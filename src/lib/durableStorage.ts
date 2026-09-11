/**
 * Durable Storage Layer
 *
 * Adds IndexedDB as a backup alongside localStorage to prevent data loss.
 * Also requests persistent storage from the browser so data isn't evicted.
 *
 * Strategy:
 * - Writes go to BOTH localStorage and IndexedDB
 * - Reads prefer localStorage (fast), fall back to IndexedDB if missing
 * - On app startup, if localStorage is empty but IndexedDB has data, restore it
 */

import { logWarn } from './logger'

const DB_NAME = 'lift-backup'
const DB_VERSION = 1
const STORE_NAME = 'keyval'

let db: IDBDatabase | null = null
/** In-flight `openDB()` promise, so concurrent callers share ONE connection. */
let opening: Promise<IDBDatabase> | null = null

function openDB(): Promise<IDBDatabase> {
  if (db) return Promise.resolve(db)
  // Single-flight (LIFT-1356). Stores persist independently, so several
  // `backupToIDB` calls routinely land in the same tick before the first open
  // resolves. Without this each one opened its OWN connection and the last
  // `onsuccess` overwrote the cache — leaking untracked connections that
  // `closeDB()` cannot close and that therefore block `deleteDatabase()`
  // forever, which is the very thing account deletion depends on.
  if (opening) return opening

  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME)
    }
    request.onsuccess = () => {
      const database = request.result
      // Another context (this tab or another) asked to delete or version-bump
      // the database. An open connection BLOCKS that request indefinitely, so
      // without closing here the wipe `deleteAccount` performs simply never
      // happens while a second Lift tab is open — and the previous user's
      // workout backup plus the durable sync journal survive on a shared
      // device after they were told the account was deleted. Dropping the
      // cache lets the next write reopen cleanly.
      database.onversionchange = () => {
        database.close()
        if (db === database) db = null
      }
      // The browser force-closed the connection (WebKit storage pressure or
      // eviction, or a `deleteDatabase` that went through). Without this the
      // cached handle stays non-null and every later `transaction()` throws
      // InvalidStateError into a swallowed catch — so the backup and the
      // durable offline journal become permanent silent no-ops for the rest
      // of the session, with no signal anywhere.
      database.onclose = () => {
        if (db === database) db = null
      }
      db = database
      resolve(database)
    }
    request.onerror = () => reject(request.error)
  })
  opening = pending
  // Clear the in-flight slot on BOTH outcomes without creating an unhandled
  // rejection (`.finally()` would return a promise nobody catches).
  const settle = (): void => {
    if (opening === pending) opening = null
  }
  pending.then(settle, settle)
  return pending
}

/** True for the error a transaction throws on a connection that is already closed. */
function isClosedConnectionError(e: unknown): boolean {
  return (e as { name?: unknown } | null)?.name === 'InvalidStateError'
}

/**
 * Run `fn` against the shared connection, reopening ONCE if the cached handle
 * turns out to be dead (LIFT-1356).
 *
 * `onclose` above clears the cache when the browser tells us — but it is
 * dispatched as an event, so there is a window in which the cached handle is
 * already closed and `transaction()` throws synchronously. Reopening turns
 * what used to be a silent, permanent no-op into a single retry that succeeds.
 */
async function withDB<T>(fn: (database: IDBDatabase) => T | Promise<T>): Promise<T> {
  const database = await openDB()
  try {
    return await fn(database)
  } catch (e) {
    if (!isClosedConnectionError(e)) throw e
    if (db === database) db = null
    return await fn(await openDB())
  }
}

/** Write a value to IndexedDB backup. Fire-and-forget. */
export function backupToIDB(key: string, value: string): void {
  withDB(database => {
    const tx = database.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(value, key)
  }).catch(() => {
    // IndexedDB unavailable — silently fail
  })
}

/**
 * Close the cached IndexedDB connection.
 *
 * `indexedDB.deleteDatabase()` is blocked indefinitely while any connection to
 * the database is still open, so this runs before every delete — that is why
 * `deleteDatabaseByName` calls it rather than leaving it to the caller. It
 * closes THIS tab's handle only; another tab yields its own through the
 * `onversionchange` handler installed in `openDB`.
 */
export function closeDB(): void {
  if (db) {
    db.close()
    db = null
  }
}

/**
 * Clear all data from IndexedDB backup.
 *
 * Resolves only once the clear has actually COMMITTED. It used to resolve as
 * soon as the request was issued, so `devClearAll`'s `location.reload()` and
 * `deleteAllIDB`'s subsequent `close()` both raced an uncommitted transaction.
 */
export async function clearIDB(): Promise<void> {
  try {
    await withDB(database => new Promise<void>((resolve, reject) => {
      const tx = database.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).clear()
      tx.oncomplete = () => resolve()
      // Surface an aborted/errored transaction as a rejection so `withDB` can
      // retry it on a dead connection rather than reporting a phantom clear.
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    }))
  } catch {
    // IndexedDB unavailable — silently fail
  }
}

/** Read a value from IndexedDB backup. */
export async function restoreFromIDB(key: string): Promise<string | null> {
  try {
    return await withDB(database => new Promise<string | null>((resolve) => {
      const tx = database.transaction(STORE_NAME, 'readonly')
      const request = tx.objectStore(STORE_NAME).get(key)
      request.onsuccess = () => resolve(request.result ?? null)
      request.onerror = () => resolve(null)
    }))
  } catch {
    return null
  }
}

/** How a `deleteDatabase` request settled. */
export type DeleteDatabaseOutcome = 'deleted' | 'blocked' | 'error'

/**
 * Delete one IndexedDB database, AWAITING the request (LIFT-1356).
 *
 * `indexedDB.deleteDatabase()` returns a request that nobody used to observe,
 * so a delete that never happened was indistinguishable from one that did.
 * `blocked` means another connection is still holding the database open — an
 * old build with no `onversionchange` handler, or a tab mid-transaction. The
 * request stays pending and WILL complete when that connection closes, but the
 * caller must not hang on a tab the user may never close, so this settles then
 * and reports the outcome honestly instead of claiming success.
 */
export function deleteDatabaseByName(name: string): Promise<DeleteDatabaseOutcome> {
  // Our own cached connection would block the delete just as another tab's does.
  if (name === DB_NAME) closeDB()
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.deleteDatabase(name)
    } catch {
      resolve('error')
      return
    }
    if (!request) {
      // No request to observe (a stub, or an environment without the API).
      resolve('error')
      return
    }
    request.onsuccess = () => resolve('deleted')
    request.onerror = () => resolve('error')
    request.onblocked = () => resolve('blocked')
  })
}

/**
 * Wipe every IndexedDB database on this origin, for account deletion.
 *
 * Ordering is deliberate. The backup store is CLEARED first: a transaction is
 * never blocked by other connections, so even when the `deleteDatabase` below
 * is blocked by a second tab, the previous user's workout backup and the
 * durable sync journal are already gone from disk rather than surviving on a
 * shared device. Only then is the connection closed and the databases dropped.
 *
 * Never throws: by the time account deletion reaches here the server rows and
 * the auth user are already gone, so a stuck local delete is reported (it is
 * the only trace such a partial wipe would otherwise leave) but must not
 * present to the user as "deletion failed, nothing happened".
 */
export async function deleteAllIDB(): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  await clearIDB()
  closeDB()

  let names: string[]
  try {
    const dbs = await indexedDB.databases()
    names = dbs.map(d => d.name).filter((n): n is string => !!n)
  } catch {
    // `indexedDB.databases()` is not supported everywhere (older WebKit) —
    // fall back to the one database this module owns.
    names = [DB_NAME]
  }

  const outcomes = await Promise.all(names.map(name => deleteDatabaseByName(name)))
  const unfinished = names
    .map((name, i) => ({ name, outcome: outcomes[i] }))
    .filter(r => r.outcome !== 'deleted')
  if (unfinished.length > 0) {
    logWarn('Some IndexedDB databases were not deleted', { databases: unfinished })
  }
}

/**
 * Request persistent storage from the browser.
 * Prevents eviction under storage pressure.
 * Should be called once on app startup.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (navigator.storage?.persist) {
    return navigator.storage.persist()
  }
  return false
}

/**
 * Check if localStorage has data for a key. If not, try restoring from IndexedDB.
 * Returns true if data was restored.
 */
export async function ensureLocalStorage(key: string): Promise<boolean> {
  const local = localStorage.getItem(key)
  if (local) {
    // Sync to IDB in case it's out of date
    backupToIDB(key, local)
    return false
  }

  // localStorage is empty — try IndexedDB
  const backup = await restoreFromIDB(key)
  if (backup) {
    localStorage.setItem(key, backup)
    return true // data was restored
  }

  return false
}

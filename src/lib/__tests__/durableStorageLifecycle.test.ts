/**
 * Connection lifecycle of the IndexedDB backup (LIFT-1356).
 *
 * `durableStorage.ts` caches ONE connection for the life of the tab, which is
 * the right shape — but a cached connection is also a liability in two ways
 * that nothing here used to exercise:
 *
 * 1. An open connection BLOCKS `indexedDB.deleteDatabase()`. Account deletion
 *    closes this tab's handle, but a second Lift tab kept its own — so the
 *    delete fired `blocked`, was never observed, and the previous user's
 *    workout backup plus the durable sync journal survived on a shared device
 *    after they were told the account was deleted.
 * 2. A connection the browser force-closes (WebKit storage pressure, or a
 *    `deleteDatabase` from another tab) leaves the cache non-null and dead, so
 *    every later `transaction()` threw `InvalidStateError` into a swallowed
 *    `catch` — the backup and the offline journal became permanent silent
 *    no-ops with no signal anywhere.
 *
 * These run against a real (in-memory) IndexedDB via `fake-indexeddb`, which
 * models `versionchange`, `blocked` and closed-connection errors faithfully —
 * a hand-rolled double would have let the fix pass without proving anything.
 * `durableStorage.test.ts` covers the read/write/restore API surface.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'

type DurableStorage = typeof import('../durableStorage')

const DB_NAME = 'lift-backup'
const STORE_NAME = 'keyval'

let mod: DurableStorage

/**
 * Import an ISOLATED copy of the module. Each copy owns its own connection
 * cache while sharing the one `indexedDB` global — which is exactly the
 * relationship between two open tabs of the app.
 */
async function freshModule(): Promise<DurableStorage> {
  vi.resetModules()
  return await import('../durableStorage')
}

/** Open a connection the module does NOT own, with no `versionchange` handler. */
function openUnmanaged(name = DB_NAME): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/** Read a key through an already-open connection (bypasses the module's cache). */
function readVia(database: IDBDatabase, key: string): Promise<string | null> {
  return new Promise((resolve) => {
    const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key)
    request.onsuccess = () => resolve((request.result as string | undefined) ?? null)
    request.onerror = () => resolve(null)
  })
}

/** Collect every connection the module opens, so a test can kill one. */
function captureConnections(): IDBDatabase[] {
  const seen: IDBDatabase[] = []
  const realOpen = indexedDB.open.bind(indexedDB)
  vi.spyOn(indexedDB, 'open').mockImplementation(((name: string, version?: number) => {
    const request = realOpen(name, version)
    request.addEventListener('success', () => seen.push(request.result))
    return request
  }) as typeof indexedDB.open)
  return seen
}

async function listDatabaseNames(): Promise<string[]> {
  return (await indexedDB.databases()).map(d => d.name).filter((n): n is string => !!n)
}

beforeEach(async () => {
  // A brand-new factory per test = fully isolated, empty origin.
  vi.stubGlobal('indexedDB', new IDBFactory())
  localStorage.clear()
  mod = await freshModule()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('durableStorage connection lifecycle (LIFT-1356)', () => {
  describe('a second tab holding the backup open', () => {
    it('yields its connection on versionchange so account deletion is not blocked', async () => {
      const tabA = mod
      // Tab A writes, which opens and CACHES a connection — the state every
      // running Lift tab is in the moment it persists anything.
      tabA.backupToIDB('workout-exercises', 'tab-a-data')
      await vi.waitFor(async () => {
        expect(await tabA.restoreFromIDB('workout-exercises')).toBe('tab-a-data')
      })

      // Tab B — an independent copy of the module against the same origin —
      // runs the account-deletion wipe.
      const tabB = await freshModule()
      await tabB.deleteAllIDB()

      // Before the fix tab A's connection carried no `onversionchange` handler,
      // so this request answered `blocked` and the database stayed on disk.
      expect(await listDatabaseNames()).not.toContain(DB_NAME)
    })

    it('drops the yielded connection from its cache so the tab keeps working', async () => {
      const tabA = mod
      tabA.backupToIDB('k', 'before')
      await vi.waitFor(async () => {
        expect(await tabA.restoreFromIDB('k')).toBe('before')
      })

      const tabB = await freshModule()
      await tabB.deleteAllIDB()

      // Closing the handle without clearing the cache would leave tab A holding
      // a dead connection — every later write silently swallowed for the rest of
      // the session. It must reopen instead.
      tabA.backupToIDB('k', 'after')
      await vi.waitFor(async () => {
        expect(await tabA.restoreFromIDB('k')).toBe('after')
      })
    })

    it('still wipes the backup contents when a stale connection blocks the delete', async () => {
      mod.backupToIDB('workout-exercises', 'previous-user-data')
      await vi.waitFor(async () => {
        expect(await mod.restoreFromIDB('workout-exercises')).toBe('previous-user-data')
      })

      // A connection with NO versionchange handler: a tab still running an older
      // build, or one sitting mid-transaction. `deleteDatabase` cannot complete
      // while it is open, and no amount of client code can force it to.
      const stale = await openUnmanaged()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      await mod.deleteAllIDB()

      // The delete really is blocked — the database itself survives...
      expect(await listDatabaseNames()).toContain(DB_NAME)
      // ...and that is reported rather than passed off as a completed wipe.
      expect(warn).toHaveBeenCalled()
      // ...but the previous user's payload is gone anyway, because the contents
      // are cleared through a TRANSACTION first, and a transaction is never
      // blocked by another connection. This is what stops a shared device from
      // handing the next user the last one's workout backup and sync journal.
      expect(await readVia(stale, 'workout-exercises')).toBeNull()

      stale.close()
    })
  })

  describe('a connection closed underneath the cache', () => {
    it('reopens instead of silently swallowing every later write', async () => {
      const connections = captureConnections()
      mod.backupToIDB('k', 'first')
      await vi.waitFor(async () => {
        expect(await mod.restoreFromIDB('k')).toBe('first')
      })
      expect(connections).toHaveLength(1)

      // Force-close the cached handle WITHOUT firing `onclose` — what
      // `IDBDatabase.close()` does by spec, and the shape of a storage-pressure
      // eviction. The module still holds it, so the next `transaction()` throws
      // InvalidStateError; before the fix that landed in a bare `catch` and the
      // backup was a no-op for the rest of the session.
      connections[0].close()

      mod.backupToIDB('k', 'second')
      await vi.waitFor(async () => {
        expect(await mod.restoreFromIDB('k')).toBe('second')
      })
      expect(connections.length).toBeGreaterThan(1)
    })

    it('clears the cache when the browser reports the close', async () => {
      const connections = captureConnections()
      mod.backupToIDB('k', 'v')
      await vi.waitFor(async () => {
        expect(await mod.restoreFromIDB('k')).toBe('v')
      })
      expect(connections).toHaveLength(1)

      // The browser dispatches `close` on an abnormal closure. Running the
      // handler must drop the cache so the next operation opens afresh.
      expect(typeof connections[0].onclose).toBe('function')
      connections[0].onclose?.call(connections[0], new Event('close'))

      await mod.restoreFromIDB('k')
      expect(connections).toHaveLength(2)
    })
  })

  describe('single-flight open', () => {
    it('opens ONE connection for writes issued in the same tick', async () => {
      const openSpy = vi.spyOn(indexedDB, 'open')

      // Four stores persist independently, so several backups routinely land
      // before the first open resolves. Each used to open its own connection and
      // the last `onsuccess` overwrote the cache — leaking handles that
      // `closeDB()` cannot close and that therefore block `deleteDatabase()`.
      mod.backupToIDB('a', '1')
      mod.backupToIDB('b', '2')
      mod.backupToIDB('c', '3')

      await vi.waitFor(async () => {
        expect(await mod.restoreFromIDB('c')).toBe('3')
      })
      expect(await mod.restoreFromIDB('a')).toBe('1')
      expect(await mod.restoreFromIDB('b')).toBe('2')
      expect(openSpy).toHaveBeenCalledTimes(1)
    })
  })

  describe('deleteDatabaseByName', () => {
    it('closes its own cached connection first and reports the delete', async () => {
      mod.backupToIDB('k', 'v')
      await vi.waitFor(async () => {
        expect(await mod.restoreFromIDB('k')).toBe('v')
      })

      await expect(mod.deleteDatabaseByName(DB_NAME)).resolves.toBe('deleted')
      expect(await listDatabaseNames()).not.toContain(DB_NAME)
    })

    it('reports blocked instead of claiming a delete that never happened', async () => {
      const stale = await openUnmanaged()

      await expect(mod.deleteDatabaseByName(DB_NAME)).resolves.toBe('blocked')

      stale.close()
    })

    it('reports an error when the request cannot even be issued', async () => {
      vi.spyOn(indexedDB, 'deleteDatabase').mockImplementation(() => {
        throw new Error('storage disabled')
      })

      await expect(mod.deleteDatabaseByName(DB_NAME)).resolves.toBe('error')
    })
  })

  describe('deleteAllIDB', () => {
    it('deletes every database on the origin, not just the backup', async () => {
      mod.backupToIDB('k', 'v')
      await vi.waitFor(async () => {
        expect(await mod.restoreFromIDB('k')).toBe('v')
      })
      const other = await openUnmanaged('some-other-db')
      other.close()

      await mod.deleteAllIDB()

      expect(await listDatabaseNames()).toEqual([])
    })

    it('falls back to the known database when databases() is unsupported', async () => {
      mod.backupToIDB('k', 'v')
      await vi.waitFor(async () => {
        expect(await mod.restoreFromIDB('k')).toBe('v')
      })
      vi.spyOn(indexedDB, 'databases').mockRejectedValue(new Error('not supported'))

      await mod.deleteAllIDB()

      vi.restoreAllMocks()
      expect(await listDatabaseNames()).not.toContain(DB_NAME)
    })

    it('resolves without throwing when IndexedDB is unavailable', async () => {
      vi.stubGlobal('indexedDB', undefined)
      await expect(mod.deleteAllIDB()).resolves.toBeUndefined()
    })
  })

  describe('clearIDB', () => {
    it('resolves only once the clear transaction has COMMITTED', async () => {
      const connections = captureConnections()
      mod.backupToIDB('k', 'v')
      await vi.waitFor(async () => {
        expect(await mod.restoreFromIDB('k')).toBe('v')
      })

      // Record the commit and the resolution in the order they really happen.
      // `clearIDB` used to resolve as soon as the request was ISSUED, so
      // `devClearAll`'s immediate `location.reload()` — and `deleteAllIDB`'s
      // `close()` — both raced a transaction that had not landed yet.
      const order: string[] = []
      const connection = connections[0]
      const realTransaction = connection.transaction.bind(connection)
      vi.spyOn(connection, 'transaction').mockImplementation(((
        store: string, mode?: IDBTransactionMode,
      ) => {
        const tx = realTransaction(store, mode)
        tx.addEventListener('complete', () => order.push('committed'))
        return tx
      }) as IDBDatabase['transaction'])

      await mod.clearIDB()
      order.push('resolved')

      expect(order).toEqual(['committed', 'resolved'])
      expect(await mod.restoreFromIDB('k')).toBeNull()
    })
  })
})

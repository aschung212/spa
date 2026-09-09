/**
 * Consolidated architectural invariant tests.
 *
 * These tests scan source code to enforce structural rules that prevent
 * specific classes of bugs from returning. Each invariant documents the
 * SEV / incident it guards against.
 *
 * Why source scanning instead of runtime tests?
 * - Runtime tests prove behavior for specific inputs; structural tests
 *   prove the *absence* of dangerous patterns across the entire codebase.
 * - The SEV1 on 2026-04-12 passed all behavioral tests because the bug
 *   only triggered on specific data patterns. A structural test would
 *   have caught the anti-pattern before it shipped.
 *
 * Consolidated from: syncQueue.test.ts, syncQueueSafety.test.ts,
 * workout.test.ts, crossTabSyncStructural.test.ts (LIFT-653).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join, relative, resolve } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

// ── Shared helpers ──────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const STORES_DIR = resolve(__dirname, '../../stores')
const SRC_DIR = resolve(__dirname, '../..')
const MIGRATIONS_DIR = resolve(SRC_DIR, '../supabase/migrations')

/** Returns { path (relative to src/), content } for every non-test .ts/.vue file. */
function getSourceFiles(dir = SRC_DIR, out: { path: string; content: string }[] = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) getSourceFiles(full, out)
    else if (/\.(ts|vue)$/.test(entry.name)) {
      out.push({ path: relative(SRC_DIR, full), content: readFileSync(full, 'utf-8') })
    }
  }
  return out
}

/**
 * Drop `//`-style and block-comment lines. Comments that explain a banned
 * pattern often quote the banned call, and a guard that flags its own
 * documentation is a guard people delete. Shared by the modal-open and
 * reload-guard invariants.
 */
function stripComments(source: string): string {
  return source
    .split('\n')
    .filter(line => !/^\s*(\/\/|\/\*|\*|<!--)/.test(line))
    .join('\n')
}

/** Returns absolute paths of all non-test .ts files in src/stores/. */
function getStoreFilePaths(): string[] {
  return readdirSync(STORES_DIR)
    .filter(f => f.endsWith('.ts') && !f.includes('__tests__'))
    .map(f => join(STORES_DIR, f))
}

/** Returns { name, content } for each store file. */
function getStoreFiles(): { name: string; content: string }[] {
  return readdirSync(STORES_DIR)
    .filter(f => f.endsWith('.ts') && !f.includes('__tests__'))
    .map(f => ({
      name: f,
      content: readFileSync(join(STORES_DIR, f), 'utf-8'),
    }))
}

/**
 * Extract a function body from source using brace-counting.
 * Returns the content between the opening and closing braces (exclusive).
 * Throws if the function signature is not found.
 */
function extractFunctionBody(source: string, signature: string): string {
  const fnStart = source.indexOf(signature)
  if (fnStart === -1) {
    throw new Error(`Function signature "${signature}" not found in source`)
  }
  const openBrace = source.indexOf('{', fnStart)
  let depth = 1
  let i = openBrace + 1
  while (i < source.length && depth > 0) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') depth--
    i++
  }
  return source.slice(openBrace + 1, i - 1)
}

/**
 * Scan a source string for all occurrences of `pattern` within a
 * `syncQueue.enqueue(` call, using brace/paren counting to scope
 * the search to the enqueue callback body.
 *
 * Returns a violation message for each match, or an empty array.
 */
function findPatternInsideSyncEnqueue(
  source: string,
  fileName: string,
  pattern: RegExp,
  violationMessage: (line: number, startLine: number) => string,
): string[] {
  const violations: string[] = []
  const lines = source.split('\n')

  let insideSyncEnqueue = false
  let enqueueStartLine = 0
  let parenDepth = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (line.includes('syncQueue.enqueue')) {
      insideSyncEnqueue = true
      enqueueStartLine = i + 1
      parenDepth = 0
    }

    if (insideSyncEnqueue) {
      for (const ch of line) {
        if (ch === '(') parenDepth++
        if (ch === ')') parenDepth--
      }

      if (pattern.test(line)) {
        violations.push(violationMessage(i + 1, enqueueStartLine))
      }

      if (parenDepth <= 0) {
        insideSyncEnqueue = false
      }
    }
  }

  return violations
}

// ── Invariant 1: Delete routing discipline ──────────────────────────
// Guard: SEV1 2026-04-12 — delete storm destroyed ~40-60% of user data.
// Every Supabase DELETE must go through syncQueue.enqueueDelete (not
// plain enqueue) so the circuit breaker sees it.

describe('Invariant: delete routing discipline (SEV1 2026-04-12 guard)', () => {
  const STORE_FILES = ['workout.ts', 'bodyweight.ts', 'preferences.ts', 'progression.ts']

  it('stores never wrap a .delete() in plain syncQueue.enqueue — must use enqueueDelete', () => {
    for (const file of STORE_FILES) {
      const src = readFileSync(resolve(STORES_DIR, file), 'utf-8')
      // Find every syncQueue.enqueue( and check a window of the following 300 chars
      // for .delete() — if present, it should have been enqueueDelete instead.
      const enqueueRe = /syncQueue\.enqueue\(/g
      let match: RegExpExecArray | null
      while ((match = enqueueRe.exec(src)) !== null) {
        const window = src.slice(match.index, match.index + 300)
        if (/\.delete\s*\(/.test(window)) {
          throw new Error(
            `${file} has syncQueue.enqueue wrapping a .delete() at offset ${match.index}. ` +
            `Use syncQueue.enqueueDelete so the circuit breaker sees it. ` +
            `Context:\n${window.slice(0, 200)}`,
          )
        }
      }
    }
  })

  // Gate 5 invariant: stores do not issue hard DELETEs at all.
  // Every removal must go through UPDATE { deleted_at: ... } so data is
  // recoverable within the grace window before the hard-delete cron runs.
  it('stores never call .delete() on a Supabase query — all removals are soft (Gate 5)', () => {
    for (const file of STORE_FILES) {
      const src = readFileSync(resolve(STORES_DIR, file), 'utf-8')
      // Match any supabase query builder .delete(), allowing whitespace / newlines
      // between .from(...) and .delete(). Non-supabase .delete() (Map/Set) is not
      // matched because the anchor requires .from(...) upstream within 200 chars.
      const re = /\.from\(\s*['"][^'"]+['"]\s*\)[\s\S]{0,200}?\.delete\s*\(/g
      const match = re.exec(src)
      if (match) {
        const offset = match.index
        throw new Error(
          `${file} contains a hard .delete() on a Supabase query at offset ${offset}. ` +
          `Gate 5 requires UPDATE { deleted_at: new Date().toISOString() } for all removals. ` +
          `Context:\n${src.slice(offset, offset + 200)}`,
        )
      }
    }
  })
})

// ── Invariant 2: SyncQueue idempotency ──────────────────────────────
// Guard: SyncQueue retries failed operations with exponential backoff.
// Non-idempotent .insert() retried after server processing creates
// duplicate data. Only .upsert(), .update(), .delete() are safe.

describe('Invariant: syncQueue idempotency (no .insert() in retry path)', () => {
  it('no .insert() calls are routed through syncQueue (non-idempotent, unsafe to retry)', () => {
    const violations: string[] = []

    for (const filePath of getStoreFilePaths()) {
      const content = readFileSync(filePath, 'utf-8')
      const fileName = filePath.split('/').pop()!

      const found = findPatternInsideSyncEnqueue(
        content,
        fileName,
        /\.insert\(/,
        (line, startLine) =>
          `${fileName}:${line} — .insert() inside syncQueue.enqueue (started line ${startLine}). ` +
          `Use .upsert() instead, or call Supabase directly without the queue.`,
      )
      violations.push(...found)
    }

    expect(
      violations,
      'Non-idempotent .insert() calls must not go through syncQueue (retries could create duplicates):\n' +
      violations.join('\n'),
    ).toHaveLength(0)
  })

  it('no fire-and-forget Supabase calls — all mutations must go through syncQueue', () => {
    const violations: string[] = []

    for (const filePath of getStoreFilePaths()) {
      const content = readFileSync(filePath, 'utf-8')
      const lines = content.split('\n')
      const fileName = filePath.split('/').pop()!

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (/supabase[!]?\.from\(/.test(line) || /\)\s*\.then\(\s*\)/.test(line)) {
          const window = lines.slice(Math.max(0, i - 2), i + 3).join('\n')
          if (/\.(?:insert|upsert|update|delete)\([\s\S]*?\)[\s\S]*?\.then\(\s*\)/.test(window)) {
            violations.push(
              `${fileName}:${i + 1} — fire-and-forget .then() on Supabase call. ` +
              `Route through syncQueue.enqueue() for retry, rate limiting, and error handling.`,
            )
          }
        }
      }
    }

    expect(
      violations,
      'Fire-and-forget Supabase calls bypass syncQueue error handling and retries:\n' +
      violations.join('\n'),
    ).toHaveLength(0)
  })
})

// ── Invariant 2b: every store write is durable (LIFT-1239) ──────────
// Guard: the IndexedDB write journal (LIFT-706) only engages when a caller
// passes a SyncDescriptor — a descriptor-less enqueue silently keeps the legacy
// in-memory-only behavior, so the write is lost if the app closes before the 1s
// flush and has no durable record to retain when retries are exhausted
// (LIFT-1229). Only workout.ts passed descriptors for a year; bodyweight,
// preferences and progression didn't, and none of those three has a
// reconciliation pass to recover the write later. Nothing failed when a table
// opted out, which is why it went unnoticed — hence a structural guard.

/**
 * Argument count of the call starting at `start` (index of the `(`), counting
 * only commas at the top level of the argument list — commas inside nested
 * calls, object/array literals, and strings belong to an argument, not to the
 * list. Returns 0 for `f()`.
 */
function countCallArgs(source: string, start: number): number {
  let depth = 0
  let args = 1
  let quote: string | null = null
  for (let i = start; i < source.length; i++) {
    const ch = source[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue }
    if (ch === '(' || ch === '{' || ch === '[') depth++
    else if (ch === ')' || ch === '}' || ch === ']') {
      depth--
      if (depth === 0) return source.slice(start + 1, i).trim() === '' ? 0 : args
    } else if (ch === ',' && depth === 1) args++
  }
  throw new Error('Unbalanced call expression while scanning syncQueue arguments')
}

describe('Invariant: store writes carry a durable descriptor (LIFT-1239)', () => {
  /**
   * An enqueue may opt out of the journal only with this marker plus a written
   * justification. The one current exemption is bodyweight's `clearAll`: its
   * match is unbounded ("every live row for this user"), a descriptor can only
   * express `eq` filters so the `.is('deleted_at', null)` guard would be lost
   * on replay, and re-applying a wipe on the next launch would destroy entries
   * logged on another device in the meantime.
   */
  const EXEMPT_MARKER = 'durable-journal-exempt'

  /** Every syncQueue.enqueue / enqueueDelete call site under src/stores/. */
  function enqueueCallSites(): { file: string; line: number; args: number; exempt: boolean }[] {
    const sites: { file: string; line: number; args: number; exempt: boolean }[] = []
    for (const { name, content } of getStoreFiles()) {
      const re = /syncQueue\s*\.\s*(enqueue|enqueueDelete)\s*\(/g
      let match: RegExpExecArray | null
      while ((match = re.exec(content)) !== null) {
        const open = match.index + match[0].length - 1
        sites.push({
          file: name,
          line: content.slice(0, match.index).split('\n').length,
          args: countCallArgs(content, open),
          // The marker must be the last comment line before the call, so it
          // can't be inherited from an unrelated block further up.
          exempt: content
            .slice(0, match.index)
            .trimEnd()
            .split('\n')
            .slice(-1)[0]
            .includes(EXEMPT_MARKER),
        })
      }
    }
    return sites
  }

  it('the argument counter handles nested literals, arrows and strings (self-test)', () => {
    const two = "syncQueue.enqueue(`k:${id}`, () => supabase!.from('x').update(v).eq('id', id))"
    expect(countCallArgs(two, two.indexOf('('))).toBe(2)
    const three = "syncQueue.enqueue('k', () => f(a, b), { op: 'update', values: { a: 1 }, match: { b: 2 } })"
    expect(countCallArgs(three, three.indexOf('('))).toBe(3)
    // A comma inside a string literal must not be read as an argument separator.
    const stringy = "syncQueue.enqueue('a,b', op)"
    expect(countCallArgs(stringy, stringy.indexOf('('))).toBe(2)
  })

  it('every store enqueue passes a SyncDescriptor (or is explicitly exempt)', () => {
    const sites = enqueueCallSites()

    // Non-vacuity: all four stores must be reached, or the scan proves nothing.
    expect(sites.length).toBeGreaterThan(5)
    for (const file of ['workout.ts', 'bodyweight.ts', 'preferences.ts', 'progression.ts']) {
      expect(sites.some(s => s.file === file), `${file} has no syncQueue call site`).toBe(true)
    }

    const violations = sites
      .filter(s => s.args < 3 && !s.exempt)
      .map(s =>
        `${s.file}:${s.line} — syncQueue enqueue with ${s.args} arguments and no ` +
        `SyncDescriptor. Without one the write is in-memory only: it is lost if ` +
        `the app closes before the flush, and has no durable record to retain ` +
        `when retries are exhausted. Pass a descriptor, or add a ` +
        `'${EXEMPT_MARKER}' comment above the call with a justification.`,
      )

    expect(violations).toEqual([])
  })
})

// ── Invariant 3: READ path is read-only ─────────────────────────────
// Guard: SEV1 2026-04-12 — _fetchFromSupabase broadcast DELETEs from a
// client-side dedup heuristic. 40-60% of one user's workout data was
// destroyed. Free tier = no PITR = unrecoverable.
//
// Rule: .delete() inside _fetchFromSupabase is ONLY allowed when
// processing tombstones (syncing pending user-initiated deletes).
// Variable names from the original bug (`dupSetIds`, etc.) must not
// reappear.

describe('Invariant: _fetchFromSupabase READ path is read-only (SEV1 2026-04-12 guard)', () => {
  it('workout _fetchFromSupabase: .delete() only allowed in tombstone context', () => {
    const src = readFileSync(resolve(STORES_DIR, 'workout.ts'), 'utf-8')
    const body = extractFunctionBody(src, 'async function _fetchFromSupabase()')

    // Every .delete() must be preceded (within 400 chars) by "tombstone"
    const deletePattern = /\.delete\s*\(/g
    let match: RegExpExecArray | null
    while ((match = deletePattern.exec(body)) !== null) {
      const before = body.slice(Math.max(0, match.index - 400), match.index)
      expect(before).toMatch(/tombstone/i)
    }

    // Guard against the specific variable names from the original bug
    expect(body).not.toMatch(/dupSetIds/)
    expect(body).not.toMatch(/Set was content-deduped out/)
    expect(body).not.toMatch(/Delete the duplicate exercise from Supabase/)
  })

  it('bodyweight _fetchFromSupabase: .delete() only allowed in tombstone context', () => {
    const src = readFileSync(resolve(STORES_DIR, 'bodyweight.ts'), 'utf-8')
    const body = extractFunctionBody(src, 'async _fetchFromSupabase()')

    const deletePattern = /\.delete\s*\(/g
    let match: RegExpExecArray | null
    while ((match = deletePattern.exec(body)) !== null) {
      const before = body.slice(Math.max(0, match.index - 400), match.index)
      expect(before).toMatch(/tombstone/i)
    }

    expect(body).not.toMatch(/dupIds/)
    expect(body).not.toMatch(/Clean up duplicate entries from Supabase/)
  })
})

// ── Invariant 3a: every store read handles failure identically (LIFT-1179) ──
// Guard: the four `_fetchFromSupabase` implementations are four hand-written
// copies of one contract — report, classify, offer auth recovery, clear the
// syncing flag — and they drifted. `preferences` had no auth branch at ALL
// (neither shape), and `workout`/`bodyweight` had one on the resolved-error
// path but not in their `catch`. That was survivable only by accident: all four
// stores fetch together under `Promise.allSettled` (initStores, useSyncRecovery),
// so a token expiry always reached SOME store that raised the refresh, and the
// gap never showed. A store that ever fetches alone — or a fifth store — would
// record `lastSyncError = 'auth'`, light the generic "Sync failed" indicator,
// and never call `ensureFreshSession()`: no token refresh, no `authNeedsReauth`
// banner telling the user to sign in, and no `sessionRecoveryTick` to re-run the
// stale reads.
//
// This is DERIVED from the store sources rather than enumerated, for the same
// reason as the REPLAYABLE_COLUMNS and role="switch" invariants: a hardcoded
// list only ever pins the stores that existed when it was written, which is how
// three of the four drifted past a suite that already covered this function.

describe('Invariant: every store read handles failure identically (LIFT-1179)', () => {
  /**
   * The `_fetchFromSupabase` body from a store source, whichever syntax it uses
   * — `async function _fetchFromSupabase()` in a setup store, `async
   * _fetchFromSupabase()` in an options store. Null when the store has no
   * remote read. Comments are stripped first: several of these bodies *quote*
   * the calls below while explaining them, and a guard that passes off its own
   * documentation proves nothing.
   */
  function extractFetchBody(source: string): string | null {
    const stripped = stripComments(source)
    const signature = /(?:async function|async)\s+_fetchFromSupabase\s*\(\s*\)/.exec(stripped)
    if (!signature) return null
    return extractFunctionBody(stripped, signature[0])
  }

  const count = (body: string, pattern: RegExp): number => (body.match(pattern) ?? []).length

  const stores = getStoreFiles()
    .map(({ name, content }) => ({ name, body: extractFetchBody(content) }))
    .filter((s): s is { name: string; body: string } => s.body !== null)

  it('found every store that reads from Supabase', () => {
    // Non-vacuity: the scan must actually see all four stores. A regex that
    // silently matches nothing would make every assertion below pass.
    expect(stores.map(s => s.name).sort()).toEqual(
      ['bodyweight.ts', 'preferences.ts', 'progression.ts', 'workout.ts'],
    )
  })

  it.each(stores)('$name: every reported failure also offers auth recovery', ({ body }) => {
    const reported = count(body, /\breportFetchError\s*\(/g)
    expect(reported).toBeGreaterThan(0)

    // Equality, not "at least one": a store with two failure branches and one
    // refresh is exactly the shape that shipped. Both the resolved `{ error }`
    // path and the thrown path must route a 401 to a refresh — `isAuthError`
    // normalizes both shapes precisely so neither is a special case.
    expect(count(body, /\bensureFreshSession\s*\(/g)).toBe(reported)
    expect(count(body, /\bisAuthError\s*\(/g)).toBeGreaterThanOrEqual(reported)
  })

  it.each(stores)('$name: every reported failure records a typed lastSyncError', ({ body }) => {
    // `lastSyncError` is what App.vue folds into the sync indicator via
    // `combineSyncStatus`, so a failure branch that reports but doesn't classify
    // is a failure the user is never shown.
    expect(count(body, /\bclassifySyncError\s*\(/g)).toBe(count(body, /\breportFetchError\s*\(/g))
  })

  it.each(stores)('$name: the syncing flag is raised and cleared in a finally', ({ body }) => {
    expect(body).toMatch(/syncing(?:\.value)?\s*=\s*true/)
    // In a `finally`, not on the success path: every failure branch returns
    // early, so a trailing assignment would strand the flag true forever.
    expect(body).toMatch(/finally\s*\{[^}]*syncing(?:\.value)?\s*=\s*false/)
  })
})

// ── Invariant 3b: collection reads must page (#1152) ────────────────
// Guard: PostgREST truncates every response at max_rows (1000) and reports it
// nowhere. An unpaged `.select()` on a collection therefore returns the first
// page and looks successful — which silently hid 454 of a real user's 1454 sets
// and made the app claim they hadn't trained in four weeks.
//
// A read is exempt only when it can't return a collection: `.single()` /
// `.maybeSingle()` (one row by contract) or a `head: true` count probe (no rows
// at all). Everything else must go through `fetchAllRows`.

describe('Invariant: Supabase collection reads are paged (#1152)', () => {
  /** Collection tables — a per-user read of these can exceed max_rows. */
  const COLLECTION_TABLES = ['sets', 'exercises', 'bodyweight_entries']

  it('no store reads a collection table without fetchAllRows', () => {
    const violations: string[] = []

    for (const { name, content } of getStoreFiles()) {
      for (const table of COLLECTION_TABLES) {
        // Find each `.from('<table>')` and inspect the chain that follows it.
        const pattern = new RegExp(`\\.from\\(\\s*['"\`]${table}['"\`]\\s*\\)`, 'g')
        let match: RegExpExecArray | null
        while ((match = pattern.exec(content)) !== null) {
          // The chain runs to the end of the statement; 500 chars covers the
          // longest multi-line query in the stores by a wide margin.
          const chain = content.slice(match.index, match.index + 500)
          const isSelect = /^\s*\.from\([^)]*\)\s*[\s\S]{0,80}?\.select\(/.test(chain)
          if (!isSelect) continue // upsert/update/delete are unaffected by max_rows
          if (/\.(single|maybeSingle)\s*\(/.test(chain.slice(0, 300))) continue
          if (/head:\s*true/.test(chain.slice(0, 300))) continue

          // The read must be wrapped by the paging helper, which appears just
          // before `.from(` on the same expression.
          const before = content.slice(Math.max(0, match.index - 200), match.index)
          if (!/fetchAllRows\s*\(/.test(before)) {
            const line = content.slice(0, match.index).split('\n').length
            violations.push(
              `${name}:${line} — reads the '${table}' collection without ` +
              `fetchAllRows. PostgREST caps the response at max_rows (1000) ` +
              `with no error, so this silently returns a partial collection.`,
            )
          }
        }
      }
    }

    expect(violations).toEqual([])
  })

  it('every paged read carries a total sort order', () => {
    // Pagination is only coherent under a deterministic order. `created_at` is
    // `default now()`, so a CSV import writes many rows with an identical
    // value; without a tiebreaker the database may order ties differently
    // between two page requests, repeating some rows and skipping others.
    const violations: string[] = []

    for (const { name, content } of getStoreFiles()) {
      const pattern = /fetchAllRows\s*\(/g
      let match: RegExpExecArray | null
      while ((match = pattern.exec(content)) !== null) {
        const chain = content.slice(match.index, match.index + 500)
        const orderCount = (chain.match(/\.order\(/g) || []).length
        if (orderCount < 2) {
          const line = content.slice(0, match.index).split('\n').length
          violations.push(
            `${name}:${line} — paged read has ${orderCount} .order() clause(s). ` +
            `A paged read needs a total order (add .order('id') as a tiebreaker).`,
          )
        }
      }
    }

    expect(violations).toEqual([])
  })
})

// ── Invariant 4: Cross-tab sync completeness ────────────────────────
// Guard: if a store has _persist() but doesn't broadcast, cross-tab
// sync silently breaks. This catches missing wiring when new stores
// are added or _persist() is refactored.
//
// Stores broadcast either directly (broadcastStoreUpdate) or by delegating
// the storage plumbing to persistStoreData, which broadcasts internally
// (LIFT-819). Either satisfies the invariant.

describe('Invariant: cross-tab sync completeness', () => {
  it('every store with _persist() must broadcast cross-tab updates', () => {
    const violations: string[] = []

    for (const { name, content } of getStoreFiles()) {
      if (!content.includes('_persist()')) continue

      if (!content.includes('broadcastStoreUpdate') && !content.includes('persistStoreData')) {
        violations.push(
          `${name} — has _persist() but neither calls broadcastStoreUpdate ` +
          `nor delegates to persistStoreData. Cross-tab sync needs one of these. ` +
          `Either call broadcastStoreUpdate('<storeName>') inside _persist(), ` +
          `or route the write through persistStoreData() from '../lib/storePersistence'.`,
        )
      }
    }

    expect(violations).toEqual([])
  })

  it('every store with _persist() must have _reloadFromStorage()', () => {
    const violations: string[] = []

    for (const { name, content } of getStoreFiles()) {
      if (!content.includes('_persist()')) continue

      if (!content.includes('_reloadFromStorage()')) {
        violations.push(
          `${name} — has _persist() but no _reloadFromStorage(). ` +
          `Cross-tab sync needs this to apply changes from other tabs.`,
        )
      }
    }

    expect(violations).toEqual([])
  })
})

// ── Modal background-scroll lock (#830 guard) ───────────────────────

/**
 * `html.modal-open` drives `overflow: hidden` on `.tabContent` — the only
 * iOS-correct way to stop the background scrolling behind a modal
 * (`touch-action: none` on the overlay does nothing in iOS Safari/WKWebView).
 *
 * useModal owns it behind a REFERENCE COUNT, and that ownership has to be
 * exclusive. A component that toggles the class itself only knows about its
 * own modals: when it closes one while another surface still has a modal up,
 * its `toggle(…, false)` strips the class even though the count is > 0. The
 * background then scrolls under a `position: fixed` modal, and the moment the
 * iOS keyboard opens — visual viewport shifts, layout viewport does not —
 * paint desyncs from hit-testing and taps land a row low.
 *
 * A behavioural test only catches this in the exact component it covers.
 * This one catches it anywhere in the codebase, which is what let the
 * WorkoutTracker copy survive: no test mounted two modal-owning components
 * at once.
 */
describe('Invariant: useModal is the only owner of html.modal-open (#830)', () => {
  const OWNER = join('composables', 'useModal.ts')

  it('no component or composable toggles the modal-open class directly', () => {
    const files = getSourceFiles()
    // Non-vacuity: the walker must actually reach the .vue components and the
    // owner itself, or this scan proves nothing.
    expect(files.map(f => f.path)).toContain(OWNER)
    expect(files.filter(f => f.path.endsWith('.vue')).length).toBeGreaterThan(20)

    const violations = files
      .filter(f => f.path !== OWNER)
      .filter(f => /classList\s*\.\s*(add|remove|toggle|replace)\s*\(\s*['"`]modal-open/.test(stripComments(f.content)))
      .map(f =>
        `${f.path} — hand-rolls the background-scroll lock. Use useModal() so ` +
        `the shared reference count decides when the class comes off.`,
      )

    expect(violations).toEqual([])
  })

  it('useModal applies the class from the reference count, not a boolean', () => {
    const owner = readFileSync(join(SRC_DIR, OWNER), 'utf-8')
    expect(owner).toMatch(/classList\.toggle\('modal-open', scrollLockCount > 0\)/)
  })
})

// ── Invariant: one resolution point for the PR baseline (#1272) ──────

/**
 * `preferences.prBaselineDate` is the RAW manual anchor. The baseline PR and XP
 * consumers must use is the mode-resolved one from `usePRBaseline()`, which
 * folds in `strengthBaselineMode` / `recentBaselineWeeks` — the whole reason
 * lifetime and recent collapse to a single `sinceDate` day key instead of two
 * parallel lookups.
 *
 * A consumer that reaches past the composable and reads the store field gets
 * the anchor and silently ignores recent mode. That failure has no visible
 * symptom for a lifetime-mode user (the two values are identical there), so it
 * would ship green and only misbehave for the cutting lifter the feature
 * exists for — the same shape as the WorkoutTracker `modal-open` copy above,
 * which survived for years because no test exercised the divergent case.
 */
describe('Invariant: usePRBaseline is the only reader of the raw PR-baseline anchor (#1272)', () => {
  const OWNERS = [join('composables', 'usePRBaseline.ts'), join('stores', 'preferences.ts')]

  it('no other file reads prBaselineDate off the preferences store', () => {
    const files = getSourceFiles()
    // Non-vacuity: the walker must reach the owners and the PR consumers.
    for (const owner of OWNERS) expect(files.map(f => f.path)).toContain(owner)
    expect(files.map(f => f.path)).toContain(join('components', 'WorkoutTracker.vue'))

    // Matches a member access like `prefs.prBaselineDate` or
    // `usePreferencesStore().prBaselineDate`, capturing the receiver so the two
    // legitimate shapes can be allowed through:
    //   - `props.prBaselineDate` — a child bound to the RESOLVED value by its
    //     host (WorkoutTimeline), which is the intended way to pass it down.
    //   - a bare destructure, `const { prBaselineDate } = usePRBaseline()`,
    //     which has no receiver at all and so never matches.
    const MEMBER_ACCESS = /(\)|[\w$]+)\s*\.\s*prBaselineDate\b/g
    const violations = files
      .filter(f => !OWNERS.includes(f.path))
      .filter(f => {
        const receivers = [...stripComments(f.content).matchAll(MEMBER_ACCESS)].map(m => m[1])
        return receivers.some(r => r !== 'props')
      })
      .map(f =>
        `${f.path} — reads the raw PR-baseline anchor. Use ` +
        `usePRBaseline().prBaselineDate so the strength baseline mode is applied.`,
      )

    expect(violations).toEqual([])

    // Non-vacuity for the matcher itself: it must actually fire on the shape
    // being banned, or the scan above passes for the wrong reason.
    expect([...'const b = prefs.prBaselineDate'.matchAll(MEMBER_ACCESS)].map(m => m[1]))
      .toEqual(['prefs'])
    expect([...'usePreferencesStore().prBaselineDate'.matchAll(MEMBER_ACCESS)].map(m => m[1]))
      .toEqual([')'])
  })

  it('the composable resolves through the shared pure helper', () => {
    const owner = readFileSync(join(SRC_DIR, OWNERS[0]), 'utf-8')
    expect(owner).toMatch(/resolveStrengthBaseline\(/)
    // The raw anchor stays reachable, but only under a name that says so.
    expect(owner).toMatch(/prBaselineAnchor/)
  })
})

// ── Invariant: Row-Level Security on every table (LIFT-1130) ─────────
// Guard: tenant isolation depends ENTIRELY on RLS. The anon key ships in
// the client bundle, so anyone can hit PostgREST directly; the client-side
// .eq('user_id', ...) filters are trivially bypassable defense-in-depth,
// not a real boundary. Each table's protection is a single hand-repeated
// `alter table ... enable row level security` line in its migration. A
// future `create table` (or a recreated table) that omits that one line
// would silently expose every user's rows to any authenticated client,
// with no behavioural test failing.
//
// This scans the migrations as text and treats a missing RLS enablement as
// a build-blocking failure. It also asserts every user-scoped table carries
// at least one auth.uid()-scoped policy, so RLS-on-but-unscoped can't slip
// through either.

/** Strip SQL line comments and block comments so commented-out DDL
 *  (documentation) never counts as a real statement. */
function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => line.replace(/--.*$/, ''))
    .join('\n')
}

// Optional `schema.` qualifier (e.g. `public.exercises`) — captured and
// discarded so the bare table name is always group 1. Without this, a
// schema-qualified DDL would capture `public` and hide the real table from
// the RLS check, letting an unprotected table pass silently.
const SCHEMA = '(?:\\w+\\.)?'

/** Every table name introduced by a `create table [if not exists] <name>`. */
function createdTables(sql: string): string[] {
  const re = new RegExp(`create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?["']?${SCHEMA}(\\w+)["']?`, 'gi')
  const names = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(sql)) !== null) names.add(m[1].toLowerCase())
  return [...names]
}

/** Every table with an `alter table <name> enable row level security`. */
function rlsEnabledTables(sql: string): Set<string> {
  const re = new RegExp(`alter\\s+table\\s+(?:only\\s+)?["']?${SCHEMA}(\\w+)["']?\\s+enable\\s+row\\s+level\\s+security`, 'gi')
  const names = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(sql)) !== null) names.add(m[1].toLowerCase())
  return names
}

/** The definition block for a `create table` — from its opening `(` to the
 *  matching `)` — used to tell whether a table is user-scoped (`user_id`). */
function tableBody(sql: string, table: string): string {
  const re = new RegExp(`create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?["']?${SCHEMA}${table}["']?`, 'i')
  const start = sql.search(re)
  if (start === -1) return ''
  const open = sql.indexOf('(', start)
  if (open === -1) return ''
  let depth = 1
  let i = open + 1
  while (i < sql.length && depth > 0) {
    if (sql[i] === '(') depth++
    else if (sql[i] === ')') depth--
    i++
  }
  return sql.slice(open + 1, i - 1)
}

/** Created tables that never `enable row level security`. */
function tablesMissingRls(sql: string): string[] {
  const enabled = rlsEnabledTables(sql)
  return createdTables(sql).filter(t => !enabled.has(t))
}

/**
 * Each `create policy` statement, mapped to the table it targets.
 *
 * SQL is tokenized on `;` FIRST so every policy is matched in isolation — a
 * lazy `[\s\S]*?` run across the whole file could otherwise stitch two
 * consecutive policies together (`create policy … on A … on B`) and let one
 * table's `auth.uid()` clear another table's unscoped policy.
 */
function policyStatements(sql: string): { table: string; text: string }[] {
  const out: { table: string; text: string }[] = []
  const re = new RegExp(`create\\s+policy\\b[\\s\\S]*?\\bon\\s+["']?${SCHEMA}(\\w+)["']?`, 'i')
  for (const stmt of sql.split(';')) {
    const m = re.exec(stmt)
    if (m) out.push({ table: m[1].toLowerCase(), text: stmt })
  }
  return out
}

/** User-scoped tables (have a `user_id` column) with no auth.uid()-scoped policy. */
function userTablesMissingScopedPolicy(sql: string): string[] {
  const policies = policyStatements(sql)
  const missing: string[] = []
  for (const table of createdTables(sql)) {
    if (!/\buser_id\b/.test(tableBody(sql, table))) continue
    const own = policies.filter(p => p.table === table)
    if (!own.some(p => /auth\.uid\(\)/i.test(p.text))) missing.push(table)
  }
  return missing
}

describe('Invariant: RLS enabled on every Supabase table (LIFT-1130)', () => {
  const migrations = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort()
    .map(f => ({ name: f, content: readFileSync(join(MIGRATIONS_DIR, f), 'utf-8') }))

  const sql = stripSqlComments(migrations.map(m => m.content).join('\n'))

  it('reads the real migrations directory (non-vacuity)', () => {
    // If this ever finds zero migrations the whole suite would pass for the
    // wrong reason — pin the core tables so a broken path can't hide a gap.
    expect(migrations.length).toBeGreaterThan(5)
    expect(createdTables(sql)).toEqual(
      expect.arrayContaining(['exercises', 'sets', 'bodyweight_entries']),
    )
  })

  it('the scan actually flags a table missing RLS / a scoped policy (self-test)', () => {
    // Proves the regexes aren't vacuously passing: a leaky table with a
    // user_id column but no RLS and no policy must be caught by both checks.
    const leaky = `create table leaky (
      id uuid primary key,
      user_id uuid not null references auth.users(id)
    );`
    const bad = stripSqlComments(leaky)
    expect(tablesMissingRls(bad)).toContain('leaky')
    expect(userTablesMissingScopedPolicy(bad)).toContain('leaky')

    // And a well-formed table passes both.
    const good = bad +
      '\nalter table leaky enable row level security;' +
      '\ncreate policy "p" on leaky for select using (auth.uid() = user_id);'
    expect(tablesMissingRls(good)).not.toContain('leaky')
    expect(userTablesMissingScopedPolicy(good)).not.toContain('leaky')

    // Cross-statement stitching guard: a scoped policy on ANOTHER table must
    // not launder an unscoped (or missing) policy on the target table.
    const stitched = bad +
      '\nalter table leaky enable row level security;' +
      '\ncreate policy "safe" on other for select using (auth.uid() = user_id);' +
      '\ncreate policy "leak" on leaky for select using (true);'
    expect(userTablesMissingScopedPolicy(stitched)).toContain('leaky')

    // Schema-qualified DDL (`public.<table>`) must resolve to the bare table
    // name, not the schema — otherwise an unprotected qualified table hides.
    const qualified = stripSqlComments(`create table public.walled (
      id uuid primary key,
      user_id uuid not null
    );`)
    expect(createdTables(qualified)).toContain('walled')
    expect(createdTables(qualified)).not.toContain('public')
    expect(tablesMissingRls(qualified)).toContain('walled')
  })

  it('every created table has RLS enabled in some migration', () => {
    const missing = tablesMissingRls(sql)

    expect(
      missing,
      'These tables are created but never `enable row level security`. ' +
      'The anon key is public, so RLS is the ONLY tenant boundary — a table ' +
      'without it exposes every user\'s rows. Add ' +
      '`alter table <name> enable row level security;` in the same migration:\n' +
      missing.join('\n'),
    ).toEqual([])
  })

  it('every user-scoped table carries at least one auth.uid()-scoped policy', () => {
    // A `user_id` column means rows belong to a user; that table must have at
    // least one policy that scopes access to auth.uid(). (Tables with no
    // user_id — e.g. the day-keyed coach_global_spend, touched only by
    // SECURITY DEFINER functions — are deliberately policy-free and skipped.)
    const violations = userTablesMissingScopedPolicy(sql).map(
      table =>
        `${table} — has a user_id column but no create policy scoped to ` +
        `auth.uid(). RLS with no scoped policy either denies all access or ` +
        `(if a permissive policy exists) leaks across tenants.`,
    )

    expect(violations).toEqual([])
  })
})

// ── Invariant: account deletion covers every user-scoped table (LIFT-1225) ──
// Guard: deleteAccount()'s table list was written on 2026-04-05 against the
// seven tables that existed then. The AI-Coach migration (2026-06-27) added
// three more — coach_usage, coach_usage_log, coach_consent — carrying the
// record that the user consented to health-data egress plus a per-request
// audit trail, and nothing updated the list. "Delete my data" wiped the device
// and left them on the server: a right-to-deletion (GDPR/CCPA) breach that no
// behavioural test could see, because a hardcoded test only ever pins the
// tables that existed when it was written. Same failure shape as the
// REPLAYABLE_COLUMNS drift (LIFT-1039), so it gets the same treatment —
// coverage is DERIVED from the migrations, not enumerated here.

/** Tables that carry a `user_id` column, i.e. hold rows belonging to a user. */
function userScopedTables(sql: string): string[] {
  return createdTables(sql).filter(t => /\buser_id\b/.test(tableBody(sql, t)))
}

/**
 * Tables a `create or replace function <name>` deletes from.
 *
 * The coach tables have no client DELETE policy by design, so they are removed
 * through a SECURITY DEFINER RPC. Reading the RPC's own body means a coach
 * table added to the schema but forgotten inside `delete_coach_data` is still
 * reported as uncovered.
 *
 * Reads the LAST definition, not the first. Migrations are concatenated in
 * apply order, and extending this RPC means shipping a second
 * `create or replace function` — so the first match is the stale body. Reading
 * it would let a later definition that DROPPED a `delete from` still read as
 * covered, which is the failure this invariant exists to catch.
 */
function tablesDeletedByFunction(sql: string, fn: string): string[] {
  const decl = new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+${SCHEMA}${fn}\\b`, 'gi')
  let start = -1
  let m: RegExpExecArray | null
  while ((m = decl.exec(sql)) !== null) start = m.index
  if (start === -1) return []
  // Body runs to the closing `$$` of the dollar-quoted block.
  const bodyStart = sql.indexOf('$$', start)
  const bodyEnd = bodyStart === -1 ? -1 : sql.indexOf('$$', bodyStart + 2)
  if (bodyEnd === -1) return []
  const body = sql.slice(bodyStart, bodyEnd)
  const re = new RegExp(`delete\\s+from\\s+["']?${SCHEMA}(\\w+)["']?`, 'gi')
  const out = new Set<string>()
  while ((m = re.exec(body)) !== null) out.add(m[1].toLowerCase())
  return [...out]
}

/** Tables removed by an `on delete cascade` FK to one of `covered`. */
function cascadeCoveredTables(sql: string, covered: Set<string>): string[] {
  const out: string[] = []
  for (const table of createdTables(sql)) {
    const body = tableBody(sql, table)
    const re = new RegExp(`references\\s+${SCHEMA}(\\w+)\\s*\\([^)]*\\)\\s*on\\s+delete\\s+cascade`, 'gi')
    let m: RegExpExecArray | null
    while ((m = re.exec(body)) !== null) {
      if (covered.has(m[1].toLowerCase())) { out.push(table); break }
    }
  }
  return out
}

describe('Invariant: account deletion covers every user-scoped table (LIFT-1225)', () => {
  const sql = stripSqlComments(
    readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
      .sort()
      .map(f => readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'))
      .join('\n'),
  )

  /** The body of deleteAccount() in useAuth.ts, up to its closing brace. */
  function deleteAccountBody(): string {
    const src = readFileSync(resolve(SRC_DIR, 'composables/useAuth.ts'), 'utf-8')
    const start = src.indexOf('async function deleteAccount(')
    expect(start, 'deleteAccount() not found in useAuth.ts — did it move?').toBeGreaterThan(-1)
    const end = src.indexOf('\n}', start)
    return src.slice(start, end)
  }

  /** Every table deleteAccount removes: direct, via an RPC, or via cascade. */
  function coveredTables(body: string): Set<string> {
    const covered = new Set<string>()
    const direct = /\.from\(\s*['"](\w+)['"]\s*\)\s*\.delete\(/g
    let m: RegExpExecArray | null
    while ((m = direct.exec(body)) !== null) covered.add(m[1].toLowerCase())

    const rpc = /\.rpc\(\s*['"](\w+)['"]/g
    while ((m = rpc.exec(body)) !== null) {
      for (const t of tablesDeletedByFunction(sql, m[1])) covered.add(t)
    }

    // Cascades are transitive; iterate to a fixed point so a grandchild table
    // is covered too.
    for (;;) {
      const before = covered.size
      for (const t of cascadeCoveredTables(sql, covered)) covered.add(t)
      if (covered.size === before) return covered
    }
  }

  it('reads the real schema and deleteAccount source (non-vacuity)', () => {
    // A broken path would make every check below pass for the wrong reason.
    expect(userScopedTables(sql)).toEqual(
      expect.arrayContaining(['exercises', 'sets', 'bodyweight_entries', 'coach_consent']),
    )
    expect(deleteAccountBody()).toContain('Promise.allSettled')
  })

  it('the scan resolves RPC and cascade coverage, and flags a gap (self-test)', () => {
    const schema = stripSqlComments(`
      create table parent (id uuid primary key, user_id uuid not null);
      create table child (
        id uuid primary key,
        user_id uuid not null,
        parent_id uuid not null references parent(id) on delete cascade
      );
      create table server_only (user_id uuid primary key);
      create table orphan (user_id uuid primary key);
      create or replace function purge() returns void language plpgsql as $$
      begin
        delete from public.server_only where user_id = v_uid;
      end;
      $$;
    `)
    expect(userScopedTables(schema).sort()).toEqual(['child', 'orphan', 'parent', 'server_only'])
    expect(tablesDeletedByFunction(schema, 'purge')).toEqual(['server_only'])
    expect(cascadeCoveredTables(schema, new Set(['parent']))).toEqual(['child'])
    // `orphan` is deleted by nothing — the shape this invariant exists to catch.
    expect(cascadeCoveredTables(schema, new Set(['parent']))).not.toContain('orphan')

    // A later `create or replace` REPLACES the function. Reading the first
    // definition would report a table the live function no longer deletes.
    const redefined = schema + stripSqlComments(`
      create or replace function purge() returns void language plpgsql as $$
      begin
        delete from public.orphan where user_id = v_uid;
      end;
      $$;
    `)
    expect(tablesDeletedByFunction(redefined, 'purge')).toEqual(['orphan'])
  })

  it('every user-scoped table is deleted by deleteAccount()', () => {
    const covered = coveredTables(deleteAccountBody())
    const missing = userScopedTables(sql).filter(t => !covered.has(t))

    expect(
      missing,
      `These tables hold rows keyed to a user but survive account deletion: ${missing.join(', ')}. ` +
      `"Delete my data" must leave nothing behind. Add the table to deleteAccount() in ` +
      `src/composables/useAuth.ts — directly when the client has a DELETE policy, or via a ` +
      `SECURITY DEFINER RPC when it does not (an RLS-blocked DELETE is NOT an error: it removes ` +
      `zero rows and resolves { error: null }, so it would report success).`,
    ).toEqual([])
  })
})

// ── Invariant: automatic reloads are circuit-broken (#1155) ─────────
// Guard: 2026-08-17 — the installed iOS PWA hit "A problem repeatedly
// occurred" (WebKit's kill screen for an app that fails repeatedly at boot).
// An automatic `location.reload()` whose trigger condition recurs after the
// reload loops the boot forever, with zero telemetry. guardedReload
// (src/lib/reloadGuard.ts) bounds every automatic reload to one per trigger
// per session and reports suppressed repeats to Sentry — but only if new
// reload sites actually route through it. This scan makes that structural.

describe('Invariant: automatic reloads go through guardedReload (#1155)', () => {
  const OWNER = join('lib', 'reloadGuard.ts')

  // USER-initiated reloads are exempt: a human tapping a button is not a
  // loop — the danger is code reloading with no human in the path. Every
  // entry here must be a reload behind an explicit user gesture.
  const USER_INITIATED = new Set([
    // Dev tools (localhost/LAN only), each behind an explicit tap.
    join('components', 'SettingsSheet.vue'),
  ])

  const RELOAD_CALL = /\blocation\s*\.\s*reload\s*\(/

  it('no source file calls location.reload() directly except the guard owner', () => {
    const files = getSourceFiles()
    // Non-vacuity: the walker must reach the owner and the known exempt
    // file, or this scan proves nothing.
    expect(files.map(f => f.path)).toContain(OWNER)
    expect(files.map(f => f.path)).toContain(join('components', 'SettingsSheet.vue'))

    const violations = files
      .filter(f => f.path !== OWNER && !USER_INITIATED.has(f.path))
      .filter(f => RELOAD_CALL.test(stripComments(f.content)))
      .map(f =>
        `${f.path} — calls location.reload() directly. An automatic reload ` +
        `whose trigger recurs is a boot loop; route it through ` +
        `guardedReload('<reason>') from src/lib/reloadGuard.ts. If this is a ` +
        `USER-initiated reload behind an explicit tap, add the file to the ` +
        `USER_INITIATED allowlist with a justification instead.`,
      )

    expect(violations).toEqual([])
  })

  it('the scan actually flags a direct reload and skips commented ones (self-test)', () => {
    expect(RELOAD_CALL.test(stripComments('const a = 1\nwindow.location.reload()'))).toBe(true)
    expect(RELOAD_CALL.test(stripComments('doRefresh()\nlocation.reload()'))).toBe(true)
    expect(RELOAD_CALL.test(stripComments('// window.location.reload()'))).toBe(false)
    expect(RELOAD_CALL.test(stripComments(' * `controllerchange → window.location.reload()`'))).toBe(false)
  })

  it('the exempt call sites are still the dev tools they were vetted as', () => {
    // The allowlist is only sound while its reloads stay behind the
    // localhost-gated dev tools. If SettingsSheet's dev gate disappears,
    // re-vet every reload in the file before loosening this.
    const settingsSheet = readFileSync(join(SRC_DIR, 'components', 'SettingsSheet.vue'), 'utf-8')
    expect(settingsSheet).toMatch(/const isDev = /)
  })
})

// ── Invariant: component window/document listeners are lifecycle-scoped ──
//
// LIFT-1240: App.vue registered its `online`/`offline` listeners in the
// `<script setup>` body and never removed them, so every instance left a
// permanent pair of window listeners holding a closure over its reactive
// scope. Dispatching `offline` then ran handlers from already-unmounted
// instances, mutating the module-level `syncStatus` — the cross-test
// state-leak class LIFT-966 is about, and a stale closure surviving HMR in
// dev. Two structural rules make the omission impossible to repeat.

describe('Invariant: component global listeners are lifecycle-scoped (LIFT-1240)', () => {
  const LISTENER = /\b(?:window|document)\s*\.\s*(add|remove)EventListener\(\s*['"]([\w:-]+)['"]/g
  // A call starting at column 0 inside a .vue file is in the `<script setup>`
  // body — i.e. it runs at setup time and is outside any lifecycle hook.
  const TOP_LEVEL_ADD = /^(?:window|document)\s*\.\s*addEventListener\(/m

  function vueFiles() {
    return getSourceFiles().filter(f => f.path.endsWith('.vue'))
  }

  /** Event names passed to add/removeEventListener, split by direction. */
  function listenerEvents(source: string): { added: Set<string>; removed: Set<string> } {
    const added = new Set<string>()
    const removed = new Set<string>()
    for (const [, direction, event] of source.matchAll(LISTENER)) {
      ;(direction === 'add' ? added : removed).add(event)
    }
    return { added, removed }
  }

  it('every window/document listener a component adds is also removed', () => {
    const files = vueFiles()
    // Non-vacuity: the walker must reach the two components that actually
    // register global listeners, or this scan proves nothing.
    expect(files.map(f => f.path)).toContain('App.vue')
    expect(files.map(f => f.path)).toContain(join('components', 'InfoPopover.vue'))

    const violations: string[] = []
    for (const file of files) {
      const { added, removed } = listenerEvents(stripComments(file.content))
      for (const event of added) {
        if (!removed.has(event)) {
          violations.push(
            `${file.path} — adds a '${event}' listener with no matching ` +
            `removeEventListener. A component listener that outlives its ` +
            `instance keeps mutating shared state after unmount (LIFT-1240); ` +
            `pair it with a removal in onUnmounted.`,
          )
        }
      }
    }

    expect(violations).toEqual([])
  })

  it('no component registers a global listener in the setup body', () => {
    const violations = vueFiles()
      .filter(f => TOP_LEVEL_ADD.test(stripComments(f.content)))
      .map(f =>
        `${f.path} — registers a window/document listener at the top level of ` +
        `<script setup>. Register it in onMounted so the paired onUnmounted ` +
        `removal actually covers it (LIFT-1240).`,
      )

    expect(violations).toEqual([])
  })

  it('the scans flag the LIFT-1240 shape and ignore comments (self-test)', () => {
    const leaky = "window.addEventListener('online', onOnline)\nonUnmounted(() => {})"
    expect(TOP_LEVEL_ADD.test(stripComments(leaky))).toBe(true)
    expect([...listenerEvents(stripComments(leaky)).added]).toEqual(['online'])
    expect(listenerEvents(stripComments(leaky)).removed.size).toBe(0)

    const balanced =
      "onMounted(() => {\n  window.addEventListener('online', onOnline)\n})\n" +
      "onUnmounted(() => {\n  window.removeEventListener('online', onOnline)\n})"
    expect(TOP_LEVEL_ADD.test(stripComments(balanced))).toBe(false)
    const events = listenerEvents(stripComments(balanced))
    expect([...events.added]).toEqual([...events.removed])

    // A comment quoting the banned shape must not trip either scan.
    const documented = "// window.addEventListener('online', onOnline)"
    expect(TOP_LEVEL_ADD.test(stripComments(documented))).toBe(false)
    expect(listenerEvents(stripComments(documented)).added.size).toBe(0)
  })
})


// ── Invariant: tests of now-relative windows pin the clock (#1254) ──

describe('Invariant: tests of now-relative windows pin the clock (#1254)', () => {
  /**
   * `calculateBest1RM` is the one windowing helper that reads the clock itself
   * (`Date.now() - windowMonths`) instead of taking a `now` parameter the way
   * `promptArbiter`, `coachHistory` and `useAppReview` do — and `scoreSet`
   * inherits that through it. A test that feeds either one absolute dates is
   * therefore asserting against the calendar rather than the behaviour, and
   * passes only until wall-clock time carries its fixtures past the cutoff.
   *
   * Not hypothetical: `progressionIntegration.test.ts` picked 2026-03-01 as a
   * date "safely inside" a 6-month window, went red five months later, and took
   * `master` — and therefore every open PR — with it (#1254).
   * `setScoring.test.ts` was roughly a month behind it with the same shape.
   *
   * `xp.test.ts` had already found the fix (freeze the clock, then date the
   * fixtures against it) and documented why. The lesson simply had no way to
   * reach the next file that needed it, which is what this scan is for: pinning
   * the clock is cheap, and it is the difference between a test that measures
   * the window and one that measures the day it was written.
   */
  const WINDOW_CONSUMER = /\b(?:calculateBest1RM|scoreSet)\s*\(/
  const PINS_CLOCK = /vi\.setSystemTime\s*\(/

  /** Every `.ts` test file under a `__tests__/` directory, except this one. */
  function getTestFiles(dir = SRC_DIR, out: { path: string; content: string }[] = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) getTestFiles(full, out)
      else if (/\.test\.ts$/.test(entry.name) && full !== __filename) {
        out.push({ path: relative(SRC_DIR, full), content: readFileSync(full, 'utf-8') })
      }
    }
    return out
  }

  it('every test exercising the rolling 1RM window freezes the clock', () => {
    const consumers = getTestFiles().filter(f => WINDOW_CONSUMER.test(stripComments(f.content)))

    // Non-vacuity: the walker must reach the known consumers, or a broken
    // regex/walk would let this pass while scanning nothing.
    expect(consumers.map(f => f.path)).toEqual(
      expect.arrayContaining([
        join('lib', '__tests__', 'setScoring.test.ts'),
        join('lib', '__tests__', 'xp.test.ts'),
        join('__tests__', 'progressionIntegration.test.ts'),
      ]),
    )

    const violations = consumers
      .filter(f => !PINS_CLOCK.test(f.content))
      .map(f =>
        `${f.path} — calls calculateBest1RM/scoreSet without vi.setSystemTime. ` +
        `Their 6-month window is measured from Date.now(), so fixtures with ` +
        `absolute dates age out of it and the file fails on a day nobody ` +
        `touched it (#1254). Freeze the clock and date the fixtures from it.`,
      )

    expect(violations).toEqual([])
  })

  it('the scan flags an unpinned consumer and ignores comments (self-test)', () => {
    const unpinned = "expect(calculateBest1RM(sets)).toBe(263)"
    expect(WINDOW_CONSUMER.test(stripComments(unpinned))).toBe(true)
    expect(PINS_CLOCK.test(unpinned)).toBe(false)

    const pinned = "vi.setSystemTime(NOW)\nexpect(scoreSet({ priorSets })).toBe(1)"
    expect(WINDOW_CONSUMER.test(stripComments(pinned))).toBe(true)
    expect(PINS_CLOCK.test(pinned)).toBe(true)

    // Importing the symbol is not exercising it, and a comment naming it is not
    // either — neither should drag a file into the scan.
    expect(WINDOW_CONSUMER.test(stripComments("import { calculateBest1RM } from '../xp'"))).toBe(false)
    expect(WINDOW_CONSUMER.test(stripComments('// calculateBest1RM(sets) rolls forward'))).toBe(false)
  })
})

describe('Invariant: REPLAYABLE_COLUMNS stays in lockstep with its producers (LIFT-1039)', () => {
  /**
   * The durable journal re-validates every replayed descriptor against
   * REPLAYABLE_COLUMNS because the journal lives in user-writable IndexedDB
   * (LIFT-785). `isAllowedColumnMap` is all-or-nothing — it rejects the WHOLE
   * descriptor if a single key is missing — so one un-allowlisted column
   * silently discards EVERY journaled write for that table on rehydrate(),
   * defeating the durable queue for the exact offline case it exists for.
   *
   * That drift is silent by construction and has now happened three times on
   * `exercises`: `equipment` (#931) and `gyms` (#961), then `plate_count_mode`
   * (LIFT-783), then `notes` (#619) and `bodyweight_loaded` (LIFT-834). Each
   * was added to `_buildExerciseUpsert` as an always-send column without a
   * matching allowlist entry. The behavioural test that shipped with LIFT-1039
   * pinned a hardcoded row literal, so it could only ever prove the columns
   * that existed the day it was written — which is precisely why the next two
   * columns drifted past it. This scan derives the expectation from the
   * producer instead, so a new column fails here the moment it is added.
   */
  const SYNC_QUEUE = readFileSync(join(SRC_DIR, 'lib/syncQueue.ts'), 'utf-8')
  const WORKOUT_STORE = readFileSync(join(STORES_DIR, 'workout.ts'), 'utf-8')

  /** The first balanced `open`…`close` block following `marker` ('' if absent). */
  function blockAfter(source: string, marker: string, open = '{', close = '}'): string {
    const start = source.indexOf(marker)
    if (start === -1) return ''
    const from = source.indexOf(open, start + marker.length)
    if (from === -1) return ''
    let depth = 0
    for (let i = from; i < source.length; i++) {
      if (source[i] === open) depth++
      else if (source[i] === close && --depth === 0) return source.slice(from, i + 1)
    }
    return ''
  }

  /** Column keys in an upsert row literal, including those inside `...(c ? { k: v } : {})`. */
  function columnKeys(literal: string): Set<string> {
    const keys = new Set<string>()
    const re = /(?:^|[{,])\s*([a-z_][a-z0-9_]*)\s*:/gm
    let m: RegExpExecArray | null
    while ((m = re.exec(stripComments(literal))) !== null) keys.add(m[1])
    return keys
  }

  /** Members of `REPLAYABLE_COLUMNS.<table>`. */
  function allowlistFor(table: string): Set<string> {
    const block = blockAfter(SYNC_QUEUE, `${table}: new Set(`, '[', ']')
    const out = new Set<string>()
    for (const q of stripComments(block).match(/'[a-z_][a-z0-9_]*'/g) ?? []) out.add(q.slice(1, -1))
    return out
  }

  const PRODUCERS = [
    { table: 'exercises', marker: 'function _buildExerciseUpsert', source: WORKOUT_STORE },
    { table: 'sets', marker: 'function _enqueueSetUpsert', source: WORKOUT_STORE },
  ] as const

  it('the extractors find real columns and a real allowlist (non-vacuity)', () => {
    const exercise = columnKeys(blockAfter(WORKOUT_STORE, 'function _buildExerciseUpsert'))
    // Anchors that must exist regardless of how the row is spelled.
    for (const col of ['id', 'user_id', 'name', 'tags', 'plate_count_mode']) {
      expect(exercise.has(col)).toBe(true)
    }
    // A conditional spread column must be seen too, or the scan misses the
    // exact shape most likely to drift.
    expect(exercise.has('input_mode')).toBe(true)
    expect(exercise.size).toBeGreaterThan(10)
    expect(allowlistFor('exercises').size).toBeGreaterThan(10)
    expect(allowlistFor('sets').has('estimated_1rm')).toBe(true)
  })

  it('the scan flags a column the allowlist is missing (self-test)', () => {
    const literal = "{ id: x.id, user_id: u, ...(x.m ? { input_mode: x.m } : {}), notes: x.notes ?? null }"
    const keys = columnKeys(literal)
    expect(keys).toEqual(new Set(['id', 'user_id', 'input_mode', 'notes']))
    // A ternary's own `:` and a `??` default must not be read as column keys.
    expect(keys.has('m')).toBe(false)
    const allowed = new Set(['id', 'user_id', 'input_mode'])
    expect([...keys].filter(k => !allowed.has(k))).toEqual(['notes'])
  })

  it('every column an upsert producer always sends is replayable', () => {
    const violations: string[] = []
    for (const { table, marker, source } of PRODUCERS) {
      const allowed = allowlistFor(table)
      for (const col of columnKeys(blockAfter(source, marker))) {
        if (!allowed.has(col)) violations.push(`${table}.${col} (sent by ${marker})`)
      }
    }
    expect(violations).toEqual([])
  })
})

// ── Invariant: every RPC the client calls exists in a migration (#1299) ──
// Guard: an `.rpc('name')` argument is a plain string, so a rename on either
// side — or a caller added ahead of its migration — typechecks, lints, and
// passes every fake-Supabase test, then fails only against the real database.
// PostgREST answers a missing function with a RESOLVED `{ error: PGRST202 }`,
// never a rejection: the same resolved-vs-rejected trap LIFT-1225 closed for
// deletes.
//
// It bites hardest on the account-deletion path (#1299). `delete_user_account`
// runs LAST, after the per-table deletes have already succeeded, so a
// name/schema mismatch there fails having already destroyed the user's rows.
// LIFT-1169 (migrate-db racing Vercel's git auto-deploy) makes the
// code-ahead-of-schema window real rather than theoretical, so the caller and
// its migration have to ship in the same commit.
describe('Invariant: client RPC names exist in the migrations (#1299)', () => {
  const migrationSql = stripSqlComments(
    readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
      .sort()
      .map(f => readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'))
      .join('\n'),
  )

  /** Every function name introduced by a `create [or replace] function <name>(`. */
  function definedFunctions(sql: string): Set<string> {
    const re = /create\s+(?:or\s+replace\s+)?function\s+["']?(?:\w+\.)?(\w+)["']?\s*\(/gi
    const names = new Set<string>()
    let m: RegExpExecArray | null
    while ((m = re.exec(sql)) !== null) names.add(m[1].toLowerCase())
    return names
  }

  /** Every literal name passed to `supabase.rpc('…')` in app source. */
  function calledRpcs(): { name: string; file: string }[] {
    const calls: { name: string; file: string }[] = []
    for (const { path, content } of getSourceFiles()) {
      const re = /\.rpc\(\s*['"]([\w.]+)['"]/g
      let m: RegExpExecArray | null
      while ((m = re.exec(content)) !== null) calls.push({ name: m[1], file: path })
    }
    return calls
  }

  it('the scan finds the migrations and the delete_user_account caller (non-vacuity)', () => {
    // Without this the invariant below would pass for the wrong reason the
    // moment either regex stopped matching (or a path broke).
    expect(definedFunctions(migrationSql).has('delete_user_account')).toBe(true)
    expect(calledRpcs().map(c => c.name)).toContain('delete_user_account')
  })

  it('the scan flags an RPC name with no matching definition (self-test)', () => {
    const defined = definedFunctions('create or replace function real_one() returns void as $$ $$;')
    expect(defined.has('real_one')).toBe(true)
    expect(defined.has('typo_one')).toBe(false)
  })

  it('every RPC the client calls is defined by a migration', () => {
    const defined = definedFunctions(migrationSql)
    const violations = calledRpcs()
      .filter(c => !defined.has(c.name.toLowerCase()))
      .map(
        c =>
          `${c.file} calls supabase.rpc('${c.name}') but no migration defines ` +
          'that function. PostgREST resolves a missing function as ' +
          '{ error: PGRST202 } rather than rejecting, so this fails silently ' +
          'against the real database. Ship the migration in the same commit.',
      )

    expect(violations).toEqual([])
  })
})


// ── Invariant: every role="switch" has an accessible name (LIFT-1308) ──

describe('Invariant: every role="switch" carries an accessible name (LIFT-1308)', () => {
  /**
   * A `role="switch"` built from a `<button>` plus a decorative knob `<span>`
   * has NO accessible name — `aria-checked` supplies the state and the role
   * supplies the role, but AT announces only "switch, off" with nothing saying
   * what it does (WCAG 4.1.2, Level A). All three `.iosToggle` switches shipped
   * that way, and `EditExerciseModal` carried two of them in one sheet,
   * announced identically.
   *
   * Derived rather than enumerated, for the same reason the deleteAccount and
   * REPLAYABLE_COLUMNS invariants are: `accessibility.axe.test.ts` scans a
   * hardcoded list of three components, so a switch added to any of the other
   * ~40 is unreachable by it. LIFT-1304 even scoped its own axe scan around
   * this violation rather than failing on it. A source scan covers every
   * switch that exists, including the ones nobody has written a test for.
   *
   * A name may come from the author (`aria-label` / `aria-labelledby`, static
   * or bound) or from the element's contents, which the `switch` role permits
   * — the `.wtWarmupToggle` switches render a visible text span.
   */
  // Both quote styles: a guard that silently misses a switch is worse than no
  // guard, since it reports green over the exact gap it exists to close.
  const SWITCH_ROLE = /role\s*=\s*["']switch["']/g
  // Leading `\s` or `:` so the shorthand, the `v-bind:` longform and the plain
  // attribute all count — a false failure here reads as a broken rule.
  const NAME_ATTR = /[\s:]aria-label(?:ledby)?\s*=/

  /** Forward scan for the tag's `>`, skipping quoted attribute values so an
   *  arrow function or comparison inside a handler can't end the tag early. */
  function tagEnd(source: string, from: number): number {
    let quote: string | null = null
    for (let i = from; i < source.length; i++) {
      const c = source[i]
      if (quote) {
        if (c === quote) quote = null
        continue
      }
      if (c === '"' || c === "'") {
        quote = c
        continue
      }
      if (c === '>') return i
    }
    return -1
  }

  /** Every `role="switch"` element as { tag, inner } — the opening tag's
   *  attribute text, and the element's contents. */
  function switchElements(source: string): { tag: string; inner: string }[] {
    const out: { tag: string; inner: string }[] = []
    for (const m of source.matchAll(SWITCH_ROLE)) {
      const start = source.lastIndexOf('<', m.index)
      if (start === -1) continue
      const end = tagEnd(source, start)
      if (end === -1) continue
      const tag = source.slice(start, end + 1)
      const tagName = /^<([\w-]+)/.exec(tag)?.[1] ?? ''
      const close = source.indexOf('</' + tagName + '>', end)
      out.push({ tag, inner: close === -1 ? '' : source.slice(end + 1, close) })
    }
    return out
  }

  /** Contents with markup removed — `{{ … }}` interpolation counts as text,
   *  an empty decorative `<span>` does not. */
  const hasTextContent = (inner: string) => /\S/.test(inner.replace(/<[^>]*>/g, ''))

  const named = (el: { tag: string; inner: string }) =>
    NAME_ATTR.test(el.tag) || hasTextContent(el.inner)

  const vueFiles = () => getSourceFiles().filter(f => f.path.endsWith('.vue'))

  it('reads the real components and finds every switch (non-vacuity)', () => {
    const withSwitches = vueFiles().filter(f => switchElements(f.content).length > 0)
    // The two families: `.iosToggle` (LIFT-1308) and `.glassToggle` (already
    // named). If either drops out, the scan below passes vacuously.
    expect(withSwitches.map(f => f.path)).toContain(join('components', 'EditExerciseModal.vue'))
    expect(withSwitches.map(f => f.path)).toContain(join('components', 'SettingsSheet.vue'))
    expect(
      switchElements(vueFiles().find(f => f.path.endsWith('EditExerciseModal.vue'))!.content),
    ).toHaveLength(2)
  })

  it('the scan flags an unnamed switch and accepts each naming route (self-test)', () => {
    const knobOnly =
      '<button class="iosToggle" role="switch" :aria-checked="on">\n' +
      '  <span class="iosToggleKnob"></span>\n</button>'
    expect(named(switchElements(knobOnly)[0])).toBe(false)

    const byLabelledby = knobOnly.replace('role="switch"', 'role="switch" aria-labelledby="x"')
    expect(named(switchElements(byLabelledby)[0])).toBe(true)

    const byBoundLabel = knobOnly.replace(
      'role="switch"',
      'role="switch" :aria-label="on ? \'Disable x\' : \'Enable x\'"',
    )
    expect(named(switchElements(byBoundLabel)[0])).toBe(true)

    const byContent = knobOnly.replace('<span class="iosToggleKnob"></span>', '<span>{{ label }}</span>')
    expect(named(switchElements(byContent)[0])).toBe(true)

    const byLongformBind = knobOnly.replace('role="switch"', 'role="switch" v-bind:aria-label="l"')
    expect(named(switchElements(byLongformBind)[0])).toBe(true)

    // A `>` inside a handler must not end the tag before its name attribute.
    const arrowHandler =
      '<button role="switch" @click="() => toggle()" aria-label="Toggle it">\n' +
      '  <span class="knob"></span>\n</button>'
    expect(named(switchElements(arrowHandler)[0])).toBe(true)

    // A single-quoted role attribute is still a switch, and still scanned.
    expect(switchElements(knobOnly.replace('role="switch"', "role='switch'"))).toHaveLength(1)
  })

  it('no component renders a switch with no accessible name', () => {
    const violations: string[] = []
    for (const file of vueFiles()) {
      for (const el of switchElements(stripComments(file.content))) {
        if (named(el)) continue
        violations.push(
          `${file.path} — a role="switch" with no aria-label/aria-labelledby ` +
          'and no text content announces as "switch, off", with nothing saying ' +
          'what it toggles (WCAG 4.1.2, LIFT-1308). Point aria-labelledby at ' +
          'the visible row label: ' + el.tag.replace(/\s+/g, ' ').slice(0, 90),
        )
      }
    }

    expect(violations).toEqual([])
  })
})


// ── Invariant: volume math folds bodyweight (#1333) ─────────────────
//
// `set.weight` is the ADDED weight on a `bodyweightLoaded` exercise (LIFT-834),
// so `set.weight * set.reps` is not this app's volume — it is the plate volume
// of a pull-up, which for a plain bodyweight rep is exactly 0. The fold has one
// owner, `effectiveSetWeight`, and every volume site is supposed to route
// through it.
//
// It has now drifted twice for the same structural reason: the fold needs the
// EXERCISE, and a volume loop that has flattened its rows (or was written
// against a `Ref<Exercise[]>` before the flag existed) reaches for the bare
// `.weight` sitting right there. LIFT-834 folded `sessionSummary` and the
// exercise graph and left the weekly trend, the per-tag trend, the calendar day
// summary, the training report and the theme stats un-folded — two different
// answers for the same sets on two screens of the same app — and no behavioural
// test could see it, because not one fixture in any of those five suites sets
// `bodyweightLoaded`. #1328 was the same omission on the inverse direction.
//
// A per-file test only ever pins the sites that existed when it was written,
// which is the failure mode this scan exists to end: a NEW volume sum is
// structurally unable to forget the fold.
describe('Invariant: volume math folds bodyweight through effectiveSetWeight (#1333)', () => {
  // The fold's owner, which necessarily names both halves.
  const OWNER = join('lib', 'bodyweightLoad.ts')

  // A `.weight` multiplied directly by a `.reps` (either order). The trailing
  // `\)*` admits an intervening unit conversion — `toDisplay(s.weight) * s.reps`
  // is the training report's shape and was one of the defects — while the
  // property-chain operand keeps the two halves in ONE product, so
  // `a.weight * 2 + b.reps * 3` (two unrelated products) does not flag. Bare
  // identifiers are deliberately not matched: `epley(weight, reps)` computes
  // `weight * (1 + reps / 30)` on parameters whose caller has already folded.
  const OPERAND = String.raw`[\w$]+(?:\.[\w$]+)*`
  const RAW_VOLUME = new RegExp(
    String.raw`\.weight\b\s*\)*\s*\*\s*${OPERAND}\.reps\b` +
      '|' +
      String.raw`\.reps\b\s*\)*\s*\*\s*${OPERAND}\.weight\b`,
  )

  /** Every raw-volume expression in `source`, comments already stripped. */
  function rawVolumeMatches(source: string): string[] {
    const re = new RegExp(RAW_VOLUME.source, 'g')
    const found: string[] = []
    let m: RegExpExecArray | null
    while ((m = re.exec(source)) !== null) found.push(m[0].replace(/\s+/g, ' '))
    return found
  }

  it('the scan reaches the fold owner and its real consumers (non-vacuity)', () => {
    const files = getSourceFiles()
    const paths = files.map(f => f.path)
    expect(paths).toContain(OWNER)
    // Sanctioned volume sites — if these stop existing (or stop calling the
    // helper) the scan below would pass having proved nothing.
    for (const consumer of [
      join('lib', 'sessionSummary.ts'),
      join('lib', 'trainingReport.ts'),
      join('lib', 'themeStats.ts'),
      join('composables', 'useVolumeTrend.ts'),
      join('composables', 'useTagVolumeTrend.ts'),
      join('composables', 'useCalendarData.ts'),
      join('components', 'ExerciseGraph.vue'),
    ]) {
      expect(paths).toContain(consumer)
      expect(files.find(f => f.path === consumer)!.content).toMatch(/effectiveSetWeight/)
    }
  })

  it('the scan flags the #1333 shapes and ignores comments (self-test)', () => {
    // The five real defects, verbatim in shape.
    expect(RAW_VOLUME.test('byWeek.set(wk, (byWeek.get(wk) ?? 0) + set.weight * set.reps)')).toBe(true)
    expect(RAW_VOLUME.test('const vol = set.weight * set.reps')).toBe(true)
    expect(RAW_VOLUME.test('totalVolume += s.weight * s.reps')).toBe(true)
    expect(RAW_VOLUME.test('sum + toDisplay(s.weight) * s.reps')).toBe(true)
    expect(RAW_VOLUME.test('stats.totalVolume += setInfo.weight * setInfo.reps')).toBe(true)
    // Reversed operand order, and a product split across two lines.
    expect(RAW_VOLUME.test('total += s.reps * s.weight')).toBe(true)
    expect(RAW_VOLUME.test('total +=\n  toDisplay(s.weight) *\n  s.reps')).toBe(true)

    // The fixes, and the shapes that must stay legal.
    expect(RAW_VOLUME.test('const vol = effectiveSetWeight(s, ex) * s.reps')).toBe(false)
    expect(RAW_VOLUME.test('sum + toDisplay(s.effectiveWeight) * s.reps')).toBe(false)
    expect(RAW_VOLUME.test('return Math.round(weight * (1 + reps / 30))')).toBe(false)
    expect(RAW_VOLUME.test('{ weight: s.weight, reps: s.reps }')).toBe(false)
    // Two separate products, not a volume.
    expect(RAW_VOLUME.test('a.weight * 2 + b.reps * 3')).toBe(false)

    // Comments quoting the banned shape must not flag — a guard that fails on
    // its own documentation is a guard people delete.
    expect(RAW_VOLUME.test(stripComments('// totalVolume += s.weight * s.reps'))).toBe(false)
    expect(RAW_VOLUME.test(stripComments(' * volume is `set.weight * set.reps`'))).toBe(false)
  })

  it('no source file multiplies a raw set weight by its reps', () => {
    const violations = getSourceFiles()
      .filter(f => f.path !== OWNER)
      .flatMap(f => rawVolumeMatches(stripComments(f.content)).map(text => ({ path: f.path, text })))
      .map(
        v =>
          `${v.path} — \`${v.text}\` multiplies a raw set weight by its reps. On a ` +
          'bodyweightLoaded exercise `set.weight` is only the ADDED plate weight, ' +
          'so this reports 0 volume for a pure-bodyweight set and undercounts every ' +
          'weighted one (#1333). Multiply `effectiveSetWeight(set, exercise)` ' +
          'instead — it is exactly `set.weight` for every other exercise. If the ' +
          'row has been flattened away from its exercise, resolve the effective ' +
          'weight where the exercise is still in scope (see trainingReport.ts).',
      )

    expect(violations).toEqual([])
  })
})


// ── Invariant: role="button" means keyboard-operable (LIFT-1305) ─────
//
// `role="button"` is a promise to assistive tech: this behaves like a button.
// A native `<button>` keeps that promise for free — it takes focus, and the UA
// synthesises a click for BOTH Enter and Space. An element that only borrows
// the role keeps none of it, so the author has to re-supply all three parts,
// and a partial job is worse than none: the control announces as a button,
// takes a tab stop, and then swallows the key the user was told to press.
//
// The app already had five correct copies of the pattern (the tag/gym/exercise
// manager labels, the calendar cells, the bodyweight rows) when three of the
// four to-beat cards in the log sheet shipped with a bare `@click`, and the
// remaining two `role="button"` divs handled Enter but not Space — Space just
// scrolled the sheet behind them. It is an omission each time, never a
// decision, which is exactly the shape a source scan can end.
//
// Derived rather than enumerated for the same reason as the `role="switch"`
// naming rule above: `accessibility.axe.test.ts` scans a hardcoded list of
// three components, and axe cannot see a missing key handler at all — that is
// a behaviour, not an attribute. This scan covers every custom button that
// exists, including the ones nobody has written a test for.
describe('Invariant: every custom role="button" is keyboard-operable (LIFT-1305)', () => {
  // Literal `role="button"` and the bound form `:role="cond ? 'button' : …"`,
  // in either quote style — a guard that misses a call site reports green over
  // the exact gap it exists to close.
  const BUTTON_ROLE = /[\s:](?:v-bind:)?role\s*=\s*(?:"[^"]*\bbutton\b[^"]*"|'[^']*\bbutton\b[^']*')/g
  const TABINDEX = /[\s:](?:v-bind:)?tabindex\s*=/
  const hasEnter = (tag: string) => /(?:@|v-on:)keydown\.enter\b/.test(tag)
  const hasSpace = (tag: string) => /(?:@|v-on:)keydown\.space\b/.test(tag)

  /** Forward scan for the tag's `>`, skipping quoted attribute values so a
   *  ternary or arrow function inside an attribute can't end the tag early. */
  function tagEnd(source: string, from: number): number {
    let quote: string | null = null
    for (let i = from; i < source.length; i++) {
      const c = source[i]
      if (quote) {
        if (c === quote) quote = null
        continue
      }
      if (c === '"' || c === "'") {
        quote = c
        continue
      }
      if (c === '>') return i
    }
    return -1
  }

  /** Every element carrying a button role, as its opening-tag text. */
  function buttonRoleTags(source: string): string[] {
    const out: string[] = []
    for (const m of source.matchAll(BUTTON_ROLE)) {
      const start = source.lastIndexOf('<', m.index)
      if (start === -1) continue
      const end = tagEnd(source, start)
      if (end === -1) continue
      out.push(source.slice(start, end + 1))
    }
    return out
  }

  /** A native <button> is keyboard-operable by definition; a borrowed role
   *  needs focusability plus both activation keys re-supplied by hand. */
  function operable(tag: string): boolean {
    if (/^<button[\s/>]/.test(tag)) return true
    return TABINDEX.test(tag) && hasEnter(tag) && hasSpace(tag)
  }

  const vueFiles = () => getSourceFiles().filter(f => f.path.endsWith('.vue'))

  it('reads the real components and finds every custom button (non-vacuity)', () => {
    const paths = vueFiles()
      .filter(f => buttonRoleTags(stripComments(f.content)).length > 0)
      .map(f => f.path)
    // A literal role, and CalendarView's bound `:role="… ? 'button' : undefined"`.
    // If either drops out of the scan, the check below passes vacuously.
    expect(paths).toContain(join('components', 'TagManagerModal.vue'))
    expect(paths).toContain(join('views', 'CalendarView.vue'))
    // The log sheet's to-beat card chain plus the plate-calculator hint.
    const tracker = vueFiles().find(f => f.path.endsWith('WorkoutTracker.vue'))!
    expect(buttonRoleTags(stripComments(tracker.content)).length).toBeGreaterThanOrEqual(5)
  })

  it('flags each missing part and accepts a native button (self-test)', () => {
    const full =
      '<div class="card" role="button" tabindex="0" ' +
      '@click="go" @keydown.enter="go" @keydown.space.prevent="go">x</div>'
    expect(operable(buttonRoleTags(full)[0])).toBe(true)

    // The LIFT-1305 shapes: Space forgotten, Enter forgotten, no tab stop.
    expect(operable(buttonRoleTags(full.replace(' @keydown.space.prevent="go"', ''))[0])).toBe(false)
    expect(operable(buttonRoleTags(full.replace(' @keydown.enter="go"', ''))[0])).toBe(false)
    expect(operable(buttonRoleTags(full.replace(' tabindex="0"', ''))[0])).toBe(false)

    // Bound role + bound tabindex + longform v-on all count.
    const bound =
      '<div :role="on ? \'button\' : undefined" :tabindex="on ? 0 : undefined" ' +
      'v-on:keydown.enter="go" v-on:keydown.space.prevent="go">x</div>'
    expect(buttonRoleTags(bound)).toHaveLength(1)
    expect(operable(buttonRoleTags(bound)[0])).toBe(true)

    // A native <button> needs none of it.
    expect(operable(buttonRoleTags('<button role="button">x</button>')[0])).toBe(true)

    // Single quotes are still a button role; a `>` inside a bound attribute
    // must not end the tag before its handlers.
    expect(buttonRoleTags("<span role='button' tabindex='0'>x</span>")).toHaveLength(1)
    const arrow =
      '<div :role="n > 0 ? \'button\' : undefined" tabindex="0" ' +
      '@keydown.enter="go" @keydown.space="go">x</div>'
    expect(operable(buttonRoleTags(arrow)[0])).toBe(true)

    // Roles that merely contain the letters must not be swept in.
    expect(buttonRoleTags('<div role="progressbar" aria-valuenow="1"></div>')).toHaveLength(0)
  })

  it('no component borrows the button role without re-supplying the keyboard', () => {
    const violations: string[] = []
    for (const file of vueFiles()) {
      for (const tag of buttonRoleTags(stripComments(file.content))) {
        if (operable(tag)) continue
        violations.push(
          `${file.path} — a custom role="button" must also carry tabindex plus ` +
          'BOTH @keydown.enter and @keydown.space, or it announces as a button ' +
          'and then ignores the keys a button responds to (WCAG 2.1.1, ' +
          'LIFT-1305): ' + tag.replace(/\s+/g, ' ').slice(0, 110),
        )
      }
    }

    expect(violations).toEqual([])
  })
})

// ── Invariant: every WorkoutSet field is synced or preserved (#1357) ─
//
// A `WorkoutSet` field is in one of exactly two states, and there is no third:
// either the `sets` table has a column for it (so `_enqueueSetUpsert` sends it
// and `mapRemoteSet` reads it back), or it lives on the device only and must be
// carried across a merge by `LOCAL_ONLY_SET_FIELDS`.
//
// `rpe` (#617) and `bodyweight` (LIFT-834) shipped in neither. `mergeEntities`
// picks an exercise wholesale by last-write-wins, sets and all, and the union
// after it only adds sets the winner is MISSING — so when the remote row won (a
// rename on a second device is enough), every set present on both sides was
// replaced by the server's copy of itself, and the two fields the server cannot
// carry were gone. Silent, routine, and committed to localStorage, so the next
// cold start loaded the stripped copy.
//
// Derived rather than enumerated because the failure is an OMISSION: adding an
// optional field to `WorkoutSet` is a one-line edit, and nothing about it
// prompts the author to think about a merge three files away. Deriving both
// sides means a new field has to be given one of the two homes or this fails.
describe('Invariant: every WorkoutSet field is synced or locally preserved (#1357)', () => {
  const WORKOUT_STORE = readFileSync(join(STORES_DIR, 'workout.ts'), 'utf-8')
  const REMOTE_ROWS = readFileSync(join(SRC_DIR, 'lib/remoteRows.ts'), 'utf-8')
  const PRESERVER = readFileSync(join(SRC_DIR, 'lib/localOnlySetFields.ts'), 'utf-8')

  /** Property names declared in `export interface <name> { … }`, comments stripped. */
  function interfaceFields(source: string, name: string): Set<string> {
    const start = source.indexOf(`export interface ${name} {`)
    if (start === -1) return new Set()
    const from = source.indexOf('{', start)
    let depth = 0
    let end = -1
    for (let i = from; i < source.length; i++) {
      if (source[i] === '{') depth++
      else if (source[i] === '}' && --depth === 0) { end = i; break }
    }
    const body = stripComments(source.slice(from + 1, end))
    return new Set([...body.matchAll(/^\s*([A-Za-z_$][\w$]*)\??\s*:/gm)].map(m => m[1]))
  }

  /** Domain keys the given mapper assigns from a remote row. */
  function mappedFields(source: string, marker: string): Set<string> {
    const start = source.indexOf(marker)
    if (start === -1) return new Set()
    const body = stripComments(source.slice(start, source.indexOf('\n}', start)))
    return new Set([...body.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)].map(m => m[1]))
  }

  /** Members of the `LOCAL_ONLY_SET_FIELDS` tuple. */
  function preservedFields(): Set<string> {
    const decl = PRESERVER.slice(PRESERVER.indexOf('export const LOCAL_ONLY_SET_FIELDS'))
    const literal = decl.slice(decl.indexOf('['), decl.indexOf(']') + 1)
    return new Set((literal.match(/'[\w$]+'/g) ?? []).map(q => q.slice(1, -1)))
  }

  it('the extractors read real declarations (non-vacuity)', () => {
    const fields = interfaceFields(WORKOUT_STORE, 'WorkoutSet')
    // Anchors on both sides of the split, so neither extractor can go empty and
    // report green over a rule it never actually evaluated.
    for (const f of ['id', 'date', 'weight', 'reps', 'estimated1RM', 'rpe', 'bodyweight']) {
      expect(fields.has(f)).toBe(true)
    }
    // A JSDoc'd field must survive comment stripping — `createdAt` and
    // `bodyweight` both carry multi-line blocks that name other fields.
    expect(fields.has('createdAt')).toBe(true)
    expect(mappedFields(REMOTE_ROWS, 'export function mapRemoteSet').has('estimated1RM')).toBe(true)
    expect(preservedFields()).toEqual(new Set(['rpe', 'bodyweight']))
  })

  it('the derivation flags a field that is neither synced nor preserved (self-test)', () => {
    const source = [
      'export interface Fake {',
      '  id: string',
      '  /** A comment naming rpe: 9 must not register as a field. */',
      '  tempo?: number',
      '}',
    ].join('\n')
    const fields = interfaceFields(source, 'Fake')
    expect(fields).toEqual(new Set(['id', 'tempo']))
    expect([...fields].filter(f => !new Set(['id']).has(f))).toEqual(['tempo'])
  })

  it('no WorkoutSet field is both un-synced and unpreserved', () => {
    const mapped = mappedFields(REMOTE_ROWS, 'export function mapRemoteSet')
    const preserved = preservedFields()
    const orphans = [...interfaceFields(WORKOUT_STORE, 'WorkoutSet')]
      .filter(f => !mapped.has(f) && !preserved.has(f))

    expect(orphans, orphans.length === 0 ? '' :
      `WorkoutSet.${orphans.join(', WorkoutSet.')} round-trips through neither ` +
      'Supabase (mapRemoteSet) nor LOCAL_ONLY_SET_FIELDS, so a remote-winning ' +
      'merge silently erases it for every set that exists on both sides ' +
      '(#1357). Give it a `sets` column, or add it to LOCAL_ONLY_SET_FIELDS.',
    ).toEqual([])
  })

  it('nothing is listed as local-only that the sync path actually carries', () => {
    // The mirror failure: once a field gains a column, remote-wins has to keep
    // meaning remote-wins, so it must leave the preserved list in the same
    // commit — restore would otherwise re-attach a stale local value.
    const mapped = mappedFields(REMOTE_ROWS, 'export function mapRemoteSet')
    expect([...preservedFields()].filter(f => mapped.has(f))).toEqual([])
  })
})

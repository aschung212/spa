/**
 * Shared, configurable Supabase test double (LIFT-1009).
 *
 * Before this existed, every sync test (`supabaseApiError`,
 * `supabaseFetchResilience`, `syncPipelineIntegration`, `syncFuzz`) hand-rolled
 * its own chainable PostgREST fake, each implementing a *different* subset of
 * `select/eq/is/order/single/upsert/update/delete/then`. That is the classic
 * mock-drift red flag for a local-first app whose entire durability story runs
 * through these queries: a real client API change could be reflected in one fake
 * but not another, letting a store pass against a shape production no longer has.
 *
 * `createFakeSupabase({ mode })` is the single source of truth for what the
 * Supabase client contract looks like in tests. It implements the full chain
 * surface the stores actually use in ONE place, with per-test behavior selected
 * by a `mode` option rather than copy-pasted chains:
 *
 *   - `'ok'`           — in-memory tables. Records every call; `seed()` rows, then
 *                        reads/upserts/updates/deletes them like a real backend.
 *                        This is the superset used by the read-path fuzz +
 *                        write-path integration tests.
 *   - `'networkError'` — every query RESOLVES the exact envelope postgrest-js
 *                        produces when `fetch` rejects (LIFT-1321). See below —
 *                        this, not `'reject'`, is what being offline looks like.
 *   - `'reject'`       — every query rejects. A real but much rarer shape (a throw
 *                        from inside the client, `shouldThrowOnError`); stores
 *                        must preserve local data and never throw out of `init()`.
 *   - `'apiError'`     — every query resolves `{ data: null, error }` (a
 *                        non-throwing API/RLS error). Stores must check `.error`
 *                        and bail out.
 *
 * `'networkError'` exists because the obvious simulation is wrong. postgrest-js
 * CATCHES the fetch rejection and resolves `{ error: { message: 'TypeError:
 * Failed to fetch', code: '' }, status: 0 }` — a Supabase mutation essentially
 * never rejects when the device is offline. Every sync test modelled offline as
 * a `Promise.reject`, which is why `SyncQueue` could count real offline writes
 * as successes (clearing retries and deleting the durable journal entry) for
 * months with the suite green: the tests exercised a code path production takes
 * only rarely. Same fake-fidelity trap as the `max_rows` cap below.
 *
 * The set of methods on the builder is asserted against the stores' real usage
 * by `fakeSupabase.contract.test.ts`, so a new query method in a store fails the
 * contract check until the fake grows to match it.
 *
 * The fake also enforces PostgREST's `max_rows` cap on every select (#1152). A
 * test double that returns unlimited rows doesn't just fail to catch a missing
 * `.range()` — it actively certifies the broken read as correct, which is how
 * the unpaged fetch shipped and hid a month of a real user's training history.
 *
 * For the same reason it applies the migrations' literal column DEFAULTs to an
 * INSERT (LIFT-1387). A store that omits a column does NOT leave it absent in
 * production — Postgres fills it in, and the next fetch reads that invented
 * value back as though the user had chosen it. `bar_weight real NOT NULL
 * DEFAULT 45` did exactly that to every kg user, and no test could see it
 * because the fake stored only what the payload contained. The defaults are
 * parsed out of `supabase/migrations` (see `migrationSchema.ts`), so a new
 * `ADD COLUMN ... DEFAULT` starts being modelled here the day it lands.
 */

import { SUPABASE_MAX_ROWS } from '../lib/supabasePagination'
import { columnDefaults } from './migrationSchema'

/** The method names a store may invoke on a `supabase.from(...)` query chain. */
export const FAKE_SUPABASE_CHAIN_METHODS = [
  'select',
  'upsert',
  'update',
  'delete',
  'eq',
  'is',
  'order',
  'range',
  'single',
  'then',
] as const

export type FakeSupabaseMode = 'ok' | 'reject' | 'apiError' | 'networkError'

export interface FakeSupabaseError {
  message: string
  code?: string
  details?: string
  hint?: string
}

/**
 * The envelope postgrest-js resolves when the underlying `fetch` rejects
 * (verified against @supabase/postgrest-js dist/index.mjs — the `shouldThrowOnError
 * === false` catch branch). `status: 0` and an empty `code` are the two markers
 * that separate "never reached the server" from a real PostgREST rejection.
 */
/**
 * What awaiting a fake query yields. `status` is optional because only the
 * failure modes that carry one bother to set it — the real client always sends
 * it, but the `'ok'` path's consumers only ever read `data` / `error`.
 */
export interface FakeSupabaseResult {
  data: unknown
  error: FakeSupabaseError | null
  count?: number | null
  status?: number
  statusText?: string
}

export const FAKE_NETWORK_ERROR_RESULT = {
  data: null,
  error: {
    message: 'TypeError: Failed to fetch',
    details: 'TypeError: Failed to fetch',
    hint: '',
    code: '',
  },
  count: null,
  status: 0,
  statusText: '',
} as const

export interface FakeSupabaseOptions {
  /** Selects per-query behavior. Defaults to `'ok'`. */
  mode?: FakeSupabaseMode
  /** Error object returned in `'apiError'` mode (defaults to an RLS 42501 denial). */
  error?: FakeSupabaseError
  /** Error thrown in `'reject'` mode (defaults to a network failure). */
  rejectionError?: Error
  /**
   * Rows a single response may return, mirroring PostgREST's `max_rows`
   * (#1152). Defaults to the real cap so a store that reads a collection
   * without paging truncates here exactly as it does in production.
   *
   * This is the whole reason the row-cap bug shipped: the fake used to return
   * every matching row regardless of any cap, so an unpaged `.select()` looked
   * complete under test and lost a month of a real user's history in prod.
   */
  maxRows?: number
}

interface Row {
  id: string
  [k: string]: unknown
}

type Op = 'select' | 'delete' | 'upsert' | 'update'

interface RecordedCall {
  op: Op
  table: string
  filters: Record<string, unknown>
  data?: unknown
  /** The `.range(from, to)` window, when the query asked for one (#1152). */
  range?: { from: number; to: number }
}

/** Sentinel wrapping a `.is(col, val)` filter so it can match NULL-or-missing. */
interface IsFilter {
  __is: unknown
}

function isIsFilter(v: unknown): v is IsFilter {
  return v !== null && typeof v === 'object' && '__is' in (v as object)
}

const DEFAULT_API_ERROR: FakeSupabaseError = {
  message: 'permission denied for table exercises',
  code: '42501',
}

export class FakeSupabase {
  readonly mode: FakeSupabaseMode
  /** PostgREST row cap applied to every `select` response (#1152). */
  readonly maxRows: number
  private readonly _apiError: FakeSupabaseError
  private readonly _rejectionError: Error

  /** In-memory rows keyed by table name (populated via `seed()`; `'ok'` mode). */
  tables: Record<string, Row[]> = {
    exercises: [],
    sets: [],
    bodyweight_entries: [],
    user_progression: [],
    user_preferences: [],
  }

  /** Every query recorded in call order, across all modes. */
  calls: RecordedCall[] = []

  constructor(options: FakeSupabaseOptions = {}) {
    this.mode = options.mode ?? 'ok'
    this.maxRows = options.maxRows ?? SUPABASE_MAX_ROWS
    this._apiError = options.error ?? DEFAULT_API_ERROR
    this._rejectionError = options.rejectionError ?? new Error('Network request failed')
  }

  reset() {
    this.tables = {
      exercises: [],
      sets: [],
      bodyweight_entries: [],
      user_progression: [],
      user_preferences: [],
    }
    this.calls = []
  }

  seed(table: string, rows: Row[]) {
    this.tables[table] = rows.map(r => ({ ...r }))
  }

  from(table: string) {
    return new FakeBuilder(this, table)
  }

  callsFor(op: Op, table: string) {
    return this.calls.filter(c => c.op === op && c.table === table)
  }

  selectsFor(table: string) {
    return this.callsFor('select', table)
  }

  deletesFor(table: string) {
    return this.callsFor('delete', table)
  }

  upsertsFor(table: string) {
    return this.callsFor('upsert', table)
  }

  updatesFor(table: string) {
    return this.callsFor('update', table)
  }

  /** @internal — records the call and, in `'ok'` mode, mutates/reads the store. */
  _resolve(
    op: Op,
    table: string,
    filters: Record<string, unknown>,
    data: unknown,
    single: boolean,
    range?: { from: number; to: number },
  ): FakeSupabaseResult {
    this.calls.push({ op, table, filters: { ...filters }, data, range })

    if (this.mode === 'apiError') {
      return { data: null, error: this._apiError }
    }

    // The call IS recorded first: an offline request really is issued, it just
    // never gets an answer. Tests asserting "nothing reached the server" must
    // assert on the server-side effect (`fake.tables`), not the call log.
    if (this.mode === 'networkError') {
      return { ...FAKE_NETWORK_ERROR_RESULT }
    }

    const rows = this._query(op, table, filters, data)
    if (op !== 'select') return { data: single ? (rows[0] ?? null) : rows, error: null }

    // PostgREST applies the `.range()` window FIRST, then truncates the result
    // to `max_rows` — so `.range(0, 4999)` still yields at most 1000 rows, and
    // an unranged select yields the first 1000. Emulating that order is what
    // makes an unpaged read fail here the way it fails in production (#1152).
    const windowed = range ? rows.slice(range.from, range.to + 1) : rows
    const capped = windowed.slice(0, this.maxRows)
    return { data: single ? (capped[0] ?? null) : capped, error: null }
  }

  /** @internal — the throwing branch for `'reject'` mode. */
  get _rejection(): Error {
    return this._rejectionError
  }

  /**
   * A new row with the migrations' literal DEFAULTs filled in for every column
   * the INSERT payload omits — Postgres's own rule. A key present but
   * `undefined` counts as omitted: `JSON.stringify` drops it, so it never
   * reaches PostgREST either.
   *
   * `seed()` deliberately does NOT go through this: seeded rows model rows that
   * already exist server-side in whatever shape the test declares.
   */
  private _withDefaults(table: string, rec: Row): Row {
    const row: Row = { ...rec }
    for (const [column, value] of columnDefaults(table)) {
      if (row[column] === undefined) row[column] = value
    }
    return row
  }

  private _query(op: Op, table: string, filters: Record<string, unknown>, data: unknown): Row[] {
    const rows = this.tables[table] || (this.tables[table] = [])
    const matches = rows.filter(r =>
      Object.entries(filters).every(([k, v]) => {
        if (isIsFilter(v)) {
          const target = v.__is
          if (target === null) return r[k] == null
          return r[k] === target
        }
        return r[k] === v
      }),
    )

    if (op === 'select') return matches
    if (op === 'delete') {
      const ids = new Set(matches.map(r => r.id))
      this.tables[table] = rows.filter(r => !ids.has(r.id))
      return matches
    }
    if (op === 'upsert') {
      const records = Array.isArray(data) ? (data as Row[]) : [data as Row]
      for (const rec of records) {
        const idx = rows.findIndex(r => r.id === rec.id)
        // ON CONFLICT DO UPDATE only assigns the columns the payload carries, so
        // an omitted column keeps its existing value on an update — but takes
        // its DEFAULT on a fresh insert, which is the half that mattered
        // (LIFT-1387).
        if (idx >= 0) rows[idx] = { ...rows[idx], ...rec }
        else rows.push(this._withDefaults(table, rec))
      }
      return records
    }
    if (op === 'update') {
      for (const m of matches) Object.assign(m, data as Row)
      return matches
    }
    return []
  }
}

class FakeBuilder implements PromiseLike<FakeSupabaseResult> {
  private _op: Op = 'select'
  private _filters: Record<string, unknown> = {}
  private _data: unknown = null
  private _single = false
  private _range: { from: number; to: number } | undefined

  constructor(private _parent: FakeSupabase, private _table: string) {}

  select(_cols?: string) { this._op = 'select'; return this }
  delete() { this._op = 'delete'; return this }
  upsert(data: unknown) { this._op = 'upsert'; this._data = data; return this }
  update(data: unknown) { this._op = 'update'; this._data = data; return this }
  eq(col: string, val: unknown) { this._filters[col] = val; return this }
  is(col: string, val: null | boolean) { this._filters[col] = { __is: val }; return this }
  order(_col: string) { return this }
  range(from: number, to: number) { this._range = { from, to }; return this }
  single() { this._single = true; return this }

  then<TResult1 = FakeSupabaseResult, TResult2 = never>(
    onfulfilled?: (v: FakeSupabaseResult) => TResult1 | PromiseLike<TResult1>,
    onrejected?: (reason: unknown) => TResult2 | PromiseLike<TResult2>,
  ): PromiseLike<TResult1 | TResult2> {
    if (this._parent.mode === 'reject') {
      return Promise.reject(this._parent._rejection).then(onfulfilled, onrejected)
    }
    const result = this._parent._resolve(
      this._op, this._table, this._filters, this._data, this._single, this._range,
    )
    return Promise.resolve(result).then(onfulfilled, onrejected)
  }
}

/**
 * Build a shared Supabase test double. Pass `{ mode }` to select behavior; the
 * returned instance is what a `vi.mock('.../lib/supabase')` factory should
 * expose as `supabase`.
 */
export function createFakeSupabase(options: FakeSupabaseOptions = {}): FakeSupabase {
  return new FakeSupabase(options)
}

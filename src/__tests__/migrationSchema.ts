/**
 * Schema facts derived from the migration SQL, for the test doubles (LIFT-1387).
 *
 * `createFakeSupabase` models the PostgREST *wire* contract faithfully — the
 * `max_rows` cap (#1152), the resolved-not-rejected offline envelope
 * (LIFT-1321) — but it modelled Postgres itself as a plain object store, so an
 * INSERT that omitted a column simply left that column absent. Real Postgres
 * fills it with the column DEFAULT, and that difference is not cosmetic: it is
 * how `bar_weight real NOT NULL DEFAULT 45` handed every kg user a 45 **kg**
 * bar on a row they had never configured, with the whole suite green
 * (LIFT-1387). Same fake-fidelity trap as the row cap: a double that quietly
 * omits a behaviour doesn't merely fail to catch the bug, it certifies the
 * broken write as correct.
 *
 * The facts are PARSED from `supabase/migrations` rather than listed here, for
 * the reason every derived invariant in this repo exists: a hardcoded map would
 * only ever pin the columns that had defaults the day it was written, and the
 * next `ADD COLUMN ... DEFAULT` would slip past it exactly the way this one did.
 *
 * Only LITERAL defaults are materialized. A function default (`now()`,
 * `gen_random_uuid()`) is deliberately skipped — inventing an `updated_at` in
 * the fake would silently rewrite the last-write-wins merge outcome of every
 * sync test, which is a much bigger lie than the one being fixed.
 */
import { readFileSync, readdirSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../supabase/migrations')

/** Table-level clauses inside a CREATE TABLE body — not column definitions. */
const CONSTRAINT_KEYWORDS = new Set([
  'primary', 'foreign', 'unique', 'constraint', 'check', 'exclude', 'like',
])

export interface MigrationSchema {
  /** table -> column -> the literal value Postgres would insert. */
  defaults: Map<string, Map<string, unknown>>
  /** table -> columns declared NOT NULL. */
  notNull: Map<string, Set<string>>
}

/** Strip `--` line comments and `/* *\/` block comments. */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, '')
}

/**
 * Coerce a SQL default expression to the JS value the fake should store, or
 * `undefined` when the expression is not a materializable literal (a function
 * call, a sequence, an arbitrary expression).
 */
export function sqlDefaultToValue(expr: string): unknown | undefined {
  // Drop a trailing type cast: `'{}'::text[]` -> `'{}'`.
  const e = expr.trim().replace(/::\s*[\w"]+(\s*\[\s*\])*$/, '').trim()
  if (/^-?\d+(\.\d+)?$/.test(e)) return Number(e)
  if (/^true$/i.test(e)) return true
  if (/^false$/i.test(e)) return false
  if (/^null$/i.test(e)) return null

  const quoted = e.match(/^'((?:[^']|'')*)'$/)
  if (!quoted) return undefined
  const literal = quoted[1].replace(/''/g, "'")
  // A Postgres array literal (`{}` / `{a,b}`) becomes a JS array — the shape the
  // client reads back for `tags` / `gyms`.
  if (literal.startsWith('{') && literal.endsWith('}')) {
    const inner = literal.slice(1, -1).trim()
    return inner === '' ? [] : inner.split(',').map(p => p.trim().replace(/^"|"$/g, ''))
  }
  return literal
}

/**
 * Extract `{ default, notNull }` from the constraint tail of a column
 * definition (`real not null default 45`). `DEFAULT` is terminal everywhere in
 * this corpus; a trailing `NOT NULL` is stripped anyway so the order can't
 * silently swallow the constraint into the expression.
 */
function parseColumnTail(tail: string): { defaultExpr?: string; notNull: boolean } {
  const notNull = /\bnot\s+null\b/i.test(tail)
  const m = tail.match(/\bdefault\s+([\s\S]+)$/i)
  if (!m) return { notNull }
  const defaultExpr = m[1].replace(/\bnot\s+null\b/i, '').trim()
  return { defaultExpr, notNull }
}

/**
 * Parse the whole migration corpus in file (i.e. chronological) order, applying
 * every ADD/ALTER/DROP COLUMN in the order Postgres would. Ordering matters:
 * LIFT-1387's `alter column bar_weight drop default` has to erase the default
 * an earlier file installed, or the fake keeps materializing the value the
 * schema no longer has.
 */
function parseMigrations(): MigrationSchema {
  const defaults = new Map<string, Map<string, unknown>>()
  const notNull = new Map<string, Set<string>>()
  const defaultsFor = (t: string) => {
    const key = t.toLowerCase()
    if (!defaults.has(key)) defaults.set(key, new Map())
    return defaults.get(key)!
  }
  const notNullFor = (t: string) => {
    const key = t.toLowerCase()
    if (!notNull.has(key)) notNull.set(key, new Set())
    return notNull.get(key)!
  }

  const applyColumn = (table: string, column: string, tail: string) => {
    const col = column.toLowerCase()
    const { defaultExpr, notNull: isNotNull } = parseColumnTail(tail)
    if (defaultExpr !== undefined) {
      const value = sqlDefaultToValue(defaultExpr)
      if (value === undefined) defaultsFor(table).delete(col)
      else defaultsFor(table).set(col, value)
    }
    if (isNotNull) notNullFor(table).add(col)
  }

  const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()
  for (const file of files) {
    const sql = stripSqlComments(readFileSync(join(MIGRATIONS_DIR, file), 'utf-8'))

    // Collect every statement of interest WITH its offset, then replay them in
    // source order so a later `drop default` beats an earlier `add column`.
    const events: { at: number; run: () => void }[] = []
    const push = (at: number, run: () => void) => events.push({ at, run })

    // CREATE TABLE <name> ( ...body... )
    for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:\w+\.)?(\w+)\s*\(([\s\S]*?)\n\)/gi)) {
      const [, table, body] = m
      push(m.index!, () => {
        for (const raw of body.split(',')) {
          const line = raw.trim()
          if (!line) continue
          const [first, ...rest] = line.split(/\s+/)
          if (CONSTRAINT_KEYWORDS.has(first.toLowerCase()) || !/^\w+$/.test(first)) continue
          applyColumn(table, first, rest.join(' '))
        }
      })
    }

    // ALTER TABLE <t> ADD COLUMN [IF NOT EXISTS] <col> <tail>;
    for (const m of sql.matchAll(
      /alter\s+table\s+(?:if\s+exists\s+)?(?:\w+\.)?(\w+)\s+add\s+column\s+(?:if\s+not\s+exists\s+)?(\w+)([^;]*)/gi,
    )) {
      const [, table, column, tail] = m
      push(m.index!, () => applyColumn(table, column, tail))
    }

    // ALTER TABLE <t> ALTER COLUMN <col> SET/DROP DEFAULT | SET/DROP NOT NULL
    for (const m of sql.matchAll(
      /alter\s+table\s+(?:if\s+exists\s+)?(?:\w+\.)?(\w+)\s+alter\s+column\s+(\w+)\s+(set|drop)\s+(default|not\s+null)([^;]*)/gi,
    )) {
      const [, table, column, action, target, tail] = m
      const col = column.toLowerCase()
      push(m.index!, () => {
        const isDefault = /^default$/i.test(target)
        if (action.toLowerCase() === 'drop') {
          if (isDefault) defaultsFor(table).delete(col)
          else notNullFor(table).delete(col)
          return
        }
        if (!isDefault) {
          notNullFor(table).add(col)
          return
        }
        const value = sqlDefaultToValue(tail)
        if (value === undefined) defaultsFor(table).delete(col)
        else defaultsFor(table).set(col, value)
      })
    }

    // ALTER TABLE <t> DROP COLUMN [IF EXISTS] <col>
    for (const m of sql.matchAll(
      /alter\s+table\s+(?:if\s+exists\s+)?(?:\w+\.)?(\w+)\s+drop\s+column\s+(?:if\s+exists\s+)?(\w+)/gi,
    )) {
      const [, table, column] = m
      const col = column.toLowerCase()
      push(m.index!, () => {
        defaultsFor(table).delete(col)
        notNullFor(table).delete(col)
      })
    }

    for (const e of events.sort((a, b) => a.at - b.at)) e.run()
  }

  return { defaults, notNull }
}

let cached: MigrationSchema | null = null

/** Parse once per test process — the corpus is static for the run. */
export function migrationSchema(): MigrationSchema {
  if (!cached) cached = parseMigrations()
  return cached
}

/** Literal column defaults Postgres would apply to an INSERT on `table`. */
export function columnDefaults(table: string): Map<string, unknown> {
  return migrationSchema().defaults.get(table.toLowerCase()) ?? new Map()
}

/** Columns declared NOT NULL on `table` as of the latest migration. */
export function notNullColumns(table: string): Set<string> {
  return migrationSchema().notNull.get(table.toLowerCase()) ?? new Set()
}

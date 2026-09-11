/**
 * Supabase Integration Tests (LIFT-651)
 *
 * Validates the exact PostgREST query shapes used by the workout and bodyweight
 * stores against a real Supabase instance. Every other sync test in this repo
 * uses in-memory fakes — those prove behavioral contracts (no data loss, no
 * runaway deletes) but can't detect schema drift. If a column is renamed,
 * a type changed, or an RLS policy tightened, the fakes won't notice.
 *
 * These tests hit the real PostgREST API, validating:
 *   1. Upsert exercises and sets (INSERT + ON CONFLICT UPDATE)
 *   2. Soft-delete via UPDATE { deleted_at }
 *   3. Fetch with `.is('deleted_at', null)` filtering
 *   4. Archived_at upsert and unarchive
 *   5. Bodyweight entry upsert and soft-delete
 *
 * ## Running locally
 *
 *   1. Start local Supabase: `npx supabase start`
 *   2. Run:
 *      ```
 *      SUPABASE_INT_URL=http://127.0.0.1:54321 \
 *      SUPABASE_INT_SERVICE_ROLE_KEY=<service_role key from `supabase status`> \
 *      npx vitest run src/stores/__tests__/supabaseIntegration.test.ts
 *      ```
 *
 * ## Running in CI
 *
 * The nightly workflow starts a local Supabase instance and sets the env vars
 * automatically. See `.github/workflows/integration.yml`.
 *
 * ## Design decisions
 *
 * - Uses the **service_role** key so the suite bypasses RLS and can read and
 *   write any user's rows. This tests query shapes, not auth policies — RLS
 *   is a separate concern.
 * - service_role bypasses RLS but NOT foreign keys. Every synced table
 *   declares `user_id uuid not null references auth.users(id) on delete
 *   cascade`, so each test mints a REAL auth user via the Admin API
 *   (`createTestUser`) instead of inventing a UUID. Inventing one fails every
 *   insert with SQLSTATE 23503 — see the header note on that below.
 * - Each test gets its own auth user, and afterEach hard-deletes it; the FK's
 *   `on delete cascade` takes every domain row with it, so tests are hermetic
 *   and parallelizable.
 * - Tests are gated behind env vars and excluded from the default vitest run
 *   via the `exclude` pattern in vitest.config.js.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../../lib/database.types'

// ── Gate: skip entire suite if env vars are missing ────────────────
const SUPABASE_URL = process.env.SUPABASE_INT_URL
const SUPABASE_KEY = process.env.SUPABASE_INT_SERVICE_ROLE_KEY

const describeIntegration = SUPABASE_URL && SUPABASE_KEY
  ? describe
  : describe.skip

// ── Helpers ────────────────────────────────────────────────────────

function uuid(): string {
  return crypto.randomUUID()
}

const now = () => new Date().toISOString()

// Tracks all user IDs created in tests for cleanup
const testUserIds: string[] = []

// ── Suite ──────────────────────────────────────────────────────────

describeIntegration('Supabase integration: PostgREST query shape validation', () => {
  let supabase: SupabaseClient<Database>

  beforeAll(() => {
    supabase = createClient<Database>(SUPABASE_URL!, SUPABASE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  })

  /**
   * Mint a real `auth.users` row and return its id.
   *
   * The service_role key bypasses RLS, but foreign keys are enforced by the
   * table definition regardless of role — and every synced table declares
   * `user_id uuid not null references auth.users(id) on delete cascade`. A
   * synthetic UUID therefore fails EVERY insert with SQLSTATE 23503
   * ("Key (user_id)=(…) is not present in table \"users\""), which is how this
   * suite failed every scheduled run from its first in May 2026 until #1283.
   *
   * The Admin API is reachable here for the same reason RLS is bypassed: we
   * hold the service_role key.
   */
  async function createTestUser(): Promise<string> {
    // No password: the suite never signs in as this user, it only needs the
    // `auth.users` row to exist so the FK resolves. Passing one would also have
    // to satisfy config.toml's `password_requirements`, which a bare UUID does
    // not (no uppercase).
    const { data, error } = await supabase.auth.admin.createUser({
      email: `integration-${uuid()}@lift.test`,
      email_confirm: true,
    })
    if (error || !data.user) {
      throw new Error(
        `could not create test auth user: ${error?.message ?? 'no user returned'}`
      )
    }
    testUserIds.push(data.user.id)
    return data.user.id
  }

  afterEach(async () => {
    // Hard-deleting the auth user cascades through every `user_id` FK, so this
    // clears sets, exercises and bodyweight entries in the right order without
    // naming them — a new synced table needs no change here.
    for (const userId of testUserIds) {
      await supabase.auth.admin.deleteUser(userId)
    }
    testUserIds.length = 0
  })

  // ── Exercise + Set upsert ──────────────────────────────────────

  describe('exercise and set upsert', () => {
    it('upserts an exercise with all fields the store sends', async () => {
      const userId = await createTestUser()
      const exerciseId = uuid()
      const ts = now()

      // This is the exact shape _buildExerciseUpsert produces
      const { error } = await supabase.from('exercises').upsert({
        id: exerciseId,
        user_id: userId,
        name: 'Bench Press',
        tags: ['Push', 'Chest'],
        created_at: ts,
        updated_at: ts,
        archived_at: null,
        input_mode: 'numpad',
        bar_weight: 45,
        gyms: ['Gym A'],
      })

      expect(error).toBeNull()

      // Verify round-trip
      const { data, error: fetchErr } = await supabase
        .from('exercises')
        .select('*')
        .eq('id', exerciseId)

      expect(fetchErr).toBeNull()
      expect(data).toHaveLength(1)
      expect(data![0]).toMatchObject({
        id: exerciseId,
        user_id: userId,
        name: 'Bench Press',
        tags: ['Push', 'Chest'],
        bar_weight: 45,
        input_mode: 'numpad',
        deleted_at: null,
        archived_at: null,
        gyms: ['Gym A'],
      })
    })

    it('upserts a set with all fields the store sends', async () => {
      const userId = await createTestUser()
      const exerciseId = uuid()
      const setId = uuid()
      const ts = now()

      // Insert parent exercise first (FK constraint)
      await supabase.from('exercises').upsert({
        id: exerciseId,
        user_id: userId,
        name: 'Squat',
        tags: [],
        created_at: ts,
        updated_at: ts,
      })

      // Exact shape the store sends for set upsert
      const { error } = await supabase.from('sets').upsert({
        id: setId,
        user_id: userId,
        exercise_id: exerciseId,
        date: ts,
        weight: 315,
        reps: 5,
        estimated_1rm: 354,
      })

      expect(error).toBeNull()

      const { data, error: fetchErr } = await supabase
        .from('sets')
        .select('*')
        .eq('id', setId)

      expect(fetchErr).toBeNull()
      expect(data).toHaveLength(1)
      expect(data![0]).toMatchObject({
        id: setId,
        user_id: userId,
        exercise_id: exerciseId,
        weight: 315,
        reps: 5,
        estimated_1rm: 354,
        deleted_at: null,
      })
    })

    it('upsert updates existing exercise on conflict (last-write-wins)', async () => {
      const userId = await createTestUser()
      const exerciseId = uuid()
      const ts = now()

      await supabase.from('exercises').upsert({
        id: exerciseId,
        user_id: userId,
        name: 'Original Name',
        tags: [],
        created_at: ts,
        updated_at: ts,
      })

      // Second upsert with same ID — should update, not duplicate
      const ts2 = now()
      const { error } = await supabase.from('exercises').upsert({
        id: exerciseId,
        user_id: userId,
        name: 'Renamed Exercise',
        tags: ['Push'],
        created_at: ts,
        updated_at: ts2,
      })

      expect(error).toBeNull()

      const { data } = await supabase
        .from('exercises')
        .select('*')
        .eq('id', exerciseId)

      expect(data).toHaveLength(1)
      expect(data![0].name).toBe('Renamed Exercise')
      expect(data![0].tags).toEqual(['Push'])
    })
  })

  // ── Soft-delete ────────────────────────────────────────────────

  describe('soft-delete via UPDATE { deleted_at }', () => {
    it('soft-deletes a set by setting deleted_at (exact store query shape)', async () => {
      const userId = await createTestUser()
      const exerciseId = uuid()
      const setId = uuid()
      const ts = now()

      await supabase.from('exercises').upsert({
        id: exerciseId, user_id: userId, name: 'Deadlift',
        tags: [], created_at: ts, updated_at: ts,
      })
      await supabase.from('sets').upsert({
        id: setId, user_id: userId, exercise_id: exerciseId,
        date: ts, weight: 405, reps: 3, estimated_1rm: 446,
      })

      // Exact query shape from store.deleteSet → syncQueue.enqueueDelete
      const deletedAt = now()
      const { error } = await supabase
        .from('sets')
        .update({ deleted_at: deletedAt })
        .eq('id', setId)
        .eq('user_id', userId)

      expect(error).toBeNull()

      // Row still exists but with deleted_at populated
      const { data } = await supabase
        .from('sets')
        .select('*')
        .eq('id', setId)

      expect(data).toHaveLength(1)
      expect(data![0].deleted_at).not.toBeNull()
    })

    it('soft-deletes all sets for an exercise (cascade pattern)', async () => {
      const userId = await createTestUser()
      const exerciseId = uuid()
      const ts = now()

      await supabase.from('exercises').upsert({
        id: exerciseId, user_id: userId, name: 'OHP',
        tags: [], created_at: ts, updated_at: ts,
      })

      // Insert 3 sets
      for (let i = 0; i < 3; i++) {
        await supabase.from('sets').upsert({
          id: uuid(), user_id: userId, exercise_id: exerciseId,
          date: ts, weight: 135 + i * 10, reps: 5, estimated_1rm: 150 + i * 10,
        })
      }

      // Exact query shape from store.deleteExercise for cascade set soft-delete
      const deletedAt = now()
      const { error: setErr } = await supabase
        .from('sets')
        .update({ deleted_at: deletedAt })
        .eq('exercise_id', exerciseId)
        .eq('user_id', userId)

      expect(setErr).toBeNull()

      // Soft-delete the exercise itself
      const { error: exErr } = await supabase
        .from('exercises')
        .update({ deleted_at: deletedAt })
        .eq('id', exerciseId)
        .eq('user_id', userId)

      expect(exErr).toBeNull()

      // All rows still exist, all have deleted_at
      const { data: sets } = await supabase
        .from('sets')
        .select('*')
        .eq('exercise_id', exerciseId)

      expect(sets).toHaveLength(3)
      expect(sets!.every(s => s.deleted_at !== null)).toBe(true)
    })

    it('restores a soft-deleted set by nulling deleted_at', async () => {
      const userId = await createTestUser()
      const exerciseId = uuid()
      const setId = uuid()
      const ts = now()

      await supabase.from('exercises').upsert({
        id: exerciseId, user_id: userId, name: 'Row',
        tags: [], created_at: ts, updated_at: ts,
      })
      await supabase.from('sets').upsert({
        id: setId, user_id: userId, exercise_id: exerciseId,
        date: ts, weight: 225, reps: 8, estimated_1rm: 281,
      })

      // Soft-delete then restore
      await supabase.from('sets')
        .update({ deleted_at: now() })
        .eq('id', setId).eq('user_id', userId)

      const { error } = await supabase.from('sets')
        .update({ deleted_at: null })
        .eq('id', setId).eq('user_id', userId)

      expect(error).toBeNull()

      const { data } = await supabase
        .from('sets')
        .select('*')
        .eq('id', setId)

      expect(data![0].deleted_at).toBeNull()
    })
  })

  // ── Fetch with deleted_at filter ──────────────────────────────

  describe('fetch with .is(deleted_at, null) filtering', () => {
    it('returns only active exercises (exact _fetchFromSupabase query)', async () => {
      const userId = await createTestUser()
      const ts = now()

      const activeId = uuid()
      const deletedId = uuid()

      await supabase.from('exercises').upsert({
        id: activeId, user_id: userId, name: 'Active Exercise',
        tags: [], created_at: ts, updated_at: ts, deleted_at: null,
      })
      await supabase.from('exercises').upsert({
        id: deletedId, user_id: userId, name: 'Deleted Exercise',
        tags: [], created_at: ts, updated_at: ts, deleted_at: ts,
      })

      // Exact query shape from _fetchFromSupabase
      const { data, error } = await supabase
        .from('exercises')
        .select('*')
        .eq('user_id', userId)
        .is('deleted_at', null)
        .order('created_at')

      expect(error).toBeNull()
      expect(data).toHaveLength(1)
      expect(data![0].id).toBe(activeId)
      expect(data![0].name).toBe('Active Exercise')
    })

    it('returns only active sets (exact _fetchFromSupabase query)', async () => {
      const userId = await createTestUser()
      const exerciseId = uuid()
      const ts = now()

      await supabase.from('exercises').upsert({
        id: exerciseId, user_id: userId, name: 'Curl',
        tags: [], created_at: ts, updated_at: ts,
      })

      const activeSetId = uuid()
      const deletedSetId = uuid()

      await supabase.from('sets').upsert({
        id: activeSetId, user_id: userId, exercise_id: exerciseId,
        date: ts, weight: 50, reps: 12, estimated_1rm: 71,
      })
      await supabase.from('sets').upsert({
        id: deletedSetId, user_id: userId, exercise_id: exerciseId,
        date: ts, weight: 50, reps: 10, estimated_1rm: 67,
        deleted_at: ts,
      })

      // Exact query shape from _fetchFromSupabase
      const { data, error } = await supabase
        .from('sets')
        .select('*')
        .eq('user_id', userId)
        .is('deleted_at', null)
        .order('created_at')

      expect(error).toBeNull()
      expect(data).toHaveLength(1)
      expect(data![0].id).toBe(activeSetId)
    })
  })

  // ── Archived_at ───────────────────────────────────────────────

  describe('archived_at lifecycle', () => {
    it('upserts archived_at on exercises (archive flow)', async () => {
      const userId = await createTestUser()
      const exerciseId = uuid()
      const ts = now()

      await supabase.from('exercises').upsert({
        id: exerciseId, user_id: userId, name: 'Leg Press',
        tags: [], created_at: ts, updated_at: ts,
      })

      // Archive: upsert with archived_at set (exact store pattern)
      const archivedAt = now()
      const { error } = await supabase.from('exercises').upsert({
        id: exerciseId, user_id: userId, name: 'Leg Press',
        tags: [], created_at: ts, updated_at: now(),
        archived_at: archivedAt,
      })

      expect(error).toBeNull()

      const { data } = await supabase
        .from('exercises')
        .select('*')
        .eq('id', exerciseId)

      expect(data![0].archived_at).not.toBeNull()
    })

    it('unarchives by upserting archived_at: null', async () => {
      const userId = await createTestUser()
      const exerciseId = uuid()
      const ts = now()

      await supabase.from('exercises').upsert({
        id: exerciseId, user_id: userId, name: 'Calf Raise',
        tags: [], created_at: ts, updated_at: ts,
        archived_at: ts,
      })

      const { error } = await supabase.from('exercises').upsert({
        id: exerciseId, user_id: userId, name: 'Calf Raise',
        tags: [], created_at: ts, updated_at: now(),
        archived_at: null,
      })

      expect(error).toBeNull()

      const { data } = await supabase
        .from('exercises')
        .select('*')
        .eq('id', exerciseId)

      expect(data![0].archived_at).toBeNull()
    })

    it('archived exercises are still visible in active-row fetch (not soft-deleted)', async () => {
      const userId = await createTestUser()
      const exerciseId = uuid()
      const ts = now()

      await supabase.from('exercises').upsert({
        id: exerciseId, user_id: userId, name: 'Archived But Active',
        tags: [], created_at: ts, updated_at: ts,
        archived_at: ts, deleted_at: null,
      })

      // The store's _fetchFromSupabase filters on deleted_at, NOT archived_at
      const { data, error } = await supabase
        .from('exercises')
        .select('*')
        .eq('user_id', userId)
        .is('deleted_at', null)
        .order('created_at')

      expect(error).toBeNull()
      expect(data).toHaveLength(1)
      expect(data![0].archived_at).not.toBeNull()
    })
  })

  // ── Bodyweight entries ────────────────────────────────────────

  describe('bodyweight entry operations', () => {
    it('upserts a bodyweight entry (exact store query shape)', async () => {
      const userId = await createTestUser()
      const entryId = uuid()
      const ts = now()

      const { error } = await supabase.from('bodyweight_entries').upsert({
        id: entryId,
        user_id: userId,
        date: ts,
        weight: 185.5,
      })

      expect(error).toBeNull()

      const { data } = await supabase
        .from('bodyweight_entries')
        .select('*')
        .eq('id', entryId)

      expect(data).toHaveLength(1)
      expect(data![0]).toMatchObject({
        id: entryId,
        user_id: userId,
        weight: 185.5,
        deleted_at: null,
      })
    })

    it('soft-deletes a bodyweight entry (exact store query shape)', async () => {
      const userId = await createTestUser()
      const entryId = uuid()
      const ts = now()

      await supabase.from('bodyweight_entries').upsert({
        id: entryId, user_id: userId, date: ts, weight: 180,
      })

      const deletedAt = now()
      const { error } = await supabase
        .from('bodyweight_entries')
        .update({ deleted_at: deletedAt })
        .eq('id', entryId)
        .eq('user_id', userId)

      expect(error).toBeNull()

      const { data } = await supabase
        .from('bodyweight_entries')
        .select('*')
        .eq('id', entryId)

      expect(data![0].deleted_at).not.toBeNull()
    })

    it('fetch filters out soft-deleted bodyweight entries', async () => {
      const userId = await createTestUser()
      const ts = now()

      const activeId = uuid()
      const deletedId = uuid()

      await supabase.from('bodyweight_entries').upsert({
        id: activeId, user_id: userId, date: ts, weight: 180,
      })
      await supabase.from('bodyweight_entries').upsert({
        id: deletedId, user_id: userId, date: ts, weight: 181,
        deleted_at: ts,
      })

      // Exact query shape from bodyweight store _fetchFromSupabase
      const { data, error } = await supabase
        .from('bodyweight_entries')
        .select('*')
        .eq('user_id', userId)
        .is('deleted_at', null)
        .order('created_at')

      expect(error).toBeNull()
      expect(data).toHaveLength(1)
      expect(data![0].id).toBe(activeId)
    })
  })

  // ── Edge cases / conflict resolution ──────────────────────────

  describe('conflict resolution and edge cases', () => {
    it('upsert with session_id column (sets table)', async () => {
      const userId = await createTestUser()
      const exerciseId = uuid()
      const setId = uuid()
      const ts = now()

      await supabase.from('exercises').upsert({
        id: exerciseId, user_id: userId, name: 'Bench',
        tags: [], created_at: ts, updated_at: ts,
      })

      // session_id is an optional field added in a later migration
      const { error } = await supabase.from('sets').upsert({
        id: setId, user_id: userId, exercise_id: exerciseId,
        date: ts, weight: 225, reps: 5, estimated_1rm: 253,
        session_id: 'sess-abc123',
      })

      expect(error).toBeNull()

      const { data } = await supabase.from('sets').select('*').eq('id', setId)
      expect(data![0].session_id).toBe('sess-abc123')
    })

    it('concurrent upserts to the same exercise resolve without error', async () => {
      const userId = await createTestUser()
      const exerciseId = uuid()
      const ts = now()

      // Seed the exercise
      await supabase.from('exercises').upsert({
        id: exerciseId, user_id: userId, name: 'Initial',
        tags: [], created_at: ts, updated_at: ts,
      })

      // Simulate two concurrent upserts (e.g. from two tabs)
      const [r1, r2] = await Promise.all([
        supabase.from('exercises').upsert({
          id: exerciseId, user_id: userId, name: 'Tab 1 Name',
          tags: ['Push'], created_at: ts, updated_at: now(),
        }),
        supabase.from('exercises').upsert({
          id: exerciseId, user_id: userId, name: 'Tab 2 Name',
          tags: ['Pull'], created_at: ts, updated_at: now(),
        }),
      ])

      // Neither should error — last-write-wins at DB level
      expect(r1.error).toBeNull()
      expect(r2.error).toBeNull()

      // Exactly one row should exist
      const { data } = await supabase
        .from('exercises')
        .select('*')
        .eq('id', exerciseId)

      expect(data).toHaveLength(1)
    })

    it('float precision is preserved through round-trip (weight, estimated_1rm)', async () => {
      const userId = await createTestUser()
      const exerciseId = uuid()
      const setId = uuid()
      const ts = now()

      await supabase.from('exercises').upsert({
        id: exerciseId, user_id: userId, name: 'Precision Test',
        tags: [], created_at: ts, updated_at: ts,
      })

      // Real columns use `real` (float4) — verify no silent truncation
      const { error } = await supabase.from('sets').upsert({
        id: setId, user_id: userId, exercise_id: exerciseId,
        date: ts, weight: 132.5, reps: 8, estimated_1rm: 166.25,
      })

      expect(error).toBeNull()

      const { data } = await supabase.from('sets').select('*').eq('id', setId)
      expect(data![0].weight).toBe(132.5)
      // float4 has ~7 digits of precision — 166.25 is exact in float4
      expect(data![0].estimated_1rm).toBe(166.25)
    })
  })

  // ── updated_at trigger (LIFT-1401) ─────────────────────────────

  /**
   * Last-write-wins is only a conflict resolution if the timestamps it compares
   * actually move, and for these three tables the SERVER is the only thing that
   * can move them: no client producer sends `updated_at`
   * (`_buildExerciseUpsert`, `_enqueueSetUpsert`, `_enqueueEntryUpsert` each
   * enumerate their columns and it is not among them). With no trigger, a row's
   * stamp is its INSERT-time `default now()` forever — every merge is a tie,
   * `mergeEntities` scores a tie as a LOCAL win, and a remote edit can never
   * win: the stale device re-upserts over the other one and never converges.
   *
   * That is not hypothetical. LIFT-1397's `supabase db push` answered SQLSTATE
   * 42704 for `trg_exercises_updated_at`, proving
   * `20250401000000_add_updated_at_columns.sql` never ran on production — its
   * version was baselined into `schema_migrations` while the schema arrived by
   * hand. **Prod's schema is not the migration history.**
   *
   * These tests cannot read production, and nothing in CI can. What they pin is
   * the layer below it: that the migration corpus, applied to a real Postgres,
   * actually produces a trigger that FIRES. `architecturalInvariants.test.ts`
   * proves the `create trigger` statement is present as text; only a real
   * database can prove the function resolves, the trigger is attached to the
   * right event, and nothing has left it DISABLED — the state
   * `20260909000000_make_bar_weight_nullable.sql` puts `exercises` into around
   * its backfill, and would leave it in permanently if it ever failed to
   * re-enable.
   *
   * Every write below goes through `upsert` with NO `updated_at` in the
   * payload, which is the shape the client actually sends. The existing
   * "last-write-wins" test one describe up passes `updated_at` explicitly, so
   * it would keep passing with every trigger dropped — the fixture supplies the
   * very thing whose absence is the bug.
   */
  describe('updated_at trigger maintains the last-write-wins stamp', () => {
    /**
     * `updated_at` of the one row with this id, as epoch ms.
     *
     * All three tables carry the column, but `from()` narrows on a literal
     * table name — the cast keeps one helper instead of three identical ones
     * and is runtime-identical (the string is passed straight through).
     */
    async function stampOf(
      table: 'exercises' | 'sets' | 'bodyweight_entries',
      id: string,
    ): Promise<number> {
      const { data, error } = await supabase
        .from(table as 'exercises')
        .select('updated_at')
        .eq('id', id)
        .single()
      expect(error).toBeNull()
      const stamp = Date.parse(data!.updated_at)
      expect(Number.isFinite(stamp)).toBe(true)
      return stamp
    }

    it('bumps exercises.updated_at on an upsert that omits the column', async () => {
      const userId = await createTestUser()
      const exerciseId = uuid()

      // Exactly `_buildExerciseUpsert`'s shape in the respect that matters:
      // no `updated_at`, so the column can only be filled by `default now()`.
      const { error: insertError } = await supabase.from('exercises').upsert({
        id: exerciseId, user_id: userId, name: 'Bench Press', tags: [],
      })
      expect(insertError).toBeNull()
      const inserted = await stampOf('exercises', exerciseId)

      // The rename device B makes. Through PostgREST this is its own
      // transaction, so `now()` is strictly later than the insert's.
      const { error } = await supabase.from('exercises').upsert({
        id: exerciseId, user_id: userId, name: 'Incline Bench Press', tags: ['Push'],
      })
      expect(error).toBeNull()

      expect(await stampOf('exercises', exerciseId)).toBeGreaterThan(inserted)
    })

    it('bumps sets.updated_at and bodyweight_entries.updated_at too', async () => {
      const userId = await createTestUser()
      const exerciseId = uuid()
      const setId = uuid()
      const entryId = uuid()
      const ts = now()

      await supabase.from('exercises').upsert({
        id: exerciseId, user_id: userId, name: 'Squat', tags: [],
      })
      await supabase.from('sets').upsert({
        id: setId, user_id: userId, exercise_id: exerciseId,
        date: ts, weight: 225, reps: 5, estimated_1rm: 253,
      })
      await supabase.from('bodyweight_entries').upsert({
        id: entryId, user_id: userId, date: ts, weight: 180,
      })
      const setInserted = await stampOf('sets', setId)
      const entryInserted = await stampOf('bodyweight_entries', entryId)

      // A corrected set and a corrected weigh-in — `updateSet` / `updateEntry`.
      await supabase.from('sets').upsert({
        id: setId, user_id: userId, exercise_id: exerciseId,
        date: ts, weight: 235, reps: 5, estimated_1rm: 264,
      })
      await supabase.from('bodyweight_entries').upsert({
        id: entryId, user_id: userId, date: ts, weight: 178.5,
      })

      expect(await stampOf('sets', setId)).toBeGreaterThan(setInserted)
      expect(await stampOf('bodyweight_entries', entryId)).toBeGreaterThan(entryInserted)
    })

    it('bumps updated_at on the soft-delete UPDATE path as well', async () => {
      // `enqueueDelete` sends `{ deleted_at }` and nothing else, so a delete
      // that raced an edit on another device would otherwise merge as a tie.
      const userId = await createTestUser()
      const exerciseId = uuid()

      await supabase.from('exercises').upsert({
        id: exerciseId, user_id: userId, name: 'Overhead Press', tags: [],
      })
      const inserted = await stampOf('exercises', exerciseId)

      const { error } = await supabase
        .from('exercises')
        .update({ deleted_at: now() })
        .eq('id', exerciseId)
        .eq('user_id', userId)
      expect(error).toBeNull()

      expect(await stampOf('exercises', exerciseId)).toBeGreaterThan(inserted)
    })
  })

  // ── Account deletion (#1299) ───────────────────────────────────

  // The one thing no fake-Supabase test in this repo can check: whether the
  // SECURITY DEFINER function actually has the PRIVILEGE to delete from
  // `auth.users`. That table lives in the auth schema and is owned by
  // supabase_auth_admin, not by the role migrations run as — so a wrong owner
  // or a missing grant fails at CALL time in production, long after a clean
  // migration and a green unit suite. This is the only place that can catch it.
  describe('delete_user_account RPC', () => {
    /**
     * Mint an auth user WITH a password and return a client signed in AS them.
     *
     * The RPC derives its target from `auth.uid()`, so it must be invoked by a
     * real session — a service_role call would only ever hit the
     * `not_authenticated` guard. The password is fixed (emails are unique) and
     * satisfies config.toml's `lower_upper_letters_digits` requirement.
     */
    async function createSignedInUser(): Promise<{
      userId: string
      client: SupabaseClient<Database>
    }> {
      const email = `delete-${uuid()}@lift.test`
      const password = 'LiftIntegration1'
      const { data, error } = await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      })
      if (error || !data.user) {
        throw new Error(
          `could not create test auth user: ${error?.message ?? 'no user returned'}`
        )
      }
      testUserIds.push(data.user.id)

      // A SEPARATE client on purpose: signing in on the shared service_role
      // client would swap its Authorization header to the user's JWT and
      // downgrade every later test in this file from service_role to
      // `authenticated`, silently subjecting them to RLS.
      const client = createClient<Database>(SUPABASE_URL!, SUPABASE_KEY!, {
        auth: { autoRefreshToken: false, persistSession: false },
      })
      const signIn = await client.auth.signInWithPassword({ email, password })
      if (signIn.error) {
        throw new Error(`could not sign in test user: ${signIn.error.message}`)
      }
      return { userId: data.user.id, client }
    }

    it("deletes the caller's own auth.users row and cascades their data", async () => {
      const { userId, client } = await createSignedInUser()
      const exerciseId = uuid()
      const ts = now()

      // Seed a row so the FK cascade is observable, not just the user row.
      const seed = await supabase.from('exercises').upsert({
        id: exerciseId,
        user_id: userId,
        name: 'Cascade Check',
        tags: [],
        created_at: ts,
        updated_at: ts,
      })
      expect(seed.error).toBeNull()

      // A wrong function owner / missing grant surfaces HERE, as
      // "permission denied for table users".
      const { error } = await client.rpc('delete_user_account')
      expect(error).toBeNull()

      const lookup = await supabase.auth.admin.getUserById(userId)
      expect(lookup.data?.user ?? null).toBeNull()

      const { data: rows } = await supabase
        .from('exercises')
        .select('id')
        .eq('id', exerciseId)
      expect(rows).toEqual([])
    })

    it('refuses a caller with no authenticated session', async () => {
      // EXECUTE is revoked from public/anon and granted to `authenticated`
      // only, and the body additionally raises when auth.uid() is null. The
      // service_role key is not a member of `authenticated`, so this is denied
      // by the grant; even if it were, the guard would reject it. Either way
      // the call must fail rather than delete an arbitrary row.
      const { error } = await supabase.rpc('delete_user_account')
      expect(error).not.toBeNull()
    })
  })
})

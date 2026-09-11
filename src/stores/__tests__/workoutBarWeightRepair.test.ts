/**
 * Regression: a locally-held `barWeight: 45` must not be pushed back over the
 * server's cleared value (LIFT-1398).
 *
 * LIFT-1387 made `bar_weight` nullable and backfilled every materialized 45 to
 * NULL, deliberately WITHOUT bumping `updated_at` (a bump hands the server the
 * win in the next last-write-wins merge, reverting any unflushed offline edit on
 * those rows). The migration's comment then reasoned that the cleared value
 * "propagates to local state on its own" because "the remote row wins the next
 * merge anyway". It does not, on any device that already fetched the row:
 *
 *   1. That device adopted the server row verbatim — the 45 AND the server's
 *      `updated_at` (`mapRemoteExercise` copies it as-is).
 *   2. An unbumped backfill leaves that `updated_at` untouched, so local and
 *      remote TIE on the next fetch.
 *   3. `mergeEntities` gives ties to LOCAL (`localTime >= remoteTime`), and
 *      `_fetchFromSupabase` re-upserts every `localWins` exercise.
 *   4. `_buildExerciseUpsert` always sends `bar_weight: barWeight ?? null`, and
 *      the local value is still an explicit 45.
 *
 * So the backfill only ever stuck for rows no device held yet, and kg users on
 * existing devices kept the 45 kg (99 lb) bar LIFT-1387 set out to remove.
 *
 * Why the suite missed it: `syncPipelineIntegration.test.ts` round-trips ONE
 * device through upsert → fetch, where nothing ever changes the server row
 * behind the client's back. Reproducing this needs the server value to move
 * while `updated_at` stands still — which is exactly what a trigger-suppressed
 * backfill does, and what no fixture had ever modelled.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { getLocalStorageMock } from '../../__tests__/helpers'

const localStorageMock = getLocalStorageMock()

const { fakeSupabase } = await vi.hoisted(async () => {
  const { createFakeSupabase } = await import('../../__tests__/fakeSupabase')
  return { fakeSupabase: createFakeSupabase({ mode: 'ok' }) }
})

vi.mock('../../lib/supabase', () => ({
  supabase: fakeSupabase,
  isPreviewMode: { value: false },
}))

// Synchronous syncQueue: run each enqueued op immediately so the upserts land on
// the fake and the assertions can read SERVER state rather than a list of
// intentions.
vi.mock('../../lib/syncQueue', () => {
  const invoke = (_key: string, op: () => PromiseLike<unknown>) => {
    Promise.resolve(op()).catch(() => {})
  }
  return {
    syncQueue: { enqueue: vi.fn(invoke), enqueueDelete: vi.fn(invoke), clear: vi.fn() },
  }
})

vi.mock('../../lib/logger', () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}))

import { useWorkoutStore } from '../workout'
import { _resetTombstones } from '../../lib/tombstones'
import { BAR_WEIGHT_REPAIR_KEY } from '../../lib/barWeightRepair'

const USER = 'user-1398'
/** The `updated_at` both sides carry — the device adopted it from the server. */
const STAMP = '2026-09-01T10:00:00.000Z'

/** Let the synchronous syncQueue's microtask chains settle. */
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

function serverRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ex-1',
    user_id: USER,
    name: 'Bench Press',
    tags: [],
    input_mode: 'plates',
    bar_weight: 45,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: STAMP,
    deleted_at: null,
    ...overrides,
  }
}

/** What the device wrote to localStorage the last time it fetched this row. */
function seedLocalExercise(barWeight: number | undefined) {
  localStorageMock.setItem('workout-exercises', JSON.stringify([{
    id: 'ex-1',
    name: 'Bench Press',
    tags: [],
    sets: [],
    inputMode: 'plates',
    ...(barWeight === undefined ? {} : { barWeight }),
    updated_at: STAMP,
  }]))
}

const serverBarWeight = () =>
  (fakeSupabase.tables.exercises.find(r => r.id === 'ex-1') as { bar_weight?: number | null })
    ?.bar_weight

describe('the LIFT-1387 backfill survives the first sync of a device that already holds the row (LIFT-1398)', () => {
  beforeEach(() => {
    localStorageMock.clear()
    _resetTombstones()
    fakeSupabase.reset()
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('drops a materialized 45 the device is holding, and pushes NULL over it rather than 45', async () => {
    // The dominant production shape: the device fetched this row back when the
    // column still had its NOT NULL DEFAULT 45, so it holds an explicit 45
    // stamped at the server's own updated_at. The backfill has since cleared the
    // server value without moving that timestamp.
    seedLocalExercise(45)
    fakeSupabase.seed('exercises', [serverRow({ bar_weight: null })])
    fakeSupabase.seed('sets', [])

    const store = useWorkoutStore()
    await store.init(USER)
    await flush()

    // The unit-aware `defaultBarWeight` is reachable again.
    expect(store.exercises[0].barWeight).toBeUndefined()
    // And the tie-push carries NULL. Before the fix it carried 45 — the value
    // the backfill had just cleared, written straight back.
    expect(serverBarWeight()).toBeNull()
  })

  it('drops a materialized 45 adopted from a server the backfill has not reached yet', async () => {
    // The second shape: a new sign-in or a PWA reinstall (#1152) hydrates the
    // row for the FIRST time, from a server that still holds the 45. The local
    // pass in `load()` ran over an empty payload and saw nothing, so only the
    // fetch pass can catch this one.
    fakeSupabase.seed('exercises', [serverRow()])
    fakeSupabase.seed('sets', [])

    const store = useWorkoutStore()
    await store.init(USER)
    await flush()

    expect(store.exercises[0].barWeight).toBeUndefined()

    // A remote-only row is adopted, not pushed, so the cleared value reaches the
    // server on the NEXT sync — as a tie, through the same `localWins` upsert.
    await store._fetchFromSupabase()
    await flush()
    expect(serverBarWeight()).toBeNull()
    expect(store.exercises[0].barWeight).toBeUndefined()
  })

  it('repairs local state at launch, before any fetch — the bug is plate math, not just sync', async () => {
    // `weightToPlates(100, 45, KG_PLATES)` says 27.5 per side where the real
    // 20 kg bar wants 40, and it decomposes cleanly, so nothing on screen
    // suggests the bar is wrong. A kg user opening the app offline or signed out
    // must not have to wait for a successful fetch to get the right load.
    seedLocalExercise(45)

    const store = useWorkoutStore()

    expect(store.exercises[0].barWeight).toBeUndefined()
    // …and the pass stays available, because this device has not seen the
    // server's copy of the row yet.
    expect(localStorageMock.getItem(BAR_WEIGHT_REPAIR_KEY)).toBeNull()
  })

  it('leaves `updated_at` alone, so the repair cannot win a merge the user never made', async () => {
    // Same rule the migration's trigger suppression follows and the same rule
    // `mergeExerciseMetadata` follows (LIFT-1369): a value the client derived
    // must never out-rank a real edit from another device (2026-04-12 SEV1).
    seedLocalExercise(45)
    fakeSupabase.seed('exercises', [serverRow({ bar_weight: null })])
    fakeSupabase.seed('sets', [])

    const store = useWorkoutStore()
    await store.init(USER)
    await flush()

    expect(store.exercises[0].updated_at).toBe(STAMP)
  })

  it('keeps a non-default explicit bar untouched', async () => {
    // 15 is a real user choice in either unit and is not a value any column
    // default ever produced.
    seedLocalExercise(15)
    fakeSupabase.seed('exercises', [serverRow({ bar_weight: 15 })])
    fakeSupabase.seed('sets', [])

    const store = useWorkoutStore()
    await store.init(USER)
    await flush()

    expect(store.exercises[0].barWeight).toBe(15)
    expect(serverBarWeight()).toBe(15)
  })

  it('burns the one-shot flag only once a fetch has repaired the server copy too', async () => {
    // Hydrating from localStorage is not enough to consume the repair: a device
    // that is signed out, offline, or mid-reinstall has not seen the server's
    // copy of these rows yet, and a flag burned there would leave a 45 it adopts
    // later in place forever.
    seedLocalExercise(45)
    fakeSupabase.seed('exercises', [serverRow({ bar_weight: null })])
    fakeSupabase.seed('sets', [])

    const store = useWorkoutStore()
    expect(localStorageMock.getItem(BAR_WEIGHT_REPAIR_KEY)).toBeNull()

    await store.init(USER)
    await flush()
    expect(localStorageMock.getItem(BAR_WEIGHT_REPAIR_KEY)).toBe('true')
  })

  it('does not re-clear a 45 the user set after the repair was consumed', async () => {
    // Once the pass is done the value stops being ambiguous: the column default
    // is gone, so a 45 can only be a deliberate choice. It must survive the
    // round trip like any other bar weight.
    localStorageMock.setItem(BAR_WEIGHT_REPAIR_KEY, 'true')
    seedLocalExercise(undefined)
    fakeSupabase.seed('exercises', [serverRow({ bar_weight: null })])
    fakeSupabase.seed('sets', [])

    const store = useWorkoutStore()
    await store.init(USER)
    await flush()

    store.setExerciseBarWeight('ex-1', 45)
    await flush()
    expect(serverBarWeight()).toBe(45)

    await store._fetchFromSupabase()
    await flush()
    expect(store.exercises[0].barWeight).toBe(45)
  })
})

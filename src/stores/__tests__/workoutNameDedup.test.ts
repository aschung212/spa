/**
 * Regression: merging same-named exercises must not drop repeated sets (LIFT-1332).
 *
 * `deduplicateByName` collapses two exercise rows that share a name but carry
 * different UUIDs — the cross-device case where each device independently
 * created its own "Bench Press". The merge gated incoming sets on a `Set` of
 * `day|weight|reps` content keys, and a `Set` cannot hold a count, so it
 * admitted at most ONE set per (day, weight, reps) tuple. Straight-set
 * programming collides with itself by construction, so a 5x5 arriving from the
 * duplicate row merged in as a single set — or, if the primary already logged
 * that tuple, as nothing at all.
 *
 * The loss was permanent from the user's side: `_fetchFromSupabase` commits the
 * deduped result to `exercises.value` and `_persist()`s it, and every later
 * fetch re-runs the same dedup over the same server rows. Nothing errors and
 * nothing ever restores the sets. (The rows do survive on the server — dedup is
 * strictly local per the 2026-04-12 SEV1 fix — which is exactly why it was
 * silent, and why this fix heals existing accounts on their next fetch.)
 *
 * Why the suite missed it: the two `deduplicateByName` tests in `workout.test.ts`
 * asserted only which EXERCISES survived, never how many sets came across, and
 * nothing anywhere drove a cross-device duplicate through the fetch pipeline.
 * These tests assert set counts, at the pure-function level in `workout.test.ts`
 * and end-to-end here.
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

vi.mock('../../lib/syncQueue', () => ({
  syncQueue: { enqueue: vi.fn(), enqueueDelete: vi.fn(), clear: vi.fn() },
}))

vi.mock('../../lib/logger', () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}))

import { useWorkoutStore } from '../workout'
import type { Exercise } from '../workout'
import { effectiveSetWeight } from '../../lib/bodyweightLoad'

const USER = 'user-1332'
const DAY = '2026-09-01'

function exerciseRow(id: string, name: string, updatedAt: string) {
  return {
    id, user_id: USER, name, tags: [],
    created_at: '2026-01-01T00:00:00.000Z', updated_at: updatedAt, deleted_at: null,
  }
}

/**
 * A day of straight sets as the app actually writes them: `endOfDayISO` stamps
 * `${day}T23:59:${ss}.${ms}Z` with jittered seconds, so same-day repeats of one
 * weight/rep tuple are distinguishable by their full timestamp but identical at
 * day granularity — the collision the old content key could not survive.
 */
function straightSets(exerciseId: string, prefix: string, count: number, firstSecond: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`,
    user_id: USER,
    exercise_id: exerciseId,
    date: `${DAY}T23:59:${String(firstSecond + i).padStart(2, '0')}.000Z`,
    weight: 135,
    reps: 5,
    estimated_1rm: 152,
    created_at: `${DAY}T18:0${i}:00.000Z`,
    deleted_at: null,
  }))
}

/** Two devices each created their own row for the same lift and logged into it. */
function seedCrossDeviceDuplicate() {
  fakeSupabase.seed('exercises', [
    exerciseRow('uuid-a', 'Bench Press', '2026-09-01T10:00:00.000Z'),
    exerciseRow('uuid-b', 'bench press', '2026-09-01T11:00:00.000Z'),
  ])
  fakeSupabase.seed('sets', [
    ...straightSets('uuid-a', 'a', 5, 10),
    ...straightSets('uuid-b', 'b', 3, 30),
  ])
}

describe('cross-device same-name merge keeps repeated sets (LIFT-1332)', () => {
  beforeEach(() => {
    localStorageMock.clear()
    fakeSupabase.reset()
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('hydrates all 8 sets — device B\'s 3x5 used to vanish entirely', async () => {
    seedCrossDeviceDuplicate()

    const store = useWorkoutStore()
    await store.init(USER)

    expect(store.exercises).toHaveLength(1)
    const ids = store.exercises[0].sets.map(s => s.id).sort()
    expect(ids).toEqual(['a-0', 'a-1', 'a-2', 'a-3', 'a-4', 'b-0', 'b-1', 'b-2'])
  })

  it('persists all 8 to localStorage — the dropped sets never came back', async () => {
    // The commit to localStorage is what made this permanent rather than a
    // render glitch: the deduped array is what the next cold start loads.
    seedCrossDeviceDuplicate()

    const store = useWorkoutStore()
    await store.init(USER)

    const persisted = JSON.parse(localStorageMock.getItem('workout-exercises')!) as Exercise[]
    expect(persisted).toHaveLength(1)
    expect(persisted[0].sets).toHaveLength(8)
  })

  it('is stable across repeated fetches — dedup re-runs on every sync', async () => {
    seedCrossDeviceDuplicate()

    const store = useWorkoutStore()
    await store.init(USER)
    // The second fetch re-runs dedup with the already-merged row in local
    // state, so every set now arrives from both sides. Id dedup must hold.
    await store.init(USER)

    expect(store.exercises).toHaveLength(1)
    expect(store.exercises[0].sets).toHaveLength(8)
  })

  it('still collapses re-inserted copies that share a full timestamp', async () => {
    // The case the content key was reaching for: a migration re-run mints fresh
    // set UUIDs but copies `date` verbatim, so the copies collide exactly.
    // `deduplicateSets` runs over the merged list right after and catches them —
    // without dropping jitter-differentiated repeats along with them.
    fakeSupabase.seed('exercises', [
      exerciseRow('uuid-a', 'Row', '2026-09-01T10:00:00.000Z'),
      exerciseRow('uuid-b', 'row', '2026-09-01T11:00:00.000Z'),
    ])
    const original = straightSets('uuid-a', 'a', 3, 10)
    fakeSupabase.seed('sets', [
      ...original,
      // Same dates, new ids, filed under the duplicate exercise.
      ...original.map((s, i) => ({ ...s, id: `copy-${i}`, exercise_id: 'uuid-b' })),
    ])

    const store = useWorkoutStore()
    await store.init(USER)

    expect(store.exercises).toHaveLength(1)
    expect(store.exercises[0].sets.map(s => s.id)).toEqual(['a-0', 'a-1', 'a-2'])
  })
})

/**
 * The same merge, one field list over: the absorbed row's CONFIGURATION
 * (LIFT-1369).
 *
 * Only sets, tags and gyms were ever merged, so the note, equipment
 * classification, Intensity-lens rep count and bodyweight-loaded flag the lifter
 * set on their phone were dropped the moment the other device's row won on set
 * count — and stayed dropped, because the merge re-runs against the same server
 * rows on every fetch and reaches the same answer. Nothing on screen said why.
 *
 * `bodyweightLoaded` is the one that goes past "a setting was lost". The absorbed
 * row's sets arrive still carrying the bodyweight captured at log time (#1357
 * restores it after both dedup passes) and a folded `estimated1RM`, so a merged
 * row with no flag reports a pure-bodyweight pull-up as zero volume beside a
 * ~204 lb one-rep max — the LIFT-1373 contradiction, reached by a sync.
 */
describe('cross-device same-name merge keeps the absorbed row\'s config (LIFT-1369)', () => {
  const BODYWEIGHT = 175
  const FOLDED_E1RM = 204 // epley(0 + 175, 5)

  beforeEach(() => {
    localStorageMock.clear()
    fakeSupabase.reset()
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  /** Pure-bodyweight reps: added weight 0, the whole load in the capture. */
  function pullupSets(exerciseId: string, prefix: string, count: number, firstSecond: number) {
    return Array.from({ length: count }, (_, i) => ({
      id: `${prefix}-${i}`,
      user_id: USER,
      exercise_id: exerciseId,
      date: `${DAY}T23:59:${String(firstSecond + i).padStart(2, '0')}.000Z`,
      weight: 0,
      reps: 5,
      estimated_1rm: FOLDED_E1RM,
      created_at: `${DAY}T18:0${i}:00.000Z`,
      deleted_at: null,
    }))
  }

  /**
   * Device A's row carries more sets and no configuration; device B's row is the
   * one the lifter actually set up. Device B's local copy additionally holds the
   * per-set bodyweight captures, which have no `sets` column (#1357).
   */
  function seedConfiguredDuplicate() {
    fakeSupabase.seed('exercises', [
      { ...exerciseRow('uuid-a', 'pull-ups', '2026-09-01T10:00:00.000Z') },
      {
        ...exerciseRow('uuid-b', 'Pull-ups', '2026-09-01T11:00:00.000Z'),
        bodyweight_loaded: true,
        notes: 'chin over the bar',
        equipment: 'bodyweight',
        intensity_max_reps: 6,
        plate_count_mode: 'total',
      },
    ])
    fakeSupabase.seed('sets', [
      ...pullupSets('uuid-a', 'a', 5, 10),
      ...pullupSets('uuid-b', 'b', 3, 30),
    ])
    localStorageMock.setItem('workout-exercises', JSON.stringify([
      {
        id: 'uuid-b',
        name: 'Pull-ups',
        tags: [],
        bodyweightLoaded: true,
        notes: 'chin over the bar',
        equipment: 'bodyweight',
        intensityMaxReps: 6,
        plateCountMode: 'total',
        updated_at: '2026-09-01T11:00:00.000Z',
        sets: pullupSets('uuid-b', 'b', 3, 30).map(s => ({
          id: s.id,
          date: s.date,
          weight: 0,
          reps: 5,
          estimated1RM: FOLDED_E1RM,
          bodyweight: BODYWEIGHT,
        })),
      },
    ]))
  }

  it('keeps the config the absorbed row carried', async () => {
    seedConfiguredDuplicate()

    const store = useWorkoutStore()
    await store.init(USER)

    expect(store.exercises).toHaveLength(1)
    const merged = store.exercises[0]
    // The primary is device A's row — it has more sets — so every one of these
    // used to be gone.
    expect(merged.id).toBe('uuid-a')
    expect(merged.bodyweightLoaded).toBe(true)
    expect(merged.notes).toBe('chin over the bar')
    expect(merged.equipment).toBe('bodyweight')
    expect(merged.intensityMaxReps).toBe(6)
    expect(merged.plateCountMode).toBe('total')
  })

  it('makes the absorbed sets\' volume agree with their stored e1RM again', async () => {
    seedConfiguredDuplicate()

    const store = useWorkoutStore()
    await store.init(USER)

    const merged = store.exercises[0]
    const set = merged.sets.find(s => s.id === 'b-0')!
    // The capture survives the merge (#1357); without the flag beside it the
    // fold is 0, so the same set reported 0 lbs of volume and a 204 lb e1RM.
    expect(set.bodyweight).toBe(BODYWEIGHT)
    expect(effectiveSetWeight(set, merged)).toBe(BODYWEIGHT)
    expect(set.estimated1RM).toBe(FOLDED_E1RM)
  })

  it('persists the merged config — the loss was permanent, not a render glitch', async () => {
    seedConfiguredDuplicate()

    const store = useWorkoutStore()
    await store.init(USER)

    const persisted = JSON.parse(localStorageMock.getItem('workout-exercises')!) as Exercise[]
    expect(persisted).toHaveLength(1)
    expect(persisted[0].bodyweightLoaded).toBe(true)
    expect(persisted[0].notes).toBe('chin over the bar')
  })

  it('does not resurrect the absorbed row or restamp the survivor', async () => {
    // Display-only (2026-04-12 SEV1): the fill must not look like an edit, or a
    // later last-write-wins comparison would push the heuristic to the server.
    seedConfiguredDuplicate()

    const store = useWorkoutStore()
    await store.init(USER)

    expect(store.exercises.map(e => e.id)).toEqual(['uuid-a'])
    expect(store.exercises[0].updated_at).toBe('2026-09-01T10:00:00.000Z')
  })
})

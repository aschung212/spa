/**
 * Regression: a remote-wins merge must not erase local-only per-set fields (#1357).
 *
 * `mergeEntities` picks an exercise wholesale by last-write-wins, and the set
 * union that follows only adds sets the winner is MISSING. So when the remote
 * exercise row wins — another device renamed or re-tagged it, or a replayed
 * journal entry bumped `updated_at` — every set present on both sides is
 * replaced by the server's copy of itself.
 *
 * `rpe` (#617) and `bodyweight` (LIFT-834) have no `sets` column: the upsert
 * never sends them and `mapRemoteSet` cannot read them back. The adopted copy
 * therefore carried `undefined` where the annotation was, so a rename on a
 * second phone wiped every RPE the lifter had typed and dropped the bodyweight
 * captured onto each calisthenic set — collapsing `effectiveSetWeight` to the
 * added weight alone, which silently rewrites pull-up volume and e1RM history.
 * Nothing errored, and the result was committed to localStorage, so the next
 * cold start loaded the stripped copy: permanent from the user's side.
 *
 * Why the suite missed it: every fetch-path test seeded local state through
 * plain `logSet`/fixtures with none of the optional fields set, so the two
 * fields that cannot round-trip were never present when a remote row won. The
 * tests below drive the real pipeline with them set, and assert on both the
 * committed state and the persisted payload.
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

const USER = 'user-1357'
const EX = 'ex-pullup'
const DAY = '2026-09-01'
const LOCAL_UPDATED = '2026-09-01T10:00:00.000Z'
const REMOTE_UPDATED = '2026-09-01T11:00:00.000Z'
const BODYWEIGHT = 165

/** Local state as the app writes it: a bodyweight-loaded lift with RPE typed in. */
function seedLocalExercise(overrides: Partial<Exercise> = {}) {
  const local: Exercise[] = [{
    id: EX,
    name: 'Pull Up',
    tags: ['Back'],
    bodyweightLoaded: true,
    updated_at: LOCAL_UPDATED,
    sets: [
      {
        id: 'set-1',
        date: `${DAY}T23:59:10.000Z`,
        weight: 25,
        reps: 5,
        // Folded at write time (LIFT-834): 25 added + 165 bodyweight.
        estimated1RM: 221,
        rpe: 8.5,
        bodyweight: BODYWEIGHT,
      },
      {
        id: 'set-2',
        date: `${DAY}T23:59:11.000Z`,
        weight: 25,
        reps: 4,
        estimated1RM: 215,
        rpe: 9,
        bodyweight: BODYWEIGHT,
      },
    ],
    ...overrides,
  }]
  localStorageMock.setItem('workout-exercises', JSON.stringify(local))
}

/**
 * The server's view of the same exercise and sets. `updated_at` is newer (the
 * other device renamed it), and the set rows carry no rpe/bodyweight because
 * those columns do not exist.
 */
function seedRemote(
  { updatedAt = REMOTE_UPDATED, extraSets = [] }:
  { updatedAt?: string; extraSets?: Record<string, unknown>[] } = {},
) {
  fakeSupabase.seed('exercises', [{
    id: EX, user_id: USER, name: 'Pull-Up', tags: ['Back'],
    bodyweight_loaded: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: updatedAt,
    deleted_at: null,
  }])
  fakeSupabase.seed('sets', [
    {
      id: 'set-1', user_id: USER, exercise_id: EX,
      date: `${DAY}T23:59:10.000Z`, weight: 25, reps: 5, estimated_1rm: 221,
      created_at: `${DAY}T18:00:00.000Z`, deleted_at: null,
    },
    {
      id: 'set-2', user_id: USER, exercise_id: EX,
      date: `${DAY}T23:59:11.000Z`, weight: 25, reps: 4, estimated_1rm: 215,
      created_at: `${DAY}T18:04:00.000Z`, deleted_at: null,
    },
    ...extraSets,
  ])
}

describe('remote-wins merge preserves local-only set fields (#1357)', () => {
  beforeEach(() => {
    localStorageMock.clear()
    fakeSupabase.reset()
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('keeps RPE and captured bodyweight when the remote exercise wins', async () => {
    seedLocalExercise()
    seedRemote()

    const store = useWorkoutStore()
    await store.init(USER)

    // The scenario is live only if remote actually won the exercise — otherwise
    // the local objects survive untouched and the assertions below are vacuous.
    expect(store.exercises[0].name).toBe('Pull-Up')

    const sets = store.exercises[0].sets
    expect(sets.map(s => s.rpe)).toEqual([8.5, 9])
    expect(sets.map(s => s.bodyweight)).toEqual([BODYWEIGHT, BODYWEIGHT])
  })

  it('keeps the pull-up folding its bodyweight into effective load', async () => {
    // The user-visible half: without the captured bodyweight, every volume and
    // e1RM read collapses a "+25 x 5" pull-up to 25 lbs.
    seedLocalExercise()
    seedRemote()

    const store = useWorkoutStore()
    await store.init(USER)

    const exercise = store.exercises[0]
    expect(effectiveSetWeight(exercise.sets[0], exercise)).toBe(25 + BODYWEIGHT)
  })

  it('persists the preserved fields — the loss used to survive a cold start', async () => {
    seedLocalExercise()
    seedRemote()

    const store = useWorkoutStore()
    await store.init(USER)

    const persisted = JSON.parse(localStorageMock.getItem('workout-exercises')!) as Exercise[]
    expect(persisted[0].sets.map(s => s.rpe)).toEqual([8.5, 9])
    expect(persisted[0].sets.map(s => s.bodyweight)).toEqual([BODYWEIGHT, BODYWEIGHT])
  })

  it('is stable across repeated fetches', async () => {
    // Every later sync re-runs the same merge over the same server rows, so a
    // one-shot repair would be undone on the next fetch.
    seedLocalExercise()
    seedRemote()

    const store = useWorkoutStore()
    await store.init(USER)
    await store.init(USER)

    expect(store.exercises[0].sets.map(s => s.rpe)).toEqual([8.5, 9])
    expect(store.exercises[0].sets.map(s => s.bodyweight)).toEqual([BODYWEIGHT, BODYWEIGHT])
  })

  it('leaves a remote-only set alone and still preserves its neighbours', async () => {
    // A set logged on the other device has no local counterpart, so it arrives
    // with no RPE — the restore must not invent one from a sibling.
    seedLocalExercise()
    seedRemote({
      extraSets: [{
        id: 'set-remote', user_id: USER, exercise_id: EX,
        date: `${DAY}T23:59:12.000Z`, weight: 25, reps: 3, estimated_1rm: 207,
        created_at: `${DAY}T18:08:00.000Z`, deleted_at: null,
      }],
    })

    const store = useWorkoutStore()
    await store.init(USER)

    const sets = store.exercises[0].sets
    expect(sets).toHaveLength(3)
    const remoteOnly = sets.find(s => s.id === 'set-remote')!
    expect(remoteOnly.rpe).toBeUndefined()
    expect(remoteOnly.bodyweight).toBeUndefined()
    expect(sets.find(s => s.id === 'set-1')!.rpe).toBe(8.5)
  })

  it('keeps a locally cleared RPE cleared', async () => {
    // `updateSet(..., rpe: null)` deletes the field. Nothing holds the old value
    // afterwards, so the restore has nothing to re-attach — a merge must not
    // resurrect an annotation the user removed.
    //
    // The clock is pinned before REMOTE_UPDATED because `updateSet` stamps
    // `exercise.updated_at = now`: at wall-clock time the local edit would win
    // the merge outright and the assertion would never reach the restore pass.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-01T10:30:00.000Z'))
    seedLocalExercise()
    seedRemote()

    const store = useWorkoutStore()
    store.updateSet(EX, 'set-1', 25, 5, undefined, null)
    expect(store.exercises[0].sets[0]).not.toHaveProperty('rpe')
    vi.useRealTimers()

    await store.init(USER)

    expect(store.exercises[0].sets[0]).not.toHaveProperty('rpe')
    expect(store.exercises[0].sets[1].rpe).toBe(9)
  })

  it('changes nothing when the local exercise wins', async () => {
    seedLocalExercise()
    seedRemote({ updatedAt: '2026-08-01T00:00:00.000Z' })

    const store = useWorkoutStore()
    await store.init(USER)

    expect(store.exercises[0].name).toBe('Pull Up')
    expect(store.exercises[0].sets.map(s => s.rpe)).toEqual([8.5, 9])
  })
})

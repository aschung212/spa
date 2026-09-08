/**
 * Regression: deleting a cross-device duplicated exercise must delete BOTH
 * server rows (LIFT-1335).
 *
 * `deduplicateByName` collapses two exercise rows that share a name but carry
 * different UUIDs into one local row. That merge is strictly local — the
 * absorbed row keeps its own `exercises` row, and its sets keep their own
 * `exercise_id` (2026-04-12 SEV1: the client has no authority to push
 * dedup-derived deletes). So the UI ends up holding only the primary's id, and
 * `deleteExercise` tombstoned and soft-deleted only that one. The duplicate came
 * straight back on the next fetch, with its sets, and had to be deleted a second
 * time — a delete that silently did not do what the button said.
 *
 * The fix carries the absorbed ids on the surviving row (`Exercise.mergedFrom`,
 * local-only, recomputed on every fetch) and routes delete / undo-commit /
 * restore through `exerciseServerIds`. Deriving the duplicates by NAME at delete
 * time would have been the banned dedup-heuristic mutation; these ids were
 * observed as live server rows during a fetch and are only ever acted on when
 * the user asks for this row to go.
 *
 * Why the suite missed it: nothing anywhere deleted an exercise that had come
 * out of a name merge. `workoutNameDedup.test.ts` drives the fetch pipeline but
 * stops at hydration, and every delete test seeds a single row per name — where
 * `mergedFrom` is empty and the old and new code do exactly the same thing.
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

// Synchronous syncQueue: run each enqueued op immediately so the soft-deletes
// actually land on the fake and the assertions can read the server state rather
// than a list of intentions.
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

import { useWorkoutStore, exerciseServerIds } from '../workout'
import type { Exercise } from '../workout'
import { _resetTombstones } from '../../lib/tombstones'

const USER = 'user-1335'
const DAY = '2026-09-02'

/** Let the synchronous syncQueue's microtask chains settle. */
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

function exerciseRow(id: string, name: string, updatedAt: string) {
  return {
    id, user_id: USER, name, tags: [],
    created_at: '2026-01-01T00:00:00.000Z', updated_at: updatedAt, deleted_at: null,
  }
}

function setRow(id: string, exerciseId: string, second: number) {
  return {
    id,
    user_id: USER,
    exercise_id: exerciseId,
    date: `${DAY}T23:59:${String(second).padStart(2, '0')}.000Z`,
    weight: 135,
    reps: 5,
    estimated_1rm: 152,
    created_at: `${DAY}T18:00:00.000Z`,
    deleted_at: null,
  }
}

/** Two devices each created their own row for the same lift and logged into it. */
function seedCrossDeviceDuplicate() {
  fakeSupabase.seed('exercises', [
    exerciseRow('uuid-a', 'Bench Press', '2026-09-02T10:00:00.000Z'),
    exerciseRow('uuid-b', 'bench press', '2026-09-02T11:00:00.000Z'),
  ])
  fakeSupabase.seed('sets', [
    setRow('a-0', 'uuid-a', 10),
    setRow('a-1', 'uuid-a', 11),
    setRow('b-0', 'uuid-b', 30),
  ])
}

const liveExerciseIds = () =>
  fakeSupabase.tables.exercises.filter(r => r.deleted_at == null).map(r => r.id).sort()

const liveSetIds = () =>
  fakeSupabase.tables.sets.filter(r => r.deleted_at == null).map(r => r.id).sort()

describe('deleting a merged exercise removes every server row it stands for (LIFT-1335)', () => {
  beforeEach(() => {
    localStorageMock.clear()
    _resetTombstones()
    fakeSupabase.reset()
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('records the absorbed duplicate on the surviving row', async () => {
    seedCrossDeviceDuplicate()

    const store = useWorkoutStore()
    await store.init(USER)

    expect(store.exercises).toHaveLength(1)
    // uuid-a wins (2 sets vs 1) and now stands for uuid-b as well.
    expect(store.exercises[0].id).toBe('uuid-a')
    expect(store.exercises[0].mergedFrom).toEqual(['uuid-b'])
  })

  it('soft-deletes both exercise rows and both sets, so it does not come back', async () => {
    seedCrossDeviceDuplicate()

    const store = useWorkoutStore()
    await store.init(USER)
    store.deleteExercise('uuid-a')
    await flush()

    // Before the fix, uuid-b and its set were still live here.
    expect(liveExerciseIds()).toEqual([])
    expect(liveSetIds()).toEqual([])

    await store.init(USER)
    expect(store.exercises).toHaveLength(0)
  })

  it('keeps it gone even while the server rows are still live — the tombstone covers the duplicate too', async () => {
    // The soft-delete can sit in the queue for an entire offline session. The
    // fetch filter is what has to hold in the meantime, and it is keyed on the
    // tombstone, so the duplicate needs one of its own.
    seedCrossDeviceDuplicate()

    const store = useWorkoutStore()
    await store.init(USER)
    store.deleteExercise('uuid-a', { sync: false })
    await store.init(USER)

    expect(store.exercises).toHaveLength(0)
  })

  it('commits the whole delete through the undo path, not just the primary', async () => {
    // The UI never calls deleteExercise with sync:true — it deletes locally,
    // shows an undo toast, and commits via syncDeleteExercise once it expires.
    seedCrossDeviceDuplicate()

    const store = useWorkoutStore()
    await store.init(USER)
    const saved = { ...store.exercises[0], sets: [...store.exercises[0].sets] }
    store.deleteExercise(saved.id, { sync: false })
    store.syncDeleteExercise(saved)
    await flush()

    expect(liveExerciseIds()).toEqual([])
    expect(liveSetIds()).toEqual([])
  })

  it('undo restores the duplicate too, so the merged sets survive the next fetch', async () => {
    seedCrossDeviceDuplicate()

    const store = useWorkoutStore()
    await store.init(USER)
    const saved: Exercise = { ...store.exercises[0], sets: [...store.exercises[0].sets] }
    store.deleteExercise(saved.id)
    await flush()
    store.restoreExercise(saved, 0)
    await flush()

    expect(liveExerciseIds()).toEqual(['uuid-a', 'uuid-b'])
    expect(liveSetIds()).toEqual(['a-0', 'a-1', 'b-0'])

    // A tombstone left on uuid-b would silently drop device B's set here.
    await store.init(USER)
    expect(store.exercises).toHaveLength(1)
    expect(store.exercises[0].sets.map(s => s.id).sort()).toEqual(['a-0', 'a-1', 'b-0'])
  })

  it('survives localStorage, so an offline relaunch can still delete both rows', async () => {
    // mergedFrom is only ever written during a fetch. A relaunch whose fetch
    // fails (or has not landed yet) deletes off the hydrated row alone, so
    // parseExercise has to keep the field — it drops every key it does not
    // name, which would have silently reduced this to the old one-row delete.
    seedCrossDeviceDuplicate()

    const store = useWorkoutStore()
    await store.init(USER)
    expect(JSON.parse(localStorageMock.getItem('workout-exercises')!)[0].mergedFrom)
      .toEqual(['uuid-b'])

    setActivePinia(createPinia())
    const relaunched = useWorkoutStore()
    expect(exerciseServerIds(relaunched.exercises[0])).toEqual(['uuid-a', 'uuid-b'])
  })

  it('drops the record once the duplicate is no longer on the server', async () => {
    // The field describes what this row currently absorbs. Another device
    // deleting uuid-b must not leave a dead uuid on it forever.
    seedCrossDeviceDuplicate()

    const store = useWorkoutStore()
    await store.init(USER)
    expect(store.exercises[0].mergedFrom).toEqual(['uuid-b'])

    fakeSupabase.seed('exercises', [exerciseRow('uuid-a', 'Bench Press', '2026-09-02T10:00:00.000Z')])
    await store.init(USER)

    expect(store.exercises[0].mergedFrom).toBeUndefined()
  })

  it('leaves an ordinary single-row exercise deleting exactly one row', async () => {
    fakeSupabase.seed('exercises', [
      exerciseRow('uuid-a', 'Bench Press', '2026-09-02T10:00:00.000Z'),
      exerciseRow('uuid-c', 'Squat', '2026-09-02T10:00:00.000Z'),
    ])
    fakeSupabase.seed('sets', [setRow('a-0', 'uuid-a', 10), setRow('c-0', 'uuid-c', 10)])

    const store = useWorkoutStore()
    await store.init(USER)
    store.deleteExercise('uuid-a')
    await flush()

    expect(liveExerciseIds()).toEqual(['uuid-c'])
    expect(liveSetIds()).toEqual(['c-0'])
  })
})

describe('exerciseServerIds', () => {
  it('is the exercise id alone when nothing was absorbed', () => {
    expect(exerciseServerIds({ id: 'uuid-a' })).toEqual(['uuid-a'])
    expect(exerciseServerIds({ id: 'uuid-a', mergedFrom: [] })).toEqual(['uuid-a'])
  })

  it('puts the primary first and never repeats an id', () => {
    expect(exerciseServerIds({ id: 'uuid-a', mergedFrom: ['uuid-b', 'uuid-a', 'uuid-b'] }))
      .toEqual(['uuid-a', 'uuid-b'])
  })
})

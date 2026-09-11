/**
 * Regression: a merged duplicate's configuration must survive (LIFT-1369).
 *
 * `deduplicateByName` merged exactly three things off an absorbed row — sets,
 * tags and gyms — and dropped every other `Exercise` field. The gym union was
 * added in #961 "so a cross-device duplicate's gym assignments aren't silently
 * dropped when its row is absorbed"; the same sentence was true of the seven
 * config fields `Exercise` grew afterwards, and nobody wrote it again.
 *
 * Why the suite missed it: no fixture anywhere set `notes` / `barWeight` /
 * `equipment` / `bodyweightLoaded` on a duplicate, so the fields that were
 * dropped were precisely the ones nothing carried. Writing seven more hand-rolled
 * cases would leave the eighth field exposed the same way, so these tests drive
 * their fixture off `EXERCISE_FILL_FIELDS` — a field added to the policy table is
 * exercised here whether or not anyone remembers to extend the test, and the
 * fixture's mapped type refuses to compile until it has a value.
 */
import { describe, it, expect } from 'vitest'
import {
  EXERCISE_FILL_FIELDS,
  EXERCISE_MERGE_RULES,
  mergeExerciseMetadata,
  type ExerciseFillField,
} from '../exerciseMerge'
import type { Exercise } from '../../stores/workout'

/**
 * One distinctive value per fill field. Typed as a total map, so adding a field
 * to the policy table fails `npm run typecheck` here until it is given a value —
 * the assertion below repeats that at runtime, since vitest does not typecheck.
 */
const CONFIGURED: { [K in ExerciseFillField]-?: NonNullable<Exercise[K]> } = {
  inputMode: 'plates',
  barWeight: 20,
  plateCountMode: 'total',
  intensityMaxReps: 6,
  equipment: 'machine',
  notes: 'brace before unrack',
  bodyweightLoaded: true,
}

function exercise(id: string, overrides: Partial<Exercise> = {}): Exercise {
  return { id, name: 'Bench Press', tags: [], sets: [], ...overrides }
}

describe('mergeExerciseMetadata (LIFT-1369)', () => {
  it('has a value for every fill field (fixture completeness)', () => {
    expect(Object.keys(CONFIGURED).sort()).toEqual([...EXERCISE_FILL_FIELDS].sort())
    expect(EXERCISE_FILL_FIELDS.length).toBeGreaterThan(0)
  })

  it('fills every unset config field from the absorbed duplicate', () => {
    // Device A's row won the primary comparison on set count; device B's row is
    // where the lifter actually configured the exercise. All of it used to go.
    const primary = exercise('uuid-a')
    const duplicate = exercise('uuid-b', { ...CONFIGURED })

    const filled = mergeExerciseMetadata(primary, [duplicate])

    expect(filled).toBe(EXERCISE_FILL_FIELDS.length)
    for (const field of EXERCISE_FILL_FIELDS) {
      expect(primary[field], `${field} was dropped when the duplicate was absorbed`)
        .toEqual(CONFIGURED[field])
    }
  })

  it('keeps the primary\'s own value when both rows set the same field', () => {
    // No per-field `updated_at` exists, so there is nothing to resolve a genuine
    // conflict with. Primary-wins is the existing convention; filling a GAP is
    // strictly additive and needs no policy of its own.
    const primary = exercise('uuid-a', { ...CONFIGURED })
    const duplicate = exercise('uuid-b', {
      inputMode: 'numpad',
      barWeight: 45,
      plateCountMode: 'per-side',
      intensityMaxReps: 12,
      equipment: 'free_weight',
      notes: 'a different cue',
      bodyweightLoaded: true,
    })

    expect(mergeExerciseMetadata(primary, [duplicate])).toBe(0)
    for (const field of EXERCISE_FILL_FIELDS) {
      expect(primary[field]).toEqual(CONFIGURED[field])
    }
  })

  it('takes each field from the first duplicate that has one', () => {
    const primary = exercise('uuid-a')
    const older = exercise('uuid-b', { notes: 'from the second row' })
    const newest = exercise('uuid-c', { notes: 'from the third row', barWeight: 15 })

    expect(mergeExerciseMetadata(primary, [older, newest])).toBe(2)
    expect(primary.notes).toBe('from the second row')
    expect(primary.barWeight).toBe(15)
  })

  it('leaves a field unset when no row in the group carries it', () => {
    const primary = exercise('uuid-a')

    expect(mergeExerciseMetadata(primary, [exercise('uuid-b')])).toBe(0)
    for (const field of EXERCISE_FILL_FIELDS) {
      expect(field in primary, `${field} must stay absent, not become undefined`).toBe(false)
    }
  })

  it('unions tags and gyms across the whole group', () => {
    const primary = exercise('uuid-a', { tags: ['Push'], gyms: ['Gym A'] })
    const duplicate = exercise('uuid-b', { tags: ['Push', 'Chest'], gyms: ['Gym B'] })

    mergeExerciseMetadata(primary, [duplicate])

    expect([...primary.tags].sort()).toEqual(['Chest', 'Push'])
    expect([...primary.gyms!].sort()).toEqual(['Gym A', 'Gym B'])
  })

  it('leaves gyms absent rather than empty when nothing is assigned', () => {
    // `matchesGymFilter` reads "no gyms" as "shows under every gym filter"
    // (#961), so an empty array must not become a different thing from an
    // absent one.
    const primary = exercise('uuid-a')

    mergeExerciseMetadata(primary, [exercise('uuid-b')])

    expect('gyms' in primary).toBe(false)
  })

  it('does not adopt the duplicate\'s archive state', () => {
    // Not a gap to fill: an absent `archived_at` is the surviving row's own
    // state, and filling it would hide the merged row — which holds the
    // primary's active sets — with no action by the user.
    const primary = exercise('uuid-a')
    const duplicate = exercise('uuid-b', { archived_at: '2026-08-01T00:00:00.000Z' })

    mergeExerciseMetadata(primary, [duplicate])

    expect('archived_at' in primary).toBe(false)
    expect(EXERCISE_MERGE_RULES.archived_at).toBe('primary')
  })

  it('leaves updated_at alone and never writes to the absorbed row', () => {
    // The merge is display-only (2026-04-12 SEV1). A freshened `updated_at`
    // would let this heuristic win a later last-write-wins comparison and
    // propagate to the server as though the user had made an edit.
    const primary = exercise('uuid-a', { updated_at: '2026-09-01T10:00:00.000Z' })
    const duplicate = exercise('uuid-b', { ...CONFIGURED, updated_at: '2026-09-01T11:00:00.000Z' })
    const before = structuredClone(duplicate)

    mergeExerciseMetadata(primary, [duplicate])

    expect(primary.updated_at).toBe('2026-09-01T10:00:00.000Z')
    expect(duplicate).toEqual(before)
  })
})

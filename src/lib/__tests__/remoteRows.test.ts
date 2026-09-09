/**
 * Unit tests for the remote-row → domain validators (LIFT-1135).
 *
 * `_fetchFromSupabase` used to map exercise/set/bodyweight rows field-by-field
 * with zero guarding, so a NaN weight, a null estimated_1rm, or a bogus
 * `input_mode` from a bad migration or manual DB edit flowed straight into
 * `getExercisePR` (a `Math.max` over `estimated1RM`) and the plate calculator.
 * These tests feed malformed remote rows and assert the mappers drop or repair
 * them so downstream math stays finite.
 */
import { describe, it, expect, vi } from 'vitest'
import type { Tables } from '../database.types'
import { mapRemoteSet, mapRemoteExercise, mapRemoteBodyweightEntry } from '../remoteRows'
import { epley } from '../epley'

vi.mock('../logger', () => ({
  logWarn: vi.fn(),
  logError: vi.fn(),
}))

function setRow(overrides: Partial<Tables<'sets'>> = {}): Tables<'sets'> {
  return {
    id: 'set-1',
    user_id: 'user-1',
    exercise_id: 'ex-1',
    date: '2026-08-12T23:59:00Z',
    weight: 225,
    reps: 5,
    estimated_1rm: 253,
    created_at: '2026-08-12T18:00:00Z',
    session_id: null,
    deleted_at: null,
    ...overrides,
  }
}

function exRow(overrides: Partial<Tables<'exercises'>> = {}): Tables<'exercises'> {
  return {
    id: 'ex-1',
    user_id: 'user-1',
    name: 'Bench Press',
    tags: ['Push'],
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-10T00:00:00Z',
    deleted_at: null,
    input_mode: 'plates',
    bar_weight: 45,
    plate_count_mode: 'per-side',
    plate_loaded: false,
    intensity_max_reps: 10,
    equipment: null,
    gyms: [],
    bodyweight_loaded: false,
    archived_at: null,
    notes: null,
    warmup_scheme: null,
    ...overrides,
  }
}

function bwRow(overrides: Partial<Tables<'bodyweight_entries'>> = {}): Tables<'bodyweight_entries'> {
  return {
    id: 'bw-1',
    user_id: 'user-1',
    date: '2026-08-12T23:59:00Z',
    weight: 185,
    created_at: '2026-08-12T18:00:00Z',
    deleted_at: null,
    ...overrides,
  }
}

describe('mapRemoteSet', () => {
  it('maps a well-formed row to a WorkoutSet', () => {
    const set = mapRemoteSet(setRow())
    expect(set).toEqual({
      id: 'set-1',
      date: '2026-08-12T23:59:00Z',
      weight: 225,
      reps: 5,
      estimated1RM: 253,
      createdAt: '2026-08-12T18:00:00Z',
    })
  })

  it('drops a set with a non-finite weight', () => {
    expect(mapRemoteSet(setRow({ weight: NaN }))).toBeNull()
    expect(mapRemoteSet(setRow({ weight: null as unknown as number }))).toBeNull()
    expect(mapRemoteSet(setRow({ weight: Infinity }))).toBeNull()
  })

  it('drops a set with non-finite reps', () => {
    expect(mapRemoteSet(setRow({ reps: NaN }))).toBeNull()
    expect(mapRemoteSet(setRow({ reps: null as unknown as number }))).toBeNull()
  })

  it('repairs a missing/non-finite estimated_1rm from weight×reps (Epley)', () => {
    const set = mapRemoteSet(setRow({ estimated_1rm: NaN }))
    expect(set?.estimated1RM).toBe(epley(225, 5))
    expect(Number.isFinite(set!.estimated1RM)).toBe(true)

    const nulled = mapRemoteSet(setRow({ estimated_1rm: null as unknown as number }))
    expect(nulled?.estimated1RM).toBe(epley(225, 5))
  })

  it('never leaks a NaN into estimated1RM — the value guarding Math.max stays finite', () => {
    const set = mapRemoteSet(setRow({ estimated_1rm: NaN }))
    expect(set).not.toBeNull()
    expect(Number.isNaN(set!.estimated1RM)).toBe(false)
  })
})

describe('mapRemoteExercise', () => {
  it('maps a well-formed row with all config fields', () => {
    const ex = mapRemoteExercise(exRow())
    expect(ex).toMatchObject({
      id: 'ex-1',
      name: 'Bench Press',
      tags: ['Push'],
      updated_at: '2026-08-10T00:00:00Z',
      inputMode: 'plates',
      barWeight: 45,
      plateCountMode: 'per-side',
      intensityMaxReps: 10,
      sets: [],
    })
  })

  it('rejects an unknown input_mode instead of casting it blind', () => {
    const ex = mapRemoteExercise(exRow({ input_mode: 'garbage' }))
    expect(ex.inputMode).toBeUndefined()
  })

  it('rejects a non-finite bar_weight', () => {
    expect(mapRemoteExercise(exRow({ bar_weight: NaN })).barWeight).toBeUndefined()
    // A NULL bar_weight is the schema's way of saying "no explicit bar" since
    // LIFT-1387 — it must stay ABSENT here so the caller falls through to the
    // unit-aware `defaultBarWeight`, not land as a literal 0 or a stale 45. The
    // column type carries the null now, so this needs no cast.
    expect(mapRemoteExercise(exRow({ bar_weight: null })).barWeight).toBeUndefined()
  })

  it('rejects an unknown plate_count_mode', () => {
    expect(mapRemoteExercise(exRow({ plate_count_mode: 'weird' })).plateCountMode).toBeUndefined()
  })

  it('drops non-string tags via parseStringArray', () => {
    const ex = mapRemoteExercise(exRow({ tags: ['Push', 2 as unknown as string, 'Pull'] }))
    expect(ex.tags).toEqual(['Push', 'Pull'])
  })

  it('falls back updated_at → created_at → now', () => {
    expect(mapRemoteExercise(exRow({ updated_at: null })).updated_at).toBe('2026-08-01T00:00:00Z')
    const both = mapRemoteExercise(exRow({ updated_at: null, created_at: null as unknown as string }))
    expect(typeof both.updated_at).toBe('string')
    expect(both.updated_at.length).toBeGreaterThan(0)
  })

  it('handles a null tags column', () => {
    expect(mapRemoteExercise(exRow({ tags: null as unknown as string[] })).tags).toEqual([])
  })
})

describe('mapRemoteBodyweightEntry', () => {
  it('maps a well-formed row and preserves the created_at → updated_at fallback', () => {
    const entry = mapRemoteBodyweightEntry(bwRow())
    expect(entry).toMatchObject({
      id: 'bw-1',
      date: '2026-08-12T23:59:00Z',
      weight: 185,
      updated_at: '2026-08-12T18:00:00Z',
    })
  })

  it('drops an entry with a non-finite weight', () => {
    expect(mapRemoteBodyweightEntry(bwRow({ weight: NaN }))).toBeNull()
    expect(mapRemoteBodyweightEntry(bwRow({ weight: null as unknown as number }))).toBeNull()
  })

  it('falls back to now when created_at is null so the entry does not lose the merge', () => {
    const entry = mapRemoteBodyweightEntry(bwRow({ created_at: null as unknown as string }))
    expect(typeof entry?.updated_at).toBe('string')
    expect(entry!.updated_at.length).toBeGreaterThan(0)
  })
})

/**
 * Remote-row → domain validators for the Supabase read path (LIFT-1135).
 *
 * `_fetchFromSupabase` previously mapped exercise/set/bodyweight rows to domain
 * objects field-by-field with zero guarding (`weight: s.weight`, `estimated1RM:
 * s.estimated_1rm`, `input_mode` cast straight to a union). A NaN, a null weight,
 * or a bogus `input_mode` from a faulty migration or a manual DB edit therefore
 * flowed unchecked into `getExercisePR` (a `Math.max` over `estimated1RM`) and the
 * plate calculator — silent core-data corruption. `jsonColumns.ts` already
 * validates the peripheral gamification JSON with per-field rigor; these mappers
 * extend the same posture to the CORE lift data, where integrity matters most.
 *
 * They delegate the set/bodyweight element checks to the `parseGuards` validators
 * so the localStorage and Supabase boundaries share ONE validation posture rather
 * than inventing divergent rules — the same principle that motivated LIFT-946.
 */
import type { Tables } from './database.types'
import type { Exercise, WorkoutSet } from '../stores/workout'
import type { BodyweightEntry } from '../stores/bodyweight'
import { parseWorkoutSet, parseBodyweightEntry, parseStringArray } from './parseGuards'
import { sanitizeIntensityMaxReps } from './intensityTable'
import { sanitizeExerciseEquipment } from './coachAnalytics'
import { sanitizeExerciseGyms } from './gyms'
import { sanitizeExerciseNotes } from './inputLimits'

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * Validate one remote `sets` row into a `WorkoutSet`, or `null` if the weight or
 * reps are non-finite (NaN/null from a bad migration or manual edit) — such a set
 * has no meaningful load and must never reach `Math.max(estimated1RM)`. A missing
 * or non-finite `estimated_1rm` is repaired from weight×reps (Epley) rather than
 * dropped, mirroring `parseWorkoutSet`. `bodyweight` is intentionally not read:
 * it is a local-only field that does not round-trip through Supabase (LIFT-834).
 */
export function mapRemoteSet(row: Tables<'sets'>): WorkoutSet | null {
  return parseWorkoutSet({
    id: row.id,
    date: row.date,
    weight: row.weight,
    reps: row.reps,
    estimated1RM: row.estimated_1rm,
    createdAt: row.created_at,
    // Synced (#1271) — unlike `bodyweight`, nothing else on the row carries it,
    // so a fresh device would otherwise lose the annotation entirely. The guard
    // keeps only a literal `true`, so the column's NULL default degrades to
    // "re-racked" exactly like a legacy local set.
    attemptedNextRep: row.attempted_next_rep,
  })
}

/**
 * Validate one remote `bodyweight_entries` row, or `null` if the weight is
 * non-finite. Preserves the store's existing `updated_at` fallback
 * (`created_at || now`) so last-write-wins merge timestamps are unchanged.
 */
export function mapRemoteBodyweightEntry(
  row: Tables<'bodyweight_entries'>,
): (BodyweightEntry & { updated_at: string }) | null {
  const entry = parseBodyweightEntry({ id: row.id, date: row.date, weight: row.weight })
  if (!entry) return null
  return { ...entry, updated_at: row.created_at || new Date().toISOString() }
}

/**
 * Validate one remote `exercises` row into an `Exercise` (with empty `sets`, which
 * the caller attaches after grouping). `id`/`name` are trusted as the DB's NOT
 * NULL primary key and identity — dropping an exercise would orphan its sets — but
 * every optional/config field is guarded through the same helpers the store
 * setters use: `input_mode` is checked against the allowed union instead of being
 * cast blind, and numeric fields are finite-checked so a NaN never becomes a
 * `barWeight`. `updated_at` keeps the `updated_at || created_at || now` fallback
 * the merge relies on.
 */
export function mapRemoteExercise(row: Tables<'exercises'>): Exercise & { updated_at: string } {
  const exercise: Exercise & { updated_at: string } = {
    id: row.id,
    name: row.name,
    tags: parseStringArray(row.tags),
    updated_at: row.updated_at || row.created_at || new Date().toISOString(),
    sets: [],
  }
  if (row.input_mode === 'numpad' || row.input_mode === 'plates') {
    exercise.inputMode = row.input_mode
  }
  // A null `bar_weight` means "no explicit bar" and must stay ABSENT here, so
  // the caller falls through to the unit-aware `defaultBarWeight` (LIFT-1211).
  // The column carried a `NOT NULL DEFAULT 45` until LIFT-1387, so this branch
  // was taken for every synced row and a kg user's untouched exercise adopted a
  // 45 kg (99 lb) bar it had never been given.
  if (isFiniteNumber(row.bar_weight)) exercise.barWeight = row.bar_weight
  if (row.plate_count_mode === 'per-side' || row.plate_count_mode === 'total') {
    exercise.plateCountMode = row.plate_count_mode
  }
  if (row.intensity_max_reps != null) {
    exercise.intensityMaxReps = sanitizeIntensityMaxReps(row.intensity_max_reps)
  }
  if (row.equipment != null) {
    const eq = sanitizeExerciseEquipment(row.equipment)
    if (eq) exercise.equipment = eq
  }
  if (row.gyms && row.gyms.length > 0) {
    const gyms = sanitizeExerciseGyms(row.gyms)
    if (gyms.length > 0) exercise.gyms = gyms
  }
  if (row.bodyweight_loaded) exercise.bodyweightLoaded = true
  if (row.archived_at) exercise.archived_at = row.archived_at
  const notes = sanitizeExerciseNotes(row.notes)
  if (notes) exercise.notes = notes
  return exercise
}

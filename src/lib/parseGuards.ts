/**
 * Element-level parse guards for untrusted persisted JSON (LIFT-946).
 *
 * `loadJSON`/`loadStoreData` only guard the top-level shape (a value parsed and,
 * at most, `Array.isArray`/`isPlainObject`-checked). That still lets a single
 * corrupt element — a set missing `weight`, a recovery-days map holding strings,
 * a tag array with a stray number — flow unchecked into 1RM math, charts, and
 * sync payloads. `jsonColumns.ts` already demonstrates the rigorous per-field
 * pattern for the identical shapes arriving from Supabase; these guards apply the
 * same rigor to the localStorage/IndexedDB boundary so both sources share one
 * validation posture.
 *
 * Each guard drops (and `logWarn`s) malformed elements rather than throwing, so
 * corrupt storage degrades to the valid subset instead of taking down a store's
 * construction. They are pure and side-effect-free apart from the warning log.
 */
import type { Exercise, WorkoutSet, ExerciseInputMode, PlateCountMode } from '../stores/workout'
import type { BodyweightEntry } from '../stores/bodyweight'
import { epley } from './epley'
import { sanitizeIntensityMaxReps } from './intensityTable'
import { sanitizeExerciseEquipment } from './coachAnalytics'
import { sanitizeExerciseGyms } from './gyms'
import { sanitizeExerciseNotes } from './inputLimits'
import { logWarn } from './logger'

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * Validate a plate-counting mode from any untrusted boundary (localStorage or
 * Supabase). Returns the enum value or `undefined` so callers leave the field
 * unset and fall back to the 'per-side' default rather than trusting a stray
 * string (LIFT-1039).
 */
export function sanitizePlateCountMode(value: unknown): PlateCountMode | undefined {
  return value === 'per-side' || value === 'total' ? value : undefined
}

/** Keep only the string elements of an array; drop anything else. */
export function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const result: string[] = []
  for (const item of value) {
    if (typeof item === 'string') result.push(item)
    else logWarn('Dropping non-string array element during hydration', { item })
  }
  return result
}

/** Keep only entries whose value is a finite number (e.g. tag→recovery-days). */
export function parseNumberRecord(value: unknown): Record<string, number> {
  if (!isPlainObject(value)) return {}
  const result: Record<string, number> = {}
  for (const [key, v] of Object.entries(value)) {
    if (isFiniteNumber(v)) result[key] = v
    else logWarn('Dropping non-numeric record entry during hydration', { key, value: v })
  }
  return result
}

/**
 * Validate one persisted set. Requires id/date strings and finite weight/reps;
 * a missing or malformed `estimated1RM` is repaired from weight×reps via Epley
 * (legacy/CSV data predates the stored field) rather than dropping the set.
 */
export function parseWorkoutSet(value: unknown): WorkoutSet | null {
  if (!isPlainObject(value)) return null
  const o = value
  if (typeof o.id !== 'string' || typeof o.date !== 'string') return null
  if (!isFiniteNumber(o.weight) || !isFiniteNumber(o.reps)) return null
  const set: WorkoutSet = {
    id: o.id,
    date: o.date,
    weight: o.weight,
    reps: o.reps,
    estimated1RM: isFiniteNumber(o.estimated1RM) ? o.estimated1RM : epley(o.weight, o.reps),
  }
  if (typeof o.createdAt === 'string') set.createdAt = o.createdAt
  // Bodyweight folded into the effective load for a bodyweight-loaded exercise
  // (LIFT-834); a non-positive/non-finite value is dropped so the fold degrades
  // to the added weight rather than skewing e1RM.
  if (isFiniteNumber(o.bodyweight) && o.bodyweight > 0) set.bodyweight = o.bodyweight
  // Optional RPE (#617). Same 6–10 half-step window the log UI and CSV import
  // accept — an out-of-range or off-step value is dropped rather than kept, so
  // hydration can't reintroduce a value the UI could never have produced.
  if (isFiniteNumber(o.rpe) && o.rpe >= 6 && o.rpe <= 10 && o.rpe * 2 === Math.round(o.rpe * 2)) {
    set.rpe = o.rpe
  }
  // "Went for one more rep and missed it" (#1271). Only a literal `true` is
  // kept: absent already means re-racked, so a stray `false`/`'true'`/`1` is
  // dropped rather than normalized, keeping the persisted shape to the one
  // form `logSet` writes.
  if (o.attemptedNextRep === true) set.attemptedNextRep = true
  return set
}

/**
 * Validate one persisted exercise. Requires id/name strings; normalizes tags to
 * a string[] and sets to validated `WorkoutSet`s (malformed sets are dropped).
 * Optional per-exercise config is validated/sanitized through the same helpers
 * the store setters use, so hydration and mutation share one boundary.
 */
export function parseExercise(value: unknown): Exercise | null {
  if (!isPlainObject(value)) return null
  const o = value
  if (typeof o.id !== 'string' || typeof o.name !== 'string') return null

  const sets: WorkoutSet[] = []
  if (Array.isArray(o.sets)) {
    for (const raw of o.sets) {
      const set = parseWorkoutSet(raw)
      if (set) sets.push(set)
      else logWarn('Dropping malformed set during exercise hydration', { exerciseId: o.id, raw })
    }
  }

  const ex: Exercise = {
    id: o.id,
    name: o.name,
    tags: parseStringArray(o.tags),
    sets,
  }
  if (o.inputMode === 'numpad' || o.inputMode === 'plates') ex.inputMode = o.inputMode as ExerciseInputMode
  if (isFiniteNumber(o.barWeight)) ex.barWeight = o.barWeight
  const plateCountMode = sanitizePlateCountMode(o.plateCountMode)
  if (plateCountMode) ex.plateCountMode = plateCountMode
  if (o.intensityMaxReps !== undefined) ex.intensityMaxReps = sanitizeIntensityMaxReps(o.intensityMaxReps)
  if (o.equipment !== undefined) {
    const eq = sanitizeExerciseEquipment(o.equipment)
    if (eq) ex.equipment = eq
  }
  // Gym membership (#961). An empty result is left unset rather than stored as
  // [], because `matchesGymFilter` treats "no gyms" as "shows under every gym
  // filter" — an exercise must never become invisible because its membership
  // failed to sanitize.
  if (o.gyms !== undefined) {
    const gyms = sanitizeExerciseGyms(o.gyms)
    if (gyms.length > 0) ex.gyms = gyms
  }
  const notes = sanitizeExerciseNotes(o.notes)
  if (notes) ex.notes = notes
  if (o.bodyweightLoaded === true) ex.bodyweightLoaded = true
  // Absorbed same-named duplicate ids (LIFT-1335). Hydrated because a delete
  // must reach those rows even on a cold start that has not fetched yet — the
  // field is otherwise only ever written by `deduplicateByName` during a fetch.
  // A self-reference is dropped so the list stays strictly "other rows".
  if (o.mergedFrom !== undefined) {
    const mergedFrom = parseStringArray(o.mergedFrom).filter(id => id !== ex.id)
    if (mergedFrom.length > 0) ex.mergedFrom = [...new Set(mergedFrom)]
  }
  if (typeof o.updated_at === 'string') ex.updated_at = o.updated_at
  if (typeof o.archived_at === 'string') ex.archived_at = o.archived_at
  if (o.sample === true) ex.sample = true
  return ex
}

/** Validate a persisted exercise array, dropping malformed entries. */
export function parseExercises(value: unknown): Exercise[] {
  if (!Array.isArray(value)) return []
  const result: Exercise[] = []
  for (const raw of value) {
    const ex = parseExercise(raw)
    if (ex) result.push(ex)
    else logWarn('Dropping malformed exercise during hydration', { raw })
  }
  return result
}

/** Validate one persisted bodyweight entry. Requires id/date strings + finite weight. */
export function parseBodyweightEntry(value: unknown): BodyweightEntry | null {
  if (!isPlainObject(value)) return null
  const o = value
  if (typeof o.id !== 'string' || typeof o.date !== 'string') return null
  if (!isFiniteNumber(o.weight)) return null
  const entry: BodyweightEntry = { id: o.id, date: o.date, weight: o.weight }
  if (typeof o.updated_at === 'string') entry.updated_at = o.updated_at
  if (o.sample === true) entry.sample = true
  return entry
}

/** Validate a persisted bodyweight-entry array, dropping malformed entries. */
export function parseBodyweightEntries(value: unknown): BodyweightEntry[] {
  if (!Array.isArray(value)) return []
  const result: BodyweightEntry[] = []
  for (const raw of value) {
    const entry = parseBodyweightEntry(raw)
    if (entry) result.push(entry)
    else logWarn('Dropping malformed bodyweight entry during hydration', { raw })
  }
  return result
}

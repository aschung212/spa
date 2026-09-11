/**
 * Bodyweight-loaded exercise load model (LIFT-834).
 *
 * Calisthenic-loaded lifts — pull-ups, dips, weighted chins — move the lifter's
 * whole bodyweight plus any added plate/belt weight. The bare `weight` field on a
 * set only captures the *added* portion, so without folding bodyweight in:
 *   - pure-bodyweight reps (added = 0) score zero volume and a zero e1RM, and
 *   - "+25 lb" undercounts the true ~185 lb load a 160 lb lifter actually moved.
 *
 * When an exercise is flagged `bodyweightLoaded`, the bodyweight in effect at log
 * time is captured onto the set (`set.bodyweight`) so history stays stable as the
 * lifter's weight drifts. This module is the single reconciliation point between
 * the two weight spaces the app moves between:
 *
 *   ADDED     — what `set.weight` holds and the log sheet's weight field means.
 *   EFFECTIVE — added + bodyweight; what `set.estimated1RM`, volume, and every
 *               PR comparison are measured in.
 *
 * `bodyweightFold` is the offset between them and the only place the flag is
 * consulted; `effectiveSetWeight` adds it and `addedWeightFromEffective`
 * subtracts it, so the fold and its inverse sit adjacent and cannot disagree.
 *
 * The inverse exists because reading an e1RM back OUT is a third boundary
 * (#1328): LIFT-834 folded at write time (`logSet`) and at volume-read time
 * (`sessionSummary`), but the log sheet inverts a stored e1RM to answer "what
 * should I load next?" — and that answer belongs in the weight field, i.e. in
 * ADDED space. Without the inverse it suggested the effective total as an added
 * weight, which folds a second time on save (~2x) and stores a fake PR.
 *
 * A set with no captured bodyweight folds in nothing (degrades to the added
 * weight) rather than guessing, and for every non-bodyweight-loaded exercise the
 * fold is 0 and both directions are the identity.
 *
 * The flag also decides the log sheet's weight FLOOR (`isLoggableWeight`,
 * LIFT-1330): "added nothing" is the ordinary pull-up, so 0 is a value here and
 * nowhere else. That lived as a hand-rolled `weight > 0` in every gate until it
 * turned out to block the exact set this module was written for.
 */
import type { Exercise, WorkoutSet } from '../stores/workout'

/**
 * The bodyweight (lbs) folded into a bodyweight-loaded exercise's load — the
 * offset between ADDED and EFFECTIVE weight. 0 for a normal exercise, and 0
 * when no usable bodyweight is available (nothing captured on the set, or the
 * lifter has never tracked their weight) so the fold degrades to the added
 * weight rather than guessing.
 */
export function bodyweightFold(
  exercise?: Pick<Exercise, 'bodyweightLoaded'> | null,
  bodyweight?: number | null,
): number {
  if (!exercise?.bodyweightLoaded) return 0
  if (typeof bodyweight !== 'number' || !Number.isFinite(bodyweight) || bodyweight <= 0) return 0
  return bodyweight
}

/**
 * Whether an added weight of exactly 0 is a real value for this exercise
 * (LIFT-1330) — true for a bodyweight-loaded lift, where the field means ADDED
 * weight and adding nothing is the ordinary case (a plain pull-up), false for
 * every other exercise, where a 0 lb barbell set says nothing.
 *
 * Keyed on the FLAG, not on whether a bodyweight is actually on record. The flag
 * is the lifter's statement about what the field means; gating entry on a
 * separate piece of state ("have you ever weighed in?") would disable Save with
 * nothing on screen explaining why. A missing bodyweight already degrades the
 * fold to 0 for every *added* weight (see `bodyweightFold`) — the zero case is
 * not a special one, and the surfaces that need a positive load to say anything
 * (the 1RM estimate, the to-beat card) hide themselves on the folded total
 * rather than on this floor.
 */
export function allowsZeroWeight(exercise?: Pick<Exercise, 'bodyweightLoaded'> | null): boolean {
  return exercise?.bodyweightLoaded === true
}

/**
 * Is `weight` a value this exercise can log? The single owner of the log
 * sheet's weight floor, shared by every gate that used to hand-roll
 * `weight > 0` — the entry gate, the live estimate, the to-beat cards and the
 * XP preview all have to agree, or Save enables on a value the surfaces above
 * it refuse to describe.
 *
 * Unit-agnostic: this is a floor test, so it holds in display units (the log
 * sheet's field) and in canonical lbs alike. Upper bounds stay at the call site
 * — `MAX_WEIGHT` is an input-limit concern, not a load-model one.
 */
export function isLoggableWeight(
  weight: number | null | undefined,
  exercise?: Pick<Exercise, 'bodyweightLoaded'> | null,
): boolean {
  if (typeof weight !== 'number' || !Number.isFinite(weight)) return false
  return allowsZeroWeight(exercise) ? weight >= 0 : weight > 0
}

/**
 * How a set's load reads back in ADDED-space words (LIFT-1373).
 *
 * Every history surface used to render `set.weight` bare — so a pure-bodyweight
 * set (added = 0, the ordinary pull-up LIFT-1330 finally made typeable) read
 * "0 lbs × 12" beside an e1RM computed off the folded load. One row said the
 * lifter moved nothing and, two spans later, that they estimate a 224 lb max.
 * Rendering the added portion bare re-asserts the thing the flag exists to
 * deny, on the one row where the added portion is zero and the load is entirely
 * the lifter: a reader cannot tell "no plates" from "no data".
 *
 * Keyed on the fold ACTUALLY APPLIED, not on the flag alone. A set logged
 * before the flag was turned on (or by a lifter who has never weighed in) folds
 * in nothing — its stored e1RM is off the bare weight — so it must keep reading
 * "0 lbs" rather than claiming a bodyweight it never recorded. The label
 * therefore always describes exactly what the neighbouring e1RM was computed
 * from.
 *
 * This is one formatter rather than a phrase per call site because the visible
 * text and the `aria-label` are separate strings at every one of them, and the
 * two drift (LIFT-1349 nearly split `WorkoutTimeline`'s pair). Callers append
 * their own "× N" / "× N reps" suffix — that part already differs by surface.
 */
export interface SetLoadFormat {
  /** lbs → the number shown in the user's unit (`useWeightUnit().displayWeight`). */
  displayWeight: (lbs: number) => number
  /** The display unit's label — `'lbs'` or `'kg'`. */
  unit: string
}

export interface SetLoadParts {
  /** The load itself — `'135'`, `'+25'`, or the whole word `'Bodyweight'`. */
  value: string
  /** The unit to follow it with, or null when the value is already a phrase. */
  unit: string | null
}

/**
 * {@link formatSetLoad} split into its parts, for the one surface that styles
 * the unit separately from the number (the PR card's smaller, dimmer `lbs`).
 * Both shapes come from this single decision so a card and a row can never
 * disagree about whether a set was bodyweight-only.
 */
export function setLoadParts(
  set: Pick<WorkoutSet, 'weight'> & { bodyweight?: number },
  exercise: Pick<Exercise, 'bodyweightLoaded'> | null | undefined,
  { displayWeight, unit }: SetLoadFormat,
): SetLoadParts {
  const fold = bodyweightFold(exercise, set.bodyweight)
  // No fold applied: the stored weight IS the whole load, so say it plainly.
  if (fold <= 0) return { value: String(displayWeight(set.weight)), unit }
  // Added nothing — the load is the lifter. Matches the log sheet's own
  // "Bodyweight × N" to-beat card, so the suggestion and the row it becomes
  // are worded the same.
  if (set.weight === 0) return { value: 'Bodyweight', unit: null }
  // A "+" marks the number as the added portion rather than the load.
  return { value: `${set.weight > 0 ? '+' : ''}${displayWeight(set.weight)}`, unit }
}

export function formatSetLoad(
  set: Pick<WorkoutSet, 'weight'> & { bodyweight?: number },
  exercise: Pick<Exercise, 'bodyweightLoaded'> | null | undefined,
  format: SetLoadFormat,
): string {
  const { value, unit } = setLoadParts(set, exercise, format)
  return unit ? `${value} ${unit}` : value
}

/** The load (in lbs) used for volume + e1RM math on a set. ADDED → EFFECTIVE. */
export function effectiveSetWeight(
  set: Pick<WorkoutSet, 'weight'> & { bodyweight?: number },
  exercise?: Pick<Exercise, 'bodyweightLoaded'> | null,
): number {
  return set.weight + bodyweightFold(exercise, set.bodyweight)
}

/**
 * Inverse of {@link effectiveSetWeight}: the ADDED weight that produces
 * `effectiveLbs` on this exercise — what the log sheet's weight field wants
 * when a suggestion is derived from a stored (effective) e1RM.
 *
 * Can legitimately return zero or a negative number: a lifter whose bodyweight
 * alone already exceeds the target needs no added weight at all. Callers decide
 * how to present that (there is no such thing as a negative plate) rather than
 * having it clamped here, so "you already beat this" stays distinguishable from
 * "load nothing extra".
 */
export function addedWeightFromEffective(
  effectiveLbs: number,
  exercise?: Pick<Exercise, 'bodyweightLoaded'> | null,
  bodyweight?: number | null,
): number {
  return effectiveLbs - bodyweightFold(exercise, bodyweight)
}

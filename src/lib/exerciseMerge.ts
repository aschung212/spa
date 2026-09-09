/**
 * What happens to each `Exercise` field when two same-named rows merge (LIFT-1369).
 *
 * `deduplicateByName` collapses the cross-device case: two devices each created
 * their own "Bench Press", so the account holds two rows with different UUIDs and
 * the same name. The row with the most sets becomes the primary, the others are
 * absorbed, and the result is committed to `exercises.value` and `_persist()`ed.
 *
 * The absorbed row's *configuration* used to be dropped wholesale. Only `sets`,
 * `tags` and `gyms` were merged — `gyms` explicitly, in #961, "so a cross-device
 * duplicate's gym assignments aren't silently dropped when its row is absorbed."
 * That reasoning applies verbatim to the other seven fields `Exercise` has grown
 * since, and was never extended to them. So a lifter who set a 20 kg bar, wrote a
 * cue and turned on bodyweight-loading on their phone watched all three vanish
 * the moment the other device's row won the primary comparison — and they did not
 * come back, because the merge re-runs against the same server rows on every
 * fetch and reaches the same answer.
 *
 * `bodyweightLoaded` was the sharpest of the seven, because dropping it does not
 * merely lose a setting: the absorbed row's sets arrive carrying a captured
 * `set.bodyweight` and a FOLDED `estimated1RM`, and under a merged row with no
 * flag `effectiveSetWeight` folds in nothing. A pure-bodyweight pull-up then
 * reports zero volume beside a 200 lb e1RM — the LIFT-1373 contradiction, reached
 * by a sync instead of by an import. `barWeight` is next: a missing bar makes
 * `weightToPlates` return `null` or decompose against the wrong base, so the
 * plate calculator degrades or lies (the LIFT-1211 failure, reached by a merge
 * rather than a unit toggle).
 *
 * ## The policy
 *
 * **Primary wins; a duplicate fills the gaps.** Strictly better than dropping,
 * and it invents no conflict-resolution rule for the case where both rows set the
 * same field differently — there, primary-wins is already the convention, and
 * `Exercise` has no per-field `updated_at` to do better with.
 *
 * ## Two things this must not become
 *
 * 1. **No write.** The merge is display-only (2026-04-12 SEV1: pushing
 *    dedup-derived mutations to the server destroyed user data). Nothing here
 *    touches the absorbed row, and `updated_at` is deliberately NOT bumped — a
 *    freshened timestamp would let the merged copy win a later last-write-wins
 *    comparison and propagate a heuristic as though the user had made an edit.
 * 2. **No hand-maintained list.** The failure mode here is an OMISSION: adding a
 *    field to `Exercise` is a one-line edit and nothing about it prompts the
 *    author to think about a merge in another file. So the policy is a total map
 *    over `keyof Exercise` — `satisfies Record<keyof Exercise, …>` fails the
 *    typecheck until a new field is classified, and the fill loop is derived from
 *    that map rather than written out a second time. This is the same drift class
 *    as LIFT-1039's `REPLAYABLE_COLUMNS` and #1357's `LOCAL_ONLY_SET_FIELDS`,
 *    both of which shipped broken while a hardcoded list looked complete.
 */
import type { Exercise } from '../stores/workout'

/**
 * How a field is resolved when same-named rows merge.
 *
 * - `primary`  — the surviving row's value stands; the duplicate's is discarded.
 * - `union`    — values from every row in the group are combined.
 * - `fill`     — primary wins, and a duplicate supplies the value only where the
 *                primary has none.
 * - `derived`  — resolved by its own rule in `deduplicateByName`, not by a
 *                per-field copy.
 */
export type ExerciseMergeRule = 'primary' | 'union' | 'fill' | 'derived'

/**
 * Every `Exercise` field and what the merge does with it. Total over
 * `keyof Exercise` by construction — a new field breaks the build here until
 * someone decides, which is the entire point of the table.
 */
export const EXERCISE_MERGE_RULES = {
  // Identity of the surviving row. `name` is the grouping key, so every row in
  // the group already agrees on it up to case.
  id: 'primary',
  name: 'primary',

  // Unioned. `sets` is merged by id inside `deduplicateByName` (LIFT-1332) —
  // it needs the id index and the chronological re-sort that follow it — while
  // tags and gyms are unioned by `mergeExerciseMetadata` below.
  sets: 'union',
  tags: 'union',
  gyms: 'union',

  // Per-exercise configuration: primary wins, duplicate fills a gap. All of
  // these are absent-when-unset (never `''`/`[]`/`false` — see `parseExercise`
  // and `mapRemoteExercise`), so `undefined` is an unambiguous "no value".
  inputMode: 'fill',
  barWeight: 'fill',
  plateCountMode: 'fill',
  intensityMaxReps: 'fill',
  equipment: 'fill',
  notes: 'fill',
  bodyweightLoaded: 'fill',

  // Merge bookkeeping. `updated_at` drives the last-write-wins comparison that
  // ran BEFORE this point; adopting a duplicate's timestamp would misreport when
  // the surviving row last changed and could flip a later merge.
  updated_at: 'primary',
  // Deliberately primary-only, not `fill`. An absent `archived_at` is not a gap
  // to be filled — it is the surviving row's state. Filling it would hide the
  // merged row (holding the primary's active sets) behind an archive decision
  // the user made about a row that no longer exists, with no action of theirs.
  archived_at: 'primary',
  // Resolved by its own rule: a sample row that absorbs a real one is adopted
  // (flag cleared) so it starts syncing, rather than either value being copied.
  sample: 'derived',
} as const satisfies Record<keyof Exercise, ExerciseMergeRule>

type MergeRuleMap = typeof EXERCISE_MERGE_RULES

/** The `Exercise` fields carrying a given merge rule, as a key union. */
type FieldsRuled<R extends ExerciseMergeRule> = {
  [K in keyof MergeRuleMap]: MergeRuleMap[K] extends R ? K : never
}[keyof MergeRuleMap]

export type ExerciseFillField = FieldsRuled<'fill'>

/**
 * The fill set, derived from the table above so the loop and the policy cannot
 * disagree. Exported for the regression test, which drives its fixture off this
 * list — a field added to the table is then exercised without anyone
 * remembering to extend the test.
 */
export const EXERCISE_FILL_FIELDS = (
  Object.keys(EXERCISE_MERGE_RULES) as (keyof MergeRuleMap)[]
).filter((field): field is ExerciseFillField => EXERCISE_MERGE_RULES[field] === 'fill')

/** Generic so `Exercise[K]` lines up on both sides of the assignment. */
function fillField<K extends ExerciseFillField>(primary: Exercise, value: Exercise[K], field: K): void {
  primary[field] = value
}

/**
 * Merge the absorbed rows' metadata into the primary, in place.
 *
 * Covers every field except `sets` (unioned by id in `deduplicateByName`, which
 * owns the set-identity rules) and `sample` (adopted there too). Returns the
 * number of fields filled from a duplicate, so a test can prove the pass did
 * something rather than passing vacuously.
 */
export function mergeExerciseMetadata(primary: Exercise, duplicates: readonly Exercise[]): number {
  // Tags and gyms union across the whole group. Gym membership is left unset
  // when the union is empty rather than stored as `[]`, because `matchesGymFilter`
  // reads "no gyms" as "shows under every gym filter" (#961) and an empty array
  // must not become a different thing from an absent one.
  const tags = new Set(primary.tags)
  const gyms = new Set(primary.gyms ?? [])
  for (const duplicate of duplicates) {
    for (const tag of duplicate.tags) tags.add(tag)
    for (const gym of duplicate.gyms ?? []) gyms.add(gym)
  }
  primary.tags = [...tags]
  if (gyms.size > 0) primary.gyms = [...gyms]

  let filled = 0
  for (const field of EXERCISE_FILL_FIELDS) {
    if (primary[field] !== undefined) continue
    for (const duplicate of duplicates) {
      const value = duplicate[field]
      if (value === undefined) continue
      fillField(primary, value, field)
      filled++
      break
    }
  }
  return filled
}

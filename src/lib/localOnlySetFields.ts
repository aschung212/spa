/**
 * Local-only per-set fields, and their survival across a sync merge (#1357).
 *
 * `_fetchFromSupabase` resolves exercises by last-write-wins (`mergeEntities`),
 * which picks ONE exercise object wholesale — sets and all. The set union that
 * runs after it only adds sets the winner is *missing*, so when the REMOTE row
 * wins (another device renamed or re-tagged the exercise, or a replayed journal
 * entry bumped `updated_at`), every set present on both sides is replaced by the
 * server's copy of itself.
 *
 * That is lossless for every column the `sets` table actually has, and silent
 * data loss for the two `WorkoutSet` fields it does not. `rpe` (#617) and
 * `bodyweight` (LIFT-834) live on the device only — `_enqueueSetUpsert` never
 * sends them and `mapRemoteSet` cannot read them back — so the adopted remote
 * copy carries `undefined` where the user's annotation was. A rename on a second
 * phone therefore erased every RPE the lifter had typed, and dropped the
 * bodyweight captured onto a calisthenic set, collapsing `effectiveSetWeight`
 * back to the added weight alone: a pull-up day's volume and e1RM history
 * quietly rewritten by a sync that changed nothing about those sets.
 *
 * Capture and restore live here, adjacent, for the same reason `bodyweightFold`
 * and `addedWeightFromEffective` do — they are inverses over one field list, and
 * a second copy of that list is a second thing to forget.
 *
 * The list itself is NOT hand-maintained against memory: an invariant in
 * `architecturalInvariants.test.ts` derives every `WorkoutSet` field from the
 * store source and every field `mapRemoteSet` reads back, and fails unless the
 * difference is exactly `LOCAL_ONLY_SET_FIELDS`. So a new per-set field either
 * round-trips through Supabase or is preserved here — it cannot be neither,
 * which is the state `rpe` and `bodyweight` shipped in.
 */
import type { Exercise, WorkoutSet } from '../stores/workout'

/**
 * `WorkoutSet` fields with no `sets` column behind them. They are persisted to
 * localStorage (and the IDB mirror) like everything else, so they survive a
 * reload — only the remote round-trip cannot carry them.
 */
export const LOCAL_ONLY_SET_FIELDS = ['rpe', 'bodyweight'] as const

export type LocalOnlySetField = (typeof LOCAL_ONLY_SET_FIELDS)[number]

/** The local-only slice of one set: what a remote copy of it cannot carry. */
export type LocalOnlySetFields = Pick<WorkoutSet, LocalOnlySetField>

/**
 * Index the local-only fields of every set currently in local state, keyed by set
 * id. Sets carrying none are omitted, so the common account indexes nothing and
 * the restore pass short-circuits.
 *
 * Call this BEFORE the merge replaces `exercises.value`; set ids are stable
 * uuids, so the index stays valid however the merge reshuffles them between
 * exercises.
 */
export function captureLocalOnlySetFields(
  exercises: readonly Exercise[],
): Map<string, LocalOnlySetFields> {
  const captured = new Map<string, LocalOnlySetFields>()
  for (const exercise of exercises) {
    for (const set of exercise.sets) {
      let fields: LocalOnlySetFields | undefined
      for (const field of LOCAL_ONLY_SET_FIELDS) {
        const value = set[field]
        if (value === undefined) continue
        fields ??= {}
        fields[field] = value
      }
      if (fields) captured.set(set.id, fields)
    }
  }
  return captured
}

/**
 * Re-attach captured local-only fields to the merged sets, in place.
 *
 * A field is filled only where the merged set has none. Today that is every
 * adopted remote copy and nothing else (a local-winning set is the very object
 * that was captured), but writing it as a fallback rather than an overwrite is
 * what keeps this correct on the day one of these fields gains a column: remote
 * would then carry a real value, including a deliberate clear, and remote-wins
 * has to keep meaning remote-wins.
 *
 * Returns the number of fields restored — the count a caller can assert on to
 * prove the pass did something rather than passing vacuously.
 */
export function restoreLocalOnlySetFields(
  exercises: readonly Exercise[],
  captured: ReadonlyMap<string, LocalOnlySetFields>,
): number {
  if (captured.size === 0) return 0
  let restored = 0
  for (const exercise of exercises) {
    for (const set of exercise.sets) {
      const fields = captured.get(set.id)
      if (!fields) continue
      for (const field of LOCAL_ONLY_SET_FIELDS) {
        const value = fields[field]
        if (value === undefined || set[field] !== undefined) continue
        set[field] = value
        restored++
      }
    }
  }
  return restored
}

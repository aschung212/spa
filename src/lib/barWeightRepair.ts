/**
 * One-time repair of the bar weight the `bar_weight` column default invented
 * (LIFT-1398 — the client half of LIFT-1387).
 *
 * `Exercise.barWeight` lives in the user's DISPLAY unit (LIFT-1211), but
 * `bar_weight real NOT NULL DEFAULT 45` did not know that, so Postgres filled
 * every gap with a number that means a different physical thing in the two
 * units. Every exercise a kg user synced without touching the bar setting came
 * back holding an explicit 45 — a 45 kg bar, 99 lb — and `defaultBarWeight('kg')`
 * became unreachable for those rows.
 *
 * `20260909000000_make_bar_weight_nullable.sql` drops the default and clears the
 * rows it already materialized, deliberately WITHOUT bumping `updated_at`: a
 * bump hands the server the win in the next last-write-wins merge, reverting any
 * unflushed offline edit on those rows. It then reasoned that the cleared value
 * would reach local state on its own, "because the remote row wins the next
 * merge anyway". It does not, on any device that already fetched the row:
 *
 *   1. That device adopted the server row verbatim — the 45 AND the server's
 *      `updated_at` (`mapRemoteExercise` copies it as-is).
 *   2. An unbumped backfill leaves that `updated_at` untouched, so local and
 *      remote TIE on the next fetch.
 *   3. `mergeEntities` gives ties to LOCAL (`localTime >= remoteTime`), and
 *      `_fetchFromSupabase` re-upserts every `localWins` exercise.
 *   4. `_buildExerciseUpsert` always sends `bar_weight: barWeight ?? null`, and
 *      the local value is still an explicit 45.
 *
 * So the server-side backfill only ever stuck for rows no device held yet, and
 * the repair has to happen where the stale value actually lives: locally.
 *
 * ### Why clearing a 45 is lossless, in both units
 *
 * The same argument the migration makes, one layer up. A stored 45 is genuinely
 * ambiguous — it is both the column default and a legitimate explicit lbs bar —
 * but the two readings resolve to the same number:
 *
 *   * 45 IS `defaultBarWeight('lbs')`, so an lbs user falls straight back to the
 *     value they already had. Clearing it is a no-op for them.
 *   * `convertBarWeight(45, 'lbs', 'kg')` snaps to 20, which IS
 *     `defaultBarWeight('kg')` — so a later unit toggle lands on the same value
 *     whether the bar was stored or defaulted, and `convertBarWeightsForUnitChange`
 *     gets back the "no explicit bar → skip" branch the materialized default had
 *     voided for every synced row.
 *
 * The one case it cannot preserve is a kg user who deliberately typed 45 kg — a
 * 99 lb bar, which no real equipment is, and which the edit sheet does not even
 * suggest (its field seeds from `defaultBarWeight(unit)`, i.e. 20). That is the
 * same trade the migration already accepted, and it is why this pass stays safe
 * to re-run: for an lbs device it changes nothing at all, and for a kg device the
 * only value it can touch is the corruption it exists to remove.
 *
 * Re-running matters because "one-shot" is per DEVICE, not per launch. A guest
 * (LIFT-1083) never calls `initStores`, so `_userId` stays null, no fetch ever
 * completes, and the flag below never burns — the `load()` pass therefore runs on
 * every launch for them. That is deliberate rather than a leak: a guest has no
 * server and so cannot hold a materialized 45 at all, and the day they sign in,
 * the pass is still armed for the rows they are about to adopt.
 *
 * ### Why `updated_at` is deliberately NOT bumped
 *
 * Same reason the migration suppressed the trigger, and the same rule
 * `mergeExerciseMetadata` follows (LIFT-1369): a repair the user did not perform
 * must never win a later last-write-wins merge as though they had — that is the
 * 2026-04-12 SEV1 shape. It does not need to. Leaving the timestamp alone keeps
 * local and remote tied, and a tie is a `localWins`, which re-upserts the row —
 * so the cleared value propagates to the server as `bar_weight: null` through the
 * very code path that used to push the 45 back.
 */

import type { Exercise } from '../stores/workout'
import { defaultBarWeight } from './plateCalculator'

/**
 * Marks the repair as consumed on this device. Set only once the pass has run
 * against a SUCCESSFUL remote fetch (see `_fetchFromSupabase`), never merely at
 * the localStorage boundary: a device that is offline, signed out, or mid-reinstall
 * has not yet seen the server's copy of these rows, and burning the flag there
 * would leave a freshly-adopted 45 behind forever.
 */
export const BAR_WEIGHT_REPAIR_KEY = 'bar-weight-default-repaired'

/**
 * The value the dropped column default materialized. Read from
 * `defaultBarWeight` rather than written as a literal, per the LIFT-1211 rule
 * that no bar weight is ever hardcoded — it is precisely BECAUSE this number is
 * the lbs default that clearing it is lossless.
 */
const MATERIALIZED_BAR_WEIGHT = defaultBarWeight('lbs')

/** Whether this device has already consumed the repair. */
export function isBarWeightRepairDone(): boolean {
  try {
    return localStorage.getItem(BAR_WEIGHT_REPAIR_KEY) === 'true'
  } catch {
    // A blocked/full localStorage must not take the store down; re-running the
    // pass is harmless (see the losslessness note above).
    return false
  }
}

/** Record that the repair has run against a fetched copy of the server's rows. */
export function markBarWeightRepairDone(): void {
  try {
    localStorage.setItem(BAR_WEIGHT_REPAIR_KEY, 'true')
  } catch {
    // Non-fatal: the pass simply runs again next launch.
  }
}

/**
 * Drop every materialized bar weight, in place, and return how many were cleared.
 *
 * Mutates rather than copying because the workout store holds `exercises` in a
 * `shallowRef` and mutates entries in place everywhere else (the array identity
 * is load-bearing for `triggerRef`). `updated_at` is left untouched — see above.
 */
export function repairMaterializedBarWeights(exercises: Exercise[]): number {
  let repaired = 0
  for (const exercise of exercises) {
    if (exercise.barWeight !== MATERIALIZED_BAR_WEIGHT) continue
    delete exercise.barWeight
    repaired++
  }
  return repaired
}

import { defineStore } from 'pinia'
import { shallowRef, triggerRef, computed } from 'vue'
import { supabase, isPreviewMode } from '../lib/supabase'
import type { Tables, TablesUpdate } from '../lib/database.types'
import { syncQueue, type SyncTable, type SyncDescriptor } from '../lib/syncQueue'
import { mergeEntities } from '../lib/conflictResolver'
import { uuid, endOfDayISO } from '../lib/uuid'
import { logError, logWarn } from '../lib/logger'
import { reportFetchError } from '../lib/fetchErrorClassifier'
import { addTombstone, removeTombstone, isTombstoned, cleanupTombstones } from '../lib/tombstones'
import { epley } from '../lib/epley'
import { todayISO, setDayKey } from '../lib/dates'
import { loadJSON, isPlainObject } from '../lib/storage'
import { persistStoreData, loadStoreData } from '../lib/storePersistence'
import { parseExercises, parseStringArray, parseNumberRecord } from '../lib/parseGuards'
import { sanitizeIntensityMaxReps } from '../lib/intensityTable'
import { convertBarWeight } from '../lib/plateCalculator'
import {
  isBarWeightRepairDone,
  markBarWeightRepairDone,
  repairMaterializedBarWeights,
} from '../lib/barWeightRepair'
import { sanitizeExerciseNotes } from '../lib/inputLimits'
import { sanitizeExerciseEquipment, type ExerciseEquipment } from '../lib/coachAnalytics'
import { sanitizeExerciseGyms } from '../lib/gyms'
import { mapRemoteExercise, mapRemoteSet } from '../lib/remoteRows'
import { captureLocalOnlySetFields, restoreLocalOnlySetFields } from '../lib/localOnlySetFields'
import { mergeExerciseMetadata } from '../lib/exerciseMerge'
import { fetchAllRows } from '../lib/supabasePagination'
import { bodyweightFold, effectiveSetWeight } from '../lib/bodyweightLoad'
import { attemptedNextRep, pickTopSet } from '../lib/setEffort'
import { useBodyweightStore } from './bodyweight'
import { isAuthError, ensureFreshSession } from '../lib/sessionHealth'
import { classifySyncError, type SyncErrorKind } from '../lib/syncStatus'

const TOMBSTONE_STORE = 'exercises'

const STORAGE_KEY = 'workout-exercises'

export interface WorkoutSet {
  id: string
  date: string
  weight: number
  reps: number
  estimated1RM: number
  /** Rate of Perceived Exertion (6–10, half-step). Optional, local-only. */
  rpe?: number
  /**
   * Real timestamp the set was logged (ISO 8601), distinct from `date` (which is
   * stamped end-of-day and carries no time of day). Stamped by `logSet` and
   * round-tripped through the `sets.created_at` column (#846); absent only on
   * legacy sets logged before that landed, which is why every consumer must treat
   * it as optional. Drives time-of-day + within-workout exercise ordering in the
   * AI Coach payload (docs/ai-coach.md) and the session-duration span on the
   * workout summary and share cards (`sessionSummary.sessionInstant`, #1288).
   */
  createdAt?: string
  /**
   * Bodyweight (lbs) folded into this set's effective load for a
   * bodyweight-loaded exercise (LIFT-834). Captured at log time so history stays
   * stable as the lifter's weight drifts; absent for normal exercises. Persisted
   * locally only — the stored `estimated1RM` already carries the fold, so it does
   * not round-trip through Supabase (see `effectiveSetWeight`).
   */
  bodyweight?: number
  /**
   * The lifter went for one more rep past `reps` and missed it (#1271) — an
   * "8 + failed 9th" rather than a clean 8 re-racked with reps in reserve.
   * Absent === re-racked; legacy sets are never backfilled. Ranks above an
   * otherwise-identical set (`src/lib/setEffort.ts`) and steers the overload
   * suggestion toward landing the rep instead of adding weight. Deliberately
   * NOT folded into `estimated1RM` — see the module header for why.
   */
  attemptedNextRep?: boolean
}

export type ExerciseInputMode = 'numpad' | 'plates'

export type PlateCountMode = 'per-side' | 'total'

export interface Exercise {
  id: string
  name: string
  tags: string[]
  sets: WorkoutSet[]
  inputMode?: ExerciseInputMode    // remembered per exercise, default 'numpad'
  barWeight?: number               // bar weight in the USER'S DISPLAY UNIT (kg users store kg — the create/edit
                                   // UI labels and saves it in display units; see LIFT-1211). Default 45 lbs / 20 kg.
  plateCountMode?: PlateCountMode  // how plates are counted, default 'per-side'
  intensityMaxReps?: number        // rep rows shown in the Intensity lens; undefined = default (10) (#770)
  equipment?: ExerciseEquipment    // explicit Coach classification; undefined = name heuristic (#931 phase C)
  gyms?: string[]                  // gym membership; empty/undefined = shows under every gym filter (#961)
  notes?: string                   // durable free-form cue ("brace before unrack"); empty/undefined = no note (#619)
  bodyweightLoaded?: boolean       // fold the lifter's bodyweight into load for volume + e1RM (LIFT-834)
  updated_at?: string              // ISO 8601, used for last-write-wins merge
  archived_at?: string             // ISO 8601, soft-hide from main list; data is preserved
  sample?: boolean                 // true for onboarding sample data — never synced to Supabase
  /**
   * Server ids of the same-named duplicate rows `deduplicateByName` absorbed
   * into this one (LIFT-1335). LOCAL-ONLY — it is not a column, is never sent in
   * `_buildExerciseUpsert`, and is recomputed from the server rows on every
   * fetch. It exists because the merge is display-only: the duplicates keep
   * their own rows (and their own `exercise_id` on their sets) server-side, so
   * one local row can stand for several remote ones, and every id-taking write
   * path — delete, restore — has to address all of them. See
   * `exerciseServerIds`.
   */
  mergedFrom?: string[]
}

/**
 * Every server row a local exercise row stands for (LIFT-1335): its own id plus
 * the ids of the same-named duplicates absorbed into it by `deduplicateByName`.
 *
 * Deleting a merged exercise used to soft-delete only the primary's row, so the
 * absorbed duplicate came straight back on the next fetch carrying its sets and
 * had to be deleted a second time. This is the single translation point from
 * "the row the user is looking at" to "the rows on the server", so a new
 * id-taking write path gets the full set by calling it rather than by
 * remembering that `exercise.id` is sometimes an undercount.
 *
 * It is emphatically NOT a name-based lookup: re-deriving duplicates by name at
 * delete time would be exactly the dedup-derived server mutation the 2026-04-12
 * SEV1 banned. These ids were observed on the server, in one fetch, as rows
 * sharing this row's name — and they are only ever acted on when the user asks
 * for this row to be deleted or restored.
 */
export function exerciseServerIds(exercise: Pick<Exercise, 'id' | 'mergedFrom'>): string[] {
  if (!exercise.mergedFrom?.length) return [exercise.id]
  return [...new Set([exercise.id, ...exercise.mergedFrom])]
}

export interface OverloadSuggestion {
  type: 'increase_weight' | 'increase_reps'
  weight: number
  reps: number
  reason: string
  /**
   * 'high' only when the data strongly supports going heavier (consistent
   * top sets or rep progression past 8). UI surfaces nudge only on 'high' —
   * the increase_reps fallbacks fire on almost any data and would spam.
   */
  confidence: 'high' | 'low'
}

export interface UsualLadderRung {
  weightLbs: number
  reps: number
  /** 'consensus' = established across recent sessions; 'recent' = tail carried verbatim from the last session (e.g. a drifting top set). */
  source: 'consensus' | 'recent'
}

export interface UsualLadder {
  rungs: UsualLadderRung[]
  consensusCount: number
  sessionsSampled: number
}

/**
 * Deduplicate sets within an exercise by exact content (full date + weight + reps).
 * Uses the full ISO timestamp so jitter-differentiated sets are preserved —
 * this protects programs like 5x5 where the same weight/reps is logged
 * multiple times. Only catches exact timestamp collisions (e.g., old fixed
 * T23:59:59.000Z format or truly identical entries).
 */
export function deduplicateSets(sets: WorkoutSet[]): { unique: WorkoutSet[]; removedIds: string[] } {
  const seen = new Map<string, string>()
  const unique: WorkoutSet[] = []
  const removedIds: string[] = []
  for (const set of sets) {
    const key = `${set.date}|${set.weight}|${set.reps}`
    if (!seen.has(key)) {
      seen.set(key, set.id)
      unique.push(set)
    } else {
      removedIds.push(set.id)
    }
  }
  return { unique, removedIds }
}

/**
 * Deduplicate exercises by name (case-insensitive).
 * For each group of exercises with the same name, keeps the one with
 * the most sets as primary and merges all other sets into it.
 *
 * Every non-set field is resolved by `EXERCISE_MERGE_RULES` (LIFT-1369) — see
 * `src/lib/exerciseMerge.ts` for the policy and why it is a total map over
 * `keyof Exercise` rather than a hand-written list.
 *
 * The primary records the absorbed rows' ids in `mergedFrom` (LIFT-1335) so a
 * later delete can reach the rows this one now stands for. That list is
 * REPLACED, not accumulated: it is only ever populated from the exercises in
 * this call, which for the one production caller (`_fetchFromSupabase`) is the
 * union of local state and the rows the server currently holds. A duplicate
 * that is no longer in that union is no longer live, so dropping it keeps the
 * field an accurate description of what this row currently absorbs rather than
 * an ever-growing pile of dead uuids. The re-merge is idempotent, so a duplicate
 * that disappears from one fetch and returns in a later one is re-recorded.
 */
export function deduplicateByName(exercises: Exercise[]): { exercises: Exercise[]; removed: Exercise[] } {
  const groups = new Map<string, Exercise[]>()
  for (const ex of exercises) {
    const key = ex.name.toLowerCase()
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(ex)
  }

  const result: Exercise[] = []
  const removed: Exercise[] = []

  for (const group of groups.values()) {
    if (group.length === 1) {
      delete group[0].mergedFrom
      result.push(group[0])
      continue
    }
    // Pick the one with the most sets as primary
    group.sort((a, b) => b.sets.length - a.sets.length)
    const primary = group[0]
    // Merge sets from the duplicates by ID only (LIFT-1332). A day-level
    // content key (`day|weight|reps`) used to gate this as well, on the theory
    // that a duplicate row's sets are always re-inserted copies of the
    // primary's. But that key lived in a `Set`, which is count-blind: it
    // admitted at most ONE set per (day, weight, reps) tuple, so straight-set
    // programming collided with itself by construction and a whole 5x5 merged
    // in as a single set. Differing exercise UUIDs mean the rows were created
    // INDEPENDENTLY — that is this function's entire premise — so their sets
    // are additional, not artifacts. Genuinely re-inserted copies (a migration
    // re-run mints fresh set UUIDs but copies `date` verbatim) collide on the
    // FULL timestamp instead, and `deduplicateSets` — which runs over the
    // merged list immediately after and is deliberately count-PRESERVING for
    // jitter-differentiated same-day sets — is what catches those.
    const setIds = new Set(primary.sets.map(s => s.id))
    for (let i = 1; i < group.length; i++) {
      for (const set of group[i].sets) {
        if (!setIds.has(set.id)) {
          primary.sets.push(set)
          setIds.add(set.id)
        }
      }
      removed.push(group[i])
    }
    // If a sample exercise absorbs a real one, adopt it (clear sample flag)
    if (primary.sample && group.some(ex => !ex.sample)) {
      delete primary.sample
    }
    // Re-sort merged sets by day. Use only the date portion (YYYY-MM-DD)
    // because endOfDayISO adds random seconds/ms jitter — sorting by full
    // timestamp would randomly shuffle same-day sets. JS sort is stable,
    // so same-day sets preserve their array insertion order (= logged order).
    primary.sets.sort((a, b) => a.date.slice(0, 10).localeCompare(b.date.slice(0, 10)))
    // Merge every remaining field per `EXERCISE_MERGE_RULES` (LIFT-1369): tags
    // and gyms union, and the seven per-exercise config fields fill a gap on the
    // primary from the first duplicate that has one. Only tags and gyms were
    // ever merged, so an absorbed row's note, bar weight, equipment and
    // bodyweight-loaded flag were dropped on every fetch — including the flag
    // its OWN incoming sets need, without which their folded e1RM contradicts
    // the volume they report. Display-only: nothing is written back to the
    // absorbed row and `updated_at` is not bumped (2026-04-12 SEV1).
    mergeExerciseMetadata(primary, group.slice(1))
    // Record which server rows this one now stands for, so a later delete or
    // restore reaches all of them and not just the primary's (LIFT-1335). The
    // merge is display-only — each absorbed duplicate keeps its own `exercises`
    // row, and its sets keep their own `exercise_id` — so `primary.id` alone is
    // an undercount of the rows the user is looking at, and this is the only
    // place those ids are ever in scope.
    const absorbed = group.slice(1).map(ex => ex.id).filter(id => id !== primary.id)
    if (absorbed.length > 0) primary.mergedFrom = absorbed
    else delete primary.mergedFrom
    result.push(primary)
  }

  return { exercises: result, removed }
}

function load(): Exercise[] {
  // Element-level validation at the localStorage boundary (LIFT-946): a single
  // corrupt exercise or set (missing weight/reps, wrong-typed fields) must not
  // flow into 1RM math, charts, or sync payloads. parseExercises drops malformed
  // entries (logWarn), normalizes tags/sets, and sanitizes the Intensity-lens
  // config, equipment classification, and gym membership (#961) through the same
  // helpers the setters use.
  const parsed = parseExercises(loadStoreData<unknown[]>('workout', STORAGE_KEY, () => [], Array.isArray))
  // Clear the bar weight the dropped `bar_weight NOT NULL DEFAULT 45` invented
  // (LIFT-1398). The server-side backfill cannot reach a device that already
  // holds the row: it left `updated_at` alone on purpose, so local and remote
  // tie, ties go to local, and the tie is re-upserted — writing the 45 straight
  // back over the cleared column. This is a transform of the parsed payload, not
  // a side effect, so it costs the state factory nothing; the flag is burned
  // only once a fetch has repaired the server's copy too (see `_fetchFromSupabase`).
  if (!isBarWeightRepairDone()) repairMaterializedBarWeights(parsed)
  return parsed
}

export const useWorkoutStore = defineStore('workout', () => {
  // ── State ──────────────────────────────────────────────────────────
  // shallowRef: Vue only tracks .value identity, not nested properties.
  // This avoids wrapping thousands of set objects in Proxy (5,000+ for heavy users).
  // Trade-off: every mutation must call triggerRef(exercises) to notify watchers.
  const exercises = shallowRef<Exercise[]>(load())
  // Secondary state MUST hydrate through loadJSON (guarded parse + shape
  // validation), never a raw JSON.parse. A corrupt key (truncated write,
  // quota eviction mid-write, manual tampering) would otherwise throw in this
  // setup-function body and the store would fail to construct at all — taking
  // down the whole workout feature instead of degrading to defaults (#822).
  // Element-level validation (LIFT-946): loadJSON only checks the top-level
  // shape, so a corrupt array holding a stray number or a recovery map holding
  // string values would still hydrate. The parse guards drop those elements.
  const customTags = shallowRef<string[]>(parseStringArray(loadJSON('lift-custom-tags', [], Array.isArray)))
  const tagRecoveryDays = shallowRef<Record<string, number>>(parseNumberRecord(loadJSON('lift-tag-recovery-days', {}, isPlainObject)))
  const tagRecoveryExcluded = shallowRef<string[]>(parseStringArray(loadJSON('lift-tag-recovery-excluded', [], Array.isArray)))
  let _userId: string | null = null

  // ── Sync status (LIFT-820) ─────────────────────────────────────────
  // Uniform, observable contract so the UI can surface "syncing" / "sync
  // failed" instead of silently degrading to local-only. `lastSyncError` is
  // typed so an expired session can be told apart from being offline.
  const syncing = shallowRef(false)
  const lastSyncError = shallowRef<SyncErrorKind | null>(null)

  // ── Persistence ────────────────────────────────────────────────────
  function _persist() {
    // Secondary tag keys are workout-specific and not mirrored to the IndexedDB
    // backup, so they're written here; the primary exercises payload goes
    // through the shared helper (localStorage + IDB backup + cross-tab broadcast).
    try {
      localStorage.setItem('lift-custom-tags', JSON.stringify(customTags.value))
      localStorage.setItem('lift-tag-recovery-days', JSON.stringify(tagRecoveryDays.value))
      localStorage.setItem('lift-tag-recovery-excluded', JSON.stringify(tagRecoveryExcluded.value))
    } catch (e) {
      logError(e, { source: 'workout._persist:tags' })
    }
    persistStoreData('workout', STORAGE_KEY, JSON.stringify(exercises.value))
  }

  /** Re-read state from localStorage (called by cross-tab sync listener). */
  function _reloadFromStorage() {
    exercises.value = load()
    _invalidateDayCounts()
    // On corrupt storage, keep the current in-memory value rather than resetting.
    customTags.value = parseStringArray(loadJSON('lift-custom-tags', customTags.value, Array.isArray))
    tagRecoveryDays.value = parseNumberRecord(loadJSON('lift-tag-recovery-days', tagRecoveryDays.value, isPlainObject))
    tagRecoveryExcluded.value = parseStringArray(loadJSON('lift-tag-recovery-excluded', tagRecoveryExcluded.value, Array.isArray))
    triggerRef(exercises)
    triggerRef(customTags)
    triggerRef(tagRecoveryDays)
    triggerRef(tagRecoveryExcluded)
  }

  // ── Sets-per-day index (LIFT-1237) ─────────────────────────────────
  // `setsLoggedOn` backs the always-visible "Finish workout" affordance and the
  // app-icon badge. Both re-read it on every `triggerRef(exercises)` — i.e. once
  // per logged set — and both used to answer it by rescanning every set of every
  // exercise, so a multi-year account paid an O(total sets) linear scan just to
  // learn that today's count went from 4 to 5. The index makes that read O(1)
  // plus the O(exercises) checksum below.
  //
  // Deliberately NOT a ref: reads take their reactive dependency on `exercises`
  // itself (every mutation already triggers it), so the cache can be built or
  // repaired from inside a computed without the self-invalidating write that
  // reassigning a tracked ref during evaluation would cause.
  //
  // Correctness does not depend on remembering to hook every future set-mutating
  // action. Reads first compare a checksum — the summed `sets.length` of every
  // exercise, O(exercises), a few dozen iterations rather than tens of thousands
  // — against the total the index was built from. Any add/remove path that
  // bypasses `_adjustDayCount` changes that total and forces exactly one rebuild,
  // degrading a would-be silent miscount into a one-off rescan. The checksum
  // cannot see a set whose DATE moved with no change in count, so `updateSet`
  // (the only action that re-dates a set) maintains the index explicitly, and the
  // three wholesale replacements of `exercises` invalidate outright.
  let _dayCounts: Map<string, number> | null = null
  let _dayCountsTotal = -1

  function _totalSetCount(list: Exercise[]): number {
    let total = 0
    for (const e of list) total += e.sets.length
    return total
  }

  /** Force a full rebuild on the next read — for wholesale replacements of `exercises`. */
  function _invalidateDayCounts() {
    _dayCounts = null
  }

  /** Apply a single set's arrival (+1) or departure (-1) to the index. */
  function _adjustDayCount(iso: string, delta: number) {
    // Null means "never built" or "invalidated"; the next read rebuilds from
    // scratch, so there is nothing to keep in step here.
    if (!_dayCounts) return
    const key = setDayKey(iso)
    const next = (_dayCounts.get(key) ?? 0) + delta
    if (next > 0) _dayCounts.set(key, next)
    else _dayCounts.delete(key)
    _dayCountsTotal += delta
  }

  /**
   * How many sets are logged on a local calendar day (`YYYY-MM-DD`).
   *
   * Bucketed with `setDayKey`, so it is correct for both stored date
   * conventions (#746) — do not reimplement the count against `slice(0, 10)`
   * or `toLocalDateKey` at a call site.
   */
  function setsLoggedOn(dayKey: string): number {
    const list = exercises.value
    const total = _totalSetCount(list)
    if (!_dayCounts || total !== _dayCountsTotal) {
      const counts = new Map<string, number>()
      for (const e of list) {
        for (const s of e.sets) {
          const key = setDayKey(s.date)
          counts.set(key, (counts.get(key) ?? 0) + 1)
        }
      }
      _dayCounts = counts
      _dayCountsTotal = total
    }
    return _dayCounts.get(dayKey) ?? 0
  }

  // ── Internal helpers ─────────────────────────────────────────────
  /**
   * Current bodyweight (lbs) to fold into a bodyweight-loaded set's load
   * (LIFT-834). Reads the latest tracked entry; returns undefined when there is
   * no usable value so `effectiveSetWeight` folds in nothing rather than guessing
   * a zero. Guarded because it depends on the bodyweight store being resolvable.
   */
  function _currentBodyweight(): number | undefined {
    try {
      const bw = useBodyweightStore().latestWeight
      return typeof bw === 'number' && Number.isFinite(bw) && bw > 0 ? bw : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Build a comprehensive upsert payload for an exercise row.
   *
   * Always include every mutable column the client owns — including
   * `archived_at` — so that the sync queue's dedup-by-key behavior cannot
   * accidentally drop archival state. (The queue collapses repeated
   * `exercise:${id}` enqueues into the last one; a partial payload from a
   * later rename would otherwise silently clear archived_at on the server.)
   */
  function _buildExerciseUpsert(exercise: Exercise, userId: string) {
    return {
      id: exercise.id,
      user_id: userId,
      name: exercise.name,
      tags: exercise.tags,
      archived_at: exercise.archived_at ?? null,
      ...(exercise.inputMode ? { input_mode: exercise.inputMode } : {}),
      // Always send bar_weight — null means "no explicit bar", which is a real
      // state the plate math depends on (it falls through to the unit-aware
      // `defaultBarWeight`). Omitting it used to let the column's own
      // `NOT NULL DEFAULT 45` fill the gap on insert, so a kg user's untouched
      // exercise came back holding a 45 **kg** bar and the fallback became
      // unreachable (LIFT-1387). Requires the nullable column from
      // 20260909000000_make_bar_weight_nullable.sql.
      bar_weight: exercise.barWeight ?? null,
      // Always send plate_count_mode (null = client default 'per-side') so a
      // switch back to the default propagates instead of leaving a stale value
      // that re-applies on the next fetch (LIFT-783).
      plate_count_mode: exercise.plateCountMode ?? null,
      // Always send intensity_max_reps (null when unset) so "reset to default"
      // actually clears the override server-side — omitting it would leave a
      // stale value that re-applies on the next fetch.
      intensity_max_reps: exercise.intensityMaxReps ?? null,
      // Same always-send rule: "Auto" clears the Coach equipment classification.
      equipment: exercise.equipment ?? null,
      // Same always-send rule: clearing gym membership must propagate (#961).
      gyms: exercise.gyms ?? [],
      // Same always-send rule: emptying the note must clear the column, not
      // leave a stale value that re-applies on the next fetch (#619).
      notes: exercise.notes ?? null,
      // Same always-send rule: turning bodyweight-loading off must propagate (LIFT-834).
      bodyweight_loaded: exercise.bodyweightLoaded ?? false,
    }
  }

  /** Clear sample flag and push exercise + all its sets to Supabase. */
  function _adoptExercise(exercise: Exercise) {
    delete exercise.sample
    if (supabase && !isPreviewMode.value && _userId) {
      const userId = _userId
      _enqueueExerciseUpsert(exercise, userId)
      for (const set of exercise.sets) {
        _enqueueSetUpsert(set, exercise.id, userId)
      }
    }
  }

  /**
   * Durable exercise upsert. Builds the row once and journals a serializable
   * descriptor alongside the closure so the write survives a reload (LIFT-706).
   */
  function _enqueueExerciseUpsert(exercise: Exercise, userId: string) {
    const row = _buildExerciseUpsert(exercise, userId)
    syncQueue.enqueue(
      `exercise:${exercise.id}`,
      () => supabase!.from('exercises').upsert(row),
      { op: 'upsert', table: 'exercises', row },
    )
  }

  /** Durable set upsert with a journaled descriptor (LIFT-706). */
  function _enqueueSetUpsert(
    set: {
      id: string; date: string; weight: number; reps: number; estimated1RM: number
      createdAt?: string; attemptedNextRep?: boolean
    },
    exerciseId: string,
    userId: string,
  ) {
    const row = {
      id: set.id, user_id: userId, exercise_id: exerciseId,
      date: set.date, weight: set.weight, reps: set.reps,
      estimated_1rm: set.estimated1RM,
      // ALWAYS sent (like `bodyweight_loaded` on exercises) so un-toggling the
      // flag propagates instead of leaving a stale `true` on the server (#1271).
      attempted_next_rep: set.attemptedNextRep ?? false,
      // Persist the real log-time timestamp so an offline set logged at 6pm but
      // synced hours later keeps its training time instead of the DB insert-time
      // default (#846). Omitted when absent so editing a legacy set (no local
      // createdAt) leaves the server's created_at untouched on upsert.
      ...(set.createdAt ? { created_at: set.createdAt } : {}),
    }
    syncQueue.enqueue(
      `set:${set.id}`,
      () => supabase!.from('sets').upsert(row),
      { op: 'upsert', table: 'sets', row },
    )
  }

  /**
   * Durable soft-delete (UPDATE { deleted_at }). Routed through enqueueDelete
   * so the circuit breaker sees it, with a journaled descriptor (LIFT-706).
   */
  /**
   * Build a typed `update` SyncDescriptor for a table only known as a runtime
   * `sets | exercises` union (LIFT-948). TypeScript can't distribute a
   * non-literal `table` across the `SyncDescriptor` union, so the single
   * unavoidable widening cast is isolated here — the signature still bounds
   * `table` to a real `SyncTable` and `values` to that table's generated
   * `Update` shape rather than an untyped record. Kept local (not exported from
   * syncQueue) so the many `syncQueue` test mocks don't each need to re-stub it.
   */
  function _buildUpdateDescriptor<T extends SyncTable>(
    table: T,
    values: TablesUpdate<T>,
    match: Record<string, string>,
  ): SyncDescriptor {
    return { op: 'update', table, values, match } as SyncDescriptor
  }

  function _enqueueSoftDelete(key: string, table: 'sets' | 'exercises', match: Record<string, string>) {
    const deletedAt = new Date().toISOString()
    const values = { deleted_at: deletedAt }
    syncQueue.enqueueDelete(
      key,
      () => {
        let q = supabase!.from(table).update(values)
        for (const [col, val] of Object.entries(match)) q = q.eq(col, val)
        return q
      },
      _buildUpdateDescriptor(table, values, match),
    )
  }

  /** Durable soft-delete restore (UPDATE { deleted_at: null }) (LIFT-706). */
  function _enqueueRestore(key: string, table: 'sets' | 'exercises', match: Record<string, string>) {
    const values = { deleted_at: null }
    syncQueue.enqueue(
      key,
      () => {
        let q = supabase!.from(table).update(values)
        for (const [col, val] of Object.entries(match)) q = q.eq(col, val)
        return q
      },
      _buildUpdateDescriptor(table, values, match),
    )
  }

  // ── Actions ────────────────────────────────────────────────────────
  async function init(userId: string) {
    _userId = userId
    await _fetchFromSupabase()
  }

  async function _fetchFromSupabase() {
    if (!supabase || !_userId) return
    // Pin the narrowed client and user id: both bindings are mutable, so TS
    // re-widens them inside the per-page query factories below.
    const client = supabase
    const userId = _userId

    syncing.value = true
    let remoteExData: Tables<'exercises'>[] | null
    let sets: Tables<'sets'>[] | null
    try {
      // Both collections MUST be paged (#1152). PostgREST caps a response at
      // max_rows (1000) and signals the truncation nowhere, so an unpaged
      // `.select()` under this ASCENDING sort silently returns only the OLDEST
      // 1000 rows: a user past the cap hydrates a truncated history on a fresh
      // device and the app reports that their training simply stopped.
      //
      // `.order('id')` is a tiebreaker, not decoration — `created_at` defaults
      // to now(), so a CSV import writes many rows with an identical timestamp
      // and a non-total sort lets the database order ties differently between
      // two page requests, repeating some rows and skipping others.
      const [exResult, setsResult] = await Promise.all([
        fetchAllRows(() =>
          client.from('exercises').select('*').eq('user_id', userId)
            .is('deleted_at', null).order('created_at').order('id')),
        fetchAllRows(() =>
          client.from('sets').select('*').eq('user_id', userId)
            .is('deleted_at', null).order('created_at').order('id')),
      ])
      if (exResult.error || setsResult.error) {
        reportFetchError('workout', exResult.error ?? setsResult.error, {
          exerciseError: String(exResult.error),
          setsError: String(setsResult.error),
        })
        lastSyncError.value = classifySyncError(exResult.error ?? setsResult.error)
        // A 401 here means the token expired rather than the user being offline.
        // Refresh once so the next fetch recovers instead of staying local-only
        // until a manual reload (LIFT-784).
        if (isAuthError(exResult.error) || isAuthError(setsResult.error)) void ensureFreshSession()
        return
      }
      remoteExData = exResult.data
      sets = setsResult.data
    } catch (err) {
      reportFetchError('workout', err)
      lastSyncError.value = classifySyncError(err)
      // Same auth branch as the resolved-error path above. postgrest-js usually
      // RESOLVES `{ error }` (LIFT-1321), but a token problem raised inside the
      // client — or by anything else in this try — arrives here instead, and
      // `isAuthError` normalizes both shapes precisely so neither is special.
      if (isAuthError(err)) void ensureFreshSession()
      return
    } finally {
      syncing.value = false
    }

    if (!remoteExData || !sets) return
    lastSyncError.value = null

    // Filter out tombstoned exercises (deleted offline, not yet synced)
    const remoteIds = new Set(remoteExData.map(ex => ex.id))
    cleanupTombstones(TOMBSTONE_STORE, remoteIds)
    const filteredExercises = remoteExData.filter(
      ex => !isTombstoned(TOMBSTONE_STORE, ex.id)
    )

    // Map + validate remote rows at the boundary (LIFT-1135): every column is
    // guarded through mapRemoteExercise/mapRemoteSet rather than trusted inline,
    // so a NaN weight or a bogus input_mode from a bad migration can't reach the
    // PR getters or the plate calculator.
    const remoteExercises = filteredExercises.map(mapRemoteExercise)

    // Build remote sets grouped by exercise, filtering tombstoned sets
    const remoteSetIds = new Set(sets.map(s => s.id))
    cleanupTombstones('sets', remoteSetIds)
    const remoteSetsMap = new Map<string, WorkoutSet[]>()
    for (const s of sets) {
      if (isTombstoned('sets', s.id)) {
        // Re-enqueue the soft-delete for tombstoned sets still visible on remote
        _enqueueSoftDelete(`set:${s.id}`, 'sets', { id: s.id, user_id: _userId })
        continue
      }
      // Validate weight/reps at the boundary and repair a missing e1RM from
      // Epley (LIFT-1135); a set with a non-finite weight/reps is dropped rather
      // than poisoning Math.max(estimated1RM). createdAt (the server insert
      // timestamp) is preserved for the AI Coach payload (#846).
      const set = mapRemoteSet(s)
      if (!set) {
        logWarn('Dropping malformed remote set during fetch', { id: s.id })
        continue
      }
      const exerciseId = s.exercise_id
      if (!remoteSetsMap.has(exerciseId)) remoteSetsMap.set(exerciseId, [])
      remoteSetsMap.get(exerciseId)!.push(set)
    }
    remoteExercises.forEach(ex => {
      ex.sets = remoteSetsMap.get(ex.id) || []
    })

    // Index the per-set fields the server has no column for, BEFORE the merge
    // can hand a set's slot to the remote copy of itself (#1357). Keyed by set
    // id, so it survives however the merge and the two dedup passes below
    // reshuffle sets between exercises.
    const localOnlySetFields = captureLocalOnlySetFields(exercises.value)

    // Merge with local state using last-write-wins conflict resolution
    // (#1 fix: local exercises now carry updated_at from mutations)
    const localWithTimestamps = exercises.value.map(ex => ({
      ...ex,
      updated_at: ex.updated_at || new Date(0).toISOString()
    }))

    type ExerciseWithTimestamp = Exercise & { updated_at: string }
    const { merged, localOnly, localWins } = mergeEntities<ExerciseWithTimestamp>(localWithTimestamps, remoteExercises as ExerciseWithTimestamp[])

    // Merge sets by ID for exercises that exist in both local and remote.
    // mergeEntities picks one exercise wholesale (last-write-wins), but
    // the losing side may have sets the winning side doesn't. Union them
    // by set ID so no sets are lost during sync.
    const localExMap = new Map(localWithTimestamps.map(e => [e.id, e]))
    const remoteExMap = new Map(remoteExercises.map(e => [e.id, e]))
    for (const ex of merged) {
      const localEx = localExMap.get(ex.id)
      const remoteEx = remoteExMap.get(ex.id)
      if (localEx && remoteEx) {
        const setIds = new Set(ex.sets.map(s => s.id))
        const otherSets = (ex === localEx || ex.updated_at === localEx.updated_at) ? remoteEx.sets : localEx.sets
        let setsMerged = false
        for (const set of otherSets) {
          if (!setIds.has(set.id) && !isTombstoned('sets', set.id)) {
            ex.sets.push(set)
            setIds.add(set.id)
            setsMerged = true
          }
        }
        if (setsMerged) {
          ex.sets.sort((a, b) => a.date.slice(0, 10).localeCompare(b.date.slice(0, 10)))
        }
      }
    }

    // Deduplicate exercises by name (case-insensitive) for LOCAL display only.
    // Two devices can create exercises with the same name but different UUIDs;
    // this merges them into a single row in the local state so the UI doesn't
    // show duplicates. We intentionally do NOT push deletes or reassignments
    // to Supabase here — the client has no authority to mutate server data
    // based on dedup heuristics. Server-side cleanup should be done via a
    // controlled one-time SQL migration, not ambient client behavior.
    // See incident 2026-04-12 (SEV1): pushing client-dedup deletes to the
    // server destroyed user data when (date|weight|reps) collided across
    // same-named exercises. The fix is to keep dedup strictly local.
    const deduped = deduplicateByName(merged as Exercise[])

    // Deduplicate sets within each exercise for LOCAL display only.
    // Legacy pre-jitter timestamps (T12:00:00 noon-local, T23:59:59 fixed)
    // cause identical (date|weight|reps) tuples for straight-set programs
    // like 5x5. We collapse those for local rendering but do NOT push
    // deletes — the server is the source of truth. See incident 2026-04-12.
    for (const ex of deduped.exercises) {
      const { unique } = deduplicateSets(ex.sets)
      ex.sets = unique
    }

    // Re-attach RPE and captured bodyweight to any set that arrived from the
    // server (#1357). Runs after BOTH dedup passes so it covers every set about
    // to be committed, not just the ones the last-write-wins union touched —
    // the alternative, patching the union loop alone, would leave the same hole
    // open for any future path that adopts a remote set.
    restoreLocalOnlySetFields(deduped.exercises, localOnlySetFields)

    // Clear the bar weight the `bar_weight NOT NULL DEFAULT 45` column default
    // invented, on the server's copy of these rows as well as the local one
    // (LIFT-1398). `load()` already ran this pass over whatever localStorage
    // held, but that alone leaves two holes only the fetch can close: a device
    // that hydrates the row for the FIRST time (a new sign-in, or the PWA
    // reinstall of #1152) adopts the server's 45 long after the local pass ran,
    // and `mergeExerciseMetadata`'s `fill` rule can put an absorbed duplicate's
    // 45 back onto the survivor. Placed here, after both dedup passes, for the
    // same reason `restoreLocalOnlySetFields` is: it then covers every exercise
    // about to be committed rather than one path's worth.
    //
    // Nothing is pushed from here, and `updated_at` is deliberately untouched:
    // the row now ties its remote twin, a tie is a `localWins`, and the
    // `filteredLocalWins` loop below re-upserts it with `bar_weight: null` —
    // the same code path that used to push the 45 back.
    //
    // The flag is burned HERE and nowhere else. Setting it in `load()` would
    // consume the repair on a device that has never seen the server's copy of
    // these rows (signed out, offline, mid-reinstall), leaving a 45 it adopts
    // later in place forever. Every early return above — no client, no user, a
    // failed query — leaves it unset, so the pass simply retries next launch.
    //
    // One residual, bounded by the migration this depends on: a device that has
    // already burned the flag and then signs into a DIFFERENT account (the flag
    // is per-device, and sign-out does not clear localStorage) would adopt that
    // account's 45s unrepaired. That can only happen while server rows still
    // hold a 45 at all — i.e. before the backfill above has run — so it closes
    // with the migration rather than needing a per-user flag here.
    if (!isBarWeightRepairDone()) {
      repairMaterializedBarWeights(deduped.exercises)
      markBarWeightRepairDone()
    }

    exercises.value = deduped.exercises
    _invalidateDayCounts()
    triggerRef(exercises)
    _persist()

    // Push local-only exercises to remote
    // (#3 fix: filter localOnly to exclude exercises removed by dedup)
    // (#232 fix: skip sample exercises — they were created with sync:false during onboarding)
    const survivingIds = new Set(deduped.exercises.map(e => e.id))
    const filteredLocalOnly = localOnly.filter(e => survivingIds.has(e.id) && !e.sample)
    if (filteredLocalOnly.length > 0) {
      const userId = _userId
      for (const ex of filteredLocalOnly) {
        _enqueueExerciseUpsert(ex, userId)
        for (const set of ex.sets) {
          _enqueueSetUpsert(set, ex.id, userId)
        }
      }
    }

    // Push local-wins back to Supabase (offline edits that beat remote timestamps)
    // Only push exercise metadata + sets that don't already exist in remote.
    // Previously this pushed ALL sets for every localWins exercise, causing
    // rate-limit storms (500+ operations on every sync).
    const filteredLocalWins = localWins.filter(e => survivingIds.has(e.id) && !e.sample)
    if (filteredLocalWins.length > 0) {
      const userId = _userId
      for (const ex of filteredLocalWins) {
        _enqueueExerciseUpsert(ex, userId)
        // Only push sets that are new or have changed content (offline edits)
        const remoteSets = new Map(
          (remoteExMap.get(ex.id)?.sets || []).map(s => [s.id, s])
        )
        for (const set of ex.sets) {
          const remote = remoteSets.get(set.id)
          const needsPush = !remote
            || remote.weight !== set.weight
            || remote.reps !== set.reps
            || remote.date !== set.date
          if (needsPush) {
            _enqueueSetUpsert(set, ex.id, userId)
          }
        }
      }
    }

    // Reconciliation gap (LIFT-706): when a DIFFERENT device updated an
    // exercise after this device added sets to it offline, the remote copy
    // WINS the last-write-wins merge — so the exercise is neither localOnly
    // nor localWins. Its offline-added sets are unioned into local state above
    // (so they render), but the old push logic only covered localOnly/localWins
    // exercises, leaving those sets stranded locally and silently diverged from
    // the server. Push any local set on a both-sides exercise that the remote
    // doesn't have (and isn't tombstoned). Idempotent upsert + key dedup makes
    // overlap with the pushes above harmless.
    //
    // Known limitation (shared with the localOnly/localWins pushes above): the
    // fetch filters out rows where deleted_at IS NOT NULL, so a set another
    // device soft-deleted looks identical to a never-synced local set. Both get
    // re-pushed. This favors "don't lose hard-won data" over silent removal, but
    // means cross-device deletes don't propagate through this path — that needs
    // the server to surface tombstones (a sync-protocol change, see LIFT-705).
    {
      const userId = _userId
      const alreadyPushedIds = new Set([
        ...filteredLocalOnly.map(e => e.id),
        ...filteredLocalWins.map(e => e.id),
      ])
      for (const ex of deduped.exercises) {
        if (ex.sample || alreadyPushedIds.has(ex.id)) continue
        // Only both-sides exercises reach here; localOnly/localWins are handled
        // above. Use the pre-merge `remoteSetIds` snapshot — the union step
        // mutates remote exercises' `.sets` arrays in place, so checking
        // `remoteEx.sets` here would wrongly treat the just-unioned local set
        // as already present on the server.
        if (!remoteExMap.has(ex.id)) continue
        for (const set of ex.sets) {
          if (remoteSetIds.has(set.id) || isTombstoned('sets', set.id)) continue
          _enqueueSetUpsert(set, ex.id, userId)
        }
      }
    }

    // Process active tombstones: ensure pending deletes are synced
    const tombstoneExercises = remoteExData
      .filter(ex => isTombstoned(TOMBSTONE_STORE, ex.id))
    if (tombstoneExercises.length > 0) {
      const userId = _userId
      for (const ex of tombstoneExercises) {
        _enqueueSoftDelete(`exercise-sets:${ex.id}`, 'sets', { exercise_id: ex.id, user_id: userId })
        _enqueueSoftDelete(`exercise:${ex.id}`, 'exercises', { id: ex.id, user_id: userId })
      }
    }
  }

  /**
   * Create an exercise. `gyms` seeds membership (#961) at creation time so the
   * new-exercise form can assign gyms atomically instead of round-tripping
   * through setExerciseGyms — the upsert enqueued below then carries membership
   * on the very first push. Like `tags`, it applies ONLY on the create path: a
   * name collision returns the existing exercise untouched, so typing an
   * existing name can never silently rewrite that exercise's gyms.
   */
  function addExercise(
    name: string,
    tags: string[] = [],
    { sync = true, gyms = [] }: { sync?: boolean; gyms?: string[] } = {},
  ): string | null {
    const trimmed = name.trim()
    if (!trimmed) return null
    const existing = exercises.value.find(
      (e: Exercise) => e.name.toLowerCase() === trimmed.toLowerCase()
    )
    if (existing) return existing.id
    const id = uuid()
    const sanitizedGyms = sanitizeExerciseGyms(gyms)
    const exercise: Exercise = { id, name: trimmed, tags: [...tags], sets: [], updated_at: new Date().toISOString(), ...(sanitizedGyms.length > 0 ? { gyms: sanitizedGyms } : {}), ...(!sync ? { sample: true } : {}) }
    exercises.value.push(exercise)
    triggerRef(exercises)
    _persist()

    if (sync && supabase && !isPreviewMode.value && _userId) {
      _enqueueExerciseUpsert(exercise, _userId)
    }
    return id
  }

  function setExercisePlateCountMode(exerciseId: string, mode: PlateCountMode) {
    const exercise = exercises.value.find((e: Exercise) => e.id === exerciseId)
    if (!exercise) return
    if (exercise.sample) _adoptExercise(exercise)
    exercise.plateCountMode = mode
    exercise.updated_at = new Date().toISOString()
    triggerRef(exercises)
    _persist()

    if (supabase && _userId) {
      _enqueueExerciseUpsert(exercise, _userId)
    }
  }

  function setExerciseBarWeight(exerciseId: string, barWeight: number) {
    const exercise = exercises.value.find((e: Exercise) => e.id === exerciseId)
    if (!exercise) return
    if (exercise.sample) _adoptExercise(exercise)
    exercise.barWeight = barWeight
    exercise.updated_at = new Date().toISOString()
    triggerRef(exercises)
    _persist()

    if (supabase && _userId) {
      _enqueueExerciseUpsert(exercise, _userId)
    }
  }

  /**
   * Convert every explicitly-stored bar weight when the global display unit
   * toggles (LIFT-1223). `Exercise.barWeight` is stored in the user's display
   * unit, so without this a bar saved as 20 in kg mode is silently reinterpreted
   * as 20 lbs after switching to lbs — feeding wrong numbers into the plate math.
   * Exercises with no explicit barWeight are skipped: they fall back to the
   * unit-aware default (45 lbs / 20 kg), so they need no conversion and must not
   * be adopted from sample state just to stamp one. Called from
   * preferences.setWeightUnit, the sole user-initiated unit-toggle path.
   */
  function convertBarWeightsForUnitChange(from: 'lbs' | 'kg', to: 'lbs' | 'kg') {
    if (from === to) return
    let changed = false
    for (const exercise of exercises.value) {
      if (exercise.barWeight == null) continue
      const next = convertBarWeight(exercise.barWeight, from, to)
      if (next === exercise.barWeight) continue
      if (exercise.sample) _adoptExercise(exercise)
      exercise.barWeight = next
      exercise.updated_at = new Date().toISOString()
      changed = true
      if (supabase && _userId) {
        _enqueueExerciseUpsert(exercise, _userId)
      }
    }
    if (changed) {
      triggerRef(exercises)
      _persist()
    }
  }

  function setExerciseInputMode(exerciseId: string, mode: ExerciseInputMode) {
    const exercise = exercises.value.find((e: Exercise) => e.id === exerciseId)
    if (!exercise) return
    if (exercise.sample) _adoptExercise(exercise)
    exercise.inputMode = mode
    exercise.updated_at = new Date().toISOString()
    triggerRef(exercises)
    _persist()

    if (supabase && _userId) {
      _enqueueExerciseUpsert(exercise, _userId)
    }
  }

  /**
   * Set (or clear) the per-exercise Intensity-lens rep-row count (#770).
   * `null` clears the override so the default (10) applies again. Any other
   * value is sanitized (floored, clamped to [1, 100]) before it is stored.
   */
  function setExerciseIntensityMaxReps(exerciseId: string, maxReps: number | null) {
    const exercise = exercises.value.find((e: Exercise) => e.id === exerciseId)
    if (!exercise) return
    if (exercise.sample) _adoptExercise(exercise)
    if (maxReps === null) {
      delete exercise.intensityMaxReps
    } else {
      exercise.intensityMaxReps = sanitizeIntensityMaxReps(maxReps)
    }
    exercise.updated_at = new Date().toISOString()
    triggerRef(exercises)
    _persist()

    if (supabase && _userId) {
      _enqueueExerciseUpsert(exercise, _userId)
    }
  }

  /**
   * Set (or clear) the explicit Coach equipment classification (#931 phase C).
   * `null` clears the override ("Auto") so the name heuristic applies again.
   * Values are sanitized so only the known kinds are ever stored.
   */
  function setExerciseEquipment(exerciseId: string, equipment: ExerciseEquipment | null) {
    const exercise = exercises.value.find((e: Exercise) => e.id === exerciseId)
    if (!exercise) return
    if (exercise.sample) _adoptExercise(exercise)
    const eq = equipment === null ? undefined : sanitizeExerciseEquipment(equipment)
    if (eq) exercise.equipment = eq
    else delete exercise.equipment
    exercise.updated_at = new Date().toISOString()
    triggerRef(exercises)
    _persist()

    if (supabase && _userId) {
      _enqueueExerciseUpsert(exercise, _userId)
    }
  }

  /**
   * Set (or clear, with []) an exercise's gym membership (#961).
   * Empty membership deletes the field — "unassigned" means the exercise
   * shows under every gym filter.
   */
  function setExerciseGyms(exerciseId: string, gyms: string[]) {
    const exercise = exercises.value.find((e: Exercise) => e.id === exerciseId)
    if (!exercise) return
    if (exercise.sample) _adoptExercise(exercise)
    const sanitized = sanitizeExerciseGyms(gyms)
    if (sanitized.length > 0) exercise.gyms = sanitized
    else delete exercise.gyms
    exercise.updated_at = new Date().toISOString()
    triggerRef(exercises)
    _persist()

    if (supabase && _userId) {
      _enqueueExerciseUpsert(exercise, _userId)
    }
  }

  /**
   * Set (or clear, with empty/whitespace) an exercise's durable free-form note
   * (#619). The value is trimmed and length-capped; an empty result deletes the
   * field so the synced column round-trips back to null.
   */
  function setExerciseNotes(exerciseId: string, notes: string) {
    const exercise = exercises.value.find((e: Exercise) => e.id === exerciseId)
    if (!exercise) return
    const sanitized = sanitizeExerciseNotes(notes)
    // No-op if nothing actually changed — avoids a needless upsert + updated_at
    // bump (and the sync traffic it triggers) when the note is unchanged.
    if ((exercise.notes ?? undefined) === sanitized) return
    if (exercise.sample) _adoptExercise(exercise)
    if (sanitized) exercise.notes = sanitized
    else delete exercise.notes
    exercise.updated_at = new Date().toISOString()
    triggerRef(exercises)
    _persist()

    if (supabase && _userId) {
      _enqueueExerciseUpsert(exercise, _userId)
    }
  }

  /**
   * Toggle whether an exercise folds the lifter's bodyweight into its load
   * (LIFT-834). Enabling recomputes every existing set's stored e1RM with the
   * bodyweight added — capturing the current bodyweight onto any set that
   * predates the flag so retroactively-flagged history gets credit; disabling
   * reverts each e1RM to the bare added weight (captured bodyweight is kept so
   * re-enabling restores the exact values). Recomputed sets are re-synced so the
   * folded e1RM propagates to other devices.
   */
  function setExerciseBodyweightLoaded(exerciseId: string, loaded: boolean) {
    const exercise = exercises.value.find((e: Exercise) => e.id === exerciseId)
    if (!exercise) return
    const current = exercise.bodyweightLoaded ?? false
    if (current === loaded) return
    if (exercise.sample) _adoptExercise(exercise)
    if (loaded) {
      exercise.bodyweightLoaded = true
      const bw = _currentBodyweight()
      for (const s of exercise.sets) {
        if (s.bodyweight === undefined && bw !== undefined) s.bodyweight = bw
        s.estimated1RM = epley(effectiveSetWeight(s, exercise), s.reps)
      }
    } else {
      delete exercise.bodyweightLoaded
      for (const s of exercise.sets) {
        s.estimated1RM = epley(s.weight, s.reps)
      }
    }
    exercise.updated_at = new Date().toISOString()
    triggerRef(exercises)
    _persist()

    if (supabase && _userId) {
      _enqueueExerciseUpsert(exercise, _userId)
      // The recomputed e1RMs live in the sets table; re-upsert so they aren't
      // stale on other devices until each set is next edited.
      for (const s of exercise.sets) _enqueueSetUpsert(s, exerciseId, _userId)
    }
  }

  function logSet(
    exerciseId: string,
    weight: number,
    reps: number,
    dateStr?: string,
    { sync = true, rpe, attemptedNextRep }: { sync?: boolean; rpe?: number; attemptedNextRep?: boolean } = {},
  ) {
    const exercise = exercises.value.find((e: Exercise) => e.id === exerciseId)
    if (!exercise) return
    // Real user action on a sample exercise adopts it (makes it syncable).
    // _adoptExercise pushes via syncQueue, so we must also use syncQueue for
    // the new set to avoid FK violations from the set arriving before the exercise.
    const wasAdopted = sync && !!exercise.sample
    if (wasAdopted) _adoptExercise(exercise)
    const date = dateStr
      ? endOfDayISO(dateStr)
      : new Date().toISOString()
    const id = uuid()
    // For a bodyweight-loaded exercise, capture the lifter's current bodyweight
    // onto the set and fold it into the stored e1RM so PR/volume math counts the
    // true load (LIFT-834). Normal exercises store nothing extra.
    const bodyweight = exercise.bodyweightLoaded ? _currentBodyweight() : undefined
    const estimated1RM = epley(effectiveSetWeight({ weight, bodyweight }, exercise), reps)
    // Real wall-clock log time, distinct from `date` (stamped end-of-day for the
    // chosen calendar day, no time-of-day, per #746). Drives time-of-day +
    // within-workout ordering in the AI Coach payload (#846): ≈ training time for
    // live logging, and for an offline set it preserves the log moment rather
    // than the later sync time.
    const createdAt = new Date().toISOString()
    const newSet: WorkoutSet = { id, date, weight, reps, estimated1RM, createdAt }
    if (bodyweight !== undefined) newSet.bodyweight = bodyweight
    if (rpe != null) newSet.rpe = rpe
    // Only the true case is stored — absent already means "re-racked" (#1271),
    // so writing `false` would bloat every set for no extra information.
    if (attemptedNextRep) newSet.attemptedNextRep = true
    exercise.sets.push(newSet)
    _adjustDayCount(date, 1)
    exercise.updated_at = new Date().toISOString()
    triggerRef(exercises)
    _persist()

    if (sync && supabase && !isPreviewMode.value && _userId) {
      _enqueueSetUpsert(newSet, exerciseId, _userId)
    }
  }

  /**
   * Edit an existing set. `rpe` and `attemptedNextRep` follow the same
   * three-state convention: `undefined` leaves the stored value untouched,
   * while an explicit value writes it (`null`/`false` clears the field).
   */
  function updateSet(
    exerciseId: string,
    setId: string,
    weight: number,
    reps: number,
    dateStr?: string,
    rpe?: number | null,
    attemptedNextRep?: boolean,
  ) {
    const exercise = exercises.value.find((e: Exercise) => e.id === exerciseId)
    if (!exercise) return
    const set = exercise.sets.find((s: WorkoutSet) => s.id === setId)
    if (!set) return
    if (exercise.sample) _adoptExercise(exercise)
    set.weight = weight
    set.reps = reps
    // Preserve the bodyweight captured at log time; only capture now if this set
    // predates the bodyweight-loaded flag (LIFT-834).
    if (exercise.bodyweightLoaded && set.bodyweight === undefined) {
      const bw = _currentBodyweight()
      if (bw !== undefined) set.bodyweight = bw
    }
    set.estimated1RM = epley(effectiveSetWeight(set, exercise), reps)
    if (dateStr) {
      // Re-dating moves the set between day buckets without changing the total
      // set count, so the index checksum cannot detect it — maintain explicitly.
      const previousDate = set.date
      set.date = endOfDayISO(dateStr)
      _adjustDayCount(previousDate, -1)
      _adjustDayCount(set.date, 1)
    }
    if (rpe !== undefined) {
      if (rpe === null) delete set.rpe
      else set.rpe = rpe
    }
    if (attemptedNextRep !== undefined) {
      if (attemptedNextRep) set.attemptedNextRep = true
      else delete set.attemptedNextRep
    }
    exercise.updated_at = new Date().toISOString()
    triggerRef(exercises)
    _persist()

    if (supabase && _userId) {
      _enqueueSetUpsert(set, exerciseId, _userId)
    }
  }

  function deleteSet(exerciseId: string, setId: string, { sync = true }: { sync?: boolean } = {}) {
    const exercise = exercises.value.find((e: Exercise) => e.id === exerciseId)
    if (!exercise) return
    addTombstone('sets', setId)
    const removed = exercise.sets.find((s: WorkoutSet) => s.id === setId)
    exercise.sets = exercise.sets.filter((s: WorkoutSet) => s.id !== setId)
    if (removed) _adjustDayCount(removed.date, -1)
    exercise.updated_at = new Date().toISOString()
    triggerRef(exercises)
    _persist()

    if (sync && supabase && !isPreviewMode.value && _userId) {
      _enqueueSoftDelete(`set:${setId}`, 'sets', { id: setId, user_id: _userId })
    }
  }

  function restoreSet(exerciseId: string, set: WorkoutSet) {
    const exercise = exercises.value.find((e: Exercise) => e.id === exerciseId)
    if (!exercise) return
    removeTombstone('sets', set.id)
    exercise.sets.push(set)
    _adjustDayCount(set.date, 1)
    triggerRef(exercises)
    _persist()

    // Soft-delete restore: clear deleted_at on server. Uses the same key as
    // deleteSet so an in-flight delete is superseded (last-write-wins). If
    // the delete already flushed, this un-soft-deletes the row.
    if (supabase && !isPreviewMode.value && _userId) {
      _enqueueRestore(`set:${set.id}`, 'sets', { id: set.id, user_id: _userId })
    }
  }

  function renameExercise(exerciseId: string, newName: string) {
    const trimmed = newName.trim()
    if (!trimmed) return
    const exercise = exercises.value.find((e: Exercise) => e.id === exerciseId)
    if (!exercise) return
    if (exercise.sample) _adoptExercise(exercise)
    exercise.name = trimmed
    exercise.updated_at = new Date().toISOString()
    triggerRef(exercises)
    _persist()

    if (supabase && _userId) {
      _enqueueExerciseUpsert(exercise, _userId)
    }
  }

  function updateExerciseTags(exerciseId: string, tags: string[]) {
    const exercise = exercises.value.find((e: Exercise) => e.id === exerciseId)
    if (!exercise) return
    if (exercise.sample) _adoptExercise(exercise)
    exercise.tags = [...tags]
    exercise.updated_at = new Date().toISOString()
    triggerRef(exercises)
    _persist()

    if (supabase && _userId) {
      _enqueueExerciseUpsert(exercise, _userId)
    }
  }

  /**
   * Toggle ONE tag on an exercise — the shared primitive behind every tag
   * membership control (TagManagerModal's per-tag exercise checklist and
   * ExerciseManagerModal's per-exercise Tags picker, #1252).
   *
   * It lives on the store rather than in a `useTagActions` composable
   * mirroring `useGymActions`: that composable exists because gym CRUD has to
   * keep the preferences gym LIST in step with workout-store membership and
   * drive an undo toast. A tag toggle coordinates nothing — it is one
   * `updateExerciseTags` call — so a composable would only add indirection.
   */
  function toggleExerciseTag(exerciseId: string, tag: string) {
    const exercise = exercises.value.find((e: Exercise) => e.id === exerciseId)
    if (!exercise) return
    const tags = exercise.tags || []
    updateExerciseTags(
      exerciseId,
      tags.includes(tag) ? tags.filter((t: string) => t !== tag) : [...tags, tag],
    )
  }

  function deleteExercise(exerciseId: string, { sync = true }: { sync?: boolean } = {}) {
    const idx = exercises.value.findIndex((e: Exercise) => e.id === exerciseId)
    if (idx === -1) return
    // Tombstone EVERY server row this local row stands for (LIFT-1335) — an
    // absorbed duplicate that keeps its tombstone-free row on the server sails
    // back through the fetch filter and the exercise reappears with its sets.
    const serverIds = exerciseServerIds(exercises.value[idx])
    for (const id of serverIds) addTombstone(TOMBSTONE_STORE, id)
    exercises.value.splice(idx, 1)
    triggerRef(exercises)
    _persist()

    if (sync && supabase && !isPreviewMode.value && _userId) {
      _syncDeleteExerciseRows(serverIds, _userId)
    }
  }

  /**
   * Soft-delete an exercise row and its sets for every id the local row covers.
   * Shared by the immediate-delete path and the undo-commit path
   * (`syncDeleteExercise`) so the two can't disagree about which rows a delete
   * reaches — the drift that let a merged duplicate survive its own deletion.
   */
  function _syncDeleteExerciseRows(serverIds: string[], userId: string) {
    for (const id of serverIds) {
      _enqueueSoftDelete(`exercise-sets:${id}`, 'sets', { exercise_id: id, user_id: userId })
      _enqueueSoftDelete(`exercise:${id}`, 'exercises', { id, user_id: userId })
    }
  }

  function restoreExercise(exercise: Exercise, atIndex?: number) {
    // Symmetric with deleteExercise: an undo has to un-tombstone and un-delete
    // the absorbed duplicates too, or the restored row loses their sets on the
    // next fetch (LIFT-1335).
    const serverIds = exerciseServerIds(exercise)
    for (const id of serverIds) removeTombstone(TOMBSTONE_STORE, id)
    if (atIndex !== undefined && atIndex >= 0 && atIndex <= exercises.value.length) {
      exercises.value.splice(atIndex, 0, exercise)
    } else {
      exercises.value.push(exercise)
    }
    triggerRef(exercises)
    _persist()

    // Soft-delete restore: clear deleted_at on both the exercise and its sets.
    // Uses the same keys as deleteExercise so in-flight deletes are superseded.
    // If the delete already flushed, these un-soft-delete.
    //
    // Note: restoring sets by exercise_id will also resurrect sets that were
    // individually soft-deleted before the exercise delete. Edge case; the
    // alternative (tracking per-cascade timestamps) is complexity without
    // matching benefit for immediate-undo UX.
    if (supabase && !isPreviewMode.value && _userId) {
      for (const id of serverIds) {
        _enqueueRestore(`exercise-sets:${id}`, 'sets', { exercise_id: id, user_id: _userId })
        _enqueueRestore(`exercise:${id}`, 'exercises', { id, user_id: _userId })
      }
    }
  }

  function archiveExercise(exerciseId: string) {
    const exercise = exercises.value.find((e: Exercise) => e.id === exerciseId)
    if (!exercise) return
    if (exercise.archived_at) return
    if (exercise.sample) _adoptExercise(exercise)
    const archivedAt = new Date().toISOString()
    exercise.archived_at = archivedAt
    exercise.updated_at = archivedAt
    triggerRef(exercises)
    _persist()

    // Use a full upsert (not a partial update) so this enqueue is safe even
    // when the row hasn't yet been created on the server (e.g., an adopted
    // sample exercise whose creating upsert sits in the same queue slot).
    if (supabase && !isPreviewMode.value && _userId) {
      _enqueueExerciseUpsert(exercise, _userId)
    }
  }

  function unarchiveExercise(exerciseId: string) {
    const exercise = exercises.value.find((e: Exercise) => e.id === exerciseId)
    if (!exercise) return
    if (!exercise.archived_at) return
    delete exercise.archived_at
    exercise.updated_at = new Date().toISOString()
    triggerRef(exercises)
    _persist()

    if (supabase && !isPreviewMode.value && _userId) {
      _enqueueExerciseUpsert(exercise, _userId)
    }
  }

  function syncDeleteSet(setId: string) {
    if (supabase && _userId) {
      _enqueueSoftDelete(`set:${setId}`, 'sets', { id: setId, user_id: _userId })
    }
  }

  /**
   * Commit a `deleteExercise(id, { sync: false })` to the server once the undo
   * window closes. Takes the EXERCISE, not an id: a local row can stand for
   * several server rows (LIFT-1335) and by the time this runs the row is gone
   * from `exercises.value`, so `mergedFrom` can only arrive from the copy the
   * undo toast is holding.
   */
  function syncDeleteExercise(exercise: Pick<Exercise, 'id' | 'mergedFrom'>) {
    if (supabase && _userId) {
      _syncDeleteExerciseRows(exerciseServerIds(exercise), _userId)
    }
  }

  function renameTag(oldName: string, newName: string) {
    const trimmed = newName.trim()
    if (!trimmed || trimmed === oldName) return
    const modified: Exercise[] = []
    exercises.value.forEach((e: Exercise) => {
      const idx = e.tags.indexOf(oldName)
      if (idx !== -1) {
        if (e.tags.includes(trimmed)) {
          e.tags.splice(idx, 1)
        } else {
          e.tags[idx] = trimmed
        }
        e.updated_at = new Date().toISOString()
        modified.push(e)
      }
    })
    const tags = customTags.value
    const customIdx = tags.indexOf(oldName)
    if (customIdx !== -1) {
      if (tags.includes(trimmed)) {
        tags.splice(customIdx, 1)
      } else {
        tags[customIdx] = trimmed
      }
      customTags.value = tags
      triggerRef(customTags)
    }
    const recovery = { ...tagRecoveryDays.value }
    if (oldName in recovery) {
      const days = recovery[oldName]
      delete recovery[oldName]
      if (!(trimmed in recovery)) {
        recovery[trimmed] = days
      }
      tagRecoveryDays.value = recovery
      triggerRef(tagRecoveryDays)
    }
    const excluded = [...tagRecoveryExcluded.value]
    const exclIdx = excluded.indexOf(oldName)
    if (exclIdx !== -1) {
      if (!excluded.includes(trimmed)) {
        excluded[exclIdx] = trimmed
      } else {
        excluded.splice(exclIdx, 1)
      }
      tagRecoveryExcluded.value = excluded
      triggerRef(tagRecoveryExcluded)
    }
    triggerRef(exercises)
    _persist()

    if (_userId && modified.length > 0) {
      const userId = _userId
      for (const e of modified.filter(e => !e.sample)) {
        _enqueueExerciseUpsert(e, userId)
      }
    }
  }

  function deleteTag(tagName: string) {
    const modified: Exercise[] = []
    exercises.value.forEach((e: Exercise) => {
      const idx = e.tags.indexOf(tagName)
      if (idx !== -1) {
        e.tags.splice(idx, 1)
        e.updated_at = new Date().toISOString()
        modified.push(e)
      }
    })
    customTags.value = customTags.value.filter(t => t !== tagName)
    triggerRef(customTags)
    const recovery = { ...tagRecoveryDays.value }
    delete recovery[tagName]
    tagRecoveryDays.value = recovery
    triggerRef(tagRecoveryDays)
    tagRecoveryExcluded.value = tagRecoveryExcluded.value.filter(t => t !== tagName)
    triggerRef(tagRecoveryExcluded)
    triggerRef(exercises)
    _persist()

    if (_userId && modified.length > 0) {
      const userId = _userId
      for (const e of modified.filter(e => !e.sample)) {
        _enqueueExerciseUpsert(e, userId)
      }
    }
  }

  /**
   * Rewrite a renamed gym across every exercise's membership (#961). The gym
   * LIST lives in the preferences store; useGymActions orchestrates both.
   * Mirrors renameTag: if an exercise already carries the new name, the old
   * entry is dropped instead of duplicated.
   */
  function renameGymOnExercises(oldName: string, newName: string) {
    const trimmed = newName.trim()
    if (!trimmed || trimmed === oldName) return
    const modified: Exercise[] = []
    exercises.value.forEach((e: Exercise) => {
      if (!e.gyms) return
      const idx = e.gyms.indexOf(oldName)
      if (idx === -1) return
      if (e.gyms.includes(trimmed)) {
        e.gyms.splice(idx, 1)
        if (e.gyms.length === 0) delete e.gyms
      } else {
        e.gyms[idx] = trimmed
      }
      e.updated_at = new Date().toISOString()
      modified.push(e)
    })
    if (modified.length === 0) return
    triggerRef(exercises)
    _persist()

    if (_userId) {
      const userId = _userId
      for (const e of modified.filter(e => !e.sample)) {
        _enqueueExerciseUpsert(e, userId)
      }
    }
  }

  /**
   * Strip a deleted gym from every exercise's membership (#961). Returns the
   * ids of the exercises that carried it so the caller's undo toast can
   * restore membership via setExerciseGyms.
   */
  function removeGymFromExercises(gymName: string): string[] {
    const modified: Exercise[] = []
    exercises.value.forEach((e: Exercise) => {
      if (!e.gyms) return
      const idx = e.gyms.indexOf(gymName)
      if (idx === -1) return
      e.gyms.splice(idx, 1)
      if (e.gyms.length === 0) delete e.gyms
      e.updated_at = new Date().toISOString()
      modified.push(e)
    })
    if (modified.length === 0) return []
    triggerRef(exercises)
    _persist()

    if (_userId) {
      const userId = _userId
      for (const e of modified.filter(e => !e.sample)) {
        _enqueueExerciseUpsert(e, userId)
      }
    }
    return modified.map(e => e.id)
  }

  function setTagRecoveryDays(tag: string, days: number | null) {
    const recovery = { ...tagRecoveryDays.value }
    if (days === null || days <= 0) {
      delete recovery[tag]
    } else {
      recovery[tag] = days
    }
    tagRecoveryDays.value = recovery
    triggerRef(tagRecoveryDays)
    _persist()
  }

  function setTagRecoveryExcluded(tag: string, excluded: boolean) {
    const arr = [...tagRecoveryExcluded.value]
    const idx = arr.indexOf(tag)
    if (excluded && idx === -1) {
      arr.push(tag)
    } else if (!excluded && idx !== -1) {
      arr.splice(idx, 1)
    }
    tagRecoveryExcluded.value = arr
    triggerRef(tagRecoveryExcluded)
    _persist()
  }

  function addCustomTag(name: string) {
    const trimmed = name.trim()
    if (!trimmed || customTags.value.includes(trimmed)) return
    customTags.value = [...customTags.value, trimmed]
    triggerRef(customTags)
    _persist()
  }

  // ── Getters (computed) ─────────────────────────────────────────────
  const allTags = computed((): string[] => {
    const tagSet = new Set<string>()
    exercises.value.forEach((e: Exercise) => (e.tags || []).forEach((t: string) => tagSet.add(t)))
    customTags.value.forEach((t: string) => tagSet.add(t))
    return [...tagSet].sort()
  })

  /** Exercises the user is actively training — main list and pickers use this. */
  const activeExercises = computed((): Exercise[] =>
    exercises.value.filter((e: Exercise) => !e.archived_at)
  )

  /** Exercises the user has archived — hidden from the main list but data is preserved. */
  const archivedExercises = computed((): Exercise[] =>
    exercises.value.filter((e: Exercise) => !!e.archived_at)
  )

  /**
   * Sorted unique workout dates (local YYYY-MM-DD), derived from all sets.
   *
   * Bucketed via `setDayKey` (#746), not a raw `slice(0, 10)`: the dominant
   * endOfDayISO stamp carries the chosen local day in its prefix, but the
   * `logSet` no-date fallback and legacy/imported rows are real UTC instants,
   * where an Americas-evening set's prefix already reads as tomorrow. This
   * getter is the app's canonical "days you trained" list (streaks, the
   * welcome-back gap, the install prompt), so a mis-bucketed day is visible
   * everywhere at once.
   */
  const workoutDates = computed((): string[] => {
    const dates = new Set<string>()
    exercises.value.forEach((e: Exercise) =>
      e.sets.forEach((s: WorkoutSet) => dates.add(setDayKey(s.date)))
    )
    return [...dates].sort()
  })

  // ── PR memoization (LIFT-939) ───────────────────────────────────
  // getExercisePR / getExercisePRSet are called many times per render
  // (the exercise list calls getRowMeta 3× per row, prsThisWeek loops
  // every exercise), and each call did an O(n) `.find` plus an O(m) scan
  // over the exercise's sets — O(rows × (n + m)) per WorkoutTracker render.
  // This computed rebuilds an id→exercise index and an empty result memo,
  // and is invalidated only when `exercises` changes (ref reassignment or
  // the store's in-place-mutation `triggerRef(exercises)` calls). Results
  // are filled lazily per baseline date and cached until the next mutation,
  // so repeat lookups are O(1) and each exercise is scanned at most once.
  interface PRResult {
    pr: number
    prSet: WorkoutSet | null
  }
  const _prCache = computed<{ byId: Map<string, Exercise>; bySince: Map<string, Map<string, PRResult>> }>(() => {
    const byId = new Map<string, Exercise>()
    for (const e of exercises.value) byId.set(e.id, e)
    return { byId, bySince: new Map<string, Map<string, PRResult>>() }
  })

  function _computePRResult(exercise: Exercise | undefined, sinceDate: string | null): PRResult {
    if (!exercise || exercise.sets.length === 0) return { pr: 0, prSet: null }
    let best: WorkoutSet | null = null
    for (const s of exercise.sets) {
      // `sinceDate` is a local day key, so the set must be bucketed with
      // setDayKey (#746) to compare against it — a raw prefix would let a
      // real-time-stamped set from the evening BEFORE the baseline read as
      // the baseline day and still count as the PR. `filterSetsSinceBaseline`
      // in setScoring.ts already buckets this same cutoff that way; the two
      // must not disagree on the same question.
      if (sinceDate && setDayKey(s.date) < sinceDate) continue
      // Strict `>` keeps the first set that reaches the max, matching the
      // prior reduce()/Math.max() tie-breaking behavior.
      if (!best || s.estimated1RM > best.estimated1RM) best = s
    }
    return best ? { pr: best.estimated1RM, prSet: best } : { pr: 0, prSet: null }
  }

  function _prResult(exerciseId: string, sinceDate: string | null): PRResult {
    const { byId, bySince } = _prCache.value
    const key = sinceDate ?? ''
    let memo = bySince.get(key)
    if (!memo) {
      memo = new Map<string, PRResult>()
      bySince.set(key, memo)
    }
    let result = memo.get(exerciseId)
    if (!result) {
      result = _computePRResult(byId.get(exerciseId), sinceDate)
      memo.set(exerciseId, result)
    }
    return result
  }

  /**
   * Max estimated1RM across all sets for an exercise.
   * When `sinceDate` (YYYY-MM-DD) is provided, only sets on or after that
   * date are considered. Default (undefined/null) preserves legacy
   * all-time behavior.
   */
  function getExercisePR(exerciseId: string, sinceDate?: string | null): number {
    return _prResult(exerciseId, sinceDate ?? null).pr
  }

  /**
   * The single set that achieved the max estimated1RM.
   * Respects `sinceDate` like getExercisePR.
   */
  function getExercisePRSet(exerciseId: string, sinceDate?: string | null): WorkoutSet | null {
    return _prResult(exerciseId, sinceDate ?? null).prSet
  }

  /**
   * The bodyweight (lbs) a write to this exercise WILL fold into its e1RM —
   * 0 for a normal exercise, and 0 while the lifter has no tracked bodyweight
   * (matching `logSet`, which then captures nothing).
   *
   * This is the log sheet's window onto the ADDED↔EFFECTIVE offset (#1328).
   * Every 1RM surface in the log sheet works in ADDED space (that is what the
   * weight field means) while `estimated1RM` — and therefore `getExercisePR` —
   * is stored EFFECTIVE, so a suggestion inverted out of a PR has to be brought
   * back across. Exposed from the store rather than resolved in the component so
   * the preview and the write path read the same bodyweight through the same
   * guard and cannot disagree.
   *
   * Pass `setId` when previewing an EDIT: `updateSet` keeps the bodyweight
   * captured at log time and only falls back to the current one for a set that
   * predates the flag, so a preview reading today's weigh-in would show an
   * estimate the save won't produce once the lifter's weight has drifted.
   */
  function bodyweightFoldFor(exerciseId: string, setId?: string): number {
    const exercise = exercises.value.find((e: Exercise) => e.id === exerciseId)
    // Short-circuit BEFORE touching the bodyweight store: for a normal exercise
    // the fold is 0 whatever the lifter weighs, and reading `latestWeight`
    // anyway would take a reactive dependency on every bodyweight entry — so
    // logging a weigh-in would invalidate the log sheet's estimate for nothing.
    // `bodyweightFold` still owns the rule; this only skips a lookup it would
    // discard.
    if (!exercise?.bodyweightLoaded) return 0
    const captured = setId
      ? exercise.sets.find((s: WorkoutSet) => s.id === setId)?.bodyweight
      : undefined
    return bodyweightFold(exercise, captured ?? _currentBodyweight())
  }

  /**
   * Returns the sets from the most recent session (day) for an exercise,
   * excluding today. Used for "Last Session" quick-fill in the log modal.
   * Returns { date, sets } or null if no prior session exists.
   */
  function getLastSession(exerciseId: string, today?: string): { date: string; sets: WorkoutSet[] } | null {
    const exercise = exercises.value.find((e: Exercise) => e.id === exerciseId)
    if (!exercise || exercise.sets.length === 0) return null
    const todayStr = today ?? todayISO()
    // Group sets by day
    const byDay = new Map<string, WorkoutSet[]>()
    for (const set of exercise.sets) {
      const day = setDayKey(set.date)
      if (day === todayStr) continue
      if (!byDay.has(day)) byDay.set(day, [])
      byDay.get(day)!.push(set)
    }
    if (byDay.size === 0) return null
    // Find the most recent day
    const latestDay = [...byDay.keys()].sort().pop()!
    return { date: latestDay, sets: byDay.get(latestDay)! }
  }

  // ── Usual ladder detection ──────────────────────────────────────
  const LADDER_WINDOW = 6         // prior sessions sampled
  const LADDER_MIN_SESSIONS = 3   // minimum prior sessions to claim a routine
  const LADDER_MIN_PREFIX = 3     // minimum established positions to claim a routine
  const LADDER_MAX_RUNGS = 10
  const LADDER_WEIGHT_TOLERANCE = 1.0 // lbs — absorbs kg↔lbs float drift; real plate steps are ≥2.5 lbs

  /**
   * Detects the user's habitual set progression ("ladder") for an exercise —
   * e.g. a bench warm-up of 45×10, 95×10, 135×10, 185×10 repeated session
   * after session. Pure read; powers the routine-aware quick-fill row and
   * one-tap ghost logging in the set modal.
   *
   * Algorithm: sample the most recent LADDER_WINDOW prior sessions (excluding
   * `today`). For each set position i, cluster the i-th set's weight across
   * sessions (±LADDER_WEIGHT_TOLERANCE) and accept the position as
   * "established" when the winning cluster covers ≥ max(3, 60%) of sampled
   * sessions — so up to 2 deviant sessions in a 6-window (a deload day, an
   * experiment) can't evict the ladder. The ladder is the longest established
   * prefix (≥ LADDER_MIN_PREFIX, else null), plus the most recent session's
   * remaining sets verbatim as a 'recent' tail so a week-to-week drifting top
   * set still gets a rung.
   */
  function getUsualLadder(exerciseId: string, today?: string): UsualLadder | null {
    const exercise = exercises.value.find((e: Exercise) => e.id === exerciseId)
    if (!exercise || exercise.sets.length === 0) return null
    const todayStr = today ?? todayISO()

    // Group sets by day preserving in-day insertion order — end-of-day
    // timestamps carry random jitter, so array order is the only reliable
    // intra-day ordering.
    const byDay = new Map<string, WorkoutSet[]>()
    for (const set of exercise.sets) {
      const day = setDayKey(set.date)
      if (day === todayStr) continue
      if (!byDay.has(day)) byDay.set(day, [])
      byDay.get(day)!.push(set)
    }
    if (byDay.size < LADDER_MIN_SESSIONS) return null

    // Most recent prior sessions, newest first.
    const days = [...byDay.keys()].sort().reverse().slice(0, LADDER_WINDOW)
    const sessions = days.map(d => byDay.get(d)!)
    const sampled = sessions.length
    const support = Math.max(LADDER_MIN_SESSIONS, Math.ceil(0.6 * sampled))

    const rungs: UsualLadderRung[] = []
    for (let i = 0; i < LADDER_MAX_RUNGS; i++) {
      // The i-th set of every sampled session that has one. Sessions shorter
      // than i count against support via the fixed `sampled` denominator.
      const candidates: { weight: number; reps: number; sessionIdx: number }[] = []
      sessions.forEach((sets, sessionIdx) => {
        if (sets.length > i) candidates.push({ weight: sets[i].weight, reps: sets[i].reps, sessionIdx })
      })
      if (candidates.length < support) break

      // Cluster weights: sort distinct values, greedily merge neighbors
      // within tolerance, then assign members.
      const clusters: { weights: number[]; members: typeof candidates }[] = []
      for (const w of [...new Set(candidates.map(c => c.weight))].sort((a, b) => a - b)) {
        const last = clusters[clusters.length - 1]
        if (last && w - last.weights[last.weights.length - 1] <= LADDER_WEIGHT_TOLERANCE) {
          last.weights.push(w)
        } else {
          clusters.push({ weights: [w], members: [] })
        }
      }
      for (const c of candidates) {
        clusters.find(cl => cl.weights.includes(c.weight))!.members.push(c)
      }

      // Winning cluster: most members; ties go to the cluster seen most
      // recently (sessions are newest-first, so lower sessionIdx = newer).
      let winner = clusters[0]
      for (const cl of clusters.slice(1)) {
        const clRecent = Math.min(...cl.members.map(m => m.sessionIdx))
        const winRecent = Math.min(...winner.members.map(m => m.sessionIdx))
        if (cl.members.length > winner.members.length ||
            (cl.members.length === winner.members.length && clRecent < winRecent)) {
          winner = cl
        }
      }
      if (winner.members.length < support) break

      // Rung weight: the newest session's in-cluster raw value, so kg users
      // see back exactly the number they last entered.
      const newest = winner.members.reduce((best, m) => m.sessionIdx < best.sessionIdx ? m : best)
      // Reps: mode among cluster members, ties broken toward the newest value.
      const repCounts = new Map<number, number>()
      for (const m of winner.members) repCounts.set(m.reps, (repCounts.get(m.reps) ?? 0) + 1)
      let rungReps = newest.reps
      let rungRepsCount = repCounts.get(newest.reps) ?? 0
      for (const [r, count] of repCounts) {
        if (count > rungRepsCount) { rungReps = r; rungRepsCount = count }
      }
      rungs.push({ weightLbs: newest.weight, reps: rungReps, source: 'consensus' })
    }

    const consensusCount = rungs.length
    if (consensusCount < LADDER_MIN_PREFIX) return null

    // Tail: the newest session's sets beyond the consensus prefix, verbatim —
    // but only when that session actually followed the ladder. A deviant
    // newest session (e.g. a long deload) would otherwise leak contradictory
    // rungs after the consensus top set.
    const newestSession = sessions[0]
    const newestOnLadder = newestSession.length >= consensusCount &&
      rungs.every((rung, i) => Math.abs(newestSession[i].weight - rung.weightLbs) <= LADDER_WEIGHT_TOLERANCE)
    if (newestOnLadder) {
      for (let i = consensusCount; i < Math.min(newestSession.length, LADDER_MAX_RUNGS); i++) {
        rungs.push({ weightLbs: newestSession[i].weight, reps: newestSession[i].reps, source: 'recent' })
      }
    }

    return { rungs, consensusCount, sessionsSampled: sampled }
  }

  /**
   * Progressive overload suggestion for an exercise.
   * Analyzes recent sessions to suggest the next weight × reps.
   *
   * Algorithm:
   * 1. Group sets by date into sessions (most recent first)
   * 2. Take the top set (highest weight) from each of the last 3 sessions
   * 3. If user lifted the same weight×reps across 2+ sessions → suggest +5 lbs
   * 4. If user increased reps but not weight recently → suggest weight increase
   * 5. Otherwise suggest +1 rep at same weight
   */
  function getOverloadSuggestion(exerciseId: string, today?: string): OverloadSuggestion | null {
    const exercise = exercises.value.find((e: Exercise) => e.id === exerciseId)
    if (!exercise || exercise.sets.length < 3) return null

    // Group sets by date (YYYY-MM-DD) → sessions. Pass `today` to exclude an
    // in-progress session — mid-workout, today's partial top set would
    // otherwise read as a regression and mask a legitimate suggestion.
    const sessions = new Map<string, WorkoutSet[]>()
    for (const set of exercise.sets) {
      const day = setDayKey(set.date)
      if (day === today) continue
      if (!sessions.has(day)) sessions.set(day, [])
      sessions.get(day)!.push(set)
    }

    // Sort sessions by date descending, take last 3
    const sortedDays = [...sessions.keys()].sort().reverse()
    if (sortedDays.length < 2) return null

    const recentSessions = sortedDays.slice(0, 3)

    // Top set per session — heaviest, then most reps, then (at a dead tie) the
    // set that went for one more rep, which is the higher-output effort (#1271).
    const topSets = recentSessions.map(day => pickTopSet(sessions.get(day)!)!)

    const latest = topSets[0]
    const previous = topSets[1]

    // Check if user has been consistent at same weight across recent sessions
    const sameWeight = topSets.filter(s => s.weight === latest.weight)
    const WEIGHT_INCREMENT = 5 // lbs

    // A top set that ended in a failed attempt at the next rep is already at
    // true failure for that weight: there are no reps in reserve to convert
    // into extra load, so "go heavier" would just cost reps. The productive
    // next step is to land the rep that was already attempted — and because
    // the lifter got part of the way there, that IS forward progress even
    // though the rep count did not move (#1271). Checked before the
    // go-heavier branch below so it wins on the same data, and marked 'high'
    // (unlike the generic add-a-rep fallbacks) because it fires only on an
    // explicit, deliberate annotation rather than on almost any history.
    if (attemptedNextRep(latest)) {
      const target = latest.reps + 1
      return {
        type: 'increase_reps',
        weight: latest.weight,
        reps: target,
        reason: `You went for rep ${target} at ${latest.weight} lbs last session — land it this time`,
        confidence: 'high'
      }
    }

    if (sameWeight.length >= 2 && latest.reps >= 5) {
      // Consistent at same weight with solid reps → increase weight
      // Suggest same reps (or slightly fewer) at higher weight
      const suggestedReps = Math.max(latest.reps - 2, 3)
      return {
        type: 'increase_weight',
        weight: latest.weight + WEIGHT_INCREMENT,
        reps: suggestedReps,
        reason: `You've hit ${latest.weight} lbs × ${latest.reps} in ${sameWeight.length} recent sessions — time to go heavier`,
        confidence: 'high'
      }
    }

    if (latest.weight === previous.weight && latest.reps > previous.reps) {
      // Reps increasing at same weight → keep building or bump weight
      if (latest.reps >= 8) {
        return {
          type: 'increase_weight',
          weight: latest.weight + WEIGHT_INCREMENT,
          reps: Math.max(latest.reps - 2, 3),
          reason: `Strong rep progression at ${latest.weight} lbs — ready for a weight increase`,
          confidence: 'high'
        }
      }
      return {
        type: 'increase_reps',
        weight: latest.weight,
        reps: latest.reps + 1,
        reason: `You went from ${previous.reps} to ${latest.reps} reps — keep building`,
        confidence: 'low'
      }
    }

    if (latest.weight > previous.weight) {
      // Already increased weight recently → consolidate
      return {
        type: 'increase_reps',
        weight: latest.weight,
        reps: latest.reps + 1,
        reason: `You recently moved up to ${latest.weight} lbs — build reps before adding more weight`,
        confidence: 'low'
      }
    }

    // Default: suggest adding a rep
    return {
      type: 'increase_reps',
      weight: latest.weight,
      reps: latest.reps + 1,
      reason: `Try adding one more rep at ${latest.weight} lbs`,
      confidence: 'low'
    }
  }

  /**
   * Reset all store state to defaults and clear persisted data.
   * Required because setup/composition stores don't get auto-$reset from Pinia.
   * Called by useAuth on sign-out and account deletion.
   */
  function $reset() {
    exercises.value = []
    _invalidateDayCounts()
    customTags.value = []
    tagRecoveryDays.value = {}
    tagRecoveryExcluded.value = []
    _userId = null
    syncing.value = false
    lastSyncError.value = null
    triggerRef(exercises)
    triggerRef(customTags)
    triggerRef(tagRecoveryDays)
    triggerRef(tagRecoveryExcluded)
    _persist()
  }

  return {
    // State
    exercises,
    customTags,
    tagRecoveryDays,
    tagRecoveryExcluded,
    syncing,
    lastSyncError,
    // Actions
    $reset,
    init,
    // Exposed so a recovered connection / session can re-run the read without
    // re-running init's migration work (LIFT-1226).
    _fetchFromSupabase,
    _reloadFromStorage,
    addExercise,
    setExercisePlateCountMode,
    setExerciseInputMode,
    setExerciseBarWeight,
    convertBarWeightsForUnitChange,
    setExerciseIntensityMaxReps,
    setExerciseEquipment,
    setExerciseBodyweightLoaded,
    setExerciseGyms,
    setExerciseNotes,
    logSet,
    updateSet,
    deleteSet,
    restoreSet,
    renameExercise,
    updateExerciseTags,
    toggleExerciseTag,
    deleteExercise,
    restoreExercise,
    archiveExercise,
    unarchiveExercise,
    syncDeleteSet,
    syncDeleteExercise,
    renameTag,
    deleteTag,
    renameGymOnExercises,
    removeGymFromExercises,
    setTagRecoveryDays,
    setTagRecoveryExcluded,
    addCustomTag,
    // Getters
    allTags,
    activeExercises,
    archivedExercises,
    workoutDates,
    setsLoggedOn,
    getExercisePR,
    getExercisePRSet,
    bodyweightFoldFor,
    getLastSession,
    getUsualLadder,
    getOverloadSuggestion
  }
})

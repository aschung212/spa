/**
 * Read-path recovery: re-fetch every store when connectivity, foreground, or
 * the session comes back (LIFT-1226).
 *
 * The app is local-first, so a failed READ degrades silently: each store's
 * `_fetchFromSupabase` records `lastSyncError` and returns, and nothing ever
 * re-runs it. Writes were assumed to self-heal (the sync queue retries with
 * backoff and journals durably), but reads had no equivalent — so an offline
 * cold start, a transient blip, or a mid-session token expiry left the app on
 * local-only data until a full relaunch. Cross-device changes stayed invisible,
 * and the reconciliation pushes that live inside `_fetchFromSupabase`
 * (re-pushing local rows the server is missing) never resumed either.
 *
 * Writes turned out to self-heal only within their ~31s retry budget
 * (LIFT-1322): past that the in-memory op is dropped and its retained journal
 * entry was read again only at the next cold start. So `run()` now replays that
 * journal before flushing — the same reconnect signals recover both directions.
 *
 * This module is the single WRITE-REPLAY + re-fetch entry point for all four
 * stores, plus the listeners that drive it:
 *   - `online`               — the connection came back
 *   - foreground resume      — the shared `onForegroundResume` signal set
 *                              (`visibilitychange` + `focus` + `pageshow`)
 *   - `sessionRecoveryTick`  — a 401 was healed by a token refresh
 *
 * Overlapping and repeated triggers are collapsed: one run at a time
 * (single-flight) and at most one run per `REFETCH_COOLDOWN_MS`, so a burst of
 * resume events or a reconnect flap can't stack four fetches per store.
 */
import { watch } from 'vue'
import { syncQueue } from '../lib/syncQueue'
import { onForegroundResume } from '../lib/foregroundResume'
import { sessionRecoveryTick } from '../lib/sessionHealth'
import { logError } from '../lib/logger'
import { useWorkoutStore } from '../stores/workout'
import { useBodyweightStore } from '../stores/bodyweight'
import { usePreferencesStore } from '../stores/preferences'
import { useProgressionStore } from '../stores/progression'

/** What woke the recovery up. Reported to Sentry when a re-fetch throws. */
export type RefetchTrigger = 'online' | 'resume' | 'session-recovered'

/**
 * Minimum spacing between re-fetches. A resume fires `visibilitychange` AND
 * `focus`, and a flaky connection can emit `online` repeatedly — without a
 * floor, tab-flicking would issue a full four-store read every time.
 */
export const REFETCH_COOLDOWN_MS = 20_000

/** Delay floor for a deferred re-run, so a trailing retry can't spin. */
const TRAILING_MIN_MS = 500

let _inFlight: Promise<void> | null = null
let _lastRunAt = 0
let _trailingTimer: ReturnType<typeof setTimeout> | null = null

function msUntilAllowed(): number {
  return Math.max(0, REFETCH_COOLDOWN_MS - (Date.now() - _lastRunAt))
}

function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}

async function run(trigger: RefetchTrigger): Promise<void> {
  // Re-arm durable writes that exhausted their retries earlier in the session
  // (LIFT-1322). Their journal entries are retained (LIFT-1229) but nothing read
  // them again until the next cold start, so flushing alone would drain an
  // already-empty queue and leave the backlog stranded. This has to come first:
  // the flush below is what actually sends them, and both must precede the
  // remote-wins reads. Separate try from the flush so a replay failure can never
  // suppress the flush, which is the load-bearing half.
  try {
    syncQueue.replayJournal()
  } catch (err) {
    logError(err, { source: 'useSyncRecovery', action: 'replay', trigger })
  }

  // Writes before reads. Every store read is remote-wins for the fields it
  // carries, so re-fetching ahead of a pending offline edit would paint the
  // stale server value back over it (the queued write still lands, but the UI
  // would show the old value until some later fetch). Flushing first also means
  // a reconnect pushes the user's backlog immediately instead of waiting out
  // the retry backoff. `flush()` reports its own failures and is a no-op on an
  // empty queue.
  try {
    await syncQueue.flush()
  } catch (err) {
    logError(err, { source: 'useSyncRecovery', action: 'flush', trigger })
  }

  // allSettled, mirroring initStores: each store already swallows its own fetch
  // failure into `lastSyncError`, so a rejection here means the store method
  // itself broke — log it, but never let one store abort the other three.
  const results = await Promise.allSettled([
    useWorkoutStore()._fetchFromSupabase(),
    useBodyweightStore()._fetchFromSupabase(),
    usePreferencesStore()._fetchFromSupabase(),
    useProgressionStore()._fetchFromSupabase(),
  ])
  for (const r of results) {
    if (r.status === 'rejected') {
      logError(r.reason, { source: 'useSyncRecovery', action: 'refetch', trigger })
    }
  }
}

function scheduleTrailing(trigger: RefetchTrigger): void {
  if (_trailingTimer) return
  _trailingTimer = setTimeout(() => {
    _trailingTimer = null
    void refetchAllStores(trigger)
  }, Math.max(msUntilAllowed(), TRAILING_MIN_MS))
}

/**
 * Re-fetch every store, subject to the single-flight + cooldown guards.
 * Resolves true when a run actually happened.
 *
 * A `session-recovered` trigger that gets blocked schedules a trailing re-run
 * rather than being dropped: it means the reads that provoked the token refresh
 * returned 401s, so whatever is currently in flight (or just ran) is exactly the
 * data that must be fetched again. `online` / `resume` are dropped when blocked
 * — an in-flight or just-completed run already carries the fresh data they want.
 */
export function refetchAllStores(trigger: RefetchTrigger): Promise<boolean> {
  // Nothing to recover to while the device is offline; the `online` listener is
  // the signal that matters, and it will fire.
  if (isOffline()) return Promise.resolve(false)
  if (_inFlight || msUntilAllowed() > 0) {
    if (trigger === 'session-recovered') scheduleTrailing(trigger)
    return Promise.resolve(false)
  }
  _lastRunAt = Date.now()
  // Clear only OUR OWN registration (promise identity, not a bare null): a
  // later run must never be un-registered by an earlier one settling late.
  const p = run(trigger).finally(() => {
    if (_inFlight === p) _inFlight = null
  })
  _inFlight = p
  // Every caller is a fire-and-forget listener (`void refetchAllStores(...)`),
  // so a rejection would surface as an unhandled rejection rather than as
  // anything actionable. `run` already contains its own failures; reaching here
  // means the machinery around them broke (e.g. no active Pinia). Report it and
  // resolve false so recovery stays a best-effort background concern.
  return p.then(() => true, (err: unknown) => {
    logError(err, { source: 'useSyncRecovery', action: 'run', trigger })
    return false
  })
}

/**
 * Register the recovery listeners. Returns a teardown for `onUnmounted`.
 *
 * The foreground signal set comes from `onForegroundResume` rather than being
 * spelled out here (LIFT-1392). It used to be, and it had quietly drifted to
 * `visibilitychange` + `focus` while the comment claimed parity with
 * `useAuth.setupSessionRefreshLifecycle` — which listens to those two PLUS
 * `pageshow` precisely because neither of the first two is reliable alone in
 * WKWebView (LIFT-784). So on the one resume path that rationale was written
 * for, the token got refreshed and this recovery never ran. The duplicate
 * triggers a single resume can deliver are absorbed by the cooldown.
 *
 * `pageshow` also fires once for the initial page load, which lands here at cold
 * start: that run is a no-op (every store's `_fetchFromSupabase` returns early
 * until `init()` sets its `_userId`) and costs only the cooldown window, during
 * which `initStores` is doing the very fetching a recovery would repeat.
 */
export function setupSyncRecovery(): () => void {
  const cleanups: Array<() => void> = []

  cleanups.push(onForegroundResume(() => { void refetchAllStores('resume') }))

  if (typeof window !== 'undefined') {
    const onOnline = () => { void refetchAllStores('online') }
    window.addEventListener('online', onOnline)
    cleanups.push(() => window.removeEventListener('online', onOnline))
  }

  cleanups.push(watch(sessionRecoveryTick, () => { void refetchAllStores('session-recovered') }))

  return () => {
    for (const cleanup of cleanups) cleanup()
    if (_trailingTimer) {
      clearTimeout(_trailingTimer)
      _trailingTimer = null
    }
  }
}

/** Reset module state (tests only). */
export function _resetSyncRecovery(): void {
  _inFlight = null
  _lastRunAt = 0
  if (_trailingTimer) clearTimeout(_trailingTimer)
  _trailingTimer = null
}

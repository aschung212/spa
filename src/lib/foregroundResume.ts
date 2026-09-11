/**
 * The one definition of "the app came back to the foreground" (LIFT-1392).
 *
 * There is no single reliable resume event on the App Store target. LIFT-784
 * established the rule the hard way: supabase-js pauses its token-refresh timer
 * while the document is hidden and resumes it on `visibilitychange`, and that
 * event does not fire dependably in WKWebView/Capacitor when the app comes back
 * from the background — so the access token quietly expired mid-session. The fix
 * was redundancy: listen to `visibilitychange` AND `focus` AND `pageshow`, and
 * let whichever arrives first do the work.
 *
 * That reasoning is not specific to auth, but the CODE was: every consumer
 * hand-rolled its own listener set, and they drifted. `useSyncRecovery`'s doc
 * comment claimed parity with `useAuth` while registering only two of the three
 * — so on the exact WKWebView resume path LIFT-784 exists for, the token was
 * refreshed and the four-store read-path recovery (LIFT-1226) never ran, leaving
 * cross-device data stale until some later signal happened along.
 *
 * So the set lives here, once, and `architecturalInvariants.test.ts` fails any
 * other file in `src/` that registers a window `focus`/`pageshow` listener of
 * its own. A hardcoded list of consumers would only ever pin the ones that
 * existed when it was written — which is precisely how the two copies drifted.
 *
 * Deliberately NOT migrated: consumers that want a visibility STATE MACHINE
 * rather than a resume signal — `useWakeLock` (re-acquire a lock the platform
 * dropped on hide), `useNotification`'s background tracker and App.vue's app-icon
 * badge (both need the hide edge as much as the show edge), and
 * `useServiceWorker`'s update poll. They register `visibilitychange` alone and
 * are unaffected by this rule.
 */

export interface ForegroundResumeOptions {
  /**
   * Called on the hide edge (`visibilitychange` → hidden). Only
   * `visibilitychange` reports going away — `focus`/`pageshow` are show-only
   * signals — so a consumer that pairs resume with a pause (supabase-js's
   * `stopAutoRefresh`) gets exactly one hide event per hide, not several.
   */
  onHide?: () => void
  /**
   * Run `onResume` immediately when the document is already visible at
   * registration. A consumer that arms a timer on resume needs it armed for the
   * session that is ALREADY in the foreground — no event is coming for a page
   * that never left.
   */
  immediate?: boolean
}

/**
 * Register the full foreground-resume signal set. Returns a teardown.
 *
 * `onResume` can fire several times for one resume (a WKWebView return can
 * deliver `visibilitychange` and `focus`), so it must be idempotent or
 * rate-limited by the caller — `useSyncRecovery` absorbs the duplicates with its
 * cooldown, `useAuth` with an idempotent `startAutoRefresh()`.
 */
export function onForegroundResume(
  onResume: () => void,
  { onHide, immediate = false }: ForegroundResumeOptions = {},
): () => void {
  const cleanups: Array<() => void> = []

  if (typeof document !== 'undefined') {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') onResume()
      else onHide?.()
    }
    document.addEventListener('visibilitychange', onVisibility)
    cleanups.push(() => document.removeEventListener('visibilitychange', onVisibility))
  }

  if (typeof window !== 'undefined') {
    // One handler for both so a consumer can never end up subscribed to a
    // subset of the set — the drift this module exists to prevent.
    const onWindowResume = () => onResume()
    window.addEventListener('focus', onWindowResume)
    window.addEventListener('pageshow', onWindowResume)
    cleanups.push(
      () => window.removeEventListener('focus', onWindowResume),
      () => window.removeEventListener('pageshow', onWindowResume),
    )
  }

  if (immediate && typeof document !== 'undefined' && document.visibilityState === 'visible') {
    onResume()
  }

  return () => {
    for (const cleanup of cleanups) cleanup()
  }
}

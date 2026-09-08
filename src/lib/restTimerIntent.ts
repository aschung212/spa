/**
 * Pending "Rest Again" intent from the rest-timer notification (LIFT-751 / LIFT-1355).
 *
 * The action button on the "Rest Complete" notification is handled in the service
 * worker (`public/sw-notification-handler.js`), which reaches the app through one of
 * two channels depending on whether a window was already open:
 *
 *   - **running app** → `client.postMessage` after focusing the existing window
 *   - **cold boot**   → the action encoded in the URL passed to `openWindow`
 *
 * The second channel exists because `openWindow()` resolves as soon as the
 * WindowClient is created — long before the page's JS runs — so a `postMessage`
 * there lands in a client with no listener and is silently dropped. That is the
 * *primary* scenario for this button: iOS kills backgrounded PWAs, so a user
 * tapping "Rest Again" after their phone locked has no running app to message.
 *
 * Both channels funnel into the single pending flag below so there is exactly one
 * place to consume from. That also decouples arrival from consumption: the rest
 * timer lives in WorkoutTracker, which is unmounted while the user is on the
 * Calendar or Weight tab, so an intent may land before its consumer exists.
 *
 * This is a module-level reactive signal for the same reason `sessionHealth`'s
 * `sessionRecoveryTick` is one — it is cross-component lifecycle plumbing, not
 * view state, and both the producer (the app shell) and the consumer (the rest
 * timer controller) need it to outlive any single component instance.
 */
import { ref, computed, type ComputedRef } from 'vue'

/** Query param the service worker uses to carry an action across a cold boot. */
export const REST_INTENT_PARAM = 'action'
/** The only action value this module recognises. */
export const REST_AGAIN_ACTION = 'rest-again'

/**
 * How long a pending request stays honourable, in ms.
 *
 * Consumption is near-immediate on both designed paths (the launch URL also
 * carries `?tab=workouts`, and the shell switches tabs on the message channel —
 * either way WorkoutTracker mounts within the same interaction). The window
 * covers the slow ones: a cold boot on a phone, or a launch that lands on the
 * auth gate and waits for a sign-in. Past that the user has moved on, and a rest
 * between sets they never started should not fire when they eventually wander
 * back to the Workouts tab.
 */
const REST_INTENT_TTL_MS = 2 * 60 * 1000

/** When the pending request arrived (epoch ms). `0` means nothing is pending. */
const requestedAt = ref(0)

/** True while a "Rest Again" request is waiting to be consumed. */
export const restAgainPending: ComputedRef<boolean> = computed(() => requestedAt.value !== 0)

/**
 * Record an inbound "Rest Again" request. Called by the app shell's
 * service-worker message listener and by {@link captureRestTimerIntent}.
 */
export function requestRestAgain(): void {
  requestedAt.value = Date.now()
}

/**
 * One-shot read: clears any pending request and reports whether it was still
 * fresh enough to act on. Always clears, even when stale or when the caller
 * decides not to act — a request that survives its own consumption would fire
 * again on the next mount.
 */
export function consumeRestAgain(): boolean {
  const at = requestedAt.value
  requestedAt.value = 0
  return at !== 0 && Date.now() - at <= REST_INTENT_TTL_MS
}

/**
 * Capture a notification action carried in the launch URL, then strip it.
 *
 * Must run before `useTabRouting` — that consumes `?tab=` and rewrites the URL
 * to the bare pathname, taking every other param with it. Stripping here (rather
 * than leaving it to that rewrite) keeps the action out of a reload, a bookmark,
 * or a shared link, so it can never replay itself.
 *
 * @param search query string to parse (defaults to the live `location.search`)
 * @returns whether an intent was found
 */
export function captureRestTimerIntent(search: string = window.location.search): boolean {
  const params = new URLSearchParams(search)
  if (params.get(REST_INTENT_PARAM) !== REST_AGAIN_ACTION) return false

  requestRestAgain()

  // Preserve any other params (?tab= is read right after this) — mirrors the
  // strip in captureAcquisitionSource rather than clobbering the query string.
  if (typeof window !== 'undefined' && window.history?.replaceState) {
    const url = new URL(window.location.href)
    url.searchParams.delete(REST_INTENT_PARAM)
    const next = url.searchParams.toString()
    window.history.replaceState({}, '', url.pathname + (next ? `?${next}` : '') + url.hash)
  }
  return true
}

/** Test seam — module state outlives any component, so suites must reset it. */
export function _resetRestTimerIntent(): void {
  requestedAt.value = 0
}

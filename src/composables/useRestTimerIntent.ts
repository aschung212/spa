import { ref, type Ref } from 'vue'

/**
 * Query param the service worker uses to carry a rest-timer notification action
 * across a cold start (LIFT-1355). See public/sw-notification-handler.js for why
 * the URL — and not `postMessage` — is the only channel that survives one.
 */
export const REST_TIMER_ACTION_PARAM = 'rest-action'

/** The one action worth carrying: "Rest Again" starts another rest. */
export const REST_AGAIN_ACTION = 'rest-again'

/** Message type the service worker posts to an already-running client (LIFT-751). */
export const REST_TIMER_MESSAGE_TYPE = 'rest-timer-action'

/**
 * Read — and clear — a rest-timer action carried in the launch URL.
 *
 * Must be called BEFORE `useTabRouting`, which wipes the whole query string when
 * it sees a `?tab=` deep link; the service worker always sends both, so the
 * ordering in App.vue is what makes this readable at all.
 *
 * The param is stripped whenever it is present, even for a value we don't
 * recognise: it is ours either way, and leaving it behind would make the intent
 * re-fire on every reload and leak into a shared link. Mirrors the cleanup
 * `captureAcquisitionSource` does for `?ref=`/`?utm_*`, preserving other params.
 *
 * @param search query string to parse (defaults to the live `location.search`)
 * @returns the recognised action, or null
 */
export function takeRestTimerLaunchAction(search: string = window.location.search): string | null {
  const action = new URLSearchParams(search).get(REST_TIMER_ACTION_PARAM)
  if (action !== null && typeof window !== 'undefined' && window.history?.replaceState) {
    const url = new URL(window.location.href)
    url.searchParams.delete(REST_TIMER_ACTION_PARAM)
    const next = url.searchParams.toString()
    window.history.replaceState({}, '', url.pathname + (next ? `?${next}` : '') + url.hash)
  }
  return action === REST_AGAIN_ACTION ? action : null
}

export interface RestTimerIntentOptions {
  /** Does the user still have the rest timer turned on? */
  isEnabled: () => boolean
  /** Bring the rest timer's host surface (the Workouts tab) on screen. */
  reveal: () => void
  /**
   * Start a fresh rest. Returns false when the host isn't mounted yet, in which
   * case the request stays parked until the next `flush()`.
   */
  start: () => boolean
}

export interface RestTimerIntent {
  /** True while a "Rest Again" request is waiting for its host to mount. */
  pending: Ref<boolean>
  /** Record a "Rest Again" request and try to satisfy it now. */
  request: () => void
  /** Retry a parked request — call whenever the host may have just mounted. */
  flush: () => void
  /** Start listening for service-worker action messages; returns a teardown. */
  listen: () => () => void
}

/**
 * Owns the "Rest Again" notification action on the client side (LIFT-1355).
 *
 * The action arrives by one of two channels — a launch-URL param on a cold start,
 * a service-worker message on a warm one — and in neither case can the producer
 * know whether anything is listening yet. So the intent is PARKED and the
 * consumer takes it when it is ready, the same shape App.vue already uses for the
 * calendar's "+ New exercise" handoff (LIFT-1375).
 *
 * This deliberately lives above WorkoutTracker rather than inside
 * `useRestTimerController`, which is where the message listener used to be. That
 * listener is registered in WorkoutTracker's setup, and WorkoutTracker is an async
 * component behind an auth gate — so on the cold start this feature exists to serve
 * it did not exist yet, and the message went nowhere. Owning it at the shell also
 * means the Workouts tab can be surfaced first: a rest timer counting down on a tab
 * the user isn't looking at is the same silence.
 */
export function useRestTimerIntent(options: RestTimerIntentOptions): RestTimerIntent {
  const pending = ref(false)

  function flush(): void {
    if (!pending.value) return
    if (options.start()) pending.value = false
  }

  function request(): void {
    // A notification outlives the setting that produced it: the user may have
    // turned the rest timer off between the beep and the tap. Drop the request
    // rather than park it — the rest bar is hidden while disabled, so a timer
    // started here would run entirely off-screen. This matches what the old
    // message handler did (ignore it outright).
    if (!options.isEnabled()) return
    pending.value = true
    // Surface the host before starting. Unconditional even when the Workouts tab
    // is hidden in preferences, for the same reason the calendar's exercise
    // handoff is (LIFT-1375): that user has no other rest-timer surface at all.
    options.reveal()
    flush()
  }

  function onServiceWorkerMessage(event: MessageEvent): void {
    const data = event.data
    if (data?.type === REST_TIMER_MESSAGE_TYPE && data.action === REST_AGAIN_ACTION) request()
  }

  function listen(): () => void {
    navigator.serviceWorker?.addEventListener('message', onServiceWorkerMessage)
    return () => {
      navigator.serviceWorker?.removeEventListener('message', onServiceWorkerMessage)
    }
  }

  return { pending, request, flush, listen }
}

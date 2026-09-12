/// <reference types="node" />
/**
 * "Rest Again" notification action, client side (LIFT-1355).
 *
 * The action used to be consumed by a `navigator.serviceWorker` message listener
 * registered inside `useRestTimerController`, i.e. inside WorkoutTracker's setup.
 * WorkoutTracker is an async component behind the auth gate, so on a COLD start —
 * the case the feature exists for, because iOS reclaims backgrounded PWAs — the
 * service worker's `openWindow()` resolved and posted its message long before any
 * listener existed, and the tap did nothing at all.
 *
 * The intent is now parked and consumed when its host is ready. These tests cover
 * both arrival channels (launch URL, service-worker message), the park/flush
 * handover, and the App.vue wiring whose ORDERING is load-bearing and otherwise
 * invisible: `useTabRouting` wipes the whole query string when it sees `?tab=`,
 * so a read placed after it recovers nothing and silently restores the bug.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import {
  takeRestTimerLaunchAction,
  useRestTimerIntent,
  REST_TIMER_ACTION_PARAM,
  REST_AGAIN_ACTION,
  REST_TIMER_MESSAGE_TYPE,
} from '../useRestTimerIntent'

function setUrl(pathAndQuery: string): void {
  window.history.replaceState({}, '', pathAndQuery)
}

describe('takeRestTimerLaunchAction', () => {
  beforeEach(() => setUrl('/'))
  afterEach(() => setUrl('/'))

  it('recovers the rest-again action from the launch URL', () => {
    setUrl(`/?tab=workouts&${REST_TIMER_ACTION_PARAM}=${REST_AGAIN_ACTION}`)

    expect(takeRestTimerLaunchAction()).toBe(REST_AGAIN_ACTION)
  })

  it('clears its own param while preserving the rest of the query', () => {
    // `useTabRouting` happens to wipe the whole query string when `?tab=` is
    // present, but this must not depend on that: a param left behind re-fires
    // the intent on every reload and leaks into a shared link.
    setUrl(`/?tab=workouts&${REST_TIMER_ACTION_PARAM}=${REST_AGAIN_ACTION}&ref=ph`)

    takeRestTimerLaunchAction()

    expect(window.location.search).not.toContain(REST_TIMER_ACTION_PARAM)
    expect(window.location.search).toContain('tab=workouts')
    expect(window.location.search).toContain('ref=ph')
  })

  it('returns null and leaves the URL alone when the param is absent', () => {
    setUrl('/?tab=calendar')

    expect(takeRestTimerLaunchAction()).toBeNull()
    expect(window.location.search).toBe('?tab=calendar')
  })

  it('ignores an unrecognised action but still strips it', () => {
    setUrl(`/?${REST_TIMER_ACTION_PARAM}=drop-tables`)

    expect(takeRestTimerLaunchAction()).toBeNull()
    expect(window.location.search).toBe('')
  })
})

describe('useRestTimerIntent', () => {
  let swListeners: Array<(event: MessageEvent) => void>
  let removed: Array<(event: MessageEvent) => void>
  let originalSW: PropertyDescriptor | undefined

  beforeEach(() => {
    swListeners = []
    removed = []
    originalSW = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker')
    Object.defineProperty(navigator, 'serviceWorker', {
      value: {
        addEventListener: (_type: string, cb: (event: MessageEvent) => void) => swListeners.push(cb),
        removeEventListener: (_type: string, cb: (event: MessageEvent) => void) => removed.push(cb),
      },
      configurable: true,
    })
  })

  afterEach(() => {
    if (originalSW) {
      Object.defineProperty(navigator, 'serviceWorker', originalSW)
    } else {
      // @ts-expect-error clean up the stub
      delete navigator.serviceWorker
    }
  })

  function makeIntent(overrides: { enabled?: boolean; hostMounted?: boolean } = {}) {
    const hostMounted = { value: overrides.hostMounted ?? true }
    const reveal = vi.fn()
    const start = vi.fn(() => hostMounted.value)
    const intent = useRestTimerIntent({
      isEnabled: () => overrides.enabled ?? true,
      reveal,
      start,
    })
    return { intent, reveal, start, hostMounted }
  }

  it('reveals the host and starts a rest when one is already mounted', () => {
    const { intent, reveal, start } = makeIntent()

    intent.request()

    expect(reveal).toHaveBeenCalledOnce()
    expect(start).toHaveBeenCalledOnce()
    expect(intent.pending.value).toBe(false)
  })

  it('parks the request when the host has not mounted yet, then starts on flush', () => {
    // The cold-start case: App.vue reads the launch param before WorkoutTracker's
    // chunk has loaded, so `start()` has no controller to call.
    const { intent, reveal, start, hostMounted } = makeIntent({ hostMounted: false })

    intent.request()

    expect(reveal).toHaveBeenCalledOnce()
    expect(start).toHaveBeenCalledOnce()
    expect(intent.pending.value).toBe(true)

    // A flush before the host lands must not consume the intent.
    intent.flush()
    expect(intent.pending.value).toBe(true)

    hostMounted.value = true
    intent.flush()

    expect(start).toHaveBeenCalledTimes(3)
    expect(intent.pending.value).toBe(false)
  })

  it('flush is a no-op when nothing was requested', () => {
    const { intent, start } = makeIntent()

    intent.flush()

    expect(start).not.toHaveBeenCalled()
  })

  it('drops the request when the rest timer has been disabled', () => {
    // A notification outlives the setting that produced it. Dropping (rather than
    // parking) matters: the rest bar is hidden while disabled, so the timer would
    // run entirely off-screen — and the intent must not fire later if the user
    // turns the feature back on.
    const { intent, reveal, start } = makeIntent({ enabled: false })

    intent.request()

    expect(reveal).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    expect(intent.pending.value).toBe(false)
  })

  it('starts a rest when the service worker posts rest-again to a running client', () => {
    const { intent, start } = makeIntent()
    const teardown = intent.listen()
    expect(swListeners.length).toBe(1)

    swListeners.forEach(cb =>
      cb({ data: { type: REST_TIMER_MESSAGE_TYPE, action: REST_AGAIN_ACTION } } as MessageEvent),
    )

    expect(start).toHaveBeenCalledOnce()
    teardown()
  })

  it('ignores unrelated service-worker messages', () => {
    const { intent, start } = makeIntent()
    const teardown = intent.listen()

    swListeners.forEach(cb => {
      cb({ data: { type: 'other-thing' } } as MessageEvent)
      cb({ data: { type: REST_TIMER_MESSAGE_TYPE, action: 'something-else' } } as MessageEvent)
      cb({ data: null } as MessageEvent)
    })

    expect(start).not.toHaveBeenCalled()
    teardown()
  })

  it('teardown removes the message listener', () => {
    const { intent } = makeIntent()

    intent.listen()()

    expect(removed).toEqual(swListeners)
  })

  it('listens without throwing where there is no service worker at all', () => {
    // @ts-expect-error model a browser/Capacitor build with no SW support
    delete navigator.serviceWorker
    const { intent } = makeIntent()

    expect(() => intent.listen()()).not.toThrow()
  })
})

describe('App.vue wiring (LIFT-1355)', () => {
  const appSource = readFileSync(resolve(__dirname, '../../App.vue'), 'utf-8')

  it('reads the launch action BEFORE useTabRouting wipes the query string', () => {
    const read = appSource.indexOf('takeRestTimerLaunchAction()')
    const router = appSource.indexOf('useTabRouting({')
    expect(read).toBeGreaterThan(-1)
    expect(router).toBeGreaterThan(-1)
    // `useTabRouting` strips the whole query on a `?tab=` deep link, and the
    // service worker always sends both params. Reading after it recovers nothing.
    expect(read).toBeLessThan(router)
  })

  it('registers the service-worker listener and tears it down', () => {
    expect(appSource).toContain('teardownRestTimerIntent = restTimerIntent.listen()')
    expect(appSource).toContain('teardownRestTimerIntent?.()')
  })

  it('retries the parked intent when the WorkoutTracker ref lands', () => {
    // WorkoutTracker is async: on a cold start the ref is null well past the
    // next tick, so the watcher is the only thing that can satisfy the request.
    const watcher = appSource.slice(
      appSource.indexOf('watch(workoutTrackerRef'),
      appSource.indexOf('watch(workoutTrackerRef') + 200,
    )
    expect(watcher).toContain('restTimerIntent.flush()')
  })

  it('no longer consumes the action inside the rest-timer controller', () => {
    // The whole defect: that listener only existed once WorkoutTracker's setup
    // had run, which on a cold start is long after the message was posted. Two
    // owners would also double-start the timer on the warm path.
    const controller = readFileSync(
      resolve(__dirname, '../useRestTimerController.ts'),
      'utf-8',
    )
    expect(controller).not.toContain('rest-timer-action')
    expect(controller).not.toMatch(/addEventListener\(\s*['"]message['"]/)
  })
})

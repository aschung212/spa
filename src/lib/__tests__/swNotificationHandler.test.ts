/**
 * Behavioural tests for the shipped service-worker notification handler
 * (`public/sw-notification-handler.js`), LIFT-751 / LIFT-1355.
 *
 * The file is plain JS injected into the Workbox-generated SW via
 * `workbox.importScripts`, so nothing imports it and no bundler ever type-checks
 * it. It was covered only by string assertions in `workboxCacheRegression.test.ts`
 * (`expect(handler).toContain('rest-again')`) — which is why LIFT-1355 shipped:
 * the handler *did* contain 'rest-again', it just posted it into a document that
 * had not booted yet. A message dropped for want of a listener is a behaviour, and
 * only executing the script can see it.
 *
 * The script only touches the SW global through `self`, so it can be evaluated
 * with a fake one and driven exactly as the browser would drive it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { captureRestTimerIntent, restAgainPending, _resetRestTimerIntent } from '../restTimerIntent'

const HANDLER_SRC = readFileSync(
  resolve(__dirname, '../../../public/sw-notification-handler.js'),
  'utf-8',
)

const APP_SRC = readFileSync(resolve(__dirname, '../../App.vue'), 'utf-8')
const CONTROLLER_SRC = readFileSync(
  resolve(__dirname, '../../composables/useRestTimerController.ts'),
  'utf-8',
)

interface FakeClient {
  focus: ReturnType<typeof vi.fn>
  postMessage: ReturnType<typeof vi.fn>
}

function makeClient(): FakeClient {
  return { focus: vi.fn().mockResolvedValue(undefined), postMessage: vi.fn() }
}

interface Harness {
  /** Dispatch a notificationclick and await the handler's waitUntil work. */
  click: (opts: { action?: string; tag?: string }) => Promise<void>
  openWindow: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  windowClients: FakeClient[]
}

/** Evaluate the real handler against a fake ServiceWorkerGlobalScope. */
function loadHandler(windowClients: FakeClient[]): Harness {
  let listener: ((event: unknown) => void) | null = null
  const openWindow = vi.fn().mockResolvedValue(makeClient())
  const close = vi.fn()

  const self = {
    addEventListener: (type: string, cb: (event: unknown) => void) => {
      if (type === 'notificationclick') listener = cb
    },
    clients: {
      matchAll: vi.fn().mockResolvedValue(windowClients),
      openWindow,
    },
  }

  new Function('self', HANDLER_SRC)(self)
  if (!listener) throw new Error('handler registered no notificationclick listener')

  return {
    windowClients,
    openWindow,
    close,
    click: async ({ action, tag = 'lift-rest-timer' }) => {
      const pending: Array<Promise<unknown>> = []
      listener!({
        action,
        notification: { tag, close },
        waitUntil: (p: Promise<unknown>) => pending.push(p),
      })
      await Promise.all(pending)
    },
  }
}

describe('sw-notification-handler: rest-timer notification actions', () => {
  beforeEach(() => vi.clearAllMocks())

  describe('no window open — the cold-boot path (LIFT-1355)', () => {
    it('carries the rest-again action in the launch URL', async () => {
      const h = loadHandler([])

      await h.click({ action: 'rest-again' })

      // openWindow() resolves as soon as the WindowClient exists, long before the
      // page's JS runs, so the intent must travel in the URL. iOS kills
      // backgrounded PWAs, making this the button's primary scenario.
      expect(h.openWindow).toHaveBeenCalledWith('/?tab=workouts&action=rest-again')
    })

    it('does not postMessage a client it just opened', async () => {
      const opened = makeClient()
      const h = loadHandler([])
      h.openWindow.mockResolvedValue(opened)

      await h.click({ action: 'rest-again' })

      // This was the whole defect: a message posted here reaches a document with
      // no listener and is silently dropped. It must not come back as a second
      // channel either, or a fast boot would start two rest timers.
      expect(opened.postMessage).not.toHaveBeenCalled()
    })

    it('opens the plain workouts URL for the log-set action and the body tap', async () => {
      const logSet = loadHandler([])
      await logSet.click({ action: 'log-set' })
      expect(logSet.openWindow).toHaveBeenCalledWith('/?tab=workouts')

      const bodyTap = loadHandler([])
      await bodyTap.click({})
      expect(bodyTap.openWindow).toHaveBeenCalledWith('/?tab=workouts')
    })
  })

  describe('a window is already open — the running-app path', () => {
    it('focuses it and posts the rest-again message', async () => {
      const client = makeClient()
      const h = loadHandler([client])

      await h.click({ action: 'rest-again' })

      expect(client.focus).toHaveBeenCalled()
      expect(client.postMessage).toHaveBeenCalledWith({
        type: 'rest-timer-action',
        action: 'rest-again',
      })
      // Never reload a running app: client.navigate() would throw away the
      // in-progress workout, which is why this path stays on postMessage.
      expect(h.openWindow).not.toHaveBeenCalled()
    })

    it('still delivers the action when focus() is refused', async () => {
      const client = makeClient()
      client.focus.mockRejectedValue(new Error('focus not allowed'))
      const h = loadHandler([client])

      // The message goes out BEFORE the focus attempt and the rejection is
      // swallowed, so a user agent that declines the activation costs the user
      // the foreground, not the rest timer.
      await expect(h.click({ action: 'rest-again' })).resolves.toBeUndefined()

      expect(client.postMessage).toHaveBeenCalledWith({
        type: 'rest-timer-action',
        action: 'rest-again',
      })
    })

    it('focuses without messaging for the log-set action and the body tap', async () => {
      const client = makeClient()
      const h = loadHandler([client])

      await h.click({ action: 'log-set' })
      await h.click({})

      expect(client.focus).toHaveBeenCalledTimes(2)
      expect(client.postMessage).not.toHaveBeenCalled()
    })
  })

  it('ignores notifications from other tags', async () => {
    const client = makeClient()
    const h = loadHandler([client])

    await h.click({ action: 'rest-again', tag: 'some-other-feature' })

    expect(h.close).not.toHaveBeenCalled()
    expect(client.focus).not.toHaveBeenCalled()
    expect(h.openWindow).not.toHaveBeenCalled()
  })

  it('closes the notification before doing any work', async () => {
    const h = loadHandler([])

    await h.click({ action: 'rest-again' })

    expect(h.close).toHaveBeenCalledTimes(1)
  })
})

describe('sw-notification-handler ↔ client handoff (LIFT-1355)', () => {
  afterEach(() => _resetRestTimerIntent())

  it('emits a launch URL the client actually recognises', async () => {
    // The SW is plain JS injected via importScripts, so it cannot import the
    // param/action constants — the two sides agree by convention only. Run the
    // real handler and feed its URL straight into the real capture, so a rename
    // on either side fails here instead of silently dropping the action.
    _resetRestTimerIntent()
    const h = loadHandler([])
    await h.click({ action: 'rest-again' })

    const launched = new URL(h.openWindow.mock.calls[0][0], 'https://spa-rho-sandy.vercel.app')

    expect(captureRestTimerIntent(launched.search)).toBe(true)
    expect(restAgainPending.value).toBe(true)
    // …and the same URL must still route to the tab the rest timer lives on,
    // or the controller that consumes the intent never mounts.
    expect(launched.searchParams.get('tab')).toBe('workouts')
  })

  it('captures the launch intent before the ?tab= cleanup rewrites the URL', () => {
    // useTabRouting replaces the URL with the bare pathname, taking every other
    // param with it — so a capture placed after it would find nothing.
    const capturePos = APP_SRC.indexOf('captureRestTimerIntent()')
    const routingPos = APP_SRC.indexOf('useTabRouting({')

    expect(capturePos).toBeGreaterThan(-1)
    expect(routingPos).toBeGreaterThan(-1)
    expect(capturePos).toBeLessThan(routingPos)
  })

  it('registers the running-app message listener on the shell, and tears it down', () => {
    // WorkoutTracker only mounts on the Workouts tab, so a listener owned by the
    // rest-timer controller misses messages that arrive after a relaunch onto
    // Calendar or Weight.
    expect(APP_SRC).toContain("navigator.serviceWorker?.addEventListener('message', onServiceWorkerMessage)")
    expect(APP_SRC).toContain("navigator.serviceWorker?.removeEventListener('message', onServiceWorkerMessage)")
    expect(APP_SRC).toContain("switchTab('workouts')")
  })

  it('leaves the controller with no listener of its own — one owner, one consumer', () => {
    expect(CONTROLLER_SRC).not.toContain('navigator.serviceWorker')
    expect(CONTROLLER_SRC).toContain('consumeRestAgain')
  })
})

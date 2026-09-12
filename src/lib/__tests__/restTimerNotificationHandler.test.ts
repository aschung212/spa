/// <reference types="node" />
/**
 * Behavioural regression for the rest-timer notification handler
 * (public/sw-notification-handler.js — LIFT-751 / LIFT-1355).
 *
 * `openWindow()` resolves as soon as the WindowClient is CREATED, long before the
 * page's scripts run, so a `postMessage` fired at a window we just opened lands on
 * a client with no listener and is dropped. That is the primary "Rest Again" case:
 * iOS reclaims backgrounded PWAs, so the user tapping the button after their phone
 * locked is exactly the user starting the app cold — and for them the button did
 * nothing at all. The action now travels in the launch URL instead.
 *
 * The handler is a classic script pulled into the generated SW by
 * `workbox.importScripts`, so it cannot import the client's constants. Rather than
 * assert two string literals match, the last test round-trips the URL this handler
 * actually opens through the parser that actually reads it — the two halves are
 * pinned by behaviour, which a copy-paste rename cannot fool.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { takeRestTimerLaunchAction, REST_AGAIN_ACTION } from '../../composables/useRestTimerIntent'

interface FakeClient {
  focus: () => Promise<void>
  postMessage: (data: unknown) => void
}

let matchAll: ReturnType<typeof vi.fn>
let openWindow: ReturnType<typeof vi.fn>
let originalClients: PropertyDescriptor | undefined

/** Dispatch a notificationclick at the imported handler and await its waitUntil. */
async function click(options: { action?: string; tag?: string } = {}): Promise<{ closed: number }> {
  const notification = { tag: options.tag ?? 'lift-rest-timer', close: vi.fn() }
  const pending: Promise<unknown>[] = []
  const event = new Event('notificationclick') as Event & Record<string, unknown>
  event.notification = notification
  event.action = options.action ?? ''
  event.waitUntil = (p: Promise<unknown>) => { pending.push(p) }

  self.dispatchEvent(event)
  await Promise.all(pending)
  return { closed: notification.close.mock.calls.length }
}

function fakeClient(): FakeClient {
  return { focus: vi.fn(async () => {}), postMessage: vi.fn() }
}

beforeAll(async () => {
  originalClients = Object.getOwnPropertyDescriptor(self, 'clients')
  // The script registers its listener on `self` at import time, exactly as
  // `importScripts` runs it inside the generated service worker.
  // @ts-expect-error classic service-worker script, shipped from public/ untyped
  await import('../../../public/sw-notification-handler.js')
})

afterAll(() => {
  if (originalClients) Object.defineProperty(self, 'clients', originalClients)
})

beforeEach(() => {
  matchAll = vi.fn(async () => [] as FakeClient[])
  openWindow = vi.fn(async () => null)
  Object.defineProperty(self, 'clients', {
    value: { matchAll, openWindow },
    configurable: true,
    writable: true,
  })
})

describe('rest-timer notificationclick handler (LIFT-1355)', () => {
  describe('with no window client to message', () => {
    it('carries the rest-again action in the URL it opens', async () => {
      await click({ action: REST_AGAIN_ACTION })

      expect(openWindow).toHaveBeenCalledOnce()
      const url = String(openWindow.mock.calls[0][0])
      expect(url).toContain('tab=workouts')
      expect(new URLSearchParams(url.slice(url.indexOf('?'))).get('rest-action'))
        .toBe(REST_AGAIN_ACTION)
    })

    it('opens the plain workouts URL for a body tap or the log-set action', async () => {
      await click()
      await click({ action: 'log-set' })

      expect(openWindow.mock.calls.map(c => c[0])).toEqual(['/?tab=workouts', '/?tab=workouts'])
    })
  })

  describe('with a window client already running', () => {
    it('focuses it and posts the action rather than opening a second window', async () => {
      const client = fakeClient()
      matchAll.mockResolvedValue([client])

      await click({ action: REST_AGAIN_ACTION })

      expect(client.focus).toHaveBeenCalledOnce()
      expect(client.postMessage).toHaveBeenCalledWith({
        type: 'rest-timer-action',
        action: REST_AGAIN_ACTION,
      })
      expect(openWindow).not.toHaveBeenCalled()
    })

    it('only focuses for a body tap or the log-set action', async () => {
      const client = fakeClient()
      matchAll.mockResolvedValue([client])

      await click()
      await click({ action: 'log-set' })

      expect(client.focus).toHaveBeenCalledTimes(2)
      expect(client.postMessage).not.toHaveBeenCalled()
    })
  })

  it('leaves notifications from other features alone', async () => {
    const { closed } = await click({ action: REST_AGAIN_ACTION, tag: 'some-other-feature' })

    expect(closed).toBe(0)
    expect(matchAll).not.toHaveBeenCalled()
    expect(openWindow).not.toHaveBeenCalled()
  })

  it('closes the notification it handled', async () => {
    const { closed } = await click({ action: REST_AGAIN_ACTION })

    expect(closed).toBe(1)
  })

  it('the URL it opens is one the client actually recognises', async () => {
    // The drift guard. The handler cannot import the client's param name, so
    // prove the halves agree by feeding one to the other: this is the exact
    // launch query App.vue reads on a cold start.
    await click({ action: REST_AGAIN_ACTION })
    const url = String(openWindow.mock.calls[0][0])

    expect(takeRestTimerLaunchAction(url.slice(url.indexOf('?')))).toBe(REST_AGAIN_ACTION)
  })
})

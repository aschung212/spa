/**
 * Pending "Rest Again" intent (LIFT-1355).
 *
 * Covers the cold-boot channel the service worker uses when no window is open —
 * the action arrives in the launch URL, is captured before `useTabRouting`
 * rewrites the URL away, and is consumed once by the rest-timer controller.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  captureRestTimerIntent,
  consumeRestAgain,
  requestRestAgain,
  restAgainPending,
  _resetRestTimerIntent,
} from '../restTimerIntent'

/** Point `window.location` at a URL and record replaceState rewrites. */
function stubLocation(href: string): { replaced: string[] } {
  const replaced: string[] = []
  const url = new URL(href)
  vi.spyOn(window, 'location', 'get').mockReturnValue({
    href: url.href,
    search: url.search,
    pathname: url.pathname,
    hash: url.hash,
  } as unknown as Location)
  vi.spyOn(window.history, 'replaceState').mockImplementation((_s, _t, next) => {
    replaced.push(String(next))
  })
  return { replaced }
}

describe('restTimerIntent', () => {
  beforeEach(() => {
    _resetRestTimerIntent()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-07T18:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    _resetRestTimerIntent()
  })

  describe('capture from the launch URL', () => {
    it('records a pending request from ?action=rest-again', () => {
      stubLocation('https://spa-rho-sandy.vercel.app/?tab=workouts&action=rest-again')

      expect(captureRestTimerIntent()).toBe(true)
      expect(restAgainPending.value).toBe(true)
    })

    it('strips its own param while preserving ?tab= for the router', () => {
      // useTabRouting reads ?tab= immediately after this and forces the Workouts
      // tab, which is what gets WorkoutTracker (and the controller) mounted.
      const { replaced } = stubLocation('https://spa-rho-sandy.vercel.app/?tab=workouts&action=rest-again')

      captureRestTimerIntent()

      expect(replaced).toEqual(['/?tab=workouts'])
    })

    it('leaves nothing behind when the action is the only param', () => {
      const { replaced } = stubLocation('https://spa-rho-sandy.vercel.app/?action=rest-again')

      captureRestTimerIntent()

      expect(replaced).toEqual(['/'])
    })

    it('ignores an unrelated or absent action and rewrites nothing', () => {
      const { replaced } = stubLocation('https://spa-rho-sandy.vercel.app/?tab=calendar&action=something-else')
      expect(captureRestTimerIntent()).toBe(false)

      stubLocation('https://spa-rho-sandy.vercel.app/?tab=workouts')
      expect(captureRestTimerIntent()).toBe(false)

      expect(restAgainPending.value).toBe(false)
      expect(replaced).toEqual([])
    })

    it('accepts an explicit search string', () => {
      stubLocation('https://spa-rho-sandy.vercel.app/')

      expect(captureRestTimerIntent('?action=rest-again')).toBe(true)
      expect(restAgainPending.value).toBe(true)
    })
  })

  describe('consumption', () => {
    it('is one-shot — a second read reports nothing pending', () => {
      requestRestAgain()

      expect(consumeRestAgain()).toBe(true)
      expect(restAgainPending.value).toBe(false)
      expect(consumeRestAgain()).toBe(false)
    })

    it('reports nothing when no request ever arrived', () => {
      expect(consumeRestAgain()).toBe(false)
    })

    it('still honours a request across a slow cold boot', () => {
      requestRestAgain()
      vi.advanceTimersByTime(90_000)

      expect(consumeRestAgain()).toBe(true)
    })

    it('goes stale rather than firing a rest the user has moved on from', () => {
      // e.g. a launch that landed on the auth gate and sat there. Without the
      // window, wandering back to the Workouts tab much later would start a rest
      // timer out of nowhere.
      requestRestAgain()
      vi.advanceTimersByTime(2 * 60 * 1000 + 1)

      expect(consumeRestAgain()).toBe(false)
    })

    it('clears a stale request so it cannot fire on a later mount', () => {
      requestRestAgain()
      vi.advanceTimersByTime(5 * 60 * 1000)

      expect(consumeRestAgain()).toBe(false)
      expect(restAgainPending.value).toBe(false)
    })
  })
})

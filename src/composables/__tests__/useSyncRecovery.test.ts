/**
 * Read-path recovery (LIFT-1226).
 *
 * Before this existed, a failed READ was terminal for the session: each store's
 * `_fetchFromSupabase` recorded `lastSyncError` and returned, and the only
 * reconnect signal in the app (App.vue's `online` listener) merely relabelled
 * the sync indicator. An offline cold start, a network blip, or a mid-session
 * token expiry therefore left the app on local-only data — and left the
 * reconciliation pushes that live inside `_fetchFromSupabase` parked — until a
 * full app relaunch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const fetchWorkout = vi.fn().mockResolvedValue(undefined)
const fetchBodyweight = vi.fn().mockResolvedValue(undefined)
const fetchPreferences = vi.fn().mockResolvedValue(undefined)
const fetchProgression = vi.fn().mockResolvedValue(undefined)

vi.mock('../../stores/workout', () => ({
  useWorkoutStore: () => ({ _fetchFromSupabase: fetchWorkout }),
}))
vi.mock('../../stores/bodyweight', () => ({
  useBodyweightStore: () => ({ _fetchFromSupabase: fetchBodyweight }),
}))
vi.mock('../../stores/preferences', () => ({
  usePreferencesStore: () => ({ _fetchFromSupabase: fetchPreferences }),
}))
vi.mock('../../stores/progression', () => ({
  useProgressionStore: () => ({ _fetchFromSupabase: fetchProgression }),
}))

const flush = vi.fn().mockResolvedValue(undefined)
const replayJournal = vi.fn().mockReturnValue(0)
vi.mock('../../lib/syncQueue', () => ({
  syncQueue: {
    flush: (...args: unknown[]) => flush(...args),
    replayJournal: (...args: unknown[]) => replayJournal(...args),
  },
}))

const logError = vi.fn()
vi.mock('../../lib/logger', () => ({
  logError: (...args: unknown[]) => logError(...args),
  logWarn: vi.fn(),
}))

vi.mock('../../lib/supabase', () => ({ supabase: null }))

import { refetchAllStores, setupSyncRecovery, _resetSyncRecovery, REFETCH_COOLDOWN_MS } from '../useSyncRecovery'
import { sessionRecoveryTick, _resetSessionHealth } from '../../lib/sessionHealth'

/** Let queued microtasks (the awaited fetches) settle. */
async function settle() {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

function setOnline(online: boolean) {
  Object.defineProperty(navigator, 'onLine', { value: online, configurable: true })
}

describe('useSyncRecovery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    _resetSyncRecovery()
    _resetSessionHealth()
    setOnline(true)
    for (const fn of [fetchWorkout, fetchBodyweight, fetchPreferences, fetchProgression, flush, replayJournal, logError]) {
      fn.mockClear()
    }
    for (const fn of [fetchWorkout, fetchBodyweight, fetchPreferences, fetchProgression]) {
      fn.mockResolvedValue(undefined)
    }
    flush.mockResolvedValue(undefined)
    replayJournal.mockReturnValue(0)
  })

  afterEach(() => {
    _resetSyncRecovery()
    vi.useRealTimers()
  })

  describe('refetchAllStores', () => {
    it('re-fetches all four stores', async () => {
      await expect(refetchAllStores('online')).resolves.toBe(true)
      expect(fetchWorkout).toHaveBeenCalledTimes(1)
      expect(fetchBodyweight).toHaveBeenCalledTimes(1)
      expect(fetchPreferences).toHaveBeenCalledTimes(1)
      expect(fetchProgression).toHaveBeenCalledTimes(1)
    })

    it('flushes pending writes BEFORE reading', async () => {
      // Ordering is load-bearing: every store read is remote-wins for the fields
      // it carries, so fetching ahead of a queued offline edit would paint the
      // stale server value back over it in the UI.
      const order: string[] = []
      flush.mockImplementation(async () => { order.push('flush') })
      fetchWorkout.mockImplementation(async () => { order.push('fetch') })

      await refetchAllStores('online')

      expect(order).toEqual(['flush', 'fetch'])
    })

    it('replays stranded journal writes BEFORE flushing, and both before reading (LIFT-1322)', async () => {
      // A write whose retries exhausted mid-session has already left the queue,
      // so flushing alone drains an empty queue and the backlog stays stranded
      // until the next cold start. Replay has to re-arm it first — and the
      // whole write half still has to precede the remote-wins reads.
      const order: string[] = []
      replayJournal.mockImplementation(() => { order.push('replay'); return 1 })
      flush.mockImplementation(async () => { order.push('flush') })
      fetchWorkout.mockImplementation(async () => { order.push('fetch') })

      await refetchAllStores('online')

      expect(order).toEqual(['replay', 'flush', 'fetch'])
    })

    it('still flushes and re-fetches when the journal replay throws', async () => {
      // The flush is the load-bearing half; a broken replay must not suppress it.
      replayJournal.mockImplementation(() => { throw new Error('journal broke') })

      await expect(refetchAllStores('online')).resolves.toBe(true)

      expect(flush).toHaveBeenCalledTimes(1)
      expect(fetchWorkout).toHaveBeenCalledTimes(1)
      expect(logError).toHaveBeenCalled()
    })

    it('still re-fetches when the queue flush fails', async () => {
      flush.mockRejectedValue(new Error('write failed'))

      await expect(refetchAllStores('online')).resolves.toBe(true)

      expect(fetchWorkout).toHaveBeenCalledTimes(1)
      expect(logError).toHaveBeenCalled()
    })

    it('does not let one store rejecting abort the others', async () => {
      fetchWorkout.mockRejectedValue(new Error('boom'))

      await expect(refetchAllStores('online')).resolves.toBe(true)

      expect(fetchBodyweight).toHaveBeenCalledTimes(1)
      expect(fetchPreferences).toHaveBeenCalledTimes(1)
      expect(fetchProgression).toHaveBeenCalledTimes(1)
      expect(logError).toHaveBeenCalled()
    })

    it('reports rather than leaks an unhandled rejection when the run itself breaks', async () => {
      // Callers are fire-and-forget listeners, so a rejected promise here would
      // land on the global unhandledrejection floor instead of anywhere useful.
      const unhandled = vi.fn()
      window.addEventListener('unhandledrejection', unhandled)
      // Promise.allSettled itself rejecting is the shape of "the machinery
      // around the fetches broke" (e.g. no active Pinia when a store is
      // acquired) — simulate it with a non-thenable return.
      fetchWorkout.mockImplementation(() => { throw new Error('no active pinia') })

      await expect(refetchAllStores('online')).resolves.toBe(false)
      await settle()

      expect(logError).toHaveBeenCalled()
      expect(unhandled).not.toHaveBeenCalled()
      window.removeEventListener('unhandledrejection', unhandled)
    })

    it('is a no-op while the device is offline', async () => {
      setOnline(false)

      await expect(refetchAllStores('resume')).resolves.toBe(false)

      expect(replayJournal).not.toHaveBeenCalled()
      expect(flush).not.toHaveBeenCalled()
      expect(fetchWorkout).not.toHaveBeenCalled()
    })

    it('collapses overlapping triggers into a single in-flight run', async () => {
      let release!: () => void
      fetchWorkout.mockImplementation(() => new Promise<void>(r => { release = () => r() }))

      const first = refetchAllStores('online')
      await settle()
      const second = await refetchAllStores('resume')

      expect(second).toBe(false)
      expect(fetchWorkout).toHaveBeenCalledTimes(1)
      release()
      await expect(first).resolves.toBe(true)
    })

    it('rate-limits repeat triggers to one run per cooldown window', async () => {
      await refetchAllStores('resume')
      expect(fetchWorkout).toHaveBeenCalledTimes(1)

      // A resume fires visibilitychange AND focus; a flaky link re-fires online.
      await expect(refetchAllStores('resume')).resolves.toBe(false)
      vi.advanceTimersByTime(REFETCH_COOLDOWN_MS - 1)
      await expect(refetchAllStores('resume')).resolves.toBe(false)
      expect(fetchWorkout).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(1)
      await expect(refetchAllStores('resume')).resolves.toBe(true)
      expect(fetchWorkout).toHaveBeenCalledTimes(2)
    })

    it('defers (does not drop) a session-recovered trigger blocked by the cooldown', async () => {
      // The recovery sequence is: read 401s -> ensureFreshSession() succeeds ->
      // tick. That tick always lands inside the cooldown of the very read that
      // failed, so dropping it would strand exactly the data it exists to
      // re-fetch.
      await refetchAllStores('resume')
      expect(fetchWorkout).toHaveBeenCalledTimes(1)

      await expect(refetchAllStores('session-recovered')).resolves.toBe(false)
      expect(fetchWorkout).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(REFETCH_COOLDOWN_MS)
      await settle()

      expect(fetchWorkout).toHaveBeenCalledTimes(2)
    })

    it('does not stack multiple trailing re-runs for a burst of session ticks', async () => {
      await refetchAllStores('resume')
      await refetchAllStores('session-recovered')
      await refetchAllStores('session-recovered')
      await refetchAllStores('session-recovered')

      await vi.advanceTimersByTimeAsync(REFETCH_COOLDOWN_MS * 2)
      await settle()

      expect(fetchWorkout).toHaveBeenCalledTimes(2)
    })
  })

  describe('setupSyncRecovery', () => {
    let teardown: (() => void) | null = null

    afterEach(() => {
      teardown?.()
      teardown = null
    })

    it('re-fetches when the connection returns', async () => {
      teardown = setupSyncRecovery()

      window.dispatchEvent(new Event('online'))
      await settle()

      expect(fetchWorkout).toHaveBeenCalledTimes(1)
    })

    it('re-fetches when the app returns to the foreground', async () => {
      teardown = setupSyncRecovery()

      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
      await settle()

      expect(fetchWorkout).toHaveBeenCalledTimes(1)
    })

    it('re-fetches on a pageshow resume (LIFT-1392)', async () => {
      // The WKWebView case LIFT-784 exists for: the page was evicted while the
      // app was backgrounded and comes back as a `pageshow`. `useAuth` has
      // listened for it since that incident; this module claimed parity in its
      // doc comment and registered only `visibilitychange` + `focus`, so the
      // token was refreshed and all four stores stayed on stale data until some
      // later signal happened along.
      teardown = setupSyncRecovery()

      window.dispatchEvent(new Event('pageshow'))
      await settle()

      expect(fetchWorkout).toHaveBeenCalledTimes(1)
    })

    it('ignores a background (hidden) visibility change', async () => {
      teardown = setupSyncRecovery()

      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
      await settle()

      expect(fetchWorkout).not.toHaveBeenCalled()
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    })

    it('re-fetches when a broken session is healed', async () => {
      teardown = setupSyncRecovery()

      sessionRecoveryTick.value++
      await settle()

      expect(fetchWorkout).toHaveBeenCalledTimes(1)
    })

    it('stops listening after teardown', async () => {
      const stop = setupSyncRecovery()
      stop()

      window.dispatchEvent(new Event('online'))
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event('pageshow'))
      document.dispatchEvent(new Event('visibilitychange'))
      sessionRecoveryTick.value++
      await settle()

      expect(fetchWorkout).not.toHaveBeenCalled()
    })
  })
})

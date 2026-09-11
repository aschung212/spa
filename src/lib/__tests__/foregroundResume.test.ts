/**
 * The shared foreground-resume signal set (LIFT-1392).
 *
 * The bug this closes was not a broken listener — it was a MISSING one. Two
 * modules hand-rolled "the app came back to the foreground" and one of them
 * registered two of the three events while its comment claimed all three, so a
 * WKWebView resume that arrives only as `pageshow` reached the token refresh and
 * never reached the read-path recovery. These tests pin the whole set, because a
 * subset is exactly what shipped.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { onForegroundResume } from '../foregroundResume'

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
}

describe('onForegroundResume', () => {
  let teardown: (() => void) | null = null

  beforeEach(() => {
    setVisibility('visible')
  })

  afterEach(() => {
    teardown?.()
    teardown = null
    setVisibility('visible')
  })

  it.each([
    ['visibilitychange', () => document.dispatchEvent(new Event('visibilitychange'))],
    ['focus', () => window.dispatchEvent(new Event('focus'))],
    ['pageshow', () => window.dispatchEvent(new Event('pageshow'))],
  ])('resumes on %s', (_name, fire) => {
    const onResume = vi.fn()
    teardown = onForegroundResume(onResume)

    fire()

    expect(onResume).toHaveBeenCalledTimes(1)
  })

  it('does not resume on a visibility change to hidden', () => {
    const onResume = vi.fn()
    teardown = onForegroundResume(onResume)

    setVisibility('hidden')
    document.dispatchEvent(new Event('visibilitychange'))

    expect(onResume).not.toHaveBeenCalled()
  })

  it('reports the hide edge only from visibilitychange', () => {
    // `focus`/`pageshow` are show-only signals, so a consumer pairing resume
    // with a pause (supabase-js's stopAutoRefresh) gets one hide per hide.
    const onHide = vi.fn()
    teardown = onForegroundResume(vi.fn(), { onHide })

    setVisibility('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('pageshow'))

    expect(onHide).toHaveBeenCalledTimes(1)
  })

  it('does not require an onHide handler', () => {
    const onResume = vi.fn()
    teardown = onForegroundResume(onResume)

    setVisibility('hidden')
    expect(() => document.dispatchEvent(new Event('visibilitychange'))).not.toThrow()
  })

  it('runs immediately for a page that is already in the foreground', () => {
    // No event is coming for a session that never left, so a consumer arming a
    // timer on resume would otherwise stay disarmed for the whole first visit.
    const onResume = vi.fn()
    teardown = onForegroundResume(onResume, { immediate: true })

    expect(onResume).toHaveBeenCalledTimes(1)
  })

  it('does not run immediately while the page is hidden', () => {
    setVisibility('hidden')
    const onResume = vi.fn()
    teardown = onForegroundResume(onResume, { immediate: true })

    expect(onResume).not.toHaveBeenCalled()
  })

  it('does not run immediately unless asked', () => {
    const onResume = vi.fn()
    teardown = onForegroundResume(onResume)

    expect(onResume).not.toHaveBeenCalled()
  })

  it('removes every listener on teardown', () => {
    const onResume = vi.fn()
    const onHide = vi.fn()
    const stop = onForegroundResume(onResume, { onHide })

    stop()

    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('pageshow'))
    document.dispatchEvent(new Event('visibilitychange'))
    setVisibility('hidden')
    document.dispatchEvent(new Event('visibilitychange'))

    expect(onResume).not.toHaveBeenCalled()
    expect(onHide).not.toHaveBeenCalled()
  })
})

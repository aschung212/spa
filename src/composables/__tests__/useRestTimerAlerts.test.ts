import { describe, it, expect, beforeEach } from 'vitest'
import { getLocalStorageMock } from '../../__tests__/helpers'
import { useRestTimerAlerts, DEFAULT_WARNING_OPTIONS } from '../useRestTimerAlerts'

const localStorageMock = getLocalStorageMock()

describe('useRestTimerAlerts', () => {
  beforeEach(() => {
    localStorageMock.clear()
    localStorageMock.setItem.mockClear()
  })

  it('defaults warning options and a single 5s warning time', () => {
    const a = useRestTimerAlerts()
    expect(a.warningOptions.value).toEqual(DEFAULT_WARNING_OPTIONS)
    expect(a.warningTimes.value).toEqual([5])
    expect(a.maxWarning.value).toBe(5)
  })

  it('maxWarning reflects the largest active warning time, 0 when none', () => {
    const a = useRestTimerAlerts()
    a.warningTimes.value = [3, 10, 5]
    expect(a.maxWarning.value).toBe(10)
    a.warningTimes.value = []
    expect(a.maxWarning.value).toBe(0)
  })

  it('toggles a warning time on and off, persisting each change', () => {
    const a = useRestTimerAlerts()
    a.toggleWarningTime(10)
    expect(a.warningTimes.value).toContain(10)
    expect(localStorageMock.setItem).toHaveBeenCalledWith('rest-warnings', JSON.stringify(a.warningTimes.value))
    a.toggleWarningTime(10)
    expect(a.warningTimes.value).not.toContain(10)
  })

  it('clears all warning times when toggling 0', () => {
    const a = useRestTimerAlerts()
    a.warningTimes.value = [3, 5, 10]
    a.toggleWarningTime(0)
    expect(a.warningTimes.value).toEqual([])
  })

  it('adds a valid warning option sorted, and clears the input', () => {
    const a = useRestTimerAlerts()
    a.newWarningValue.value = 7
    a.addWarningOption()
    expect(a.warningOptions.value).toContain(7)
    expect(a.warningOptions.value).toEqual([...a.warningOptions.value].sort((x, y) => x - y))
    expect(a.newWarningValue.value).toBeNull()
  })

  it('rejects out-of-range or duplicate warning options', () => {
    const a = useRestTimerAlerts()
    const before = [...a.warningOptions.value]
    a.newWarningValue.value = 0
    a.addWarningOption()
    a.newWarningValue.value = 121
    a.addWarningOption()
    a.newWarningValue.value = before[0]
    a.addWarningOption()
    expect(a.warningOptions.value).toEqual(before)
  })

  it('removing a warning option also removes it from active warning times', () => {
    const a = useRestTimerAlerts()
    a.warningTimes.value = [3, 5]
    a.removeWarningOption(5)
    expect(a.warningOptions.value).not.toContain(5)
    expect(a.warningTimes.value).not.toContain(5)
  })

  it('refuses to remove the last warning option', () => {
    const a = useRestTimerAlerts()
    a.warningOptions.value = [5]
    a.removeWarningOption(5)
    expect(a.warningOptions.value).toEqual([5])
  })

  it('resets warning options and times to defaults', () => {
    const a = useRestTimerAlerts()
    a.warningOptions.value = [99]
    a.warningTimes.value = [99]
    a.resetToDefaults()
    expect(a.warningOptions.value).toEqual(DEFAULT_WARNING_OPTIONS)
    expect(a.warningTimes.value).toEqual([5])
  })

  it('audio methods are no-ops when the context was never unlocked', () => {
    const a = useRestTimerAlerts()
    // No ensureAudio() call → no AudioContext → these must not throw.
    expect(() => a.playWarningBeep(5)).not.toThrow()
    expect(() => a.playGoBeep()).not.toThrow()
  })

  it('degrades to silence when the platform has no AudioContext', () => {
    // startRestTimer calls ensureAudio, and since LIFT-1355 it can run during
    // WorkoutTracker's setup (a pending "Rest Again" intent at mount) — where an
    // escaping error takes down the Workouts tab rather than one event handler.
    const original = globalThis.AudioContext
    // @ts-expect-error simulate a platform without Web Audio
    delete globalThis.AudioContext
    try {
      const a = useRestTimerAlerts()
      expect(() => a.ensureAudio()).not.toThrow()
      expect(() => a.playGoBeep()).not.toThrow()
    } finally {
      globalThis.AudioContext = original
    }
  })
})

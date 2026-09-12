import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { getLocalStorageMock } from '../../__tests__/helpers'

// ── useNotification is mocked so we can observe the notify / background-tracker
//    side effects without touching the real Notification / ServiceWorker APIs.
const notifMocks = vi.hoisted(() => ({
  notify: vi.fn().mockResolvedValue(true),
  requestPermission: vi.fn().mockResolvedValue(true),
  startTracking: vi.fn(),
  stopTracking: vi.fn(),
  wasBackgrounded: { value: false },
}))

// The controller used to register a service-worker "message" listener here with a
// paired onUnmounted cleanup, which needed `onUnmounted` stubbed so the bare
// (non-component) makeController calls in this suite didn't warn. That listener
// moved to `useRestTimerIntent` in LIFT-1355 — it fired too late to be useful on a
// cold start — and the controller now registers no lifecycle hooks of its own.

vi.mock('../useNotification', () => ({
  REST_TIMER_NOTIFICATION_ACTIONS: [
    { action: 'rest-again', title: 'Rest Again' },
    { action: 'log-set', title: 'Log Set' },
  ],
  useNotification: () => ({
    notify: notifMocks.notify,
    requestPermission: notifMocks.requestPermission,
  }),
  useBackgroundTracker: () => ({
    wasBackgrounded: notifMocks.wasBackgrounded,
    startTracking: notifMocks.startTracking,
    stopTracking: notifMocks.stopTracking,
  }),
}))

const { useRestTimerController, formatDuration } = await import('../useRestTimerController')
const { usePreferencesStore } = await import('../../stores/preferences')

const localStorageMock = getLocalStorageMock()

// ── AudioContext stub — the controller unlocks / beeps through the Web Audio
//    API, which happy-dom does not provide.
function stubAudioContext() {
  const osc = {
    connect: vi.fn(),
    frequency: { value: 0, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
    start: vi.fn(),
    stop: vi.fn(),
  }
  const gain = {
    connect: vi.fn(),
    gain: { value: 0, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
  }
  vi.stubGlobal('AudioContext', class {
    state = 'running'
    currentTime = 0
    destination = {}
    resume = vi.fn()
    createOscillator = vi.fn(() => osc)
    createGain = vi.fn(() => gain)
  })
}

type Controller = ReturnType<typeof useRestTimerController>

function makeController(): {
  ctrl: Controller
  onComplete: ReturnType<typeof vi.fn>
  showUndo: ReturnType<typeof vi.fn>
} {
  const onComplete = vi.fn()
  const showUndo = vi.fn()
  const ctrl = useRestTimerController(onComplete, showUndo)
  return { ctrl, onComplete, showUndo }
}

describe('useRestTimerController', () => {
  beforeEach(() => {
    localStorageMock.clear()
    localStorageMock.setItem.mockClear()
    setActivePinia(createPinia())
    stubAudioContext()
    notifMocks.notify.mockClear()
    notifMocks.requestPermission.mockClear()
    notifMocks.startTracking.mockClear()
    notifMocks.stopTracking.mockClear()
    notifMocks.wasBackgrounded.value = false
  })

  describe('formatDuration', () => {
    it('renders sub-minute values as seconds', () => {
      expect(formatDuration(45)).toBe('45s')
      expect(formatDuration(5)).toBe('5s')
    })

    it('renders whole minutes without seconds', () => {
      expect(formatDuration(60)).toBe('1m')
      expect(formatDuration(180)).toBe('3m')
    })

    it('renders mixed minutes and zero-padded seconds', () => {
      expect(formatDuration(90)).toBe('1:30')
      expect(formatDuration(125)).toBe('2:05')
    })

    it('is also exposed on the controller', () => {
      const { ctrl } = makeController()
      expect(ctrl.formatDuration(90)).toBe('1:30')
    })
  })

  describe('initial state', () => {
    it('starts idle', () => {
      const { ctrl } = makeController()
      expect(ctrl.timerActive.value).toBe(false)
      expect(ctrl.timerPaused.value).toBe(false)
      expect(ctrl.timerSeconds.value).toBe(0)
      expect(ctrl.timerStopping.value).toBe(false)
    })

    it('defaults restDuration to 90 when nothing is stored', () => {
      const { ctrl } = makeController()
      expect(ctrl.restDuration.value).toBe(90)
    })

    it('loads restDuration from localStorage', () => {
      localStorageMock.setItem('rest-duration', '120')
      const { ctrl } = makeController()
      expect(ctrl.restDuration.value).toBe(120)
    })

    it('defaults presets and warnings when storage is empty', () => {
      const { ctrl } = makeController()
      expect(ctrl.restPresets.value).toEqual([30, 60, 90, 120, 180, 300])
      expect(ctrl.disabledPresets.value).toEqual([])
      expect(ctrl.warningOptions.value).toEqual([3, 5, 10, 15, 30])
      expect(ctrl.warningTimes.value).toEqual([5])
    })

    it('loads and sorts stored presets', () => {
      localStorageMock.setItem('rest-presets', JSON.stringify([120, 30, 60]))
      const { ctrl } = makeController()
      expect(ctrl.restPresets.value).toEqual([30, 60, 120])
    })

    it('falls back to defaults when stored presets are not an array', () => {
      localStorageMock.setItem('rest-presets', JSON.stringify({ bad: true }))
      const { ctrl } = makeController()
      expect(ctrl.restPresets.value).toEqual([30, 60, 90, 120, 180, 300])
    })
  })

  describe('computed display state', () => {
    it('formats timerDisplay as m:ss', () => {
      const { ctrl } = makeController()
      ctrl.timerSeconds.value = 90
      expect(ctrl.timerDisplay.value).toBe('1:30')
      ctrl.timerSeconds.value = 5
      expect(ctrl.timerDisplay.value).toBe('0:05')
    })

    it('reports timerProgress as remaining / duration', () => {
      const { ctrl } = makeController()
      ctrl.restDuration.value = 100
      ctrl.timerSeconds.value = 25
      expect(ctrl.timerProgress.value).toBe(0.25)
    })

    it('reports zero progress when duration is non-positive', () => {
      const { ctrl } = makeController()
      ctrl.restDuration.value = 0
      ctrl.timerSeconds.value = 10
      expect(ctrl.timerProgress.value).toBe(0)
    })

    it('marks the timer urgent only within the max warning window', () => {
      const { ctrl } = makeController()
      // default warning [5]
      ctrl.timerSeconds.value = 5
      expect(ctrl.timerUrgent.value).toBe(true)
      ctrl.timerSeconds.value = 6
      expect(ctrl.timerUrgent.value).toBe(false)
      ctrl.timerSeconds.value = 0
      expect(ctrl.timerUrgent.value).toBe(false)
    })

    it('is never urgent when all warnings are disabled', () => {
      const { ctrl } = makeController()
      ctrl.warningTimes.value = []
      ctrl.timerSeconds.value = 1
      expect(ctrl.timerUrgent.value).toBe(false)
    })

    it('excludes disabled presets from visiblePresets', () => {
      const { ctrl } = makeController()
      ctrl.disabledPresets.value = [60, 120]
      expect(ctrl.visiblePresets.value).toEqual([30, 90, 180, 300])
    })
  })

  describe('preset management', () => {
    it('adds a valid preset, sorted and persisted', () => {
      const { ctrl } = makeController()
      ctrl.newPresetValue.value = 45
      ctrl.addPreset()
      expect(ctrl.restPresets.value).toEqual([30, 45, 60, 90, 120, 180, 300])
      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        'rest-presets',
        JSON.stringify([30, 45, 60, 90, 120, 180, 300]),
      )
      expect(ctrl.newPresetValue.value).toBeNull()
    })

    it('rejects out-of-range and duplicate presets', () => {
      const { ctrl } = makeController()
      ctrl.newPresetValue.value = 4 // below 5
      ctrl.addPreset()
      ctrl.newPresetValue.value = 601 // above 600
      ctrl.addPreset()
      ctrl.newPresetValue.value = 60 // duplicate
      ctrl.addPreset()
      expect(ctrl.restPresets.value).toEqual([30, 60, 90, 120, 180, 300])
    })

    it('does nothing when newPresetValue is null', () => {
      const { ctrl } = makeController()
      ctrl.newPresetValue.value = null
      ctrl.addPreset()
      expect(ctrl.restPresets.value).toEqual([30, 60, 90, 120, 180, 300])
    })

    it('removes a preset and persists', () => {
      const { ctrl } = makeController()
      ctrl.removePreset(60)
      expect(ctrl.restPresets.value).toEqual([30, 90, 120, 180, 300])
    })

    it('refuses to remove the last remaining preset', () => {
      const { ctrl } = makeController()
      ctrl.restPresets.value = [90]
      ctrl.removePreset(90)
      expect(ctrl.restPresets.value).toEqual([90])
    })

    it('reassigns restDuration when the active preset is removed', () => {
      const { ctrl } = makeController()
      ctrl.setRestDuration(60)
      expect(ctrl.restDuration.value).toBe(60)
      ctrl.removePreset(60)
      expect(ctrl.restDuration.value).toBe(ctrl.restPresets.value[0])
    })

    it('toggles a preset disabled and back, persisting each time', () => {
      const { ctrl } = makeController()
      ctrl.togglePresetEnabled(60)
      expect(ctrl.disabledPresets.value).toContain(60)
      expect(ctrl.visiblePresets.value).not.toContain(60)
      ctrl.togglePresetEnabled(60)
      expect(ctrl.disabledPresets.value).not.toContain(60)
    })

    it('refuses to disable the last visible preset', () => {
      const { ctrl } = makeController()
      ctrl.restPresets.value = [30, 60]
      ctrl.disabledPresets.value = [60]
      ctrl.togglePresetEnabled(30)
      expect(ctrl.disabledPresets.value).toEqual([60])
    })
  })

  describe('warning management', () => {
    it('toggles a warning time on and off', () => {
      const { ctrl } = makeController()
      ctrl.toggleWarningTime(10)
      expect(ctrl.warningTimes.value).toEqual([5, 10])
      ctrl.toggleWarningTime(5)
      expect(ctrl.warningTimes.value).toEqual([10])
    })

    it('clears all warnings when toggling 0', () => {
      const { ctrl } = makeController()
      ctrl.toggleWarningTime(0)
      expect(ctrl.warningTimes.value).toEqual([])
      expect(localStorageMock.setItem).toHaveBeenCalledWith('rest-warnings', '[]')
    })

    it('adds a valid warning option, rejecting range and duplicates', () => {
      const { ctrl } = makeController()
      ctrl.newWarningValue.value = 20
      ctrl.addWarningOption()
      expect(ctrl.warningOptions.value).toEqual([3, 5, 10, 15, 20, 30])
      expect(ctrl.newWarningValue.value).toBeNull()

      ctrl.newWarningValue.value = 0 // below 1
      ctrl.addWarningOption()
      ctrl.newWarningValue.value = 121 // above 120
      ctrl.addWarningOption()
      ctrl.newWarningValue.value = 5 // duplicate
      ctrl.addWarningOption()
      expect(ctrl.warningOptions.value).toEqual([3, 5, 10, 15, 20, 30])
    })

    it('removes a warning option and drops it from active warnings', () => {
      const { ctrl } = makeController()
      ctrl.toggleWarningTime(10) // active [5, 10]
      ctrl.removeWarningOption(10)
      expect(ctrl.warningOptions.value).not.toContain(10)
      expect(ctrl.warningTimes.value).toEqual([5])
    })

    it('refuses to remove the last warning option', () => {
      const { ctrl } = makeController()
      ctrl.warningOptions.value = [5]
      ctrl.removeWarningOption(5)
      expect(ctrl.warningOptions.value).toEqual([5])
    })

    it('resets presets, options, and warnings to defaults', () => {
      const { ctrl } = makeController()
      ctrl.restPresets.value = [15]
      ctrl.warningOptions.value = [1]
      ctrl.warningTimes.value = [1]
      ctrl.resetAllDefaults()
      expect(ctrl.restPresets.value).toEqual([30, 60, 90, 120, 180, 300])
      expect(ctrl.warningOptions.value).toEqual([3, 5, 10, 15, 30])
      expect(ctrl.warningTimes.value).toEqual([5])
    })
  })

  describe('timer lifecycle', () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: false })
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('starts the timer at the full duration', () => {
      const { ctrl } = makeController()
      ctrl.setRestDuration(90)
      const start = Date.now()
      vi.setSystemTime(start)
      ctrl.startRestTimer()
      expect(ctrl.timerActive.value).toBe(true)
      expect(ctrl.timerPaused.value).toBe(false)
      expect(ctrl.timerSeconds.value).toBe(90)
      expect(ctrl.timerAnnouncement.value).toContain('Rest timer started')
    })

    it('counts down using wall-clock time', () => {
      const { ctrl } = makeController()
      ctrl.setRestDuration(90)
      const start = Date.now()
      vi.setSystemTime(start)
      ctrl.startRestTimer()

      vi.setSystemTime(start + 30_000)
      vi.advanceTimersByTime(250)
      expect(ctrl.timerSeconds.value).toBe(60)
    })

    it('fires the warning announcement as the timer crosses a warning time', () => {
      const { ctrl } = makeController()
      ctrl.setRestDuration(10)
      const start = Date.now()
      vi.setSystemTime(start)
      ctrl.startRestTimer()

      vi.setSystemTime(start + 6_000) // 4s remaining, crosses the 5s warning
      vi.advanceTimersByTime(250)
      expect(ctrl.timerSeconds.value).toBe(4)
      expect(ctrl.timerAnnouncement.value).toBe('5 seconds remaining')
    })

    it('completes at zero: announces, notifies, stops tracking, and calls onComplete', () => {
      const { ctrl, onComplete } = makeController()
      ctrl.setRestDuration(90)
      const start = Date.now()
      vi.setSystemTime(start)
      ctrl.startRestTimer()

      vi.setSystemTime(start + 91_000)
      vi.advanceTimersByTime(250)
      expect(ctrl.timerSeconds.value).toBe(0)
      expect(ctrl.timerAnnouncement.value).toBe('Rest timer done')
      expect(onComplete).toHaveBeenCalledOnce()
      expect(notifMocks.notify).toHaveBeenCalledOnce()
      expect(notifMocks.stopTracking).toHaveBeenCalled()
    })

    it('attaches Rest Again / Log Set action buttons to the completion notification (LIFT-751)', () => {
      const { ctrl } = makeController()
      ctrl.setRestDuration(90)
      const start = Date.now()
      vi.setSystemTime(start)
      ctrl.startRestTimer()

      vi.setSystemTime(start + 91_000)
      vi.advanceTimersByTime(250)

      expect(notifMocks.notify).toHaveBeenCalledWith('Rest Complete', expect.objectContaining({
        actions: [
          { action: 'rest-again', title: 'Rest Again' },
          { action: 'log-set', title: 'Log Set' },
        ],
      }))
    })

    it('does not call onComplete while editing presets', () => {
      const { ctrl, onComplete } = makeController()
      ctrl.setRestDuration(90)
      const start = Date.now()
      vi.setSystemTime(start)
      ctrl.startRestTimer()
      ctrl.editingPresets.value = true

      vi.setSystemTime(start + 91_000)
      vi.advanceTimersByTime(250)
      expect(ctrl.timerSeconds.value).toBe(0)
      expect(onComplete).not.toHaveBeenCalled()
    })

    it('suppresses the completion notification when the flag is off', () => {
      const prefs = usePreferencesStore()
      prefs.experience.restTimerNotification = false
      const { ctrl } = makeController()
      ctrl.setRestDuration(90)
      const start = Date.now()
      vi.setSystemTime(start)
      ctrl.startRestTimer()

      vi.setSystemTime(start + 91_000)
      vi.advanceTimersByTime(250)
      expect(notifMocks.notify).not.toHaveBeenCalled()
    })

    it('pauses and resumes without losing remaining time', () => {
      const { ctrl } = makeController()
      ctrl.setRestDuration(90)
      const start = Date.now()
      vi.setSystemTime(start)
      ctrl.startRestTimer()

      vi.setSystemTime(start + 30_000)
      vi.advanceTimersByTime(250)
      expect(ctrl.timerSeconds.value).toBe(60)

      // Pause — remaining freezes at 60 even as wall-clock advances
      ctrl.togglePause()
      expect(ctrl.timerPaused.value).toBe(true)
      vi.setSystemTime(start + 50_000)
      vi.advanceTimersByTime(250)
      expect(ctrl.timerSeconds.value).toBe(60)

      // Resume — the remaining 60s picks up from the new "now"
      ctrl.togglePause()
      expect(ctrl.timerPaused.value).toBe(false)
      vi.setSystemTime(start + 60_000) // 10s after resume
      vi.advanceTimersByTime(250)
      expect(ctrl.timerSeconds.value).toBe(50)
    })

    it('stopTimer resets state and closes the preset editor', () => {
      const { ctrl } = makeController()
      ctrl.setRestDuration(90)
      ctrl.startRestTimer()
      ctrl.editingPresets.value = true
      ctrl.newPresetValue.value = 45

      ctrl.stopTimer()
      expect(ctrl.timerActive.value).toBe(false)
      expect(ctrl.timerPaused.value).toBe(false)
      expect(ctrl.timerSeconds.value).toBe(0)
      expect(ctrl.editingPresets.value).toBe(false)
      expect(ctrl.newPresetValue.value).toBeNull()
      // timerStopping flips true then back to false on the next tick
      expect(ctrl.timerStopping.value).toBe(true)
      vi.advanceTimersByTime(0)
      expect(ctrl.timerStopping.value).toBe(false)
    })

    it('restartTimer refills the remaining time and unpauses', () => {
      const { ctrl } = makeController()
      ctrl.setRestDuration(90)
      const start = Date.now()
      vi.setSystemTime(start)
      ctrl.startRestTimer()

      vi.setSystemTime(start + 40_000)
      vi.advanceTimersByTime(250)
      expect(ctrl.timerSeconds.value).toBe(50)

      ctrl.togglePause()
      vi.setSystemTime(start + 45_000)
      ctrl.restartTimer()
      expect(ctrl.timerPaused.value).toBe(false)
      expect(ctrl.timerSeconds.value).toBe(90)
    })

    it('setRestDuration updates, persists, and restarts the countdown', () => {
      const { ctrl } = makeController()
      const start = Date.now()
      vi.setSystemTime(start)
      ctrl.setRestDuration(120)
      expect(ctrl.restDuration.value).toBe(120)
      expect(ctrl.timerSeconds.value).toBe(120)
      expect(localStorageMock.setItem).toHaveBeenCalledWith('rest-duration', '120')

      vi.setSystemTime(start + 20_000)
      vi.advanceTimersByTime(250)
      expect(ctrl.timerSeconds.value).toBe(100)
    })
  })

  describe('disableRestTimer', () => {
    it('disables the timer, runs onDisable, and offers an undo', () => {
      const prefs = usePreferencesStore()
      prefs.setRestTimer(true)
      const { ctrl, showUndo } = makeController()
      const onDisable = vi.fn()
      const onRestore = vi.fn()

      ctrl.disableRestTimer(onDisable, onRestore)
      expect(prefs.restTimerEnabled).toBe(false)
      expect(onDisable).toHaveBeenCalledOnce()
      expect(showUndo).toHaveBeenCalledOnce()
      expect(showUndo.mock.calls[0][0]).toBe('Rest timer disabled')
    })

    it('restores an active timer when undo is invoked', () => {
      vi.useFakeTimers({ shouldAdvanceTime: false })
      try {
        const prefs = usePreferencesStore()
        prefs.setRestTimer(true)
        const { ctrl, showUndo } = makeController()
        ctrl.setRestDuration(90)
        ctrl.startRestTimer()
        ctrl.timerSeconds.value = 42

        const onDisable = vi.fn()
        const onRestore = vi.fn()
        ctrl.disableRestTimer(onDisable, onRestore)
        expect(prefs.restTimerEnabled).toBe(false)

        // Invoke the undo callback that the controller handed to showUndo
        const undo = showUndo.mock.calls[0][1] as () => void
        undo()
        expect(prefs.restTimerEnabled).toBe(true)
        expect(ctrl.timerActive.value).toBe(true)
        expect(ctrl.timerSeconds.value).toBe(42)
        expect(onRestore).toHaveBeenCalledOnce()
      } finally {
        vi.useRealTimers()
      }
    })
  })

  // The "rest-again" service-worker action moved out of the controller in
  // LIFT-1355 — a listener registered in WorkoutTracker's setup does not exist
  // yet on the cold start the action is tapped from. Its behaviour (including the
  // disabled-preference guard these tests covered) now lives in
  // useRestTimerIntent.test.ts, alongside the launch-URL channel that replaced it.
})

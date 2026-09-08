import { ref, computed, watch, type Ref, type ComputedRef } from 'vue'
import { usePreferencesStore } from '../stores/preferences'
import { restAgainPending, consumeRestAgain } from '../lib/restTimerIntent'
import { useNotification, useBackgroundTracker, REST_TIMER_NOTIFICATION_ACTIONS } from './useNotification'
import { useRestTimer } from './useRestTimer'
import { useRestTimerPresets } from './useRestTimerPresets'
import { useRestTimerAlerts } from './useRestTimerAlerts'

function formatTimerAnnouncement(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  if (m > 0 && s > 0) return `${m} minute${m > 1 ? 's' : ''} ${s} second${s !== 1 ? 's' : ''}`
  if (m > 0) return `${m} minute${m > 1 ? 's' : ''}`
  return `${s} second${s !== 1 ? 's' : ''}`
}

export function formatDuration(s: number): string {
  if (s < 60) return s + 's'
  const m = Math.floor(s / 60)
  const rem = s % 60
  return rem ? `${m}:${rem.toString().padStart(2, '0')}` : `${m}m`
}

export interface RestTimerController {
  // Reactive state
  timerActive: Ref<boolean>
  timerPaused: Ref<boolean>
  timerSeconds: Ref<number>
  timerStopping: Ref<boolean>
  timerAnnouncement: Ref<string>
  timerDisplay: ComputedRef<string>
  timerProgress: ComputedRef<number>
  timerUrgent: ComputedRef<boolean>
  restDuration: Ref<number>
  editingPresets: Ref<boolean>
  editTab: Ref<'rest' | 'alerts'>
  newPresetValue: Ref<number | null>
  newWarningValue: Ref<number | null>
  restPresets: Ref<number[]>
  disabledPresets: Ref<number[]>
  visiblePresets: ComputedRef<number[]>
  warningOptions: Ref<number[]>
  warningTimes: Ref<number[]>
  presetInputEl: Ref<HTMLInputElement | null>

  // Methods
  startRestTimer: () => void
  stopTimer: () => void
  restartTimer: () => void
  togglePause: () => void
  setRestDuration: (val: number) => void
  addPreset: () => void
  removePreset: (val: number) => void
  togglePresetEnabled: (val: number) => void
  resetAllDefaults: () => void
  addWarningOption: () => void
  removeWarningOption: (val: number) => void
  toggleWarningTime: (val: number) => void
  formatDuration: (s: number) => string
  disableRestTimer: (onDisable: () => void, onRestore: () => void) => void
}

/**
 * Thin orchestrator for the rest timer. It owns the countdown loop, its
 * pause/restart/stop controls, notification integration, and the disable/undo
 * flow, and composes two single-responsibility helpers (LIFT-879):
 *   - useRestTimerPresets — duration presets + their persistence
 *   - useRestTimerAlerts  — warning-time state + Web Audio beeps
 * The public RestTimerController surface is unchanged; preset/alert fields are
 * re-exposed by delegation so RestTimerContent.vue consumes one controller.
 *
 * @param onComplete - Called when the timer reaches zero (e.g. to skip to next set)
 * @param showUndo - The undo toast function from the parent
 */
export function useRestTimerController(
  onComplete: () => void,
  showUndo: (msg: string, onUndo: () => void, onCommit: () => void) => void,
): RestTimerController {
  const prefs = usePreferencesStore()
  const { notify: sendNotification, requestPermission: requestNotificationPermission } = useNotification()
  const { wasBackgrounded, startTracking: startBgTracking, stopTracking: stopBgTracking } = useBackgroundTracker()
  const { restTimerEnabled, setRestTimerEnabled } = useRestTimer()

  const presets = useRestTimerPresets()
  const alerts = useRestTimerAlerts()

  // ── Core timer state ──────────────────────────────────────────
  const timerActive = ref(false)
  const timerPaused = ref(false)
  const timerSeconds = ref(0)
  const timerStopping = ref(false)
  const timerAnnouncement = ref('')
  const restDuration = ref(parseInt(localStorage.getItem('rest-duration') ?? '90') || 90)

  let timerIntervalId: ReturnType<typeof setInterval> | null = null
  let timerEndTime = 0
  let pausedRemaining = 0
  let lastWarnedAt = -1

  // ── Edit-mode UI state ────────────────────────────────────────
  const editingPresets = ref(false)
  const editTab = ref<'rest' | 'alerts'>('rest')

  // ── Computed ──────────────────────────────────────────────────
  const timerDisplay = computed(() => {
    const m = Math.floor(timerSeconds.value / 60)
    const s = timerSeconds.value % 60
    return `${m}:${s.toString().padStart(2, '0')}`
  })

  const timerProgress = computed(() => {
    if (restDuration.value <= 0) return 0
    return timerSeconds.value / restDuration.value
  })

  const timerUrgent = computed(() =>
    alerts.maxWarning.value > 0 && timerSeconds.value <= alerts.maxWarning.value && timerSeconds.value > 0
  )

  // ── Watchers ──────────────────────────────────────────────────
  watch(editingPresets, (v) => {
    if (v) setTimeout(() => presets.presetInputEl.value?.focus(), 0)
  })

  // ── Timer interval ────────────────────────────────────────────
  function startInterval() {
    if (timerIntervalId !== null) clearInterval(timerIntervalId)
    lastWarnedAt = -1
    timerIntervalId = setInterval(() => {
      if (!timerPaused.value) {
        const remaining = Math.ceil((timerEndTime - Date.now()) / 1000)
        const prev = timerSeconds.value
        timerSeconds.value = Math.max(remaining, 0)
        for (const w of alerts.warningTimes.value) {
          if (w < prev && w >= timerSeconds.value && w !== lastWarnedAt) {
            lastWarnedAt = w
            alerts.playWarningBeep(w)
            timerAnnouncement.value = `${formatTimerAnnouncement(w)} remaining`
          }
        }
        if (timerSeconds.value <= 0) {
          alerts.playGoBeep()
          if (timerIntervalId !== null) clearInterval(timerIntervalId)
          timerIntervalId = null
          timerSeconds.value = 0
          timerAnnouncement.value = 'Rest timer done'
          if (prefs.experience.restTimerNotification) {
            sendNotification('Rest Complete', {
              body: 'Time to get back to work 💪',
              wasBackgrounded: wasBackgrounded.value,
              actions: REST_TIMER_NOTIFICATION_ACTIONS,
            })
          }
          stopBgTracking()
          if (!editingPresets.value) {
            onComplete()
          }
        }
      }
    }, 250)
  }

  // ── Timer controls ────────────────────────────────────────────
  function startRestTimer() {
    alerts.ensureAudio()
    if (prefs.experience.restTimerNotification) {
      requestNotificationPermission()
      startBgTracking()
    }
    timerActive.value = true
    timerPaused.value = false
    timerSeconds.value = restDuration.value
    timerEndTime = Date.now() + restDuration.value * 1000
    timerAnnouncement.value = `Rest timer started, ${formatTimerAnnouncement(restDuration.value)}`
    startInterval()
  }

  // ── Notification action buttons (LIFT-751 / LIFT-1355) ────────
  // The "Rest Again" button on the completion notification is handled in the
  // service worker (public/sw-notification-handler.js). It reaches the app by
  // postMessage when a window is already open and by the launch URL after a cold
  // boot; both land in `restTimerIntent`, so this controller consumes from one
  // place rather than owning a listener of its own. That matters because the
  // controller does not exist when the intent arrives on either of the two paths
  // this fixes — a cold boot, or a message received while the user was on the
  // Calendar/Weight tab with WorkoutTracker unmounted. `immediate` covers an
  // intent recorded before this controller existed; the watcher covers one
  // arriving while it is mounted, and the watcher is scoped to the owning
  // component so it cannot outlive it.
  //
  // Restart a fresh rest so the user can extend their break without reopening the
  // log sheet. Respect the user's rest-timer preference: a lingering notification
  // must not restart a timer the user has since disabled — but consume the intent
  // either way so it cannot fire on a later mount.
  watch(restAgainPending, (pending) => {
    if (!pending) return
    const fresh = consumeRestAgain()
    if (fresh && restTimerEnabled.value) startRestTimer()
  }, { immediate: true })

  function togglePause() {
    alerts.ensureAudio()
    if (!timerPaused.value) {
      pausedRemaining = Math.max(Math.ceil((timerEndTime - Date.now()) / 1000), 0)
      timerPaused.value = true
    } else {
      timerEndTime = Date.now() + pausedRemaining * 1000
      timerPaused.value = false
    }
  }

  function stopTimer() {
    timerStopping.value = true
    if (timerIntervalId !== null) clearInterval(timerIntervalId)
    timerIntervalId = null
    timerActive.value = false
    timerPaused.value = false
    timerSeconds.value = 0
    editingPresets.value = false
    presets.newPresetValue.value = null
    setTimeout(() => { timerStopping.value = false }, 0)
  }

  function restartTimer() {
    alerts.ensureAudio()
    timerSeconds.value = restDuration.value
    timerEndTime = Date.now() + restDuration.value * 1000
    timerPaused.value = false
    startInterval()
  }

  function setRestDuration(val: number) {
    alerts.ensureAudio()
    restDuration.value = val
    localStorage.setItem('rest-duration', String(val))
    timerSeconds.value = val
    timerEndTime = Date.now() + val * 1000
    timerPaused.value = false
    startInterval()
  }

  // ── Preset management (delegated) ──────────────────────────────
  function removePreset(val: number) {
    const fallback = presets.removePreset(val, restDuration.value)
    if (fallback !== undefined && fallback !== null) {
      setRestDuration(fallback)
    }
  }

  function resetAllDefaults() {
    presets.resetToDefaults()
    alerts.resetToDefaults()
  }

  // ── Disable (with undo) ───────────────────────────────────────
  function disableRestTimer(onDisable: () => void, onRestore: () => void) {
    const hadActiveTimer = timerActive.value
    const wasPaused = timerPaused.value
    const previousSeconds = timerSeconds.value
    const previousDuration = restDuration.value
    setRestTimerEnabled(false)
    onDisable()
    showUndo('Rest timer disabled', () => {
      setRestTimerEnabled(true)
      if (hadActiveTimer) {
        timerSeconds.value = previousSeconds
        restDuration.value = previousDuration
        timerActive.value = true
        timerPaused.value = wasPaused
        onRestore()
        if (previousSeconds > 0) {
          if (wasPaused) {
            pausedRemaining = previousSeconds
          } else {
            timerEndTime = Date.now() + previousSeconds * 1000
          }
          startInterval()
        }
      }
    }, () => { /* already disabled — no-op on commit */ })
  }

  return {
    timerActive,
    timerPaused,
    timerSeconds,
    timerStopping,
    timerAnnouncement,
    timerDisplay,
    timerProgress,
    timerUrgent,
    restDuration,
    editingPresets,
    editTab,
    newPresetValue: presets.newPresetValue,
    newWarningValue: alerts.newWarningValue,
    restPresets: presets.restPresets,
    disabledPresets: presets.disabledPresets,
    visiblePresets: presets.visiblePresets,
    warningOptions: alerts.warningOptions,
    warningTimes: alerts.warningTimes,
    presetInputEl: presets.presetInputEl,
    startRestTimer,
    stopTimer,
    restartTimer,
    togglePause,
    setRestDuration,
    addPreset: presets.addPreset,
    removePreset,
    togglePresetEnabled: presets.togglePresetEnabled,
    resetAllDefaults,
    addWarningOption: alerts.addWarningOption,
    removeWarningOption: alerts.removeWarningOption,
    toggleWarningTime: alerts.toggleWarningTime,
    formatDuration,
    disableRestTimer,
  }
}

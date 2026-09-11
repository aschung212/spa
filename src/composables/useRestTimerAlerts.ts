import { ref, computed, type Ref, type ComputedRef } from 'vue'
import { loadJSON } from '../lib/storage'

// ── Defaults ──────────────────────────────────────────────────────
export const DEFAULT_WARNING_OPTIONS = [3, 5, 10, 15, 30]

// ── localStorage helpers ──────────────────────────────────────────
function loadWarningOptions(): number[] {
  const stored = loadJSON<number[]>('rest-warning-options', [], Array.isArray)
  return stored.length > 0 ? [...stored].sort((a, b) => a - b) : [...DEFAULT_WARNING_OPTIONS]
}

function loadWarningTimes(): number[] {
  return loadJSON<number[]>('rest-warnings', [5], Array.isArray)
}

export interface RestTimerAlerts {
  warningOptions: Ref<number[]>
  warningTimes: Ref<number[]>
  newWarningValue: Ref<number | null>
  maxWarning: ComputedRef<number>
  /** Lazily create/resume the AudioContext and unlock iOS audio on a gesture. */
  ensureAudio: () => void
  playWarningBeep: (secondsLeft: number) => void
  playGoBeep: () => void
  toggleWarningTime: (val: number) => void
  addWarningOption: () => void
  removeWarningOption: (val: number) => void
  resetToDefaults: () => void
}

/**
 * Owns the rest-timer alert system: the Web Audio warning/finish beeps (and the
 * AudioContext they run on) plus the configurable warning-time state and its
 * localStorage persistence. Extracted from useRestTimerController (LIFT-879) so
 * audio synthesis is isolated from the countdown loop. The AudioContext is
 * instance-scoped — the controller is the single consumer.
 */
export function useRestTimerAlerts(): RestTimerAlerts {
  const warningOptions = ref<number[]>(loadWarningOptions())
  const warningTimes = ref<number[]>(loadWarningTimes())
  const newWarningValue = ref<number | null>(null)

  const maxWarning = computed(() =>
    warningTimes.value.length ? Math.max(...warningTimes.value) : 0
  )

  // ── Audio ───────────────────────────────────────────────────────
  let audioCtx: AudioContext | null = null

  // Beeps are best-effort — both play* helpers below already swallow audio
  // failures. This one was the exception while being the only one that can
  // realistically throw (it constructs the context), and LIFT-1355 widened the
  // blast radius: startRestTimer can now run during WorkoutTracker's setup when a
  // "Rest Again" intent is pending at mount, where an escaping error takes down
  // the whole Workouts tab instead of one event handler. Losing the beeps is the
  // correct degradation; losing the tab is not.
  function ensureAudio() {
    try {
      if (!audioCtx) {
        audioCtx = new AudioContext()
      }
      if (audioCtx.state === 'suspended') {
        audioCtx.resume()
      }
      // Play a short quiet tick to unlock iOS audio on user gesture
      const osc = audioCtx.createOscillator()
      const gain = audioCtx.createGain()
      osc.connect(gain)
      gain.connect(audioCtx.destination)
      osc.frequency.value = 1
      gain.gain.setValueAtTime(0.001, audioCtx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.05)
      osc.start(audioCtx.currentTime)
      osc.stop(audioCtx.currentTime + 0.05)
    } catch { /* audio not available — beeps degrade to silence */ }
  }

  function playWarningBeep(secondsLeft: number) {
    if (!audioCtx) return
    if (audioCtx.state === 'suspended') audioCtx.resume()
    try {
      const t = audioCtx.currentTime
      const freq = Math.min(1100, 500 + (30 - Math.min(secondsLeft, 30)) * 20)
      const osc = audioCtx.createOscillator()
      const gain = audioCtx.createGain()
      osc.connect(gain)
      gain.connect(audioCtx.destination)
      osc.frequency.setValueAtTime(freq, t)
      osc.frequency.linearRampToValueAtTime(freq + 120, t + 0.2)
      gain.gain.setValueAtTime(0.2, t)
      gain.gain.exponentialRampToValueAtTime(0.01, t + 0.25)
      osc.start(t)
      osc.stop(t + 0.25)
    } catch { /* audio not available */ }
  }

  function playGoBeep() {
    if (!audioCtx) return
    if (audioCtx.state === 'suspended') audioCtx.resume()
    try {
      const t = audioCtx.currentTime
      for (let i = 0; i < 2; i++) {
        const offset = i * 0.18
        const osc = audioCtx.createOscillator()
        const gain = audioCtx.createGain()
        osc.connect(gain)
        gain.connect(audioCtx.destination)
        osc.frequency.value = 1320
        gain.gain.setValueAtTime(0.35, t + offset)
        gain.gain.exponentialRampToValueAtTime(0.01, t + offset + 0.1)
        osc.start(t + offset)
        osc.stop(t + offset + 0.1)
      }
    } catch { /* audio not available */ }
  }

  // ── Warning management ──────────────────────────────────────────
  function saveWarningOptions() {
    localStorage.setItem('rest-warning-options', JSON.stringify(warningOptions.value))
  }

  function toggleWarningTime(val: number) {
    if (val === 0) {
      warningTimes.value = []
    } else if (warningTimes.value.includes(val)) {
      warningTimes.value = warningTimes.value.filter(v => v !== val)
    } else {
      warningTimes.value = [...warningTimes.value, val].sort((a, b) => a - b)
    }
    localStorage.setItem('rest-warnings', JSON.stringify(warningTimes.value))
  }

  function addWarningOption() {
    if (newWarningValue.value === null) return
    const val = newWarningValue.value
    if (val >= 1 && val <= 120 && !warningOptions.value.includes(val)) {
      warningOptions.value = [...warningOptions.value, val].sort((a, b) => a - b)
      saveWarningOptions()
    }
    newWarningValue.value = null
  }

  function removeWarningOption(val: number) {
    if (warningOptions.value.length <= 1) return
    warningOptions.value = warningOptions.value.filter(v => v !== val)
    warningTimes.value = warningTimes.value.filter(v => v !== val)
    saveWarningOptions()
    localStorage.setItem('rest-warnings', JSON.stringify(warningTimes.value))
  }

  function resetToDefaults() {
    warningOptions.value = [...DEFAULT_WARNING_OPTIONS]
    saveWarningOptions()
    warningTimes.value = [5]
    localStorage.setItem('rest-warnings', JSON.stringify(warningTimes.value))
  }

  return {
    warningOptions,
    warningTimes,
    newWarningValue,
    maxWarning,
    ensureAudio,
    playWarningBeep,
    playGoBeep,
    toggleWarningTime,
    addWarningOption,
    removeWarningOption,
    resetToDefaults,
  }
}

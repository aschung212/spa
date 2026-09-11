import { computed, type ComputedRef, type Ref } from 'vue'
import type { Exercise, WorkoutSet } from '../stores/workout'
import { effectiveSetWeight } from '../lib/bodyweightLoad'

export interface DaySummary {
  exercises: number
  sets: number
  volumeDisplay: string
  prs: number
}

export interface CalendarSet extends WorkoutSet {
  isPR: boolean
  /**
   * LIFT-1373: the row is looked up by exercise NAME and rendered without the
   * exercise, so the bodyweight-loaded flag has to ride along or the load
   * cannot be described in ADDED-space words.
   */
  bodyweightLoaded: boolean
}

export interface UseCalendarDataOptions {
  /** Exercises to derive the calendar from (already tag-filtered by the view). */
  exercises: Ref<Exercise[]>
  /** The currently-selected day key (YYYY-MM-DD) or null. Drives daySummary. */
  selectedDay: Ref<string | null>
  /** PR baseline day key — sets before this are excluded from PR resolution. */
  prBaselineDate: Ref<string | null>
  /** Store getter: the best e1RM for an exercise on/after an optional baseline. */
  getExercisePR: (exerciseId: string, sinceDate?: string | null) => number
  /** Converts a stored (lb) weight into the user's display unit. */
  displayWeight: (value: number) => number
}

export interface UseCalendarDataReturn {
  trainingMap: ComputedRef<Record<string, string[]>>
  prMap: ComputedRef<Record<string, Set<string>>>
  daySummary: ComputedRef<DaySummary | null>
  isPRExercise: (dateStr: string, exName: string) => boolean
  hasPR: (dateStr: string) => boolean
  getSetsForDay: (dateStr: string, exName: string) => CalendarSet[]
  getSetCount: (dateStr: string, exName: string) => number
}

/**
 * Owns the calendar's domain derivation — the training map, PR-date resolution,
 * and per-day summary — so the view is left with only view state and rendering.
 *
 * PR-date resolution honours the baseline window and awards the record to the
 * EARLIEST date a set reached the PR e1RM; later ties are not new records.
 */
export function useCalendarData(options: UseCalendarDataOptions): UseCalendarDataReturn {
  const { exercises, selectedDay, prBaselineDate, getExercisePR, displayWeight } = options

  // Map YYYY-MM-DD → unique exercise names trained that day.
  const trainingMap = computed(() => {
    const map: Record<string, string[]> = {}
    for (const exercise of exercises.value) {
      for (const set of exercise.sets) {
        const day = set.date.slice(0, 10)
        if (!map[day]) map[day] = []
        if (!map[day].includes(exercise.name)) map[day].push(exercise.name)
      }
    }
    return map
  })

  // Map YYYY-MM-DD → Set of exercise names that achieved a PR on that date.
  // Only the first set to reach the PR value counts — ties on later dates are
  // not new records. Respects the PR baseline: when set, only sets on/after the
  // baseline count.
  const prMap = computed(() => {
    const map: Record<string, Set<string>> = {}
    const baseline = prBaselineDate.value
    for (const exercise of exercises.value) {
      const pr = getExercisePR(exercise.id, baseline)
      if (!pr) continue
      // Find the earliest date (within baseline window) any set hit the PR value.
      let earliestDate = ''
      for (const set of exercise.sets) {
        const day = set.date.slice(0, 10)
        if (baseline && day < baseline) continue
        if (set.estimated1RM === pr) {
          if (!earliestDate || day < earliestDate) earliestDate = day
        }
      }
      if (earliestDate) {
        if (!map[earliestDate]) map[earliestDate] = new Set()
        map[earliestDate].add(exercise.name)
      }
    }
    return map
  })

  function isPRExercise(dateStr: string, exName: string): boolean {
    return prMap.value[dateStr]?.has(exName) ?? false
  }

  function hasPR(dateStr: string): boolean {
    return !!(prMap.value[dateStr]?.size > 0)
  }

  // Volume sums the bodyweight-inclusive EFFECTIVE load (LIFT-834), matching
  // `sessionSummary` and the exercise graph — a pure-bodyweight pull-up set
  // contributes the lifter's weight, not zero. `effectiveSetWeight` is exactly
  // `s.weight` for every non-bodyweight-loaded exercise.
  const daySummary = computed((): DaySummary | null => {
    if (!selectedDay.value || !trainingMap.value[selectedDay.value]) return null
    const dayStr = selectedDay.value.slice(0, 10)
    let totalSets = 0
    let totalVolume = 0
    let exerciseCount = 0
    let prCount = 0

    for (const exercise of exercises.value) {
      const daySets = exercise.sets.filter(s => s.date.slice(0, 10) === dayStr)
      if (daySets.length === 0) continue
      exerciseCount++
      totalSets += daySets.length
      for (const s of daySets) {
        totalVolume += effectiveSetWeight(s, exercise) * s.reps
      }
      const pr = getExercisePR(exercise.id, prBaselineDate.value)
      if (pr && daySets.some(s => s.estimated1RM === pr)) {
        prCount++
      }
    }

    const formatted = totalVolume >= 10000
      ? `${(displayWeight(totalVolume) / 1000).toFixed(1)}k`
      : String(displayWeight(totalVolume))

    return {
      exercises: exerciseCount,
      sets: totalSets,
      volumeDisplay: formatted,
      prs: prCount,
    }
  })

  function getSetsForDay(dateStr: string, exName: string): CalendarSet[] {
    const exercise = exercises.value.find(e => e.name === exName)
    if (!exercise) return []
    const pr = getExercisePR(exercise.id, prBaselineDate.value)
    const dayStr = dateStr.slice(0, 10)
    // Only mark as PR if this is the earliest date the PR was achieved.
    const isPRDay = prMap.value[dayStr]?.has(exName) ?? false
    return exercise.sets
      .filter(s => s.date.slice(0, 10) === dayStr)
      .sort((a, b) => b.estimated1RM - a.estimated1RM)
      .map(s => ({
        ...s,
        isPR: isPRDay && s.estimated1RM === pr,
        bodyweightLoaded: exercise.bodyweightLoaded === true,
      }))
  }

  function getSetCount(dateStr: string, exName: string): number {
    const exercise = exercises.value.find(e => e.name === exName)
    if (!exercise) return 0
    const dayStr = dateStr.slice(0, 10)
    return exercise.sets.filter(s => s.date.slice(0, 10) === dayStr).length
  }

  return {
    trainingMap,
    prMap,
    daySummary,
    isPRExercise,
    hasPR,
    getSetsForDay,
    getSetCount,
  }
}

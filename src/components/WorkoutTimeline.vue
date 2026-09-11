<template>
  <div class="wtTimelineControls wtTimelineControlsRow">
    <!-- Timeline rows have no per-exercise "+", so this is the log entry
         point for the timeline view (the top-bar "+" adds an exercise). -->
    <button
      class="wtTimelineLogBtn"
      @click="emit('log-set')"
      aria-label="Log a set"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      <span>Log a set</span>
    </button>
    <button
      :class="['wtWarmupToggle', { wtWarmupToggleActive: hideWarmups }]"
      @click="hideWarmups = !hideWarmups"
      role="switch"
      :aria-checked="hideWarmups"
      :aria-label="hideWarmups ? 'Show warmup sets' : 'Hide warmup sets'"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M7 12h10M10 18h4"/></svg>
      <span>{{ hideWarmups ? 'Warmups hidden' : 'Hide warmups' }}</span>
    </button>
  </div>
  <div v-if="timelineSets.length === 0" class="wtEmpty">
    No sets logged yet.
  </div>
  <div v-else class="wtTimeline">
    <template v-for="group in visibleTimelineGroups" :key="group.key">
      <p class="wtTimelineDateHeader">{{ group.label }}</p>
      <div class="wtSetCard">
        <div
          v-for="entry in group.sets"
          :key="entry.set.id"
          :class="['wtTimelineRow', { wtTimelineRowActive: activeSetId === entry.set.id }]"
        >
          <!-- Disclosure trigger (LIFT-1349). A real <button> rather than a
               clickable div: Enter/Space come from the platform, and the
               Edit/Delete buttons stay siblings so they are not swallowed by
               a children-presentational button role. -->
          <button
            type="button"
            class="wtTimelineRowMain"
            :aria-expanded="activeSetId === entry.set.id"
            :aria-label="setRowLabel(entry)"
            @click="toggleSetActions(entry.set.id)"
          >
            <span class="wtTimelineExName">{{ entry.exerciseName }}</span>
            <span class="wtTimelineSetDetail">{{ setLoad(entry) }} × {{ entry.set.reps }}</span>
            <span
              v-if="entry.set.attemptedNextRep"
              class="wtEffortBadge"
              :aria-label="`Went for rep ${entry.set.reps + 1}`"
            >+1</span>
            <span v-if="entry.set.rpe" class="wtTimelineRPE">RPE {{ entry.set.rpe }}</span>
            <span class="wtTimelineE1RM">~{{ displayWeight(entry.set.estimated1RM) }}</span>
            <span v-if="timelinePRMap[entry.set.id] === 'pr'" class="wtTimelineBadge" aria-label="Personal record">🏆</span>
            <span v-else-if="timelinePRMap[entry.set.id] === 'repPR'" class="wtTimelineBadge" aria-label="Rep personal record">🔥</span>
          </button>
          <div v-if="activeSetId === entry.set.id" class="wtSetActions">
            <button class="wtSetBtn" @click="emit('edit-set', entry.exerciseId, entry.set)" aria-label="Edit set">Edit</button>
            <button class="wtSetBtn wtSetBtnDel" @click="emit('delete-set', entry.exerciseId, entry.set)" aria-label="Delete set">Delete</button>
          </div>
        </div>
      </div>
    </template>
    <button v-if="timelineLimit < filteredTimelineSets.length" class="wtTimelineShowMore" @click="timelineLimit += 50">
      Show more ({{ filteredTimelineSets.length - timelineLimit }} remaining)
    </button>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import type { Exercise, WorkoutSet } from '../stores/workout'
import { useWeightUnit } from '../composables/useWeightUnit'
import { buildWarmupSetIds } from '../lib/classifyWarmupSets'
import { formatSetLoad } from '../lib/bodyweightLoad'
import { setDayKey, formatShortDate } from '../lib/dates'

const props = defineProps<{
  exercises: Exercise[]
  /** PR badges and the comparison pool only consider sets on/after this date (null = all time). */
  prBaselineDate: string | null
  /** Sets below this fraction of the session's top e1RM classify as warmups. */
  warmupThreshold: number
}>()

const emit = defineEmits<{
  (e: 'log-set'): void
  (e: 'edit-set', exerciseId: string, set: WorkoutSet): void
  (e: 'delete-set', exerciseId: string, set: WorkoutSet): void
}>()

const { weightUnit, displayWeight } = useWeightUnit()

// ── Warmup set filtering (session-only toggle, not persisted) ───
const hideWarmups = ref(false)
const warmupSetIds = computed(() => {
  if (!hideWarmups.value) return new Set<string>()
  const exercises = props.exercises.map(ex => ({
    sets: ex.sets.map(s => ({ id: s.id, date: s.date, estimated1RM: s.estimated1RM })),
  }))
  return buildWarmupSetIds(exercises, props.warmupThreshold)
})

// Filter sets to those on/after the user-set PR baseline.
// When no baseline is set, returns sets unchanged (legacy all-time behavior).
function filterSetsSinceBaseline<T extends { date: string }>(sets: T[]): T[] {
  const baseline = props.prBaselineDate
  if (!baseline) return sets
  return sets.filter(s => setDayKey(s.date) >= baseline)
}

const timelineLimit = ref(50)

interface TimelineEntry {
  exerciseId: string
  exerciseName: string
  /**
   * LIFT-1373: the row flattens its set away from the exercise, so the
   * bodyweight-loaded flag has to be threaded onto the entry or the load
   * cannot be described in ADDED-space words (the shape #1333 used for
   * `SetWithExercise.effectiveWeight`).
   */
  bodyweightLoaded: boolean
  set: WorkoutSet
}

const timelineSets = computed((): TimelineEntry[] => {
  const entries: TimelineEntry[] = []
  for (const ex of props.exercises) {
    for (const s of ex.sets) {
      entries.push({
        exerciseId: ex.id,
        exerciseName: ex.name,
        bodyweightLoaded: ex.bodyweightLoaded === true,
        set: s,
      })
    }
  }
  return entries.sort((a, b) => setDayKey(b.set.date).localeCompare(setDayKey(a.set.date)))
})

/**
 * The set's load in the words the app uses for it — "Bodyweight", "+25 lbs",
 * "135 lbs" (LIFT-1373). Shared by the visible row text and its accessible
 * name so the two cannot disagree about what the number means.
 */
function setLoad(entry: TimelineEntry): string {
  return formatSetLoad(
    entry.set,
    { bodyweightLoaded: entry.bodyweightLoaded },
    { displayWeight, unit: weightUnit.value },
  )
}

// PR badge map: for each set, determine if it's the best e1RM (weight PR)
// or the best reps at its weight (rep PR) for that exercise.
// Respects the user-set PR baseline: when set, only sets on/after baseline
// are eligible for badges AND serve as the comparison pool.
const timelinePRMap = computed((): Record<string, 'pr' | 'repPR'> => {
  const map: Record<string, 'pr' | 'repPR'> = {}
  for (const ex of props.exercises) {
    if (ex.sets.length === 0) continue
    const eligible = filterSetsSinceBaseline(ex.sets)
    if (eligible.length === 0) continue
    const best1RM = Math.max(...eligible.map(s => s.estimated1RM))
    // Weight PR: set(s) achieving the best e1RM within the baseline window
    for (const s of eligible) {
      if (s.estimated1RM === best1RM) {
        map[s.id] = 'pr'
      }
    }
    // Rep PR: best reps at each weight within the baseline window
    const bestRepsAtWeight: Record<number, number> = {}
    for (const s of eligible) {
      bestRepsAtWeight[s.weight] = Math.max(bestRepsAtWeight[s.weight] ?? 0, s.reps)
    }
    for (const s of eligible) {
      if (!map[s.id] && s.reps === bestRepsAtWeight[s.weight] && eligible.filter(o => o.weight === s.weight).length > 1) {
        map[s.id] = 'repPR'
      }
    }
  }
  return map
})

const filteredTimelineSets = computed(() => {
  if (!hideWarmups.value) return timelineSets.value
  const ids = warmupSetIds.value
  return timelineSets.value.filter(e => !ids.has(e.set.id))
})

const visibleTimelineGroups = computed(() => {
  const limited = filteredTimelineSets.value.slice(0, timelineLimit.value)
  const groups: { key: string; label: string; sets: TimelineEntry[] }[] = []
  for (const entry of limited) {
    const k = setDayKey(entry.set.date)
    const last = groups[groups.length - 1]
    if (last && last.key === k) {
      last.sets.push(entry)
    } else {
      // Label from the day key (anchored at noon) so an endOfDayISO set's
      // header matches its group key instead of rolling +1 in UTC+ zones.
      groups.push({ key: k, label: formatShortDate(k + 'T12:00:00'), sets: [entry] })
    }
  }
  return groups
})

// Accessible name for the disclosure trigger. The row's own text ends in a
// bare "~216", which reads as nothing useful, and the day it belongs to lives
// in an unassociated date header above the card — so state the set explicitly.
// Static per row (never "Expand"/"Collapse"): the state is on aria-expanded.
function setRowLabel(entry: TimelineEntry): string {
  const parts = [
    entry.exerciseName,
    `${setLoad(entry)} × ${entry.set.reps}`,
  ]
  // The badge spans carry their own aria-labels, but a child's label does not
  // reach a parent that has one of its own — so restate them here or they are
  // simply gone from the name.
  if (entry.set.attemptedNextRep) parts.push(`went for rep ${entry.set.reps + 1}`)
  if (entry.set.rpe) parts.push(`RPE ${entry.set.rpe}`)
  const badge = timelinePRMap.value[entry.set.id]
  if (badge === 'pr') parts.push('personal record')
  else if (badge === 'repPR') parts.push('rep personal record')
  return parts.join(', ')
}

// ── Set actions (tap-to-reveal) ──────────────────────────────────
const activeSetId = ref<string | null>(null)

function toggleSetActions(setId: string) {
  activeSetId.value = activeSetId.value === setId ? null : setId
}
</script>

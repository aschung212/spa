<template>
  <div class="calCard">
    <!-- Header -->
    <div class="calCardHeader">
      <h1 class="calTitle">Training Calendar</h1>
      <div class="calViewToggle">
        <button :class="['calToggleBtn', { active: view === 'year' }]" :aria-pressed="view === 'year'" @click="setView('year')">Year</button>
        <button :class="['calToggleBtn', { active: view === 'month' }]" :aria-pressed="view === 'month'" @click="setView('month')">Month</button>
        <button :class="['calToggleBtn', { active: view === 'week' }]" :aria-pressed="view === 'week'" @click="setView('week')">Week</button>
      </div>
    </div>

    <!-- Navigation (month/week only — year view has inline nav) -->
    <div v-if="view !== 'year'" class="calNav">
      <button class="calNavBtn" @click="prev" aria-label="Previous">‹</button>
      <button :class="['calNavLabel', { calNavLabelTappable: !isCurrentPeriod }]" :disabled="isCurrentPeriod" @click="goToToday">{{ navLabel }}</button>
      <button class="calNavBtn" @click="next" aria-label="Next">›</button>
    </div>

    <!-- Tag filter -->
    <template v-if="store.allTags.length > 0 && view !== 'year'">
      <div class="wtTagFilterBar">
        <button
          v-for="tag in store.allTags"
          :key="tag"
          :class="['wtTagChip', { wtTagChipActive: activeTagFilters.includes(tag) }]"
          :aria-pressed="activeTagFilters.includes(tag) ? 'true' : 'false'"
          :aria-label="activeTagFilters.includes(tag) ? `Remove ${tag} filter` : `Filter by ${tag}`"
          @click="toggleTagFilter(tag)"
        >{{ tag }}</button>
        <button
          v-if="activeTagFilters.length > 0"
          class="wtTagChip wtTagChipClear"
          aria-label="Clear all tag filters"
          @click="activeTagFilters = []"
        >× Clear</button>
      </div>
    </template>

    <!-- Year view (consistency heatmap) -->
    <template v-if="view === 'year'">
      <ConsistencyHeatmap
        :year="heatmapYear"
        :days="heatmapDays"
        :current-streak="currentWeekStreak"
        :longest-streak="longestWeekStreak"
        :is-current-year="heatmapYear === new Date().getFullYear()"
        @prev-year="heatmapYear--"
        @next-year="heatmapYear++"
      />
    </template>

    <!-- Monthly view -->
    <template v-if="view === 'month'">
      <div class="calGrid">
        <div v-for="d in DAY_HEADERS" :key="d" class="calDayHeader">{{ d }}</div>
        <div
          v-for="cell in monthCells"
          :key="cell.key"
          class="calCell"
          :class="{
            calCellToday: cell.isToday,
            calCellOtherMonth: !cell.inMonth,
            calCellHasWork: cell.exercises.length > 0 && cell.inMonth,
            calCellSelected: selectedDay === cell.dateStr && cell.inMonth
          }"
          :role="cell.inMonth ? 'button' : undefined"
          :tabindex="cell.inMonth ? 0 : -1"
          :aria-label="cell.inMonth ? cellAriaLabel(cell) : undefined"
          :aria-pressed="cell.inMonth ? selectedDay === cell.dateStr : undefined"
          @click="cell.inMonth && toggleDay(cell.dateStr)"
          @keydown.enter.prevent="cell.inMonth && toggleDay(cell.dateStr)"
          @keydown.space.prevent="cell.inMonth && toggleDay(cell.dateStr)"
        >
          <span class="calCellNum">{{ cell.day }}</span>
          <span v-if="cell.inMonth && hasPR(cell.dateStr)" class="calCellPR">🏆</span>
          <div v-if="cell.exercises.length > 0 && cell.inMonth" class="calDots">
            <span
              v-for="(_ex, i) in cell.exercises.slice(0, 3)"
              :key="i"
              class="calDot"
            ></span>
            <span v-if="cell.exercises.length > 3" class="calOverflow">+{{ cell.exercises.length - 3 }}</span>
          </div>
        </div>
      </div>

      <!-- First-use empty state (no workout data at all) -->
      <p v-if="!hasAnyData && !selectedDay" class="wtEmpty calEmptyState">
        Log your first workout on the Workouts tab to see it here.
      </p>

      <!-- Selected day detail -->
      <div v-if="selectedDay" class="calDetail">
        <div class="calDetailHeader">
          <p class="calDetailDate">{{ formatSelectedDay(selectedDay) }}</p>
          <button class="calLogBtn" @click="openLogModal(selectedDay)">+ Log</button>
        </div>
        <div v-if="trainingMap[selectedDay]" class="calDetailTags">
          <!-- Daily workout summary -->
          <div class="calSummaryBar" v-if="daySummary">
            <span class="calSumStat">
              <span class="calSumValue">{{ daySummary.exercises }}</span>
              <span class="calSumLabel">exercise{{ daySummary.exercises !== 1 ? 's' : '' }}</span>
            </span>
            <span class="calSumDivider"></span>
            <span class="calSumStat">
              <span class="calSumValue">{{ daySummary.sets }}</span>
              <span class="calSumLabel">set{{ daySummary.sets !== 1 ? 's' : '' }}</span>
            </span>
            <span class="calSumDivider"></span>
            <span class="calSumStat">
              <span class="calSumValue">{{ daySummary.volumeDisplay }}</span>
              <span class="calSumLabel">{{ weightUnit }} volume</span>
            </span>
            <span v-if="daySummary.prs > 0" class="calSumDivider"></span>
            <span v-if="daySummary.prs > 0" class="calSumStat calSumPR">
              <span class="calSumValue">🏆 {{ daySummary.prs }}</span>
              <span class="calSumLabel">PR{{ daySummary.prs !== 1 ? 's' : '' }}</span>
            </span>
          </div>

          <div class="calExList">
            <div v-for="ex in trainingMap[selectedDay]" :key="ex" class="calExGroup">
              <button
                :class="['calExRow', { calExRowExpanded: expandedExercises.has(`${selectedDay}::${ex}`), calExRowPR: isPRExercise(selectedDay, ex) }]"
                :aria-expanded="expandedExercises.has(`${selectedDay}::${ex}`)"
                @click="toggleDetail(selectedDay, ex)"
              >
                <span class="calExRowLeft">
                  <span v-if="isPRExercise(selectedDay, ex)" class="calSetPR">🏆</span>
                  <span class="calExRowName">{{ ex }}</span>
                </span>
                <span class="calExRowRight">
                  <span class="calExRowCount">{{ getSetCount(selectedDay, ex) }} set{{ getSetCount(selectedDay, ex) !== 1 ? 's' : '' }}</span>
                  <span :class="['calExRowChevron', { calExRowChevronOpen: expandedExercises.has(`${selectedDay}::${ex}`) }]">›</span>
                </span>
              </button>
              <div v-if="expandedExercises.has(`${selectedDay}::${ex}`)" class="calSetList">
                <div
                  v-for="s in getSetsForDay(selectedDay, ex)"
                  :key="s.id"
                  :class="['calSetRow', { calSetRowPR: s.isPR }]"
                >
                  <span class="calSetMain">
                    <span v-if="s.isPR" class="calSetPR">🏆</span>
                    <span class="calSetWeight">{{ displayWeight(s.weight) }} {{ weightUnit }}</span>
                    <span class="calSetSep">×</span>
                    <span class="calSetReps">{{ s.reps }} reps</span>
                  </span>
                  <span class="calSetE1RM">~{{ displayWeight(Math.round(s.estimated1RM)) }} {{ weightUnit }} e1RM</span>
                </div>
              </div>
            </div>
          </div>
        </div>
        <p v-else class="calDetailEmpty">No sets logged.</p>
      </div>
    </template>

    <!-- Weekly view -->
    <div v-else class="calWeek">
      <div
        v-for="day in weekDays"
        :key="day.dateStr"
        class="calWeekRow"
        :class="{ calWeekRowToday: day.isToday }"
      >
        <div class="calWeekDayCol">
          <span class="calWeekDayName">{{ day.shortName }}</span>
          <span class="calWeekDayNum" :class="{ calWeekDayNumToday: day.isToday }">{{ day.dayNum }}</span>
          <button class="calWeekDayLogBtn" :aria-label="`Log workout for ${day.shortName} ${day.dayNum}`" @click="openLogModal(day.dateStr)">+</button>
        </div>
        <div class="calWeekContent">
          <span v-if="day.exercises.length === 0" class="calWeekRest">Rest</span>
          <div v-if="day.exercises.length > 0" class="calExList">
            <div v-for="ex in day.exercises" :key="ex" class="calExGroup">
              <button
                :class="['calExRow calExRowCompact', { calExRowExpanded: expandedExercises.has(`${day.dateStr}::${ex}`), calExRowPR: isPRExercise(day.dateStr, ex) }]"
                :aria-expanded="expandedExercises.has(`${day.dateStr}::${ex}`)"
                @click="toggleDetail(day.dateStr, ex)"
              >
                <span class="calExRowLeft">
                  <span v-if="isPRExercise(day.dateStr, ex)" class="calSetPR">🏆</span>
                  <span class="calExRowName">{{ ex }}</span>
                </span>
                <span class="calExRowRight">
                  <span class="calExRowCount">{{ getSetCount(day.dateStr, ex) }}</span>
                  <span :class="['calExRowChevron', { calExRowChevronOpen: expandedExercises.has(`${day.dateStr}::${ex}`) }]">›</span>
                </span>
              </button>
              <div v-if="expandedExercises.has(`${day.dateStr}::${ex}`)" class="calSetList">
                <div
                  v-for="s in getSetsForDay(day.dateStr, ex)"
                  :key="s.id"
                  :class="['calSetRow', { calSetRowPR: s.isPR }]"
                >
                  <span class="calSetMain">
                    <span v-if="s.isPR" class="calSetPR">🏆</span>
                    <span class="calSetWeight">{{ displayWeight(s.weight) }} {{ weightUnit }}</span>
                    <span class="calSetSep">×</span>
                    <span class="calSetReps">{{ s.reps }} reps</span>
                  </span>
                  <span class="calSetE1RM">~{{ displayWeight(Math.round(s.estimated1RM)) }} {{ weightUnit }} e1RM</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- First-use empty state (no workout data at all) -->
      <p v-if="!hasAnyData" class="wtEmpty calEmptyState">
        Log your first workout on the Workouts tab to see it here.
      </p>

      <MuscleGroupRecovery
        v-if="hasRecoveryData"
        :recovery="tagRecovery"
        :hidden-count="recoveryHiddenCount"
        :hidden-tags="recoveryHiddenTags"
        @hide="onRecoveryHide"
        @show="onRecoveryShow"
        @days-change="onRecoveryDaysChange"
      />

      <!-- Weekly muscle group volume chart (collapsible) -->
      <MuscleGroupChart
        v-if="weeklyVolume.length > 0"
        :weekly-volume="weeklyVolume"
        :max-sets="maxSets"
        :total-sets="totalSets"
        :tag-trends="tagTrends"
        :collapsed="volumeCollapsed"
        @toggle-collapsed="volumeCollapsed = !volumeCollapsed"
      />

      <!-- Week-over-week training volume trend (collapsible) -->
      <VolumeTrendChart
        v-if="volumeTrend.length >= 2"
        :weekly-volume="volumeTrend"
        :total-volume="volumeTrendTotal"
        :collapsed="trendCollapsed"
        @toggle-collapsed="trendCollapsed = !trendCollapsed"
      />

      <!-- Rep-range / intensity-zone distribution (collapsible) -->
      <RepRangeChart
        v-if="repRangeTotal > 0"
        :zones="repRangeZones"
        :total-sets="repRangeTotal"
        :dominant="repRangeDominant"
        :collapsed="repRangeCollapsed"
        @toggle-collapsed="repRangeCollapsed = !repRangeCollapsed"
      />
    </div>
  </div>

  <!-- Exercise Picker Modal -->
  <Teleport to="body">
    <div v-if="pickerOpen" class="repMaxOverlay" @click.self="closeExercisePicker" @keydown.escape="closeExercisePicker">
      <div class="repMaxModal" role="dialog" aria-modal="true" aria-labelledby="exercise-picker-title">
        <h2 id="exercise-picker-title">Choose Exercise</h2>
        <div class="wtExPickerList">
          <button
            v-for="ex in store.exercises"
            :key="ex.id"
            class="wtExPickerRow"
            @click="pickExercise(ex.id)"
          >
            <span class="wtExPickerName">{{ ex.name }}</span>
            <span class="wtChevron">›</span>
          </button>
        </div>
        <div class="repMaxActions">
          <button class="repMaxBtn repMaxBtnClose" @click="closeExercisePicker">Cancel</button>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- Log Set Modal -->
  <Teleport to="body">
    <div v-if="logModalOpen" class="repMaxOverlay" @click.self="closeLogModal" @keydown.escape="closeLogModal">
      <div class="repMaxModal" role="dialog" aria-modal="true" aria-labelledby="cal-modal-title">
        <h2 id="cal-modal-title">{{ store.exercises.find(e => e.id === logModal.exerciseId)?.name || 'Log a Set' }}</h2>
        <p class="wtModalSubtitle">{{ formatSelectedDay(logModal.date) }}</p>

        <div class="wtInputRow">
          <!-- "Added" on a bodyweight-loaded exercise, matching the log sheet:
               the field is the weight on the belt, and 0 is a real value
               (LIFT-1330). -->
          <label class="repMaxLabel" style="flex:1">
            {{ logModalWeightLabel }} ({{ weightUnit }})
            <div class="repMaxInputRow">
              <input
                v-model.number="logModal.weight"
                type="number"
                inputmode="decimal"
                min="0"
                step="any"
                :placeholder="logModalWeightPlaceholder"
                class="repMaxInput"
              />
            </div>
          </label>
          <label class="repMaxLabel" style="flex:1">
            Reps
            <div class="repMaxInputRow">
              <input
                v-model.number="logModal.reps"
                type="number"
                inputmode="numeric"
                min="1"
                max="30"
                placeholder="8"
                class="repMaxInput"
              />
            </div>
          </label>
        </div>

        <div v-if="logModalEstimate" class="repMaxResult">
          <span class="repMaxResultLabel">Estimated 1RM</span>
          <span class="repMaxResultValue">{{ logModalEstimate }} {{ weightUnit }}</span>
        </div>

        <div class="repMaxActions">
          <button class="repMaxBtn repMaxBtnCalc" :disabled="!canSaveLog" @click="saveLog">Save</button>
          <button class="repMaxBtn repMaxBtnClose" @click="closeLogModal">Cancel</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, defineAsyncComponent } from 'vue'
import { useWorkoutStore } from '../stores/workout'
import { localDateKey, todayISO } from '../lib/dates'
import { useAnalytics } from '../composables/useAnalytics'
import { useWeightUnit } from '../composables/useWeightUnit'
import { usePRBaseline } from '../composables/usePRBaseline'
import { useModal } from '../composables/useModal'
import { useTagVolume } from '../composables/useTagVolume'
import { useTagVolumeTrend } from '../composables/useTagVolumeTrend'
import { useTagRecovery } from '../composables/useTagRecovery'
import { useVolumeTrend } from '../composables/useVolumeTrend'
import { useRepRangeDistribution } from '../composables/useRepRangeDistribution'
import { useCalendarData } from '../composables/useCalendarData'
import { allowsZeroWeight, isLoggableWeight } from '../lib/bodyweightLoad'
import { epley } from '../lib/epley'
import type { HeatmapDay } from '../components/ConsistencyHeatmap.vue'

const MuscleGroupChart = defineAsyncComponent(() => import('../components/MuscleGroupChart.vue'))
const MuscleGroupRecovery = defineAsyncComponent(() => import('../components/MuscleGroupRecovery.vue'))
const VolumeTrendChart = defineAsyncComponent(() => import('../components/VolumeTrendChart.vue'))
const RepRangeChart = defineAsyncComponent(() => import('../components/RepRangeChart.vue'))
const ConsistencyHeatmap = defineAsyncComponent(() => import('../components/ConsistencyHeatmap.vue'))

const store = useWorkoutStore()
const { weightUnit, displayWeight, toLbs } = useWeightUnit()
const { prBaselineDate } = usePRBaseline()
const { logEvent } = useAnalytics()

// ── Tag filtering ────────────────────────────────────────────────
const activeTagFilters = ref<string[]>([])

function toggleTagFilter(tag: string) {
  const idx = activeTagFilters.value.indexOf(tag)
  if (idx >= 0) {
    activeTagFilters.value = activeTagFilters.value.filter(t => t !== tag)
  } else {
    activeTagFilters.value = [...activeTagFilters.value, tag]
  }
}

const filteredExercises = computed(() => {
  if (activeTagFilters.value.length === 0) return store.exercises
  return store.exercises.filter(e => {
    const tags = e.tags || []
    return activeTagFilters.value.some(t => tags.includes(t))
  })
})

// Remove stale tags from active filters
watch(() => store.allTags, (tags) => {
  activeTagFilters.value = activeTagFilters.value.filter(t => tags.includes(t))
})


const DAY_HEADERS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

const view = ref('month')
const cursor = ref(new Date())
const selectedDay = ref<string | null>(null)

function setView(v: string) {
  view.value = v
  selectedDay.value = null
  logEvent('calendar_view_switch', { view: v })
}

const todayStr = todayISO()

// True when the user has zero sets across all exercises (brand-new account)
const hasAnyData = computed(() =>
  store.exercises.some(e => e.sets.length > 0)
)

// ── Calendar domain derivation (training map, PR dates, day summary) ──
const {
  trainingMap,
  daySummary,
  isPRExercise,
  hasPR,
  getSetsForDay,
  getSetCount,
} = useCalendarData({
  exercises: filteredExercises,
  selectedDay,
  prBaselineDate,
  getExercisePR: store.getExercisePR,
  displayWeight,
})

// Exercise detail expand: "YYYY-MM-DD::Exercise Name" or null
const expandedExercises = ref(new Set<string>())
watch(selectedDay, () => expandedExercises.value.clear())

function toggleDetail(dateStr: string, exName: string) {
  const key = `${dateStr}::${exName}`
  if (expandedExercises.value.has(key)) {
    expandedExercises.value.delete(key)
  } else {
    expandedExercises.value.add(key)
  }
}

// Navigation label
const navLabel = computed(() => {
  if (view.value === 'month') {
    return cursor.value.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  }
  const days = weekDays.value
  const first = new Date(days[0].dateStr + 'T12:00:00')
  const last = new Date(days[6].dateStr + 'T12:00:00')
  const fmt = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return `${fmt(first)} – ${fmt(last)}`
})

const isCurrentPeriod = computed(() => {
  const now = new Date()
  if (view.value === 'year') {
    return heatmapYear.value === now.getFullYear()
  }
  if (view.value === 'month') {
    return cursor.value.getFullYear() === now.getFullYear() && cursor.value.getMonth() === now.getMonth()
  }
  // Week view: check if today falls within the displayed week
  const days = weekDays.value
  return days.some(d => d.isToday)
})

function goToToday() {
  cursor.value = new Date()
  selectedDay.value = null
}

function prev() {
  const d = new Date(cursor.value)
  // Set day to 1 before shifting months so a 31st never overflows into the
  // wrong month (e.g. June 31 → July 1 would leave the month unchanged).
  if (view.value === 'month') {
    d.setDate(1)
    d.setMonth(d.getMonth() - 1)
  } else {
    d.setDate(d.getDate() - 7)
  }
  cursor.value = d
  selectedDay.value = null
}

function next() {
  const d = new Date(cursor.value)
  if (view.value === 'month') {
    d.setDate(1)
    d.setMonth(d.getMonth() + 1)
  } else {
    d.setDate(d.getDate() + 7)
  }
  cursor.value = d
  selectedDay.value = null
}

function toggleDay(dateStr: string) {
  selectedDay.value = selectedDay.value === dateStr ? null : dateStr
}

function cellAriaLabel(cell: { dateStr: string; exercises: string[]; isToday: boolean }): string {
  const date = new Date(cell.dateStr + 'T12:00:00')
  const dateLabel = date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
  const parts = [dateLabel]
  if (cell.isToday) parts.push('today')
  if (cell.exercises.length > 0) {
    parts.push(`${cell.exercises.length} exercise${cell.exercises.length !== 1 ? 's' : ''}`)
  }
  if (hasPR(cell.dateStr)) parts.push('PR')
  if (selectedDay.value === cell.dateStr) parts.push('selected')
  return parts.join(', ')
}

// Monthly grid cells
const monthCells = computed(() => {
  const year = cursor.value.getFullYear()
  const month = cursor.value.getMonth()
  const firstDow = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const prevMonthDays = new Date(year, month, 0).getDate()
  const cells = []

  for (let i = firstDow - 1; i >= 0; i--) {
    const day = prevMonthDays - i
    const d = new Date(year, month - 1, day)
    const dateStr = localDateKey(d)
    cells.push({ key: `p${day}`, day, dateStr, inMonth: false, isToday: dateStr === todayStr, exercises: trainingMap.value[dateStr] || [] })
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(year, month, day)
    const dateStr = localDateKey(d)
    cells.push({ key: `c${day}`, day, dateStr, inMonth: true, isToday: dateStr === todayStr, exercises: trainingMap.value[dateStr] || [] })
  }

  const rem = cells.length % 7
  if (rem > 0) {
    for (let day = 1; day <= 7 - rem; day++) {
      const d = new Date(year, month + 1, day)
      const dateStr = localDateKey(d)
      cells.push({ key: `n${day}`, day, dateStr, inMonth: false, isToday: dateStr === todayStr, exercises: trainingMap.value[dateStr] || [] })
    }
  }

  return cells
})

// Weekly days
const weekDays = computed(() => {
  const d = new Date(cursor.value)
  d.setDate(d.getDate() - d.getDay()) // back to Sunday
  const SHORT_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  return Array.from({ length: 7 }, (_, i) => {
    const curr = new Date(d)
    curr.setDate(d.getDate() + i)
    const dateStr = localDateKey(curr)
    return {
      dateStr,
      shortName: SHORT_NAMES[i],
      dayNum: curr.getDate(),
      isToday: dateStr === todayStr,
      exercises: trainingMap.value[dateStr] || []
    }
  })
})

// ── Weekly muscle group volume ────────────────────────────────────
const weekDateStrings = computed(() => weekDays.value.map(d => d.dateStr))
const exercisesRef = computed(() => filteredExercises.value)
const { weeklyVolume, maxSets, totalSets } = useTagVolume(exercisesRef, weekDateStrings)
const { tagTrends } = useTagVolumeTrend(exercisesRef)

// ── Week-over-week volume trend (full history, respects tag filter) ──
const { weeklyVolume: volumeTrend, totalVolume: volumeTrendTotal } = useVolumeTrend(exercisesRef)

// ── Rep-range distribution (full history, respects tag filter) ──
const { zones: repRangeZones, totalSets: repRangeTotal, dominant: repRangeDominant } = useRepRangeDistribution(exercisesRef)

// ── Tag recovery ─────────────────────────────────────────────────
const allExercisesRef = computed(() => store.exercises)
const tagRecoveryDaysRef = computed(() => store.tagRecoveryDays)
const tagRecoveryExcludedRef = computed(() => store.tagRecoveryExcluded)
// hiddenTags/hiddenCount are two views of the same answer, so they come from the
// one composable rather than being re-derived here — the local copy ran a second,
// identical scan of every set on every store trigger (#1236).
const {
  recovery: tagRecovery,
  hasData: hasRecoveryData,
  hiddenCount: recoveryHiddenCount,
  hiddenTags: recoveryHiddenTags,
} = useTagRecovery(allExercisesRef, tagRecoveryDaysRef, tagRecoveryExcludedRef)

function onRecoveryHide(tag: string) {
  store.setTagRecoveryExcluded(tag, true)
}

function onRecoveryShow(tag: string) {
  store.setTagRecoveryExcluded(tag, false)
}

function onRecoveryDaysChange(tag: string, days: number | null) {
  store.setTagRecoveryDays(tag, days)
}

const volumeCollapsed = ref(false)
const trendCollapsed = ref(true)
const repRangeCollapsed = ref(true)

// ── Year view (heatmap) ──────────────────────────────────────────
const heatmapYear = ref(new Date().getFullYear())

// Map YYYY-MM-DD → total sets (all exercises, ignoring tag filters for year-wide view)
const allDaySets = computed(() => {
  const map = new Map<string, number>()
  for (const exercise of store.exercises) {
    for (const set of exercise.sets) {
      const day = set.date.slice(0, 10)
      map.set(day, (map.get(day) || 0) + 1)
    }
  }
  return map
})

const heatmapDays = computed((): HeatmapDay[] => {
  const year = heatmapYear.value
  const result: HeatmapDay[] = []
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  const daysInYear = isLeap ? 366 : 365
  for (let i = 0; i < daysInYear; i++) {
    const d = new Date(year, 0, 1 + i)
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    result.push({ date: dateStr, sets: allDaySets.value.get(dateStr) || 0 })
  }
  return result
})

// Streak calculation: consecutive weeks with at least one workout
// A "week" is Mon–Sun (ISO 8601)
function getISOWeekStart(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00')
  const dow = d.getDay()
  const diff = dow === 0 ? -6 : 1 - dow // Monday
  d.setDate(d.getDate() + diff)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const workoutWeeks = computed(() => {
  const weeks = new Set<string>()
  for (const [dateStr, count] of allDaySets.value) {
    if (count > 0) {
      weeks.add(getISOWeekStart(dateStr))
    }
  }
  return Array.from(weeks).sort()
})

const currentWeekStreak = computed(() => {
  const weeks = workoutWeeks.value
  if (weeks.length === 0) return 0

  // Get the current week's Monday
  const now = new Date()
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const currentWeek = getISOWeekStart(todayStr)

  // Also get previous week in case current week hasn't started yet
  const prevWeekDate = new Date(currentWeek + 'T12:00:00')
  prevWeekDate.setDate(prevWeekDate.getDate() - 7)
  const prevWeek = `${prevWeekDate.getFullYear()}-${String(prevWeekDate.getMonth() + 1).padStart(2, '0')}-${String(prevWeekDate.getDate()).padStart(2, '0')}`

  const weekSet = new Set(weeks)

  // Start from current week or previous week if current has no data yet
  let anchor = weekSet.has(currentWeek) ? currentWeek : (weekSet.has(prevWeek) ? prevWeek : null)
  if (!anchor) return 0

  let streak = 0
  let check = anchor
  while (weekSet.has(check)) {
    streak++
    const d = new Date(check + 'T12:00:00')
    d.setDate(d.getDate() - 7)
    check = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  return streak
})

const longestWeekStreak = computed(() => {
  const weeks = workoutWeeks.value
  if (weeks.length === 0) return 0

  let longest = 1
  let current = 1

  for (let i = 1; i < weeks.length; i++) {
    const prevDate = new Date(weeks[i - 1] + 'T12:00:00')
    const currDate = new Date(weeks[i] + 'T12:00:00')
    const diffDays = Math.round((currDate.getTime() - prevDate.getTime()) / 86400000)

    if (diffDays === 7) {
      current++
      if (current > longest) longest = current
    } else {
      current = 1
    }
  }
  return longest
})

function formatSelectedDay(dateStr: string) {
  return new Date(dateStr + 'T12:00:00').toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric'
  })
}

// ── Log modal ─────────────────────────────────────────────────────
const { isOpen: pickerOpen, open: openPicker, close: closePicker } = useModal({
  selector: '[aria-labelledby="exercise-picker-title"]',
})
// focusContainer: the first field is a number input — focusing the dialog
// (not the field) lets iOS raise the keyboard on the user's first tap instead
// of deadlocking on a pre-focused field (#830).
const { isOpen: logModalOpen, open: openLogTrap, close: closeLogTrap } = useModal({
  selector: '[aria-labelledby="cal-modal-title"]',
  focusContainer: true,
})
const logModal = ref<{ date: string; exerciseId: string; weight: number | null; reps: number | null }>({ date: '', exerciseId: '', weight: null, reps: null })

const exercisePickerDate = ref<string | null>(null)

function openLogModal(dateStr: string) {
  exercisePickerDate.value = dateStr
  openPicker()
}

function pickExercise(exerciseId: string) {
  const dateStr = exercisePickerDate.value!
  exercisePickerDate.value = null
  closePicker()
  logModal.value = { date: dateStr, exerciseId, weight: null, reps: null }
  openLogTrap()
}

function closeLogModal() {
  closeLogTrap()
  logModal.value = { date: '', exerciseId: '', weight: null, reps: null }
}

function closeExercisePicker() {
  exercisePickerDate.value = null
  closePicker()
}

/** The exercise this backfill modal is logging for. */
const logModalExercise = computed(() =>
  store.exercises.find(e => e.id === logModal.value.exerciseId),
)

// Same copy rule as the log sheet: the field means ADDED weight on a
// bodyweight-loaded exercise, and "135" is a barbell's placeholder.
const logModalWeightLabel = computed(() =>
  allowsZeroWeight(logModalExercise.value) ? 'Added' : 'Weight',
)
const logModalWeightPlaceholder = computed(() =>
  allowsZeroWeight(logModalExercise.value) ? '0' : '135',
)

/**
 * Estimate for the set being backfilled. Runs the same `epley()` over the same
 * folded load the store will store (LIFT-834 / #1328) — this surface was still
 * estimating off the bare field, so a bodyweight-loaded pull-up read ~29 lbs
 * here against the ~216 `logSet` was about to write. Null rather than 0 when
 * there is no load at all (added 0 with no bodyweight on record): the row is a
 * readout, and "0 lbs" is not an estimate.
 */
const logModalEstimate = computed(() => {
  const { weight, reps, exerciseId } = logModal.value
  if (!isLoggableWeight(weight, logModalExercise.value) || !reps || reps < 1) return null
  const loadLbs = toLbs(weight!) + store.bodyweightFoldFor(exerciseId)
  if (loadLbs <= 0) return null
  return displayWeight(epley(loadLbs, reps))
})

/**
 * The backfill path's weight floor. Shares `isLoggableWeight` with the log
 * sheet (LIFT-1330) so the second entry point can't keep refusing the
 * pure-bodyweight set the first one now accepts.
 */
const canSaveLog = computed(() => {
  const { exerciseId, weight, reps } = logModal.value
  return !!exerciseId && isLoggableWeight(weight, logModalExercise.value) && reps !== null && reps >= 1
})

function saveLog() {
  if (!canSaveLog.value) return
  const { exerciseId, weight, reps, date } = logModal.value
  if (weight === null || reps === null) return
  store.logSet(exerciseId, toLbs(weight), reps, date)
  logEvent('set_log', { source: 'calendar' })
  closeLogModal()
}
</script>

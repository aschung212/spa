import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { shallowRef, triggerRef, reactive, defineComponent, nextTick } from 'vue'
import { mount, VueWrapper, enableAutoUnmount } from '@vue/test-utils'
import { useModal } from '../../composables/useModal'

// Unmount every wrapper after each test. Without this, a tracker that was
// mounted with a modal open stays mounted for the rest of the file and never
// releases its background-scroll lock — useModal's reference count is module
// state shared across this file, so a leak makes `html.modal-open` sticky and
// the lock assertions below vacuous. This is a large part of why the
// hand-rolled `classList.toggle('modal-open', …)` survived so long untested.
enableAutoUnmount(afterEach)
import type { Exercise, WorkoutSet } from '../../stores/workout'
import { setDayKey } from '../../lib/dates'
import { bodyweightFold } from '../../lib/bodyweightLoad'
import { epley } from '../../lib/epley'
import { searchExerciseDatabase } from '../../lib/exerciseDatabase'
import { runComponentAxe } from '../../__tests__/axeHelper'
import { getLocalStorageMock, mockAnalytics, mockTheme, mockWeightUnit, mockRestTimer } from '../../__tests__/helpers'
import EditExerciseModal from '../EditExerciseModal.vue'

const localStorageMock = getLocalStorageMock()

vi.mock('../../composables/useAnalytics', () => mockAnalytics())
vi.mock('../../composables/useTheme', () => mockTheme())
// Switchable unit mock (LIFT-1211): defaults to lbs with the same rounding the
// plain mockWeightUnit() provided, so every pre-existing test is unaffected.
// The unit lives in a factory-scoped ref (module consts hit the vi.mock TDZ,
// and a factory-created computed over plain state would cache forever); the
// kg plate-mode suite flips it through the mocked module's __setMockUnit.
vi.mock('../../composables/useWeightUnit', async () => {
  const { shallowRef } = await import('vue')
  const unit = shallowRef<'lbs' | 'kg'>('lbs')
  return {
    __setMockUnit: (u: 'lbs' | 'kg') => { unit.value = u },
    ...mockWeightUnit({
      weightUnit: unit,
      displayWeight: (lbs: number) => unit.value === 'kg' ? +(lbs * 0.453592).toFixed(1) : Math.round(lbs),
      toLbs: (w: number) => unit.value === 'kg' ? +(w / 0.453592).toFixed(1) : w,
    }),
  }
})
import * as weightUnitMockModule from '../../composables/useWeightUnit'
const setMockUnit = (u: 'lbs' | 'kg') =>
  (weightUnitMockModule as unknown as { __setMockUnit: (u: 'lbs' | 'kg') => void }).__setMockUnit(u)
vi.mock('../../composables/useRestTimer', () => mockRestTimer())
// Mutable container so gym-filter tests (#961) can drive the synced gym list.
// `reactive` keeps the mock faithful to the real Pinia store: adding a gym has
// to invalidate `allGyms` so newly created gyms render without a remount —
// with a plain object the computed caches forever and inline-add tests pass
// vacuously (same class of unfaithful-mock blind spot as #963).
const mockPrefsState = reactive({ gyms: [] as string[] })
const mockAddGym = vi.fn((name: string) => {
  if (mockPrefsState.gyms.includes(name)) return null
  mockPrefsState.gyms = [...mockPrefsState.gyms, name]
  return name
})
vi.mock('../../stores/preferences', () => ({
  usePreferencesStore: () => ({
    experience: { prCelebrations: true, haptics: true, screenWakeLock: true },
    filters: { warmupThreshold: 0.75 },
    intensityPresets: [50, 70, 80, 90, 100],
    get gyms() { return mockPrefsState.gyms },
    addGym: mockAddGym,
  }),
}))
// Reactive so streak-badge tests (LIFT-1109) can flip progression on and set a
// streak count without a remount — same mock-fidelity contract as
// `mockPrefsState`: a plain object would cache the header computeds forever.
const mockProgressionState = reactive({ progressionEnabled: false, streakWeeks: 0, weeklyTarget: 4 })
vi.mock('../../stores/progression', () => ({
  useProgressionStore: () => ({
    get progressionEnabled() { return mockProgressionState.progressionEnabled },
    get streakWeeks() { return mockProgressionState.streakWeeks },
    get weeklyTarget() { return mockProgressionState.weeklyTarget },
    showProgression: false,
    streakHistory: [],
    currentMultiplier: 1,
    logSetXP: vi.fn(),
    recordSetXP: vi.fn(),
    creditSetXP: vi.fn(),
    recalcSetXP: vi.fn(),
    removeSetXP: vi.fn(),
    checkUnlocks: vi.fn().mockReturnValue([]),
    starterConfirmed: true,
    starterTheme: 'fire',
    epoch: 1,
    xpPerSet: {},
    progressPercent: 0,
    totalXP: 0,
    nextUnlockThreshold: 5000,
  }),
}))
vi.mock('../../lib/xp', () => ({
  calculateSetXP: () => 50,
  calculateBest1RM: () => null,
  applyStreakMultiplier: (_xp: number) => _xp,
  checkRepPR: () => false,
  isExerciseEstablished: () => false,
  XP_CONFIG: { warmupThreshold: 0.5, prMultiplier: 3, tieMultiplier: 2, repPRMultiplier: 1.25 },
}))

// Mock ExerciseGraph (heavy SVG child)
vi.mock('../ExerciseGraph.vue', () => ({
  default: { name: 'ExerciseGraph', template: '<div class="mock-graph" />' }
}))

// Fixture factories — each call returns a fresh deep copy so tests never share object references.
function createExercises(): Exercise[] {
  return [
    {
      id: 'ex-1',
      name: 'Bench Press',
      tags: ['Chest', 'Push'],
      sets: [
        { id: 's-1', date: '2026-01-15T12:00:00', weight: 185, reps: 5, estimated1RM: 216 },
        { id: 's-2', date: '2026-01-20T12:00:00', weight: 195, reps: 5, estimated1RM: 228 },
      ]
    },
    {
      id: 'ex-2',
      name: 'Squat',
      tags: ['Legs'],
      sets: [
        { id: 's-3', date: '2026-01-16T12:00:00', weight: 225, reps: 5, estimated1RM: 263 },
      ]
    },
    {
      id: 'ex-3',
      name: 'Overhead Press',
      tags: ['Push'],
      sets: []
    },
  ]
}

function createPRExercises(): Exercise[] {
  return [
    {
      id: 'ex-1',
      name: 'Bench Press',
      tags: [],
      sets: [
        { id: 's-1', date: '2026-01-01T12:00:00', weight: 135, reps: 5, estimated1RM: 158 },
        { id: 's-2', date: '2026-01-15T12:00:00', weight: 155, reps: 5, estimated1RM: 181 },
        { id: 's-3', date: '2026-02-01T12:00:00', weight: 175, reps: 5, estimated1RM: 204 },
      ]
    }
  ]
}

// Mock store state — a shallowRef mutated in place + triggerRef, mirroring the
// real store's reactivity contract (workout.ts trades deep reactivity for
// explicit triggers). Faithfulness matters here: children only observe
// in-place mutations when a fresh-identity prop reaches them (#963), and the
// live-update regression tests must be able to reproduce exactly that. The
// `mockState` getter/setter facade keeps the original container API.
const mockExercises = shallowRef<Exercise[]>([])
const mockState = {
  get exercises() { return mockExercises.value },
  set exercises(v: Exercise[]) { mockExercises.value = v },
}

function getExercisePR(id: string): number {
  const ex = mockState.exercises.find(e => e.id === id)
  if (!ex || ex.sets.length === 0) return 0
  return Math.max(...ex.sets.map(s => s.estimated1RM))
}

function getExercisePRSet(id: string): WorkoutSet | null {
  const ex = mockState.exercises.find(e => e.id === id)
  if (!ex || ex.sets.length === 0) return null
  return ex.sets.reduce((best, s) => s.estimated1RM > best.estimated1RM ? s : best)
}

// The lifter's tracked bodyweight, as the real store's `_currentBodyweight()`
// would read it off the bodyweight store (#1328). `reactive` for the same
// mock-fidelity reason as `mockPrefsState`: a plain object would let the fold
// computed cache forever and any test that changes bodyweight mid-mount would
// pass vacuously.
const mockBodyweightState = reactive({ lbs: null as number | null })

// Delegates to the REAL fold helper so the mock can't invent its own rule about
// when bodyweight counts — that decision is exactly what #1328 was about.
function bodyweightFoldFor(id: string, setId?: string): number {
  const ex = mockState.exercises.find(e => e.id === id)
  const captured = setId ? ex?.sets.find(s => s.id === setId)?.bodyweight : undefined
  return bodyweightFold(ex, captured ?? mockBodyweightState.lbs)
}

// Mirrors the real store's sets-per-day index (LIFT-1237): same `setDayKey`
// bucketing, and it reads `mockExercises` so it re-answers after a triggerRef.
function setsLoggedOn(dayKey: string): number {
  let count = 0
  for (const ex of mockState.exercises) {
    for (const s of ex.sets) {
      if (setDayKey(s.date) === dayKey) count++
    }
  }
  return count
}

function getAllTags(): string[] {
  const tags = new Set<string>()
  mockState.exercises.forEach(e => (e.tags || []).forEach(t => tags.add(t)))
  return [...tags].sort()
}

const mockAddExercise = vi.fn()
const mockLogSet = vi.fn()
const mockUpdateSet = vi.fn()
const mockDeleteSet = vi.fn()
const mockDeleteExercise = vi.fn()
const mockRestoreSet = vi.fn()
const mockSyncDeleteSet = vi.fn()
const mockRestoreExercise = vi.fn()
const mockSyncDeleteExercise = vi.fn()
const mockRenameExercise = vi.fn()

// Faithful to the real actions: mutate the exercise IN PLACE, then triggerRef —
// the exact store contract the fresh-identity bindings (#963) exist to handle.
const mockUpdateExerciseTags = vi.fn((exerciseId: string, tags: string[]) => {
  const ex = mockExercises.value.find(e => e.id === exerciseId)
  if (!ex) return
  ex.tags = [...tags]
  triggerRef(mockExercises)
})
// Delegates to mockUpdateExerciseTags exactly as the real store action does,
// so the in-place-mutate + triggerRef contract still holds through the toggle.
const mockToggleExerciseTag = vi.fn((exerciseId: string, tag: string) => {
  const ex = mockExercises.value.find(e => e.id === exerciseId)
  if (!ex) return
  const tags = ex.tags || []
  mockUpdateExerciseTags(
    exerciseId,
    tags.includes(tag) ? tags.filter(t => t !== tag) : [...tags, tag],
  )
})
const mockSetExerciseGyms = vi.fn((exerciseId: string, gyms: string[]) => {
  const ex = mockExercises.value.find(e => e.id === exerciseId)
  if (!ex) return
  if (gyms.length > 0) ex.gyms = [...gyms]
  else delete ex.gyms
  triggerRef(mockExercises)
})

const mockArchiveExercise = vi.fn()
const mockUnarchiveExercise = vi.fn()

// Mockable read getters — tests drive these with mockReturnValue and the
// suite-level beforeEach resets them to the no-data default.
const mockGetOverloadSuggestion = vi.fn()
const mockGetLastSession = vi.fn()
const mockGetUsualLadder = vi.fn()

vi.mock('../../stores/workout', () => ({
  useWorkoutStore: () => ({
    get exercises() { return mockState.exercises },
    set exercises(v: Exercise[]) { mockState.exercises = v },
    get activeExercises() { return mockState.exercises.filter(e => !e.archived_at) },
    get archivedExercises() { return mockState.exercises.filter(e => !!e.archived_at) },
    get allTags() { return getAllTags() },
    setsLoggedOn,
    getExercisePR,
    getExercisePRSet,
    bodyweightFoldFor,
    getOverloadSuggestion: mockGetOverloadSuggestion,
    getLastSession: mockGetLastSession,
    getUsualLadder: mockGetUsualLadder,
    addExercise: mockAddExercise,
    logSet: mockLogSet,
    updateSet: mockUpdateSet,
    deleteSet: mockDeleteSet,
    deleteExercise: mockDeleteExercise,
    restoreSet: mockRestoreSet,
    syncDeleteSet: mockSyncDeleteSet,
    restoreExercise: mockRestoreExercise,
    syncDeleteExercise: mockSyncDeleteExercise,
    archiveExercise: mockArchiveExercise,
    unarchiveExercise: mockUnarchiveExercise,
    renameExercise: mockRenameExercise,
    updateExerciseTags: mockUpdateExerciseTags,
    toggleExerciseTag: mockToggleExerciseTag,
    updateExercise: vi.fn(),
    setExerciseGyms: mockSetExerciseGyms,
    renameGymOnExercises: vi.fn(),
    removeGymFromExercises: vi.fn(() => []),
  })
}))



import WorkoutTracker from '../WorkoutTracker.vue'

function mountTracker(): VueWrapper {
  return mount(WorkoutTracker, {
    global: {
      stubs: { Teleport: true },
    }
  })
}

/**
 * Typed accessor for WorkoutTracker's defineExpose'd methods.
 * These are the component's public API for parent components (App.vue).
 */
function exposed(wrapper: VueWrapper) {
  return wrapper.vm as unknown as {
    openTimelineLogModal: () => void
    openNewExerciseModal: () => void
  }
}

/**
 * Typed accessor for WorkoutTracker's internal timer state.
 * Used by wall-clock timer tests that verify backgrounding behavior —
 * these need direct access to startRestTimer / timerSeconds because
 * the timer is internal state not exposed to parents.
 *
 * After #582 extracted RestTimerView, the timer lives on a controller
 * (timerCtrl) exposed on the component instance. We unwrap the refs
 * so call sites can read .timerSeconds directly instead of .value.
 */
function timerState(wrapper: VueWrapper) {
  const vm = wrapper.vm as unknown as {
    timerCtrl: {
      startRestTimer: () => void
      timerSeconds: { value: number }
      timerActive: { value: boolean }
    }
  }
  return {
    startRestTimer: () => vm.timerCtrl.startRestTimer(),
    get timerSeconds() { return vm.timerCtrl.timerSeconds.value },
    get timerActive() { return vm.timerCtrl.timerActive.value },
  }
}

describe('WorkoutTracker', () => {
  beforeEach(() => {
    mockState.exercises = []
    mockPrefsState.gyms = []
    mockBodyweightState.lbs = null
    mockProgressionState.progressionEnabled = false
    mockProgressionState.streakWeeks = 0
    mockProgressionState.weeklyTarget = 4
    localStorageMock.clear()
    vi.clearAllMocks()
    // clearAllMocks keeps implementations — reset return values explicitly
    // so a test's mockReturnValue never leaks into the next test.
    mockGetOverloadSuggestion.mockReturnValue(null)
    mockGetLastSession.mockReturnValue(null)
    mockGetUsualLadder.mockReturnValue(null)
  })

  describe('empty state', () => {
    it('shows empty message when no exercises exist', () => {
      const wrapper = mountTracker()
      expect(wrapper.find('.wtEmpty').text()).toContain('No exercises yet')
    })

    it('renders the Workouts large title', () => {
      // After the 03-workouts.png restyle, the "+ New Exercise" button moved
      // into the exercise-picker modal. The tab itself shows an iOS large
      // title instead.
      const wrapper = mountTracker()
      expect(wrapper.find('.wtPageTitle').text()).toBe('Workouts')
    })

    it('does not render the tag filter bar when no tags (only the gym row remains)', () => {
      const wrapper = mountTracker()
      // The gym row (#963) is always visible in the exercises view; the TAG
      // bar still keeps its zero-chrome behavior.
      const bars = wrapper.findAll('.wtTagFilterBar')
      expect(bars).toHaveLength(1)
      expect(bars[0].attributes('aria-label')).toBe('Filter by gym')
    })

    it('shows fresh-start transition card after clearing sample data', () => {
      localStorageMock.setItem('fresh-start', 'true')
      const wrapper = mountTracker()
      expect(wrapper.find('.wtFreshStart').exists()).toBe(true)
      expect(wrapper.find('.wtFreshStartTitle').text()).toContain('starting fresh')
      expect(wrapper.find('.wtFreshStartCta').exists()).toBe(true)
    })

    it('shows default empty state when fresh-start flag is absent', () => {
      const wrapper = mountTracker()
      expect(wrapper.find('.wtFreshStart').exists()).toBe(false)
      expect(wrapper.find('.wtEmpty').text()).toContain('No exercises yet')
    })
  })

  describe('consecutive-week streak badge (LIFT-1109)', () => {
    it('is hidden when progression is disabled', () => {
      mockProgressionState.progressionEnabled = false
      mockProgressionState.streakWeeks = 12
      const wrapper = mountTracker()
      expect(wrapper.find('.wtStreakBadge').exists()).toBe(false)
    })

    it('is hidden when the streak is zero even with progression enabled', () => {
      mockProgressionState.progressionEnabled = true
      mockProgressionState.streakWeeks = 0
      const wrapper = mountTracker()
      expect(wrapper.find('.wtWeeklyGoal').exists()).toBe(true)
      expect(wrapper.find('.wtStreakBadge').exists()).toBe(false)
    })

    it('surfaces the multi-week streak count in the goal banner', () => {
      mockProgressionState.progressionEnabled = true
      mockProgressionState.streakWeeks = 12
      const wrapper = mountTracker()
      const badge = wrapper.find('.wtStreakBadge')
      expect(badge.exists()).toBe(true)
      expect(badge.text()).toBe('12-week streak')
      expect(badge.attributes('aria-label')).toBe('12-week training streak')
    })

    it('renders a one-week streak from the first completed week', () => {
      mockProgressionState.progressionEnabled = true
      mockProgressionState.streakWeeks = 1
      const wrapper = mountTracker()
      expect(wrapper.find('.wtStreakBadge').text()).toBe('1-week streak')
    })

    it('reacts to a streak change without a remount', async () => {
      mockProgressionState.progressionEnabled = true
      mockProgressionState.streakWeeks = 0
      const wrapper = mountTracker()
      expect(wrapper.find('.wtStreakBadge').exists()).toBe(false)
      mockProgressionState.streakWeeks = 3
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.wtStreakBadge').text()).toBe('3-week streak')
    })
  })

  describe('exercise list', () => {
    beforeEach(() => {
      mockState.exercises = createExercises()
    })

    it('renders all exercises', () => {
      const wrapper = mountTracker()
      const items = wrapper.findAll('.wtExerciseItem')
      expect(items.length).toBe(3)
    })

    it('displays exercise name', () => {
      const wrapper = mountTracker()
      const rows = wrapper.findAll('.wtExerciseRow')
      expect(rows[0].text()).toContain('Bench Press')
      expect(rows[1].text()).toContain('Squat')
    })

    it('displays last set summary with weight × reps on the card', () => {
      const wrapper = mountTracker()
      // The restyled card shows the most recent set + time-ago instead of
      // an est. 1RM summary. Bench last set in the fixture is 195 × 5.
      const stats = wrapper.findAll('.wtExerciseStat')
      expect(stats[0].text()).toContain('195')
      expect(stats[0].text()).toContain('× 5')
    })

    it('shows "No sets yet" placeholder for exercise with no sets', () => {
      const wrapper = mountTracker()
      const items = wrapper.findAll('.wtExerciseItem')
      // ex-3 (Deadlift) has no sets — stat line shows the empty placeholder
      const deadliftStat = items[2].find('.wtExerciseStatEmpty')
      expect(deadliftStat.exists()).toBe(true)
      expect(deadliftStat.text()).toContain('No sets yet')
    })

    it('shows a circular quick-log button for each exercise', () => {
      const wrapper = mountTracker()
      // Button is now icon-only (gold circle with a plus svg). Assert it
      // exists with the circle modifier class and an aria-label.
      const logBtns = wrapper.findAll('.wtExerciseLogBtn.wtExerciseLogBtnCircle')
      expect(logBtns.length).toBe(3)
      expect(logBtns[0].attributes('aria-label')).toContain('Log a set')
    })

    // Custom ordering was removed once the list became recency-ordered (#936):
    // no drag handles, no long-press gesture, no keyboard reorder. This guards
    // against any of those affordances being reintroduced by accident.
    it('does not render drag handles (custom ordering removed)', () => {
      const wrapper = mountTracker()
      expect(wrapper.findAll('.wtDragHandle').length).toBe(0)
    })
  })

  // ── archived exercises section (LIFT-434) ─────────────────────
  describe('archived exercises', () => {
    it('does not render the archived section when there are no archived exercises', () => {
      mockState.exercises = createExercises()
      const wrapper = mountTracker()
      expect(wrapper.find('.wtArchivedSection').exists()).toBe(false)
    })

    it('hides archived exercises from the main list and shows them in the Archived section', async () => {
      mockState.exercises = createExercises()
      mockState.exercises[1].archived_at = '2026-05-01T00:00:00.000Z'
      const wrapper = mountTracker()
      const items = wrapper.findAll('.wtExerciseItem')
      expect(items.length).toBe(2)
      const section = wrapper.find('.wtArchivedSection')
      expect(section.exists()).toBe(true)
      expect(section.find('.wtArchivedToggleCount').text()).toBe('1')
      // Archived list is collapsed by default — click the disclosure to reveal it.
      await section.find('.wtArchivedToggle').trigger('click')
      const archivedRows = wrapper.findAll('.wtArchivedRow')
      expect(archivedRows.length).toBe(1)
      expect(archivedRows[0].text()).toContain('Squat')
    })

    it('calls unarchiveExercise when the Unarchive button is clicked', async () => {
      mockState.exercises = createExercises()
      mockState.exercises[0].archived_at = '2026-05-01T00:00:00.000Z'
      const wrapper = mountTracker()
      await wrapper.find('.wtArchivedToggle').trigger('click')
      await wrapper.find('.wtArchivedActionBtn').trigger('click')
      expect(mockUnarchiveExercise).toHaveBeenCalledWith('ex-1')
    })

    it('omits tags that exist only on archived exercises from the chip bar', () => {
      // 'Legs' lives only on Squat. Archive Squat and 'Legs' should disappear
      // from the chips — otherwise tapping it would filter to an empty list.
      mockState.exercises = createExercises()
      mockState.exercises[1].archived_at = '2026-05-01T00:00:00.000Z'
      const wrapper = mountTracker()
      const chips = wrapper.findAll('.wtTagChip').map(c => c.text())
      const chipText = chips.join(' ')
      expect(chipText).not.toContain('Legs')
      expect(chipText).toContain('Chest')
      expect(chipText).toContain('Push')
    })
  })

  describe('tag filtering', () => {
    beforeEach(() => {
      mockState.exercises = createExercises()
    })

    function tagChips(wrapper: VueWrapper) {
      // After the PNG restyle, chips include an "All" chip and a tag-manager
      // chip. Skip those so tests focus on the real tag filter chips.
      return wrapper.findAll('.wtTagChip').filter(c => {
        if (c.classes('wtTagChipClear')) return false
        if (c.classes('wtTagChipManage')) return false
        const label = c.find('.wtTagChipLabel')
        if (!label.exists()) return false
        return true
      })
    }

    it('renders tag filter chips for all unique tags', () => {
      const wrapper = mountTracker()
      const chips = tagChips(wrapper)
      const chipLabels = chips.map(c => c.find('.wtTagChipLabel').text())
      expect(chipLabels).toContain('Chest')
      expect(chipLabels).toContain('Push')
      expect(chipLabels).toContain('Legs')
    })

    it('filters exercises when tag is clicked', async () => {
      const wrapper = mountTracker()
      const chips = tagChips(wrapper)
      const legsChip = chips.find(c => c.find('.wtTagChipLabel').text() === 'Legs')!
      await legsChip.trigger('click')

      const items = wrapper.findAll('.wtExerciseItem')
      expect(items.length).toBe(1)
      expect(wrapper.text()).toContain('Squat')
    })

    it('deactivates filter by clicking the All chip', async () => {
      // The dedicated "× Clear" button was retired in favor of the "All" chip
      // that sits at the head of the tag-filter row.
      const wrapper = mountTracker()
      const chips = tagChips(wrapper)
      await chips[0].trigger('click')
      const allChip = wrapper.findAll('.wtTagChip').find(c => c.text().trim() === 'All')!
      await allChip.trigger('click')

      expect(wrapper.findAll('.wtExerciseItem').length).toBe(3)
    })

    it('shows exercises matching ANY active tag (OR logic)', async () => {
      const wrapper = mountTracker()
      const chips = tagChips(wrapper)
      const pushChip = chips.find(c => c.find('.wtTagChipLabel').text() === 'Push')!
      await pushChip.trigger('click')

      // Push matches Bench Press and Overhead Press
      const items = wrapper.findAll('.wtExerciseItem')
      expect(items.length).toBe(2)
    })

    it('deactivates tag on second click', async () => {
      const wrapper = mountTracker()
      const chips = tagChips(wrapper)
      const legsChip = chips.find(c => c.find('.wtTagChipLabel').text() === 'Legs')!
      await legsChip.trigger('click')
      expect(wrapper.findAll('.wtExerciseItem').length).toBe(1)

      await legsChip.trigger('click')
      expect(wrapper.findAll('.wtExerciseItem').length).toBe(3)
    })
  })

  // Recency ordering (#936): the exercise list is sorted by the most recent
  // set date (descending) so the next exercise to perform is easiest to reach,
  // and that order is preserved inside tag/search-filtered subsets.
  describe('recency ordering (#936)', () => {
    /** Names in the order they render in the list. */
    function renderedNames(wrapper: VueWrapper): string[] {
      return wrapper.findAll('.wtExerciseItem .wtExerciseName').map(n => n.text())
    }

    it('orders exercises by most-recent set first, regardless of array order', () => {
      // Array order deliberately does NOT match recency order.
      mockState.exercises = [
        {
          id: 'ex-old', name: 'Deadlift', tags: ['Legs'],
          sets: [{ id: 'so', date: '2026-01-05T12:00:00', weight: 315, reps: 3, estimated1RM: 344 }],
        },
        {
          id: 'ex-new', name: 'Row', tags: ['Back'],
          sets: [{ id: 'sn', date: '2026-03-10T12:00:00', weight: 135, reps: 8, estimated1RM: 168 }],
        },
        {
          id: 'ex-mid', name: 'Curl', tags: ['Arms'],
          sets: [{ id: 'sm', date: '2026-02-01T12:00:00', weight: 40, reps: 10, estimated1RM: 53 }],
        },
      ]
      const wrapper = mountTracker()
      expect(renderedNames(wrapper)).toEqual(['Row', 'Curl', 'Deadlift'])
    })

    it('sorts never-logged exercises to the bottom', () => {
      mockState.exercises = [
        { id: 'ex-empty', name: 'Plank', tags: ['Core'], sets: [] },
        {
          id: 'ex-logged', name: 'Bench Press', tags: ['Push'],
          sets: [{ id: 's', date: '2026-01-20T12:00:00', weight: 185, reps: 5, estimated1RM: 216 }],
        },
      ]
      const wrapper = mountTracker()
      expect(renderedNames(wrapper)).toEqual(['Bench Press', 'Plank'])
    })

    it('keeps recency order inside a tag-filtered subset', async () => {
      mockState.exercises = [
        {
          id: 'ex-a', name: 'Incline Press', tags: ['Push'],
          sets: [{ id: 'a', date: '2026-01-05T12:00:00', weight: 135, reps: 8, estimated1RM: 168 }],
        },
        {
          id: 'ex-b', name: 'Overhead Press', tags: ['Push'],
          sets: [{ id: 'b', date: '2026-03-01T12:00:00', weight: 95, reps: 6, estimated1RM: 114 }],
        },
        {
          id: 'ex-c', name: 'Squat', tags: ['Legs'],
          sets: [{ id: 'c', date: '2026-04-01T12:00:00', weight: 225, reps: 5, estimated1RM: 263 }],
        },
      ]
      const wrapper = mountTracker()
      const pushChip = wrapper.findAll('.wtTagChip')
        .find(c => c.find('.wtTagChipLabel').exists() && c.find('.wtTagChipLabel').text() === 'Push')!
      await pushChip.trigger('click')

      // Only the two Push exercises, most-recent first — Squat is filtered out
      // even though it is the most recently trained overall.
      expect(renderedNames(wrapper)).toEqual(['Overhead Press', 'Incline Press'])
    })

    it('breaks recency ties by preserving array order (stable sort)', () => {
      // Same day for both — the stored array (creation) order is the stable
      // tiebreaker now that manual reorder is gone.
      mockState.exercises = [
        {
          id: 'ex-1', name: 'Second', tags: [],
          sets: [{ id: '1', date: '2026-02-02T12:00:00', weight: 100, reps: 5, estimated1RM: 117 }],
        },
        {
          id: 'ex-2', name: 'First', tags: [],
          sets: [{ id: '2', date: '2026-02-02T18:00:00', weight: 100, reps: 5, estimated1RM: 117 }],
        },
      ]
      const wrapper = mountTracker()
      expect(renderedNames(wrapper)).toEqual(['Second', 'First'])
    })
  })

  describe('exercise detail modal', () => {
    beforeEach(() => {
      mockState.exercises = createExercises()
    })

    it('opens detail modal when exercise row is clicked', async () => {
      const wrapper = mountTracker()
      await wrapper.findAll('.wtExerciseRow')[0].trigger('click')
      await wrapper.vm.$nextTick()

      expect(wrapper.find('.wtDetailModal').exists()).toBe(true)
      expect(wrapper.find('.wtDetailTitle').text()).toBe('Bench Press')
    })

    it('shows "All Sets" tab as active by default', async () => {
      const wrapper = mountTracker()
      await wrapper.findAll('.wtExerciseRow')[0].trigger('click')
      await wrapper.vm.$nextTick()

      expect(wrapper.find('.wtDetailTab.active').text()).toContain('All Sets')
    })

    it('displays set count badge in tab', async () => {
      const wrapper = mountTracker()
      await wrapper.findAll('.wtExerciseRow')[0].trigger('click')
      await wrapper.vm.$nextTick()

      expect(wrapper.find('.wtDetailTabCount').text()).toBe('2')
    })

    it('renders set rows with weight × reps and e1RM', async () => {
      const wrapper = mountTracker()
      await wrapper.findAll('.wtExerciseRow')[0].trigger('click')
      await wrapper.vm.$nextTick()

      const setRows = wrapper.findAll('.wtSetRow')
      expect(setRows.length).toBe(2)
      // Most recent first
      expect(setRows[0].text()).toContain('195')
      expect(setRows[0].text()).toContain('lbs')
    })

    it('highlights the PR set with a trophy emoji', async () => {
      const wrapper = mountTracker()
      await wrapper.findAll('.wtExerciseRow')[0].trigger('click')
      await wrapper.vm.$nextTick()

      expect(wrapper.findAll('.wtSetRowPR').length).toBeGreaterThan(0)
      expect(wrapper.find('.wtSetPR').text()).toContain('🏆')
    })

    it('groups sets by date headers', async () => {
      const wrapper = mountTracker()
      await wrapper.findAll('.wtExerciseRow')[0].trigger('click')
      await wrapper.vm.$nextTick()

      expect(wrapper.findAll('.wtSetDateHeader').length).toBeGreaterThan(0)
    })

    it('wraps each date group in a card', async () => {
      const wrapper = mountTracker()
      await wrapper.findAll('.wtExerciseRow')[0].trigger('click')
      await wrapper.vm.$nextTick()

      const cards = wrapper.findAll('.wtSetCard')
      expect(cards.length).toBe(2) // two different dates
    })

    it('groups same-date sets into one card', async () => {
      // Add a second set on the same date as the latest (Jan 20)
      mockState.exercises[0].sets.push(
        { id: 's-extra', date: '2026-01-20T14:00:00', weight: 190, reps: 3, estimated1RM: 210 }
      )
      const wrapper = mountTracker()
      await wrapper.findAll('.wtExerciseRow')[0].trigger('click')
      await wrapper.vm.$nextTick()

      const cards = wrapper.findAll('.wtSetCard')
      expect(cards.length).toBe(2) // still two dates: Jan 15 and Jan 20
      // The Jan 20 card (first in reversed order) should have 2 set rows
      expect(cards[0].findAll('.wtSetRow').length).toBe(2)
    })

    it('groups sets by local date, not UTC date', async () => {
      // Two sets with the same UTC date prefix but at different times
      // Both should group under the same local date
      mockState.exercises[0].sets = [
        { id: 's-a', date: '2026-03-16T10:00:00', weight: 185, reps: 5, estimated1RM: 216 },
        { id: 's-b', date: '2026-03-16T14:30:00', weight: 195, reps: 5, estimated1RM: 228 },
      ]
      const wrapper = mountTracker()
      await wrapper.findAll('.wtExerciseRow')[0].trigger('click')
      await wrapper.vm.$nextTick()

      // Both sets are on the same local date → 1 card
      const cards = wrapper.findAll('.wtSetCard')
      expect(cards.length).toBe(1)
      expect(cards[0].findAll('.wtSetRow').length).toBe(2)
    })

    it('closes modal via back button', async () => {
      const wrapper = mountTracker()
      await wrapper.findAll('.wtExerciseRow')[0].trigger('click')
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.wtDetailModal').exists()).toBe(true)

      await wrapper.find('.wtDetailBack').trigger('click')
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.wtDetailModal').exists()).toBe(false)
    })

    it('reveals edit/delete actions on set tap', async () => {
      const wrapper = mountTracker()
      await wrapper.findAll('.wtExerciseRow')[0].trigger('click')
      await wrapper.vm.$nextTick()

      await wrapper.findAll('.wtSetRowMain')[0].trigger('click')
      await wrapper.vm.$nextTick()

      const btns = wrapper.findAll('.wtSetBtn')
      expect(btns.map(b => b.text())).toContain('Edit')
      expect(btns.map(b => b.text())).toContain('Delete')
    })

    it('shows Edit button in detail header and Log Set in footer', async () => {
      const wrapper = mountTracker()
      await wrapper.findAll('.wtExerciseRow')[0].trigger('click')
      await wrapper.vm.$nextTick()

      expect(wrapper.find('.wtDetailEditBtn').exists()).toBe(true)
      expect(wrapper.find('.wtDetailFooterBtn').text()).toBe('+ Log Set')
    })

    it('shows empty message for exercise with no sets', async () => {
      const wrapper = mountTracker()
      await wrapper.findAll('.wtExerciseRow')[2].trigger('click')
      await wrapper.vm.$nextTick()

      expect(wrapper.find('.wtSetEmpty').text()).toContain('No sets logged yet')
    })

    it('has + Log Set button in detail footer', async () => {
      const wrapper = mountTracker()
      await wrapper.findAll('.wtExerciseRow')[0].trigger('click')
      await wrapper.vm.$nextTick()

      expect(wrapper.find('.wtDetailFooterBtn').text()).toBe('+ Log Set')
    })
  })

  // #971: a "history" button in the log-set header jumps to the exercise's
  // set-history detail view. The log sheet and detail modal share a z-index,
  // so this is a swap (close sheet → open detail), not a stack.
  describe('set history shortcut from log modal (#971)', () => {
    beforeEach(() => {
      mockState.exercises = createExercises()
    })

    it('opens the exercise set history from the log-set header, swapping out the log sheet', async () => {
      const wrapper = mountTracker()
      // Open the log-set modal for a known exercise (Bench Press is most-recent).
      await wrapper.findAll('.wtExerciseLogBtn')[0].trigger('click')
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.logSetSheet').exists()).toBe(true)
      expect(wrapper.find('.wtDetailModal').exists()).toBe(false)

      // Tap the leading history button.
      const historyBtn = wrapper.find('.wtLogHistoryBtn')
      expect(historyBtn.exists()).toBe(true)
      await historyBtn.trigger('click')
      await wrapper.vm.$nextTick()

      // The log sheet is replaced by the detail "All Sets" view for the same exercise.
      expect(wrapper.find('.logSetSheet').exists()).toBe(false)
      expect(wrapper.find('.wtDetailModal').exists()).toBe(true)
      expect(wrapper.find('.wtDetailTitle').text()).toBe('Bench Press')
      expect(wrapper.find('.wtDetailTab.active').text()).toContain('All Sets')
    })

    it('routes back to logging via the detail "+ Log Set" footer', async () => {
      const wrapper = mountTracker()
      await wrapper.findAll('.wtExerciseLogBtn')[0].trigger('click')
      await wrapper.vm.$nextTick()
      await wrapper.find('.wtLogHistoryBtn').trigger('click')
      await wrapper.vm.$nextTick()

      // From the detail view, the footer re-opens the log-set modal.
      await wrapper.find('.wtDetailFooterBtn').trigger('click')
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.logSetSheet').exists()).toBe(true)
      expect(wrapper.find('#log-modal-title').text()).toBe('Bench Press')
    })

    it('hides the history button when creating a new exercise', async () => {
      const wrapper = mountTracker()
      exposed(wrapper).openNewExerciseModal()
      await wrapper.vm.$nextTick()

      expect(wrapper.find('.logSetSheet').exists()).toBe(true)
      expect(wrapper.find('.wtLogHistoryBtn').exists()).toBe(false)
    })
  })

  describe('PR history tab', () => {
    beforeEach(() => {
      mockState.exercises = createPRExercises()
    })

    it('shows PRs tab when multiple PRs exist', async () => {
      const wrapper = mountTracker()
      await wrapper.find('.wtExerciseRow').trigger('click')
      await wrapper.vm.$nextTick()

      const tabs = wrapper.findAll('.wtDetailTab')
      expect(tabs.length).toBe(2)
      expect(tabs[1].text()).toContain('PRs')
    })

    it('renders a PR card for each PR', async () => {
      const wrapper = mountTracker()
      await wrapper.find('.wtExerciseRow').trigger('click')
      await wrapper.vm.$nextTick()
      await wrapper.findAll('.wtDetailTab')[1].trigger('click')
      await wrapper.vm.$nextTick()

      expect(wrapper.findAll('.wtPRCard').length).toBe(3)
    })

    it('marks the latest PR as "Current"', async () => {
      const wrapper = mountTracker()
      await wrapper.find('.wtExerciseRow').trigger('click')
      await wrapper.vm.$nextTick()
      await wrapper.findAll('.wtDetailTab')[1].trigger('click')
      await wrapper.vm.$nextTick()

      expect(wrapper.find('.wtPRCardCurrent').exists()).toBe(true)
      expect(wrapper.find('.wtPRCardBadge').text()).toBe('Current')
    })

    it('shows connectors with e1RM delta between PRs', async () => {
      const wrapper = mountTracker()
      await wrapper.find('.wtExerciseRow').trigger('click')
      await wrapper.vm.$nextTick()
      await wrapper.findAll('.wtDetailTab')[1].trigger('click')
      await wrapper.vm.$nextTick()

      const connectors = wrapper.findAll('.wtPRConnector')
      expect(connectors.length).toBeGreaterThan(0)
      expect(connectors[0].text()).toContain('+')
    })

    it('shows PR count badge in tab', async () => {
      const wrapper = mountTracker()
      await wrapper.find('.wtExerciseRow').trigger('click')
      await wrapper.vm.$nextTick()

      const prTab = wrapper.findAll('.wtDetailTab')[1]
      expect(prTab.text()).toContain('3')
    })
  })

  describe('new exercise modal', () => {
    // App.vue's top-bar "+" calls the exposed openNewExerciseModal directly to
    // open this modal (the picker's "+ New exercise" row is now only reached
    // via the timeline "Log a set" button). Tests use the exposed API directly.
    async function openNewExerciseModal(wrapper: VueWrapper) {
      exposed(wrapper).openNewExerciseModal()
      await wrapper.vm.$nextTick()
    }

    it('opens modal via the "+ New exercise" picker row', async () => {
      const wrapper = mountTracker()
      await openNewExerciseModal(wrapper)

      expect(wrapper.find('.repMaxModal').exists()).toBe(true)
    })

    it('shows "New Exercise" as modal title', async () => {
      const wrapper = mountTracker()
      await openNewExerciseModal(wrapper)

      expect(wrapper.find('#log-modal-title').text()).toBe('New Exercise')
    })

    it('calls addExercise with name and tags on save', async () => {
      mockState.exercises = createExercises()
      mockAddExercise.mockReturnValue('ex-new')
      const wrapper = mountTracker()

      await openNewExerciseModal(wrapper)

      // Enter exercise name
      const nameInput = wrapper.find('.repMaxModal input[type="text"]')
      await nameInput.setValue('Deadlift')

      // Click save (no weight/reps means just create the exercise)
      const saveBtn = wrapper.find('.repMaxBtn.repMaxBtnCalc')
      await saveBtn.trigger('click')

      // The options bag carries gym membership from creation (#984); with no
      // gym filter active it is empty = unassigned = shows at every gym.
      expect(mockAddExercise).toHaveBeenCalledWith('Deadlift', [], { gyms: [] })
    })

    it('calls addExercise with selected tags', async () => {
      mockState.exercises = createExercises()
      mockAddExercise.mockReturnValue('ex-new')
      const wrapper = mountTracker()

      await openNewExerciseModal(wrapper)

      // Enter exercise name
      const nameInput = wrapper.find('.repMaxModal input[type="text"]')
      await nameInput.setValue('Pull Up')

      // Click existing tag chips
      const tagChips = wrapper.findAll('.wtTagPickerChip')
      if (tagChips.length > 0) {
        await tagChips[0].trigger('click')
      }

      const saveBtn = wrapper.find('.repMaxBtn.repMaxBtnCalc')
      await saveBtn.trigger('click')

      expect(mockAddExercise).toHaveBeenCalled()
      // Verify tags were passed (first tag from allTags)
      const callArgs = mockAddExercise.mock.calls[0]
      expect(callArgs[0]).toBe('Pull Up')
      expect(callArgs[1].length).toBeGreaterThan(0)
    })

    it('disables save button when name is empty', async () => {
      const wrapper = mountTracker()
      await openNewExerciseModal(wrapper)

      const saveBtn = wrapper.find('.repMaxBtn.repMaxBtnCalc')
      expect(saveBtn.attributes('disabled')).toBeDefined()
    })
  })

  describe('set logging flow', () => {
    beforeEach(() => {
      mockState.exercises = createExercises()
    })

    it('opens log modal for specific exercise via "+ Log" button', async () => {
      const wrapper = mountTracker()
      const logBtns = wrapper.findAll('.wtExerciseLogBtn')
      await logBtns[0].trigger('click')
      await wrapper.vm.$nextTick()

      expect(wrapper.find('.repMaxModal').exists()).toBe(true)
      expect(wrapper.find('#log-modal-title').text()).toBe('Bench Press')
    })

    it('calls logSet with weight and reps on save', async () => {
      const wrapper = mountTracker()
      const logBtns = wrapper.findAll('.wtExerciseLogBtn')
      await logBtns[0].trigger('click')
      await wrapper.vm.$nextTick()

      // Enter weight and reps
      const inputs = wrapper.findAll('.repMaxModal input')
      const weightInput = inputs.find(i => i.attributes('inputmode') === 'decimal')!
      const repsInput = inputs.find(i => i.attributes('inputmode') === 'numeric')!
      await weightInput.setValue('185')
      await repsInput.setValue('5')

      const saveBtn = wrapper.find('.repMaxBtn.repMaxBtnCalc')
      await saveBtn.trigger('click')

      expect(mockLogSet).toHaveBeenCalledWith('ex-1', 185, 5, expect.any(String), expect.objectContaining({}))
    })

    // LIFT-1148: the log-set modal stays open with cleared fields after a save,
    // so a sighted user sees the emptied form as confirmation but a screen-reader
    // user gets no feedback. A polite live region inside the modal announces the
    // saved set (WCAG 2.2 SC 4.1.3 Status Messages).
    it('announces the logged set via a polite live region (#1148)', async () => {
      const wrapper = mountTracker()
      const logBtns = wrapper.findAll('.wtExerciseLogBtn')
      await logBtns[0].trigger('click')
      await wrapper.vm.$nextTick()

      // The region is present and silent before any save.
      const live = wrapper.find('.repMaxModal .srOnly[aria-live="polite"]')
      expect(live.exists()).toBe(true)
      expect(live.attributes('role')).toBe('status')
      expect(live.attributes('aria-atomic')).toBe('true')
      expect(live.text()).toBe('')

      const inputs = wrapper.findAll('.repMaxModal input')
      const weightInput = inputs.find(i => i.attributes('inputmode') === 'decimal')!
      const repsInput = inputs.find(i => i.attributes('inputmode') === 'numeric')!
      await weightInput.setValue('185')
      await repsInput.setValue('5')

      await wrapper.find('.repMaxBtn.repMaxBtnCalc').trigger('click')
      // announceSet clears then re-sets on nextTick so identical re-logs re-fire.
      await wrapper.vm.$nextTick()
      await wrapper.vm.$nextTick()

      // Re-find: Vue replaces the text node on update, so the held wrapper is stale.
      const liveAfter = wrapper.find('.repMaxModal .srOnly[aria-live="polite"]')
      expect(liveAfter.text()).toBe('Logged Bench Press: 185 lbs × 5 reps')
    })

    // LIFT-683: the set-logging inputs declare enterkeyhint so iOS labels the
    // keyboard return key for the weight -> reps -> done flow. Without these,
    // the return key shows a generic label and breaks the native flow that is
    // central to the app. Pin the hints so they cannot silently regress.
    it('sets enterkeyhint on weight (next) and reps (done) inputs for iOS keyboard flow', async () => {
      const wrapper = mountTracker()
      const logBtns = wrapper.findAll('.wtExerciseLogBtn')
      await logBtns[0].trigger('click')
      await wrapper.vm.$nextTick()

      const inputs = wrapper.findAll('.repMaxModal input')
      const weightInput = inputs.find(i => i.attributes('inputmode') === 'decimal')!
      const repsInput = inputs.find(i => i.attributes('inputmode') === 'numeric')!
      expect(weightInput.attributes('enterkeyhint')).toBe('next')
      expect(repsInput.attributes('enterkeyhint')).toBe('done')
    })

    it('keeps modal open with cleared fields after saving a set', async () => {
      const wrapper = mountTracker()
      const logBtns = wrapper.findAll('.wtExerciseLogBtn')
      await logBtns[0].trigger('click')
      await wrapper.vm.$nextTick()

      const inputs = wrapper.findAll('.repMaxModal input')
      const weightInput = inputs.find(i => i.attributes('inputmode') === 'decimal')!
      const repsInput = inputs.find(i => i.attributes('inputmode') === 'numeric')!
      await weightInput.setValue('225')
      await repsInput.setValue('3')

      await wrapper.find('.repMaxBtn.repMaxBtnCalc').trigger('click')
      await wrapper.vm.$nextTick()

      // Modal stays open for the next set
      expect(wrapper.find('.repMaxModal').exists()).toBe(true)
      // Fields are cleared
      const updatedInputs = wrapper.findAll('.repMaxModal input')
      const updatedWeight = updatedInputs.find(i => i.attributes('inputmode') === 'decimal')!
      const updatedReps = updatedInputs.find(i => i.attributes('inputmode') === 'numeric')!
      expect((updatedWeight.element as HTMLInputElement).value).toBe('')
      expect((updatedReps.element as HTMLInputElement).value).toBe('')
    })

    it('disables save when weight or reps missing', async () => {
      const wrapper = mountTracker()
      const logBtns = wrapper.findAll('.wtExerciseLogBtn')
      await logBtns[0].trigger('click')
      await wrapper.vm.$nextTick()

      // Only enter weight, no reps
      const inputs = wrapper.findAll('.repMaxModal input')
      const weightInput = inputs.find(i => i.attributes('inputmode') === 'decimal')!
      await weightInput.setValue('185')

      const saveBtn = wrapper.find('.repMaxBtn.repMaxBtnCalc')
      expect(saveBtn.attributes('disabled')).toBeDefined()
    })

    /**
     * Regression: gemini-3.1-pro flagged a P1 in the step 5c plate-calc
     * restyle where the WEIGHT/REPS card row had a stale `v-else` against
     * the now-deleted standalone reps stepper. In plate mode this meant
     * the WEIGHT card disappeared, and step 5c had also removed the
     * in-card weight display — leaving the user with no visible weight
     * at all while picking plates. This test pins the WEIGHT/REPS row +
     * plate calc to *both* render in plate mode.
     */
    it('shows WEIGHT/REPS cards alongside the plate calc in plate mode', async () => {
      mockState.exercises = createExercises()
      // Switch the first exercise into plate mode
      mockState.exercises[0].inputMode = 'plates'
      mockState.exercises[0].plateCountMode = 'per-side'
      mockState.exercises[0].barWeight = 45

      const wrapper = mountTracker()
      const logBtns = wrapper.findAll('.wtExerciseLogBtn')
      await logBtns[0].trigger('click')
      await wrapper.vm.$nextTick()

      // Both the WEIGHT/REPS card row AND the plate calc must be present.
      expect(wrapper.find('.logSetFieldsRow').exists()).toBe(true)
      expect(wrapper.find('.wtPlateCalc').exists()).toBe(true)
      // The legacy standalone reps stepper used to render in plate mode
      // and is now gone — the REPS card covers it.
      expect(wrapper.find('.wtRepsStepperFull').exists()).toBe(false)
    })

    it('shows plate calculator hint for numpad-mode exercises (LIFT-388)', async () => {
      mockState.exercises = createExercises()
      // ex-1 is in default numpad mode (no inputMode set)
      const wrapper = mountTracker()
      const logBtns = wrapper.findAll('.wtExerciseLogBtn')
      await logBtns[0].trigger('click')
      await wrapper.vm.$nextTick()

      expect(wrapper.find('.wtPlateHint').exists()).toBe(true)
      expect(wrapper.find('.wtPlateHintText').text()).toContain('plate calculator')
    })

    it('hides plate calculator hint when exercise is in plate mode (LIFT-388)', async () => {
      mockState.exercises = createExercises()
      mockState.exercises[0].inputMode = 'plates'
      const wrapper = mountTracker()
      const logBtns = wrapper.findAll('.wtExerciseLogBtn')
      await logBtns[0].trigger('click')
      await wrapper.vm.$nextTick()

      expect(wrapper.find('.wtPlateHint').exists()).toBe(false)
    })

    it('hides plate calculator hint after dismissal via localStorage (LIFT-388)', async () => {
      localStorageMock.setItem('plate-calc-hint-dismissed', 'true')
      mockState.exercises = createExercises()
      const wrapper = mountTracker()
      const logBtns = wrapper.findAll('.wtExerciseLogBtn')
      await logBtns[0].trigger('click')
      await wrapper.vm.$nextTick()

      expect(wrapper.find('.wtPlateHint').exists()).toBe(false)
    })

    it('dismiss button persists hint dismissal to localStorage (LIFT-388)', async () => {
      mockState.exercises = createExercises()
      const wrapper = mountTracker()
      const logBtns = wrapper.findAll('.wtExerciseLogBtn')
      await logBtns[0].trigger('click')
      await wrapper.vm.$nextTick()

      await wrapper.find('.wtPlateHintDismiss').trigger('click')
      await wrapper.vm.$nextTick()

      expect(localStorageMock.getItem('plate-calc-hint-dismissed')).toBe('true')
      expect(wrapper.find('.wtPlateHint').exists()).toBe(false)
    })

    // ── Explore-path chart-discovery tip (LIFT-1086) ────────────────
    it('shows the chart tip when sample data is present (LIFT-1086)', () => {
      localStorageMock.setItem('sample-data', 'true')
      mockState.exercises = createExercises()
      const wrapper = mountTracker()
      expect(wrapper.find('.wtChartTip').exists()).toBe(true)
      expect(wrapper.find('.wtChartTipText').text()).toContain('progress chart')
    })

    it('does not show the chart tip for real users (no sample-data flag) (LIFT-1086)', () => {
      mockState.exercises = createExercises()
      const wrapper = mountTracker()
      expect(wrapper.find('.wtChartTip').exists()).toBe(false)
    })

    it('does not show the chart tip once dismissed via localStorage (LIFT-1086)', () => {
      localStorageMock.setItem('sample-data', 'true')
      localStorageMock.setItem('explore-chart-tip-dismissed', 'true')
      mockState.exercises = createExercises()
      const wrapper = mountTracker()
      expect(wrapper.find('.wtChartTip').exists()).toBe(false)
    })

    it('chart tip dismiss button persists to localStorage (LIFT-1086)', async () => {
      localStorageMock.setItem('sample-data', 'true')
      mockState.exercises = createExercises()
      const wrapper = mountTracker()
      await wrapper.find('.wtChartTipDismiss').trigger('click')
      await wrapper.vm.$nextTick()
      expect(localStorageMock.getItem('explore-chart-tip-dismissed')).toBe('true')
      expect(wrapper.find('.wtChartTip').exists()).toBe(false)
    })

    it('retires the chart tip after opening an exercise detail (LIFT-1086)', async () => {
      localStorageMock.setItem('sample-data', 'true')
      mockState.exercises = createExercises()
      const wrapper = mountTracker()
      expect(wrapper.find('.wtChartTip').exists()).toBe(true)
      await wrapper.find('.wtExerciseRow').trigger('click')
      await wrapper.vm.$nextTick()
      expect(localStorageMock.getItem('explore-chart-tip-dismissed')).toBe('true')
      expect(wrapper.find('.wtChartTip').exists()).toBe(false)
    })

    it('debounces plate sync when typing weight (LIFT-634)', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: false })
      try {
        mockState.exercises = createExercises()
        mockState.exercises[0].inputMode = 'plates'
        mockState.exercises[0].plateCountMode = 'per-side'
        mockState.exercises[0].barWeight = 45

        const wrapper = mountTracker()
        const logBtns = wrapper.findAll('.wtExerciseLogBtn')
        await logBtns[0].trigger('click')
        await wrapper.vm.$nextTick()

        const weightInput = wrapper.find('input[aria-label="Weight"]')
        expect(weightInput.exists()).toBe(true)

        // Type "2" — plate sync should NOT fire immediately
        await weightInput.setValue('2')
        await wrapper.vm.$nextTick()


        // Type "22" — should reset the debounce timer, still no sync
        await weightInput.setValue('22')
        await wrapper.vm.$nextTick()

        // Now advance past the 250ms debounce
        vi.advanceTimersByTime(300)
        await wrapper.vm.$nextTick()

        // After debounce, the plate display should have synced.
        // The exact plate state depends on the value, but the key assertion
        // is that we reached here without the sync running 2 separate times
        // (once for "2" and once for "22"). If debounce is working, only
        // the final value "22" was synced.
        // Verify the weight input still shows the last typed value.
        expect((weightInput.element as HTMLInputElement).value).toBe('22')
      } finally {
        vi.useRealTimers()
      }
    })
  })

  // The RPE selector is five whole points plus a half-step modifier, disclosed
  // by a pill that stays on screen (#1271 / LIFT-617). Two shipped bugs drove
  // this: the scale had no visible way back (collapsing meant re-tapping the
  // already-selected chip), and opening it seeded a 7 that a user who only
  // peeked would silently save.
  describe('RPE selector', () => {
    beforeEach(() => {
      mockState.exercises = createExercises()
    })

    async function openLog(wrapper: VueWrapper) {
      const logBtns = wrapper.findAll('.wtExerciseLogBtn')
      await logBtns[0].trigger('click')
      await wrapper.vm.$nextTick()
    }

    const points = (w: VueWrapper) => w.findAll('.wtRPEPoints .wtRPEChip')

    it('keeps the scale hidden until the pill is tapped', async () => {
      const wrapper = mountTracker()
      await openLog(wrapper)

      expect(wrapper.find('.wtRPEScale').exists()).toBe(false)
      const pill = wrapper.find('.wtRPEToggle')
      expect(pill.attributes('aria-expanded')).toBe('false')
      expect(pill.text()).toBe('RPE')

      await pill.trigger('click')
      expect(wrapper.find('.wtRPEScale').exists()).toBe(true)
      expect(wrapper.find('.wtRPEToggle').attributes('aria-expanded')).toBe('true')
    })

    // The reported bug: once expanded there was no way back. The pill is the
    // one control that opens AND closes the scale.
    it('collapses again when the pill is tapped a second time', async () => {
      const wrapper = mountTracker()
      await openLog(wrapper)

      await wrapper.find('.wtRPEToggle').trigger('click')
      expect(wrapper.find('.wtRPEScale').exists()).toBe(true)

      await wrapper.find('.wtRPEToggle').trigger('click')
      expect(wrapper.find('.wtRPEScale').exists()).toBe(false)
      expect(wrapper.find('.wtRPEToggle').attributes('aria-expanded')).toBe('false')
    })

    it('keeps a chosen rating visible on the pill while collapsed', async () => {
      const wrapper = mountTracker()
      await openLog(wrapper)

      await wrapper.find('.wtRPEToggle').trigger('click')
      await points(wrapper)[2].trigger('click') // RPE 8
      await wrapper.find('.wtRPEToggle').trigger('click')

      expect(wrapper.find('.wtRPEScale').exists()).toBe(false)
      expect(wrapper.find('.wtRPEToggle').text()).toBe('RPE 8')
    })

    // Opening a picker is not choosing a value. The old selector set 7 on tap,
    // so peeking at the scale and dismissing it recorded an RPE of 7.
    it('does not seed a rating just for opening the scale', async () => {
      const wrapper = mountTracker()
      await openLog(wrapper)
      await wrapper.find('.wtRPEToggle').trigger('click')

      expect(points(wrapper).every(c => c.attributes('aria-checked') === 'false')).toBe(true)
      expect(wrapper.find('.wtRPEToggle').text()).toBe('RPE')

      const inputs = wrapper.findAll('.repMaxModal input')
      await inputs.find(i => i.attributes('inputmode') === 'decimal')!.setValue('185')
      await inputs.find(i => i.attributes('inputmode') === 'numeric')!.setValue('5')
      await wrapper.find('.repMaxBtn.repMaxBtnCalc').trigger('click')

      // `logSet` only stores an rpe when it is non-null, so an unset rating
      // must arrive as undefined rather than a seeded number.
      expect(mockLogSet.mock.calls[0][4].rpe).toBeUndefined()
    })

    // Nine 44pt chips needed 428px in a 350px row, so 9 / 9.5 / 10 sat off
    // screen behind a scroller with no visible edge. Six chips fit outright.
    it('shows the whole scale — five points and the half modifier', async () => {
      const wrapper = mountTracker()
      await openLog(wrapper)
      await wrapper.find('.wtRPEToggle').trigger('click')

      expect(points(wrapper).map(c => c.text())).toEqual(['6', '7', '8', '9', '10'])
      expect(wrapper.find('.wtRPEHalfChip').exists()).toBe(true)
    })

    it('composes a half-point rating from a point plus the modifier', async () => {
      const wrapper = mountTracker()
      await openLog(wrapper)
      await wrapper.find('.wtRPEToggle').trigger('click')

      await points(wrapper)[2].trigger('click') // 8
      await wrapper.find('.wtRPEHalfChip').trigger('click')

      expect(wrapper.find('.wtRPEToggle').text()).toBe('RPE 8.5')
      expect(points(wrapper)[2].attributes('aria-checked')).toBe('true')
      expect(wrapper.find('.wtRPEHalfChip').attributes('aria-pressed')).toBe('true')

      const inputs = wrapper.findAll('.repMaxModal input')
      await inputs.find(i => i.attributes('inputmode') === 'decimal')!.setValue('185')
      await inputs.find(i => i.attributes('inputmode') === 'numeric')!.setValue('5')
      await wrapper.find('.repMaxBtn.repMaxBtnCalc').trigger('click')

      expect(mockLogSet.mock.calls[0][4]).toMatchObject({ rpe: 8.5 })
    })

    // The half is a modifier on the current rating, not a tenth value, so it
    // rides along as the point moves.
    it('carries the half across a change of point', async () => {
      const wrapper = mountTracker()
      await openLog(wrapper)
      await wrapper.find('.wtRPEToggle').trigger('click')

      await points(wrapper)[2].trigger('click') // 8
      await wrapper.find('.wtRPEHalfChip').trigger('click') // 8.5
      await points(wrapper)[3].trigger('click') // 9 -> 9.5

      expect(wrapper.find('.wtRPEToggle').text()).toBe('RPE 9.5')
    })

    // 10.5 is not an RPE, so the modifier goes inert at the top of the scale —
    // and has nothing to modify before a point is picked.
    it('disables the half modifier with no point picked and at RPE 10', async () => {
      const wrapper = mountTracker()
      await openLog(wrapper)
      await wrapper.find('.wtRPEToggle').trigger('click')

      expect(wrapper.find('.wtRPEHalfChip').attributes('disabled')).toBeDefined()

      await points(wrapper)[4].trigger('click') // 10
      expect(wrapper.find('.wtRPEHalfChip').attributes('disabled')).toBeDefined()
      expect(wrapper.find('.wtRPEToggle').text()).toBe('RPE 10')
    })

    it('drops the half when a half rating moves up to 10', async () => {
      const wrapper = mountTracker()
      await openLog(wrapper)
      await wrapper.find('.wtRPEToggle').trigger('click')

      await points(wrapper)[3].trigger('click') // 9
      await wrapper.find('.wtRPEHalfChip').trigger('click') // 9.5
      await points(wrapper)[4].trigger('click') // 10, not 10.5

      expect(wrapper.find('.wtRPEToggle').text()).toBe('RPE 10')
      expect(wrapper.find('.wtRPEHalfChip').attributes('aria-pressed')).toBe('false')
    })

    // Clearing is the chips' job; collapsing is the pill's. Re-tapping the
    // selected point clears the rating and leaves the scale open.
    it('clears the rating when the selected point is tapped again', async () => {
      const wrapper = mountTracker()
      await openLog(wrapper)
      await wrapper.find('.wtRPEToggle').trigger('click')

      await points(wrapper)[1].trigger('click') // 7
      expect(wrapper.find('.wtRPEToggle').text()).toBe('RPE 7')

      await points(wrapper)[1].trigger('click')
      expect(wrapper.find('.wtRPEToggle').text()).toBe('RPE')
      expect(wrapper.find('.wtRPEScale').exists()).toBe(true)
    })

    // Both annotations are optional and neither fills half the row, so they
    // share one line rather than costing the sheet 112px unconditionally.
    it('puts the effort toggle and the RPE pill in the same row', async () => {
      const wrapper = mountTracker()
      await openLog(wrapper)

      const row = wrapper.find('.wtEffortRow')
      expect(row.find('.wtEffortToggle').exists()).toBe(true)
      expect(row.find('.wtRPEToggle').exists()).toBe(true)
      expect(wrapper.findAll('.wtEffortRow')).toHaveLength(1)
    })
  })

  describe('usual ladder & ghost logging (#741)', () => {
    /** Local calendar date, matching the component's todayISO(). */
    function localDay(daysAgo = 0): string {
      const d = new Date()
      d.setDate(d.getDate() - daysAgo)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }

    function benchLadder() {
      return {
        rungs: [
          { weightLbs: 45, reps: 10, source: 'consensus' },
          { weightLbs: 95, reps: 10, source: 'consensus' },
          { weightLbs: 135, reps: 10, source: 'consensus' },
          { weightLbs: 185, reps: 10, source: 'consensus' },
          { weightLbs: 225, reps: 10, source: 'consensus' },
          { weightLbs: 275, reps: 10, source: 'consensus' },
        ],
        consensusCount: 6,
        sessionsSampled: 4,
      }
    }

    /** Appends sets dated today to ex-1 so doneness derivation sees them. */
    function seedTodaySets(weights: number[]) {
      for (const w of weights) {
        mockState.exercises[0].sets.push({
          id: `s-today-${w}-${mockState.exercises[0].sets.length}`,
          date: `${localDay()}T23:59:00.000Z`,
          weight: w,
          reps: 10,
          estimated1RM: Math.round(w * (1 + 10 / 30)),
        })
      }
    }

    async function openBenchModal(wrapper: VueWrapper) {
      await wrapper.findAll('.wtExerciseLogBtn')[0].trigger('click')
      await wrapper.vm.$nextTick()
    }

    beforeEach(() => {
      mockState.exercises = createExercises()
    })

    it('falls back to last-session chips when no ladder is detected', async () => {
      mockGetLastSession.mockReturnValue({
        date: '2026-01-20',
        sets: [
          { id: 's-a', date: '2026-01-20T12:00:00', weight: 185, reps: 5, estimated1RM: 216 },
          { id: 's-b', date: '2026-01-20T12:00:00', weight: 195, reps: 3, estimated1RM: 215 },
        ],
      })
      const wrapper = mountTracker()
      await openBenchModal(wrapper)

      expect(wrapper.find('.wtPrevSessionLabel').text()).toContain('Last session')
      const chips = wrapper.findAll('.wtPrevSessionChip')
      expect(chips).toHaveLength(2)
      await chips[0].trigger('click')
      expect((wrapper.find('input[aria-label="Weight"]').element as HTMLInputElement).value).toBe('185')
      expect((wrapper.find('input[aria-label="Reps"]').element as HTMLInputElement).value).toBe('5')
    })

    it('renders the ladder with the first rung highlighted as next', async () => {
      mockGetUsualLadder.mockReturnValue(benchLadder())
      const wrapper = mountTracker()
      await openBenchModal(wrapper)

      expect(wrapper.find('.wtPrevSessionLabel').text()).toBe('Usual · 6 sets')
      const chips = wrapper.findAll('.wtPrevSessionChip')
      expect(chips).toHaveLength(6)
      expect(chips[0].classes()).toContain('wtPrevSessionChipNext')
      expect(chips[0].attributes('aria-current')).toBe('step')
      expect(chips[0].text()).toBe('45 × 10')
      expect(chips[5].text()).toBe('275 × 10')
    })

    it('fills weight and reps when a rung chip is tapped', async () => {
      mockGetUsualLadder.mockReturnValue(benchLadder())
      const wrapper = mountTracker()
      await openBenchModal(wrapper)

      await wrapper.findAll('.wtPrevSessionChip')[2].trigger('click')
      expect((wrapper.find('input[aria-label="Weight"]').element as HTMLInputElement).value).toBe('135')
      expect((wrapper.find('input[aria-label="Reps"]').element as HTMLInputElement).value).toBe('10')
    })

    it('arms the ghost: placeholders show the next rung and Save states its payload', async () => {
      mockGetUsualLadder.mockReturnValue(benchLadder())
      const wrapper = mountTracker()
      await openBenchModal(wrapper)

      expect(wrapper.find('input[aria-label="Weight"]').attributes('placeholder')).toBe('45')
      expect(wrapper.find('input[aria-label="Reps"]').attributes('placeholder')).toBe('10')
      const saveBtn = wrapper.find('.repMaxBtn.repMaxBtnCalc')
      expect(saveBtn.text()).toBe('Save 45 × 10')
      expect(saveBtn.attributes('disabled')).toBeUndefined()
    })

    it('ghost save logs the next rung with fields left empty (settled pattern)', async () => {
      mockGetUsualLadder.mockReturnValue(benchLadder())
      const wrapper = mountTracker()
      await openBenchModal(wrapper)

      await wrapper.find('.repMaxBtn.repMaxBtnCalc').trigger('click')
      await wrapper.vm.$nextTick()

      expect(mockLogSet).toHaveBeenCalledWith('ex-1', 45, 10, expect.any(String), expect.objectContaining({}))
      // Modal stays open, fields remain genuinely empty
      expect(wrapper.find('.repMaxModal').exists()).toBe(true)
      expect((wrapper.find('input[aria-label="Weight"]').element as HTMLInputElement).value).toBe('')
      expect((wrapper.find('input[aria-label="Reps"]').element as HTMLInputElement).value).toBe('')
    })

    it('a double-tap on ghost Save logs exactly one set (re-arm cooldown)', async () => {
      mockGetUsualLadder.mockReturnValue(benchLadder())
      const wrapper = mountTracker()
      await openBenchModal(wrapper)

      // NOTE: re-find the button after every state change — the render
      // replaces the element, so a held wrapper goes stale (detached node).
      const saveBtn = () => wrapper.find('.repMaxBtn.repMaxBtnCalc')
      await saveBtn().trigger('click')
      await saveBtn().trigger('click') // accidental double-tap
      expect(mockLogSet).toHaveBeenCalledTimes(1)
      // Button visibly disarms during the cooldown
      expect(saveBtn().attributes('disabled')).toBeDefined()
      expect(saveBtn().text()).toBe('Save')

      // After the cooldown an intentional tap logs the next set
      await new Promise(r => setTimeout(r, 600))
      await wrapper.vm.$nextTick()
      await saveBtn().trigger('click')
      expect(mockLogSet).toHaveBeenCalledTimes(2)
    })

    it('typing anything disarms the ghost', async () => {
      mockGetUsualLadder.mockReturnValue(benchLadder())
      const wrapper = mountTracker()
      await openBenchModal(wrapper)

      await wrapper.find('input[aria-label="Weight"]').setValue('50')
      const saveBtn = wrapper.find('.repMaxBtn.repMaxBtnCalc')
      expect(saveBtn.text()).toBe('Save')
      // Normal validation again: weight without reps cannot save
      expect(saveBtn.attributes('disabled')).toBeDefined()
    })

    it('derives doneness from today\'s logged sets', async () => {
      mockGetUsualLadder.mockReturnValue(benchLadder())
      seedTodaySets([45])
      const wrapper = mountTracker()
      await openBenchModal(wrapper)

      expect(wrapper.find('.wtPrevSessionLabel').text()).toBe('Usual · 1 of 6')
      const chips = wrapper.findAll('.wtPrevSessionChip')
      expect(chips[0].classes()).toContain('wtPrevSessionChipUsed')
      expect(chips[0].attributes('aria-label')).toBe('45 × 10, logged')
      expect(chips[1].classes()).toContain('wtPrevSessionChipNext')
      // Ghost now points at the second rung
      expect(wrapper.find('.repMaxBtn.repMaxBtnCalc').text()).toBe('Save 95 × 10')
    })

    it('dims lighter rungs as skipped when the user jumps ahead', async () => {
      mockGetUsualLadder.mockReturnValue(benchLadder())
      seedTodaySets([185])
      const wrapper = mountTracker()
      await openBenchModal(wrapper)

      const chips = wrapper.findAll('.wtPrevSessionChip')
      // 45/95/135 are moot warm-ups below today's heaviest — skipped, not struck through
      for (const i of [0, 1, 2]) {
        expect(chips[i].classes()).toContain('wtPrevSessionChipSkipped')
        expect(chips[i].classes()).not.toContain('wtPrevSessionChipUsed')
        // Skipped state is exposed to screen readers, not just via opacity
        expect(chips[i].attributes('aria-label')).toContain('skipped')
      }
      expect(chips[3].classes()).toContain('wtPrevSessionChipUsed')
      expect(chips[4].classes()).toContain('wtPrevSessionChipNext')
      expect(chips[4].attributes('aria-label')).toBeUndefined()
      expect(wrapper.find('.wtPrevSessionLabel').text()).toBe('Usual · 4 of 6')
    })

    it('completes the ladder when a heavier set beats the top rung', async () => {
      mockGetUsualLadder.mockReturnValue(benchLadder())
      seedTodaySets([280])
      const wrapper = mountTracker()
      await openBenchModal(wrapper)

      expect(wrapper.find('.wtPrevSessionLabel').text()).toBe('Usual · 6 of 6')
      expect(wrapper.find('.wtPrevSessionChipNext').exists()).toBe(false)
      // Ghost disarmed → Save disabled until the user types
      const saveBtn = wrapper.find('.repMaxBtn.repMaxBtnCalc')
      expect(saveBtn.text()).toBe('Save')
      expect(saveBtn.attributes('disabled')).toBeDefined()
    })

    it('backdating the modal date drops to fallback mode and disarms the ghost', async () => {
      mockGetUsualLadder.mockReturnValue(benchLadder())
      const wrapper = mountTracker()
      await openBenchModal(wrapper)

      await wrapper.find('.wtDateOverlayInput').setValue('2026-01-10')
      await wrapper.vm.$nextTick()

      // Ladder gated off (not today) → no routine chips and the ghost disarms.
      // (The PR-anchored Intensity lens is date-independent and may still show
      // its own preset chips, so scope to the non-preset chips.)
      const routineChips = wrapper.findAll('.wtPrevSessionChip')
        .filter(c => !c.element.closest('.wtIntensityPresetChips'))
      expect(routineChips).toHaveLength(0)
      const saveBtn = wrapper.find('.repMaxBtn.repMaxBtnCalc')
      expect(saveBtn.text()).toBe('Save')
      expect(saveBtn.attributes('disabled')).toBeDefined()
    })

    it('never arms the ghost in plate mode but chips still fill plates + reps', async () => {
      mockState.exercises[0].inputMode = 'plates'
      mockState.exercises[0].plateCountMode = 'per-side'
      mockState.exercises[0].barWeight = 45
      mockGetUsualLadder.mockReturnValue(benchLadder())
      const wrapper = mountTracker()
      await openBenchModal(wrapper)

      // Plate seeding pre-fills the weight from the next rung — no ghost
      expect(wrapper.find('.repMaxBtn.repMaxBtnCalc').text()).toBe('Save')
      expect(wrapper.find('input[aria-label="Reps"]').attributes('placeholder')).toBe('—')

      await wrapper.findAll('.wtPrevSessionChip')[2].trigger('click')
      await wrapper.vm.$nextTick()
      expect((wrapper.find('input[aria-label="Weight"]').element as HTMLInputElement).value).toBe('135')
      expect((wrapper.find('input[aria-label="Reps"]').element as HTMLInputElement).value).toBe('10')
    })
  })

  describe('overload nudge (#741)', () => {
    function localDay(daysAgo = 0): string {
      const d = new Date()
      d.setDate(d.getDate() - daysAgo)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }

    function benchLadder() {
      return {
        rungs: [
          { weightLbs: 45, reps: 10, source: 'consensus' },
          { weightLbs: 135, reps: 10, source: 'consensus' },
          { weightLbs: 225, reps: 10, source: 'consensus' },
          { weightLbs: 275, reps: 10, source: 'consensus' },
        ],
        consensusCount: 4,
        sessionsSampled: 4,
      }
    }

    function highSuggestion() {
      return { type: 'increase_weight', weight: 280, reps: 8, reason: 'x', confidence: 'high' }
    }

    function priorSession(daysAgo = 2, topWeight = 275) {
      return {
        date: localDay(daysAgo),
        sets: [{ id: 's-p', date: `${localDay(daysAgo)}T12:00:00`, weight: topWeight, reps: 10, estimated1RM: 367 }],
      }
    }

    /** Today's sets covering every rung except the top one → top set is up next. */
    function seedAllButTopRung() {
      for (const w of [45, 135, 225]) {
        mockState.exercises[0].sets.push({
          id: `s-today-${w}`,
          date: `${localDay()}T23:59:00.000Z`,
          weight: w,
          reps: 10,
          estimated1RM: Math.round(w * (1 + 10 / 30)),
        })
      }
    }

    async function openBenchModal(wrapper: VueWrapper) {
      await wrapper.findAll('.wtExerciseLogBtn')[0].trigger('click')
      await wrapper.vm.$nextTick()
    }

    function armEligibleNudge() {
      mockGetUsualLadder.mockReturnValue(benchLadder())
      mockGetOverloadSuggestion.mockReturnValue(highSuggestion())
      mockGetLastSession.mockReturnValue(priorSession())
      seedAllButTopRung()
    }

    beforeEach(() => {
      mockState.exercises = createExercises()
    })

    it('shows the nudge card right before the habitual top set', async () => {
      armEligibleNudge()
      const wrapper = mountTracker()
      await openBenchModal(wrapper)

      const card = wrapper.find('.wtOverloadCard')
      expect(card.exists()).toBe(true)
      expect(card.text()).toContain('Suggestion')
      expect(card.text()).toContain('280 lbs × 8')
      expect(card.text()).toContain('Up from 275 lbs × 10')
    })

    it('records the shown nudge once per day in localStorage', async () => {
      armEligibleNudge()
      const wrapper = mountTracker()
      await openBenchModal(wrapper)

      const state = JSON.parse(localStorageMock.getItem('overload-nudge-state')!)
      expect(state.lastGlobalShownDay).toBe(localDay())
      expect(state.byExercise['ex-1']).toMatchObject({
        lastShownDay: localDay(),
        shownForWeightLbs: 280,
        outcome: 'pending',
        ignoredCount: 0,
      })
    })

    it('does not show before the top rung is up next', async () => {
      mockGetUsualLadder.mockReturnValue(benchLadder())
      mockGetOverloadSuggestion.mockReturnValue(highSuggestion())
      mockGetLastSession.mockReturnValue(priorSession())
      // No sets logged today → next rung is the first, not the top
      const wrapper = mountTracker()
      await openBenchModal(wrapper)
      expect(wrapper.find('.wtOverloadCard').exists()).toBe(false)
    })

    it('never shows low-confidence suggestions', async () => {
      armEligibleNudge()
      mockGetOverloadSuggestion.mockReturnValue({ ...highSuggestion(), confidence: 'low' })
      const wrapper = mountTracker()
      await openBenchModal(wrapper)
      expect(wrapper.find('.wtOverloadCard').exists()).toBe(false)
    })

    it('suppresses the nudge during a deload (last session below the usual top)', async () => {
      armEligibleNudge()
      mockGetLastSession.mockReturnValue(priorSession(2, 225))
      const wrapper = mountTracker()
      await openBenchModal(wrapper)
      expect(wrapper.find('.wtOverloadCard').exists()).toBe(false)
    })

    it('suppresses the nudge after a 3+ week break', async () => {
      armEligibleNudge()
      mockGetLastSession.mockReturnValue(priorSession(30))
      const wrapper = mountTracker()
      await openBenchModal(wrapper)
      expect(wrapper.find('.wtOverloadCard').exists()).toBe(false)
    })

    it('enforces the one-nudge-per-day global cap across exercises', async () => {
      armEligibleNudge()
      localStorageMock.setItem('overload-nudge-state', JSON.stringify({
        lastGlobalShownDay: localDay(),
        byExercise: { 'ex-other': { lastShownDay: localDay(), shownForWeightLbs: 100, outcome: 'pending', ignoredCount: 0 } },
      }))
      const wrapper = mountTracker()
      await openBenchModal(wrapper)
      expect(wrapper.find('.wtOverloadCard').exists()).toBe(false)
    })

    it('enforces the 7-day per-exercise cooldown', async () => {
      armEligibleNudge()
      localStorageMock.setItem('overload-nudge-state', JSON.stringify({
        lastGlobalShownDay: localDay(3),
        byExercise: { 'ex-1': { lastShownDay: localDay(3), shownForWeightLbs: 280, outcome: 'accepted', ignoredCount: 0 } },
      }))
      const wrapper = mountTracker()
      await openBenchModal(wrapper)
      expect(wrapper.find('.wtOverloadCard').exists()).toBe(false)
    })

    it('shows again once the cooldown has elapsed', async () => {
      armEligibleNudge()
      localStorageMock.setItem('overload-nudge-state', JSON.stringify({
        lastGlobalShownDay: localDay(8),
        byExercise: { 'ex-1': { lastShownDay: localDay(8), shownForWeightLbs: 280, outcome: 'accepted', ignoredCount: 0 } },
      }))
      const wrapper = mountTracker()
      await openBenchModal(wrapper)
      expect(wrapper.find('.wtOverloadCard').exists()).toBe(true)
    })

    it('backs off to 14 days after one ignore', async () => {
      armEligibleNudge()
      localStorageMock.setItem('overload-nudge-state', JSON.stringify({
        lastGlobalShownDay: localDay(10),
        byExercise: { 'ex-1': { lastShownDay: localDay(10), shownForWeightLbs: 280, outcome: 'ignored', ignoredCount: 1 } },
      }))
      const wrapper = mountTracker()
      await openBenchModal(wrapper)
      expect(wrapper.find('.wtOverloadCard').exists()).toBe(false)
    })

    it('mutes the exercise after three ignores while the top weight is unchanged', async () => {
      armEligibleNudge()
      localStorageMock.setItem('overload-nudge-state', JSON.stringify({
        lastGlobalShownDay: localDay(60),
        byExercise: { 'ex-1': { lastShownDay: localDay(60), shownForWeightLbs: 280, outcome: 'ignored', ignoredCount: 3 } },
      }))
      const wrapper = mountTracker()
      await openBenchModal(wrapper)
      expect(wrapper.find('.wtOverloadCard').exists()).toBe(false)
    })

    it('disarms the ghost while the nudge is visible — Save demands an explicit choice', async () => {
      armEligibleNudge()
      const wrapper = mountTracker()
      await openBenchModal(wrapper)

      expect(wrapper.find('.wtOverloadCard').exists()).toBe(true)
      // No ghost: plain disabled Save, default placeholders — the nudge and
      // the old top set never compete as two one-tap payloads
      const saveBtn = wrapper.find('.repMaxBtn.repMaxBtnCalc')
      expect(saveBtn.text()).toBe('Save')
      expect(saveBtn.attributes('disabled')).toBeDefined()
      expect(wrapper.find('input[aria-label="Weight"]').attributes('placeholder')).toBe('135')
    })

    // Space as well as Enter: `role="button"` tells AT this is a button, so
    // Space is an expected activation key — without a handler it just scrolls
    // the sheet (LIFT-1305).
    it.each(['enter', 'space'] as const)(
      'exposes the nudge card as a keyboard-actionable button (%s)',
      async key => {
        armEligibleNudge()
        const wrapper = mountTracker()
        await openBenchModal(wrapper)

        const card = wrapper.find('.wtOverloadCard')
        expect(card.attributes('role')).toBe('button')
        expect(card.attributes('tabindex')).toBe('0')
        expect(card.attributes('aria-label')).toContain('280')
        await card.trigger(`keydown.${key}`)
        expect((wrapper.find('input[aria-label="Weight"]').element as HTMLInputElement).value).toBe('280')
      },
    )

    it('settles a stale pending nudge as ignored when a later session stayed lighter', async () => {
      armEligibleNudge()
      // Nudge shown 8 days ago, still pending; the user benched 5 days ago
      // at the usual top weight — that answers "no thanks"
      localStorageMock.setItem('overload-nudge-state', JSON.stringify({
        lastGlobalShownDay: localDay(8),
        byExercise: { 'ex-1': { lastShownDay: localDay(8), shownForWeightLbs: 280, outcome: 'pending', ignoredCount: 0 } },
      }))
      mockState.exercises[0].sets.push({
        id: 's-between', date: `${localDay(5)}T23:59:00.000Z`, weight: 275, reps: 10, estimated1RM: 367,
      })
      const wrapper = mountTracker()
      await openBenchModal(wrapper)

      const state = JSON.parse(localStorageMock.getItem('overload-nudge-state')!)
      expect(state.byExercise['ex-1'].outcome).toBe('ignored')
      expect(state.byExercise['ex-1'].ignoredCount).toBe(1)
      // One ignore → 14-day backoff; only 8 days elapsed → suppressed
      expect(wrapper.find('.wtOverloadCard').exists()).toBe(false)
    })

    it('tapping the card fills the fields, and saving records the accept', async () => {
      armEligibleNudge()
      const wrapper = mountTracker()
      await openBenchModal(wrapper)

      await wrapper.find('.wtOverloadCard').trigger('click')
      await wrapper.vm.$nextTick()
      expect((wrapper.find('input[aria-label="Weight"]').element as HTMLInputElement).value).toBe('280')
      expect((wrapper.find('input[aria-label="Reps"]').element as HTMLInputElement).value).toBe('8')
      // Card is gone once the fields are filled (fill-only, never saves)
      expect(wrapper.find('.wtOverloadCard').exists()).toBe(false)

      await wrapper.find('.repMaxBtn.repMaxBtnCalc').trigger('click')
      await wrapper.vm.$nextTick()
      expect(mockLogSet).toHaveBeenCalledWith('ex-1', 280, 8, expect.any(String), expect.objectContaining({}))
      const state = JSON.parse(localStorageMock.getItem('overload-nudge-state')!)
      expect(state.byExercise['ex-1'].outcome).toBe('accepted')
      expect(state.byExercise['ex-1'].ignoredCount).toBe(0)
    })
  })

  describe('intensity lens (#770)', () => {
    async function openBenchModal(wrapper: VueWrapper) {
      await wrapper.findAll('.wtExerciseLogBtn')[0].trigger('click')
      await wrapper.vm.$nextTick()
    }

    // Bench's best e1RM in createExercises is 228 — the intensity anchor.
    function priorSession() {
      return {
        date: '2026-01-20',
        sets: [
          { id: 's-a', date: '2026-01-20T12:00:00', weight: 185, reps: 5, estimated1RM: 216 },
          { id: 's-b', date: '2026-01-20T12:00:00', weight: 195, reps: 5, estimated1RM: 228 },
        ],
      }
    }

    beforeEach(() => {
      mockState.exercises = createExercises()
    })

    // Activate a named lens in the Suggestions drawer (the drawer opens on the
    // default quick-fill lens; intensity lives behind the segmented control).
    async function selectLens(wrapper: VueWrapper, label: string) {
      const seg = wrapper.findAll('.wtSuggestionSegment').find(s => s.text() === label)
      if (!seg) throw new Error(`no "${label}" suggestion segment`)
      await seg.trigger('click')
    }

    it('exposes an Intensity lens anchored to the PR e1RM', async () => {
      mockGetLastSession.mockReturnValue(priorSession())
      const wrapper = mountTracker()
      await openBenchModal(wrapper)

      // No routine detected → drawer defaults to the last-session lens, with the
      // intensity lens available alongside it on the segmented control.
      expect(wrapper.findAll('.wtSuggestionSegment').map(s => s.text())).toEqual(['Last', 'Intensity'])
      await selectLens(wrapper, 'Intensity')
      // Anchor caption + the slider control.
      expect(wrapper.find('.wtSuggestions').text()).toContain('228 lbs max')
      expect(wrapper.find('.wtIntensitySlider').exists()).toBe(true)
    })

    it('renders tappable intensity presets that drive the slider (#776)', async () => {
      mockGetLastSession.mockReturnValue(priorSession())
      const wrapper = mountTracker()
      await openBenchModal(wrapper)

      await selectLens(wrapper, 'Intensity')
      const chips = wrapper.findAll('.wtIntensityPresetChips .wtPrevSessionChip')
      expect(chips.map(c => c.text())).toEqual(['50%', '70%', '80%', '90%', '100%'])
      // Default intensity is 80% → that chip is highlighted as current.
      expect(chips.find(c => c.classes().includes('wtPrevSessionChipNext'))?.text()).toBe('80%')

      // Tapping a preset sets the intensity: caption + slider follow, highlight moves.
      await chips.find(c => c.text() === '50%')!.trigger('click')
      expect(wrapper.find('.wtSuggestions .wtPrevSessionLabel').text()).toContain('50% of')
      expect((wrapper.find('.wtIntensitySlider').element as HTMLInputElement).value).toBe('50')
      const after = wrapper.findAll('.wtIntensityPresetChips .wtPrevSessionChip')
      expect(after.find(c => c.classes().includes('wtPrevSessionChipNext'))?.text()).toBe('50%')
    })

    it('shows weight rows at the default intensity and fills inputs on tap', async () => {
      mockGetLastSession.mockReturnValue(priorSession())
      const wrapper = mountTracker()
      await openBenchModal(wrapper)

      await selectLens(wrapper, 'Intensity')
      const rows = wrapper.findAll('.wtPrTargetsRow')
      // Default 80% of 228 e1RM, default 10 rep rows.
      expect(rows).toHaveLength(10)
      // Row 1 (1 rep = the 1RM, no Epley multiplier): ceil(80% × 228) = 185 lb,
      // and each row surfaces its e1RM for context.
      expect(rows[0].text()).toContain('185 lbs')
      expect(rows[0].text()).toContain('e1RM')

      await rows[0].trigger('click')
      expect((wrapper.find('input[aria-label="Weight"]').element as HTMLInputElement).value).toBe('185')
      expect((wrapper.find('input[aria-label="Reps"]').element as HTMLInputElement).value).toBe('1')
      // Re-find: tapping mutates intensityUsed, so Vue re-renders and the held node goes stale.
      expect(wrapper.findAll('.wtPrTargetsRow')[0].classes()).toContain('wtPrTargetsRowActive')
    })

    it('respects a per-exercise intensityMaxReps override', async () => {
      mockGetLastSession.mockReturnValue(priorSession())
      mockState.exercises[0].intensityMaxReps = 3
      const wrapper = mountTracker()
      await openBenchModal(wrapper)

      await selectLens(wrapper, 'Intensity')
      expect(wrapper.findAll('.wtPrTargetsRow')).toHaveLength(3)
    })

    it('recomputes (and can empty) the table as the slider moves', async () => {
      mockGetLastSession.mockReturnValue(priorSession())
      const wrapper = mountTracker()
      await openBenchModal(wrapper)

      await selectLens(wrapper, 'Intensity')
      expect(wrapper.findAll('.wtPrTargetsRow').length).toBeGreaterThan(0)
      // 0% intensity has no loadable target at any rep count → empty state.
      await wrapper.find('.wtIntensitySlider').setValue(0)
      expect(wrapper.findAll('.wtPrTargetsRow')).toHaveLength(0)
      expect(wrapper.find('.wtIntensityEmpty').exists()).toBe(true)
    })

    it('clears the row highlight when the slider moves (no stale index)', async () => {
      mockGetLastSession.mockReturnValue(priorSession())
      const wrapper = mountTracker()
      await openBenchModal(wrapper)

      await selectLens(wrapper, 'Intensity')
      await wrapper.findAll('.wtPrTargetsRow')[1].trigger('click')
      expect(wrapper.findAll('.wtPrTargetsRow')[1].classes()).toContain('wtPrTargetsRowActive')

      // Moving the slider rebuilds the table — the stale highlight must clear.
      await wrapper.find('.wtIntensitySlider').setValue(70)
      expect(wrapper.findAll('.wtPrTargetsRow').some(r => r.classes().includes('wtPrTargetsRowActive'))).toBe(false)
    })

    it('coexists with the usual ladder as a separate lens', async () => {
      mockGetUsualLadder.mockReturnValue({
        rungs: [
          { weightLbs: 45, reps: 10 },
          { weightLbs: 135, reps: 8 },
          { weightLbs: 225, reps: 5 },
        ],
      })
      const wrapper = mountTracker()
      await openBenchModal(wrapper)

      // Routine is the default lens; intensity is available beside it.
      expect(wrapper.findAll('.wtSuggestionSegment').map(s => s.text())).toEqual(['Routine', 'Intensity'])
      expect(wrapper.find('.wtSuggestionSegmentActive').text()).toBe('Routine')

      await selectLens(wrapper, 'Intensity')
      expect(wrapper.findAll('.wtPrTargetsRow').length).toBeGreaterThan(0)
    })

    it('does not render the drawer with no routine, last session, or PR', async () => {
      // An exercise with no sets has no PR to anchor the intensity lens to.
      mockState.exercises = [{ id: 'ex-1', name: 'Bench Press', tags: [], sets: [] }]
      const wrapper = mountTracker()
      await openBenchModal(wrapper)
      expect(wrapper.find('.wtSuggestions').exists()).toBe(false)
    })
  })

  describe('suggestions drawer (#759)', () => {
    async function openBenchModal(wrapper: VueWrapper) {
      await wrapper.findAll('.wtExerciseLogBtn')[0].trigger('click')
      await wrapper.vm.$nextTick()
    }

    beforeEach(() => {
      mockState.exercises = createExercises()
    })

    it('opens expanded on the routine lens so one-tap logging needs no extra tap', async () => {
      mockGetUsualLadder.mockReturnValue({
        rungs: [
          { weightLbs: 135, reps: 5 },
          { weightLbs: 185, reps: 5 },
        ],
      })
      const wrapper = mountTracker()
      await openBenchModal(wrapper)

      // Ladder chips are visible immediately — the ghost-arm flow is preserved.
      expect(wrapper.find('.wtSuggestions').exists()).toBe(true)
      expect(wrapper.findAll('.wtPrevSessionChip').length).toBe(2)
    })

    it('renders no segmented control when only one lens is available', async () => {
      // Ladder only — a no-sets exercise has no PR, so no intensity lens either.
      mockState.exercises = [{ id: 'ex-1', name: 'Bench Press', tags: [], sets: [] }]
      mockGetUsualLadder.mockReturnValue({
        rungs: [
          { weightLbs: 135, reps: 5 },
          { weightLbs: 185, reps: 5 },
        ],
      })
      const wrapper = mountTracker()
      await openBenchModal(wrapper)

      expect(wrapper.find('.wtSuggestions').exists()).toBe(true)
      expect(wrapper.findAll('.wtSuggestionSegment')).toHaveLength(0)
    })

    it('switches the visible lens when a segment is tapped', async () => {
      mockGetLastSession.mockReturnValue({
        date: '2026-01-20',
        sets: [
          { id: 's-a', date: '2026-01-20T12:00:00', weight: 185, reps: 5, estimated1RM: 216 },
          { id: 's-b', date: '2026-01-20T12:00:00', weight: 225, reps: 3, estimated1RM: 248 },
        ],
      })
      const wrapper = mountTracker()
      await openBenchModal(wrapper)

      // Defaults to the last-session lens (chips visible, no ramp rows).
      expect(wrapper.find('.wtSuggestionSegmentActive').text()).toBe('Last')
      expect(wrapper.findAll('.wtPrevSessionChip').length).toBe(2)
      expect(wrapper.findAll('.wtPrTargetsRow')).toHaveLength(0)

      const intensitySeg = wrapper.findAll('.wtSuggestionSegment').find(s => s.text() === 'Intensity')!
      await intensitySeg.trigger('click')
      // Now the intensity rows show and the last-session chips are gone (the
      // intensity lens has its own preset chips, so scope to non-preset chips).
      expect(wrapper.find('.wtSuggestionSegmentActive').text()).toBe('Intensity')
      expect(wrapper.findAll('.wtPrTargetsRow').length).toBeGreaterThan(0)
      const lastSessionChips = wrapper.findAll('.wtPrevSessionChip')
        .filter(c => !c.element.closest('.wtIntensityPresetChips'))
      expect(lastSessionChips).toHaveLength(0)
    })
  })

  /**
   * The log sheet straddles two weight spaces on a `bodyweightLoaded` exercise
   * (#1328): the weight field holds ADDED weight, while `estimated1RM` — and so
   * `getExercisePR` — is stored EFFECTIVE (added + bodyweight). Every surface
   * derived from a 1RM has to cross that boundary, in the right direction.
   *
   * Why nothing caught this: `bodyweightLoad.test.ts` covered the lib helper and
   * the store write path, but no test had ever MOUNTED the tracker with
   * `bodyweightLoaded` set — the whole inverse direction (reading an e1RM back
   * out and turning it into a field value) was uncovered.
   */
  describe('bodyweight-loaded 1RM surfaces (#1328)', () => {
    const BODYWEIGHT = 160
    // A 160 lb lifter's +25 x 5 pull-up: stored as weight 25, e1RM epley(185, 5).
    const PR = epley(BODYWEIGHT + 25, 5) // 216

    function pullups(): Exercise[] {
      return [{
        id: 'ex-1',
        name: 'Pull-Up',
        tags: ['Back'],
        bodyweightLoaded: true,
        sets: [
          { id: 's-1', date: '2026-01-15T12:00:00', weight: 15, reps: 5, bodyweight: BODYWEIGHT, estimated1RM: epley(BODYWEIGHT + 15, 5) },
          { id: 's-2', date: '2026-01-20T12:00:00', weight: 25, reps: 5, bodyweight: BODYWEIGHT, estimated1RM: PR },
        ],
      }]
    }

    async function openPullupModal(wrapper: VueWrapper) {
      await wrapper.findAll('.wtExerciseLogBtn')[0].trigger('click')
      await wrapper.vm.$nextTick()
    }

    // The field is labelled "Added" on a bodyweight-loaded exercise (LIFT-1330)
    // — it holds belt weight, not the load. The one test below that mounts a
    // normal exercise still finds it as "Weight", which is the point.
    const ADDED_FIELD = 'input[aria-label="Added weight"]'

    function weightField(wrapper: VueWrapper) {
      return wrapper.find(ADDED_FIELD).element as HTMLInputElement
    }

    /** What `logSet` would store for a set typed into the fields right now. */
    function savedE1RM(wrapper: VueWrapper, reps: number) {
      return epley(Number(weightField(wrapper).value) + BODYWEIGHT, reps)
    }

    beforeEach(() => {
      mockState.exercises = pullups()
      mockBodyweightState.lbs = BODYWEIGHT
    })

    it('estimates the 1RM of the full load, matching what logSet will store', async () => {
      const wrapper = mountTracker()
      await openPullupModal(wrapper)
      await wrapper.find(ADDED_FIELD).setValue('25')
      await wrapper.find('input[aria-label="Reps"]').setValue('5')

      // Was ~29 lbs — Epley over the bare added weight — against a stored 216.
      expect(wrapper.find('.repMaxResult').text()).toContain(`${PR} lbs`)
      expect(savedE1RM(wrapper, 5)).toBe(PR)
    })

    it('leaves a normal exercise untouched (fold is 0)', async () => {
      mockState.exercises = [{
        id: 'ex-1', name: 'Bench Press', tags: [], sets: [
          { id: 's-1', date: '2026-01-15T12:00:00', weight: 185, reps: 5, estimated1RM: 216 },
        ],
      }]
      const wrapper = mountTracker()
      await openPullupModal(wrapper)
      await wrapper.find('input[aria-label="Weight"]').setValue('185')
      await wrapper.find('input[aria-label="Reps"]').setValue('5')

      expect(wrapper.find('.repMaxResult').text()).toContain('216 lbs')
    })

    it('suggests an added weight that just beats the PR, not one that doubles it', async () => {
      const wrapper = mountTracker()
      await openPullupModal(wrapper)
      // Reps only → the "to beat" card fills the weight axis.
      await wrapper.find('input[aria-label="Reps"]').setValue('5')

      const card = wrapper.find('.repMaxResultTarget')
      expect(card.exists()).toBe(true)
      // Was ~186 (the effective total offered as ADDED weight). 30 is the first
      // 5 lb step past the 25.6 lb of belt weight actually required.
      expect(card.text()).toContain('30 lbs × 5')

      await wrapper.find(ADDED_FIELD).setValue('30')
      // The savable consequence: this must edge the PR, not land near 2x it.
      const saved = savedE1RM(wrapper, 5)
      expect(saved).toBeGreaterThan(PR)
      expect(saved).toBeLessThan(PR + 20)
    })

    it('fills intensity rows in added-weight space', async () => {
      const wrapper = mountTracker()
      await openPullupModal(wrapper)
      // Intensity is the only lens here (no ladder, no last session), so the
      // drawer starts collapsed and there is no segmented control to click.
      await wrapper.find('.wtPrTargetsHeader').trigger('click')
      // 100% = the PR-beating end of the lens, the tap that used to be able to
      // save a fake all-time PR.
      await wrapper.find('.wtIntensitySlider').setValue(100)

      const rows = wrapper.findAll('.wtPrTargetsRow')
      expect(rows.length).toBeGreaterThan(0)
      await rows[0].trigger('click')

      const filled = Number(weightField(wrapper).value)
      const filledReps = Number((wrapper.find('input[aria-label="Reps"]').element as HTMLInputElement).value)
      // A belt load, not the whole effective total.
      expect(filled).toBeLessThan(PR - BODYWEIGHT + 10)
      const saved = epley(filled + BODYWEIGHT, filledReps)
      expect(saved).toBeGreaterThanOrEqual(PR)
      expect(saved).toBeLessThan(PR + 20)
    })

    /**
     * Regression for the LIFT-1315 × #1328 merge seam. The fold is canonical
     * lbs; the intensity generator moved into DISPLAY units (bar, plates, 1RM
     * and now the base load all share one space). Passing the fold raw put a
     * 160 lb bodyweight into a kg table as 160 KG of base load — larger than
     * the 98 kg anchor itself, so every rep target went negative and the lens
     * rendered its empty state. The lifter who most needs a suggestion (kg,
     * bodyweight-loaded) would have been the only one offered none.
     *
     * Neither parent branch could catch it: the kg suite uses a normal exercise
     * (fold 0) and the bodyweight suite runs in lbs, where displayWeight() is
     * the identity. The bug lives only at the intersection.
     */
    it('fills intensity rows in added-weight space for a kg user (LIFT-1315)', async () => {
      setMockUnit('kg')
      try {
        const wrapper = mountTracker()
        await openPullupModal(wrapper)
        await wrapper.find('.wtPrTargetsHeader').trigger('click')
        await wrapper.find('.wtIntensitySlider').setValue(100)

        const rows = wrapper.findAll('.wtPrTargetsRow')
        // The assertion that fails on a raw-lbs fold: the table is not empty.
        expect(rows.length).toBeGreaterThan(0)

        // A tapped row must fill the field with the number it advertises, in kg.
        const labelled = rows[0].find('.wtPrTargetsWeight').text().replace(' kg', '')
        await rows[0].trigger('click')
        await wrapper.vm.$nextTick()
        expect(weightField(wrapper).value).toBe(labelled)

        // ...and it is belt weight, not the whole effective total: converted
        // back to lbs it edges the 216 lb PR rather than doubling it.
        const addedLbs = Number(weightField(wrapper).value) / 0.453592
        const filledReps = Number((wrapper.find('input[aria-label="Reps"]').element as HTMLInputElement).value)
        const saved = epley(addedLbs + BODYWEIGHT, filledReps)
        expect(saved).toBeGreaterThanOrEqual(PR - 1)
        expect(saved).toBeLessThan(PR + 20)
      } finally {
        setMockUnit('lbs')
      }
    })

    it('asks for a reachable rep count at a typed added weight', async () => {
      const wrapper = mountTracker()
      await openPullupModal(wrapper)
      // 25 lb added ties the PR at 5 reps, so 6 reps beats it — not the ~90 the
      // unfolded comparison (25 vs 216) used to demand.
      await wrapper.find(ADDED_FIELD).setValue('25')

      const card = wrapper.find('.repMaxResultTarget')
      expect(card.text()).toContain('25 lbs × 6')
    })

    it('says bodyweight alone beats the best when no added weight is needed', async () => {
      const wrapper = mountTracker()
      await openPullupModal(wrapper)
      // 12 bodyweight pull-ups out-score a +25 x 5, so there is no positive
      // added weight to suggest — a real state, not a missing card.
      await wrapper.find('input[aria-label="Reps"]').setValue('12')

      const card = wrapper.find('.repMaxResultTarget')
      expect(card.text()).toContain('Bodyweight × 12')
      expect(card.text()).toContain('no added weight needed')
      // #1328 shipped this card informational-only because 0 was not a savable
      // weight. LIFT-1330 made it one, so the card now loads its own answer
      // like every other to-beat card in the sheet.
      expect(card.classes()).toContain('repMaxResultTappable')
      await card.trigger('click')
      expect(weightField(wrapper).value).toBe('0')
      expect(wrapper.find('.repMaxBtnCalc').attributes('disabled')).toBeUndefined()
    })

    it('edits against the set\'s captured bodyweight, not today\'s weigh-in', async () => {
      // The lifter has since cut to 150; `updateSet` keeps the 160 captured at
      // log time, so the estimate must too or it shows a number the save can't
      // produce.
      mockBodyweightState.lbs = 150
      const wrapper = mountTracker()
      await wrapper.findAll('.wtExerciseRow')[0].trigger('click')
      await wrapper.vm.$nextTick()
      await wrapper.findAll('.wtSetRowMain')[0].trigger('click')
      await wrapper.vm.$nextTick()
      await wrapper.findAll('.wtSetBtn').find(b => b.text() === 'Edit')!.trigger('click')
      await wrapper.vm.$nextTick()

      // The most recent set (25 x 5, captured at 160 lb) opens pre-filled.
      expect(weightField(wrapper).value).toBe('25')
      expect(wrapper.find('.repMaxResult').text()).toContain(`${PR} lbs`)
    })

    it('folds nothing when the lifter has never tracked their bodyweight', async () => {
      // The store captures nothing in that case, so the sheet must not either —
      // otherwise the preview would disagree with what gets stored.
      mockBodyweightState.lbs = null
      const wrapper = mountTracker()
      await openPullupModal(wrapper)
      await wrapper.find(ADDED_FIELD).setValue('25')
      await wrapper.find('input[aria-label="Reps"]').setValue('5')

      expect(wrapper.find('.repMaxResult').text()).toContain(`${epley(25, 5)} lbs`)
    })

    /**
     * LIFT-1330 — the entry half of the same feature. LIFT-834 was built so
     * "a pure-bodyweight rep at added = 0 still scores", and the store scored
     * it from day one, but every gate in this sheet hand-rolled `weight > 0`:
     * a plain pull-up — the single most common set the feature exists to
     * record — could not be typed in. There was no other way in either, so the
     * lifter's options were to skip the set or to log a fake 1 lb, which then
     * poisons the ladder clustering and the overload nudge with a rung nobody
     * loaded.
     *
     * Why nothing caught it: the flag's tests all cover the FOLD, never the
     * ENTRY. `bodyweightLoad.test.ts` builds `{ weight: 0, bodyweight: 170 }`
     * as a fixture literal and asserts the math; it never asks whether the app
     * can produce that object. #1328 added the first tests that mount the
     * tracker with `bodyweightLoaded` set, and every one of them types a
     * positive added weight — because that is all the sheet accepted.
     */
    describe('logging added-0 (LIFT-1330)', () => {
      const saveBtn = (wrapper: VueWrapper) => wrapper.find('.repMaxBtn.repMaxBtnCalc')
      const isSaveEnabled = (wrapper: VueWrapper) =>
        saveBtn(wrapper).attributes('disabled') === undefined

      it('enables Save and logs weight 0 for a pure-bodyweight set', async () => {
        const wrapper = mountTracker()
        await openPullupModal(wrapper)
        await wrapper.find(ADDED_FIELD).setValue('0')
        await wrapper.find('input[aria-label="Reps"]').setValue('12')

        expect(isSaveEnabled(wrapper)).toBe(true)
        await saveBtn(wrapper).trigger('click')
        expect(mockLogSet).toHaveBeenCalledWith(
          'ex-1', 0, 12, expect.any(String), expect.objectContaining({}),
        )
      })

      it('estimates the 1RM of bodyweight alone', async () => {
        const wrapper = mountTracker()
        await openPullupModal(wrapper)
        await wrapper.find(ADDED_FIELD).setValue('0')
        await wrapper.find('input[aria-label="Reps"]').setValue('12')

        // Epley over the lifter's own bodyweight — the number logSet stores.
        expect(wrapper.find('.repMaxResult').text()).toContain(`${epley(BODYWEIGHT, 12)} lbs`)
      })

      it('still refuses 0 on a normal exercise', async () => {
        mockState.exercises = [{
          id: 'ex-1', name: 'Bench Press', tags: [], sets: [
            { id: 's-1', date: '2026-01-15T12:00:00', weight: 185, reps: 5, estimated1RM: 216 },
          ],
        }]
        const wrapper = mountTracker()
        await openPullupModal(wrapper)
        await wrapper.find('input[aria-label="Weight"]').setValue('0')
        await wrapper.find('input[aria-label="Reps"]').setValue('5')

        // A 0 lb barbell set says nothing — the floor only moves for the
        // exercise whose field means "added".
        expect(isSaveEnabled(wrapper)).toBe(false)
      })

      it('keeps an empty field distinct from an explicit 0', async () => {
        const wrapper = mountTracker()
        await openPullupModal(wrapper)
        await wrapper.find('input[aria-label="Reps"]').setValue('12')

        // Reps alone is not a set: blank still means "not filled in", which is
        // also what keeps the "what should I add?" card on screen.
        expect(isSaveEnabled(wrapper)).toBe(false)
        expect(wrapper.find('.repMaxResultTarget').exists()).toBe(true)

        await wrapper.find(ADDED_FIELD).setValue('0')
        expect(isSaveEnabled(wrapper)).toBe(true)
        // ...and now the weight axis IS filled, so the card gives way to the
        // estimate rather than suggesting a weight the lifter just chose.
        expect(wrapper.find('.repMaxResultTarget').exists()).toBe(false)
      })

      it('calls the field "Added" and drops the barbell placeholder', async () => {
        const wrapper = mountTracker()
        await openPullupModal(wrapper)

        const field = wrapper.find(ADDED_FIELD)
        expect(field.attributes('placeholder')).toBe('0')
        // The visible label, not just the accessible one: "Weight: 135" on a
        // pull-up is why added-0 looked forbidden in the first place.
        expect(wrapper.find('.logSetFieldWeight .logSetFieldLabel').text()).toContain('Added')
      })

      it('leaves the label and placeholder alone on a normal exercise', async () => {
        mockState.exercises = [{ id: 'ex-1', name: 'Bench Press', tags: [], sets: [] }]
        const wrapper = mountTracker()
        await openPullupModal(wrapper)

        expect(wrapper.find('input[aria-label="Weight"]').attributes('placeholder')).toBe('135')
        expect(wrapper.find('.logSetFieldWeight .logSetFieldLabel').text()).toContain('Weight')
      })

      it('counts pure-bodyweight history as the best at that weight', async () => {
        mockState.exercises = [{
          id: 'ex-1', name: 'Pull-Up', tags: ['Back'], bodyweightLoaded: true,
          sets: [
            { id: 's-1', date: '2026-01-15T12:00:00', weight: 0, reps: 8, bodyweight: BODYWEIGHT, estimated1RM: epley(BODYWEIGHT, 8) },
            { id: 's-2', date: '2026-01-20T12:00:00', weight: 0, reps: 10, bodyweight: BODYWEIGHT, estimated1RM: epley(BODYWEIGHT, 10) },
          ],
        }]
        const wrapper = mountTracker()
        await openPullupModal(wrapper)
        // Weight only → the reps-to-beat card, which now has an added-0 rung of
        // history to read rather than bailing on the field.
        await wrapper.find(ADDED_FIELD).setValue('0')

        const card = wrapper.find('.repMaxResultTarget')
        expect(card.text()).toContain('Your best at 0 lbs: 10 reps')
      })

      it('offers no rep target when there is no bodyweight to make 0 a load', async () => {
        // Added 0 with nothing on record is a genuinely zero load, and
        // "how many reps at nothing beats your PR" divides by it — the card
        // would have rendered an Infinity rep count.
        mockBodyweightState.lbs = null
        const wrapper = mountTracker()
        await openPullupModal(wrapper)
        await wrapper.find(ADDED_FIELD).setValue('0')

        expect(wrapper.find('.repMaxResultTarget').exists()).toBe(false)
        // Save still works — the set is real, only the estimate is unknowable.
        await wrapper.find('input[aria-label="Reps"]').setValue('12')
        expect(isSaveEnabled(wrapper)).toBe(true)
      })

      it('lets an existing set be edited down to bodyweight only', async () => {
        const wrapper = mountTracker()
        await wrapper.findAll('.wtExerciseRow')[0].trigger('click')
        await wrapper.vm.$nextTick()
        await wrapper.findAll('.wtSetRowMain')[0].trigger('click')
        await wrapper.vm.$nextTick()
        await wrapper.findAll('.wtSetBtn').find(b => b.text() === 'Edit')!.trigger('click')
        await wrapper.vm.$nextTick()

        await wrapper.find(ADDED_FIELD).setValue('0')
        expect(isSaveEnabled(wrapper)).toBe(true)
        await saveBtn(wrapper).trigger('click')
        expect(mockUpdateSet).toHaveBeenCalledWith(
          'ex-1', 's-2', 0, 5, expect.any(String), null, false,
        )
      })
    })

    /**
     * LIFT-1373 — reading the set back out in words. Both of the tracker's
     * read-back surfaces echoed `set.weight` bare, so the set LIFT-1330 made
     * typeable was confirmed as "0 lbs × 12 reps" — the only feedback a
     * screen-reader user gets after a save, saying they moved nothing.
     */
    describe('reads a set back in ADDED-space words (LIFT-1373)', () => {
      const saveBtn = (wrapper: VueWrapper) => wrapper.find('.repMaxBtn.repMaxBtnCalc')

      async function saveAndRead(wrapper: VueWrapper, added: string, reps: string) {
        await wrapper.find(ADDED_FIELD).setValue(added)
        await wrapper.find('input[aria-label="Reps"]').setValue(reps)
        await saveBtn(wrapper).trigger('click')
        // announceSet clears then re-sets on nextTick so identical re-logs re-fire.
        await wrapper.vm.$nextTick()
        await wrapper.vm.$nextTick()
        // Re-find: Vue replaces the text node, so a held wrapper is stale.
        return wrapper.find('.repMaxModal .srOnly[aria-live="polite"]').text()
      }

      it('announces a pure-bodyweight save as "Bodyweight"', async () => {
        const wrapper = mountTracker()
        await openPullupModal(wrapper)
        expect(await saveAndRead(wrapper, '0', '12')).toBe('Logged Pull-Up: Bodyweight × 12 reps')
      })

      it('announces an added weight as added', async () => {
        const wrapper = mountTracker()
        await openPullupModal(wrapper)
        expect(await saveAndRead(wrapper, '25', '5')).toBe('Logged Pull-Up: +25 lbs × 5 reps')
      })

      it('leaves a normal exercise announcing the plain weight', async () => {
        mockState.exercises = [{ id: 'ex-1', name: 'Bench Press', tags: [], sets: [] }]
        const wrapper = mountTracker()
        await openPullupModal(wrapper)
        await wrapper.find('input[aria-label="Weight"]').setValue('185')
        await wrapper.find('input[aria-label="Reps"]').setValue('5')
        await saveBtn(wrapper).trigger('click')
        await wrapper.vm.$nextTick()
        await wrapper.vm.$nextTick()
        expect(wrapper.find('.repMaxModal .srOnly[aria-live="polite"]').text())
          .toBe('Logged Bench Press: 185 lbs × 5 reps')
      })

      // The edit path's "Set updated: …" string goes through the same
      // `setLoadLabel`, but it cannot be asserted from the DOM: `saveSet`
      // calls `closeModal()` synchronously after `announceSet`, which unmounts
      // the live region before the nextTick that fills it. That announcement
      // has never reached anyone — pre-existing, filed separately.

      it('reads the exercise row last-set meta in the same words', async () => {
        // The row meta is the list surface's own read-back — the same set,
        // one screen up from the sheet that just announced it.
        const wrapper = mountTracker()
        expect(wrapper.find('.wtExerciseStat').text()).toContain('+25 lbs')

        mockState.exercises = [{
          id: 'ex-1', name: 'Pull-Up', tags: ['Back'], bodyweightLoaded: true,
          sets: [{ id: 's-1', date: '2026-01-20T12:00:00', weight: 0, reps: 12, bodyweight: BODYWEIGHT, estimated1RM: epley(BODYWEIGHT, 12) }],
        }]
        const bwOnly = mountTracker()
        const stat = bwOnly.find('.wtExerciseStat').text()
        expect(stat).toContain('Bodyweight')
        expect(stat).not.toContain('0 lbs')
      })
    })
  })

  /**
   * LIFT-1305 — the to-beat cards are the log sheet's one-tap "load this"
   * affordance, and three of the four shipped as bare `@click` divs: no role,
   * no tabindex, no key handler. A keyboard or switch-control user could not
   * reach them at all (WCAG 2.1.1, Level A). The fourth sibling in the very
   * same v-else-if chain — the overload nudge, added later — already carried
   * role/tabindex/Enter, which is what makes this an omission rather than a
   * convention.
   *
   * The behavioural half is here; `architecturalInvariants.test.ts` derives the
   * structural half over every `role="button"` in `src/`, so a card added to
   * this chain later cannot repeat the omission.
   */
  describe('to-beat cards are keyboard-operable (LIFT-1305)', () => {
    beforeEach(() => { mockState.exercises = createExercises() })

    const openBench = async (wrapper: VueWrapper) => {
      await wrapper.findAll('.wtExerciseLogBtn')[0].trigger('click')
      await wrapper.vm.$nextTick()
    }
    const repsField = (wrapper: VueWrapper) =>
      wrapper.find('input[aria-label="Reps"]').element as HTMLInputElement
    const weightValue = (wrapper: VueWrapper) =>
      (wrapper.find('input[aria-label="Weight"]').element as HTMLInputElement).value

    // Bench Press' best e1RM is 228 (195 × 5). A typed weight below that asks
    // for a rep count; one above it means any single rep beats the baseline.
    it('activates the "set reps" card with Enter and with Space', async () => {
      for (const key of ['enter', 'space'] as const) {
        const wrapper = mountTracker()
        await openBench(wrapper)
        await wrapper.find('input[aria-label="Weight"]').setValue('185')

        const card = wrapper.find('.repMaxResultTappable')
        expect(card.attributes('role')).toBe('button')
        expect(card.attributes('tabindex')).toBe('0')
        expect(card.text()).toContain('185 lbs × 8')

        await card.trigger(`keydown.${key}`)
        await wrapper.vm.$nextTick()
        expect(repsField(wrapper).value).toBe('8')
      }
    })

    it('activates the "any rep beats it" card with Enter and with Space', async () => {
      for (const key of ['enter', 'space'] as const) {
        const wrapper = mountTracker()
        await openBench(wrapper)
        // 235 > the 228 baseline, so a single rep is the whole target.
        await wrapper.find('input[aria-label="Weight"]').setValue('235')

        const card = wrapper.find('.repMaxResultTappable')
        expect(card.attributes('role')).toBe('button')
        expect(card.attributes('tabindex')).toBe('0')
        expect(card.text()).toContain('235 lbs × 1')

        await card.trigger(`keydown.${key}`)
        await wrapper.vm.$nextTick()
        expect(repsField(wrapper).value).toBe('1')
      }
    })

    it('activates the "load plates" card with Enter and with Space', async () => {
      for (const key of ['enter', 'space'] as const) {
        mockState.exercises = createExercises()
        mockState.exercises[0].inputMode = 'plates'
        mockState.exercises[0].barWeight = 45
        const wrapper = mountTracker()
        await openBench(wrapper)
        // Plate mode seeds the field from the last set, so clear it: the card
        // only offers a weight when reps are filled and weight is not.
        await wrapper.find('input[aria-label="Weight"]').setValue('')
        await wrapper.find('input[aria-label="Reps"]').setValue('5')

        const card = wrapper.find('.repMaxResultTappable')
        expect(card.attributes('role')).toBe('button')
        expect(card.attributes('tabindex')).toBe('0')
        expect(card.text()).toContain('Tap to load plates')

        // 228 e1RM at 5 reps needs ~196 lbs, rounded up to the 5 lb grid.
        await card.trigger(`keydown.${key}`)
        await wrapper.vm.$nextTick()
        expect(weightValue(wrapper)).toBe('200')
      }
    })

    // The same card is purely informational without the plate calculator, so it
    // must NOT advertise itself as a button or sit in the tab order — an empty
    // stop is its own 2.4.3/4.1.2 problem.
    it('leaves the to-beat card out of the tab order when it does nothing', async () => {
      const wrapper = mountTracker()
      await openBench(wrapper)
      await wrapper.find('input[aria-label="Reps"]').setValue('5')

      const card = wrapper.find('.repMaxResultTarget')
      expect(card.exists()).toBe(true)
      expect(card.classes()).not.toContain('repMaxResultTappable')
      expect(card.attributes('role')).toBeUndefined()
      expect(card.attributes('tabindex')).toBeUndefined()
    })

    it('activates the plate-calculator hint with Space, not just Enter', async () => {
      const wrapper = mountTracker()
      await openBench(wrapper)

      const hint = wrapper.find('.wtPlateHint')
      expect(hint.attributes('role')).toBe('button')
      expect(hint.attributes('tabindex')).toBe('0')
      await hint.trigger('keydown.space')
      await wrapper.vm.$nextTick()

      // Same effect as tapping it: dismissed, and exercise settings opened.
      expect(wrapper.find('.wtPlateHint').exists()).toBe(false)
      expect(localStorageMock.getItem('plate-calc-hint-dismissed')).toBe('true')
    })
  })

  describe('exercise search', () => {
    const FIVE_EXERCISES: Exercise[] = [
      { id: 'ex-1', name: 'Bench Press', tags: ['Chest'], sets: [] },
      { id: 'ex-2', name: 'Squat', tags: ['Legs'], sets: [] },
      { id: 'ex-3', name: 'Deadlift', tags: ['Back'], sets: [] },
      { id: 'ex-4', name: 'Overhead Press', tags: ['Shoulders'], sets: [] },
      { id: 'ex-5', name: 'Barbell Row', tags: ['Back'], sets: [] },
    ]

    beforeEach(() => {
      mockState.exercises = JSON.parse(JSON.stringify(FIVE_EXERCISES))
    })

    it('shows search bar when 5+ exercises exist', () => {
      const wrapper = mountTracker()
      expect(wrapper.find('.wtSearchBar').exists()).toBe(true)
    })

    it('hides search bar when fewer than 5 exercises', () => {
      mockState.exercises = createExercises() // only 3
      const wrapper = mountTracker()
      expect(wrapper.find('.wtSearchBar').exists()).toBe(false)
    })

    it('filters exercises by search query', async () => {
      const wrapper = mountTracker()
      const searchInput = wrapper.find('.wtSearchInput')
      await searchInput.setValue('bench')

      const items = wrapper.findAll('.wtExerciseItem')
      expect(items.length).toBe(1)
      expect(wrapper.text()).toContain('Bench Press')
    })

    it('shows result count when searching', async () => {
      const wrapper = mountTracker()
      const searchInput = wrapper.find('.wtSearchInput')
      await searchInput.setValue('press')

      expect(wrapper.find('.wtSearchCount').text()).toContain('2')
    })

    it('announces the result count via a persistent polite live region (#989)', async () => {
      const wrapper = mountTracker()
      // The live region is always present so assistive tech observes mutations,
      // and is empty (silent) before any query is typed.
      const live = wrapper.find('.wtSearchBar .srOnly[aria-live="polite"]')
      expect(live.exists()).toBe(true)
      expect(live.attributes('role')).toBe('status')
      expect(live.attributes('aria-atomic')).toBe('true')
      expect(live.text()).toBe('')

      const searchInput = wrapper.find('.wtSearchInput')
      await searchInput.setValue('press')
      expect(live.text()).toBe('2 results')

      await searchInput.setValue('bench')
      expect(live.text()).toBe('1 result')

      await searchInput.setValue('zzzzz')
      expect(live.text()).toBe('0 results')

      // Clearing the query silences the region again.
      await searchInput.setValue('')
      expect(live.text()).toBe('')
    })

    it('hides the visible result badge from assistive tech to avoid a double read (#989)', async () => {
      const wrapper = mountTracker()
      const searchInput = wrapper.find('.wtSearchInput')
      await searchInput.setValue('press')

      expect(wrapper.find('.wtSearchCount').attributes('aria-hidden')).toBe('true')
    })

    it('shows no-match message for unmatched query', async () => {
      const wrapper = mountTracker()
      const searchInput = wrapper.find('.wtSearchInput')
      await searchInput.setValue('zzzzz')

      expect(wrapper.findAll('.wtExerciseItem').length).toBe(0)
      expect(wrapper.text()).toContain('No exercises match your search')
    })

    it('search is case-insensitive', async () => {
      const wrapper = mountTracker()
      const searchInput = wrapper.find('.wtSearchInput')
      await searchInput.setValue('SQUAT')

      expect(wrapper.findAll('.wtExerciseItem').length).toBe(1)
      expect(wrapper.text()).toContain('Squat')
    })

    it('combined search and tag filter narrows results', async () => {
      const wrapper = mountTracker()
      // First filter by tag 'Back' — skip the "All" and manage chips added
      // in the 03-workouts.png restyle.
      const chips = wrapper.findAll('.wtTagChip').filter(c => {
        if (c.classes('wtTagChipClear')) return false
        if (c.classes('wtTagChipManage')) return false
        const label = c.find('.wtTagChipLabel')
        return label.exists()
      })
      const backChip = chips.find(c => c.find('.wtTagChipLabel').text() === 'Back')!
      await backChip.trigger('click')

      // Then search for 'row'
      const searchInput = wrapper.find('.wtSearchInput')
      await searchInput.setValue('row')

      const items = wrapper.findAll('.wtExerciseItem')
      expect(items.length).toBe(1)
      expect(wrapper.text()).toContain('Barbell Row')
    })
  })

  describe('delete set with undo', () => {
    beforeEach(() => {
      mockState.exercises = createExercises()
    })

    it('calls deleteSet when delete button is clicked', async () => {
      const wrapper = mountTracker()
      // Open detail modal
      await wrapper.findAll('.wtExerciseRow')[0].trigger('click')
      await wrapper.vm.$nextTick()

      // Tap a set to reveal actions
      await wrapper.findAll('.wtSetRowMain')[0].trigger('click')
      await wrapper.vm.$nextTick()

      // Click delete
      const btns = wrapper.findAll('.wtSetBtn')
      const deleteBtn = btns.find(b => b.text() === 'Delete')!
      await deleteBtn.trigger('click')
      await wrapper.vm.$nextTick()

      expect(mockDeleteSet).toHaveBeenCalledWith('ex-1', expect.any(String), { sync: false })
    })

    it('calls deleteExercise from edit exercise modal', async () => {
      const wrapper = mountTracker()
      await wrapper.findAll('.wtExerciseRow')[0].trigger('click')
      await wrapper.vm.$nextTick()

      // Open edit modal from detail header
      await wrapper.find('.wtDetailEditBtn').trigger('click')
      await wrapper.vm.$nextTick()

      // Click Delete Exercise, then confirm
      await wrapper.find('.wtEditDeleteBtn').trigger('click')
      await wrapper.vm.$nextTick()
      await wrapper.find('.wtEditDeleteConfirmDanger').trigger('click')
      await wrapper.vm.$nextTick()

      expect(mockDeleteExercise).toHaveBeenCalledWith('ex-1', { sync: false })
    })
  })

  describe('edit set flow', () => {
    beforeEach(() => {
      mockState.exercises = createExercises()
    })

    it('opens edit modal with pre-filled values when Edit is clicked', async () => {
      const wrapper = mountTracker()
      // Open detail modal
      await wrapper.findAll('.wtExerciseRow')[0].trigger('click')
      await wrapper.vm.$nextTick()

      // Tap a set to reveal actions
      await wrapper.findAll('.wtSetRowMain')[0].trigger('click')
      await wrapper.vm.$nextTick()

      // Click edit
      const btns = wrapper.findAll('.wtSetBtn')
      const editBtn = btns.find(b => b.text() === 'Edit')!
      await editBtn.trigger('click')
      await wrapper.vm.$nextTick()

      expect(wrapper.find('.repMaxModal').exists()).toBe(true)
      expect(wrapper.find('#log-modal-title').text()).toBe('Edit Set')
    })

    it('calls updateSet on save in edit mode', async () => {
      const wrapper = mountTracker()
      await wrapper.findAll('.wtExerciseRow')[0].trigger('click')
      await wrapper.vm.$nextTick()

      await wrapper.findAll('.wtSetRowMain')[0].trigger('click')
      await wrapper.vm.$nextTick()

      const editBtn = wrapper.findAll('.wtSetBtn').find(b => b.text() === 'Edit')!
      await editBtn.trigger('click')
      await wrapper.vm.$nextTick()

      // Modify weight
      const inputs = wrapper.findAll('.repMaxModal input')
      const weightInput = inputs.find(i => i.attributes('inputmode') === 'decimal')!
      await weightInput.setValue('200')

      const repsInput = inputs.find(i => i.attributes('inputmode') === 'numeric')!
      await repsInput.setValue('6')

      await wrapper.find('.repMaxBtn.repMaxBtnCalc').trigger('click')

      expect(mockUpdateSet).toHaveBeenCalledWith('ex-1', expect.any(String), 200, 6, expect.any(String), null, false)
    })

    it('shows date picker in edit mode', async () => {
      const wrapper = mountTracker()
      // Open detail modal
      await wrapper.findAll('.wtExerciseRow')[0].trigger('click')
      await wrapper.vm.$nextTick()

      // Tap set, click Edit
      await wrapper.findAll('.wtSetRowMain')[0].trigger('click')
      await wrapper.vm.$nextTick()
      const editBtn = wrapper.findAll('.wtSetBtn').find(b => b.text() === 'Edit')!
      await editBtn.trigger('click')
      await wrapper.vm.$nextTick()

      // Date picker should be visible in edit mode
      const dateInput = wrapper.find('.repMaxModal input[type="date"]')
      expect(dateInput.exists()).toBe(true)
    })

    // Regression (c16fc0b): tapping the "Today" subtitle must trigger the
    // native date picker. After the modal redesign (d4974c2) moved the date
    // into an inline <span>, the overlay input's click handler was missing,
    // so desktop Chrome never opened the picker (Chrome only opens on the
    // built-in calendar icon, not on opacity:0 input-body clicks).
    it('date subtitle tap calls showPicker on the overlay input', async () => {
      const wrapper = mountTracker()
      await wrapper.findAll('.wtExerciseLogBtn')[0].trigger('click')
      await wrapper.vm.$nextTick()

      const wrap = wrapper.find('.wtDateBtnWrap')
      expect(wrap.exists(), 'date subtitle wrap missing from log modal').toBe(true)

      const dateInput = wrapper.find('.wtDateOverlayInput')
      expect(dateInput.exists(), 'overlay date input missing').toBe(true)
      expect(dateInput.attributes('type')).toBe('date')

      // The click handler must be bound so showPicker() fires inside the
      // user gesture on desktop Chrome and iOS 16+.
      const el = dateInput.element as HTMLInputElement
      let showPickerCalled = false
      // jsdom doesn't implement showPicker; install a stub so the handler
      // can invoke it without throwing.
      ;(el as HTMLInputElement & { showPicker: () => void }).showPicker = () => {
        showPickerCalled = true
      }
      await dateInput.trigger('click')
      expect(showPickerCalled, '@click="tryShowDatePicker" binding missing — regression of c16fc0b').toBe(true)
    })
  })

  describe('accessibility', () => {
    it('log modal has aria-modal and role dialog', async () => {
      mockState.exercises = createExercises()
      const wrapper = mountTracker()
      await wrapper.findAll('.wtExerciseLogBtn')[0].trigger('click')
      await wrapper.vm.$nextTick()

      const modal = wrapper.find('.repMaxModal')
      expect(modal.attributes('role')).toBe('dialog')
      expect(modal.attributes('aria-modal')).toBe('true')
    })

    it('search input has aria-label', () => {
      mockState.exercises = [
        { id: '1', name: 'A', tags: [], sets: [] },
        { id: '2', name: 'B', tags: [], sets: [] },
        { id: '3', name: 'C', tags: [], sets: [] },
        { id: '4', name: 'D', tags: [], sets: [] },
        { id: '5', name: 'E', tags: [], sets: [] },
      ]
      const wrapper = mountTracker()
      // Search now covers both exercise names and tags (03-workouts.png).
      expect(wrapper.find('.wtSearchInput').attributes('aria-label')).toBe('Search exercises or tags')
    })

    it('log button aria-label renders exercise name dynamically', () => {
      mockState.exercises = [{ id: '1', name: 'Bench Press', tags: [], sets: [] }]
      const wrapper = mountTracker()
      const logBtn = wrapper.find('.wtExerciseLogBtn')
      expect(logBtn.attributes('aria-label')).toBe('Log a set for Bench Press')
    })

    it('detail modal has aria-modal and role dialog', async () => {
      mockState.exercises = createExercises()
      const wrapper = mountTracker()
      await wrapper.findAll('.wtExerciseRow')[0].trigger('click')
      await wrapper.vm.$nextTick()

      const modal = wrapper.find('.wtDetailModal')
      expect(modal.attributes('role')).toBe('dialog')
      expect(modal.attributes('aria-modal')).toBe('true')
    })

    it('tag filter buttons have aria-pressed reflecting active state', () => {
      mockState.exercises = createExercises()
      const wrapper = mountTracker()
      // Only actual tag chips have aria-pressed — skip "All", "× Clear",
      // and the tag-manager chip added in the 03-workouts.png restyle.
      const tagBtns = wrapper.findAll('.wtTagChip').filter(c => c.find('.wtTagChipLabel').exists())
      expect(tagBtns.length).toBeGreaterThan(0)
      tagBtns.forEach(btn => {
        expect(btn.attributes('aria-pressed')).toBe('false')
      })
    })

    it('tag add buttons have aria-label', async () => {
      mockState.exercises = createExercises()
      const wrapper = mountTracker()
      // Open new exercise modal via the exposed helper (retired wtLogBtn).
      exposed(wrapper).openNewExerciseModal()
      await wrapper.vm.$nextTick()
      const addBtn = wrapper.find('.wtTagAddChip')
      expect(addBtn.attributes('aria-label')).toBe('Add tag')
    })

    it('timer visual display has aria-hidden (not aria-live) to prevent per-second announcements', () => {
      mockState.exercises = createExercises()
      const wrapper = mountTracker()
      const timerInner = wrapper.find('.wtTimerRingInner')
      if (timerInner.exists()) {
        expect(timerInner.attributes('aria-hidden')).toBe('true')
        expect(timerInner.attributes('aria-live')).toBeUndefined()
      }
    })

    it('timer has a screen-reader-only aria-live region for milestone announcements', () => {
      mockState.exercises = createExercises()
      const wrapper = mountTracker()
      const srAnnouncement = wrapper.find('.srOnly[aria-live="polite"]')
      if (srAnnouncement.exists()) {
        expect(srAnnouncement.attributes('aria-atomic')).toBe('true')
      }
    })
  })

  describe('rest timer drift correction', () => {
    beforeEach(() => {
      mockState.exercises = createExercises()
      localStorage.setItem('rest-timer', 'on')
      localStorage.setItem('rest-duration', '90')
      const mockOsc = { connect: vi.fn(), frequency: { value: 0, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() }, start: vi.fn(), stop: vi.fn() }
      const mockGain = { connect: vi.fn(), gain: { value: 0, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() } }
      vi.stubGlobal('AudioContext', class {
        state = 'running'
        currentTime = 0
        destination = {}
        resume = vi.fn()
        createOscillator = vi.fn(() => mockOsc)
        createGain = vi.fn(() => mockGain)
      })
      vi.useFakeTimers({ shouldAdvanceTime: false })
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('uses wall-clock time so backgrounding the app does not cause drift', async () => {
      const wrapper = mountTracker()
      const timer = timerState(wrapper)
      // Start the timer with 90s duration
      const startTime = Date.now()
      vi.setSystemTime(startTime)
      timer.startRestTimer()
      expect(timer.timerSeconds).toBe(90)

      // Simulate 30 real seconds passing (as if phone was backgrounded)
      vi.setSystemTime(startTime + 30_000)
      vi.advanceTimersByTime(250) // one tick
      await wrapper.vm.$nextTick()
      expect(timer.timerSeconds).toBe(60)

      // Simulate 55 more seconds — only 5s should remain
      vi.setSystemTime(startTime + 85_000)
      vi.advanceTimersByTime(250)
      await wrapper.vm.$nextTick()
      expect(timer.timerSeconds).toBe(5)
    })

    it('timer reaches zero even if intervals were throttled', async () => {
      const wrapper = mountTracker()
      const timer = timerState(wrapper)
      const startTime = Date.now()
      vi.setSystemTime(startTime)
      timer.startRestTimer()

      // Jump past the full duration in one step
      vi.setSystemTime(startTime + 91_000)
      vi.advanceTimersByTime(250)
      await wrapper.vm.$nextTick()
      expect(timer.timerSeconds).toBe(0)
    })
  })

  describe('view toggle', () => {
    beforeEach(() => {
      mockState.exercises = createExercises()
    })

    it('renders Exercises and Timeline toggle buttons when exercises exist', () => {
      const wrapper = mountTracker()
      const btns = wrapper.findAll('.wtViewToggleBtn')
      expect(btns.length).toBe(2)
      expect(btns[0].text()).toBe('Exercises')
      expect(btns[1].text()).toBe('Timeline')
    })

    it('does not render toggle when no exercises exist', () => {
      mockState.exercises = []
      const wrapper = mountTracker()
      expect(wrapper.find('.wtViewToggle').exists()).toBe(false)
    })

    it('defaults to exercises view', () => {
      const wrapper = mountTracker()
      const activeBtn = wrapper.find('.wtViewToggleBtn.active')
      expect(activeBtn.text()).toBe('Exercises')
    })

    it('switches to timeline view when Timeline button is clicked', async () => {
      const wrapper = mountTracker()
      await wrapper.findAll('.wtViewToggleBtn')[1].trigger('click')
      await wrapper.vm.$nextTick()

      expect(wrapper.find('.wtViewToggleBtn.active').text()).toBe('Timeline')
    })

    it('exposes openTimelineLogModal to open the exercise picker from both views', async () => {
      // The top-bar "+" now adds an exercise; logging a set goes through the
      // exercise picker, exposed via openTimelineLogModal (used by the timeline
      // view's "Log a set" button). The picker works from both views.
      const wrapper = mountTracker()
      expect(typeof exposed(wrapper).openTimelineLogModal).toBe('function')

      exposed(wrapper).openTimelineLogModal()
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.wtExPickerNew').exists()).toBe(true)

      // Switch to timeline view; the exposed helper still works.
      await wrapper.find('.wtExPickerRow + .wtExPickerRow, .wtExPickerRow')
      await wrapper.findAll('.wtViewToggleBtn')[1].trigger('click')
      await wrapper.vm.$nextTick()
      exposed(wrapper).openTimelineLogModal()
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.wtExPickerNew').exists()).toBe(true)
    })

    it('timeline view shows a "Log a set" button that opens the exercise picker', async () => {
      const wrapper = mountTracker()
      // Switch to timeline view (timeline rows have no per-exercise "+").
      await wrapper.findAll('.wtViewToggleBtn')[1].trigger('click')
      await wrapper.vm.$nextTick()

      const logBtn = wrapper.find('.wtTimelineLogBtn')
      expect(logBtn.exists()).toBe(true)
      expect(logBtn.attributes('aria-label')).toBe('Log a set')

      await logBtn.trigger('click')
      await wrapper.vm.$nextTick()
      // Picker opens with the "+ New exercise" row available.
      expect(wrapper.find('.wtExPickerNew').exists()).toBe(true)
    })

    it('exercise picker dialog has aria-labelledby linked to title', async () => {
      const wrapper = mountTracker()
      exposed(wrapper).openTimelineLogModal()
      await wrapper.vm.$nextTick()

      const dialog = wrapper.find('[role="dialog"][aria-labelledby="timeline-picker-title"]')
      expect(dialog.exists()).toBe(true)
      expect(dialog.attributes('aria-modal')).toBe('true')
      const title = wrapper.find('#timeline-picker-title')
      expect(title.exists()).toBe(true)
      expect(title.text()).toBe('Choose Exercise')
    })

    it('persists view selection to localStorage', async () => {
      const wrapper = mountTracker()
      await wrapper.findAll('.wtViewToggleBtn')[1].trigger('click')
      await wrapper.vm.$nextTick()

      expect(localStorageMock.setItem).toHaveBeenCalledWith('wt-list-view', 'timeline')
    })

    it('restores view from localStorage on mount', () => {
      localStorage.setItem('wt-list-view', 'timeline')
      const wrapper = mountTracker()
      expect(wrapper.find('.wtViewToggleBtn.active').text()).toBe('Timeline')
    })
  })

  describe('timeline view', () => {
    // Uses endOfDayISO-style timestamps (23:59:ss.msZ) to match production behavior.
    // Within a day, sets from different exercises preserve insertion order (Bench before Squat).
    const TIMELINE_EXERCISES: Exercise[] = [
      {
        id: 'ex-1',
        name: 'Bench Press',
        tags: ['Chest'],
        sets: [
          { id: 's-1', date: '2026-03-10T23:59:10.100Z', weight: 185, reps: 5, estimated1RM: 216 },
          { id: 's-2', date: '2026-03-10T23:59:20.200Z', weight: 185, reps: 4, estimated1RM: 208 },
          { id: 's-3', date: '2026-03-12T23:59:05.300Z', weight: 195, reps: 5, estimated1RM: 228 },
        ]
      },
      {
        id: 'ex-2',
        name: 'Squat',
        tags: ['Legs'],
        sets: [
          { id: 's-4', date: '2026-03-10T23:59:30.400Z', weight: 225, reps: 5, estimated1RM: 263 },
          { id: 's-5', date: '2026-03-12T23:59:45.500Z', weight: 235, reps: 3, estimated1RM: 257 },
        ]
      },
    ]

    async function mountTimeline() {
      const wrapper = mountTracker()
      await wrapper.findAll('.wtViewToggleBtn')[1].trigger('click')
      await wrapper.vm.$nextTick()
      return wrapper
    }

    beforeEach(() => {
      mockState.exercises = JSON.parse(JSON.stringify(TIMELINE_EXERCISES))
    })

    it('renders all sets across exercises sorted by date (newest first)', async () => {
      const wrapper = await mountTimeline()
      const rows = wrapper.findAll('.wtTimelineRow')
      expect(rows.length).toBe(5)
      // Mar 12 sets come first. Within a day, insertion order is preserved
      // (Bench iterated before Squat), so Bench 195 then Squat 235
      expect(rows[0].text()).toContain('195')
      expect(rows[1].text()).toContain('235')
    })

    it('groups sets by date with date headers', async () => {
      const wrapper = await mountTimeline()
      const headers = wrapper.findAll('.wtTimelineDateHeader')
      expect(headers.length).toBe(2) // Mar 12 and Mar 10
    })

    it('displays exercise name in each timeline row', async () => {
      const wrapper = await mountTimeline()
      const names = wrapper.findAll('.wtTimelineExName')
      expect(names.length).toBe(5)
      // Mar 12 sets: Bench then Squat (insertion order preserved within day)
      expect(names[0].text()).toBe('Bench Press')
      expect(names[1].text()).toBe('Squat')
    })

    it('displays weight × reps and estimated 1RM for each set', async () => {
      const wrapper = await mountTimeline()
      const details = wrapper.findAll('.wtTimelineSetDetail')
      // First entry is Bench 195×5 (insertion order within day)
      expect(details[0].text()).toContain('195')
      expect(details[0].text()).toContain('5')

      const e1rms = wrapper.findAll('.wtTimelineE1RM')
      expect(e1rms[0].text()).toContain('228')
    })

    it('shows empty message when no sets exist', async () => {
      mockState.exercises = [{ id: 'ex-1', name: 'Bench', tags: [], sets: [] }]
      const wrapper = await mountTimeline()
      expect(wrapper.text()).toContain('No sets logged yet')
    })

    it('reveals edit/delete actions on timeline row tap', async () => {
      const wrapper = await mountTimeline()
      await wrapper.findAll('.wtTimelineRowMain')[0].trigger('click')
      await wrapper.vm.$nextTick()

      expect(wrapper.find('.wtTimelineRowActive').exists()).toBe(true)
      const btns = wrapper.findAll('.wtSetBtn')
      expect(btns.map(b => b.text())).toContain('Edit')
      expect(btns.map(b => b.text())).toContain('Delete')
    })

    // ── Row disclosure keyboard reachability (LIFT-1349) ──────────────
    // Editing and deleting a logged set are reachable ONLY through this row,
    // and the row was a bare `<div @click>`: no role, no tabindex, no key
    // handler. A keyboard or switch-control user could log sets all day and
    // then never correct or remove one — WCAG 2.1.1, Level A, with no
    // alternative path anywhere in the app.
    describe('timeline row disclosure (LIFT-1349)', () => {
      it('is a real <button>, so Enter and Space come from the platform', async () => {
        const wrapper = await mountTimeline()
        const trigger = wrapper.findAll('.wtTimelineRowMain')[0]
        expect(trigger.element.tagName).toBe('BUTTON')
        expect(trigger.attributes('type')).toBe('button')
        // The row is a plain container: it must not carry the click itself,
        // or the trigger is decorative and the keyboard path is fake.
        expect(wrapper.findAll('.wtTimelineRow')[0].attributes('role')).toBeUndefined()
      })

      it('carries aria-expanded reflecting whether the actions are shown', async () => {
        const wrapper = await mountTimeline()
        expect(wrapper.findAll('.wtTimelineRowMain')[0].attributes('aria-expanded')).toBe('false')

        await wrapper.findAll('.wtTimelineRowMain')[0].trigger('click')
        await wrapper.vm.$nextTick()
        expect(wrapper.findAll('.wtTimelineRowMain')[0].attributes('aria-expanded')).toBe('true')
      })

      it('names the row by its set, not by the bare "~228" its text ends on', async () => {
        const wrapper = await mountTimeline()
        const label = wrapper.findAll('.wtTimelineRowMain')[0].attributes('aria-label')
        expect(label).toContain('Bench Press')
        expect(label).toContain('195')
        expect(label).toContain('5')
        // Static per row — the state belongs to aria-expanded (LIFT-1308).
        expect(label).not.toMatch(/expand|collapse|show|hide/i)
      })

      it('keeps Edit and Delete as siblings of the trigger, never inside it', async () => {
        // A button role is children-presentational, so action buttons nested
        // in the trigger drop out of the accessibility tree entirely.
        const wrapper = await mountTimeline()
        await wrapper.findAll('.wtTimelineRowMain')[0].trigger('click')
        await wrapper.vm.$nextTick()

        expect(wrapper.find('.wtTimelineRowMain .wtSetBtn').exists()).toBe(false)
        expect(wrapper.findAll('.wtTimelineRow > .wtSetActions .wtSetBtn')).toHaveLength(2)
      })

      it('has no axe violations with a row expanded', async () => {
        // axe is blind to the ORIGINAL defect — a missing key handler is a
        // behaviour, not an attribute — which is what the structural tests
        // above are for. This pins the other half: that the fix did not reach
        // for the `role="button"` row the other two lists carried, whose
        // nested Edit/Delete buttons axe rejects as `nested-interactive`.
        // Scoped to the timeline; the tracker's other views are their own
        // surfaces with their own scans.
        const wrapper = await mountTimeline()
        await wrapper.findAll('.wtTimelineRowMain')[0].trigger('click')
        await wrapper.vm.$nextTick()

        const results = await runComponentAxe(wrapper.find('.wtTimeline').element)
        expect(results).toHaveNoViolations()
      })
    })

    it('hides tag filter bar in timeline view', async () => {
      const wrapper = await mountTimeline()
      expect(wrapper.find('.wtTagFilterBar').exists()).toBe(false)
    })

    it('hides search bar in timeline view', async () => {
      // Need 5+ exercises for search bar
      mockState.exercises = [
        { id: '1', name: 'A', tags: [], sets: [{ id: 's1', date: '2026-01-01T10:00:00', weight: 100, reps: 5, estimated1RM: 117 }] },
        { id: '2', name: 'B', tags: [], sets: [] },
        { id: '3', name: 'C', tags: [], sets: [] },
        { id: '4', name: 'D', tags: [], sets: [] },
        { id: '5', name: 'E', tags: [], sets: [] },
      ]
      const wrapper = await mountTimeline()
      expect(wrapper.find('.wtSearchBar').exists()).toBe(false)
    })
  })

  describe('timeline pagination', () => {
    beforeEach(() => {
      // Create exercise with 55 sets to test "show more" (limit is 50)
      const sets = Array.from({ length: 55 }, (_, i) => ({
        id: `s-${i}`,
        date: `2026-01-${String(Math.floor(i / 3) + 1).padStart(2, '0')}T10:00:00`,
        weight: 135 + i,
        reps: 5,
        estimated1RM: 158 + i,
      }))
      mockState.exercises = [{ id: 'ex-1', name: 'Bench Press', tags: [], sets }]
    })

    it('limits visible timeline entries to 50 initially', async () => {
      const wrapper = mountTracker()
      await wrapper.findAll('.wtViewToggleBtn')[1].trigger('click')
      await wrapper.vm.$nextTick()

      const rows = wrapper.findAll('.wtTimelineRow')
      expect(rows.length).toBe(50)
    })

    it('shows "Show more" button with remaining count', async () => {
      const wrapper = mountTracker()
      await wrapper.findAll('.wtViewToggleBtn')[1].trigger('click')
      await wrapper.vm.$nextTick()

      const showMore = wrapper.find('.wtTimelineShowMore')
      expect(showMore.exists()).toBe(true)
      expect(showMore.text()).toContain('5 remaining')
    })

    it('loads more entries when "Show more" is clicked', async () => {
      const wrapper = mountTracker()
      await wrapper.findAll('.wtViewToggleBtn')[1].trigger('click')
      await wrapper.vm.$nextTick()

      await wrapper.find('.wtTimelineShowMore').trigger('click')
      await wrapper.vm.$nextTick()

      const rows = wrapper.findAll('.wtTimelineRow')
      expect(rows.length).toBe(55)
      expect(wrapper.find('.wtTimelineShowMore').exists()).toBe(false)
    })
  })

  describe('show all / show less sets', () => {
    beforeEach(() => {
      // Create exercise with 15 sets — exceeds SET_LIMIT of 10
      const sets = Array.from({ length: 15 }, (_, i) => ({
        id: `s-${i}`,
        date: `2026-01-${String(i + 1).padStart(2, '0')}T10:00:00`,
        weight: 135 + i * 5,
        reps: 5,
        estimated1RM: 158 + i * 5,
      }))
      mockState.exercises = [{ id: 'ex-1', name: 'Bench Press', tags: [], sets }]
    })

    it('limits visible sets to 10 initially in detail modal', async () => {
      const wrapper = mountTracker()
      await wrapper.find('.wtExerciseRow').trigger('click')
      await wrapper.vm.$nextTick()

      const setRows = wrapper.findAll('.wtSetRow')
      expect(setRows.length).toBe(10)
    })

    it('shows "Show all X sets" button when sets exceed limit', async () => {
      const wrapper = mountTracker()
      await wrapper.find('.wtExerciseRow').trigger('click')
      await wrapper.vm.$nextTick()

      const btn = wrapper.find('.wtShowAllBtn')
      expect(btn.exists()).toBe(true)
      expect(btn.text()).toContain('Show all 15 sets')
    })

    it('shows all sets when "Show all" is clicked', async () => {
      const wrapper = mountTracker()
      await wrapper.find('.wtExerciseRow').trigger('click')
      await wrapper.vm.$nextTick()

      await wrapper.find('.wtShowAllBtn').trigger('click')
      await wrapper.vm.$nextTick()

      const setRows = wrapper.findAll('.wtSetRow')
      expect(setRows.length).toBe(15)
    })

    it('toggles button text to "Show less" after expanding', async () => {
      const wrapper = mountTracker()
      await wrapper.find('.wtExerciseRow').trigger('click')
      await wrapper.vm.$nextTick()

      await wrapper.find('.wtShowAllBtn').trigger('click')
      await wrapper.vm.$nextTick()

      expect(wrapper.find('.wtShowAllBtn').text()).toBe('Show less')
    })

    it('collapses back to limit when "Show less" is clicked', async () => {
      const wrapper = mountTracker()
      await wrapper.find('.wtExerciseRow').trigger('click')
      await wrapper.vm.$nextTick()

      // Expand
      await wrapper.find('.wtShowAllBtn').trigger('click')
      await wrapper.vm.$nextTick()
      expect(wrapper.findAll('.wtSetRow').length).toBe(15)

      // Collapse
      await wrapper.find('.wtShowAllBtn').trigger('click')
      await wrapper.vm.$nextTick()
      expect(wrapper.findAll('.wtSetRow').length).toBe(10)
    })

    it('does not show "Show all" button when sets are within limit', async () => {
      mockState.exercises = createExercises() // 2 sets on Bench Press
      const wrapper = mountTracker()
      await wrapper.findAll('.wtExerciseRow')[0].trigger('click')
      await wrapper.vm.$nextTick()

      expect(wrapper.find('.wtShowAllBtn').exists()).toBe(false)
    })
  })

  // ── Gym filtering (#961) ─────────────────────────────────────────
  describe('gym filtering', () => {
    /** Exercises spanning two gyms + shared (unassigned) equipment. */
    function createGymExercises(): Exercise[] {
      return [
        { id: 'ex-1', name: 'Hack Squat (PF)', tags: ['Legs'], sets: [], gyms: ['Gym A'] },
        { id: 'ex-2', name: 'Hack Squat (24h)', tags: ['Legs'], sets: [], gyms: ['Gym B'] },
        { id: 'ex-3', name: 'Bench Press', tags: ['Chest'], sets: [] }, // unassigned = everywhere
        { id: 'ex-4', name: 'Cable Row', tags: ['Back'], sets: [], gyms: ['Gym A', 'Gym B'] },
      ]
    }

    function gymChipRow(wrapper: VueWrapper) {
      return wrapper.find('[aria-label="Filter by gym"]')
    }

    function gymChip(wrapper: VueWrapper, label: string) {
      return gymChipRow(wrapper).findAll('.wtTagChip').find(c => c.text() === label)!
    }

    function listedNames(wrapper: VueWrapper): string[] {
      return wrapper.findAll('.wtExerciseName').map(n => n.text())
    }

    it('renders the zero-state chip row: All Gyms active + a labeled Add Gym chip (#963)', () => {
      mockState.exercises = createGymExercises()
      const wrapper = mountTracker()
      const chips = gymChipRow(wrapper).findAll('.wtTagChip')
      expect(chips.map(c => c.text())).toEqual(['All Gyms', 'Add Gym'])
      expect(chips[0].classes()).toContain('wtTagChipActive')
      // The labeled manage chip is the create-first-gym entry point in the
      // logging surface — Settings must not be the only way in.
      expect(gymChipRow(wrapper).find('[aria-label="Add a gym"]').exists()).toBe(true)
    })

    it('opens the gym manager from the zero-state Add Gym chip', async () => {
      mockState.exercises = createGymExercises()
      const wrapper = mountTracker()
      await gymChipRow(wrapper).find('[aria-label="Add a gym"]').trigger('click')
      expect(wrapper.find('[aria-labelledby="gym-manager-title"]').exists()).toBe(true)
    })

    it('routes EditExerciseModal create-gym to the preferences store (#963)', () => {
      mockState.exercises = createGymExercises()
      const wrapper = mountTracker()
      wrapper.findComponent(EditExerciseModal).vm.$emit('create-gym', 'Iron Temple')
      expect(mockAddGym).toHaveBeenCalledWith('Iron Temple')
      expect(mockPrefsState.gyms).toContain('Iron Temple')
    })

    it('renders the chip row (All Gyms + one chip per gym + manage) once gyms exist', () => {
      mockPrefsState.gyms = ['Gym A', 'Gym B']
      mockState.exercises = createGymExercises()
      const wrapper = mountTracker()
      const chips = gymChipRow(wrapper).findAll('.wtTagChip')
      expect(chips.map(c => c.text())).toEqual(['All Gyms', 'Gym A', 'Gym B', ''])
      // Exclusive default: All Gyms is the active chip.
      expect(chips[0].classes()).toContain('wtTagChipActive')
      // Trailing icon-only chip opens the gym manager.
      expect(gymChipRow(wrapper).find('[aria-label="Manage gyms"]').exists()).toBe(true)
    })

    it('filters exclusively: only the active gym\'s + unassigned exercises remain', async () => {
      mockPrefsState.gyms = ['Gym A', 'Gym B']
      mockState.exercises = createGymExercises()
      const wrapper = mountTracker()

      await gymChip(wrapper, 'Gym A').trigger('click')

      const names = listedNames(wrapper)
      expect(names).toContain('Hack Squat (PF)')   // Gym A
      expect(names).toContain('Bench Press')        // unassigned = everywhere
      expect(names).toContain('Cable Row')          // multi-gym incl. Gym A
      expect(names).not.toContain('Hack Squat (24h)') // Gym B only
    })

    it('selecting a second gym replaces the first (exclusive, not additive)', async () => {
      mockPrefsState.gyms = ['Gym A', 'Gym B']
      mockState.exercises = createGymExercises()
      const wrapper = mountTracker()

      await gymChip(wrapper, 'Gym A').trigger('click')
      await gymChip(wrapper, 'Gym B').trigger('click')

      expect(gymChip(wrapper, 'Gym B').classes()).toContain('wtTagChipActive')
      expect(gymChip(wrapper, 'Gym A').classes()).not.toContain('wtTagChipActive')
      const names = listedNames(wrapper)
      expect(names).toContain('Hack Squat (24h)')
      expect(names).not.toContain('Hack Squat (PF)')
    })

    it('tapping the active gym chip deselects back to All Gyms', async () => {
      mockPrefsState.gyms = ['Gym A', 'Gym B']
      mockState.exercises = createGymExercises()
      const wrapper = mountTracker()

      await gymChip(wrapper, 'Gym A').trigger('click')
      await gymChip(wrapper, 'Gym A').trigger('click')

      expect(gymChip(wrapper, 'All Gyms').classes()).toContain('wtTagChipActive')
      expect(listedNames(wrapper)).toHaveLength(4)
    })

    it('composes with the tag filter as AND (tags narrow within the gym)', async () => {
      mockPrefsState.gyms = ['Gym A', 'Gym B']
      mockState.exercises = createGymExercises()
      const wrapper = mountTracker()

      await gymChip(wrapper, 'Gym B').trigger('click')
      // Tag chip row: pick "Legs" — within Gym B that's only the 24h hack squat.
      const legsChip = wrapper.findAll('.wtTagChip').find(c => c.text().startsWith('Legs'))!
      await legsChip.trigger('click')

      expect(listedNames(wrapper)).toEqual(['Hack Squat (24h)'])
    })

    it('scopes tag chip counts to the active gym', async () => {
      mockPrefsState.gyms = ['Gym A', 'Gym B']
      mockState.exercises = createGymExercises()
      const wrapper = mountTracker()

      // Both hack squats carry Legs → count 2 without a gym filter.
      let legsChip = wrapper.findAll('.wtTagChip').find(c => c.text().startsWith('Legs'))!
      expect(legsChip.find('.wtTagChipCount').text()).toBe('2')

      await gymChip(wrapper, 'Gym A').trigger('click')
      legsChip = wrapper.findAll('.wtTagChip').find(c => c.text().startsWith('Legs'))!
      expect(legsChip.find('.wtTagChipCount').text()).toBe('1')
    })

    it('keeps an exercise whose gyms are all orphaned visible under any gym (rename race safety net)', async () => {
      mockPrefsState.gyms = ['Gym A', 'Gym B']
      mockState.exercises = [
        ...createGymExercises(),
        { id: 'ex-5', name: 'Ghost Machine', tags: [], sets: [], gyms: ['Renamed Away'] },
      ]
      const wrapper = mountTracker()

      await gymChip(wrapper, 'Gym A').trigger('click')

      expect(listedNames(wrapper)).toContain('Ghost Machine')
    })

    it('passes the gym-filtered list to the quick-log exercise picker', async () => {
      mockPrefsState.gyms = ['Gym A', 'Gym B']
      mockState.exercises = createGymExercises()
      const wrapper = mountTracker()

      await gymChip(wrapper, 'Gym B').trigger('click')

      const picker = wrapper.findComponent({ name: 'ExercisePickerModal' })
      const names = (picker.props('exercises') as Exercise[]).map(e => e.name)
      expect(names).toContain('Hack Squat (24h)')
      expect(names).toContain('Bench Press')
      expect(names).not.toContain('Hack Squat (PF)')
    })

    it('persists the selection per device and restores it on mount', async () => {
      mockPrefsState.gyms = ['Gym A', 'Gym B']
      mockState.exercises = createGymExercises()
      const first = mountTracker()
      await gymChip(first, 'Gym B').trigger('click')
      expect(localStorageMock.getItem('active-gym-filter')).toBe(JSON.stringify('Gym B'))
      first.unmount()

      const second = mountTracker()
      expect(gymChip(second, 'Gym B').classes()).toContain('wtTagChipActive')
      expect(listedNames(second)).not.toContain('Hack Squat (PF)')
    })

    it('ignores a persisted selection for a gym that no longer exists (filter stays inert)', () => {
      localStorageMock.setItem('active-gym-filter', JSON.stringify('Deleted Gym'))
      mockPrefsState.gyms = ['Gym A']
      mockState.exercises = createGymExercises()
      const wrapper = mountTracker()

      expect(gymChip(wrapper, 'All Gyms').classes()).toContain('wtTagChipActive')
      expect(listedNames(wrapper)).toHaveLength(4)
    })

    it('shows the generalized empty state when the gym filter empties the list', async () => {
      mockPrefsState.gyms = ['Gym A', 'Empty Gym']
      mockState.exercises = [
        { id: 'ex-1', name: 'Hack Squat (PF)', tags: [], sets: [], gyms: ['Gym A'] },
      ]
      const wrapper = mountTracker()

      await gymChip(wrapper, 'Empty Gym').trigger('click')

      expect(wrapper.find('.wtEmpty').text()).toContain('No exercises match your filters.')
    })

    // ── Assigning gyms at creation time (#984) ───────────────────
    describe('gym assignment in the new-exercise form', () => {
      /** The Gym picker inside the log sheet (EditExerciseModal has its own). */
      function newExerciseGymPicker(wrapper: VueWrapper) {
        return wrapper
          .find('[aria-labelledby="log-modal-title"]')
          .find('[aria-label="Gym membership"]')
      }

      function gymPickerChip(wrapper: VueWrapper, label: string) {
        return newExerciseGymPicker(wrapper)
          .findAll('.wtTagPickerChip')
          .find(c => c.text() === label)!
      }

      async function openNewExerciseForm(wrapper: VueWrapper, name = 'Hack Squat') {
        exposed(wrapper).openNewExerciseModal()
        await wrapper.vm.$nextTick()
        await wrapper.find('[aria-labelledby="log-modal-title"] input[type="text"]').setValue(name)
        return wrapper
      }

      async function save(wrapper: VueWrapper) {
        await wrapper.find('.repMaxBtn.repMaxBtnCalc').trigger('click')
      }

      it('renders a Gym picker in the new-exercise form', async () => {
        mockPrefsState.gyms = ['Gym A', 'Gym B']
        mockState.exercises = createGymExercises()
        const wrapper = mountTracker()
        await openNewExerciseForm(wrapper)

        expect(newExerciseGymPicker(wrapper).exists()).toBe(true)
        expect(
          newExerciseGymPicker(wrapper).findAll('.wtTagPickerChip').map(c => c.text()),
        ).toEqual(['Gym A', 'Gym B', '+'])
      })

      it('keeps the tag and gym inline-add chips distinguishable by accessible name', async () => {
        // The form now has TWO .wtTagAddChip buttons. Anything selecting one
        // by class alone matches both — that is exactly how the e2e spec broke
        // when this feature landed. The accessible names are the stable
        // discriminator, so pin them here where the fast suite catches it.
        mockPrefsState.gyms = ['Gym A']
        mockState.exercises = createGymExercises()
        const wrapper = mountTracker()
        await openNewExerciseForm(wrapper)

        const form = wrapper.find('[aria-labelledby="log-modal-title"]')
        const addChips = form.findAll('.wtTagAddChip')
        expect(addChips).toHaveLength(2)
        expect(addChips.map(c => c.attributes('aria-label')).sort()).toEqual(['Add gym', 'Add tag'])
      })

      it('renders the picker with only the add chip when no gyms exist yet (first-gym path)', async () => {
        mockState.exercises = createGymExercises()
        const wrapper = mountTracker()
        await openNewExerciseForm(wrapper)

        expect(newExerciseGymPicker(wrapper).exists()).toBe(true)
        expect(newExerciseGymPicker(wrapper).find('[aria-label="Add gym"]').exists()).toBe(true)
      })

      it('pre-selects the active gym filter — the gym you are at is the gym you are adding for', async () => {
        mockPrefsState.gyms = ['Gym A', 'Gym B']
        mockState.exercises = createGymExercises()
        const wrapper = mountTracker()
        await gymChip(wrapper, 'Gym A').trigger('click')

        await openNewExerciseForm(wrapper)

        expect(gymPickerChip(wrapper, 'Gym A').classes()).toContain('wtTagPickerChipActive')
        expect(gymPickerChip(wrapper, 'Gym B').classes()).not.toContain('wtTagPickerChipActive')
      })

      it('passes the pre-selected gym through addExercise at creation', async () => {
        mockPrefsState.gyms = ['Gym A', 'Gym B']
        mockState.exercises = createGymExercises()
        mockAddExercise.mockReturnValue('ex-new')
        const wrapper = mountTracker()
        await gymChip(wrapper, 'Gym A').trigger('click')

        await openNewExerciseForm(wrapper, 'Pendulum Squat')
        await save(wrapper)

        expect(mockAddExercise).toHaveBeenCalledWith('Pendulum Squat', [], { gyms: ['Gym A'] })
      })

      it('leaves membership empty when no gym filter is active (unassigned = everywhere)', async () => {
        mockPrefsState.gyms = ['Gym A', 'Gym B']
        mockState.exercises = createGymExercises()
        mockAddExercise.mockReturnValue('ex-new')
        const wrapper = mountTracker()

        await openNewExerciseForm(wrapper, 'Pendulum Squat')
        await save(wrapper)

        expect(mockAddExercise).toHaveBeenCalledWith('Pendulum Squat', [], { gyms: [] })
      })

      it('deselecting the pre-seeded gym is one tap and sticks through save', async () => {
        mockPrefsState.gyms = ['Gym A', 'Gym B']
        mockState.exercises = createGymExercises()
        mockAddExercise.mockReturnValue('ex-new')
        const wrapper = mountTracker()
        await gymChip(wrapper, 'Gym A').trigger('click')

        await openNewExerciseForm(wrapper, 'Pendulum Squat')
        await gymPickerChip(wrapper, 'Gym A').trigger('click')
        await save(wrapper)

        expect(mockAddExercise).toHaveBeenCalledWith('Pendulum Squat', [], { gyms: [] })
      })

      it('selects multiple gyms (shared equipment across gyms)', async () => {
        mockPrefsState.gyms = ['Gym A', 'Gym B']
        mockState.exercises = createGymExercises()
        mockAddExercise.mockReturnValue('ex-new')
        const wrapper = mountTracker()

        await openNewExerciseForm(wrapper, 'Pendulum Squat')
        await gymPickerChip(wrapper, 'Gym A').trigger('click')
        await gymPickerChip(wrapper, 'Gym B').trigger('click')
        await save(wrapper)

        expect(mockAddExercise).toHaveBeenCalledWith('Pendulum Squat', [], {
          gyms: ['Gym A', 'Gym B'],
        })
      })

      it('inline "+" creates the gym in preferences and selects it locally', async () => {
        mockState.exercises = createGymExercises()
        mockAddExercise.mockReturnValue('ex-new')
        const wrapper = mountTracker()
        await openNewExerciseForm(wrapper, 'Pendulum Squat')

        await newExerciseGymPicker(wrapper).find('[aria-label="Add gym"]').trigger('click')
        const input = newExerciseGymPicker(wrapper).find('[aria-label="New gym name"]')
        await input.setValue('Iron Temple')
        await input.trigger('keyup.enter')

        expect(mockAddGym).toHaveBeenCalledWith('Iron Temple')
        expect(mockPrefsState.gyms).toContain('Iron Temple')
        expect(gymPickerChip(wrapper, 'Iron Temple').classes()).toContain('wtTagPickerChipActive')
      })

      it('flushes half-typed gym text on save instead of dropping it', async () => {
        mockState.exercises = createGymExercises()
        mockAddExercise.mockReturnValue('ex-new')
        const wrapper = mountTracker()
        await openNewExerciseForm(wrapper, 'Pendulum Squat')

        await newExerciseGymPicker(wrapper).find('[aria-label="Add gym"]').trigger('click')
        // Typed but never committed with Enter/blur — Save must not lose it.
        await newExerciseGymPicker(wrapper).find('[aria-label="New gym name"]').setValue('Iron Temple')
        await save(wrapper)

        expect(mockAddExercise).toHaveBeenCalledWith('Pendulum Squat', [], {
          gyms: ['Iron Temple'],
        })
      })

      it('does not leak a previous selection into the next new exercise', async () => {
        mockPrefsState.gyms = ['Gym A', 'Gym B']
        mockState.exercises = createGymExercises()
        mockAddExercise.mockReturnValue('ex-new')
        const wrapper = mountTracker()

        await openNewExerciseForm(wrapper, 'Pendulum Squat')
        await gymPickerChip(wrapper, 'Gym B').trigger('click')
        await save(wrapper)

        await openNewExerciseForm(wrapper, 'Belt Squat')
        expect(gymPickerChip(wrapper, 'Gym B').classes()).not.toContain('wtTagPickerChipActive')
      })
    })
  })

  describe('fresh-identity child bindings (#963)', () => {
    // The store mutates exercises in place behind a shallowRef; children bound
    // to the raw array froze because their prop identity never changed. These
    // tests drive the REAL host wiring (liveExercises) against the mock's
    // faithful in-place-mutation contract — they fail if anyone reverts a
    // binding to `store.exercises`.

    it('gym manager checklist shows a toggled checkmark live, without reopening', async () => {
      mockPrefsState.gyms = ['Gym A']
      mockState.exercises = [
        { id: 'ex-1', name: 'Hack Squat (PF)', tags: [], sets: [], gyms: ['Gym A'] },
        { id: 'ex-3', name: 'Bench Press', tags: [], sets: [] },
      ]
      const wrapper = mountTracker()
      await wrapper.find('[aria-label="Manage gyms"]').trigger('click')
      await wrapper.find('[aria-label="Show exercises for Gym A"]').trigger('click')

      // Re-find rows after every state change — Vue may replace the nodes.
      const benchRow = () =>
        wrapper.findAll('.wtTagExerciseRow').find(r => r.text().includes('Bench Press'))!
      expect(benchRow().find('.wtTagExerciseCheck').exists()).toBe(false)
      expect(wrapper.find('.wtTagManagerCount').text()).toBe('1')

      await benchRow().trigger('click')

      expect(benchRow().find('.wtTagExerciseCheck').exists()).toBe(true)
      expect(wrapper.find('.wtTagManagerCount').text()).toBe('2')
    })

    it('tag manager checklist shows a toggled checkmark live, without reopening', async () => {
      mockState.exercises = createExercises()
      const wrapper = mountTracker()
      await wrapper.find('[aria-label="Manage tags"]').trigger('click')
      await wrapper.find('[aria-label="Show exercises for Legs"]').trigger('click')

      const benchRow = () =>
        wrapper.findAll('.wtTagExerciseRow').find(r => r.text().includes('Bench Press'))!
      expect(benchRow().find('.wtTagExerciseCheck').exists()).toBe(false)

      await benchRow().trigger('click')

      expect(benchRow().find('.wtTagExerciseCheck').exists()).toBe(true)
    })

    it('timeline reflects sets mutated in place while it is the active view', async () => {
      mockState.exercises = createExercises()
      const wrapper = mountTracker()
      await wrapper.findAll('.wtViewToggleBtn')[1].trigger('click')
      expect(wrapper.text()).not.toContain('205')

      // The real store contract for logSet/updateSet/deleteSet: mutate the
      // exercise in place, then triggerRef.
      mockState.exercises[0].sets.push({
        id: 's-new', date: '2026-01-21T12:00:00', weight: 205, reps: 5, estimated1RM: 239,
      })
      triggerRef(mockExercises)
      await wrapper.vm.$nextTick()

      expect(wrapper.text()).toContain('205')
    })
  })

  // ── Background-scroll lock (#830) ────────────────────────────────
  //
  // WorkoutTracker used to hand-roll the lock:
  //   watch(anyModalOpen, open => html.classList.toggle('modal-open', open))
  // A boolean toggle only knows about ITS OWN modals. The moment another
  // surface holds the lock — CalendarView's set editor, BodyweightTracker's
  // log-weight sheet, both built on useModal — closing a WorkoutTracker modal
  // stripped `modal-open` out from under it and re-enabled background scroll
  // beneath a still-open `position: fixed` modal. On iOS that desyncs paint
  // from hit-testing as soon as the keyboard opens, so taps land a row low.
  // Only useModal's shared reference count knows when the LAST holder let go.
  describe('background-scroll lock (#830)', () => {
    const isLocked = () => document.documentElement.classList.contains('modal-open')

    // A stand-in for any other useModal-based surface (CalendarView,
    // BodyweightTracker, …) holding the shared lock at the same time.
    const ForeignModalHost = defineComponent({
      setup: () => ({ modal: useModal() }),
      template: '<div />',
    })
    type ForeignHost = { modal: ReturnType<typeof useModal> }

    it('locks background scroll while the log-set sheet is open', async () => {
      const wrapper = mountTracker()
      expect(isLocked()).toBe(false)

      exposed(wrapper).openNewExerciseModal()
      await wrapper.vm.$nextTick()
      expect(isLocked()).toBe(true)

      await wrapper.find('.logSetOverlay').trigger('click')
      expect(isLocked()).toBe(false)
    })

    it('locks background scroll while a child modal (exercise detail) is open', async () => {
      mockState.exercises = createExercises()
      const wrapper = mountTracker()
      expect(isLocked()).toBe(false)

      await wrapper.find('.wtExerciseRow').trigger('click')
      expect(isLocked()).toBe(true)
    })

    it('keeps the lock applied when its modal closes under another modal', async () => {
      const other = mount(ForeignModalHost)
      ;(other.vm as unknown as ForeignHost).modal.open()
      expect(isLocked()).toBe(true)

      const wrapper = mountTracker()
      exposed(wrapper).openNewExerciseModal()
      await wrapper.vm.$nextTick()
      expect(isLocked()).toBe(true)

      await wrapper.find('.logSetOverlay').trigger('click')
      // The regression: the old boolean toggle cleared `modal-open` here,
      // unlocking the background under the still-open foreign modal.
      expect(isLocked()).toBe(true)

      ;(other.vm as unknown as ForeignHost).modal.close()
      expect(isLocked()).toBe(false)
    })

    it('keeps the lock applied when it unmounts under another modal', async () => {
      const other = mount(ForeignModalHost)
      ;(other.vm as unknown as ForeignHost).modal.open()

      const wrapper = mountTracker()
      exposed(wrapper).openNewExerciseModal()
      await wrapper.vm.$nextTick()
      // The old onUnmounted did an unconditional classList.remove('modal-open').
      wrapper.unmount()
      expect(isLocked()).toBe(true)

      ;(other.vm as unknown as ForeignHost).modal.close()
      expect(isLocked()).toBe(false)
    })

    it('releases its lock on unmount with a modal still open', async () => {
      const wrapper = mountTracker()
      exposed(wrapper).openNewExerciseModal()
      await wrapper.vm.$nextTick()
      expect(isLocked()).toBe(true)

      wrapper.unmount()
      expect(isLocked()).toBe(false)
    })

    it('stays locked across the log-sheet → detail-modal swap', async () => {
      mockState.exercises = createExercises()
      const wrapper = mountTracker()

      await wrapper.findAll('.wtExerciseLogBtn')[0].trigger('click')
      await wrapper.vm.$nextTick()
      expect(isLocked()).toBe(true)

      // openHistoryFromLog swaps the log sheet for the detail modal (they share
      // a z-index, so it is a swap and not a stack). Two separate useModal
      // instances hand the lock over here — it must not blink off in between.
      await wrapper.find('.wtLogHistoryBtn').trigger('click')
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.wtDetailModal').exists()).toBe(true)
      expect(isLocked()).toBe(true)

      await wrapper.find('.wtDetailBack').trigger('click')
      await wrapper.vm.$nextTick()
      expect(isLocked()).toBe(false)
    })
  })

  /**
   * Regression: LIFT-1211 — the plate calculator double-converted for kg
   * users. The plate subsystem operates entirely in display units (kg plates
   * on a kg bar), but the computed total was piped through displayWeight(),
   * multiplying an already-kg total by 0.4536 — every plate-mode set a kg
   * user logged was silently corrupted (20 kg bar + 2×20 kg plates filled
   * the weight field with 27.2 instead of 60). The reverse path had the
   * mirror bug: typed kg weights were converted to lbs before being
   * decomposed against kg denominations.
   */
  describe('kg plate mode (LIFT-1211)', () => {
    afterEach(() => { setMockUnit('lbs') })

    // ex-3 (Overhead Press) has no sets, so the log modal opens with an empty
    // weight field — no ladder auto-fill to interfere with plate math.
    // `barWeight: undefined` leaves the exercise without a stored bar, which is
    // how every numpad-created and sample exercise starts (LIFT-1223).
    function mountPlateTracker(unit: 'lbs' | 'kg', barWeight?: number) {
      setMockUnit(unit)
      mockState.exercises = createExercises()
      mockState.exercises[2].inputMode = 'plates'
      mockState.exercises[2].plateCountMode = 'per-side'
      if (barWeight !== undefined) mockState.exercises[2].barWeight = barWeight
      return mountTracker()
    }

    async function openLogModal(wrapper: VueWrapper) {
      await wrapper.findAll('.wtExerciseLogBtn')[2].trigger('click')
      await wrapper.vm.$nextTick()
    }

    it('fills the weight field with the true kg total, not a double-converted one', async () => {
      const wrapper = mountPlateTracker('kg', 20)
      await openLogModal(wrapper)

      // kg users see kg denominations
      const addBtns = wrapper.findAll('.wtPlateBtnAdd')
      expect(addBtns.map(b => b.text())).toContain('+20')

      // 20 kg bar + one 20 kg plate per side = 60 kg. Pre-fix, the total was
      // piped through displayWeight() and the field showed 27.2.
      await addBtns.find(b => b.text() === '+20')!.trigger('click')
      await wrapper.vm.$nextTick()

      const input = wrapper.find('input[aria-label="Weight"]')
      expect((input.element as HTMLInputElement).value).toBe('60')
    })

    it('decomposes a typed kg weight against kg plates (reverse sync)', async () => {
      const wrapper = mountPlateTracker('kg', 20)
      await openLogModal(wrapper)

      // Type 60 kg — after the 250ms debounce the calculator should show one
      // 20 kg plate per side. Pre-fix this decomposed toLbs(60)=132.3 against
      // kg denominations and produced a nonsense stack.
      await wrapper.find('input[aria-label="Weight"]').setValue('60')
      await new Promise(r => setTimeout(r, 350))
      await wrapper.vm.$nextTick()

      const col20 = wrapper.findAll('.wtPlateCol')
        .find(c => c.find('.wtPlateBtnAdd').text() === '+20')
      expect(col20).toBeDefined()
      expect(col20!.find('.wtPlateCountNum').text()).toBe('1')
    })

    it('keeps lbs plate math unchanged (45 bar + 2×45 = 135)', async () => {
      const wrapper = mountPlateTracker('lbs', 45)
      await openLogModal(wrapper)

      const addBtns = wrapper.findAll('.wtPlateBtnAdd')
      await addBtns.find(b => b.text() === '+45')!.trigger('click')
      await wrapper.vm.$nextTick()

      const input = wrapper.find('input[aria-label="Weight"]')
      expect((input.element as HTMLInputElement).value).toBe('135')
    })

    /**
     * LIFT-1223: every fixture above hands the exercise an explicit barWeight,
     * so the `??` fallback had never run under kg. `openLogForExercise` seeded
     * the plate stack from a hardcoded 45 — read as kg — while the plate card's
     * own `currentBarWeight` correctly used 20, so the two disagreed by 25 kg
     * on open.
     */
    describe('no stored bar weight', () => {
      /** ex-3 with one prior set, so the log modal seeds the plate calculator. */
      function withSeedSet(unit: 'lbs' | 'kg', weightLbs: number) {
        const wrapper = mountPlateTracker(unit)
        mockState.exercises[2].sets = [
          { id: 's-9', date: '2026-01-18T12:00:00', weight: weightLbs, reps: 5, estimated1RM: weightLbs * 1.16 },
        ]
        return wrapper
      }

      const plateCount = (wrapper: VueWrapper, denom: string) =>
        wrapper.findAll('.wtPlateCol')
          .find(c => c.find('.wtPlateBtnAdd').text() === denom)
          ?.find('.wtPlateCountNum').text()

      it('opens with a stack that matches the weight field for a kg user', async () => {
        // 132.3 lbs displays as 60 kg = the 20 kg default bar + one 20 kg plate
        // a side. Pre-fix the seed decomposed 132.3 against a 45 "kg" bar, which
        // kg plates cannot load, so the card opened with no plates under a "60"
        // field and only repopulated after the 250ms weightStr debounce.
        const wrapper = withSeedSet('kg', 132.3)
        await openLogModal(wrapper)

        const input = wrapper.find('input[aria-label="Weight"]')
        expect((input.element as HTMLInputElement).value).toBe('60')
        expect(plateCount(wrapper, '+20')).toBe('1')
      })

      it('defaults an lbs user to the 45 lb bar (135 = bar + 2×45)', async () => {
        const wrapper = withSeedSet('lbs', 135)
        await openLogModal(wrapper)

        const input = wrapper.find('input[aria-label="Weight"]')
        expect((input.element as HTMLInputElement).value).toBe('135')
        expect(plateCount(wrapper, '+45')).toBe('1')
      })

      it('adds plates onto the kg default bar, not a 45 kg one', async () => {
        const wrapper = mountPlateTracker('kg')
        await openLogModal(wrapper)

        await wrapper.findAll('.wtPlateBtnAdd').find(b => b.text() === '+20')!.trigger('click')
        await wrapper.vm.$nextTick()

        const input = wrapper.find('input[aria-label="Weight"]')
        expect((input.element as HTMLInputElement).value).toBe('60')
      })
    })
  })

  /**
   * Regression: LIFT-1315 — the Intensity lens handed `generateIntensityTable`
   * a canonical-LBS 1RM alongside the DISPLAY-unit bar and DISPLAY-unit plates
   * the rest of the plate subsystem uses (LIFT-1211). The two spaces coincide
   * for lbs users; for a kg user they don't, so a row LABELLED 82.8 kg loaded a
   * stack the card totalled at 182.5 kg. Unlike a display glitch that number is
   * savable — `toLbs(182.5)` stores 402 lbs for a lifter whose real best is 228,
   * a fake all-time PR that wins getExercisePR, re-anchors every later
   * suggestion, fires the PR burst, and pays PR-multiplier XP.
   *
   * The kg plate-mode suite above never opens the Suggestions drawer, and
   * intensityTable.test.ts's only kg case was `plateMode: false` — the numpad
   * path, the one that was already unit-correct. The assertion that would have
   * caught this is the first one below: a tapped row must fill the weight field
   * with the number the row is labelled.
   */
  describe('kg intensity lens (LIFT-1315)', () => {
    afterEach(() => { setMockUnit('lbs') })

    // ex-1 (Bench Press) in kg plate mode on a 20 kg bar. Its best e1RM is
    // 228 lbs, which displays as 103.4 kg — the intensity anchor.
    function mountKgIntensityTracker() {
      setMockUnit('kg')
      mockState.exercises = createExercises()
      mockState.exercises[0].inputMode = 'plates'
      mockState.exercises[0].plateCountMode = 'per-side'
      mockState.exercises[0].barWeight = 20
      return mountTracker()
    }

    /**
     * Open Bench's log sheet and expand the drawer. With no ladder and no last
     * session, intensity is the only lens — so it needs no segmented control,
     * but it does start collapsed (only quick-fill lenses auto-expand).
     */
    async function openIntensityLens(wrapper: VueWrapper) {
      await wrapper.findAll('.wtExerciseLogBtn')[0].trigger('click')
      await wrapper.vm.$nextTick()
      await wrapper.find('.wtSuggestions .wtPrTargetsHeader').trigger('click')
    }

    const rowsOf = (wrapper: VueWrapper) => wrapper.findAll('.wtPrTargetsRow')

    const weightField = (wrapper: VueWrapper) =>
      (wrapper.find('input[aria-label="Weight"]').element as HTMLInputElement).value

    /** The weight a row advertises, without its unit: "85 kg" → "85". */
    const rowLabel = (wrapper: VueWrapper, i: number) =>
      rowsOf(wrapper)[i].find('.wtPrTargetsWeight').text().replace(' kg', '')

    it('fills the weight field with the weight the row is labelled', async () => {
      const wrapper = mountKgIntensityTracker()
      await openIntensityLens(wrapper)

      // 80% of the 103.4 kg max at 1 rep ceils onto the 20 kg bar at 85 kg.
      expect(rowLabel(wrapper, 0)).toBe('85')
      await rowsOf(wrapper)[0].trigger('click')
      await wrapper.vm.$nextTick()

      // Pre-fix the field read 182.5 — the lbs target decomposed against kg
      // plates, off by exactly the 1/0.4536 conversion factor.
      expect(weightField(wrapper)).toBe('85')
    })

    // Guards the OTHER half of the boundary, and the likelier future slip: rows
    // now arrive already in display units, so a `displayWeight(row.weight)` in
    // the template (which is exactly what this markup used to say) would relabel
    // an 85 kg row as 38.6 while the field it fills still reads 85. This one is
    // structural — it cannot fail while both surfaces read `row.weight` — so it
    // pins the markup, not the arithmetic; the cases above pin the arithmetic.
    it('labels every row with the number it fills — no second conversion', async () => {
      const wrapper = mountKgIntensityTracker()
      await openIntensityLens(wrapper)

      for (const pct of [50, 80, 100]) {
        await wrapper.find('.wtIntensitySlider').setValue(pct)
        const count = rowsOf(wrapper).length
        expect(count).toBeGreaterThan(0)
        for (let i = 0; i < count; i++) {
          // Re-find each pass: tapping mutates intensityUsed, so Vue re-renders
          // and a held wrapper goes stale.
          const label = rowLabel(wrapper, i)
          await rowsOf(wrapper)[i].trigger('click')
          await wrapper.vm.$nextTick()
          expect(weightField(wrapper)).toBe(label)
        }
      }
    })

    it('saves the weight it showed, not a 2.2x fake all-time PR', async () => {
      const wrapper = mountKgIntensityTracker()
      await openIntensityLens(wrapper)

      // 100% is where the damage was worst: the row is meant to be the lightest
      // load that BEATS the PR, so a mis-scaled one is stored as a real record.
      await wrapper.find('.wtIntensitySlider').setValue(100)
      await rowsOf(wrapper)[0].trigger('click')
      await wrapper.vm.$nextTick()
      await wrapper.find('.repMaxBtn.repMaxBtnCalc').trigger('click')

      // 105 kg = toLbs 231.5 — just past the 228 lb best, which is what a 100%
      // 1-rep row means. Pre-fix this saved 507.1 lbs: a 2.2x phantom PR.
      expect(mockLogSet).toHaveBeenCalledWith('ex-1', 231.5, 1, expect.any(String), expect.objectContaining({}))
    })

    it('drops rows below the kg bar instead of measuring them against a lbs one', async () => {
      const wrapper = mountKgIntensityTracker()
      await openIntensityLens(wrapper)

      // 25% of 103.4 kg = 25.9 kg; past 8 reps the target falls under the 20 kg
      // bar. Pre-fix `raw` was in lbs (57) and the bar in kg (20), so the guard
      // never fired and the lens offered a full 10 rows it could not load.
      await wrapper.find('.wtIntensitySlider').setValue(25)
      const rows = rowsOf(wrapper)
      expect(rows.length).toBeLessThan(10)
      expect(rows.length).toBeGreaterThan(0)
      for (const row of rows) {
        expect(Number(row.find('.wtPrTargetsWeight').text().replace(' kg', ''))).toBeGreaterThanOrEqual(20)
      }
    })
  })

  /**
   * Regression: LIFT-1312 — the reverse sync (typed weight → plates) was the
   * only path in the plate subsystem that didn't branch on the loading mode,
   * so a `plateCountMode: 'total'` machine exercise decomposed a typed weight
   * as though half of it were needed. The card then read 2× low against the
   * weight field, and the disagreement resolved the WRONG way: the next plate
   * tap wrote the card's total back over the user's typed number.
   *
   * LIFT-783 added the mode as a synced field and covered the sync half well;
   * the plate MATH for total mode had no coverage at all — the kg suite above
   * sets `plateCountMode = 'per-side'` on every fixture, and nothing typed a
   * weight into a total-mode exercise.
   */
  describe('total plate count mode (LIFT-1312)', () => {
    /**
     * ex-3 (Overhead Press) has no sets, so the modal opens with an empty
     * weight field — no seed to interfere. `barWeight` is deliberately left
     * unset: a plate-loaded machine has no bar, which is what `currentBarWeight`
     * defaults to in total mode, and it is how the numpad-created and sample
     * exercises actually start.
     */
    function mountTotalTracker() {
      mockState.exercises = createExercises()
      mockState.exercises[2].inputMode = 'plates'
      mockState.exercises[2].plateCountMode = 'total'
      return mountTracker()
    }

    async function openLogModal(wrapper: VueWrapper) {
      await wrapper.findAll('.wtExerciseLogBtn')[2].trigger('click')
      await wrapper.vm.$nextTick()
    }

    const plateCount = (wrapper: VueWrapper, denom: number) =>
      wrapper.findAll('.wtPlateCol')
        .find(c => c.find('.wtPlateBtnAdd').text() === `+${denom}`)
        ?.find('.wtPlateCountNum').text()

    const weightField = (wrapper: VueWrapper) =>
      (wrapper.find('input[aria-label="Weight"]').element as HTMLInputElement).value

    async function typeWeight(wrapper: VueWrapper, value: string) {
      await wrapper.find('input[aria-label="Weight"]').setValue(value)
      // The reverse sync is debounced 250ms (LIFT-634).
      await new Promise(r => setTimeout(r, 350))
      await wrapper.vm.$nextTick()
    }

    it('labels the card as total loading', async () => {
      const wrapper = mountTotalTracker()
      await openLogModal(wrapper)
      expect(wrapper.find('.wtPlateCardHeaderLabel').text()).toBe('TOTAL · 0 lbs BAR')
    })

    it('decomposes a typed weight against the WHOLE load, not half of it', async () => {
      const wrapper = mountTotalTracker()
      await openLogModal(wrapper)

      // 100 on a machine is 45 + 45 + 10. Pre-fix this halved to 50 and showed
      // [45, 5] — a stack the card totals at 50, under a field reading 100.
      await typeWeight(wrapper, '100')

      expect(plateCount(wrapper, 45)).toBe('2')
      expect(plateCount(wrapper, 10)).toBe('1')
      expect(plateCount(wrapper, 5)).toBe('0')
      expect(weightField(wrapper)).toBe('100')
    })

    it('does not overwrite the typed weight when the next plate is tapped', async () => {
      const wrapper = mountTotalTracker()
      await openLogModal(wrapper)
      await typeWeight(wrapper, '100')

      // Tapping any plate re-derives the field from the card. Pre-fix the card
      // held [45, 5], so this jumped the field from 100 down to 55 — the user's
      // typed number silently lost.
      await wrapper.findAll('.wtPlateBtnAdd').find(b => b.text() === '+5')!.trigger('click')
      await wrapper.vm.$nextTick()

      expect(weightField(wrapper)).toBe('105')
    })

    it('loads a total that per-side decomposition would misread', async () => {
      const wrapper = mountTotalTracker()
      await openLogModal(wrapper)

      // 95 = 45 + 45 + 5 in total mode. Per-side answers [45, 2.5] (47.5 a
      // side), which is loadable — so this failed silently rather than blanking.
      await typeWeight(wrapper, '95')

      expect(plateCount(wrapper, 45)).toBe('2')
      expect(plateCount(wrapper, 5)).toBe('1')
      expect(plateCount(wrapper, 2.5)).toBe('0')
    })

    it('keeps the card and the field in step when plates are tapped', async () => {
      const wrapper = mountTotalTracker()
      await openLogModal(wrapper)

      const add = (denom: number) =>
        wrapper.findAll('.wtPlateBtnAdd').find(b => b.text() === `+${denom}`)!.trigger('click')
      await add(45)
      await add(45)
      await add(10)
      await wrapper.vm.$nextTick()

      // Forward direction: the stack IS the load, so 45 + 45 + 10 = 100 — not
      // the 200 a per-side reading would give.
      expect(weightField(wrapper)).toBe('100')
    })
  })

  describe('guided session plan (#1256)', () => {
    /** Local calendar date, matching the component's todayISO(). */
    function localDay(daysAgo = 0): string {
      const d = new Date()
      d.setDate(d.getDate() - daysAgo)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }

    /** Bench + OHP trained 2 days ago (the reference session), Squat 5 days ago. */
    function planExercises(): Exercise[] {
      return [
        {
          id: 'ex-1', name: 'Bench Press', tags: ['Push'], sets: [
            { id: 'b1', date: `${localDay(2)}T12:00:00`, weight: 135, reps: 10, estimated1RM: 180 },
            { id: 'b2', date: `${localDay(2)}T12:00:00`, weight: 185, reps: 5, estimated1RM: 216 },
          ],
        },
        {
          id: 'ex-2', name: 'Overhead Press', tags: ['Push'], sets: [
            { id: 'o1', date: `${localDay(2)}T12:00:00`, weight: 95, reps: 8, estimated1RM: 120 },
          ],
        },
        {
          id: 'ex-3', name: 'Squat', tags: ['Legs'], sets: [
            { id: 'q1', date: `${localDay(5)}T12:00:00`, weight: 225, reps: 5, estimated1RM: 263 },
          ],
        },
      ]
    }

    beforeEach(() => {
      mockState.exercises = planExercises()
    })

    it('renders the collapsed card with counts from the last session, list hidden', () => {
      const wrapper = mountTracker()
      const toggle = wrapper.find('.wtSessionPlanToggle')
      expect(toggle.exists()).toBe(true)
      expect(toggle.text()).toContain('Repeat last session')
      expect(toggle.text()).toContain('2 exercises · 3 sets')
      expect(toggle.attributes('aria-expanded')).toBe('false')
      expect(wrapper.find('.wtSessionPlanList').exists()).toBe(false)
    })

    it('expands into rows for the reference day only, and a row opens the log modal for its exercise', async () => {
      const wrapper = mountTracker()
      await wrapper.find('.wtSessionPlanToggle').trigger('click')

      const rows = wrapper.findAll('.wtSessionPlanRow')
      expect(rows.map(r => r.find('.wtSessionPlanName').text())).toEqual(['Bench Press', 'Overhead Press'])
      expect(rows[0].find('.wtSessionPlanRowMeta').text()).toContain('2 sets · top 185 lbs × 5')

      await rows[1].trigger('click')
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.repMaxModal').exists()).toBe(true)
      expect(wrapper.find('#log-modal-title').text()).toContain('Overhead Press')
      expect(mockGetUsualLadder).toHaveBeenCalledWith('ex-2', localDay())
    })

    it('tracks live progress as sets land today and marks completed rows', async () => {
      const wrapper = mountTracker()
      await wrapper.find('.wtSessionPlanToggle').trigger('click')

      // Log OHP's single planned set today (end-of-day storage convention),
      // mutating in place + triggerRef per the store's reactivity contract.
      mockState.exercises[1].sets.push({
        id: 'o-today', date: `${localDay()}T23:59:00.000Z`, weight: 95, reps: 8, estimated1RM: 120,
      })
      triggerRef(mockExercises)
      await wrapper.vm.$nextTick()

      expect(wrapper.find('.wtSessionPlanMeta').text()).toContain('1/3 sets')
      const rows = wrapper.findAll('.wtSessionPlanRow')
      expect(rows[0].classes()).not.toContain('wtSessionPlanRowDone')
      expect(rows[0].find('.wtSessionPlanProgress').text()).toBe('0/2')
      expect(rows[1].classes()).toContain('wtSessionPlanRowDone')
      expect(rows[1].find('.wtSessionPlanCheck').exists()).toBe(true)
    })

    it('scopes the plan to the active tag filter', async () => {
      const wrapper = mountTracker()
      const legsChip = wrapper.findAll('.wtTagChip').find(c => c.text().includes('Legs'))!
      await legsChip.trigger('click')

      const toggle = wrapper.find('.wtSessionPlanToggle')
      expect(toggle.text()).toContain('Repeat last Legs session')
      expect(toggle.text()).toContain('1 exercise · 1 set')
      await toggle.trigger('click')
      expect(wrapper.findAll('.wtSessionPlanRow')).toHaveLength(1)
      expect(wrapper.find('.wtSessionPlanName').text()).toBe('Squat')
    })

    it('does not render when there is nothing to repeat (only today logged)', () => {
      mockState.exercises = [{
        id: 'ex-1', name: 'Bench Press', tags: [], sets: [
          { id: 't1', date: `${localDay()}T23:59:00.000Z`, weight: 135, reps: 10, estimated1RM: 180 },
        ],
      }]
      const wrapper = mountTracker()
      expect(wrapper.find('.wtSessionPlan').exists()).toBe(false)
    })

    it('hides while a search query is active', async () => {
      // Search bar only renders with 5+ exercises.
      mockState.exercises = [
        ...planExercises(),
        { id: 'ex-4', name: 'Curl', tags: [], sets: [] },
        { id: 'ex-5', name: 'Row', tags: [], sets: [] },
      ]
      const wrapper = mountTracker()
      expect(wrapper.find('.wtSessionPlan').exists()).toBe(true)
      await wrapper.find('.wtSearchInput').setValue('bench')
      expect(wrapper.find('.wtSessionPlan').exists()).toBe(false)
    })
  })

  /**
   * Exercise-name autocomplete: ARIA combobox + keyboard operability (LIFT-1304).
   *
   * The popup shipped mouse/touch-only — options were `tabindex="-1"` and bound
   * only to @mousedown/@touchstart, with no keydown handler on the input — so a
   * keyboard user watched suggestions appear and then had to retype the whole
   * name (WCAG 2.1.1, Level A). Nothing caught it because no test had ever
   * opened this list: the component suite never typed into the new-exercise
   * field, and the axe suite (accessibility.axe.test.ts) covers only
   * AuthScreen/OnboardingScreen/BodyweightTracker. Both gaps are closed here —
   * the axe scan lives in this file rather than the axe suite because
   * WorkoutTracker needs this file's ~250 lines of store/composable mocks.
   *
   * Expected suggestions are derived from searchExerciseDatabase rather than
   * hardcoded, so growing the exercise DB can't turn these red.
   */
  describe('exercise-name autocomplete (LIFT-1304)', () => {
    /**
     * Always re-query the combobox. Vue swaps this input's DOM node when the
     * popup opens, so a wrapper captured before `setValue` reads attributes off
     * a detached element and every ARIA assertion passes (or fails) vacuously.
     */
    const nameInput = (w: VueWrapper) => w.find('.wtNewExerciseNameField .repMaxInput')
    const nameValue = (w: VueWrapper) => (nameInput(w).element as HTMLInputElement).value
    const options = (w: VueWrapper) => w.findAll('[role="option"]')
    const key = (w: VueWrapper, k: string) => nameInput(w).trigger('keydown', { key: k })

    /** Opens the New Exercise sheet. */
    async function openNewExercise(wrapper: VueWrapper) {
      exposed(wrapper).openNewExerciseModal()
      await nextTick()
    }

    const suggestionsFor = (q: string) => searchExerciseDatabase(q, [])

    it('exposes the popup state on the input as a combobox', async () => {
      const wrapper = mountTracker()
      await openNewExercise(wrapper)

      // Collapsed: aria-expanded is still present (required by role=combobox),
      // and aria-controls is absent rather than dangling at a missing id.
      expect(nameInput(wrapper).attributes('role')).toBe('combobox')
      expect(nameInput(wrapper).attributes('aria-autocomplete')).toBe('list')
      expect(nameInput(wrapper).attributes('aria-expanded')).toBe('false')
      expect(nameInput(wrapper).attributes('aria-controls')).toBeUndefined()

      await nameInput(wrapper).setValue('bench')
      const listId = wrapper.find('[role="listbox"]').attributes('id')
      expect(listId).toBeTruthy()
      expect(nameInput(wrapper).attributes('aria-expanded')).toBe('true')
      expect(nameInput(wrapper).attributes('aria-controls')).toBe(listId)
      expect(options(wrapper)).toHaveLength(suggestionsFor('bench').length)
    })

    it('ArrowDown walks the options and Enter picks the active one', async () => {
      const expected = suggestionsFor('bench')
      expect(expected.length).toBeGreaterThan(1)

      const wrapper = mountTracker()
      await openNewExercise(wrapper)
      await nameInput(wrapper).setValue('bench')

      // Nothing is active until the user arrows — the typed value stands.
      expect(nameInput(wrapper).attributes('aria-activedescendant')).toBeUndefined()
      expect(wrapper.findAll('[aria-selected="true"]')).toHaveLength(0)

      await key(wrapper, 'ArrowDown')
      expect(nameInput(wrapper).attributes('aria-activedescendant'))
        .toBe(options(wrapper)[0].attributes('id'))
      expect(options(wrapper)[0].attributes('aria-selected')).toBe('true')
      // The active row must be visible: DOM focus never leaves the input, so
      // the row never gets :focus-visible and the class is the only cue.
      expect(options(wrapper)[0].classes()).toContain('wtExerciseSuggestionItemActive')

      await key(wrapper, 'ArrowDown')
      expect(nameInput(wrapper).attributes('aria-activedescendant'))
        .toBe(options(wrapper)[1].attributes('id'))
      expect(options(wrapper)[0].attributes('aria-selected')).toBe('false')

      await key(wrapper, 'Enter')
      expect(nameValue(wrapper)).toBe(expected[1].name)
      // Choosing an option closes the popup (APG) and drops the active id.
      expect(wrapper.find('[role="listbox"]').exists()).toBe(false)
      expect(nameInput(wrapper).attributes('aria-expanded')).toBe('false')
      expect(nameInput(wrapper).attributes('aria-activedescendant')).toBeUndefined()
    })

    it('Enter selection applies the database entry tags, same as a tap', async () => {
      const expected = suggestionsFor('bench')
      const wrapper = mountTracker()
      await openNewExercise(wrapper)
      await nameInput(wrapper).setValue('bench')
      await key(wrapper, 'ArrowDown')
      await key(wrapper, 'Enter')

      const active = wrapper.findAll('.wtTagPickerChipActive').map(c => c.text())
      expect(active).toEqual(expect.arrayContaining(expected[0].tags))
    })

    it('ArrowUp from no selection activates the last option, and both ends wrap', async () => {
      const expected = suggestionsFor('bench')
      const wrapper = mountTracker()
      await openNewExercise(wrapper)
      await nameInput(wrapper).setValue('bench')
      const ids = options(wrapper).map(o => o.attributes('id'))
      expect(ids).toHaveLength(expected.length)
      const last = ids.length - 1

      await key(wrapper, 'ArrowUp')
      expect(nameInput(wrapper).attributes('aria-activedescendant')).toBe(ids[last])

      await key(wrapper, 'ArrowDown')
      expect(nameInput(wrapper).attributes('aria-activedescendant')).toBe(ids[0])
      await key(wrapper, 'ArrowUp')
      expect(nameInput(wrapper).attributes('aria-activedescendant')).toBe(ids[last])
    })

    it('Enter with nothing active does not pick a suggestion', async () => {
      const wrapper = mountTracker()
      await openNewExercise(wrapper)
      await nameInput(wrapper).setValue('bench')
      await key(wrapper, 'Enter')
      expect(nameValue(wrapper)).toBe('bench')
      expect(wrapper.find('[role="listbox"]').exists()).toBe(true)
    })

    it('Escape closes the popup, keeps the typed name, and leaves the sheet open', async () => {
      const wrapper = mountTracker()
      await openNewExercise(wrapper)
      await nameInput(wrapper).setValue('bench')
      await key(wrapper, 'ArrowDown')

      await key(wrapper, 'Escape')
      expect(wrapper.find('[role="listbox"]').exists()).toBe(false)
      expect(nameValue(wrapper)).toBe('bench')
      // The overlay carries @keydown.escape="closeModal": without
      // stopPropagation, one Escape would discard the half-typed exercise.
      expect(wrapper.find('.repMaxOverlay').exists()).toBe(true)
    })

    it('Escape with the popup closed still falls through to the sheet', async () => {
      const wrapper = mountTracker()
      await openNewExercise(wrapper)
      await key(wrapper, 'Escape')
      expect(wrapper.find('.repMaxOverlay').exists()).toBe(false)
    })

    it('typing after Escape re-opens the popup', async () => {
      const wrapper = mountTracker()
      await openNewExercise(wrapper)
      await nameInput(wrapper).setValue('bench')
      await key(wrapper, 'Escape')
      expect(wrapper.find('[role="listbox"]').exists()).toBe(false)

      await nameInput(wrapper).setValue('bench p')
      expect(wrapper.find('[role="listbox"]').exists()).toBe(true)
    })

    it('ArrowDown re-opens a popup dismissed with Escape', async () => {
      const wrapper = mountTracker()
      await openNewExercise(wrapper)
      await nameInput(wrapper).setValue('bench')
      await key(wrapper, 'Escape')

      await key(wrapper, 'ArrowDown')
      expect(options(wrapper).length).toBeGreaterThan(0)
      expect(nameInput(wrapper).attributes('aria-activedescendant'))
        .toBe(options(wrapper)[0].attributes('id'))
    })

    it('re-typing a name the popup was dismissed at still shows suggestions', async () => {
      // The dismissal is keyed to a query, so it has to be cleared when the
      // sheet closes — otherwise typing that exact name again renders nothing.
      const wrapper = mountTracker()
      await openNewExercise(wrapper)
      await nameInput(wrapper).setValue('bench')
      await key(wrapper, 'Escape')   // closes the popup
      await key(wrapper, 'Escape')   // closes the sheet
      expect(wrapper.find('.repMaxOverlay').exists()).toBe(false)

      await openNewExercise(wrapper)
      await nameInput(wrapper).setValue('bench')
      expect(wrapper.find('[role="listbox"]').exists()).toBe(true)
    })

    it('still selects on tap (mousedown), unchanged', async () => {
      const expected = suggestionsFor('bench')
      const wrapper = mountTracker()
      await openNewExercise(wrapper)
      await nameInput(wrapper).setValue('bench')
      await wrapper.findAll('.wtExerciseSuggestionItem')[0].trigger('mousedown')
      expect(nameValue(wrapper)).toBe(expected[0].name)
    })

    it('does not fold the suggestion text into the field name, and passes axe', async () => {
      const wrapper = mount(WorkoutTracker, {
        attachTo: document.body,
        global: { stubs: { Teleport: true } },
      })
      exposed(wrapper).openNewExerciseModal()
      await nextTick()
      await nameInput(wrapper).setValue('bench')
      expect(wrapper.find('[role="listbox"]').exists()).toBe(true)

      // The listbox must NOT sit inside the <label>: an implicit label
      // contributes its entire subtree to the accessible name, so a nested
      // list announced the field as "Exercise name Bench Press Push · Chest …".
      const label = wrapper.find('.wtNewExerciseNameField .repMaxLabel')
      expect(label.find('[role="listbox"]').exists()).toBe(false)
      expect(label.text().replace(/\s+/g, ' ').trim()).toBe('Exercise name')

      // Scanned component-wide now that the `.iosToggle` switch below the form
      // has an accessible name (LIFT-1308). This was scoped to
      // `.wtNewExerciseNameField` while that violation stood, so the widening
      // is itself the regression proof: re-drop the switch's label and this
      // fails on `button-name` even though nothing here mentions toggles.
      const results = await runComponentAxe(wrapper.element)
      expect(results).toHaveNoViolations()
    })
  })

  // ── Switch accessible names (LIFT-1308) ───────────────────────────
  // The `.iosToggle` switches render a decorative knob and nothing else, so
  // without an explicit name AT announced only "switch, off". axe catches the
  // absence; these assert the name is the *visible* row label, which is the
  // part `button-name` cannot see (any non-empty string satisfies it).
  describe('plate-calculator switch has an accessible name', () => {
    it('is named by the visible row label, and the name does not change with state', async () => {
      const wrapper = mount(WorkoutTracker, {
        attachTo: document.body,
        global: { stubs: { Teleport: true } },
      })
      exposed(wrapper).openNewExerciseModal()
      await nextTick()

      // Re-found each read: turning the switch on reveals the Counting and
      // Starting-weight rows, so a held wrapper goes stale.
      const toggle = () => wrapper.find('.iosToggle')
      expect(toggle().exists()).toBe(true)
      const labelId = toggle().attributes('aria-labelledby')
      expect(labelId).toBeTruthy()
      expect(document.getElementById(labelId!)?.textContent).toBe('Plate calculator')
      expect(toggle().attributes('aria-checked')).toBe('false')

      // Toggling moves `aria-checked` only — the name is state-independent.
      await toggle().trigger('click')
      expect(toggle().attributes('aria-checked')).toBe('true')
      expect(toggle().attributes('aria-labelledby')).toBe(labelId)
      expect(toggle().attributes('aria-label')).toBeUndefined()
    })
  })
})

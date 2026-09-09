import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { getLocalStorageMock, mockAnalytics, mockWeightUnit } from '../../__tests__/helpers'
import { bodyweightFold } from '../../lib/bodyweightLoad'
import { epley } from '../../lib/epley'

const localStorageMock = getLocalStorageMock()

vi.mock('../../composables/useAnalytics', () => mockAnalytics())
vi.mock('../../composables/useWeightUnit', () => mockWeightUnit())
vi.mock('../../composables/usePRBaseline', () => ({
  usePRBaseline: () => ({
    prBaselineDate: { value: null },
  })
}))

// Build reactive mock store
interface MockSet {
  id: string
  date: string
  weight: number
  reps: number
  estimated1RM: number
  /** The bodyweight captured at log time (LIFT-834) — local-only, per set. */
  bodyweight?: number
}

interface MockExercise {
  id: string
  name: string
  tags: string[]
  sets: MockSet[]
  bodyweightLoaded?: boolean
}

// The lifter's tracked bodyweight, as the real store's `_currentBodyweight()`
// would read it (LIFT-834).
let bodyweightLbs: number | null = null

let exercises: MockExercise[] = []

function getExercisePR(id: string): number {
  const ex = exercises.find(e => e.id === id)
  if (!ex || ex.sets.length === 0) return 0
  return Math.max(...ex.sets.map(s => s.estimated1RM))
}

function getAllTags(): string[] {
  const tags = new Set<string>()
  exercises.forEach(e => (e.tags || []).forEach(t => tags.add(t)))
  return [...tags].sort()
}

const mockLogSet = vi.fn()

// Delegates to the REAL fold helper so the mock can't invent its own rule about
// when bodyweight counts — the same fidelity contract the WorkoutTracker
// harness holds itself to (#1328).
function bodyweightFoldFor(id: string): number {
  return bodyweightFold(exercises.find(e => e.id === id), bodyweightLbs)
}

vi.mock('../../stores/workout', () => ({
  useWorkoutStore: () => ({
    get exercises() { return exercises },
    set exercises(v: MockExercise[]) { exercises = v },
    get allTags() { return getAllTags() },
    getExercisePR,
    bodyweightFoldFor,
    logSet: mockLogSet,
    addExercise: vi.fn(),
    tagRecoveryDays: {},
    tagRecoveryExcluded: [],
  })
}))

import CalendarView from '../../views/CalendarView.vue'

function mountCalendar() {
  return mount(CalendarView, {
    global: {
      stubs: { Teleport: true },
    }
  })
}

// Create exercise data with sets on specific dates
function makeExercises(dates: string[]): MockExercise[] {
  return [{
    id: 'ex-1',
    name: 'Bench Press',
    tags: ['Chest'],
    sets: dates.map((date, i) => ({
      id: `s-${i}`,
      date: `${date}T12:00:00`,
      weight: 185 + i * 10,
      reps: 5,
      estimated1RM: Math.round((185 + i * 10) * (1 + 5 / 30)),
    }))
  }]
}

describe('CalendarView', () => {
  beforeEach(() => {
    exercises = []
    bodyweightLbs = null
    mockLogSet.mockClear()
    localStorageMock.clear()
  })

  describe('header and navigation', () => {
    it('renders the Training Calendar title', () => {
      const wrapper = mountCalendar()
      expect(wrapper.find('.calTitle').text()).toBe('Training Calendar')
    })

    // LIFT-856: each top-level view needs a single page-level <h1> so screen-reader
    // users get a consistent landmark and the hierarchy doesn't skip from h1 to h2.
    it('exposes the calendar title as the single h1 (no skipped heading level)', () => {
      const wrapper = mountCalendar()
      const h1s = wrapper.findAll('h1')
      expect(h1s.length).toBe(1)
      expect(h1s[0].classes()).toContain('calTitle')
      expect(h1s[0].text()).toBe('Training Calendar')
    })

    it('shows Year, Month, and Week view toggle buttons', () => {
      const wrapper = mountCalendar()
      const btns = wrapper.findAll('.calToggleBtn')
      expect(btns.length).toBe(3)
      expect(btns[0].text()).toBe('Year')
      expect(btns[1].text()).toBe('Month')
      expect(btns[2].text()).toBe('Week')
    })

    it('defaults to month view', () => {
      const wrapper = mountCalendar()
      expect(wrapper.find('.calToggleBtn.active').text()).toBe('Month')
      expect(wrapper.find('.calGrid').exists()).toBe(true)
    })

    it('shows navigation arrows and month label', () => {
      const wrapper = mountCalendar()
      const navBtns = wrapper.findAll('.calNavBtn')
      expect(navBtns.length).toBe(2)
      expect(navBtns[0].text()).toBe('‹')
      expect(navBtns[1].text()).toBe('›')
      expect(wrapper.find('.calNavLabel').exists()).toBe(true)
    })

    it('changes month label after navigating backward', async () => {
      const wrapper = mountCalendar()
      // Click prev twice to ensure we move away from current month
      await wrapper.findAll('.calNavBtn')[0].trigger('click')
      await wrapper.vm.$nextTick()
      await wrapper.findAll('.calNavBtn')[0].trigger('click')
      await wrapper.vm.$nextTick()

      const label = wrapper.find('.calNavLabel').text()
      const now = new Date()
      const currentMonthName = now.toLocaleDateString(undefined, { month: 'long' })
      // After going back 2 months, the label should not contain the current month
      expect(label).not.toContain(currentMonthName)
    })

    it('changes month label after navigating forward', async () => {
      const wrapper = mountCalendar()
      await wrapper.findAll('.calNavBtn')[1].trigger('click')
      await wrapper.vm.$nextTick()
      await wrapper.findAll('.calNavBtn')[1].trigger('click')
      await wrapper.vm.$nextTick()

      const label = wrapper.find('.calNavLabel').text()
      const now = new Date()
      const currentMonthName = now.toLocaleDateString(undefined, { month: 'long' })
      expect(label).not.toContain(currentMonthName)
    })

    // Regression (#1068): month nav used to stall/skip when the cursor sat on a
    // 31st. `new Date(2026, 4, 31).setMonth(3)` (April, 30 days) overflows to
    // May 1, so a naive setMonth left the label unchanged going back and skipped
    // a month going forward. The fix pins the day to 1 before shifting the month.
    // Pinned to May 31 because both neighbors (April, June) have 30 days, so a
    // single click in each direction exercises the bug. The harness otherwise
    // starts the cursor at the real "today", whose day-of-month may exist in
    // every month — which is exactly why this never got caught.
    it('navigates by exactly one month when the cursor is on a 31st (#1068)', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(2026, 4, 31, 12, 0, 0)) // Sun May 31, 2026
      try {
        const april = new Date(2026, 3, 1).toLocaleDateString(undefined, { month: 'long' })
        const june = new Date(2026, 5, 1).toLocaleDateString(undefined, { month: 'long' })

        const fwd = mountCalendar()
        await fwd.findAll('.calNavBtn')[1].trigger('click') // next
        await fwd.vm.$nextTick()
        // Without the fix this reads "July" (June skipped entirely).
        expect(fwd.find('.calNavLabel').text()).toContain(june)

        const back = mountCalendar()
        await back.findAll('.calNavBtn')[0].trigger('click') // prev
        await back.vm.$nextTick()
        // Without the fix this stays "May" (nav appears frozen).
        expect(back.find('.calNavLabel').text()).toContain(april)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('month grid', () => {
    it('renders day headers (Su Mo Tu We Th Fr Sa)', () => {
      const wrapper = mountCalendar()
      const headers = wrapper.findAll('.calDayHeader')
      expect(headers.length).toBe(7)
      expect(headers.map(h => h.text())).toEqual(['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'])
    })

    it('renders calendar cells for the month', () => {
      const wrapper = mountCalendar()
      const cells = wrapper.findAll('.calCell')
      // A month grid has between 28 and 42 cells (4-6 rows × 7 days)
      expect(cells.length).toBeGreaterThanOrEqual(28)
      expect(cells.length).toBeLessThanOrEqual(42)
    })

    it('marks today with calCellToday class', () => {
      const wrapper = mountCalendar()
      const todayCells = wrapper.findAll('.calCellToday')
      expect(todayCells.length).toBe(1)
    })

    it('shows dots on days with workout data', () => {
      const today = new Date()
      const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
      exercises = makeExercises([dateStr])

      const wrapper = mountCalendar()
      const dotsContainers = wrapper.findAll('.calDots')
      expect(dotsContainers.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('day selection', () => {
    it('selects a day when clicked', async () => {
      const wrapper = mountCalendar()
      // Click on an in-month cell
      const inMonthCells = wrapper.findAll('.calCell:not(.calCellOtherMonth)')
      await inMonthCells[0].trigger('click')
      expect(wrapper.find('.calCellSelected').exists()).toBe(true)
    })

    it('shows detail panel when day is selected', async () => {
      const wrapper = mountCalendar()
      const inMonthCells = wrapper.findAll('.calCell:not(.calCellOtherMonth)')
      await inMonthCells[0].trigger('click')
      expect(wrapper.find('.calDetail').exists()).toBe(true)
    })

    it('shows "+ Log" button in day detail', async () => {
      const wrapper = mountCalendar()
      const inMonthCells = wrapper.findAll('.calCell:not(.calCellOtherMonth)')
      await inMonthCells[0].trigger('click')
      expect(wrapper.find('.calLogBtn').text()).toBe('+ Log')
    })

    it('shows "No sets logged" for empty days', async () => {
      const wrapper = mountCalendar()
      const inMonthCells = wrapper.findAll('.calCell:not(.calCellOtherMonth)')
      await inMonthCells[0].trigger('click')
      expect(wrapper.find('.calDetailEmpty').text()).toContain('No sets logged')
    })

    it('shows first-use empty state when no exercises have sets (month view)', () => {
      exercises = []
      const wrapper = mountCalendar()
      const emptyState = wrapper.find('.calEmptyState')
      expect(emptyState.exists()).toBe(true)
      expect(emptyState.text()).toContain('Log your first workout')
      expect(emptyState.text()).toContain('Workouts tab')
    })

    it('hides first-use empty state when exercises have sets', () => {
      const today = new Date()
      const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
      exercises = makeExercises([dateStr])
      const wrapper = mountCalendar()
      expect(wrapper.find('.calEmptyState').exists()).toBe(false)
    })

    it('hides first-use empty state when a day is selected', async () => {
      exercises = []
      const wrapper = mountCalendar()
      expect(wrapper.find('.calEmptyState').exists()).toBe(true)
      const inMonthCells = wrapper.findAll('.calCell:not(.calCellOtherMonth)')
      await inMonthCells[0].trigger('click')
      // When a day is selected, the per-day detail takes over
      expect(wrapper.find('.calEmptyState').exists()).toBe(false)
    })

    it('deselects day when clicked again', async () => {
      const wrapper = mountCalendar()
      const inMonthCells = wrapper.findAll('.calCell:not(.calCellOtherMonth)')
      await inMonthCells[0].trigger('click')
      expect(wrapper.find('.calCellSelected').exists()).toBe(true)

      await inMonthCells[0].trigger('click')
      expect(wrapper.find('.calCellSelected').exists()).toBe(false)
    })
  })

  describe('day detail with workout data', () => {
    it('shows exercise names for selected day', async () => {
      const today = new Date()
      const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
      exercises = makeExercises([dateStr])

      const wrapper = mountCalendar()
      // Click on today's cell
      const todayCell = wrapper.find('.calCellToday')
      await todayCell.trigger('click')

      expect(wrapper.find('.calDetailTags').exists()).toBe(true)
      expect(wrapper.text()).toContain('Bench Press')
    })

    it('shows workout summary bar with exercise count, set count, and volume', async () => {
      const today = new Date()
      const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
      exercises = makeExercises([dateStr])

      const wrapper = mountCalendar()
      await wrapper.find('.calCellToday').trigger('click')

      const summary = wrapper.find('.calSummaryBar')
      expect(summary.exists()).toBe(true)
      expect(summary.text()).toContain('1')  // 1 exercise
      expect(summary.text()).toContain('set') // set count
    })

    it('shows set count badge on exercise tag', async () => {
      const today = new Date()
      const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
      exercises = makeExercises([dateStr])

      const wrapper = mountCalendar()
      await wrapper.find('.calCellToday').trigger('click')

      expect(wrapper.find('.calExRowCount').exists()).toBe(true)
    })

    it('expands set details when exercise row is clicked', async () => {
      const today = new Date()
      const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
      exercises = makeExercises([dateStr])

      const wrapper = mountCalendar()
      await wrapper.find('.calCellToday').trigger('click')
      await wrapper.find('.calExRow').trigger('click')

      expect(wrapper.find('.calSetList').exists()).toBe(true)
      expect(wrapper.find('.calSetRow').exists()).toBe(true)
    })

    it('collapses set details on second click', async () => {
      const today = new Date()
      const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
      exercises = makeExercises([dateStr])

      const wrapper = mountCalendar()
      await wrapper.find('.calCellToday').trigger('click')
      await wrapper.find('.calExRow').trigger('click')
      expect(wrapper.find('.calSetList').exists()).toBe(true)

      await wrapper.find('.calExRow').trigger('click')
      expect(wrapper.find('.calSetList').exists()).toBe(false)
    })
  })

  describe('week view', () => {
    it('switches to week view when Week button is clicked', async () => {
      const wrapper = mountCalendar()
      await wrapper.findAll('.calToggleBtn')[2].trigger('click')

      expect(wrapper.find('.calWeek').exists()).toBe(true)
      expect(wrapper.find('.calGrid').exists()).toBe(false)
    })

    it('renders 7 day rows in week view', async () => {
      const wrapper = mountCalendar()
      await wrapper.findAll('.calToggleBtn')[2].trigger('click')

      expect(wrapper.findAll('.calWeekRow').length).toBe(7)
    })

    it('shows day names and numbers', async () => {
      const wrapper = mountCalendar()
      await wrapper.findAll('.calToggleBtn')[2].trigger('click')

      expect(wrapper.findAll('.calWeekDayName').length).toBe(7)
      expect(wrapper.findAll('.calWeekDayNum').length).toBe(7)
    })

    it('shows "Rest" for days without workouts', async () => {
      const wrapper = mountCalendar()
      await wrapper.findAll('.calToggleBtn')[2].trigger('click')

      expect(wrapper.findAll('.calWeekRest').length).toBe(7)
    })

    it('marks today in week view', async () => {
      const wrapper = mountCalendar()
      await wrapper.findAll('.calToggleBtn')[2].trigger('click')

      expect(wrapper.find('.calWeekRowToday').exists()).toBe(true)
    })

    it('shows "+ Log" button on each day row', async () => {
      const wrapper = mountCalendar()
      await wrapper.findAll('.calToggleBtn')[2].trigger('click')

      expect(wrapper.findAll('.calWeekDayLogBtn').length).toBe(7)
    })

    it('navigates weeks with arrows', async () => {
      const wrapper = mountCalendar()
      await wrapper.findAll('.calToggleBtn')[2].trigger('click')

      const initialLabel = wrapper.find('.calNavLabel').text()
      await wrapper.findAll('.calNavBtn')[0].trigger('click')
      expect(wrapper.find('.calNavLabel').text()).not.toBe(initialLabel)
    })

    it('shows first-use empty state when no exercises have sets (week view)', async () => {
      exercises = []
      const wrapper = mountCalendar()
      await wrapper.findAll('.calToggleBtn')[2].trigger('click')

      const emptyState = wrapper.find('.calEmptyState')
      expect(emptyState.exists()).toBe(true)
      expect(emptyState.text()).toContain('Log your first workout')
    })

    it('hides first-use empty state in week view when exercises have sets', async () => {
      const today = new Date()
      const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
      exercises = makeExercises([dateStr])
      const wrapper = mountCalendar()
      await wrapper.findAll('.calToggleBtn')[2].trigger('click')

      expect(wrapper.find('.calEmptyState').exists()).toBe(false)
    })
  })

  describe('tag filtering', () => {
    it('shows tag filter bar when exercises have tags', () => {
      exercises = makeExercises(['2026-03-31'])
      const wrapper = mountCalendar()
      expect(wrapper.find('.wtTagFilterBar').exists()).toBe(true)
    })

    it('does not show tag filter when no exercises have tags', () => {
      exercises = [{ id: 'ex-1', name: 'Bench', tags: [], sets: [] }]
      const wrapper = mountCalendar()
      expect(wrapper.find('.wtTagFilterBar').exists()).toBe(false)
    })
  })

  describe('PR indicators', () => {
    it('shows trophy on calendar cell for PR day', () => {
      const today = new Date()
      const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
      exercises = makeExercises([dateStr])

      const wrapper = mountCalendar()
      expect(wrapper.find('.calCellPR').exists()).toBe(true)
      expect(wrapper.find('.calCellPR').text()).toContain('🏆')
    })
  })

  describe('nav label tap-to-today', () => {
    it('nav label is not tappable when on current period', () => {
      const wrapper = mountCalendar()
      const label = wrapper.find('.calNavLabel')
      expect(label.classes()).not.toContain('calNavLabelTappable')
      expect((label.element as HTMLButtonElement).disabled).toBe(true)
    })

    it('nav label becomes tappable when viewing a past month', async () => {
      const wrapper = mountCalendar()
      // Navigate back one month
      await wrapper.findAll('.calNavBtn')[0].trigger('click')
      const label = wrapper.find('.calNavLabel')
      expect(label.classes()).toContain('calNavLabelTappable')
      expect((label.element as HTMLButtonElement).disabled).toBe(false)
    })

    it('tapping nav label returns to current month', async () => {
      const wrapper = mountCalendar()
      const currentLabel = wrapper.find('.calNavLabel').text()
      // Navigate back
      await wrapper.findAll('.calNavBtn')[0].trigger('click')
      expect(wrapper.find('.calNavLabel').text()).not.toBe(currentLabel)
      // Tap label to return
      await wrapper.find('.calNavLabel').trigger('click')
      expect(wrapper.find('.calNavLabel').text()).toBe(currentLabel)
    })
  })

  describe('accordion multi-expand', () => {
    it('allows multiple exercises expanded simultaneously', async () => {
      const today = new Date()
      const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
      exercises = [
        { id: 'ex-1', name: 'Bench', tags: ['Chest'], sets: [{ id: 's1', date: `${dateStr}T12:00:00`, weight: 135, reps: 5, estimated1RM: 158 }] },
        { id: 'ex-2', name: 'Squat', tags: ['Legs'], sets: [{ id: 's2', date: `${dateStr}T12:00:00`, weight: 225, reps: 5, estimated1RM: 263 }] },
      ]

      const wrapper = mountCalendar()
      await wrapper.find('.calCellToday').trigger('click')

      const rows = wrapper.findAll('.calExRow')
      expect(rows).toHaveLength(2)

      // Expand first
      await rows[0].trigger('click')
      expect(wrapper.findAll('.calSetList')).toHaveLength(1)

      // Expand second — both should be open
      await rows[1].trigger('click')
      expect(wrapper.findAll('.calSetList')).toHaveLength(2)
    })
  })

  describe('accessibility', () => {
    it('nav buttons have aria-labels', () => {
      const wrapper = mountCalendar()
      const navBtns = wrapper.findAll('.calNavBtn')
      expect(navBtns[0].attributes('aria-label')).toBe('Previous')
      expect(navBtns[1].attributes('aria-label')).toBe('Next')
    })

    it('view toggle buttons have aria-pressed', () => {
      const wrapper = mountCalendar()
      const btns = wrapper.findAll('.calToggleBtn')
      expect(btns[0].attributes('aria-pressed')).toBe('false')  // Year
      expect(btns[1].attributes('aria-pressed')).toBe('true')   // Month is default
      expect(btns[2].attributes('aria-pressed')).toBe('false')  // Week
    })

    it('tag filter buttons have aria-pressed and aria-label', () => {
      exercises = makeExercises(['2026-03-31'])
      const wrapper = mountCalendar()
      const tagBtns = wrapper.findAll('.wtTagChip:not(.wtTagChipClear)')
      expect(tagBtns.length).toBeGreaterThan(0)

      // Initially unpressed
      expect(tagBtns[0].attributes('aria-pressed')).toBe('false')
      expect(tagBtns[0].attributes('aria-label')).toContain('Filter by')
    })

    it('tag filter buttons toggle aria-pressed on click', async () => {
      exercises = makeExercises(['2026-03-31'])
      const wrapper = mountCalendar()
      const tagBtn = wrapper.find('.wtTagChip:not(.wtTagChipClear)')

      expect(tagBtn.attributes('aria-pressed')).toBe('false')
      expect(tagBtn.attributes('aria-label')).toContain('Filter by')

      await tagBtn.trigger('click')

      expect(tagBtn.attributes('aria-pressed')).toBe('true')
      expect(tagBtn.attributes('aria-label')).toContain('Remove')
    })

    it('clear tag filter button has aria-label', async () => {
      exercises = makeExercises(['2026-03-31'])
      const wrapper = mountCalendar()
      const tagBtn = wrapper.find('.wtTagChip:not(.wtTagChipClear)')
      await tagBtn.trigger('click')

      const clearBtn = wrapper.find('.wtTagChipClear')
      expect(clearBtn.exists()).toBe(true)
      expect(clearBtn.attributes('aria-label')).toBe('Clear all tag filters')
    })

    it('exercise picker modal has aria-labelledby linking to heading', async () => {
      const today = new Date()
      const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
      exercises = makeExercises([dateStr])

      const wrapper = mountCalendar()
      await wrapper.find('.calCellToday').trigger('click')
      await wrapper.find('.calLogBtn').trigger('click')

      const dialog = wrapper.find('[role="dialog"]')
      expect(dialog.exists()).toBe(true)
      expect(dialog.attributes('aria-labelledby')).toBe('exercise-picker-title')
      expect(wrapper.find('#exercise-picker-title').exists()).toBe(true)
      expect(wrapper.find('#exercise-picker-title').text()).toBe('Choose Exercise')
    })

    it('week view log buttons have aria-labels', async () => {
      const wrapper = mountCalendar()
      await wrapper.findAll('.calToggleBtn')[2].trigger('click')

      const logBtns = wrapper.findAll('.calWeekDayLogBtn')
      expect(logBtns.length).toBe(7)
      for (const btn of logBtns) {
        const label = btn.attributes('aria-label')
        expect(label).toBeTruthy()
        expect(label).toMatch(/^Log workout for/)
      }
    })

    it('exercise expand rows have aria-expanded', async () => {
      const today = new Date()
      const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
      exercises = makeExercises([dateStr])

      const wrapper = mountCalendar()
      await wrapper.find('.calCellToday').trigger('click')

      const exRow = wrapper.find('.calExRow')
      expect(exRow.attributes('aria-expanded')).toBe('false')

      await exRow.trigger('click')
      expect(exRow.attributes('aria-expanded')).toBe('true')
    })

    it('in-month calendar cells have role="button" and tabindex="0"', () => {
      const wrapper = mountCalendar()
      const inMonthCells = wrapper.findAll('.calCell:not(.calCellOtherMonth)')
      expect(inMonthCells.length).toBeGreaterThan(0)
      for (const cell of inMonthCells) {
        expect(cell.attributes('role')).toBe('button')
        expect(cell.attributes('tabindex')).toBe('0')
      }
    })

    it('other-month cells do not have role="button"', () => {
      const wrapper = mountCalendar()
      const otherCells = wrapper.findAll('.calCellOtherMonth')
      if (otherCells.length > 0) {
        for (const cell of otherCells) {
          expect(cell.attributes('role')).toBeUndefined()
          expect(cell.attributes('tabindex')).toBe('-1')
        }
      }
    })

    it('in-month calendar cells have descriptive aria-labels', () => {
      const today = new Date()
      const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
      exercises = makeExercises([dateStr])

      const wrapper = mountCalendar()
      const todayCell = wrapper.find('.calCellToday')
      const label = todayCell.attributes('aria-label')!
      expect(label).toBeTruthy()
      expect(label).toContain('today')
      expect(label).toContain('1 exercise')
    })

    it('calendar cells with PR show "PR" in aria-label', () => {
      const today = new Date()
      const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
      exercises = makeExercises([dateStr])

      const wrapper = mountCalendar()
      const todayCell = wrapper.find('.calCellToday')
      const label = todayCell.attributes('aria-label')!
      expect(label).toContain('PR')
    })

    it('selected calendar cell has aria-pressed="true"', async () => {
      const wrapper = mountCalendar()
      const inMonthCells = wrapper.findAll('.calCell:not(.calCellOtherMonth)')
      await inMonthCells[0].trigger('click')
      expect(inMonthCells[0].attributes('aria-pressed')).toBe('true')
    })

    it('calendar cells respond to Enter key', async () => {
      const wrapper = mountCalendar()
      const inMonthCells = wrapper.findAll('.calCell:not(.calCellOtherMonth)')
      await inMonthCells[0].trigger('keydown', { key: 'Enter' })
      expect(wrapper.find('.calCellSelected').exists()).toBe(true)
    })

    it('calendar cells respond to Space key', async () => {
      const wrapper = mountCalendar()
      const inMonthCells = wrapper.findAll('.calCell:not(.calCellOtherMonth)')
      await inMonthCells[0].trigger('keydown', { key: ' ' })
      expect(wrapper.find('.calCellSelected').exists()).toBe(true)
    })
  })

  describe('year view', () => {
    it('switches to year view when Year button is clicked', async () => {
      const wrapper = mountCalendar()
      await wrapper.findAll('.calToggleBtn')[0].trigger('click')

      // Year view should not show the month grid
      expect(wrapper.find('.calGrid').exists()).toBe(false)
      // Year toggle button should be active
      expect(wrapper.findAll('.calToggleBtn')[0].classes()).toContain('active')
    })

    it('hides month/week navigation in year view', async () => {
      const wrapper = mountCalendar()
      await wrapper.findAll('.calToggleBtn')[0].trigger('click')

      expect(wrapper.find('.calNav').exists()).toBe(false)
    })

    it('hides tag filter bar in year view', async () => {
      exercises = makeExercises(['2026-03-31'])
      const wrapper = mountCalendar()
      // Verify tag filter shows in month view
      expect(wrapper.find('.wtTagFilterBar').exists()).toBe(true)

      await wrapper.findAll('.calToggleBtn')[0].trigger('click')
      expect(wrapper.find('.wtTagFilterBar').exists()).toBe(false)
    })
  })

  /**
   * The calendar's "+ Log" is the app's SECOND way to log a set — backfilling a
   * day you forgot — and it carried its own hand-rolled copy of the log sheet's
   * `weight > 0` gate, so fixing only the sheet would have left the pure
   * bodyweight set (LIFT-1330) refused here. Its estimate was also still
   * unfolded, the #1328 defect surviving in a surface that issue never touched:
   * a bodyweight-loaded pull-up read ~29 lbs on screen while `logSet` was about
   * to store ~216.
   */
  describe('backfill log modal, bodyweight-loaded (LIFT-1330)', () => {
    const BODYWEIGHT = 160

    async function openLogModalFor(name: string) {
      const wrapper = mountCalendar()
      await wrapper.find('.calCellToday').trigger('click')
      await wrapper.find('.calLogBtn').trigger('click')
      await wrapper.findAll('.wtExPickerRow').find(b => b.text().includes(name))!.trigger('click')
      return wrapper
    }

    function fields(wrapper: ReturnType<typeof mountCalendar>) {
      const inputs = wrapper.findAll('[aria-labelledby="cal-modal-title"] input')
      return { weight: inputs[0], reps: inputs[1] }
    }

    const saveBtn = (wrapper: ReturnType<typeof mountCalendar>) =>
      wrapper.find('[aria-labelledby="cal-modal-title"] .repMaxBtnCalc')

    beforeEach(() => {
      bodyweightLbs = BODYWEIGHT
      exercises = [{ id: 'ex-1', name: 'Pull-Up', tags: ['Back'], bodyweightLoaded: true, sets: [] }]
    })

    it('accepts an added weight of 0 and logs it', async () => {
      const wrapper = await openLogModalFor('Pull-Up')
      const { weight, reps } = fields(wrapper)
      await weight.setValue('0')
      await reps.setValue('12')

      expect(saveBtn(wrapper).attributes('disabled')).toBeUndefined()
      await saveBtn(wrapper).trigger('click')
      expect(mockLogSet).toHaveBeenCalledWith('ex-1', 0, 12, expect.any(String))
    })

    it('estimates the folded load, matching what logSet stores', async () => {
      const wrapper = await openLogModalFor('Pull-Up')
      const { weight, reps } = fields(wrapper)
      await weight.setValue('25')
      await reps.setValue('5')

      expect(wrapper.find('.repMaxResult').text()).toContain(`${epley(BODYWEIGHT + 25, 5)} lbs`)
    })

    it('calls the field "Added" and drops the barbell placeholder', async () => {
      const wrapper = await openLogModalFor('Pull-Up')
      expect(fields(wrapper).weight.attributes('placeholder')).toBe('0')
      expect(wrapper.find('[aria-labelledby="cal-modal-title"] .repMaxLabel').text()).toContain('Added')
    })

    it('still refuses 0 on a normal exercise', async () => {
      exercises = [{ id: 'ex-2', name: 'Bench Press', tags: ['Chest'], sets: [] }]
      const wrapper = await openLogModalFor('Bench Press')
      const { weight, reps } = fields(wrapper)
      await weight.setValue('0')
      await reps.setValue('5')

      expect(saveBtn(wrapper).attributes('disabled')).toBeDefined()
      expect(fields(wrapper).weight.attributes('placeholder')).toBe('135')
    })

    /**
     * LIFT-1373 — the day's set rows are a history read-back surface, and they
     * render the load right beside the folded e1RM. A pure-bodyweight set read
     * "0 lbs x 12 reps ~238 lbs e1RM": the same row saying the lifter moved
     * nothing and estimating a 238 lb max.
     */
    describe('set rows read the load in ADDED-space words', () => {
      function seedPullUpDay(weight: number, bodyweight?: number) {
        const today = new Date()
        const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
        exercises = [{
          id: 'ex-1',
          name: 'Pull-Up',
          tags: ['Back'],
          bodyweightLoaded: true,
          sets: [{
            id: 's-1',
            date: `${dateStr}T12:00:00`,
            weight,
            reps: 12,
            estimated1RM: epley((bodyweight ?? 0) + weight, 12),
            ...(bodyweight === undefined ? {} : { bodyweight }),
          }],
        }]
      }

      async function expandTodaysSets() {
        const wrapper = mountCalendar()
        await wrapper.find('.calCellToday').trigger('click')
        await wrapper.find('.calExRow').trigger('click')
        return wrapper
      }

      it('reads a pure-bodyweight set as "Bodyweight", not "0 lbs"', async () => {
        seedPullUpDay(0, BODYWEIGHT)
        const wrapper = await expandTodaysSets()
        expect(wrapper.find('.calSetWeight').text()).toBe('Bodyweight')
        expect(wrapper.find('.calSetMain').text()).not.toContain('0 lbs')
      })

      it('marks an added weight as added', async () => {
        seedPullUpDay(25, BODYWEIGHT)
        const wrapper = await expandTodaysSets()
        expect(wrapper.find('.calSetWeight').text()).toBe('+25 lbs')
      })

      it('keeps "0 lbs" for a set that folded nothing in', async () => {
        // No captured bodyweight, so the neighbouring e1RM is off the bare
        // weight — "Bodyweight" would contradict it.
        seedPullUpDay(0, undefined)
        const wrapper = await expandTodaysSets()
        expect(wrapper.find('.calSetWeight').text()).toBe('0 lbs')
      })

      it('leaves an ordinary barbell set exactly as it was', async () => {
        const today = new Date()
        const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
        exercises = makeExercises([dateStr])
        const wrapper = await expandTodaysSets()
        expect(wrapper.find('.calSetWeight').text()).toBe('185 lbs')
      })
    })
  })
})

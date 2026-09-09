/**
 * LIFT-1189 — ExerciseDetailModal: the exercise history/graph/PR surface.
 *
 * This modal is one of the core history-viewing flows but was only touched
 * incidentally by E2E. These tests pin the component's own contract in
 * isolation: the sets/PRs tab switch and their visibility gate, set-row and
 * PR-card rendering, the trophy on the PR set, the warmup-hide toggle, the
 * "show all" gate at SET_LIMIT, the empty state, and every emit the parent
 * relies on. The heavy SVG ExerciseGraph child is stubbed; the workout /
 * preferences stores and useWeightUnit are mocked at their boundary so the
 * test drives pure component STATE, mirroring the CoachSheet pattern.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, enableAutoUnmount, type VueWrapper } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import ExerciseDetailModal from '../ExerciseDetailModal.vue'
import { runComponentAxe } from '../../__tests__/axeHelper'
import type { Exercise, WorkoutSet } from '../../stores/workout'

enableAutoUnmount(afterEach)

// ── Store boundary mocks ─────────────────────────────────────────
// A single mutable array backs the mocked workout store; each test seeds it
// via setExercises() before mounting. getExercisePR returns the max e1RM of
// the exercise's sets — the same all-time-max semantics the real store uses
// when no PR baseline is set — so the trophy-matching logic is exercised
// faithfully rather than stubbed to a constant.
let mockExercises: Exercise[] = []
function setExercises(list: Exercise[]) {
  mockExercises = list
}

vi.mock('../../stores/workout', () => ({
  useWorkoutStore: () => ({
    get exercises() {
      return mockExercises
    },
    getExercisePR(id: string): number {
      const ex = mockExercises.find((e) => e.id === id)
      if (!ex || ex.sets.length === 0) return 0
      return Math.max(...ex.sets.map((s) => s.estimated1RM))
    },
  }),
}))

vi.mock('../../stores/preferences', () => ({
  usePreferencesStore: () => ({
    filters: { warmupThreshold: 0.75 },
    prBaselineDate: null,
  }),
}))

vi.mock('../../composables/useWeightUnit', () => ({
  useWeightUnit: () => ({
    weightUnit: ref('lbs'),
    displayWeight: (w: number) => Math.round(w),
    toLbs: (w: number) => w,
  }),
}))

// ExerciseGraph is a heavy computed-SVG child unrelated to this surface.
vi.mock('../../components/ExerciseGraph.vue', () => ({
  default: { name: 'ExerciseGraph', template: '<div class="mock-graph" />' },
}))

// ── Fixtures ─────────────────────────────────────────────────────
function makeSet(over: Partial<WorkoutSet> & { weight: number; reps: number; estimated1RM: number }): WorkoutSet {
  return {
    // Spread first so optional fields (rpe, bodyweight — the local-only ones a
    // fixture must be able to set) survive rather than being dropped.
    ...over,
    id: over.id ?? `s-${Math.random().toString(36).slice(2)}`,
    date: over.date ?? '2026-01-01T12:00:00',
    weight: over.weight,
    reps: over.reps,
    estimated1RM: over.estimated1RM,
  }
}

// Three ascending-max sets on distinct days → prHistory has 3 entries (>1),
// so the PRs tab is shown; the top set (204 on Feb 1) is the current PR.
function prRichExercise(over: Partial<Exercise> = {}): Exercise {
  return {
    id: 'ex-1',
    name: 'Bench Press',
    tags: ['Chest'],
    sets: [
      makeSet({ id: 's-1', date: '2026-01-01T12:00:00', weight: 135, reps: 5, estimated1RM: 158 }),
      makeSet({ id: 's-2', date: '2026-01-15T12:00:00', weight: 155, reps: 5, estimated1RM: 181 }),
      makeSet({ id: 's-3', date: '2026-02-01T12:00:00', weight: 175, reps: 5, estimated1RM: 204 }),
    ],
    ...over,
  }
}

// A typical session shape for the warmup toggle: three ramp-up sets then
// three working sets. buildWarmupSetIds only classifies sets BEFORE the
// session's top set (e1RM 200) that fall under 0.75 × 200 = 150, so exactly
// the first three are warmups and the last three survive the filter.
const SESSION_E1RMS = [50, 60, 70, 190, 200, 195]
const FOUR_DAYS = ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04']

function warmupHeavyExercise(days: string[]): Exercise {
  return prRichExercise({
    sets: days.flatMap((day) =>
      SESSION_E1RMS.map((e1rm, i) =>
        makeSet({
          id: `${day}-${i}`,
          date: `${day}T12:00:00`,
          weight: e1rm - 10,
          reps: 5,
          estimated1RM: e1rm,
        }),
      ),
    ),
  })
}

function mountModal(exerciseId: string | null = 'ex-1'): VueWrapper {
  return mount(ExerciseDetailModal, {
    props: { exerciseId },
    global: { stubs: { Teleport: true } },
  })
}

beforeEach(() => {
  mockExercises = []
})

describe('ExerciseDetailModal', () => {
  describe('visibility', () => {
    it('renders nothing when no exerciseId is set', () => {
      setExercises([prRichExercise()])
      const wrapper = mountModal(null)
      expect(wrapper.find('.repMaxOverlay').exists()).toBe(false)
    })

    it('renders nothing when the exerciseId matches no known exercise', () => {
      setExercises([prRichExercise()])
      const wrapper = mountModal('missing')
      expect(wrapper.find('.repMaxOverlay').exists()).toBe(false)
    })

    it('renders a labelled dialog titled with the exercise name', () => {
      setExercises([prRichExercise()])
      const wrapper = mountModal()
      const dialog = wrapper.find('.wtDetailModal')
      expect(dialog.attributes('role')).toBe('dialog')
      expect(dialog.attributes('aria-modal')).toBe('true')
      expect(dialog.attributes('aria-labelledby')).toBe('detail-modal-title')
      expect(wrapper.find('#detail-modal-title').text()).toBe('Bench Press')
    })

    it('surfaces the durable per-exercise note when present', () => {
      setExercises([prRichExercise({ notes: 'Pause at the chest' })])
      const wrapper = mountModal()
      expect(wrapper.find('.wtDetailNote').text()).toBe('Pause at the chest')
    })

    it('omits the note paragraph when the exercise has no note', () => {
      setExercises([prRichExercise()])
      const wrapper = mountModal()
      expect(wrapper.find('.wtDetailNote').exists()).toBe(false)
    })
  })

  describe('All Sets tab', () => {
    it('shows the set count and renders each set row with weight × reps and e1RM', () => {
      setExercises([prRichExercise()])
      const wrapper = mountModal()
      expect(wrapper.find('.wtDetailTabCount').text()).toBe('3')
      const rows = wrapper.findAll('.wtSetRow')
      expect(rows).toHaveLength(3)
      // Sorted most-recent-first: the top row is the Feb 1 set.
      expect(rows[0].find('.wtSetDetail').text()).toBe('175 lbs × 5')
      expect(rows[0].find('.wtSet1RM').text()).toContain('~204 lbs')
    })

    it('marks the current-PR set with a trophy and none of the others', () => {
      setExercises([prRichExercise()])
      const wrapper = mountModal()
      const trophies = wrapper.findAll('.wtSetPR')
      expect(trophies).toHaveLength(1)
      // The trophy lives in the top (Feb 1, e1RM 204) row.
      const rows = wrapper.findAll('.wtSetRow')
      expect(rows[0].find('.wtSetPR').exists()).toBe(true)
    })

    it('shows the empty state when the exercise has no sets', () => {
      setExercises([prRichExercise({ sets: [] })])
      const wrapper = mountModal()
      expect(wrapper.find('.wtSetEmpty').text()).toBe('No sets logged yet.')
    })

    // ── Row disclosure keyboard reachability (LIFT-1349) ─────────────
    // This row and the timeline's are the only way to edit or delete a logged
    // set, and both were bare `<div @click>`s: no role, no tabindex, no key
    // handler. A keyboard or switch-control user could log sets all day and
    // then never correct or remove one — WCAG 2.1.1, Level A, with no
    // alternative path anywhere in the app. Existing row tests only ever
    // trigger('click'), so the gap was invisible to them by construction.
    describe('set row disclosure (LIFT-1349)', () => {
      it('is a real <button>, so Enter and Space come from the platform', () => {
        setExercises([prRichExercise()])
        const wrapper = mountModal()
        const trigger = wrapper.findAll('.wtSetRowMain')[0]
        expect(trigger.element.tagName).toBe('BUTTON')
        expect(trigger.attributes('type')).toBe('button')
        // The row is a plain container: it must not carry the click itself,
        // or the trigger is decorative and the keyboard path is fake.
        expect(wrapper.findAll('.wtSetRow')[0].attributes('role')).toBeUndefined()
      })

      it('carries aria-expanded reflecting whether the actions are shown', async () => {
        setExercises([prRichExercise()])
        const wrapper = mountModal()
        expect(wrapper.findAll('.wtSetRowMain')[0].attributes('aria-expanded')).toBe('false')

        await wrapper.findAll('.wtSetRowMain')[0].trigger('click')
        expect(wrapper.findAll('.wtSetRowMain')[0].attributes('aria-expanded')).toBe('true')
      })

      it('names the row with the day it belongs to, which its text never states', () => {
        // The date lives in an unassociated `.wtSetDateHeader` above the card,
        // so without this a screen reader cannot tell one day's sets apart.
        setExercises([prRichExercise()])
        const wrapper = mountModal()
        const label = wrapper.findAll('.wtSetRowMain')[0].attributes('aria-label') ?? ''
        expect(label).toContain('175')
        expect(label).toContain('lbs')
        expect(label).toContain(wrapper.findAll('.wtSetDateHeader')[0].text())
        // Static per row — the state belongs to aria-expanded (LIFT-1308).
        expect(label).not.toMatch(/expand|collapse|show|hide/i)
      })

      it('keeps Edit and Delete as siblings of the trigger, never inside it', async () => {
        // A button role is children-presentational, so action buttons nested
        // in the trigger drop out of the accessibility tree entirely.
        setExercises([prRichExercise()])
        const wrapper = mountModal()
        await wrapper.findAll('.wtSetRowMain')[0].trigger('click')

        expect(wrapper.find('.wtSetRowMain .wtSetBtn').exists()).toBe(false)
        expect(wrapper.findAll('.wtSetRow > .wtSetActions .wtSetBtn')).toHaveLength(2)
      })

      it('has no axe violations with a row expanded', async () => {
        // axe is blind to the original defect — a missing key handler is a
        // behaviour, not an attribute. This pins the other half: that the fix
        // did not reach for a `role="button"` row, whose nested Edit/Delete
        // buttons axe rejects as `nested-interactive`.
        setExercises([prRichExercise()])
        const wrapper = mountModal()
        await wrapper.findAll('.wtSetRowMain')[0].trigger('click')

        const results = await runComponentAxe(wrapper.find('.wtSetList').element)
        expect(results).toHaveNoViolations()
      })
    })

    it('groups sets under a per-day date header', () => {
      setExercises([prRichExercise()])
      const wrapper = mountModal()
      // Three sets on three distinct days → three date headers.
      expect(wrapper.findAll('.wtSetDateHeader')).toHaveLength(3)
    })
  })

  describe('warmup toggle', () => {
    it('renders the warmup toggle only when more than one set exists', () => {
      setExercises([
        prRichExercise({ id: 'solo', sets: [makeSet({ weight: 135, reps: 5, estimated1RM: 158 })] }),
      ])
      const wrapper = mountModal('solo')
      expect(wrapper.find('.wtWarmupToggle').exists()).toBe(false)
    })

    it('toggles the hide-warmups state, flipping its label and aria-checked', async () => {
      setExercises([prRichExercise()])
      const wrapper = mountModal()
      const toggle = wrapper.find('.wtWarmupToggle')
      expect(toggle.attributes('aria-checked')).toBe('false')
      expect(toggle.text()).toBe('Hide warmups')

      await toggle.trigger('click')
      expect(wrapper.find('.wtWarmupToggle').attributes('aria-checked')).toBe('true')
      expect(wrapper.find('.wtWarmupToggle').text()).toBe('Warmups hidden')
    })
  })

  describe('show-all gate', () => {
    it('shows the "show all" button only past SET_LIMIT (10) sets and expands on tap', async () => {
      const many = Array.from({ length: 12 }, (_, i) =>
        makeSet({
          id: `m-${i}`,
          // Distinct days so each set is its own group; day index padded.
          date: `2026-03-${String(i + 1).padStart(2, '0')}T12:00:00`,
          weight: 100 + i,
          reps: 5,
          estimated1RM: 120 + i,
        }),
      )
      setExercises([prRichExercise({ sets: many })])
      const wrapper = mountModal()

      // Capped at SET_LIMIT until expanded.
      expect(wrapper.findAll('.wtSetRow')).toHaveLength(10)
      const btn = wrapper.find('.wtShowAllBtn')
      expect(btn.text()).toBe('Show all 12 sets')

      await btn.trigger('click')
      expect(wrapper.findAll('.wtSetRow')).toHaveLength(12)
      expect(wrapper.find('.wtShowAllBtn').text()).toBe('Show less')
    })

    it('does not render the show-all button at or below SET_LIMIT', () => {
      setExercises([prRichExercise()])
      const wrapper = mountModal()
      expect(wrapper.find('.wtShowAllBtn').exists()).toBe(false)
    })
  })

  // #1274 — the display limit must be applied to the sets the list can
  // actually render. Slicing first and filtering warmups after dropped
  // working sets that belong inside the limit, and left the "Show all"
  // control advertising a total the list would never reach.
  describe('show-all gate with warmups hidden', () => {
    it('fills the limit with working sets instead of spending it on hidden warmups', async () => {
      setExercises([warmupHeavyExercise(FOUR_DAYS)])
      const wrapper = mountModal()
      // Baseline: unfiltered, the limit is spent on all 24 sets.
      expect(wrapper.findAll('.wtSetRow')).toHaveLength(10)

      await wrapper.find('.wtWarmupToggle').trigger('click')
      // 12 working sets exist, so the limit is still reachable in full.
      expect(wrapper.findAll('.wtSetRow')).toHaveLength(10)
    })

    it('counts only working sets in the "Show all N sets" label', async () => {
      setExercises([warmupHeavyExercise(FOUR_DAYS)])
      const wrapper = mountModal()
      expect(wrapper.find('.wtShowAllBtn').text()).toBe('Show all 24 sets')

      await wrapper.find('.wtWarmupToggle').trigger('click')
      expect(wrapper.find('.wtShowAllBtn').text()).toBe('Show all 12 sets')
    })

    it('expands to every working set — and no more — when show-all is tapped', async () => {
      setExercises([warmupHeavyExercise(FOUR_DAYS)])
      const wrapper = mountModal()
      await wrapper.find('.wtWarmupToggle').trigger('click')
      await wrapper.find('.wtShowAllBtn').trigger('click')

      expect(wrapper.findAll('.wtSetRow')).toHaveLength(12)
      expect(wrapper.find('.wtShowAllBtn').text()).toBe('Show less')
    })

    it('hides the show-all control when the working sets all fit, despite a larger total', async () => {
      // 12 sets total (past SET_LIMIT) but only 6 working ones.
      setExercises([warmupHeavyExercise(['2026-03-01', '2026-03-02'])])
      const wrapper = mountModal()
      expect(wrapper.find('.wtShowAllBtn').exists()).toBe(true)

      await wrapper.find('.wtWarmupToggle').trigger('click')
      expect(wrapper.find('.wtShowAllBtn').exists()).toBe(false)
      expect(wrapper.findAll('.wtSetRow')).toHaveLength(6)
    })
  })

  describe('PRs tab', () => {
    it('hides the PRs tab when there is one or zero distinct PR days', () => {
      setExercises([
        prRichExercise({
          id: 'flat',
          sets: [makeSet({ weight: 135, reps: 5, estimated1RM: 158 })],
        }),
      ])
      const wrapper = mountModal('flat')
      const tabs = wrapper.findAll('.wtDetailTab')
      expect(tabs).toHaveLength(1)
      expect(tabs[0].text()).toContain('All Sets')
    })

    it('switches to the PRs tab and renders a card per PR with the current badge', async () => {
      setExercises([prRichExercise()])
      const wrapper = mountModal()
      const prTab = wrapper.findAll('.wtDetailTab').find((t) => t.text().includes('PRs'))!
      expect(prTab).toBeTruthy()

      await prTab.trigger('click')
      const cards = wrapper.findAll('.wtPRCard')
      expect(cards).toHaveLength(3)
      // Newest-first: the current PR (204) is on top and carries the badge.
      expect(cards[0].classes()).toContain('wtPRCardCurrent')
      expect(cards[0].find('.wtPRCardBadge').text()).toBe('Current')
      expect(cards[0].find('.wtPRCardValue').text()).toContain('175')
      // Only the current card gets the Current badge.
      expect(wrapper.findAll('.wtPRCardBadge')).toHaveLength(1)
    })

    it('resets to the All Sets tab when the exercise prop changes', async () => {
      setExercises([prRichExercise(), prRichExercise({ id: 'ex-2', name: 'Squat' })])
      const wrapper = mountModal()
      const prTab = wrapper.findAll('.wtDetailTab').find((t) => t.text().includes('PRs'))!
      await prTab.trigger('click')
      expect(wrapper.findAll('.wtPRCard').length).toBeGreaterThan(0)

      await wrapper.setProps({ exerciseId: 'ex-2' })
      await nextTick()
      // Back on All Sets: PR cards are gone, set rows are shown.
      expect(wrapper.findAll('.wtPRCard')).toHaveLength(0)
      expect(wrapper.findAll('.wtSetRow').length).toBeGreaterThan(0)
    })
  })

  describe('emits', () => {
    it('emits close from the Back button', async () => {
      setExercises([prRichExercise()])
      const wrapper = mountModal()
      await wrapper.find('.wtDetailBack').trigger('click')
      expect(wrapper.emitted('close')).toHaveLength(1)
    })

    it('emits open-edit-exercise with the exercise from the edit button', async () => {
      const ex = prRichExercise()
      setExercises([ex])
      const wrapper = mountModal()
      await wrapper.find('.wtDetailEditBtn').trigger('click')
      expect(wrapper.emitted('open-edit-exercise')![0]).toEqual([ex])
    })

    it('emits open-log-set with the exercise id from the footer button', async () => {
      setExercises([prRichExercise()])
      const wrapper = mountModal()
      await wrapper.find('.wtDetailFooterBtn').trigger('click')
      expect(wrapper.emitted('open-log-set')![0]).toEqual(['ex-1'])
    })

    it('reveals per-set actions on tap and emits edit-set / delete-set', async () => {
      const ex = prRichExercise()
      setExercises([ex])
      const wrapper = mountModal()

      const topRow = wrapper.findAll('.wtSetRow')[0]
      expect(topRow.find('.wtSetActions').exists()).toBe(false)
      await topRow.find('.wtSetRowMain').trigger('click')
      expect(wrapper.findAll('.wtSetRow')[0].find('.wtSetActions').exists()).toBe(true)

      await wrapper.find('.wtSetActions button[aria-label="Edit set"]').trigger('click')
      expect(wrapper.emitted('edit-set')![0][0]).toEqual(ex)
      expect((wrapper.emitted('edit-set')![0][1] as WorkoutSet).id).toBe('s-3')

      await wrapper.find('.wtSetActions button[aria-label="Delete set"]').trigger('click')
      expect(wrapper.emitted('delete-set')![0][0]).toBe('ex-1')
      expect((wrapper.emitted('delete-set')![0][1] as WorkoutSet).id).toBe('s-3')
    })
  })

  /**
   * LIFT-1373 — a set's load reads in ADDED-space words on a bodyweight-loaded
   * exercise. Every fixture above uses a positive weight on an unflagged
   * exercise, which is exactly why the contradiction (a "0 lbs" row beside an
   * e1RM computed off the folded load) was never visible to this suite.
   */
  describe('bodyweight-loaded set rows (LIFT-1373)', () => {
    // A weighted PR, then a pure-bodyweight one that beats it — two ascending
    // PR entries, so the PRs tab renders too.
    function pullUpExercise(): Exercise {
      return {
        id: 'ex-1',
        name: 'Pull-Up',
        tags: ['Back'],
        bodyweightLoaded: true,
        sets: [
          makeSet({ id: 'bw-1', date: '2026-01-01T12:00:00', weight: 25, reps: 5, estimated1RM: 227, bodyweight: 170 }),
          makeSet({ id: 'bw-2', date: '2026-01-08T12:00:00', weight: 0, reps: 12, estimated1RM: 238, bodyweight: 170 }),
        ],
      }
    }

    it('reads a pure-bodyweight set as "Bodyweight", not "0 lbs"', () => {
      setExercises([pullUpExercise()])
      const wrapper = mountModal()
      // Newest-first: the bodyweight-only set leads, the weighted set follows.
      const rows = wrapper.findAll('.wtSetDetail').map((r) => r.text())
      expect(rows).toEqual(['Bodyweight × 12', '+25 lbs × 5'])
      expect(rows.join(' ')).not.toContain('0 lbs')
    })

    it('gives each row an accessible name matching its visible text', () => {
      setExercises([pullUpExercise()])
      const wrapper = mountModal()
      const triggers = wrapper.findAll('.wtSetRowMain')
      const details = wrapper.findAll('.wtSetDetail')
      triggers.forEach((trigger, i) => {
        expect(trigger.attributes('aria-label')).toContain(details[i].text())
      })
      expect(triggers[0].attributes('aria-label')).toContain('Bodyweight × 12')
    })

    it('keeps "0 lbs" for a flagged set that folded nothing in', () => {
      // Logged before the flag was turned on (no captured bodyweight), so the
      // stored e1RM is off the bare weight — claiming "Bodyweight" here would
      // contradict the number rendered beside it.
      setExercises([
        {
          id: 'ex-1',
          name: 'Pull-Up',
          tags: [],
          bodyweightLoaded: true,
          sets: [makeSet({ id: 'pre-flag', weight: 0, reps: 12, estimated1RM: 0 })],
        },
      ])
      const wrapper = mountModal()
      expect(wrapper.find('.wtSetDetail').text()).toBe('0 lbs × 12')
    })

    it('names the PR card the same way, keeping the unit styled separately', async () => {
      setExercises([pullUpExercise()])
      const wrapper = mountModal()
      const prTab = wrapper.findAll('.wtDetailTab').find((t) => t.text().includes('PRs'))!
      await prTab.trigger('click')
      const cards = wrapper.findAll('.wtPRCard')
      // Current PR first: the 238 e1RM pure-bodyweight set.
      expect(cards[0].find('.wtPRCardValue').text()).toContain('Bodyweight')
      expect(cards[0].find('.wtPRCardValue').text()).not.toContain('0 lbs')
      // The word carries no unit, so the unit span drops rather than rendering
      // a dangling "lbs" after it.
      expect(cards[0].find('.wtPRCardUnit').exists()).toBe(false)
      // A weighted PR still styles its unit apart from the number.
      expect(cards[1].find('.wtPRCardValue').text()).toContain('+25')
      expect(cards[1].find('.wtPRCardUnit').text()).toBe('lbs')
    })
  })
})

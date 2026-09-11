/**
 * WorkoutTimeline — how a logged set reads back (LIFT-1373).
 *
 * The timeline is the app's all-exercise history surface, and it flattens each
 * set away from its exercise into a `TimelineEntry`. It rendered `set.weight`
 * bare, so a pure-bodyweight set — added = 0 on a `bodyweightLoaded` exercise,
 * which LIFT-1330 finally made typeable and CSV import has produced all along —
 * read "0 lbs x 12" directly beside an e1RM computed off the folded load.
 *
 * Nothing caught it because every timeline fixture that had ever existed used a
 * positive weight on an unflagged exercise: the two fields that make the row
 * contradict itself were never both present.
 */
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import WorkoutTimeline from '../WorkoutTimeline.vue'
import type { Exercise, WorkoutSet } from '../../stores/workout'

const unit = { value: 'lbs' }

vi.mock('../../composables/useWeightUnit', () => ({
  useWeightUnit: () => ({
    weightUnit: unit,
    displayWeight: (w: number) => (unit.value === 'kg' ? +(w * 0.453592).toFixed(1) : +w.toFixed(1)),
    toLbs: (w: number) => w,
  }),
}))

function makeSet(partial: Partial<WorkoutSet>): WorkoutSet {
  return {
    id: 's-1',
    // endOfDayISO shape: the prefix IS the local day (#746).
    date: '2026-08-01T23:59:00.000Z',
    weight: 135,
    reps: 5,
    estimated1RM: 157.5,
    ...partial,
  }
}

function mountTimeline(exercises: Exercise[]) {
  return mount(WorkoutTimeline, {
    props: { exercises, prBaselineDate: null, warmupThreshold: 0.7 },
  })
}

describe('WorkoutTimeline set load (LIFT-1373)', () => {
  it('reads a pure-bodyweight set as "Bodyweight", not "0 lbs"', () => {
    const wrapper = mountTimeline([
      {
        id: 'ex-1',
        name: 'Pull-Up',
        tags: [],
        bodyweightLoaded: true,
        sets: [makeSet({ weight: 0, reps: 12, bodyweight: 170, estimated1RM: 238 })],
      },
    ])
    const row = wrapper.find('.wtTimelineSetDetail')
    expect(row.text()).toBe('Bodyweight × 12')
    expect(row.text()).not.toContain('0 lbs')
  })

  it('gives the accessible name the same words as the visible text', () => {
    // The visible text and the aria-label are separate strings at this call
    // site; before the shared formatter they were separate implementations too.
    const wrapper = mountTimeline([
      {
        id: 'ex-1',
        name: 'Pull-Up',
        tags: [],
        bodyweightLoaded: true,
        sets: [makeSet({ weight: 0, reps: 12, bodyweight: 170, estimated1RM: 238 })],
      },
    ])
    const visible = wrapper.find('.wtTimelineSetDetail').text()
    const label = wrapper.find('.wtTimelineRowMain').attributes('aria-label')
    expect(label).toBe('Pull-Up, Bodyweight × 12, personal record')
    expect(label).toContain(visible)
  })

  it('marks an added weight as added', () => {
    const wrapper = mountTimeline([
      {
        id: 'ex-1',
        name: 'Weighted Dip',
        tags: [],
        bodyweightLoaded: true,
        sets: [makeSet({ weight: 25, reps: 5, bodyweight: 160, estimated1RM: 215.8 })],
      },
    ])
    expect(wrapper.find('.wtTimelineSetDetail').text()).toBe('+25 lbs × 5')
    expect(wrapper.find('.wtTimelineRowMain').attributes('aria-label')).toContain('+25 lbs × 5')
  })

  it('leaves an ordinary barbell set exactly as it was', () => {
    const wrapper = mountTimeline([
      { id: 'ex-1', name: 'Bench Press', tags: [], sets: [makeSet({})] },
    ])
    expect(wrapper.find('.wtTimelineSetDetail').text()).toBe('135 lbs × 5')
  })

  it('keeps "0 lbs" for a flagged set that folded nothing in', () => {
    // No captured bodyweight (logged before the flag, or a lifter who has never
    // weighed in): the stored e1RM is off the bare weight, so claiming
    // "Bodyweight" would contradict the ~0 rendered beside it.
    const wrapper = mountTimeline([
      {
        id: 'ex-1',
        name: 'Pull-Up',
        tags: [],
        bodyweightLoaded: true,
        sets: [makeSet({ weight: 0, reps: 12, bodyweight: undefined, estimated1RM: 0 })],
      },
    ])
    expect(wrapper.find('.wtTimelineSetDetail').text()).toBe('0 lbs × 12')
  })

  it('converts the added portion for a kg user', () => {
    unit.value = 'kg'
    try {
      const wrapper = mountTimeline([
        {
          id: 'ex-1',
          name: 'Weighted Dip',
          tags: [],
          bodyweightLoaded: true,
          sets: [makeSet({ weight: 25, reps: 5, bodyweight: 160, estimated1RM: 215.8 })],
        },
        {
          id: 'ex-2',
          name: 'Pull-Up',
          tags: [],
          bodyweightLoaded: true,
          sets: [makeSet({ id: 's-2', weight: 0, reps: 12, bodyweight: 170, estimated1RM: 238 })],
        },
      ])
      const rows = wrapper.findAll('.wtTimelineSetDetail').map(r => r.text())
      expect(rows).toContain('+11.3 kg × 5')
      // Unit-free by construction — nothing to mis-convert (LIFT-1315).
      expect(rows).toContain('Bodyweight × 12')
    } finally {
      unit.value = 'lbs'
    }
  })
})

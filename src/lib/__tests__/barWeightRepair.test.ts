/**
 * The bar-weight repair's safety rests on an arithmetic coincidence, so the
 * coincidence is what gets pinned here (LIFT-1398).
 *
 * Clearing a stored 45 is only lossless because 45 IS `defaultBarWeight('lbs')`
 * and because `convertBarWeight` snaps a 45 lb bar to the 20 kg one that IS
 * `defaultBarWeight('kg')`. Change `STANDARD_BARS_LBS`/`STANDARD_BARS_KG` and
 * that stops being true — the repair would start deleting a value the fallback
 * no longer reproduces, silently, on every device. The behavioural half lives in
 * `workoutBarWeightRepair.test.ts`, which drives the real fetch pipeline.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { getLocalStorageMock } from '../../__tests__/helpers'
import {
  BAR_WEIGHT_REPAIR_KEY,
  isBarWeightRepairDone,
  markBarWeightRepairDone,
  repairMaterializedBarWeights,
} from '../barWeightRepair'
import { convertBarWeight, defaultBarWeight } from '../plateCalculator'
import type { Exercise } from '../../stores/workout'

const localStorageMock = getLocalStorageMock()

function exercise(overrides: Partial<Exercise> = {}): Exercise {
  return { id: 'ex-1', name: 'Bench Press', tags: [], sets: [], ...overrides }
}

describe('barWeightRepair', () => {
  beforeEach(() => {
    localStorageMock.clear()
    vi.clearAllMocks()
  })

  describe('the value it clears is the one the fallback reproduces', () => {
    it('45 is the lbs default, so an lbs user loses nothing', () => {
      expect(defaultBarWeight('lbs')).toBe(45)
    })

    it('and it converts to the kg default, so a unit toggle lands on the same bar', () => {
      // This is the leg that makes a BLANKET repair safe rather than one scoped
      // to kg accounts — which would leave every lbs user broken the moment they
      // toggled to kg.
      expect(convertBarWeight(defaultBarWeight('lbs'), 'lbs', 'kg')).toBe(defaultBarWeight('kg'))
      expect(convertBarWeight(defaultBarWeight('kg'), 'kg', 'lbs')).toBe(defaultBarWeight('lbs'))
    })
  })

  describe('repairMaterializedBarWeights', () => {
    it('clears the materialized bar and reports how many it touched', () => {
      const list = [exercise({ barWeight: 45 }), exercise({ id: 'ex-2', barWeight: 45 })]

      expect(repairMaterializedBarWeights(list)).toBe(2)
      // Absent, not zero: `?? defaultBarWeight(unit)` is what has to fire, and a
      // stored 0 would read as a bar-less lift instead.
      expect('barWeight' in list[0]).toBe(false)
      expect(list[1].barWeight).toBeUndefined()
    })

    it('leaves every other bar weight alone, including an unset one', () => {
      const list = [
        exercise({ barWeight: 20 }),
        exercise({ id: 'ex-2', barWeight: 15 }),
        exercise({ id: 'ex-3' }),
        exercise({ id: 'ex-4', barWeight: 44.5 }),
      ]

      expect(repairMaterializedBarWeights(list)).toBe(0)
      expect(list.map(e => e.barWeight)).toEqual([20, 15, undefined, 44.5])
    })

    it('does not touch updated_at — a derived repair must not out-rank a real edit', () => {
      // 2026-04-12 SEV1, and the reason the migration suppressed its trigger:
      // bumping the stamp would win a later last-write-wins merge as though the
      // user had made the change.
      const stamp = '2026-09-01T10:00:00.000Z'
      const list = [exercise({ barWeight: 45, updated_at: stamp })]

      repairMaterializedBarWeights(list)
      expect(list[0].updated_at).toBe(stamp)
    })

    it('mutates in place, because the store holds exercises in a shallowRef', () => {
      const target = exercise({ barWeight: 45 })
      const list = [target]

      repairMaterializedBarWeights(list)
      expect(list[0]).toBe(target)
      expect(target.barWeight).toBeUndefined()
    })

    it('is idempotent', () => {
      const list = [exercise({ barWeight: 45 })]

      expect(repairMaterializedBarWeights(list)).toBe(1)
      expect(repairMaterializedBarWeights(list)).toBe(0)
    })
  })

  describe('the one-shot flag', () => {
    it('starts unset and records completion', () => {
      expect(isBarWeightRepairDone()).toBe(false)
      markBarWeightRepairDone()
      expect(isBarWeightRepairDone()).toBe(true)
      expect(localStorageMock.getItem(BAR_WEIGHT_REPAIR_KEY)).toBe('true')
    })

    it('reports "not done" when localStorage throws, so the pass simply retries', () => {
      // A blocked/full localStorage must not take the store down. Re-running is
      // harmless, which is the whole reason this can fail open.
      const spy = vi.spyOn(localStorageMock, 'getItem').mockImplementation(() => {
        throw new DOMException('denied', 'SecurityError')
      })
      expect(isBarWeightRepairDone()).toBe(false)
      spy.mockRestore()
    })

    it('does not throw when the completion write fails', () => {
      const spy = vi.spyOn(localStorageMock, 'setItem').mockImplementation(() => {
        throw new DOMException('quota', 'QuotaExceededError')
      })
      expect(() => markBarWeightRepairDone()).not.toThrow()
      spy.mockRestore()
    })
  })
})

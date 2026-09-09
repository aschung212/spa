import { describe, it, expect } from 'vitest'
import {
  addedWeightFromEffective,
  allowsZeroWeight,
  bodyweightFold,
  effectiveSetWeight,
  formatSetLoad,
  isLoggableWeight,
  setLoadParts,
} from '../bodyweightLoad'
import type { WorkoutSet } from '../../stores/workout'

function set(partial: Partial<WorkoutSet>): WorkoutSet {
  return { id: 's', date: '2026-08-01T23:59:00.000Z', weight: 25, reps: 8, estimated1RM: 0, ...partial }
}

describe('effectiveSetWeight (LIFT-834)', () => {
  it('returns the bare weight for a normal exercise', () => {
    expect(effectiveSetWeight(set({ weight: 135 }), { bodyweightLoaded: false })).toBe(135)
  })

  it('returns the bare weight when no exercise context is given', () => {
    expect(effectiveSetWeight(set({ weight: 135 }))).toBe(135)
    expect(effectiveSetWeight(set({ weight: 135 }), null)).toBe(135)
  })

  it('folds captured bodyweight into the load for a bodyweight-loaded exercise', () => {
    expect(effectiveSetWeight(set({ weight: 25, bodyweight: 160 }), { bodyweightLoaded: true })).toBe(185)
  })

  it('gives pure-bodyweight reps (added = 0) full credit', () => {
    expect(effectiveSetWeight(set({ weight: 0, bodyweight: 170 }), { bodyweightLoaded: true })).toBe(170)
  })

  it('degrades to the added weight when the flag is on but no bodyweight was captured', () => {
    // A set logged before the exercise was flagged and never edited: fold in
    // nothing rather than guessing a zero-bodyweight or NaN.
    expect(effectiveSetWeight(set({ weight: 25, bodyweight: undefined }), { bodyweightLoaded: true })).toBe(25)
  })

  it('ignores a captured bodyweight while the flag is off', () => {
    expect(effectiveSetWeight(set({ weight: 25, bodyweight: 160 }), { bodyweightLoaded: false })).toBe(25)
  })
})

describe('bodyweightFold (#1328)', () => {
  it('is zero for a normal exercise, whatever bodyweight is offered', () => {
    expect(bodyweightFold({ bodyweightLoaded: false }, 160)).toBe(0)
    expect(bodyweightFold(null, 160)).toBe(0)
    expect(bodyweightFold(undefined, 160)).toBe(0)
  })

  it('is the bodyweight for a bodyweight-loaded exercise', () => {
    expect(bodyweightFold({ bodyweightLoaded: true }, 160)).toBe(160)
  })

  it('degrades to zero rather than guessing on an unusable bodyweight', () => {
    // Nothing captured / never tracked / corrupt — fold in nothing, exactly as
    // `effectiveSetWeight` has always done for a set with no capture.
    expect(bodyweightFold({ bodyweightLoaded: true }, undefined)).toBe(0)
    expect(bodyweightFold({ bodyweightLoaded: true }, null)).toBe(0)
    expect(bodyweightFold({ bodyweightLoaded: true }, 0)).toBe(0)
    expect(bodyweightFold({ bodyweightLoaded: true }, -160)).toBe(0)
    expect(bodyweightFold({ bodyweightLoaded: true }, NaN)).toBe(0)
  })
})

describe('addedWeightFromEffective (#1328)', () => {
  it('inverts effectiveSetWeight exactly', () => {
    const exercise = { bodyweightLoaded: true }
    const effective = effectiveSetWeight(set({ weight: 25, bodyweight: 160 }), exercise)
    expect(addedWeightFromEffective(effective, exercise, 160)).toBe(25)
  })

  it('is the identity for a normal exercise', () => {
    expect(addedWeightFromEffective(185, { bodyweightLoaded: false }, 160)).toBe(185)
    expect(addedWeightFromEffective(185)).toBe(185)
  })

  it('returns a non-positive number when bodyweight alone already covers the target', () => {
    // Real state, not an error: 12 bodyweight pull-ups beat a +25 x 5. Left
    // unclamped so callers can tell "add nothing" from "load 0".
    expect(addedWeightFromEffective(154.6, { bodyweightLoaded: true }, 160)).toBeCloseTo(-5.4, 5)
  })

  it('folds nothing back out when nothing was folded in', () => {
    // A flagged exercise on a lifter with no tracked bodyweight: both directions
    // are the identity, so a suggestion is still self-consistent.
    const exercise = { bodyweightLoaded: true }
    const effective = effectiveSetWeight(set({ weight: 25, bodyweight: undefined }), exercise)
    expect(addedWeightFromEffective(effective, exercise, undefined)).toBe(25)
  })
})

describe('isLoggableWeight (LIFT-1330)', () => {
  it('accepts 0 on a bodyweight-loaded exercise', () => {
    // The set this whole module exists for: a plain pull-up, added nothing.
    expect(isLoggableWeight(0, { bodyweightLoaded: true })).toBe(true)
    expect(allowsZeroWeight({ bodyweightLoaded: true })).toBe(true)
  })

  it('rejects 0 everywhere else', () => {
    // A 0 lb barbell set carries no information — the floor only moves for the
    // exercise whose weight field means "added".
    expect(isLoggableWeight(0, { bodyweightLoaded: false })).toBe(false)
    expect(isLoggableWeight(0)).toBe(false)
    expect(isLoggableWeight(0, null)).toBe(false)
    expect(allowsZeroWeight({ bodyweightLoaded: false })).toBe(false)
    expect(allowsZeroWeight()).toBe(false)
  })

  it('keeps an unfilled field distinct from an explicit 0', () => {
    // null/undefined is "not entered", which is what keeps the to-beat card
    // alive; only a real number clears the floor.
    expect(isLoggableWeight(null, { bodyweightLoaded: true })).toBe(false)
    expect(isLoggableWeight(undefined, { bodyweightLoaded: true })).toBe(false)
    expect(isLoggableWeight(NaN, { bodyweightLoaded: true })).toBe(false)
    expect(isLoggableWeight(Infinity, { bodyweightLoaded: true })).toBe(false)
  })

  it('rejects a negative weight even on a bodyweight-loaded exercise', () => {
    // `addedWeightFromEffective` can hand back a negative ("bodyweight alone
    // beats this"), and that is a message, never a set.
    expect(isLoggableWeight(-5, { bodyweightLoaded: true })).toBe(false)
  })

  it('passes ordinary positive weights through unchanged', () => {
    expect(isLoggableWeight(135, { bodyweightLoaded: false })).toBe(true)
    expect(isLoggableWeight(2.5, { bodyweightLoaded: true })).toBe(true)
  })
})

describe('formatSetLoad (LIFT-1373)', () => {
  // Display-unit converters matching `useWeightUnit`, so the formatter is
  // exercised in the two spaces the app actually renders in.
  const lbs = { displayWeight: (v: number) => +v.toFixed(1), unit: 'lbs' }
  const kg = { displayWeight: (v: number) => +(v * 0.453592).toFixed(1), unit: 'kg' }

  it('names the load "Bodyweight" when the lifter added nothing', () => {
    // The defect: this row read "0 lbs x 12" beside a ~224 lb e1RM computed
    // off the folded load — one row saying the lifter moved nothing.
    expect(formatSetLoad(set({ weight: 0, bodyweight: 170 }), { bodyweightLoaded: true }, lbs))
      .toBe('Bodyweight')
  })

  it('marks a non-zero added weight with a "+"', () => {
    expect(formatSetLoad(set({ weight: 25, bodyweight: 160 }), { bodyweightLoaded: true }, lbs))
      .toBe('+25 lbs')
  })

  it('renders an ordinary exercise exactly as before', () => {
    expect(formatSetLoad(set({ weight: 135 }), { bodyweightLoaded: false }, lbs)).toBe('135 lbs')
    expect(formatSetLoad(set({ weight: 135 }), null, lbs)).toBe('135 lbs')
    expect(formatSetLoad(set({ weight: 135 }), undefined, lbs)).toBe('135 lbs')
  })

  it('keys on the fold actually applied, not on the flag alone', () => {
    // A set logged before the flag was turned on folds in nothing, so its
    // stored e1RM is off the bare weight. Saying "Bodyweight" here would claim
    // a bodyweight the set never recorded — and contradict the ~0 e1RM beside
    // it. The label always describes what the neighbouring e1RM came from.
    expect(formatSetLoad(set({ weight: 0, bodyweight: undefined }), { bodyweightLoaded: true }, lbs))
      .toBe('0 lbs')
    expect(formatSetLoad(set({ weight: 25, bodyweight: undefined }), { bodyweightLoaded: true }, lbs))
      .toBe('25 lbs')
  })

  it('converts the added portion into the display unit', () => {
    // "Bodyweight" is unit-free by construction, which is half of why the word
    // is right: there is no number to convert or mis-space (LIFT-1315).
    expect(formatSetLoad(set({ weight: 25, bodyweight: 160 }), { bodyweightLoaded: true }, kg))
      .toBe('+11.3 kg')
    expect(formatSetLoad(set({ weight: 0, bodyweight: 160 }), { bodyweightLoaded: true }, kg))
      .toBe('Bodyweight')
  })

  it('does not prefix a "+" onto a negative added weight', () => {
    // `isLoggableWeight` refuses these at entry, but a hand-edited or imported
    // row must still read as a number rather than "+-5".
    expect(formatSetLoad(set({ weight: -5, bodyweight: 160 }), { bodyweightLoaded: true }, lbs))
      .toBe('-5 lbs')
  })

  it('splits into parts that rejoin into the same string', () => {
    // `setLoadParts` exists for the PR card, which styles the unit separately.
    // Both shapes come from one decision, so they cannot disagree about
    // whether a set was bodyweight-only.
    const bw = set({ weight: 0, bodyweight: 170 })
    const added = set({ weight: 25, bodyweight: 170 })
    const plain = set({ weight: 135 })
    const cases = [
      [bw, { bodyweightLoaded: true }],
      [added, { bodyweightLoaded: true }],
      [plain, { bodyweightLoaded: false }],
    ] as const
    for (const [s, ex] of cases) {
      const parts = setLoadParts(s, ex, lbs)
      const rejoined = parts.unit ? parts.value + ' ' + parts.unit : parts.value
      expect(rejoined).toBe(formatSetLoad(s, ex, lbs))
    }
    expect(setLoadParts(bw, { bodyweightLoaded: true }, lbs)).toEqual({ value: 'Bodyweight', unit: null })
    expect(setLoadParts(plain, null, lbs)).toEqual({ value: '135', unit: 'lbs' })
  })
})

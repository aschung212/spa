import { describe, it, expect } from 'vitest'
import {
  addedWeightFromEffective,
  allowsZeroWeight,
  bodyweightFold,
  effectiveSetWeight,
  isLoggableWeight,
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

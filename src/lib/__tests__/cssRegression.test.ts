/// <reference types="node" />
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { resolve, relative } from 'path'

const css = readFileSync(resolve(__dirname, '../../index.css'), 'utf-8')

/**
 * Regression tests for CSS bugs caught during manual testing.
 * These verify structural properties of the CSS to prevent
 * accidental moves/deletions during future edits.
 */

// Helper: extract lines between a selector and its closing brace
function getRuleLines(selector: string, source = css): string[] {
  // Match the selector at the start of a line to avoid matching it inside another selector
  const needle = '\n' + selector + ' {'
  const idx = source.indexOf(needle)
  if (idx === -1) return []
  const start = source.indexOf('{', idx) + 1
  let depth = 1
  let end = start
  while (depth > 0 && end < source.length) {
    if (source[end] === '{') depth++
    if (source[end] === '}') depth--
    end++
  }
  return source.slice(start, end - 1).split('\n').map((l: string) => l.trim()).filter(Boolean)
}

// Helper: extract the <style> block from a Vue SFC
function getVueStyleBlock(componentPath: string): string {
  const content = readFileSync(resolve(__dirname, '../../components', componentPath), 'utf-8')
  const match = content.match(/<style[^>]*>([\s\S]*?)<\/style>/)
  return match ? match[1] : ''
}

// Helper: every .vue file under src/, recursively. The flat readdirSync walks
// elsewhere in this file only ever look at src/components, which silently skips
// src/views, src/components/share/cards and src/App.vue.
//
// Paths come back with forward slashes on every platform. `resolve` emits the
// native separator, so on Windows the non-vacuity guard's `includes('/views/')`
// and `includes('/share/')` checks matched nothing and the guard failed there
// while passing on Linux CI. Normalizing at the source keeps every consumer —
// the guard, and the `relative()` offender messages — separator-agnostic.
function collectVueFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__') continue
    const full = resolve(dir, entry.name).replace(/\\/g, '/')
    if (entry.isDirectory()) out.push(...collectVueFiles(full))
    else if (entry.name.endsWith('.vue')) out.push(full)
  }
  return out.sort()
}

// Helper: concatenate every <style> block in an SFC. matchAll, not match — a
// component may carry several (e.g. a scoped block alongside a global one).
function allVueStyleBlocks(content: string): string {
  let style = ''
  for (const m of content.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) style += m[1] + '\n'
  return style
}

describe('CSS regression tests', () => {
  describe('viewport-height unit convention (LIFT-1099)', () => {
    // Full-height/max-height surfaces must all use `svh` (smallest viewport
    // height). svh always fits regardless of browser-chrome state, so a nested
    // surface can never exceed the 100svh #app shell and get clipped, nor jump
    // when the URL bar collapses. `dvh`/`lvh`/bare `vh` are larger and are the
    // exact overflow risk this convention forbids. Any `<number>vh` token in a
    // property value must be prefixed with `s` (i.e. `svh`).
    it('uses only svh for every viewport-height value', () => {
      // Match a numeric length followed by an optional s/d/l prefix and `vh`
      // (svh, dvh, lvh, or bare vh — all forbidden except svh).
      const matches = css.match(/\d+(?:\.\d+)?(?:s|d|l)?vh\b/g) ?? []
      expect(matches.length, 'expected viewport-height units to exist').toBeGreaterThan(0)
      const offenders = matches.filter(m => !/svh\b/.test(m))
      expect(
        offenders,
        `non-svh viewport-height units found (use svh — see LIFT-1099): ${offenders.join(', ')}`
      ).toEqual([])
    })

    it('sizes the #app shell in svh', () => {
      const lines = getRuleLines('#app')
      expect(lines.some(l => l.startsWith('height: 100svh'))).toBe(true)
    })
  })

  describe('.tabContent base rule', () => {
    const lines = getRuleLines('.tabContent')

    // Regression: padding was accidentally moved to .modal-open override,
    // breaking scroll on the main exercise list (PR #37)
    it('has padding-top', () => {
      expect(lines.some(l => l.startsWith('padding-top'))).toBe(true)
    })

    it('has padding-bottom for tab bar clearance', () => {
      expect(lines.some(l => l.startsWith('padding-bottom'))).toBe(true)
    })

    it('has overflow-y: auto for scrolling', () => {
      expect(lines.some(l => l.includes('overflow-y') && l.includes('auto'))).toBe(true)
    })

    // Regression: keyboard/screen-reader focus must clear the fixed tab bar
    // (WCAG 2.2 SC 2.4.11 Focus Not Obscured). Without scroll-padding-bottom the
    // browser scrolls focused rows flush to the viewport edge, tucking them
    // under the floating glass bar (LIFT-681).
    it('has scroll-padding-bottom so focus clears the fixed tab bar', () => {
      const rule = lines.find(l => l.startsWith('scroll-padding-bottom'))
      expect(rule).toBeTruthy()
      // Must account for the safe-area inset on notched devices
      expect(rule).toContain('safe-area-inset-bottom')
    })
  })

  describe('html.modal-open .tabContent override', () => {
    const lines = getRuleLines('html.modal-open .tabContent')

    // Regression: must lock scroll on the container, not the overlay (PR #27)
    it('sets overflow: hidden to lock scroll', () => {
      expect(lines.some(l => l.includes('overflow') && l.includes('hidden'))).toBe(true)
    })

    it('sets touch-action: none for iOS', () => {
      expect(lines.some(l => l.includes('touch-action') && l.includes('none'))).toBe(true)
    })

    // Regression: padding should NOT be in this override (PR #37)
    it('does not contain padding-top (belongs in base rule)', () => {
      expect(lines.some(l => l.startsWith('padding-top'))).toBe(false)
    })

    it('does not contain padding-bottom (belongs in base rule)', () => {
      expect(lines.some(l => l.startsWith('padding-bottom'))).toBe(false)
    })
  })

  describe('.repMaxOverlay', () => {
    const lines = getRuleLines('.repMaxOverlay')

    // Regression: drag handle hidden behind Dynamic Island in PWA mode (PR #22)
    it('has safe-area-inset-top padding for Dynamic Island', () => {
      expect(lines.some(l => l.includes('safe-area-inset-top'))).toBe(true)
    })
  })

  describe('.settingsSheet', () => {
    const lines = getRuleLines('.settingsSheet')

    // Regression: drag handle hidden behind Dynamic Island in PWA mode (PR #28)
    it('accounts for safe-area-inset-top in max-height', () => {
      expect(lines.some(l => l.includes('safe-area-inset-top'))).toBe(true)
    })
  })

  describe('.previewBanner is data-mode aware, not OS-color-scheme aware (LIFT-1097)', () => {
    const lines = getRuleLines('.previewBanner')

    // The app resolves light/dark explicitly via the data-mode attribute
    // (useTheme applyResolvedMode), so a user who forces a mode opposite their
    // OS still gets consistent styling. The banner must follow the same tokens
    // instead of hardcoding hex and switching on prefers-color-scheme.
    it('uses theme tokens for color/background/border, not hardcoded hex', () => {
      expect(lines.some(l => l.startsWith('color:') && l.includes('var(--accent'))).toBe(true)
      expect(lines.some(l => l.startsWith('background:') && l.includes('var(--accent-subtle'))).toBe(true)
      expect(lines.some(l => l.startsWith('border-bottom:') && l.includes('var(--border'))).toBe(true)
    })

    it('does not hardcode hex colors', () => {
      expect(lines.some(l => /#[0-9a-fA-F]{3,6}/.test(l))).toBe(false)
    })

    // Regression guard: prefers-color-scheme couples visuals to the OS scheme,
    // breaking the data-mode invariant. index.css must contain zero such rules.
    it('index.css has no prefers-color-scheme override', () => {
      expect(css.includes('@media (prefers-color-scheme')).toBe(false)
    })
  })

  describe('.wtDetailTabs segmented control', () => {
    const lines = getRuleLines('.wtDetailTabs')

    it('has border-radius for pill shape', () => {
      expect(lines.some(l => l.includes('border-radius'))).toBe(true)
    })

    it('uses bg-secondary background', () => {
      expect(lines.some(l => l.includes('--bg-secondary'))).toBe(true)
    })
  })

  describe('.wtSetCard date-grouped card', () => {
    const lines = getRuleLines('.wtSetCard')

    it('has border-radius for rounded corners', () => {
      expect(lines.some(l => l.includes('border-radius'))).toBe(true)
    })

    it('has border for visibility in light themes', () => {
      expect(lines.some(l => l.includes('border') && l.includes('--border'))).toBe(true)
    })

    it('uses bg-elevated background', () => {
      expect(lines.some(l => l.includes('--bg-elevated'))).toBe(true)
    })
  })

  describe('.wtGraphWrap chart card', () => {
    const lines = getRuleLines('.wtGraphWrap')

    it('has border-radius for rounded corners', () => {
      expect(lines.some(l => l.includes('border-radius'))).toBe(true)
    })

    it('has border for visibility in light themes', () => {
      expect(lines.some(l => l.includes('border') && l.includes('--border'))).toBe(true)
    })
  })

  describe('.settingsScrollBody', () => {
    const lines = getRuleLines('.settingsScrollBody')

    it('exists as separate scroll container from settingsSheet', () => {
      expect(lines.length).toBeGreaterThan(0)
    })

    it('has overflow-y: auto', () => {
      expect(lines.some(l => l.includes('overflow-y') && l.includes('auto'))).toBe(true)
    })
  })

  describe('.settingsSegment weight goal control', () => {
    const lines = getRuleLines('.settingsSegment')

    it('has border-radius for pill shape', () => {
      expect(lines.some(l => l.includes('border-radius'))).toBe(true)
    })
  })

  describe('.settingsInput', () => {
    const lines = getRuleLines('.settingsInput')

    it('has min-height for touch targets', () => {
      expect(lines.some(l => l.includes('min-height') && l.includes('44px'))).toBe(true)
    })
  })

  describe('.wtSetBtn equal-width action buttons', () => {
    const lines = getRuleLines('.wtSetBtn')

    it('uses flex: 1 for equal widths', () => {
      expect(lines.some(l => l.includes('flex') && l.includes('1'))).toBe(true)
    })

    it('has min-height for touch targets', () => {
      expect(lines.some(l => l.includes('min-height') && l.includes('44px'))).toBe(true)
    })
  })

  // LIFT-1349: the set / bodyweight-entry / timeline rows became disclosures
  // whose trigger is a real <button>. The row's padding had to move ONTO that
  // button — a button sized to its text alone inside a padded row is a ~20px
  // tap target where the row used to be 44px, i.e. fixing the keyboard path by
  // breaking the touch one.
  describe('row disclosure triggers fill their row (LIFT-1349)', () => {
    const triggers = [
      { trigger: '.wtSetRowMain', row: '.wtSetRow', hint: 'set / bodyweight entry row' },
      { trigger: '.wtTimelineRowMain', row: '.wtTimelineRow', hint: 'timeline set row' },
    ]

    for (const { trigger, row, hint } of triggers) {
      it(`${trigger} (${hint}) has min-height: 44px`, () => {
        const lines = getRuleLines(trigger)
        expect(lines.some(l => l.includes('min-height') && l.includes('44px'))).toBe(true)
      })

      it(`${trigger} (${hint}) carries the row's padding and spans its width`, () => {
        const lines = getRuleLines(trigger)
        expect(lines.some(l => l.startsWith('padding') && l.includes('12px') && l.includes('16px'))).toBe(true)
        expect(lines.some(l => l.startsWith('width: 100%'))).toBe(true)
      })

      it(`${row} (${hint}) no longer pads around the trigger`, () => {
        // A row that keeps its own padding insets the button away from its own
        // edges, which is the ~20px-target regression above.
        const lines = getRuleLines(row)
        const padding = lines.filter(l => l.startsWith('padding'))
        expect(padding.every(l => !/\d+px\s+\d+px/.test(l))).toBe(true)
      })
    }

    it('.wtSetActions carries the row inset itself', () => {
      // Its row has no padding left to give it (see above), so an action bar
      // without its own inset sits flush against the card edge.
      const lines = getRuleLines('.wtSetActions')
      expect(lines.some(l => l.startsWith('padding') && l.includes('16px'))).toBe(true)
    })
  })

  describe('.wtPrevSessionChip quick-fill / ladder chips (#741)', () => {
    const lines = getRuleLines('.wtPrevSessionChip')

    it('has min-height: 44px for iOS HIG touch target', () => {
      expect(lines.some(l => l.includes('min-height') && l.includes('44px'))).toBe(true)
    })

    it('keeps ladder state classes on theme tokens (no hardcoded colors)', () => {
      const next = getRuleLines('.wtPrevSessionChipNext')
      expect(next.some(l => l.includes('var(--accent-subtle)'))).toBe(true)
      expect(next.some(l => l.includes('var(--accent)'))).toBe(true)
      expect(next.some(l => /#[0-9a-fA-F]{3,8}/.test(l))).toBe(false)
    })
  })

  describe('destructive controls track the per-theme --danger token (LIFT-1098)', () => {
    // Regression: several destructive controls hardcoded red literals
    // (#ff6b6b, #ff4444) or a literal #fff on-danger text instead of the
    // per-theme --danger / --text-on-accent tokens. Because --danger varies
    // per theme (e.g. #ff5a5a vs #dc2626 vs #f87171), the fixed values drifted
    // from the palette and could fall out of AA contrast in some themes.

    it('.devBtnDanger uses --danger / --danger-subtle, no hardcoded hex', () => {
      const lines = getRuleLines('.devBtnDanger')
      expect(lines.length, '.devBtnDanger rule not found').toBeGreaterThan(0)
      expect(lines.some(l => l.includes('color: var(--danger)'))).toBe(true)
      expect(lines.some(l => l.includes('border-color: var(--danger-subtle)'))).toBe(true)
      expect(lines.some(l => /#[0-9a-fA-F]{3,8}/.test(l))).toBe(false)
    })

    it('.wtEditDeleteConfirmDanger uses --danger bg with --text-on-accent text', () => {
      const lines = getRuleLines('.wtEditDeleteConfirmDanger')
      expect(lines.length, '.wtEditDeleteConfirmDanger rule not found').toBeGreaterThan(0)
      expect(lines.some(l => l.includes('background: var(--danger)'))).toBe(true)
      expect(lines.some(l => l.includes('color: var(--text-on-accent)'))).toBe(true)
      expect(lines.some(l => /#[0-9a-fA-F]{3,8}/.test(l))).toBe(false)
    })

    it('.resetConfirmDanger uses --danger and drops the !important literal', () => {
      // Scoped to .unlockDismiss so the token wins on specificity, not !important.
      const lines = getRuleLines('.unlockDismiss.resetConfirmDanger')
      expect(lines.length, '.unlockDismiss.resetConfirmDanger rule not found').toBeGreaterThan(0)
      expect(lines.some(l => l.includes('background: var(--danger)'))).toBe(true)
      expect(lines.some(l => l.includes('!important'))).toBe(false)
      expect(lines.some(l => /#[0-9a-fA-F]{3,8}/.test(l))).toBe(false)
      // The unscoped literal must be gone so the accent base cannot win.
      expect(css).not.toContain('#ff4444 !important')
    })
  })

  describe('.bwExportBtn bodyweight Health-export button (#1159)', () => {
    const lines = getRuleLines('.bwExportBtn')

    it('meets the 44px iOS HIG touch target in both dimensions', () => {
      expect(lines.some(l => l.includes('min-height') && l.includes('44px'))).toBe(true)
      expect(lines.some(l => l.includes('min-width') && l.includes('44px'))).toBe(true)
    })

    it('self-centers against the baseline-aligned hero row', () => {
      expect(lines.some(l => l.includes('align-self') && l.includes('center'))).toBe(true)
    })
  })

  describe('.topBarCoachBtn AI Review entry (#972)', () => {
    // The AI Review entry moved from a full-width Workouts card to a compact
    // top-bar icon on the Calendar tab; it must inherit the shared 44px
    // top-bar button sizing (.settingsGearBtn, .topBarPlusBtn, .topBarCoachBtn).
    const lines = getRuleLines('.topBarCoachBtn')

    it('meets the 44px iOS HIG touch target via the shared top-bar rule', () => {
      expect(lines.some(l => l.startsWith('width') && l.includes('44px'))).toBe(true)
      expect(lines.some(l => l.startsWith('height') && l.includes('44px'))).toBe(true)
    })

    it('the removed Workouts entry card does not linger in the stylesheet', () => {
      expect(css.includes('.wtCoachCard')).toBe(false)
    })
  })

  describe('Vue component touch target compliance', () => {
    // jsdom does not apply scoped CSS from Vue SFCs, so getComputedStyle
    // cannot verify sizing in component tests. These CSS regression tests
    // read the stylesheet source directly to assert 44px touch targets.

    describe('.mgHeader in MuscleGroupChart', () => {
      const style = getVueStyleBlock('MuscleGroupChart.vue')
      const lines = getRuleLines('.mgHeader', style)

      it('has min-height: 44px for iOS HIG touch target', () => {
        expect(lines.some(l => l.includes('min-height') && l.includes('44px'))).toBe(true)
      })
    })

    describe('.mgRow in MuscleGroupChart', () => {
      const style = getVueStyleBlock('MuscleGroupChart.vue')
      const lines = getRuleLines('.mgRow', style)

      it('has min-height: 44px for iOS HIG touch target', () => {
        expect(lines.some(l => l.includes('min-height') && l.includes('44px'))).toBe(true)
      })
    })
  })

  // #617: the RPE chips are a tiling radiogroup, so they must be SIZED to the
  // 44pt floor — an absolutely-positioned ::before overlay would butt against
  // the neighbouring chip and a near-miss would pick the wrong RPE (#990).
  describe('RPE controls touch targets (#617)', () => {
    it('.wtRPEChip is sized to 44px in both dimensions, not overlay-extended', () => {
      const lines = getRuleLines('.wtRPEChip')
      expect(lines.some(l => l.includes('min-height') && l.includes('44px'))).toBe(true)
      expect(lines.some(l => l.includes('min-width') && l.includes('44px'))).toBe(true)
    })

    it('.wtRPEToggle has min-height: 44px for iOS HIG compliance', () => {
      const lines = getRuleLines('.wtRPEToggle')
      expect(lines.some(l => l.includes('min-height') && l.includes('44px'))).toBe(true)
    })

    // The chips flex to share the row now that the scale is five points plus a
    // half modifier. `flex: 1 1 0` alone would happily shrink them under the
    // floor on a narrow sheet, so the min-width above has to stay paired with a
    // wrapping container — the ½ chip drops to a second line instead.
    it('.wtRPEScale wraps rather than shrinking chips below the 44pt floor', () => {
      const lines = getRuleLines('.wtRPEScale')
      expect(lines.some(l => l.includes('flex-wrap') && l.includes('wrap'))).toBe(true)
      const points = getRuleLines('.wtRPEPoints')
      expect(points.some(l => l.includes('flex-wrap') && l.includes('wrap'))).toBe(true)
    })

    it('.wtRPEChip flexes to share the row', () => {
      const lines = getRuleLines('.wtRPEChip')
      expect(lines.some(l => l.includes('flex:') && l.includes('1 1 0'))).toBe(true)
    })

    // The ½ chip reads quieter than the five value chips, but only while it is
    // OFF. `.wtRPEHalfChip` and `.wtRPEChipActive` are both single-class, so an
    // unscoped muted colour sitting later in the file wins on source order and
    // paints --text-muted onto the accent fill — measured at 3.31:1, under the
    // 4.5:1 AA floor, on a chip that looks selected.
    it('.wtRPEHalfChip only dims itself while inactive', () => {
      expect(getRuleLines('.wtRPEHalfChip')).toEqual([])
      const scoped = getRuleLines('.wtRPEHalfChip:not(.wtRPEChipActive)')
      expect(scoped.some(l => l.includes('color') && l.includes('--text-muted'))).toBe(true)
    })
  })

  // The effort toggle and the RPE pill share ONE row (#1271 / LIFT-617).
  // Stacking them cost 112px of sheet height unconditionally — both rows were
  // already at the 44pt floor, so the sheet paid the same whether or not
  // either annotation was used.
  describe('set-annotation row shares one line', () => {
    it('.wtEffortRow is a flex row so both annotations sit side by side', () => {
      const lines = getRuleLines('.wtEffortRow')
      expect(lines.some(l => l.includes('display') && l.includes('flex'))).toBe(true)
      expect(lines.some(l => l.includes('gap') && l.includes('8px'))).toBe(true)
    })

    // Only the effort label grows ("Went for rep 12"), so it must take the
    // truncation rather than push the RPE pill off the row.
    it('.wtEffortToggleLabel truncates instead of overflowing the row', () => {
      const lines = getRuleLines('.wtEffortToggleLabel')
      expect(lines.some(l => l.includes('text-overflow') && l.includes('ellipsis'))).toBe(true)
      expect(lines.some(l => l.includes('min-width') && l.includes('0'))).toBe(true)
      expect(getRuleLines('.wtEffortToggle').some(l => l.includes('min-width') && l.includes('0'))).toBe(true)
    })

    // The pill is fixed-width so a long rep label never squeezes the value out.
    it('.wtRPEToggle does not shrink', () => {
      expect(getRuleLines('.wtRPEToggle').some(l => l.includes('flex') && l.includes('none'))).toBe(true)
    })
  })

  describe('.wtTimerEditResetBtn touch target', () => {
    const lines = getRuleLines('.wtTimerEditResetBtn')

    it('has min-height: 44px for iOS HIG compliance', () => {
      expect(lines.some(l => l.includes('min-height') && l.includes('44px'))).toBe(true)
    })

    it('has adequate padding (not 4px)', () => {
      const paddingLine = lines.find(l => l.startsWith('padding'))
      expect(paddingLine).toBeDefined()
      // Ensure padding is at least 8px vertically
      expect(paddingLine).not.toMatch(/padding:\s*4px/)
    })
  })

  describe('.wtTimerPresetSm touch target', () => {
    const lines = getRuleLines('.wtTimerPresetSm')

    it('has min-height: 44px for iOS HIG compliance', () => {
      expect(lines.some(l => l.includes('min-height') && l.includes('44px'))).toBe(true)
    })
  })

  describe('.wtTimerEditCountdown touch target', () => {
    const lines = getRuleLines('.wtTimerEditCountdown')

    it('has min-height: 44px for iOS HIG compliance', () => {
      expect(lines.some(l => l.includes('min-height') && l.includes('44px'))).toBe(true)
    })
  })

  describe('.wtSuggestionSegment touch target (#759)', () => {
    // The Suggestions-drawer segmented control is a new interactive element;
    // each segment must meet the project's 44pt iOS touch-target minimum.
    const lines = getRuleLines('.wtSuggestionSegment')

    it('has min-height: 44px for iOS HIG compliance', () => {
      expect(lines.some(l => l.includes('min-height') && l.includes('44px'))).toBe(true)
    })
  })

  describe('.wtExManagerLabel touch target (#1252)', () => {
    // The exercise manager's row label is a tappable expander sitting beside
    // the expand chevron. Its two text lines plus padding measure 43px on
    // their own — one pixel under the floor — so the min-height is load-
    // bearing, not decorative. Sizing (not a ::before overlay) is mandatory
    // here: these labels tile vertically, so an oversized overlay would reach
    // into the next row and expand the wrong exercise.
    const lines = getRuleLines('.wtExManagerLabel')

    it('has min-height: 44px for iOS HIG compliance', () => {
      expect(lines.some(l => l.includes('min-height') && l.includes('44px'))).toBe(true)
    })

    it('centers its stacked lines so the extra height is not top-aligned dead space', () => {
      expect(lines.some(l => l.includes('justify-content') && l.includes('center'))).toBe(true)
    })
  })

  describe('guided session plan touch targets (#1256)', () => {
    // The plan card adds two interactive elements — the collapse toggle and
    // the per-exercise rows; both must meet the 44pt iOS touch-target minimum.
    it('.wtSessionPlanToggle has min-height: 44px', () => {
      const lines = getRuleLines('.wtSessionPlanToggle')
      expect(lines.some(l => l.includes('min-height') && l.includes('44px'))).toBe(true)
    })

    it('.wtSessionPlanRow has min-height: 44px', () => {
      const lines = getRuleLines('.wtSessionPlanRow')
      expect(lines.some(l => l.includes('min-height') && l.includes('44px'))).toBe(true)
    })
  })

  describe('.wtIntensitySlider touch target (#770)', () => {
    // The Intensity-lens slider is a draggable control; its hit area must meet
    // the project's 44pt iOS touch-target minimum.
    const lines = getRuleLines('.wtIntensitySlider')

    it('has min-height: 44px for iOS HIG compliance', () => {
      expect(lines.some(l => l.includes('min-height') && l.includes('44px'))).toBe(true)
    })
  })

  describe('intensity preset editor touch targets (#776)', () => {
    // The Settings preset editor adds two new interactive controls; both must
    // meet the project's 44pt iOS touch-target minimum.
    it('.settingsPresetDelete is a 44x44 hit area', () => {
      const lines = getRuleLines('.settingsPresetDelete')
      expect(lines.some(l => l.includes('width') && l.includes('44px'))).toBe(true)
      expect(lines.some(l => l.includes('height') && l.includes('44px'))).toBe(true)
    })

    it('.settingsPresetAdd has min-height: 44px', () => {
      const lines = getRuleLines('.settingsPresetAdd')
      expect(lines.some(l => l.includes('min-height') && l.includes('44px'))).toBe(true)
    })
  })

  describe('.wtTagPickerChip touch target (#990)', () => {
    // Regression: the picker chips carried only `padding: 8px 16px` around
    // 13px text, so they measured 33px tall (38px in rows containing the
    // larger --font-body "+" add chip, which stretches its row) — well under
    // the project's 44pt iOS floor. The class is shared by five pickers:
    // WorkoutTracker's new-exercise Tags and Gym rows, and EditExerciseModal's
    // Tags, Equipment and Gym rows, so the height must live on the shared rule
    // rather than being patched per surface.
    //
    // Sized rather than padded out with a transparent ::before hit-area (the
    // .logSetFieldClear approach): that trick suits an isolated control ringed
    // by inert whitespace, but these chips tile in a wrapping 8px-gap row, so
    // 44px overlays over 33px pills would tile edge-to-edge and a near-miss in
    // the gutter would toggle the neighbouring chip instead of doing nothing.
    it('.wtTagPickerChip has min-height: 44px for iOS HIG compliance', () => {
      const lines = getRuleLines('.wtTagPickerChip')
      expect(lines.some(l => l.includes('min-height') && l.includes('44px'))).toBe(true)
    })

    // The chip must carry the height itself: .wtTagPicker is a plain flex row,
    // so a chip alone in its row has nothing to stretch against.
    it('does not depend on a fixed height that would clip wrapped labels', () => {
      const lines = getRuleLines('.wtTagPickerChip')
      expect(lines.some(l => /^height:/.test(l))).toBe(false)
    })

    // The "+" chip is the narrowest in every picker; its 44pt width comes from
    // min-width, not from a text label.
    it('.wtTagAddChip keeps min-width: 44px so the "+" is a full target', () => {
      const lines = getRuleLines('.wtTagAddChip')
      expect(lines.some(l => l.includes('min-width') && l.includes('44px'))).toBe(true)
    })

    // The inline add input replaces the "+" chip in the same row. With no tags
    // or gyms configured it is the only item in that row, so flex stretch alone
    // would leave it at its natural 33px.
    it('.wtTagInlineInput matches the 44pt floor it swaps in for', () => {
      const lines = getRuleLines('.wtTagInlineInput')
      expect(lines.some(l => l.includes('min-height') && l.includes('44px'))).toBe(true)
    })
  })

  describe('brace balance', () => {
    // Regression: an extra closing brace in index.css caused a CSS minifier
    // warning ("unexpected }") that could silently drop rules in production.
    it('index.css has balanced braces', () => {
      let depth = 0
      const lines = css.split('\n')
      for (let i = 0; i < lines.length; i++) {
        for (const ch of lines[i]) {
          if (ch === '{') depth++
          if (ch === '}') depth--
        }
        if (depth < 0) {
          expect.fail(`Extra closing brace at line ${i + 1}: "${lines[i].trim()}"`)
        }
      }
      if (depth !== 0) {
        expect.fail(`Brace imbalance: ${depth > 0 ? depth + ' unclosed' : Math.abs(depth) + ' extra closing'} brace(s)`)
      }
    })

    it('Vue component style blocks have balanced braces', () => {
      const componentsDir = resolve(__dirname, '../../components')
      const vueFiles = readdirSync(componentsDir).filter((f: string) => f.endsWith('.vue'))
      for (const file of vueFiles) {
        const content = readFileSync(resolve(componentsDir, file), 'utf-8')
        const styleMatch = content.match(/<style[^>]*>([\s\S]*?)<\/style>/)
        if (!styleMatch) continue
        let depth = 0
        const lines = styleMatch[1].split('\n')
        for (let i = 0; i < lines.length; i++) {
          for (const ch of lines[i]) {
            if (ch === '{') depth++
            if (ch === '}') depth--
          }
        }
        if (depth !== 0) {
          expect.fail(`${file}: brace imbalance (${depth > 0 ? depth + ' unclosed' : Math.abs(depth) + ' extra closing'})`)
        }
      }
    })
  })

  describe('.srOnly screen-reader utility', () => {
    it('has position: absolute and clip to hide visually', () => {
      const lines = getRuleLines('.srOnly')
      expect(lines.length).toBeGreaterThan(0)
      expect(lines.some(l => l.startsWith('position: absolute'))).toBe(true)
      expect(lines.some(l => l.startsWith('clip: rect(0, 0, 0, 0)'))).toBe(true)
      expect(lines.some(l => l.startsWith('overflow: hidden'))).toBe(true)
    })

    it('.srOnlyFocusable becomes visible on focus with proper styling', () => {
      const lines = getRuleLines('.srOnly.srOnlyFocusable:focus')
      expect(lines.length).toBeGreaterThan(0)
      expect(lines.some(l => l.startsWith('position: fixed'))).toBe(true)
      expect(lines.some(l => l.startsWith('clip: auto'))).toBe(true)
      expect(lines.some(l => l.startsWith('overflow: visible'))).toBe(true)
      expect(lines.some(l => l.startsWith('z-index: 10000'))).toBe(true)
      expect(lines.some(l => l.startsWith('width: auto'))).toBe(true)
      expect(lines.some(l => l.startsWith('height: auto'))).toBe(true)
    })
  })

  describe('WCAG 2.4.1 skip-to-content (LIFT-551)', () => {
    const appVue = readFileSync(resolve(__dirname, '../../App.vue'), 'utf-8')

    it('App.vue has a skip-to-content link targeting #main-content', () => {
      expect(appVue).toContain('href="#main-content"')
      expect(appVue).toContain('Skip to content')
    })

    it('App.vue has a main-content target element with tabindex=-1', () => {
      expect(appVue).toContain('id="main-content"')
      expect(appVue).toMatch(/id="main-content"[^>]*tabindex="-1"/)
    })

    it('skip link uses srOnly srOnlyFocusable classes', () => {
      expect(appVue).toMatch(/class="srOnly srOnlyFocusable"[^>]*>Skip to content</)
    })
  })

  describe('spacing scale compliance (4/8/12/16/24/32)', () => {
    // Valid spacing values: 0, 1, 2, 4, 8, 12, 16, 24, 32, and multiples of 8 above 32
    const SCALE = new Set([0, 1, 2, 4, 8, 12, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128])
    const isOnScale = (v: number) => SCALE.has(v) || (v >= 32 && v % 8 === 0)

    const spacingProps = /^\s*(padding|margin|gap|padding-top|padding-bottom|padding-left|padding-right|margin-top|margin-bottom|margin-left|margin-right|row-gap|column-gap)\s*:/
    const pxVal = /-?\d+(?=px)/g

    function findViolations(): { line: number; text: string; values: number[] }[] {
      const violations: { line: number; text: string; values: number[] }[] = []
      css.split('\n').forEach((text, i) => {
        if (!spacingProps.test(text)) return
        if (text.includes('calc(') || text.includes('env(')) return
        const offScale: number[] = []
        let match
        pxVal.lastIndex = 0
        while ((match = pxVal.exec(text)) !== null) {
          const abs = Math.abs(parseInt(match[0], 10))
          if (abs > 2 && !isOnScale(abs)) offScale.push(abs)
        }
        if (offScale.length > 0) violations.push({ line: i + 1, text: text.trim(), values: offScale })
      })
      return violations
    }

    it('has no off-scale spacing values in index.css', () => {
      const violations = findViolations()
      if (violations.length > 0) {
        const report = violations.map(v => `  L${v.line}: ${v.text} (off-scale: ${v.values.join(', ')}px)`).join('\n')
        expect.fail(`Found ${violations.length} spacing scale violation(s):\n${report}`)
      }
    })

    it('has no off-scale spacing values in Vue component style blocks', () => {
      const componentsDir = resolve(__dirname, '../../components')
      const vueFiles = readdirSync(componentsDir).filter((f: string) => f.endsWith('.vue'))
      const allViolations: { file: string; line: number; text: string; values: number[] }[] = []

      for (const file of vueFiles) {
        const content = readFileSync(resolve(componentsDir, file), 'utf-8')
        const styleMatch = content.match(/<style[^>]*>([\s\S]*?)<\/style>/)
        if (!styleMatch) continue
        const styleBlock = styleMatch[1]
        const styleStartLine = content.slice(0, content.indexOf(styleMatch[0])).split('\n').length
        styleBlock.split('\n').forEach((text, i) => {
          if (!spacingProps.test(text)) return
          if (text.includes('calc(') || text.includes('env(')) return
          const offScale: number[] = []
          let match
          pxVal.lastIndex = 0
          while ((match = pxVal.exec(text)) !== null) {
            const abs = Math.abs(parseInt(match[0], 10))
            if (abs > 2 && !isOnScale(abs)) offScale.push(abs)
          }
          if (offScale.length > 0) allViolations.push({ file, line: styleStartLine + i, text: text.trim(), values: offScale })
        })
      }

      if (allViolations.length > 0) {
        const report = allViolations.map(v => `  ${v.file}:${v.line}: ${v.text} (off-scale: ${v.values.join(', ')}px)`).join('\n')
        expect.fail(`Found ${allViolations.length} spacing scale violation(s) in Vue components:\n${report}`)
      }
    })
  })

  describe('.wtDateBtnWrap date subtitle tap target', () => {
    // Regression: the date "Today" subtitle in the log modal became an
    // inline <span> wrapper during the modal redesign (d4974c2). With
    // display:inline, the absolutely-positioned overlay <input type="date">
    // only covered the 44x17px inline text box — below iOS's 44pt minimum
    // and unreliable for native picker activation. Fix (c16fc0b) requires
    // inline-block + padding to produce a proper touch target.
    const lines = getRuleLines('.wtDateBtnWrap')

    it('is display: inline-block (not inline or flex)', () => {
      expect(lines.some(l => l.startsWith('display: inline-block'))).toBe(true)
    })

    it('has padding to expand the touch target above 44pt', () => {
      // Text height is ~17pt; needs at least 16px padding top+bottom to reach 44pt
      const paddingLine = lines.find(l => l.startsWith('padding'))
      expect(paddingLine, 'padding rule missing on .wtDateBtnWrap').toBeTruthy()
      const match = paddingLine!.match(/padding:\s*(\d+)px/)
      expect(match, `padding value parse failed: ${paddingLine}`).toBeTruthy()
      expect(Number(match![1])).toBeGreaterThanOrEqual(14)
    })

    it('has negative margin to preserve visible layout', () => {
      expect(lines.some(l => l.startsWith('margin') && l.includes('-'))).toBe(true)
    })

    it('position: relative for the absolute overlay input', () => {
      expect(lines.some(l => l.startsWith('position: relative'))).toBe(true)
    })
  })

  describe('.wtDateOverlayInput picker-trigger integrity', () => {
    const lines = getRuleLines('.wtDateOverlayInput')

    it('is position: absolute with inset: 0 to cover the wrap', () => {
      expect(lines.some(l => l.startsWith('position: absolute'))).toBe(true)
      expect(lines.some(l => l.startsWith('inset: 0'))).toBe(true)
    })

    it('has z-index to sit above the label span', () => {
      // Without z-index, real touches on iOS may land on the static-positioned
      // label sibling instead of the input — which never opens the picker.
      expect(lines.some(l => l.startsWith('z-index'))).toBe(true)
    })

    it('does NOT have pointer-events: none', () => {
      // A prior fix attempt (reverted in b437ffe) added pointer-events:none
      // which caused iOS Safari to refuse showPicker() entirely.
      expect(lines.every(l => !l.startsWith('pointer-events: none'))).toBe(true)
    })
  })

  describe('content-visibility: auto for off-screen rendering skip (LIFT-633)', () => {
    const targets = [
      { selector: '.wtSetCard', hint: 'timeline date group' },
      { selector: '.wtTimelineRow', hint: 'timeline set row' },
      { selector: '.calWeekRow', hint: 'calendar week row' },
      { selector: '.calExGroup', hint: 'calendar exercise group' },
    ]

    for (const { selector, hint } of targets) {
      it(`${selector} (${hint}) has content-visibility: auto`, () => {
        const lines = getRuleLines(selector)
        expect(lines.some(l => l.includes('content-visibility') && l.includes('auto'))).toBe(true)
      })

      it(`${selector} (${hint}) has contain-intrinsic-size`, () => {
        const lines = getRuleLines(selector)
        expect(lines.some(l => l.includes('contain-intrinsic-size'))).toBe(true)
      })
    }
  })

  describe('WCAG 2.4.11 focus indicators on inputs with outline:none', () => {
    // Regression: 11 input elements had outline:none with only border-color
    // changes as focus replacement. WCAG 2.4.7 (Focus Visible) and 2.4.11
    // (Focus Appearance) require a clearly visible focus indicator — border-color
    // alone is insufficient for users with low vision. Fix: box-shadow ring on
    // :focus-visible for all affected inputs.

    const focusInputs = [
      { selector: '.settingsInput:focus-visible', shadow: '--accent-subtle' },
      { selector: '.settingsRange:focus-visible', shadow: '--accent-subtle' },
      { selector: '.wtSearchInput:focus-visible', shadow: '--accent-subtle' },
      { selector: '.wtTagInlineInput:focus-visible', shadow: '--accent-subtle' },
      { selector: '.logSetSheet .logSetFieldInput:focus-visible', shadow: '--accent-subtle' },
      { selector: '.wtRepsStepperInput:focus-visible', shadow: '--accent-subtle' },
      { selector: '.repMaxInput:focus-visible', shadow: '--accent-subtle' },
      { selector: '.iosStepperInput:focus-visible', shadow: '--accent-subtle' },
      { selector: '.wtTimerEditInput:focus-visible', shadow: '--accent-subtle' },
      { selector: '.deleteConfirmInput:focus-visible', shadow: '--danger-subtle' },
    ]

    for (const { selector, shadow } of focusInputs) {
      it(`${selector} has box-shadow focus ring`, () => {
        const lines = getRuleLines(selector)
        expect(lines.length, `${selector} rule not found`).toBeGreaterThan(0)
        expect(lines.some(l => l.includes('box-shadow') && l.includes(shadow))).toBe(true)
      })
    }
  })

  describe('forced-colors / High Contrast Mode glass borders (LIFT-682)', () => {
    // Regression: in forced-colors mode the UA drops backdrop-filter and
    // translucent backgrounds, so glass surfaces that rely on blur for
    // separation blend into adjacent content (WCAG 2.2 SC 1.4.11). A
    // @media (forced-colors: active) block must pin explicit system-color
    // borders on every glass surface so boundaries stay visible.

    function getAtRuleBody(query: string): string {
      const needle = '@media (' + query + ') {'
      const idx = css.indexOf(needle)
      if (idx === -1) return ''
      const start = css.indexOf('{', idx) + 1
      let depth = 1
      let end = start
      while (depth > 0 && end < css.length) {
        if (css[end] === '{') depth++
        if (css[end] === '}') depth--
        end++
      }
      return css.slice(start, end - 1)
    }

    const forcedBody = getAtRuleBody('forced-colors: active')

    it('has a @media (forced-colors: active) block', () => {
      expect(forcedBody.length).toBeGreaterThan(0)
    })

    const glassSurfaces = [
      '.tabBar',
      '.repMaxModal',
      '.kbSheet',
      '.legalSheet',
      '.confirmSheet',
      '.settingsSheet',
      '.wtCard',
      '.calCard',
      '.wtSetCard',
      '.wtGraphWrap',
    ]

    for (const selector of glassSurfaces) {
      it(`forced-colors block targets ${selector}`, () => {
        expect(forcedBody).toContain(selector)
      })
    }

    it('uses a system color keyword (CanvasText) for the border', () => {
      expect(forcedBody).toMatch(/border:\s*1px solid CanvasText/)
    })

    it('outlines the active-tab indicator with the Highlight system color', () => {
      expect(forcedBody).toContain('.tabIndicator')
      expect(forcedBody).toMatch(/border:\s*1px solid Highlight/)
    })

    it('has a @media (prefers-contrast: more) block strengthening glass edges', () => {
      const contrastBody = getAtRuleBody('prefers-contrast: more')
      expect(contrastBody.length).toBeGreaterThan(0)
      expect(contrastBody).toContain('.tabBar')
      expect(contrastBody).toContain('--border-strong')
    })
  })

  describe('.logSetFieldClear 44pt touch target (LIFT-685)', () => {
    // Regression: the inline "clear weight" × chip was a bare 24x24px button
    // with padding:0 — exactly the WCAG 2.2 SC 2.5.8 floor but well below the
    // project's own 44pt iOS standard, making it easy to mis-tap during fast
    // set entry. Fix: keep the compact 24px visible chip but extend the tap
    // target to 44x44pt via an absolutely-positioned ::before overlay so the
    // layout (and the 44px weight value next to it) never shifts.
    const lines = getRuleLines('.logSetSheet .logSetFieldClear')
    const beforeLines = getRuleLines('.logSetSheet .logSetFieldClear::before')

    it('keeps the visible chip at a compact 24px (no layout growth)', () => {
      expect(lines.some(l => l.startsWith('width: 24px'))).toBe(true)
      expect(lines.some(l => l.startsWith('height: 24px'))).toBe(true)
    })

    it('is position: relative to anchor the hit-area overlay', () => {
      expect(lines.some(l => l.startsWith('position: relative'))).toBe(true)
    })

    it('has a ::before overlay sized to the 44pt iOS minimum', () => {
      expect(beforeLines.length, '::before rule not found').toBeGreaterThan(0)
      expect(beforeLines.some(l => l.startsWith('position: absolute'))).toBe(true)
      expect(beforeLines.some(l => l.startsWith('width: 44px'))).toBe(true)
      expect(beforeLines.some(l => l.startsWith('height: 44px'))).toBe(true)
    })
  })

  describe('log-set sheet sticky save bar', () => {
    // Regression: the log form (usual ladder + PR card + plate calc) grew
    // taller than the 88svh sheet, pushing Save/Done below the fold — users
    // had to scroll to find Save and could close the sheet thinking the set
    // was logged. The action bar must stay pinned/visible at the sheet
    // bottom while the form scrolls behind it.
    const sheetLines = getRuleLines('.repMaxModal.logSetSheetForm')
    const barLines = getRuleLines('.logSetSheetForm .repMaxActions')

    it('form view is a flex column so the bar can pin to the sheet bottom', () => {
      expect(sheetLines.some(l => l.startsWith('display: flex'))).toBe(true)
      expect(sheetLines.some(l => l.startsWith('flex-direction: column'))).toBe(true)
    })

    it('moves the sheet bottom padding into the bar (bar sits flush)', () => {
      expect(sheetLines.some(l => l.startsWith('padding-bottom: 0'))).toBe(true)
      const pad = barLines.find(l => l.startsWith('padding:'))
      expect(pad, 'bar must own the safe-area bottom padding').toContain('safe-area-inset-bottom')
    })

    it('form children keep natural height (overflow scrolls, not compresses)', () => {
      const childLines = getRuleLines('.logSetSheetForm > *')
      expect(childLines.some(l => l.startsWith('flex-shrink: 0'))).toBe(true)
    })

    it('action bar is sticky at bottom: 0 with an opaque-enough backdrop', () => {
      expect(barLines.some(l => l.startsWith('position: sticky'))).toBe(true)
      expect(barLines.some(l => l.startsWith('bottom: 0'))).toBe(true)
      expect(barLines.some(l => l.startsWith('background:'))).toBe(true)
    })

    it('pins to the sheet bottom when content is short (margin-top: auto)', () => {
      expect(barLines.some(l => l.startsWith('margin: auto'))).toBe(true)
    })

    it('has a glass-off fallback without backdrop-filter', () => {
      const offLines = getRuleLines('[data-glass="off"] .logSetSheetForm .repMaxActions')
      expect(offLines.some(l => l.startsWith('background: var(--bg-elevated)'))).toBe(true)
      expect(offLines.some(l => l.startsWith('backdrop-filter: none'))).toBe(true)
    })
  })

  describe('prefers-reduced-transparency fallback (LIFT-680)', () => {
    // Regression: glass morphism is always on, but users who enable Reduce
    // Transparency (iOS/macOS/Windows) expect blur/translucency swapped for
    // solid surfaces. Without this media query, text over the always-on glass
    // stays hard to read on busy mesh backgrounds.

    // Extract the @media (prefers-reduced-transparency: reduce) block body.
    function getMediaBlock(query: string, source = css): string {
      const needle = '@media (' + query + ')'
      const idx = source.indexOf(needle)
      if (idx === -1) return ''
      const start = source.indexOf('{', idx) + 1
      let depth = 1
      let end = start
      while (depth > 0 && end < source.length) {
        if (source[end] === '{') depth++
        if (source[end] === '}') depth--
        end++
      }
      return source.slice(start, end - 1)
    }

    const block = getMediaBlock('prefers-reduced-transparency: reduce')

    it('declares a prefers-reduced-transparency: reduce media query', () => {
      expect(block.length, 'media block not found in index.css').toBeGreaterThan(0)
    })

    it('disables backdrop-filter on the glass surfaces', () => {
      // Every backdrop-filter declaration inside the block must be `none`.
      const filters = block.match(/(?<!-webkit-)backdrop-filter:[^;]+;/g) || []
      expect(filters.length).toBeGreaterThan(0)
      for (const f of filters) {
        expect(f).toContain('none')
      }
    })

    it('gives the tab bar and content cards a solid background', () => {
      expect(block).toMatch(/\.tabBar,[\s\S]*?\.calCard\s*\{[\s\S]*?background:\s*var\(--bg-secondary\)/)
    })

    it('gives modals and sheets a solid elevated background', () => {
      expect(block).toMatch(/\.confirmSheet\s*\{[\s\S]*?background:\s*var\(--bg-elevated\)/)
    })

    it('removes blur from scrim overlays', () => {
      for (const sel of ['.settingsOverlay', '.repMaxOverlay', '.kbOverlay', '.confirmOverlay']) {
        expect(block, `${sel} missing from reduced-transparency block`).toContain(sel)
      }
    })

    it('comes after the mobile backdrop-filter reduction block so it wins', () => {
      const mobileIdx = css.indexOf('@media (max-width: 768px)')
      const reduceIdx = css.indexOf('@media (prefers-reduced-transparency: reduce)')
      expect(mobileIdx).toBeGreaterThan(-1)
      expect(reduceIdx).toBeGreaterThan(mobileIdx)
    })

    it('PRBurst celebration backdrop has a reduced-transparency fallback', () => {
      const vue = getVueStyleBlock('PRBurst.vue')
      const prBlock = getMediaBlock('prefers-reduced-transparency: reduce', vue)
      expect(prBlock.length, 'PRBurst reduced-transparency block not found').toBeGreaterThan(0)
      expect(prBlock).toContain('backdrop-filter: none')
    })
  })
})

/**
 * Regression: the type scale must stay anchored to rem, not fixed px, so text
 * honors the user's preferred browser/OS text size and iOS Dynamic Type
 * (WCAG 1.4.4 Resize Text, AA — LIFT-988). A fixed-px scale ignores text-only
 * zoom, forcing low-vision users into full-page pinch-zoom + horizontal scroll.
 */
describe('type scale is rem-anchored (WCAG 1.4.4 — LIFT-988)', () => {
  const fontTokens = [
    '--font-caption2', '--font-caption1', '--font-footnote', '--font-subhead',
    '--font-callout', '--font-body', '--font-headline', '--font-title3',
    '--font-title2', '--font-title1', '--font-lg-title',
    '--font-display-sm', '--font-display', '--font-display-lg',
  ]

  for (const token of fontTokens) {
    it(`${token} is defined in rem, not px`, () => {
      const decl = css.match(new RegExp(`${token}:\\s*([^;]+);`))
      expect(decl, `${token} definition not found`).not.toBeNull()
      const value = decl![1].trim()
      expect(value, `${token} should be rem-based`).toMatch(/rem$/)
      expect(value, `${token} must not use a fixed px size`).not.toMatch(/px/)
    })
  }

  it('no font-size declaration in index.css uses a fixed px value', () => {
    // Relative units (rem/em) scale with the user's text-size preference; px does not.
    const pxFontSizes = css.match(/font-size:\s*[0-9.]+px/g)
    expect(pxFontSizes, `found fixed-px font-size(s): ${pxFontSizes?.join(', ')}`).toBeNull()
  })

  it('does not pin the root font-size, so 1rem tracks the user preference', () => {
    // A fixed `html { font-size: 16px }` would defeat rem-based scaling.
    expect(css).not.toMatch(/\bhtml\s*\{[^}]*font-size:\s*\d+px/)
  })
})

describe('Custom-property token definitions', () => {
  // Every design token consumed via var(--x) must be declared somewhere in
  // index.css (a :root block or a theme block). A reference with no matching
  // declaration and no fallback silently resolves to the initial value —
  // `background: var(--bg-tertiary)` rendered transparent in all 20 theme
  // variants for months because the token was never defined (LIFT-1094).
  const definedTokens = new Set<string>()
  for (const m of css.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) {
    definedTokens.add(m[1])
  }

  it('parsed a non-trivial set of token definitions', () => {
    // Guards the test itself: if the regex silently matched nothing, the
    // undefined-reference check below would pass vacuously.
    expect(definedTokens.size).toBeGreaterThan(20)
    expect(definedTokens.has('--bg-hover')).toBe(true)
  })

  it('every var(--token) reference resolves to a declared token', () => {
    const undefinedRefs = new Set<string>()
    // Capture the token name up to a comma (fallback) or the closing paren.
    for (const m of css.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)\s*[,)]/g)) {
      const token = m[1]
      // A reference carrying its own fallback (var(--x, y)) degrades
      // gracefully, so only flag bare references.
      const hasFallback = m[0].includes(',')
      if (!hasFallback && !definedTokens.has(token)) {
        undefinedRefs.add(token)
      }
    }
    expect(
      [...undefinedRefs],
      `undefined CSS custom properties referenced without a fallback: ${[...undefinedRefs].join(', ')}`,
    ).toEqual([])
  })

  it('does not reintroduce the undefined --bg-tertiary token', () => {
    // Pin the specific token that regressed so the fix cannot silently revert.
    expect(css.includes('var(--bg-tertiary)')).toBe(false)
    expect(definedTokens.has('--bg-tertiary')).toBe(false)
  })

  // --- .vue <style> blocks (#1261) ---
  // The check above reads index.css and nothing else, which is exactly why a
  // `var(--card-bg)` typo in index.css was caught on sight while the identical
  // one in StarterPickerFlow.vue survived: component <style> blocks consume the
  // same global tokens but were never in scope. The guard has to cover every
  // file that can CONSUME a token, not just the file that declares them.
  const vueFiles = collectVueFiles(resolve(__dirname, '../..'))

  it('found the .vue files to scan', () => {
    // Guards the sweep itself: an empty or components-only file list would let
    // the undefined-reference check below pass vacuously.
    expect(vueFiles.length).toBeGreaterThan(20)
    expect(vueFiles.some((f) => f.endsWith('StarterPickerFlow.vue'))).toBe(true)
    // The walk must recurse — these two live outside src/components/.
    expect(vueFiles.some((f) => f.includes('/views/'))).toBe(true)
    expect(vueFiles.some((f) => f.includes('/share/'))).toBe(true)
  })

  it('every var(--token) reference in a .vue <style> block resolves to a declared token', () => {
    const offenders: string[] = []

    for (const file of vueFiles) {
      const style = allVueStyleBlocks(readFileSync(file, 'utf-8'))
      if (!style.trim()) continue

      // A component may declare its own local tokens; those resolve too.
      const resolvable = new Set(definedTokens)
      for (const m of style.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) resolvable.add(m[1])

      const undefinedRefs = new Set<string>()
      for (const m of style.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)\s*[,)]/g)) {
        // A reference carrying its own fallback (var(--x, y)) degrades
        // gracefully, so only flag bare references.
        const hasFallback = m[0].includes(',')
        if (!hasFallback && !resolvable.has(m[1])) undefinedRefs.add(m[1])
      }
      if (undefinedRefs.size > 0) {
        offenders.push(`${relative(resolve(__dirname, '../..'), file)}: ${[...undefinedRefs].join(', ')}`)
      }
    }

    expect(
      offenders,
      `undefined CSS custom properties referenced without a fallback:\n${offenders.join('\n')}`,
    ).toEqual([])
  })

  it('does not reintroduce the undefined --card-bg or --text-tertiary tokens', () => {
    // Pin the two tokens that regressed in StarterPickerFlow.vue. They failed
    // differently, which is why neither surfaced as an obvious break:
    // `background` is not inherited, so --card-bg resolved to transparent (no
    // track behind the progress fill); `color` IS inherited, so --text-tertiary
    // made captions silently adopt their parent's color instead of de-emphasizing.
    const allStyles = vueFiles.map((f) => allVueStyleBlocks(readFileSync(f, 'utf-8'))).join('\n')
    for (const token of ['--card-bg', '--text-tertiary']) {
      expect(allStyles.includes(`var(${token})`), `${token} referenced but never declared`).toBe(false)
      expect(css.includes(`var(${token})`), `${token} referenced but never declared`).toBe(false)
      expect(definedTokens.has(token)).toBe(false)
    }
  })
})

/**
 * iOS focus-zoom floor (LIFT-1376).
 *
 * iOS Safari zooms the whole page when a form control smaller than 16px takes
 * focus, and never zooms back out. index.html used to suppress that with
 * `maximum-scale=1.0, user-scalable=no` — which also blocks pinch-zoom, a WCAG
 * 2.1 AA failure on 1.4.4 and 1.4.10. Lifting the lock (see the viewport pin in
 * metaRegression.test.ts) hands the zoom-on-focus behaviour back, so the floor
 * has to be met by the controls themselves: seven of them computed under 16px
 * and would have started yanking the layout on every tap.
 *
 * DERIVED, not enumerated. A hardcoded class list would only ever pin the
 * inputs that existed the day it was written, and the two halves of this fix
 * live in different files — the next input added with a `--font-subhead` label
 * style would silently re-break zoom-free focus with the meta tag still (and
 * correctly) permissive. So the controls come out of the .vue templates and the
 * sizes out of the stylesheets, and a new control with no font-size rule at all
 * fails too: form controls do NOT inherit `body`'s font-size, they fall back to
 * the UA default (~13px), which is under the floor.
 *
 * Deliberately stricter than the real cascade: EVERY rule that can style a
 * control must clear 16px, not just whichever one happens to win. Resting a
 * WCAG floor on source order is how `.wtTagManagerInput` came to carry a dead
 * 15px declaration that only looked harmless because `.repMaxInput` sits
 * further down the file.
 */
describe('iOS focus-zoom floor: text controls are at least 16px (LIFT-1376)', () => {
  const SRC = resolve(__dirname, '../..')
  const MIN_PX = 16
  const ROOT_PX = 16 // 1rem at the default root size, which index.css never pins

  // --- font-size values, resolved to px ------------------------------------

  const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '')

  const fontTokens = new Map<string, number>()
  for (const m of stripComments(css).matchAll(/(--font-[a-z0-9-]+)\s*:\s*([\d.]+)(rem|px)\s*;/gi)) {
    fontTokens.set(m[1], m[3].toLowerCase() === 'rem' ? parseFloat(m[2]) * ROOT_PX : parseFloat(m[2]))
  }

  /** px for a font-size value, or null when it can't be resolved statically. */
  function toPx(value: string): number | null {
    const varRef = value.match(/^var\(\s*(--[a-z0-9-]+)\s*\)$/i)
    if (varRef) return fontTokens.get(varRef[1]) ?? null
    const unit = value.match(/^([\d.]+)(rem|px|em)$/i)
    if (!unit) return null
    const n = parseFloat(unit[1])
    return unit[2].toLowerCase() === 'px' ? n : n * ROOT_PX
  }

  // --- font-size declarations, keyed by the file they can reach ------------
  // Every .vue <style> block in this app is `scoped`, so a component's rules
  // only ever style that component. index.css is the global sheet.

  type FontRule = { selector: string; raw: string; px: number | null; origin: string; scope: string | null }
  const fontRules: FontRule[] = []

  function collectFontRules(source: string, origin: string, scope: string | null): void {
    // Innermost-rule match: the inner `[^{}]*` can't span a nested block, so an
    // at-rule prelude (@media/@supports) never captures as a selector while the
    // rules inside it still do.
    for (const m of stripComments(source).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const decl = m[2].match(/(?:^|;)\s*font-size\s*:\s*([^;]+)/)
      if (!decl) continue
      const raw = decl[1].trim()
      for (const selector of m[1].split(',')) {
        fontRules.push({ selector: selector.trim(), raw, px: toPx(raw), origin, scope })
      }
    }
  }

  collectFontRules(css, 'src/index.css', null)

  // --- the controls themselves, out of the templates -----------------------

  // Types that never open a text-entry keyboard, so never trigger focus zoom.
  const EXEMPT_TYPES = new Set([
    'range', 'checkbox', 'radio', 'file', 'hidden', 'submit', 'reset', 'button', 'image',
  ])

  type Control = { file: string; line: number; tag: string; type: string; classes: string[] }
  const controls: Control[] = []

  const templateFiles = [...collectVueFiles(SRC), resolve(SRC, '../index.html').replace(/\\/g, '/')]
  for (const file of templateFiles) {
    const content = readFileSync(file, 'utf-8')
    const rel = relative(resolve(SRC, '..'), file).replace(/\\/g, '/')

    if (file.endsWith('.vue')) {
      const style = allVueStyleBlocks(content)
      if (style.trim()) collectFontRules(style, rel, file)
    }

    for (const m of content.matchAll(/<(input|textarea|select)\b([^>]*?)\/?>/g)) {
      const attrs = m[2]
      // A bound :type is unresolvable here; assume the zooming case.
      const type = m[1] === 'input' ? (attrs.match(/\btype="([^"]*)"/)?.[1] ?? 'text') : m[1]
      if (EXEMPT_TYPES.has(type)) continue
      controls.push({
        file: rel,
        line: content.slice(0, m.index).split('\n').length,
        tag: m[1],
        type,
        classes: (attrs.match(/\bclass="([^"]*)"/)?.[1] ?? '').split(/\s+/).filter(Boolean),
      })
    }
  }

  /** Does `selector` style `c`? Conservative: unresolvable qualifiers say no. */
  function ruleMatches(selector: string, c: Control): boolean {
    if (selector.startsWith('@') || selector.includes('::')) return false
    // Only the rightmost compound selector describes the element itself.
    const compound = selector.split(/\s*[>+~]\s*|\s+/).filter(Boolean).pop()
    if (!compound) return false
    const bare = compound.replace(/:[a-z-]+(\([^)]*\))?/gi, '')
    const classes = [...bare.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((x) => x[1])
    if (classes.length === 0) return false
    const rest = bare.replace(/\.[A-Za-z0-9_-]+/g, '')
    // An id or attribute qualifier can't be resolved from the template alone.
    if (rest.includes('#') || rest.includes('[')) return false
    const tag = rest.match(/^[a-z][a-z0-9-]*/i)?.[0]
    if (tag && tag.toLowerCase() !== c.tag) return false
    return classes.every((cl) => c.classes.includes(cl))
  }

  it('found the controls and the font tokens to check them against', () => {
    // Guards the derivation: a regex that stopped matching would turn the
    // check below into an assertion about an empty list.
    expect(fontTokens.get('--font-callout')).toBe(16)
    expect(fontTokens.get('--font-subhead')).toBe(15)
    expect(controls.length).toBeGreaterThan(20)
    expect(fontRules.length).toBeGreaterThan(100)
    // One from index.css, one from a scoped component block, one from a view.
    expect(controls.some((c) => c.classes.includes('wtSearchInput'))).toBe(true)
    expect(controls.some((c) => c.classes.includes('recDaysInput'))).toBe(true)
    expect(controls.some((c) => c.classes.includes('authInput'))).toBe(true)
    // The date overlay is invisible but still takes focus — it must be in scope.
    expect(controls.some((c) => c.type === 'date')).toBe(true)
  })

  it('every focusable text control computes to at least 16px', () => {
    const offenders: string[] = []

    for (const c of controls) {
      const where = `${c.file}:${c.line} <${c.tag} type="${c.type}" class="${c.classes.join(' ') || '(none)'}">`
      const matched = fontRules.filter((r) => (r.scope === null || r.origin === c.file) && ruleMatches(r.selector, c))

      if (matched.length === 0) {
        offenders.push(`${where} — no font-size rule; form controls do not inherit body's, so this lands on the UA default (~13px)`)
        continue
      }
      for (const r of matched) {
        if (r.px === null) {
          offenders.push(`${where} — ${r.origin} \`${r.selector}\` font-size: ${r.raw} cannot be resolved to px`)
        } else if (r.px < MIN_PX) {
          offenders.push(`${where} — ${r.origin} \`${r.selector}\` font-size: ${r.raw} = ${r.px}px, under the ${MIN_PX}px floor`)
        }
      }
    }

    expect(
      offenders,
      `controls under the iOS focus-zoom floor (raise them to var(--font-callout); never re-add user-scalable=no):\n${offenders.join('\n')}`,
    ).toEqual([])
  })
})

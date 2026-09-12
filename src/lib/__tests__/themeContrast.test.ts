/**
 * WCAG 2.1 AA contrast ratio audit for all 10 Lift themes (20 variants).
 *
 * The theme palettes are parsed directly from src/index.css at test time —
 * index.css is the single source of truth, so the audit can never validate a
 * stale duplicate of the design tokens (LIFT-1095). If a theme block gains,
 * loses, or renames a token, this suite either re-audits the real value or
 * fails loudly on the missing token.
 *
 * That single-source claim only holds because of the parity guard below: every
 * theme ALSO exists as src/themes/<id>.css, which is what `loadThemeCSS`
 * injects at runtime and what `vite-plugin-theme-split` leaves behind after it
 * strips the non-eternal blocks out of the bundled index.css. For 9 of the 10
 * themes the per-theme file is the palette that actually renders, so an audit
 * that reads index.css alone would be measuring dead CSS the moment the two
 * copies diverged (LIFT-1096).
 *
 * Checks every critical text/background pair against WCAG AA thresholds:
 *   - Normal text (< 18px): 4.5:1
 *   - Large text (≥ 18px or ≥ 14px bold): 3:1
 *   - Non-text UI (icons, borders): 3:1
 *
 * See: https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html
 */
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

// ── Color utilities ──────────────────────────────────────────────────

/** Expand a 3-digit hex (#fff) to its 6-digit form (#ffffff). */
function normalizeHex(hex: string): string {
  const h = hex.replace('#', '').trim()
  if (h.length === 3) {
    return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`.toLowerCase()
  }
  return `#${h}`.toLowerCase()
}

function hexToRgb(hex: string): [number, number, number] {
  const h = normalizeHex(hex).replace('#', '')
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ]
}

/** WCAG 2.x relative luminance */
function relativeLuminance([r, g, b]: [number, number, number]): number {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs
}

/** WCAG contrast ratio (1–21) */
function contrastRatio(fg: string, bg: string): number {
  const l1 = relativeLuminance(hexToRgb(fg))
  const l2 = relativeLuminance(hexToRgb(bg))
  const lighter = Math.max(l1, l2)
  const darker = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}

// ── Theme parsing (single source of truth: src/index.css) ────────────

interface ThemeColors {
  bgPrimary: string
  bgSecondary: string
  bgElevated: string
  bgHover: string
  textPrimary: string
  textSecondary: string
  textMuted: string
  accent: string
  textOnAccent: string
  danger: string
  success: string
}

/**
 * CSS custom-property name → ThemeColors field. Every field the audit reads
 * must be a hex-valued token in index.css; a missing one fails the parse.
 */
const TOKEN_MAP: Record<string, keyof ThemeColors> = {
  '--bg-primary': 'bgPrimary',
  '--bg-secondary': 'bgSecondary',
  '--bg-elevated': 'bgElevated',
  '--bg-hover': 'bgHover',
  '--text-primary': 'textPrimary',
  '--text-secondary': 'textSecondary',
  '--text-muted': 'textMuted',
  '--accent': 'accent',
  '--text-on-accent': 'textOnAccent',
  '--danger': 'danger',
  '--success': 'success',
}

const HEX_TOKEN = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/

/**
 * Parse every `[data-theme="X"][data-mode="Y"]` token block out of index.css.
 * Blocks contain only flat `--token: value;` declarations (no nested braces),
 * so a non-greedy brace match is sufficient and unambiguous.
 */
function parseThemesFromCss(css: string): Record<string, ThemeColors> {
  const blockRe = /\[data-theme="([\w-]+)"\]\[data-mode="(dark|light)"\]\s*\{([^}]*)\}/g
  const declRe = /(--[\w-]+)\s*:\s*([^;]+);/g

  const out: Record<string, ThemeColors> = {}
  let block: RegExpExecArray | null

  while ((block = blockRe.exec(css)) !== null) {
    const [, theme, mode, body] = block
    const key = `${theme}-${mode}`
    const colors: Partial<ThemeColors> = {}

    let decl: RegExpExecArray | null
    while ((decl = declRe.exec(body)) !== null) {
      const field = TOKEN_MAP[decl[1]]
      if (!field) continue
      const value = decl[2].trim()
      if (!HEX_TOKEN.test(value)) {
        throw new Error(
          `${key}: token ${decl[1]} is "${value}", but the contrast audit only ` +
            `understands hex values. Update the audit if this token is now non-hex.`,
        )
      }
      colors[field] = normalizeHex(value)
    }

    const missing = Object.values(TOKEN_MAP).filter((f) => !(f in colors))
    if (missing.length > 0) {
      throw new Error(`${key}: missing required token(s): ${missing.join(', ')}`)
    }
    out[key] = colors as ThemeColors
  }

  return out
}

const cssPath = resolve(__dirname, '../../index.css')
const themes = parseThemesFromCss(readFileSync(cssPath, 'utf8'))

/**
 * The lazy-loaded twin of each index.css theme block. Read off the directory
 * rather than a theme-id list: a new theme is then audited the moment its file
 * lands, and an enumeration can't fall behind the one it is meant to pin.
 */
const themesDir = resolve(__dirname, '../../themes')
const themeFilePalettes: Record<string, ThemeColors> = {}
for (const file of readdirSync(themesDir).filter(f => f.endsWith('.css'))) {
  Object.assign(themeFilePalettes, parseThemesFromCss(readFileSync(resolve(themesDir, file), 'utf8')))
}

// ── Contrast pair definitions ────────────────────────────────────────

interface ContrastPair {
  label: string
  fg: (t: ThemeColors) => string
  bg: (t: ThemeColors) => string
  /** WCAG AA minimum ratio */
  min: number
}

/**
 * The three RESTING reading surfaces. Anything that renders text below
 * 18px (or 14px bold) on one of them owes the full 4.5:1, whatever tier of the
 * type scale it belongs to.
 */
const RESTING: { name: string; bg: (t: ThemeColors) => string }[] = [
  { name: 'bg-primary',   bg: t => t.bgPrimary },
  { name: 'bg-secondary', bg: t => t.bgSecondary },
  { name: 'bg-elevated',  bg: t => t.bgElevated },
]

/** `fg` on all three resting surfaces at the normal-text floor. */
function onEveryRestingSurface(
  token: string,
  fg: (t: ThemeColors) => string,
): ContrastPair[] {
  return RESTING.map(s => ({ label: `${token} on ${s.name}`, fg, bg: s.bg, min: 4.5 }))
}

const normalText: ContrastPair[] = [
  // Primary body text sits on every surface — cards/modals/rows use bg-elevated,
  // hovered/pressed rows use bg-hover.
  ...onEveryRestingSurface('text-primary', t => t.textPrimary),
  { label: 'text-primary on bg-hover',     fg: t => t.textPrimary,   bg: t => t.bgHover,     min: 4.5 },
  // Secondary text (subtitles, metadata) renders on the primary/secondary/elevated
  // resting surfaces — all require the full 4.5:1 for normal-size text.
  ...onEveryRestingSurface('text-secondary', t => t.textSecondary),
  // --text-muted is the de-emphasis tier, not an exemption from AA. It carries ~100
  // `color:` declarations and all but a handful render at 11-15px: empty states
  // (.wtEmpty, .calDetailEmpty, .wtSetEmpty), settings hints and footers, stat
  // labels, dates, placeholders. Classifying it large-text-only held real body copy
  // to 3:1 — and every dark variant sat under 4.5:1 on bg-elevated, down to
  // amethyst-dark's 2.87:1 (LIFT-1096).
  ...onEveryRestingSurface('text-muted', t => t.textMuted),
  // --danger and --success are semantic TEXT colours as often as they are fills:
  // .settingsSignOut (15px), .deleteConfirmError (12px), .wtClearBtn (13px),
  // .wtPrBadge (11px), .wtSet1RM (15px), .wtPRConnector (12px). None of those reach
  // the large-text threshold, so 3:1 never applied to them either.
  ...onEveryRestingSurface('danger', t => t.danger),
  ...onEveryRestingSurface('success', t => t.success),
  { label: 'text-on-accent on accent',     fg: t => t.textOnAccent,  bg: t => t.accent,      min: 4.5 },
]

const largeText: ContrastPair[] = [
  // bg-hover is a *transient* pressed/hover feedback surface, not a resting reading
  // surface. Primary text on it still gets the full 4.5:1 guard; the de-emphasised
  // tiers on a momentary hover background are held to the 3:1 large/UI floor.
  { label: 'text-secondary on bg-hover (transient)', fg: t => t.textSecondary, bg: t => t.bgHover, min: 3 },
  { label: 'text-muted on bg-hover (transient)',     fg: t => t.textMuted,     bg: t => t.bgHover, min: 3 },
  { label: 'danger on bg-hover (transient)',         fg: t => t.danger,        bg: t => t.bgHover, min: 3 },
  { label: 'success on bg-hover (transient)',        fg: t => t.success,       bg: t => t.bgHover, min: 3 },
  { label: 'accent on bg-primary (large)',        fg: t => t.accent,   bg: t => t.bgPrimary,   min: 3 },
  { label: 'accent on bg-secondary (large)',      fg: t => t.accent,   bg: t => t.bgSecondary, min: 3 },
]

/**
 * --text-muted must stay *visibly* quieter than --text-secondary, or raising it to
 * the AA floor silently deletes a tier of the type scale. The light variants set the
 * house style: muted pinned just over 4.5:1 on the worst-case resting surface, with
 * secondary 1.2-1.4 ratio points above it. Anything under a full point apart reads
 * as one tone.
 */
const MIN_TIER_SEPARATION = 1.0

// ── Tests ────────────────────────────────────────────────────────────

describe('theme contrast audit (WCAG 2.1 AA)', () => {
  it('parses all 10 themes (20 variants) from index.css', () => {
    // 10 themes × light/dark. Guards against a parser regression silently
    // dropping variants and leaving the audit green on an empty set.
    expect(Object.keys(themes).length).toBe(20)
  })

  // Auditing index.css only proves anything about the running app while the
  // lazy-loaded twin agrees with it. `loadThemeCSS` appends src/themes/<id>.css
  // as a <link> AFTER the bundled stylesheet — equal specificity, later in source
  // order, so it wins — and the build plugin deletes the non-eternal blocks from
  // the bundled index.css outright. Without this, a token fixed in one file and
  // missed in the other reads as a clean pass on a palette no user ever sees.
  it('every theme file matches its index.css block token-for-token', () => {
    expect(Object.keys(themeFilePalettes).length).toBe(20)
    for (const [name, fileColors] of Object.entries(themeFilePalettes)) {
      expect(themes[name], `src/themes has ${name}, index.css does not`).toBeDefined()
      expect(fileColors, `src/themes/*.css and index.css disagree for ${name}`).toEqual(themes[name])
    }
  })

  for (const [name, colors] of Object.entries(themes)) {
    describe(name, () => {
      // De-emphasis has to survive the AA floor, not be erased by it.
      it(`text-muted stays a tier below text-secondary`, () => {
        for (const surface of RESTING) {
          const bg = surface.bg(colors)
          const muted = contrastRatio(colors.textMuted, bg)
          const secondary = contrastRatio(colors.textSecondary, bg)
          expect(
            secondary - muted,
            `${surface.name}: text-secondary ${secondary.toFixed(2)}:1 vs text-muted ` +
              `${muted.toFixed(2)}:1 — the two tiers render as one tone`,
          ).toBeGreaterThanOrEqual(MIN_TIER_SEPARATION)
        }
      })

      for (const pair of normalText) {
        it(`${pair.label} ≥ ${pair.min}:1`, () => {
          const ratio = contrastRatio(pair.fg(colors), pair.bg(colors))
          expect(
            ratio,
            `${pair.label}: ${ratio.toFixed(2)}:1 (need ${pair.min}:1) — fg ${pair.fg(colors)} bg ${pair.bg(colors)}`,
          ).toBeGreaterThanOrEqual(pair.min)
        })
      }
      for (const pair of largeText) {
        it(`${pair.label} ≥ ${pair.min}:1`, () => {
          const ratio = contrastRatio(pair.fg(colors), pair.bg(colors))
          expect(
            ratio,
            `${pair.label}: ${ratio.toFixed(2)}:1 (need ${pair.min}:1) — fg ${pair.fg(colors)} bg ${pair.bg(colors)}`,
          ).toBeGreaterThanOrEqual(pair.min)
        })
      }
    })
  }
})

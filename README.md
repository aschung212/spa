# Lift — Workout Tracker PWA

A **mobile-first Progressive Web App** for tracking strength training, bodyweight, and personal records. Built with Vue 3 + TypeScript, Pinia, Supabase, and hand-rolled SVG — no UI component libraries, no external chart packages. Designed to feel like a native iOS app.

**[→ Live App](https://spa-rho-sandy.vercel.app)**

![Vue 3](https://img.shields.io/badge/Vue-3.4-42b883?logo=vue.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-6-646cff?logo=vite&logoColor=white)
![Supabase](https://img.shields.io/badge/Supabase-cloud--sync-3ecf8e?logo=supabase&logoColor=white)
![PWA](https://img.shields.io/badge/PWA-installable-5a0fc8)
![Tests](https://img.shields.io/badge/tests-1279_passing-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)

<p align="center">
  <img src="docs/screenshots/IMG_5472.PNG" alt="Exercise detail with PR chart" width="230" />
  &nbsp;&nbsp;
  <img src="docs/screenshots/IMG_5455.PNG" alt="Calendar view with tag filtering" width="230" />
  &nbsp;&nbsp;
  <img src="docs/screenshots/IMG_5408.jpg" alt="Body weight tracker" width="230" />
</p>

---

## What It Does

Lift lets you track any strength exercise over time. Log a set (weight + reps + date), and the app immediately computes your estimated 1-rep max, detects whether you just hit a personal record, and plots your progress on a time-proportional SVG chart. Sign in with Google or email to sync your data across devices via Supabase.

---

## Features

### Workout Tracking
- Log weight, reps, and date for any exercise
- Epley 1RM estimation (`weight × (1 + reps / 30)`) computed on every set
- Per-exercise SVG line chart — best estimated 1RM per day with area fill, time-proportional x-axis
- PR detection — gold row highlight + trophy badge on personal record sets
- Tap an exercise to open a full detail modal with tabbed views: All Sets and PRs
- Sets grouped by date headers for easy scanning
- PR History tab — shows each PR with weight × reps, e1RM, and days since previous PR
- Graph updates per tab: full e1RM history on All Sets, PR staircase on PRs
- Set list capped at 10 most recent, with "Show all" toggle
- Full CRUD: add, edit, and delete individual sets and exercises
- Exercise list orders itself by recency — the exercise you trained most recently floats to the top, and the sort is applied after search and tag filtering so a filtered subset stays recency-ordered too

### Exercise Search
- Instant search bar for filtering exercises by name
- Debounced input for smooth performance with large exercise lists

### Exercise Tags
- Tag exercises with custom labels (e.g. Chest, Legs, Push)
- Add tags when creating a new exercise or editing an existing one
- Tappable tag picker with toggle chips — theme-colored, no rainbow
- Multi-tag filtering on both Workouts and Calendar tabs (ANY match)
- Inline "× Clear" chip at end of tag row when filters are active — no layout shift

### Gym Filtering
- Assign exercises to the gyms you train at (multi-gym membership; leave empty to show an exercise everywhere)
- Exclusive gym filter row above the tag chips — pick where you're training today and other gyms' equipment disappears
- Always-visible row defaulting to "All Gyms"; the zero state shows an "Add Gym" chip so your first gym is one tap away
- Composes with tags: gym narrows the list, tags filter within it (quick-log picker follows too)
- Gym manager for create/rename/delete plus bulk per-gym exercise assignment; gyms can also be created inline while editing an exercise, or from Settings
- Active gym selection remembered per device (not synced — your phone can be at Gym A while your iPad stays on All)
- Exercise-first manager (Settings › Exercises) for the inverse sweep: every exercise in one searchable list, each showing which gyms it's at and expanding to edit its gyms and muscle-group tags together

### Guided Session Plan (Repeat Last Session)
- A "Repeat last session" card above the exercise list turns your history into today's plan — no templates to author
- Shows the last training day in the current scope (gym + tag filters) with exercise count, set count, and date
- Expands into a per-exercise checklist: planned sets, top set from last time, and live done-today progress with checkmarks
- Tapping a row opens the log modal, where the usual ladder's one-tap ghost logging takes over
- With a single tag active it becomes that day's plan — "Repeat last Push session"

### Usual Ladder (One-Tap Set Logging)
- Detects your habitual set progression per exercise across recent sessions (e.g. 45×10 → 95×10 → 135×10 …), tolerant of occasional deviations
- The log modal shows the ladder as chips: done rungs strike through, skipped rungs dim, the next rung highlights
- Ghost prefill: with empty fields, the next rung appears as placeholders and the Save button reads "Save 135 × 10" — one tap logs each habitual set
- Falls back to last-session chips when no routine is detected

### Progressive Overload Suggestions
- Analyzes recent training history per exercise
- Suggests weight or rep increases when performance plateaus
- Surfaces as a tappable suggestion card right before your habitual top set — only on high-confidence signals
- Rate-limited so it never nags: at most one nudge per day across all exercises, 7-day per-exercise cooldown, and ignoring it backs off further (14/28 days, then muted until your top weight changes)

### Workout Templates
- Save current exercise list as a named template
- Load templates to quickly set up a workout
- Manage saved templates from the workout screen

### Rest Timer
- Circular progress ring with countdown display — Apple Timer style
- Dedicated play/pause/restart button below the ring
- Configurable duration presets as tappable pills
- Auto-starts after logging a set (configurable separately from enable/disable)
- Persistent bottom bar shows live countdown while browsing the app
- Timer continues running when modal is dismissed
- Visual warning flash when timer completes
- Configurable rest times and alert warnings in timer settings

### Training Calendar
- Monthly and weekly views of all training days
- Accent-colored exercise dots per day
- Trophy badge on days/exercises where a PR was set
- Tap any day to expand its detail panel
- Tap any exercise tag to expand all sets logged that day
- Set count badge on each exercise tag
- Log sets directly from the calendar
- Tag filtering shared with workouts tab
- Weekly view surfaces a muscle-group volume snapshot (tap any tag to drill into its week-over-week volume trend) plus an overall training-volume trend line (hand-rolled SVG)

### Body Weight Tracking
- Log daily weigh-ins with date
- Time-proportional SVG line chart filtered by period: 7d / 30d / 90d / 1y
- Stats row per period: Change, Low, High, Avg
- All-time low (green) and high (red) highlighted in the entry list
- Per-entry delta from previous weigh-in (green for down, red for up)
- Entries sorted by date
- Smart date label spacing to prevent overlap

### Tag Management
- Rename and delete tags from a dedicated tag manager
- Edit exercise-tag associations in bulk
- Theme-colored tag chips throughout the UI

### Auth & Sync
- Google OAuth or email/password sign-in via Supabase
- Optimistic local-first writes: UI updates instantly, Supabase syncs in background
- Debounced sync queue — batches rapid mutations to avoid excessive API calls
- Multi-device conflict resolution with last-write-wins strategy
- One-time migration of existing localStorage data on first sign-in
- Data persists in localStorage for offline use; Supabase for cross-device sync
- Sample/onboarding data excluded from sync to keep remote store clean

### UI & Experience
- Bottom tab bar with sliding liquid glass indicator (when glass mode is on)
- Tab animation on switch
- 10 themes with visual preview dots: Eternal, Origin, Fortitude, Intensity, Flow, Stability, Luck, Focus, Energy, Love
- Light / Auto / Dark mode — auto follows system `prefers-color-scheme`
- Liquid Glass mode — frosted glass cards, tab bar, and modals with per-theme ambient mesh gradients
- Settings bottom sheet — iOS-style grouped sections for Appearance, Features, and Account
- Swipe-to-dismiss on bottom sheets and modals with velocity-based flick detection
- Undo toast for destructive actions (delete exercise, delete set, clear data)
- Service worker update prompt — "New version available" banner with one-tap update
- Keyboard shortcuts for power users — press `?` to view the shortcut help dialog
- CSV and JSON data export from settings
- Apple Health-compatible bodyweight CSV export from the Weight tab (share sheet → Files / AirDrop / Health importer apps)
- Active tab persisted across sessions
- All touch targets meet iOS 44pt minimum
- All text meets 11pt minimum font size
- Toggle switches sized to iOS standard (51×31pt)
- Improved contrast ratios across all themes for accessibility
- Portrait-only: landscape blocked with a clean overlay
- Safe-area insets respected for notched devices

---

## Tech Stack

| Layer | Choice | Why |
|---|---|---|
| **Language** | TypeScript (strict) | Type-safe stores, composables, and lib modules |
| **UI framework** | Vue 3 (`<script setup>`) | Fine-grained reactivity; single-file components |
| **State** | Pinia | Lightweight store; syncs to localStorage on every mutation |
| **Backend / Auth** | Supabase | Postgres with RLS, Google OAuth, email auth |
| **Build** | Vite 6 | Sub-second HMR, native ESM |
| **PWA** | `vite-plugin-pwa` + Workbox | Pre-caches all static assets; installable on iOS & Android |
| **Charts** | Hand-rolled SVG | `<polyline>` + `<polygon>` computed from normalized data — no chart library |
| **Styling** | CSS custom properties | All themes + glass tokens are a single `data-theme` attribute swap |
| **Deployment** | Vercel | Deployed from CI after the DB migration applies; environment variables set in dashboard |

---

## Architecture Notes

### Local-first writes
Every action updates Pinia state and `localStorage` immediately, then fires a Supabase call in the background. The UI never waits on the network.

### Code splitting
Tab content components are lazy-loaded via `defineAsyncComponent()` with dynamic `import()`. This keeps the initial bundle small — only the auth screen and shell load upfront; heavy components like WorkoutTracker (34 KB) load on demand after sign-in.

### PR detection
`getExercisePR(exerciseId, sinceDate)` returns the max `estimated1RM` across an exercise's sets on or after `sinceDate` (all-time when it is null). Any set where `set.estimated1RM === PR` gets the gold treatment — in both the workout list and the calendar.

`sinceDate` comes from one place, `usePRBaseline().prBaselineDate`, which resolves the **strength baseline mode** (#1272): *Lifetime* uses the manual "evaluate PRs since" anchor as-is, while *Recent* uses a rolling window (8 weeks by default) so a cut is measured against recent work instead of an out-of-reach peak-bulk PR. Both modes collapse to that single day key, so badges, log-set suggestions, and XP scoring stay in agreement without any of them knowing the mode exists.

### Calendar PR map
A `prMap` computed property (`YYYY-MM-DD → Set<exerciseName>`) is derived from the store at render time. The calendar reads this to show trophy badges on cells and exercise tags without any extra queries.

### Glass system
Each theme defines `--glass-fill`, `--glass-edge`, `--glass-shine`, `--glass-bar`, `--glass-overlay`, and `--mesh` tokens. When `data-glass="on"` (default), cards and chrome use `backdrop-filter: blur()` with translucent fills. `data-glass="off"` overrides fall back to solid `--bg-secondary` / `--bg-elevated` values. The tab bar indicator only renders in glass mode.

### Sync infrastructure
A debounced sync queue (`lib/syncQueue.ts`) batches rapid Pinia mutations into coalesced Supabase writes. A conflict resolver (`lib/conflictResolver.ts`) implements last-write-wins with `updated_at` timestamp comparison when merging remote and local state.

### iOS HIG compliance
All interactive elements meet Apple's 44pt minimum touch target. Font sizes are 11pt minimum throughout. Toggle switches are 51×31pt. Text contrast ratios are tuned per-theme for WCAG AA compliance. Safe areas are respected for notched devices.

---

## Testing & CI

### Unit & Component Tests (Vitest)

1279 tests across 54 test files, covering stores, composables, library modules, and Vue components:

| Layer | What's covered |
|---|---|
| **Stores** | Exercise/set CRUD, Epley 1RM, PR detection, bodyweight stats, preference toggles, progression XP and theme unlocks, sync fuzzing |
| **Composables** | Theme switching, color modes, auth flows (OAuth, email, sign-up with duplicate detection), keyboard shortcuts, undo toast, swipe-to-dismiss, focus trap, haptics, PR burst, tag recovery/volume |
| **Library** | Sync queue debouncing/coalescing, conflict resolver (last-write-wins, merge strategies), CSS/meta/manifest/SEO/theme-contrast/vercel-headers regression suites, CSV import, data export, plate calculator, XP migration |
| **Components** | WorkoutTracker, BodyweightTracker, AuthScreen, ExerciseGraph, OnboardingScreen, CalendarView, ErrorBoundary, StarterPickerFlow, SkeletonLoader, MuscleGroupChart/Recovery, VolumeTrendChart, PR target, accessibility attributes |

```bash
npm test           # run all tests
npx vitest --ui    # interactive test explorer
```

### CI Pipeline

GitHub Actions runs on every push and PR to `master`:

1. `npm ci` — deterministic install
2. `npm run lint` — ESLint with Vue plugin (0 errors)
3. `npm run build` — Vite production build
4. `npm test` — full test suite
5. **Lighthouse CI** (PRs only) — runs `@lhci/cli autorun` against `npm run preview` and asserts category budgets (accessibility ≥ 0.87 as a hard gate — the observed baseline, to be ratcheted toward 0.9 as the failing audits are fixed; performance/best-practices/SEO as advisory warnings). Config in `lighthouserc.json`; full HTML reports upload as the `lighthouse-report` artifact. Complements the static 512 KB JS bundle budget with real rendered-page Core Web Vitals.

### Code Quality

- **TypeScript** in strict mode — typed stores, composables, and library modules with exported interfaces (`Exercise`, `WorkoutSet`, `BodyweightEntry`, `FeatureFlags`)
- **ESLint** with `eslint-plugin-vue/recommended` + `typescript-eslint` — enforced via CI and pre-commit hook
- **Husky + lint-staged** — lints staged `.js` and `.vue` files before every commit
- **Error boundary** — global Vue error handler with graceful fallback UI
- **Accessibility** — ARIA attributes, keyboard navigation, focus management on modals

---

## Performance

- **Code splitting** — tab content (`WorkoutTracker`, `CalendarView`, `BodyweightTracker`) lazy-loaded via `defineAsyncComponent` with dynamic imports
- **Local-first architecture** — UI updates instantly via Pinia + localStorage; Supabase syncs in background
- **PWA pre-caching** — Workbox service worker pre-caches all static assets for offline use
- **Zero external UI/chart libraries** — hand-rolled SVG charts and CSS-only components keep the bundle lean (~300 KB gzipped JS)

---

## Getting Started

```bash
git clone https://github.com/aschung212/Lift.git
cd lift
npm install
```

Create `.env.local` with your Supabase credentials:

```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

Run the Supabase migration in `supabase/migration.sql` to create the required tables and RLS policies, then:

```bash
npm run dev   # http://localhost:5173
```

### Production build

```bash
npm run build    # outputs to dist/
npm run preview  # preview production build locally
```

### Deploy

Push to GitHub, connect to [Vercel](https://vercel.com), and add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as environment variables in the Vercel dashboard. Enable Google as an OAuth provider in Supabase and add your Vercel domain to the allowed redirect URLs.

Production is **not** deployed by Vercel's git integration: `vercel.json` sets `git.deploymentEnabled: { master: false }`, and CI's `deploy-production` job builds and deploys after `migrate-db` has applied the schema, so new code never reaches users ahead of the column it reads. PR branches still get git-integration previews as usual. That job needs three repository secrets — `VERCEL_TOKEN` (create at <https://vercel.com/account/tokens>) plus `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` (the `orgId`/`projectId` in `.vercel/project.json` after running `vercel link`). Without them nothing reaches production, so the job fails fast and says exactly that.

### Native iOS build (Capacitor)

The PWA is wrapped with [Capacitor 8](https://capacitorjs.com) for the App Store. The
shared config lives in `capacitor.config.ts` (`appId: com.aschung212.lift`). The native
`ios/` project is generated per-machine and is **not** committed — it depends on a local
Xcode + CocoaPods toolchain. Generate and run it on the Simulator with:

```bash
# One-time: generate the native Xcode project (requires Xcode + CocoaPods)
npx cap add ios

# Build the web bundle and sync it into the native project
npm run cap:build        # = npm run build && npx cap sync

# Open the project in Xcode, then build & run on a Simulator (e.g. iPhone 15 Pro)
npm run cap:open:ios
```

In Xcode, set the **iOS Deployment Target to 16.0** (App target → General → Minimum
Deployments) for broad device coverage with modern APIs. The app should launch to the
auth screen with no white screen. Re-run `npm run cap:build` after any web change to
re-sync the `dist/` bundle into the native shell.

---

## Project Structure

```
├── public/
│   ├── icon.svg
│   ├── icon-192.png
│   ├── icon-512.png
│   ├── apple-touch-icon.png
│   └── launch/                 # iOS PWA launch screens (apple-touch-startup-image), per device
├── scripts/
│   ├── generate-icons.js
│   └── generate-launch-screens.js  # Renders themed iOS launch PNGs (pure Node, no deps)
├── src/
│   ├── components/
│   │   ├── WorkoutTracker.vue   # Exercise list, detail modal, log/edit modal, rest timer, tags
│   │   ├── ExerciseGraph.vue    # Per-exercise SVG line chart (time-proportional)
│   │   ├── CalendarView.vue     # Monthly/weekly calendar, PR map, set detail, tag filtering
│   │   ├── BodyweightTracker.vue # Weight log, period stats, SVG chart, low/high badges
│   │   ├── AuthScreen.vue       # Email/password + Google sign-in
│   │   ├── ErrorBoundary.vue    # Global error handler with fallback UI
│   │   ├── OnboardingScreen.vue # Welcome flow with 3 entry paths
│   │   └── __tests__/           # Component tests (159 tests)
│   ├── composables/
│   │   ├── useTheme.ts              # Themes, mode (light/auto/dark), glass toggle, rest timer toggle
│   │   ├── useAuth.ts               # Supabase session, OAuth + email auth, store init on sign-in
│   │   ├── useAnalytics.ts          # Lightweight event logging
│   │   ├── useUndoToast.ts          # Undo toast with timed rollback
│   │   ├── useSwipeToDismiss.ts     # Touch gesture dismissal for modals and sheets
│   │   ├── useKeyboardShortcuts.ts  # Global keyboard shortcuts with help dialog
│   │   └── __tests__/               # Composable tests (43 tests)
│   ├── stores/
│   │   ├── workout.ts           # Exercises + sets CRUD, Epley 1RM, PR getter, tags, Supabase sync
│   │   ├── bodyweight.ts        # Weight entries CRUD, min/max getters, Supabase sync
│   │   ├── preferences.ts       # Feature toggles (tab visibility), Supabase sync
│   │   ├── templates.ts         # Workout template save/load
│   │   └── __tests__/           # Store tests (76 tests)
│   ├── lib/
│   │   ├── supabase.ts          # Supabase client singleton
│   │   ├── migrate.ts           # One-time localStorage → Supabase migration
│   │   ├── syncQueue.ts         # Debounced sync queue for batching Supabase writes
│   │   ├── conflictResolver.ts  # Last-write-wins conflict resolution for multi-device sync
│   │   ├── tagColors.ts         # Theme-aware tag color mapping
│   │   ├── uuid.ts              # UUID generation utility
│   │   └── __tests__/           # Library tests (21 tests)
│   ├── App.vue                  # Tab bar, settings sheet, theme picker, auth gate
│   ├── main.ts                  # App entry point
│   └── index.css                # All theme tokens, glass tokens, component styles
├── supabase/
│   └── migration.sql            # Creates exercises, sets, bodyweight_entries with RLS
├── .github/
│   ├── workflows/ci.yml         # GitHub Actions: lint, build, test
│   ├── ISSUE_TEMPLATE/          # Bug report and feature request templates
│   └── pull_request_template.md # PR template with checklist
├── CONTRIBUTING.md               # Contribution guide with setup, conventions, and PR process
├── index.html
├── vite.config.js
├── vitest.config.js
├── eslint.config.js
└── vercel.json
```

---

## Installing on Mobile

- **iOS (Safari):** Share → "Add to Home Screen" → launches in standalone mode with portrait lock
- **Android (Chrome):** Menu → "Add to Home Screen" or install prompt
- Once installed, all assets are pre-cached by the Workbox service worker for offline use
- The PWA manifest enforces portrait orientation when installed

---

## License

MIT

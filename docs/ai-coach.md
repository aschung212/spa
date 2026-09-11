# AI Coach — AI Review (design)

> **Naming (#972):** the user-facing feature name is **"AI Review"** (sheet title, aria-labels,
> download filename `lift-ai-review-YYYY-MM-DD.md`). It was called "Weekly Review" until
> 2026-07-16; the weekly *cadence* (quota window, digest framing) is unchanged — only the label.

Status: **Phase 1 in progress** (backend scaffold landed; UI + consent + deletion wiring remain).
The live transport today is the **bring-your-own-AI export** (open loop, no server) — see below —
because the Anthropic key the server needs isn't provisioned yet. Flip `COACH_MODE` to `'server'`
in `src/lib/coachExport.ts` once it is.

An opt-in feature where a user taps once and gets an LLM-generated **AI Review** of
their training — a fixed-shape digest rendered as themed cards. It is the smallest surface
that delivers a genuine, differentiating coaching moment without the cost, abuse,
hallucination, and prompt-injection blast radius of free-form chat.

## Why this earns its place (CLAUDE.md Principle 2: no feature bloat)

The app already computes PRs, e1RM, ladders, overload nudges, and volume **deterministically**.
A coach that merely restates those numbers in prose *is* bloat. The net-new value is the one
thing the deterministic engine cannot do: **cross-signal synthesis** — weighing progress +
volume balance + consistency + the overload suggestion against each other and naming the single
most useful thing to focus on next. If a week has nothing worth saying, the review renders a
graceful "nothing notable changed" state instead of padding.

This collapses the three UX options we considered into the best one:
- **Not** free-form chat (biggest cost/abuse/injection surface; weekly cadence doesn't suit it).
- **Not** an "ask N questions" menu (its value is absorbed by the digest's four sections,
  delivered proactively instead of making the user pick).
- A single weekly **AI Review** digest, server-validated against a fixed JSON schema.

## The load-bearing reality

Lift is a pure static SPA today — **zero server-side compute** before this feature. The entire
trust boundary (key secrecy, quota, consent) depends on a backend that did not exist. So the
**first deliverable is the backend** (`api/coach.ts` + the migration), and the client-side
counter is cosmetic — the server is the only real cap.

## Bring-your-own-AI export (interim transport + permanent free tier) — #931

The whole coaching brain is pure and client-side (`buildCoachPayload`, `COACH_SYSTEM_PROMPT`,
`buildCoachUserMessage`); the server only ever added the API key, the quota, and the network
destination. So until the key is provisioned we deliver the value with **zero server**:

- `src/lib/coachExport.ts` composes the recommended prompt + the optional `<athlete>` block +
  the `<data>` block into one paste-ready text (`buildCoachExportText`). The prompt is an
  **analyst** prompt (analyze → synthesize → prescribe), not a summarizer: it asks the model to
  derive per-exercise progression, ramp/frequency/recovery patterns, and e1RM reliability, then
  name the single highest-leverage change and prescribe concretely — individualized to `<athlete>`
  and adapting to bodybuilding / powerlifting / general fitness. It bakes in the known pitfalls
  (e1RM inflation on high-rep sets; machine lifts aren't standard-comparable), keeps the DATA-ONLY
  prompt-injection guard, and — because it's read in the user's chat, not parsed by the app — asks
  for **prose of data-driven depth**, not the server's `CoachReview` JSON or a fixed length. It
  references a `derived` analytics block "if present" (forward-compat for the Phase-B pre-computed
  stats).
- **Athlete profile (`src/lib/coachProfile.ts`) — the biggest quality lever.** A versioned,
  sanitized `CoachProfile` (sex/age/height/experience/goal/priorities/effort-style/schedule/
  injuries/equipment/competition/reviewMode) collected once and **synced in the preferences blob**
  (no DB migration — the `intensityPresets` precedent). `buildAthleteBlock` serializes it into the
  `<athlete>` block, **omitting empty fields** so a sparse profile stays clean and the prompt's
  "state your assumption and proceed, then list what would sharpen it" path engages. Edited in
  `CoachProfileSheet.vue` (reached from the export panel), which shows an "N/total added" meter.
- **Tiered depth.** `reviewMode` (`quick_checkin` | `deep_audit`, default deep_audit) rides in the
  `<athlete>` block and is chosen per export via a segmented control; one prompt serves both.
- `CoachSheet` (when `COACH_MODE === 'byo'`) renders the export panel: review-depth control,
  profile entry point, a bodyweight opt-out (passes `[]` to `buildCoachPayload`), a
  "nothing leaves Lift until you paste it" disclosure, and **Copy to clipboard** + **Download
  `.md`** actions. The server states stay intact behind `mode === 'server'`.
- **Open loop by decision:** no paste-back / JSON round-trip — the coaching lives in the chat.
- No key, no quota, no consent-to-transmit surface (nothing is sent), so the entry point drops the
  sign-in gate in this mode. This also stands as a permanent **free / privacy tier** after the
  server exists: a user's data never leaves the device unless they paste it themselves.
- **Privacy:** the profile adds sensitive fields (age, injuries). In BYO nothing is auto-sent — the
  disclosure states the profile is included only when the user copies/downloads. When `COACH_MODE`
  flips to `'server'`, forwarding the profile to Anthropic is a **consent bump** (versioned via
  `CURRENT_CONSENT_VERSION`) and an App Store health-data-label consideration; wire that with #849.
- **Derived analytics (Phase B, landed):** a single LLM call has no compute, and making the model
  do arithmetic over hundreds of sets drifts on exactly the numbers users care about — so the app
  pre-computes the analyses in pure `src/lib/coachAnalytics.ts` and ships them as the payload's
  `derived` block (`buildCoachPayload` attaches it; types/caps/validation live in the shared
  `aiCoach.ts` contract, so the dormant server benefits the moment it wakes). Contents:
  per-exercise progression (first/best/recent e1RM, gain, gain/week, reliability flags),
  **reliable 1RM** (best ≤6-rep set of free-weight lifts, with strength-to-bodyweight ratio when
  bodyweight is included — the opt-out passes `[]` → no ratio), warm-up ramp shape (median ramp
  sets + first-set % of top), session shape medians, weekly volume & frequency per muscle tag
  (incl. median rest-gap days), intensity distribution (at-the-time %: <60 / 60–85 / >85), rep-range
  distribution (≤6 / 7–12 / ≥13), and within-session exercise order. Two honesty rules:
  (1) equipment classification is **two-layered** (`resolveExerciseKind`, phase C): the explicit
  per-exercise `Exercise.equipment` field wins — user-set in EditExerciseModal's "Equipment"
  chips (Auto / Free weight / Machine / Bodyweight, where Auto stores nothing and shows what the
  heuristic resolves to), synced via the additive `equipment` text column (always-send like
  `intensity_max_reps`, so "Auto" clears server-side), sanitized at every boundary
  (`sanitizeExerciseEquipment`: store setter, localStorage load, remote fetch — unknown values
  degrade to unset, never trusted) — and the conservative NAME HEURISTIC (`classifyExercise`:
  free_weight / machine / bodyweight / unknown; machine markers beat free-weight markers so
  "Seated Row" is a cable stack) is the fallback for never-classified exercises;
  (2) `exerciseOrder` computes ONLY from real `createdAt` timestamps (#846) — for
  untimestamped sets, cross-exercise order within a day is array order, and we never feed the
  model fabricated sequence.

`COACH_MODE` (in `coachExport.ts`) is the single switch: `'byo'` today, `'server'` once
`ANTHROPIC_API_KEY` et al. are provisioned. Consent (#849) and history (#851) remain their own
follow-ups; the BYO disclosure is a lightweight stand-in, not the versioned consent modal.

## Locked decisions

| Decision | Choice | Notes |
|---|---|---|
| Provider/model | **Claude Opus 4.8** (`claude-opus-4-8`), read from `COACH_MODEL` env | Sonnet 4.6 is a 1-line swap; Haiku 4.5 also priced. Never hardcoded (SEV1). |
| Billing | **Anthropic Console API key**, usage-billed | A Claude **Max subscription is NOT API access** and cannot power an app backend. Separate account/bill. |
| Monetization | **Free forever, premium seam built in** | `coach_usage.limit_override` column lets a future premium tier be a config change, not a rewrite. |
| Bodyweight | **Included in v1**, behind its own opt-out | Most sensitive field; named explicitly in consent + App Store label. |
| Data sent | **Full per-set log** (client windows to ~16 wks) + lifetime PRs + per-set relative intensities + derived volume/consistency/overload | Ground truth, not just aggregates — thin aggregates produce thin coaching. Identifiers (user_id/email/UUIDs) are never sent. |
| Per-user quota | **3 reviews / rolling 7-day window** (`DEFAULT_WEEKLY_LIMIT`) | Rolling, not fixed Mon–Sun. UI copy: "Resets in N days" from server `resetsAt`. |
| Cadence | **Weekly only** | No daily flag/tier in v1. |
| Global spend ceiling | **$2/day** (`COACH_DAILY_CEILING_CENTS=200`) | Abuse brake, not a growth limiter. Provider-side monthly cap ≈ $62. |
| Output cap | `max_tokens` 2500 (`MAX_OUTPUT_TOKENS`) | Leaves room for adaptive thinking + the digest; single-shot (non-streaming). |
| Thinking | Adaptive on for Opus/Sonnet; off for Haiku | The synthesis benefits from reasoning. |
| History | Device-local, last-12 ring (Phase 1) | No `coach_insights` sync until Phase 2 (re-triggers consent bump). |

### Cost model (authoritative pricing, full per-set history)

Input scales with the history window. A serious lifter (4 sessions/wk × ~20 sets) over 12 weeks
is ~960 sets ≈ ~30K input tokens — trivially within Opus's 1M context, ~$0.15 of input. Casual
users are far cheaper. Output is capped at `MAX_OUTPUT_TOKENS` (2500).

| Window (heavy user) | ~Sets | ~Input tok | Opus ~/review | Sonnet ~/review |
|---|---|---|---|---|
| This week only | ~80 | ~3K | ~$0.08 | ~$0.05 |
| 12 weeks (default ~16) | ~960 | ~30K | ~$0.20 | ~$0.13 |
| 26 weeks | ~2,000 | ~62K | ~$0.38 | ~$0.24 |

At Opus with a ~12–16-week window the `$2/day` ceiling buys ~8–10 heavy reviews/day (casual users
cost far less, so the practical mix is higher). It throttles organically around ~100 weekly-active
users — earlier than the aggregate-only design, which is the deliberate trade for usefulness. The
two levers when you grow: raise the ceiling (and the provider monthly cap), or shorten the window.
Hard backstops: `MAX_SETS` (1500), `MAX_INPUT_TOKENS` (80K → 413), `MAX_INPUT_PAYLOAD_BYTES` (512KB).

## Architecture & request flow

A single Vercel serverless function at `api/coach.ts` holds the Anthropic key. The web client
calls it same-origin (`/api/coach`); the native Capacitor build calls the absolute
`https://spa-rho-sandy.vercel.app/api/coach` (read from the authoritative domain, never
fabricated) and that origin must be added to the CSP `connect-src` + the function's CORS
allowlist before the native build ships.

Gate order is load-bearing — every cheap check runs **before any spend**:

1. **Kill switch** — `COACH_ENABLED !== 'true'` → 503 (fail-closed; feature off by default).
2. **Production-only** — `VERCEL_ENV !== 'production'` → 503, so preview deploys aren't live
   spending endpoints. `vercel dev` opts in via `COACH_DEV_ALLOW=1`.
3. **Required config** — `COACH_MODEL`, `ANTHROPIC_API_KEY`, `SUPABASE_URL`,
   `SUPABASE_ANON_KEY` present, and the model is priced; else 503 (never fabricate).
4. **Auth** — verify the JWT via `supabase.auth.getUser(token)`, derive identity from the
   verified `sub`, require `email_confirmed_at` (canonical for email + Google OAuth) → 401/403.
5. **Consent** — server-recorded, versioned (`coach_consent.version >= CURRENT_CONSENT_VERSION`)
   → 403 if absent/stale (a stale synced client blob must not re-enable egress).
6. **Payload** — byte cap + input-token cap (413) then allowlist validation; reject < 8 logged sets (422).
7. **Quota + global pre-charge** — one atomic `claim_coach_request` RPC: pre-charge the max
   possible cost into the daily ledger, then the rolling per-user window reset + increment +
   cap check; refund the global pre-charge if the per-user gate rejects. 429 / 503.
8. **Model call → true-up → sanitize** — single-shot Anthropic call with `output_config.format`
   forcing the schema; `record_coach_usage` trues the global ledger to **actual** token usage
   (refunding the per-user count only on an unbilled upstream failure); then `sanitizeCoachOutput`
   truncates bodies, drops any section with a URL/markdown link, and metric-echoes numbers.

### Data contract (full training picture, identifiers stripped)

The model gets ground truth — the per-set log — plus the app's derived analysis, so it can find
real patterns instead of restating pre-chewed aggregates. Assembled into a typed payload (client
windows the log to ~16 weeks), validated server-side against an allowlist (`validateCoachPayload`
in `src/lib/aiCoach.ts`):

- **sets** — the per-set log (core ground truth): `{ exerciseName, weight, reps, e1rm?, date?, intensityPct?, isPR?, timeOfDay? }`
  where `intensityPct` is the set's weight as a % of the best e1RM achieved **up to that point**
  (intensity *when performed*, not vs the current best — so historical training intensity reads
  truthfully), `isPR` flags an all-time e1RM PR **at the moment it was performed**, and `timeOfDay`
  is the local "HH:MM" the set was performed. Within a day, sets are ordered by real timestamp when
  available, giving within-workout exercise order.
- **personalRecords** — lifetime bests per exercise: `{ exerciseName, bestE1rm, bestWeight?, bestReps?, date? }`
  (so the model knows the whole history without serializing every old set).
- **sessions** — one entry per training day (oldest first): `{ date, tags, setCount }`. Drives
  **rest-day cadence** (gaps between dates) and **training split & rotation** (tags trained each day).
- **volume** — per muscle-group tag: `{ tagName, weeklyVolume }`
- **consistency** — `{ workoutDaysThisWeek, weeklyTarget, streakWeeks, goalMet }`
- **focus** — overload suggestions: `{ exerciseName, type, suggestedWeight, suggestedReps, reason }`
- **bodyweight** (opt-out) — `{ trendDirection, deltaLbs }`

> **`timeOfDay` and within-workout order are now live (#846).** `set.date` stays end-of-day (no
> time, per #746); a separate `WorkoutSet.createdAt` carries the real log time — surfaced from the
> server `sets.created_at` column for synced/historical sets and stamped at log time in `logSet` for
> new/offline sets. The builder reads it for `timeOfDay` ("HH:MM" local) and orders within a day by
> real timestamp. **Accuracy caveat:** `created_at` is insert/sync time — ≈ training time for live
> online logging, but skewed for log-offline-then-sync-later or backfilled sets. It also stores only
> a UTC instant (no captured offset), and `timeOfDay` is rendered in the timezone of the device that
> *builds* the digest — so a set trained while traveling reads in the digesting device's local time,
> not the training-location time. Treat time-of-day as indicative, not exact. `sessions` (split +
> rest-day cadence) works for all data regardless.

**Never sent:** exercise/session/set UUIDs, user_id, email, auth tokens, XP log, preferences.
Identifiers are used for quota/consent only and never forwarded to the model. Exercise names are
the one semi-PII free-text field that crosses the boundary; they are length-capped, delimited as
data, and treated as untrusted (prompt-injection vector). The spend guard requires at least
`MIN_SETS_FOR_REVIEW` (8) logged sets before a review is generated.

## Guardrails (defense in depth)

- **Key** lives only in Vercel server env (Production scope, never `VITE_`-prefixed). The proxy
  keeps `api.anthropic.com` out of the bundle and CSP. (Recommended: a bundle-grep regression
  test asserting the bundle never references `api.anthropic.com`.)
- **Quota** in `coach_usage` with **no client write policy**; written only by the
  `SECURITY DEFINER` RPC that derives `user_id` from `auth.uid()` and `SET search_path = ''`.
- **Global daily ceiling** (`coach_global_spend`) — two-phase pre-charge/true-up, the true bound
  against multi-account farming. On trip → 503 "coach paused for today."
- **Provider-side monthly budget cap** ≈ ceiling × 31 as the dollar backstop.
- **Vercel WAF rate rule + BotID** on `/api/coach`; Attack Mode + the `COACH_ENABLED` flag are
  the documented kill switches.
- **Output is untrusted too** — rendered via Vue text interpolation (never `v-html`), sanitized
  before persist and before the share-card rasterizer.

## Privacy / consent / App Store

Bodyweight + training history go to a new third-party sub-processor (Anthropic). The consent +
disclosure work must ship in the **same PR as the UI** (CLAUDE.md Documentation Mandate):

- Versioned opt-in consent gate (centered modal) before first use; stored in preferences
  (`aiCoachConsent: { accepted, acceptedAt, version }`, sanitized at the same points as
  `intensityPresets`) **and** server-side via `record_coach_consent` (server is authoritative).
- `LegalSheet.vue` updated to name the LLM provider as a processor of health/fitness data, list
  the exact fields sent (the per-set log — exercises, weights, reps, dates — plus PRs, relative
  intensities, volume, consistency, and bodyweight), and state the **actual** retention posture —
  do not write "zero data retention" until verified in writing (SEV1 fabrication trap).
- A hosted `/privacy` route (`public/privacy.html` + a `vercel.json` rewrite exception) for the
  App Store listing.
- App Store nutrition label: Health & Fitness → **Data Linked to You = Yes**,
  **Used for Tracking = No**, **Third-Party Sharing = Yes**.

## UX (Phase 1, after backend)

- One entry point: a compact **top-bar icon button on the Calendar tab** (#972) — the
  retrospective surface — mirroring the contextual "+" that shows on the Workouts tab. It
  replaced the original full-width Workouts-page card, which was too prominent for an
  infrequently used feature. Appears only with ≥2 weeks of data; the quota meter now lives
  inside the sheet header, not the entry point.
- Tapping opens `CoachSheet` (built on `useModal` for the #830 scroll lock) with four states:
  consent gate → loading skeleton → result cards → quota-exceeded ("Resets in N days").
- No text input on the primary path → sidesteps the iOS-keyboard-modal bug class.

## Status: what landed vs what remains

**Landed (this scaffold PR):**
- `src/lib/aiCoach.ts` — pure contract + guardrails (payload validation, output sanitization,
  cost model, schema, prompt) + unit tests.
- `api/coach.ts` — the Vercel function with the full gate chain.
- `supabase/migrations/20260627000000_add_ai_coach_tables.sql` — `coach_usage`,
  `coach_global_spend`, `coach_usage_log`, `coach_consent`, and the `SECURITY DEFINER` RPCs
  (`claim_coach_request`, `record_coach_usage`, `record_coach_consent`, `delete_coach_data`).
- `vercel.json` `ignoreCommand` now includes `api/` and `vercel.json` (else a function-only
  change ships green in CI and 404s in prod). *(That list became a denylist in LIFT-1354 —
  it now names the paths that DON'T deploy. Both of these stay deployable, by not being
  excluded rather than by being listed.)*
- `src/lib/coachDigest.ts` — pure payload builder (`buildCoachPayload`) mirroring
  `buildSessionSummary`: full per-set log windowed to ~16 weeks (`setDayKey`-bucketed),
  lifetime PRs, per-set relative intensities, current-week volume, consistency, bodyweight
  trend, weights unit-converted, identifiers stripped — + 13 tests (validate round-trip +
  no-identifiers assertion).
- `src/lib/coachHistory.ts` (LIFT-851) — device-local insight ring. Persists generated
  reviews to localStorage (`coach-insights-history`) as a **last-12 ring** (drop oldest);
  re-opening a cached review is **free** (no quota). `appendCoachInsight` / `loadCoachHistory`
  (newest-first, corrupt + malformed entries dropped) / `clearCoachHistory`. The key is wired
  into `deleteAccount`'s `localStorageKeys` clear. NOT synced — cross-device `coach_insights`
  is a deliberate Phase 2 change. The CoachSheet "Past insights" list consumes this once #848
  lands.

- `CoachSheet` + the entry point (LIFT-848, moved in #972): `src/lib/coachClient.ts` (pure status→
  result mapping + abort-timeout fetch + `daysUntilReset`), `src/composables/useCoach.ts`
  (singleton UI state + device-local cosmetic quota cache + `getSession` token), and
  `src/views/CoachSheet.vue` (idle/loading/result/error states; output rendered via text
  interpolation, NEVER `v-html`). The entry is a `topBarCoachBtn` icon in `App.vue`'s top bar,
  shown on the Calendar tab, gated by `coachReviewEligibility` (≥`MIN_SETS_FOR_REVIEW` sets across
  ≥2 weeks) AND not a preview deploy AND (BYO mode OR signed-in). `CoachSheet` mounts from
  `App.vue` (lazy chunk, fetched on first open) and wires `buildCoachPayload` to
  the stores (`getOverloadSuggestion` → `overloads`, `streakWeeks`/`weeklyTarget`, `toDisplayUnits`).

- **Bring-your-own-AI export (#931)** — `src/lib/coachExport.ts` (`COACH_MODE`, analyst
  `RECOMMENDED_COACH_PROMPT`, `buildCoachExportText`, `coachExportFilename`), the versioned
  athlete profile (`src/lib/coachProfile.ts` + preferences-store persistence + `CoachProfileSheet`),
  tiered `reviewMode`, and the `CoachSheet` export panel (review depth / profile / copy / download /
  bodyweight opt-out) + tests. This is the live transport while the server key is unprovisioned
  (`COACH_MODE = 'byo'`). Phase B (the pre-computed `derived` analytics block,
  `src/lib/coachAnalytics.ts` + contract/validator support in `aiCoach.ts`) landed as the
  follow-up. See the section above.

- **Account deletion (LIFT-1225)** — `deleteAccount()` in `src/composables/useAuth.ts` calls
  `delete_coach_data` alongside its six table deletes, so `coach_usage`, `coach_usage_log` and
  `coach_consent` go with the account. The RPC is **not** an optional extra path: those tables
  have RLS on with SELECT-only policies, and an RLS-blocked `DELETE` is not an error in
  Postgres — it removes zero rows and PostgREST answers `{ error: null }` — so a client-side
  `.from('coach_usage').delete()` would report success while the rows survive. The RPC joins
  the same `Promise.allSettled` batch and is held to the same resolved-`{ error }` assertion
  landed in #1231 (supabase-js *resolves* rather than rejects on RLS/FK/401, the LIFT-784
  trap), so any failure aborts BEFORE the local wipe. Coverage is enforced structurally rather
  than by enumeration: `architecturalInvariants.test.ts` derives every `user_id`-scoped table
  from the migrations and every table `deleteAccount` reaches — directly, through an RPC's own
  `delete from` statements, or by `on delete cascade` — and fails when one is left behind.
  **A new user-scoped table is covered by that invariant the moment its migration lands.**

**Remaining Phase 1:**
- Versioned consent modal + `LegalSheet` update + hosted `/privacy` + nutrition-label answers
  (#849). Until it lands the server 403s `consent_required`; `CoachSheet` surfaces that as a
  non-retryable "accept the Coach privacy terms" message (the consent capture itself is #849).
- Past-insights history (#851) — `useCoach` deliberately holds only transient state today.
- Provision env (`COACH_ENABLED`, `COACH_MODEL`, `ANTHROPIC_API_KEY`, `SUPABASE_URL`,
  `SUPABASE_ANON_KEY`, `COACH_DAILY_CEILING_CENTS`) in Vercel Production scope, plus the
  provider-side monthly budget cap and a Slack spend alert from the function.
- WAF rate rule + BotID on `/api/coach`; CSP `connect-src` + CORS for the native origin.

## Known deploy gotcha

`netlify.toml` is committed (publish=dist, `/*` → index.html, **zero functions**), so
`/api/coach` 404s on any Netlify deploy. Confirm Netlify is dead/removed, or scope the feature
to the Vercel origin and document the exclusion, before launch.

## Local dev / testing

`npm run dev` has no Supabase client (DEV short-circuits in `src/lib/supabase.ts` and `useAuth`),
so the auth-gated function is untestable there. Exercise it via `vercel dev` against a dev
Supabase project with a dev sign-in to mint a JWT; the function stays prod-gated except when
`VERCEL_ENV === 'development' && COACH_DEV_ALLOW === '1'` (a local-only var never set in Vercel).

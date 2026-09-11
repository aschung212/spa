# Browser-Mode Testing (LIFT-666)

Most of Lift's ~2,900 unit/component tests run under **happy-dom** (`vitest.config.js`)
— fast, headless, and perfect for logic and DOM wiring. But happy-dom has no
layout engine: `getBoundingClientRect()`, `offsetHeight`, `offsetWidth`,
`scrollTop`, and `visualViewport` all report **zeros**. A handful of our
iOS-critical composables are layout- and gesture-sensitive and can only be
_wired_-tested there, not _behaviour_-tested:

- `useSwipeToDismiss` — bottom-sheet drag thresholds depend on real
  `offsetHeight` (animate-out distance) and real `scrollTop` (the "am I at the
  top?" guard). Its happy-dom test has to `Object.defineProperty` fake values
  for both.
- `useFocusTrap` — tab-order and focus movement depend on real focusable
  geometry.
- Keyboard-offset / `visualViewport` logic — depends on a real viewport.

**Vitest Browser Mode** runs these same tests in a real Chromium (via the
Playwright provider), where all of that geometry is measured for real.

## What's wired up

- **`vitest.browser.config.js`** — Browser Mode config. Playwright provider,
  headless Chromium, scoped to `src/**/*.browser.test.ts` only.
- **`vitest.config.js`** — the default happy-dom config **excludes**
  `**/*.browser.test.ts`, so no test ever runs in both environments.
- **`npm run test:browser`** — runs the browser suite.
- **`src/composables/__tests__/useSwipeToDismiss.browser.test.ts`** — the first
  real-geometry test. It asserts against actual `offsetHeight` / `scrollTop`
  with **no mocks**, unlike its happy-dom sibling.
- **`src/lib/__tests__/browserModeConfig.test.ts`** — a guardrail (runs in the
  normal suite) that keeps the two configs non-overlapping and the wiring intact.

## Running it locally

`@vitest/browser` and `playwright` are **intentionally not committed to
`package.json` / the lockfile**, mirroring the `@lhci/cli` precedent in
`ci.yml`: they pull Chromium and a large transitive tree that would bloat the
lockfile and trip the `dependency-review` PR gate for a tool that only ever
runs on demand in a browser context. Install them ad hoc:

```bash
npm i -D @vitest/browser@^5 playwright@^1.62
npx playwright install chromium
npm run test:browser
```

> **Note:** the `npm i -D` above will edit `package.json` / `package-lock.json`
> locally. Don't commit that change — it's the whole reason these deps stay out
> of the tree. `git checkout package.json package-lock.json` afterward.

## Version pinning caveat

The `@vitest/browser` major **must** match the installed Vitest major (the repo
is on Vitest `^5`). The exact compatible patch could not be verified inside the
network-restricted overnight builder loop, so `test:browser` was authored but
not executed there. Run it once locally to confirm the resolved versions before
relying on it in CI.

## Wiring into CI (follow-up)

Browser Mode is deliberately kept **out of the PR gate** for now (like Stryker
mutation testing) so an unverified job can't wedge master. When ready, add a
dedicated PR-only job that reuses the existing Playwright browser cache from the
`e2e` job in `ci.yml`:

```yaml
  browser-tests:
    runs-on: ubuntu-latest
    needs: [lint, typecheck]
    if: github.event_name == 'pull_request'
    steps:
      - uses: actions/checkout@... # pin by SHA, matching ci.yml
      - uses: actions/setup-node@...
        with: { node-version: 24, cache: npm }
      - name: Restore node_modules
        uses: actions/cache/restore@...
        with:
          path: node_modules
          key: node-modules-${{ runner.os }}-${{ hashFiles('package-lock.json') }}
      - run: npm i -D @vitest/browser@^5 playwright@^1.62 --no-save
      - run: npx playwright install --with-deps chromium
      - run: npm run test:browser
```

`--no-save` keeps the lockfile clean in CI too.

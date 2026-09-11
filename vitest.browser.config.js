import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'

// ── Vitest Browser Mode config (LIFT-666) ────────────────────────────
// Runs the *geometry-dependent* composable tests in a REAL Chromium via the
// Playwright provider, where getBoundingClientRect / offsetHeight / scrollTop /
// visualViewport report true layout instead of the zeros happy-dom stubs.
//
// This is an OPT-IN, on-demand suite — it is NOT part of `npm test` or the PR
// gate. `@vitest/browser` + `playwright` are intentionally kept out of the
// committed lockfile (mirroring the `@lhci/cli` precedent in ci.yml): they pull
// Chromium and a large tree that would bloat the lockfile and the
// dependency-review gate for a tool that only ever runs in a browser context.
// Install them once to run locally (see docs/browser-mode-testing.md):
//   npm i -D @vitest/browser@^5 playwright@^1.62 && npx playwright install chromium
//   npm run test:browser
//
// Only `**/*.browser.test.ts` files run here; the default happy-dom config
// (vitest.config.js) excludes that same glob so no test runs in both envs.
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      'virtual:pwa-register': fileURLToPath(
        new URL('./src/__tests__/stubs/pwaRegister.ts', import.meta.url)
      ),
    },
  },
  test: {
    globals: true,
    setupFiles: ['src/__tests__/setup.ts'],
    include: ['src/**/*.browser.test.ts'],
    browser: {
      enabled: true,
      provider: 'playwright',
      headless: true,
      instances: [{ browser: 'chromium' }],
    },
  },
})

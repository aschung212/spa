/// <reference types="node" />
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { readFileSync, readdirSync, existsSync } from 'fs'
import { resolve, join } from 'path'

/**
 * Guard: the dev sign-in bypass must never ship to production (LIFT-1123).
 *
 * AuthScreen exposes a "Continue as Dev" button that calls devSignIn(), which
 * fabricates a `{ id: 'local-dev' }` session and skips the entire auth gate. It
 * exists only for local dev and the CI e2e build (which sets VITE_E2E=true).
 *
 * The button lives in DevSignInButton.vue, lazily imported by AuthScreen behind
 * a build-time `import.meta.env.VITE_E2E` flag, so a normal production build
 * folds the flag to false, tree-shakes the component, and never emits its chunk.
 * The only thing that could reintroduce it is a misconfigured Vercel env var
 * setting VITE_E2E — a silent auth-UI bypass with no other gate.
 *
 * These are structural pins (mirroring metaRegression.test.ts). The definitive
 * build-output check — grep the real production dist/ — runs in CI via
 * `npm run guard:dev-signin` (scripts/check-no-dev-signin.js), and is mirrored
 * below whenever a build exists locally.
 */

const root = resolve(__dirname, '../../..')
const srcDir = resolve(root, 'src')

// UI markers unique to the dev sign-in button. We deliberately do NOT pin
// 'local-dev' / 'dev@localhost': those live in useAuth's devSignIn helper, part
// of the composable's always-bundled API. The button's class + label are the
// strings that actually render the bypass and that get tree-shaken out.
const DEV_SIGNIN_MARKERS = ['authDevBtn', 'Continue as Dev']
const DEV_SIGNIN_COMPONENT = 'DevSignInButton.vue'

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walk(full))
    } else if (entry.isFile()) {
      out.push(full)
    }
  }
  return out
}

/** Committed source files that render UI (excludes tests). */
function sourceFiles(): string[] {
  return walk(srcDir).filter(
    (file) => /\.(vue|ts)$/.test(file) && !/\.test\.ts$/.test(file),
  )
}

describe('production bundle guard: dev sign-in bypass (LIFT-1123)', () => {
  describe('source structure keeps the bypass tree-shakeable', () => {
    const authScreen = readFileSync(resolve(srcDir, 'views/AuthScreen.vue'), 'utf-8')

    it('AuthScreen no longer renders the dev button inline', () => {
      // Inlined, it compiles to an always-present runtime v-if that ships in
      // every bundle. It must live in a separately-chunked component instead.
      for (const marker of DEV_SIGNIN_MARKERS) {
        expect(authScreen).not.toContain(marker)
      }
    })

    it('AuthScreen gates the dev button behind the VITE_E2E build flag', () => {
      expect(authScreen).toContain('import.meta.env.VITE_E2E')
      expect(authScreen).toContain('defineAsyncComponent')
      expect(authScreen).toContain(DEV_SIGNIN_COMPONENT)
    })

    it('the dev button component still carries the markers (guard is non-vacuous)', () => {
      const component = readFileSync(resolve(srcDir, 'views', DEV_SIGNIN_COMPONENT), 'utf-8')
      for (const marker of DEV_SIGNIN_MARKERS) {
        expect(component).toContain(marker)
      }
    })

    it('DevSignInButton.vue is the ONLY source file that renders the bypass', () => {
      const offenders = sourceFiles().filter((file) => {
        if (file.endsWith(DEV_SIGNIN_COMPONENT)) return false
        const contents = readFileSync(file, 'utf-8')
        return DEV_SIGNIN_MARKERS.some((marker) => contents.includes(marker))
      })
      expect(offenders).toEqual([])
    })
  })

  // Mirrors scripts/check-no-dev-signin.js. Only runs when a build exists (it
  // does after `npm run build`; CI enforces the real check in build-and-test).
  describe('built production bundle omits the bypass', () => {
    const distDir = resolve(root, 'dist')
    const hasBuild = existsSync(distDir)

    it.runIf(hasBuild)('no emitted JS chunk contains the dev sign-in markers', () => {
      const jsFiles = walk(distDir).filter((f) => f.endsWith('.js'))
      const offenders = jsFiles.filter((file) => {
        const contents = readFileSync(file, 'utf-8')
        return DEV_SIGNIN_MARKERS.some((marker) => contents.includes(marker))
      })
      expect(offenders).toEqual([])
    })
  })

  // The script itself, run the way CI runs it. Nothing outside CI executed it
  // before, so its contract was unpinned — and LIFT-1169 now depends on the
  // directory argument: deploy-production points it at `.vercel/output/static`,
  // the tree `vercel deploy --prebuilt` uploads, rather than assuming
  // `vercel build` leaves `dist/` behind. Drop the argument handling and that
  // job either scans the wrong tree or hard-fails on a missing one.
  describe('scripts/check-no-dev-signin.js scans the directory it is given', () => {
    const script = resolve(root, 'scripts/check-no-dev-signin.js')

    function runGuard(buildDir: string) {
      return spawnSync(process.execPath, [script, buildDir], { encoding: 'utf-8' })
    }

    function withFixture(js: string, run: (relDir: string) => void) {
      const dir = mkdtempSync(join(tmpdir(), 'lift-guard-'))
      try {
        mkdirSync(join(dir, 'assets'))
        writeFileSync(join(dir, 'assets', 'index-abc123.js'), js)
        run(dir)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }

    it('passes on a clean bundle in the given directory', () => {
      withFixture('export const a=1;\n', (dir) => {
        const result = runGuard(dir)
        expect(result.status, result.stderr).toBe(0)
      })
    })

    it('fails when the given directory carries the bypass (non-vacuity)', () => {
      // Without this case the test above would pass just as happily against a
      // guard that never opened a file.
      withFixture(`const c="${DEV_SIGNIN_MARKERS[0]}";\n`, (dir) => {
        const result = runGuard(dir)
        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain(DEV_SIGNIN_MARKERS[0])
      })
    })

    it('fails loudly when the given directory does not exist', () => {
      // A silent pass here would be the worst outcome: CI would report the
      // deployed bundle clean having inspected nothing at all.
      const result = runGuard(join(tmpdir(), 'lift-guard-does-not-exist'))
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('not found')
    })
  })
})

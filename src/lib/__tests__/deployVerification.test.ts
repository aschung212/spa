import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parse } from 'yaml'

// LIFT-1167: the "✅ Deployed to production" Slack message must not fire off
// green CI alone — CI passing does not prove Vercel promoted the commit (a
// failed Vercel build leaves the PREVIOUS deploy live, answering 200). A
// dedicated `smoke-test-production` job polls the prod URL until it serves
// THIS commit's version.json, and notify-deploy depends on it. This test pins
// that wiring so the guarantee can't silently regress in a workflow edit.

const ROOT = resolve(__dirname, '../../..')
const CI_PATH = resolve(ROOT, '.github/workflows/ci.yml')

interface Step {
  id?: string
  name?: string
  uses?: string
  run?: string
  if?: string
  env?: Record<string, string>
}
interface Job {
  needs?: string | string[]
  if?: string
  outputs?: Record<string, string>
  steps?: Step[]
}

function loadJobs(): Record<string, Job> {
  const wf = parse(readFileSync(CI_PATH, 'utf8')) as { jobs?: Record<string, Job> }
  return wf.jobs ?? {}
}

function needsOf(job: Job | undefined): string[] {
  if (!job?.needs) return []
  return Array.isArray(job.needs) ? job.needs : [job.needs]
}

// ---------------------------------------------------------------------------
// LIFT-1354: which commits Vercel actually deploys.
//
// `vercel.json`'s `ignoreCommand` decides that, and its contract is inverted:
// exit 0 means SKIP the build. It used to be an ALLOWLIST of deployable paths
// naming `vite.config.js` but none of the four root-level `vite-plugin-*.ts`
// files that config imports — so a commit touching only, say, the theme-split
// plugin (which changes the CSS actually served) matched nothing, Vercel
// skipped the build, and production kept serving the previous bundle
// indefinitely. `package-lock.json` had the same gap.
//
// It is now a DENYLIST: deploy unless the commit touched ONLY known
// non-deployable paths. That fails safe — an unrecognised new root-level build
// input deploys rather than silently not deploying.
//
// These tests EXECUTE the real command from vercel.json against a scratch git
// repo rather than asserting on its text. The defect was a path that matched
// nothing, which no string assertion over an allowlist can see: the old
// command mentioned every path it knew about, and that was the bug.
// ---------------------------------------------------------------------------

const GIT_ID = ['-c', 'user.email=ci@example.com', '-c', 'user.name=CI', '-c', 'commit.gpgsign=false']

/**
 * Split a shell command into argv. Only understands the single-quoted form the
 * ignoreCommand uses (git pathspec magic like `':(exclude)docs/'` must be
 * quoted); anything else throws so the test fails loudly rather than executing
 * something it mis-parsed.
 */
function shellWords(cmd: string): string[] {
  const words: string[] = []
  let word = ''
  let quoted = false
  let started = false
  for (const ch of cmd) {
    if (ch === '"' || ch === '\\' || ch === '$' || ch === '`') {
      throw new Error(`ignoreCommand uses shell syntax this harness cannot parse: ${cmd}`)
    }
    if (ch === "'") {
      quoted = !quoted
      started = true
      continue
    }
    if (!quoted && /\s/.test(ch)) {
      if (started) words.push(word)
      word = ''
      started = false
      continue
    }
    word += ch
    started = true
  }
  if (quoted) throw new Error(`unbalanced quote in ignoreCommand: ${cmd}`)
  if (started) words.push(word)
  return words
}

function ignoreCommandOf(json = readFileSync(resolve(ROOT, 'vercel.json'), 'utf8')): string {
  const cmd = (JSON.parse(json) as { ignoreCommand?: string }).ignoreCommand
  if (!cmd) throw new Error('vercel.json has no ignoreCommand')
  return cmd
}

/** A throwaway git repo whose HEAD^ is a fixed, empty base commit. */
class ScratchRepo {
  readonly dir = mkdtempSync(join(tmpdir(), 'lift-deploy-gate-'))
  private base = ''

  constructor() {
    this.git(['init', '-q', '.'])
    this.git([...GIT_ID, 'commit', '-q', '--allow-empty', '-m', 'base'])
    this.base = this.git(['rev-parse', 'HEAD']).trim()
  }

  private git(args: string[]): string {
    return execFileSync('git', args, { cwd: this.dir, encoding: 'utf8', stdio: 'pipe' })
  }

  /**
   * Commit exactly `paths` on top of the base commit and report Vercel's
   * verdict for that commit: true = deployed, false = skipped.
   */
  deploysWhenTouching(paths: string[], command: string): boolean {
    for (const path of paths) {
      const full = join(this.dir, path)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, `changed: ${path}\n`)
    }
    this.git(['add', '-A'])
    this.git([...GIT_ID, 'commit', '-q', '-m', `touch ${paths.join(' ')}`])

    const words = shellWords(command)
    if (words[0] !== 'git') {
      throw new Error(`ignoreCommand is not a bare git invocation: ${command}`)
    }
    let status = 0
    try {
      this.git(words.slice(1))
    } catch (err) {
      status = (err as { status?: number }).status ?? -1
    }

    this.git(['reset', '-q', '--hard', this.base])
    this.git(['clean', '-qfd'])

    // `git diff --quiet` exits 0 with no differences and 1 with differences.
    // Anything else (128 — bad pathspec, bad revision) is a broken harness or
    // a broken command, not a verdict.
    if (status !== 0 && status !== 1) {
      throw new Error(`ignoreCommand exited ${status} — expected 0 (skip) or 1 (deploy)`)
    }
    // Vercel's contract: exit 0 from ignoreCommand => skip the build.
    return status === 1
  }

  destroy(): void {
    rmSync(this.dir, { recursive: true, force: true })
  }
}

describe('production deploy verification (LIFT-1167)', () => {
  const jobs = loadJobs()

  it('defines a smoke-test-production job', () => {
    expect(jobs['smoke-test-production']).toBeDefined()
  })

  it('smoke test only runs on green master pushes', () => {
    const cond = jobs['smoke-test-production']?.if ?? ''
    expect(cond).toContain('success()')
    expect(cond).toContain("github.ref == 'refs/heads/master'")
    expect(cond).toContain("github.event_name == 'push'")
  })

  it('smoke test verifies the deployed commit against github.sha', () => {
    const step = (jobs['smoke-test-production']?.steps ?? []).find((s) =>
      /version|verify/i.test(s.name ?? ''),
    )
    expect(step, 'expected a verification step').toBeDefined()
    // The pushed commit SHA is passed via env (not inline ${{ }}), mirroring
    // the notify jobs' script-injection guard.
    expect(step?.env?.EXPECTED_SHA).toBe('${{ github.sha }}')
    const run = step?.run ?? ''
    // It reads the domain from CLAUDE.md (never hardcodes a URL — SEV1 rule)…
    expect(run).toContain('CLAUDE.md')
    // …polls version.json and compares the deployed SHA to the expected one…
    expect(run).toContain('version.json')
    expect(run).toContain('EXPECTED_SHA')
    // …and fails when the deploy never reports this commit.
    expect(run).toContain('::error::')
  })

  it('notify-deploy depends on the smoke test (no false "Deployed" message)', () => {
    expect(needsOf(jobs['notify-deploy'])).toContain('smoke-test-production')
  })

  it('notify-failure depends on the smoke test (a failed deploy is reported)', () => {
    expect(needsOf(jobs['notify-failure'])).toContain('smoke-test-production')
  })

  it('the success message reflects that the deploy was verified live', () => {
    const step = (jobs['notify-deploy']?.steps ?? []).find((s) =>
      /notify slack/i.test(s.name ?? ''),
    )
    expect(step?.run ?? '').toContain('verified live')
  })

  // LIFT-1354: smoke-test-production skips its verification for a commit
  // Vercel ignores, but still SUCCEEDS — so notify-deploy posted "Deployed to
  // production (verified live)" for a commit that was neither deployed nor
  // verified. The gate's decision has to reach the notification.
  describe('the "Deployed" claim is withheld when nothing deployed', () => {
    const smoke = jobs['smoke-test-production']

    // Derived from the workflow rather than hardcoding the step id: the step
    // that writes the gate decision is whichever one writes `skip=` to
    // GITHUB_OUTPUT.
    const gateStep = (smoke?.steps ?? []).find((s) => /skip=.*GITHUB_OUTPUT/s.test(s.run ?? ''))

    it('the gate step has an id and publishes its decision as a job output', () => {
      expect(gateStep, 'expected a step writing skip= to GITHUB_OUTPUT').toBeDefined()
      expect(gateStep?.id, 'the gate step needs an id to be referenced as an output').toBeTruthy()

      const outputs = smoke?.outputs ?? {}
      const exposed = Object.values(outputs).find((v) =>
        v.includes(`steps.${gateStep?.id}.outputs.skip`),
      )
      expect(exposed, `smoke-test-production must expose steps.${gateStep?.id}.outputs.skip`).toBeDefined()
    })

    it('the verification step is the one gated on that decision', () => {
      const verify = (smoke?.steps ?? []).find((s) => /verify production/i.test(s.name ?? ''))
      expect(verify?.if ?? '').toContain(`steps.${gateStep?.id}.outputs.skip`)
    })

    it('notify-deploy reads the gate decision and branches its message', () => {
      const outputName = Object.entries(smoke?.outputs ?? {}).find(([, v]) =>
        v.includes(`steps.${gateStep?.id}.outputs.skip`),
      )?.[0]
      expect(outputName).toBeDefined()

      const step = (jobs['notify-deploy']?.steps ?? []).find((s) =>
        /notify slack/i.test(s.name ?? ''),
      )
      // Consumed via env, not inline `${{ }}` in the bash body — same
      // script-injection guard as the commit message beside it.
      const envValues = Object.values(step?.env ?? {})
      const wired = envValues.find(
        (v) => v.includes('needs.smoke-test-production.outputs') && v.includes(outputName as string),
      )
      expect(wired, 'notify-deploy must read the deploy-skipped output via env').toBeDefined()

      const envName = Object.entries(step?.env ?? {}).find(([, v]) => v === wired)?.[0]
      const run = step?.run ?? ''
      // The message actually branches on it…
      expect(run).toMatch(new RegExp(`if \\[ "\\$${envName}" = "true" \\]`))

      // …and the skipped branch still says SOMETHING (silence reads as a
      // broken workflow) without claiming a deploy or a verification. The
      // exact wording is deliberately not pinned; the lie is.
      const skippedBranch = run.slice(run.indexOf(`$${envName}`), run.indexOf('else'))
      expect(skippedBranch).toMatch(/MSG=".+"/)
      expect(skippedBranch).not.toMatch(/deployed to production/i)
      expect(skippedBranch).not.toMatch(/verified live/i)
    })
  })
})

describe("vercel.json ignoreCommand — which commits deploy (LIFT-1354)", () => {
  const command = ignoreCommandOf()
  let repo: ScratchRepo

  beforeAll(() => {
    repo = new ScratchRepo()
  })
  afterAll(() => {
    repo?.destroy()
  })

  const deploys = (paths: string[]) => repo.deploysWhenTouching(paths, command)

  it('the harness would have caught the original defect (self-test)', () => {
    // The command as it shipped before this fix: an allowlist naming
    // vite.config.js but none of the plugins it imports. Proves these
    // assertions are not vacuous — the same probe reports "skipped" for the
    // old command and "deployed" for the new one, on the same commit.
    const oldAllowlist =
      'git diff --quiet HEAD^ HEAD -- src/ public/ api/ index.html vite.config.js package.json vercel.json'
    expect(repo.deploysWhenTouching(['vite-plugin-theme-split.ts'], oldAllowlist)).toBe(false)
    expect(deploys(['vite-plugin-theme-split.ts'])).toBe(true)
  })

  it('deploys every root-level module vite.config.js imports', () => {
    // Derived from the config, not enumerated: a fifth build plugin joins this
    // assertion by being imported, the way the first four did not join the
    // allowlist by being imported.
    const config = readFileSync(resolve(ROOT, 'vite.config.js'), 'utf8')
    const specifiers = [...config.matchAll(/from\s+'\.\/([^']+)'/g)].map((m) => m[1])
    expect(specifiers.length, 'expected vite.config.js to import root-level modules').toBeGreaterThan(0)

    for (const specifier of specifiers) {
      // Extensionless TS specifiers resolve to the real file on disk.
      const file = ['', '.ts', '.js', '.mjs']
        .map((ext) => `${specifier}${ext}`)
        .find((candidate) => {
          try {
            readFileSync(resolve(ROOT, candidate))
            return true
          } catch {
            return false
          }
        })
      expect(file, `vite.config.js imports './${specifier}' but no such file exists`).toBeDefined()
      expect(deploys([file as string]), `${file} must be deployable`).toBe(true)
    }
  })

  it.each([
    ['package-lock.json'], // a transitive bump still changes what ships
    ['package.json'],
    ['vite.config.js'],
    ['vercel.json'],
    ['index.html'],
    ['src/App.vue'],
    ['public/manifest-icon.png'],
    ['api/coach.ts'],
  ])('deploys a commit touching %s', (path) => {
    expect(deploys([path])).toBe(true)
  })

  it.each([
    ['.github/workflows/ci.yml'],
    ['.husky/pre-commit'],
    ['docs/browser-mode-testing.md'],
    ['e2e/offline.spec.ts'],
    ['scripts/generate-icons.js'],
    ['supabase/migrations/20260101000000_add_thing.sql'],
    ['CLAUDE.md'],
    ['playwright.config.ts'],
    ['vitest.config.js'],
    ['vitest.browser.config.js'],
  ])('skips a commit touching only %s', (path) => {
    expect(deploys([path])).toBe(false)
  })

  it('skips the ratchet-baseline bookkeeping commit', () => {
    // ci.yml's ratchet-baseline job pushes `.coverage-baseline.json` with
    // [skip ci]. smoke-test-production deliberately does not depend on that
    // job precisely because Vercel skips its commit; if that stopped being
    // true, every coverage bump would rebuild production.
    expect(deploys(['.coverage-baseline.json'])).toBe(false)
  })

  it('deploys a mixed commit that touches one deployable path', () => {
    expect(deploys(['.github/workflows/ci.yml', 'docs/notes.md', 'src/main.ts'])).toBe(true)
  })

  it('deploys an unrecognised new root-level path (fails safe)', () => {
    // The whole point of a denylist: the next root-level build input to appear
    // deploys by default instead of silently never deploying.
    expect(deploys(['postcss.config.js'])).toBe(true)
  })

  it("CI's deploy gate can still execute the command it reads from vercel.json", () => {
    // ci.yml refuses to eval anything that isn't the known-safe form, so a
    // rewrite that breaks that prefix would fail every master push.
    expect(command.startsWith('git diff --quiet')).toBe(true)
  })
})

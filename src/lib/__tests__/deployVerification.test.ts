import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'

// LIFT-1167: the "✅ Deployed to production" Slack message must not fire off
// green CI alone — CI passing does not prove Vercel promoted the commit (a
// failed Vercel build leaves the PREVIOUS deploy live, answering 200). A
// dedicated `smoke-test-production` job polls the prod URL until it serves
// THIS commit's version.json, and notify-deploy depends on it. This test pins
// that wiring so the guarantee can't silently regress in a workflow edit.

const ROOT = resolve(__dirname, '../../..')
const CI_PATH = resolve(ROOT, '.github/workflows/ci.yml')

const VERCEL_PATH = resolve(ROOT, 'vercel.json')

interface Step {
  id?: string
  name?: string
  uses?: string
  if?: string
  run?: string
  env?: Record<string, string>
}
interface Job {
  needs?: string | string[]
  if?: string
  outputs?: Record<string, string>
  env?: Record<string, string>
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

interface VercelConfig {
  git?: { deploymentEnabled?: Record<string, boolean> }
}

function loadVercelConfig(): VercelConfig {
  return JSON.parse(readFileSync(VERCEL_PATH, 'utf8')) as VercelConfig
}

/** Every `run:` in a job, concatenated — for "does this job do X anywhere" checks. */
function runScriptOf(job: Job | undefined): string {
  return (job?.steps ?? []).map((s) => s.run ?? '').join('\n')
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
})

// LIFT-1169: `migrate-db` claimed in a comment to run "before Vercel deploys",
// but Vercel's git integration deployed on push — independently of this
// workflow, and minutes ahead of a job that waits behind build-and-test + e2e.
// So code depending on a fresh column went live and errored for users until the
// migration caught up, and no ordering primitive existed that could stop it.
//
// The fix has two halves that are only correct together: git auto-deploy is off
// for master (vercel.json), and CI deploys after migrate-db (ci.yml). Delete
// either one and the repo is broken in a different direction — restore git
// auto-deploy and the race is back; drop the CI job and master silently stops
// reaching production. These tests pin both.
describe('production deploys are ordered after the schema migration (LIFT-1169)', () => {
  const jobs = loadJobs()
  const deploy = jobs['deploy-production']

  it('defines a deploy-production job', () => {
    expect(deploy, 'ci.yml must own the production deploy').toBeDefined()
  })

  it('vercel.json turns OFF git auto-deploy for master', () => {
    // The other half of the guarantee. With this re-enabled, Vercel would
    // deploy the push directly again and the CI ordering would be advisory.
    expect(loadVercelConfig().git?.deploymentEnabled?.master).toBe(false)
  })

  it('the deploy waits for migrate-db', () => {
    expect(needsOf(deploy)).toContain('migrate-db')
  })

  it('the deploy is gated at least as narrowly as migrate-db', () => {
    // A `needs:` edge does not stop a SKIPPED job from satisfying it — GitHub
    // treats a skipped need as met. So if migrate-db's gate ever narrows
    // relative to the deploy's, the deploy sails past a migration that never
    // ran: the original bug, reintroduced through its own fix. Requiring every
    // migrate-db clause to also gate the deploy makes that unrepresentable.
    const clauses = (cond: string) =>
      cond
        .split('&&')
        .map((c) => c.trim())
        // `success()` is GitHub's implicit default when `if` is present without
        // it, so stating it or not is a style choice, not a gate.
        .filter((c) => c.length > 0 && c !== 'success()')

    const migrateClauses = clauses(jobs['migrate-db']?.if ?? '')
    expect(migrateClauses.length).toBeGreaterThan(0)
    for (const clause of migrateClauses) {
      expect(clauses(deploy?.if ?? '')).toContain(clause)
    }
  })

  it('the deploy only runs on green master pushes', () => {
    const cond = deploy?.if ?? ''
    expect(cond).toContain('success()')
    expect(cond).toContain("github.event_name == 'push'")
    expect(cond).toContain("github.ref == 'refs/heads/master'")
  })

  it('deploys the prebuilt output to production', () => {
    const script = runScriptOf(deploy)
    // `vercel build` locally + `deploy --prebuilt` is what lets the deploy be
    // ordered at all: a plain `vercel deploy` would hand the build back to
    // Vercel and reopen the timing gap this issue is about.
    expect(script).toContain('vercel build --prod')
    expect(script).toContain('vercel deploy --prebuilt --prod')
  })

  it('stamps version.json with the commit CI checked out', () => {
    const build = (deploy?.steps ?? []).find((s) =>
      (s.run ?? '').includes('vercel build'),
    )
    // vite-plugin-version-stamp reads this first, ahead of any
    // VERCEL_GIT_COMMIT_SHA that `vercel pull` wrote into
    // .vercel/.env.production.local describing a different deployment. The
    // smoke test polls for exactly this value.
    expect(build?.env?.LIFT_BUILD_COMMIT).toBe('${{ github.sha }}')
  })

  it('fails with an actionable message when the deploy secrets are missing', () => {
    // With git auto-deploy off, an unconfigured secret means production stops
    // updating. That must not surface as an opaque CLI auth error.
    const jobEnv = deploy?.env ?? {}
    expect(jobEnv.VERCEL_TOKEN).toBe('${{ secrets.VERCEL_TOKEN }}')
    expect(jobEnv.VERCEL_ORG_ID).toBe('${{ secrets.VERCEL_ORG_ID }}')
    expect(jobEnv.VERCEL_PROJECT_ID).toBe('${{ secrets.VERCEL_PROJECT_ID }}')

    const preflight = (deploy?.steps ?? []).find((s) =>
      /credentials/i.test(s.name ?? ''),
    )
    expect(preflight, 'expected a credential preflight step').toBeDefined()
    const run = preflight?.run ?? ''
    for (const secret of ['VERCEL_TOKEN', 'VERCEL_ORG_ID', 'VERCEL_PROJECT_ID']) {
      expect(run).toContain(secret)
    }
    expect(run).toContain('::error::')
  })

  it('re-runs the dev sign-in guard against the bundle that actually ships', () => {
    // build-and-test runs the same guard, but on a build without Vercel's
    // project env — so it could never catch the cause its own comment names
    // (a VITE_E2E left set on the Vercel project). This build has that env, and
    // the guard reads the tree `deploy --prebuilt` uploads.
    const script = runScriptOf(deploy)
    expect(script).toContain('check-no-dev-signin.js')
    expect(script).toContain('.vercel/output/static')
  })

  it('skips the deploy for commits vercel.json says are not deployable', () => {
    const gate = (deploy?.steps ?? []).find((s) => s.id === 'deploy_gate')
    expect(gate, 'expected a deploy_gate step').toBeDefined()
    // Executed from vercel.json rather than restated, so the deployable-path
    // list has exactly one definition.
    expect(gate?.run ?? '').toContain('ignoreCommand')
    expect(deploy?.outputs?.deployed).toBe('${{ steps.deploy_gate.outputs.deploy }}')
  })

  it('the smoke test verifies the deploy this workflow made', () => {
    expect(needsOf(jobs['smoke-test-production'])).toContain('deploy-production')
    const verify = (jobs['smoke-test-production']?.steps ?? []).find((s) =>
      /version|verify/i.test(s.name ?? ''),
    )
    // Reads the deploy job's gate output instead of re-deriving it: one
    // derivation of "did this commit deploy", so the two cannot disagree and
    // strand the verification job polling for a deploy that never happened.
    expect(verify?.if ?? '').toContain('needs.deploy-production.outputs.deployed')
  })

  it('a failed deploy reaches Slack instead of going quiet', () => {
    expect(needsOf(jobs['notify-failure'])).toContain('deploy-production')
    expect(needsOf(jobs['notify-deploy'])).toContain('deploy-production')
  })

  it('confirms the security headers survived the new build mechanism', () => {
    // vercel.json's headers reach production by being compiled into the
    // deployment's routing config, and this change moved the build that does
    // that compiling into CI. vercelHeadersRegression.test.ts only reads the
    // source file, so a mechanism that quietly dropped the CSP would ship
    // green — the smoke test checks the live response instead.
    const verify = (jobs['smoke-test-production']?.steps ?? []).find((s) =>
      /version|verify/i.test(s.name ?? ''),
    )
    const run = verify?.run ?? ''
    expect(run).toContain('content-security-policy')
    // Read off the response headers, not the body: markup that merely mentions
    // the policy must not be able to satisfy the check.
    expect(run).toContain('-D -')
  })
})

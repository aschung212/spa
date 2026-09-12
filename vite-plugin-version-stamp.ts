/**
 * Vite plugin: emit a static `version.json` stamped with the deployed commit.
 *
 * CI passing on master does NOT prove Vercel actually promoted the new build —
 * Vercel deploys independently and, on a failed build, keeps the *previous*
 * deployment live. So a "Deployed to production" notification fired purely off
 * green CI can be a lie, and a plain reachability curl can't tell the difference
 * (the old deploy answers 200 just fine). LIFT-1167.
 *
 * This plugin writes `dist/version.json` = `{ commit, builtAt }`, sourced from
 * the build environment's commit SHA. The `smoke-test-production` CI job then
 * polls `<prod>/version.json` and only sends the success notification once the
 * *deployed* commit matches the pushed commit — genuinely verifying the deploy
 * landed rather than assuming it did.
 *
 * The commit value is read from an authoritative build-env variable, never
 * fabricated (the SEV1 rule). Locally, with no var set, `commit` is '' —
 * harmless, since local builds are never the production deploy being verified.
 */
import type { Plugin } from 'vite'

export interface VersionInfo {
  /** Full 40-char git SHA of the build, or '' when built outside CI/Vercel. */
  commit: string
  /** ISO timestamp the bundle was produced. */
  builtAt: string
}

/**
 * Pure derivation of the version payload — exported for unit testing.
 *
 * Precedence, most authoritative first:
 *
 * 1. `LIFT_BUILD_COMMIT` — set explicitly by the `deploy-production` CI job to
 *    `github.sha` (LIFT-1169). Since that job runs `vercel build` itself, the
 *    checked-out commit is what is being deployed, and the workflow states it
 *    rather than leaving it to be inferred. This matters because `vercel pull`
 *    writes `.vercel/.env.production.local`, which `vercel build` injects into
 *    the build env — so a `VERCEL_GIT_COMMIT_SHA` may be present there
 *    describing some *other* deployment. Left to win, it would stamp a commit
 *    production is not serving and the smoke test would poll for 300s and fail
 *    on every deploy.
 * 2. `VERCEL_GIT_COMMIT_SHA` — Vercel's own build-time SHA, authoritative for
 *    the git-integration builds that still produce preview deploys.
 * 3. `GITHUB_SHA` — any other GitHub Actions build.
 */
export function buildVersionInfo(
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): VersionInfo {
  const commit =
    env.LIFT_BUILD_COMMIT || env.VERCEL_GIT_COMMIT_SHA || env.GITHUB_SHA || ''
  return { commit, builtAt: now.toISOString() }
}

export default function versionStampPlugin(): Plugin {
  return {
    name: 'lift-version-stamp',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify(buildVersionInfo()) + '\n',
      })
    },
  }
}

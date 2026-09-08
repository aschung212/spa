import { describe, it, expect } from 'vitest'
import versionStampPlugin, {
  buildVersionInfo,
} from '../../../vite-plugin-version-stamp'

// LIFT-1167: the build emits a `version.json` carrying the deployed commit SHA
// so the smoke-test-production CI job can verify Vercel actually promoted THIS
// commit before Slack claims a successful deploy. The plugin's contract:
//   - commit is sourced from an authoritative build-env var (never fabricated)
//   - Vercel's SHA wins over GitHub's when both are present (it's the value
//     that identifies the deploy being verified)
//   - it emits at the well-known root path `version.json` the smoke test polls

describe('buildVersionInfo (LIFT-1167)', () => {
  // LIFT-1169: CI now runs `vercel build` itself, so the commit it checked out
  // is what is being deployed and the workflow says so explicitly. That has to
  // outrank VERCEL_GIT_COMMIT_SHA, because `vercel pull` writes
  // .vercel/.env.production.local and `vercel build` injects it into the build
  // env — a SHA from there describes some other deployment. Stamping it would
  // make smoke-test-production poll for a commit production never serves and
  // fail after 300s on every single deploy.
  it('prefers the explicit CI deploy stamp over every ambient SHA', () => {
    const info = buildVersionInfo({
      LIFT_BUILD_COMMIT: 'ci-deploy-sha',
      VERCEL_GIT_COMMIT_SHA: 'stale-pulled-sha',
      GITHUB_SHA: 'github-sha',
    })
    expect(info.commit).toBe('ci-deploy-sha')
  })

  it('prefers VERCEL_GIT_COMMIT_SHA over GITHUB_SHA', () => {
    const info = buildVersionInfo({
      VERCEL_GIT_COMMIT_SHA: 'vercel-sha',
      GITHUB_SHA: 'github-sha',
    })
    expect(info.commit).toBe('vercel-sha')
  })

  it('falls back to GITHUB_SHA when Vercel var is absent', () => {
    const info = buildVersionInfo({ GITHUB_SHA: 'github-sha' })
    expect(info.commit).toBe('github-sha')
  })

  it('uses an empty commit when no var is set (local build)', () => {
    const info = buildVersionInfo({})
    expect(info.commit).toBe('')
  })

  it('stamps an ISO build timestamp', () => {
    const now = new Date('2026-08-24T12:00:00.000Z')
    const info = buildVersionInfo({}, now)
    expect(info.builtAt).toBe('2026-08-24T12:00:00.000Z')
  })
})

describe('versionStampPlugin (LIFT-1167)', () => {
  it('is a build-only plugin', () => {
    const plugin = versionStampPlugin()
    expect(plugin.name).toBe('lift-version-stamp')
    expect(plugin.apply).toBe('build')
  })

  it('emits version.json at the root with valid JSON the smoke test can parse', () => {
    const plugin = versionStampPlugin()
    let emitted: { type: string; fileName: string; source: string } | undefined

    // generateBundle is a rollup hook; invoke it with a fake `this` exposing
    // emitFile, mirroring how the preloadDefaultView test drives its plugin.
    const ctx = {
      emitFile(file: { type: string; fileName: string; source: string }) {
        emitted = file
      },
    }
    const hook = plugin.generateBundle as unknown as (
      this: typeof ctx,
    ) => void
    hook.call(ctx)

    expect(emitted).toBeDefined()
    expect(emitted!.type).toBe('asset')
    expect(emitted!.fileName).toBe('version.json')
    const parsed = JSON.parse(emitted!.source)
    expect(parsed).toHaveProperty('commit')
    expect(parsed).toHaveProperty('builtAt')
  })
})

#!/usr/bin/env node

/**
 * Production-bundle guard: fails if the dev sign-in bypass shipped (LIFT-1123).
 *
 * AuthScreen renders a "Continue as Dev" button that calls devSignIn(), which
 * fabricates a `{ id: 'local-dev' }` session and skips the entire auth gate.
 * It is meant to exist ONLY in local dev and the CI e2e build (which sets
 * VITE_E2E=true). The button lives in DevSignInButton.vue, lazily imported by
 * AuthScreen behind a build-time `import.meta.env.VITE_E2E` flag, so a normal
 * production build tree-shakes the component and its chunk out entirely.
 *
 * The only thing that could reintroduce it in production is a misconfigured
 * Vercel env var setting VITE_E2E — a silent auth-UI bypass with no other gate.
 * This script greps the built `dist/` (which CI produces WITHOUT VITE_E2E) for
 * the button's UI markers and fails the build if any are present.
 *
 * Run against a production build only (e.g. the build-and-test CI job). Running
 * it after `VITE_E2E=true npm run build` is expected to fail.
 *
 * The directory is an optional argument so the deploy-production job can scan
 * `.vercel/output/static` — the artifact `vercel build` actually uploads
 * (LIFT-1169). That build carries the real Vercel project env, so it is the
 * only place this guard can see the misconfiguration described above; and
 * naming the output explicitly avoids assuming `vercel build` leaves `dist/`
 * behind rather than consuming it.
 *
 * Usage:
 *   node scripts/check-no-dev-signin.js [buildDir]   # default: dist
 *
 * `buildDir` is resolved from the repo root (not the cwd), so the same
 * invocation works from anywhere in the tree.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const distDir = resolve(root, process.argv[2] || 'dist');

// UI markers unique to the dev sign-in button. We deliberately do NOT grep for
// 'local-dev' / 'dev@localhost': those live in useAuth's devSignIn helper, which
// is part of the composable's returned API and therefore always present in the
// bundle regardless of the flag. The button's class + label are what actually
// render the bypass, and they are the strings that get tree-shaken out.
const FORBIDDEN_MARKERS = ['authDevBtn', 'Continue as Dev'];

if (!existsSync(distDir)) {
  console.error(
    `Error: ${distDir} not found. Run \`npm run build\` before this guard so ` +
      `there is a production bundle to inspect.`,
  );
  process.exit(1);
}

/** Recursively collect every emitted JS file under the build dir (chunks may be lazy). */
function collectJsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectJsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

const jsFiles = collectJsFiles(distDir);

if (jsFiles.length === 0) {
  console.error(`Error: no .js files found under ${distDir} — is the build complete?`);
  process.exit(1);
}

const offenders = [];
for (const file of jsFiles) {
  const contents = readFileSync(file, 'utf-8');
  const hits = FORBIDDEN_MARKERS.filter((marker) => contents.includes(marker));
  if (hits.length > 0) {
    offenders.push({ file: file.replace(`${root}/`, ''), hits });
  }
}

if (offenders.length > 0) {
  console.error('❌ Dev sign-in bypass leaked into the production bundle:');
  for (const { file, hits } of offenders) {
    console.error(`   ${file} contains: ${hits.join(', ')}`);
  }
  console.error(
    '\nThe "Continue as Dev" button must never ship to production. This usually ' +
      'means VITE_E2E was set for a production build, or the flag gate in ' +
      'AuthScreen.vue was removed. See LIFT-1123.',
  );
  process.exit(1);
}

console.log(
  `✅ No dev sign-in bypass in the production bundle (scanned ${jsFiles.length} JS files).`,
);

/**
 * Make sure `lib/index.js` was built from the current sources before a bench run.
 *
 * A run against a stale bundle is not a bad measurement — it is a measurement of
 * something that no longer exists. That happened once: the plugin's source was
 * fixed, the profile kept loading an older `lib/index.js`, and every run of the
 * new version actually measured the old one. So every runner checks here first,
 * and rebuilds rather than measuring the wrong thing.
 */

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LIB = join(ROOT, 'lib', 'index.js')

/**
 * The newest source file under `src/`.
 *
 * @returns the modification time, in milliseconds.
 */
function newestSource() {
  let newest = 0
  for (const name of readdirSync(join(ROOT, 'src'))) {
    if (!name.endsWith('.ts')) continue
    newest = Math.max(newest, statSync(join(ROOT, 'src', name)).mtimeMs)
  }
  return newest
}

/**
 * Build when the bundle is missing or older than the sources, and verify it.
 *
 * @returns the build that will be measured.
 */
export function ensureBuild() {
  let built = false
  try {
    const bundleTime = statSync(LIB).mtimeMs
    if (bundleTime < newestSource()) {
      built = true
    }
  } catch {
    built = true
  }
  if (built) {
    console.log('bench: rebuilding lib/index.js (stale or missing)')
    execFileSync(process.execPath, [join(ROOT, 'build.mjs')], { cwd: ROOT, stdio: 'inherit' })
  }
  // Verify rather than trust the build: the branch that bit us was a build that
  // reported success and still did not contain the change.
  const newest = newestSource()
  const bundleTime = statSync(LIB).mtimeMs
  if (bundleTime < newest) {
    throw new Error('bench: lib/index.js is still older than src/ after a build — refusing to measure a stale bundle')
  }
  const bundle = readFileSync(LIB, 'utf8')
  if (!bundle.includes('refine_plan')) {
    throw new Error('bench: lib/index.js does not look like this plugin — refusing to measure')
  }
  return { bundleBytes: bundle.length, built }
}

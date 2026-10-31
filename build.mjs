/**
 * Standalone build for @zyn19940107/dsh-refine-loop.
 *
 * The host half is plain ESM with the harness packages left as imports: the
 * Loader resolves them from the profile, exactly as it does for an official
 * plugin.
 *
 * Run: node build.mjs
 */

import { build } from 'esbuild'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

/** Harness packages the host half imports instead of bundling. */
const HOST_EXTERNALS = Object.keys(manifest.peerDependencies ?? {})

const outDir = join(root, 'lib')
await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

await build({
  entryPoints: [join(root, 'src/index.ts')],
  outfile: join(outDir, 'index.js'),
  bundle: true,
  platform: 'node',
  target: 'es2024',
  format: 'esm',
  external: HOST_EXTERNALS,
  logLevel: 'info',
})

console.log('build: wrote lib/index.js')

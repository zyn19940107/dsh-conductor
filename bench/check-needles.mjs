/**
 * Audit every judge needle against the repository.
 *
 * A needle that names a file or a symbol the code no longer has makes a correct
 * answer fail: the review judge asked for "rounds.ts" and "delegationDepth" while
 * the answer could not name them, and the task looked like a plugin failure.
 * This walks the source of the task files, pulls out the needles and any-lists,
 * and reports every entry that looks like a local file or identifier but is not
 * in the tree.
 *
 * Usage: node bench/check-needles.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'D:/code/vibe/dsh-refine-loop'
const SRC = join(ROOT, 'src')
const VERIFY = join(ROOT, 'verify')

const srcFiles = readdirSync(SRC).filter(name => name.endsWith('.ts'))
const srcText = srcFiles.map(name => readFileSync(join(SRC, name), 'utf8')).join('\n').toLowerCase()
const knownFiles = new Set([
  ...srcFiles,
  ...readdirSync(VERIFY).filter(name => name.endsWith('.spec.ts')),
  ...readdirSync(ROOT).filter(name => /\.(mjs|json|md|ts)$/.test(name) && statSync(join(ROOT, name)).isFile()),
])

const TASK_SOURCES = [
  'bench/scenarios.mjs',
  'bench/task.mjs',
  'bench/pubeval.mjs',
  'bench/lhtb.mjs',
  'bench/lhtb-nbody.mjs',
  'bench/lhtb-commit0.mjs',
  'bench/lhtb-matpower.mjs',
]

/** Matches needles/any arrays in the source, not in the loaded task objects. */
const ARRAY = /\b(needles|any):\s*\[([\s\S]*?)\]/g
const STRING = /'([^']*)'|"([^"]*)"/g
const CJK = /[\u4e00-\u9fff]/

/**
 * Needles that name things in another repository on purpose.
 *
 * The discovery/multihop/bigread tasks review deepseek-harness, not this plugin,
 * so their needles are checked against that tree by hand, not here.
 */
const EXTERNAL = new Set([
  'schema.ts', 'glob.ts', 'grep.ts', 'api-catalog.ts', 'slot-catalog.ts', 'analyzer.ts',
  'serviceapientry', 'clientslotentry', 'workspaceanalyzeroptions', 'tooldefinition',
])

let problems = 0
let checked = 0
for (const name of TASK_SOURCES) {
  let text
  try {
    text = readFileSync(join(ROOT, name), 'utf8')
  } catch {
    continue
  }
  for (const array of text.matchAll(ARRAY)) {
    for (const literal of array[2].matchAll(STRING)) {
      const value = literal[1] ?? literal[2] ?? ''
      if (value === '' || CJK.test(value) || /\s/.test(value)) continue
      if (EXTERNAL.has(value) || /^[0-9]+$/.test(value)) continue
      // Paths inside another tree (deepseek-harness, the lhtb fixtures) are out
      // of scope: this audit is about the repository the tasks ask about.
      if (value.includes('/') || value.includes('\\')) continue
      checked += 1
      if (/\.(ts|mjs|json|md)$/.test(value)) {
        if (!knownFiles.has(value)) {
          console.log(`${name}: needle "${value}" is a file that does not exist`)
          problems += 1
        }
        continue
      }
      if (/^[a-z0-9_]+$/i.test(value) && !srcText.includes(value.toLowerCase())) {
        console.log(`${name}: needle "${value}" is not exported or mentioned in src/`)
        problems += 1
      }
    }
  }
}

console.log(problems === 0
  ? `no stale needles (${checked} checked)`
  : `\n${problems} problem(s)`)

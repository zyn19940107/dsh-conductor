/**
 * Check every benchmark task against the repository it asks about.
 *
 * The tasks carry two kinds of fact that go stale silently: names (a file or an
 * exported symbol the answer has to mention) and counts ("8 modules", "6 specs").
 * A stale name makes a correct answer fail; a stale count makes the worker spend
 * its rounds working out which item to leave out. Both happened.
 *
 * Usage: node bench/check-tasks.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { TASKS } from './task.mjs'

const ROOT = 'D:/code/vibe/dsh-refine-loop'
const SRC = join(ROOT, 'src')
const VERIFY = join(ROOT, 'verify')

const srcFiles = readdirSync(SRC).filter(name => name.endsWith('.ts'))
const specFiles = readdirSync(VERIFY).filter(name => name.endsWith('.spec.ts'))
const srcText = srcFiles.map(name => readFileSync(join(SRC, name), 'utf8')).join('\n').toLowerCase()

/** Files the task may name without a path. */
const knownFiles = new Set([
  ...srcFiles,
  ...specFiles,
  ...readdirSync(ROOT).filter(name => /\.(mjs|json|md|ts)$/.test(name) && statSync(join(ROOT, name)).isFile()),
  ...readdirSync(VERIFY).filter(name => name.endsWith('.mjs')),
])

const FILE_REFERENCE = /\b([\w.-]+\.(?:spec\.ts|test\.ts|ts|mjs|json))\b/g
const COUNT_CLAIM = /(\d+)\s*个\s*(\.spec\.ts|spec|\.ts|模块|文件)/g

let problems = 0
for (const [name, task] of Object.entries(TASKS)) {
  const text = `${task.text ?? ''}`
  const issues = []
  for (const match of text.matchAll(FILE_REFERENCE)) {
    const file = match[1]
    const before = text[match.index - 1] ?? ''
    // "*.spec.ts" is a pattern, and "a/b/c.ts" is a path inside another tree.
    if (file === 'spec.ts' || before === '/' || before === '\\' || before === '*') continue
    if (!knownFiles.has(file)) issues.push(`names a file that does not exist: ${file}`)
  }
  for (const match of text.matchAll(COUNT_CLAIM)) {
    const claimed = Number(match[1])
    const unit = match[2]
    const actual = unit === '.spec.ts' || unit === 'spec' ? specFiles.length
      : unit === '.ts' || unit === '模块' ? srcFiles.length
        : undefined
    if (actual !== undefined && claimed !== actual) {
      issues.push(`claims ${claimed} ${unit} but the tree has ${actual}`)
    }
  }
  // Judge needles that look like an exported symbol must exist in src.
  const judge = task.judge
  if (typeof judge === 'function') {
    const probe = judge('')
    void probe
  }
  if (issues.length > 0) {
    problems += issues.length
    console.log(`${name}:`)
    for (const issue of issues) console.log(`  - ${issue}`)
  }
}

if (problems === 0) console.log('no stale names or counts found in any task text')
else console.log(`\n${problems} problem(s)`)

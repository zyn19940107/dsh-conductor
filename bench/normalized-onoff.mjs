/**
 * Wall time normalised to one token speed, with the plan's parallel nodes taken
 * into account.
 *
 * A plan runs its nodes at the same time, so the plan takes about as long as its
 * slowest node — not the sum. Summing every session's model time is why the plain
 * normalisation broke on fleet runs: three workers thinking for 300s each in 300s
 * of wall time is not 900s.
 *
 * So each node is normalised on its own, and a plan block is the latest of its
 * nodes' normalised ends. Everything outside the plan (the parent's own steps)
 * is the parent's wall minus the plan blocks, plus the parent's output at the
 * fixed speed.
 *
 * Usage: node bench/normalized-v25.mjs [speed] [task ...]
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalise } from './normalise.mjs'

const RESULTS = 'D:/code/vibe/dsh-refine-loop/bench/results'
const V20 = join(RESULTS, 'v2.0')
const OLD = join(RESULTS, 'before-one-layer')
const SESSIONS = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const LF = String.fromCharCode(10)
const SPEED = Number(process.argv[2] ?? '160')
const ONLY = process.argv.slice(3)

/**
 * @param values - the numbers.
 * @returns the median.
 */
function median(values) {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

const groups = [
  ['off', RESULTS, 'off'],
  
  ['on', RESULTS, 'on'],
]

const table = new Map()
for (const [label, dir, arm] of groups) {
  for (const name of readdirSync(dir)) {
    const match = /^(.*)-(on|off)-([0-9]+)\.json$/.exec(name)
    if (match === null || match[2] !== arm) continue
    if (ONLY.length > 0 && !ONLY.includes(match[1])) continue
    let record
    try {
      record = JSON.parse(readFileSync(join(dir, name), 'utf8'))
    } catch {
      continue
    }
    const normalised = normalise(record)
    if (normalised === undefined) continue
    if (!table.has(match[1])) table.set(match[1], new Map())
    const versions = table.get(match[1])
    if (!versions.has(label)) versions.set(label, [])
    versions.get(label).push({ ...normalised, agents: record.formation?.agents, steps: record.steps, token: record.formation?.total })
  }
}

console.log(`并行感知的归一（${SPEED} tok/s）`)
console.log('scenario version n wall_s normalized_s parentModel_s agents tokens_k')
console.log('(VERBOSE=1 prints each run: wall normalized parentModel planBlock agents tokens)')
for (const [scenario, versions] of table) {
  for (const label of ['off', 'on']) {
    const runs = versions.get(label)
    if (runs === undefined) continue
    if (process.env.VERBOSE === '1') {
      for (const run of runs) {
        console.log([
          scenario,
          label,
          'run',
          (run.wall / 1000).toFixed(0),
          (run.adjusted / 1000).toFixed(0),
          (run.parentModel / 1000).toFixed(0),
          (run.blockNormal / 1000).toFixed(0),
          run.agents,
          ((run.token ?? 0) / 1000).toFixed(0),
        ].join(' '))
      }
    }
    console.log([
      scenario,
      label,
      runs.length,
      (median(runs.map(run => run.wall)) / 1000).toFixed(0),
      (median(runs.map(run => run.adjusted)) / 1000).toFixed(0),
      (median(runs.map(run => run.parentModel)) / 1000).toFixed(0),
      [...new Set(runs.map(run => run.agents))].join(','),
      (median(runs.map(run => run.token ?? 0)) / 1000).toFixed(0),
    ].join(' '))
  }
}

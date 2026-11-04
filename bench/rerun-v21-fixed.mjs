/**
 * Re-run the v2.1 comparison on a verified build.
 *
 * The first v2.1 re-runs measured a stale bundle: the 50k compression threshold
 * landed in the sources after the bundle was built, so every run compressed
 * results at 6k — one model call inside the plan for almost every node result —
 * and the wall times measured that, not v2.1.
 *
 * This archives those runs as `v2.1-stale`, checks the build, then re-runs
 * coverage, review, matpower and commit0 on the plugin arm.
 *
 * Usage: node bench/rerun-v21-fixed.mjs
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeLog } from './sessions.mjs'
import { ensureBuild } from './build-check.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const RESULTS = join(HERE, 'results')
const STALE = join(RESULTS, 'v2.1-stale')
const SESSIONS = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const LF = String.fromCharCode(10)

/** Task name → how many runs to take, matching what the earlier rounds used. */
const PLAN = [
  ['coverage', 5],
  ['review', 5],
  ['lhtb-matpower', 2],
  ['lhtb-commit0', 2],
]

const build = ensureBuild()
console.log(`bench: measuring lib/index.js (${build.bundleBytes} bytes)${build.built ? ' [freshly built]' : ''}`)

mkdirSync(STALE, { recursive: true })
for (const [task, runs] of PLAN) {
  for (let index = 1; index <= runs; index += 1) {
    const name = `${task}-on-${index}.json`
    const from = join(RESULTS, name)
    if (existsSync(from) && !existsSync(join(STALE, name))) renameSync(from, join(STALE, name))
  }
}
console.log('stale-build runs archived to bench/results/v2.1-stale/')

for (const [task, runs] of PLAN) {
  for (let index = 1; index <= runs; index += 1) {
    const child = spawn(process.execPath, [join(HERE, 'run-one.mjs'), task, 'on', String(index)], {
      cwd: resolve(HERE, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', chunk => { out += chunk.toString() })
    child.stderr.on('data', chunk => { out += chunk.toString() })
    const code = await new Promise(resolve => child.on('close', resolve))
    const record = JSON.parse(readFileSync(join(RESULTS, `${task}-on-${index}.json`), 'utf8'))
    console.log(`${task} on-${index}: exit=${code} wall=${(record.wallMs / 1000).toFixed(0)}s `
      + `steps=${record.steps} agents=${record.formation?.agents} `
      + `correct=${record.correctness?.passed}/${record.correctness?.total}`)
  }
}

/**
 * The model time and output of one main session, plus its plan reports.
 *
 * @param record - the bench record.
 * @returns the split, or undefined.
 */
function measure(record) {
  const session = readdirSync(SESSIONS).find(entry => entry === record.sessionId
    || entry.startsWith(record.sessionId.slice(8, 21)))
  if (session === undefined) return undefined
  const events = []
  for (const file of readdirSync(join(SESSIONS, session)).filter(entry => entry.endsWith('.zstd')).sort()) {
    try {
      events.push(...decodeLog(join(SESSIONS, session, file)).split(LF).filter(Boolean).map(line => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      }).filter(Boolean))
    } catch {
      // torn segment
    }
  }
  let modelMs = 0
  let output = 0
  let start = 0
  const open = new Map()
  let reports = 0
  let truncated = 0
  for (const event of events) {
    if (event.type === 'step/start') start = event.timestamp ?? event.time ?? 0
    if (event.type === 'tool/call') open.set(String(event.data?.callId), event.data?.name)
    if (event.type === 'assistant/message') {
      const usage = event.data?.usage ?? {}
      output += usage.outputTokens ?? 0
      modelMs += (event.timestamp ?? event.time ?? 0) - start
    }
    if (event.type !== 'tool/result') continue
    if (open.get(String(event.data?.message?.toolCallId ?? '')) !== 'refine_plan') continue
    const text = (event.data?.message?.content ?? []).map(block => block.text ?? '').join('')
    reports += 1
    if (text.includes('Omitted')) truncated += 1
  }
  if (output <= 0) return undefined
  return { modelMs, output, reports, truncated, planMs: 0 }
}

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

console.log('\n=== v2.0 vs v2.1（正确构建；单 agent 样本才做 160 tok/s 归一）===')
for (const [task] of PLAN) {
  const groups = [
    ['v2.0', join(RESULTS, 'v2.0')],
    ['v2.1', RESULTS],
  ]
  console.log(`\n--- ${task} ---`)
  for (const [label, dir] of groups) {
    const runs = []
    for (let index = 1; index <= 5; index += 1) {
      let record
      try {
        record = JSON.parse(readFileSync(join(dir, `${task}-on-${index}.json`), 'utf8'))
      } catch {
        continue
      }
      const measured = measure(record)
      if (measured === undefined) continue
      runs.push({ ...record, ...measured })
    }
    if (runs.length === 0) continue
    const single = runs.filter(run => run.formation?.agents === 1)
    const normalised = single.map(run => (run.wallMs - run.modelMs) + run.output / 160 * 1000)
    const reports = runs.reduce((sum, run) => sum + run.reports, 0)
    const truncated = runs.reduce((sum, run) => sum + run.truncated, 0)
    console.log(`  ${label}: n=${runs.length}`
      + `  实测 ${(median(runs.map(run => run.wallMs)) / 1000).toFixed(0)}s`
      + (normalised.length === 0 ? '' : `  归一@160 ${(median(normalised) / 1000).toFixed(0)}s (n=${single.length})`)
      + `  token ${(median(runs.map(run => run.formation?.total)) / 1000).toFixed(0)}k`
      + `  输出 ${(median(runs.map(run => run.output)) / 1000).toFixed(1)}k`
      + `  步数 ${median(runs.map(run => run.steps))}`
      + `  编队 ${runs.map(run => run.formation?.agents).join('/')}`
      + `  正确 ${runs.map(run => `${run.correctness?.passed}/${run.correctness?.total}`).join(' ')}`
      + `  报告截断 ${truncated}/${reports}`)
  }
}

/**
 * Run every benchmark task on the plugin arm with the current build (v2.3.0).
 *
 * Only the plugin arm is re-run: the off arm is the harness with the plugin
 * removed, so the plugin's version cannot change it. Whatever `on` records are
 * in the results directory are archived first, so nothing from an older build is
 * mistaken for this one.
 *
 * Usage: node bench/run-all-v23.mjs
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureBuild } from './build-check.mjs'
import { decodeLog } from './sessions.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const RESULTS = join(HERE, 'results')
const OLD = join(RESULTS, 'pre-v2.3')
const SESSIONS = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const LF = String.fromCharCode(10)

/**
 * Every task and how many runs it gets, matching the rounds the README published.
 */
const PLAN = [
  ['coverage', 5],
  ['review', 5],
  ['humeval', 5],
  ['humeval-hard', 5],
  ['quixbugs', 5],
  ['panel', 2],
  ['lhtb-2048', 5],
  ['lhtb-nbody', 3],
  ['lhtb-matpower', 2],
  ['lhtb-commit0', 2],
]

const build = ensureBuild()
console.log(`v2.3.0: measuring lib/index.js (${build.bundleBytes} bytes)${build.built ? ' [freshly built]' : ''}`)

mkdirSync(OLD, { recursive: true })
for (const name of readdirSync(RESULTS)) {
  if (!/-on-[0-9]+\.json$/.test(name)) continue
  if (existsSync(join(OLD, name))) continue
  renameSync(join(RESULTS, name), join(OLD, name))
}
console.log('older plugin-arm records archived to bench/results/pre-v2.3/')

const started = Date.now()
for (const [task, runs] of PLAN) {
  for (let index = 1; index <= runs; index += 1) {
    const before = Date.now()
    const child = spawn(process.execPath, [join(HERE, 'run-one.mjs'), task, 'on', String(index)], {
      cwd: resolve(HERE, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', chunk => { out += chunk.toString() })
    child.stderr.on('data', chunk => { out += chunk.toString() })
    const code = await new Promise(resolve => child.on('close', resolve))
    let record
    try {
      record = JSON.parse(readFileSync(join(RESULTS, `${task}-on-${index}.json`), 'utf8'))
    } catch {
      console.log(`${task} on-${index}: exit=${code} NO RECORD`)
      continue
    }
    const elapsed = ((Date.now() - started) / 60000).toFixed(0)
    console.log(`${task} on-${index}: exit=${code} wall=${(record.wallMs / 1000).toFixed(0)}s `
      + `steps=${record.steps} agents=${record.formation?.agents} planned=${record.planned} `
      + `token=${Math.round((record.formation?.total ?? 0) / 1000)}k `
      + `correct=${record.correctness?.passed}/${record.correctness?.total} `
      + `[+${((Date.now() - before) / 60000).toFixed(1)}m, total ${elapsed}m]`)
  }
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

/**
 * One run's plan reports and how many the harness truncated.
 *
 * @param record - the bench record.
 * @returns the counts and how many nodes carried a budget.
 */
function reportsOf(record) {
  const session = readdirSync(SESSIONS).find(entry => entry === record.sessionId
    || entry.startsWith(record.sessionId.slice(8, 21)))
  if (session === undefined) return { reports: 0, truncated: 0, nodes: 0, budgets: 0 }
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
  const open = new Map()
  let reports = 0
  let truncated = 0
  let nodes = 0
  let budgets = 0
  for (const event of events) {
    if (event.type === 'tool/call' && event.data?.name === 'refine_plan') {
      try {
        const plan = JSON.parse(String(event.data.arguments))
        for (const node of plan.nodes ?? []) {
          nodes += 1
          if (node.budgetMs !== undefined && node.budgetMs > 0) budgets += 1
        }
      } catch {
        // a plan that does not parse was refused before it ran
      }
    }
    if (event.type === 'tool/call') open.set(String(event.data?.callId), event.data?.name)
    if (event.type !== 'tool/result') continue
    if (open.get(String(event.data?.message?.toolCallId ?? '')) !== 'refine_plan') continue
    const text = (event.data?.message?.content ?? []).map(block => block.text ?? '').join('')
    reports += 1
    if (text.includes('Omitted')) truncated += 1
  }
  return { reports, truncated, nodes, budgets }
}

console.log('\n=== v2.3.0 汇总（on 臂）===')
for (const [task, runs] of PLAN) {
  const records = []
  for (let index = 1; index <= runs; index += 1) {
    try {
      records.push(JSON.parse(readFileSync(join(RESULTS, `${task}-on-${index}.json`), 'utf8')))
    } catch {
      continue
    }
  }
  if (records.length === 0) {
    console.log(`${task}: 没有记录`)
    continue
  }
  const reports = records.map(reportsOf)
  const totalReports = reports.reduce((sum, entry) => sum + entry.reports, 0)
  const totalTruncated = reports.reduce((sum, entry) => sum + entry.truncated, 0)
  const nodes = reports.reduce((sum, entry) => sum + entry.nodes, 0)
  const budgets = reports.reduce((sum, entry) => sum + entry.budgets, 0)
  console.log(`${task.padEnd(14)} n=${records.length}`
    + ` 墙钟 ${(median(records.map(r => r.wallMs)) / 1000).toFixed(0)}s`
    + ` token ${(median(records.map(r => r.formation?.total ?? 0)) / 1000).toFixed(0)}k`
    + ` context ${(median(records.map(r => r.mainPrompt ?? 0)) / 1000).toFixed(0)}k`
    + ` 步数 ${median(records.map(r => r.steps))}`
    + ` 编队 ${records.map(r => r.formation?.agents).join('/')}`
    + ` 交图 ${records.filter(r => r.planned).length}/${records.length}`
    + ` 预算 ${budgets}/${nodes}`
    + ` 报告 ${totalReports}（截断 ${totalTruncated}）`
    + ` 正确 ${records.map(r => `${r.correctness?.passed}/${r.correctness?.total}`).join(' ')}`)
}

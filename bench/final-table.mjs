/**
 * One table for the whole suite: wall, normalised time, tokens, cost, agents,
 * correctness, per task and per arm.
 *
 * Every number is derived the same way the analysis does it elsewhere:
 * - time is normalised by `bench/normalise.mjs` (fixed 160 tok/s, per-node max);
 * - tokens are re-read from the session logs with `bench/sessions.mjs`, which
 *   skips a forked child's seeded prefix (that prefix carries the parent's own
 *   usage, so summing it would count the parent once per child);
 * - cost uses DeepSeek's off-peak prices.
 *
 * Usage:
 *   node bench/final-table.mjs [task...]
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readSessions, subtree, totals } from './sessions.mjs'
import { TASKS } from './task.mjs'
import { normalise, eventsOf } from './normalise.mjs'

const RESULTS = process.env.DSH_RESULTS ?? 'bench/results'
const SESSIONS = process.env.DSH_SESSIONS ?? 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'

/** DeepSeek prices, 元 per million tokens, off-peak. */
const PRICE = { cacheHit: 0.02, cacheMiss: 1, output: 4 }
/** The generation speed the normaliser assumes, in tokens per second. */
const SPEED = 160

/**
 * The median of a list.
 *
 * @param {number[]} values - the samples.
 * @returns {number} the median.
 */
function median(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/**
 * What one record's tokens cost.
 *
 * @param {{input: number, output: number, cacheRead: number}} formation - the totals.
 * @returns {number} 元.
 */
function cost(formation) {
  return (formation.cacheRead / 1e6) * PRICE.cacheHit
    + (formation.input / 1e6) * PRICE.cacheMiss
    + (formation.output / 1e6) * PRICE.output
}

const wanted = new Set(process.argv.slice(2))
const sessions = readSessions(SESSIONS)

const records = []
for (const file of readdirSync(RESULTS)) {
  if (!file.endsWith('.json')) continue
  let record
  try {
    record = JSON.parse(readFileSync(join(RESULTS, file), 'utf8'))
  } catch {
    continue
  }
  if (typeof record.task !== 'string' || typeof record.sessionId !== 'string') continue
  if (wanted.size > 0 && !wanted.has(record.task)) continue
  records.push(record)
}

const byTaskArm = new Map()
for (const record of records) {
  const key = `${record.task}\u0000${record.condition}`
  const list = byTaskArm.get(key) ?? []
  list.push(record)
  byTaskArm.set(key, list)
}

const tasks = [...new Set(records.map(record => record.task))]
console.log('| 任务 | 臂 | n | 墙钟 | 归一化 | token | 未缓存 | 成本 | 编队 | 步数 | 正确性 |')
console.log('|---|---|---:|---:|---:|---:|---:|---:|---|---:|---|')
const summary = []
for (const task of tasks) {
  const row = { task }
  for (const arm of ['off', 'on']) {
    const list = byTaskArm.get(`${task}\u0000${arm}`) ?? []
    if (list.length === 0) continue
    const walls = []
    const normalised = []
    const formations = []
    const agents = []
    const steps = []
    const verdicts = []
    for (const record of list) {
      const formation = totals(subtree(sessions, record.sessionId))
      if (formation.sessions === 0) continue
      walls.push(record.wallMs / 1000)
      const normal = normalise(record)
      normalised.push((normal?.adjusted ?? record.wallMs) / 1000)
      formations.push(formation)
      agents.push(record.formation?.agents ?? formation.sessions)
      steps.push(record.steps ?? 0)
      // Re-judge from the session log: the stored verdict was computed with
      // whatever judge existed at run time, and a judge fixed afterwards (the
      // panel shape predicate, a wider wording list) must apply to every row.
      const judge = TASKS[record.task]?.judge
      let passed = record.correctness?.passed ?? 0
      let total = record.correctness?.total ?? 0
      // Only an answer-based judge can be re-run here. A judge that takes no
      // argument reads a workspace (`humeval`, `quixbugs`, `matpower`, `nbody`),
      // and the workspace path comes from the runner's environment — re-running it
      // from this script would look at the wrong directory and score everything 0.
      const answerBased = judge !== undefined && judge.length >= 1
      if (answerBased) {
        try {
          const full = eventsOf(record.sessionId)
            .filter(event => event.type === 'assistant/message')
            .flatMap(event => (event.data?.message?.content ?? [])
              .filter(block => block.type === 'text').map(block => block.text ?? ''))
            .join('')
          if (full !== '') {
            const verdict = judge(full)
            passed = verdict.passed
            total = verdict.total
          }
        } catch {
          // The log is gone; keep the stored verdict.
        }
      }
      verdicts.push({ passed, total })
    }
    row[arm] = {
      n: list.length,
      wall: median(walls),
      normalised: median(normalised),
      token: median(formations.map(formation => formation.total)),
      input: median(formations.map(formation => formation.input)),
      cost: median(formations.map(cost)),
      agents: median(agents),
      steps: median(steps),
      ok: verdicts.filter(verdict => verdict.passed === verdict.total).length,
      total: verdicts.length,
    }
  }
  summary.push(row)
}

for (const row of summary) {
  for (const arm of ['off', 'on']) {
    const entry = row[arm]
    if (entry === undefined) continue
    console.log(`| ${row.task} | ${arm} | ${entry.n} | ${entry.wall.toFixed(0)}s | ${entry.normalised.toFixed(0)}s `
      + `| ${Math.round(entry.token / 1000)}k | ${Math.round(entry.input / 1000)}k | ¥${entry.cost.toFixed(2)} `
      + `| ${entry.agents} | ${entry.steps} | ${entry.ok}/${entry.total} |`)
  }
}

// Ratios, geometric mean across tasks.
console.log()
console.log('| 任务 | 归一化 on/off | token on/off | 成本 on/off | 正确性 off → on |')
console.log('|---|---:|---:|---:|---|')
const ratios = { normalised: [], token: [], cost: [] }
for (const row of summary) {
  if (row.off === undefined || row.on === undefined) continue
  const normalised = row.on.normalised / row.off.normalised
  const token = row.on.token / row.off.token
  const money = row.on.cost / row.off.cost
  ratios.normalised.push(normalised)
  ratios.token.push(token)
  ratios.cost.push(money)
  console.log(`| ${row.task} | ${normalised.toFixed(2)}x | ${token.toFixed(2)}x | ${money.toFixed(2)}x `
    + `| ${row.off.ok}/${row.off.total} → ${row.on.ok}/${row.on.total} |`)
}
const geometric = values => Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length)
if (ratios.cost.length > 0) {
  console.log(`\n几何平均：归一化 ${geometric(ratios.normalised).toFixed(2)}x，`
    + `token ${geometric(ratios.token).toFixed(2)}x，成本 ${geometric(ratios.cost).toFixed(2)}x（${ratios.cost.length} 个任务）`)
}
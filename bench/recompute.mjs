/**
 * Recompute a record's token totals from the session logs.
 *
 * The totals stored in a record were summed by `readOne` at run time. That reader
 * used to include the seeded prefix of a forked child, which carries the parent's
 * own usage: every child added one copy of the parent's tokens to the on arm. The
 * record's `formation` therefore overstates the on arm by however many children it
 * forked, times the size of the conversation at the fork point.
 *
 * This reads the logs again with the fixed reader and prints what each record
 * would say today, so an old batch can be corrected without re-running it.
 *
 * Usage:
 *   node bench/recompute.mjs [task...]
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readSessions, subtree, totals } from './sessions.mjs'

const RESULTS = process.env.DSH_RESULTS ?? 'bench/results'
const SESSIONS = process.env.DSH_SESSIONS ?? 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'

/** DeepSeek prices, 元 per million tokens (off-peak). */
const PRICE = { cacheHit: 0.02, cacheMiss: 1, output: 4 }

/**
 * The median of a list.
 *
 * @param {number[]} values - the samples.
 * @returns {number} the median.
 */
function median(values) {
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
console.log(`读入 ${sessions.size} 个会话`)

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
  const fixed = totals(subtree(sessions, record.sessionId))
  if (fixed.sessions === 0) {
    console.log(`  跳过 ${file}: 日志已不在`)
    continue
  }
  records.push({ file, record, fixed })
}

console.log()
console.log('记录               存储 total   重算 total    偏差     存储成本   重算成本')
for (const { file, record, fixed } of records) {
  const stored = record.formation ?? {}
  const storedTotal = stored.total ?? 0
  const delta = storedTotal === 0 ? 0 : (storedTotal / fixed.total - 1) * 100
  console.log(
    `${file.replace(/\.json$/, '').padEnd(20)}`
    + `${Math.round(storedTotal / 1000)}k`.padStart(10)
    + `${Math.round(fixed.total / 1000)}k`.padStart(12)
    + `${delta.toFixed(1)}%`.padStart(9)
    + `${('¥' + cost(stored).toFixed(2)).padStart(10)}`
    + `${('¥' + cost(fixed).toFixed(2)).padStart(11)}`,
  )
}

// The summary the batch exists for: per task, off vs on.
const byTask = new Map()
for (const { record, fixed } of records) {
  const key = `${record.task}\u0000${record.condition}`
  const list = byTask.get(key) ?? []
  list.push(fixed)
  byTask.set(key, list)
}
const tasks = [...new Set(records.map(item => item.record.task))]
console.log()
console.log('任务                 n     off成本    on成本    成本比    off token   on token   token比')
const costRatios = []
for (const task of tasks) {
  const off = byTask.get(`${task}\u0000off`) ?? []
  const on = byTask.get(`${task}\u0000on`) ?? []
  if (off.length === 0 || on.length === 0) continue
  const offCost = median(off.map(cost))
  const onCost = median(on.map(cost))
  const offToken = median(off.map(item => item.total))
  const onToken = median(on.map(item => item.total))
  const ratio = onCost / offCost
  costRatios.push(ratio)
  console.log(
    `${task.padEnd(18)}`
    + `${Math.min(off.length, on.length)}`.padStart(4)
    + `${('¥' + offCost.toFixed(2)).padStart(10)}`
    + `${('¥' + onCost.toFixed(2)).padStart(9)}`
    + `${(ratio.toFixed(2) + 'x').padStart(9)}`
    + `${Math.round(offToken / 1000)}k`.padStart(11)
    + `${Math.round(onToken / 1000)}k`.padStart(10)
    + `${(onToken / offToken).toFixed(2) + 'x'}`.padStart(10),
  )
}
if (costRatios.length > 0) {
  const geometric = Math.exp(costRatios.reduce((sum, value) => sum + Math.log(value), 0) / costRatios.length)
  console.log(`\n成本几何平均：on / off = ${geometric.toFixed(2)}x`)
}
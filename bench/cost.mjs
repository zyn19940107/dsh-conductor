/**
 * What a benchmark run cost, priced with the DeepSeek API's own table.
 *
 * The records already carry the three token classes the price table charges for,
 * summed over the whole session tree: `input` (cache miss), `cacheRead` (cache
 * hit) and `output`. DeepSeek prices peak and off-peak differently, so the run's
 * own start time picks the row.
 *
 * Prices are yuan per million tokens, from the model & pricing page:
 *   deepseek-flash            off-peak   peak
 *     input, cache hit          0.02      0.04
 *     input, cache miss         1         2
 *     output                    4         8
 * Peak is Monday-Friday 09:00-12:00 and 14:00-18:00 Beijing time; everything
 * else, weekends included, is off-peak. Public holidays are not modelled.
 *
 * Usage: node bench/cost.mjs [task ...]
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const RESULTS = process.env.DSH_RESULTS ?? 'D:/code/vibe/dsh-refine-loop/bench/results'
const SESSIONS = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'

const PRICE = {
  offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
  peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
}

const TASKS = process.argv.length > 2
  ? process.argv.slice(2)
  : ['coverage', 'review', 'humeval', 'humeval-hard', 'quixbugs', 'panel', 'lhtb-nbody', 'lhtb-matpower']

/**
 * @param record - the bench record.
 * @returns the run's start time in milliseconds, or undefined.
 */
function startOf(record) {
  const dir = readdirSync(SESSIONS).find(entry => entry === record.sessionId
    || entry.startsWith(String(record.sessionId).slice(8, 21)))
  if (dir === undefined) return undefined
  const file = readdirSync(join(SESSIONS, dir)).find(name => name.endsWith('.zstd'))
  if (file === undefined) return undefined
  try {
    const header = decodeLog(join(SESSIONS, dir, file)).split(String.fromCharCode(10))
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line) } catch { return null } })
      .find(event => event?.type === 'session')
    return header?.createdAt
  } catch {
    return undefined
  }
}

/**
 * @param at - a time in milliseconds.
 * @returns whether DeepSeek charges peak price then.
 */
function isPeak(at) {
  if (at === undefined) return false
  // Beijing is UTC+8 all year.
  const beijing = new Date(at + 8 * 3600_000)
  const day = beijing.getUTCDay()
  if (day === 0 || day === 6) return false
  const hour = beijing.getUTCHours()
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}

/**
 * @param record - the bench record.
 * @returns { yuan, peak } for the run.
 */
function costOf(record) {
  const at = startOf(record)
  const peak = isPeak(at)
  const price = peak ? PRICE.peak : PRICE.offPeak
  const yuan = (record.formation.cacheRead / 1e6) * price.cacheHit
    + (record.formation.input / 1e6) * price.cacheMiss
    + (record.formation.output / 1e6) * price.output
  return { yuan, peak }
}

/**
 * @param values - the numbers.
 * @returns the median.
 */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

console.log('每次运行的 DeepSeek 计价（元）\n')
console.log('任务'.padEnd(14), 'n'.padEnd(6), 'off'.padEnd(10), 'on'.padEnd(10), '倍数'.padEnd(8), 'on 省/多花')
let product = 1
let counted = 0
for (const task of TASKS) {
  const arms = { off: [], on: [] }
  for (const arm of ['off', 'on']) {
    for (let index = 1; index <= 5; index += 1) {
      let record
      try {
        record = JSON.parse(readFileSync(join(RESULTS, `${task}-${arm}-${index}.json`), 'utf8'))
      } catch {
        continue
      }
      arms[arm].push(costOf(record))
    }
  }
  if (arms.off.length === 0 || arms.on.length === 0) continue
  const off = median(arms.off.map(item => item.yuan))
  const on = median(arms.on.map(item => item.yuan))
  product *= on / off
  counted += 1
  console.log(
    task.padEnd(14),
    `${arms.off.length}/${arms.on.length}`.padEnd(6),
    `¥${off.toFixed(2)}`.padEnd(10),
    `¥${on.toFixed(2)}`.padEnd(10),
    `${(on / off).toFixed(2)}x`.padEnd(8),
    on <= off ? `省 ¥${(off - on).toFixed(2)}` : `多花 ¥${(on - off).toFixed(2)}`,
  )
}
console.log(`\n几何平均：on / off = ${Math.pow(product, 1 / counted).toFixed(2)}x`)
/**
 * The whole benchmark in one table: normalised time, tokens and correctness.
 *
 * Every record is normalised the same way the comparison scripts do it — each
 * node's model turns replaced by its tokens at a fixed speed, a plan block taken
 * as its slowest node, and nested delegation normalised recursively. The ratio
 * is the thing to read: the off arm's absolute seconds move with the API's mood
 * between batches, so a raw time cannot be compared across days.
 *
 * Usage: node bench/summary.mjs [speed]
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalise } from './normalise.mjs'

const RESULTS = 'D:/code/vibe/dsh-refine-loop/bench/results/before-clock-dedup'
const speed = process.argv[2] ?? '160'
process.env.SPEED = speed

const TASKS = [
  'coverage', 'review', 'humeval', 'humeval-hard', 'quixbugs',
  'panel', 'lhtb-2048', 'lhtb-nbody', 'lhtb-matpower',
]

/**
 * @param values - the numbers.
 * @returns the median.
 */
function median(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * @param task - the scenario name.
 * @param arm - on or off.
 * @returns the records that exist.
 */
function recordsOf(task, arm) {
  const out = []
  for (let index = 1; index <= 5; index += 1) {
    let record
    try {
      record = JSON.parse(readFileSync(join(RESULTS, `${task}-${arm}-${index}.json`), 'utf8'))
    } catch {
      continue
    }
    const normalised = normalise(record)
    if (normalised === undefined) continue
    out.push({ record, normalised })
  }
  return out
}

console.log(`归一化 ${speed} tok/s（并行感知，递归；子代理只算种子之后）\n`)
console.log('任务'.padEnd(14), 'n'.padEnd(7), 'off'.padEnd(9), 'on'.padEnd(9), '倍数'.padEnd(7), 'token倍数'.padEnd(10), '正确 off→on')

let product = 1
let tokenProduct = 1
let counted = 0
let scoreDelta = 0

for (const task of TASKS) {
  const off = recordsOf(task, 'off')
  const on = recordsOf(task, 'on')
  if (off.length === 0 || on.length === 0) {
    console.log(task.padEnd(14), '-')
    continue
  }
  const offTime = median(off.map(item => item.normalised.adjusted))
  const onTime = median(on.map(item => item.normalised.adjusted))
  const offTokens = median(off.map(item => item.record.formation?.total ?? 0))
  const onTokens = median(on.map(item => item.record.formation?.total ?? 0))
  const offRate = median(off.map(item => item.record.correctness.passed / item.record.correctness.total))
  const onRate = median(on.map(item => item.record.correctness.passed / item.record.correctness.total))

  const ratio = onTime / offTime
  const tokenRatio = offTokens > 0 && onTokens > 0 ? onTokens / offTokens : 1
  product *= ratio
  tokenProduct *= tokenRatio
  counted += 1
  scoreDelta += onRate - offRate

  console.log(
    task.padEnd(14),
    `${off.length}/${on.length}`.padEnd(7),
    `${(offTime / 1000).toFixed(0)}s`.padEnd(9),
    `${(onTime / 1000).toFixed(0)}s`.padEnd(9),
    `${ratio.toFixed(2)}x`.padEnd(7),
    `${tokenRatio.toFixed(2)}x`.padEnd(10),
    `${(offRate * 100).toFixed(0)}% → ${(onRate * 100).toFixed(0)}%`,
  )
}

console.log(`\n几何平均：时间 ${Math.pow(product, 1 / counted).toFixed(2)}x，`
  + `token ${Math.pow(tokenProduct, 1 / counted).toFixed(2)}x，`
  + `正确率平均 ${(scoreDelta / counted * 100).toFixed(1)} 个百分点`)

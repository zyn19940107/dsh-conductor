/**
 * Run the benchmark in both conditions, sequentially, and print the table.
 *
 * The runs are sequential on purpose: two runs against the same provider at
 * the same time measure the provider's contention as much as the plugin, and
 * a wall-clock number that cannot be reproduced is not a number worth
 * publishing.
 *
 * Usage: node bench/compare.mjs [runs-per-condition]
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUNS = Number(process.argv[2] ?? 3)

/**
 * Run one benchmark in one condition and wait for it.
 *
 * @param {string} condition - on | off
 * @param {number} index - the run's number, for its result file.
 * @returns {Promise<void>} resolves when the run is over.
 */
function runOne(condition, index) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [resolve(HERE, 'run-one.mjs'), condition, String(index)], {
      cwd: resolve(HERE, '..'),
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    child.on('close', code => {
      if (code === 0) resolveRun()
      else rejectRun(new Error(`the ${condition} run ${index} exited with ${String(code)}`))
    })
  })
}

console.log(`running ${RUNS} run(s) per condition, sequentially`)
for (let index = 1; index <= RUNS; index += 1) {
  for (const condition of ['off', 'on']) {
    const file = resolve(HERE, 'results', `${condition}-${index}.json`)
    if (existsSync(file)) {
      console.log(`skipping ${condition} ${index}: the result file already exists`)
      continue
    }
    process.stdout.write(`${condition} ${index} ... `)
    const started = Date.now()
    await runOne(condition, index)
    console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`)
  }
}

/**
 * Read every result of one condition.
 *
 * @param {string} condition - on | off
 * @returns {object[]} the records.
 */
function recordsOf(condition) {
  const records = []
  for (let index = 1; index <= RUNS; index += 1) {
    const file = resolve(HERE, 'results', `${condition}-${index}.json`)
    if (!existsSync(file)) continue
    records.push(JSON.parse(readFileSync(file, 'utf8')))
  }
  return records
}

/**
 * The median of a list of numbers.
 *
 * @param {number[]} values - the numbers.
 * @returns {number} the median.
 */
function median(values) {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle]
  return (sorted[middle - 1] + sorted[middle]) / 2
}

const off = recordsOf('off')
const on = recordsOf('on')

/**
 * One row of the comparison table.
 *
 * @param {string} label - what the row measures.
 * @param {object[]} a - the off records.
 * @param {object[]} b - the on records.
 * @param {string} unit - the unit to print.
 * @param {(record: object) => number} get - the accessor for the measured value.
 * @returns {string} the markdown row.
 */
function row(label, a, b, unit, get) {
  const pick = records => median(records.map(get))
  const av = pick(a)
  const bv = pick(b)
  const delta = av === 0 || Number.isNaN(av) ? '—' : `${(((bv - av) / av) * 100).toFixed(0)}%`
  return `| ${label} | ${fmt(av)}${unit} | ${fmt(bv)}${unit} | ${delta} |`
}

/**
 * Format a number for the table.
 *
 * @param {number} value - the number.
 * @returns {string} the formatted number.
 */
function fmt(value) {
  if (Number.isNaN(value)) return '—'
  return Math.round(value).toLocaleString('en-US')
}

console.log('')
console.log('| 指标 | 关掉插件 | 开着插件 | 变化 |')
console.log('|---|---:|---:|---:|')
/**
 * The calls a plan made inside itself.
 *
 * A plan's calls do not appear as top-level tool calls: they run inside the
 * plan tool and come back in its result. Counting only the top-level calls
 * would make the plan look like it did less work than it did, so the table
 * counts them too.
 *
 * @param {object} record - one run's record.
 * @returns {number} the calls the plan made.
 */
function planCalls(record) {
  const nodes = record.plan?.nodes ?? []
  return nodes
    .filter(node => node.kind === 'tools')
    .reduce((total, node) => total + (node.calls?.length ?? 0), 0)
}

console.log(row('步数(模型往返)', off, on, '', record => record.steps))
console.log(row('工具调用(顶层)', off, on, '', record => record.toolCalls))
console.log(row('工具调用(含计划内)', off, on, '', record => record.toolCalls + planCalls(record)))
console.log(row('总 tokens', off, on, '', record => record.usage.totalTokens))
console.log(row('其中 input', off, on, '', record => record.usage.inputTokens))
console.log(row('其中 cacheRead', off, on, '', record => record.usage.cacheReadTokens))
console.log(row('其中 output', off, on, '', record => record.usage.outputTokens))
console.log(row('墙钟(秒)', off, on, 's', record => record.wallMs / 1000))
console.log(row('正确性(命中判据)', off, on, '', record => record.correctness.passed))

console.log('')
console.log(`runs: off=${off.length} on=${on.length} (median)`)
for (const record of [...off, ...on]) {
  console.log(` ${record.condition} ${record.index}: ${(record.wallMs / 1000).toFixed(1)}s steps=${record.steps} calls=${record.toolCalls} tokens=${record.usage.totalTokens} correct=${record.correctness.passed}/${record.correctness.total}`)
}

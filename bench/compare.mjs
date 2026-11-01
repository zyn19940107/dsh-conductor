/**
 * Run the benchmark in both conditions, sequentially, and print the tables.
 *
 * The runs are sequential on purpose: two runs against the same provider at
 * the same time measure the provider's contention as much as the plugin, and
 * a wall-clock number that cannot be reproduced is not a number worth
 * publishing.
 *
 * Usage: node bench/compare.mjs [runs-per-condition] [task ...]
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TASKS } from './task.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUNS = Number(process.argv[2] ?? 3)
const TASKS_TO_RUN = process.argv.slice(3).filter(name => TASKS[name] !== undefined)

/**
 * Run one benchmark and wait for it.
 *
 * @param {string} task - the task name.
 * @param {string} condition - on | off
 * @param {number} index - the run's number.
 * @returns {Promise<void>} resolves when the run is over.
 */
function runOne(task, condition, index) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [resolve(HERE, 'run-one.mjs'), task, condition, String(index)], {
      cwd: resolve(HERE, '..'),
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    child.on('close', code => {
      if (code === 0) resolveRun()
      else rejectRun(new Error(`the ${task} ${condition} run ${index} exited with ${String(code)}`))
    })
  })
}

const tasks = TASKS_TO_RUN.length > 0 ? TASKS_TO_RUN : Object.keys(TASKS)

console.log(`running ${RUNS} run(s) per condition per task, sequentially`)
for (let index = 1; index <= RUNS; index += 1) {
  for (const task of tasks) {
    for (const condition of ['off', 'on']) {
      const file = resolve(HERE, 'results', `${task}-${condition}-${index}.json`)
      if (existsSync(file)) continue
      process.stdout.write(`${task} ${condition} ${index} ... `)
      const started = Date.now()
      await runOne(task, condition, index)
      console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`)
    }
  }
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

/**
 * Format a number for a table cell.
 *
 * @param {number} value - the number.
 * @returns {string} the formatted number.
 */
function fmt(value) {
  if (Number.isNaN(value)) return '—'
  return Math.round(value).toLocaleString('en-US')
}

/**
 * Every record of one task and condition.
 *
 * @param {string} task - the task name.
 * @param {string} condition - on | off
 * @returns {object[]} the records.
 */
function recordsOf(task, condition) {
  const records = []
  for (let index = 1; index <= RUNS; index += 1) {
    const file = resolve(HERE, 'results', `${task}-${condition}-${index}.json`)
    if (!existsSync(file)) continue
    records.push(JSON.parse(readFileSync(file, 'utf8')))
  }
  return records
}

/**
 * One row of a comparison table.
 *
 * @param {string} label - what the row measures.
 * @param {object[]} off - the off records.
 * @param {object[]} on - the on records.
 * @param {string} unit - the unit to print.
 * @param {(record: object) => number} get - the accessor for the measured value.
 * @returns {string} the markdown row.
 */
function row(label, off, on, unit, get) {
  const av = median(off.map(get))
  const bv = median(on.map(get))
  const delta = av === 0 || Number.isNaN(av) ? '—' : `${(((bv - av) / av) * 100).toFixed(0)}%`
  return `| ${label} | ${fmt(av)}${unit} | ${fmt(bv)}${unit} | ${delta} |`
}

for (const task of tasks) {
  const off = recordsOf(task, 'off')
  const on = recordsOf(task, 'on')
  if (off.length === 0 && on.length === 0) continue
  console.log('')
  console.log(`### ${task}  (off ${off.length} 次 / on ${on.length} 次,中位数)`)
  console.log('')
  console.log('| 指标 | 关掉插件 | 开着插件 | 变化 |')
  console.log('|---|---:|---:|---:|')
  console.log(row('总耗时(秒)', off, on, 's', record => record.wallMs / 1000))
  console.log(row('总 token(整个编队)', off, on, '', record => record.formation.total))
  console.log(row('├ input', off, on, '', record => record.formation.input))
  console.log(row('├ cacheRead', off, on, '', record => record.formation.cacheRead))
  console.log(row('└ output', off, on, '', record => record.formation.output))
  console.log(row('主 agent 的 context', off, on, '', record => record.mainPrompt))
  console.log(row('编队人数', off, on, ' 人', record => record.formation.agents))
  console.log(row('主 agent 的往返步数', off, on, '', record => record.steps))
  console.log(row('编队总步数', off, on, '', record => record.formation.steps))
  console.log(row('正确性(命中判据)', off, on, '', record => record.correctness.passed))
  console.log('')
  for (const record of [...off, ...on]) {
    console.log(` ${record.condition.padEnd(3)} ${record.index}: ${(record.wallMs / 1000).toFixed(1)}s `
      + `agents=${record.formation.agents} tokens=${record.formation.total} `
      + `mainCtx=${record.mainPrompt} correct=${record.correctness.passed}/${record.correctness.total} `
      + `plan=${record.planned ? 'y' : 'n'}/${record.planAgentNodes}`)
  }
}

/**
 * Compare two sets of benchmark results side by side.
 *
 * Usage: node bench/compare-versions.mjs <old-dir> <new-dir>
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OLD = resolve(HERE, process.argv[2] ?? 'results-with-nudge')
const NEW = resolve(HERE, process.argv[3] ?? 'results')

/**
 * Every record of one directory.
 *
 * @param {string} directory - the directory.
 * @returns {object[]} the records.
 */
function readAll(directory) {
  const records = []
  let files = []
  try {
    files = readdirSync(directory).filter(file => file.endsWith('.json'))
  } catch {
    return records
  }
  for (const file of files) {
    records.push(JSON.parse(readFileSync(join(directory, file), 'utf8')))
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

/**
 * One cell of the comparison: the median over one task and condition.
 *
 * @param {object[]} records - all the records.
 * @param {string} task - the task name.
 * @param {string} condition - on | off
 * @param {(record: object) => number} get - the accessor.
 * @returns {number} the median.
 */
function cell(records, task, condition, get) {
  return median(records
    .filter(record => record.task === task && record.condition === condition)
    .map(get))
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

const old = readAll(OLD)
const fresh = readAll(NEW)
const tasks = [...new Set(fresh.map(record => record.task))]

console.log('开着插件时(off 组是基线,两版一样,这里不重复)')
console.log('')
console.log('| 任务 | 指标 | 有 nudge | 无 nudge | 变化 |')
console.log('|---|---|---:|---:|---:|')
for (const task of tasks) {
  const rows = [
    ['编队出现率(有编队的运行)', (records) => {
      const runs = records.filter(record => record.task === task && record.condition === 'on')
      return runs.length === 0 ? Number.NaN : (runs.filter(record => record.formation.agents > 1).length / runs.length) * 100
    }, '%'],
    ['总耗时', records => cell(records, task, 'on', record => record.wallMs / 1000), 's'],
    ['总 token(整个编队)', records => cell(records, task, 'on', record => record.formation.total), ''],
    ['主 agent 的 context', records => cell(records, task, 'on', record => record.mainPrompt), ''],
    ['正确性', records => cell(records, task, 'on', record => record.correctness.passed), ''],
  ]
  for (const [label, get, unit] of rows) {
    const a = get(old)
    const b = get(fresh)
    const delta = a === 0 || Number.isNaN(a) ? '—' : `${(((b - a) / a) * 100).toFixed(0)}%`
    console.log(`| ${task} | ${label} | ${fmt(a)}${unit} | ${fmt(b)}${unit} | ${delta} |`)
  }
}

console.log('')
console.log('每一次运行(无 nudge):')
for (const record of fresh.filter(item => item.condition === 'on').sort((a, b) => a.task.localeCompare(b.task) || a.index - b.index)) {
  console.log(` ${record.task.padEnd(7)} on ${record.index}: ${(record.wallMs / 1000).toFixed(1)}s `
    + `agents=${record.formation.agents} tokens=${record.formation.total} `
    + `mainCtx=${record.mainPrompt} correct=${record.correctness.passed}/${record.correctness.total} `
    + `plan=${record.planned ? 'y' : 'n'}/${record.planAgentNodes}`)
}

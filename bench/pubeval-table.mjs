/**
 * Render the public-evaluation comparison for the README.
 *
 * The numbers in the README are generated, not typed: this reads the recorded
 * runs and prints the tables. A hand-typed number is a number nobody can
 * check.
 *
 * Usage: node bench/pubeval-table.mjs
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = 'bench/results'
const TASKS = ['humeval', 'humeval-hard', 'quixbugs', 'lhtb-2048', 'lhtb-nbody', 'lhtb-commit0', 'lhtb-matpower']

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
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/**
 * Every recorded run.
 */
const runs = []
for (const file of readdirSync(DIR)) {
  if (!file.endsWith('.json')) continue
  const record = JSON.parse(readFileSync(join(DIR, file), 'utf8'))
  if (!TASKS.includes(record.task)) continue
  runs.push(record)
}

/**
 * The median of one metric, for one task and one condition.
 *
 * @param {string} task - the task's name.
 * @param {string} condition - 'on' or 'off'.
 * @param {(record: object) => number} get - the accessor.
 * @returns {number} the median.
 */
function pick(task, condition, get) {
  return median(runs.filter(run => run.task === task && run.condition === condition).map(get))
}

/**
 * A signed percentage change.
 *
 * @param {number} off - the value without the plugin.
 * @param {number} on - the value with it.
 * @returns {string} the change as a display string.
 */
function delta(off, on) {
  if (!Number.isFinite(off) || off === 0) return '—'
  const percent = ((on - off) / off) * 100
  const sign = percent > 0 ? '+' : ''
  return `${sign}${percent.toFixed(0)}%`
}

/**
 * Format a token count.
 *
 * @param {number} value - the count.
 * @returns {string} the display string.
 */
function format(value) {
  if (!Number.isFinite(value)) return '—'
  if (Math.abs(value) >= 10000) return `${Math.round(value / 1000)}k`
  return String(Math.round(value))
}

const METRICS = [
  ['总耗时(秒)', record => record.wallMs / 1000, value => `${value.toFixed(0)}s`],
  ['整个编队的 token', record => record.formation.total, format],
  ['├ input', record => record.formation.input, format],
  ['├ cacheRead', record => record.formation.cacheRead, format],
  ['└ output', record => record.formation.output, format],
  ['主 agent 的 input', record => record.usage.inputTokens, format],
  ['主 agent 的 cacheRead', record => record.usage.cacheReadTokens, format],
  ['主 agent 的 output', record => record.usage.outputTokens, format],
  ['主 agent 的 context(最后一次请求的 prompt)', record => record.mainPrompt, format],
  ['主 agent 的往返步数', record => record.steps, value => String(value)],
  ['编队步数', record => record.formation.steps, value => String(value)],
  ['编队人数', record => record.formation.agents, value => String(value)],
]

for (const task of TASKS) {
  const off = runs.filter(run => run.task === task && run.condition === 'off')
  const on = runs.filter(run => run.task === task && run.condition === 'on')
  if (off.length === 0 && on.length === 0) continue
  console.log(`### ${task}  (off ${off.length} 次 / on ${on.length} 次,中位数)`)
  console.log('')
  console.log('| 指标 | 关掉插件 | 开着插件 | 变化 |')
  console.log('|---|---:|---:|---:|')
  for (const [label, get, fmt] of METRICS) {
    const a = pick(task, 'off', get)
    const b = pick(task, 'on', get)
    console.log(`| ${label} | ${fmt(a)} | ${fmt(b)} | ${delta(a, b)} |`)
  }
  const offCorrect = pick(task, 'off', record => record.correctness.passed)
  const onCorrect = pick(task, 'on', record => record.correctness.passed)
  const offTotal = pick(task, 'off', record => record.correctness.total)
  const onTotal = pick(task, 'on', record => record.correctness.total)
  const scaled = task.startsWith('lhtb-')
  const label = task === 'lhtb-commit0'
    ? '命中的判据(隐藏测试)'
    : (scaled ? '通过的档(加权分见下)' : '正确性(通过的判据)')
  console.log(`| ${label} `
    + `| ${offCorrect}/${offTotal} | ${onCorrect}/${onTotal} | — |`)
  // A judge may report a second score: the commit0 task reports the score the
  // agent's own code earns, with the libraries it copied dropped.
  const offVoided = pick(task, 'off', record => record.correctness.voidedScore ?? Number.NaN)
  const onVoided = pick(task, 'on', record => record.correctness.voidedScore ?? Number.NaN)
  if (Number.isFinite(offVoided) || Number.isFinite(onVoided)) {
    console.log(`| 自写分(去掉抄来的库) | ${Number.isFinite(offVoided) ? offVoided.toFixed(3) : '—'} `
      + `| ${Number.isFinite(onVoided) ? onVoided.toFixed(3) : '—'} | ${delta(offVoided, onVoided)} |`)
  }
  const offScore = pick(task, 'off', record => record.correctness.score ?? Number.NaN)
  const onScore = pick(task, 'on', record => record.correctness.score ?? Number.NaN)
  if (Number.isFinite(offScore) || Number.isFinite(onScore)) {
    console.log(`| 连续分(判据原始分) | ${Number.isFinite(offScore) ? offScore.toFixed(2) : '—'} `
      + `| ${Number.isFinite(onScore) ? onScore.toFixed(2) : '—'} | ${delta(offScore, onScore)} |`)
  }
  const planned = on.filter(record => record.planned).length
  console.log(`| 其中真的交了图的运行 | — | ${planned}/${on.length} | — |`)
  console.log('')
  if (planned > 0) {
    console.log(`只看**真的交了图**的那 ${planned} 次:`)
    console.log('')
    console.log('| 指标 | 关掉插件(全部) | 开着插件(交图的) |')
    console.log('|---|---:|---:|')
    for (const [label, get, fmt] of METRICS) {
      const a = pick(task, 'off', get)
      const b = median(on.filter(record => record.planned).map(get))
      console.log(`| ${label} | ${fmt(a)} | ${fmt(b)} |`)
    }
    console.log('')
  }
  for (const record of [...off, ...on]) {
    console.log(` ${record.condition.padEnd(3)} ${record.index}: ${(record.wallMs / 1000).toFixed(1)}s `
      + `agents=${record.formation.agents} tokens=${record.formation.total} `
      + `mainCtx=${record.mainPrompt} correct=${record.correctness.passed}/${record.correctness.total} `
      + `plan=${record.planned ? 'y' : 'n'}/${record.planAgentNodes} profile=${record.profile}`)
  }
  console.log('')
}

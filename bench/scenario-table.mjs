/**
 * Turn the recorded runs into the published scenario table.
 *
 * One row per task: what the plugin cost against what it saved, split the way
 * the tokens actually split — fresh input, cache reads, and output are different
 * money, and averaging them hides where the cost went.
 *
 * Usage: node bench/scenario-table.mjs [--markdown]
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = 'bench/results'
const markdown = process.argv.includes('--markdown')

/**
 * The median of a list of numbers.
 *
 * @param values - the numbers.
 * @returns the median, or 0 when the list is empty.
 */
function median(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/**
 * One run, as the table needs it.
 */
const ORDER = ['survey', 'discovery', 'fanout', 'chain', 'multihop', 'review']

const runs = []
for (const file of readdirSync(DIR)) {
  if (!file.endsWith('.json')) continue
  const record = JSON.parse(readFileSync(join(DIR, file), 'utf8'))
  runs.push({
    task: record.task,
    condition: record.condition,
    wallMs: record.wallMs,
    tokens: record.formation.total,
    input: record.usage.inputTokens,
    cache: record.usage.cacheReadTokens,
    output: record.usage.outputTokens,
    mainContext: record.mainPrompt,
    mainSteps: record.steps,
    formationSteps: record.formation.steps,
    agents: record.formation.agents,
    correct: record.correctness.passed,
    total: record.correctness.total,
    plans: record.plan,
  })
}

const tasks = [...new Set(runs.map(run => run.task))]
  .sort((left, right) => {
    const a = ORDER.indexOf(left)
    const b = ORDER.indexOf(right)
    return (a === -1 ? 99 : a) - (b === -1 ? 99 : b)
  })

/**
 * The median of one metric for one task and condition.
 *
 * @param task - the task name.
 * @param condition - 'on' or 'off'.
 * @param key - the metric.
 * @returns the median.
 */
function pick(task, condition, key) {
  return median(runs.filter(run => run.task === task && run.condition === condition).map(run => run[key]))
}

const rows = []
for (const task of tasks) {
  const onRuns = runs.filter(run => run.task === task && run.condition === 'on')
  const offRuns = runs.filter(run => run.task === task && run.condition === 'off')
  rows.push({
    task,
    n: `${onRuns.length}/${offRuns.length}`,
    off: {
      wall: pick(task, 'off', 'wallMs') / 1000,
      tokens: pick(task, 'off', 'tokens'),
      input: pick(task, 'off', 'input'),
      cache: pick(task, 'off', 'cache'),
      output: pick(task, 'off', 'output'),
      context: pick(task, 'off', 'mainContext'),
      steps: pick(task, 'off', 'mainSteps'),
      formationSteps: pick(task, 'off', 'formationSteps'),
      agents: pick(task, 'off', 'agents'),
      correct: `${pick(task, 'off', 'correct')}/${pick(task, 'off', 'total')}`,
    },
    on: {
      wall: pick(task, 'on', 'wallMs') / 1000,
      tokens: pick(task, 'on', 'tokens'),
      input: pick(task, 'on', 'input'),
      cache: pick(task, 'on', 'cache'),
      output: pick(task, 'on', 'output'),
      context: pick(task, 'on', 'mainContext'),
      steps: pick(task, 'on', 'mainSteps'),
      formationSteps: pick(task, 'on', 'formationSteps'),
      agents: pick(task, 'on', 'agents'),
      correct: `${pick(task, 'on', 'correct')}/${pick(task, 'on', 'total')}`,
    },
  })
}

/**
 * A signed percentage change.
 *
 * @param off - the value without the plugin.
 * @param on - the value with it.
 * @returns the change as a display string.
 */
function delta(off, on) {
  if (off === 0) return '—'
  const percent = ((on - off) / off) * 100
  const sign = percent > 0 ? '+' : ''
  return `${sign}${percent.toFixed(0)}%`
}

/**
 * Format a number with thin thousands separators.
 *
 * @param value - the number.
 * @returns the display string.
 */
function format(value) {
  if (value >= 10000) return `${Math.round(value / 1000)}k`
  return String(Math.round(value))
}

for (const row of rows) {
  console.log(`\n### ${row.task}  (n = ${row.n})`)
  console.log('')
  console.log('| 指标 | 关掉插件 | 开着插件 | 变化 |')
  console.log('|---|---:|---:|---:|')
  console.log(`| 总耗时 | ${row.off.wall.toFixed(0)}s | ${row.on.wall.toFixed(0)}s | ${delta(row.off.wall, row.on.wall)} |`)
  console.log(`| 总 token | ${format(row.off.tokens)} | ${format(row.on.tokens)} | ${delta(row.off.tokens, row.on.tokens)} |`)
  console.log(`| ├ input | ${format(row.off.input)} | ${format(row.on.input)} | ${delta(row.off.input, row.on.input)} |`)
  console.log(`| ├ cacheRead | ${format(row.off.cache)} | ${format(row.on.cache)} | ${delta(row.off.cache, row.on.cache)} |`)
  console.log(`| └ output | ${format(row.off.output)} | ${format(row.on.output)} | ${delta(row.off.output, row.on.output)} |`)
  console.log(`| 主 agent context | ${format(row.off.context)} | ${format(row.on.context)} | ${delta(row.off.context, row.on.context)} |`)
  console.log(`| 主 agent 步数 | ${row.off.steps} | ${row.on.steps} | ${delta(row.off.steps, row.on.steps)} |`)
  console.log(`| 编队步数 | ${row.off.formationSteps} | ${row.on.formationSteps} | ${delta(row.off.formationSteps, row.on.formationSteps)} |`)
  console.log(`| 编队人数 | ${row.off.agents} | ${row.on.agents} | ${delta(row.off.agents, row.on.agents)} |`)
  console.log(`| 正确性 | ${row.off.correct} | ${row.on.correct} | — |`)
}

console.log('')
console.log('| 场景 | 形状 | 耗时 | 总 token | input | cacheRead | output | 主 context | 正确性 |')
console.log('|---|---|---:|---:|---:|---:|---:|---:|---:|')
for (const row of rows) {
  const shape = {
    survey: '五个独立查找 + 一次归纳',
    discovery: '跨两个仓库的六个独立查找',
    fanout: '五个点名文件的同一问题',
    chain: '三步依赖链',
    multihop: 'grep → 按行号精读 → 归纳',
    review: '三段独立审查 + 汇总',
  }[row.task] ?? ''
  console.log(`| ${row.task} | ${shape} | ${delta(row.off.wall, row.on.wall)} | ${delta(row.off.tokens, row.on.tokens)} `
    + `| ${delta(row.off.input, row.on.input)} | ${delta(row.off.cache, row.on.cache)} | ${delta(row.off.output, row.on.output)} `
    + `| ${delta(row.off.context, row.on.context)} | ${row.on.correct} |`)
}

if (!markdown) {
  console.log('')
  console.log(`(${runs.length} 次运行,取中位数)`)
}
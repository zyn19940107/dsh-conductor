/**
 * Print the off / v1.0 / v2.0 numbers for every scenario, as medians per metric,
 * reading the current records and the archived v1.0 ones.
 *
 * Usage: node bench/three-way.mjs [scenario...]
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const RESULTS = 'D:/code/vibe/dsh-refine-loop/bench/results'
const OLD = join(RESULTS, 'before-one-layer')

/**
 * @param path - the record path.
 * @returns the record, or undefined.
 */
function read(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * @param records - the records.
 * @param pick - the value.
 * @returns the median.
 */
function median(records, pick) {
  const values = records.map(pick).filter(value => Number.isFinite(value)).sort((a, b) => a - b)
  if (values.length === 0) return undefined
  const mid = Math.floor(values.length / 2)
  return values.length % 2 === 0 ? (values[mid - 1] + values[mid]) / 2 : values[mid]
}

/**
 * @param records - the records.
 * @param scenario - the scenario.
 * @param group - off / on.
 * @param source - where they came from.
 * @returns the metric row.
 */
function row(records, scenario, group, source) {
  if (records.length === 0) return undefined
  const pick = key => median(records, record => record[key])
  const usage = key => median(records, record => record.usage?.[key])
  return {
    scenario,
    group,
    n: records.length,
    source,
    wall: median(records, record => record.wallMs),
    total: median(records, record => record.formation?.total),
    input: usage('inputTokens'),
    cache: usage('cacheReadTokens'),
    output: usage('outputTokens'),
    context: median(records, record => record.mainPrompt),
    steps: median(records, record => record.steps),
    agents: median(records, record => record.formation?.agents),
    passed: records.map(record => record.correctness?.passed).join('/'),
    totalChecks: records[0].correctness?.total,
  }
}

const scenarios = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : ['coverage', 'review', 'panel', 'humeval', 'humeval-hard', 'quixbugs', 'lhtb-2048', 'lhtb-nbody', 'lhtb-matpower', 'lhtb-commit0']

const seconds = value => value === undefined ? '—' : (value / 1000).toFixed(0) + 's'
const kilo = value => value === undefined ? '—' : Math.round(value / 1000) + 'k'

for (const scenario of scenarios) {
  const rows = []
  const current = { off: [], on: [] }
  for (const name of readdirSync(RESULTS)) {
    const match = new RegExp('^' + scenario + '-(off|on)-([0-9]+)\\.json$').exec(name)
    if (match === null) continue
    const record = read(join(RESULTS, name))
    if (record !== undefined) current[match[1]].push(record)
  }
  const old = { off: [], on: [] }
  for (const name of readdirSync(OLD)) {
    const match = new RegExp('^' + scenario + '-(off|on)-([0-9]+)\\.json$').exec(name)
    if (match === null || name.includes('POLLUTED')) continue
    const record = read(join(OLD, name))
    if (record !== undefined) old[match[1]].push(record)
  }
  rows.push(row(current.off, scenario, 'off', '本轮'))
  rows.push(row(old.on, scenario, 'v1.0', '归档'))
  rows.push(row(current.on, scenario, 'v2.0', '本轮'))
  const present = rows.filter(Boolean)
  if (present.length === 0) continue
  console.log('=== ' + scenario + ' ===')
  console.log('  group  n  wall   total  input  cache  output  context  steps  agents  passed')
  for (const entry of present) {
    console.log('  ' + entry.group.padEnd(5) + String(entry.n).padStart(2)
      + '  ' + seconds(entry.wall).padStart(5)
      + '  ' + kilo(entry.total).padStart(6)
      + '  ' + kilo(entry.input).padStart(5)
      + '  ' + kilo(entry.cache).padStart(6)
      + '  ' + kilo(entry.output).padStart(6)
      + '  ' + kilo(entry.context).padStart(8)
      + '  ' + String(entry.steps).padStart(5)
      + '  ' + String(entry.agents).padStart(6)
      + '  ' + entry.passed + ' of ' + entry.totalChecks)
  }
}

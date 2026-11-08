/**
 * Compare three builds per scenario: the old multi-round DAG records kept under
 * `before-one-layer/`, the current plugin off, and the current plugin on.
 *
 * Medians, not means: one bad sample in five should not move the number.
 *
 * Usage: node bench/compare-builds.mjs [scenario...]
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
 * @param pick - the value to take.
 * @returns the median, or undefined for no records.
 */
function median(records, pick) {
  const values = records.map(pick).filter(value => Number.isFinite(value)).sort((a, b) => a - b)
  if (values.length === 0) return undefined
  const mid = Math.floor(values.length / 2)
  return values.length % 2 === 0 ? (values[mid - 1] + values[mid]) / 2 : values[mid]
}

const scenarios = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : ['coverage', 'review', 'humeval', 'humeval-hard', 'quixbugs', 'lhtb-nbody', 'lhtb-matpower']

const rows = []
for (const scenario of scenarios) {
  const row = { scenario, oldOn: [], off: [], on: [] }
  for (const name of readdirSync(OLD)) {
    const match = new RegExp('^' + scenario + '-on-([0-9]+)\\.json$').exec(name)
    if (match === null) continue
    const record = read(join(OLD, name))
    if (record !== undefined) row.oldOn.push(record)
  }
  for (const arm of ['off', 'on']) {
    for (const name of readdirSync(RESULTS)) {
      const match = new RegExp('^' + scenario + '-' + arm + '-([0-9]+)\\.json$').exec(name)
      if (match === null) continue
      const record = read(join(RESULTS, name))
      if (record !== undefined) row[arm].push(record)
    }
  }
  rows.push(row)
}

const seconds = value => value === undefined ? '—' : (value / 1000).toFixed(0) + 's'
const kilo = value => value === undefined ? '—' : Math.round(value / 1000) + 'k'
const score = records => records.length === 0
  ? '—'
  : records.map(record => String(record.correctness?.passed ?? 0)).join('/')
    + ' of ' + String(records[0].correctness?.total ?? 0)

console.log('scenario        old(DAG)  n  wall  tokens     off   n  wall  tokens     on    n  wall  tokens     correct old/off/on')
for (const row of rows) {
  const cell = records => (records.length === 0
    ? '     —'
    : String(records.length).padStart(2) + '  ' + seconds(median(records, record => record.wallMs)).padStart(5)
      + '  ' + kilo(median(records, record => record.formation?.total)).padStart(6))
  console.log(row.scenario.padEnd(14)
    + '  ' + cell(row.oldOn)
    + '  ' + cell(row.off)
    + '  ' + cell(row.on)
    + '   ' + score(row.oldOn) + ' / ' + score(row.off) + ' / ' + score(row.on))
}

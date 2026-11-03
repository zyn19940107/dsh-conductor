/**
 * Aggregate the bench records of one scenario across N samples per arm: medians,
 * the spread, and a stall flag read off the main session's own steps.
 *
 * Usage: node bench/aggregate.mjs <scenario> [samples]
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const SESSIONS = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const RESULTS = 'D:/code/vibe/dsh-refine-loop/bench/results'
const LF = String.fromCharCode(10)
const scenario = process.argv[2] ?? 'review'
const samples = Number(process.argv[3] ?? '5')

/**
 * Every step duration of the run's main session.
 *
 * @param sessionId - the record's session id.
 * @returns step durations in milliseconds.
 */
function stepDurations(sessionId) {
  if (typeof sessionId !== 'string') return []
  const dir = readdirSync(SESSIONS).find(name => name === sessionId
    || name.startsWith(sessionId.slice(8, 21)))
  if (dir === undefined) return []
  const files = readdirSync(join(SESSIONS, dir)).filter(name => name.endsWith('.zstd')).sort()
  const events = []
  for (const name of files) {
    try {
      events.push(...decodeLog(join(SESSIONS, dir, name)).split(LF).filter(Boolean).map(line => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      }).filter(Boolean))
    } catch {
      // torn segment
    }
  }
  const durations = []
  let started
  for (const event of events) {
    if (event.type === 'step/start') started = event.time
    if (event.type === 'assistant/message' && started !== undefined) {
      durations.push(event.time - started)
      started = undefined
    }
  }
  return durations
}

/**
 * @param numbers - the numbers.
 * @returns the median.
 */
function median(numbers) {
  if (numbers.length === 0) return Number.NaN
  const sorted = [...numbers].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

const arms = ['off', 'on']
for (const arm of arms) {
  console.log(`=== ${scenario} ${arm} ===`)
  console.log('  #   wall   total    main in   main cR   main out  fleetSteps  mainSteps  agents  correct  plan  maxStep  stalls')
  const rows = []
  for (let index = 1; index <= samples; index += 1) {
    const path = join(RESULTS, `${scenario}-${arm}-${index}.json`)
    let record
    try {
      record = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      console.log(`  ${index}   — missing —`)
      continue
    }
    const usage = record.usage ?? {}
    const formation = record.formation ?? {}
    const durations = stepDurations(record.sessionId)
    const maxStep = Math.max(0, ...durations)
    const stalls = durations.filter(ms => ms > 120000).length
    rows.push({ wall: record.wallMs, total: formation.total ?? 0, correct: record.correctness?.passed ?? 0, stalls })
    console.log(`  ${String(index).padEnd(2)} ${(record.wallMs / 1000).toFixed(1).padStart(6)}`
      + ` ${String(formation.total ?? 0).padStart(9)}`
      + ` ${String(usage.input ?? 0).padStart(9)}`
      + ` ${String(usage.cacheRead ?? 0).padStart(9)}`
      + ` ${String(usage.output ?? 0).padStart(9)}`
      + ` ${String(formation.steps ?? 0).padStart(11)}`
      + ` ${String(record.steps ?? 0).padStart(10)}`
      + ` ${String(formation.agents ?? 0).padStart(7)}`
      + ` ${(String(record.correctness?.passed) + '/' + String(record.correctness?.total)).padStart(8)}`
      + ` ${String(record.planAgentNodes ?? 0).padStart(5)}`
      + ` ${String(Math.round(maxStep / 1000) + 's').padStart(8)}`
      + ` ${String(stalls).padStart(7)}`)
  }
  if (rows.length > 0) {
    const clean = rows.filter(row => row.stalls === 0)
    console.log(`  medians: wall ${(median(rows.map(row => row.wall)) / 1000).toFixed(1)}s`
      + `  total ${median(rows.map(row => row.total))}`
      + `  correct ${rows.map(row => String(row.correct)).join('/')}`
      + `  stalls ${rows.map(row => String(row.stalls)).join('/')}`)
    if (clean.length > 0 && clean.length < rows.length) {
      console.log(`  no-stall only (${clean.length}/${rows.length}): wall ${(median(clean.map(row => row.wall)) / 1000).toFixed(1)}s`
        + `  total ${median(clean.map(row => row.total))}`)
    }
  }
  console.log()
}

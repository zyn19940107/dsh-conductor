/**
 * Print the off / v1.0 / v2.0 / v2.1 comparison for the coverage and review
 * scenarios, as medians, plus the plan-report truncation counts.
 *
 * Usage: node bench/four-way.mjs
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const RESULTS = 'D:/code/vibe/dsh-refine-loop/bench/results'
const OLD = join(RESULTS, 'before-one-layer')
const V20 = join(RESULTS, 'v2.0')
const SESSIONS = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const LF = String.fromCharCode(10)

/**
 * @param path - a record path.
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
 * The plan reports of one run, when they can still be read back.
 *
 * @param record - the bench record.
 * @returns the truncation count and the report count, or undefined.
 */
function truncationOf(record) {
  const dir = readdirSync(SESSIONS).find(name => name === record.sessionId
    || name.startsWith(record.sessionId.slice(8, 21)))
  if (dir === undefined) return undefined
  const events = []
  for (const file of readdirSync(join(SESSIONS, dir)).filter(name => name.endsWith('.zstd')).sort()) {
    try {
      events.push(...decodeLog(join(SESSIONS, dir, file)).split(LF).filter(Boolean).map(line => {
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
  const open = new Map()
  let reports = 0
  let truncated = 0
  for (const event of events) {
    if (event.type === 'tool/call') open.set(String(event.data?.callId), event.data?.name)
    if (event.type !== 'tool/result') continue
    if (open.get(String(event.data?.message?.toolCallId ?? '')) !== 'refine_plan') continue
    const text = (event.data?.message?.content ?? []).map(block => block.text ?? '').join('')
    reports += 1
    if (text.includes('Omitted')) truncated += 1
  }
  return reports === 0 ? undefined : { reports, truncated }
}

for (const task of ['coverage', 'review']) {
  console.log(`\n===== ${task} =====`)
  const groups = [
    ['off', [1, 2, 3, 4, 5].map(index => read(join(RESULTS, `${task}-off-${index}.json`))).filter(Boolean)],
    ['v1.0', [1, 2, 3, 4, 5].map(index => read(join(OLD, `${task}-on-${index}.json`))).filter(Boolean)],
    ['v2.0', [1, 2, 3, 4, 5].map(index => read(join(V20, `${task}-on-${index}.json`))).filter(Boolean)],
    ['v2.1', [1, 2, 3, 4, 5].map(index => read(join(RESULTS, `${task}-on-${index}.json`))).filter(Boolean)],
  ]
  for (const [label, records] of groups) {
    const plans = records.map(truncationOf).filter(Boolean)
    const reports = plans.reduce((sum, entry) => sum + entry.reports, 0)
    const truncated = plans.reduce((sum, entry) => sum + entry.truncated, 0)
    console.log(`  ${label.padEnd(5)} n=${records.length}`
      + `  耗时 ${(median(records, r => r.wallMs) / 1000).toFixed(0)}s`
      + `  token ${(median(records, r => r.formation?.total) / 1000).toFixed(0)}k`
      + `  context ${(median(records, r => r.mainPrompt) / 1000).toFixed(0)}k`
      + `  步数 ${median(records, r => r.steps)}`
      + `  正确性 ${records.map(r => `${r.correctness?.passed}/${r.correctness?.total}`).join(' ')}`
      + (reports === 0 ? '' : `  报告截断 ${truncated}/${reports}`))
  }
}

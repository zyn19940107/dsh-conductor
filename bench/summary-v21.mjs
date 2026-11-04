/**
 * Summarise what the coverage and review re-runs produced, against the archived
 * v2.0 records.
 *
 * Reads the plan results out of each run's session log so the summary can say
 * whether a report was truncated and whether the compressor fired.
 *
 * Usage: node bench/summary-v21.mjs
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const RESULTS = 'D:/code/vibe/dsh-refine-loop/bench/results'
const ARCHIVE = join(RESULTS, 'v2.0')
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
 * The plan reports of one run.
 *
 * @param record - the bench record.
 * @returns the report sizes, truncation count and compression markers.
 */
function plansOf(record) {
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
  const sizes = []
  let truncated = 0
  let compressed = 0
  for (const event of events) {
    if (event.type === 'tool/call') open.set(String(event.data?.callId), event.data?.name)
    if (event.type !== 'tool/result') continue
    if (open.get(String(event.data?.message?.toolCallId ?? '')) !== 'refine_plan') continue
    const text = (event.data?.message?.content ?? []).map(block => block.text ?? '').join('')
    sizes.push(text.length)
    if (text.includes('Omitted')) truncated += 1
    if (/compressed to/.test(text)) compressed += 1
  }
  return { sizes, truncated, compressed }
}

for (const task of ['coverage', 'review']) {
  console.log(`\n===== ${task} =====`)
  for (const [label, dir] of [['v2.0', ARCHIVE], ['v2.1', RESULTS]]) {
    const records = [1, 2, 3, 4, 5].map(index => read(join(dir, `${task}-on-${index}.json`))).filter(Boolean)
    if (records.length === 0) {
      console.log(`  ${label}: 没有记录`)
      continue
    }
    const plans = records.map(plansOf).filter(Boolean)
    const sizes = plans.flatMap(entry => entry.sizes)
    const truncated = plans.reduce((sum, entry) => sum + entry.truncated, 0)
    const compressed = plans.reduce((sum, entry) => sum + entry.compressed, 0)
    console.log(`  ${label}  n=${records.length}`
      + `  耗时 ${(median(records, r => r.wallMs) / 1000).toFixed(0)}s`
      + `  编队 token ${(median(records, r => r.formation?.total) / 1000).toFixed(0)}k`
      + `  主 context ${(median(records, r => r.mainPrompt) / 1000).toFixed(0)}k`
      + `  步数 ${median(records, r => r.steps)}`
      + `  正确性 ${records.map(r => r.correctness?.passed).join('/')}`)
    console.log(`        plan 报告 ${sizes.length} 个：${sizes.map(size => (size / 1000).toFixed(1) + 'k').join(' / ')}`)
    console.log(`        被截断 ${truncated} 个 ✗  |  含压缩标记 ${compressed} 个`)
  }
}

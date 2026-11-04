/**
 * Find the tool calls that put the most text into the context, across the v2.0
 * (plugin-on) bench records.
 *
 * Usage: node bench/tool-context.mjs [topN]
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const RESULTS = 'D:/code/vibe/dsh-refine-loop/bench/results'
const SESSIONS = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const LF = String.fromCharCode(10)
const topN = Number(process.argv[2] ?? '5')

/**
 * Every event of one session, all segments.
 *
 * @param sessionId - the session id.
 * @returns the events.
 */
function eventsOf(sessionId) {
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
  return events
}

/**
 * Pair each tool call with the size of what it returned.
 *
 * @param events - the session's events.
 * @returns the calls.
 */
function callsOf(events) {
  const open = new Map()
  const calls = []
  for (const event of events) {
    if (event.type === 'tool/call') {
      const call = { id: String(event.data?.callId), name: event.data?.name, arguments: String(event.data?.arguments ?? ''), size: 0 }
      open.set(call.id, call)
      calls.push(call)
      continue
    }
    if (event.type !== 'tool/result') continue
    const id = String(event.data?.message?.toolCallId ?? '')
    const call = open.get(id)
    if (call === undefined) continue
    const text = (event.data?.message?.content ?? []).map(block => block.text ?? '').join('')
    call.size += text.length
    open.delete(id)
  }
  return calls
}

// Every plugin-on record, main session only.
const rows = []
for (const name of readdirSync(RESULTS)) {
  const match = /^(.*)-on-([0-9]+)\.json$/.exec(name)
  if (match === null) continue
  const record = JSON.parse(readFileSync(join(RESULTS, name), 'utf8'))
  const events = eventsOf(record.sessionId)
  if (events.length === 0) continue
  const calls = callsOf(events).filter(call => call.size > 0).sort((a, b) => b.size - a.size)
  const total = calls.reduce((sum, call) => sum + call.size, 0)
  rows.push({ name, scenario: match[1], index: match[2], calls, total })
}

rows.sort((a, b) => (b.calls[0]?.size ?? 0) - (a.calls[0]?.size ?? 0))

console.log('每个 v2.0 运行里，单次工具调用往上下文里灌进去最多的几条：')
for (const row of rows.slice(0, 12)) {
  const biggest = row.calls[0]
  if (biggest === undefined) continue
  console.log(`\n${row.name}  工具结果总计 ${(row.total / 1000).toFixed(0)}k 字符`)
  for (const call of row.calls.slice(0, topN)) {
    const args = call.arguments.replace(/\s+/g, ' ').slice(0, 130)
    console.log(`  ${(call.size / 1000).toFixed(1).padStart(6)}k  ${call.name.padEnd(10)} ${args}`)
  }
}

// Aggregate by tool name.
const byTool = new Map()
for (const row of rows) {
  for (const call of row.calls) {
    const entry = byTool.get(call.name) ?? { count: 0, chars: 0, max: 0 }
    entry.count += 1
    entry.chars += call.size
    entry.max = Math.max(entry.max, call.size)
    byTool.set(call.name, entry)
  }
}
console.log('\n\n按工具汇总（全部 v2.0 运行）：')
console.log('  工具       次数   总字符    平均     最大')
for (const [name, entry] of [...byTool.entries()].sort((a, b) => b[1].chars - a[1].chars)) {
  console.log('  ' + name.padEnd(11)
    + String(entry.count).padStart(4)
    + String((entry.chars / 1000).toFixed(0) + 'k').padStart(9)
    + String((entry.chars / entry.count / 1000).toFixed(1) + 'k').padStart(8)
    + String((entry.max / 1000).toFixed(1) + 'k').padStart(9))
}

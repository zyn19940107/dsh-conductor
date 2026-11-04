/**
 * List the tool calls in the v2.0 runs that put at least 20k characters into the
 * context, biggest first.
 *
 * Usage: node bench/big-calls.mjs [threshold]
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const RESULTS = 'D:/code/vibe/dsh-refine-loop/bench/results'
const SESSIONS = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const LF = String.fromCharCode(10)
const threshold = Number(process.argv[2] ?? '20000')

const calls = []
for (const name of readdirSync(RESULTS)) {
  const match = /^(.*)-on-([0-9]+)\.json$/.exec(name)
  if (match === null) continue
  const record = JSON.parse(readFileSync(join(RESULTS, name), 'utf8'))
  const dir = readdirSync(SESSIONS).find(entry => entry === record.sessionId
    || entry.startsWith(record.sessionId.slice(8, 21)))
  if (dir === undefined) continue
  const events = []
  for (const file of readdirSync(join(SESSIONS, dir)).filter(entry => entry.endsWith('.zstd')).sort()) {
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
  for (const event of events) {
    if (event.type === 'tool/call') {
      open.set(String(event.data?.callId), { name: event.data?.name, args: String(event.data?.arguments ?? ''), size: 0, run: name })
      continue
    }
    if (event.type !== 'tool/result') continue
    const id = String(event.data?.message?.toolCallId ?? '')
    const call = open.get(id)
    if (call === undefined) continue
    call.size += (event.data?.message?.content ?? []).map(block => block.text ?? '').join('').length
    open.delete(id)
    if (call.size > 0) calls.push(call)
  }
}

const big = calls.filter(call => call.size >= threshold).sort((a, b) => b.size - a.size)
console.log('v2.0 主 agent 的工具调用:', calls.length, '次；其中结果 ≥', threshold, '字符的:', big.length, '次')
console.log()
for (const call of big) {
  console.log('  ' + (call.size / 1000).toFixed(1).padStart(6) + 'k  ' + String(call.name).padEnd(12)
    + call.run.replace(/-on-[0-9]+\.json/, '').padEnd(15)
    + call.args.replace(/\s+/g, ' ').slice(0, 110))
}

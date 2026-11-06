/**
 * What a child session's time actually went into: per step, the wait before the
 * model answered, how many tokens it wrote, and the exact calls it made.
 *
 * Usage: node bench/child-what.mjs <child-session-prefix>
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const SESSIONS = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const LF = String.fromCharCode(10)
const prefix = process.argv[2]

const session = readdirSync(SESSIONS).find(entry => entry.startsWith('refine-loop-child-') && entry.includes(prefix))
if (session === undefined) {
  console.error('no session matches', prefix)
  process.exit(1)
}

const events = []
for (const file of readdirSync(join(SESSIONS, session)).filter(entry => entry.endsWith('.zstd')).sort()) {
  try {
    events.push(...decodeLog(join(SESSIONS, session, file)).split(LF).filter(Boolean).map(line => {
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

const stamp = event => event.timestamp ?? event.time ?? 0
const base = Math.min(...events.map(stamp).filter(value => value > 0))
const results = new Map()
for (const event of events) {
  if (event.type !== 'tool/result') continue
  const id = String(event.data?.message?.toolCallId ?? event.data?.toolCallId ?? '')
  results.set(id, stamp(event))
}

let previous = base
let step = 0
for (const event of events) {
  if (event.type !== 'assistant/message') continue
  step += 1
  const at = stamp(event)
  const message = event.data?.message ?? {}
  const usage = event.data?.usage ?? message.usage ?? {}
  const blocks = message.content ?? []
  const calls = blocks.filter(block => block.type === 'tool-call').map(block => {
    const args = block.arguments ?? block.args ?? {}
    const text = typeof args === 'string' ? args : JSON.stringify(args)
    return `${block.name ?? block.toolName}(${String(text).slice(0, 110)})`
  })
  const text = blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
  const wait = (at - previous) / 1000
  console.log(`${String(step).padStart(2)}  等待 ${wait.toFixed(1).padStart(5)}s  输出 ${String(usage.outputTokens ?? 0).padStart(5)} tok  输入 ${String(usage.inputTokens ?? 0).padStart(6)} tok`)
  if (text.trim() !== '') console.log(`    说: ${text.replace(/\s+/g, ' ').slice(0, 120)}`)
  for (const call of calls) {
    const result = calls.length > 0 ? '' : ''
    console.log(`    调: ${call}`)
  }
  previous = at
}
const end = Math.max(...events.map(stamp))
console.log(`\n总跨度 ${((end - base) / 1000).toFixed(0)}s，${step} 次模型往返`)

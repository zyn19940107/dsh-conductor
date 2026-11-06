/**
 * Timeline of one child session: what a slow worker actually did.
 *
 * Only the steps after the seed boundary are the child's own.
 *
 * Usage: node bench/child-timeline.mjs <child-session-prefix>
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ownEvents } from './child-events.mjs'

const SESSIONS = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const LF = String.fromCharCode(10)
const prefix = process.argv[2]

const session = readdirSync(SESSIONS).find(entry => entry.startsWith('refine-loop-child-') && entry.includes(prefix))
if (session === undefined) {
  console.error('no session matches', prefix)
  process.exit(1)
}

const { inherited, own: events } = ownEvents(session)
console.log(`会话 ${session.slice(18, 30)}  继承 ${inherited} 条事件，自己的 ${events.length} 条
`)

const stamp = event => event.timestamp ?? event.time ?? 0
const base = Math.min(...events.map(stamp).filter(value => value > 0))
const calls = new Map()
let index = 0

for (const event of events) {
  const at = (stamp(event) - base) / 1000
  if (event.type === 'assistant/message') {
    const message = event.data?.message ?? {}
    const usage = event.data?.usage ?? message.usage ?? {}
    const blocks = message.content ?? []
    const thinking = blocks.filter(block => block.type === 'thinking').map(block => block.thinking ?? '').join('').length
    const text = blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
    const toolCalls = blocks.filter(block => block.type === 'tool-call').map(block => block.name ?? block.toolName ?? '?')
    for (const block of blocks.filter(block => block.type === 'tool-call')) {
      calls.set(String(block.toolCallId ?? block.id ?? ''), { name: block.name ?? block.toolName ?? '?', at })
    }
    index += 1
    console.log(`#${String(index).padStart(2)} ${at.toFixed(0).padStart(4)}s  out ${String(usage.outputTokens ?? 0).padStart(5)} tok  think ${String(thinking).padStart(6)} chars  text ${String(text.length).padStart(5)} chars  calls [${toolCalls.join(',')}]`)
  }
  if (event.type === 'tool/result') {
    const id = String(event.data?.message?.toolCallId ?? event.data?.toolCallId ?? '')
    const call = calls.get(id)
    if (call === undefined) continue
    const content = (event.data?.message?.content ?? event.data?.content ?? []).map(block => block.text ?? block.content ?? '').join('')
    console.log(`      ↳ ${call.name} ${((stamp(event) - base) / 1000 - call.at).toFixed(1)}s  → ${content.length} chars`)
  }
}

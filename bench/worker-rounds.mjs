/**
 * One worker, round by round: what it waited for, how big its context already
 * was, what it wrote, and what each tool returned.
 *
 * Usage: node bench/worker-rounds.mjs <child-session-prefix>
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { SESSIONS, ownEvents, stamp } from './child-events.mjs'

const prefix = process.argv[2]
const session = readdirSync(SESSIONS).find(entry => entry.startsWith('refine-loop-child-') && entry.includes(prefix))
if (session === undefined) {
  console.error('no session matches', prefix)
  process.exit(1)
}

const { inherited, own } = ownEvents(session)
console.log(`会话 ${session.slice(18, 30)}  继承 ${inherited} 条，自己的 ${own.length} 条`)

/** Tool calls, by id, so a result can name the call it answers. */
const pending = new Map()
let previous = Math.min(...own.map(stamp).filter(value => value > 0))
let round = 0
let totalWait = 0

for (const event of own) {
  const at = stamp(event)
  if (event.type === 'assistant/message') {
    round += 1
    const message = event.data?.message ?? {}
    const usage = event.data?.usage ?? message.usage ?? {}
    const wait = (at - previous) / 1000
    totalWait += wait
    const calls = (message.content ?? []).filter(block => block.type === 'tool-call')
    const names = calls.map(call => {
      const args = call.arguments ?? call.args ?? {}
      const text = typeof args === 'string' ? args : JSON.stringify(args)
      return `${call.name}(${String(text).replace(/\s+/g, ' ').slice(0, 80)})`
    })
    console.log(`\n第 ${String(round).padStart(2)} 轮  等待 ${wait.toFixed(1).padStart(5)}s  输入 ${String(usage.inputTokens ?? 0).padStart(6)} tok  输出 ${String(usage.outputTokens ?? 0).padStart(5)} tok`)
    for (const call of calls) {
      pending.set(String(call.toolCallId ?? call.id ?? ''), call.name)
      console.log(`     调 ${names.shift()}`)
    }
    previous = at
  }
  if (event.type === 'tool/result') {
    const id = String(event.data?.message?.toolCallId ?? event.data?.toolCallId ?? '')
    const name = pending.get(id)
    if (name === undefined) continue
    pending.delete(id)
    const content = (event.data?.message?.content ?? event.data?.content ?? []).map(block => block.text ?? '').join('')
    console.log(`     ↳ ${name} 用时 ${((at - previous) / 1000).toFixed(1)}s，返回 ${content.length} 字符`)
  }
}

const last = Math.max(...own.map(stamp))
console.log(`\n合计 ${((last - Math.min(...own.map(stamp).filter(value => value > 0))) / 1000).toFixed(0)}s，模型等待 ${totalWait.toFixed(0)}s，${round} 轮`)

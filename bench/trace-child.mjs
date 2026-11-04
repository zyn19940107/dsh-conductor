/**
 * Reconstruct one child session's own turn, event by event.
 *
 * A child's log opens with the inherited seed (the parent's events), so the
 * child's own work is everything after the seed boundary. This prints that part
 * only: each step's wall time and reasoning, and each tool call with how long it
 * took, so the 540 seconds of one worker can be attributed rather than guessed.
 *
 * Usage: node bench/trace-child.mjs [parentRecord] [childSessionPrefix]
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const SESSIONS = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const LF = String.fromCharCode(10)
const RESULTS = 'D:/code/vibe/dsh-refine-loop/bench/results'
const RECORD = process.argv[2] ?? 'lhtb-2048-on-1.json'
const CHILD = process.argv[3]

/**
 * @param session - a session directory.
 * @returns its events, in order.
 */
function eventsOf(session) {
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
  return events
}

const record = JSON.parse(readFileSync(join(RESULTS, RECORD), 'utf8'))
const children = readdirSync(SESSIONS).filter(entry => entry.startsWith('refine-loop-child-'))
const candidates = []
for (const entry of children) {
  if (CHILD !== undefined && !entry.startsWith(`refine-loop-child-${CHILD}`)) continue
  const events = eventsOf(entry)
  const header = events.find(event => event.type === 'session')
  const parent = header?.data?.parentSession ?? header?.parentSession
  if (parent !== record.sessionId) continue
  candidates.push({ entry, events })
}

if (candidates.length === 0) {
  console.error(`no child session of ${RECORD} matched`)
  process.exit(1)
}

for (const { entry, events } of candidates) {
  const boundaries = []
  for (const [index, event] of events.entries()) {
    if (String(event.type).includes('end-seed')) boundaries.push(index)
  }
  const first = boundaries[0] ?? -1
  const own = events.slice(first + 1)

  console.log(`=== 子会话 ${entry}`)
  console.log(`事件 ${events.length} 个，seed 边界 ${boundaries.length} 个（首个在第 ${first} 个）`)
  console.log(`继承部分: ${first + 1} 个事件；自己的部分: ${own.length} 个事件`)

  // What the child was told.
  const prompt = own.filter(event => event.type === 'user/message')
    .map(event => (event.data?.message?.content ?? event.data?.content ?? []).map(block => block.text ?? '').join(''))
    .join('')
  console.log(`自己的第一条 user 消息开头: ${prompt.slice(0, 120).replace(/\n/g, ' ')}`)

  // Walk the own region: each step and each call.
  let stepStart = 0
  let step = 0
  const callStart = new Map()
  let modelMs = 0
  let toolMs = 0
  const calls = []
  for (const event of own) {
    const at = event.timestamp ?? event.time ?? 0
    if (event.type === 'step/start') stepStart = at
    if (event.type === 'turn/start') stepStart = at
    if (event.type === 'assistant/message') {
      step += 1
      const content = event.data?.message?.content ?? []
      const reasoning = content.filter(block => block.type === 'reasoning').reduce((sum, block) => sum + (block.text ?? '').length, 0)
      const names = content.filter(block => block.type === 'tool-call').map(block => block.name)
      const spent = (at - stepStart) / 1000
      modelMs += at - stepStart
      console.log(`  步${String(step).padStart(2)} 模型 ${spent.toFixed(1)}s  思考 ${reasoning}字符  调用: ${names.join(',') || '(无)'}`)
    }
    if (event.type === 'tool/call') callStart.set(String(event.data?.callId), { at, name: event.data?.name, args: String(event.data?.arguments ?? '') })
    if (event.type === 'tool/result') {
      const started = callStart.get(String(event.data?.message?.toolCallId ?? ''))
      if (started === undefined) continue
      const spent = (at - started.at) / 1000
      toolMs += at - started.at
      const result = (event.data?.message?.content ?? []).map(block => block.text ?? '').join('')
      calls.push({ name: started.name, spent, result: result.length, args: started.args })
      callStart.delete(String(event.data?.message?.toolCallId))
    }
  }

  console.log(`  --- 汇总：模型时间 ${(modelMs / 1000).toFixed(0)}s，工具时间 ${(toolMs / 1000).toFixed(0)}s`)
  console.log('  --- 工具调用明细（按耗时排序）---')
  for (const call of [...calls].sort((a, b) => b.spent - a.spent).slice(0, 12)) {
    const args = call.args.replace(/\s+/g, ' ').slice(0, 110)
    console.log(`    ${call.spent.toFixed(1)}s  ${call.name}  结果 ${call.result}字符  ${args}`)
  }
}

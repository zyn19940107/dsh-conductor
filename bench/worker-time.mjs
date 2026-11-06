/**
 * Where a worker's time goes, across the runs of one task.
 *
 * For every child session of the given runs: the model round-trips, how long
 * each waited, how much the child wrote, and how much time the tools took.
 *
 * Usage: node bench/worker-time.mjs <task> [runs]
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const RESULTS = 'D:/code/vibe/dsh-refine-loop/bench/results'
const SESSIONS = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const LF = String.fromCharCode(10)
const task = process.argv[2] ?? 'coverage'
const runs = Number(process.argv[3] ?? '4')

/**
 * @param session - a session directory name.
 * @returns its events after the seed boundary.
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

const stamp = event => event.timestamp ?? event.time ?? 0

for (let index = 1; index <= runs; index += 1) {
  let record
  try {
    record = JSON.parse(readFileSync(join(RESULTS, `${task}-on-${index}.json`), 'utf8'))
  } catch {
    continue
  }
  const parent = record.sessionId
  const children = []
  for (const entry of readdirSync(SESSIONS)) {
    if (!entry.startsWith('refine-loop-child-')) continue
    const all = eventsOf(entry)
    const header = all.find(event => event.type === 'session')
    const owner = header?.data?.parentSession ?? header?.parentSession
    if (owner !== parent) continue
    const boundary = all.findIndex(event => String(event.type).includes('end-seed'))
    const events = boundary < 0 ? all : all.slice(boundary + 1)
    const first = Math.min(...events.map(stamp).filter(value => value > 0))
    const last = Math.max(...events.map(stamp))
    let steps = 0
    let output = 0
    let thinking = 0
    let toolMs = 0
    let slowest = 0
    const calls = new Map()
    let previous = first
    for (const event of events) {
      if (event.type === 'assistant/message') {
        steps += 1
        const message = event.data?.message ?? {}
        const usage = event.data?.usage ?? message.usage ?? {}
        output += usage.outputTokens ?? 0
        for (const block of message.content ?? []) {
          if (block.type === 'thinking') thinking += (block.thinking ?? '').length
          if (block.type === 'tool-call') calls.set(String(block.toolCallId ?? block.id ?? ''), stamp(event))
        }
        slowest = Math.max(slowest, (stamp(event) - previous) / 1000)
        previous = stamp(event)
      }
      if (event.type === 'tool/result') {
        const id = String(event.data?.message?.toolCallId ?? event.data?.toolCallId ?? '')
        const at = calls.get(id)
        if (at !== undefined) {
          toolMs += stamp(event) - at
          calls.delete(id)
        }
      }
    }
    children.push({ id: entry.slice(18, 28), span: (last - first) / 1000, steps, output, thinking, toolMs: toolMs / 1000, slowest })
  }
  const total = children.reduce((sum, child) => sum + child.span, 0)
  console.log(`${task}-on-${index}  墙钟 ${(record.wallMs / 1000).toFixed(0)}s  编队 ${record.formation?.agents}  子代理合计 ${total.toFixed(0)}s`)
  for (const child of children.sort((a, b) => b.span - a.span)) {
    console.log(`  ${child.id}  ${child.span.toFixed(0).padStart(3)}s | ${String(child.steps).padStart(2)} 次往返 | 输出 ${String(child.output).padStart(5)} tok | 思考 ${String(child.thinking).padStart(6)} 字 | 工具 ${child.toolMs.toFixed(1)}s | 最慢一轮 ${child.slowest.toFixed(0)}s`)
  }
}

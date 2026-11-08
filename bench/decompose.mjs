/**
 * Where a run's wall time went.
 *
 * The record says how long a run took; this says what it was spent on. A run is
 * the parent's own model time, the plan blocks it waited on, and everything else
 * (tool calls outside a plan, gaps). A plan block runs its nodes in parallel, so
 * its duration is the time the parent spent waiting on the block, while the
 * children's model time is measured separately and can exceed it.
 *
 * Usage: node bench/decompose.mjs <task> [indexes...]
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const RESULTS = process.env.DSH_RESULTS ?? 'D:/code/vibe/dsh-refine-loop/bench/results'
const SESSIONS = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const LF = String.fromCharCode(10)

/**
 * @param session - the session directory.
 * @returns its events.
 */
function eventsOf(session) {
  const events = []
  let files = []
  try {
    files = readdirSync(join(SESSIONS, session)).filter(name => name.endsWith('.zstd')).sort()
  } catch {
    return events
  }
  for (const file of files) {
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

/**
 * @param events - a session's events.
 * @returns its first and last timestamps, model milliseconds and output tokens.
 */
function spanOf(events) {
  let first = Infinity
  let last = -Infinity
  let modelMs = 0
  let output = 0
  let start = 0
  for (const event of events) {
    const at = event.timestamp ?? event.time ?? 0
    if (at > 0) {
      first = Math.min(first, at)
      last = Math.max(last, at)
    }
    if (event.type === 'step/start') start = at
    if (event.type !== 'assistant/message') continue
    output += event.data?.usage?.outputTokens ?? 0
    if (start > 0) modelMs += at - start
  }
  return { first, last, modelMs, output }
}

/**
 * @param events - a session's events.
 * @returns the plan blocks in time order.
 */
function blocksOf(events) {
  const blocks = []
  const open = new Map()
  for (const event of events) {
    const at = event.timestamp ?? event.time ?? 0
    if (event.type === 'tool/call' && event.data?.name === 'refine_plan') open.set(String(event.data.callId), at)
    if (event.type !== 'tool/result') continue
    const started = open.get(String(event.data?.message?.toolCallId ?? ''))
    if (started === undefined) continue
    blocks.push({ start: started, end: at })
    open.delete(String(event.data?.message?.toolCallId))
  }
  return blocks
}

/**
 * A forked child's log starts with the parent's conversation.
 *
 * @param events - the session's events.
 * @returns the events from the seed boundary on.
 */
function ownPart(events) {
  const boundary = events.findIndex(event => String(event.type).includes('end-seed'))
  return boundary < 0 ? events : events.slice(boundary + 1)
}

/**
 * @param sessionId - the session to read.
 * @param byParent - the session tree.
 * @returns its own span and its children's.
 */
function breakdown(sessionId, byParent) {
  const own = eventsOf(sessionId)
  const span = spanOf(own)
  const blocks = blocksOf(own)
  const children = (byParent.get(sessionId) ?? []).map(childId => {
    const childOwn = ownPart(eventsOf(childId))
    return { id: childId, ...spanOf(childOwn) }
  })
  return { span, blocks, children }
}

const task = process.argv[2] ?? 'lhtb-2048'
const indexes = process.argv.length > 3 ? process.argv.slice(3) : ['1', '2', '3', '4', '5']

// The session tree, from every child header.
const byParent = new Map()
const records = []
for (const arm of ['off', 'on']) {
  for (const index of indexes) {
    let record
    try {
      record = JSON.parse(readFileSync(join(RESULTS, `${task}-${arm}-${index}.json`), 'utf8'))
    } catch {
      continue
    }
    records.push({ arm, index, record })
  }
}

for (const entry of readdirSync(SESSIONS)) {
  const header = eventsOf(entry).find(event => event.type === 'session')
  const owner = header?.parentSession ?? header?.data?.parentSession ?? header?.header?.parentSession
  if (owner === undefined || owner === null) continue
  if (!byParent.has(owner)) byParent.set(owner, [])
  byParent.get(owner).push(entry)
}

console.log(`${task}: 时间构成（秒；父模型 = 父代理自己生成的时间，计划块 = 等计划执行的时间）\n`)
console.log('臂   次  墙钟   父模型  计划块  其它   子代理数  子模型合计  子最慢')
for (const { arm, index, record } of records) {
  const { span, blocks, children } = breakdown(record.sessionId, byParent)
  const parentModel = span.modelMs / 1000
  const blockActual = blocks.reduce((sum, block) => sum + block.end - block.start, 0) / 1000
  const wall = record.wallMs / 1000
  const other = wall - parentModel - blockActual
  const childModel = children.reduce((sum, child) => sum + child.modelMs, 0) / 1000
  const slowest = children.reduce((max, child) => Math.max(max, (child.last - child.first) / 1000), 0)
  console.log(
    arm.padEnd(4),
    String(index).padEnd(3),
    String(Math.round(wall)).padStart(5),
    String(Math.round(parentModel)).padStart(7),
    String(Math.round(blockActual)).padStart(7),
    String(Math.round(other)).padStart(6),
    String(children.length).padStart(8),
    String(Math.round(childModel)).padStart(10),
    String(Math.round(slowest)).padStart(8),
  )
}
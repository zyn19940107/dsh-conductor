/**
 * What a worker does in its own turn, before and after the registration fix.
 *
 * A child session's log starts with the inherited seed — the parent's events as
 * they stood when the plan was handed over — and only the events after the
 * `session/end-seed` boundary belong to the child. Counting `refine_plan` over
 * the whole log counts the parent's plan, which is exactly the mistake that made
 * the fix look ineffective.
 *
 * This prints, per worker: its own steps, its own tool calls, and its own plan
 * calls (which must be zero), split by whether the run predates the fix.
 *
 * Usage: node bench/worker-shape.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const RESULTS = 'D:/code/vibe/dsh-refine-loop/bench/results'
const SESSIONS = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const LF = String.fromCharCode(10)

/**
 * Split one session log into the inherited part and the session's own part.
 *
 * @param events - the session's events.
 * @returns the own events.
 */
function ownEvents(events) {
  let boundary = -1
  for (const [index, event] of events.entries()) {
    if (String(event.type).includes('end-seed')) boundary = index
  }
  return boundary < 0 ? events : events.slice(boundary + 1)
}

/**
 * @param session - a session directory.
 * @returns its events.
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

const children = readdirSync(SESSIONS).filter(entry => entry.startsWith('refine-loop-child-'))
const byParent = new Map()
for (const entry of children) {
  const events = eventsOf(entry)
  const header = events.find(event => event.type === 'session')
  const parent = header?.data?.parentSession ?? header?.parentSession
  if (typeof parent !== 'string') continue
  if (!byParent.has(parent)) byParent.set(parent, [])
  const own = ownEvents(events)
  const ownCalls = own.filter(event => event.type === 'tool/call')
  const ownMessages = own.filter(event => event.type === 'assistant/message')
  const users = own.filter(event => event.type === 'user/message')
    .map(event => (event.data?.message?.content ?? event.data?.content ?? []).map(block => block.text ?? '').join(''))
    .join(' ')
  byParent.get(parent).push({
    id: entry.slice(18, 30),
    worker: users.includes('[refine-loop worker]'),
    steps: ownMessages.length,
    calls: ownCalls.length,
    plans: ownCalls.filter(call => call.data?.name === 'refine_plan').length,
    wall: (() => {
      const first = own[0]?.timestamp ?? 0
      const last = own[own.length - 1]?.timestamp ?? 0
      return last > first ? (last - first) / 1000 : 0
    })(),
    mtime: Math.max(...readdirSync(join(SESSIONS, entry)).filter(name => name.endsWith('.zstd'))
      .map(name => statSync(join(SESSIONS, entry, name)).mtimeMs)),
  })
}

const FIX_TIME = new Date('2026-11-04T21:05:00+08:00').getTime()

/**
 * @param values - the numbers.
 * @returns the median.
 */
function median(values) {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

const groups = new Map()
for (const [task, ids] of [['review (修复前)', [1, 2, 3, 4, 5]], ['review (修复后)', [9, 10]]]) {
  const runs = []
  for (const id of ids) {
    let record
    try {
      record = JSON.parse(readFileSync(join(RESULTS, `review-on-${id}.json`), 'utf8'))
    } catch {
      continue
    }
    const kids = byParent.get(record.sessionId) ?? []
    runs.push({ record, kids })
  }
  groups.set(task, runs)
}

for (const [label, runs] of groups) {
  const workers = runs.flatMap(run => run.kids.filter(kid => kid.worker))
  const forkers = runs.flatMap(run => run.kids.filter(kid => !kid.worker))
  console.log(`=== ${label} | ${runs.length} 次运行，worker ${workers.length} 个，forker/spawner ${forkers.length} 个`)
  console.log('  worker 自己的步数   中位 ' + median(workers.map(kid => kid.steps))
    + '  逐次 ' + workers.map(kid => kid.steps).join('/'))
  console.log('  worker 自己的调用数 中位 ' + median(workers.map(kid => kid.calls))
    + '  逐次 ' + workers.map(kid => kid.calls).join('/'))
  console.log('  worker 自己画图数   总计 ' + workers.reduce((sum, kid) => sum + kid.plans, 0)
    + '  （应为 0）')
  console.log('  worker 自己的时长   中位 ' + median(workers.map(kid => kid.wall)).toFixed(0) + 's')
  if (forkers.length > 0) {
    console.log('  forker 画图数       总计 ' + forkers.reduce((sum, kid) => sum + kid.plans, 0)
      + '（应当 > 0）')
  }
  const walls = runs.map(run => run.record.wallMs / 1000)
  console.log('  整次墙钟             ' + walls.map(wall => wall.toFixed(0)).join('/') + 's'
    + '  中位 ' + median(walls).toFixed(0) + 's')
}

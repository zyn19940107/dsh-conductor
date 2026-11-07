/**
 * Wall time normalised to one token speed, with the plan's parallel nodes taken
 * into account.
 *
 * A plan runs its nodes at the same time, so the plan takes about as long as its
 * slowest node — not the sum. Summing every session's model time is why the plain
 * normalisation broke on fleet runs: three workers thinking for 300s each in 300s
 * of wall time is not 900s.
 *
 * So each node is normalised on its own, and a plan block is the latest of its
 * nodes' normalised ends. Everything outside the plan (the parent's own steps)
 * is the parent's wall minus the plan blocks, plus the parent's output at the
 * fixed speed.
 *
 * Usage: node bench/normalized.mjs [speed] [task ...]
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const RESULTS = 'D:/code/vibe/dsh-refine-loop/bench/results'
const V20 = join(RESULTS, 'v2.0')
const OLD = join(RESULTS, 'before-one-layer')
const SESSIONS = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const LF = String.fromCharCode(10)
const SPEED = Number(process.argv[2] ?? '160')
const ONLY = process.argv.slice(3)

/**
 * One session's events, all segments.
 *
 * @param session - the session directory name.
 * @returns the events.
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
    const usage = event.data?.usage ?? {}
    output += usage.outputTokens ?? 0
    if (start > 0) modelMs += at - start
  }
  return { first, last, modelMs, output }
}

/**
 * Every session, keyed by the session it was started from.
 *
 * @returns a map of parent session id to the child session ids.
 */
function sessionsByParent() {
  const byParent = new Map()
  for (const entry of readdirSync(SESSIONS)) {
    let header
    try {
      header = eventsOf(entry).find(event => event.type === 'session')
    } catch {
      continue
    }
    const owner = header?.parentSession ?? header?.header?.parentSession ?? header?.data?.parentSession
    if (owner === undefined || owner === null) continue
    if (!byParent.has(owner)) byParent.set(owner, [])
    byParent.get(owner).push(entry)
  }
  return byParent
}

/**
 * A session's own events: a forked child's log starts with the parent's
 * conversation, and that prefix is not the child's work.
 *
 * @param events - the session's events.
 * @returns the events from the seed boundary on.
 */
function ownPart(events) {
  const boundary = events.findIndex(event => String(event.type).includes('end-seed'))
  return boundary < 0 ? events : events.slice(boundary + 1)
}

/**
 * Normalise one session, recursively.
 *
 * A session spends its wall time in three places: its own model turns, its plan
 * blocks, and everything else. The model turns are replaced by the tokens they
 * wrote at the fixed speed; a block is replaced by its nodes' own normalised
 * spans, each normalised the same way — which is what makes the wait for a
 * forker's children token time instead of raw wall time.
 *
 * @param sessionId - the session to normalise.
 * @param byParent - the session tree, keyed by parent.
 * @param depth - how deep the recursion is, to stop a cycle.
 * @returns the span, the normalised span and the parts.
 */
function normaliseSession(sessionId, byParent, depth = 0) {
  const all = eventsOf(sessionId)
  const own = depth === 0 ? all : ownPart(all)
  const span = spanOf(own)
  if (span.first === Infinity) return { normalized: 0, blockActual: 0, blockNormal: 0, children: 0, span: 0, modelMs: 0, output: 0 }

  // The plan blocks, in order, with the call and result timestamps.
  const blocks = []
  const open = new Map()
  for (const event of own) {
    const at = event.timestamp ?? event.time ?? 0
    if (event.type === 'tool/call' && event.data?.name === 'refine_plan') open.set(String(event.data.callId), at)
    if (event.type !== 'tool/result') continue
    const started = open.get(String(event.data?.message?.toolCallId ?? ''))
    if (started === undefined) continue
    blocks.push({ start: started, end: at })
    open.delete(String(event.data?.message?.toolCallId))
  }

  const childIds = byParent.get(sessionId) ?? []
  const children = childIds.map(childId => {
    const nested = normaliseSession(childId, byParent, depth + 1)
    const childEvents = ownPart(eventsOf(childId))
    const mine = spanOf(childEvents)
    return { ...nested, first: mine.first, last: mine.last }
  })

  let blockActual = 0
  let blockNormal = 0
  for (const block of blocks) {
    blockActual += block.end - block.start
    // A child whose session log is gone has no first timestamp; it cannot be
    // placed in a block, and letting Infinity through would drown the total.
    const inside = children.filter(child => Number.isFinite(child.first)
      && child.first >= block.start && child.first <= block.end)
    if (inside.length === 0) {
      blockNormal += block.end - block.start
      continue
    }
    let latest = 0
    for (const child of inside) latest = Math.max(latest, (child.first - block.start) + child.normalized)
    blockNormal += latest
  }

  const wallSpan = span.last - span.first
  const outsideActual = wallSpan - span.modelMs - blockActual
  const normalized = outsideActual + span.output / SPEED * 1000 + blockNormal
  return {
    normalized,
    blockActual,
    blockNormal,
    children: children.length,
    span: wallSpan,
    modelMs: span.modelMs,
    output: span.output,
  }
}

/**
 * @param record - the bench record.
 * @returns the normalised wall time, or undefined.
 */
function normalise(record) {
  const parent = readdirSync(SESSIONS).find(entry => entry === record.sessionId
    || entry.startsWith(String(record.sessionId).slice(8, 21)))
  if (parent === undefined) return undefined
  const byParent = sessionsByParent()
  const result = normaliseSession(parent, byParent)
  if (!Number.isFinite(result.normalized)) return undefined
  const wall = record.wallMs
  return {
    wall,
    adjusted: result.normalized,
    parentModel: result.modelMs,
    parentOutput: result.output,
    blockActual: result.blockActual,
    blockNormal: result.blockNormal,
    children: result.children,
    speed: result.output / (result.modelMs / 1000),
  }
}

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

const groups = [
  ['off', RESULTS, 'off'],
  ['v1.0', OLD, 'on'],
  ['v2.0', V20, 'on'],
  ['v2.3', RESULTS, 'on'],
]

const table = new Map()
for (const [label, dir, arm] of groups) {
  for (const name of readdirSync(dir)) {
    const match = /^(.*)-(on|off)-([0-9]+)\.json$/.exec(name)
    if (match === null || match[2] !== arm) continue
    if (ONLY.length > 0 && !ONLY.includes(match[1])) continue
    let record
    try {
      record = JSON.parse(readFileSync(join(dir, name), 'utf8'))
    } catch {
      continue
    }
    const normalised = normalise(record)
    if (normalised === undefined) continue
    if (!table.has(match[1])) table.set(match[1], new Map())
    const versions = table.get(match[1])
    if (!versions.has(label)) versions.set(label, [])
    versions.get(label).push({ ...normalised, agents: record.formation?.agents, steps: record.steps })
  }
}

console.log(`并行感知的归一（${SPEED} tok/s；每个 node 单独归一、并行取 max）\n`)
console.log('  场景             版本    实测   归一   父模型  图块(实测)  图块(归一)  编队')
for (const [scenario, versions] of table) {
  for (const label of ['off', 'v1.0', 'v2.0', 'v2.3']) {
    const runs = versions.get(label)
    if (runs === undefined) continue
    console.log('  ' + scenario.padEnd(16) + label.padEnd(7)
      + String((median(runs.map(run => run.wall)) / 1000).toFixed(0)).padStart(6)
      + String((median(runs.map(run => run.adjusted)) / 1000).toFixed(0)).padStart(7)
      + String((median(runs.map(run => run.parentModel)) / 1000).toFixed(0)).padStart(7)
      + String((median(runs.map(run => run.blockActual)) / 1000).toFixed(0)).padStart(10)
      + String((median(runs.map(run => run.blockNormal)) / 1000).toFixed(0)).padStart(11)
      + String(runs.map(run => run.agents).join('/')).padStart(8))
  }
}

/**
 * Wall time normalised to one token speed, with the plan's parallel nodes and
 * nested delegation taken into account.
 *
 * A plan runs its nodes at the same time, so a plan block lasts about as long as
 * its slowest node, not the sum. Each node is therefore normalised on its own —
 * its model turns replaced by its output at the fixed speed, its own plan blocks
 * replaced the same way, recursively — and the block is the latest of the nodes'
 * normalised ends.
 *
 * The recursion matters for a forker: its wall time includes waiting for the
 * children it dispatched, and that wait is model time, so it is normalised by
 * those children's tokens instead of being kept as raw duration.
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const SESSIONS = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const LF = String.fromCharCode(10)
const SPEED = Number(process.env.SPEED ?? '160')

/**
 * One session's events, all segments.
 *
 * @param session - the session directory name.
 * @returns the events.
 */
export function eventsOf(session) {
  const events = []
  let files = []
  try {
    files = readdirSync(join(SESSIONS, session)).filter(entry => entry.endsWith('.zstd')).sort()
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
 * Every session, keyed by the session it was started from.
 *
 * @returns a map of parent session id to child session ids.
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
 * A forked child's log starts with the parent's conversation; that prefix is not
 * the child's work.
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
 * @param sessionId - the session to normalise.
 * @param byParent - the session tree, keyed by parent.
 * @param depth - how deep the recursion is, to stop a cycle.
 * @returns its normalised span and the parts it is made of.
 */
function normaliseSession(sessionId, byParent, depth = 0) {
  const own = depth === 0 ? eventsOf(sessionId) : ownPart(eventsOf(sessionId))
  const span = spanOf(own)
  if (span.first === Infinity) {
    return { normalized: 0, blockActual: 0, blockNormal: 0, children: 0, modelMs: 0, output: 0 }
  }

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

  const children = (byParent.get(sessionId) ?? []).map(childId => {
    const nested = normaliseSession(childId, byParent, depth + 1)
    const ownEvents = ownPart(eventsOf(childId))
    const mine = spanOf(ownEvents)
    return { ...nested, first: mine.first, last: mine.last }
  })

  let blockActual = 0
  let blockNormal = 0
  for (const block of blocks) {
    blockActual += block.end - block.start
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

  const outsideActual = (span.last - span.first) - span.modelMs - blockActual
  const normalized = outsideActual + span.output / SPEED * 1000 + blockNormal
  return {
    normalized,
    blockActual,
    blockNormal,
    children: children.length,
    modelMs: span.modelMs,
    output: span.output,
  }
}

/**
 * @param record - the bench record.
 * @returns the normalised wall time, or undefined when the session is gone.
 */
export function normalise(record) {
  const parent = readdirSync(SESSIONS).find(entry => entry === record.sessionId
    || entry.startsWith(String(record.sessionId).slice(8, 21)))
  if (parent === undefined) return undefined
  const result = normaliseSession(parent, sessionsByParent())
  if (!Number.isFinite(result.normalized)) return undefined
  return {
    wall: record.wallMs,
    adjusted: result.normalized,
    parentModel: result.modelMs,
    parentOutput: result.output,
    blockActual: result.blockActual,
    blockNormal: result.blockNormal,
    children: result.children,
    speed: result.output / (result.modelMs / 1000),
  }
}

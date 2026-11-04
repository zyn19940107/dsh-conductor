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
    modelMs += at - start
  }
  return { first, last, modelMs, output }
}

/**
 * @param record - the bench record.
 * @returns the normalised wall time, or undefined.
 */
function normalise(record) {
  const parent = readdirSync(SESSIONS).find(entry => entry === record.sessionId
    || entry.startsWith(record.sessionId.slice(8, 21)))
  if (parent === undefined) return undefined
  const parentEvents = eventsOf(parent)
  const parentSpan = spanOf(parentEvents)

  // The plan blocks, in order, with the call and result timestamps.
  const blocks = []
  const open = new Map()
  for (const event of parentEvents) {
    const at = event.timestamp ?? event.time ?? 0
    if (event.type === 'tool/call' && event.data?.name === 'refine_plan') open.set(String(event.data.callId), at)
    if (event.type !== 'tool/result') continue
    const started = open.get(String(event.data?.message?.toolCallId ?? ''))
    if (started === undefined) continue
    blocks.push({ start: started, end: at })
    open.delete(String(event.data?.message?.toolCallId))
  }

  // Children, keyed by their first timestamp so a node can be matched to the
  // block it started in.
  const children = []
  for (const entry of readdirSync(SESSIONS)) {
    if (!entry.startsWith('refine-loop-child-')) continue
    const events = eventsOf(entry)
    const header = events.find(event => event.type === 'session')
    const owner = header?.parentSession ?? header?.header?.parentSession ?? header?.data?.parentSession
    if (owner !== record.sessionId) continue
    children.push(spanOf(events))
  }

  let blockActual = 0
  let blockNormal = 0
  for (const block of blocks) {
    blockActual += block.end - block.start
    // The nodes that started inside this block; the block lasts as long as the
    // last of them, each at the fixed speed.
    const inside = children.filter(child => child.first >= block.start && child.first <= block.end)
    if (inside.length === 0) {
      blockNormal += block.end - block.start
      continue
    }
    let latest = 0
    for (const child of inside) {
      const normalSpan = (child.last - child.first) - child.modelMs + child.output / SPEED * 1000
      latest = Math.max(latest, (child.first - block.start) + normalSpan)
    }
    blockNormal += latest
  }

  const wall = record.wallMs
  const outsideActual = wall - parentSpan.modelMs - blockActual
  const adjusted = outsideActual + parentSpan.output / SPEED * 1000 + blockNormal
  return {
    wall,
    adjusted,
    parentModel: parentSpan.modelMs,
    parentOutput: parentSpan.output,
    blockActual,
    blockNormal,
    children: children.length,
    speed: parentSpan.output / (parentSpan.modelMs / 1000),
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
  ['v2.2', RESULTS, 'on'],
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
  for (const label of ['off', 'v1.0', 'v2.0', 'v2.2']) {
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

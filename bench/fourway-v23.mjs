/**
 * The four-way table for the tasks v2.3 has finished so far.
 *
 * off is the harness with the plugin removed; v1.0 / v2.0 are the archived
 * earlier rounds; v2.3 is the current build. Time is normalised to 160 tok/s
 * with the parallel-aware rule: each node on its own, a plan block as the
 * latest normalised node, everything outside the plan kept as measured.
 *
 * Usage: node bench/fourway-v23.mjs [task ...]
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const RESULTS = 'D:/code/vibe/dsh-refine-loop/bench/results'
const SESSIONS = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const LF = String.fromCharCode(10)
const ONLY = process.argv.slice(2)

const GROUPS = [
  ['off', RESULTS, 'off'],
  ['v1.0', join(RESULTS, 'before-one-layer'), 'on'],
  ['v2.0', join(RESULTS, 'v2.0'), 'on'],
  ['v2.4', RESULTS, 'on'],
]

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

/**
 * @param events - one session's events.
 * @returns first/last timestamps, model time, output tokens and plan blocks.
 */
function spanOf(events) {
  let first = Infinity
  let last = -Infinity
  let modelMs = 0
  let output = 0
  let start = 0
  const blocks = []
  const open = new Map()
  for (const event of events) {
    const at = event.timestamp ?? event.time ?? 0
    if (at > 0) {
      first = Math.min(first, at)
      last = Math.max(last, at)
    }
    if (event.type === 'step/start') start = at
    if (event.type === 'tool/call' && event.data?.name === 'refine_plan') open.set(String(event.data.callId), at)
    if (event.type === 'tool/result') {
      const started = open.get(String(event.data?.message?.toolCallId ?? ''))
      if (started !== undefined) {
        blocks.push({ start: started, end: at })
        open.delete(String(event.data?.message?.toolCallId))
      }
    }
    if (event.type !== 'assistant/message') continue
    const usage = event.data?.usage ?? {}
    output += usage.outputTokens ?? 0
    modelMs += at - start
  }
  return { first, last, modelMs, output, blocks }
}

/**
 * @param record - the bench record.
 * @param dir - where it lives.
 * @returns the normalised wall time and the plan count, or undefined.
 */
function measure(record) {
  const session = readdirSync(SESSIONS).find(entry => entry === record.sessionId
    || entry.startsWith(record.sessionId.slice(8, 21)))
  if (session === undefined) return undefined
  const parent = spanOf(eventsOf(session))
  // Children: every child session, keyed by its parent.
  const children = []
  for (const entry of readdirSync(SESSIONS)) {
    if (!entry.startsWith('refine-loop-child-')) continue
    const events = eventsOf(entry)
    const header = events.find(event => event.type === 'session')
    const owner = header?.data?.parentSession ?? header?.parentSession
    if (owner !== record.sessionId) continue
    children.push(spanOf(events))
  }
  let blockActual = 0
  let blockNormal = 0
  for (const block of parent.blocks) {
    blockActual += block.end - block.start
    const inside = children.filter(child => child.first >= block.start && child.first <= block.end)
    if (inside.length === 0) {
      blockNormal += block.end - block.start
      continue
    }
    let latest = 0
    for (const child of inside) {
      const normal = (child.last - child.first) - child.modelMs + child.output / 160 * 1000
      latest = Math.max(latest, (child.first - block.start) + normal)
    }
    blockNormal += latest
  }
  const outside = record.wallMs - parent.modelMs - blockActual
  return {
    adjusted: outside + parent.output / 160 * 1000 + blockNormal,
    plans: parent.blocks.length,
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

const table = new Map()
for (const [label, dir, arm] of GROUPS) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    continue
  }
  for (const name of names) {
    const match = /^(.*)-(on|off)-([0-9]+)\.json$/.exec(name)
    if (match === null || match[2] !== arm) continue
    if (ONLY.length > 0 && !ONLY.includes(match[1])) continue
    let record
    try {
      record = JSON.parse(readFileSync(join(dir, name), 'utf8'))
    } catch {
      continue
    }
    const measured = measure(record)
    if (measured === undefined) continue
    if (!table.has(match[1])) table.set(match[1], new Map())
    const versions = table.get(match[1])
    if (!versions.has(label)) versions.set(label, [])
    versions.get(label).push({ ...record, ...measured })
  }
}

console.log('场景            版本   n   墙钟   归一    token   步数  编队    正确    报告截断')
for (const [task, versions] of table) {
  let printed = false
  for (const label of ['off', 'v1.0', 'v2.0', 'v2.4']) {
    const runs = versions.get(label)
    if (runs === undefined) continue
    printed = true
    const first = !printed
    console.log((first ? task : '').padEnd(16) + label.padEnd(6)
      + String(runs.length).padStart(3)
      + String((median(runs.map(run => run.wallMs)) / 1000).toFixed(0) + 's').padStart(7)
      + String((median(runs.map(run => run.adjusted)) / 1000).toFixed(0) + 's').padStart(7)
      + String((median(runs.map(run => run.formation?.total ?? 0)) / 1000).toFixed(0) + 'k').padStart(8)
      + String(median(runs.map(run => run.steps))).padStart(6)
      + ' ' + runs.map(run => run.formation?.agents).join('/').padEnd(8)
      + ' ' + runs.map(run => `${run.correctness?.passed}/${run.correctness?.total}`).join(' ').padEnd(20)
      + ' ' + String(runs.filter(run => run.planned === false).length) + ' 未交图')
  }
  if (printed) console.log()
}

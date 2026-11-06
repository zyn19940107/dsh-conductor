/**
 * Per-run timing detail for one task, on both arms of the v2.5 comparison.
 *
 * Usage: node bench/timing-detail.mjs <task> [pre-v2.5-dir]
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const RESULTS = 'D:/code/vibe/dsh-refine-loop/bench/results'
const SESSIONS = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const LF = String.fromCharCode(10)
const task = process.argv[2]
const archive = process.argv[3] ?? 'pre-v2.5'

/**
 * @param session - a session directory name.
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
 * @param record - one run record.
 * @returns the plan rounds and the agent time inside them.
 */
function analyse(record) {
  const parent = readdirSync(SESSIONS).find(entry => entry === record.sessionId
    || entry.startsWith(String(record.sessionId).slice(8, 21)))
  if (parent === undefined) return undefined
  const events = eventsOf(parent)
  const stamp = event => event.timestamp ?? event.time ?? 0
  const plans = []
  const open = new Map()
  for (const event of events) {
    if (event.type === 'tool/call' && event.data?.name === 'refine_plan') open.set(String(event.data.callId), stamp(event))
    if (event.type !== 'tool/result') continue
    const id = String(event.data?.message?.toolCallId ?? '')
    if (!open.has(id)) continue
    plans.push(stamp(event) - open.get(id))
    open.delete(id)
  }
  const first = Math.min(...events.map(stamp).filter(value => value > 0))
  const last = Math.max(...events.map(stamp))
  const model = events.filter(event => event.type === 'assistant/message')
    .map(event => (event.data?.usage?.outputTokens ?? 0) / 160 * 1000)
    .reduce((sum, value) => sum + value, 0)
  return {
    rounds: plans.length,
    planMs: plans.reduce((sum, value) => sum + value, 0),
    spanMs: last - first,
    modelMs: model,
    steps: record.steps,
  }
}

for (const [label, dir] of [['pre2.5', join(RESULTS, archive)], ['v2.5', RESULTS]]) {
  const names = readdirSync(dir).filter(name => name.startsWith(`${task}-on-`) && name.endsWith('.json')).sort()
  for (const name of names) {
    const record = JSON.parse(readFileSync(join(dir, name), 'utf8'))
    const detail = analyse(record)
    if (detail === undefined) continue
    const shape = record.formation ?? {}
    console.log([
      label.padEnd(7),
      name.replace(`${task}-on-`, 'on-').replace('.json', '').padEnd(6),
      `wall ${(record.wallMs / 1000).toFixed(0)}s`,
      `rounds ${detail.rounds}`,
      `plan ∑ ${(detail.planMs / 1000).toFixed(0)}s`,
      `parent steps ${detail.steps}`,
      `agents ${shape.agents}`,
      `tokens ${Math.round((shape.total ?? 0) / 1000)}k`,
      `out ${Math.round((shape.output ?? 0) / 1000)}k`,
      `cacheRead ${Math.round((shape.cacheRead ?? 0) / 1000)}k`,
      `ctx ${Math.round((record.mainPrompt ?? 0) / 1000)}k`,
      `${record.correctness.passed}/${record.correctness.total}`,
    ].join('  '))
  }
}

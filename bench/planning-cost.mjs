/**
 * How much of a run goes into designing the plan.
 *
 * The plan is the model's own output: everything before the first `refine_plan`
 * call is the model working out what to put in it, and the call's arguments are
 * the graph itself. This prints that share for the runs that planned.
 *
 * Usage: node bench/planning-cost.mjs [task ...]
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const RESULTS = 'D:/code/vibe/dsh-refine-loop/bench/results'
const V20 = join(RESULTS, 'v2.0')
const SESSIONS = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const LF = String.fromCharCode(10)
const ONLY = process.argv.slice(2)

/**
 * @param dir - where the record lives.
 * @param name - the record name.
 * @returns the planning split, or undefined.
 */
function planningOf(dir, name) {
  let record
  try {
    record = JSON.parse(readFileSync(join(dir, name), 'utf8'))
  } catch {
    return undefined
  }
  const session = readdirSync(SESSIONS).find(entry => entry === record.sessionId
    || entry.startsWith(record.sessionId.slice(8, 21)))
  if (session === undefined) return undefined
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

  let modelMs = 0
  let output = 0
  let reasoning = 0
  let start = 0
  let beforeMs = 0
  let beforeOutput = 0
  let beforeReasoning = 0
  let firstPlanAt
  let planArgs = 0
  let plans = 0
  for (const event of events) {
    const at = event.timestamp ?? event.time ?? 0
    if (event.type === 'step/start') start = at
    if (event.type === 'tool/call' && event.data?.name === 'refine_plan') {
      plans += 1
      if (firstPlanAt === undefined) firstPlanAt = at
      planArgs += 0
    }
    if (event.type === 'assistant/message') {
      const usage = event.data?.usage ?? {}
      const spent = at - start
      let reasoningChars = 0
      for (const block of event.data?.message?.content ?? []) {
        if (block.type === 'reasoning') reasoningChars += (block.text ?? '').length
      }
      modelMs += spent
      output += usage.outputTokens ?? 0
      reasoning += reasoningChars
      if (firstPlanAt === undefined) {
        beforeMs += spent
        beforeOutput += usage.outputTokens ?? 0
        beforeReasoning += reasoningChars
      }
    }
    if (event.type === 'tool/call' && event.data?.name === 'refine_plan' && firstPlanAt === at) {
      planArgs = String(event.data?.arguments ?? '').length
    }
  }
  if (plans === 0) return { planned: false }
  return {
    planned: true,
    plans,
    planArgs,
    beforeMs,
    beforeOutput,
    beforeReasoning,
    modelMs,
    output,
    reasoning,
    wall: record.wallMs,
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

const tasks = new Map()
for (const [label, dir] of [['v2.0', V20], ['v2.1', RESULTS]]) {
  for (const name of readdirSync(dir)) {
    const match = /^(.*)-on-[0-9]+\.json$/.exec(name)
    if (match === null) continue
    if (ONLY.length > 0 && !ONLY.includes(match[1])) continue
    const planning = planningOf(dir, name)
    if (planning === undefined || !planning.planned) continue
    if (!tasks.has(match[1])) tasks.set(match[1], new Map())
    const versions = tasks.get(match[1])
    if (!versions.has(label)) versions.set(label, [])
    versions.get(label).push(planning)
  }
}

console.log('建图成本（只统计真的交了图的运行）\n')
console.log('  场景            版本   n   到第一张图   占模型时间   其中思考   图 JSON   图数')
for (const [task, versions] of tasks) {
  for (const label of ['v2.0', 'v2.1']) {
    const runs = versions.get(label)
    if (runs === undefined) continue
    const before = median(runs.map(run => run.beforeMs)) / 1000
    const model = median(runs.map(run => run.modelMs)) / 1000
    const reasoning = median(runs.map(run => run.beforeReasoning))
    const args = median(runs.map(run => run.planArgs))
    const plans = median(runs.map(run => run.plans))
    console.log('  ' + task.padEnd(16) + label.padEnd(6) + String(runs.length).padEnd(3)
      + String(before.toFixed(0) + 's').padStart(10)
      + String((before / model * 100).toFixed(0) + '%').padStart(11)
      + String((reasoning / 1000).toFixed(0) + 'k字符').padStart(11)
      + String((args / 1000).toFixed(1) + 'k字符').padStart(10)
      + String(plans).padStart(6))
  }
}

/**
 * Where a normalised wall time goes, run by run.
 *
 * Normalised = tool time + output tokens / SPEED. So a run is slow after
 * normalisation for one of two reasons: it spent more time in tools, or it wrote
 * more output. This prints both, plus how much of the output was reasoning, so
 * the two can be told apart.
 *
 * Usage: node bench/why-slow.mjs [scenario ...]
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const RESULTS = 'D:/code/vibe/dsh-refine-loop/bench/results'
const V20 = join(RESULTS, 'v2.0')
const OLD = join(RESULTS, 'before-one-layer')
const SESSIONS = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const LF = String.fromCharCode(10)
const SPEED = 160
const ONLY = process.argv.slice(2)

/**
 * @param dir - where the record lives.
 * @param name - the record name.
 * @returns the split, or undefined.
 */
function splitOf(dir, name) {
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
  let reasoningChars = 0
  let planCalls = 0
  let start = 0
  for (const event of events) {
    if (event.type === 'step/start') start = event.timestamp ?? event.time ?? 0
    if (event.type === 'tool/call' && event.data?.name === 'refine_plan') planCalls += 1
    if (event.type !== 'assistant/message') continue
    const usage = event.data?.usage ?? {}
    output += usage.outputTokens ?? 0
    modelMs += (event.timestamp ?? event.time ?? 0) - start
    for (const block of event.data?.message?.content ?? []) {
      if (block.type === 'reasoning') reasoningChars += (block.text ?? '').length
    }
  }
  const wall = record.wallMs
  return {
    wall,
    model: modelMs,
    tool: wall - modelMs,
    output,
    reasoningChars,
    planCalls,
    steps: events.filter(event => event.type === 'assistant/message').length,
    agents: record.formation?.agents,
    normalised: (wall - modelMs) + output / SPEED * 1000,
  }
}

const groups = [
  ['off', RESULTS, 'off'],
  ['v1.0', OLD, 'on'],
  ['v2.0', V20, 'on'],
  ['v2.1', RESULTS, 'on'],
]

const scenarios = new Map()
for (const [label, dir, arm] of groups) {
  for (const name of readdirSync(dir)) {
    const match = /^(.*)-(on|off)-([0-9]+)\.json$/.exec(name)
    if (match === null || match[2] !== arm) continue
    if (ONLY.length > 0 && !ONLY.includes(match[1])) continue
    const split = splitOf(dir, name)
    if (split === undefined) continue
    if (!scenarios.has(match[1])) scenarios.set(match[1], [])
    scenarios.get(match[1]).push({ label, index: match[3], ...split })
  }
}

for (const [scenario, runs] of scenarios) {
  console.log(`\n===== ${scenario} =====`)
  console.log('  版本  样本  归一  实测  模型  工具  输出   其中思考  图数  步数  编队')
  for (const run of runs.sort((a, b) => a.label.localeCompare(b.label) || Number(a.index) - Number(b.index))) {
    console.log('  ' + run.label.padEnd(5) + String(run.index).padEnd(4)
      + String((run.normalised / 1000).toFixed(0) + 's').padStart(6)
      + String((run.wall / 1000).toFixed(0) + 's').padStart(6)
      + String((run.model / 1000).toFixed(0) + 's').padStart(6)
      + String((run.tool / 1000).toFixed(0) + 's').padStart(6)
      + String((run.output / 1000).toFixed(1) + 'k').padStart(7)
      + String((run.reasoningChars / 1000).toFixed(0) + 'k字符').padStart(10)
      + String(run.planCalls).padStart(4)
      + String(run.steps).padStart(5)
      + String(run.agents).padStart(5))
  }
}

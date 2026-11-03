/**
 * Where did the wall clock go?
 *
 * Reads one bench record's session log and attributes the run's span to:
 *   - the model: the part of each step that is not a tool call
 *   - tools: each tool call's own span, with `refine_plan` split out because the
 *     nodes of a plan run inside it (and children run inside those nodes)
 *   - the tail: time after the last recorded event the model is still thinking
 *
 * Usage: node bench/where-time.mjs <scenario> <off|on> [runIndex]
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const ROOT = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const RESULTS = 'D:/code/vibe/dsh-refine-loop/bench/results'
const LF = String.fromCharCode(10)

const scenario = process.argv[2] ?? 'coverage'
const arm = process.argv[3] ?? 'on'
const index = process.argv[4] ?? '1'

const record = JSON.parse(
  (await import('node:fs')).readFileSync(join(RESULTS, `${scenario}-${arm}-${index}.json`), 'utf8'),
)

/**
 * Every event of one session, oldest segment first.
 *
 * @param sessionId - the session's id.
 * @returns the events, or undefined when the log is missing.
 */
function eventsOf(sessionId) {
  const dir = readdirSync(ROOT).find(name => name === sessionId
    || name.startsWith(sessionId.slice(8, 8 + 13)))
  if (dir === undefined) return undefined
  const files = readdirSync(join(ROOT, dir)).filter(name => name.endsWith('.zstd')).sort()
  const events = []
  for (const name of files) {
    try {
      events.push(...decodeLog(join(ROOT, dir, name)).split(LF).filter(Boolean).map(line => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      }).filter(Boolean))
    } catch {
      // a torn segment is skipped
    }
  }
  return events
}

const events = eventsOf(record.sessionId)
if (events === undefined) {
  console.error('no session log for ' + record.sessionId)
  process.exit(2)
}

const start = events[0].time ?? events[0].createdAt
const end = events[events.length - 1].time ?? start
const spanMs = end - start

// Steps: the model call plus the tool calls it asked for.
let stepCount = 0
let stepMs = 0
const toolMs = new Map()
let planMs = 0
let planCount = 0
let modelMs = 0

const openCalls = new Map()
let openStep = undefined

for (const event of events) {
  switch (event.type) {
    case 'step/start':
      stepCount += 1
      openStep = event.time
      break
    case 'step/end':
      if (openStep !== undefined) {
        stepMs += event.time - openStep
        openStep = undefined
      }
      break
    case 'tool/call':
      openCalls.set(event.data.callId, { at: event.time, name: event.data.name })
      break
    case 'tool/result': {
      const callId = event.data?.message?.toolCallId
      const call = openCalls.get(callId)
      if (call === undefined) break
      openCalls.delete(callId)
      const took = event.time - call.at
      toolMs.set(call.name, (toolMs.get(call.name) ?? 0) + took)
      if (call.name === 'refine_plan') {
        planMs += took
        planCount += 1
      }
      break
    }
    default:
      break
  }
}

// The model's share is the steps that are not tool execution. A plan's span is
// the nodes' (and their children's) wall clock, already inside the tools.
let toolTotalMs = 0
for (const took of toolMs.values()) toolTotalMs += took
modelMs = stepMs - toolTotalMs

const seconds = (ms) => (ms / 1000).toFixed(1)
console.log(`${scenario} ${arm} — record ${seconds(record.wallMs)}s, log span ${seconds(spanMs)}s`)
console.log(`  steps                     ${String(stepCount).padStart(4)}  ${seconds(stepMs).padStart(8)}s`)
console.log(`  model generation (rest)              ${seconds(modelMs).padStart(8)}s`)
console.log(`  tool execution            ${seconds(toolTotalMs).padStart(8)}s`)
for (const [name, took] of [...toolMs].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
  console.log(`    ${name.padEnd(22)} ${seconds(took).padStart(8)}s`)
}
console.log(`  of which refine_plan      ${String(planCount).padStart(4)}  ${seconds(planMs).padStart(8)}s`)

// Output tokens per second of model time, which tells whether the model or the
// tooling is the bottleneck.
const outputTokens = record.formation?.output ?? 0
const inputTokens = (record.formation?.input ?? 0) + (record.formation?.cacheRead ?? 0)
console.log(`  output tokens             ${String(outputTokens).padStart(9)}  ${(outputTokens / Math.max(1, modelMs / 1000)).toFixed(0)} tok/s of model time`)
console.log(`  input + cacheRead tokens  ${String(inputTokens).padStart(9)}  ${(inputTokens / Math.max(1, spanMs / 1000)).toFixed(0)} tok/s of wall time`)

/**
 * Where the wall clock of one bench sample went: the main agent's own model
 * time, the time it spent waiting for its children, the tool time, and each
 * child's own clock beside the others.
 *
 * Usage: node bench/time-breakdown.mjs <scenario> <off|on> [samples]
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const SESSIONS = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const RESULTS = 'D:/code/vibe/dsh-refine-loop/bench/results'
const LF = String.fromCharCode(10)
const scenario = process.argv[2] ?? 'review'
const arm = process.argv[3] ?? 'on'
const samples = Number(process.argv[4] ?? '5')

/**
 * @param sessionId - the session id.
 * @returns every event of the session, all segments.
 */
function eventsOf(sessionId) {
  const dir = readdirSync(SESSIONS).find(name => name === sessionId
    || name.startsWith(sessionId.slice(8, 21)))
  if (dir === undefined) return { dir: undefined, events: [] }
  const files = readdirSync(join(SESSIONS, dir)).filter(name => name.endsWith('.zstd')).sort()
  const events = []
  for (const name of files) {
    try {
      events.push(...decodeLog(join(SESSIONS, dir, name)).split(LF).filter(Boolean).map(line => {
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
  return { dir, events }
}

/**
 * Per-step model and tool time, plus the calls each step made.
 *
 * @param events - the session's events.
 * @returns the steps.
 */
function stepsOf(events) {
  const steps = []
  const open = new Map()
  let stepStart
  for (const event of events) {
    if (event.type === 'step/start') {
      stepStart = event.time
      steps.push({ start: event.time, end: undefined, tool: 0, calls: [] })
      continue
    }
    const step = steps[steps.length - 1]
    if (event.type === 'step/end' && stepStart !== undefined) {
      if (step !== undefined) step.end = event.time
      stepStart = undefined
      continue
    }
    if (step === undefined) continue
    if (event.type === 'tool/call') {
      step.calls.push(event.data?.name)
      open.set(String(event.data?.callId), { at: event.time, step })
      continue
    }
    if (event.type === 'tool/result') {
      const id = String(event.data?.message?.toolCallId ?? '')
      const pending = open.get(id)
      if (pending !== undefined) {
        pending.step.tool += event.time - pending.at
        open.delete(id)
      }
    }
  }
  return steps
}

for (let index = 1; index <= samples; index += 1) {
  let record
  try {
    record = JSON.parse(readFileSync(join(RESULTS, `${scenario}-${arm}-${index}.json`), 'utf8'))
  } catch {
    continue
  }
  const { dir: mainDir, events: main } = eventsOf(record.sessionId)
  const mainSteps = stepsOf(main)
  const mainTotal = mainSteps.reduce((a, s) => a + ((s.end ?? s.start) - s.start), 0)
  const mainTool = mainSteps.reduce((a, s) => a + s.tool, 0)

  // Children of this run.
  const kids = []
  for (const dir of readdirSync(SESSIONS)) {
    if (dir === mainDir) continue
    const files = readdirSync(join(SESSIONS, dir)).filter(name => name.endsWith('.zstd'))
    if (files.length === 0) continue
    const { events } = eventsOf(dir)
    const header = events.find(event => event.type === 'session')
    if (header?.parentSession !== record.sessionId) continue
    let cut = -1
    events.forEach((event, i) => { if (event.type === 'session/end-seed') cut = i })
    const own = events.slice(cut + 1)
    const steps = stepsOf(own)
    const wall = steps.reduce((a, s) => a + ((s.end ?? s.start) - s.start), 0)
    kids.push({ steps: steps.length, wall })
  }
  kids.sort((a, b) => b.wall - a.wall)

  console.log(`#${index}  wall ${(record.wallMs / 1000).toFixed(1)}s`
    + `  |  主 agent 模型 ${((mainTotal - mainTool) / 1000).toFixed(1)}s`
    + `  工具 ${(mainTool / 1000).toFixed(1)}s`
    + `  (其中 refine_plan ${(mainSteps.filter(s => s.calls.includes('refine_plan'))
      .reduce((a, s) => a + s.tool, 0) / 1000).toFixed(1)}s)`
    + `  |  ${kids.length} 个子代理: `
    + kids.map(k => `${k.steps}步/${(k.wall / 1000).toFixed(0)}s`).join('  '))
}

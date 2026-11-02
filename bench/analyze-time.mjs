/**
 * Decompose each run's wall time into what it was actually spent on.
 *
 * Wall clock alone cannot say why a run is slow: a step is a model round trip, a
 * tool call is execution, a child session has its own startup, and a plan call
 * hides all of its layers inside one tool/result pair. This script reads the
 * session logs and separates them:
 *
 * - model:  step/start → first tool/call (or step/end when the step only writes)
 * - tools:  first tool/call → last tool/result
 * - plan:   a refine_plan call, which contains the whole plan's execution
 * - spawn:  the gap between the plan's call and the child's first event
 *
 * Usage: node bench/analyze-time.mjs [result.json ...]
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const HOME = 'D:/code/vibe/dsh-sandbox/home'
const ROOT = join(HOME, 'sessions', '--D-code-vibe--')

/**
 * Read one session log.
 *
 * @param id - the session id.
 * @returns its events, or undefined when the log is not there.
 */
function sessionEvents(id) {
  if (!existsSync(ROOT)) return undefined
  for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    for (const file of readdirSync(join(ROOT, entry.name))) {
      if (!file.endsWith('.zstd')) continue
      const text = decodeLog(join(ROOT, entry.name, file))
      if (text === '') continue
      let header
      try {
        header = JSON.parse(text.split('\n')[0])
      } catch {
        continue
      }
      if (header.id !== id) continue
      return text.split('\n')
        .map(line => {
          try { return JSON.parse(line) } catch { return null }
        })
        .filter(Boolean)
    }
  }
  return undefined
}

/**
 * Every session whose parent is the given one.
 *
 * @param parent - the parent session id.
 * @returns the child session ids.
 */
function childrenOf(parent) {
  const found = []
  if (!existsSync(ROOT)) return found
  for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    for (const file of readdirSync(join(ROOT, entry.name))) {
      if (!file.endsWith('.zstd')) continue
      const text = decodeLog(join(ROOT, entry.name, file))
      if (text === '') continue
      let header
      try {
        header = JSON.parse(text.split('\n')[0])
      } catch {
        continue
      }
      if (header.parentSession === parent) found.push(header.id)
    }
  }
  return found
}

/**
 * Per-step timing of one session.
 *
 * @param events - the session's events.
 * @returns the steps, in order.
 */
function stepsOf(events) {
  const steps = []
  let current
  for (const event of events) {
    const time = Number(event.time ?? 0)
    if (event.type === 'step/start') {
      current = { startedAt: time, firstCall: 0, lastResult: 0, endedAt: 0, calls: [] }
      continue
    }
    if (current === undefined) continue
    if (event.type === 'tool/call') {
      if (current.firstCall === 0) current.firstCall = time
      current.calls.push(String(event.data?.name ?? ''))
      continue
    }
    if (event.type === 'tool/result') {
      current.lastResult = time
      continue
    }
    if (event.type === 'step/end') {
      current.endedAt = time
      steps.push(current)
      current = undefined
    }
  }
  return steps
}

/**
 * Split one step's duration into the model part and the tool part.
 *
 * @param step - the step timing.
 * @returns the two durations in milliseconds.
 */
function split(step) {
  if (step.firstCall === 0) return { model: step.endedAt - step.startedAt, tool: 0 }
  const model = step.firstCall - step.startedAt
  const tool = (step.lastResult === 0 ? step.endedAt : step.lastResult) - step.firstCall
  const tail = step.endedAt - (step.lastResult === 0 ? step.endedAt : step.lastResult)
  return { model, tool: tool + tail }
}

/**
 * One session, summarised.
 *
 * @param events - the session's events.
 * @param label - what to call it.
 * @returns the summary.
 */
function summarise(events, label) {
  const times = events.map(event => Number(event.time ?? 0)).filter(Boolean)
  const steps = stepsOf(events)
  let model = 0
  let tool = 0
  const detail = []
  for (const step of steps) {
    const parts = split(step)
    model += parts.model
    tool += parts.tool
    detail.push({ calls: step.calls, ...parts })
  }
  return {
    label,
    first: Math.min(...times),
    last: Math.max(...times),
    span: Math.max(...times) - Math.min(...times),
    model,
    tool,
    steps: detail,
  }
}

/**
 * Format milliseconds as seconds.
 *
 * @param ms - milliseconds.
 * @returns the display string.
 */
function seconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`
}

const files = process.argv.slice(2)
for (const file of files) {
  const isSession = file.startsWith('session-')
  const record = isSession ? { sessionId: file, wallMs: 0 } : JSON.parse(readFileSync(file, 'utf8'))
  const name = isSession ? file.slice(0, 12) : (file.split(/[\\/]/).pop()?.replace('.json', '') ?? file)
  const main = sessionEvents(record.sessionId)
  if (main === undefined) {
    console.log(`${name}: 日志不在沙盒里(可能已清空)` )
    continue
  }
  const kids = childrenOf(record.sessionId)
  console.log(`\n══════ ${name}  墙钟 ${seconds(record.wallMs)}  编队 ${kids.length + 1} ══════`)

  const mainSummary = summarise(main, 'main')
  console.log(`主  span ${seconds(mainSummary.span)} · 模型 ${seconds(mainSummary.model)} · 工具 ${seconds(mainSummary.tool)}`)
  for (const [index, step] of mainSummary.steps.entries()) {
    const calls = step.calls.join('+')
    const isPlan = step.calls.includes('refine_plan')
    console.log(`   步${index + 1} 模型 ${seconds(step.model)}${isPlan ? '(含写图)' : ''} `
      + `· 执行 ${seconds(step.tool)}${isPlan ? '(含整张图)' : ''} ${calls === '' ? '→ 写结论' : '→ ' + calls}`)
  }

  for (const kid of kids) {
    const events = sessionEvents(kid)
    if (events === undefined) continue
    const summary = summarise(events, kid.slice(0, 8))
    const spawn = summary.first - mainSummary.first
    console.log(`孩子 ${kid.slice(0, 8)} 启动于 +${seconds(spawn)} · span ${seconds(summary.span)} `
      + `· 模型 ${seconds(summary.model)} · 工具 ${seconds(summary.tool)} · 步 ${summary.steps.length}`)
    for (const [index, step] of summary.steps.entries()) {
      console.log(`   步${index + 1} 模型 ${seconds(step.model)} · 执行 ${seconds(step.tool)} → ${step.calls.join('+') || '写结论'}`)
    }
  }
}
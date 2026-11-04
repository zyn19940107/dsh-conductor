/**
 * Two thinking costs side by side.
 *
 * 1. Deciding the next step: with no plan in play, every model step is "what do
 *    I call next". Measured on the off-arm runs, as the per-step model time and
 *    the reasoning text behind it.
 * 2. Designing the plan on step one: the runs whose very first model message is
 *    the `refine_plan` call. That step is "read the task, decide the shape, write
 *    the graph" with no tool round in between.
 *
 * Usage: node bench/think-cost.mjs
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const RESULTS = 'D:/code/vibe/dsh-refine-loop/bench/results'
const V20 = join(RESULTS, 'v2.0')
const OLD = join(RESULTS, 'before-one-layer')
const SESSIONS = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const LF = String.fromCharCode(10)

/**
 * Every step of one run: its duration, output tokens, reasoning chars, and
 * whether the message carried a refine_plan call.
 *
 * @param record - the bench record.
 * @returns the steps, or undefined.
 */
function stepsOf(record) {
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
  const steps = []
  let start = 0
  for (const event of events) {
    const at = event.timestamp ?? event.time ?? 0
    if (event.type === 'step/start') start = at
    if (event.type !== 'assistant/message') continue
    const usage = event.data?.usage ?? {}
    const content = event.data?.message?.content ?? []
    let reasoning = 0
    const tools = []
    for (const block of content) {
      if (block.type === 'reasoning') reasoning += (block.text ?? '').length
      if (block.type === 'tool-call') tools.push(block.name)
    }
    steps.push({ ms: at - start, output: usage.outputTokens ?? 0, reasoning, tools })
  }
  return steps
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

const nextStep = []
const planFirst = []

for (const [label, dir] of [['off', RESULTS], ['v2.0', V20], ['v1.0', OLD], ['v2.1', RESULTS]]) {
  for (const name of readdirSync(dir)) {
    const match = /^(.+)-(on|off)-[0-9]+\.json$/.exec(name)
    if (match === null) continue
    if (label === 'off' && match[2] !== 'off') continue
    if (label !== 'off' && match[2] !== 'on') continue
    if (label === 'v2.1' && !name.startsWith('coverage') && !name.startsWith('review')
      && !name.startsWith('lhtb-matpower') && !name.startsWith('lhtb-commit0')) continue
    let record
    try {
      record = JSON.parse(readFileSync(join(dir, name), 'utf8'))
    } catch {
      continue
    }
    const steps = stepsOf(record)
    if (steps === undefined || steps.length === 0) continue
    if (label === 'off') {
      // Every step of a plain agent is "what do I call next".
      for (const step of steps) nextStep.push(step)
      continue
    }
    const first = steps[0]
    if (first.tools.includes('refine_plan')) planFirst.push(first)
  }
}

const report = (label, steps) => {
  console.log(`${label}  n=${steps.length}`)
  console.log(`  每步模型耗时  中位数 ${(median(steps.map(s => s.ms)) / 1000).toFixed(0)}s`
    + `  均值 ${(steps.reduce((sum, s) => sum + s.ms, 0) / steps.length / 1000).toFixed(0)}s`
    + `  最大 ${(Math.max(...steps.map(s => s.ms)) / 1000).toFixed(0)}s`)
  console.log(`  每步思考字符  中位数 ${(median(steps.map(s => s.reasoning)) / 1000).toFixed(1)}k`
    + `  均值 ${(steps.reduce((sum, s) => sum + s.reasoning, 0) / steps.length / 1000).toFixed(1)}k`)
  console.log(`  每步输出 token 中位数 ${median(steps.map(s => s.output))}`)
}

console.log('两种思考成本\n')
report('1. 只想下一步（off 臂的每一个模型步）', nextStep)
console.log()
report('2. 第一步就建图（首条消息就是 refine_plan 的运行）', planFirst)

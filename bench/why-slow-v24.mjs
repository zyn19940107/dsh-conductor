/**
 * Why v2.4 is slower on a task than v2.0: where the time and the tokens go.
 *
 * For each run it prints the wall time split (model vs plan blocks), the token
 * split the harness recorded, the plan shapes, and one line per child agent with
 * its own tokens and duration. The point is to attribute the difference to a
 * mechanism, not to guess.
 *
 * Usage: node bench/why-slow-v24.mjs <task> [runs]
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const RESULTS = 'D:/code/vibe/dsh-refine-loop/bench/results'
const V20 = join(RESULTS, 'v2.0')
const SESSIONS = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const LF = String.fromCharCode(10)
const TASK = process.argv[2] ?? 'coverage'
const RUNS = Number(process.argv[3] ?? '3')

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
 * @returns model time, output tokens, reasoning chars, plan blocks, node kinds.
 */
function summarise(events) {
  let modelMs = 0
  let output = 0
  let reasoning = 0
  let start = 0
  const blocks = []
  const open = new Map()
  const kinds = []
  for (const event of events) {
    const at = event.timestamp ?? event.time ?? 0
    if (event.type === 'step/start') start = at
    if (event.type === 'tool/call' && event.data?.name === 'refine_plan') {
      try {
        const plan = JSON.parse(String(event.data.arguments))
        kinds.push((plan.nodes ?? []).map(node => `${node.id}:${node.kind}${node.budgetMs > 0 ? `@${Math.round(node.budgetMs / 1000)}s` : ''}`))
      } catch {
        kinds.push([])
      }
      open.set(String(event.data.callId), at)
    }
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
    for (const block of event.data?.message?.content ?? []) {
      if (block.type === 'reasoning') reasoning += (block.text ?? '').length
    }
  }
  return { modelMs, output, reasoning, blocks, kinds }
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

for (const [label, dir] of [['v2.0', V20], ['v2.4', RESULTS]]) {
  const runs = []
  for (let index = 1; index <= RUNS; index += 1) {
    let record
    try {
      record = JSON.parse(readFileSync(join(dir, `${TASK}-on-${index}.json`), 'utf8'))
    } catch {
      continue
    }
    const session = readdirSync(SESSIONS).find(entry => entry === record.sessionId
      || entry.startsWith(record.sessionId.slice(8, 21)))
    const children = []
    for (const entry of readdirSync(SESSIONS)) {
      if (!entry.startsWith('refine-loop-child-')) continue
      const events = eventsOf(entry)
      const header = events.find(event => event.type === 'session')
      const owner = header?.data?.parentSession ?? header?.parentSession
      if (owner !== record.sessionId) continue
      const own = (() => {
        const boundary = events.findIndex(event => String(event.type).includes('end-seed'))
        return boundary < 0 ? events : events.slice(boundary + 1)
      })()
      children.push({ id: entry.slice(18, 30), ...summarise(own) })
    }
    const parent = session === undefined ? undefined : summarise(eventsOf(session))
    runs.push({ record, parent, children })
  }

  console.log(`=== ${TASK} ${label} ===`)
  for (const run of runs) {
    const { record, parent, children } = run
    const formation = record.formation ?? {}
    const blockMs = (parent?.blocks ?? []).reduce((sum, block) => sum + (block.end - block.start), 0)
    console.log(`  墙钟 ${(record.wallMs / 1000).toFixed(0)}s | 步数 ${record.steps} | 编队 ${formation.agents}`
      + ` | token ${Math.round((formation.total ?? 0) / 1000)}k`
      + ` (in ${Math.round((formation.input ?? 0) / 1000)}k / cache ${Math.round((formation.cacheRead ?? 0) / 1000)}k / out ${Math.round((formation.output ?? 0) / 1000)}k)`
      + ` | context ${Math.round((record.mainPrompt ?? 0) / 1000)}k`
      + ` | 父模型 ${((parent?.modelMs ?? 0) / 1000).toFixed(0)}s / 图块 ${(blockMs / 1000).toFixed(0)}s`
      + ` | 父思考 ${(parent?.reasoning ?? 0)}字`)
    // 每一轮图各自花了多久：慢在"哪一轮"比分总时间有用。
    const blockS = (parent?.blocks ?? []).map(block => ((block.end - block.start) / 1000).toFixed(0) + 's')
    console.log(`    图: ${(parent?.kinds ?? []).map((kinds, index) => `[${index + 1}] ${blockS[index] ?? '?'} ${kinds.join(',')}`).join('  ')}`)
    // 每个子代理自己的模型时间 + 工具时间（它的")图块"就是它的整段工作）
    for (const child of children) {
      const toolMs = child.blocks.reduce((sum, block) => sum + (block.end - block.start), 0)
      console.log(`    子 ${child.id} | 模型 ${(child.modelMs / 1000).toFixed(0)}s + 工具 ${(toolMs / 1000).toFixed(0)}s = ${((child.modelMs + toolMs) / 1000).toFixed(0)}s`)
    }
    for (const child of children) {
      console.log(`    子 ${child.id} 步${child.output > 0 ? '' : ''} | 模型 ${(child.modelMs / 1000).toFixed(0)}s`
        + ` | 出 ${child.output}tok | 思考 ${child.reasoning}字 | 图块 ${child.blocks.length}`)
    }
  }
  const tokens = runs.map(run => (run.record.formation?.total ?? 0) / 1000)
  const walls = runs.map(run => run.record.wallMs / 1000)
  console.log(`  中位: 墙钟 ${median(walls).toFixed(0)}s / token ${median(tokens).toFixed(0)}k\n`)
}

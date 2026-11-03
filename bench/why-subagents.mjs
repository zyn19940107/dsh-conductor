/**
 * Why did the model open children?
 *
 * Finds every session that ran the `review` scenario and classifies it by the
 * plugin shape it ran under (three node kinds = the DAG shape, four = the
 * one-layer shape) and by the node kinds it chose. Then prints the model's own
 * reasoning around the plan call, which is the only direct evidence of why.
 *
 * Usage: node bench/why-subagents.mjs [--kinds] [--reasoning <n>]
 */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const ROOT = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const LF = String.fromCharCode(10)
const NEEDLE = '分别独立审查'
const kindsOnly = process.argv.includes('--kinds')
const reasoningArg = process.argv.indexOf('--reasoning')
const reasoningLimit = reasoningArg === -1 ? 2 : Number(process.argv[reasoningArg + 1] ?? 2)

const sessions = []
for (const dir of readdirSync(ROOT, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue
  for (const name of readdirSync(join(ROOT, dir.name))) {
    if (!name.endsWith('.zstd')) continue
    const path = join(ROOT, dir.name, name)
    sessions.push({ id: dir.name, path, mtime: statSync(path).mtimeMs })
  }
}
sessions.sort((a, b) => b.mtime - a.mtime)

let printed = 0
for (const session of sessions) {
  let text
  try {
    text = decodeLog(session.path)
  } catch {
    continue
  }
  if (!text.includes(NEEDLE)) continue

  const events = text.split(LF).filter(Boolean).map(line => {
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  }).filter(Boolean)

  // Which plugin shape the session ran under: the guidance lives in the system
  // prompt, and it says how many node kinds a plan has.
  const shape = text.includes('one of four kinds')
    ? 'one-layer'
    : text.includes('one of three kinds') ? 'dag' : 'unknown'

  const planCalls = events.filter(event => event.type === 'tool/call' && event.data?.name === 'refine_plan')
  const when = new Date(session.mtime).toISOString().replace('T', ' ').slice(0, 16)
  if (planCalls.length === 0) {
    if (!kindsOnly) console.log(`--- ${when}  ${session.id.slice(0, 8)}  ${shape}  no plan`)
    continue
  }

  for (const planCall of planCalls) {
    let plan
    try {
      plan = JSON.parse(planCall.data.arguments)
    } catch {
      continue
    }
    const kinds = (plan.nodes ?? []).map(node => node.kind)
    console.log(`--- ${when}  ${session.id.slice(0, 8)}  ${shape}  kinds=${JSON.stringify(kinds)}`)
    if (kindsOnly) continue

    const index = events.indexOf(planCall)
    let shown = 0
    for (let i = index - 1; i >= 0 && shown < reasoningLimit; i -= 1) {
      const event = events[i]
      if (event.type !== 'assistant/message') continue
      for (const block of event.data?.message?.content ?? []) {
        if (block.type !== 'reasoning' || typeof block.text !== 'string') continue
        const clipped = block.text.length > 1400 ? block.text.slice(-1400) : block.text
        console.log('  [reasoning]')
        for (const line of clipped.split(LF)) if (line.trim() !== '') console.log('   ' + line.trim())
        shown += 1
      }
    }
    for (const node of plan.nodes ?? []) {
      const detail = node.task !== undefined
        ? String(node.task).slice(0, 90)
        : (node.calls ?? []).map(call => call.name).join(',')
      console.log(`  node ${node.kind}: ${detail}`)
    }
    printed += 1
    if (printed >= 6) process.exit(0)
  }
}

/**
 * Print the flow of one bench run: the main agent step by step, and what each
 * child it started did on its own.
 *
 * Usage: node bench/flow.mjs <scenario> <off|on> [index]
 */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const ROOT = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const RESULTS = 'D:/code/vibe/dsh-refine-loop/bench/results'
const LF = String.fromCharCode(10)
const scenario = process.argv[2] ?? 'review'
const arm = process.argv[3] ?? 'on'
const index = process.argv[4] ?? '1'

const record = JSON.parse(
  (await import('node:fs')).readFileSync(join(RESULTS, `${scenario}-${arm}-${index}.json`), 'utf8'),
)

/**
 * Every event of one session, every segment.
 *
 * @param dir - the session directory.
 * @returns the events.
 */
function eventsOf(dir) {
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
      // torn segment
    }
  }
  return events
}

/**
 * Render one session's own steps.
 *
 * @param events - the session's events.
 * @param label - a heading.
 * @returns nothing; prints.
 */
function printFlow(events, label) {
  console.log(label)
  let step = -1
  let started = undefined
  const rows = []
  for (const event of events) {
    if (event.type === 'step/start') {
      step += 1
      started = event.time
      rows.push({ step, ms: 0, out: 0, think: '', calls: [], text: '' })
      continue
    }
    const row = rows[rows.length - 1]
    if (row === undefined) continue
    if (event.type === 'assistant/message' && started !== undefined) {
      const usage = event.data?.usage ?? {}
      row.ms = event.time - started
      row.out = usage.outputTokens ?? 0
      for (const block of event.data?.message?.content ?? []) {
        if (block.type === 'reasoning') row.think += block.text ?? ''
        if (block.type === 'text') row.text += block.text ?? ''
      }
      started = undefined
    }
    if (event.type === 'tool/call') {
      row.calls.push({ name: event.data.name, args: String(event.data.arguments ?? '') })
    }
  }
  for (const row of rows) {
    const head = row.text.trim().split(LF)[0].slice(0, 110)
    console.log('  step ' + String(row.step).padStart(2) + '  ' + String((row.ms / 1000).toFixed(1)).padStart(6) + 's'
      + '  out=' + String(row.out).padStart(4) + '  think=' + String(row.think.length).padStart(5) + 'ch')
    for (const call of row.calls) {
      console.log('          → ' + call.name + '  ' + call.args.replace(/\s+/g, ' ').slice(0, 130))
    }
    if (head !== '') console.log('          "' + head + '"')
  }
  console.log()
}

const mainDir = readdirSync(ROOT).find(dir => dir === record.sessionId
  || dir.startsWith(record.sessionId.slice(8, 21)))
const main = eventsOf(mainDir)
printFlow(main, '主 agent（' + (record.wallMs / 1000).toFixed(0) + 's / ' + record.formation.agents + ' 个 agent / '
  + record.formation.total + ' token）')

// The plan it drew.
const planCall = main.find(event => event.type === 'tool/call' && event.data?.name === 'refine_plan')
if (planCall !== undefined) {
  const plan = JSON.parse(planCall.data.arguments)
  console.log('它画的图（' + planCall.data.arguments.length + ' 字符）：')
  for (const node of plan.nodes) {
    const detail = node.task !== undefined
      ? node.task.replace(/\s+/g, ' ').slice(0, 150)
      : (node.calls ?? []).map(call => call.name).join(',')
    console.log('  [' + node.id + '] ' + node.kind + ' — ' + detail)
  }
  console.log()
}

const children = []
for (const dir of readdirSync(ROOT)) {
  if (dir === mainDir) continue
  const files = readdirSync(join(ROOT, dir)).filter(name => name.endsWith('.zstd'))
  if (files.length === 0) continue
  let events
  try {
    events = eventsOf(dir)
  } catch {
    continue
  }
  const header = events.find(event => event.type === 'session')
  if (header?.parentSession !== record.sessionId) continue
  let cut = -1
  events.forEach((event, i) => { if (event.type === 'session/end-seed') cut = i })
  const own = events.slice(cut + 1)
  const task = own.find(event => event.type === 'user/message')
  const last = [...own].reverse().find(event => event.type === 'assistant/message')
  const text = (last?.data?.message?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('')
  children.push({ dir, own, task: JSON.stringify(task?.data?.content ?? ''), text })
}

for (const child of children) {
  const taskText = child.task.replace(/\\n/g, ' ').replace(/\s+/g, ' ')
  const marker = taskText.indexOf('worker]')
  const body = marker === -1 ? taskText : taskText.slice(marker + 8)
  console.log('子代理（task: ' + body.slice(0, 120) + '…）')
  printFlow(child.own, '  ' + child.dir.slice(0, 20))
  console.log('  最终答案 ' + child.text.length + ' 字符：' + child.text.replace(/\s+/g, ' ').slice(0, 220))
  console.log()
}

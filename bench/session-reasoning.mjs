/**
 * Print the reasoning of one session, around its plan call.
 *
 * Usage: node bench/session-reasoning.mjs <sessionIdPrefix> [maxChars]
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const ROOT = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const LF = String.fromCharCode(10)
const prefix = process.argv[2]
const max = Number(process.argv[3] ?? 6000)

if (prefix === undefined) {
  console.error('usage: node bench/session-reasoning.mjs <sessionIdPrefix> [maxChars]')
  process.exit(2)
}

const dir = readdirSync(ROOT).find(name => name.startsWith(prefix))
if (dir === undefined) {
  console.error('no session starts with ' + prefix)
  process.exit(2)
}

const files = readdirSync(join(ROOT, dir)).filter(name => name.endsWith('.zstd')).sort()
let text = ''
for (const name of files) text += decodeLog(join(ROOT, dir, name)) + LF

const events = text.split(LF).filter(Boolean).map(line => {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}).filter(Boolean)

const planIndex = events.findIndex(event => event.type === 'tool/call' && event.data?.name === 'refine_plan')
if (planIndex === -1) {
  console.log('no refine_plan call in this session')
  process.exit(0)
}

// Every reasoning block from the step that produced the plan.
const plan = JSON.parse(events[planIndex].data.arguments)
console.log('plan kinds: ' + JSON.stringify((plan.nodes ?? []).map(node => node.kind)))
console.log()

for (let i = Math.max(0, planIndex - 8); i < planIndex; i += 1) {
  const event = events[i]
  if (event.type !== 'assistant/message') continue
  for (const block of event.data?.message?.content ?? []) {
    if (block.type !== 'reasoning' || typeof block.text !== 'string') continue
    const body = block.text.length > max ? block.text.slice(0, max) + ' …[cut]' : block.text
    console.log('--- reasoning ---')
    console.log(body)
    console.log()
  }
}

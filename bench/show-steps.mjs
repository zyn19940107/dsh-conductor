/**
 * Print one session's steps with the outcome of each call.
 *
 * Usage: node bench/show-steps.mjs <result-file> [--results]
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const ROOT = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const result = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const withResults = process.argv.includes('--results')

/**
 * Find the log of one session.
 *
 * @param {string} id - the session id.
 * @returns {string} the log text.
 */
function loadOne(id) {
  for (const entry of readdirSync(ROOT, { withFileTypes: true }).filter(item => item.isDirectory())) {
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
      if (header.id === id) return text
    }
  }
  return ''
}

const text = loadOne(result.sessionId)
if (text === '') {
  console.error('no log for this session')
  process.exit(1)
}

const events = text.split('\n').map(line => {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}).filter(Boolean)

const calls = new Map()
const outcomes = new Map()
let step = 0
let planNumber = 0
for (const event of events) {
  if (event.type === 'step/start') step += 1
  if (event.type === 'tool/call') {
    const args = JSON.parse(event.data.arguments)
    if (event.data.name === 'refine_plan') {
      planNumber += 1
      const plan = JSON.parse(event.data.arguments)
      const nodes = plan.nodes
        .map(node => `${node.id}(${node.kind}${node.kind === 'tools' ? ':' + node.calls.length : ''})`)
        .join(' ')
      calls.set(event.data.callId, `步${step}  【第${planNumber}张计划】${nodes}`)
      continue
    }
    const shown = String(args.file_path ?? args.pattern ?? args.command ?? '')
      .split('\\').join('/')
      .slice(0, 55)
    calls.set(event.data.callId, `步${step}  ${event.data.name}  ${shown}`)
  }
  if (event.type === 'tool/result' && withResults) {
    const message = event.data.message
    const body = (message.content ?? []).map(block => block.text ?? '').join(' ')
    outcomes.set(message.toolCallId, message.isError === true ? `被拒绝: ${body.slice(0, 60)}` : '')
  }
}

let current = ''
for (const [callId, line] of calls) {
  const stepOf = line.match(/^步(\d+)/)?.[1]
  if (stepOf !== current) {
    current = stepOf
    console.log('')
    console.log(`── 步 ${stepOf} ──`)
  }
  const outcome = outcomes.get(callId)
  console.log(`  ${line.replace(/^步\d+\s+/, '')}${outcome ? '   ← ' + outcome : ''}`)
}
console.log('')
console.log(`共 ${step} 步,${calls.size} 个顶层工具调用`)

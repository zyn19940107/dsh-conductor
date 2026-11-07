/**
 * Did the report phase actually happen in one bench record?
 *
 * Looks for the report request in the child's own log, a refused tool call, and
 * the report text in the parent's plan result — the three things the redesign is
 * supposed to produce.
 *
 * Usage: node bench/check-report.mjs <task> <run-index>
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const SESSIONS = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const RESULTS = 'D:/code/vibe/dsh-refine-loop/bench/results'
const LF = String.fromCharCode(10)
const task = process.argv[2] ?? 'budgetprobe'
const index = process.argv[3] ?? '1'

/**
 * @param session - the session directory.
 * @returns its events.
 */
function eventsOf(session) {
  const out = []
  let files = []
  try {
    files = readdirSync(join(SESSIONS, session)).filter(name => name.endsWith('.zstd'))
  } catch {
    return out
  }
  for (const file of files) {
    try {
      out.push(...decodeLog(join(SESSIONS, session, file)).split(LF).filter(Boolean).map(line => {
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
  return out
}

const record = JSON.parse(readFileSync(join(RESULTS, `${task}-on-${index}.json`), 'utf8'))
const parentDir = readdirSync(SESSIONS).find(entry => entry === record.sessionId
  || entry.startsWith(String(record.sessionId).slice(8, 21)))
if (parentDir === undefined) {
  console.log('parent session not found')
  process.exit(1)
}
const parentText = JSON.stringify(eventsOf(parentDir))
console.log(`record: ${task}-on-${index}  wall ${(record.wallMs / 1000).toFixed(0)}s  score ${record.correctness.passed}/${record.correctness.total}`)
console.log('parent saw the report request:', parentText.includes('Write the report now'))
console.log('parent saw a refused tool call:', parentText.includes('Tools are refused'))
console.log('parent saw the budget error:', parentText.includes('this is what it reported'))

let children = 0
let gotRequest = 0
let gotRefusal = 0
let reported = 0
for (const entry of readdirSync(SESSIONS).filter(name => name.startsWith('refine-loop-child-'))) {
  const events = eventsOf(entry)
  const header = events.find(event => event.type === 'session')
  if ((header?.data?.parentSession ?? header?.parentSession) !== record.sessionId) continue
  children += 1
  const text = JSON.stringify(events)
  if (text.includes('Write the report now')) gotRequest += 1
  if (text.includes('Tools are refused')) gotRefusal += 1
  const last = [...events].reverse().find(event => event.type === 'assistant/message')
  const blocks = last?.data?.message?.content ?? []
  const said = blocks.filter(block => block.type === 'text').map(block => String(block.text ?? '')).join('')
  if (said.trim() !== '') reported += 1
}
console.log(`children ${children} | asked to report ${gotRequest} | refused a tool ${gotRefusal} | ended with text ${reported}`)
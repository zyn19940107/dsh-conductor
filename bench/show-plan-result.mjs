/**
 * Print what one plan's nodes actually produced, next to the criteria the
 * plan set for itself.
 *
 * Usage: node bench/show-plan-result.mjs <result-file> [plan-number]
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const ROOT = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const result = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const wanted = Number(process.argv[3] ?? 1)

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

const events = loadOne(result.sessionId).split('\n').map(line => {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}).filter(Boolean)

let number = 0
let pending = null
let plan = null
for (const event of events) {
  if (event.type === 'tool/call' && event.data.name === 'refine_plan') {
    number += 1
    if (number === wanted) {
      pending = event.data.callId
      plan = JSON.parse(event.data.arguments)
    }
    continue
  }
  if (event.type !== 'tool/result' || pending === null) continue
  if (event.data.message.toolCallId !== pending) continue
  pending = null

  const body = (event.data.message.content ?? []).map(block => block.text ?? '').join('\n')

  console.log('══════ 这张图要什么 ══════')
  for (const criterion of plan.criteria) console.log(`  判据: ${criterion.slice(0, 110)}`)

  console.log('')
  console.log('══════ 这张图回来的是什么 ══════')
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (/^(Plan finished|Criteria:)/.test(trimmed)) continue
    if (/^[a-z0-9_]+ \(/.test(trimmed)) { console.log(`  ${trimmed}`); continue }
    if (/^\| \d+\. /.test(trimmed)) { console.log(`    ${trimmed.slice(0, 100)}`); continue }
    if (trimmed.startsWith('|    |')) { console.log(`      ${trimmed.slice(6, 110)}`); continue }
    if (/^   \|/.test(line)) console.log(`    ${trimmed.slice(0, 110)}`)
  }
}

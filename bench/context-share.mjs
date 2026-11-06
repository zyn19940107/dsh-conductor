/**
 * How much of the leader's context is plan reports, and how much of that is tools output.
 *
 * The leader never calls tools itself, so everything it knows about the work
 * arrives in refine_plan's report. This measures the report's share of the
 * context and attributes each section to the node kind that produced it.
 *
 * Usage: node bench/context-share.mjs <task> [task ...]
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const RESULTS = 'D:/code/vibe/dsh-refine-loop/bench/results'
const SESSIONS = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const LF = String.fromCharCode(10)

/**
 * @param sessionId - the run's session.
 * @returns the session directory name, or undefined.
 */
function sessionDirOf(sessionId) {
  return readdirSync(SESSIONS).find(entry => entry === sessionId
    || entry.startsWith(String(sessionId).slice(8, 21)))
}

/**
 * @param directory - a session directory.
 * @returns its events.
 */
function eventsOf(directory) {
  const events = []
  for (const name of readdirSync(join(SESSIONS, directory)).filter(entry => entry.endsWith('.zstd')).sort()) {
    try {
      events.push(...decodeLog(join(SESSIONS, directory, name)).split(LF).filter(Boolean).map(line => {
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

for (const task of process.argv.slice(2)) {
  const names = readdirSync(RESULTS).filter(name => name.startsWith(`${task}-on-`) && name.endsWith('.json')).sort()
  for (const name of names) {
    let record
    try {
      record = JSON.parse(readFileSync(join(RESULTS, name), 'utf8'))
    } catch {
      continue
    }
    const directory = sessionDirOf(record.sessionId)
    if (directory === undefined) continue
    const events = eventsOf(directory)
    const kinds = {}
    const open = new Set()
    let reportChars = 0
    let assistantChars = 0
    let userChars = 0
    const byKind = {}
    for (const event of events) {
      if (event.type === 'tool/call' && event.data?.name === 'refine_plan') {
        try {
          const plan = JSON.parse(String(event.data.arguments))
          for (const node of plan.nodes ?? []) kinds[node.id] = node.kind
        } catch {
          // refused plan
        }
        open.add(String(event.data.callId))
      }
      if (event.type === 'tool/result' && open.has(String(event.data?.message?.toolCallId ?? ''))) {
        const text = (event.data?.message?.content ?? []).map(block => block.text ?? '').join('')
        reportChars += text.length
        for (const [id, kind] of Object.entries(kinds)) {
          const at = text.indexOf(`\n${id} (${kind})`)
          if (at < 0) continue
          let end = text.length
          for (const other of Object.keys(kinds)) {
            if (other === id) continue
            const pos = text.indexOf(`\n${other} (`, at + 1)
            if (pos >= 0 && pos < end) end = pos
          }
          byKind[kind] = (byKind[kind] ?? 0) + (end - at)
        }
        open.delete(String(event.data?.message?.toolCallId))
      }
      if (event.type === 'assistant/message') {
        for (const block of event.data?.message?.content ?? []) {
          if (block.type === 'text') assistantChars += (block.text ?? '').length
        }
      }
      if (event.type === 'user/message') {
        for (const block of event.data?.content ?? []) {
          if (block.type === 'text') userChars += (block.text ?? '').length
        }
      }
    }
    const prompt = record.mainPrompt ?? 0
    const share = kind => reportChars === 0 ? '0%' : `${Math.round(((byKind[kind] ?? 0) / reportChars) * 100)}%`
    console.log(`${name.padEnd(28)} 主 context ~${(prompt / 1000).toFixed(0)}k tok`
      + ` | 报告 ${reportChars.toLocaleString()} 字符`
      + ` | ${Object.entries(byKind).map(([kind, chars]) => `${kind} ${(chars / 1000).toFixed(0)}k (${share(kind)})`).join(' ')}`
      + ` | 主代理自己写 ${assistantChars.toLocaleString()}`)
  }
}

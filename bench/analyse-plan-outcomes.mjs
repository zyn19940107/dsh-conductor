/**
 * Were the plans accepted or rejected, and why?
 *
 * The proposal wants to drop the intra-round dependency machinery. Whether
 * that is cheap depends on how much the models actually *used* it - and on
 * how often the plans that tried to use it were thrown out. A plan that
 * references a node that does not exist is rejected outright, so the model
 * burns a turn and gets nothing.
 *
 * Usage: node analyse-plan-outcomes.mjs
 */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const ROOT = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'

const files = []
for (const dir of readdirSync(ROOT, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue
  for (const name of readdirSync(join(ROOT, dir.name))) {
    if (name.endsWith('.zstd')) files.push(join(ROOT, dir.name, name))
  }
}
files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)

const outcomes = new Map()
const reasons = new Map()
const samples = []
let calls = 0
let accepted = 0
let rejected = 0
let usedAfter = 0
let usedAfterAccepted = 0
let usedPlaceholder = 0
let usedPlaceholderAccepted = 0

for (const path of files) {
  let text
  try {
    text = decodeLog(path)
  } catch {
    continue
  }
  const events = text.split('\n').filter(Boolean).map(line => {
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  }).filter(Boolean)

  for (const event of events) {
    if (event.type !== 'tool/call' || event.data.name !== 'refine_plan') continue
    calls += 1
    let input
    try {
      input = JSON.parse(event.data.arguments)
    } catch {
      continue
    }
    const nodes = Array.isArray(input.nodes) ? input.nodes : []
    const ids = new Set(nodes.map(node => String(node.id).trim()))
    const afterEdges = nodes.flatMap(node => (Array.isArray(node.after) ? node.after : [])
      .map(dependency => String(dependency).trim()))
    const dangling = afterEdges.filter(dependency => !ids.has(dependency))
    const placeholders = nodes.some(node => (Array.isArray(node.calls) ? node.calls : [])
      .some(call => JSON.stringify(call.arguments ?? '').includes('@@')))
    if (afterEdges.length > 0) usedAfter += 1
    if (placeholders) usedPlaceholder += 1

    // The result of this call.
    const callId = event.data.callId
    const result = events.find(other => other.type === 'tool/result'
      && other.data?.message?.source?.kind === 'tool'
      && other.data.message.source.callId === callId)
    const text2 = JSON.stringify(result?.data?.message?.content ?? '')
    const aborted = text2.includes('tool call aborted')
    const schema = text2.includes('invalid arguments')
    const ok = !text2.includes('"isError":true') && text2.includes('Plan finished')
    outcomes.set(ok ? 'ok' : 'rejected', (outcomes.get(ok ? 'ok' : 'rejected') ?? 0) + 1)
    if (ok) {
      accepted += 1
      if (afterEdges.length > 0) usedAfterAccepted += 1
      if (placeholders) usedPlaceholderAccepted += 1
    } else {
      rejected += 1
      const reason = /depends on "([^"]+)", which is not a node/.exec(text2)?.[0]
        ?? /depends on itself/.exec(text2)?.[0]
        ?? /which is also a subagent/.exec(text2)?.[0]
        ?? (/not a valid plan|no plan|parse/i.exec(text2)?.[0] ?? 'other')
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
      if (samples.length < 6) {
        const plain = text2.replace(/\n/g, ' ').slice(0, 260)
        samples.push(plain)
      }
    }
    if (dangling.length > 0) {
      const key = `悬空引用 ${dangling.length} 个`
      reasons.set(key, (reasons.get(key) ?? 0) + 1)
    }
  }
}

console.log(`refine_plan 调用: ${calls}  接受: ${accepted}  被拒: ${rejected}`)
console.log(`用到 after 的调用: ${usedAfter},其中被接受: ${usedAfterAccepted} (${pct(usedAfterAccepted, usedAfter)})`)
console.log(`用到 @@ 的调用: ${usedPlaceholder},其中被接受: ${usedPlaceholderAccepted} (${pct(usedPlaceholderAccepted, usedPlaceholder)})`)
console.log('被拒的原因:')
for (const [reason, count] of [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${count}× ${reason}`)
}

console.log('被拒的样例:')
for (const sample of samples) console.log(`  - ${sample}`)

/**
 * A percentage as a display string.
 *
 * @param {number} part - the numerator.
 * @param {number} whole - the denominator.
 * @returns {string} the percentage.
 */
function pct(part, whole) {
  if (!whole) return '—'
  return `${Math.round((part / whole) * 100)}%`
}

/**
 * Print one plan in full: its nodes, its calls, and what came back.
 *
 * Usage: node bench/show-plan.mjs <result-file> [plan-number]
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
for (const event of events) {
  if (event.type === 'tool/call' && event.data.name === 'refine_plan') {
    number += 1
    if (number !== wanted) continue
    const plan = JSON.parse(event.data.arguments)
    console.log(`══════ 第 ${number} 张计划 ══════`)
    console.log('判据:')
    for (const criterion of plan.criteria) console.log(`  · ${criterion.slice(0, 150)}`)
    console.log('节点:')
    for (const node of plan.nodes) {
      console.log(`  ${node.id}  [${node.kind}]  after=[${(node.after ?? []).join(',')}]`)
      if (node.kind === 'tools') {
        for (const call of node.calls) {
          const args = call.arguments ?? {}
          const shown = String(args.file_path ?? args.pattern ?? args.command ?? '')
            .split('\\').join('/').slice(0, 90)
          console.log(`      ${call.name}  ${shown}`)
        }
      } else {
        console.log(`      任务: ${String(node.task).replace(/\s+/g, ' ').slice(0, 160)}`)
      }
    }
    pending = event.data.callId
    continue
  }
  if (event.type === 'tool/result' && pending !== null && event.data.message.toolCallId === pending) {
    pending = null
    const body = (event.data.message.content ?? []).map(block => block.text ?? '').join('\n')
    console.log('')
    console.log('══════ 计划回来的结果(前 2000 字)══════')
    console.log(body.slice(0, 2000))
  }
}

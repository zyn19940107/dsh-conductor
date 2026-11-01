/**
 * Print a session's system prompt sections and the reasoning right before a
 * plan call.
 *
 * Usage: node bench/show-guidance.mjs <result-file>
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const ROOT = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const result = JSON.parse(readFileSync(process.argv[2], 'utf8'))

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

console.log('══════ 这个会话的系统提示词里有没有那条规则 ══════')
console.log('含 "Refined loop:" 的段落:', /Refined loop:/.test(text) ? '有' : '★ 没有 ★')
console.log('含 "subagent_fork" 的段落:', /subagent_fork/.test(text) ? '有' : '★ 没有 ★')
console.log('含 "需不需要知道" 的段落:', /需不需要知道/.test(text) ? '有' : '★ 没有 ★')

const events = text.split('\n').map(line => {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}).filter(Boolean)

const systemMessages = events.filter(event => event.type === 'system/message' || event.type === 'system/prompt')
console.log('')
console.log('系统消息事件:', systemMessages.length, systemMessages.map(event => event.type).join(','))

for (const event of systemMessages) {
  const content = JSON.stringify(event.data ?? {})
  const index = content.indexOf('Refined loop:')
  if (index >= 0) {
    console.log('')
    console.log('══════ 规则原文 ══════')
    console.log(content.slice(index, index + 900).replace(/\\n/g, '\n'))
  }
}

console.log('')
console.log('══════ 画第二张计划之前的思考 ══════')
let reasoning = []
for (const event of events) {
  if (event.type === 'assistant/message') {
    for (const block of event.data.message.content ?? []) {
      if (block.type === 'reasoning') reasoning.push(String(block.text ?? ''))
    }
  }
  if (event.type === 'tool/call' && event.data.name === 'refine_plan') {
    const plan = JSON.parse(event.data.arguments)
    const agents = plan.nodes.filter(node => node.kind !== 'tools')
    if (agents.length === 0) continue
    console.log('--- 思考(最后两条) ---')
    for (const line of reasoning.slice(-2)) console.log('  · ' + line.replace(/\s+/g, ' ').slice(0, 700))
    console.log('--- 选出来的节点类型 ---')
    for (const node of agents) console.log(`  ${node.id}: ${node.kind}`)
    reasoning = []
  }
}

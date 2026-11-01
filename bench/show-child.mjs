/**
 * Print the full task text of a plan's agent nodes, and a child agent's own
 * reasoning, so a claim about what a child was told can be checked.
 *
 * Usage: node bench/show-child.mjs <result-file>
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const ROOT = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const result = JSON.parse(readFileSync(process.argv[2], 'utf8'))

/**
 * Every session log under the sessions root, keyed by session id.
 *
 * @returns {Map<string, {header: object, text: string}>} the logs.
 */
function loadAll() {
  const sessions = new Map()
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
      if (header.type !== 'session') continue
      sessions.set(header.id, { header, text })
    }
  }
  return sessions
}

const sessions = loadAll()
const main = sessions.get(result.sessionId)
if (main === undefined) {
  console.error(`no session log for ${result.sessionId}`)
  process.exit(1)
}

let planNumber = 0
for (const line of main.text.split('\n')) {
  let event
  try {
    event = JSON.parse(line)
  } catch {
    continue
  }
  if (event.type !== 'tool/call' || event.data.name !== 'refine_plan') continue
  planNumber += 1
  const plan = JSON.parse(event.data.arguments)
  const agents = plan.nodes.filter(node => node.kind !== 'tools')
  if (agents.length === 0) continue
  console.log(`══════ 第 ${planNumber} 张计划里的代理节点 —— 完整任务文本 ══════`)
  for (const node of agents) {
    console.log(`\n──── ${node.id} [${node.kind}] ────`)
    console.log(node.task)
  }
}

const kids = [...sessions.values()].filter(entry => entry.header.parentSession === result.sessionId)
for (const kid of kids) {
  const calls = []
  let reasoning = []
  for (const line of kid.text.split('\n')) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.type === 'tool/call') {
      const args = JSON.parse(event.data.arguments)
      const shown = args.file_path ?? args.pattern ?? args.command ?? JSON.stringify(args)
      calls.push(`${event.data.name}  ${String(shown).slice(0, 70)}`)
    }
    if (event.type === 'assistant/message') {
      for (const block of event.data.message.content ?? []) {
        if (block.type === 'reasoning') reasoning.push(String(block.text ?? '').replace(/\s+/g, ' '))
      }
    }
  }
  console.log(`\n══════ 子代理 ${kid.header.id.slice(0, 8)} ══════`)
  console.log('调用:'); for (const call of calls) console.log('  ' + call)
  console.log('思考:'); for (const line of reasoning) console.log('  · ' + line.slice(0, 400))
}

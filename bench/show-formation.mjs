/**
 * Print what one formation run planned, and what each child agent did.
 *
 * Usage: node bench/show-formation.mjs <result-file>
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
  console.log(`══════ 第 ${planNumber} 张计划 ══════`)
  console.log(`判据 ${plan.criteria.length} 条`)
  for (const node of plan.nodes) {
    const after = (node.after ?? []).join(',')
    console.log(`  ${node.id}  [${node.kind}]  after=[${after}]`)
    if (node.kind === 'tools') {
      for (const call of node.calls) {
        const args = call.arguments ?? {}
        const shown = args.file_path ?? args.pattern ?? args.command ?? JSON.stringify(args)
        console.log(`      ${call.name}  ${String(shown).slice(0, 90)}`)
      }
    } else {
      console.log(`      任务: ${String(node.task).replace(/\s+/g, ' ').slice(0, 130)}`)
    }
  }
  console.log('')
}

const kids = [...sessions.values()].filter(entry => entry.header.parentSession === result.sessionId)
console.log(`══════ ${kids.length} 个子代理(并行的那一波)══════`)
for (const kid of kids) {
  const calls = []
  let step = 0
  for (const line of kid.text.split('\n')) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.type === 'step/start') step += 1
    if (event.type === 'tool/call') {
      const args = JSON.parse(event.data.arguments)
      const shown = args.file_path ?? args.pattern ?? args.command ?? JSON.stringify(args)
      calls.push(`      步${step} → ${event.data.name}  ${String(shown).slice(0, 80)}`)
    }
  }
  console.log(`  子代理 ${kid.header.id.slice(0, 8)}（${kid.header.delegationDepth} 步）`)
  for (const call of calls) console.log(call)
}

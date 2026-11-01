/**
 * List every plan a session drew, with what each node did.
 *
 * Usage: node bench/show-plans.mjs <session-id-prefix>
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const ROOT = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const prefix = process.argv[2] ?? ''

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
    if (!String(header.id).startsWith(prefix)) continue
    const events = text.split('\n').map(line => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    }).filter(Boolean)

    let plan = 0
    for (const event of events) {
      const data = event.data ?? {}
      const name = data.name ?? event.tool ?? ''
      if (name === 'refine_plan') {
        plan += 1
        let args = data.arguments ?? data.input ?? {}
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args)
          } catch {
            args = {}
          }
        }
        const nodes = args.nodes ?? []
        console.log(`\n图 ${plan} —— ${nodes.length} 个节点`)
        for (const node of nodes) {
          const calls = node.calls ?? []
          console.log(`  ${node.id} (${node.kind}) 调用 ${calls.length} 个: `
            + calls.map(call => `${call.name}(${Object.keys(call.arguments ?? {}).join(',')})`).join(' '))
        }
      }
      if (event.type === 'tool/result' || event.type === 'tool_result') {
        const raw = JSON.stringify(data)
        if (!raw.includes('Plan finished')) continue
        const text2 = (data.result ?? data.text ?? raw)
        const body = typeof text2 === 'string' ? text2 : JSON.stringify(text2)
        for (const line of body.split('\n')) {
          if (line.includes('— failed') || line.includes('error:') || line.includes('Plan finished')) {
            console.log('    ' + line.trim().slice(0, 160))
          }
        }
      }
    }
    process.exit(0)
  }
}
console.error('no session with that prefix')
process.exit(1)

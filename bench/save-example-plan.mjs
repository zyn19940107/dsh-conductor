/**
 * Write the biggest plan of the newest run that matches a text into
 * docs/example-plan.json.
 *
 * Usage: node bench/save-example-plan.mjs <text-to-match> [output-file]
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const ROOT = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const needle = process.argv[2] ?? 'DSH 生态简报'
const output = process.argv[3] ?? 'docs/example-plan.json'

let best = null
for (const entry of readdirSync(ROOT, { withFileTypes: true }).filter(item => item.isDirectory())) {
  for (const file of readdirSync(join(ROOT, entry.name))) {
    if (!file.endsWith('.zstd')) continue
    const text = decodeLog(join(ROOT, entry.name, file))
    if (text === '') continue
    if (!text.includes(needle)) continue
    for (const line of text.split('\n')) {
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (event.type !== 'tool/call' || event.data.name !== 'refine_plan') continue
      let plan
      try {
        plan = JSON.parse(event.data.arguments)
      } catch {
        continue
      }
      if (!Array.isArray(plan.nodes) || plan.nodes.length === 0) continue
      if (best === null || plan.nodes.length > best.nodes.length) best = plan
    }
  }
}

if (best === null) {
  console.error('no plan found')
  process.exit(1)
}
writeFileSync(output, JSON.stringify(best, null, 2) + '\n')
console.log('wrote', output)
console.log('节点:', best.nodes.map(node => `${node.id}(${node.kind}${node.kind === 'tools' ? ':' + node.calls.length : ''})`).join(' '))
console.log('依赖:', best.nodes.map(node => `${node.id}←[${(node.after ?? []).join(',')}]`).join('  '))
console.log('判据:', best.criteria.length, '条')

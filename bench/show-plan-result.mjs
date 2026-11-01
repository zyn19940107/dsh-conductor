/**
 * Print one plan's tool result, so what the model sees after the plan is visible.
 *
 * Usage: node bench/show-plan-result.mjs <session-id-prefix> [n]
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const ROOT = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const prefix = process.argv[2] ?? ''
const which = Number(process.argv[3] ?? 1)

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

    let seen = 0
    for (const event of events) {
      const raw = JSON.stringify(event.data ?? {})
      if (!raw.includes('Plan finished')) continue
      seen += 1
      if (seen !== which) continue
      const body = raw.replace(/\\n/g, '\n')
      const at = body.indexOf('Plan finished')
      console.log(body.slice(at, at + 2500))
      process.exit(0)
    }
  }
}
console.error('no plan result with that prefix')
process.exit(1)

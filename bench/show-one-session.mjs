/**
 * Print one session's calls, step by step.
 *
 * Usage: node bench/show-one-session.mjs <session-id-prefix>
 */

import { readdirSync, readFileSync } from 'node:fs'
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
    console.log('会话', header.id, '| 深度', header.delegationDepth ?? 0)
    let step = 0
    for (const line of text.split('\n')) {
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (event.type === 'step/start') step += 1
      if (event.type !== 'tool/call') continue
      let args = {}
      try {
        args = JSON.parse(event.data.arguments || '{}')
      } catch {
        // Not JSON.
      }
      const shown = String(args.file_path ?? args.pattern ?? args.command ?? '')
        .split('\\').join('/').slice(0, 56)
      console.log(`步${String(step).padStart(2)}  ${event.data.name.padEnd(8)} ${shown}`)
    }
    process.exit(0)
  }
}
console.error('no session with that prefix')
process.exit(1)

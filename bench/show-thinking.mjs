/**
 * Print the model's reasoning after the first refusal in the newest session.
 *
 * Usage: node bench/show-thinking.mjs [session-id-substring]
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const ROOT = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const wanted = process.argv[2]

const dirs = readdirSync(ROOT, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => ({ name: entry.name, mtime: statSync(join(ROOT, entry.name)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)

for (const dir of dirs) {
  if (wanted !== undefined && !dir.name.includes(wanted)) continue
  for (const file of readdirSync(join(ROOT, dir.name))) {
    if (!file.endsWith('.zstd')) continue
    const text = decodeLog(join(ROOT, dir.name, file))
    if (text === '') continue
    const events = text.split('\n').map(line => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    }).filter(Boolean)
    const calls = events.filter(event => event.type === 'tool/call')
    if (calls.length === 0) continue
    const names = calls.map(call => call.data.name)
    console.log('════ 会话', dir.name.slice(0, 20), '调用:', names.join(',').slice(0, 120))
    let refusals = 0
    for (const event of events) {
      if (event.type === 'assistant/message') {
        for (const block of event.data.message.content ?? []) {
          if (block.type === 'reasoning') {
            console.log('  · 思考:', String(block.text ?? '').replace(/\s+/g, ' ').slice(0, 420))
          }
        }
      }
      if (event.type === 'tool/result' && event.data.message?.isError === true) {
        refusals += 1
        console.log('  ← 拒绝 #' + refusals + ': ' + String((event.data.message.content ?? []).map(block => block.text ?? '').join('')).slice(0, 80))
      }
    }
    if (refusals === 0) continue
  }
}

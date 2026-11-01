/**
 * Measure one run two ways: the whole process, and the session log's span.
 *
 * Usage: node bench/show-span.mjs <session-id-prefix>
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
    const times = events.map(event => Number(event.time ?? 0)).filter(time => time > 0)
    const starts = events.filter(event => event.type === 'step/start').map(event => Number(event.time))
    const ends = events.filter(event => event.type === 'step/end').map(event => Number(event.time))
    const first = Math.min(...times)
    const last = Math.max(...times)
    console.log(`会话 ${header.id.slice(0, 16)}`)
    console.log(`  日志跨度(第一个事件 → 最后一个事件): ${((last - first) / 1000).toFixed(1)} 秒`)
    if (starts.length > 0) {
      console.log(`  步骤跨度(第一步开始 → 最后一步结束): ${((Math.max(...ends) - Math.min(...starts)) / 1000).toFixed(1)} 秒`)
    }
    console.log(`  头部记录的时间: ${new Date(header.createdAt ?? first).toISOString()}`)
    process.exit(0)
  }
}
console.error('no session with that prefix')
process.exit(1)

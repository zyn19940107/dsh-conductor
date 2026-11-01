/**
 * Draw the time spans of a run's sessions, so overlap is visible.
 *
 * Usage: node bench/show-overlap-bar.mjs <session-id-prefix>
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const ROOT = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const prefix = process.argv[2] ?? ''

/**
 * One session's span and its parent.
 *
 * @param {string} id - the session id.
 * @returns {{id: string, parent: string|undefined, start: number, end: number, depth: number}|undefined} the span.
 */
function spanOf(id) {
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
      if (header.id !== id) continue
      const events = text.split('\n').map(line => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      }).filter(Boolean)
      const times = events.map(event => Number(event.time ?? 0)).filter(time => time > 0)
      if (times.length === 0) continue
      return {
        id: header.id,
        parent: header.parentSession,
        start: Math.min(...times),
        end: Math.max(...times),
        depth: header.delegationDepth ?? 0,
      }
    }
  }
  return undefined
}

const main = spanOf(prefix)
if (main === undefined) {
  console.error('no session with that prefix')
  process.exit(1)
}

const all = [main]
const queue = [main.id]
while (queue.length > 0) {
  const parent = queue.shift()
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
      if (header.parentSession !== parent) continue
      const child = spanOf(header.id)
      if (child === undefined) continue
      all.push(child)
      queue.push(child.id)
    }
  }
}

const from = Math.min(...all.map(item => item.start))
const to = Math.max(...all.map(item => item.end))
const width = 60
console.log(`整个编队: ${((to - from) / 1000).toFixed(1)} 秒,${all.length} 个会话`)
console.log('')
for (const item of all.sort((a, b) => a.start - b.start)) {
  const left = Math.round(((item.start - from) / (to - from)) * width)
  const length = Math.max(1, Math.round(((item.end - item.start) / (to - from)) * width))
  const label = item.depth === 0 ? '主' : `子${item.depth}`
  console.log(`${label} ${item.id.slice(0, 8)} ${' '.repeat(left)}${'█'.repeat(length)} ${((item.end - item.start) / 1000).toFixed(1)}s`)
}
console.log('')
const kids = all.filter(item => item.depth > 0)
if (kids.length > 1) {
  const sum = kids.reduce((total, item) => total + (item.end - item.start), 0)
  const span = Math.max(...kids.map(item => item.end)) - Math.min(...kids.map(item => item.start))
  console.log(`孩子串起来要 ${(sum / 1000).toFixed(1)} 秒,挤在一起只要 ${(span / 1000).toFixed(1)} 秒 → 省了 ${((1 - span / sum) * 100).toFixed(0)}%`)
}

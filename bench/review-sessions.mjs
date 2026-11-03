/**
 * Every `review` session, split by who it is (root or child), which plugin
 * shape it ran under, and what node kinds it drew.
 *
 * Usage: node bench/review-sessions.mjs
 */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const ROOT = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const LF = String.fromCharCode(10)
const NEEDLE = '分别独立审查'

const rows = []
for (const dir of readdirSync(ROOT, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue
  const files = readdirSync(join(ROOT, dir.name)).filter(name => name.endsWith('.zstd'))
  if (files.length === 0) continue
  let text = ''
  try {
    for (const name of files) text += decodeLog(join(ROOT, dir.name, name)) + LF
  } catch {
    continue
  }
  if (!text.includes(NEEDLE)) continue

  const events = text.split(LF).filter(Boolean).map(line => {
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  }).filter(Boolean)

  const sessionEvent = events.find(event => event.type === 'session')
  const parent = sessionEvent?.parentSession ?? ''
  const shape = text.includes('one of four kinds')
    ? 'one-layer'
    : text.includes('one of three kinds') ? 'dag' : 'unknown'
  const plans = events
    .filter(event => event.type === 'tool/call' && event.data?.name === 'refine_plan')
    .map(event => {
      try {
        return (JSON.parse(event.data.arguments).nodes ?? []).map(node => node.kind)
      } catch {
        return null
      }
    })
    .filter(Boolean)
  const mtime = Math.max(...files.map(name => statSync(join(ROOT, dir.name, name)).mtimeMs))
  rows.push({ id: dir.name, when: new Date(mtime).toISOString().replace('T', ' ').slice(5, 16), shape, parent, plans })
}

rows.sort((a, b) => (a.when < b.when ? 1 : -1))
for (const row of rows) {
  const who = row.parent === '' ? 'ROOT ' : 'child'
  const plans = row.plans.length === 0 ? 'no plan' : row.plans.map(kinds => kinds.join('+')).join(' | ')
  console.log(`${row.when}  ${who}  ${row.shape.padEnd(9)}  ${plans}`)
}

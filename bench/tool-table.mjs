/**
 * Read the newest session's request header and report which delegation-related
 * tools it carries — the header is what the model is actually sent.
 *
 * Usage: node bench/tool-table.mjs
 */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const HOME = 'D:/code/vibe/dsh-sandbox/home/sessions'
const LF = String.fromCharCode(10)
const NAMES = ['subagent', 'subagent_fork', 'list_agents', 'send_message', 'interrupt_agent', 'refine_plan']

const rows = []
for (const workspace of readdirSync(HOME)) {
  const root = join(HOME, workspace)
  if (!statSync(root).isDirectory()) continue
  for (const dir of readdirSync(root)) {
    const files = readdirSync(join(root, dir)).filter(name => name.endsWith('.zstd')).sort()
    if (files.length === 0) continue
    rows.push({ root, dir, files, mtime: statSync(join(root, dir, files[files.length - 1])).mtimeMs })
  }
}
rows.sort((a, b) => b.mtime - a.mtime)

for (const row of rows.slice(0, 3)) {
  const events = []
  for (const name of row.files) {
    try {
      events.push(...decodeLog(join(row.root, row.dir, name)).split(LF).filter(Boolean).map(line => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      }).filter(Boolean))
    } catch {
      // torn segment
    }
  }
  const header = events.find(event => event.type === 'request/header')
  const text = JSON.stringify(header ?? {})
  const headerSteps = events.filter(event => event.type === 'step/start').length
  console.log(row.dir.slice(0, 14), new Date(row.mtime).toISOString().slice(11, 19),
    '| header', header === undefined ? '无' : String(text.length) + ' 字符', '| steps', headerSteps)
  for (const name of NAMES) {
    console.log('   ' + name.padEnd(16) + (text.includes(name) ? '出现' : '—'))
  }
}

// The tools array inside the header, if there is one.
for (const row of rows.slice(0, 1)) {
  const events = []
  for (const name of row.files) {
    try {
      events.push(...decodeLog(join(row.root, row.dir, name)).split(LF).filter(Boolean).map(line => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      }).filter(Boolean))
    } catch {
      // torn segment
    }
  }
  const header = events.find(event => event.type === 'request/header')
  const tools = header?.data?.tools
  if (Array.isArray(tools)) {
    console.log()
    console.log('工具表里的名字:', tools.map(tool => tool.name ?? tool.function?.name).join(', '))
  }
}

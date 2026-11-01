/**
 * Count, across a session tree, which files every agent touched.
 *
 * The question this answers: did the parent and its children read the same
 * files? Work that both the parent and a child did is work the delegation
 * did not save — it repeated.
 *
 * Usage: node bench/show-overlap.mjs <result-file>
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
const tree = []
const walk = (id, label) => {
  const entry = sessions.get(id)
  if (entry === undefined) return
  tree.push({ id, label, text: entry.text })
  for (const child of sessions.values()) {
    if (child.header.parentSession === id) walk(child.header.id, '子代理')
  }
}
walk(result.sessionId, '主会话')

/**
 * What one agent touched.
 *
 * @param {string} text - the session log.
 * @returns {Map<string, number>} the target of each call, and how often.
 */
function touched(text) {
  const targets = new Map()
  for (const line of text.split('\n')) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.type !== 'tool/call') continue
    const args = JSON.parse(event.data.arguments)
    const target = args.file_path ?? args.path ?? args.pattern ?? args.command ?? event.data.name
    const key = String(target).replace(/\\/g, '/').replace(/^.*\//, '')
    targets.set(key, (targets.get(key) ?? 0) + 1)
  }
  return targets
}

const perAgent = tree.map(entry => ({ label: entry.label, id: entry.id, targets: touched(entry.text) }))

console.log('每个 agent 碰过的东西:')
for (const agent of perAgent) {
  const items = [...agent.targets.entries()].map(([key, count]) => `${key}×${count}`)
  console.log(`  ${agent.label} ${agent.id.slice(0, 8)}: ${items.join('  ')}`)
}

const all = new Map()
for (const agent of perAgent) {
  for (const [key, count] of agent.targets) {
    const list = all.get(key) ?? []
    list.push({ label: agent.label, count })
    all.set(key, list)
  }
}

console.log('')
console.log('被不止一个 agent 碰过的东西(= 重复劳动):')
let repeated = 0
for (const [key, list] of all) {
  if (list.length < 2) continue
  repeated += 1
  console.log(`  ${key}: ${list.map(entry => `${entry.label}×${entry.count}`).join(' + ')}`)
}
if (repeated === 0) console.log('  (无)')

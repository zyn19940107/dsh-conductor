/**
 * How often each node kind was chosen, per archived round of the plugin.
 *
 * Reads every `*-on-*.json` record in every results directory, finds the session
 * it ran in, and counts the node kinds of each refine_plan call. A session that no
 * longer exists on disk is skipped and counted separately, so the totals say how
 * much of the archive they actually cover.
 *
 * Usage: node bench/kind-history.mjs
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const RESULTS = 'D:/code/vibe/dsh-refine-loop/bench/results'
const SESSIONS = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const LF = String.fromCharCode(10)

const ROUNDS = [
  ['v1.0', join(RESULTS, 'before-one-layer')],
  ['v2.0', join(RESULTS, 'v2.0')],
  ['v2.1-stale', join(RESULTS, 'v2.1-stale')],
  ['v2.1', join(RESULTS, 'v2.1')],
  ['v2.1-t6k', join(RESULTS, 'v2.1-t6k')],
  ['v2.1-compress', join(RESULTS, 'v2.1-compress')],
  ['v2.2', join(RESULTS, 'v2.2')],
  ['doctrine-v1', join(RESULTS, 'doctrine-v1')],
  ['pre-v2.3', join(RESULTS, 'pre-v2.3')],
  ['v2.4 (存档前)', join(RESULTS, 'taskfix-before')],
  ['v2.4', RESULTS],
]

const sessionDirs = readdirSync(SESSIONS)

/**
 * @param record - one bench record.
 * @returns the node kinds in its plan calls, or undefined when the session is gone.
 */
function kindsOf(record) {
  const dir = sessionDirs.find(entry => entry === record.sessionId
    || entry.startsWith(String(record.sessionId).slice(8, 21)))
  if (dir === undefined) return undefined
  let text = ''
  for (const file of readdirSync(join(SESSIONS, dir)).filter(entry => entry.endsWith('.zstd')).sort()) {
    try {
      text += decodeLog(join(SESSIONS, dir, file)) + LF
    } catch {
      // torn segment
    }
  }
  const kinds = []
  for (const line of text.split(LF)) {
    if (!line.includes('refine_plan')) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.type !== 'tool/call' || event.data?.name !== 'refine_plan') continue
    try {
      const plan = JSON.parse(String(event.data.arguments))
      for (const node of plan.nodes ?? []) kinds.push(node.kind)
    } catch {
      // refused
    }
  }
  return kinds
}

for (const [label, dir] of ROUNDS) {
  if (!existsSync(dir)) continue
  const counts = {}
  let covered = 0
  let missing = 0
  for (const name of readdirSync(dir).filter(entry => /-on-\d+\.json$/.test(entry))) {
    let record
    try {
      record = JSON.parse(readFileSync(join(dir, name), 'utf8'))
    } catch {
      continue
    }
    const kinds = kindsOf(record)
    if (kinds === undefined) {
      missing += 1
      continue
    }
    covered += 1
    for (const kind of kinds) counts[kind] = (counts[kind] ?? 0) + 1
  }
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0)
  const share = kind => total === 0 ? '0%' : `${Math.round(((counts[kind] ?? 0) / total) * 100)}%`
  console.log(`${label.padEnd(14)} 会话 ${covered}（丢失 ${missing}）`
    + ` | 节点 ${total}`
    + ` | tools ${counts.tools ?? 0} (${share('tools')})`
    + ` | worker ${counts.worker ?? 0} (${share('worker')})`
    + ` | spawner ${counts.spawner ?? 0}`
    + ` | forker ${counts.forker ?? 0}`)
}

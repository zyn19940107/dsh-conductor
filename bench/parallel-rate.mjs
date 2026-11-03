/**
 * How fast do parallel children actually produce tokens?
 *
 * Finds a run whose plan started several workers, then looks at the window in
 * which they overlap: total output tokens produced divided by that window,
 * beside each child's own rate. If the provider serves them truly in parallel
 * the aggregate scales; if it serialises, it does not.
 *
 * Usage: node bench/parallel-rate.mjs [minimumChildren]
 */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const ROOT = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const LF = String.fromCharCode(10)
const minimum = Number(process.argv[2] ?? 3)

/**
 * Every event of one session, every segment.
 *
 * @param dir - the session directory.
 * @returns the events.
 */
function eventsOf(dir) {
  const files = readdirSync(join(ROOT, dir)).filter(name => name.endsWith('.zstd')).sort()
  const events = []
  for (const name of files) {
    try {
      events.push(...decodeLog(join(ROOT, dir, name)).split(LF).filter(Boolean).map(line => {
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
  return events
}

const parents = new Map()
for (const dir of readdirSync(ROOT)) {
  const files = readdirSync(join(ROOT, dir)).filter(name => name.endsWith('.zstd'))
  if (files.length === 0) continue
  let events
  try {
    events = eventsOf(dir)
  } catch {
    continue
  }
  const header = events.find(event => event.type === 'session')
  if (header?.parentSession === undefined) continue
  const parent = header.parentSession
  const list = parents.get(parent) ?? []
  list.push({ dir, events, mtime: statSync(join(ROOT, dir, files[files.length - 1])).mtimeMs })
  parents.set(parent, list)
}

const candidates = [...parents.entries()]
  .map(([parent, children]) => {
    const workers = children.filter(child => {
      let cut = -1
      child.events.forEach((event, index) => { if (event.type === 'session/end-seed') cut = index })
      const own = child.events.slice(cut + 1)
      return JSON.stringify(own.slice(0, 6)).includes('refine-loop worker')
    })
    return { parent, workers, newest: Math.max(...children.map(child => child.mtime)) }
  })
  .filter(entry => entry.workers.length >= minimum)
  .sort((a, b) => b.newest - a.newest)

if (candidates.length === 0) {
  console.log('no run with ' + minimum + '+ parallel workers found')
  process.exit(0)
}

// Prefer the run whose parent asked for the review task, when it is there.
const REVIEW = '分别独立审查'
let chosen = candidates[0]
for (const candidate of candidates) {
  const dir = readdirSync(ROOT).find(name => name === candidate.parent)
  if (dir === undefined) continue
  const files = readdirSync(join(ROOT, dir)).filter(name => name.endsWith('.zstd'))
  if (files.length === 0) continue
  let text = ''
  try {
    for (const name of files) text += decodeLog(join(ROOT, dir, name)) + LF
  } catch {
    continue
  }
  if (text.includes(REVIEW)) { chosen = candidate; break }
}
console.log('run with ' + chosen.workers.length + ' workers, ' + new Date(chosen.newest).toISOString())

const rows = []
for (const worker of chosen.workers) {
  let cut = -1
  worker.events.forEach((event, index) => { if (event.type === 'session/end-seed') cut = index })
  const own = worker.events.slice(cut + 1)
  const steps = []
  let started = undefined
  for (const event of own) {
    if (event.type === 'step/start') started = event.time
    if (event.type === 'assistant/message' && started !== undefined) {
      const usage = event.data?.usage ?? {}
      steps.push({ from: started, to: event.time, out: usage.outputTokens ?? 0 })
      started = undefined
    }
  }
  if (steps.length === 0) continue
  const from = steps[0].from
  const to = steps[steps.length - 1].to
  const out = steps.reduce((sum, step) => sum + step.out, 0)
  rows.push({ id: worker.dir.slice(0, 12), from, to, out, steps: steps.length, own: (out / Math.max(1, (to - from) / 1000)).toFixed(1) })
}

if (rows.length === 0) {
  console.log('the workers produced no steps')
  process.exit(0)
}

const windowFrom = Math.min(...rows.map(row => row.from))
const windowTo = Math.max(...rows.map(row => row.to))
const windowSec = (windowTo - windowFrom) / 1000

// Only count a worker's output while it was actually running inside the window.
const totalOut = rows.reduce((sum, row) => sum + row.out, 0)
const totalWorkerSeconds = rows.reduce((sum, row) => sum + (row.to - row.from) / 1000, 0)

console.log()
console.log('worker           own window   own out  own tok/s')
for (const row of rows) {
  console.log(row.id.padEnd(14) + ' ' + String(((row.to - row.from) / 1000).toFixed(1)).padStart(9) + 's'
    + String(row.out).padStart(9) + ' ' + String(row.own).padStart(9))
}
console.log()
console.log('parallel window: ' + windowSec.toFixed(1) + 's')
console.log('sum of worker running time: ' + totalWorkerSeconds.toFixed(1) + 's  (parallelism: '
  + (totalWorkerSeconds / windowSec).toFixed(2) + 'x)')
console.log('sum of output tokens: ' + totalOut)
console.log('aggregate output rate over the window: ' + (totalOut / Math.max(1, windowSec)).toFixed(1) + ' tok/s')
console.log('mean single-worker rate: ' + (rows.reduce((sum, row) => sum + row.out / Math.max(1, (row.to - row.from) / 1000), 0) / rows.length).toFixed(1) + ' tok/s')

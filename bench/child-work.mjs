/**
 * What did a forked child actually do on its own?
 *
 * A forked child's log starts with the inherited prefix, so "how many steps did
 * it take" has to be counted after the last `session/end-seed` marker — and the
 * inherited events must not be mistaken for the child's own work.
 *
 * Usage: node bench/child-work.mjs <scenario> <off|on> [runIndex]
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const ROOT = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const RESULTS = 'D:/code/vibe/dsh-refine-loop/bench/results'
const LF = String.fromCharCode(10)
const scenario = process.argv[2] ?? 'review'
const arm = process.argv[3] ?? 'on'
const index = process.argv[4] ?? '1'

const record = JSON.parse(
  (await import('node:fs')).readFileSync(join(RESULTS, `${scenario}-${arm}-${index}.json`), 'utf8'),
)

/**
 * Every event of one session, every segment.
 *
 * @param dir - the session directory name.
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
      // a torn segment is skipped
    }
  }
  return events
}

const children = []
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
  if (header?.parentSession !== record.sessionId) continue
  children.push({ dir, events })
}

for (const child of children) {
  const events = child.events
  const header = events.find(event => event.type === 'session')
  // The child's own events are the ones after the last inherited marker.
  let cut = -1
  events.forEach((event, index) => { if (event.type === 'session/end-seed') cut = index })
  const own = cut === -1 ? events : events.slice(cut + 1)
  const inherited = cut === -1 ? [] : events.slice(0, cut)

  const ownSteps = own.filter(event => event.type === 'step/start').length
  const inheritedSteps = inherited.filter(event => event.type === 'step/start').length
  const ownCalls = own.filter(event => event.type === 'tool/call')
  const ownPlan = ownCalls.filter(event => event.data?.name === 'refine_plan').length
  const ownDoctrine = own.some(event => event.type === 'user/message'
    && JSON.stringify(event.data?.content ?? '').includes('Every round is the same four steps'))
  const ownTask = own.find(event => event.type === 'user/message'
    && JSON.stringify(event.data?.content ?? '').includes('refine-loop worker'))
  const removals = own
    .filter(event => event.type === 'developer/message')
    .flatMap(event => (event.data?.message?.content ?? []).filter(block => block.type === 'tool-removal'))
    .map(block => block.toolName)

  const first = own[0]?.time ?? 0
  const last = own[own.length - 1]?.time ?? first
  const ownMs = first === 0 ? 0 : last - first
  const usage = own.filter(event => event.type === 'assistant/message')
    .reduce((sum, event) => {
      const u = event.data?.usage ?? {}
      return {
        input: sum.input + (u.inputTokens ?? 0),
        cache: sum.cache + (u.cacheReadTokens ?? 0),
        output: sum.output + (u.outputTokens ?? 0),
      }
    }, { input: 0, cache: 0, output: 0 })

  console.log('child ' + child.dir.slice(0, 12)
    + ' inherited(events=' + inherited.length + ', steps=' + inheritedSteps + ', seeded=' + header.isSeeded + ')')
  console.log('   own: steps=' + ownSteps
    + '  calls=' + JSON.stringify(ownCalls.reduce((m, event) => {
      m[event.data.name] = (m[event.data.name] ?? 0) + 1
      return m
    }, {})))
  console.log('   own plan calls=' + ownPlan
    + '  doctrine=' + ownDoctrine
    + '  workerMarkerInOwn=' + (ownTask !== undefined)
    + '  removals=' + JSON.stringify(removals))
  console.log('   own wall=' + (ownMs / 1000).toFixed(1) + 's'
    + '  tokens in=' + usage.input + ' cache=' + usage.cache + ' out=' + usage.output)
  if (ownTask !== undefined) {
    const text = JSON.stringify(ownTask.data.content)
    console.log('   own task prompt: ' + text.slice(0, 200).replace(/\\n/g, ' '))
  }
  console.log()
}

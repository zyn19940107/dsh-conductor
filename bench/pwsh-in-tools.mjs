/**
 * Which v2.0 runs put `pwsh` inside a plan's `tools` node — the shape that hands
 * the raw command output to the main agent.
 *
 * Usage: node bench/pwsh-in-tools.mjs
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const RESULTS = 'D:/code/vibe/dsh-refine-loop/bench/results'
const SESSIONS = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const LF = String.fromCharCode(10)

/**
 * @param sessionId - the session id.
 * @returns the events.
 */
function eventsOf(sessionId) {
  const dir = readdirSync(SESSIONS).find(name => name === sessionId
    || name.startsWith(sessionId.slice(8, 21)))
  if (dir === undefined) return []
  const events = []
  for (const name of readdirSync(join(SESSIONS, dir)).filter(entry => entry.endsWith('.zstd')).sort()) {
    try {
      events.push(...decodeLog(join(SESSIONS, dir, name)).split(LF).filter(Boolean).map(line => {
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

const rows = []
for (const name of readdirSync(RESULTS)) {
  const match = /^(.*)-(on|off)-([0-9]+)\.json$/.exec(name)
  if (match === null || match[2] !== 'on') continue
  const record = JSON.parse(readFileSync(join(RESULTS, name), 'utf8'))
  const events = eventsOf(record.sessionId)
  if (events.length === 0) continue
  const planCalls = events.filter(event => event.type === 'tool/call' && event.data?.name === 'refine_plan')
  const pwshCalls = []
  for (const call of planCalls) {
    let plan
    try {
      plan = JSON.parse(call.data.arguments)
    } catch {
      continue
    }
    for (const node of plan.nodes ?? []) {
      if (node.kind !== 'tools') continue
      for (const entry of node.calls ?? []) {
        if (entry.name !== 'pwsh' && entry.name !== 'ops_bash') continue
        pwshCalls.push({ node: node.id, command: String(entry.arguments?.command ?? '').replace(/\s+/g, ' ') })
      }
    }
  }
  rows.push({ name, scenario: match[1], index: match[3], plans: planCalls.length, pwshCalls })
}

const withPwsh = rows.filter(row => row.pwshCalls.length > 0)
console.log('v2.0 运行总数:', rows.length, '| 其中在 tools 节点里用了 pwsh 的:', withPwsh.length)
console.log()
for (const row of withPwsh) {
  console.log(`${row.scenario} #${row.index}  （${row.plans} 个 plan，${row.pwshCalls.length} 条 pwsh 在 tools 节点里）`)
  for (const call of row.pwshCalls) {
    console.log('    [' + call.node + '] ' + call.command.slice(0, 150))
  }
}

// Which runs instead delegated a shell command to a worker/spawner/forker.
const delegated = []
for (const row of rows) {
  const record = JSON.parse(readFileSync(join(RESULTS, row.scenario + '-on-' + row.index + '.json'), 'utf8'))
  void record
}
console.log()
console.log('按场景统计（tools 节点里的 pwsh 条数）：')
const byScenario = new Map()
for (const row of rows) {
  const entry = byScenario.get(row.scenario) ?? { runs: 0, withPwsh: 0, commands: 0, samples: [] }
  entry.runs += 1
  if (row.pwshCalls.length > 0) {
    entry.withPwsh += 1
    entry.commands += row.pwshCalls.length
    entry.samples.push('#' + row.index + ':' + row.pwshCalls.length)
  }
  byScenario.set(row.scenario, entry)
}
for (const [scenario, entry] of [...byScenario.entries()].sort((a, b) => b[1].withPwsh - a[1].withPwsh)) {
  if (entry.withPwsh === 0) continue
  console.log('  ' + scenario.padEnd(15) + entry.withPwsh + '/' + entry.runs + ' 次运行用到，共 '
    + entry.commands + ' 条（' + entry.samples.join(' ') + '）')
}

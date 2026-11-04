/**
 * How fast the provider was generating, per run.
 *
 * Wall time mixes three things: the tool work, the model's thinking, and how fast
 * the provider serves tokens that hour. The first two are the benchmark; the
 * third is the environment. This prints the third one for every recorded run, so
 * a wall-clock comparison can be read against the speed it was measured at.
 *
 * Usage: node bench/speed.mjs
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const RESULTS = 'D:/code/vibe/dsh-refine-loop/bench/results'
const V20 = join(RESULTS, 'v2.0')
const OLD = join(RESULTS, 'before-one-layer')
const SESSIONS = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const LF = String.fromCharCode(10)

/**
 * @param dir - where the records live.
 * @param name - the record name.
 * @returns the run's speed, or undefined when the session is gone.
 */
function speedOf(dir, name) {
  let record
  try {
    record = JSON.parse(readFileSync(join(dir, name), 'utf8'))
  } catch {
    return undefined
  }
  const session = readdirSync(SESSIONS).find(entry => entry === record.sessionId
    || entry.startsWith(record.sessionId.slice(8, 21)))
  if (session === undefined) return undefined
  const events = []
  for (const file of readdirSync(join(SESSIONS, session)).filter(entry => entry.endsWith('.zstd')).sort()) {
    try {
      events.push(...decodeLog(join(SESSIONS, session, file)).split(LF).filter(Boolean).map(line => {
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
  let modelMs = 0
  let output = 0
  let start = 0
  for (const event of events) {
    if (event.type === 'step/start') start = event.timestamp ?? event.time ?? 0
    if (event.type !== 'assistant/message') continue
    const usage = event.data?.usage ?? {}
    output += usage.outputTokens ?? 0
    modelMs += (event.timestamp ?? event.time ?? 0) - start
  }
  if (modelMs <= 0 || output <= 0) return undefined
  return { output, modelMs, speed: output / (modelMs / 1000) }
}

const rows = []
for (const [label, dir] of [['v1.0', OLD], ['v2.0', V20], ['v2.1', RESULTS]]) {
  for (const name of readdirSync(dir)) {
    const match = /^(.*)-(on|off)-([0-9]+)\.json$/.exec(name)
    if (match === null) continue
    if (label === 'v2.1' && match[2] === 'off') continue
    const speed = speedOf(dir, name)
    if (speed === undefined) continue
    rows.push({ label, scenario: match[1], arm: match[2], index: match[3], ...speed })
  }
}
rows.sort((a, b) => a.speed - b.speed)

console.log('按生成速度排序（tok/s = 输出 token / 模型耗时）\n')
console.log('  版本   场景            臂   输出     模型耗时   速度')
for (const row of rows) {
  console.log('  ' + row.label.padEnd(6)
    + row.scenario.padEnd(16)
    + row.arm.padEnd(4)
    + String(Math.round(row.output / 1000) + 'k').padStart(6)
    + String((row.modelMs / 1000).toFixed(0) + 's').padStart(10)
    + String(row.speed.toFixed(0)).padStart(8) + ' tok/s')
}

const speeds = rows.map(row => row.speed)
const mean = speeds.reduce((sum, value) => sum + value, 0) / speeds.length
console.log(`\n中位数 ${speeds.sort((a, b) => a - b)[Math.floor(speeds.length / 2)].toFixed(0)} tok/s`
  + `  平均 ${mean.toFixed(0)} tok/s  n=${rows.length}`)

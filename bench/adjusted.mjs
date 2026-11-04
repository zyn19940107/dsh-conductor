/**
 * The benchmark's wall times, normalised to one token speed.
 *
 * Wall time = tool work + model time. The model time depends on how fast the
 * provider served tokens that hour, which was measured between 51 and 290
 * tok/s across this benchmark — so a raw wall-clock comparison between two runs
 * made hours apart measures the provider as much as the plugin.
 *
 * This removes that variable: every run's own model time is replaced by the time
 * it would have taken at a fixed speed, while its tool work is left alone.
 *
 *   adjusted = (wall - model time) + output tokens / speed
 *
 * Usage: node bench/adjusted.mjs [speed] [task ...]
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const RESULTS = 'D:/code/vibe/dsh-refine-loop/bench/results'
const V20 = join(RESULTS, 'v2.0')
const OLD = join(RESULTS, 'before-one-layer')
const SESSIONS = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const LF = String.fromCharCode(10)
const SPEED = Number(process.argv[2] ?? '160')
const ONLY = process.argv.slice(3)

/**
 * @param dir - where the record lives.
 * @param name - the record name.
 * @returns the run's timing split, or undefined when the session is gone.
 */
function timingOf(dir, name) {
  let record
  try {
    record = JSON.parse(readFileSync(join(dir, name), 'utf8'))
  } catch {
    return undefined
  }
  /**
   * The model time and output of one session log.
   *
   * @param session - the session directory name.
   * @returns the model milliseconds and output tokens.
   */
  function measure(session) {
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
    return { modelMs, output }
  }

  const session = readdirSync(SESSIONS).find(entry => entry === record.sessionId
    || entry.startsWith(record.sessionId.slice(8, 21)))
  if (session === undefined) return undefined
  // The whole session tree: a child's model time is model time too, not tool work.
  const tree = [session]
  const all = readdirSync(SESSIONS)
  for (const entry of all) {
    if (!entry.startsWith('refine-loop-child-')) continue
    try {
      const header = JSON.parse(decodeLog(join(SESSIONS, entry, readdirSync(join(SESSIONS, entry)).filter(name => name.endsWith('.zstd')).sort()[0])).split(LF)[0])
      voider(header)
    } catch {
      // not a readable header
    }
    const h = (() => {
      try {
        const file = readdirSync(join(SESSIONS, entry)).filter(name => name.endsWith('.zstd')).sort()[0]
        const first = decodeLog(join(SESSIONS, entry, file)).split(LF).filter(Boolean).map(line => {
          try {
            return JSON.parse(line)
          } catch {
            return null
          }
        }).filter(Boolean).find(event => event.type === 'session')
        return first
      } catch {
        return undefined
      }
    })()
    const parent = h?.parentSession ?? h?.header?.parentSession ?? h?.data?.parentSession
    if (parent === record.sessionId) tree.push(entry)
  }
  let modelMs = 0
  let output = 0
  for (const entry of tree) {
    const measured = measure(entry)
    modelMs += measured.modelMs
    output += measured.output
  }
  /** @param value - unused. */
  function voider(value) { void value }
  if (output <= 0 || modelMs <= 0) return undefined
  const wall = record.wallMs
  const toolMs = wall - modelMs
  const adjusted = toolMs + output / SPEED * 1000
  return { wall, modelMs, toolMs, output, adjusted, speed: output / (modelMs / 1000) }
}

/**
 * @param values - the numbers.
 * @returns the median.
 */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 0) return undefined
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

const groups = [
  ['off', RESULTS, 'off'],
  ['v1.0', OLD, 'on'],
  ['v2.0', V20, 'on'],
  ['v2.1', RESULTS, 'on'],
]

const scenarios = new Map()
for (const [label, dir, arm] of groups) {
  for (const name of readdirSync(dir)) {
    const match = /^(.*)-(on|off)-([0-9]+)\.json$/.exec(name)
    if (match === null || match[2] !== arm) continue
    const scenario = match[1]
    if (ONLY.length > 0 && !ONLY.includes(scenario)) continue
    const timing = timingOf(dir, name)
    if (timing === undefined) continue
    if (!scenarios.has(scenario)) scenarios.set(scenario, new Map())
    const versions = scenarios.get(scenario)
    if (!versions.has(label)) versions.set(label, [])
    versions.get(label).push(timing)
  }
}

console.log(`按 ${SPEED} tok/s 归一的耗时（中位数，秒）—— 工具时间原样，模型时间按固定速度重算\n`)
console.log('  场景             版本    实测   归一   模型   工具   平均速度')
for (const [scenario, versions] of scenarios) {
  for (const [label] of [['off'], ['v1.0'], ['v2.0'], ['v2.1']]) {
    const runs = versions.get(label)
    if (runs === undefined) continue
    console.log('  ' + scenario.padEnd(16) + label.padEnd(7)
      + String((median(runs.map(r => r.wall)) / 1000).toFixed(0)).padStart(6)
      + String((median(runs.map(r => r.adjusted)) / 1000).toFixed(0)).padStart(7)
      + String((median(runs.map(r => r.modelMs)) / 1000).toFixed(0)).padStart(7)
      + String((median(runs.map(r => r.toolMs)) / 1000).toFixed(0)).padStart(7)
      + String(median(runs.map(r => r.speed)).toFixed(0)).padStart(9) + ' tok/s')
  }
}

/**
 * Fit token counts to model wait time, so normalisation can price input too.
 *
 * The normaliser replaces a session's model wait with its output at a fixed
 * speed. That treats prompt processing as free, which is close enough for a run
 * with small prompts and wrong for a run whose children inherit millions of
 * cached tokens: the wait is real, and the formula drops all of it.
 *
 * This reads the per-step usage and wall time from the recorded sessions and
 * fits model_ms ≈ intercept + input/speed_in + cache/speed_cache + output/speed_out.
 * The coefficients are then the speeds the normaliser should use.
 *
 * Usage: node bench/fit-speed.mjs
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const SESSIONS = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const RESULTS = 'D:/code/vibe/dsh-refine-loop/bench/results'
const LF = String.fromCharCode(10)

/**
 * @param session - the session directory name.
 * @returns its events.
 */
function eventsOf(session) {
  const events = []
  let files = []
  try {
    files = readdirSync(join(SESSIONS, session)).filter(entry => entry.endsWith('.zstd')).sort()
  } catch {
    return events
  }
  for (const file of files) {
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
  return events
}

/**
 * One sample per assistant message: the tokens the request carried and the wait
 * it took.
 *
 * @param events - a session's events.
 * @returns the samples.
 */
function samplesOf(events) {
  const samples = []
  let start = 0
  for (const event of events) {
    const at = event.timestamp ?? event.time ?? 0
    if (event.type === 'step/start') start = at
    if (event.type !== 'assistant/message' || start <= 0) continue
    const usage = event.data?.usage ?? {}
    samples.push({
      wait: at - start,
      input: usage.inputTokens ?? 0,
      cache: usage.cacheReadTokens ?? 0,
      output: usage.outputTokens ?? 0,
    })
  }
  return samples
}

const samples = []
for (const name of readdirSync(RESULTS)) {
  if (!/-on-\d+\.json$/.test(name)) continue
  let record
  try {
    record = JSON.parse(readFileSync(join(RESULTS, name), 'utf8'))
  } catch {
    continue
  }
  const parent = readdirSync(SESSIONS).find(entry => entry === record.sessionId
    || entry.startsWith(String(record.sessionId).slice(8, 21)))
  if (parent === undefined) continue
  samples.push(...samplesOf(eventsOf(parent)))
  for (const entry of readdirSync(SESSIONS).filter(item => item.startsWith('refine-loop-child-'))) {
    const events = eventsOf(entry)
    const header = events.find(event => event.type === 'session')
    if ((header?.data?.parentSession ?? header?.parentSession) !== record.sessionId) continue
    const boundary = events.findIndex(event => String(event.type).includes('end-seed'))
    samples.push(...samplesOf(boundary < 0 ? events : events.slice(boundary + 1)))
  }
}

console.log(`样本 ${samples.length} 步`)

// Ordinary least squares: wait = b0 + b1*prompt + b2*output, where prompt is
// input plus cache reads. Input and cache are nearly collinear (a cache read is
// a prompt whose tokens were seen before), and fitting them apart gives the
// cache a negative speed; together they price the whole prompt.
const rows = samples.map(sample => [1, sample.input + sample.cache, sample.output])
const ys = samples.map(sample => sample.wait)
const k = 3
const xtx = Array.from({ length: k }, () => Array(k).fill(0))
const xty = Array(k).fill(0)
for (let index = 0; index < rows.length; index += 1) {
  const row = rows[index]
  for (let a = 0; a < k; a += 1) {
    xty[a] += row[a] * ys[index]
    for (let b = 0; b < k; b += 1) xtx[a][b] += row[a] * row[b]
  }
}

// Gaussian elimination.
const matrix = xtx.map((line, index) => [...line, xty[index]])
for (let col = 0; col < k; col += 1) {
  let pivot = col
  for (let row = col + 1; row < k; row += 1) if (Math.abs(matrix[row][col]) > Math.abs(matrix[pivot][col])) pivot = row
  const swap = matrix[col]
  matrix[col] = matrix[pivot]
  matrix[pivot] = swap
  const scale = matrix[col][col]
  for (let cell = col; cell <= k; cell += 1) matrix[col][cell] /= scale
  for (let row = 0; row < k; row += 1) {
    if (row === col) continue
    const factor = matrix[row][col]
    for (let cell = col; cell <= k; cell += 1) matrix[row][cell] -= factor * matrix[col][cell]
  }
}
const [b0, b1, b2] = matrix.map(line => line[k])

console.log(`wait_ms = ${b0.toFixed(0)} + prompt×${b1.toFixed(4)} + output×${b2.toFixed(4)}`)
console.log(`即 提示 ${(1000 / b1).toFixed(0)} tok/s，输出 ${(1000 / b2).toFixed(0)} tok/s，固定开销 ${b0.toFixed(0)} ms`)

// How much of the wait the model explains.
const mean = ys.reduce((sum, value) => sum + value, 0) / ys.length
let residual = 0
let total = 0
for (let index = 0; index < rows.length; index += 1) {
  const predicted = rows[index].reduce((sum, value, at) => sum + value * [b0, b1, b2][at], 0)
  residual += (ys[index] - predicted) ** 2
  total += (ys[index] - mean) ** 2
}
console.log(`R² = ${(1 - residual / total).toFixed(3)}`)

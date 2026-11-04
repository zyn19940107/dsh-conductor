/**
 * Re-run coverage and review on the plugin arm with the current build (v2.1),
 * archiving the v2.0 records first and printing the two versions side by side.
 *
 * Only the `on` arm is re-run: the off arm is the harness with the plugin
 * removed, and the plugin's version cannot change it.
 *
 * Usage: node bench/rerun-v21.mjs [runs]
 */

import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RESULTS = join(HERE, 'results')
const ARCHIVE = join(RESULTS, 'v2.0')
const RUNS = Number(process.argv[2] ?? '5')
const TASKS = ['coverage', 'review']

mkdirSync(ARCHIVE, { recursive: true })
for (const task of TASKS) {
  for (let index = 1; index <= RUNS; index += 1) {
    const name = `${task}-on-${index}.json`
    const from = join(RESULTS, name)
    if (existsSync(from)) copyFileSync(from, join(ARCHIVE, name))
  }
}
console.log('v2.0 records archived to bench/results/v2.0/')

/**
 * @param task - the task.
 * @param index - the sample number.
 * @returns the record it wrote.
 */
async function runOne(task, index) {
  const child = spawn(process.execPath, [join(HERE, 'run-one.mjs'), task, 'on', String(index)], {
    cwd: resolve(HERE, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', chunk => { out += chunk.toString() })
  child.stderr.on('data', chunk => { out += chunk.toString() })
  const code = await new Promise(resolve => child.on('close', resolve))
  const record = JSON.parse(readFileSync(join(RESULTS, `${task}-on-${index}.json`), 'utf8'))
  console.log(`${task} on-${index}: exit=${code} wall=${(record.wallMs / 1000).toFixed(0)}s `
    + `steps=${record.steps} agents=${record.formation?.agents} correct=${record.correctness?.passed}/${record.correctness?.total}`)
  return record
}

for (const task of TASKS) {
  for (let index = 1; index <= RUNS; index += 1) await runOne(task, index)
}

/**
 * @param path - a record path.
 * @returns the record, or undefined.
 */
function read(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * @param records - the records.
 * @param pick - the value.
 * @returns the median.
 */
function median(records, pick) {
  const values = records.map(pick).filter(value => Number.isFinite(value)).sort((a, b) => a - b)
  if (values.length === 0) return undefined
  const mid = Math.floor(values.length / 2)
  return values.length % 2 === 0 ? (values[mid - 1] + values[mid]) / 2 : values[mid]
}

console.log('\n=== v2.0 vs v2.1（on 臂，中位数）===')
for (const task of TASKS) {
  const old = Array.from({ length: RUNS }, (_, i) => read(join(ARCHIVE, `${task}-on-${i + 1}.json`))).filter(Boolean)
  const fresh = Array.from({ length: RUNS }, (_, i) => read(join(RESULTS, `${task}-on-${i + 1}.json`))).filter(Boolean)
  const fields = [
    ['耗时', record => record.wallMs / 1000, 's'],
    ['编队 token', record => record.formation?.total, 'k'],
    ['主 agent context', record => record.mainPrompt, 'k'],
    ['主 agent 步数', record => record.steps, ''],
  ]
  for (const [label, pick, unit] of fields) {
    const before = median(old, pick)
    const after = median(fresh, pick)
    const scale = unit === 'k' ? 1000 : 1
    console.log(`${task} ${label.padEnd(16)} v2.0 ${(before / scale).toFixed(unit === 'k' ? 0 : 1)}${unit}`
      + ` → v2.1 ${(after / scale).toFixed(unit === 'k' ? 0 : 1)}${unit}`
      + `  (${((after - before) / before * 100).toFixed(0)}%)`)
  }
  console.log(`${task} 正确性             v2.0 ${old.map(r => r.correctness?.passed).join('/')}`
    + ` → v2.1 ${fresh.map(r => r.correctness?.passed).join('/')}`)
}

void readdirSync

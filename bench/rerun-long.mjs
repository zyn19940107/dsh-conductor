/**
 * Re-run the long-horizon tasks the plan report was truncated on, on the current
 * build (v2.1), and print the v2.0 / v2.1 comparison.
 *
 * Only `lhtb-matpower` and `lhtb-commit0` are re-run: they are the long-horizon
 * tasks the plugin wins, and matpower is the one whose reports were being cut
 * (3 of 8). `lhtb-nbody` had none, so it is left alone.
 *
 * Usage: node bench/rerun-long.mjs [runs]
 */

import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeLog } from './sessions.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const RESULTS = join(HERE, 'results')
const V20 = join(RESULTS, 'v2.0')
const SESSIONS = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const LF = String.fromCharCode(10)
const RUNS = Number(process.argv[2] ?? '2')
const TASKS = ['lhtb-matpower', 'lhtb-commit0']

mkdirSync(V20, { recursive: true })
for (const task of TASKS) {
  for (let index = 1; index <= RUNS; index += 1) {
    const name = `${task}-on-${index}.json`
    const from = join(RESULTS, name)
    if (existsSync(from) && !existsSync(join(V20, name))) copyFileSync(from, join(V20, name))
  }
}
console.log('v2.0 long-horizon records archived')

for (const task of TASKS) {
  for (let index = 1; index <= RUNS; index += 1) {
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
      + `steps=${record.steps} agents=${record.formation?.agents} `
      + `correct=${record.correctness?.passed}/${record.correctness?.total}`)
  }
}

/**
 * The plan reports of one run: how many, how big, how many truncated.
 *
 * @param record - the bench record.
 * @returns the counts, or undefined when the session is gone.
 */
function plansOf(record) {
  const dir = readdirSync(SESSIONS).find(name => name === record.sessionId
    || name.startsWith(record.sessionId.slice(8, 21)))
  if (dir === undefined) return undefined
  const events = []
  for (const file of readdirSync(join(SESSIONS, dir)).filter(name => name.endsWith('.zstd')).sort()) {
    try {
      events.push(...decodeLog(join(SESSIONS, dir, file)).split(LF).filter(Boolean).map(line => {
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
  const open = new Map()
  const sizes = []
  let truncated = 0
  for (const event of events) {
    if (event.type === 'tool/call') open.set(String(event.data?.callId), event.data?.name)
    if (event.type !== 'tool/result') continue
    if (open.get(String(event.data?.message?.toolCallId ?? '')) !== 'refine_plan') continue
    const text = (event.data?.message?.content ?? []).map(block => block.text ?? '').join('')
    sizes.push(text.length)
    if (text.includes('Omitted')) truncated += 1
  }
  return { sizes, truncated }
}

/**
 * @param records - the records.
 * @param pick - the value.
 * @returns the mean (these tasks have two samples, so a mean says more than one of them).
 */
function mean(records, pick) {
  const values = records.map(pick).filter(value => Number.isFinite(value))
  return values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length
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

console.log('\n=== v2.0 vs v2.1（长程题，on 臂，均值）===')
for (const task of TASKS) {
  const before = Array.from({ length: RUNS }, (_, i) => read(join(V20, `${task}-on-${i + 1}.json`))).filter(Boolean)
  const after = Array.from({ length: RUNS }, (_, i) => read(join(RESULTS, `${task}-on-${i + 1}.json`))).filter(Boolean)
  const fields = [
    ['耗时', record => record.wallMs / 1000, 's'],
    ['编队 token', record => record.formation?.total, 'k'],
    ['主 agent context', record => record.mainPrompt, 'k'],
    ['主 agent 步数', record => record.steps, ''],
    ['编队人数', record => record.formation?.agents, ''],
  ]
  for (const [label, pick, unit] of fields) {
    const a = mean(before, pick)
    const b = mean(after, pick)
    const scale = unit === 'k' ? 1000 : 1
    console.log(`${task.padEnd(14)} ${label.padEnd(16)} v2.0 ${(a / scale).toFixed(unit === 'k' ? 0 : 1)}${unit}`
      + ` → v2.1 ${(b / scale).toFixed(unit === 'k' ? 0 : 1)}${unit}`
      + `  (${((b - a) / a * 100).toFixed(0)}%)`)
  }
  console.log(`${task.padEnd(14)} 正确性             v2.0 ${before.map(r => `${r.correctness?.passed}/${r.correctness?.total}`).join(' ')}`
    + ` → v2.1 ${after.map(r => `${r.correctness?.passed}/${r.correctness?.total}`).join(' ')}`)
  const plansBefore = before.map(plansOf).filter(Boolean)
  const plansAfter = after.map(plansOf).filter(Boolean)
  const count = entries => entries.reduce((sum, entry) => sum + entry.sizes.length, 0)
  const cut = entries => entries.reduce((sum, entry) => sum + entry.truncated, 0)
  console.log(`${task.padEnd(14)} 报告截断           v2.0 ${cut(plansBefore)}/${count(plansBefore)}`
    + ` → v2.1 ${cut(plansAfter)}/${count(plansAfter)}`)
  console.log(`${task.padEnd(14)} 报告尺寸           v2.0 ${plansBefore.flatMap(e => e.sizes).map(s => (s / 1000).toFixed(1) + 'k').join(' / ')}`)
  console.log(`${task.padEnd(14)}                    v2.1 ${plansAfter.flatMap(e => e.sizes).map(s => (s / 1000).toFixed(1) + 'k').join(' / ')}`)
}

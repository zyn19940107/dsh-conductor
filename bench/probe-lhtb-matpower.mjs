/**
 * Prove the MATPOWER judge works before a model run spends anything on it.
 *
 * Upstream's reference implementation must pass the whole verifier; the
 * skeleton must pass none of it.
 *
 * Usage: node bench/probe-lhtb-matpower.mjs
 */

import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { TASKS } from './task.mjs'

process.env.DSH_BENCH_CONDITION = 'probe'
const SANDBOX_HOME = process.env.DSH_SANDBOX_HOME ?? 'D:/code/vibe/dsh-sandbox/home'
const ASSETS = process.env.DSH_MATPOWER_ASSETS ?? resolve(SANDBOX_HOME, '..', 'lhtb', 'matpower')
const REFERENCE = resolve(ASSETS, 'solution', 'audit.py')

const task = TASKS['lhtb-matpower']
if (task === undefined) {
  console.error('the lhtb-matpower task is not registered')
  process.exit(2)
}

task.setup()
const ws = task.text.match(/工作区 (\S+)/)?.[1]
if (ws === undefined) {
  console.error('the task text does not name a workspace')
  process.exit(2)
}

if (!existsSync(REFERENCE)) {
  console.error(`the reference implementation is missing: ${REFERENCE}`)
  process.exit(2)
}

// The oracle: upstream's reference implementation must pass the verifier.
cpSync(REFERENCE, resolve(ws, 'src', 'power_audit', 'audit.py'))
const good = task.judge('reference implementation')
console.log(`reference implementation -> ${JSON.stringify(good)}`)

// The skeleton: nothing implemented.
task.setup()
const stub = task.judge('skeleton')
console.log(`skeleton                 -> ${JSON.stringify(stub)}`)

const ok = good.passed === good.total && stub.passed === 0
console.log(ok ? 'PROBE OK' : 'PROBE FAILED')
process.exit(ok ? 0 : 1)

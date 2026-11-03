/**
 * Prove the commit0 judge works before a model run spends anything on it.
 *
 * The pristine upstream sources are the judge's oracle: the hidden suites must
 * pass all 784 of them. The stubbed workspace must score zero. And a
 * submission that copies one upstream file must be caught, with the reward
 * voided the way upstream voids it.
 *
 * Usage: node bench/probe-lhtb-commit0.mjs
 */

import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { TASKS } from './task.mjs'

process.env.DSH_BENCH_CONDITION = 'probe'
const SANDBOX_HOME = process.env.DSH_SANDBOX_HOME ?? 'D:/code/vibe/dsh-sandbox/home'
const ASSETS = process.env.DSH_COMMIT0_ASSETS ?? resolve(SANDBOX_HOME, '..', 'lhtb', 'commit0')
const ORACLE = process.env.DSH_COMMIT0_ORACLE ?? resolve(SANDBOX_HOME, '..', '.oracle-9c41')
const REFERENCE = resolve(ORACLE, 'reference')

const task = TASKS['lhtb-commit0']
if (task === undefined) {
  console.error('the lhtb-commit0 task is not registered')
  process.exit(2)
}

task.setup()
const ws = task.text.match(/工作区 (\S+)/)?.[1]
if (ws === undefined) {
  console.error('the task text does not name a workspace')
  process.exit(2)
}

if (!existsSync(REFERENCE)) {
  console.error(`the reference sources are missing: ${REFERENCE}`)
  process.exit(2)
}

// The oracle: the pristine upstream sources must pass the whole hidden suite.
rmSync(resolve(ws, 'libs'), { recursive: true, force: true })
cpSync(resolve(REFERENCE, 'libs'), resolve(ws, 'libs'), { recursive: true })
const good = task.judge('reference sources')
console.log(`reference sources -> raw ${good.rawScore}, self-written ${good.voidedScore} `
  + `(${good.passed}/${good.total}), copied: ${JSON.stringify(good.copied)}`)

// The stubbed workspace: nothing implemented.
task.setup()
const stub = task.judge('stubbed workspace')
console.log(`stubbed workspace  -> raw ${stub.rawScore}, self-written ${stub.voidedScore} `
  + `(${stub.passed}/${stub.total})`)

// A submission that copies one upstream file verbatim.
task.setup()
const upstream = resolve(REFERENCE, 'libs', 'cachetools', 'src', 'cachetools', 'func.py')
const target = resolve(ws, 'libs', 'cachetools', 'src', 'cachetools', 'func.py')
writeFileSync(target, readFileSync(upstream))
const copied = task.judge('copied file')
console.log(`copied one file   -> raw ${copied.rawScore}, self-written ${copied.voidedScore}, `
  + `flagged: ${JSON.stringify(copied.copied)}`)

const ok = good.rawScore === 1 && good.copied.length === 3 && good.voidedScore === 0
  && stub.rawScore === 0 && stub.passed === 0
  && copied.copied.length > 0
  && copied.missing.some(line => line.includes('抄了上游源码'))
console.log(ok ? 'PROBE OK' : 'PROBE FAILED')
process.exit(ok ? 0 : 1)

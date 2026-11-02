/**
 * Prove the N-body judge works before a model run spends anything on it.
 *
 * The reference submission is a known-good one (the upstream numpy baseline):
 * the judge must score it above zero. A submission that returns nothing must
 * score zero. A judge that cannot tell those apart would publish a score
 * column that means nothing.
 *
 * Usage: node bench/probe-lhtb-nbody.mjs
 */

import { cpSync, existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { TASKS } from './task.mjs'

process.env.DSH_BENCH_CONDITION = 'probe'
const SANDBOX_HOME = process.env.DSH_SANDBOX_HOME ?? 'D:/code/vibe/dsh-sandbox/home'
const ASSETS = process.env.DSH_NBODY_ASSETS ?? resolve(SANDBOX_HOME, '..', 'lhtb', 'nbody')
const REFERENCE = resolve(ASSETS, 'reference_simulator.py')

const task = TASKS['lhtb-nbody']
if (task === undefined) {
  console.error('the lhtb-nbody task is not registered')
  process.exit(2)
}

task.setup()
const ws = task.text.match(/工作区 (\S+)/)?.[1]
if (ws === undefined) {
  console.error('the task text does not name a workspace')
  process.exit(2)
}

if (!existsSync(REFERENCE)) {
  console.error(`the reference submission is missing: ${REFERENCE}`)
  process.exit(2)
}

cpSync(REFERENCE, resolve(ws, 'simulator.py'))
const good = task.judge('reference submission')
console.log(`reference submission -> ${JSON.stringify(good)}`)

writeFileSync(resolve(ws, 'simulator.py'), `
class Simulator:
    def __init__(self, particles, params):
        self.particles = particles

    def simulate_step(self):
        return []
`)
const bad = task.judge('empty submission')
console.log(`empty submission      -> ${JSON.stringify(bad)}`)

const ok = good.passed === good.total && good.score > 0 && bad.passed === 0
console.log(ok ? 'PROBE OK' : 'PROBE FAILED')
process.exit(ok ? 0 : 1)

/**
 * Prove the 2048 judge works before a model run spends anything on it.
 *
 * The reference player is a known-good run: it plays a real game and its move
 * log must score above zero when the judge replays it. A judge that cannot
 * tell that from an empty log would publish a score column that means nothing.
 *
 * Usage: node bench/probe-lhtb.mjs
 */

import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { TASKS } from './task.mjs'

process.env.DSH_BENCH_CONDITION = 'probe'
const SANDBOX_HOME = process.env.DSH_SANDBOX_HOME ?? 'D:/code/vibe/dsh-sandbox/home'
const ASSETS = process.env.DSH_LHTB_ASSETS ?? resolve(SANDBOX_HOME, '..', 'lhtb', '2048')
const REFERENCE = resolve(ASSETS, 'reference_moves.log')

const task = TASKS['lhtb-2048']
if (task === undefined) {
  console.error('the lhtb-2048 task is not registered')
  process.exit(2)
}

task.setup()
const ws = task.text.match(/工作区 (\S+)/)?.[1]
if (ws === undefined) {
  console.error('the task text does not name a workspace')
  process.exit(2)
}

if (!existsSync(REFERENCE)) {
  console.error(`the reference move log is missing: ${REFERENCE}`)
  console.error('run: python reference_player.py 500')
  process.exit(2)
}

// The reference run: a real game, replayed by the judge.
cpSync(REFERENCE, resolve(ws, 'moves.log'))
const good = task.judge('reference player')
console.log(`reference player -> ${JSON.stringify(good)}`)

// An empty run: the agent never played.
writeFileSync(resolve(ws, 'moves.log'), '')
const empty = task.judge('empty log')
console.log(`empty log        -> ${JSON.stringify(empty)}`)

// A tampered engine: the agent edited the rules.
task.setup()
cpSync(REFERENCE, resolve(ws, 'moves.log'))
const engine = resolve(ws, 'game2048_engine.py')
writeFileSync(engine, `${readFileSync(engine, 'utf8')}\n# tampered\n`)
const tampered = task.judge('tampered engine')
console.log(`tampered engine  -> ${JSON.stringify(tampered)}`)

const ok = good.passed > 0 && empty.passed === 0 && tampered.missing.length > 0
console.log(ok ? 'PROBE OK' : 'PROBE FAILED')
process.exit(ok ? 0 : 1)

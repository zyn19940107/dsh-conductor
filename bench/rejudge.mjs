/**
 * Re-judge a finished run and update its record.
 *
 * The judge can change between runs (a path fix, a stricter check). This
 * re-runs the judge over the workspace that run left behind and rewrites the
 * `correctness` block of its record, so the numbers in the README always come
 * from the same judge.
 *
 * Usage: node bench/rejudge.mjs <task> <condition> <index>
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { TASKS } from './task.mjs'

const taskName = process.argv[2]
const condition = process.argv[3]
const index = process.argv[4] ?? '1'

const task = TASKS[taskName]
if (task === undefined) {
  console.error(`unknown task: ${taskName}`)
  process.exit(2)
}

process.env.DSH_BENCH_CONDITION = condition
const verdict = task.judge(`re-judge ${taskName} ${condition} ${index}`)

const recordPath = resolve(import.meta.dirname, 'results', `${taskName}-${condition}-${index}.json`)
const record = JSON.parse(readFileSync(recordPath, 'utf8'))
record.correctness = {
  ...record.correctness,
  passed: verdict.passed,
  total: verdict.total,
  missing: verdict.missing,
  ...(verdict.score === undefined ? {} : { score: verdict.score }),
  ...(verdict.rawScore === undefined ? {} : { rawScore: verdict.rawScore }),
  ...(verdict.voidedScore === undefined ? {} : { voidedScore: verdict.voidedScore }),
  ...(verdict.copied === undefined ? {} : { copied: verdict.copied }),
}
record.rejudged = true
writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8')

console.log(`${recordPath}: ${JSON.stringify(record.correctness)}`)

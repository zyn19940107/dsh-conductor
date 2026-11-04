/**
 * Re-score bench records against the current judge, from the session logs.
 *
 * A record keeps only the first 4000 characters of the final answer, and the
 * judge runs on the whole one. This reads the whole answer back out of the
 * session log and applies the task's own judge, so a criterion whose wording was
 * widened can be re-checked without re-running the model.
 *
 * Usage: node bench/rescore.mjs [task ...]
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'
import { TASKS } from './task.mjs'

const RESULTS = 'D:/code/vibe/dsh-refine-loop/bench/results'
const ARCHIVE = join(RESULTS, 'v2.0')
const SESSIONS = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const LF = String.fromCharCode(10)
const tasks = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['review']

/**
 * The whole final answer of a run, read from its own session.
 *
 * @param record - the bench record.
 * @returns the text, or undefined when the session is gone.
 */
function answerOf(record) {
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
  const messages = events.filter(event => event.type === 'assistant/message')
  const last = messages[messages.length - 1]
  const content = last?.data?.message?.content ?? last?.data?.content ?? []
  return content.map(block => block.text ?? '').join('')
}

for (const task of tasks) {
  const definition = TASKS[task]
  if (definition?.judge === undefined) {
    console.log(`${task}: no judge`)
    continue
  }
  console.log(`\n===== ${task} =====`)
  for (const [label, dir] of [['v2.0', ARCHIVE], ['v2.1', RESULTS]]) {
    const rows = []
    for (const name of readdirSync(dir).filter(entry => entry.startsWith(`${task}-on-`)).sort()) {
      const record = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      const answer = answerOf(record)
      if (answer === undefined) {
        rows.push(`${name}: 会话已不在`)
        continue
      }
      const verdict = definition.judge(answer)
      rows.push(`  ${name.padEnd(22)} 旧 ${record.correctness.passed}/${record.correctness.total}`
        + `  → 新 ${verdict.passed}/${verdict.total}`
        + (verdict.missing.length === 0 ? '' : `  (缺 ${verdict.missing.join('; ')})`))
    }
    console.log(`${label}:\n${rows.join('\n')}`)
  }
}

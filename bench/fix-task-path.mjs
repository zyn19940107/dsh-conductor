/**
 * Repair the review task's path: the source line has single backslashes, so JS
 * turns `\v` into a vertical tab and the model receives a mangled path.
 *
 * Run once: node bench/fix-task-path.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'

const BACKSLASH = String.fromCharCode(92)
const path = 'D:' + BACKSLASH + 'code' + BACKSLASH + 'vibe' + BACKSLASH + 'dsh-refine-loop'
const escaped = 'D:' + BACKSLASH.repeat(2) + 'code' + BACKSLASH.repeat(2) + 'vibe' + BACKSLASH.repeat(2) + 'dsh-refine-loop'

const source = readFileSync('bench/task.mjs', 'utf8')
const lines = source.split(String.fromCharCode(10))
let changed = false
for (let i = 0; i < lines.length; i += 1) {
  if (!lines[i].includes('分别独立审查')) continue
  if (!lines[i].includes(path)) continue
  lines[i] = lines[i].split(path).join(escaped)
  changed = true
  console.log('line ' + String(i + 1) + ': ' + JSON.stringify(lines[i].slice(0, 70)))
}
if (!changed) {
  console.log('nothing to fix')
  process.exit(0)
}
writeFileSync('bench/task.mjs', lines.join(String.fromCharCode(10)))
console.log('written')

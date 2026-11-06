/**
 * Check that every file a task points at actually exists.
 *
 * Some tasks review another repository (deepseek-harness) and some run inside a
 * copy of this one (the greenspecs workspace). A path that stopped existing makes
 * the task impossible without saying so.
 *
 * Usage: node bench/check-external.mjs
 */

import { existsSync } from 'node:fs'
import { TASKS } from './task.mjs'

const ROOTS = {
  'deepseek-harness': 'D:/code/vibe/deepseek-harness',
  'dsh-refine-loop': 'D:/code/vibe/dsh-refine-loop',
  'dsh-sandbox': 'D:/code/vibe/dsh-sandbox',
}

const REFERENCE = /(deepseek-harness|dsh-refine-loop|dsh-sandbox)[\\/][^\s'"`,)]*/g

let missing = 0
let checked = 0
for (const [name, task] of Object.entries(TASKS)) {
  const raw = task.text
  const text = typeof raw === 'string' ? raw : ''
  for (const match of text.matchAll(REFERENCE)) {
    const reference = match[0].replaceAll('\\', '/').replace(/[.,]+$/, '')
    const normalized = reference.replace(/\//g, '/')
    if (!normalized.startsWith(match[1]) && !normalized.startsWith('D:')) continue
    const full = normalized.startsWith('D:')
      ? normalized
      : `D:/code/vibe/${normalized}`
    checked += 1
    if (!existsSync(full)) {
      console.log(`${name}: missing ${reference}`)
      missing += 1
    }
  }
}

console.log(missing === 0
  ? `every referenced path exists (${checked} checked)`
  : `\n${missing} missing path(s)`)

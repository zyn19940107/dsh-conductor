/**
 * Print what one child agent did: its steps, its calls per step, and whether
 * it drew a plan of its own.
 *
 * Usage: node bench/show-child-steps.mjs <result-file>
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const ROOT = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const result = { sessionId: process.argv[2] }

/**
 * Find the log of one session.
 *
 * @param {string} id - the session id.
 * @returns {string} the log text.
 */
function loadOne(id) {
  for (const entry of readdirSync(ROOT, { withFileTypes: true }).filter(item => item.isDirectory())) {
    for (const file of readdirSync(join(ROOT, entry.name))) {
      if (!file.endsWith('.zstd')) continue
      const text = decodeLog(join(ROOT, entry.name, file))
      if (text === '') continue
      let header
      try {
        header = JSON.parse(text.split('\n')[0])
      } catch {
        continue
      }
      if (header.id === id) return text
    }
  }
  return ''
}

/**
 * The children of one session.
 *
 * @param {string} id - the parent session id.
 * @returns {string[]} the child session ids.
 */
function childrenOf(id) {
  const found = []
  for (const entry of readdirSync(ROOT, { withFileTypes: true }).filter(item => item.isDirectory())) {
    for (const file of readdirSync(join(ROOT, entry.name))) {
      if (!file.endsWith('.zstd')) continue
      const text = decodeLog(join(ROOT, entry.name, file))
      if (text === '') continue
      let header
      try {
        header = JSON.parse(text.split('\n')[0])
      } catch {
        continue
      }
      if (header.parentSession === id || header.parent === id) found.push(header.id)
    }
  }
  return found
}

const children = childrenOf(result.sessionId)
console.log(`主会话 ${result.sessionId.slice(0, 12)} 的孩子: ${children.length} 个`)
for (const child of children) {
  const text = loadOne(child)
  if (text === '') continue
  const events = text.split('\n').map(line => {
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  }).filter(Boolean)
  let step = 0
  const perStep = []
  for (const event of events) {
    if (event.type === 'step/start') {
      step += 1
      perStep.push([])
      continue
    }
    if (event.type === 'tool/call') {
      const names = perStep[perStep.length - 1]
      if (names !== undefined) names.push(event.data.name)
    }
  }
  const planCalls = perStep.flat().filter(name => name === 'refine_plan').length
  const total = perStep.flat().length
  const parallelSteps = perStep.filter(names => names.length > 1).length
  console.log('')
  console.log(`── 孩子 ${child.slice(0, 12)} ──`)
  console.log(`   步数 ${step} · 工具调用 ${total} · 提示词里有 "Refined loop": ${/Refined loop:/.test(text) ? '有' : '没有'} · 自己交过图: ${planCalls} 次`)
  console.log(`   每步的调用数: ${perStep.map(names => names.length).join(',')}`)
  console.log(`   一步里发过多个调用的步: ${parallelSteps} / ${step}`)
}

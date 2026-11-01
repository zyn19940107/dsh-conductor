/**
 * Print what each step of one run cost, in wall-clock time.
 *
 * Usage: node bench/show-timeline.mjs <result-file>
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const ROOT = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const result = JSON.parse(readFileSync(process.argv[2], 'utf8'))

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

const events = loadOne(result.sessionId).split('\n').map(line => {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}).filter(Boolean)

const at = event => Number(event.time ?? 0)
let stepStart = 0
let step = 0
for (const event of events) {
  if (event.type === 'step/start') {
    stepStart = at(event)
    step += 1
    console.log('')
    console.log(`── 步 ${step} ──`)
    continue
  }
  if (event.type === 'step/end') {
    const seconds = (at(event) - stepStart) / 1000
    console.log(`   这一步用了 ${seconds.toFixed(1)} 秒`)
    continue
  }
  if (event.type === 'tool/call') {
    const name = event.data.name
    const args = String(event.data.arguments ?? '')
    let detail = ''
    if (name === 'refine_plan') {
      try {
        const plan = JSON.parse(args)
        detail = plan.nodes.map(node => `${node.id}(${node.kind}${node.kind === 'tools' ? ':' + node.calls.length : ''})`).join(' ')
      } catch {
        detail = '(参数坏了)'
      }
    }
    console.log(`   调用 ${name} ${detail}`)
    continue
  }
  if (event.type === 'tool/result' && event.data.message?.isError === true) {
    const text = String((event.data.message.content ?? []).map(block => block.text ?? '').join(''))
    console.log(`      ← 被拒: ${text.slice(0, 70).replace(/\n/g, ' ')}`)
  }
}
console.log('')
console.log(`整个主会话: ${(result.wallMs / 1000).toFixed(1)} 秒,${result.steps} 步,编队 ${result.formation.agents} 个会话`)

/**
 * Print what each step cost in tokens and in time.
 *
 * Usage: node bench/show-step-cost.mjs <result-file>
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

let step = 0
let start = 0
for (const event of events) {
  if (event.type === 'step/start') {
    step += 1
    start = Number(event.time)
    continue
  }
  if (event.type !== 'step/end') continue
  const seconds = (Number(event.time) - start) / 1000
  const data = event.data ?? {}
  const usage = data.usage ?? data.tokenUsage ?? {}
  const input = Number(usage.inputTokens ?? usage.input ?? usage.promptTokens ?? 0)
  const output = Number(usage.outputTokens ?? usage.output ?? usage.completionTokens ?? 0)
  const cacheRead = Number(usage.cacheReadTokens ?? usage.cacheRead ?? 0)
  const calls = Number(data.toolCalls ?? data.calls ?? 0)
  const thinking = Number(data.thinkingChars ?? 0)
  console.log(
    `步${step}  ${seconds.toFixed(1).padStart(5)}秒  `
    + `input ${String(input).padStart(6)}  cacheRead ${String(cacheRead).padStart(6)}  `
    + `output ${String(output).padStart(5)}  工具调用 ${calls}  `
    + `思考 ${thinking} 字  `
    + (output > 0 && seconds > 0 ? `→ ${(output / seconds).toFixed(0)} tok/s` : ''),
  )
}
console.log('')
console.log('字段:', JSON.stringify(events.find(event => event.type === 'step/end')?.data ?? {}).slice(0, 400))

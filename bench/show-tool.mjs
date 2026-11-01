/**
 * Print the refine_plan tool exactly as the model saw it.
 *
 * The tool schema in the session log's request header is what the provider
 * was given, so it is the thing worth looking at.
 *
 * Usage: node bench/show-tool.mjs [result-file]
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const ROOT = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'

/**
 * Every session log under the sessions root.
 *
 * @returns {{header: object, text: string}[]} the logs.
 */
function loadAll() {
  const sessions = []
  for (const entry of readdirSync(ROOT, { withFileTypes: true }).filter(item => item.isDirectory())) {
    for (const file of readdirSync(join(ROOT, entry.name))) {
      if (!file.endsWith('.zstd')) continue
      const text = decodeLog(join(ROOT, entry.name, file))
      if (text === '') continue
      sessions.push({ header: JSON.parse(text.split('\n')[0]), text })
    }
  }
  return sessions
}

let found = null
for (const session of loadAll()) {
  for (const line of session.text.split('\n')) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.type !== 'request/header') continue
    const tools = event.data?.tools ?? []
    const plan = tools.find(tool => tool.name === 'refine_plan')
    if (plan !== undefined) {
      found = plan
      break
    }
  }
  if (found !== null) break
}

if (found === null) {
  console.error('no request header carrying refine_plan was found')
  process.exit(1)
}

console.log('══════ 模型看到的 refine_plan ══════')
console.log(JSON.stringify(found, null, 2))

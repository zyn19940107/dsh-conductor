/**
 * Smoke the rebuilt plugin in the sandbox, and look at what it actually did.
 *
 * The criterion is not "the process exited 0": it is that the plan the model
 * drew used the new shape — the node kinds, no `after` — and that a worker
 * child did not call the plan tool, having lost it from its table.
 *
 * Usage: node bench/smoke-worker.mjs
 */

import { spawn } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const EXE = 'C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe'
const CLI = 'C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'
const HOME = 'D:/code/vibe/dsh-sandbox/home'
const SESSIONS = join(HOME, 'sessions', '--D-code-vibe--')
const LF = String.fromCharCode(10)

const task = [
  '用 refine_plan 把下面三个互不相干的小活一次性交出去,三个节点的 kind 都必须是 "worker":',
  '',
  '1. 数 D:\\code\\vibe\\dsh-refine-loop\\src 下有多少个 .ts 文件,列出文件名。',
  '2. 数 D:\\code\\vibe\\dsh-refine-loop\\verify 下有多少个 .spec.ts 文件,列出文件名。',
  '3. 读出 D:\\code\\vibe\\dsh-refine-loop\\package.json 的 version 字段。',
  '',
  '三个活各自独立,都交给 worker 去做(不要自己用工具去做)。收齐结果后,用一句话汇总三个答案。',
].join(LF)

/**
 * The tool calls and the tool removals of one session log.
 *
 * @param path - the log file.
 * @returns what the session called and what was taken away.
 */
function readSession(path) {
  const events = decodeLog(path).split(LF).filter(Boolean).map(line => {
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  }).filter(Boolean)
  const calls = events.filter(event => event.type === 'tool/call').map(event => event.data.name)
  const removed = events
    .filter(event => event.type === 'developer/message')
    .flatMap(event => (event.data?.message?.content ?? []).filter(block => block.type === 'tool-removal'))
    .map(block => block.toolName)
  const child = events.some(event => event.type === 'session'
    && (event.parentSession !== undefined || event.origin === 'subagent'))
  return { calls, removed, child }
}

/**
 * The newest sessions, the newest first.
 *
 * @returns the session directories with their newest write time.
 */
function recentSessions() {
  return readdirSync(SESSIONS, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const files = readdirSync(join(SESSIONS, entry.name)).filter(name => name.endsWith('.zstd'))
      const times = files.map(name => statSync(join(SESSIONS, entry.name, name)).mtimeMs)
      return { id: entry.name, mtime: times.length === 0 ? 0 : Math.max(...times) }
    })
    .sort((a, b) => b.mtime - a.mtime)
}

const child = spawn(EXE, ['--expose-internals', CLI, '--profile', 'bench-on', '--json', '-'], {
  cwd: 'D:/code/vibe',
  env: {
    ...process.env,
    DSH_HOME: HOME,
    ELECTRON_RUN_AS_NODE: '1',
    DSH_PERMISSION_MODE: 'danger-full-access',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
})

let out = ''
child.stdout.on('data', chunk => { out += chunk.toString() })
child.stderr.on('data', chunk => { out += chunk.toString() })
child.stdin.end(task)

const started = Date.now()
child.on('close', code => {
  console.log('session exited ' + code + ' after ' + Math.round((Date.now() - started) / 1000) + 's')

  const plans = []
  for (const line of out.split(LF)) {
    if (!line.includes('refine_plan')) continue
    try {
      const event = JSON.parse(line)
      const args = event.data?.arguments ?? event.input ?? event.arguments
      const parsed = typeof args === 'string' ? JSON.parse(args) : args
      if (parsed?.nodes !== undefined) plans.push(parsed)
    } catch {
      // not a plan call
    }
  }
  if (plans.length === 0) {
    console.log('NO PLAN FOUND in the event stream — raw output follows')
    console.log(out.slice(0, 1200))
    process.exit(2)
  }

  const plan = plans[0]
  const kinds = plan.nodes.map(node => node.kind)
  console.log('plan: ' + plan.nodes.length + ' node(s), kinds = ' + JSON.stringify(kinds))
  console.log('has "after": ' + plan.nodes.some(node => node.after !== undefined))

  let children = 0
  let childrenThatPlanned = 0
  let childrenLosingTheTool = 0
  for (const session of recentSessions().slice(0, 10)) {
    const files = readdirSync(join(SESSIONS, session.id)).filter(name => name.endsWith('.zstd'))
    for (const name of files) {
      let info
      try {
        info = readSession(join(SESSIONS, session.id, name))
      } catch {
        continue
      }
      if (!info.child) continue
      children += 1
      if (info.calls.includes('refine_plan')) childrenThatPlanned += 1
      if (info.removed.includes('refine_plan')) childrenLosingTheTool += 1
      console.log('  child ' + session.id.slice(0, 8) + '  calls=' + JSON.stringify(info.calls)
        + ' removed=' + JSON.stringify(info.removed))
      break
    }
  }
  console.log('child sessions: ' + children + ', planned: ' + childrenThatPlanned
    + ', lost the plan tool: ' + childrenLosingTheTool)
})

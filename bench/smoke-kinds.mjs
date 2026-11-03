/**
 * Smoke the three child kinds in the sandbox.
 *
 * The design says what each kind is, so the check is that the runtime matches
 * it, read off the session logs rather than off an exit code:
 *
 *   worker  — inherits this conversation (isSeeded true),  never draws a plan
 *   spawner — starts empty (isSeeded false),               draws a plan
 *   forker  — inherits this conversation (isSeeded true),  draws a plan
 *
 * Usage: node bench/smoke-kinds.mjs
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
  '用 refine_plan 交一张图,三个节点各用一种 kind,三个任务都是:报告 D:\\code\\vibe\\dsh-refine-loop\\src 目录下有多少个 .ts 文件(用 glob 数,不要读文件内容)。',
  '',
  '- 节点 1:kind "worker"',
  '- 节点 2:kind "spawner"',
  '- 节点 3:kind "forker"',
  '',
  '三个任务的 task 字段里写清楚要做什么。收齐结果后用一句话汇总。',
].join(LF)

const eventsOf = (path) => decodeLog(path).split(LF).filter(Boolean).map(line => {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}).filter(Boolean)

const child = spawn(EXE, ['--expose-internals', CLI, '--profile', 'bench-on', '--json', '-'], {
  cwd: 'D:/code/vibe',
  env: { ...process.env, DSH_HOME: HOME, ELECTRON_RUN_AS_NODE: '1', DSH_PERMISSION_MODE: 'danger-full-access' },
  stdio: ['pipe', 'pipe', 'pipe'],
})

let out = ''
child.stdout.on('data', chunk => { out += chunk.toString() })
child.stderr.on('data', chunk => { out += chunk.toString() })
child.stdin.end(task)

const started = Date.now()
child.on('close', code => {
  console.log('session exited ' + code + ' after ' + Math.round((Date.now() - started) / 1000) + 's')

  let plan
  for (const line of out.split(LF)) {
    if (!line.includes('refine_plan')) continue
    try {
      const event = JSON.parse(line)
      const raw = event.data?.arguments ?? event.input
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
      if (parsed?.nodes !== undefined) { plan = parsed; break }
    } catch {
      // not a plan
    }
  }
  if (plan === undefined) {
    console.log('NO PLAN — raw output follows')
    console.log(out.slice(0, 1000))
    process.exit(2)
  }
  console.log('plan kinds: ' + JSON.stringify(plan.nodes.map(node => node.kind)))

  const children = []
  for (const dir of readdirSync(SESSIONS, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const files = readdirSync(join(SESSIONS, dir.name)).filter(name => name.endsWith('.zstd')).sort()
    if (files.length === 0) continue
    let events
    try {
      events = eventsOf(join(SESSIONS, dir.name, files[files.length - 1]))
    } catch {
      continue
    }
    const header = events.find(event => event.type === 'session')
    if (header?.parentSession === undefined) continue
    const mtime = statSync(join(SESSIONS, dir.name, files[files.length - 1])).mtimeMs
    const planned = events.some(event => event.type === 'tool/call' && event.data?.name === 'refine_plan')
    const calls = events.filter(event => event.type === 'tool/call').map(event => event.data.name)
    children.push({ id: dir.name, mtime, seeded: header.isSeeded === true, planned, calls })
  }
  children.sort((a, b) => b.mtime - a.mtime)

  const fresh = children.slice(0, 3)
  let failures = 0
  for (const info of fresh) {
    const shape = (info.seeded ? 'inherits' : 'empty') + (info.planned ? ' +plans' : ' no-plan')
    console.log('  child ' + info.id.slice(0, 8) + '  ' + shape + '  calls=' + JSON.stringify(info.calls))
  }

  const seen = new Set(fresh.map(info => (info.seeded ? 'inherits' : 'empty') + (info.planned ? '+plans' : '-noplan')))
  const expect = ['empty+plans', 'inherits+noplan', 'inherits+plans']
  for (const wanted of expect) {
    if (seen.has(wanted)) {
      console.log('  ok   ' + wanted)
      continue
    }
    failures += 1
    console.log('  FAIL ' + wanted + ' (saw ' + JSON.stringify([...seen]) + ')')
  }
  if (failures > 0) process.exit(1)
  console.log('all three child kinds match their definition')
})

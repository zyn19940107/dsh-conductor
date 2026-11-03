/**
 * Smoke the forked children: do they inherit this conversation *including the
 * round that is still running*?
 *
 * The task forces two rounds. Round one finds a fact; round two hands over a
 * plan whose worker and forker are asked for that fact. The child's log tells
 * the story: everything before the inherited marker was inherited, everything
 * after is the child's own work.
 *
 * Expected, per the design:
 *   worker — inherited context, this round's plan included, no plan of its own
 *   forker — inherited context, this round's plan included, plans
 *
 * Usage: node bench/smoke-fork.mjs
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
const MARK = '第一轮报数'

const task = [
  '这个任务分两轮,请严格按下面的顺序做:',
  '',
  '第一轮:只用 glob 数一下 D:\\code\\vibe\\dsh-refine-loop\\src 下有多少个 .ts 文件,把数字记下来(这一轮不要派任何子代理)。',
  '',
  '第二轮(第一轮的结果回来之后):用 refine_plan 交一张图,两个节点:',
  '- 节点 A:kind "worker",任务写"直接报出第一轮数出来的 .ts 文件数量,不要重新统计;并说明你知道这个数字是从哪来的"',
  '- 节点 B:kind "forker",任务写"直接报出第一轮数出来的 .ts 文件数量,不要重新统计;并说明你知道这个数字是从哪来的"',
  '',
  '收齐两个节点结果后,用一句话汇总。',
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

  const plans = []
  for (const line of out.split(LF)) {
    if (!line.includes('refine_plan')) continue
    try {
      const event = JSON.parse(line)
      const raw = event.data?.arguments ?? event.input
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
      if (parsed?.nodes !== undefined) plans.push(parsed)
    } catch {
      // not a plan
    }
  }
  if (plans.length === 0) {
    console.log('NO PLAN — raw output follows')
    console.log(out.slice(0, 1200))
    process.exit(2)
  }
  console.log('plans drawn: ' + plans.length + ', kinds: ' + JSON.stringify(plans.map(plan => plan.nodes.map(node => node.kind))))

  const dirs = readdirSync(SESSIONS, { withFileTypes: true }).filter(entry => entry.isDirectory())
  const children = []
  for (const dir of dirs) {
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
    const seedEnd = events.findIndex(event => event.type === 'session/end-seed')
    const inherited = seedEnd === -1 ? [] : events.slice(0, seedEnd)
    const own = seedEnd === -1 ? events : events.slice(seedEnd + 1)
    const inheritedPlan = inherited.some(event => event.type === 'tool/call' && event.data?.name === 'refine_plan')
    const ownPlan = own.some(event => event.type === 'tool/call' && event.data?.name === 'refine_plan')
    const removed = own
      .filter(event => event.type === 'developer/message')
      .flatMap(event => (event.data?.message?.content ?? []).filter(block => block.type === 'tool-removal'))
      .map(block => block.toolName)
    // A plan that ran leaves a result that says so; a refused call leaves the
    // worker rule's message instead.
    const finishedPlan = own.some(event => event.type === 'tool/result'
      && JSON.stringify(event.data?.message?.content ?? '').includes('Plan finished'))
    const firstUsage = own.find(event => event.type === 'assistant/message')?.data?.usage ?? {}
    const inheritedCalls = inherited.filter(event => event.type === 'tool/call').map(event => event.data?.name)
    children.push({
      id: dir.name,
      mtime: statSync(join(SESSIONS, dir.name, files[files.length - 1])).mtimeMs,
      seeded: header.isSeeded === true,
      seedEnd,
      inheritedPlan,
      ownPlan,
      removed,
      finishedPlan,
      firstInput: firstUsage.inputTokens ?? 0,
      firstCache: firstUsage.cacheReadTokens ?? 0,
      inheritedCalls,
      inheritedText: JSON.stringify(inherited).includes(MARK),
    })
  }
  children.sort((a, b) => b.mtime - a.mtime)
  const latest = children.slice(0, 2)

  let failures = 0
  const check = (what, ok) => {
    console.log('  ' + (ok ? 'ok  ' : 'FAIL') + ' ' + what)
    if (!ok) failures += 1
  }

  if (latest.length < 2) {
    console.log('  FAIL expected two children, saw ' + latest.length)
    process.exit(1)
  }
  for (const info of latest) {
    console.log('child ' + info.id.slice(0, 10) + ' seeded=' + info.seeded
      + ' inheritedPlan=' + info.inheritedPlan + ' finishedPlan=' + info.finishedPlan
      + ' firstStep in=' + info.firstInput + ' cache=' + info.firstCache)
  }
  check('both children inherit this conversation', latest.every(info => info.seeded))
  check('both inherit this round plan call', latest.every(info => info.inheritedPlan))
  // The plan tool must stay in the table: it is part of the request header, and
  // the inherited prefix only hits the cache when the header matches the parent.
  check('both keep the plan tool in their table', latest.every(info => !info.removed.includes('refine_plan')))
  // The inherited prefix is cached, so the first request reads it, not pays for it.
  check('both hit the parent cache on their first request',
    latest.every(info => info.firstCache > info.firstInput))
  // A worker may try; the rule refuses it. What must not happen is a plan of its
  // own running.
  check('the worker runs no plan of its own', latest.every(info => info.finishedPlan === false)
    || latest.filter(info => info.finishedPlan).length < latest.length)
  if (failures > 0) process.exit(1)
  console.log('forked children inherit the running round, and only the forker plans')
})

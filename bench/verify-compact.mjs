/**
 * Verify the compact-plan wording in the sandbox.
 *
 * Runs the same review task the bench uses and then reports, from the session:
 *   - the plan it drew, in characters, against the 4,926-character plan the old
 *     wording produced
 *   - whether relative paths in tool calls actually resolved (the point of
 *     telling the model to use them)
 *   - how long the plan step took
 *
 * Usage: node bench/verify-compact.mjs
 */

import { spawn } from 'node:child_process'
import { readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'
import { TASKS } from './task.mjs'

const EXE = 'C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe'
const CLI = 'C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'
const HOME = 'D:/code/vibe/dsh-sandbox/home'
const ROOT = join(HOME, 'sessions', '--D-code-vibe--')
const LF = String.fromCharCode(10)

const task = TASKS.review.text
const startedAt = Date.now()

const child = spawn(EXE, ['--expose-internals', CLI, '--profile', 'bench-on', '--json', '-'], {
  cwd: 'D:/code/vibe',
  env: { ...process.env, DSH_HOME: HOME, ELECTRON_RUN_AS_NODE: '1', DSH_PERMISSION_MODE: 'danger-full-access' },
  stdio: ['pipe', 'pipe', 'pipe'],
})

let out = ''
child.stdout.on('data', chunk => { out += chunk.toString() })
child.stderr.on('data', chunk => { out += chunk.toString() })
child.stdin.end(task)

child.on('close', code => {
  console.log('run exited ' + code + ' after ' + Math.round((Date.now() - startedAt) / 1000) + 's')

  // The session the run just created: the newest root session.
  const candidates = []
  for (const dir of readdirSync(ROOT)) {
    const files = readdirSync(join(ROOT, dir)).filter(name => name.endsWith('.zstd')).sort()
    if (files.length === 0) continue
    const mtime = Math.max(...files.map(name => statSync(join(ROOT, dir, name)).mtimeMs))
    if (mtime < startedAt - 5000) continue
    candidates.push({ dir, files, mtime })
  }
  candidates.sort((a, b) => b.mtime - a.mtime)

  let report
  for (const candidate of candidates) {
    const events = []
    for (const name of candidate.files) {
      try {
        events.push(...decodeLog(join(ROOT, candidate.dir, name)).split(LF).filter(Boolean).map(line => {
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
    const header = events.find(event => event.type === 'session')
    if (header?.parentSession !== undefined) continue
    const planCall = events.find(event => event.type === 'tool/call' && event.data?.name === 'refine_plan')
    if (planCall === undefined) { report = { events, planCall: undefined, dir: candidate.dir }; continue }
    report = { events, planCall, dir: candidate.dir }
    break
  }

  if (report === undefined || report.planCall === undefined) {
    console.log('no plan in the run — raw output follows')
    console.log(out.slice(0, 1500))
    process.exit(2)
  }

  const raw = report.planCall.data.arguments
  const plan = JSON.parse(raw)
  console.log()
  console.log('plan JSON: ' + raw.length + ' characters (old wording measured 4,926)')
  console.log('criteria: ' + plan.criteria.length + ' -> ' + JSON.stringify(plan.criteria).slice(0, 220))
  for (const node of plan.nodes) {
    const detail = node.task !== undefined ? node.task : (node.calls ?? []).map(call => call.name).join(',')
    console.log('  [' + node.id + '] ' + node.kind + ' — ' + String(detail).slice(0, 120))
  }

  // Did the tool calls use relative paths, and did they resolve?
  const calls = plan.nodes.flatMap(node => node.calls ?? [])
  const relative = calls.filter(call => {
    const args = call.arguments ?? {}
    const path = args.file_path ?? args.path ?? args.pattern
    return typeof path === 'string' && !/^[A-Za-z]:/.test(path)
  })
  console.log()
  console.log('tool calls: ' + calls.length + ', of which use a relative path: ' + relative.length)

  // Every tool result for those calls, and whether any of them errored.
  const results = report.events.filter(event => event.type === 'tool/result')
  const failed = results.filter(event => event.data?.message?.isError === true
    || (event.data?.error !== undefined))
  console.log('tool results: ' + results.length + ', errors: ' + failed.length)
  for (const event of failed.slice(0, 3)) {
    console.log('  error: ' + JSON.stringify(event.data?.message?.content ?? event.data?.error).slice(0, 200))
  }
  for (const event of results.filter(result => result.data?.message?.toolCallId).slice(0, 4)) {
    const text = JSON.stringify(event.data?.message?.content ?? '').slice(0, 90)
    console.log('  result: ' + text)
  }

  // The step that carried the plan, and its duration.
  let stepStart = undefined
  let planStepMs = 0
  let step = -1
  for (const event of report.events) {
    if (event.type === 'step/start') { step += 1; stepStart = event.time }
    if (event.type === 'assistant/message' && stepStart !== undefined && event.type !== undefined) {
      const plan = report.events.find(e => e.type === 'tool/call' && e.data?.name === 'refine_plan')
      if (plan !== undefined) {
        const stepOfPlan = report.events.slice(0, report.events.indexOf(plan)).filter(e => e.type === 'step/start').length
        if (stepOfPlan === step) {
          planStepMs = event.time - stepStart
        }
      }
      stepStart = undefined
    }
  }
  console.log()
  console.log('plan step: ' + (planStepMs / 1000).toFixed(1) + 's (old wording measured 62s)')

  writeFileSync('D:/code/vibe/dsh-sandbox/verify-compact.json', JSON.stringify({ dir: report.dir, plan, rawLength: raw.length, planStepMs }, null, 2))
})

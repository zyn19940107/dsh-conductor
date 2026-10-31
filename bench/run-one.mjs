/**
 * Run the benchmark task once, in one condition, and record what it cost.
 *
 * The measurement comes from the harness's own `--json` projection: one
 * newline-delimited event per session event, with the provider's token
 * accounting on every step. Nothing here estimates a number the provider did
 * not report.
 *
 * Usage: node bench/run-one.mjs <condition> <index>
 *   condition: on | off
 */

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TASK, judge } from './task.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const EXE = 'C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe'
const CLI = 'C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'
const SANDBOX_HOME = 'D:/code/vibe/dsh-sandbox/home'
const CWD = 'D:/code/vibe'

const condition = process.argv[2] ?? 'on'
const index = process.argv[3] ?? '1'

/**
 * Run the headless task and collect its events.
 *
 * @returns the parsed events, the final text, the wall-clock cost, and the exit code.
 */
async function run() {
  const args = [
    '--expose-internals',
    CLI,
    '--profile',
    'headless',
  ]
  // `--patch` has to come before `--json`: the launcher's option parser stops
  // reading options once the positional task argument starts, and a patch
  // placed after the flags is swallowed as part of the task.
  if (condition === 'off') {
    args.push('--patch', resolve(HERE, 'off.patch.yml'))
  }
  args.push('--json')
  // The task goes in on stdin: it carries quotes, newlines, and a Windows
  // path, and a command line built from those comes back mangled.
  args.push('-')

  const started = Date.now()
  const child = spawn(EXE, args, {
    cwd: CWD,
    env: {
      ...process.env,
      DSH_HOME: SANDBOX_HOME,
      ELECTRON_RUN_AS_NODE: '1',
      DSH_PERMISSION_MODE: 'danger-full-access',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdin.end(TASK)

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  const exitCode = await new Promise((resolveExit) => {
    child.on('close', code => resolveExit(code ?? -1))
  })
  const wallMs = Date.now() - started

  const events = []
  let finalText = ''
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    events.push(event)
    if (event.type === 'final') finalText = String(event.text ?? '')
  }
  if (exitCode !== 0) {
    console.error('--- stdout ---')
    console.error(stdout.slice(0, 2000))
    console.error('--- stderr ---')
    console.error(stderr.slice(0, 2000))
  }
  return { events, finalText, wallMs, exitCode, stderr }
}

const { events, finalText, wallMs, exitCode, stderr } = await run()

/**
 * The provider's accounting for one step.
 *
 * @param {object} event - a step_end event.
 * @returns {object} the token counts it carries.
 */
function usageOf(event) {
  const usage = event.usage ?? {}
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    totalTokens: usage.totalTokens ?? 0,
    reasoningTokens: usage.reasoningTokens ?? 0,
  }
}

const steps = events.filter(event => event.type === 'status' && event.phase === 'step_end')
const toolCalls = events.filter(event => event.type === 'tool_call')
const thinking = events.filter(event => event.type === 'thinking').map(event => String(event.text ?? ''))
const tools = toolCalls.map(event => String(event.tool ?? ''))
const usage = steps.map(event => usageOf(event))
const sum = (key) => usage.reduce((total, entry) => total + entry[key], 0)

const verdict = judge(finalText)
const planCall = toolCalls.find(event => event.tool === 'refine_plan')

const record = {
  condition,
  index: Number(index),
  exitCode,
  wallMs,
  stderr: stderr.slice(0, 1200),
  steps: steps.length,
  toolCalls: toolCalls.length,
  tools,
  usage: {
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    cacheReadTokens: sum('cacheReadTokens'),
    totalTokens: sum('totalTokens'),
    reasoningTokens: sum('reasoningTokens'),
  },
  correctness: {
    passed: verdict.passed,
    total: verdict.total,
    missing: verdict.missing,
  },
  planned: tools.includes('refine_plan'),
  plan: planCall?.input ?? null,
  thinkingChars: thinking.join('\n').length,
  thinkingPreview: thinking.join('\n').slice(0, 900),
  finalText: finalText.slice(0, 4000),
}

mkdirSync(resolve(HERE, 'results'), { recursive: true })
const out = resolve(HERE, 'results', `${condition}-${index}.json`)
writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`)

console.log(JSON.stringify({
  condition,
  index,
  exitCode,
  wallMs,
  steps: record.steps,
  toolCalls: record.toolCalls,
  planned: record.planned,
  tools: tools.slice(0, 14),
  usage: record.usage,
  correctness: record.correctness,
}, null, 2))

/**
 * Run one benchmark task once, in one condition, and record what it cost.
 *
 * The measurement comes from the harness's own `--json` projection: one
 * newline-delimited event per session event, with the provider's token
 * accounting on every step. Nothing here estimates a number the provider did
 * not report.
 *
 * The projection only covers the session the runner drives. A delegated agent
 * lives in its own session with its own log, so the whole formation's cost
 * is the sum over the session tree, read back from those logs after the run.
 *
 * The run needs a DSH home of its own: it must not share a profile with the
 * DSH the person is using. Point DSH_SANDBOX_HOME at one, and DSH_BENCH_CWD
 * at the directory the task reads.
 *
 * Usage: node bench/run-one.mjs <task> <condition> <index>
 *   task: survey | chain | review
 *   condition: on | off
 */

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TASKS } from './task.mjs'
import { readSessions, subtree, totals } from './sessions.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const EXE = 'C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe'
const CLI = 'C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'
const SANDBOX_HOME = process.env.DSH_SANDBOX_HOME ?? 'D:/code/vibe/dsh-sandbox/home'
const CWD = process.env.DSH_BENCH_CWD ?? 'D:/code/vibe'
const SESSIONS_ROOT = resolve(SANDBOX_HOME, 'sessions', '--D-code-vibe--')

// The two sandboxes. They differ in exactly one thing: whether the plugin's
// bundle is part of the profile. The old overlay (`enabled: false` on the same
// profile) is kept available through DSH_BENCH_OFF_OVERLAY=1 for reproducing
// the numbers the README published before the split.
const PROFILE_ON = process.env.DSH_BENCH_PROFILE_ON ?? 'bench-on'
const PROFILE_OFF = process.env.DSH_BENCH_PROFILE_OFF ?? 'bench-off'
const OFF_OVERLAY = process.env.DSH_BENCH_OFF_OVERLAY === '1'

const taskName = process.argv[2] ?? 'survey'
const condition = process.argv[3] ?? 'on'
const index = process.argv[4] ?? '1'
const task = TASKS[taskName]
if (task === undefined) {
  console.error(`unknown task "${taskName}"; known: ${Object.keys(TASKS).join(', ')}`)
  process.exit(2)
}

/**
 * Run the headless task and collect its events.
 *
 * @returns {Promise<object>} the events, the final text, the wall-clock cost, and the session id.
 */
async function run() {
  // A scenario may need a fresh fixture before the run (a copy of the repo with
  // a bug planted, a scratch directory). It runs before anything else so both
  // conditions start from the same state. The condition goes into the fixture's
  // name so the two conditions can run in parallel without sharing it.
  process.env.DSH_BENCH_CONDITION = condition
  task.setup?.()
  const args = [
    '--expose-internals',
    CLI,
    '--profile',
    condition === 'off' ? PROFILE_OFF : PROFILE_ON,
  ]
  // `--patch` has to come before `--json`: the launcher's option parser stops
  // reading options once the positional task argument starts, and a patch
  // placed after the flags is swallowed as part of the task.
  if (condition === 'off' && OFF_OVERLAY) {
    args.push('--patch', resolve(HERE, 'off.patch.yml'))
  }
  args.push('--json')
  // The task goes in on stdin: it carries quotes, newlines, and a Windows
  // path, and a command line built from those comes back mangled.
  args.push('-')

  const started = Date.now()
  let timedOut = false
  // A task may need its own environment (the commit0 task needs PYTHONPATH
  // pointing at its three library trees, the way the container had it).
  const environment = { ...process.env, ...(task.env ?? {}) }

  // The sealed network. Upstream runs this task with `network_mode: none`, so
  // the agent cannot fetch the real libraries and copy them in. DSH has no
  // "no internet" switch and the LLM client honours the proxy variables, so
  // the benchmark runs a local proxy that blocks the package sources and
  // forwards everything else (the model API) untouched.
  const proxy = process.env.DSH_BENCH_PROXY
  if (proxy !== undefined && proxy !== '') {
    Object.assign(environment, {
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      ALL_PROXY: proxy,
      http_proxy: proxy,
      https_proxy: proxy,
      all_proxy: proxy,
      NO_PROXY: '',
      no_proxy: '',
      GIT_CONFIG_GLOBAL: resolve(SANDBOX_HOME, '..', 'sealed', 'gitconfig'),
      GIT_TERMINAL_PROMPT: '0',
      PIP_NO_INDEX: '1',
      PIP_DISABLE_PIP_VERSION_CHECK: '1',
    })
  }
  const child = spawn(EXE, args, {
    cwd: CWD,
    env: {
      ...environment,
      DSH_HOME: SANDBOX_HOME,
      ELECTRON_RUN_AS_NODE: '1',
      DSH_PERMISSION_MODE: 'danger-full-access',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdin.end(task.text)

  // The task's own budget. Upstream, the long-horizon tasks are scored by the
  // peak the agent reached before its deadline was cut off; here the child is
  // killed at the deadline and whatever it left on disk is what the judge
  // reads. The same rule for both conditions.
  const budget = task.timeoutMs ?? 0
  if (budget > 0) {
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, budget)
    timer.unref?.()
  }

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  const exitCode = await new Promise((resolveExit) => {
    child.on('close', code => resolveExit(code ?? -1))
  })
  const wallMs = Date.now() - started
  if (timedOut) {
    console.error(`the ${taskName} ${condition} run hit its ${String(budget)}ms budget and was cut off`)
  }

  const events = []
  let finalText = ''
  let sessionId = ''
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
    // The turn's answer is whatever it produced: the assistant's text and the
    // results of the tools it ran. With the plugin on, the plan's result is the
    // turn's answer — there is no closing summary to read.
    if (event.type === 'text') finalText += String.fromCharCode(10) + String(event.text ?? '')
    if (event.type === 'tool_result') finalText += String.fromCharCode(10) + String(event.result ?? '')
    if (event.type === 'session') sessionId = String(event.sessionId ?? '')
  }
  if (exitCode !== 0) {
    console.error('--- stdout ---')
    console.error(stdout.slice(0, 2000))
    console.error('--- stderr ---')
    console.error(stderr.slice(0, 2000))
  }
  return { events, finalText, wallMs, exitCode, stderr, sessionId, timedOut }
}

const { events, finalText, wallMs, exitCode, stderr, sessionId, timedOut } = await run()

/**
 * The provider's accounting for one step, from the projection stream.
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
  }
}

const steps = events.filter(event => event.type === 'status' && event.phase === 'step_end')
const toolCalls = events.filter(event => event.type === 'tool_call')
const thinking = events.filter(event => event.type === 'thinking').map(event => String(event.text ?? ''))
const tools = toolCalls.map(event => String(event.tool ?? ''))
const usage = steps.map(event => usageOf(event))
const sum = (key) => usage.reduce((total, entry) => total + entry[key], 0)

const planCall = toolCalls.find(event => event.tool === 'refine_plan')
const planCalls = planCall?.input?.nodes?.filter(node => node.kind !== 'tools').length ?? 0

// The whole formation: the session the runner drove plus every session it
// spawned, read back from their own logs.
let formation = { sessions: 1, input: 0, output: 0, cacheRead: 0, total: 0, steps: 0 }
let mainPrompt = 0
if (sessionId !== '') {
  const sessions = readSessions(SESSIONS_ROOT)
  const root = sessions.get(sessionId)
  if (root !== undefined) {
    const tree = subtree(sessions, sessionId)
    formation = totals(tree)
    mainPrompt = root.lastPrompt
  }
}

const verdict = task.judge(finalText)

const record = {
  task: taskName,
  condition,
  index: Number(index),
  profile: condition === 'off' ? PROFILE_OFF : PROFILE_ON,
  exitCode,
  wallMs,
  timedOut,
  sessionId,
  stderr: stderr.slice(0, 1200),
  steps: steps.length,
  toolCalls: toolCalls.length,
  tools,
  usage: {
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    cacheReadTokens: sum('cacheReadTokens'),
    totalTokens: sum('totalTokens'),
  },
  formation: {
    agents: formation.sessions,
    input: formation.input,
    output: formation.output,
    cacheRead: formation.cacheRead,
    total: formation.total,
    steps: formation.steps,
  },
  mainPrompt,
  correctness: {
    passed: verdict.passed,
    total: verdict.total,
    missing: verdict.missing,
    // A continuous score, when the judge has one: the 2048 task is scored by
    // the band it reached, and the raw value is the finer signal.
    ...(verdict.score === undefined ? {} : { score: verdict.score }),
    ...(verdict.moves === undefined ? {} : { moves: verdict.moves }),
    // A judge may also report the raw score and what it voided, so a record
    // keeps both the credited score and the reason a run was voided.
    ...(verdict.rawScore === undefined ? {} : { rawScore: verdict.rawScore }),
    ...(verdict.voidedScore === undefined ? {} : { voidedScore: verdict.voidedScore }),
    ...(verdict.copied === undefined ? {} : { copied: verdict.copied }),
  },
  planned: tools.includes('refine_plan'),
  planAgentNodes: planCalls,
  thinkingChars: thinking.join('\n').length,
  thinkingPreview: thinking.join('\n').slice(0, 900),
  finalText: finalText.slice(0, 4000),
}

mkdirSync(resolve(HERE, 'results'), { recursive: true })
const out = resolve(HERE, 'results', `${taskName}-${condition}-${index}.json`)
writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`)

console.log(JSON.stringify({
  task: taskName,
  condition,
  index,
  exitCode,
  wallMs,
  steps: record.steps,
  agents: formation.sessions,
  mainPrompt,
  formationTotal: formation.total,
  planned: record.planned,
  planAgentNodes: planCalls,
  correctness: record.correctness,
}, null, 2))

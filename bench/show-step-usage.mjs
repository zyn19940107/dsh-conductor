/**
 * Run one task and print what each step cost: tokens in, tokens out, time.
 *
 * Usage: node bench/show-step-usage.mjs "<task>"
 */

import { spawn } from 'node:child_process'

const EXE = 'C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe'
const CLI = 'C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'
const SANDBOX_HOME = process.env.DSH_SANDBOX_HOME ?? 'D:/code/vibe/dsh-sandbox/home'
const CWD = process.env.DSH_BENCH_CWD ?? 'D:/code/vibe'
const task = process.argv[2] ?? '读 D:\\code\\vibe\\dsh-refine-loop\\src\\plan.ts 的前 3 行,告诉我第一行是什么。'

const args = ['--expose-internals', CLI, '--profile', 'headless', '--json', '-']
const child = spawn(EXE, args, {
  cwd: CWD,
  env: { ...process.env, DSH_HOME: SANDBOX_HOME, ELECTRON_RUN_AS_NODE: '1' },
  stdio: ['pipe', 'pipe', 'inherit'],
})
child.stdin.end(task)

let buffer = ''
const events = []
child.stdout.on('data', chunk => {
  buffer += chunk.toString('utf8')
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''
  for (const line of lines) {
    try {
      events.push(JSON.parse(line))
    } catch {
      // Not an event line.
    }
  }
})

child.on('close', () => {
  let step = 0
  for (const event of events) {
    if (event.type !== 'status' || event.phase !== 'step_end') continue
    step += 1
    const usage = event.usage ?? {}
    const input = usage.inputTokens ?? 0
    const cacheRead = usage.cacheReadTokens ?? 0
    const output = usage.outputTokens ?? 0
    const ms = Number(event.durationMs ?? event.ms ?? event.elapsedMs ?? 0)
    const seconds = ms > 0 ? ms / 1000 : 0
    console.log(
      `步${step}  ${seconds > 0 ? seconds.toFixed(1).padStart(5) + '秒' : '  ?  '}  `
      + `input ${String(input).padStart(6)}  cacheRead ${String(cacheRead).padStart(6)}  `
      + `output ${String(output).padStart(5)}  `
      + (seconds > 0 && output > 0 ? `→ ${(output / seconds).toFixed(0)} tok/s` : ''),
    )
  }
  console.log('')
  console.log('status 事件的字段:', JSON.stringify(events.find(event => event.type === 'status' && event.phase === 'step_end') ?? {}).slice(0, 400))
})

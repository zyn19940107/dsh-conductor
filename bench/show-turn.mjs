/**
 * Run one task in the headless bundle and print the shape of the turn.
 *
 * Usage: node bench/show-turn.mjs "<task>"
 */

import { spawn } from 'node:child_process'

const EXE = 'C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe'
const CLI = 'C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'
const SANDBOX_HOME = process.env.DSH_SANDBOX_HOME ?? 'D:/code/vibe/dsh-sandbox/home'
const CWD = process.env.DSH_BENCH_CWD ?? 'D:/code/vibe'
const task = process.argv[2] ?? '看看 D:\\code\\vibe\\dsh-refine-loop\\src 下有几个文件,分别叫什么。'

const args = ['--expose-internals', CLI, '--profile', 'headless', '--json', '-']
const child = spawn(EXE, args, {
  cwd: CWD,
  env: { ...process.env, DSH_HOME: SANDBOX_HOME },
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
  let planNumber = 0
  for (const event of events) {
    if (event.type === 'step_start') step += 1
    if (event.type === 'tool_call') {
      const args = typeof event.input === 'string' ? event.input : JSON.stringify(event.input)
      if (event.tool === 'refine_plan') {
        planNumber += 1
        let nodes = '(没有 nodes)'
        try {
          const parsed = JSON.parse(args)
          nodes = (parsed.nodes ?? []).map(node => `${node.id}(${node.kind})`).join(' ')
        } catch {
          nodes = '(参数不是 JSON)'
        }
        console.log(`步${step}  【第${planNumber}张计划】${nodes}`)
        continue
      }
      console.log(`步${step}  直接调用 ${event.tool}`)
    }
    if (event.type === 'tool_result') {
      const text = String(event.result ?? '')
      if (event.status === 'error') {
        console.log('     ← 被拒: ' + text.slice(0, 110).replace(/\n/g, ' '))
      } else if (text.includes('Plan finished')) {
        console.log('     ← 图跑完')
      }
    }
    if (event.type === 'status') {
      console.log('【' + event.phase + '】')
    }
  }
  const final = events.filter(event => event.type === 'final').map(event => event.text ?? '').join('\n')
  console.log('')
  console.log('════ 结论 ════')
  console.log(final.slice(0, 900))
})

/**
 * One small task, two shapes: the same heavy `pwsh` command run as a `tools`
 * node versus inside a `worker` node.
 *
 * The command prints ~370k characters. A tools node hands that raw text to the
 * main agent; a worker reads it in its own context and returns one line.
 *
 * Usage: node bench/pwsh-vs-worker.mjs [runs]
 */

import { spawn } from 'node:child_process'
import { readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const EXE = 'C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe'
const CLI = 'C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'
const HOME = 'D:/code/vibe/dsh-sandbox/home'
const ROOT = join(HOME, 'sessions')
const LF = String.fromCharCode(10)
const runs = Number(process.argv[2] ?? '2')
const only = process.argv[3]

const COMMAND = "Get-ChildItem -Path 'D:\\code\\vibe\\dsh-refine-loop' -Recurse -File -Force | Sort-Object FullName | Select-Object FullName, Length"
const FIRST = '.git' + String.fromCharCode(92) + 'COMMIT_EDITMSG'

const TOOLS_TASK = `用 refine_plan 交一张图，图上只有一个节点，kind 必须是 "tools"，calls 里只放这一条 pwsh 调用：
command = ${COMMAND}
不要自己先跑这条命令。交完图之后，回答：这条命令输出的第一条记录，文件名是什么？只回答文件名。`

const WORKER_TASK = `用 refine_plan 交一张图，图上只有一个节点，kind 必须是 "worker"，它的 task 写成：跑这条 pwsh 调用，然后回答输出第一条记录的文件名是什么——command = ${COMMAND}
你不要自己跑这条命令，也不要自己读文件；把这件事整个交给 worker。交完图之后，把 worker 的结论复述一遍。`

/**
 * Run one case and pull the numbers back out of the session log.
 *
 * @param label - tools or worker.
 * @param task - the prompt.
 * @param index - the sample number.
 * @returns the measurement.
 */
async function run(label, task, index) {
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
  const code = await new Promise(resolve => child.on('close', resolve))
  const wall = Date.now() - startedAt
  const final = (() => {
    const line = out.split(LF).reverse().find(entry => entry.includes('"type":"final"'))
    if (line === undefined) return ''
    try {
      return String(JSON.parse(line).text ?? '')
    } catch {
      return ''
    }
  })()

  // The session this run created: newest root session under any workspace.
  const candidates = []
  for (const workspace of readdirSync(ROOT)) {
    const dir = join(ROOT, workspace)
    if (!statSync(dir).isDirectory()) continue
    for (const session of readdirSync(dir)) {
      const files = readdirSync(join(dir, session)).filter(name => name.endsWith('.zstd')).sort()
      if (files.length === 0) continue
      const mtime = Math.max(...files.map(name => statSync(join(dir, session, name)).mtimeMs))
      if (mtime < startedAt - 5000) continue
      candidates.push({ dir, session, files, mtime })
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime)
  let plan
  let mainTokens = 0
  let mainContext = 0
  let steps = 0
  let biggest = 0
  let report = 0
  let reportTruncated = false
  for (const candidate of candidates.slice(0, 3)) {
    const events = []
    for (const name of candidate.files) {
      try {
        events.push(...decodeLog(join(candidate.dir, candidate.session, name)).split(LF).filter(Boolean).map(line => {
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
    const call = events.find(event => event.type === 'tool/call' && event.data?.name === 'refine_plan')
    if (call === undefined) continue
    plan = JSON.parse(call.data.arguments)
    mainTokens = events.filter(event => event.type === 'assistant/message')
      .reduce((sum, event) => sum + (event.data?.usage?.outputTokens ?? 0), 0)
    steps = events.filter(event => event.type === 'step/start').length
    const open = new Map()
    for (const event of events) {
      if (event.type === 'tool/call') open.set(String(event.data?.callId), event.data?.name)
      if (event.type === 'tool/result') {
        const name = open.get(String(event.data?.message?.toolCallId ?? ''))
        const text = (event.data?.message?.content ?? []).map(block => block.text ?? '').join('')
        biggest = Math.max(biggest, text.length)
        if (text.includes('Plan finished')) {
          report = text.length
          reportTruncated = text.includes('Omitted')
        }
        void name
      }
    }
    mainContext = events.filter(event => event.type === 'assistant/message')
      .reduce((sum, event) => sum + (event.data?.usage?.inputTokens ?? 0) + (event.data?.usage?.cacheReadTokens ?? 0), 0)
    break
  }

  const kinds = plan?.nodes?.map(node => node.kind).join(',') ?? '?'
  const correct = final.includes(FIRST) || final.includes('COMMIT_EDITMSG')
  console.log(`${label.padEnd(6)} #${index}  ${(wall / 1000).toFixed(0).padStart(4)}s  `
    + `nodes=${kinds.padEnd(8)} 主步=${String(steps).padStart(2)}  `
    + `主 agent 输出=${String(mainTokens).padStart(4)}tok  上下文累计=${(mainContext / 1000).toFixed(0).padStart(4)}k  `
    + `最大单条结果=${(biggest / 1000).toFixed(0).padStart(3)}k  `
    + `报告=${(report / 1000).toFixed(1)}k${reportTruncated ? ' 截断✗' : ' 完整✅'}  答对=${correct ? '✅' : '❌'}`)
  return { label, index, wall, kinds, steps, mainTokens, mainContext, biggest, report, reportTruncated, correct, plan, final }
}

const results = []
for (let index = 1; index <= runs; index += 1) {
  if (only !== 'worker') results.push(await run('tools', TOOLS_TASK, index))
  if (only !== 'tools') results.push(await run('worker', WORKER_TASK, index))
}

const avg = (items, pick) => items.reduce((sum, item) => sum + pick(item), 0) / Math.max(1, items.length)
console.log()
for (const label of only === 'worker' ? ['worker'] : only === 'tools' ? ['tools'] : ['tools', 'worker']) {
  const group = results.filter(item => item.label === label)
  const matched = group.filter(item => item.kinds !== '?' )
  console.log(`${label.padEnd(6)} 平均 ${(avg(group, item => item.wall) / 1000).toFixed(0)}s  `
    + `主 agent 输出 ${avg(group, item => item.mainTokens).toFixed(0)}tok  `
    + `上下文累计 ${avg(group, item => item.mainContext) / 1000 | 0}k  `
    + `最大单条结果 ${avg(group, item => item.biggest) / 1000 | 0}k  `
    + `报告完整 ${group.filter(item => !item.reportTruncated).length}/${group.length}  `
    + `答对 ${group.filter(item => item.correct).length}/${group.length}  `
    + `形状 ${matched.map(item => item.kinds).join(' / ') || '—'}`)
}
writeFileSync('D:/code/vibe/dsh-sandbox/pwsh-vs-worker.json', JSON.stringify(results, null, 2))

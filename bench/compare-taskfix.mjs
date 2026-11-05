/**
 * Compare two sets of coverage runs: what changed after the task guidance rewrite.
 *
 * Prints, per version: wall, token, steps, fleet, plan shapes (kinds and task
 * lengths), budget coverage, truncation, correctness. The task length and the
 * presence of a "Done when" clause are the two things the rewrite was about.
 *
 * Usage: node bench/compare-taskfix.mjs <task> <beforeDir> <afterDir>
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const RESULTS = 'D:/code/vibe/dsh-refine-loop/bench/results'
const SESSIONS = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const LF = String.fromCharCode(10)

const TASK = process.argv[2] ?? 'coverage'
const BEFORE = process.argv[3] ?? join(RESULTS, 'taskfix-before')
const AFTER = process.argv[4] ?? RESULTS

/**
 * @param values - the numbers.
 * @returns the median.
 */
function median(values) {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * @param dir - where the record lives.
 * @param index - the run index.
 * @returns the record, or undefined.
 */
function recordOf(dir, index) {
  try {
    return JSON.parse(readFileSync(join(dir, `${TASK}-on-${index}.json`), 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * @param record - one bench record.
 * @returns the plan shapes and task statistics.
 */
function plansOf(record) {
  const dir = readdirSync(SESSIONS).find(entry => entry === record.sessionId
    || entry.startsWith(record.sessionId.slice(8, 21)))
  if (dir === undefined) return { nodes: 0, budgets: 0, kinds: [], taskChars: [], doneWhen: 0, reports: 0, truncated: 0 }
  const events = []
  for (const file of readdirSync(join(SESSIONS, dir)).filter(entry => entry.endsWith('.zstd')).sort()) {
    try {
      events.push(...decodeLog(join(SESSIONS, dir, file)).split(LF).filter(Boolean).map(line => {
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
  let nodes = 0
  let budgets = 0
  const kinds = []
  const taskChars = []
  let doneWhen = 0
  let reports = 0
  let truncated = 0
  const open = new Map()
  for (const event of events) {
    if (event.type === 'tool/call' && event.data?.name === 'refine_plan') {
      try {
        const plan = JSON.parse(String(event.data.arguments))
        for (const node of plan.nodes ?? []) {
          nodes += 1
          if (node.budgetMs > 0) budgets += 1
          kinds.push(node.kind ?? '?')
          if (typeof node.task === 'string') {
            taskChars.push(node.task.length)
            if (/done when|done once|finished looks like|完成|算做完/i.test(node.task)) doneWhen += 1
          }
        }
      } catch {
        // refused plan
      }
      open.set(String(event.data.callId), true)
    }
    if (event.type === 'tool/result' && open.get(String(event.data?.message?.toolCallId ?? ''))) {
      const text = (event.data?.message?.content ?? []).map(block => block.text ?? '').join('')
      reports += 1
      if (text.includes('Omitted')) truncated += 1
      open.delete(String(event.data?.message?.toolCallId))
    }
  }
  return { nodes, budgets, kinds, taskChars, doneWhen, reports, truncated }
}

for (const [label, dir] of [['改前', BEFORE], ['改后', AFTER]]) {
  const runs = []
  for (let index = 1; index <= 5; index += 1) {
    const record = recordOf(dir, index)
    if (record === undefined) continue
    runs.push({ record, ...plansOf(record) })
  }
  if (runs.length === 0) {
    console.log(`${label}: 没有记录`)
    continue
  }
  const totalNodes = runs.reduce((sum, run) => sum + run.nodes, 0)
  const totalBudgets = runs.reduce((sum, run) => sum + run.budgets, 0)
  const allTasks = runs.flatMap(run => run.taskChars)
  const allKinds = runs.flatMap(run => run.kinds)
  const counts = {}
  for (const kind of allKinds) counts[kind] = (counts[kind] ?? 0) + 1
  console.log(`=== ${label} (${TASK} n=${runs.length}) ===`)
  console.log(`  墙钟 ${median(runs.map(run => run.record.wallMs / 1000)).toFixed(0)}s`
    + ` | token ${(median(runs.map(run => run.record.formation?.total ?? 0)) / 1000).toFixed(0)}k`
    + ` | 步数 ${median(runs.map(run => run.record.steps))}`
    + ` | 编队 ${runs.map(run => run.record.formation?.agents).join('/')}`)
  console.log(`  节点 ${totalNodes} | 预算 ${totalBudgets}/${totalNodes}`
    + ` | 种类 ${Object.entries(counts).map(([kind, count]) => `${kind}:${count}`).join(' ')}`)
  console.log(`  节点任务字数 中位 ${median(allTasks)?.toFixed(0) ?? '-'}`
    + ` | 带完成标准 ${runs.reduce((sum, run) => sum + run.doneWhen, 0)}/${allTasks.length}`
    + ` | 报告截断 ${runs.reduce((sum, run) => sum + run.truncated, 0)}/${runs.reduce((sum, run) => sum + run.reports, 0)}`)
  console.log(`  正确性 ${runs.map(run => `${run.record.correctness?.passed}/${run.record.correctness?.total}`).join(' ')}`)
}

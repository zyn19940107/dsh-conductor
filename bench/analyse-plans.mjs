/**
 * What do the plans actually look like?
 *
 * The proposal wants to drop the intra-round dependency machinery (`after`,
 * `@@nodeId@@` placeholders, topological layering). Whether that costs
 * anything depends on how often the models that ran in this benchmark used
 * those features, so this counts them over every session log the benchmark
 * produced.
 *
 * Usage: node analyse-plans.mjs
 */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const ROOT = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'

const files = []
for (const dir of readdirSync(ROOT, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue
  for (const name of readdirSync(join(ROOT, dir.name))) {
    if (name.endsWith('.zstd')) files.push(join(ROOT, dir.name, name))
  }
}
files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)

const kinds = new Map()
const stats = {
  plans: 0,
  plansWithAfter: 0,
  plansWithPlaceholder: 0,
  plansWithAgentNode: 0,
  nodes: 0,
  nodesWithAfter: 0,
  nodesWithPlaceholder: 0,
  agentNodes: 0,
  forkNodes: 0,
  plansWithSeveralWaves: 0,
  afterEdges: new Map(),
}

for (const path of files) {
  let text
  try {
    text = decodeLog(path)
  } catch {
    continue
  }
  for (const line of text.split('\n')) {
    if (!line.includes('"tool/call"') || !line.includes('refine_plan')) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    let input
    try {
      input = JSON.parse(event.data.arguments)
    } catch {
      continue
    }
    const nodes = Array.isArray(input.nodes) ? input.nodes : []
    if (nodes.length === 0) continue
    stats.plans += 1
    let withAfter = false
    let withPlaceholder = false
    let withAgent = false
    for (const node of nodes) {
      stats.nodes += 1
      kinds.set(node.kind, (kinds.get(node.kind) ?? 0) + 1)
      const after = Array.isArray(node.after) ? node.after : []
      if (after.length > 0) {
        withAfter = true
        stats.nodesWithAfter += 1
      }
      const calls = Array.isArray(node.calls) ? node.calls : []
      for (const call of calls) {
        if (JSON.stringify(call.arguments ?? '').includes('@@')) {
          withPlaceholder = true
          stats.nodesWithPlaceholder += 1
        }
      }
      if (node.kind === 'subagent') stats.agentNodes += 1
      if (node.kind === 'subagent_fork') stats.forkNodes += 1
      if (node.kind === 'subagent' || node.kind === 'subagent_fork') withAgent = true
    }
    if (withAfter) stats.plansWithAfter += 1
    // What do the after-edges connect?
    const kindOf = new Map(nodes.map(node => [String(node.id).trim(), node.kind]))
    for (const node of nodes) {
      for (const dependency of Array.isArray(node.after) ? node.after : []) {
        const from = kindOf.get(node.kind) ?? '?'
        const to = kindOf.get(String(dependency).trim()) ?? '?'
        const key = `${to} -> ${from}`
        stats.afterEdges.set(key, (stats.afterEdges.get(key) ?? 0) + 1)
      }
    }
    if (withPlaceholder) stats.plansWithPlaceholder += 1
    if (withAgent) stats.plansWithAgentNode += 1
    // A plan needs more than one layer only when some node depends on another.
    if (nodes.some(node => Array.isArray(node.after) && node.after.length > 0)) {
      stats.plansWithSeveralWaves += 1
    }
  }
}

console.log('=== 所有实测会话里的图 ===')
console.log(`图总数: ${stats.plans}  节点总数: ${stats.nodes}`)
console.log(`节点种类: ${JSON.stringify(Object.fromEntries(kinds))}`)
console.log(`用到 after 的图: ${stats.plansWithAfter} (${pct(stats.plansWithAfter, stats.plans)})`)
console.log(`用到 @@ 跨节点引用的图: ${stats.plansWithPlaceholder} (${pct(stats.plansWithPlaceholder, stats.plans)})`)
console.log(`用到 @@ 的节点: ${stats.nodesWithPlaceholder}`)
console.log(`含子代理节点的图: ${stats.plansWithAgentNode} (${pct(stats.plansWithAgentNode, stats.plans)})`)
console.log(`  其中 subagent 节点 ${stats.agentNodes} 个,subagent_fork 节点 ${stats.forkNodes} 个`)
console.log('after 边连的是哪两种节点(上游 -> 本节点):')
for (const [key, count] of [...stats.afterEdges.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${key}: ${count}`)
}

/**
 * A percentage as a display string.
 *
 * @param {number} part - the numerator.
 * @param {number} whole - the denominator.
 * @returns {string} the percentage.
 */
function pct(part, whole) {
  if (!whole) return '—'
  return `${Math.round((part / whole) * 100)}%`
}

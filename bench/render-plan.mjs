/**
 * Render a plan as a flowchart.
 *
 * A plan is a layered graph: the nodes that depend on nothing run together,
 * and the nodes that depend on those wait for them. This prints that graph
 * twice — as text for a terminal, and as Mermaid so a README renders it.
 *
 * Usage: node bench/render-plan.mjs [plan-file]
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const file = process.argv[2] ?? resolve(HERE, '..', 'docs', 'example-plan.json')
const plan = JSON.parse(readFileSync(file, 'utf8'))

/**
 * Split the plan into the layers that run one after the other.
 *
 * @param {object[]} nodes - the plan's nodes.
 * @returns {object[][]} the layers.
 */
function buildWaves(nodes) {
  const byId = new Map(nodes.map(node => [node.id, node]))
  const depth = new Map()
  const depthOf = (node) => {
    if (depth.has(node.id)) return depth.get(node.id)
    let layer = 0
    for (const dependency of node.after ?? []) {
      const other = byId.get(dependency)
      if (other === undefined) continue
      layer = Math.max(layer, depthOf(other) + 1)
    }
    depth.set(node.id, layer)
    return layer
  }
  for (const node of nodes) depthOf(node)
  const layers = Math.max(...nodes.map(node => depth.get(node.id) ?? 0)) + 1
  return Array.from({ length: layers }, () => [])
    .map((_, index) => nodes.filter(node => (depth.get(node.id) ?? 0) === index))
}

const waves = buildWaves(plan.nodes)

/**
 * The width of one node box in the text rendering.
 */
const BOX = 16

/**
 * One node's box.
 *
 * @param {object} node - the node.
 * @returns {string[]} the lines of the box.
 */
function box(node) {
  const label = node.id.length > 13 ? `${node.id.slice(0, 12)}…` : node.id
  return [
    `┌${'─'.repeat(BOX - 2)}┐`,
    `│ ${label.padEnd(BOX - 4)} │`,
    `│ ${node.kind.padEnd(BOX - 4)} │`,
    `└${'─'.repeat(BOX - 2)}┘`,
  ]
}

console.log('═══ 文字版 ═══')
for (const [index, wave] of waves.entries()) {
  const boxes = wave.map(box)
  console.log(`第 ${index + 1} 层（${wave.length} 个节点并行）`)
  for (let line = 0; line < boxes[0].length; line += 1) {
    console.log('  ' + boxes.map(parts => parts[line]).join(' '))
  }
  if (wave.length > 1) {
    const width = wave.length * BOX + (wave.length - 1)
    const stem = '  ' + ' '.repeat(Math.floor(width / 2))
    console.log(stem + '│')
    console.log(stem + '│  ← 都在等上一层')
  }
  console.log('')
}

console.log('═══ Mermaid(贴进 README 就能渲染)═══')
console.log('```mermaid')
console.log('graph TD')
for (const node of plan.nodes) {
  const label = `${node.id}<br/>${node.kind}`
  console.log(`  ${node.id.replace(/-/g, '_')}["${label}"]`)
}
for (const node of plan.nodes) {
  for (const dependency of node.after ?? []) {
    console.log(`  ${dependency.replace(/-/g, '_')} --> ${node.id.replace(/-/g, '_')}`)
  }
}
console.log('```')

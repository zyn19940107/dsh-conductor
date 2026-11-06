/**
 * Find the same sentence living in more than one guidance text.
 *
 * The plugin says things to the model in ten-odd places: the policy section, the
 * tool description, the parameter docs, the round messages, the refusals, the
 * child contract. A rule copied into two of them drifts in two directions and
 * costs context in both, so duplication is worth measuring, not assuming.
 *
 * Usage: node bench/audit-guidance.mjs
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = 'D:/code/vibe/dsh-refine-loop/src'

/**
 * The guidance texts, pulled out of the source by their markers.
 *
 * Strings are concatenated the way the module does it — the literals sit in the
 * source as `'...'` pieces joined with `+` — so the quotes and the join markers
 * come out before the text is compared.
 *
 * @param source - one source file.
 * @param start - the marker the block starts at.
 * @param end - the marker the block ends at.
 * @returns the joined text, or '' when the block is not there.
 */
function block(source, start, end) {
  const from = source.indexOf(start)
  if (from < 0) return ''
  const to = source.indexOf(end, from + start.length)
  const slice = to < 0 ? source.slice(from) : source.slice(from, to)
  return slice
    .split('\n')
    .map(line => line.replace(/^\s*(\+|:)?\s*/, ''))
    .filter(line => line.startsWith("'") || line.startsWith('"') || line.startsWith('`'))
    .map(line => line.replace(/^['"`]/, '').replace(/['"`],?\s*$/, '').replace(/['"`]\s*\+?\s*$/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const strings = readFileSync(join(SRC, 'tool.ts'), 'utf8')
const rounds = readFileSync(join(SRC, 'rounds.ts'), 'utf8')
const index = readFileSync(join(SRC, 'index.ts'), 'utf8')
const fork = readFileSync(join(SRC, 'fork.ts'), 'utf8')

const texts = new Map([
  ['系统提示词', block(index, 'export const REFINE_GUIDANCE = [', "].join('\\n')")],
  ['工具描述', block(strings, 'export const PLAN_TOOL_DESCRIPTION = ', '\n\n/**')],
  ['节点参数', block(strings, 'kind: {', '},')],
  ['任务参数', block(strings, 'task: {', '},')],
  ['ROUND_LOOP', block(rounds, 'export const ROUND_LOOP = ', '\n\n/**')],
  ['NEXT_ROUND', block(rounds, 'export const NEXT_ROUND = ', '\n\n/**')],
  ['DELEGATE_IN_GRAPH', block(rounds, 'export const DELEGATE_IN_GRAPH = ', '\n\n/**')],
  ['WORKER_NO_PLAN', block(rounds, 'export const WORKER_NO_PLAN = ', '\n\n/**')],
  ['子代理契约', block(strings, 'const contract = ', 'String.fromCharCode(10)')],
  ['worker 开场', block(strings, 'const opener = ', 'String.fromCharCode(10)')],
  ['预算到期提示', block(fork, 'function statusPrompt', '\n}')],
])

/**
 * Word shingles, so the same rule written slightly differently still shows up.
 *
 * @param text - a guidance text.
 * @returns its 6-word windows.
 */
function shinglesOf(text) {
  const words = text.toLowerCase().replace(/[.,;:!?'"()]/g, ' ').split(/\s+/).filter(Boolean)
  const out = []
  for (let index = 0; index + 6 <= words.length; index += 1) out.push(words.slice(index, index + 6).join(' '))
  return out
}

const seen = new Map()
for (const [name, text] of texts) {
  for (const shingle of shinglesOf(text)) {
    if (!seen.has(shingle)) seen.set(shingle, new Set())
    seen.get(shingle).add(name)
  }
}

// Report each overlapping run once: consecutive shingles shared by the same pair
// of texts are one paragraph of duplication, not twenty.
const runs = []
for (const [shingle, where] of seen) {
  if (where.size < 2) continue
  const pair = [...where].sort().join(' + ')
  const previous = runs.at(-1)
  if (previous !== undefined && previous.pair === pair && previous.texts.has(shingle)) {
    previous.shingles.push(shingle)
    continue
  }
  runs.push({ pair, texts: where, shingles: [shingle] })
}

let found = 0
for (const run of runs) {
  if (run.shingles.length < 2) continue
  found += 1
  console.log(`${run.pair}: ${run.shingles.join(' … ').slice(0, 220)}`)
}

console.log(found === 0 ? 'no sentence appears in two guidance texts' : `\n${found} duplicated sentence(s)`)
console.log(`\nmeasured: ${texts.size} texts, ${[...texts].map(([name, text]) => `${name} ${text.length}`).join(', ')}`)

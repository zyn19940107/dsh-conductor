/**
 * Temporary probe: does a plan node's "files" reach the child, and what
 * happens to a plan when one node's placeholder cannot be resolved?
 */

import { runPlan } from '../src/tool.js'
import type { BatchRunner } from '../src/batch.js'
import { parsePlanArgs } from '../src/plan.js'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'

const prompts: string[] = []
const runner: BatchRunner = {
  executionMode: () => ({ kind: 'parallel' }),
  async execute(exec) {
    if (exec.name === 'subagent') {
      prompts.push(String((exec.arguments as { prompt?: string }).prompt ?? ''))
    }
    return { isError: false, value: exec.name, content: [{ type: 'text', text: `ran ${exec.name}` }] }
  },
}

console.log('=== probe 1: files + question on an agent node ===')
const parsed = parsePlanArgs({
  criteria: ['the child answered'],
  nodes: [{
    id: 'judge',
    kind: 'subagent',
    files: ['D:\\code\\vibe\\dsh-refine-loop\\src\\index.ts'],
    question: 'What does apply() register?',
  }],
})
console.log('parsed node files:', JSON.stringify(parsed?.nodes[0]?.files))
console.log('parsed node task:', JSON.stringify(parsed?.nodes[0]?.task))
const output = await runPlan(
  runner,
  parsed!,
  undefined,
  new AbortController().signal,
  true,
  ToolCallId('probe:root'),
  {},
  1,
  300000,
)
console.log('child prompt was:', JSON.stringify(prompts[0]))

console.log('=== probe 2: unresolvable placeholder in a tools node ===')
const parsed2 = parsePlanArgs({
  criteria: ['x'],
  nodes: [
    { id: 'a', kind: 'tools', calls: [{ name: 'glob', arguments: { pattern: '*' } }] },
    { id: 'b', kind: 'tools', calls: [{ name: 'grep', arguments: { pattern: '@@missing@@' } }] },
  ],
})
console.log('b depends on:', JSON.stringify(parsed2?.nodes[1]?.after))
try {
  const out2 = await runPlan(
    runner,
    parsed2!,
    undefined,
    new AbortController().signal,
    true,
    ToolCallId('probe:root2'),
    {},
    1,
    300000,
  )
  console.log('plan finished, nodes:', out2.nodes.map(node => `${node.id}:${node.ok}`).join(' '))
} catch (error: unknown) {
  console.log('runPlan THREW:', error instanceof Error ? error.message : String(error))
}

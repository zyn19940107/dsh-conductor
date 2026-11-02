/**
 * The plan: how it is read, how it is layered, and how it runs.
 */

import { runPlan, renderPlan, type PlanOutput } from '../src/tool.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { BatchRunner } from '../src/batch.js'
import {
  buildWaves,
  parsePlanArgs,
  substitutePlaceholders,
  type PlanNode,
} from '../src/plan.js'

let failures = 0

/**
 * Assert one condition.
 *
 * @param name - what is being asserted.
 * @param condition - the condition that must hold.
 * @param detail - what to print when it does not.
 */
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ok   ${name}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

/**
 * The layers of a plan, or undefined when the plan does not hold together.
 *
 * @param nodes - the nodes of the plan.
 * @returns the layers.
 */
function wavesOf(nodes: PlanNode[]): PlanNode[][] | undefined {
  const built = buildWaves(nodes)
  return 'error' in built ? undefined : built.waves
}

/**
 * The reason a plan does not hold together.
 *
 * @param nodes - the nodes of the plan.
 * @returns the reason.
 */
function problemOf(nodes: PlanNode[]): string | undefined {
  const built = buildWaves(nodes)
  return 'error' in built ? built.error : undefined
}

/**
 * A node, written the short way.
 *
 * @param id - the node's name.
 * @param after - the nodes it depends on.
 * @returns the node.
 */
function node(id: string, after: string[] = []): PlanNode {
  return { id, kind: 'tools', calls: [{ name: 'echo', arguments: {} }], task: '', after }
}

console.log('parsePlanArgs')
{
  const parsed = parsePlanArgs({
    criteria: ['everything ran'],
    nodes: [
      { id: 'read', kind: 'tools', calls: [{ name: 'glob', arguments: { pattern: '*' } }] },
      { id: 'judge', kind: 'subagent', task: 'judge it', after: ['read'] },
    ],
  })
  check('accepts a plan', parsed !== undefined)
  check('keeps the criteria', parsed?.criteria.length === 1)
  check('keeps the nodes in order', parsed?.nodes[1]?.id === 'judge')
  check('keeps the dependency', parsed?.nodes[1]?.after[0] === 'read')
  check('keeps the agent task', parsed?.nodes[1]?.task === 'judge it')

  check('refuses a plan without criteria', parsePlanArgs({ nodes: [] }) === undefined)
  check('accepts a plan with no nodes', parsePlanArgs({ criteria: ['x'], nodes: [] })?.nodes.length === 0)
  check('refuses a duplicate id', parsePlanArgs({
    criteria: ['x'],
    nodes: [
      { id: 'a', kind: 'tools', calls: [{ name: 'x', arguments: {} }] },
      { id: 'a', kind: 'tools', calls: [{ name: 'x', arguments: {} }] },
    ],
  }) === undefined)
  check('refuses an unknown kind', parsePlanArgs({
    criteria: ['x'],
    nodes: [{ id: 'a', kind: 'telepathy', calls: [] }],
  }) === undefined)
  check('refuses a tools node without calls', parsePlanArgs({
    criteria: ['x'],
    nodes: [{ id: 'a', kind: 'tools' }],
  }) === undefined)
  check('refuses an agent node without a task', parsePlanArgs({
    criteria: ['x'],
    nodes: [{ id: 'a', kind: 'subagent' }],
  }) === undefined)
}

console.log('a placeholder in an argument is a dependency')
{
  const parsed = parsePlanArgs({
    criteria: ['x'],
    nodes: [
      { id: 'scan', kind: 'tools', calls: [{ name: 'glob', arguments: { pattern: '*' } }] },
      { id: 'use', kind: 'tools', calls: [{ name: 'grep', arguments: { pattern: '@@scan@@' } }] },
    ],
  })
  check('the referencing node depends on the referenced one',
    parsed?.nodes[1]?.after.includes('scan') === true)
  const layers = wavesOf(parsed?.nodes ?? [])
  check('the referenced node is in an earlier layer',
    layers?.[0]?.[0]?.id === 'scan' && layers?.[1]?.[0]?.id === 'use')
}

console.log('buildWaves')
{
  const flat = wavesOf([node('a'), node('b')])
  check('a flat plan is one layer', flat?.length === 1)
  check('the layer holds every node', flat?.[0].length === 2)

  const layered = wavesOf([node('a'), node('b', ['a'])])
  check('a dependency makes a second layer', layered?.length === 2)
  check('the dependency comes first', layered?.[0][0]?.id === 'a')

  const deep = wavesOf([node('a'), node('b', ['a']), node('c', ['b'])])
  check('a chain makes one layer each', deep?.length === 3)

  check('refuses a cycle', wavesOf([node('a', ['b']), node('b', ['a'])]) === undefined)
  check('the cycle says so', (problemOf([node('a', ['b']), node('b', ['a'])]) ?? '').includes('cycle'))
  check('refuses a dependency that does not exist', wavesOf([node('a', ['nope'])]) === undefined)
  check('the missing dependency says so',
    (problemOf([node('a', ['nope'])]) ?? '').includes('not a node of this plan'))
  check('refuses a node that depends on itself', wavesOf([node('a', ['a'])]) === undefined)
  check('the self dependency says so', (problemOf([node('a', ['a'])]) ?? '').includes('itself'))
}

console.log('substitutePlaceholders')
{
  const outputs = new Map([['read', 'the file list']])
  check('replaces an exact placeholder', substitutePlaceholders('@@read@@', outputs) === 'the file list')
  check('pastes an inline placeholder where it stands',
    substitutePlaceholders('x @@read@@ y', outputs) === 'x the file list y')
  check('replaces inside an object',
    JSON.stringify(substitutePlaceholders({ pattern: '@@read@@' }, outputs)) === '{"pattern":"the file list"}')
  check('replaces inside an array',
    JSON.stringify(substitutePlaceholders(['@@read@@'], outputs)) === '["the file list"]')

  let refused = false
  try {
    substitutePlaceholders('@@nope@@', outputs)
  } catch (error: unknown) {
    refused = error instanceof Error && error.message.includes('nope')
  }
  check('refuses a placeholder it cannot resolve', refused)
}

console.log('runPlan')
{
  const calls: string[] = []
  const prompts: string[] = []
  const runner: BatchRunner = {
    executionMode: () => ({ kind: 'parallel' }),
    async execute(exec) {
      calls.push(exec.name)
      if (exec.name === 'subagent') {
        prompts.push(String((exec.arguments as { prompt?: string }).prompt ?? ''))
      }
      return {
        isError: false,
        value: exec.name,
        content: [{ type: 'text', text: `ran ${exec.name}` }],
      }
    },
  }
  const output = await runPlan(
    runner,
    {
      criteria: ['every node ran'],
      nodes: [
        { id: 'read', kind: 'tools', calls: [{ name: 'glob', arguments: { pattern: '*' } }], task: '', after: [] },
        { id: 'judge', kind: 'subagent', calls: [], task: 'judge the listing', after: ['read'] },
        { id: 'fresh', kind: 'subagent', calls: [], task: 'look it up', after: [] },
      ],
    },
    undefined,
    new AbortController().signal,
    true,
    ToolCallId('refine-loop:test:root'),
    {},
    1,
    300000,
  )

  check('every node ran', output.nodes.length === 3)
  check('the results keep the plan order', output.nodes[0]?.id === 'read')
  check('the plan had two layers', output.waves === 2)
  check('the shape is mixed', output.schedule === 'mixed')
  check('the tool node ran its call', calls.includes('glob'))
  check('the child node ran', calls.includes('subagent'))
  check('the fresh node ran', calls.includes('subagent'))
  check('the fork child was given the dependency output',
    prompts.some(prompt => prompt.includes('judge the listing') && prompt.includes('ran glob')))
  check('every node succeeded', output.nodes.every(result => result.ok))

  const text = renderPlan(output)
  check('the render names every node', text.includes('read') && text.includes('judge') && text.includes('fresh'))
  check('the render says the turn is over', text.includes('Every result is above. The turn is over.'))
}

console.log('a plan may not start an agent from inside a child')
{
  const runner: BatchRunner = {
    executionMode: () => ({ kind: 'parallel' }),
    async execute() {
      return { isError: false, value: '', content: [] }
    },
  }
  const agent = {
    session: { id: 'child', header: { delegationDepth: 1 } },
  } as unknown as Agent
  const output = await runPlan(
    runner,
    {
      criteria: ['x'],
      nodes: [{ id: 'child-agent', kind: 'subagent', calls: [], task: 'go', after: [] }],
    },
    agent,
    new AbortController().signal,
    true,
    ToolCallId('refine-loop:test:root'),
    {},
    1,
    300000,
  )
  check('the agent node was refused', output.nodes[0]?.ok === false)
  check('the refusal says why', (output.nodes[0]?.error ?? '').includes('delegated child'))
}

console.log('a node that runs out of time is reported, and the plan carries on')
{
  const runner: BatchRunner = {
    executionMode: () => ({ kind: 'parallel' }),
    async execute(exec) {
      if (exec.name === 'subagent') {
        await new Promise(resolve => setTimeout(resolve, 5000))
      }
      return { isError: false, value: exec.name, content: [{ type: 'text', text: 'ok' }] }
    },
  }
  const output = await runPlan(
    runner,
    {
      criteria: ['x'],
      nodes: [
        { id: 'slow', kind: 'subagent', calls: [], task: 'go', after: [] },
        { id: 'quick', kind: 'tools', calls: [{ name: 'glob', arguments: {} }], task: '', after: [] },
      ],
    },
    undefined,
    new AbortController().signal,
    true,
    ToolCallId('refine-loop:test:root'),
    {},
    1,
    120,
  )
  check('the slow node failed', output.nodes[0]?.ok === false)
  check('the failure says it ran out of time',
    (output.nodes[0]?.error ?? '').includes('ran out of its'))
  check('the other node still ran', output.nodes[1]?.ok === true)
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')

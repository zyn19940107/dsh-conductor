/**
 * The plan: how it is read, how its nodes are grouped, and how it runs.
 *
 * The plan is one layer. Every node starts at the same time; the only thing
 * that can split the layer is two nodes writing the same file.
 */

import { runPlan, renderPlan, type PlanOutput } from '../src/tool.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { BatchRunner } from '../src/batch.js'
import {
  WORKER_MARKER,
  buildGroups,
  parsePlanArgs,
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
 * A parent conversation, as much of it as the plan tool reads.
 *
 * @param depth - the delegation depth.
 * @returns the agent.
 */
function fakeAgent(depth = 0): Agent {
  return {
    session: {
      id: 'session-parent',
      header: { delegationDepth: depth, cwd: '/tmp' },
      requestHeader: () => undefined,
      snapshotEvents: () => [],
    },
    options: undefined,
    ctx: {},
  } as unknown as Agent
}

/**
 * A node, written the short way.
 *
 * @param id - the node's name.
 * @param writes - the files it writes.
 * @returns the node.
 */
function node(id: string, writes: string[] = []): PlanNode {
  return { id, kind: 'tools', calls: [{ name: 'echo', arguments: {} }], task: '', order: 'parallel', writes }
}

/**
 * The agent factory the plan tool spawns children through.
 *
 * Every agent node is started by the plugin itself now, so the fake is an
 * `agentLoop` rather than a delegation tool on the runner: the checks look at
 * what the children were told, not at which harness tool was called.
 *
 * @param prompts - receives every message a child is sent.
 * @param behavior - whether a child answers, or never goes idle.
 * @returns the plan tool's fork options.
 */
function fakeFork(prompts: string[], behavior: 'answer' | 'never' = 'answer') {
  let created = 0
  const agentLoop = {
    async createAgent(_owner: unknown, _options: Record<string, unknown>) {
      created += 1
      const id = `child-${created}`
      const events: Array<Record<string, unknown>> = []
      const child = {
        session: {
          id,
          header: { delegationDepth: 2, cwd: '/tmp' },
          snapshotEvents: () => events,
        },
        followup(message: { content?: Array<{ text?: string }> }) {
          const text = (message.content ?? []).map(block => block.text ?? '').join('')
          prompts.push(text)
          if (behavior === 'answer') {
            events.push({
              type: 'assistant/message',
              seq: events.length + 1,
              time: 1,
              data: { message: { content: [{ type: 'text', text: `done by ${id}` }] } },
            })
          }
        },
        whenIdle: () => behavior === 'never' ? new Promise<void>(() => {}) : Promise.resolve(),
        cancel: () => {},
      }
      return { agent: child as unknown as Agent, dispose: async () => {} }
    },
  }
  return { host: { agentLoop }, onWorker: undefined }
}

console.log('parsePlanArgs')
{
  const parsed = parsePlanArgs({
    criteria: ['everything ran'],
    nodes: [
      { id: 'read', kind: 'tools', calls: [{ name: 'glob', arguments: { pattern: '*' } }] },
      { id: 'work', kind: 'worker', task: 'do the work' },
      { id: 'judge', kind: 'spawner', task: 'judge it' },
      { id: 'fork', kind: 'forker', task: 'carry it on' },
    ],
  })
  check('accepts a plan', parsed !== undefined)
  check('keeps the criteria', parsed?.criteria.length === 1)
  check('keeps the nodes in order', parsed?.nodes[2]?.id === 'judge')
  check('keeps the agent task', parsed?.nodes[2]?.task === 'judge it')
  check('knows the four kinds',
    parsed?.nodes.map(node => node.kind).join(',') === 'tools,worker,spawner,forker')

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
    nodes: [{ id: 'a', kind: 'worker' }],
  }) === undefined)
  check('refuses a spawner without a task', parsePlanArgs({
    criteria: ['x'],
    nodes: [{ id: 'a', kind: 'spawner' }],
  }) === undefined)
}

console.log('a tools node says how its calls run, and what it writes')
{
  const sequential = parsePlanArgs({
    criteria: ['x'],
    nodes: [{ id: 'a', kind: 'tools', order: 'sequential', calls: [{ name: 'x', arguments: {} }] }],
  })
  check('reads the sequential order', sequential?.nodes[0]?.order === 'sequential')

  const byDefault = parsePlanArgs({
    criteria: ['x'],
    nodes: [{ id: 'a', kind: 'tools', calls: [{ name: 'x', arguments: {} }] }],
  })
  check('parallel is the default', byDefault?.nodes[0]?.order === 'parallel')

  const writes = parsePlanArgs({
    criteria: ['x'],
    nodes: [{ id: 'a', kind: 'tools', writes: ['/tmp/a.txt'], calls: [{ name: 'x', arguments: {} }] }],
  })
  check('reads the write scope', writes?.nodes[0]?.writes[0] === '/tmp/a.txt')
  check('an empty write scope stays empty', byDefault?.nodes[0]?.writes.length === 0)
}

console.log('buildGroups')
{
  const flat = buildGroups([node('a'), node('b')])
  check('nodes with no writes run in one group', flat.length === 1)
  check('the group holds every node', flat[0]?.length === 2)

  const declared = buildGroups([node('a', ['/tmp/a']), node('b', ['/tmp/b'])])
  check('disjoint writes still run together', declared.length === 1)

  const conflict = buildGroups([node('a', ['/tmp/x']), node('b', ['/tmp/x'])])
  check('two nodes writing one file are separated', conflict.length === 2)
  check('the first write comes first', conflict[0]?.[0]?.id === 'a')
  check('the second write comes second', conflict[1]?.[0]?.id === 'b')

  const mixed = buildGroups([node('a', ['/tmp/x']), node('b'), node('c', ['/tmp/x'])])
  check('a node with no declared writes joins the first group', mixed[0]?.length === 2)
  check('the conflicting write is on its own', mixed[1]?.[0]?.id === 'c')
}

console.log('runPlan')
{
  const calls: string[] = []
  const prompts: string[] = []
  const runner: BatchRunner = {
    executionMode: () => ({ kind: 'parallel' }),
    async execute(exec) {
      calls.push(exec.name)
      if (exec.name === 'subagent' || exec.name === 'subagent_fork') {
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
        { id: 'read', kind: 'tools', calls: [{ name: 'glob', arguments: { pattern: '*' } }], task: '', order: 'parallel', writes: [] },
        { id: 'work', kind: 'worker', calls: [], task: 'do the work', order: 'parallel', writes: [] },
        { id: 'fresh', kind: 'spawner', calls: [], task: 'look it up', order: 'parallel', writes: [] },
      ],
    },
    fakeAgent(),
    new AbortController().signal,
    true,
    ToolCallId('refine-loop:test:root'),
    {},
    1,
    300000,
    undefined,
    fakeFork(prompts),
  )

  check('every node ran', output.nodes.length === 3)
  check('the results keep the plan order', output.nodes[0]?.id === 'read')
  check('the plan ran in one group', output.groups === 1)
  check('the tool node ran its call', calls.includes('glob'))
  check('both agent children were started by the plugin', prompts.length === 2)
  check('the tools node never went through a child', calls.length === 1)
  check('the worker prompt is marked',
    prompts.some(prompt => prompt.startsWith(WORKER_MARKER)))
  check('the worker is told not to plan',
    prompts.some(prompt => prompt.includes('Do not draw a plan')))
  // The contract has to be the last thing a child reads, and it has to say it
  // wins over a task that asks for a report — the task sits above it and would
  // otherwise be what the child follows.
  check('every child prompt ends with the conclusion contract',
    prompts.every(prompt => prompt.trim().endsWith('the parent composes the final answer.')))
  check('the contract says it overrides a report-shaped task',
    prompts.every(prompt => prompt.includes('even when the task above asks for a fuller report')))
  check('the contract comes after the criteria',
    prompts.every(prompt => prompt.indexOf('What this plan is judged on') < prompt.indexOf('What comes back from you')))
  if (prompts[0] !== undefined) {
    console.log('  --- the composed prompt a child actually receives ---')
    for (const line of prompts[0].split(String.fromCharCode(10))) console.log('  | ' + line)
  }
  check('a spawner prompt is not marked',
    prompts.some(prompt => !prompt.includes(WORKER_MARKER) && prompt.includes('look it up')))
  check('every node succeeded', output.nodes.every(result => result.ok))

  const text = renderPlan(output)
  check('the render names every node', text.includes('read') && text.includes('work') && text.includes('fresh'))
  check('the render says the layer ran in parallel', text.includes('run in parallel'))
  check('the render says the turn is over', text.includes('Every result is above. The turn is over.'))
}

console.log('two nodes writing one file do not run together')
{
  const order: string[] = []
  const runner: BatchRunner = {
    executionMode: () => ({ kind: 'parallel' }),
    async execute(exec) {
      order.push(String((exec.arguments as { pattern?: string }).pattern ?? exec.name))
      return { isError: false, value: '', content: [{ type: 'text', text: 'done' }] }
    },
  }
  const output = await runPlan(
    runner,
    {
      criteria: ['x'],
      nodes: [
        { id: 'one', kind: 'tools', calls: [{ name: 'write', arguments: { pattern: 'one' } }], task: '', order: 'parallel', writes: ['/tmp/same'] },
        { id: 'two', kind: 'tools', calls: [{ name: 'write', arguments: { pattern: 'two' } }], task: '', order: 'parallel', writes: ['/tmp/same'] },
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
  check('the plan ran in two groups', output.groups === 2)
  check('the first writer ran first', order[0] === 'one')
  check('the second writer ran after', order[1] === 'two')
}

console.log('a child that inherits the conversation needs a conversation to inherit')
{
  const runner: BatchRunner = {
    executionMode: () => ({ kind: 'parallel' }),
    async execute() {
      return { isError: false, value: '', content: [] }
    },
  }
  const output = await runPlan(
    runner,
    {
      criteria: ['x'],
      nodes: [
        { id: 'w', kind: 'worker', calls: [], task: 'go', order: 'parallel', writes: [] },
        { id: 'f', kind: 'forker', calls: [], task: 'go', order: 'parallel', writes: [] },
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
  check('the worker was refused', output.nodes[0]?.ok === false)
  check('the refusal says why', (output.nodes[0]?.error ?? '').includes('inherits it'))
  check('the forker was refused', output.nodes[1]?.ok === false)
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
      nodes: [{ id: 'child-agent', kind: 'spawner', calls: [], task: 'go', order: 'parallel', writes: [] }],
    },
    agent,
    new AbortController().signal,
    true,
    ToolCallId('refine-loop:test:root'),
    {},
    1,
    300000,
    undefined,
    fakeFork([]),
  )
  check('the agent node was refused', output.nodes[0]?.ok === false)
  check('the refusal says why', (output.nodes[0]?.error ?? '').includes('delegated child'))
}

console.log('a node that runs out of time is reported, and the plan carries on')
{
  // The plugin's own budget timers are unref'd, so in a harness they never hold
  // the process open. This spec is the whole process, so it holds it open itself.
  const keepAlive = setTimeout(() => {}, 2000)
  const runner: BatchRunner = {
    executionMode: () => ({ kind: 'parallel' }),
    async execute(exec) {
      if (exec.name === 'subagent' || exec.name === 'subagent_fork') {
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
        { id: 'slow', kind: 'worker', calls: [], task: 'go', order: 'parallel', writes: [] },
        { id: 'quick', kind: 'tools', calls: [{ name: 'glob', arguments: {} }], task: '', order: 'parallel', writes: [] },
      ],
    },
    fakeAgent(),
    new AbortController().signal,
    true,
    ToolCallId('refine-loop:test:root'),
    {},
    1,
    120,
    undefined,
    fakeFork([], 'never'),
  )
  check('the slow node failed', output.nodes[0]?.ok === false)
  check('the failure says the budget was spent',
    (output.nodes[0]?.error ?? '').toLowerCase().includes('budget'))
  check('the other node still ran', output.nodes[1]?.ok === true)
  clearTimeout(keepAlive)
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')

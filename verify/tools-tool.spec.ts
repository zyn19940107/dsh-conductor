/**
 * The batch tool that stands outside the plan.
 *
 * A worker cannot draw a graph, so the plan's tools node is out of its reach. The
 * batch it runs is not: the same scheduler and the same cap are published as the
 * `tools` tool to the conversations that cannot plan, and refused everywhere else
 * so the plan-first rule does not change.
 */

import { applyToolsTool, readToolsCalls, TOOLS_TOOL } from '../src/tools-tool.js'
import type { Workers } from '../src/rounds.ts'

let failures = 0

/**
 * Assert one condition.
 *
 * @param name - what is being asserted.
 * @param condition - the condition that must hold.
 */
function check(name: string, condition: boolean): void {
  if (condition) {
    console.log(`  ok   ${name}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${name}`)
}

/** A workers registry that knows one session. */
function fakeWorkers(known: string): Workers {
  return {
    mark: () => undefined,
    has: (sessionId: string) => sessionId === known,
    isWorkerText: () => false,
    forget: () => undefined,
  } as unknown as Workers
}

/**
 * Register the tool against a fake context and read the definition back.
 *
 * @param workers - the conversations that count as leaves.
 * @returns the captured definition.
 */
function registered(workers: Workers): any {
  let captured: any
  const ctx = {
    tools: { register: (definition: unknown) => { captured = definition } },
  } as unknown as Parameters<typeof applyToolsTool>[0]
  applyToolsTool(ctx, {
    workers,
    respectConcurrencySafety: () => true,
    overrides: () => ({}),
    timeoutMs: () => 600_000,
  })
  return captured
}

console.log('the tool is registered under its own name')
{
  const definition = registered(fakeWorkers('session-worker'))
  check('its name is "tools"', definition.name === TOOLS_TOOL)
  check('its description is not empty', String(definition.description).length > 100)
  // defineTool converts the parameter spec to JSON schema before registering it.
  const properties = definition.parameters.properties
  check('it takes a calls array', properties.calls.type === 'array')
  check('the calls are objects with name and arguments',
    properties.calls.items.properties.name.type === 'string'
    && properties.calls.items.properties.arguments !== undefined)
  check('the order is optional and bounded',
    properties.order.type === 'string'
    && properties.order.enum.join(',') === 'parallel,sequential')
  check('only calls is required', (definition.parameters.required ?? []).join(',') === 'calls')
}

console.log('the calls are read strictly')
{
  check('a normal batch reads back', readToolsCalls([{ name: 'read', arguments: { file_path: 'a.ts' } }])?.length === 1)
  check('an empty batch is not a batch', readToolsCalls([]) === undefined)
  check('a call without a name is refused', readToolsCalls([{ arguments: {} }]) === undefined)
  check('a call without arguments still runs',
    readToolsCalls([{ name: 'pwsh' }])?.[0]?.arguments !== undefined)
}

console.log('a conversation that cannot plan is the only one the tool accepts')
{
  const definition = registered(fakeWorkers('session-worker'))
  let refused = false
  try {
    await definition.execute({ calls: [{ name: 'read', arguments: { file_path: 'a.ts' } }] }, {
      agent: { session: { id: 'session-root', requestHeader: () => undefined } },
      signal: new AbortController().signal,
      callId: 'call-1',
    })
  } catch (error: unknown) {
    refused = String(error instanceof Error ? error.message : error).includes('can draw a plan')
  }
  check('a conversation that can plan is refused, and told to use refine_plan', refused)
}

if (failures > 0) {
  console.log(`${failures} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('all checks passed')
}
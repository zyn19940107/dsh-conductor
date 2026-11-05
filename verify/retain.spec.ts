/**
 * The plan report is never truncated.
 *
 * The harness mounts a spill policy on `tools/post-execute`: a result past its
 * budget is replaced by its head, its tail and a path to the rest. That policy
 * skips a decision that carries a `value`, so the plugin answers for
 * `refine_plan` with one — the report is handed over by value and rendered
 * whole, and the policy's `next` is never reached.
 */

import { applyReportRetention } from '../src/index.js'
import { PLAN_TOOL } from '../src/tool.js'

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

type Listener = (
  exec: { name: string },
  result: { content: { type: string, text: string }[], value: unknown, isError: boolean },
  next: () => Promise<unknown>,
) => Promise<unknown>

/**
 * Capture the listener the plugin registers.
 *
 * @returns the listener and its registration options.
 */
function registered(): { listener: Listener, options: unknown } {
  let listener: Listener | undefined
  let options: unknown
  const ctx = {
    on: (name: string, fn: Listener, config?: unknown) => {
      if (name !== 'tools/post-execute') throw new Error(`unexpected event ${name}`)
      listener = fn
      options = config
    },
  }
  applyReportRetention(ctx as never)
  if (listener === undefined) throw new Error('no listener registered')
  return { listener, options }
}

const report = {
  criteria: ['c'],
  groups: 1,
  nodes: [{ id: 'a', kind: 'tools' as const, ok: true, output: 'big', error: '' }],
}

// 1. The plan report is answered by value, and the spill policy is never reached.
{
  const { listener, options } = registered()
  let nextCalled = false
  const decision = await listener(
    { name: PLAN_TOOL },
    { content: [{ type: 'text', text: 'Plan finished — …' }], value: report, isError: false },
    async () => {
      nextCalled = true
      return { kind: 'accept', content: [{ type: 'text', text: 'TRUNCATED' }] }
    },
  ) as { kind: string, value?: unknown, content?: unknown }
  check('refine_plan: answered by value', decision.kind === 'accept' && decision.value === report)
  check('refine_plan: no content (the policy is skipped)', decision.content === undefined)
  check('refine_plan: spill policy not reached', nextCalled === false)
  check('hook registered prepended', (options as { prepend?: boolean } | undefined)?.prepend === true)
}

// 2. A failed plan result is left to the chain: the harness throws when a policy
//    replaces the value of a failure, so accepting here would hide the failure.
{
  const { listener } = registered()
  let nextCalled = false
  const decision = await listener(
    { name: PLAN_TOOL },
    { content: [{ type: 'text', text: 'aborted' }], value: undefined, isError: true },
    async () => {
      nextCalled = true
      return { kind: 'accept', content: [{ type: 'text', text: 'aborted' }] }
    },
  ) as { content?: { text: string }[], value?: unknown }
  check('failed plan: policy chain runs', nextCalled === true)
  check('failed plan: no value replacement', decision.value === undefined)
  check('failed plan: the failure itself passes through', decision.content?.[0]?.text === 'aborted')
}

// 3. Every other tool still goes through the chain unchanged.
{
  const { listener } = registered()
  let nextCalled = false
  const decision = await listener(
    { name: 'pwsh' },
    { content: [{ type: 'text', text: 'x' }], value: undefined, isError: false },
    async () => {
      nextCalled = true
      return { kind: 'accept', content: [{ type: 'text', text: 'SPILLED' }] }
    },
  ) as { content?: { text: string }[] }
  check('other tools: policy runs', nextCalled === true)
  check('other tools: decision passes through', decision.content?.[0]?.text === 'SPILLED')
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nretain: ok')

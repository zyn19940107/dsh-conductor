/**
 * The loop that fixes a failed call inside a plan.
 *
 * A plan is one round trip and the turn does not come back to redraw it, so a
 * call that fails has to be repaired where it happens: run it, read the error,
 * ask the model what the call should have been, run that. The point of this
 * spec is that the repair costs nothing when nothing fails.
 */

import { runBatch, type BatchRunner } from '../src/batch.js'
import { parseRepair } from '../src/repair.js'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'

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

/** A resolve-side answer that looks like a successful read. */
const okResult = {
  isError: false as const,
  value: null,
  content: [{ type: 'text' as const, text: 'line one' }],
}

/**
 * Build a runner that fails the first call and answers the second.
 *
 * @param seen - collects the arguments each call was made with.
 * @returns the runner.
 */
function failingOnce(seen: unknown[]): BatchRunner {
  let calls = 0
  return {
    executionMode: () => ({ kind: 'parallel' }),
    async execute(input) {
      calls += 1
      seen.push(input.arguments)
      if (calls === 1) {
        return {
          isError: true as const,
          error: { message: 'read: invalid arguments: "limit" must be a number' },
          content: [{ type: 'text' as const, text: 'boom' }],
        }
      }
      return okResult
    },
  }
}

/**
 * Build a runner that always succeeds.
 *
 * @returns the runner.
 */
function alwaysOk(): BatchRunner {
  return {
    executionMode: () => ({ kind: 'parallel' }),
    async execute() {
      return okResult
    },
  }
}

const signal = new AbortController().signal
const root = ToolCallId('plan-root')

console.log('a failed call is repaired once, and the fix is what runs')
{
  const seen: unknown[] = []
  let asked = 0
  const output = await runBatch(
    failingOnce(seen),
    { criteria: ['x'], calls: [{ name: 'read', arguments: { file_path: 'a.ts', limit: '5' } }] },
    undefined,
    signal,
    false,
    root,
    {},
    async () => {
      asked += 1
      return { name: 'read', arguments: { file_path: 'a.ts', limit: 5 } }
    },
  )
  check('the model was asked once', asked === 1)
  check('the call ended ok', output.results[0]?.ok === true)
  check('the first attempt used the plan\'s arguments',
    JSON.stringify(seen[0]) === JSON.stringify({ file_path: 'a.ts', limit: '5' }))
  check('the second attempt used the repaired arguments',
    JSON.stringify(seen[1]) === JSON.stringify({ file_path: 'a.ts', limit: 5 }))
}

console.log('a call that works is never repaired')
{
  let asked = 0
  const output = await runBatch(
    alwaysOk(),
    { criteria: ['x'], calls: [{ name: 'read', arguments: { file_path: 'a.ts' } }] },
    undefined,
    signal,
    false,
    root,
    {},
    async () => {
      asked += 1
      return undefined
    },
  )
  check('the model was never asked', asked === 0)
  check('the call ended ok', output.results[0]?.ok === true)
}

console.log('a repair that gives nothing usable stops the loop')
{
  const seen: unknown[] = []
  let asked = 0
  const output = await runBatch(
    failingOnce(seen),
    { criteria: ['x'], calls: [{ name: 'read', arguments: { file_path: 'missing.ts' } }] },
    undefined,
    signal,
    false,
    root,
    {},
    async () => {
      asked += 1
      return undefined
    },
  )
  check('the model was asked once', asked === 1)
  check('the call is reported failed', output.results[0]?.ok === false)
  check('the failure carries the tool\'s message',
    (output.results[0]?.error ?? '').includes('limit'))
}

console.log('the repair answer is read as a call, or not at all')
{
  check('a plain JSON call parses',
    parseRepair('{"name":"read","arguments":{"file_path":"a.ts"}}', 'read')?.name === 'read')
  check('prose around the JSON is tolerated',
    parseRepair('here you go: {"name":"glob","arguments":{"pattern":"*.ts"}} done', 'read')?.name === 'glob')
  check('junk is refused', parseRepair('I could not fix it.', 'read') === undefined)
  check('an array is refused', parseRepair('{"name":"read","arguments":[]}', 'read') === undefined)
}

if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
/**
 * The behaviour the plugin exists for: a batch costs one round trip, and the
 * calls that may run together actually run together.
 *
 * The runner below records when each call started and ended, so the specs can
 * look at the overlap rather than at a summary.
 */

import { capOutput, MAX_CALL_OUTPUT_CHARS, runBatch, type BatchRunner } from '../src/batch.js'

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

/** One recorded call. */
interface Recorded {
  name: string
  start: number
  end: number
}

/**
 * A runner that records the window each call ran in.
 *
 * @param exclusive - the tools that declare themselves unsafe to run together.
 * @param delayMs - how long each call takes.
 * @returns the runner and the record it writes to.
 */
function createRunner(exclusive: string[], delayMs: number): { runner: BatchRunner, recorded: Recorded[] } {
  const recorded: Recorded[] = []
  const runner: BatchRunner = {
    executionMode(exec) {
      return { kind: exclusive.includes(exec.name) ? 'exclusive' : 'parallel' }
    },
    async execute(exec) {
      const start = Date.now()
      await new Promise(resolve => setTimeout(resolve, delayMs))
      const end = Date.now()
      recorded.push({ name: exec.name, start, end })
      return {
        isError: false,
        value: exec.name,
        content: [{ type: 'text', text: `${exec.name} done` }],
      }
    },
  }
  return { runner, recorded }
}

/**
 * Whether two recorded windows overlapped.
 *
 * @param a - the first window.
 * @param b - the second window.
 * @returns true when they overlapped.
 */
function overlapped(a: Recorded, b: Recorded): boolean {
  return a.start < b.end && b.start < a.end
}

/**
 * Build a plan out of tool names.
 *
 * @param names - the tools to call.
 * @returns the plan.
 */
function plan(names: string[]): { criteria: string[], calls: { name: string, arguments: unknown }[] } {
  return {
    criteria: ['every call ran'],
    calls: names.map(name => ({ name, arguments: {} })),
  }
}

const signal = new AbortController().signal

console.log('a batch of parallel-safe calls runs together')
{
  const { runner, recorded } = createRunner([], 120)
  const started = Date.now()
  const output = await runBatch(runner, plan(['a', 'b', 'c']), undefined, signal, true)
  const elapsed = Date.now() - started

  check('every call ran', output.results.length === 3)
  check('every call succeeded', output.results.every(item => item.ok))
  check('the schedule is concurrent', output.schedule === 'concurrent')
  check('every call is marked concurrent', output.results.every(item => item.scheduled === 'concurrent'))
  check('the windows overlap', recorded.length === 3
    && overlapped(recorded[0]!, recorded[1]!)
    && overlapped(recorded[1]!, recorded[2]!))
  check('the batch took less than three calls', elapsed < 300, `took ${elapsed}ms`)
  check('the results keep the plan order',
    output.results[0]?.name === 'a' && output.results[2]?.name === 'c')
}

console.log('a batch honours a tool that declares itself exclusive')
{
  const { runner, recorded } = createRunner(['b'], 120)
  const output = await runBatch(runner, plan(['a', 'b', 'c']), undefined, signal, true)

  check('every call ran', output.results.length === 3)
  check('the schedule is mixed', output.schedule === 'mixed')
  check('the exclusive call is marked serial', output.results[1]?.scheduled === 'serial')
  check('the other calls are marked concurrent',
    output.results[0]?.scheduled === 'concurrent' && output.results[2]?.scheduled === 'concurrent')
  // The record is in completion order, so the windows are looked up by name.
  const first = recorded.find(entry => entry.name === 'a')
  const exclusive = recorded.find(entry => entry.name === 'b')
  const last = recorded.find(entry => entry.name === 'c')
  check('the exclusive call did not overlap the concurrent ones',
    first !== undefined && exclusive !== undefined && last !== undefined
    && !overlapped(first, exclusive) && !overlapped(exclusive, last))
}

console.log('a deployment that trusts its tools can run them together anyway')
{
  const { runner, recorded } = createRunner(['a', 'b'], 120)
  const output = await runBatch(runner, plan(['a', 'b']), undefined, signal, false)

  check('the schedule is concurrent', output.schedule === 'concurrent')
  check('the windows overlap', recorded.length === 2 && overlapped(recorded[0]!, recorded[1]!))
}

console.log('a call that fails is reported, not thrown')
{
  const runner: BatchRunner = {
    executionMode: () => ({ kind: 'parallel' }),
    async execute(exec) {
      if (exec.name === 'bad') {
        return {
          isError: true,
          value: null,
          content: [{ type: 'text', text: 'it failed' }],
          error: { message: 'the call failed' },
        }
      }
      return { isError: false, value: 'ok', content: [{ type: 'text', text: 'ok' }] }
    },
  }
  const output = await runBatch(runner, plan(['good', 'bad']), undefined, signal, true)

  check('the batch finished', output.results.length === 2)
  check('the good call succeeded', output.results[0]?.ok === true)
  check('the bad call failed', output.results[1]?.ok === false)
  check('the failure carries its message', output.results[1]?.error === 'the call failed')
  check('the failure carries its output', output.results[1]?.output === 'it failed')
}

// The report is the concatenation of every call's output, so one unbounded
// result is capped: head, tail, and a marker that says how much is missing.
{
  const big = 'H'.repeat(3000) + 'M'.repeat(20000) + 'T'.repeat(2000)
  const capped = capOutput(big)
  check('a large result is capped', capped.length <= MAX_CALL_OUTPUT_CHARS + 200, String(capped.length))
  check('the cap keeps the head', capped.startsWith('HHHH'))
  check('the cap keeps the tail', capped.endsWith('TTTT'))
  check('the cap says what it dropped', capped.includes('characters of this 25000-character result were left out'))
  check('a small result is untouched', capOutput('short') === 'short')
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')

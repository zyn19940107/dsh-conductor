/**
 * The behaviour the plugin exists for: a batch costs one round trip, and the
 * calls that may run together actually run together.
 *
 * The runner below records when each call started and ended, so the specs can
 * look at the overlap rather than at a summary.
 */

import { capNodeOutput, capOutput, MAX_CALL_OUTPUT_CHARS, MAX_NODE_OUTPUT_CHARS, runBatch, scrubConclusion, type BatchRunner } from '../src/batch.js'

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
  const big = 'H'.repeat(6000) + 'M'.repeat(20000) + 'T'.repeat(4000)
  const capped = capOutput(big)
  check('a large result is capped', capped.length <= MAX_CALL_OUTPUT_CHARS + 200, String(capped.length))
  check('the cap keeps the head', capped.startsWith('HHHH'))
  check('the cap keeps the tail', capped.endsWith('TTTT'))
  check('the cap says what it dropped', capped.includes('characters of this 30000-character result were left out'))
  check('a small result is untouched', capOutput('short') === 'short')
}

// A node may hold many calls, so its combined output is capped as well: the
// calls keep their names in the marker instead of disappearing from the report.
{
  const big = 'H'.repeat(6000) + 'M'.repeat(40000) + 'T'.repeat(4000)
  const results = [
    { name: 'read', ok: true, scheduled: 'concurrent' as const, output: '', error: '' },
    { name: 'pwsh', ok: false, scheduled: 'concurrent' as const, output: '', error: 'boom' },
  ]
  const capped = capNodeOutput(big, results)
  check('a large tools node is capped', capped.length <= MAX_NODE_OUTPUT_CHARS + 400, String(capped.length))
  check('the node cap keeps the head', capped.startsWith('HHHH'))
  check('the node cap keeps the tail', capped.endsWith('TTTT'))
  check('the node cap says what it dropped', capped.includes("characters of this node's 50000-character output were left out"))
  check('the node cap names every call', capped.includes('1. read ok') && capped.includes('2. pwsh failed'))
  check('a small tools node is untouched', capNodeOutput('short', results) === 'short')
}

// A conclusion carries the verdict, not the receipts: lines that reach for a
// line number, an import or a piece of evidence are dropped before the parent
// reads them.
{
  const text = [
    'The verify scripts are hand-rolled: run-specs bundles each and runs it in node.',
    'The rule lives in src/rounds.ts and the field is delegationDepth.',
    '证据：batch.ts:351 连着三处调用。',
    'Line numbers: L6, L8.',
    'The result is that all 8 specs pass.',
  ].join('\n')
  const scrubbed = scrubConclusion(text)
  check('receipt lines with 证据 are dropped', scrubbed.includes('证据') === false)
  check('receipt lines with line numbers are dropped', scrubbed.includes('L6') === false)
  check('the conclusion itself survives', scrubbed.includes('all 8 specs pass'))
  check('a named file and field survive', scrubbed.includes('src/rounds.ts') && scrubbed.includes('delegationDepth'))
  check('ordinary lines survive', scrubbed.includes('run-specs bundles each'))
  const allReceipts = '证据: a\n行号: L3'
  check('an all-receipt conclusion is left alone', scrubConclusion(allReceipts) === allReceipts)
  check('plain text is untouched', scrubConclusion('the suite passes') === 'the suite passes')
  // The whole report on one line, ending in a sentence that describes this rule.
  // Dropping the line would take the fact at the start of it too; only the
  // receipt sentence may go.
  const oneLine = '嵌套深度由 maxAgentDepth 把关，按 session.header.delegationDepth 判定，超了就失败。'
    + '报告还会过 scrubConclusion，把「行号/证据/proof/citation」那类收据句整行剔掉。'
  const keptOneLine = scrubConclusion(oneLine)
  check('a receipt sentence on a long line does not take the facts with it',
    keptOneLine.includes('delegationDepth') && keptOneLine.includes('maxAgentDepth'))
  check('and the receipt sentence itself is gone', keptOneLine.includes('行号') === false)
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')

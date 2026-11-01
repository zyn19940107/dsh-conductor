/**
 * The batch tool: one call that carries a whole plan and returns every result
 * together.
 *
 * The chain this plugin replaces looks like this: the agent decides what to do
 * next, does one thing, reads the result, decides again, does one more thing.
 * Every one of those steps is a full round trip to the model, and every one of
 * them re-reads everything that came before.
 *
 * A batch is the other shape. The agent states the plan once — the criteria
 * that decide whether the batch succeeded, and the calls the batch is made of —
 * and hands the whole thing over in one call. The calls that may run together
 * run together; the ones that may not run together run one after the other,
 * still inside the same batch. Every result comes back in one tool result, so
 * the agent writes the conclusions of all the items in one reply.
 *
 * @module @zyn19940107/dsh-refine-loop/batch
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionInput, ToolExecutionMode, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { mayRunTogether, type ConcurrencyOverride } from './concurrency.js'

/** One call inside a batch. */
export interface BatchCall {
  /** The tool to call. */
  name: string
  /** The arguments to call it with. */
  arguments: unknown
}

/** The plan a batch carries. */
export interface BatchArgs {
  /** The observable criteria that decide whether the batch succeeded. */
  criteria: string[]
  /** The calls the batch is made of. */
  calls: BatchCall[]
}

/** How one call inside a batch was scheduled. */
export type BatchSchedule = 'concurrent' | 'serial'

/**
 * What one call in the batch produced.
 *
 * A type alias and not an interface, so the value keeps an implicit index
 * signature and stays a lossless JSON value on its way out of the tool.
 */
export type BatchItemResult = {
  /** The tool that was called. */
  name: string
  /** Whether the call succeeded. */
  ok: boolean
  /** Whether the call ran with the others or on its own. */
  scheduled: BatchSchedule
  /** The output the call produced, as text. */
  output: string
  /** Why the call failed; empty when it did not fail. */
  error: string
}

/** What the batch produced, as the model reads it. */
export type BatchOutput = {
  /** The criteria the batch was planned against. */
  criteria: string[]
  /** How the whole batch was scheduled. */
  schedule: 'concurrent' | 'mixed' | 'serial'
  /** One entry per call, in the order the plan listed them. */
  results: BatchItemResult[]
}

/**
 * Read the plan out of a tool call.
 *
 * A call that carries no plan is refused, so a batch cannot be an empty list
 * or a list of unnamed calls.
 *
 * @param value - the parsed arguments.
 * @returns the plan, or undefined when the call does not carry one.
 */
export function parseBatchArgs(value: unknown): BatchArgs | undefined {
  const record = (value ?? {}) as Record<string, unknown>
  const criteria = record.criteria
  const calls = record.calls
  if (!Array.isArray(criteria) || !Array.isArray(calls)) return undefined
  const parsedCriteria = criteria
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
    .map(entry => entry.trim())
  if (parsedCriteria.length === 0) return undefined
  const parsedCalls: BatchCall[] = []
  for (const entry of calls) {
    if (entry === null || typeof entry !== 'object') return undefined
    const item = entry as Record<string, unknown>
    const name = item.name
    if (typeof name !== 'string' || name.trim() === '') return undefined
    const args = item.arguments
    parsedCalls.push({ name: name.trim(), arguments: args === undefined ? {} : args })
  }
  if (parsedCalls.length === 0) return undefined
  return { criteria: parsedCriteria, calls: parsedCalls }
}

/**
 * The text of a tool result.
 *
 * A result carries content blocks; the model reads them as text. A result with
 * no text is rendered from its value, so nothing is silently dropped.
 *
 * @param content - the result's content blocks.
 * @param value - the result's value, used when the content carries no text.
 * @returns the text.
 */
function contentToText(content: readonly ContentBlock[], value: unknown): string {
  const text = content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
  if (text.trim() !== '') return text
  if (value === undefined) return ''
  try {
    return JSON.stringify(value, null, 2) ?? ''
  } catch {
    return String(value)
  }
}

/**
 * The message of a thrown value.
 *
 * @param error - the thrown value.
 * @returns the message.
 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Makes every call id in one batch unique. */
let callSequence = 0

/**
 * One call id for a call inside a batch.
 *
 * @returns the id.
 */
function nextCallId(): ToolCallId {
  callSequence += 1
  return ToolCallId(`refine-loop:${process.pid}:${callSequence}`)
}

/**
 * The part of the tool registry a batch needs.
 *
 * The batch runs calls through the registry's own pipeline, so every guard and
 * every policy that governs a normal call governs a batched call too. Only
 * these two members are needed, and naming them keeps the batch's behaviour
 * testable without a running host.
 */
export interface BatchRunner {
  /** Classify a pending call as safe to run concurrently or not. */
  executionMode(exec: ToolExecutionInput): ToolExecutionMode
  /** Run one call through the registry's pipeline. */
  execute(exec: ToolExecutionInput): Promise<ToolExecutionResult>
}

/**
 * Ask the model what a failed call should have been.
 *
 * @param failed - the call as the plan wrote it.
 * @param error - what the tool said.
 * @param signal - the plan's cancellation signal.
 * @returns the corrected call, or undefined when the model gave no usable one.
 */
export type RepairCall = (
  failed: { name: string, arguments: unknown },
  error: string,
  signal: AbortSignal,
) => Promise<{ name: string, arguments: unknown } | undefined>

/**
 * How many times one failed call may be repaired.
 */
export const MAX_REPAIRS = 2

/**
 * Run one call of a batch and describe what it produced.
 *
 * A plan is written before anything has run, so its calls are guesses. The plan
 * is one round trip and the turn ends when it has run, so a call that fails
 * inside it is repaired here: call the tool, read the error, ask the model what
 * the call should have been, call the tool again with that. Only the failing
 * call goes to the model; the rest of the plan is untouched.
 *
 * @param runner - the tool registry the call runs through.
 * @param call - the call to run.
 * @param agent - the agent the batch belongs to.
 * @param signal - the abort signal of the batch.
 * @param scheduled - how the call was scheduled.
 * @param rootCallId - the call the plan itself runs under.
 * @param repair - how a failed call is repaired, when it may be.
 * @returns the item result.
 */
async function runOne(
  runner: BatchRunner,
  call: BatchCall,
  agent: Agent | undefined,
  signal: AbortSignal,
  scheduled: BatchSchedule,
  rootCallId: ToolCallId,
  repair: RepairCall | undefined,
): Promise<BatchItemResult> {
  let name = call.name
  let args = call.arguments
  const tries = repair === undefined ? 1 : MAX_REPAIRS + 1
  for (let attempt = 0; attempt < tries; attempt += 1) {
    let output = ''
    let error = 'the call failed'
    try {
      const result = await runner.execute({
        callId: nextCallId(),
        rootCallId,
        name,
        arguments: args,
        ...(agent === undefined ? {} : { agent }),
        signal,
      })
      output = contentToText(result.content, result.value)
      if (!result.isError) {
        return { name: call.name, ok: true, scheduled, output, error: '' }
      }
      error = result.error?.message ?? 'the call failed'
    } catch (caught: unknown) {
      error = errorMessage(caught)
    }
    if (repair === undefined || attempt === tries - 1) {
      return { name: call.name, ok: false, scheduled, output, error }
    }
    const fixed = await repair({ name, arguments: args }, error, signal)
    if (fixed === undefined) {
      return { name: call.name, ok: false, scheduled, output, error }
    }
    name = fixed.name
    args = fixed.arguments
  }
  return { name: call.name, ok: false, scheduled, output: '', error: 'the call failed' }
}

/**
 * Run a whole batch and collect every result.
 *
 * The calls that their own tool declares safe to run concurrently run
 * concurrently. The ones it does not — a write, a command that touches shared
 * state — run one after the other, still inside the same batch, so the batch
 * still costs one round trip. A deployment that knows its exclusive tools are
 * safe together can turn that rule off.
 *
 * @param ctx - the plugin context supplying the tool registry.
 * @param args - the plan.
 * @param agent - the agent the batch belongs to.
 * @param signal - the abort signal of the batch.
 * @param respectConcurrencySafety - whether a tool's own exclusivity is honoured.
 * @param rootCallId - the call the plan itself runs under.
 * @returns the batch output.
 */
export async function runBatch(
  runner: BatchRunner,
  args: BatchArgs,
  agent: Agent | undefined,
  signal: AbortSignal,
  respectConcurrencySafety: boolean,
  rootCallId: ToolCallId,
  overrides: Readonly<Record<string, ConcurrencyOverride>> = {},
  repair?: RepairCall,
): Promise<BatchOutput> {
  const calls = args.calls
  const results: BatchItemResult[] = new Array(calls.length)

  // The plan is split into waves at every call that may not run with the
  // others. A call that may not share its neighbours is a barrier: the calls
  // before it finish before it starts, and the calls after it wait for it.
  // This is the order the harness's own scheduler uses, and a batch that
  // reordered its calls would report results the model never asked for.
  const waves: { indexes: number[], concurrent: boolean }[] = []
  for (const [index, call] of calls.entries()) {
    const mode = runner.executionMode({
      callId: nextCallId(),
      name: call.name,
      arguments: call.arguments,
      ...(agent === undefined ? {} : { agent }),
      signal,
    })
    const safe = !respectConcurrencySafety
      || mayRunTogether(call.name, call.arguments, mode.kind === 'parallel', overrides)
    const last = waves[waves.length - 1]
    if (safe && last !== undefined && last.concurrent) {
      last.indexes.push(index)
      continue
    }
    waves.push({ indexes: [index], concurrent: safe })
  }

  for (const wave of waves) {
    if (wave.concurrent) {
      await Promise.all(wave.indexes.map(async (index) => {
        const call = calls[index]
        if (call === undefined) return
        results[index] = await runOne(runner, call, agent, signal, 'concurrent', rootCallId, repair)
      }))
      continue
    }
    for (const index of wave.indexes) {
      const call = calls[index]
      if (call === undefined) continue
      results[index] = await runOne(runner, call, agent, signal, 'serial', rootCallId, repair)
    }
  }

  const concurrentCount = waves.filter(wave => wave.concurrent).length
  const schedule: BatchOutput['schedule'] = concurrentCount === waves.length
    ? 'concurrent'
    : concurrentCount === 0 ? 'serial' : 'mixed'

  return { criteria: args.criteria, schedule, results: results.filter(item => item !== undefined) }
}

/**
 * Render the batch output as the text the model reads.
 *
 * Every item of the batch is in this one text, so the agent can write the
 * conclusions of all of them in one reply instead of walking them one at a
 * time.
 *
 * @param output - the batch output.
 * @returns the text.
 */
export function renderBatch(output: BatchOutput): string {
  const lines: string[] = []
  lines.push(`Batch finished — ${output.results.length} call(s), scheduled ${output.schedule}.`)
  lines.push(`Criteria: ${output.criteria.join('; ')}`)
  lines.push('')
  for (const [index, item] of output.results.entries()) {
    lines.push(`${index + 1}. ${item.name} — ${item.ok ? 'ok' : 'failed'} (${item.scheduled})`)
    if (item.error !== '') lines.push(`   error: ${item.error}`)
    if (item.output !== '') {
      lines.push('   output:')
      for (const line of item.output.split('\n')) lines.push(`   | ${line}`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * The plan's tools node, without the plan.
 *
 * A worker is a leaf: it cannot draw a graph, so the plan tool is refused in its
 * conversation. That also puts the two things a tools node gives out of reach —
 * several calls run as one batch, and one bounded digest instead of every raw
 * output. Neither of those has anything to do with drawing a graph: they are the
 * scheduler and the cap. This tool hands them back to the conversations that
 * cannot plan, and to those only, so the plan-first rule stays exactly as it was.
 *
 * @module @zyn19940107/dsh-conductor/tools-tool
 */

import type { Context } from '@deepseek-ai/cordis'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  capNodeOutput,
  renderBatch,
  runBatch,
  type BatchCall,
  type BatchOutput,
  type RepairCall,
} from './batch.js'
import type { ConcurrencyOverride } from './concurrency.js'
import type { Workers } from './rounds.js'

/** The name of the standalone batch tool. */
export const TOOLS_TOOL = 'tools'

/**
 * What the model reads when it opens the tool, in every conversation.
 *
 * The last sentence is the scope: the tool is registered for everyone because a
 * per-session tool table would break the prompt cache, so the boundary is said
 * here and enforced in the call.
 */
export const TOOLS_TOOL_DESCRIPTION = 'Run several tool calls as one batch and get back one bounded digest. '
  + 'This is the plan\'s tools node without a plan: the same scheduler, the same call-level safety, and the '
  + 'same cap — every output is joined and cut to a few thousand characters, head and tail kept, with a '
  + 'marker naming each call. Send the calls that only look around together in one batch (listing, '
  + 'searching, reading a range) instead of one model step each. A conversation that can draw a plan uses a '
  + 'tools node and hands it over with refine_plan instead; this tool exists for the nodes that cannot plan.'

/** What one batch through the tool produced. */
export interface ToolsOutput {
  /** How many calls the batch ran. */
  calls: number
  /** How many of them failed. */
  failed: number
  /** The joined, capped digest. */
  output: string
}

/**
 * Read the calls the model wrote, or nothing when they are not a usable batch.
 *
 * @param value - the raw `calls` argument.
 * @returns the calls, or undefined when the argument is not a batch.
 */
export function readToolsCalls(value: unknown): BatchCall[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const calls: BatchCall[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const record = entry as { name?: unknown, arguments?: unknown }
    if (typeof record.name !== 'string' || record.name.trim() === '') return undefined
    calls.push({ name: record.name, arguments: record.arguments ?? {} })
  }
  return calls
}

/**
 * Register the standalone batch tool.
 *
 * @param ctx - the plugin context supplying the tool registry.
 * @param options - the workers to allow, and the settings a batch runs under.
 * @param options.workers - the conversations that are leaves.
 * @param options.respectConcurrencySafety - whether a tool's own exclusivity counts.
 * @param options.overrides - the tools the plugin lets run with others.
 * @param options.timeoutMs - the ceiling for one batch.
 * @param options.repair - how a failed call is repaired, when it may be.
 */
export function applyToolsTool(
  ctx: Context,
  options: {
    /** The worker conversations: the only ones this tool belongs to. */
    workers: Workers
    /** Whether a tool's own exclusivity is honoured. */
    respectConcurrencySafety: () => boolean
    /** The tools the plugin lets run with others whatever their own definition says. */
    overrides: () => Readonly<Record<string, ConcurrencyOverride>>
    /** The ceiling for one batch, in milliseconds. */
    timeoutMs: () => number
    /** Build the repair for one conversation, from its own call configuration. */
    repair?: (config: LlmCallConfig) => RepairCall
  },
): void {
  ctx.tools.register(defineTool({
    name: TOOLS_TOOL,
    timeoutMs: options.timeoutMs(),
    description: TOOLS_TOOL_DESCRIPTION,
    parameters: {
      calls: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true, description: 'The tool to call.' },
            arguments: { type: 'json', required: true, description: 'The arguments to call it with.' },
          },
        },
        description: 'The calls of this batch, in the order they are written.',
      },
      order: {
        type: 'string',
        enum: ['parallel', 'sequential'],
        description: 'How the calls run. "parallel" (the default) lets the calls that are safe together run '
          + 'together; "sequential" runs them in written order, for an order of business like "write the '
          + 'file, then run the test".',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          calls: { type: 'number', required: true },
          failed: { type: 'number', required: true },
          output: { type: 'string', required: true },
        },
      },
      render: (_args: { [key: string]: unknown }, value: unknown) => {
        const output = value as ToolsOutput
        return [{ type: 'text', text: output.output }]
      },
    },
    async execute(args, exec: ToolRunContext): Promise<ToolsOutput> {
      const agent = exec.agent
      if (agent === undefined) throw new Error('the tools tool needs a conversation')
      if (!options.workers.has(agent.session.id)) {
        throw new Error('This conversation can draw a plan: put these calls in a tools node and hand it '
          + 'over with refine_plan. The tools tool is for a node that cannot plan.')
      }
      const calls = readToolsCalls(args['calls'])
      if (calls === undefined) {
        throw new Error('tools needs calls: a non-empty array of {"name": ..., "arguments": {...}}')
      }
      const order = args['order'] === 'sequential' ? 'sequential' : 'parallel'
      const ownConfig = agent.session.requestHeader()?.config
      const repair = options.repair === undefined || ownConfig === undefined
        ? undefined
        : options.repair(ownConfig)
      const batch: BatchOutput = await runBatch(
        ctx.tools,
        { criteria: [], calls, order },
        agent,
        exec.signal,
        options.respectConcurrencySafety(),
        exec.callId,
        options.overrides(),
        repair,
      )
      const failed = batch.results.filter(item => !item.ok).length
      return {
        calls: batch.results.length,
        failed,
        output: capNodeOutput(renderBatch(batch), batch.results),
      }
    },
  }))
}
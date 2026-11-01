/**
 * The plan tool: one call that carries the whole shape of the work.
 *
 * The agent draws the plan before it starts. The plan says which pieces of the
 * work are independent tool calls, which ones need a child that starts with no
 * context, which ones need a child that inherits this conversation, and what
 * depends on what. The plugin runs the plan and hands back every result at
 * once.
 *
 * This is the difference between a chain and a plan. In a chain the agent
 * decides the next step after seeing the last result, so it re-plans at every
 * step and pays for the whole history each time. In a plan it decides the
 * shape once, and the shape runs.
 *
 * @module @zyn19940107/dsh-refine-loop/tool
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  renderBatch,
  runBatch,
  type BatchArgs,
  type BatchOutput,
  type BatchRunner,
  type RepairCall,
} from './batch.js'
import { mayRunTogether, type ConcurrencyOverride } from './concurrency.js'
import {
  AGENT_NODE_KINDS,
  buildWaves,
  dependenciesOf,
  parsePlanArgs,
  substitutePlaceholders,
  type PlanArgs,
  type PlanNode,
  type PlanNodeKind,
} from './plan.js'

/** The tool that runs a plan. */
export const PLAN_TOOL = 'refine_plan'

/** What one node of a plan produced. */
export type PlanNodeResult = {
  /** The node's name. */
  id: string
  /** What kind of work the node was. */
  kind: PlanNodeKind
  /** Whether the node succeeded. */
  ok: boolean
  /** What the node produced, as text. */
  output: string
  /** Why the node failed, when it did. */
  error: string
}

/** What the plan produced, as the model reads it. */
export type PlanOutput = {
  /** The criteria the plan was drawn against. */
  criteria: string[]
  /** How many layers the plan had. */
  waves: number
  /** How the plan's layers were shaped. */
  schedule: 'concurrent' | 'mixed' | 'serial'
  /** One entry per node, in the order the plan listed them. */
  nodes: PlanNodeResult[]
}

/**
 * Make every call id in one plan unique.
 */
let planSequence = 0

/**
 * One call id for a call inside a plan.
 *
 * @returns the id.
 */
function nextPlanCallId(): ToolCallId {
  planSequence += 1
  return ToolCallId(`refine-loop:plan:${process.pid}:${planSequence}`)
}

/**
 * The text of a tool result.
 *
 * @param content - the result's content blocks.
 * @param value - the result's value, used when the content carries no text.
 * @returns the text.
 */
function resultText(content: readonly { type: string, text?: string }[], value: unknown): string {
  const text = content
    .filter((block): block is { type: 'text', text: string } => block.type === 'text')
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
 * Run one call with a deadline of its own.
 *
 * A plan that waits for a child that never comes loses the results of the
 * nodes that already succeeded. A node that runs out of its budget is
 * reported as failed, and the plan carries on with the rest.
 *
 * @param run - the call to run.
 * @param timeoutMs - the node's budget, in milliseconds.
 * @param id - the node's name, for the message.
 * @param controller - the controller that stops the call when the budget runs out.
 * @returns what the call produced.
 */
async function runWithDeadline<T>(
  run: () => Promise<T>,
  timeoutMs: number,
  id: string,
  controller: AbortController,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`the node "${id}" ran out of its ${timeoutMs}ms budget`))
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
  })
  try {
    return await Promise.race([run(), expired])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * The task an agent node hands to its child, with the output of the nodes it
 * depends on put in front of it.
 *
 * @param node - the agent node.
 * @param dependencies - the nodes it depends on.
 * @param outputs - the output of every node that has finished.
 * @returns the prompt.
 */
function buildAgentPrompt(
  node: PlanNode,
  dependencies: readonly PlanNode[],
  outputs: ReadonlyMap<string, string>,
): string {
  if (dependencies.length === 0) return node.task
  const sections = dependencies.map((dependency) => {
    const output = outputs.get(dependency.id) ?? ''
    return `Output of ${dependency.id}:\n${output}`
  })
  return `${node.task}\n\n---\nWhat the nodes this task depends on produced:\n\n${sections.join('\n\n')}`
}

/**
 * Run one node of a plan.
 *
 * @param runner - the tool registry every call runs through.
 * @param node - the node to run.
 * @param dependencies - the nodes it depends on.
 * @param outputs - the output of every node that has finished.
 * @param criteria - the criteria the plan was drawn against.
 * @param agent - the agent the plan belongs to.
 * @param signal - the abort signal of the plan.
 * @param respectConcurrencySafety - whether a tool's own exclusivity is honoured.
 * @param overrides - the tools the plugin lets run with others.
 * @param maxAgentDepth - how deep a plan may start an agent.
 * @returns what the node produced.
 */
async function runNode(
  runner: BatchRunner,
  node: PlanNode,
  dependencies: readonly PlanNode[],
  outputs: ReadonlyMap<string, string>,
  criteria: readonly string[],
  agent: Agent | undefined,
  signal: AbortSignal,
  respectConcurrencySafety: boolean,
  rootCallId: ToolCallId,
  overrides: Readonly<Record<string, ConcurrencyOverride>>,
  maxAgentDepth: number,
  agentNodeTimeoutMs: number,
  repair: RepairCall | undefined,
): Promise<PlanNodeResult> {
  if (node.kind === 'tools') {
    const calls = node.calls.map(call => ({
      name: call.name,
      arguments: substitutePlaceholders(call.arguments, outputs),
    }))
    const batch: BatchOutput = await runBatch(
      runner,
      { criteria: [...criteria], calls },
      agent,
      signal,
      respectConcurrencySafety,
      rootCallId,
      overrides,
      repair,
    )
    const failed = batch.results.filter(item => !item.ok)
    return {
      id: node.id,
      kind: node.kind,
      ok: failed.length === 0,
      output: renderBatch(batch),
      error: failed.length === 0 ? '' : failed.map(item => `${item.name}: ${item.error}`).join('; '),
    }
  }

  const depth = agent?.session.header.delegationDepth ?? 0
  if (depth >= maxAgentDepth) {
    return {
      id: node.id,
      kind: node.kind,
      ok: false,
      output: '',
      error: `this conversation is already a delegated child (depth ${depth}), so a plan here may not start `
        + 'another agent. Keep the work in the nodes that call tools.',
    }
  }

  try {
    const deadline = new AbortController()
    const onPlanAbort = (): void => deadline.abort()
    signal.addEventListener('abort', onPlanAbort, { once: true })
    let result
    try {
      result = await runWithDeadline(
        () => runner.execute({
          callId: nextPlanCallId(),
          rootCallId,
          name: node.kind,
          arguments: {
            description: node.id,
            prompt: buildAgentPrompt(node, dependencies, outputs),
            run_in_background: false,
          },
          ...(agent === undefined ? {} : { agent }),
          signal: deadline.signal,
        }),
        agentNodeTimeoutMs,
        node.id,
        deadline,
      )
    } finally {
      signal.removeEventListener('abort', onPlanAbort)
    }
    const output = resultText(result.content, result.value)
    if (result.isError) {
      return {
        id: node.id,
        kind: node.kind,
        ok: false,
        output,
        error: result.error?.message ?? 'the delegation failed',
      }
    }
    return { id: node.id, kind: node.kind, ok: true, output, error: '' }
  } catch (error: unknown) {
    return {
      id: node.id,
      kind: node.kind,
      ok: false,
      output: '',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Run a whole plan and collect every result.
 *
 * The nodes of a layer run at the same time. A node that depends on another
 * waits for it, and its output becomes part of what the next node is given.
 *
 * @param runner - the tool registry every call runs through.
 * @param plan - the plan.
 * @param agent - the agent the plan belongs to.
 * @param signal - the abort signal of the plan.
 * @param respectConcurrencySafety - whether a tool's own exclusivity is honoured.
 * @param overrides - the tools the plugin lets run with others.
 * @param maxAgentDepth - how deep a plan may start an agent.
 * @returns the plan output.
 */
export async function runPlan(
  runner: BatchRunner,
  plan: PlanArgs,
  agent: Agent | undefined,
  signal: AbortSignal,
  respectConcurrencySafety: boolean,
  rootCallId: ToolCallId,
  overrides: Readonly<Record<string, ConcurrencyOverride>>,
  maxAgentDepth: number,
  agentNodeTimeoutMs: number,
  repair?: RepairCall,
): Promise<PlanOutput> {
  const built = buildWaves(plan.nodes)
  if ('error' in built) {
    throw new Error(`the plan does not hold together: ${built.error}`)
  }
  const waves = built.waves
  const byId = new Map(plan.nodes.map(node => [node.id, node]))
  const outputs = new Map<string, string>()
  const results = new Map<string, PlanNodeResult>()

  for (const wave of waves) {
    const settled = await Promise.all(wave.map(async (node) => await runNode(
      runner,
      node,
      dependenciesOf(node, byId),
      outputs,
      plan.criteria,
      agent,
      signal,
      respectConcurrencySafety,
      rootCallId,
      overrides,
      maxAgentDepth,
      agentNodeTimeoutMs,
      repair,
    )))
    for (const result of settled) {
      results.set(result.id, result)
      outputs.set(result.id, result.output)
    }
  }

  const parallelLayers = waves.filter(wave => wave.length > 1).length
  const schedule: PlanOutput['schedule'] = parallelLayers === waves.length
    ? 'concurrent'
    : parallelLayers === 0 ? 'serial' : 'mixed'

  return {
    criteria: plan.criteria,
    waves: waves.length,
    schedule,
    nodes: plan.nodes.map(node => results.get(node.id)).filter((result): result is PlanNodeResult => result !== undefined),
  }
}

/**
 * Render the plan output as the text the model reads.
 *
 * @param output - the plan output.
 * @returns the text.
 */
export function renderPlan(output: PlanOutput): string {
  const lines: string[] = []
  lines.push(`Plan finished — ${output.nodes.length} node(s) in ${output.waves} layer(s), `
    + `shaped ${output.schedule}.`)
  lines.push(`Criteria: ${output.criteria.join('; ')}`)
  lines.push('')
  for (const node of output.nodes) {
    lines.push(`${node.id} (${node.kind}) — ${node.ok ? 'ok' : 'failed'}`)
    if (node.error !== '') lines.push(`   error: ${node.error}`)
    if (node.output !== '') {
      lines.push('   output:')
      for (const line of node.output.split('\n')) lines.push(`   | ${line}`)
    }
  }
  lines.push('')
  lines.push('Every result is above. The turn is over.')
  return lines.join('\n')
}

/**
 * Register the plan tool.
 *
 * @param ctx - the plugin context supplying the registries.
 * @param options - how the tool reads its configuration.
 */
export function applyPlanTool(
  ctx: Context,
  options: {
    /** Whether a tool's own exclusivity is honoured. */
    respectConcurrencySafety: () => boolean
    /** The largest plan the tool accepts, in nodes. */
    maxBatchSize: () => number
    /** The budget for one plan, in milliseconds. */
    timeoutMs: () => number
    /** The tools the plugin lets run with others whatever their own definition says. */
    overrides: () => Readonly<Record<string, ConcurrencyOverride>>
    /** How deep a plan may start an agent. */
    maxAgentDepth: () => number
    /** The budget for one agent node, in milliseconds. */
    agentNodeTimeoutMs: () => number
    /** Told when a plan starts running, so a rule can know the turn handed its plan over. */
    onPlanStarted?: (sessionId: string, callId: ToolCallId) => void
    /** Build the repair for one conversation, from its own call configuration. */
    repair?: (config: LlmCallConfig) => RepairCall
    /**
     * Called when a plan has run, before the tool returns.
     *
     * Returns true when the loop should go on: the plugin has queued the next
     * round and the turn must end so that round can start.
     */
    onPlanFinished?: (agent: Agent) => boolean
  },
): void {
  ctx.tools.register(defineTool({
    name: PLAN_TOOL,
    timeoutMs: options.timeoutMs(),
    description: 'Run one plan of work and return every result together. A turn is one plan: this call carries '
      + 'the whole shape of the turn — the observable criteria that decide whether it succeeded, and the nodes '
      + 'it is made of. A node is one of three kinds — "tools" (several calls that run together), "subagent" (a '
      + 'self-contained task for a child that starts with no context), or "subagent_fork" (a task for a child '
      + 'that inherits this conversation) — and a node may name the nodes it depends on, so the ones that '
      + 'depend on nothing run together and the next layer waits for them. Choose "subagent" for a task that '
      + 'needs nothing from this conversation, and "subagent_fork" for one that builds on what was said here.',
    parameters: {
      criteria: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: 'The observable criteria that decide whether this plan succeeded. Each one is something '
          + 'you could check against the results.',
      },
      nodes: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: {
              type: 'string',
              required: true,
              description: 'The name of this node. Other nodes refer to it in "after".',
            },
            kind: {
              type: 'string',
              enum: ['tools', 'subagent', 'subagent_fork'],
              required: true,
              description: '"tools" runs calls together. "subagent" hands a self-contained task to a child '
                + 'that starts with no context — use it when the task needs nothing from this conversation. '
                + '"subagent_fork" hands a task to a child that inherits this conversation — use it when '
                + 'the task builds on what has been said here.',
            },
            calls: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string', required: true, description: 'The tool to call.' },
                  arguments: { type: 'json', required: true, description: 'The arguments to call it with. '
                    + 'An argument that is exactly "@@nodeId@@" becomes the output of that node.' },
                },
              },
              description: 'The calls of a tools node. Only for kind "tools".',
            },
            task: {
              type: 'string',
              description: 'The task of an agent node. Only for kind "subagent" or "subagent_fork". State '
                + 'everything the child needs: a child that starts with no context knows nothing but this.',
            },
            after: {
              type: 'array',
              items: { type: 'string' },
              description: 'The nodes this one depends on. Their output is put in front of this node.',
            },
          },
        },
        required: true,
        description: 'The nodes of the plan.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          criteria: { type: 'array', items: { type: 'string' }, required: true },
          waves: { type: 'number', required: true },
          schedule: { type: 'string', enum: ['concurrent', 'mixed', 'serial'], required: true },
          nodes: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                kind: { type: 'string', enum: ['tools', 'subagent', 'subagent_fork'], required: true },
                ok: { type: 'boolean', required: true },
                output: { type: 'string', required: true },
                error: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args: { [key: string]: unknown }, value: unknown) => {
        const output = value as PlanOutput
        return [{ type: 'text', text: renderPlan(output) }]
      },
    },
    async execute(args, exec: ToolRunContext) {
      const parsed = parsePlanArgs(args)
      if (parsed === undefined) {
        throw new Error('refine_plan needs criteria and a non-empty list of nodes, each with an id and a kind')
      }
      const limit = options.maxBatchSize()
      if (parsed.nodes.length > limit) {
        throw new Error(`This plan has ${parsed.nodes.length} nodes and the limit is ${limit}. `
          + 'Split it, or narrow it to the nodes that belong together.')
      }
      const agent: Agent | undefined = exec.agent
      if (agent !== undefined) options.onPlanStarted?.(agent.session.id, exec.callId)
      // A failed call is repaired on the conversation's own route: the latest
      // request header carries the call configuration the conversation is on.
      const ownConfig = agent?.session.requestHeader()?.config
      const repair = options.repair === undefined || ownConfig === undefined
        ? undefined
        : options.repair(ownConfig)
      const output = await runPlan(
        ctx.tools,
        parsed,
        agent,
        exec.signal,
        options.respectConcurrencySafety(),
        exec.callId,
        options.overrides(),
        options.maxAgentDepth(),
        options.agentNodeTimeoutMs(),
        repair,
      )
      // The plan has run. If the loop has a round left, the next one is already
      // queued; ending this turn is what lets the harness open it.
      if (agent !== undefined && options.onPlanFinished?.(agent) === true) {
        exec.concludeTurn()
      }
      return output
    },
  }))
}

/**
 * The kinds of node that start an agent.
 */
export { AGENT_NODE_KINDS, mayRunTogether }

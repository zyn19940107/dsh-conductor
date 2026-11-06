/**
 * The plan tool: one call that carries the whole shape of the work.
 *
 * The agent draws the plan before it starts. The plan says which pieces of the
 * work are tool calls whose arguments are already decided, which ones need a
 * child that does the work itself, and which ones need a child that starts
 * empty or inherits this conversation. The plugin runs every node at the same
 * time and hands back every result at once.
 *
 * This is the difference between a chain and a plan. In a chain the agent
 * decides the next step after seeing the last result, so it re-plans at every
 * step and pays for the whole history each time. In a plan it decides the
 * shape once, and the shape runs.
 *
 * @module @zyn19940107/dsh-conductor/tool
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  capNodeOutput,
  scrubConclusion,
  renderBatch,
  runBatch,
  type BatchArgs,
  type BatchOutput,
  type BatchRunner,
  type RepairCall,
} from './batch.js'
import { mayRunTogether, type ConcurrencyOverride } from './concurrency.js'
import { spawnEmptyChild, spawnForkedChild, type SpawnResult } from './fork.js'
import {
  AGENT_NODE_KINDS,
  WORKER_MARKER,
  WORKER_NODE_KINDS,
  buildGroups,
  parsePlanArgs,
  type PlanArgs,
  type PlanNode,
  type PlanNodeKind,
} from './plan.js'

/** The tool that runs a plan. */
export const PLAN_TOOL = 'refine_plan'

/**
 * What a plan needs to start a child that inherits this conversation.
 *
 * Without it a `worker` or a `forker` falls back to the harness's own
 * delegation tools, which seed completed turns only — inside a running round
 * that means no inherited context at all.
 */
export interface PlanForkOptions {
  /** The host context carrying the agent factory. */
  host: Record<string, unknown>
  /** Told the child's session id when a worker starts, so the loop leaves it alone. */
  onWorker?: (sessionId: string) => void
}

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
  /** How many groups of nodes ran. */
  groups: number
  /** One entry per node, in the order the plan listed them. */
  nodes: PlanNodeResult[]
  /** A warning about the plan's own budgets, when they cannot all be spent. */
  budgetWarn?: string
}

/**
 * Make every call id in one plan unique.
 */
let planSequence = 0




/**
 * The task an agent node hands to its child.
 *
 * @param node - the agent node.
 * @param criteria - the criteria the plan was drawn against.
 * @returns the prompt.
 */
function buildAgentPrompt(node: PlanNode, criteria: readonly string[]): string {
  const judged = criteria.length === 0
    ? ''
    : `What this plan is judged on:
${criteria.map(criterion => `- ${criterion}`).join(String.fromCharCode(10))}
` + String.fromCharCode(10) + String.fromCharCode(10)
  // What the parent needs back is the judgement itself, and now the knowledge
  // behind it: the parent reads the raw tool output of the round through a small
  // cap, so a bare verdict leaves it unable to judge. The contract is the last
  // thing the child reads, and it says outright that it wins over a task written
  // to ask for a fuller report.
  const contract = 'What comes back from you is used as it stands, and it is what the parent judges from. '
    + 'Keep it compact and give the substance, not the paperwork: (1) what you found out — the facts or '
    + 'behaviour that matter, named exactly: when the answer is a file, a module, a field or a function, name '
    + 'it; (2) roughly how — the method in a line or two, not a transcript; (3) what came of it — the result, '
    + 'whether it worked, and what is still open. No line numbers, no citations and no command log as proof, '
    + 'and never write 证据 / evidence / proof / citation / 行号: a sentence that reaches for those is a '
    + 'receipt, not a conclusion, and it is dropped before the parent reads it. Keep it short — a few '
    + 'paragraphs or a short list, no tables of counts or rankings and no inventory of what you looked at — '
    + 'even when the task above asks for a fuller report; the parent composes the final answer.'
    + String.fromCharCode(10) + String.fromCharCode(10)
  // A worker is told what it is: it does the work, it does not draw a graph of
  // its own. The marker is also how the plugin recognises the worker's own
  // conversation and keeps the turn doctrine away from it.
  const opener = node.kind === 'worker'
    ? `${WORKER_MARKER} You are a worker. This conversation is yours: do the work yourself — think, act, and `
      + 'report what you found. Do not draw a plan and do not delegate.'
      + String.fromCharCode(10) + String.fromCharCode(10)
    : ''
  // The last line a worker reads, and the one that has to survive the system
  // prompt above it: that prompt describes the plan tool as this conversation's
  // opening move, so a worker that only reads the top still tries to plan. Two
  // rules, in the language most tasks are written in.
  const workerBan = node.kind === 'worker'
    ? String.fromCharCode(10) + String.fromCharCode(10)
      + '禁止使用 refine_plan，不要做和任务不相关的事情。'
    : ''
  return `${opener}${node.task}${String.fromCharCode(10)}${String.fromCharCode(10)}${judged}${contract}${workerBan}`.trim()
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
  criteria: readonly string[],
  agent: Agent | undefined,
  signal: AbortSignal,
  respectConcurrencySafety: boolean,
  rootCallId: ToolCallId,
  overrides: Readonly<Record<string, ConcurrencyOverride>>,
  maxAgentDepth: number,
  agentNodeTimeoutMs: number,
  repair: RepairCall | undefined,
  fork: PlanForkOptions | undefined,
): Promise<PlanNodeResult> {
  if (node.kind === 'tools') {
    const calls = node.calls.map(call => ({
      name: call.name,
      arguments: call.arguments,
    }))
    // A tools node runs long too when one of its calls does — a search, a
    // solver, a build. Its budget stops the calls still running and keeps the
    // ones that finished, so the report carries what the node learned rather
    // than a single timeout with nothing in it.
    const limit = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let spent = false
    if (node.budgetMs > 0) {
      timer = setTimeout(() => {
        spent = true
        limit.abort()
      }, node.budgetMs)
      ;(timer as { unref?: () => void }).unref?.()
    }
    const nodeSignal = node.budgetMs > 0 ? AbortSignal.any([signal, limit.signal]) : signal
    try {
      const batch: BatchOutput = await runBatch(
        runner,
        { criteria: [...criteria], calls, order: node.order },
        agent,
        nodeSignal,
        respectConcurrencySafety,
        rootCallId,
        overrides,
        repair,
      )
      const failed = batch.results.filter(item => !item.ok)
      const note = spent
        ? `${String.fromCharCode(10)}${String.fromCharCode(10)}[the time budget of ${node.budgetMs}ms `
          + 'was reached: calls still running were stopped, the ones that finished are above]'
        : ''
      return {
        id: node.id,
        kind: node.kind,
        ok: failed.length === 0,
        output: capNodeOutput(renderBatch(batch) + note, batch.results),
        error: failed.length === 0 ? '' : failed.map(item => `${item.name}: ${item.error}`).join('; '),
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
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

  // A worker and a forker inherit this conversation, this round included. The
  // harness's own fork tool cannot do that from inside a running round, so the
  // child is started here, on a seed built from the log as it stands.
  const forked = node.kind === 'worker' || node.kind === 'forker'
  if (forked && agent === undefined) {
    return {
      id: node.id,
      kind: node.kind,
      ok: false,
      output: '',
      error: 'a plan outside a conversation cannot start a child that inherits it',
    }
  }
  if (forked && fork !== undefined && agent !== undefined) {
    const result: SpawnResult = await spawnForkedChild(
      fork.host,
      agent,
      buildAgentPrompt(node, criteria),
      {
        timeoutMs: agentNodeTimeoutMs,
        ...(node.budgetMs > 0 ? { budgetMs: node.budgetMs } : {}),
        signal,
        ...(node.kind === 'worker' && fork.onWorker !== undefined ? { onCreated: fork.onWorker } : {}),
      },
    )
    return {
      id: node.id,
      kind: node.kind,
      ok: result.error === undefined,
      output: scrubConclusion(result.output),
      error: result.error ?? '',
    }
  }

  // A spawner starts empty and plans through this loop. It is started here, by
  // this plugin, for the same reason a forked child is: the handle is what lets
  // the node's budget stop it and ask it for its state instead of killing it.
  if (agent === undefined || fork === undefined) {
    return {
      id: node.id,
      kind: node.kind,
      ok: false,
      output: '',
      error: 'a plan outside a conversation cannot start an agent node',
    }
  }
  const result: SpawnResult = await spawnEmptyChild(
    fork.host,
    agent,
    buildAgentPrompt(node, criteria),
    {
      timeoutMs: agentNodeTimeoutMs,
      ...(node.budgetMs > 0 ? { budgetMs: node.budgetMs } : {}),
      signal,
    },
  )
  return {
    id: node.id,
    kind: node.kind,
    ok: result.error === undefined,
    output: scrubConclusion(result.output),
    error: result.error ?? '',
  }
}

/**
 * Run a whole plan and collect every result.
 *
 * The nodes run at the same time — one layer — and every result is collected.
 * The only thing that splits the layer is two nodes writing the same file.
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
  fork?: PlanForkOptions,
): Promise<PlanOutput> {
  const groups = buildGroups(plan.nodes)
  const results = new Map<string, PlanNodeResult>()

  for (const group of groups) {
    const settled = await Promise.all(group.map(async (node) => await runNode(
      runner,
      node,
      plan.criteria,
      agent,
      signal,
      respectConcurrencySafety,
      rootCallId,
      overrides,
      maxAgentDepth,
      agentNodeTimeoutMs,
      repair,
      fork,
    )))
    for (const result of settled) results.set(result.id, result)
  }

  return {
    criteria: plan.criteria,
    groups: groups.length,
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
  lines.push(`Plan finished — ${output.nodes.length} node(s) in ${output.groups} group(s), `
    + 'run in parallel.')
  lines.push(`Criteria: ${output.criteria.join('; ')}`)
  if (output.budgetWarn !== undefined && output.budgetWarn !== '') {
    lines.push('')
    lines.push(output.budgetWarn)
  }
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

/** The tool's own description: what it does, and the shape of a plan. */
export const PLAN_TOOL_DESCRIPTION = 'Run one plan and return every result together. A plan may be empty: it then returns at '
      + 'once, and the round can end with the conclusion. One call carries the whole round — the criteria '
      + 'that decide whether it succeeded, and the nodes it is made of. There is one layer: every node starts '
      + 'at the same time and every result comes back together. Each node is one of four kinds. What a kind '
      + 'is, and which one to pick, is in the policy section above the tools; the kind only decides what a '
      + 'node\'s task has to say. '
      + 'Shape of a plan: {"criteria": ["...", "..."], "nodes": ['
      + '{"id": "scan", "kind": "tools", "calls": [{"name": "read", "arguments": {"file_path": "src/plan.ts"}}]}, '
      + '{"id": "budget-field", "kind": "worker", "task": "Add the budgetMs field to PlanNode in '
      + 'src/plan.ts and read it in parsePlanArgs. Done when both places are changed and tsc passes."}, '
      + '{"id": "plan-review", "kind": "forker", "task": "Review how the plan format treats node '
      + 'arguments: where they are validated, where they leak, and what a fifth node kind would need. You '
      + 'decide how to split the review. Done when each question has an answer backed by a line of code."}]}'

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
    /** The host context carrying the agent factory, for children that inherit the conversation. */
    host?: () => Record<string, unknown>
    /** Told a worker's session id, so the loop leaves that conversation alone. */
    onWorker?: (sessionId: string) => void
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
    description: PLAN_TOOL_DESCRIPTION,
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
              description: 'The name of this node.',
            },
            kind: {
              type: 'string',
              enum: ['tools', 'worker', 'spawner', 'forker'],
              required: true,
              description: '"tools": a batch of calls, no child. "worker": a leaf — the plan tool is refused '
                + 'inside it. "forker": a leader — it inherits this conversation. "spawner": a leader starting '
                + 'empty. The policy section says what each kind is for and how to pick one.',
            },
            calls: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string', required: true, description: 'The tool to call.' },
                  arguments: { type: 'json', required: true, description: 'The arguments to call it with.' },
                },
              },
              description: 'The calls of a tools node. Only for kind "tools".',
            },
            task: {
              type: 'string',
              description: 'The task of an agent node (worker, forker or spawner). What it has to say '
                + 'depends on the kind — the policy section says how much of the how goes in it. The result '
                + 'comes back and is used as it stands.',
            },
            order: {
              type: 'string',
              enum: ['parallel', 'sequential'],
              description: 'How the calls of a tools node run. "parallel" (the default) lets the calls that '
                + 'are safe together run together; "sequential" runs them in the order they are written, for '
                + 'an order of business like "write the file, then run the test".',
            },
            writes: {
              type: 'array',
              items: { type: 'string' },
              description: 'The files this node writes. Two nodes that write the same file do not run '
                + 'together, because the second write would land on the result of the first one.',
            },
            budgetMs: {
              type: 'number',
              description: 'How long you expect this node to take, in milliseconds. When it is spent the '
                + 'node is stopped mid-work and asked to look at where it got to and either finish by the '
                + 'shortest path or report its state and stop, so the parent still gets something. Declare '
                + 'one on every node that could run long: a node that declares nothing runs until the '
                + "runner's own ceiling.",
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
          groups: { type: 'number', required: true },
          nodes: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                kind: { type: 'string', enum: ['tools', 'worker', 'spawner', 'forker'], required: true },
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
        throw new Error('refine_plan needs criteria, and nodes that each have an id and a kind')
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
      // Workers and forkers inherit this conversation, this round included, so
      // they are started here rather than through the harness's own fork tool.
      const fork: PlanForkOptions | undefined = options.host === undefined
        ? undefined
        : {
            host: options.host(),
            ...(options.onWorker === undefined ? {} : { onWorker: options.onWorker }),
          }
      // The model has no clock, so it cannot tell how much of a stated budget is
      // already gone. The node budgets it wrote are one thing it can be checked
      // on: a plan whose nodes ask for more than the plan's own ceiling can never
      // spend them, and the model should hear that in the same report, before it
      // plans the next round.
      const declared = parsed.nodes.reduce((sum, node) => sum + (node.budgetMs ?? 0), 0)
      const ceiling = options.timeoutMs()
      const budgetWarn = declared > ceiling
        ? `[budgets] These nodes ask for ${Math.round(declared / 1000)}s in total, `
          + `and this plan stops at ${Math.round(ceiling / 1000)}s: the nodes that run last cannot use what they asked for.`
        : ''

      let output = await runPlan(
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
        fork,
      )
      if (budgetWarn !== '') output = { ...output, budgetWarn }
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


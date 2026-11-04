/**
 * The refined loop: draw the plan once, run it, collect every result at once.
 *
 * The agent loop is a chain. Each step is a round trip to the model, and each
 * step re-reads everything the earlier steps left behind: the system prompt,
 * the tool table, the whole history. An agent that takes one step per item
 * spends a round trip on every item and pays for the accumulated history on
 * every one of them.
 *
 * This plugin offers the other shape and enforces the difference between the
 * two where it can be enforced.
 *
 * - `refine_plan` carries the whole shape of the turn in one call: the
 *   observable criteria that decide whether it succeeded, and the nodes it is
 *   made of. A node is a set of tool calls that run together, a task for a
 *   child that starts with no context, or a task for a child that inherits
 *   this conversation; a node may say what it depends on, so the plan runs in
 *   one layer and every result comes back in one tool result.
 * - The rule makes a turn one plan: the first call of a turn is the plan, and
 *   after the plan has run the turn is over — what the plan did not settle
 *   belongs to the next round.
 * - The per-conversation switch takes the whole plugin out of one conversation
 *   without touching the deployment.
 *
 * @module @local/dsh-refine-loop
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import { buildOverrides } from './concurrency.js'
import { applyDelegationRule, applyJudgementGuard, applyRounds, applyTurnDoctrine, applyWorkerRule, NEXT_ROUND, Plans, Rounds, Workers } from './rounds.js'
import { applyPolicyCommand, applyPolicyMessage, SessionPolicy } from './policy.js'
import { compressToolOutput, needsCompression } from './compress.js'
import { applyPlanTool, PLAN_TOOL } from './tool.js'
import { describeFailure, parseRepair, repairSystem } from './repair.js'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'refine-loop'

/**
 * Services this plugin needs: the tool registry, the prompt assembly, and the
 * command registry the per-conversation switch is registered in.
 */
export const inject = ['tools', 'systemPrompt', 'commands', 'llm', 'agentLoop']

/**
 * The refined loop, as the model should see it.
 *
 * This text is part of the system prompt and is re-sent every turn, so it
 * stays as short as the rule allows.
 */
export const REFINE_GUIDANCE = [
  'Refined loop:',
  `- ${PLAN_TOOL}: one call that carries the whole shape of the round — the criteria that decide whether it `
  + 'succeeded, and the nodes it is made of. There is one layer: every node starts at the same time and every '
  + 'result comes back together. How a round runs, and when the plan or the conclusion is due, is said at the '
  + 'head of every round.',
  '- A node is one of four kinds: "tools" (calls whose arguments are already decided), "worker" (a child that '
  + 'starts with this conversation and does the work itself, without drawing a plan of its own), "spawner" (a '
  + 'child that starts empty and plans through this loop), "forker" (a child that starts with this conversation '
  + 'and plans through this loop).',
  '- There is no dependency between the nodes of one round: work that needs the output of another node belongs '
  + 'to the next round. Work that has to happen in order belongs inside one node — a tools node with '
  + '"order": "sequential", or a worker.',
  '- A "worker" or a "forker" already sees this conversation, including what you have read so far, so its '
  + 'task says what to do; only a "spawner" starts empty and needs the context in its task.',
  '- An agent node answers with its conclusion, and that conclusion goes into your answer as it stands: give '
  + 'it a task that says what to decide. Asking a child for a report, or for proofs of what it found, is you '
  + 'doing the work twice.',
  '- Say which files a node writes in "writes": two nodes that write the same file do not run together.',
  '- Write paths in a tool call relative to the workspace root. The plan runs in this workspace, so the '
  + 'tools resolve them there.',
  '- Keep each node task to one sentence and the criteria to one or two: they decide the round, they are '
  + 'not a report.',
  '- The plan runs in one round trip and every result comes back together. A result may be too long to fit '
  + 'and be left out of what you see — the rest is in the spill file.',
].join('\n')

/**
 * Whether the plugin is mounted at all.
 *
 * Read when the plugin loads: a deployment that does not want it turns it off
 * in the configuration, and nothing is mounted — no tool, no guidance, no
 * rule.
 */
export const DEFAULT_ENABLED = true


/**
 * The largest plan the tool accepts, in nodes.
 *
 * A plan is one round trip whatever it holds, but the results of a very large
 * plan are a very large tool result. Eight is enough for a real turn and
 * small enough to read.
 */
export const DEFAULT_MAX_BATCH_SIZE = 8

/**
 * The budget for one plan, in milliseconds.
 */
export const DEFAULT_MAX_BATCH_TIMEOUT_MS = 900000

/**
 * How deep a plan may start an agent.
 *
 * The conversation is depth zero, so this is how many levels of children a plan
 * may reach. It is a runaway valve, not a policy: a child that needs its own
 * child is doing real work, and a chain that keeps delegating without producing
 * an answer is not.
 */
export const DEFAULT_MAX_AGENT_DEPTH = 3

/**
 * The budget for one agent node, in milliseconds.
 *
 * A node that runs out of its budget is reported as failed and the plan
 * carries on. Without it, one child that never comes would take the results
 * of every node that already succeeded down with it.
 */
export const DEFAULT_AGENT_NODE_TIMEOUT_MS = 540000

/**
 * Whether a tool's own exclusivity is honoured.
 *
 * A tool that declares itself unsafe to run concurrently — a write, a command
 * that touches shared state — runs one after the other inside a plan, so the
 * plan still costs one round trip. A deployment that knows its exclusive
 * tools are safe together can turn the rule off and let them run together.
 */
export const DEFAULT_RESPECT_CONCURRENCY_SAFETY = true

/**
 * The tools that may run with others whatever their own definition says.
 *
 * `glob` and `grep` only read: they spawn their own subprocess and return
 * what they found. The harness does not know that, so the plugin says so here.
 */
export const DEFAULT_CONCURRENT_TOOLS: readonly string[] = ['glob', 'grep']

/**
 * Whether a read-only shell command may run with others.
 *
 * The shell tool's command may be anything, so the plugin judges the command
 * itself: a single simple command, on the allowlist of readers, with no
 * shell metacharacter that could hide a second command or a redirection.
 */
export const DEFAULT_CONCURRENT_SHELL = true

/**
 * The shell tool the read-only rule applies to.
 */
export const DEFAULT_SHELL_TOOL = 'ops_bash'

/**
 * How many rounds one request may run before the loop stops on its own.
 *
 * The loop is the point: a plan runs, and the next round decides what its
 * results mean. This is the valve that keeps a model that never concludes from
 * running forever — when it is reached the turn simply ends and the conversation
 * waits for a person.
 */
export const DEFAULT_MAX_ROUNDS = 16

/** Plugin config. */
export interface Config {
  /** Whether the plugin is mounted at all. */
  enabled: Volatile<boolean>
  /** The largest plan the tool accepts, in nodes. */
  maxBatchSize: Volatile<number>
  /** The budget for one plan, in milliseconds. */
  maxBatchTimeoutMs: Volatile<number>
  /** How deep a plan may start an agent. */
  maxAgentDepth: Volatile<number>
  /** The budget for one agent node, in milliseconds. */
  agentNodeTimeoutMs: Volatile<number>
  /** Whether a tool's own exclusivity is honoured. */
  respectConcurrencySafety: Volatile<boolean>
  /** The tools that may run with others whatever their own definition says. */
  concurrentTools: Volatile<string[]>
  /** Whether a read-only shell command may run with others. */
  concurrentShell: Volatile<boolean>
  /** The shell tool the read-only rule applies to. */
  shellTool: Volatile<string>
  /** How many rounds one request may run before the loop stops on its own. */
  maxRounds: Volatile<number>
  /** How many times a turn may be pulled back after it handed over its plan. */
}

export const Config = z.object({
  enabled: z.boolean().default(DEFAULT_ENABLED).volatile(),
  maxBatchSize: z.number().step(1).min(1).default(DEFAULT_MAX_BATCH_SIZE).volatile(),
  maxBatchTimeoutMs: z.number().step(1).min(1).default(DEFAULT_MAX_BATCH_TIMEOUT_MS).volatile(),
  maxAgentDepth: z.number().step(0).min(0).default(DEFAULT_MAX_AGENT_DEPTH).volatile(),
  agentNodeTimeoutMs: z.number().step(1).min(1).default(DEFAULT_AGENT_NODE_TIMEOUT_MS).volatile(),
  respectConcurrencySafety: z.boolean().default(DEFAULT_RESPECT_CONCURRENCY_SAFETY).volatile(),
  concurrentTools: z.array(z.string()).default([...DEFAULT_CONCURRENT_TOOLS]).volatile(),
  concurrentShell: z.boolean().default(DEFAULT_CONCURRENT_SHELL).volatile(),
  shellTool: z.string().default(DEFAULT_SHELL_TOOL).volatile(),
  maxRounds: z.number().step(1).min(1).default(DEFAULT_MAX_ROUNDS).volatile(),
})

/**
 * Register the plan tool, the guidance, the rule that makes a turn one plan, and the switch.
 *
 * @param ctx - the plugin context supplying the registries.
 * @param config - the resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled.get()) return

  // The harness reserves double braces for its prompt variables and refuses to
  // render a section that contains one, so a stray "{{" in this guidance would
  // break every turn of every conversation. The failure is loud and fast here
  // rather than silent and fatal in a session.
  if (REFINE_GUIDANCE.includes('{{')) {
    throw new Error('the refined loop guidance must not contain "{{": the harness reserves double braces '
      + 'for prompt variables and refuses to render a section that holds one')
  }

  // The conversations that opted out of the plugin. One conversation turning it
  // off changes no other conversation.
  const policy = new SessionPolicy()
  // Whether a conversation has opened its turn with a plan.
  const rounds = new Rounds()
  const plans = new Plans()
  // The conversations that are workers, which the loop leaves alone.
  const workers = new Workers()

  ctx.systemPrompt.section({
    name: 'refine-loop:policy',
    // The policy slot, not a tool slot. This section says what a turn in this
    // session is, so it belongs with the policies at the head of the prompt.
    // Registered among the tool sections it was read as documentation for one
    // tool, and it sat next to the harness's own advice to delegate directly —
    // which the model followed instead.
    order: ctx.systemPrompt.getSectionOrder('PLAN_POLICY'),
    // A conversation that opted out has no plan tool in its tool table, and
    // this guidance is written in terms of it — so the tool leaving is what
    // takes the guidance out of the system prompt.
    text: ({ scope }) => ctx.tools.get(PLAN_TOOL, scope) === undefined ? '' : REFINE_GUIDANCE,
  })

  applyPlanTool(ctx, {
    respectConcurrencySafety: () => config.respectConcurrencySafety.get(),
    maxBatchSize: () => config.maxBatchSize.get(),
    timeoutMs: () => config.maxBatchTimeoutMs.get(),
    overrides: () => buildOverrides(
      config.concurrentTools.get(),
      config.concurrentShell.get(),
      config.shellTool.get(),
    ),
    maxAgentDepth: () => config.maxAgentDepth.get(),
    agentNodeTimeoutMs: () => config.agentNodeTimeoutMs.get(),
    // A worker or a forker inherits this conversation, this round included.
    // The host context is what can start such a child; the sink is how the loop
    // learns which conversations are workers.
    // A plan report carries every call's output, and the harness truncates a
    // report that is too large — keeping the head and the tail, dropping the
    // middle, which loses whole nodes. A tool result that is too large is
    // compressed here, with the model, before it enters the report.
    compress: async (route, tool, output, signal) => {
      if (!needsCompression(output)) return output
      try {
        return await compressToolOutput(ctx, route, tool, output, signal)
      } catch (error: unknown) {
        ctx.logger?.warn?.(`refine-loop: compression failed, reporting the raw result: ${String(error)}`)
        return output
      }
    },
    host: () => ctx as unknown as Record<string, unknown>,
    onWorker: (sessionId: string) => workers.mark(sessionId),
    // One round is a plan and its execution. When the plan has run and the loop
    // still has rounds in budget, queue the next one: the plan tool ends this
    // turn, and the pending message is what makes the harness open the next.
    onPlanFinished: (agent: Agent) => {
      const sessionId = agent.session.id
      plans.done(sessionId)
      if (rounds.bump(sessionId) > config.maxRounds.get()) return false
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: NEXT_ROUND }],
        source: { kind: 'system-prompt' },
      }))
      return true
    },
    repair: (config: LlmCallConfig) => (failed, error, signal) => repairFailedCall(ctx, config, failed, error, signal),
  })


  // The doctrine is registered before the rounds hook: a pre-step hook's next()
  // runs the hooks registered after it, and the doctrine has to be the last
  // message the model reads before it speaks.
  applyTurnDoctrine(ctx, workers)
  applyRounds(ctx, rounds, plans)
  applyJudgementGuard(ctx, plans)
  applyWorkerRule(ctx, workers)
  applyDelegationRule(ctx)
  applyReportRetention(ctx)

  applyPolicyCommand(ctx, policy)
  applyPolicyMessage(ctx, policy)
}

/**
 * Keep the plan report whole.
 *
 * The harness mounts a spill policy on `tools/post-execute`: a result past its
 * budget is replaced by its head, its tail, and a path to the rest. That is a
 * good default for a tool the agent called itself. The plan report is the one
 * result the loop cannot afford to shorten — the agent judges from it, and a
 * report with its middle cut out is a report of nodes that silently disappeared.
 *
 * A result that carries a `value` instead of a `content` skips that policy, so
 * the report is handed over by value and rendered whole.
 *
 * @param ctx - the plugin context supplying the tool registry.
 */
export function applyReportRetention(ctx: Context): void {
  ctx.on('tools/post-execute', async (exec, result, next) => {
    if (exec.name !== PLAN_TOOL) return await next()
    return { kind: 'accept', value: result.value as never }
  }, { prepend: true })
}

/**
 * Ask the conversation's own model what a failed call should have been.
 *
 * The plugin owns no provider: the repair runs on the same model the
 * conversation already uses, so a plan's failure is fixed by the model that
 * wrote the plan — the call → think → call loop, run once, scoped to the one
 * call that failed.
 *
 * @param ctx - the plugin context supplying the model service.
 * @param config - the conversation's own call configuration.
 * @param failed - the call that failed.
 * @param error - what the tool said.
 * @param signal - the plan's cancellation signal.
 * @returns the corrected call, or undefined when there is nothing usable.
 */
async function repairFailedCall(
  ctx: Context,
  config: LlmCallConfig,
  failed: { name: string, arguments: unknown },
  error: string,
  signal: AbortSignal,
): Promise<{ name: string, arguments: unknown } | undefined> {
  const reply = await ctx.llm.stream({
    provider: config.provider,
    model: config.model,
    system: repairSystem(),
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: describeFailure(failed, error) }],
    }],
    signal,
  })
  let text = ''
  for await (const chunk of reply) {
    if (chunk.type === 'text-delta') text += chunk.text
  }
  return parseRepair(text, failed.name)
}


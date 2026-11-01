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
 *   layers and every result comes back in one tool result.
 * - The rule makes a turn one plan: the first call of a turn is the plan, and
 *   after the plan has run the turn is over — what the plan did not settle
 *   belongs to the next round.
 * - The per-conversation switch takes the whole plugin out of one conversation
 *   without touching the deployment.
 *
 * @module @local/dsh-refine-loop
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { buildOverrides } from './concurrency.js'
import { applyPlanGate, PlanGate } from './gate.js'
import { applyPolicyCommand, applyPolicyMessage, SessionPolicy } from './policy.js'
import { applyPlanTool, PLAN_TOOL } from './tool.js'
import { describeFailure, parseRepair, repairSystem } from './repair.js'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'refine-loop'

/**
 * Services this plugin needs: the tool registry, the prompt assembly, and the
 * command registry the per-conversation switch is registered in.
 */
export const inject = ['tools', 'systemPrompt', 'commands', 'llm']

/**
 * The refined loop, as the model should see it.
 *
 * This text is part of the system prompt and is re-sent every turn, so it
 * stays as short as the rule allows.
 */
export const REFINE_GUIDANCE = [
  'Refined loop:',
  `- ${PLAN_TOOL}: one call that carries the whole shape of the turn and returns every result together. `
  + 'Give it the observable criteria that decide whether it succeeded, and the nodes it is made of.',
  '- You do not call tools yourself: every call you make goes inside a plan. Draw the shape of the '
  + 'work in your reasoning first — which items are independent, which need a child with no context, which '
  + 'need a child that inherits this conversation, and what depends on what — then hand that shape over in '
  + 'one refine_plan call. The plan runs, its results come back together, and the turn is over: what the '
  + 'plan produced is what this turn produced. If you have nothing left to do, write the conclusion instead — '
  + 'that ends the turn too.',
  '- A node is one of three kinds. "tools": a batch of calls written before anything has run — they run '
  + 'together and nothing looks at a result before the next call, so it cannot correct itself; use it when '
  + 'the calls are plain and sure, such as reading files you can name exactly. "subagent"/"subagent_fork": '
  + 'the ordinary call → think → call chain, run inside the plan — the child sees each result and decides '
  + 'the next call, so it can work its own way out of a failure; use it when the work needs looking at what '
  + 'came back, such as auditing, searching, or tracing something you cannot name in advance. "subagent" '
  + 'starts with no context; "subagent_fork" inherits this conversation. You decide which one each task '
  + 'needs.',
  '- A node may name the nodes it depends on in "after". The nodes that depend on nothing run together, and '
  + 'the next layer waits for them. A tool argument that is exactly "@@nodeId@@" becomes the output of that '
  + 'node, and counts as a dependency too.',
  '- Write the tool calls of a node with absolute paths. A plan is written before anything has run, so a '
  + 'relative path is a guess: the same call that returns nothing when guessed can return everything when '
  + 'the path is spelled out.',
  '- The plan runs in one round trip and every result comes back together. A result may be too long to '
  + 'fit and be left out of what you see — the rest is in the spill file, and the next plan can read it.',
  'These are the rules for the refined loop. Do not go looking for them elsewhere — the tool is already in '
  + 'your tool table and the rules are already here.',
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
export const DEFAULT_MAX_BATCH_TIMEOUT_MS = 600000

/**
 * How deep a plan may start an agent.
 *
 * A child that is already a delegated child has no business starting another
 * one from inside a plan: the pipeline would eat itself. One means the
 * conversation may plan for children, and a child may plan for tool calls.
 */
export const DEFAULT_MAX_AGENT_DEPTH = 1

/**
 * The budget for one agent node, in milliseconds.
 *
 * A node that runs out of its budget is reported as failed and the plan
 * carries on. Without it, one child that never comes would take the results
 * of every node that already succeeded down with it.
 */
export const DEFAULT_AGENT_NODE_TIMEOUT_MS = 300000

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
 * Whether a turn has to open with a plan.
 *
 * The plan is the shape of the work only if it comes before the work. An
 * agent that starts calling tools has already chosen the first thing to do,
 * and the plan it draws afterwards is a plan of what is left rather than of
 * the whole turn.
 */
export const DEFAULT_REQUIRE_PLAN = true

/**
 * How many times a turn may be pulled back for not opening with a plan.
 *
 * A rule that traps an agent is worse than a rule it ignores, so after this
 * many refusals the turn is left alone.
 */
export const DEFAULT_PLAN_PULLBACKS = 2
/**
 * How many rounds one request may run before the loop stops on its own.
 *
 * The loop is the point: a plan runs, and the next round decides what its
 * results mean. This is the valve that keeps a model that never concludes from
 * running forever — when it is reached the turn simply ends and the conversation
 * waits for a person.
 */
export const DEFAULT_MAX_ROUNDS = 16
/** How many times a turn may be pulled back after it handed over its plan. */

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
  /** Whether every step has to be one plan. */
  requirePlan: Volatile<boolean>
  /** How many times a step may be pulled back before it is left alone. */
  planPullbacks: Volatile<number>
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
  requirePlan: z.boolean().default(DEFAULT_REQUIRE_PLAN).volatile(),
  planPullbacks: z.number().step(0).min(0).default(DEFAULT_PLAN_PULLBACKS).volatile(),
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
  const planGate = new PlanGate()

  ctx.systemPrompt.section({
    name: 'tool:refine-loop',
    order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
    // A conversation that opted out has no plan tool in its tool table, and
    // this guidance is written in terms of it — so the tool leaving is what
    // takes the guidance out of the system prompt.
    text: ({ scope }) => ctx.tools.get(PLAN_TOOL, scope) === undefined
      ? ''
      : REFINE_GUIDANCE,
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
    onPlanStarted: (sessionId, callId) => planGate.markPlanned(sessionId, callId),
    repair: (config: LlmCallConfig) => (failed, error, signal) => repairFailedCall(ctx, config, failed, error, signal),
  })


  applyPlanGate(ctx, planGate, {
    requirePlan: () => config.requirePlan.get(),
    planPullbacks: () => config.planPullbacks.get(),
    maxRounds: () => config.maxRounds.get(),
    appliesTo: (sessionId: string) => policy.appliesTo(sessionId),
  })

  applyPolicyCommand(ctx, policy)
  applyPolicyMessage(ctx, policy)
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


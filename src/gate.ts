/**
 * The rule that replaces a chain of one-call steps.
 *
 * A batch is only worth having if the agent reaches for it. Left alone, an
 * agent asked to do several independent things tends to take one step per
 * thing: decide, do one, read, decide again, do one more. Every one of those
 * steps is a round trip to the model, and every one of them re-reads the
 * history the earlier ones left behind.
 *
 * The rule watches for that shape rather than for any particular tool. A step
 * that made exactly one call, right after another step that made exactly one
 * call, is a chain. Two such steps in a row is the pattern this plugin exists
 * to break, and the third step is told how to break it: put the remaining
 * items into one plan.
 *
 * The rule is a nudge, not a cage. It changes the shape of the next step; it
 * never refuses a call, so an agent whose items genuinely depend on each other
 * can keep taking one step at a time.
 *
 * @module @zyn19940107/dsh-refine-loop/gate
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { PLAN_TOOL } from './tool.js'

/** What the agent is told when the chain is detected. */
export const PLAN_NUDGE = 'The last steps of this turn each did exactly one thing, and each of them cost a '
  + 'full round trip. The work left in this turn is probably several independent items, and they can travel '
  + `together: draw the plan and hand it over in one ${PLAN_TOOL} call. It carries the criteria and the `
  + 'nodes, runs the calls that may run together and the children that need to run, and returns every '
  + 'result at once — so you write the conclusion of all of them in one reply. If the remaining items '
  + 'really do depend on each other, say so and carry on one at a time.'

/**
 * What one conversation's steps looked like.
 *
 * The counts are per conversation, because the rule is about the shape of one
 * agent's turn and not about the deployment.
 */
export class ChainDetector {
  private readonly calls = new Map<string, number>()
  private readonly batched = new Map<string, boolean>()
  private readonly streak = new Map<string, number>()

  /**
   * Record that a call was made in the step in progress.
   *
   * @param sessionId - the session the call belongs to.
   * @param name - the tool that was called.
   */
  count(sessionId: string, name: string): void {
    this.calls.set(sessionId, (this.calls.get(sessionId) ?? 0) + 1)
    if (name === PLAN_TOOL) this.batched.set(sessionId, true)
  }

  /**
   * Whether the step that just finished was a chain step: exactly one call,
   * and it was not a batch.
   *
   * @param sessionId - the session the step belongs to.
   * @returns true when the step was a chain step.
   */
  takeChainStep(sessionId: string): boolean {
    const calls = this.calls.get(sessionId) ?? 0
    const batched = this.batched.get(sessionId) === true
    this.calls.delete(sessionId)
    this.batched.delete(sessionId)
    return calls === 1 && !batched
  }

  /**
   * Extend the chain streak.
   *
   * @param sessionId - the session the step belongs to.
   * @returns the length of the streak.
   */
  bumpStreak(sessionId: string): number {
    const streak = (this.streak.get(sessionId) ?? 0) + 1
    this.streak.set(sessionId, streak)
    return streak
  }

  /**
   * Break the chain streak.
   *
   * @param sessionId - the session the step belongs to.
   */
  resetStreak(sessionId: string): void {
    this.streak.delete(sessionId)
  }
}

/**
 * What one conversation's plan state looks like.
 *
 * The state is per conversation: whether the turn has opened with a plan, and
 * how many times the conversation has been pulled back for not doing so.
 */
export class PlanGate {
  private readonly planned = new Set<string>()
  private readonly pullbacks = new Map<string, number>()

  /**
   * Record that the conversation opened its turn with a plan.
   *
   * @param sessionId - the session the plan belongs to.
   */
  markPlanned(sessionId: string): void {
    this.planned.add(sessionId)
  }

  /**
   * Whether the conversation has opened its turn with a plan.
   *
   * @param sessionId - the session the plan belongs to.
   * @returns true when a plan was made.
   */
  hasPlanned(sessionId: string): boolean {
    return this.planned.has(sessionId)
  }

  /**
   * Record one refusal to open the turn with a plan.
   *
   * @param sessionId - the session the refusal belongs to.
   * @returns how many refusals the turn has collected.
   */
  bumpPullback(sessionId: string): number {
    const count = (this.pullbacks.get(sessionId) ?? 0) + 1
    this.pullbacks.set(sessionId, count)
    return count
  }

  /**
   * Forget the turn's plan state, for the turn that is about to start.
   *
   * @param sessionId - the session the turn belongs to.
   */
  reset(sessionId: string): void {
    this.planned.delete(sessionId)
    this.pullbacks.delete(sessionId)
  }
}

/**
 * What the agent is told when it tries to act before the turn has a plan.
 */
export const PLAN_REQUIRED = 'This turn has to open with a plan. Before you call anything else, hand the '
  + `shape of the turn to ${PLAN_TOOL}: the criteria that decide whether it succeeded, and the nodes — the `
  + 'calls that run together, the tasks that need a child with no context, the tasks that need a child that '
  + 'inherits this conversation, and what depends on what. The plan runs in one round trip and returns every '
  + 'result together.'

/**
 * The rule's configuration, read when the rule runs.
 */
export interface PlanGateConfig {
  /** Whether a turn has to open with a plan. */
  requirePlan: () => boolean
  /** How many times a turn may be pulled back before it is left alone. */
  planPullbacks: () => number
}

/**
 * Whether a call may run before the turn has opened with a plan.
 *
 * @param toolName - the tool being called.
 * @param sessionId - the session the call belongs to.
 * @param delegationDepth - how deep the calling agent is.
 * @param gate - the state the plan state is kept in.
 * @param requirePlan - whether a turn has to open with a plan.
 * @param maxPullbacks - how many times the turn may be pulled back.
 * @returns the refusal reason, or undefined when the call may run.
 */
export function planRefusal(
  toolName: string,
  sessionId: string,
  delegationDepth: number,
  gate: PlanGate,
  requirePlan: boolean,
  maxPullbacks: number,
): string | undefined {
  if (!requirePlan) return undefined
  if (toolName === PLAN_TOOL) return undefined
  if (gate.hasPlanned(sessionId)) return undefined
  // A child agent was handed a turn that was already planned.
  if (delegationDepth > 0) return undefined
  if (gate.bumpPullback(sessionId) > maxPullbacks) return undefined
  return PLAN_REQUIRED
}

/**
 * Make a turn open with a plan.
 *
 * The plan is only the shape of the work if it comes before the work. An
 * agent that starts calling tools has already chosen the first thing to do,
 * and the plan it draws afterwards is a plan of what is left rather than of
 * the whole turn — so the first tool call of a turn is refused unless it is
 * the plan itself.
 *
 * The refusal is a pullback, not a cage: after a couple of them the agent is
 * left alone, because a rule that traps an agent is worse than a rule it
 * ignores. A child agent is never held to the rule — the turn it was handed
 * was already planned.
 *
 * @param ctx - the plugin context supplying the agent runtime and the registry.
 * @param gate - the state the plan state is kept in.
 * @param config - the rule's configuration.
 */
export function applyPlanGate(
  ctx: Context,
  gate: PlanGate,
  config: PlanGateConfig,
): void {
  ctx.on('tools/pre-execute', async (exec, next) => {
    const agent = exec.agent
    if (agent !== undefined && exec.name === PLAN_TOOL) {
      gate.markPlanned(agent.session.id)
    }
    return next()
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'enter' && payload.step === 1) {
      gate.reset(payload.agent.session.id)
    }
    return decision
  })

  ctx.tools.guard((execution) => {
    const agent = execution.agent
    if (agent === undefined) return undefined
    return planRefusal(
      execution.name,
      agent.session.id,
      agent.session.header.delegationDepth ?? 0,
      gate,
      config.requirePlan(),
      config.planPullbacks(),
    )
  })
}

/**
 * The rule's configuration, read when the rule runs.
 */
export interface ChainRuleConfig {
  /** How many chain steps in a row the rule waits for before it speaks. */
  chainLimit: () => number
  /** Whether the rule applies to this conversation. */
  appliesTo: (sessionId: string) => boolean
}

/**
 * Watch for chains of one-call steps and tell the agent how to break them.
 *
 * The counts are read at the step boundary rather than at the call, because
 * the step boundary is the only place where "one call" is a fact: several
 * calls in one step are a batch the agent chose on its own, and the rule
 * leaves those alone.
 *
 * @param ctx - the plugin context supplying the agent runtime.
 * @param detector - the state the counts are kept in.
 * @param config - the rule's configuration.
 */
export function applyChainRule(
  ctx: Context,
  detector: ChainDetector,
  config: ChainRuleConfig,
): void {
  ctx.on('tools/pre-execute', async (exec, next) => {
    const agent = exec.agent
    if (agent !== undefined) detector.count(agent.session.id, exec.name)
    return next()
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const sessionId = payload.agent.session.id
    if (payload.step === 1) detector.resetStreak(sessionId)
    if (!config.appliesTo(sessionId)) {
      detector.resetStreak(sessionId)
      return decision
    }
    if (!detector.takeChainStep(sessionId)) {
      detector.resetStreak(sessionId)
      return decision
    }
    const streak = detector.bumpStreak(sessionId)
    const limit = config.chainLimit()
    if (streak < limit) return decision
    detector.resetStreak(sessionId)
    const message = createUserMessage({
      content: [{ type: 'text', text: PLAN_NUDGE }],
      source: { kind: 'system-prompt' },
    })
    return { kind: 'enter', messages: [...decision.messages, message] }
  })
}

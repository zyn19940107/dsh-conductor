/**
 * The rule that makes a turn open with a plan.
 *
 * A plan is only worth having if the agent reaches for it. Left alone, an
 * agent asked to do several independent things tends to take one step per
 * thing: decide, do one, read, decide again, do one more. Every one of those
 * steps is a round trip to the model, and every one of them re-reads the
 * history the earlier ones left behind.
 *
 * The rule makes the plan the first call of the turn instead of something the
 * agent may or may not reach for. A turn that opens with a plan carries the
 * whole shape of the work — the items that are independent, the tasks that
 * belong to a child agent, and what depends on what — and the plan's results
 * come back together.
 *
 * The rule is a pullback, not a cage: after a couple of refusals the agent is
 * left alone, because a rule that traps an agent is worse than a rule it
 * ignores. A child agent is never held to the rule — the turn it was handed
 * was already planned.
 *
 * @module @zyn19940107/dsh-refine-loop/gate
 */

import type { Context } from '@deepseek-ai/cordis'
import { PLAN_TOOL } from './tool.js'

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
export interface PlanGateConfig {
  /** Whether a turn has to open with a plan. */
  requirePlan: () => boolean
  /** How many times a turn may be pulled back before it is left alone. */
  planPullbacks: () => number
}

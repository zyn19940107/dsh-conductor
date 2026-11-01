/**
 * The rule that makes a turn one plan.
 *
 * A plan is only worth having if the agent reaches for it. Left alone, an
 * agent asked to do several independent things tends to take one step per
 * thing: decide, do one, read, decide again, do one more. Every one of those
 * steps is a round trip to the model, and every one of them re-reads the
 * history the earlier ones left behind.
 *
 * The rule gives the turn a shape: the agent hands over one plan, the plan
 * runs, the results come back together, and the agent writes the conclusion.
 * What is left over belongs to the next round — the rule does not let the
 * agent keep working past the plan it already handed over, because that is
 * how a turn turns back into a chain.
 *
 * The rule is a pullback, not a cage: after a couple of refusals the agent is
 * left alone, because a rule that traps an agent is worse than a rule it
 * ignores.
 *
 * @module @zyn19940107/dsh-refine-loop/gate
 */

import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { PLAN_TOOL } from './tool.js'

/**
 * What one conversation's plan state looks like.
 *
 * The state is per conversation: whether the turn has handed over its plan,
 * and how many times the conversation has been pulled back on each count.
 */
export class PlanGate {
  private readonly planned = new Map<string, ToolCallId>()
  private readonly before = new Map<string, number>()
  private readonly after = new Map<string, number>()

  /**
   * Record the call the turn handed its plan over with.
   *
   * Only the first plan of a turn is recorded: the turn keeps the plan it
   * started with, so a later plan is a call that wants to keep working.
   *
   * @param sessionId - the session the plan belongs to.
   * @param callId - the call the plan was handed over with.
   */
  markPlanned(sessionId: string, callId: ToolCallId): void {
    if (!this.planned.has(sessionId)) {
      this.planned.set(sessionId, callId)
    }
  }

  /**
   * The call the turn handed its plan over with.
   *
   * @param sessionId - the session the plan belongs to.
   * @returns the call, or undefined when the turn has not handed one over.
   */
  planCallId(sessionId: string): ToolCallId | undefined {
    return this.planned.get(sessionId)
  }

  /**
   * Whether the turn has handed over its plan.
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
  bumpBefore(sessionId: string): number {
    const count = (this.before.get(sessionId) ?? 0) + 1
    this.before.set(sessionId, count)
    return count
  }

  /**
   * Record one refusal to keep working past the turn's plan.
   *
   * @param sessionId - the session the refusal belongs to.
   * @returns how many refusals the turn has collected.
   */
  bumpAfter(sessionId: string): number {
    const count = (this.after.get(sessionId) ?? 0) + 1
    this.after.set(sessionId, count)
    return count
  }

  /**
   * Forget the turn's plan state, for the turn that is about to start.
   *
   * @param sessionId - the session the turn belongs to.
   */
  reset(sessionId: string): void {
    this.planned.delete(sessionId)
    this.before.delete(sessionId)
    this.after.delete(sessionId)
  }
}

/**
 * What the agent is told when it tries to act before the turn has a plan.
 */
export const PLAN_REQUIRED = 'This turn is one plan. Before you call anything else, hand the turn over as a '
  + `plan with ${PLAN_TOOL}: the criteria that decide whether it succeeded, and the nodes — the calls `
  + 'that run together, the tasks that need a child with no context, the tasks that need a child that '
  + 'inherits this conversation, and what depends on what. The plan runs in one round trip and returns every '
  + 'result together.'

/**
 * What the agent is told when it tries to keep working past the turn's plan.
 */
export const PLAN_DONE = 'This turn already handed over its plan, and the plan\'s results are in front of '
  + 'you. Do not call any tool again in this turn — the turn ends with what the plan produced. Write that '
  + 'conclusion now: what the plan produced, what it did not settle, and what the next round has to pick up. '
  + 'The next round draws the next plan. Do not hand over another plan in this turn.'

/**
 * Whether a call is the model's own call rather than one a plan made.
 *
 * The harness marks a nested call with the root call it runs under, so the
 * calls a plan makes are told apart from the calls the model asked for.
 *
 * @param execution - the call about to run.
 * @returns true when the model asked for this call itself.
 */
export function isModelCall(execution: { readonly callId: ToolCallId, readonly rootCallId: ToolCallId }): boolean {
  return execution.rootCallId === execution.callId
}

/**
 * Whether a call may run.
 *
 * @param toolName - the tool being called.
 * @param callId - the call being made.
 * @param sessionId - the session the call belongs to.
 * @param gate - the state the plan state is kept in.
 * @param appliesTo - whether the rules apply to this conversation.
 * @param requirePlan - whether a turn has to be one plan.
 * @param planPullbacks - how many times the turn may be pulled back before it handed over its plan.
 * @param conclusionPullbacks - how many times the turn may be pulled back after it handed over its plan.
 * @returns the refusal reason, or undefined when the call may run.
 */
export function planRefusal(
  toolName: string,
  callId: ToolCallId,
  sessionId: string,
  gate: PlanGate,
  appliesTo: (sessionId: string) => boolean,
  requirePlan: boolean,
  planPullbacks: number,
  conclusionPullbacks: number,
): string | undefined {
  // A conversation that opted out is left alone.
  if (!appliesTo(sessionId)) return undefined
  if (!requirePlan) return undefined
  const planCall = gate.planCallId(sessionId)
  if (planCall === undefined) {
    // The turn has not handed over its plan yet: the plan is the first call.
    if (toolName === PLAN_TOOL) return undefined
    if (gate.bumpBefore(sessionId) > planPullbacks) return undefined
    return PLAN_REQUIRED
  }
  // The call the plan was handed over with is the plan itself.
  if (callId === planCall) return undefined
  // The turn already handed over its plan: what is left is the conclusion.
  if (gate.bumpAfter(sessionId) > conclusionPullbacks) return undefined
  return PLAN_DONE
}
/**
 * Make a turn one plan.
 *
 * The plan is only the shape of the work if it comes before the work, and it
 * is only the shape of the whole turn if the turn stops when the plan's
 * results arrive. So the first tool call of a turn has to be the plan, and
 * every call after it has to be the conclusion.
 *
 * The refusal is a pullback, not a cage: after a couple of them the turn is
 * left alone, because a rule that traps an agent is worse than a rule it
 * ignores.
 *
 * @param ctx - the plugin context supplying the agent runtime and the registry.
 * @param gate - the state the plan state is kept in.
 * @param config - the rule's configuration.
 */
export function applyPlanGate(
  ctx: Context,
  gate: PlanGate,
  config: PlanGateConfig,
): void {  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'enter' && payload.step === 1) {
      gate.reset(payload.agent.session.id)
    }
    return decision
  })

  ctx.tools.guard((execution) => {
    const agent = execution.agent
    if (agent === undefined) return undefined
    // Only the calls the model asked for are held to the rule. The calls a
    // plan makes are nested under the plan's own call, and they are the
    // plan's business — the rule is about what the model does between rounds.
    if (!isModelCall(execution)) return undefined
    return planRefusal(
      execution.name,
      execution.callId,
      agent.session.id,
      gate,
      config.appliesTo,
      config.requirePlan(),
      config.planPullbacks(),
      config.conclusionPullbacks(),
    )
  })
}

/**
 * The rule's configuration, read when the rule runs.
 */
export interface PlanGateConfig {
  /** Whether a turn has to be one plan. */
  requirePlan: () => boolean
  /** How many times the turn may be pulled back before it handed over its plan. */
  planPullbacks: () => number
  /** How many times the turn may be pulled back after it handed over its plan. */
  conclusionPullbacks: () => number
  /** Whether the rules apply to this conversation. */
  appliesTo: (sessionId: string) => boolean
}

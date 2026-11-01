/**
 * The rule that keeps the agent's tool calls inside a plan.
 *
 * A plan is only worth having if the agent reaches for it. Left alone, an
 * agent asked to do several independent things tends to take one step per
 * thing: decide, do one, read, decide again, do one more. Every one of those
 * steps is a round trip to the model, and every one of them re-reads the
 * history the earlier ones left behind.
 *
 * The rule is one line: the agent does not call tools itself. Every tool call
 * it makes goes inside a plan.
 *
 * What the agent does after a plan has run is its own business: it decides
 * whether to hand over another plan or to write the conclusion. Writing the
 * conclusion ends the turn, and the harness ends it — the rule does not decide
 * that, and it does not stop the agent from planning again.
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
 * The state is per conversation: how many times the conversation has been
 * pulled back for calling a tool itself.
 */
export class PlanGate {
  private readonly before = new Map<string, number>()
  private readonly planned = new Map<string, ToolCallId>()

  /**
   * Count one pullback for a tool the agent called itself.
   *
   * @param sessionId - the session the call belongs to.
   * @returns how many times the conversation has been pulled back.
   */
  bumpBefore(sessionId: string): number {
    const count = (this.before.get(sessionId) ?? 0) + 1
    this.before.set(sessionId, count)
    return count
  }

  /**
   * Record the plan the turn handed over.
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
   * Whether the turn has handed over a plan.
   *
   * @param sessionId - the session the turn belongs to.
   * @returns true when a plan has run in this turn.
   */
  hasPlanned(sessionId: string): boolean {
    return this.planned.has(sessionId)
  }

  /**
   * Forget one conversation's pullbacks and its plan.
   *
   * @param sessionId - the session the turn belongs to.
   */
  reset(sessionId: string): void {
    this.before.delete(sessionId)
    this.planned.delete(sessionId)
  }
}

/**
 * What the agent is told when it tries to call a tool itself.
 */
export const PLAN_REQUIRED = 'Do not call tools yourself — every call you make goes inside a plan. Either hand '
  + `the work over as a plan with ${PLAN_TOOL} — the criteria that decide whether it succeeded, and the `
  + 'nodes: the calls that run together, the tasks that need a child with no context, the tasks that need a '
  + 'child that inherits this conversation, and what depends on what. The plan runs in one round trip and '
  + 'returns every result together — or write the conclusion, which ends the turn.'

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
 * @param sessionId - the session the call belongs to.
 * @param gate - the state the pullbacks are kept in.
 * @param appliesTo - whether the rules apply to this conversation.
 * @param requirePlan - whether tool calls have to go inside a plan.
 * @param planPullbacks - how many times the conversation may be pulled back.
 * @returns the refusal reason, or undefined when the call may run.
 */
export function planRefusal(
  toolName: string,
  sessionId: string,
  gate: PlanGate,
  appliesTo: (sessionId: string) => boolean,
  requirePlan: boolean,
  planPullbacks: number,
): string | undefined {
  // A conversation that opted out is left alone.
  if (!appliesTo(sessionId)) return undefined
  if (!requirePlan) return undefined
  // The plan is how the work is handed over.
  if (toolName === PLAN_TOOL) return undefined
  if (gate.bumpBefore(sessionId) > planPullbacks) return undefined
  return PLAN_REQUIRED
}

/**
 * Keep the agent's tool calls inside a plan.
 *
 * @param ctx - the plugin context supplying the agent runtime and the registry.
 * @param gate - the state the pullbacks are kept in.
 * @param config - the rule's configuration.
 */
export function applyPlanGate(
  ctx: Context,
  gate: PlanGate,
  config: PlanGateConfig,
): void {
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const sessionId = payload.agent.session.id
    if (payload.step === 1) {
      gate.reset(sessionId)
      return decision
    }
    // The plan has run: the turn is over. What it produced is what the turn
    // produced. Coming back to draw another plan is the chain this plugin is
    // here to replace.
    if (gate.hasPlanned(sessionId)) {
      return { kind: 'reject' }
    }
    return decision
  })

  ctx.tools.guard((execution) => {
    const agent = execution.agent
    if (agent === undefined) return undefined
    // Only the calls the model asked for are held to the rule. The calls a
    // plan makes are nested under the plan's own call, and they are the
    // plan's business.
    if (!isModelCall(execution)) return undefined
    return planRefusal(
      execution.name,
      agent.session.id,
      gate,
      config.appliesTo,
      config.requirePlan(),
      config.planPullbacks(),
    )
  })
}

/**
 * The rule's configuration, read when the rule runs.
 */
export interface PlanGateConfig {
  /** Whether tool calls have to go inside a plan. */
  requirePlan: () => boolean
  /** How many times the conversation may be pulled back before it hands over a plan. */
  planPullbacks: () => number
  /** Whether the rules apply to this conversation. */
  appliesTo: (sessionId: string) => boolean
}

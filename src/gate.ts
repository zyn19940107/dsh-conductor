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
import { createUserMessage } from '@deepseek-ai/dsh-llm'
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
  private readonly rounds = new Map<string, number>()

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
   * Count one round the loop ran for the same request.
   *
   * @param sessionId - the session the round belongs to.
   * @returns how many rounds the request has used.
   */
  bumpRound(sessionId: string): number {
    const count = (this.rounds.get(sessionId) ?? 0) + 1
    this.rounds.set(sessionId, count)
    return count
  }

  /**
   * How many rounds the current request has used.
   *
   * @param sessionId - the session the request belongs to.
   * @returns the round count.
   */
  roundsUsed(sessionId: string): number {
    return this.rounds.get(sessionId) ?? 0
  }

  /**
   * Forget one conversation's rounds.
   *
   * A person speaking starts a new request, and a new request gets its own
   * budget.
   *
   * @param sessionId - the session the request belongs to.
   */
  resetRounds(sessionId: string): void {
    this.rounds.delete(sessionId)
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
 * What the loop says when a plan has run and the next round starts.
 *
 * A round is: the model decides, and a plan runs. The turn does not end after a
 * plan — the next round starts with this message, and the model decides again.
 */
export const NEXT_ROUND = 'The plan has run — every result is above. This is the next round: hand over '
  + `another plan with ${PLAN_TOOL} for what is left, or write the conclusion. Writing the conclusion answers `
  + 'the request and ends the loop.'

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
 * @param delegationDepth - how deep the calling agent is; a delegated child is 1.
 * @returns the refusal reason, or undefined when the call may run.
 */
export function planRefusal(
  toolName: string,
  sessionId: string,
  gate: PlanGate,
  appliesTo: (sessionId: string) => boolean,
  requirePlan: boolean,
  planPullbacks: number,
  delegationDepth = 0,
): string | undefined {
  // A conversation that opted out is left alone.
  if (!appliesTo(sessionId)) return undefined
  if (!requirePlan) return undefined
  // A delegated child is an agent: it looks at a result, then decides the next
  // call. That is the whole point of handing work to one — a child that must
  // write its calls before anything runs cannot notice that a command is slow,
  // that a grep returned nothing, or that the files are not where it guessed.
  // Measured: a child forced to plan one call, watched a recursive directory
  // scan take 290 of its 300 seconds, and could not change course.
  //
  // It may still hand over a plan when it already knows every call; it is not
  // required to. What keeps this cheap is the parent's task being narrow —
  // measured: a child given a whole survey instead of one question walked 14
  // steps and cost 1.2M tokens, and the fix for that is the task, not the gate.
  if (delegationDepth > 0) return undefined
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
    // A person speaking starts a new request, and a new request gets its own
    // budget for rounds.
    if (payload.messages.some(message => message.source?.kind === 'user')) {
      gate.resetRounds(sessionId)
    }
    if (payload.step === 1) {
      gate.reset(sessionId)
      return decision
    }
    // A plan that ran ends its own turn (the plan tool concludes it), so there
    // is nothing left for this hook to do here. The round it starts is queued
    // when the plan finishes, and the harness opens it as the next turn.
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
      agent.session.header.delegationDepth ?? 0,
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
  /** How many rounds one request may run before the loop stops on its own. */
  maxRounds: () => number
  /** Whether the rules apply to this conversation. */
  appliesTo: (sessionId: string) => boolean
}

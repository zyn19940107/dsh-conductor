/**
 * How many rounds one request may run.
 *
 * A round is one turn that hands over a plan: the plan runs, the results come
 * back, and the harness opens the next turn. Nothing else limits that loop, so
 * this budget does: when it is spent the plugin stops queueing the next round and
 * waits for the person.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'

/**
 * What the model is told when its plan has run and another round is open.
 *
 * It has every result in front of it and exactly two ways on: hand over another
 * plan for what is left, or write the conclusion, which answers the request and
 * ends the loop.
 */
export const NEXT_ROUND = 'The plan has run — every result is above. This is the next round: hand over another plan '
  + 'with refine_plan for what is left, or write the conclusion. Writing the conclusion answers the request and '
  + 'ends the loop.'

/**
 * The rounds each conversation has spent.
 */
export class Rounds {
  /** Rounds counted so far. */
  readonly #counts = new Map<string, number>()

  /**
   * Count one more round.
   *
   * @param sessionId - the conversation.
   * @returns how many rounds it has now spent.
   */
  bump(sessionId: string): number {
    const next = (this.#counts.get(sessionId) ?? 0) + 1
    this.#counts.set(sessionId, next)
    return next
  }

  /**
   * How many rounds a conversation has spent.
   *
   * @param sessionId - the conversation.
   * @returns the count.
   */
  used(sessionId: string): number {
    return this.#counts.get(sessionId) ?? 0
  }

  /**
   * Forget a conversation's rounds.
   *
   * @param sessionId - the conversation.
   */
  reset(sessionId: string): void {
    this.#counts.delete(sessionId)
  }
}

/**
 * Reset the round budget whenever the person speaks.
 *
 * A new request gets its own budget; the rounds of the request before it are not
 * its business.
 *
 * @param ctx - the plugin context supplying the agent runtime.
 * @param rounds - the counters.
 * @param config - the budget.
 */
export function applyRounds(ctx: Context, rounds: Rounds): void {
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    if (payload.messages.some(message => message.source?.kind === 'user')) {
      rounds.reset(payload.agent.session.id)
    }
    return decision
  })
}

/**
 * What the model is told when it calls a tool outside a plan.
 *
 * The plugin's whole contract is that a turn hands its work over as a graph, or
 * writes the conclusion. This is the sentence that holds that contract: the
 * model may not act one call at a time, because that is the shape the plugin
 * exists to replace.
 */
export const PLAN_REQUIRED = 'Every tool call you make goes inside a plan: hand the work over with refine_plan — '
  + 'the criteria that decide whether it succeeded, and the nodes it is made of. If nothing is left to do, '
  + 'write the conclusion instead: that answers the request and ends the loop.'

/**
 * Whether a call is one the model asked for itself.
 *
 * The calls a plan makes are nested under the plan's own call, and they are the
 * plan's business — only the model's own calls are held to the rule.
 *
 * @param execution - the call being executed.
 * @returns true when the model asked for it.
 */
export function isModelCall(execution: {
  readonly callId: string
  readonly rootCallId: string
}): boolean {
  return execution.callId === execution.rootCallId
}

/**
 * The rule's configuration, read when the rule runs.
 */
export interface RuleConfig {
  /** Whether tool calls have to go inside a plan. */
  requirePlan: () => boolean
  /** How many refusals a turn gets before it is left alone. */
  planPullbacks: () => number
}

/**
 * Keep the model's own tool calls inside a plan.
 *
 * A person speaking starts a new request, and a new request gets a fresh budget
 * of refusals. A rule that traps an agent is worse than a rule it ignores, so
 * after the budget the turn is left alone.
 *
 * @param ctx - the plugin context supplying the tool registry.
 * @param config - the rule.
 */
export function applyRule(ctx: Context, config: RuleConfig): void {
  const refusals = new Map<string, number>()
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    if (payload.messages.some(message => message.source?.kind === 'user')) {
      refusals.delete(payload.agent.session.id)
    }
    return decision
  })
  ctx.tools.guard((execution) => {
    const agent = execution.agent
    if (agent === undefined) return undefined
    if (!isModelCall(execution)) return undefined
    if (!config.requirePlan()) return undefined
    if (execution.name === 'refine_plan') return undefined
    const sessionId = agent.session.id
    const seen = (refusals.get(sessionId) ?? 0) + 1
    refusals.set(sessionId, seen)
    if (seen > config.planPullbacks()) return undefined
    return PLAN_REQUIRED
  })
}

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
 * What the model is told when it has looked enough.
 *
 * Tool calls are there to make the plan accurate — to find out what the nodes
 * should say. The work itself belongs in the plan, where the independent nodes
 * run at the same time instead of one step at a time.
 */
export const PLAN_REQUIRED = 'Tool calls are for writing the plan accurately; the work itself goes in the plan. '
  + 'Hand the rest over with refine_plan — the criteria that decide whether it succeeded, and the nodes it is '
  + 'made of — or write the conclusion if nothing is left to do.'

/**
 * Whether a call is one the model asked for itself.
 *
 * The calls a plan makes are nested under the plan's own call, and they are the
 * plan's business.
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
 * The rule's configuration, read when it runs.
 */
export interface RuleConfig {
  /** How many calls the model may make itself before it has to hand over a plan. */
  reconCalls: () => number
  /** How many refusals a turn gets on top of that before it is left alone. */
  planPullbacks: () => number
}

/**
 * Keep the model's own calls down to reconnaissance.
 *
 * A turn may look before it plans — that is what makes a plan accurate — but
 * past that budget the rest of the turn is a plan or a conclusion. A rule that
 * traps an agent is worse than a rule it ignores, so after the refusals run out
 * the turn is left alone.
 *
 * @param ctx - the plugin context supplying the tool registry.
 * @param config - the rule.
 */
export function applyRule(ctx: Context, config: RuleConfig): void {
  const seen = new Map<string, number>()
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    // A turn starts with a clean budget: the reconnaissance of the turn before
    // it was in aid of a plan that has already run.
    if (payload.step === 1 || payload.messages.some(message => message.source?.kind === 'user')) {
      seen.delete(payload.agent.session.id)
    }
    return decision
  })
  ctx.tools.guard((execution) => {
    const agent = execution.agent
    if (agent === undefined) return undefined
    if (!isModelCall(execution)) return undefined
    if (execution.name === 'refine_plan') return undefined
    const sessionId = agent.session.id
    const count = (seen.get(sessionId) ?? 0) + 1
    seen.set(sessionId, count)
    const recon = config.reconCalls()
    if (count <= recon) return undefined
    if (count > recon + config.planPullbacks()) return undefined
    return PLAN_REQUIRED
  })
}

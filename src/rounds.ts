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

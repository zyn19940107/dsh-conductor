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
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/**
 * What the model is told when its plan has run and another round is open.
 *
 * It has every result in front of it and exactly two ways on: hand over another
 * plan for what is left, or write the conclusion, which answers the request and
 * ends the loop.
 */
export const NEXT_ROUND = 'The plan has run — every result is above. Step 4: is the request answered? If it is, '
  + 'write the conclusion — that answers it and ends the loop. If it is not, go back to step 1 and hand over the '
  + 'next plan with refine_plan.'

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
export function applyRounds(ctx: Context, rounds: Rounds, plans: Plans): void {
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    if (payload.messages.some(message => message.source?.kind === 'user')) {
      rounds.reset(payload.agent.session.id)
      // A new request expects its own plan: the one the request before it handed
      // over is not this request's plan.
      plans.expect(payload.agent.session.id)
    }
    return decision
  })
}

/**
 * What the model is told when it tries to call a tool before handing over a plan.
 *
 * Tool calls are there to write the plan accurately — they are not the work. The
 * work is the plan, where the independent nodes run at the same time.
 */
export const PLAN_REQUIRED = 'Call tools only to write the plan: they are how you find out what the nodes '
  + 'should say, not how the work gets done. Hand the plan over first with refine_plan — the observable '
  + 'criteria and the nodes — and it runs, its independent nodes together, and every result comes back.'

/**
 * Whether a call is one the model asked for itself.
 *
 * The calls a plan makes are nested under the plan's own call.
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
 * Make the plan the first thing a turn hands over.
 *
 * A turn is one plan. Until the plan has been handed over, the model's own tool
 * calls are refused: letting them run is letting the turn do the work one call at
 * a time, which is the shape this plugin exists to replace.
 *
 * @param ctx - the plugin context supplying the tool registry.
 */
export function applyPlanFirst(ctx: Context): void {
  ctx.tools.guard((execution) => {
    const agent = execution.agent
    if (agent === undefined) return undefined
    if (!isModelCall(execution)) return undefined
    if (execution.name === 'refine_plan') return undefined
    return PLAN_REQUIRED
  })
}

/**
 * What the model is told when it stops a turn without having handed over a plan.
 *
 * A tool call is how the plan gets written accurately; the plan is the work. A
 * conclusion written before any plan has run answers the request with the loop
 * never having run, so the turn is put back on the loop instead of being allowed
 * to end.
 */
export const MUST_PLAN = 'This turn has not handed over a plan yet. A tool call is how the plan gets written '
  + 'accurately — the plan is the work. Call refine_plan with the observable criteria and the nodes; it runs, '
  + 'the independent nodes together, and every result comes back. Then the turn ends.'

/**
 * How many times one request may be put back on the loop before it is let go.
 *
 * A rule that traps an agent is worse than a rule it ignores.
 */
export const MUST_PLAN_LIMIT = 3

/**
 * Track whether a request has handed over a plan yet.
 */
export class Plans {
  /** Conversations still waiting for their first plan. */
  readonly #waiting = new Map<string, number>()

  /**
   * Start expecting a plan, and forget the nudges of the request before it.
   *
   * @param sessionId - the conversation.
   */
  expect(sessionId: string): void {
    this.#waiting.set(sessionId, 0)
  }

  /**
   * Note that a plan has run.
   *
   * @param sessionId - the conversation.
   */
  done(sessionId: string): void {
    this.#waiting.delete(sessionId)
  }

  /**
   * Count one nudge, and say whether another is allowed.
   *
   * @param sessionId - the conversation.
   * @returns true when the turn may be put back on the loop.
   */
  nudge(sessionId: string): boolean {
    const used = this.#waiting.get(sessionId)
    if (used === undefined) return false
    if (used >= MUST_PLAN_LIMIT) return false
    this.#waiting.set(sessionId, used + 1)
    return true
  }
}

/**
 * Put a turn back on the loop when it stops without a plan.
 *
 * Every call a plan makes is nested under the plan's own call, so a turn that
 * stops without one has answered the request without the loop running. The
 * follow-up opens the next turn with the message above.
 *
 * @param ctx - the plugin context supplying the agent runtime.
 * @param plans - the tracker.
 */
export function applyMustPlan(ctx: Context, plans: Plans): void {
  ctx.on('agent/turn-stopping', ({ agent, signal }) => {
    if (signal.aborted) return
    if (agent.inbox.nextTurn.length > 0) return
    if (!plans.nudge(agent.session.id)) return
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: MUST_PLAN }],
      source: { kind: 'system-prompt' },
    }))
  })
}

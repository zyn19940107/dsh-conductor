/**
 * The turn doctrine and the round budget.
 *
 * Every round of the loop runs the same way: the turn's work is a graph, or — if
 * the results already in hand answer the request — the conclusion that ends the
 * loop. The doctrine is a message at the head of every turn, because a message
 * that arrives with the step is acted on where a paragraph in the system prompt is
 * read as background.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/**
 * What the model is told at the head of every turn.
 *
 * It says both halves of the rule in one place: hand over the graph, or answer.
 */
export const GRAPH_OR_CONCLUSION = 'Every turn hands its work over as a graph, or answers with the conclusion. '
  + 'It answers only if the plan results above already answer the request; a turn with no plan results above has '
  + 'nothing to answer from. Otherwise the graph is the work of this turn: what the pieces of work are, which of '
  + 'can run at the same time, what each node is made of, and what observable criteria decide it succeeded. Call '
  + 'tools only to answer questions the graph needs answered, then hand it over with refine_plan.'

/**
 * What the model is told when a plan has run and another round is open.
 *
 * The results are in front of it; this is the round's judgement: answer, or draw
 * the next graph.
 */
export const NEXT_ROUND = 'The plan has run — every result is above. Judge it: if the request is answered, write the '
  + 'conclusion — that ends the loop. If it is not, this turn is the next graph: hand it over with refine_plan.'

/**
 * What the model is told when it tries to delegate outside a plan.
 *
 * The harness ships direct delegation tools. In this plugin delegation is a node
 * of the graph: the child runs as part of the turn, under the round's plan, and
 * the results come back together.
 */
export const DELEGATE_IN_GRAPH = 'Delegation happens inside the plan: add a "subagent_fork" node to refine_plan '
  + 'and the child runs as part of this turn\'s graph, under the plan\'s budget. A direct delegation call would '
  + 'run outside the plan.'

/** The tools the harness ships for delegating directly. */
export const DELEGATION_TOOLS = ['subagent', 'subagent_fork'] as const

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
 * Say the turn doctrine as the last message before the model speaks.
 *
 * Registered before {@link applyRounds}: a pre-step hook's `next()` runs the hooks
 * registered after it, and the message has to be the one the model reads last.
 *
 * @param ctx - the plugin context supplying the agent runtime.
 */
export function applyTurnDoctrine(ctx: Context): void {
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    if (payload.step !== 1) return decision
    return {
      ...decision,
      messages: [...decision.messages, createUserMessage({
        content: [{ type: 'text', text: GRAPH_OR_CONCLUSION }],
        source: { kind: 'system-prompt' },
      })],
    }
  })
}

/**
 * Put the harness's direct delegation tools behind the plan.
 *
 * Each tool keeps its name and schema, so the model still sees it and still gets a
 * clear reason when it reaches for it. What changes is the call the model makes
 * itself: it is refused, and the reason points at the plan. The calls a plan makes
 * are nested under the plan's own call and go through untouched — that is how a
 * node of kind "subagent" or "subagent_fork" still works.
 *
 * @param ctx - the plugin context supplying the tool registry.
 */
export function applyDelegationRule(ctx: Context): void {
  ctx.on('agent/created', ({ agent }): undefined => {
    for (const name of DELEGATION_TOOLS) {
      const original = ctx.tools.get(name)
      if (original === undefined) continue
      agent.ctx.tools.register({
        ...original,
        execute: async (args: unknown, exec: Parameters<typeof original.execute>[1]) => {
          if (exec.callId === exec.rootCallId) throw new Error(DELEGATE_IN_GRAPH)
          return await original.execute(args, exec)
        },
      })
    }
    return undefined
  })
}

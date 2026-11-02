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
export const ROUND_LOOP = 'Every round is the same four steps. (1) Design the graph: what the pieces of work '
  + 'are, which of them can run at the same time, what each node is made of, what observable criteria decide it '
  + 'succeeded. (2) Hand it over with refine_plan. (3) It runs — the independent nodes together — and every '
  + 'result comes back. (4) Only then judge: if those results answer the request, write the conclusion, which '
  + 'ends the loop; if they do not, the next round designs the next graph. You may call tools while you design '
  + 'the graph — use them to find out what a node should say. What is not allowed is using them to do the work and '
  + 'skip the graph: the conclusion comes only after a graph has run.'

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
 * Whether a request has handed over a plan yet.
 *
 * The turn before the first plan is the graph; the turns after it judge what the
 * plan produced. The flag lives as long as the request does.
 */
export class Plans {
  /** Requests that have not produced a plan yet. */
  readonly #waiting = new Set<string>()

  /**
   * Start expecting a plan.
   *
   * @param sessionId - the conversation.
   */
  expect(sessionId: string): void {
    this.#waiting.add(sessionId)
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
   * Whether a request still has to hand over its first plan.
   *
   * @param sessionId - the conversation.
   * @returns true when no plan has run for the current request.
   */
  waiting(sessionId: string): boolean {
    return this.#waiting.has(sessionId)
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
export function applyRounds(ctx: Context, rounds: Rounds, plans: Plans): void {
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    if (payload.messages.some(message => message.source?.kind === 'user')) {
      rounds.reset(payload.agent.session.id)
      // A new request expects its own plan: the plan the request before it handed
      // over is not this request's plan.
      plans.expect(payload.agent.session.id)
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
        content: [{ type: 'text', text: ROUND_LOOP }],
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

/**
 * What the model is told when it reaches for a tool after the graph has run.
 *
 * The round after a plan is the judgement: the results are in, and the turn is
 * either the conclusion that ends the loop or the next graph. Work done one call
 * at a time here is work that belonged inside a graph.
 */
export const JUDGE_ONLY = 'The graph has run — every result is above. This turn is the judgement: write the '
  + 'conclusion if the results answer the request, or hand over the next graph with refine_plan for what is '
  + 'still missing. Direct tool calls belong inside a graph, not after one.'

/**
 * What the model is told when it stops a turn that never handed over a graph.
 *
 * A turn is a graph: stopping without one answers the request with the loop never
 * having run.
 */
export const MUST_PLAN = 'This turn has not handed over a graph yet. The work of a turn is the graph: call '
  + 'refine_plan with the observable criteria and the nodes, and it runs — the independent nodes together — and '
  + 'every result comes back. Then the turn ends.'

/**
 * How many times a turn may be put back on the loop before it is let go.
 *
 * A rule that traps an agent is worse than a rule it ignores.
 */
export const MUST_PLAN_LIMIT = 3

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
 * Refuse work done one call at a time after the graph has run.
 *
 * The round after a plan is the judgement, so the only ways on are the conclusion
 * and the next graph. The calls a plan makes are nested and go through untouched.
 *
 * @param ctx - the plugin context supplying the tool registry.
 * @param plans - the request tracker.
 */
export function applyJudgementGuard(ctx: Context, plans: Plans): void {
  ctx.tools.guard((execution) => {
    const agent = execution.agent
    if (agent === undefined) return undefined
    if (!isModelCall(execution)) return undefined
    if (execution.name === 'refine_plan') return undefined
    if (plans.waiting(agent.session.id)) return undefined
    return JUDGE_ONLY
  })
}

/**
 * Put a turn back on the loop when it stops without a graph.
 *
 * @param ctx - the plugin context supplying the agent runtime.
 * @param plans - the request tracker.
 */
export function applyMustPlan(ctx: Context, plans: Plans): void {
  const nudges = new Map<string, number>()
  ctx.on('agent/turn-stopping', ({ agent, signal }) => {
    if (signal.aborted) return
    const sessionId = agent.session.id
    if (!plans.waiting(sessionId)) return
    if (agent.inbox.nextTurn.length > 0) return
    const used = (nudges.get(sessionId) ?? 0) + 1
    nudges.set(sessionId, used)
    if (used > MUST_PLAN_LIMIT) return
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: MUST_PLAN }],
      source: { kind: 'system-prompt' },
    }))
  })
}

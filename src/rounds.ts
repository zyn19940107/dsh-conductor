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
import { WORKER_MARKER } from './plan.js'
import { PLAN_TOOL } from './tool.js'

/**
 * What the model is told at the head of every turn.
 *
 * It says both halves of the rule in one place: hand over the graph, or answer.
 */
export const ROUND_LOOP = 'Every round is the same four steps. (1) Design the plan: what the pieces of work '
  + 'are, which of them are independent enough to run at the same time, what each node is made of, what '
  + 'observable criteria decide it succeeded. If there is nothing to run — you already have what you need — '
  + 'hand over the empty plan. Write every call with the exact tool name from the tool list you were given — '
  + 'copy it, do not reconstruct it from memory. (2) Hand it over with refine_plan: one layer, every node '
  + 'starts at the same time, every result comes back together. The plan may be empty, and then the round goes '
  + 'on to the conclusion. (3) It runs — the nodes together — and every result comes back. (4) Only then '
  + 'judge: if those results answer the request, write the conclusion, which ends the loop; if they do not, '
  + 'the next round designs the next plan. You may call tools while you design the plan — use them to find out '
  + 'what a node should say. There is no dependency between the nodes of one round: work that needs another '
  + 'node output belongs to the next round, and work that must happen in order belongs inside one node. '

  + '"worker" starts with this conversation and does the work itself, never drawing a plan; "spawner" '
  + 'starts empty and plans; "forker" starts with this conversation and plans.'

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
export const DELEGATE_IN_GRAPH = 'Delegation happens inside the plan: add a "worker", "spawner" or "forker" node'
  + ' to refine_plan and the child runs as part of this turn, under the plan budget. A direct delegation'
  + ' call would run outside the plan.'

/** The tools the harness ships for delegating directly. */
export const DELEGATION_TOOLS = ['subagent', 'subagent_fork'] as const

/**
 * Tools the model inside a refine-loop turn is never shown.
 *
 * A plan node is synchronous: there is no background child to list, message or
 * interrupt, so a model that reaches for these only loses steps to waiting. They
 * are hidden rather than refused, so the model never reads a description for a
 * tool it cannot use.
 */
export const HIDDEN_TOOLS: readonly string[] = [
  'list_agents',
  'send_message',
  'interrupt_agent',
]

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
export function applyTurnDoctrine(ctx: Context, workers?: Workers): void {
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision

    // A worker is a child that does the work itself: it is not handed the
    // doctrine that tells a conversation to draw a plan. The plan tool stays in
    // its table on purpose — taking it away would change the request header and
    // the inherited prefix would stop matching the parent's cache, which is the
    // whole point of inheriting. The tool is refused where it is called; see
    // {@link applyWorkerRule}.
    if (workers?.has(payload.agent.session.id) === true || isWorkerConversation(payload.messages)) {
      return decision
    }

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
 * The conversations that belong to workers.
 *
 * A worker is a child that was started without the plan tool and must be left
 * alone by the loop: it inherits this conversation, it does the work itself,
 * and no round of it is a plan. The plugin is the one that starts it, so it
 * knows the session id and does not have to recognise the conversation from
 * its messages.
 */
export class Workers {
  /** The worker conversations. */
  readonly #sessions = new Set<string>()

  /**
   * Record one worker conversation.
   *
   * @param sessionId - the child's session.
   */
  mark(sessionId: string): void {
    this.#sessions.add(sessionId)
  }

  /**
   * Whether a conversation is a worker's.
   *
   * @param sessionId - the conversation.
   * @returns true when it is a worker's.
   */
  has(sessionId: string): boolean {
    return this.#sessions.has(sessionId)
  }
}

/**
 * Whether a turn belongs to a worker.
 *
 * The plugin's own worker prompt opens with {@link WORKER_MARKER}; the child's
 * first user message carries it. Reading the marker off the messages is what
 * lets the plugin keep the turn doctrine, and the plan tool, away from a
 * conversation that was asked to work rather than to plan.
 *
 * @param messages - the conversation's user messages.
 * @returns true when the conversation is a worker.
 */
export function isWorkerConversation(messages: readonly { content?: unknown }[]): boolean {
  for (const message of messages) {
    const content = message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const text = (block ?? {}) as { type?: unknown, text?: unknown }
      if (text.type === 'text' && typeof text.text === 'string' && text.text.startsWith(WORKER_MARKER)) {
        return true
      }
    }
  }
  return false
}

/**
 * What a worker is told when it reaches for the plan tool.
 *
 * The tool stays in the worker's table because its request header has to match
 * the parent's for the inherited prefix to hit the cache; what changes is the
 * answer when the worker tries to use it.
 */
export const WORKER_NO_PLAN = 'You are a worker: this conversation inherits the plan you are part of, and your '
  + 'job is to do the work yourself and report what you found. Do not draw a plan of your own — use the tools '
  + 'and answer.'

/**
 * Refuse the plan tool inside a worker conversation.
 *
 * A worker inherits the conversation that started it and does the work itself.
 * Its turn is not a plan, so the tool it could use to draw one is answered with
 * the rule instead of being removed from the table: removing it would change
 * the tool list, the tool list is part of the request header, and the inherited
 * prefix would stop matching the parent's cache.
 *
 * @param ctx - the plugin context supplying the tool registry.
 * @param workers - the worker conversations.
 */
export function applyWorkerRule(ctx: Context, workers: Workers): void {
  ctx.tools.guard((execution) => {
    const agent = execution.agent
    if (agent === undefined) return undefined
    if (!isModelCall(execution)) return undefined
    if (execution.name !== PLAN_TOOL) return undefined
    if (!workers.has(agent.session.id)) return undefined
    return WORKER_NO_PLAN
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
    agent.ctx.tools.restrict({ deny: HIDDEN_TOOLS })
    for (const name of DELEGATION_TOOLS) {
      const original = ctx.tools.get(name)
      if (original === undefined) continue
      agent.ctx.tools.register({
        ...original,
        // The harness's own wording describes its direct-call tool: a child that
        // starts from the completed turns only. A plan node is not that: its
        // child starts from this conversation as it stands, the round it was
        // handed over in included. The model reads this description every turn,
        // so leaving the harness's wording there is what makes it assume a node
        // cannot see what this round has already read.
        description: `Not called directly: delegation happens inside refine_plan, as a node of kind "worker" `
          + '(does the work itself), "spawner" (starts empty and plans) or "forker" (starts with this '
          + 'conversation and plans). The child of a plan node starts from this conversation as it stands when the '
          + 'plan is handed over, including what this round has already read.',
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
 * The turn after a plan is the judgement, so the only ways on are the conclusion
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

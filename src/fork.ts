/**
 * Forked children: children that inherit this conversation, including the round
 * that is still running.
 *
 * The harness ships two delegation tools. Its `subagent_fork` seeds the child
 * with the parent's *completed* turns only — a plan node runs inside the turn
 * that is still in flight, so from inside a plan that tool has nothing to
 * inherit and degrades to a plain spawn. The seed construction below is the
 * same one the harness uses for session forks (`buildForkSeed`), but the
 * boundary is the conversation as it stands right now: the plan call included.
 *
 * The open tail is closed the way the harness closes it: unanswered tool calls
 * get synthetic error results, an open step ends, the open turn ends. The
 * transcript the child starts with is therefore balanced and readable.
 *
 * @module @zyn19940107/dsh-conductor/fork
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** One recorded session event, as much of it as this module reads. */
export interface SessionEventLike {
  /** The event type. */
  type: string
  /** The event's position in the log. */
  seq: number
  /** When the event was recorded. */
  time: number
  /** The event's payload. */
  data: Record<string, unknown>
  /** Set on a surface-eligible event, such as a synthetic tool result. */
  surfaceOp?: 'append'
}

/** The two reasons a tail is closed. */
type CloserCause = 'interrupted' | 'forked'

/** What the synthetic tool results say. */
const CLOSER_TEXT: Record<CloserCause, { started: string, notStarted: string }> = {
  interrupted: {
    started: 'The tool call was interrupted after it was recorded, but no result was durably recorded. '
      + 'Its outcome is unknown. Retry only if the operation is read-only or idempotent.',
    notStarted: 'The tool call was interrupted before it was recorded as started. Retry it if it is still needed.',
  },
  forked: {
    started: 'The history inherited by this branch records this tool call starting but does not include its '
      + 'result. The parent may have completed it after the fork point. Retry only if the operation is '
      + 'read-only or idempotent.',
    notStarted: 'The history inherited by this branch has no record of this tool call starting. The parent may '
      + 'have executed it after the fork point. Retry only if the operation is read-only or idempotent.',
  },
}

/** Recovery codes the synthetic tool results carry. */
const TOOL_NOT_STARTED = 'TOOL_NOT_STARTED'
const TOOL_OUTCOME_UNKNOWN = 'TOOL_OUTCOME_UNKNOWN'

/** One pending tool call seen in the log. */
interface PendingCall {
  /** The call's turn. */
  turn: number
  /** The call's step. */
  step: number
  /** The seq of the recorded call start, when there is one. */
  callSeq: number | undefined
}

/**
 * Track unanswered tool calls in one log.
 */
class ToolCallRecovery {
  /** The cause that decides the wording. */
  readonly #cause: CloserCause

  /** Calls whose result is missing. */
  readonly #pending = new Map<string, PendingCall>()

  /** The last event seen. */
  #last: { seq: number, time: number } | undefined

  /**
   * @param cause - the wording to use.
   */
  constructor(cause: CloserCause) {
    this.#cause = cause
  }

  /** Consume one event. */
  observe(event: SessionEventLike): void {
    this.#last = { seq: event.seq, time: event.time }
    const data = event.data
    switch (event.type) {
      case 'assistant/message': {
        const message = data.message as { content?: Array<{ type?: string, id?: string, toolCallId?: string }> } | undefined
        for (const block of message?.content ?? []) {
          if (block.type !== 'tool-call' || typeof block.id !== 'string') continue
          this.#pending.set(block.id, {
            turn: Number(data.turn ?? 0),
            step: Number(data.step ?? 0),
            callSeq: undefined,
          })
        }
        break
      }
      case 'tool/call': {
        const callId = data.callId
        if (typeof callId === 'string') {
          this.#pending.set(callId, {
            turn: Number(data.turn ?? 0),
            step: Number(data.step ?? 0),
            callSeq: event.seq,
          })
        }
        break
      }
      case 'tool/result': {
        const message = data.message as { toolCallId?: string } | undefined
        if (typeof message?.toolCallId === 'string') this.#pending.delete(message.toolCallId)
        break
      }
      case 'step/end':
      case 'turn/end':
        this.#pending.clear()
        break
      default:
        break
    }
  }

  /**
   * The synthetic results for the calls that never got one.
   *
   * @returns the events.
   */
  results(): SessionEventLike[] {
    if (this.#last === undefined) return []
    let seq = this.#last.seq + 1
    const time = this.#last.time
    const text = CLOSER_TEXT[this.#cause]
    const results: SessionEventLike[] = []
    for (const [callId, call] of this.#pending) {
      const started = call.callSeq !== undefined
      const message = {
        id: `${this.#cause}-tool-result-${callId}-${seq}`,
        role: 'tool',
        toolCallId: callId,
        isError: true,
        source: { kind: 'tool', callId },
        content: [{ type: 'text', text: started ? text.started : text.notStarted }],
      }
      results.push({
        type: 'tool/result',
        seq: seq,
        time,
        surfaceOp: 'append',
        data: {
          turn: call.turn,
          step: call.step,
          message,
          error: started
            ? { name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN }
            : { name: 'ToolNotStartedError', code: TOOL_NOT_STARTED },
          ...(started ? { sourceEventSeqs: [call.callSeq] } : {}),
        },
      })
      seq += 1
    }
    return results
  }
}

/**
 * Close the open tail of a log, the way the harness closes it for a fork.
 *
 * @param events - the log, possibly ending inside an open turn.
 * @param cause - the wording and turn-ending reason.
 * @returns the synthetic closer events; empty when the log is already balanced.
 */
export function openTurnClosers(events: readonly SessionEventLike[], cause: CloserCause): SessionEventLike[] {
  let openTurn: number | null = null
  let openStep: number | null = null
  const recovery = new ToolCallRecovery(cause)
  for (const event of events) {
    recovery.observe(event)
    const data = event.data
    switch (event.type) {
      case 'turn/start':
        openTurn = Number(data.turn ?? 0)
        openStep = null
        break
      case 'turn/end':
        openTurn = null
        openStep = null
        break
      case 'step/start':
        openStep = Number(data.step ?? 0)
        break
      case 'step/end':
        openStep = null
        break
      default:
        break
    }
  }
  const last = events.at(-1)
  if (openTurn === null || last === undefined) return []
  const closers = recovery.results()
  let seq = last.seq + closers.length + 1
  const time = last.time
  if (openStep !== null) {
    closers.push({ type: 'step/end', seq: seq, time, data: { turn: openTurn, step: openStep } })
    seq += 1
  }
  closers.push({ type: 'turn/end', seq: seq, time, data: { turn: openTurn, reason: { kind: cause } } })
  return closers
}

/**
 * The seed a child inherits: this conversation as it stands, this round included.
 *
 * The prefix is every recorded event, marked at the cut with the inherited
 * marker and balanced by the fork closers — exactly the shape the harness's own
 * `buildForkSeed` produces, with the boundary at the end of the log instead of
 * the end of the last completed turn.
 *
 * @param events - the parent's events.
 * @returns the seed events; empty when there is nothing to inherit.
 */
export function buildSeedFromNow(events: readonly SessionEventLike[]): SessionEventLike[] {
  const last = events.at(-1)
  if (last === undefined) return []
  const prefix: SessionEventLike[] = [...events]
  prefix.push({
    type: 'session/end-seed',
    seq: last.seq + 1,
    time: last.time,
    data: { inherited: true },
  })
  return prefix.concat(openTurnClosers(prefix, 'forked'))
}

/** What one spawned child produced. */
export interface SpawnResult {
  /** The child's final text. */
  output: string
  /** Why the child produced nothing, when it did not. */
  error: string | undefined
}

/** What the plugin needs from the runtime to start a child. */
export interface SpawnRuntime {
  /** The host context, for the agent factory. */
  readonly host: Record<string, unknown>
}

/**
 * The last assistant text in a log.
 *
 * @param events - the log.
 * @returns the text, or an empty string.
 */
function lastAssistantText(events: readonly SessionEventLike[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'assistant/message') continue
    const message = event.data.message as { content?: Array<{ type?: string, text?: string }> } | undefined
    const text = (message?.content ?? [])
      .filter((block): block is { type: 'text', text: string } => block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('')
    if (text.trim() !== '') return text
  }
  return ''
}

/** How long a child gets to look at its state after its budget is spent. */
const STATUS_WINDOW_MS = 45_000

/**
 * What the child is told when its budget runs out.
 *
 * It is not told to stop and it is not told to keep going. It is told the one
 * thing only it can weigh — how much work is left against how much time is left
 * — and what the two outcomes would be. Asked to "look at the status" without
 * those numbers it can only guess, and guessing is what the budget exists to
 * stop.
 *
 * @param budgetMs - the budget the node declared, now spent.
 * @param extensionMs - how much time this second look may take.
 * @returns the message.
 */
function statusPrompt(budgetMs: number, extensionMs: number): string {
  const spent = Math.round(budgetMs / 1000)
  const left = Math.round(extensionMs / 1000)
  return `Your node's time budget of ${spent} seconds is spent, and the work in flight was just stopped. `
    + `You now have at most ${left} seconds more. It is a window to finish or to report, not to start `
    + 'anything new.'
    + String.fromCharCode(10) + String.fromCharCode(10)
    + 'Decide from what you can actually see:'
    + String.fromCharCode(10)
    + `- If the remaining work needs longer than ${left} seconds, stop now. Report what already exists and `
    + 'where, what is done and confirmed, and what is still missing.'
    + String.fromCharCode(10)
    + `- If the remaining work fits inside ${left} seconds, finish it by the shortest path and report the `
    + 'result — artifact, command output, and the conclusion.'
    + String.fromCharCode(10)
    + String.fromCharCode(10)
    + `When the window ends the node is stopped again, whether or not you answered, so start nothing you `
    + 'cannot finish inside it. The parent only sees what you report: a clear status with wrong-looking '
    + 'numbers beats an unfinished attempt.'
}

/**
 * Wait for the child to go idle, its window, or the plan's cancellation.
 *
 * @param child - the child to wait for.
 * @param ms - how long to wait.
 * @param signal - the plan's cancellation signal.
 * @returns which of the three happened.
 */
async function waitForIdle(
  child: Agent,
  ms: number,
  signal: AbortSignal,
): Promise<'idle' | 'timeout' | 'cancelled'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      child.whenIdle().then((): 'idle' => 'idle'),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), ms)
        ;(timer as { unref?: () => void }).unref?.()
      }),
      new Promise<'cancelled'>((resolve) => {
        signal.addEventListener('abort', () => resolve('cancelled'), { once: true })
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * The child's latest text, whether or not its turn finished.
 *
 * @param child - the child to read.
 * @returns the text, or an empty string.
 */
function snapshotText(child: Agent): string {
  const events = (child.session as unknown as { snapshotEvents: () => SessionEventLike[] }).snapshotEvents()
  return lastAssistantText(events)
}

/**
 * Start a child seeded with this conversation and wait for its answer.
 *
 * @param host - the host context carrying the agent factory.
 * @param parent - the conversation the child inherits.
 * @param prompt - what the child is asked to do.
 * @param options - whether the child may plan, and the budget.
 * @returns what the child produced.
 */
export async function spawnForkedChild(
  host: Record<string, unknown>,
  parent: Agent,
  prompt: string,
  options: {
    /** The ceiling: the child never runs longer than this. */
    timeoutMs: number
    /**
     * What the node itself said it would take.
     *
     * It is not a kill switch. When it is spent the child is stopped and then
     * asked to look at where it got to and decide: finish by the shortest path,
     * or report its state and stop. The ceiling still bounds the whole thing.
     */
    budgetMs?: number
    /** The signal that cancels the child. */
    signal: AbortSignal
    /** Told the child's session id as soon as the child exists. */
    onCreated?: (sessionId: string) => void
  },
): Promise<SpawnResult> {
  return await spawnChild(host, parent, prompt, options, true)
}

/**
 * Start a child that begins empty and plans through this loop.
 *
 * A spawner has nothing to inherit, so it starts the same way a forked child
 * does: by this plugin, through the agent factory, rather than through the
 * harness's delegation tool. The reason to do it here is the handle — with it
 * the node's budget can stop the child and ask it for its state, which the
 * harness tool never exposes.
 *
 * @param host - the host context carrying the agent factory.
 * @param parent - the conversation the node belongs to.
 * @param prompt - what the child is asked to do.
 * @param options - the ceiling and the node's own budget.
 * @returns what the child produced.
 */
export async function spawnEmptyChild(
  host: Record<string, unknown>,
  parent: Agent,
  prompt: string,
  options: {
    /** The ceiling: the child never runs longer than this. */
    timeoutMs: number
    /** What the node itself said it would take. */
    budgetMs?: number
    /** The signal that cancels the child. */
    signal: AbortSignal
  },
): Promise<SpawnResult> {
  return await spawnChild(host, parent, prompt, options, false)
}

/**
 * The shared spawn: seeded or empty, with the budget handled the same way.
 *
 * @param host - the host context carrying the agent factory.
 * @param parent - the conversation the node belongs to.
 * @param prompt - what the child is asked to do.
 * @param options - the ceiling, the node's own budget and the cancellation.
 * @param seeded - whether the child inherits this conversation.
 * @returns what the child produced.
 */
async function spawnChild(
  host: Record<string, unknown>,
  parent: Agent,
  prompt: string,
  options: {
    /** The ceiling: the child never runs longer than this. */
    timeoutMs: number
    /**
     * What the node itself said it would take.
     *
     * It is not a kill switch. When it is spent the child is stopped and then
     * asked to look at where it got to and decide: finish by the shortest path,
     * or report its state and stop. The ceiling still bounds the whole thing.
     */
    budgetMs?: number
    /** The signal that cancels the child. */
    signal: AbortSignal
    /** Told the child's session id as soon as the child exists. */
    onCreated?: (sessionId: string) => void
  },
  seeded: boolean,
): Promise<SpawnResult> {
  const agentLoop = host['agentLoop'] as
    | { createAgent: (owner: unknown, options: Record<string, unknown>) => Promise<ChildHandle> }
    | undefined
  if (agentLoop === undefined) return { output: '', error: 'the host has no agent factory' }

  const session = parent.session as unknown as {
    id: string
    header: Record<string, unknown>
    snapshotEvents: () => SessionEventLike[]
  }
  const seed = seeded ? buildSeedFromNow(session.snapshotEvents()) : []
  const depth = Number(session.header.delegationDepth ?? 0) + 1

  const sessionId = `refine-loop-child-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  // Register before the child exists, not after: the child may speak before
  // createAgent resolves, and a worker's very first call must already hit the
  // rule that refuses the plan tool. Registering afterwards let each worker's
  // first plan through — 285 of 285 in the benchmark did exactly that.
  options.onCreated?.(sessionId)

  let handle: ChildHandle
  try {
    handle = await agentLoop.createAgent(parent.ctx, {
      sessionId,
      parentAgent: parent,
      meta: {
        cwd: session.header.cwd,
        parentSession: session.id,
        isSeeded: seed.length > 0,
        origin: 'subagent',
        delegationDepth: depth,
      },
      ...(seed.length > 0 ? { seed, inheritedEventCount: seed.length } : {}),
      // No tool restriction: the child's request header must match the parent's
      // for the inherited prefix to hit the cache. A worker that must not plan
      // is refused where it calls the plan tool instead (see applyWorkerRule).
      ...(parent.options === undefined ? {} : { agentOptions: parent.options }),
    })
  } catch (error: unknown) {
    return { output: '', error: error instanceof Error ? error.message : String(error) }
  }

  const child = handle.agent
  const budget = options.budgetMs !== undefined && options.budgetMs > 0
    ? Math.min(options.budgetMs, options.timeoutMs)
    : options.timeoutMs
  const extension = Math.min(Math.max(STATUS_WINDOW_MS, Math.round(budget / 4)), options.timeoutMs)
  try {
    child.followup(createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    }))
    const first = await waitForIdle(child, budget, options.signal)
    if (first !== 'timeout') {
      const output = snapshotText(child)
      return {
        output,
        error: first === 'cancelled'
          ? 'the plan was cancelled'
          : (output.trim() === '' ? 'the child produced no answer' : undefined),
      }
    }
    // The budget is spent. Stop what is running — the in-flight tool included —
    // and hand the decision back to the child: it knows what it has, the parent
    // does not. It finishes by the shortest path or reports its state, and the
    // extension is what bounds that second look.
    child.cancel({ kind: 'hook', reason: 'the node used its time budget' })
    child.followup(createUserMessage({
      content: [{ type: 'text', text: statusPrompt(budget, extension) }],
      source: { kind: 'user' },
    }))
    const second = await waitForIdle(child, extension, options.signal)
    const output = snapshotText(child)
    if (second === 'cancelled') return { output, error: 'the plan was cancelled' }
    if (output.trim() === '') {
      return { output, error: `the child used its ${budget}ms budget and produced no answer` }
    }
    return {
      output,
      error: second === 'idle' ? undefined : `the child used its ${budget}ms budget; this is where it got to`,
    }
  } catch (error: unknown) {
    return { output: snapshotText(child), error: error instanceof Error ? error.message : String(error) }
  } finally {
    try {
      await handle.dispose()
    } catch {
      // The child is already gone; there is nothing left to release.
    }
  }
}

/** The handle the agent factory returns, as much of it as this module reads. */
interface ChildHandle {
  /** The child. */
  agent: Agent
  /** Release the child. */
  dispose: () => Promise<void> | void
}

/**
 * The round budget and the turn doctrine.
 *
 * One request gets a fixed number of rounds, a new request gets its own, and a
 * worker conversation is not told to draw a plan at all.
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  Rounds,
  NEXT_ROUND,
  ROUND_LOOP,
  WORKER_NO_PLAN,
  REPORT_ONLY,
  Workers,
  applyReportGuard,
  applyTurnDoctrine,
  applyWorkerRule,
  formatClock,
  startOf,
  isWorkerConversation,
} from '../src/rounds.ts'
import { WORKER_MARKER } from '../src/plan.ts'
import { Reporters } from '../src/fork.ts'

let failures = 0

/**
 * Record one check.
 *
 * @param what - what the check asserts.
 * @param ok - whether it held.
 */
function check(what: string, ok: boolean): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failures += 1
}

/**
 * Capture the doctrine's pre-step handler from a fake context.
 *
 * @returns the handler.
 */
function captureDoctrine(
  nodeLimit?: () => number,
): (payload: unknown, next: () => Promise<unknown>) => Promise<{ messages: unknown[] }> {
  let handler: ((payload: unknown, next: () => Promise<unknown>) => Promise<{ messages: unknown[] }>) | undefined
  const ctx = {
    on: (event: string, registered: typeof handler) => {
      if (event === 'agent/pre-step') handler = registered
    },
  } as unknown as Context
  applyTurnDoctrine(ctx, undefined, nodeLimit)
  if (handler === undefined) throw new Error('the doctrine registered no pre-step hook')
  return handler
}

/**
 * A pre-step payload whose first user message carries the given text.
 *
 * @param text - the message.
 * @param restricted - collects the tools the worker loses.
 * @returns the payload.
 */
function payload(text: string, restricted: string[]) {
  return {
    agent: {
      session: { id: 'session-doctrine', createdAt: Date.now() },
      ctx: {
        tools: {
          restrict: (filter: { deny?: readonly string[] }) => {
            restricted.push(...(filter.deny ?? []))
            return () => {}
          },
        },
      },
    },
    messages: [{ content: [{ type: 'text', text }] }],
    step: 1,
  }
}

const enter = async () => ({ kind: 'enter', messages: [] })

console.log('the round budget')
{
  const rounds = new Rounds()
  check('a fresh conversation has spent none', rounds.used('s1') === 0)
  check('the first round counts as one', rounds.bump('s1') === 1)
  check('the second round counts as two', rounds.bump('s1') === 2)
  check('another conversation is unaffected', rounds.used('s2') === 0)
  rounds.reset('s1')
  check('a reset forgets the rounds', rounds.used('s1') === 0)
}

console.log('what the next round is told')
{
  check('it says the results are above', NEXT_ROUND.includes('every result is above'))
  check('it offers the plan as one way on', NEXT_ROUND.includes('refine_plan'))
  check('it offers the conclusion as the other', NEXT_ROUND.includes('conclusion'))
  check('it says the conclusion ends the loop', NEXT_ROUND.includes('ends the loop'))
}

console.log('what the turn doctrine says')
{
  check('it says the round is one plan', ROUND_LOOP.includes('refine_plan'))
  check('it says the plan is one layer', ROUND_LOOP.includes('one layer'))
  check('it says there is no dependency between nodes', ROUND_LOOP.includes('no dependency'))
  // The four kinds are defined in the policy section, not again here: a round
  // message repeats every round, so a definition living in it drifts once and
  // then repeats the drift.
  check('the doctrine leaves the kinds to the policy',
    ROUND_LOOP.includes('is a leaf') === false
    && ROUND_LOOP.includes('"forker" is a leader') === false)
}

console.log('a worker conversation is recognised')
{
  const user = (text: string) => ({ content: [{ type: 'text', text }] })
  check('a marked prompt is a worker', isWorkerConversation([user(`${WORKER_MARKER} do the work`)]))
  check('an unmarked prompt is not', !isWorkerConversation([user('do the work')]))
  check('a marker inside a sentence does not count', !isWorkerConversation([
    user('hello'),
    { content: [{ type: 'text', text: `note: ${WORKER_MARKER}` }] },
  ]))
  check('a marker opening a later message counts', isWorkerConversation([
    user('hello'),
    { content: [{ type: 'text', text: `${WORKER_MARKER} do the work` }] },
  ]))
  check('a message without content is ignored', !isWorkerConversation([{}, { content: [] }]))
}

console.log('the doctrine hook skips the worker, and the plan tool stays in its table')
{
  const handler = captureDoctrine()

  const workerRestricted: string[] = []
  const workerDecision = await handler(payload(`${WORKER_MARKER} do the work`, workerRestricted), enter)
  check('a worker is not given the doctrine', workerDecision.messages.length === 0)
  // The tool stays, because the request header has to match the parent's for
  // the inherited prefix to hit the cache; the rule refuses it at call time.
  check('a worker keeps the plan tool in its table', workerRestricted.length === 0)

  const normalRestricted: string[] = []
  const normalDecision = await handler(payload('please do the thing', normalRestricted), enter)
  const normalText = normalDecision.messages
    .map(message => (message as { content?: Array<{ text?: string }> }).content?.map(part => part.text ?? '').join('') ?? '')
    .join(' ')
  check('a normal turn is given the doctrine', normalText.includes(ROUND_LOOP))
  check('the first round also says when the conversation started',
    normalText.includes('This conversation started at'))
  check('a normal turn keeps the plan tool', normalRestricted.length === 0)

  // The start is a fact about the conversation, said once: the next round must
  // not repeat it.
  const secondDecision = await handler(payload('next round', []), enter)
  const secondText = secondDecision.messages
    .map(message => (message as { content?: Array<{ text?: string }> }).content?.map(part => part.text ?? '').join('') ?? '')
    .join(' ')
  check('the next round gets the doctrine but not the start again',
    secondText.includes(ROUND_LOOP) && secondText.includes('started at') === false)

  // The plan tool refuses a plan with more nodes than its limit. The model used
  // to learn that by having a whole round's plan refused, then spend a round
  // working out how to fit; the limit belongs in the message that asks for the
  // plan.
  const limited = captureDoctrine(() => 8)
  const limitedDecision = await limited(payload('draw me a plan', []), enter)
  const limitedText = limitedDecision.messages
    .map(message => (message as { content?: Array<{ text?: string }> }).content?.map(part => part.text ?? '').join('') ?? '')
    .join(' ')
  check('the round message states the plan node limit',
    limitedText.includes('at most 8 nodes') && limitedText.includes('refused'))

  const unlimited = captureDoctrine(() => 0)
  const unlimitedDecision = await unlimited(payload('draw me a plan', []), enter)
  const unlimitedText = unlimitedDecision.messages
    .map(message => (message as { content?: Array<{ text?: string }> }).content?.map(part => part.text ?? '').join('') ?? '')
    .join(' ')
  check('with no limit configured nothing is claimed', unlimitedText.includes('at most') === false)
}

console.log('the report guard refuses every tool while the report is written')
{
  const reporters = new Reporters()
  reporters.mark('session-reporting')
  let guard: ((execution: unknown) => string | undefined) | undefined
  const ctx = {
    tools: { guard: (registered: typeof guard) => { guard = registered } },
  } as unknown as Context
  applyReportGuard(ctx, reporters)
  if (guard === undefined) throw new Error('the report guard registered nothing')

  const call = (name: string, sessionId: string) => ({
    name,
    agent: { session: { id: sessionId } },
    callId: 'root',
    rootCallId: 'root',
  })

  check('a tool call from a reporting conversation is refused',
    guard(call('read', 'session-reporting')) === REPORT_ONLY)
  check('a reporting conversation cannot plan either',
    guard(call('refine_plan', 'session-reporting')) === REPORT_ONLY)
  check('another conversation is untouched',
    guard(call('read', 'session-working')) === undefined)
  reporters.unmark('session-reporting')
  check('once the report is written the tools come back',
    guard(call('read', 'session-reporting')) === undefined)
}

console.log('the worker rule refuses the plan tool where it is called')
{
  const workers = new Workers()
  workers.mark('session-worker')
  let guard: ((execution: unknown) => string | undefined) | undefined
  const ctx = {
    tools: { guard: (registered: typeof guard) => { guard = registered } },
  } as unknown as Context
  applyWorkerRule(ctx, workers)
  if (guard === undefined) throw new Error('the worker rule registered no guard')

  const modelCall = (name: string, sessionId: string) => ({
    name,
    agent: { session: { id: sessionId } },
    callId: 'call-1',
    rootCallId: 'call-1',
  })
  check('the worker is refused the plan tool',
    guard(modelCall('refine_plan', 'session-worker')) === WORKER_NO_PLAN)
  check('the worker may call other tools',
    guard(modelCall('read', 'session-worker')) === undefined)
  check('another conversation is not touched',
    guard(modelCall('refine_plan', 'session-other')) === undefined)
  check('the refusal says not to plan', WORKER_NO_PLAN.includes('Do not draw a plan'))
}

// The plugin does not push a clock reading: the shell has a clock. What it does
// give once is when the conversation started, because that is the one number the
// model cannot read off the machine.
{
  const instant = new Date(2026, 10, 6, 20, 14, 3).getTime()
  check('the start comes from the session', startOf({ createdAt: instant }) === instant)
  check('a session with no start has none', startOf({}) === undefined)
  check('a bad start has none', startOf({ createdAt: 0 }) === undefined)
  const clock = formatClock(instant, new Date(instant))
  check('the start is rendered as a local date and time',
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(UTC[+-]\d{2}:\d{2}\)$/.test(clock))
  check('the rendered start names the same instant',
    new Date(clock.slice(0, 19).replace(' ', 'T')).getTime() === instant)
}

// The parent does not verify the children: the doctrine says so in its own
// sentence, not buried in the paragraph about trust.
{
  check('the round doctrine forbids checking a node',
    ROUND_LOOP.includes('Do not spend a node on checking another node'))
  check('the doctrine names the three disguises',
    ROUND_LOOP.includes('no review node')
    && ROUND_LOOP.includes('no independent re-derivation')
    && ROUND_LOOP.includes('no hardening pass'))
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')

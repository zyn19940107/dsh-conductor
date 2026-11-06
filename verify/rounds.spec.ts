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
  Workers,
  applyTurnDoctrine,
  applyWorkerRule,
  elapsedSince,
  formatElapsed,
  isWorkerConversation,
} from '../src/rounds.ts'
import { WORKER_MARKER } from '../src/plan.ts'

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
function captureDoctrine(): (payload: unknown, next: () => Promise<unknown>) => Promise<{ messages: unknown[] }> {
  let handler: ((payload: unknown, next: () => Promise<unknown>) => Promise<{ messages: unknown[] }>) | undefined
  const ctx = {
    on: (event: string, registered: typeof handler) => {
      if (event === 'agent/pre-step') handler = registered
    },
  } as unknown as Context
  applyTurnDoctrine(ctx)
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
  check('it names the worker', ROUND_LOOP.includes('worker'))
  check('it names the spawner', ROUND_LOOP.includes('spawner'))
  check('it names the forker', ROUND_LOOP.includes('forker'))
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
  check('a normal turn is given the doctrine', normalDecision.messages.length === 1)
  check('a normal turn keeps the plan tool', normalRestricted.length === 0)
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

// The model has no clock of its own: the elapsed time has to be handed to it,
// or a task that states a budget cannot be planned against.
{
  check('a duration under a minute is seconds', formatElapsed(45_000) === '45s')
  check('a duration over a minute is minutes and seconds', formatElapsed(750_000) === '12m 30s')
  check('the elapsed time comes from the session start',
    Math.abs((elapsedSince({ createdAt: Date.now() - 5_000 }) ?? 0) - 5_000) < 1_000)
  check('a session with no start time has no elapsed time', elapsedSince({}) === undefined)
  check('a bad start time has no elapsed time', elapsedSince({ createdAt: 0 }) === undefined)
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')

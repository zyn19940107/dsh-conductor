/**
 * The seed a forked child starts from.
 *
 * The harness's own fork seeds the parent's completed turns. A plan node runs
 * inside the turn that is still in flight, so the plugin builds the seed from
 * the log as it stands: the plan call included, the open tail closed the way
 * the harness closes it.
 */

import { buildSeedFromNow, openTurnClosers, type SessionEventLike } from '../src/fork.ts'

let failures = 0

/**
 * Assert one condition.
 *
 * @param name - what is being asserted.
 * @param condition - the condition that must hold.
 */
function check(name: string, condition: boolean): void {
  if (condition) {
    console.log(`  ok   ${name}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${name}`)
}

/**
 * A log with one completed turn and a second turn open.
 *
 * @returns the events.
 */
function openTurnLog(): SessionEventLike[] {
  const events: SessionEventLike[] = []
  let seq = 0
  const push = (type: string, data: Record<string, unknown>): void => {
    events.push({ type, seq, time: 1000 + seq, data })
    seq += 1
  }
  push('session', { cwd: '/tmp' })
  push('turn/start', { turn: 1 })
  push('step/start', { turn: 1, step: 1 })
  push('assistant/message', {
    turn: 1,
    step: 1,
    message: { role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'glob' }] },
  })
  push('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'glob', arguments: '{}' })
  push('tool/result', {
    turn: 1,
    step: 1,
    message: { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'ok' }] },
  })
  push('step/end', { turn: 1, step: 1 })
  push('turn/end', { turn: 1, reason: { kind: 'completed' } })
  push('turn/start', { turn: 2 })
  push('step/start', { turn: 2, step: 1 })
  push('assistant/message', {
    turn: 2,
    step: 1,
    message: { role: 'assistant', content: [{ type: 'tool-call', id: 'call-2', name: 'refine_plan' }] },
  })
  push('tool/call', { turn: 2, step: 1, callId: 'call-2', name: 'refine_plan', arguments: '{"nodes":[]}' })
  return events
}

console.log('an empty log seeds nothing')
{
  check('no events, no seed', buildSeedFromNow([]).length === 0)
}

console.log('a balanced log is inherited whole')
{
  const events = openTurnLog().slice(0, 8)
  const seed = buildSeedFromNow(events)
  check('every event is inherited', seed.length === events.length + 1)
  check('the inherited marker is last', seed[seed.length - 1]?.type === 'session/end-seed')
  check('the marker says inherited', (seed[seed.length - 1]?.data as { inherited?: boolean }).inherited === true)

  const closers = openTurnClosers(events, 'forked')
  check('a balanced log needs no closers', closers.length === 0)
}

console.log('the open turn is inherited and closed')
{
  const events = openTurnLog()
  const seed = buildSeedFromNow(events)
  check('the plan call is inside the seed', seed.some(event => event.type === 'tool/call'))
  check('the marker comes after the log', seed[events.length]?.type === 'session/end-seed')
  const closers = seed.slice(events.length + 1).map(event => event.type)
  check('a step closer is among them', closers.includes('step/end'))
  check('a turn closer ends the seed', seed[seed.length - 1]?.type === 'turn/end')
  const ending = seed[seed.length - 1]?.data as { reason?: { kind?: string } }
  check('the ending says forked', ending.reason?.kind === 'forked')
  check('the sequence stays contiguous',
    seed.every((event, index) => event.seq === index))
}

console.log('an unanswered tool call gets a synthetic result')
{
  const events = openTurnLog()
  // The plan call never got a result: it is the in-flight call.
  const seed = buildSeedFromNow(events)
  // The closed turn already has a real result; only the closers are synthetic.
  const marker = seed.findIndex(event => event.type === 'session/end-seed')
  const synthetic = seed.slice(marker + 1).filter(event => event.type === 'tool/result')
  check('one synthetic result', synthetic.length === 1)
  check('it is an error', (synthetic[0]?.data as { message?: { isError?: boolean } }).message?.isError === true)
  check('it carries the call id',
    (synthetic[0]?.data as { message?: { toolCallId?: string } }).message?.toolCallId === 'call-2')
  check('it is a surface-eligible event', synthetic[0]?.surfaceOp === 'append')
  const order = seed.map(event => event.type)
  check('the result comes before the step closer',
    order.indexOf('tool/result') < order.lastIndexOf('step/end'))
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')

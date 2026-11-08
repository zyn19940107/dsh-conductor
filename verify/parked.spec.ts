/**
 * Nodes that ran out of budget but are not done.
 *
 * A parked node keeps its conversation and its work; the parent continues it by
 * using the same node id in the next plan, and ends it by leaving the id out. The
 * turn is the outer bound.
 */

import { Parked, type ParkedNode } from '../src/parked.ts'

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
 * A parked node whose continuation is scripted.
 *
 * @param nodeId - the id it is parked under.
 * @param parkedAgain - whether the next continuation runs out of budget again.
 * @returns the node and the calls it recorded.
 */
function fakeParked(nodeId: string, parkedAgain = false): {
  node: ParkedNode
  calls: Array<{ prompt: string, budgetMs: number | undefined, timeoutMs: number }>
  disposed: () => number
} {
  const calls: Array<{ prompt: string, budgetMs: number | undefined, timeoutMs: number }> = []
  let disposed = 0
  return {
    calls,
    disposed: () => disposed,
    node: {
      nodeId,
      sessionId: `session-${nodeId}`,
      report: `report from ${nodeId}`,
      async continue(prompt, budgetMs, timeoutMs) {
        calls.push({ prompt, budgetMs, timeoutMs })
        return { output: `continued ${nodeId}`, parked: parkedAgain }
      },
      async dispose() {
        disposed += 1
      },
    },
  }
}

console.log('a parked node is continued when the next plan asks for its id')
{
  const parked = new Parked()
  const fake = fakeParked('solver')
  parked.park('session-root', fake.node)
  check('it is listed under the conversation that parked it', parked.list('session-root').includes('solver'))
  check('another conversation sees nothing', parked.list('session-other').length === 0)

  const outcome = await parked.resume('session-root', 'solver', 'keep going', 60_000, 540_000, new AbortController().signal)
  check('the continuation ran', outcome?.output === 'continued solver')
  check('it got the new prompt', fake.calls[0]?.prompt === 'keep going')
  check('it got the new budget', fake.calls[0]?.budgetMs === 60_000)
  check('it did not run out again, so it is gone from the registry', parked.list('session-root').length === 0)
}

console.log('a continuation that runs out again is parked again')
{
  const parked = new Parked()
  parked.park('session-root', fakeParked('solver', true).node)
  const outcome = await parked.resume('session-root', 'solver', 'again', 10_000, 540_000, new AbortController().signal)
  check('the outcome says it is parked again', outcome?.parked === true)
  check('it is back in the registry under the same id', parked.list('session-root').includes('solver'))
}

console.log("the plan decides: an id it leaves out is ended")
{
  const parked = new Parked()
  const kept = fakeParked('solver')
  const dropped = fakeParked('stale')
  parked.park('session-root', kept.node)
  parked.park('session-root', dropped.node)
  const ended = await parked.retain('session-root', new Set(['solver']))
  check('the id the plan left out is ended', ended.includes('stale'))
  check('the one it kept is still parked', parked.list('session-root').includes('solver'))
  check('the kept node was not disposed', kept.disposed() === 0)
  check('the dropped node was disposed', dropped.disposed() === 1)
  await parked.disposeAll('session-root')
  check('the turn end ends the rest', kept.disposed() === 1 && parked.list('session-root').length === 0)
}

console.log('resuming an id that is not parked does nothing')
{
  const parked = new Parked()
  const outcome = await parked.resume('session-root', 'never-parked', 'x', undefined, 540_000, new AbortController().signal)
  check('it reports no parked node', outcome === undefined)
}

if (failures > 0) {
  console.log(`${failures} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('all checks passed')
}
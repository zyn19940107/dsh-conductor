/**
 * The round budget: one request gets a fixed number of rounds, and a new request
 * gets its own.
 */

import { Rounds, NEXT_ROUND } from '../src/rounds.ts'

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

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')

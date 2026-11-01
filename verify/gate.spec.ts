/**
 * The rule that keeps the agent's tool calls inside a plan.
 *
 * The agent does not call tools itself. Every call it makes goes inside a
 * plan. What it does after a plan has run is its own business.
 */

import { PlanGate, PLAN_REQUIRED, planRefusal } from '../src/gate.js'

let failures = 0

/**
 * Check one expectation.
 *
 * @param what - what is being checked.
 * @param ok - whether it holds.
 */
function check(what: string, ok: boolean): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failures += 1
}

console.log('a tool the agent calls itself is pulled back')
{
  const gate = new PlanGate()
  check('a direct call is refused',
    planRefusal('glob', 's1', gate, () => true, true, 2, 16) === PLAN_REQUIRED)
  check('the refusal says the call goes inside a plan',
    (planRefusal('glob', 's1', gate, () => true, true, 2, 16) ?? '').includes('inside a plan'))
  const fresh = new PlanGate()
  check('the refusal offers the conclusion as the other way out',
    (planRefusal('glob', 's1b', fresh, () => true, true, 2, 16) ?? '').includes('conclusion'))
}

console.log('the plan is how the work is handed over')
{
  const gate = new PlanGate()
  check('the plan is never refused',
    planRefusal('refine_plan', 's1', gate, () => true, true, 2, 16) === undefined)
}

console.log('the rule is a pullback, not a cage')
{
  const gate = new PlanGate()
  check('the first direct call is refused',
    planRefusal('glob', 's1', gate, () => true, true, 2, 16) === PLAN_REQUIRED)
  check('the second direct call is refused',
    planRefusal('glob', 's1', gate, () => true, true, 2, 16) === PLAN_REQUIRED)
  check('after the pullbacks run out the agent is left alone',
    planRefusal('glob', 's1', gate, () => true, true, 2, 16) === undefined)
}

console.log('a conversation that opted out is left alone')
{
  const gate = new PlanGate()
  check('nothing is refused for a conversation that opted out',
    planRefusal('glob', 's7', gate, () => false, true, 2, 16) === undefined)
}

console.log('the rule can be turned off')
{
  const gate = new PlanGate()
  check('nothing is refused when the rule is off',
    planRefusal('glob', 's2', gate, () => true, false, 2, 16) === undefined)
}

console.log('a new turn starts from scratch')
{
  const gate = new PlanGate()
  planRefusal('glob', 's3', gate, () => true, true, 2, 16)
  planRefusal('glob', 's3', gate, () => true, true, 2, 16)
  gate.reset('s3')
  check('after a reset the first call of the new turn is refused again',
    planRefusal('glob', 's3', gate, () => true, true, 2, 16) === PLAN_REQUIRED)
}

if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')

/**
 * The rule that makes a turn open with a plan.
 */

import { PlanGate, planRefusal, PLAN_REQUIRED } from '../src/gate.js'

let failures = 0

/**
 * Assert one condition.
 *
 * @param name - what is being asserted.
 * @param condition - the condition that must hold.
 * @param detail - what to print when it does not.
 */
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ok   ${name}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

console.log('a turn has to open with a plan')
{
  const gate = new PlanGate()
  check('a direct call before a plan is refused',
    planRefusal('glob', 's1', 0, gate, true, 2) === PLAN_REQUIRED)
  check('the plan itself is never refused',
    planRefusal('refine_plan', 's1', 0, gate, true, 2) === undefined)
  check('a refused call says what to do',
    (planRefusal('glob', 's1', 0, gate, true, 2) ?? '').includes('refine_plan'))
}

console.log('after the plan, anything may run')
{
  const gate = new PlanGate()
  gate.markPlanned('s1')
  check('a direct call after the plan is allowed',
    planRefusal('glob', 's1', 0, gate, true, 2) === undefined)
  check('the plan tool is still allowed',
    planRefusal('refine_plan', 's1', 0, gate, true, 2) === undefined)
}

console.log('a child agent is never held to the rule')
{
  const gate = new PlanGate()
  check('a child may call anything',
    planRefusal('glob', 's2', 1, gate, true, 2) === undefined)
}

console.log('the rule gives up rather than trap the agent')
{
  const gate = new PlanGate()
  planRefusal('glob', 's3', 0, gate, true, 2)
  planRefusal('glob', 's3', 0, gate, true, 2)
  check('the third attempt is allowed through',
    planRefusal('glob', 's3', 0, gate, true, 2) === undefined)
}

console.log('the rule can be turned off')
{
  const gate = new PlanGate()
  check('nothing is refused when the rule is off',
    planRefusal('glob', 's4', 0, gate, false, 2) === undefined)
}

console.log('a new turn starts over')
{
  const gate = new PlanGate()
  gate.markPlanned('s5')
  check('the turn has a plan', gate.hasPlanned('s5') === true)
  gate.reset('s5')
  check('the new turn has none', gate.hasPlanned('s5') === false)
  check('and the new turn is held to the rule again',
    planRefusal('glob', 's5', 0, gate, true, 2) === PLAN_REQUIRED)
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')

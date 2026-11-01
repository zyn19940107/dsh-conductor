/**
 * The rule that makes a turn one plan.
 */

import { PlanGate, planRefusal, isModelCall, PLAN_REQUIRED, PLAN_DONE } from '../src/gate.js'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'

let failures = 0

/**
 * Assert one condition.
 *
 * @param {string} name - what is being asserted.
 * @param {boolean} condition - the condition that must hold.
 * @param {string} detail - what to print when it does not.
 */
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ok   ${name}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

console.log('a turn opens with its plan')
{
  const gate = new PlanGate()
  check('a direct call before the plan is refused',
    planRefusal('glob', ToolCallId('call-s1'), 's1', gate, true, 2, 10) === PLAN_REQUIRED)
  check('the plan itself is never refused',
    planRefusal('refine_plan', ToolCallId('call-s1'), 's1', gate, true, 2, 10) === undefined)
  check('the refusal names the tool',
    (planRefusal('glob', ToolCallId('call-s1'), 's1', gate, true, 2, 10) ?? '').includes('refine_plan'))
}

console.log('a turn stops when its plan has run')
{
  const gate = new PlanGate()
  gate.markPlanned('s2', ToolCallId('plan-2'))
  check('a direct call after the plan is refused',
    planRefusal('glob', ToolCallId('call-s2'), 's2', gate, true, 2, 10) === PLAN_DONE)
  check('the call that handed the plan over is the plan itself, and it runs',
    planRefusal('refine_plan', ToolCallId('plan-2'), 's2', gate, true, 2, 10) === undefined)
  check('the refusal asks for the conclusion',
    (planRefusal('glob', ToolCallId('call-s2'), 's2', gate, true, 2, 10) ?? '').includes('conclusion'))
  const fresh = new PlanGate()
  fresh.markPlanned('s2b', ToolCallId('plan-2b'))
  check('a second plan is refused too',
    planRefusal('refine_plan', ToolCallId('call-s2b'), 's2b', fresh, true, 2, 10) === PLAN_DONE)
}

console.log('the calls a plan makes are not held to the rule')
{
  const root = ToolCallId('root-1')
  const nested = ToolCallId('nested-1')
  check('the call the model asked for is its own',
    isModelCall({ callId: root, rootCallId: root }) === true)
  check('a call a plan made is nested',
    isModelCall({ callId: nested, rootCallId: root }) === false)
}

console.log('a child agent is held to the rule too')
{
  const gate = new PlanGate()
  check('a child must hand over a plan as well',
    planRefusal('glob', ToolCallId('call-s3'), 's3', gate, true, 2, 10) === PLAN_REQUIRED)
  check('the child may hand over a plan',
    planRefusal('refine_plan', ToolCallId('call-s3b'), 's3', gate, true, 2, 10) === undefined)
}

console.log('the rule gives up rather than trap the agent')
{
  const gate = new PlanGate()
  planRefusal('glob', ToolCallId('call-s4'), 's4', gate, true, 2, 10)
  planRefusal('glob', ToolCallId('call-s4'), 's4', gate, true, 2, 10)
  check('the third attempt before the plan is allowed through',
    planRefusal('glob', ToolCallId('call-s4'), 's4', gate, true, 2, 10) === undefined)
}

console.log('the rule can be turned off')
{
  const gate = new PlanGate()
  check('nothing is refused when the rule is off',
    planRefusal('glob', ToolCallId('call-s5'), 's5', gate, false, 2, 10) === undefined)
}

console.log('a new turn starts over')
{
  const gate = new PlanGate()
  gate.markPlanned('s6', ToolCallId('plan-6'))
  check('the turn has a plan', gate.hasPlanned('s6') === true)
  gate.reset('s6')
  check('the new turn has none', gate.hasPlanned('s6') === false)
  check('and the new turn is held to the rule again',
    planRefusal('glob', ToolCallId('call-s6'), 's6', gate, true, 2, 10) === PLAN_REQUIRED)
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')

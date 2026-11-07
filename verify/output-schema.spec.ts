/**
 * The plan tool's result shape, checked against the schema it registers.
 *
 * The harness refuses a result that carries a property the output schema does
 * not declare (`additionalProperties: false`). When that happens the plan has
 * already run — every node did its work — and the parent is handed an error
 * instead of the results, so it draws the same plan again. That is not a small
 * failure: one undeclared field cost minutes and a pile of agents before anyone
 * noticed.
 *
 * So the schema is checked here, through the same validator the harness uses.
 */

import { applyPlanTool, type PlanOutput } from '../src/tool.js'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

let failures = 0

/**
 * @param name - the check's name.
 * @param condition - what has to hold.
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
 * The tool definition the plugin registers, whatever the rest of the context is.
 *
 * @returns the definition, with its output schema.
 */
function registeredTool(): { output: { schema: unknown } } {
  let captured: any
  const ctx = {
    tools: { register: (definition: unknown) => { captured = definition } },
    effect: () => ({ register: () => {} }),
    on: () => {},
  } as any
  applyPlanTool(ctx, {
    respectConcurrencySafety: () => false,
    maxBatchSize: () => 8,
    timeoutMs: () => 600_000,
    overrides: () => ({}),
    maxAgentDepth: () => 3,
    agentNodeTimeoutMs: () => 600_000,
  } as any)
  if (captured === undefined) throw new Error('the plan tool registered nothing')
  return captured
}

console.log('the plan tool may return exactly what it declares')
{
  const tool = registeredTool()
  const withWarning: PlanOutput = {
    criteria: ['the plan ran'],
    groups: 1,
    nodes: [{ id: 'scan', kind: 'tools', ok: true, output: 'done', error: '' }],
    budgetWarn: '[budgets] These nodes ask for 900s in total, and this plan stops at 600s.',
  }

  // validateJsonSchemaValue returns the list of violations; the harness turns a
  // non-empty list into the error the model would see.
  const violations = (value: unknown): number =>
    (validateJsonSchemaValue(tool.output.schema, value) as unknown[]).length

  check('the schema declares the budget warning', JSON.stringify(tool.output.schema).includes('"budgetWarn"'))
  check('a result with a budget warning validates', violations(withWarning) === 0)
  check('a result without one validates', violations({ criteria: ['x'], groups: 0, nodes: [] }) === 0)
  check('an undeclared property is refused (so the checks above mean something)',
    violations({ ...withWarning, undeclaredField: 1 }) > 0)
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')

/**
 * The name a model writes is not always the name of a tool.
 *
 * A plan is written from memory: the model can prefix a tool it never saw
 * (`CompatGrep`) or invent a suffix (`CompatRefinePlan3d1656`). The repair asks
 * the registry for the real name before it asks the model for anything.
 */

import { resolveToolName } from '../src/repair.ts'

let failures = 0

/** Record one check. */
function check(what: string, ok: boolean): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failures += 1
}

const KNOWN = new Set(['read', 'grep', 'glob', 'pwsh', 'refine_plan', 'subagent', 'subagent_fork', 'edit', 'write'])
const known = (name: string): boolean => KNOWN.has(name)

console.log('a name that is already a tool is left alone')
{
  check('read stays read', resolveToolName(known, 'read') === 'read')
  check('refine_plan stays refine_plan', resolveToolName(known, 'refine_plan') === 'refine_plan')
}

console.log('an invented name is resolved')
{
  check('CompatGrep resolves to grep', resolveToolName(known, 'CompatGrep') === 'grep')
  check('CompatRead resolves to read', resolveToolName(known, 'CompatRead') === 'read')
  check('CompatRefinePlan3d1656 resolves to refine_plan', resolveToolName(known, 'CompatRefinePlan3d1656') === 'refine_plan')
  check('CompatSubagentFork resolves to subagent_fork', resolveToolName(known, 'CompatSubagentFork') === 'subagent_fork')
}

console.log('a name that matches nothing stays unresolved')
{
  check('nonsense is undefined', resolveToolName(known, 'nonsense') === undefined)
  check('a tool the registry does not have is undefined', resolveToolName(known, 'CompatBashSandbox') === undefined)
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')

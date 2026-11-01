/**
 * Regression tests for the plan, the chain detector, and the per-conversation
 * switch.
 */

import { parseBatchArgs, renderBatch, type BatchOutput } from '../src/batch.js'

import { parsePolicyCommand } from '../src/policy.js'

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

console.log('parseBatchArgs')
{
  const parsed = parseBatchArgs({
    criteria: ['the file exists', 'it parses'],
    calls: [
      { name: 'read', arguments: { path: 'a.txt' } },
      { name: 'glob', arguments: { pattern: '*.ts' } },
    ],
  })
  check('accepts a plan', parsed !== undefined)
  check('keeps the criteria', parsed?.criteria.length === 2)
  check('keeps the calls in order', parsed?.calls[1]?.name === 'glob')
  check('keeps the arguments', (parsed?.calls[0]?.arguments as { path: string }).path === 'a.txt')

  check('refuses a plan without criteria', parseBatchArgs({ calls: [{ name: 'read' }] }) === undefined)
  check('refuses a plan with empty criteria', parseBatchArgs({ criteria: [], calls: [{ name: 'read' }] }) === undefined)
  check('refuses a plan without calls', parseBatchArgs({ criteria: ['x'], calls: [] }) === undefined)
  check('refuses a call without a name', parseBatchArgs({ criteria: ['x'], calls: [{ arguments: {} }] }) === undefined)
  check('refuses a plan that is not an object', parseBatchArgs('nonsense') === undefined)
  check('trims the criteria', parseBatchArgs({ criteria: ['  x  '], calls: [{ name: 'read' }] })?.criteria[0] === 'x')
}

console.log('parsePolicyCommand')
{
  check('reads the off command', parsePolicyCommand('/dsh-refine-loop off') === 'off')
  check('reads the on command', parsePolicyCommand('/dsh-refine-loop on') === 'on')
  check('ignores another command', parsePolicyCommand('/dsh-some-other-policy off') === undefined)
  check('ignores the command without a mode', parsePolicyCommand('/dsh-refine-loop') === undefined)
  check('ignores a command that is not the first line', parsePolicyCommand('hello\n/dsh-refine-loop off') === undefined)
  check('ignores an ordinary message', parsePolicyCommand('please batch these') === undefined)
}

console.log('renderBatch')
{
  const output: BatchOutput = {
    criteria: ['the file exists'],
    schedule: 'concurrent',
    results: [
      { name: 'read', ok: true, scheduled: 'concurrent', output: 'contents', error: '' },
      { name: 'glob', ok: false, scheduled: 'serial', output: '', error: 'it failed' },
    ],
  }
  const text = renderBatch(output)
  check('names the criteria', text.includes('the file exists'))
  check('names every item', text.includes('read') && text.includes('glob'))
  check('carries the failure', text.includes('it failed'))
  check('asks for a short answer', text.includes('keep it short'))
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')

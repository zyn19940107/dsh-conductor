/**
 * The rule that decides which calls may run at the same time, and the order
 * the calls of a batch keep.
 */

import { runBatch, type BatchRunner } from '../src/batch.js'
import {
  buildOverrides,
  isReadOnlyCommand,
  mayRunTogether,
} from '../src/concurrency.js'

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

console.log('isReadOnlyCommand')
{
  check('reads ls', isReadOnlyCommand('ls -la'))
  check('reads cat', isReadOnlyCommand('cat package.json'))
  check('reads grep', isReadOnlyCommand('grep -r "name" src'))
  check('reads an absolute path', isReadOnlyCommand('/usr/bin/ls'))
  check('reads a command with a glob', isReadOnlyCommand('find . -name "*.ts"'))

  check('refuses rm', !isReadOnlyCommand('rm file.txt'))
  check('refuses npm install', !isReadOnlyCommand('npm install'))
  check('refuses node -e', !isReadOnlyCommand('node -e "process.exit(1)"'))
  check('refuses a redirection', !isReadOnlyCommand('echo hello > file.txt'))
  check('refuses an append', !isReadOnlyCommand('echo hello >> file.txt'))
  check('refuses a chain', !isReadOnlyCommand('ls && rm file.txt'))
  check('refuses a pipe', !isReadOnlyCommand('cat file.txt | grep x'))
  check('refuses a separator', !isReadOnlyCommand('ls; rm file.txt'))
  check('refuses a substitution', !isReadOnlyCommand('ls $(pwd)'))
  check('refuses a backtick', !isReadOnlyCommand('ls `pwd`'))
  check('refuses a background job', !isReadOnlyCommand('ls &'))
  check('reads a quoted pattern', isReadOnlyCommand('grep "a|b" file.txt'))
  check('reads a single-quoted dollar', isReadOnlyCommand('cat \'$(rm x)\''))
  check('refuses echo', !isReadOnlyCommand('echo hello'))
  check('refuses an expansion inside double quotes', !isReadOnlyCommand('echo "$(rm x)"'))
  check('refuses find -exec', !isReadOnlyCommand('find . -exec rm {} +'))
  check('refuses find -delete', !isReadOnlyCommand('find . -delete'))
  check('refuses sort -o', !isReadOnlyCommand('sort -o out.txt file.txt'))
  check('refuses tail -f', !isReadOnlyCommand('tail -f log.txt'))
  check('refuses an empty command', !isReadOnlyCommand('   '))
  check('refuses a non-string', !isReadOnlyCommand(undefined))
}

console.log('mayRunTogether')
{
  const overrides = { glob: { kind: 'always' } as const, ops_bash: { kind: 'read-only' } as const }
  check('a tool that says it is safe is safe', mayRunTogether('read', {}, true, overrides))
  check('a tool that says nothing is not safe', !mayRunTogether('read', {}, false, overrides))
  check('an always override is safe', mayRunTogether('glob', {}, false, overrides))
  check('a read-only override judges the command',
    mayRunTogether('ops_bash', { command: 'ls -la' }, false, overrides))
  check('a read-only override refuses a writer',
    !mayRunTogether('ops_bash', { command: 'rm file.txt' }, false, overrides))
  check('a read-only override refuses a missing command',
    !mayRunTogether('ops_bash', {}, false, overrides))
}

console.log('buildOverrides')
{
  const overrides = buildOverrides(['glob', 'grep', 'ops_bash'], true, 'ops_bash')
  check('lists the flat tools', overrides.glob !== undefined && overrides.grep !== undefined)
  check('the shell tool is judged by the read-only rule',
    overrides.ops_bash?.kind === 'read-only')
  const withoutShell = buildOverrides(['glob'], false, 'ops_bash')
  check('the shell tool is absent when the rule is off', withoutShell.ops_bash === undefined)
}

console.log('the order of a batch is the order of the plan')
{
  const order: string[] = []
  const runner: BatchRunner = {
    executionMode: exec => ({ kind: exec.name === 'exclusive' ? 'exclusive' : 'parallel' }),
    async execute(exec) {
      order.push(`start:${exec.name}`)
      await new Promise(resolve => setTimeout(resolve, 10))
      order.push(`end:${exec.name}`)
      return { isError: false, value: exec.name, content: [{ type: 'text', text: exec.name }] }
    },
  }
  await runBatch(
    runner,
    {
      criteria: ['every call ran'],
      calls: [
        { name: 'a', arguments: {} },
        { name: 'exclusive', arguments: {} },
        { name: 'b', arguments: {} },
      ],
    },
    undefined,
    new AbortController().signal,
    true,
  )

  check('the exclusive call starts after the first one finished',
    order.indexOf('start:exclusive') > order.indexOf('end:a'))
  check('the last call starts after the exclusive one finished',
    order.indexOf('start:b') > order.indexOf('end:exclusive'))
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')

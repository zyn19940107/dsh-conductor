/**
 * Deciding which calls may run at the same time.
 *
 * The harness already has this decision: a tool that declares itself safe to
 * run concurrently runs with its neighbours, and a tool that does not is a
 * barrier that runs alone. Two tools that matter here do not declare it:
 * `glob` and `grep` — both pure reads that spawn their own subprocess — and
 * the shell tool, whose command may be anything at all.
 *
 * This module is the plugin's own answer for the tools it covers, and it is
 * deliberately narrower than the harness's default:
 *
 * - A read tool is read by what it does, and there is no state to share.
 * - A shell command is read only when it is a single simple command whose
 *   executable is on an allowlist of readers and whose text contains no shell
 *   metacharacter that could hide a second command or a redirection.
 *
 * The shell answer is the risky one, so it errs hard: a command the classifier
 * cannot read as a reader stays on its own.
 *
 * @module @local/dsh-refine-loop/concurrency
 */

/**
 * The commands that only read.
 *
 * Every entry is a command whose whole job is to look at something and print
 * what it saw. None of them writes a file, changes a permission, starts a
 * server, or runs another program.
 */
export const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'ag', 'find', 'fd', 'stat',
  'file', 'du', 'df', 'tree', 'pwd', 'which', 'type', 'date', 'uname', 'basename',
  'dirname', 'realpath', 'readlink', 'sort', 'uniq', 'cut', 'diff', 'cmp', 'tr',
  'nl', 'fold', 'expand', 'env', 'printenv', 'sleep', 'true', 'false',
])

/**
 * The flags that turn an allowed command into a writer.
 *
 * `find -exec` runs another program, `find -delete` removes files, `grep
 * --pre` runs a program per match, and `sort -o` writes its output to a file.
 */
export const UNSAFE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  find: ['-exec', '-ok', '-okdir', '-delete', '-fprint', '-fprintf', '-fls'],
  grep: ['--pre', '--pre-glob'],
  rg: ['--pre', '--pre-glob'],
  sort: ['-o', '--output'],
  tail: ['-f', '--follow'],
  head: ['-f'],
  cat: ['-'],
}

/**
 * The characters that make a command more than one command.
 *
 * Outside quotes these end a word, redirect a stream, chain a command, start a
 * substitution, or open a group — each of them runs something the classifier
 * never saw. Inside quotes they are literal, so the lexer reads them as part
 * of the argument they belong to.
 */
const UNSAFE_OUTSIDE_QUOTES = ['>', '<', '&', ';', '|', '`', '$', '(', ')', '{', '}', '#', '\\']

/**
 * The characters that end a word.
 */
const SEPARATORS = [' ', '\t']

/**
 * Split a command into its words, refusing the ones that hide a second
 * command.
 *
 * The lexer understands the two kinds of quote a shell understands. Inside
 * single quotes everything is literal. Inside double quotes everything is
 * literal except `$` and a backtick, which still expand — so those two are
 * refused there.
 *
 * @param text - the command line as the model wrote it.
 * @returns the words, or undefined when the command is more than one command.
 */
function lexCommand(text: string): string[] | undefined {
  const words: string[] = []
  let current = ''
  let started = false
  let index = 0
  while (index < text.length) {
    const character = text[index]!
    if (SEPARATORS.includes(character)) {
      if (started) {
        words.push(current)
        current = ''
        started = false
      }
      index += 1
      continue
    }
    if (character === '\n' || character === '\r') return undefined
    if (character === "'") {
      const end = text.indexOf("'", index + 1)
      if (end === -1) return undefined
      current += text.slice(index + 1, end)
      started = true
      index = end + 1
      continue
    }
    if (character === '"') {
      let scan = index + 1
      while (scan < text.length && text[scan] !== '"') {
        const inner = text[scan]!
        if (inner === '$' || inner === '`') return undefined
        scan += 1
      }
      if (scan >= text.length) return undefined
      current += text.slice(index + 1, scan)
      started = true
      index = scan + 1
      continue
    }
    if (UNSAFE_OUTSIDE_QUOTES.includes(character)) return undefined
    current += character
    started = true
    index += 1
  }
  if (started) words.push(current)
  return words
}

/**
 * Whether a shell command only reads.
 *
 * The command has to be one simple command: no redirection, no chain, no pipe,
 * no substitution. The executable has to be on the allowlist, and the flags
 * have to be ones the allowlisted command does not turn into a writer.
 *
 * @param command - the command line as the model wrote it.
 * @returns true when the command only reads.
 */
export function isReadOnlyCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false
  const text = command.trim()
  if (text === '') return false
  const words = lexCommand(text)
  if (words === undefined || words.length === 0) return false
  const executable = words[0]
  if (executable === undefined) return false
  const name = executable.split(/[/\\]/u).pop() ?? executable
  if (!READ_ONLY_COMMANDS.has(name)) return false
  const unsafe = UNSAFE_FLAGS[name]
  if (unsafe === undefined) return true
  for (const token of words.slice(1)) {
    for (const flag of unsafe) {
      if (token === flag || token.startsWith(`${flag}=`)) return false
    }
  }
  return true
}

/**
 * The tool the plugin lets run with others even though their own definition
 * does not say so.
 *
 * The tool's name is the key; the value says how the call is judged. `always`
 * is for a tool that only reads. `read-only` is for a tool whose arguments
 * decide, and it is given the arguments to judge.
 */
export type ConcurrencyOverride =
  | { kind: 'always' }
  | { kind: 'read-only' }

/**
 * The overrides the plugin ships with.
 *
 * `glob` and `grep` spawn their own subprocess and return what they found.
 * Nothing they touch is shared with anything else.
 */
export const DEFAULT_OVERRIDES: Readonly<Record<string, ConcurrencyOverride>> = {
  glob: { kind: 'always' },
  grep: { kind: 'always' },
  ops_bash: { kind: 'read-only' },
}

/**
 * Build the plugin's overrides from its configuration.
 *
 * The shell tool is judged by the read-only rule and never by the flat list,
 * so listing it there cannot turn an arbitrary command into a concurrent one.
 *
 * @param concurrentTools - the tools that may run with others whatever their
 * own definition says.
 * @param concurrentShell - whether a read-only shell command may run with
 * others.
 * @param shellTool - the shell tool the read-only rule applies to.
 * @returns the overrides.
 */
export function buildOverrides(
  concurrentTools: readonly string[],
  concurrentShell: boolean,
  shellTool: string,
): Readonly<Record<string, ConcurrencyOverride>> {
  const overrides: Record<string, ConcurrencyOverride> = {}
  for (const tool of concurrentTools) {
    if (tool === shellTool) continue
    overrides[tool] = { kind: 'always' }
  }
  if (concurrentShell) overrides[shellTool] = { kind: 'read-only' }
  return overrides
}

/**
 * Whether a call may run with the calls around it.
 *
 * The tool's own answer comes first: a tool that says it is safe is safe. The
 * override only answers for a tool that says nothing, because saying nothing
 * is what "exclusive" means to the harness.
 *
 * @param toolName - the tool being called.
 * @param args - the arguments the call carries.
 * @param ownAnswer - what the tool's own definition says.
 * @param overrides - the plugin's overrides.
 * @returns true when the call may run with its neighbours.
 */
export function mayRunTogether(
  toolName: string,
  args: unknown,
  ownAnswer: boolean,
  overrides: Readonly<Record<string, ConcurrencyOverride>>,
): boolean {
  if (ownAnswer) return true
  const override = overrides[toolName]
  if (override === undefined) return false
  if (override.kind === 'always') return true
  const command = (args as { command?: unknown } | undefined)?.command
  return isReadOnlyCommand(command)
}

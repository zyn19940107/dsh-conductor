/**
 * Tasks taken from public model-evaluation sets.
 *
 * The scenarios in `scenarios.mjs` are shaped by hand: they ask a question the
 * plugin's shape answers well and judge the answer by looking for strings in
 * it. The tasks here are different in both halves.
 *
 * - The task itself comes from a public evaluation set, verbatim: the prompt
 *   and the canonical tests of a HumanEval problem are the dataset's own.
 * - The correctness criterion is executed, not matched: the judge runs the
 *   dataset's tests against the code the agent wrote. A string-matching judge
 *   can be satisfied by a sentence that happens to contain the right words; a
 *   test suite cannot.
 *
 * The judge reads its tests from the vendored dataset copy, never from the
 * workspace, and it fingerprints both the copy and the self-check script the
 * agent is given. So "fix the test" is not a way to pass.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const SAMPLE_PATH = resolve(HERE, 'data', 'humaneval-sample.json')
const HARD_SAMPLE_PATH = resolve(HERE, 'data', 'humaneval-hard-sample.json')

/**
 * The vendored dataset sample.
 *
 * @param {string} path - the sample file.
 * @returns {object} the sample.
 */
function sample(path = SAMPLE_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * The fixture directory for one run.
 *
 * Computed per call, not at import: the runner sets `DSH_BENCH_CONDITION` just
 * before it asks for the fixture, so the two conditions get two directories and
 * can run in parallel.
 *
 * @param {string} name - the scenario's name.
 * @returns {string} the absolute workspace path.
 */
function workspace(name) {
  return resolve(REPO, '..', 'dsh-sandbox', `bench-workspace-${process.env.DSH_BENCH_CONDITION ?? 'one'}-${name}`)
}

/**
 * The hash of a file's contents.
 *
 * @param {string} path - the file.
 * @returns {string} the hash.
 */
function fingerprint(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * The self-check the agent is given.
 *
 * It is the judge's logic, but with the problems read from the workspace copy
 * and the workspace taken from the script's own directory. The agent can run
 * it; the judge does not trust it.
 */
const CHECK_PY = `"""Run the HumanEval tests against solution.py. Prints one line per problem."""
import json
from pathlib import Path

HERE = Path(__file__).parent


def main():
    problems = json.loads((HERE / 'problems.json').read_text(encoding='utf-8'))['problems']
    solution = HERE / 'solution.py'
    if not solution.exists():
        print('FAIL missing solution.py')
        print('RESULT 0/%d' % len(problems))
        return
    scope = {}
    try:
        exec(compile(solution.read_text(encoding='utf-8'), 'solution.py', 'exec'), scope)
    except Exception as exc:
        print('FAIL solution.py does not import: %s: %s' % (type(exc).__name__, exc))
        print('RESULT 0/%d' % len(problems))
        return
    passed = 0
    for problem in problems:
        entry = problem['entry_point']
        if entry not in scope:
            print('FAIL %s: %s is not defined' % (problem['task_id'], entry))
            continue
        try:
            exec(compile(problem['test'], problem['task_id'], 'exec'), scope)
            scope['check'](scope[entry])
            passed += 1
            print('PASS %s' % problem['task_id'])
        except Exception as exc:
            print('FAIL %s: %s: %s' % (problem['task_id'], type(exc).__name__, exc))
    print('RESULT %d/%d' % (passed, len(problems)))


main()
`

/**
 * The judge runner: the same checks, the dataset's own copy of the tests.
 *
 * It is written fresh at judgement time, so the agent cannot have touched it.
 */
const JUDGE_PY = `"""Judge one run: run the vendored HumanEval tests against the agent's solution.py."""
import json
import sys
from pathlib import Path


def main():
    workspace = Path(sys.argv[1])
    sample = json.loads(Path(sys.argv[2]).read_text(encoding='utf-8'))
    problems = sample['problems']
    solution = workspace / 'solution.py'
    if not solution.exists():
        print('FAIL missing solution.py')
        print('RESULT 0/%d' % len(problems))
        return
    scope = {}
    try:
        exec(compile(solution.read_text(encoding='utf-8'), 'solution.py', 'exec'), scope)
    except Exception as exc:
        print('FAIL solution.py does not import: %s: %s' % (type(exc).__name__, exc))
        print('RESULT 0/%d' % len(problems))
        return
    passed = 0
    for problem in problems:
        entry = problem['entry_point']
        if entry not in scope:
            print('FAIL %s: %s is not defined' % (problem['task_id'], entry))
            continue
        try:
            exec(compile(problem['test'], problem['task_id'], 'exec'), scope)
            scope['check'](scope[entry])
            passed += 1
            print('PASS %s' % problem['task_id'])
        except Exception as exc:
            print('FAIL %s: %s: %s' % (problem['task_id'], type(exc).__name__, exc))
    print('RESULT %d/%d' % (passed, len(problems)))


main()
`

/**
 * Build a HumanEval task from a vendored sample.
 *
 * @param {{name: string, samplePath: string, workspaceName: string, label: string}} options - the sample and how the task names it.
 * @returns {object} the task.
 */
function makeHumanEval({ name, samplePath, workspaceName, label }) {
  return {
    name,
    text: [],
    setup() {
      const ws = workspace(workspaceName)
      rmSync(ws, { recursive: true, force: true })
      mkdirSync(ws, { recursive: true })
      const data = sample(samplePath)
      writeFileSync(resolve(ws, 'problems.json'), `${JSON.stringify({ problems: data.problems }, null, 2)}\n`)
      writeFileSync(resolve(ws, 'check.py'), CHECK_PY)
      writeFileSync(resolve(ws, 'solution.py'), [
        '# Implement the functions below here.',
        '# Keep the signature and the docstring of each function exactly as given.',
        '',
      ].join('\n'))
      this.pristine = {
        check: fingerprint(resolve(ws, 'check.py')),
        sample: fingerprint(samplePath),
      }
      this.text = [
        `公开评测集任务(${label},原题 + 原测试):工作区 ${ws}`,
        '',
        `请在 solution.py 里实现下面 ${data.problems.length} 个函数。每个函数的签名和文档字符串原样保留,实现写在 def 的下一行。`,
        '',
        ...data.problems.flatMap((problem, index) => [
          `--- ${index + 1}. ${problem.task_id} (函数名 ${problem.entry_point}) ---`,
          problem.prompt.trimEnd(),
          '',
        ]),
        '规则:',
        '1. 只允许改 solution.py。',
        '2. 不许改 check.py 和 problems.json —— 那是判据,改了不算。',
        `3. 用 \`python check.py\` 自检,一直跑到输出 RESULT ${data.problems.length}/${data.problems.length}。`,
        '4. 报告:每个函数一行实现思路,加上 check.py 的完整最终输出。',
        '',
        `不要修改本仓库(${REPO})本身的任何文件。`,
      ].join('\n')
    },
    judge() {
      const ws = workspace(workspaceName)
      const missing = []
      const data = sample(samplePath)
      const total = data.problems.length
      if (!existsSync(resolve(ws, 'solution.py'))) {
        return { passed: 0, total, missing: ['solution.py 不存在'] }
      }
      if (fingerprint(resolve(ws, 'check.py')) !== this.pristine.check) missing.push('check.py 被改过(禁止)')
      if (fingerprint(samplePath) !== this.pristine.sample) missing.push(`${samplePath} 被改过(禁止)`)
      const runner = resolve(tmpdir(), `humeval-judge-${process.pid}.py`)
      writeFileSync(runner, JUDGE_PY)
      let out = ''
      try {
        out = execFileSync('python', [runner, ws, samplePath], { encoding: 'utf8', stdio: 'pipe' })
      } catch (error) {
        out = String(error.stdout ?? '')
        missing.push('判据脚本跑不起来')
      }
      const match = /RESULT (\d+)\/(\d+)/.exec(out)
      const passed = match === null ? 0 : Number(match[1])
      if (passed < total) {
        const failures = out.split('\n').filter(line => line.startsWith('FAIL')).slice(0, 3)
        if (failures.length > 0) missing.push(`没过的用例:${failures.join(' | ').slice(0, 300)}`)
      }
      return { passed, total, missing }
    },
  }
}

/**
 * The HumanEval subset: five independent problems, five canonical test sets.
 *
 * The problems do not depend on each other, so the shape is the one a plan
 * batches: every implementation is knowable before anything has run, and every
 * test result comes back together. A plain agent can also emit five writes in
 * one step, so this is the shape where the plugin's advantage is the round trip
 * and the context, not the ability.
 */
export const HUMANEVAL = makeHumanEval({
  name: 'humeval',
  samplePath: SAMPLE_PATH,
  workspaceName: 'humeval',
  label: 'HumanEval 子集',
})

/**
 * The same shape, five harder problems: more of the prompt has to be read
 * before the implementation can be written.
 */
export const HUMAEVAL_HARD = makeHumanEval({
  name: 'humeval-hard',
  samplePath: HARD_SAMPLE_PATH,
  workspaceName: 'humeval-hard',
  label: 'HumanEval 难题子集',
})

/**
 * The QuixBugs sample: the benchmark's own buggy programs and test cases.
 */
export const QX_SAMPLE_PATH = resolve(HERE, 'data', 'quixbugs-sample.json')

/**
 * Cases the agent never sees.
 *
 * The canonical cases are handed to the agent, so a program that returns the
 * expected answer for the given inputs would pass them. These extra cases
 * come from the benchmark's own correct programs — they are checked against
 * them before they are used — so a program that memorises the visible cases
 * does not pass.
 */
const QX_HELD_OUT = {
  bitcount: [[[1023], 10], [[1], 1], [[0], 0]],
  gcd: [[[48, 18], 6], [[17, 17], 17], [[0, 5], 5]],
  find_first_in_sorted: [[[[1, 2, 3], 2], 1], [[[1, 1, 1], 1], 0], [[[], 1], -1]],
  bucketsort: [[[[3, 1, 2], 4], [1, 2, 3]], [[[0, 0], 2], [0, 0]], [[[5], 7], [5]]],
}

/**
 * The runner, for the agent's self-check and for the judge.
 *
 * Given a workspace and a cases file it runs every bug's cases against the
 * program in the workspace and prints one line per bug.
 */
const QX_RUNNER_PY = `"""Run the QuixBugs cases against the programs in the workspace.

Each bug is checked in its own process: a buggy program may loop forever, and
a judge that waits for it judges nothing.
"""
import json
import multiprocessing
import sys
from pathlib import Path

TIMEOUT_SECONDS = 10


def run_bug(name, cases, program_path, out):
    """Check one bug's cases. Puts its result lines in the queue."""
    lines = []
    try:
        with open(program_path, encoding='utf-8') as handle:
            source = handle.read()
        scope = {}
        exec(compile(source, program_path, 'exec'), scope)
        function = scope.get(name)
        if function is None:
            lines.append('FAIL %s: %s is not defined' % (name, name))
        else:
            broken = 0
            for args, expected in cases:
                try:
                    got = function(*args)
                except Exception as exc:
                    lines.append('FAIL %s: %s(%r) raised %s: %s'
                                 % (name, name, args, type(exc).__name__, exc))
                    broken += 1
                    continue
                if got != expected:
                    lines.append('FAIL %s: %s(%r) -> %r, expected %r'
                                 % (name, name, args, got, expected))
                    broken += 1
            if broken == 0:
                lines.append('PASS %s' % name)
    except Exception as exc:
        lines.append('FAIL %s: does not import: %s: %s' % (name, type(exc).__name__, exc))
    out.put(lines)


def load_cases(root, cases_path):
    """The cases to run: the file the judge hands over, or the workspace's own."""
    if cases_path:
        data = json.loads(Path(cases_path).read_text(encoding='utf-8'))
        return [(bug['name'], bug['cases']) for bug in data['bugs']]
    cases = []
    for directory in sorted(Path(root).iterdir()):
        if not directory.is_dir():
            continue
        cases.append((directory.name,
                      json.loads((directory / 'cases.json').read_text(encoding='utf-8'))['cases']))
    return cases


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent
    cases_path = sys.argv[2] if len(sys.argv) > 2 else ''
    context = multiprocessing.get_context('spawn')
    passed = 0
    bugs = load_cases(root, cases_path)
    for name, bug_cases in bugs:
        program = root / name / 'program.py'
        if not program.exists():
            print('FAIL %s: program.py is missing' % name)
            continue
        queue = context.Queue()
        worker = context.Process(target=run_bug, args=(name, bug_cases, str(program), queue))
        worker.start()
        worker.join(TIMEOUT_SECONDS)
        if worker.is_alive():
            worker.terminate()
            worker.join()
            print('FAIL %s: timed out after %ds' % (name, TIMEOUT_SECONDS))
            continue
        try:
            lines = queue.get_nowait()
        except Exception:
            lines = ['FAIL %s: no result' % name]
        for line in lines:
            print(line)
        if lines and lines[-1].startswith('PASS'):
            passed += 1
    print('RESULT %d/%d' % (passed, len(bugs)))


if __name__ == '__main__':
    main()
`

/**
 * The state the QuixBugs judge keeps between the setup and the judgement.
 */
let qxPristine = { check: '', sample: '' }

/**
 * The QuixBugs subset: four programs, four bugs, four test sets.
 *
 * The shape is the one a plan batches and the one the plugin claims to help
 * with: four independent repairs, each judged by running its cases. The loop
 * inside each repair — run the cases, read the failure, fix the program — is
 * the long-horizon part; whether the four repairs are drawn in one graph or
 * one at a time is the part the plugin changes.
 */
export const QUIXBUGS = {
  name: 'quixbugs',
  text: [],
  setup() {
    const ws = workspace('quixbugs')
    rmSync(ws, { recursive: true, force: true })
    mkdirSync(ws, { recursive: true })
    const data = JSON.parse(readFileSync(QX_SAMPLE_PATH, 'utf8'))
    for (const bug of data.bugs) {
      const dir = resolve(ws, bug.name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(resolve(dir, 'program.py'), bug.program)
      writeFileSync(resolve(dir, 'cases.json'), `${JSON.stringify({ cases: bug.cases }, null, 2)}\n`)
    }
    writeFileSync(resolve(ws, 'check.py'), QX_RUNNER_PY)
    qxPristine = {
      check: fingerprint(resolve(ws, 'check.py')),
      sample: fingerprint(QX_SAMPLE_PATH),
    }
    this.text = [
      `公开评测集任务(QuixBugs 子集,原程序 + 原用例):工作区 ${ws}`,
      '',
      '下面每个目录里有一个程序,程序里有且只有一个 bug。用目录里的 cases.json 判断对错,',
      'cases.json 的每一行是 [参数, 期望值]:',
      '',
      ...data.bugs.map(bug => `  - ${bug.name}/  (用例 ${bug.cases.length} 条)`),
      '',
      '任务:把每个程序都修好,让它的用例全部通过。',
      '',
      '规则:',
      '1. 只允许改各个目录下的 program.py。',
      '2. 不许改 cases.json 和 check.py —— 那是判据,改了不算。',
      '3. 用 `python check.py` 自检,一直跑到输出 RESULT 4/4。',
      '4. 报告:每个 bug 是什么、改了哪一行,加上 check.py 的完整最终输出。',
      '',
      `不要修改本仓库(${REPO})本身的任何文件。`,
    ].join('\n')
  },
  judge() {
    const ws = workspace('quixbugs')
    const missing = []
    const data = JSON.parse(readFileSync(QX_SAMPLE_PATH, 'utf8'))
    const total = data.bugs.length
    if (!existsSync(resolve(ws, 'check.py'))) {
      return { passed: 0, total, missing: ['check.py 不存在'] }
    }
    if (fingerprint(resolve(ws, 'check.py')) !== qxPristine.check) missing.push('check.py 被改过(禁止)')
    if (fingerprint(QX_SAMPLE_PATH) !== qxPristine.sample) missing.push('bench/data/quixbugs-sample.json 被改过(禁止)')
    // The judge runs the canonical cases and the held-out ones together.
    const combined = resolve(tmpdir(), `quixbugs-cases-${process.pid}.json`)
    writeFileSync(combined, `${JSON.stringify({
      bugs: data.bugs.map(bug => ({
        name: bug.name,
        cases: [...bug.cases, ...(QX_HELD_OUT[bug.name] ?? [])],
      })),
    })}\n`)
    const runner = resolve(tmpdir(), `quixbugs-judge-${process.pid}.py`)
    writeFileSync(runner, QX_RUNNER_PY)
    let out = ''
    try {
      out = execFileSync('python', [runner, ws, combined], { encoding: 'utf8', stdio: 'pipe' })
    } catch (error) {
      out = String(error.stdout ?? '')
      missing.push('判据脚本跑不起来')
    }
    const match = /RESULT (\d+)\/(\d+)/.exec(out)
    const passed = match === null ? 0 : Number(match[1])
    if (passed < total) {
      const failures = out.split('\n').filter(line => line.startsWith('FAIL')).slice(0, 3)
      if (failures.length > 0) missing.push(`没过的用例:${failures.join(' | ').slice(0, 300)}`)
    }
    return { passed, total, missing }
  },
}

export const PUBLIC_TASKS = { humeval: HUMANEVAL, 'humeval-hard': HUMAEVAL_HARD, quixbugs: QUIXBUGS }

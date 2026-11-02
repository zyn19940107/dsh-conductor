/**
 * Prove the judge works before a model run spends anything on it.
 *
 * Three probes per task: a correct solution passes, a wrong solution fails,
 * and a tampered judge file is caught. A judge that cannot tell those apart
 * would publish a correctness column that means nothing.
 *
 * The reference solutions live outside the plugin repository, in the sandbox
 * home: the repository must hold no answer for the tasks it measures.
 *
 * Usage: node bench/probe-judge.mjs [task ...]
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { TASKS } from './task.mjs'
import { QX_SAMPLE_PATH } from './pubeval.mjs'

process.env.DSH_BENCH_CONDITION = 'probe'
const SANDBOX_HOME = process.env.DSH_SANDBOX_HOME ?? 'D:/code/vibe/dsh-sandbox/home'
const SOLUTIONS = resolve(SANDBOX_HOME, '..', 'bench-reference', 'probe-solutions.json')

/**
 * The reference answer for the HumanEval task.
 */
const HUMAEVAL_SOLUTION = `import math


def poly(xs: list, x: float):
    return sum([coeff * math.pow(x, i) for i, coeff in enumerate(xs)])


def find_zero(xs: list):
    def f(x):
        return poly(xs, x)
    step = 0.25
    x = -1000.0
    prev = f(x)
    while x < 1000.0:
        x += step
        cur = f(x)
        if cur == 0:
            return x
        if prev * cur < 0:
            a, b = x - step, x
            for _ in range(200):
                m = (a + b) / 2
                if f(a) * f(m) <= 0:
                    b = m
                else:
                    a = m
            return (a + b) / 2
        prev = cur
    return 0.0


def fibfib(n: int):
    if n == 0 or n == 1:
        return 0
    if n == 2:
        return 1
    a, b, c = 0, 0, 1
    for _ in range(n - 2):
        a, b, c = b, c, a + b + c
    return c


def sort_array(array):
    arr = list(array)
    if not arr:
        return arr
    if (arr[0] + arr[-1]) % 2 == 1:
        return sorted(arr)
    return sorted(arr, reverse=True)


def move_one_ball(arr):
    if not arr:
        return True
    for shift in range(len(arr)):
        rotated = arr[len(arr) - shift:] + arr[:len(arr) - shift] if shift else arr
        if rotated == sorted(rotated):
            return True
    return False


def maximum(arr, k):
    ordered = sorted(arr)
    if k <= 0:
        return []
    return ordered[len(ordered) - k:]
`

/**
 * A deliberately wrong answer: everything returns nothing useful.
 */
const WRONG_SOLUTION = `
def find_zero(xs):
    return 0.0


def fibfib(n):
    return 0


def sort_array(array):
    return sorted(array)


def move_one_ball(arr):
    return True


def maximum(arr, k):
    return arr[:k]
`

/**
 * Put the reference answer in the workspace.
 *
 * @param {string} task - the task's name.
 * @param {string} workspace - the workspace the task set up.
 * @returns {boolean} whether the reference was applied.
 */
function applyReference(task, workspace) {
  if (task === 'humeval') {
    writeFileSync(resolve(workspace, 'solution.py'), HUMAEVAL_SOLUTION)
    return true
  }
  if (task === 'quixbugs') {
    if (!existsSync(SOLUTIONS)) {
      console.error(`the reference programs are missing: ${SOLUTIONS}`)
      return false
    }
    const programs = JSON.parse(readFileSync(SOLUTIONS, 'utf8')).programs
    for (const [name, program] of Object.entries(programs)) {
      writeFileSync(resolve(workspace, name, 'program.py'), program)
    }
    return true
  }
  return false
}

/**
 * Put a wrong answer in the workspace.
 *
 * @param {string} task - the task's name.
 * @param {string} workspace - the workspace the task set up.
 */
function applyWrong(task, workspace) {
  if (task === 'humeval') {
    writeFileSync(resolve(workspace, 'solution.py'), WRONG_SOLUTION)
    return
  }
  const sample = JSON.parse(readFileSync(QX_SAMPLE_PATH, 'utf8'))
  for (const bug of sample.bugs) {
    writeFileSync(resolve(workspace, bug.name, 'program.py'), bug.program)
  }
}

const names = process.argv.slice(2).filter(name => TASKS[name] !== undefined)
const tasks = names.length > 0 ? names : Object.keys(TASKS).filter(name => TASKS[name].setup !== undefined)

let allOk = true
for (const name of tasks) {
  const task = TASKS[name]
  task.setup()
  const ws = task.text.match(/工作区 (\S+)/)?.[1]
  if (ws === undefined) {
    console.error(`${name}: the task text does not name a workspace`)
    allOk = false
    continue
  }
  if (!applyReference(name, ws)) {
    allOk = false
    continue
  }
  const good = task.judge('reference answer')
  console.log(`${name}: reference answer -> ${JSON.stringify(good)}`)

  applyWrong(name, ws)
  const bad = task.judge('wrong answer')
  console.log(`${name}: wrong answer     -> ${JSON.stringify(bad)}`)

  if (!applyReference(name, ws)) {
    allOk = false
    continue
  }
  writeFileSync(resolve(ws, 'check.py'), 'print("ALL PASS")\n')
  const tampered = task.judge('tampered')
  console.log(`${name}: tampered judge  -> ${JSON.stringify(tampered)}`)

  const ok = good.passed === good.total && bad.passed < bad.total && tampered.missing.length > 0
  console.log(`${name}: ${ok ? 'PROBE OK' : 'PROBE FAILED'}`)
  if (!ok) allOk = false
}

console.log(allOk ? 'ALL PROBES OK' : 'SOME PROBES FAILED')
process.exit(allOk ? 0 : 1)

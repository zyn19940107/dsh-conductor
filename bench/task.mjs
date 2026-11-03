/**
 * The benchmark tasks and their correctness criteria.
 *
 * One task per shape the plugin claims to change: a set of independent
 * lookups, a chain where the second step depends on the first, and a review
 * whose parts are independent enough that a good model hands them to child
 * agents.
 *
 * Every criterion is mechanical: the answer has to name the files, the
 * identifiers, and the counts. Nothing here asks whether an answer reads
 * well, because a criterion nobody can disagree about is the only one that
 * survives being published.
 */

import { BIGREAD, COVERAGE, COVERAGEWIDE, DISCOVERY, FANOUT, GREENSPECS, GREENSPECSHARD, MULTIHOP, PANEL, SWEEP } from './scenarios.mjs'
import { PUBLIC_TASKS } from './pubeval.mjs'
import { LHTB_TASKS } from './lhtb.mjs'
import { LHTB_NBODY_TASKS } from './lhtb-nbody.mjs'
import { LHTB_COMMIT0_TASKS } from './lhtb-commit0.mjs'
import { LHTB_MATPOWER_TASKS } from './lhtb-matpower.mjs'

/**
 * The scenario tasks that say where the plugin helps and where it does not.
 */
const SCENARIOS = { discovery: DISCOVERY, fanout: FANOUT, multihop: MULTIHOP, coverage: COVERAGE, coveragewide: COVERAGEWIDE, sweep: SWEEP, bigread: BIGREAD, panel: PANEL, greenspecs: GREENSPECS, 'greenspecs-hard': GREENSPECSHARD }

/**
 * The plugin health check: independent lookups, one synthesis.
 *
 * @type {{text: string, judge: (answer: string) => {passed: number, total: number, missing: string[]}}}
 */
export const SURVEY = {
  text: [
    '对 D:\\code\\vibe\\dsh-refine-loop 这个插件做一次体检,回答下面五件事:',
    '',
    '1. src 目录下有多少个 .ts 文件?分别叫什么名字?',
    '2. verify 目录下有多少个 .spec.ts 文件?分别叫什么名字?',
    '3. 哪些文件里出现了 "isConcurrencySafe"?',
    '4. 哪些文件里出现了 "delegationDepth"?',
    '5. 根据上面四项的发现,用两三句话评价这个插件的架构。',
    '',
    '只读不改。不要修改任何文件。',
  ].join(String.fromCharCode(10)),
}

/**
 * A chain: each step needs the previous step's answer.
 *
 * @type {{text: string, judge: (answer: string) => {passed: number, total: number, missing: string[]}}}
 */
export const CHAIN = {
  text: [
    '对 D:\\code\\vibe\\dsh-refine-loop 做三步调查,每一步都要用到上一步的结果:',
    '',
    '1. 先读 src/plan.ts,找出 buildWaves 这个函数返回的 waves 数组里,元素是什么类型。',
    '2. 根据第一步找到的类型名,在 src 目录下找出所有引用了它的文件,列出来。',
    '3. 根据第二步的文件清单,用一句话说明这个类型在插件里承担什么角色。',
    '',
    '只读不改。不要修改任何文件。',
  ].join(String.fromCharCode(10)),
}

/**
 * A review whose three parts are independent enough to hand to children.
 *
 * @type {{text: string, judge: (answer: string) => {passed: number, total: number, missing: string[]}}}
 */
export const REVIEW = {
  text: [
    '分别独立审查 D:\code\vibe\dsh-refine-loop 的三个部分,每部分给出结论:',
    '',
    '1. src/plan.ts —— 计划的数据结构长什么样?节点有哪几种?调用参数是怎么处理的?',
    '2. src/gate.ts —— 这个插件的那条规则是什么?它的触发条件是什么?',
    '3. src/tool.ts —— 计划是怎么被跑起来的?派出去的子代理受到什么限制?',
    '',
    '最后把三条结论汇总成一段话。只读不改。不要修改任何文件。',
  ].join(String.fromCharCode(10)),
  judge: judgeBy([
    { what: '三个部分都回答了', needles: ['plan.ts', 'gate.ts', 'tool.ts'] },
    { what: '节点种类', needles: ['worker', 'forker'] },
    { what: '调用参数原样透传', any: ['原样', '没有占位符', '不存在占位符', '字面量', '直接传'] },
    { what: '子代理限制的字段', needles: ['delegationDepth'] },
  ]),
}

/**
 * Every task, keyed by the name the runner takes.
 */
export const TASKS = { survey: SURVEY, chain: CHAIN, review: REVIEW, ...SCENARIOS, ...PUBLIC_TASKS, ...LHTB_TASKS, ...LHTB_NBODY_TASKS, ...LHTB_COMMIT0_TASKS, ...LHTB_MATPOWER_TASKS }

/**
 * Build a criterion checker from a list of requirements.
 *
 * @param {{what: string, needles: string[]}[]} requirements - what the answer must contain.
 * @returns {(answer: string) => {passed: number, total: number, missing: string[]}} the checker.
 */
function judgeBy(requirements) {
  return (answer) => {
    const haystack = answer.toLowerCase()
    const missing = []
    let passed = 0
    for (const requirement of requirements) {
      // `needles` must all appear; `any` is the alternative set — either form
      // counts, for a question that has several equally correct wordings.
      const hit = requirement.any !== undefined
        ? requirement.any.some(needle => haystack.includes(needle.toLowerCase()))
        : requirement.needles.every(needle => haystack.includes(needle.toLowerCase()))
      if (hit) {
        passed += 1
        continue
      }
      const needles = requirement.any ?? requirement.needles
      const absent = needles.filter(needle => !haystack.includes(needle.toLowerCase()))
      missing.push(`${requirement.what}(缺:${absent.join('/')})`)
    }
    return { passed, total: requirements.length, missing }
  }
}

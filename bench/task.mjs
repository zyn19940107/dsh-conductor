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

import { BIGREAD, COVERAGE, COVERAGEWIDE, DISCOVERY, FANOUT, MULTIHOP, SWEEP } from './scenarios.mjs'

/**
 * The scenario tasks that say where the plugin helps and where it does not.
 */
const SCENARIOS = { discovery: DISCOVERY, fanout: FANOUT, multihop: MULTIHOP, coverage: COVERAGE, coveragewide: COVERAGEWIDE, sweep: SWEEP, bigread: BIGREAD }

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
  ].join('\n'),
  judge: judgeBy([
    { what: 'src 下的 .ts 文件数(7)', needles: ['7'] },
    { what: 'verify 下的 spec 数(5)', needles: ['5'] },
    {
      what: 'src 里的每个文件名',
      needles: ['batch.ts', 'concurrency.ts', 'gate.ts', 'index.ts', 'plan.ts', 'policy.ts', 'tool.ts'],
    },
    {
      what: 'verify 里的每个 spec 名',
      needles: ['batch.spec.ts', 'concurrency.spec.ts', 'gate.spec.ts', 'plan.spec.ts', 'refine.spec.ts'],
    },
    { what: '定义 isConcurrencySafe 的文件', needles: ['concurrency.ts'] },
    { what: '提到 delegationDepth 的文件', needles: ['gate.ts'] },
  ]),
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
  ].join('\n'),
  judge: judgeBy([
    { what: '第一步的函数名', needles: ['buildWaves'] },
    { what: '元素类型名', needles: ['PlanNode'] },
    { what: '定义该类型的文件', needles: ['plan.ts'] },
    { what: '引用该类型的文件', needles: ['tool.ts'] },
  ]),
}

/**
 * A review whose three parts are independent enough to hand to children.
 *
 * @type {{text: string, judge: (answer: string) => {passed: number, total: number, missing: string[]}}}
 */
export const REVIEW = {
  text: [
    '分别独立审查 D:\\code\\vibe\\dsh-refine-loop 的三个部分,每部分给出结论:',
    '',
    '1. src/plan.ts —— 计划的数据结构长什么样?节点有哪三种?一个调用参数里的占位符用什么语法?',
    '2. src/gate.ts —— 这个插件的那条规则是什么?它的触发条件是什么?',
    '3. src/tool.ts —— 计划是怎么被跑起来的?派出去的子代理受到什么限制?',
    '',
    '最后把三条结论汇总成一段话。只读不改。不要修改任何文件。',
  ].join('\n'),
  judge: judgeBy([
    { what: '被审查的三个文件', needles: ['plan.ts', 'gate.ts', 'tool.ts'] },
    { what: '代理节点的类型名', needles: ['subagent_fork'] },
    { what: '占位符语法', needles: ['@@'] },
    { what: '子代理的深度限制靠哪个字段', needles: ['delegationDepth'] },
  ]),
}

/**
 * Every task, keyed by the name the runner takes.
 */
export const TASKS = { survey: SURVEY, chain: CHAIN, review: REVIEW, ...SCENARIOS }

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
      const hit = requirement.needles.every(needle => haystack.includes(needle.toLowerCase()))
      if (hit) {
        passed += 1
        continue
      }
      const absent = requirement.needles.filter(needle => !haystack.includes(needle.toLowerCase()))
      missing.push(`${requirement.what}(缺:${absent.join('/')})`)
    }
    return { passed, total: requirements.length, missing }
  }
}

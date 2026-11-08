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
    '分别独立审查 D:\\code\\vibe\\dsh-refine-loop 的三个部分,每部分给出结论:',
    '',
    '1. src/plan.ts —— 计划的数据结构长什么样?节点有哪几种?调用参数是怎么处理的?',
    '2. 这个插件强制的那条规则是什么?它在现在的代码里怎么实现、触发条件是什么?',
    '3. src/tool.ts —— 计划是怎么被跑起来的?派出去的子代理受到什么限制?',
    '',
    '最后把三条结论汇总成一段话。只读不改。不要修改任何文件。',
  ].join(String.fromCharCode(10)),
  judge: judgeBy([
    { what: '两处源码都回答了', needles: ['plan.ts', 'tool.ts'] },
    { what: '说清了规则现在住哪', needles: ['rounds.ts'] },
    { what: '节点种类', needles: ['worker', 'forker'] },
    { what: '调用参数原样透传', any: ['原样', '没有占位符', '不存在占位符', '字面量', '直接传'] },
    { what: '说清了触发条件', any: ['触发', '条件是', '条件:', '条件：', '何时', '什么时候'] },
    { what: '子代理限制的字段', needles: ['delegationDepth'] },
  ]),
}

/**
 * Every task, keyed by the name the runner takes.
 */
/**
 * A mechanism probe: does a node stop at its declared budget and report its state?
 *
 * The worker is asked to block for five minutes with a budget of twenty seconds.
 * If the mechanism works, the plan returns in well under a minute, the node's
 * output is the child's status report rather than a timeout with nothing in it,
 * and the blocked process is gone.
 */
export const BUDGET_PROBE = {
  text: [
    '这是一个机制验证任务，只做一件事：验证 spawner 节点的 budgetMs 到点后会被停下并要求报告现状。',
    '',
    '请交一张图，criteria 写「spawner 节点在 20 秒预算用尽时被停下并报告了现状」，nodes 原样照抄：',
    '{"id": "sleep", "kind": "spawner", "budgetMs": 20000,',
    ' "task": "用 pwsh 跑一条会阻塞 300 秒的命令：python -c \\"import time; time.sleep(300)\\"，命令结束后告诉我它的输出。"}',
    '',
    '等它回来之后，把 refine_plan 报告里 sleep 节点的 output 原样复述给我，',
    '并说明它是按时结束的还是被预算停下的。',
  ].join(String.fromCharCode(10)),
  judge: judgeBy([
    { what: '说清了预算到点停了节点', any: ['budget', '预算', '超时', 'time budget', '现状'] },
  ]),
}

/**
 * A probe for a background job that outlives the node that started it.
 *
 * The job is started through the plugin's `bg` tool, which registers it
 * unowned: no session owns it, so no session teardown cancels it and any
 * conversation may read it. The point under test is that the parent — a
 * different session from the one that started it — can still collect it with the
 * ordinary job_output tool once the node that started it is gone.
 */
export const BG_PROBE = {
  text: [
    '这是一个机制验证任务：验证插件起的后台任务不属于任何会话（unowned），所以启动它的节点结束后它还在跑，父代理能直接读它。',
    '',
    '请交一张图，criteria 写「tools 节点用 bg 起了一个后台任务，图返回后父代理能用 job_output 读到它的输出 BG-DONE-42」，nodes 原样照抄：',
    `{"id": "slow", "kind": "tools", "calls": [{"name": "bg", "arguments": {"command": "python -c \\"import time; time.sleep(12); print('BG-DONE-42')\\""}}]}`,
    '',
    '等这张图回来之后：',
    '1. 从报告里拿到 bg 返回的 job id；',
    '2. 用 job_output 读它（如果还没结束就再读一次），把输出原样复述给我；',
    '3. 说明这个 job 为什么父代理能读到。',
    '',
    '然后做第二件事，验证「节点被预算掐断时，它起的后台任务不会被杀」：',
    '4. 再交一张图，nodes 原样照抄下面这个（一个只有 15 秒预算的 worker，它起的命令要跑 45 秒）：',
    `{"id": "cut", "kind": "worker", "budgetMs": 15000, "task": "用 bg 工具起这条命令：python -c \\"import time; time.sleep(45); print('BG-CUT-77')\\"。起完立刻把 job 的 id 写进你的结论，不要等它跑完，也不要用别的工具去等它。"}`,
    '5. 这张图回来后（那个 worker 会被它的预算停下），用 job_output 读它报告的那个 job——可能要多读几次，直到输出出现——把输出复述给我，并说明这个后台任务有没有跟着 worker 一起被杀。',
  ].join(String.fromCharCode(10)),
  judge: judgeBy([
    { what: '读到了第一个后台任务的输出', any: ['BG-DONE-42'] },
    { what: 'worker 被预算停下后，它起的后台任务仍然跑完并被读到', any: ['BG-CUT-77'] },
  ]),
}

/**
 * A probe for a call that outlives its node's budget.
 *
 * The node's budget is 20 seconds; the call it must run blocks for 180. The
 * budget stops the driving at 20 seconds, but the call itself is already paid
 * for and must be allowed to return — killing it loses the one piece of evidence
 * the report exists to carry. So the worker keeps running to 180 seconds and only
 * then reports what the command printed.
 */
export const TOOL_PROBE = {
  text: [
    '这是一个机制验证任务，只做一件事：验证「工具调用跑到一半预算到期时，不杀工具，等它跑完再要报告」。',
    '',
    '请交一张图，criteria 写「worker 在 20 秒预算用尽后仍然等到命令跑完，并报告了命令的实际输出」，nodes 原样照抄：',
    '{"id": "slow", "kind": "worker", "budgetMs": 20000,',
    ` "task": "用 pwsh 跑这条命令，等它结束，然后把它的完整输出写进你的结论：python -c \\"import time; time.sleep(180); print('SLEPT 180')\\""}`,
    '',
    '等它回来之后，把 refine_plan 报告里 slow 节点的 output 原样复述给我，',
    '并说明它是在预算内完成中还是被预算打断的。',
  ].join(String.fromCharCode(10)),
  judge: judgeBy([
    { what: '报告里有命令跑完的证据', any: ['SLEPT 180'] },
  ]),
}

/**
 * A probe for running under a persisted goal.
 *
 * The harness keeps a session working across automatic continuation rounds while
 * a goal is open. This task asks the model to open one, do the work in the
 * plugin's rounds, and close it — so the two mechanisms are exercised together.
 */
/**
 * A probe for the nested-leader path.
 *
 * A "forker" is a child that is a leader itself: it inherits the conversation and
 * draws its own plans. That claim is only true if the plan tool is reachable from
 * inside a child, so this task hands a forker a job that must be done with
 * refine_plan and checks that the child actually drew one.
 */
/**
 * A probe for the nested-fan-out case.
 *
 * A "worker" cannot dispatch anyone, so a job that must be owned by one person
 * and split inside that person needs a leader node ("forker" or "spawner"). The
 * task says the ownership and the parallelism; it says nothing about which kind
 * to use, so what the model picks is the measurement.
 */
export const LEAD_PROBE = {
  text: [
    '这是一个机制验证任务：把一件事整包交给一个负责人，由他内部再分工。',
    '',
    '工作区：D:/code/vibe/dsh-refine-loop（只读，不要改文件）',
    '',
    '把下面这件事交给**同一个负责人**整体负责：',
    '  对 3 个互不相干的模块做并行审查：src/plan.ts、src/batch.ts、src/concurrency.ts',
    '  要求三份审查同时进行、互相独立、互不参考；',
    '  每个模块给出：它的职责、一个最容易被误用的地方（点出那个函数或字段的名字）、结论。',
    '  最后由他把三份结论汇总成一段话交给我。',
    '',
    '注意：这件事必须由**同一个负责人**整体负责 —— 你不能直接派三个互不相干的人，',
    '也不能自己一个个做。他内部再分几个、怎么分，由他自己决定。',
  ].join(String.fromCharCode(10)),
  judge: judgeBy([
    { what: '三个模块都提到了', needles: ['plan.ts', 'batch.ts', 'concurrency.ts'] },
    { what: '有汇总', any: ['综上', '汇总', '总结', '三段结论'] },
  ]),
}

export const FORKER_PROBE = {
  text: [
    '这是一个机制验证任务，只做一件事：验证 forker 节点里的子代理能不能自己画图。',
    '',
    '请交一张图，criteria 写「forker 子代理自己画了一张图并拿到 package.json 的 version」，nodes 原样照抄：',
    '{"id": "nested-lead", "kind": "forker", "budgetMs": 120000,',
    ' "task": "你是一个领导。请用 refine_plan 画一张图去查 D:/code/vibe/dsh-refine-loop/package.json 的 version 字段，',
    '图里用一个 tools 节点调 read 读这个文件。拿到结果后说出版本号，然后直接给结论。"}',
    '',
    '等它回来之后告诉我：它的节点输出里有没有提到版本号，它有没有自己画图。',
  ].join(String.fromCharCode(10)),
  judge: judgeBy([
    { what: '报出了版本号', any: ['2.4', '2.3'] },
    { what: '说清了它自己画图', any: ['画图', 'plan', '图'] },
  ]),
}

export const GOAL_PROBE = {
  text: [
    '请用 create_goal 建立一个持久目标，目标是：',
    '"读完 D:\\code\\vibe\\dsh-refine-loop 的 src/plan.ts 和 src/tool.ts，说明计划的数据结构和四种节点分别是什么，',
    '并给出 refine_plan 的执行入口在哪个文件哪个函数里。"',
    '',
    '要求：',
    '1. 先调用 create_goal 建立这个目标（不要只说不做）；',
    '2. 用 refine_plan 交图去完成它（图里带 budgetMs）；',
    '3. 结论写清楚之后，用 update_goal 把目标标记为 complete。',
    '',
    '只读不改。',
  ].join(String.fromCharCode(10)),
  judge: judgeBy([
    { what: '说清了计划的数据结构', needles: ['criteria', 'nodes'] },
    { what: '说清了四种节点', needles: ['tools', 'worker', 'forker'] },
    { what: '指出了执行入口', any: ['runPlan', 'tool.ts'] },
  ]),
}

export const TASKS = { goalprobe: GOAL_PROBE, forkerprobe: FORKER_PROBE, leadprobe: LEAD_PROBE,
  survey: SURVEY, chain: CHAIN, review: REVIEW, budgetprobe: BUDGET_PROBE, toolprobe: TOOL_PROBE, bgprobe: BG_PROBE, ...SCENARIOS, ...PUBLIC_TASKS, ...LHTB_TASKS, ...LHTB_NBODY_TASKS, ...LHTB_MATPOWER_TASKS }

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

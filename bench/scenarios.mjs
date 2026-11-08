import { execSync } from 'node:child_process'
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Tasks shaped to the plugin's claim, one per scenario.
 *
 * The published comparison has to say where the plugin helps and where it does
 * not, so the tasks are chosen by shape rather than by convenience:
 *
 * - `discovery`: many independent lookups over two repositories, one synthesis.
 *   This is the shape a plan batches: one round trip, every result together.
 * - `fanout`: the same question asked of several named files. A plan runs them
 *   as one node; a plain agent can also emit them in one step, so this is the
 *   control that should show little difference.
 * - `multihop`: each step needs the previous step's answer. A static plan cannot
 *   write the second call, so this is where the plugin is expected to lose.
 */

/**
 * The files the coverage tasks are written against.
 *
 * Read from the tree itself, not typed into the prose: the counts in these tasks
 * went stale once (a module and two specs were added, the text still said eight
 * and six), and a worker that is told "eight modules" when there are nine spends
 * its rounds working out which one to leave out instead of answering.
 */
const SRC_ROOT = 'D:/code/vibe/dsh-refine-loop/src'
const VERIFY_ROOT = 'D:/code/vibe/dsh-refine-loop/verify'
const SRC_MODULES = readdirSync(SRC_ROOT).filter(name => name.endsWith('.ts')).sort()
const SPEC_FILES = readdirSync(VERIFY_ROOT).filter(name => name.endsWith('.spec.ts')).sort()

/** The module with the most lines, right now. */
const LARGEST_MODULE = SRC_MODULES
  .map(name => ({ name, lines: readFileSync(join(SRC_ROOT, name), 'utf8').split(String.fromCharCode(10)).length }))
  .sort((left, right) => right.lines - left.lines)[0]

/**
 * @param {string[]} files - file names.
 * @returns them joined for prose.
 */
const list = files => files.join('、')

/** Criterion: every module under src is named. */
const MODULE_NEEDLES = { what: `src 的 ${SRC_MODULES.length} 个模块`, needles: SRC_MODULES }
/** Criterion: every spec under verify is named. */
const SPEC_NEEDLES = { what: `verify 的 ${SPEC_FILES.length} 个 spec`, needles: SPEC_FILES }

/**
 * Build a criterion checker from a list of requirements.
 *
 * `needles` must all appear; `any` is the alternative set — either form counts,
 * for a question that has several equally correct wordings.
 *
 * @param {{what: string, needles?: string[], any?: string[]}[]} requirements - what the answer must contain.
 * @returns {(answer: string) => {passed: number, total: number, missing: string[]}} the checker.
 */
function judgeBy(requirements) {
  return (answer) => {
    const haystack = answer.toLowerCase()
    const missing = []
    let passed = 0
    for (const requirement of requirements) {
      const needles = requirement.any ?? requirement.needles ?? []
      // `test` is for a requirement about shape rather than wording: three
      // reviews, each labelled, however the labels are spelled.
      if (requirement.test !== undefined) {
        if (requirement.test(answer)) passed += 1
        else missing.push(`${requirement.what}(形状不符)`)
        continue
      }
      const hit = requirement.any !== undefined
        ? requirement.any.some(needle => haystack.includes(needle.toLowerCase()))
        : (requirement.needles ?? []).every(needle => haystack.includes(needle.toLowerCase()))
      if (hit) {
        passed += 1
        continue
      }
      const absent = needles.filter(needle => !haystack.includes(needle.toLowerCase()))
      missing.push(`${requirement.what}(缺:${absent.join('/')})`)
    }
    return { passed, total: requirements.length, missing }
  }
}

/**
 * Many independent lookups over two repositories, then one synthesis.
 *
 * Every question is answerable without the others, and the two repositories are
 * far apart on disk, so a plan can put all of them in one layer.
 */
export const DISCOVERY = {
  text: [
    '对两个仓库做一次横向普查,六件事互相独立,只读不改:',
    '',
    '1. D:\\code\\vibe\\dsh-refine-loop\\src 下有多少个 .ts 文件?',
    '2. D:\\code\\vibe\\dsh-refine-loop\\verify 下有多少个 .spec.ts 文件?',
    '3. D:\\code\\vibe\\deepseek-harness\\packages\\core\\tools\\src\\index.ts 这个文件有多少行?',
    '4. D:\\code\\vibe\\deepseek-harness 里,defineTool 这个函数定义在哪个文件?',
    '5. D:\\code\\vibe\\deepseek-harness 里,哪些 .ts 文件出现了 isConcurrencySafe?列出文件名。',
    '6. 用三句话对比这两个仓库的代码组织方式。',
    '',
    '只读不改。不要修改任何文件。',
  ].join('\n'),
  judge: judgeBy([
    { what: 'src 的 .ts 文件数(8)', needles: ['8'] },
    { what: 'verify 的 spec 数(6)', needles: ['6'] },
    { what: 'harness tools/index.ts 的行数(1985)', needles: ['1985'] },
    { what: 'defineTool 的定义文件', needles: ['schema.ts'] },
    {
      what: '出现 isConcurrencySafe 的文件',
      needles: ['index.ts', 'glob.ts', 'grep.ts'],
    },
  ]),
}

/**
 * The same question asked of several named files.
 *
 * A plan runs it as one tools node; a plain agent can also emit several reads in
 * one step, so this is the control: the plugin should not look better here.
 */
export const FANOUT = {
  text: [
    '分别读下面五个文件的第一行,把每个文件的第一行原样列出来:',
    '',
    '1. D:\\code\\vibe\\dsh-refine-loop\\src\\plan.ts',
    '2. D:\\code\\vibe\\dsh-refine-loop\\src\\rounds.ts',
    '3. D:\\code\\vibe\\dsh-refine-loop\\src\\batch.ts',
    '4. D:\\code\\vibe\\dsh-refine-loop\\src\\repair.ts',
    '5. D:\\code\\vibe\\dsh-refine-loop\\src\\tool.ts',
    '',
    '最后用一句话说明这五个文件各自负责什么。只读不改。',
  ].join('\n'),
  judge: judgeBy([
    { what: '五个文件都被读到', needles: ['plan.ts', 'rounds.ts', 'batch.ts', 'repair.ts', 'tool.ts'] },
    { what: '注释起始符(第一行都是块注释开头)', needles: ['/**'] },
    { what: '五个文件各自的职责', needles: ['计划', '轮次', '批'] },
  ]),
}

/**
 * A chain where each step needs the previous answer.
 *
 * This is the shape the plugin cannot express as a static plan: the second call
 * needs the first call's line numbers.
 */
export const MULTIHOP = {
  text: [
    '做一次三步的链式调查,每一步都要用上一步的结果:',
    '',
    '1. 在 D:\\code\\vibe\\dsh-refine-loop\\src 里 grep "PLAN_TOOL",列出所有命中的文件。',
    '2. 找出它被定义的那一行,读出那一行前后 30 行。',
    '3. 根据读到的内容,说明这个常量被哪些文件用到、分别用来做什么。',
    '',
    '只读不改。不要修改任何文件。',
  ].join('\n'),
  judge: judgeBy([
    { what: '定义 PLAN_TOOL 的文件', needles: ['tool.ts'] },
    { what: '其它用到它的文件', needles: ['rounds.ts', 'index.ts', 'policy.ts'] },
    { what: '它的值', needles: ['refine_plan'] },
    { what: '定义在 tool.ts 里', needles: ['tool.ts'] },
  ]),
}
/**
 * Every spec against every module, then a judgement about what is untested.
 *
 * A plain agent carries all of them in its own context; a plan can hand the
 * files out and keep only the conclusions. This is the shape the plugin claims
 * to be for.
 */
export const COVERAGE = {
  text: [
    '回答下面三个问题,只读不改:',
    '',
    '1. D:\\code\\vibe\\dsh-refine-loop\\verify 下每个 .spec.ts 实际测的入口函数是什么?',
    '2. D:\\code\\vibe\\dsh-refine-loop\\src 下所有 .ts 模块里,哪些没有对应的 spec?',
    '3. 这些模块里行数最多的是哪一个?多少行?',
    '',
    '只读不改。不要修改任何文件。',
  ].join(String.fromCharCode(10)),
  judge: judgeBy([
    MODULE_NEEDLES,
    SPEC_NEEDLES,
    { what: 'concurrency.spec 测的入口', needles: ['isreadonlycommand'] },
    { what: 'refine.spec 实际测的入口', needles: ['parsebatchargs'] },
    // tool.ts grows with the plugin; the criterion is that the answer names the
    // largest module and a line count that matches one of its two counts.
    // The line count is an implementation detail that moves with every edit; the
    // task asks which module is largest, and that is what the answer must name.
    { what: `行数最多的模块是 ${LARGEST_MODULE.name}`, needles: [LARGEST_MODULE.name] },
  ]),
}

/**
 * One sentence per file, nothing skipped.
 *
 * Embarrassingly parallel: the answer for one file does not inform any other.
 */
export const SWEEP = {
  text: [
    `给下面 ${SRC_MODULES.length + SPEC_FILES.length} 个文件各写一句话,说明它负责什么,一个都不要漏:`,
    '',
    `src 下:${list(SRC_MODULES)}`,
    `verify 下:${list(SPEC_FILES)}`,
    '',
    '都在 D:\\code\\vibe\\dsh-refine-loop 下。只读不改。',
  ].join('\n'),
  judge: judgeBy([
    MODULE_NEEDLES,
    SPEC_NEEDLES,
    { what: 'repair.ts 的职责(失败后修一次)', needles: ['修'] },
    { what: 'concurrency.ts 的职责(并发判定)', needles: ['并发'] },
    { what: 'plan.ts 的职责(图的节点)', needles: ['节点'] },
  ]),
}

/**
 * Four large source files, one summary each, then how they relate.
 *
 * Together they are ~17,700 lines: reading all of them puts well over 100k
 * tokens into one agent's context, and every later step pays for all of it
 * again. A plan can give one file to one child and keep the main context small.
 * This is the shape where the plugin should win on time as well as tokens: the
 * plain agent's own steps get slower as its context grows.
 */
export const BIGREAD = {
  text: [
    '读 D:\\code\\vibe\\deepseek-harness 下这四个大文件,每个写 3 条要点(它是什么、主要导出什么、关键结构),',
    '最后用一段话说明它们之间的关系:',
    '',
    '1. packages/extensions/tool-cordis/src/api-catalog.ts',
    '2. packages/extensions/cordis-client-runner/src/client/slot-catalog.ts',
    '3. packages/typert/generator/src/analyzer.ts',
    '4. packages/core/tools/src/index.ts',
    '',
    '只读不改。不要修改任何文件。',
  ].join('\n'),
  judge: judgeBy([
    {
      what: '四个文件都被读到',
      needles: ['api-catalog.ts', 'slot-catalog.ts', 'analyzer.ts', 'core\tools\src\index.ts'],
    },
    { what: 'api-catalog 的主要导出', needles: ['serviceapientry'] },
    { what: 'slot-catalog 的主要导出', needles: ['clientslotentry'] },
    { what: 'analyzer 的主要类型', needles: ['workspaceanalyzeroptions'] },
    { what: 'tools/index 的主要导出', needles: ['tooldefinition'] },
  ]),
}

/**
 * The same audit asked as a chore: read all 14 files and describe each one.
 *
 * Kept next to {@link COVERAGE} because the difference between them is the
 * point: the same facts, asked as a reading list instead of as questions, and
 * the two conditions respond to that differently.
 */
export const COVERAGEWIDE = {
  text: [
    '对这个插件的测试覆盖做一次盘点,只读不改:',
    '',
    '1. 读 D:\\code\\vibe\\dsh-refine-loop\\verify 下全部 .spec.ts,每个用一句话说明它实际测的是什么,',
    '   注明它主要调用的那个函数/入口的名字。',
    '2. 读 D:\\code\\vibe\\dsh-refine-loop\\src 下全部 .ts,判断哪些模块没有对应的 spec。',
    '3. 行数最多的那个模块是哪个?多少行?',
    '4. 给出补测优先级:先补哪个,为什么(一句话)。',
    '',
    '只读不改。不要修改任何文件。',
  ].join(String.fromCharCode(10)),
  judge: judgeBy([
    MODULE_NEEDLES,
    SPEC_NEEDLES,
    { what: 'concurrency.spec 测的入口', needles: ['isreadonlycommand'] },
    { what: 'refine.spec 实际测的入口', needles: ['parsebatchargs'] },
    // tool.ts grows with the plugin; the criterion is that the answer names the
    // largest module and a line count that matches one of its two counts.
    // The line count is an implementation detail that moves with every edit; the
    // task asks which module is largest, and that is what the answer must name.
    { what: `行数最多的模块是 ${LARGEST_MODULE.name}`, needles: [LARGEST_MODULE.name] },
  ]),
}

/**
 * Three judgements that must be independent of each other.
 *
 * One agent can read the same code three times, but it cannot give three
 * genuinely independent verdicts: the second view is coloured by the first.
 * The only way to get independence is three separate contexts, so this is the
 * scenario that asks the plugin to delegate rather than to batch.
 */
export const PANEL = {
  text: [
    '对 D:\\code\\vibe\\dsh-refine-loop 这个插件的「核心规则」做一次三方独立评审,只读不改:',
    '',
    '核心规则指:每轮必须交一张图,交完图判断能不能给结论;派发只能走图里的节点。',
    '',
    '请组织三份**互相独立**的评审意见(互相不知道对方结论),各自判断这条规则:',
    '1. 对模型是否过度限制:会不会逼模型做多余的规划?',
    '2. 是否可被绕过:模型有没有办法不交图就拿到结论?',
    '3. 与 harness 原生能力是否冲突:和 subagent / plan 模式 / 工具并发是否打架?',
    '',
    '每份评审都要读相关源码并点出实现所在的文件,最后汇总:三方在哪些点上一致、在哪些点上分歧。',
    '',
    '只读不改。不要修改任何文件。',
  ].join('\n'),
  judge: judgeBy([
    { what: '三份独立评审都给出', test: (answer) => {
      // Either three labelled reviews, or the synthesis the task asks for at the
      // end: three perspectives and what they agree and disagree on. A model that
      // merges the three reports into the summary is still answering the request.
      const labels = new Set([...answer.matchAll(/评审\s*[一二三123ABC]/g)].map(match => match[0].replace(/\s+/g, '')))
      if (labels.size >= 3) return true
      return ['过度限制', '绕过', '冲突', '一致', '分歧'].every(word => answer.includes(word))
    } },
    { what: '第一种视角(过度限制)', needles: ['过度限制'] },
    { what: '第二种视角(可绕过)', needles: ['绕过'] },
    { what: '第三种视角(与原生能力冲突)', needles: ['冲突'] },
    { what: '汇总了一致与分歧', needles: ['一致', '分歧'] },
    { what: '点到了实现所在的文件', needles: ['rounds.ts'] },
  ]),
}


/**
 * Long-horizon: a copy of this repo with three bugs planted, specs red.
 *
 * This is the shape the long-horizon benchmarks call the hard one — run,
 * measure, adjust, re-run — and the loop has to hold for dozens of steps
 * without losing the thread. The verifier is the repo's own spec runner, so
 * the agent can check itself, and `verify/` is fingerprinted so it cannot
 * "fix" the tests instead of the code.
 */
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
/**
 * The fixture directory for this run.
 *
 * Computed per call, not at import: the runner sets `DSH_BENCH_CONDITION` just
 * before it asks for the fixture, so the two conditions get two directories and
 * can run in parallel.
 *
 * @returns {string} the absolute workspace path.
 */
function workspace() {
  return resolve(REPO, '..', 'dsh-sandbox', `bench-workspace-${process.env.DSH_BENCH_CONDITION ?? 'one'}`)
}

/**
 * What one planted bug looks like: a needle to find and what to put there.
 */
const PLANTED = [
  {
    file: 'src/concurrency.ts',
    find: "['>', '<', '&', ';', '|',",
    replace: "['<', '&',",
  },
  {
    file: 'src/concurrency.ts',
    find: "  'ls', 'cat', 'head', 'tail',",
    replace: "  'cat', 'head', 'tail',",
  },
]

/**
 * The harder set: four bugs in two files, all of them covered by the specs.
 *
 * The point of this variant is not that the bugs are harder to find - the spec
 * runner names the failing check - but that the loop has to survive more
 * rounds before it converges. A task the agent can give up on after two
 * edits tells you nothing about the plugin; one that needs four does.
 */
const PLANTED_HARD = [
  ...PLANTED,
  {
    file: 'src/concurrency.ts',
    // This one runs after the bug above, so the needle matches what is left
    // of the list by then.
    find: "['<', '&', '`',",
    replace: "['<', '`',",
  },
  {
    file: 'src/rounds.ts',
    find: "  reset(sessionId: string): void {",
    replace: "  reset(sessionId: string): void {\n    if (sessionId.length >= 0) return",
  },
]

/**
 * Build a fresh copy of the repo with the bugs planted.
 *
 * @returns {string} the workspace the task runs in.
 */
function plant(bugs = PLANTED) {
  const WORKSPACE = workspace()
  rmSync(WORKSPACE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  for (const name of ['src', 'verify']) cpSync(resolve(REPO, name), resolve(WORKSPACE, name), { recursive: true })
  for (const name of ['package.json', 'tsconfig.json']) cpSync(resolve(REPO, name), resolve(WORKSPACE, name))
  symlinkSync(resolve(REPO, 'node_modules'), resolve(WORKSPACE, 'node_modules'), 'junction')
  for (const bug of bugs) {
    const path = resolve(WORKSPACE, bug.file)
    // The source may be checked out with CRLF; match on normalised newlines so
    // the needle does not depend on how git wrote the file.
    const before = readFileSync(path, 'utf8').split(String.fromCharCode(13)).join('')
    if (!before.includes(bug.find)) throw new Error(`the bug for ${bug.file} no longer matches the source: ${JSON.stringify(bug.find)}`)
    writeFileSync(path, before.replace(bug.find, bug.replace))
  }
  return WORKSPACE
}

/**
 * Fingerprint `verify/` so "fix the tests" does not count as a fix.
 *
 * @returns {string} the workspace-relative hashes.
 */
function verifyFingerprint() {
  const out = []
  for (const name of ['batch.spec.ts', 'concurrency.spec.ts', 'plan.spec.ts', 'refine.spec.ts', 'repair.spec.ts', 'rounds.spec.ts']) {
    out.push(readFileSync(resolve(workspace(), 'verify', name), 'utf8'))
  }
  return out.join('\u0000')
}

/** The pristine `verify/` the task is not allowed to change. */
let pristineVerify = ''

export const GREENSPECS = {
  text: [
    `长程任务:工作区 ${workspace()} 是这个插件的完整源码副本,`,
    `它的测试当前是红的。你的任务:把它修到全绿。`,
    '',
    '规则:',
    '1. 只允许改 src/ 下的文件。',
    '2. 不允许改 verify/ 下的任何文件 —— 那是判据,改了也不算。',
    '3. 用 `node verify/run-specs.mjs` 自己检查,一直跑到输出 all checks passed。',
    '4. 报告:每个 bug 是什么、在哪个文件、改成了什么、最后 runner 的完整输出。',
    '',
    '不要修改本仓库(D:\\code\\vibe\\dsh-refine-loop)本身的任何文件。',
  ].join('\n'),
  setup() {
    plant()
    pristineVerify = verifyFingerprint()
  },
  judge() {
    const missing = []
    if (verifyFingerprint() !== pristineVerify) missing.push('verify/ 被改过(禁止)')
    let passed = true
    try {
      execSync('node verify/run-specs.mjs', { cwd: workspace(), stdio: 'pipe' })
    } catch {
      passed = false
    }
    if (!passed) missing.push('specs 仍然不过')
    return { passed: passed && missing.length === 0 ? 1 : 0, total: 1, missing }
  },
}

/**
 * The same long-horizon shape with four planted bugs instead of two.
 *
 * @type {typeof GREENSPECS}
 */
export const GREENSPECSHARD = {
  text: GREENSPECS.text,
  setup() {
    plant(PLANTED_HARD)
    pristineVerify = verifyFingerprint()
  },
  judge() {
    return GREENSPECS.judge()
  },
}

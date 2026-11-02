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
    '2. D:\\code\\vibe\\dsh-refine-loop\\src\\gate.ts',
    '3. D:\\code\\vibe\\dsh-refine-loop\\src\\batch.ts',
    '4. D:\\code\\vibe\\dsh-refine-loop\\src\\repair.ts',
    '5. D:\\code\\vibe\\dsh-refine-loop\\src\\tool.ts',
    '',
    '最后用一句话说明这五个文件各自负责什么。只读不改。',
  ].join('\n'),
  judge: judgeBy([
    { what: '五个文件都被读到', needles: ['plan.ts', 'gate.ts', 'batch.ts', 'repair.ts', 'tool.ts'] },
    { what: '注释起始符(第一行都是块注释开头)', needles: ['/**'] },
    { what: '五个文件各自的职责', needles: ['计划', '规则', '批'] },
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
    { what: '其它用到它的文件', needles: ['gate.ts', 'index.ts', 'policy.ts'] },
    { what: '它的值', needles: ['refine_plan'] },
    { what: '定义在第 45 行', needles: ['45'] },
  ]),
}
/**
 * Six specs against eight modules, then a judgement about what is untested.
 *
 * Reading all fourteen files is ~3,600 lines. A plain agent carries every one of
 * them in its own context; a plan can hand the files out and keep only the
 * conclusions. This is the shape the plugin claims to be for.
 */
export const COVERAGE = {
  text: [
    '回答下面三个问题,只读不改:',
    '',
    '1. D:\code\vibe\dsh-refine-loop\verify 下每个 .spec.ts 实际测的入口函数是什么?',
    '2. D:\code\vibe\dsh-refine-loop\src 下 8 个模块里,哪些没有对应的 spec?',
    '3. 这些模块里行数最多的是哪一个?多少行?',
    '',
    '只读不改。不要修改任何文件。',
  ].join(String.fromCharCode(10)),
  judge: judgeBy([
    { what: 'src 的八个模块', needles: ['batch.ts', 'concurrency.ts', 'gate.ts', 'index.ts', 'plan.ts', 'policy.ts', 'repair.ts', 'tool.ts'] },
    { what: 'verify 的六个 spec', needles: ['batch.spec.ts', 'concurrency.spec.ts', 'gate.spec.ts', 'plan.spec.ts', 'refine.spec.ts', 'repair.spec.ts'] },
    { what: 'concurrency.spec 测的入口', needles: ['isreadonlycommand'] },
    { what: 'refine.spec 实际测的入口', needles: ['parsebatchargs'] },
    { what: '行数最多的模块(632 行)', needles: ['632'] },
  ]),
}

/**
 * One sentence per file, fourteen files, nothing skipped.
 *
 * Embarrassingly parallel: the answer for one file does not inform any other.
 */
export const SWEEP = {
  text: [
    '给下面 14 个文件各写一句话,说明它负责什么,一个都不要漏:',
    '',
    'src 下:batch.ts、concurrency.ts、gate.ts、index.ts、plan.ts、policy.ts、repair.ts、tool.ts',
    'verify 下:batch.spec.ts、concurrency.spec.ts、gate.spec.ts、plan.spec.ts、refine.spec.ts、repair.spec.ts',
    '',
    '都在 D:\code\vibe\dsh-refine-loop 下。只读不改。',
  ].join('\n'),
  judge: judgeBy([
    { what: 'src 的八个模块', needles: ['batch.ts', 'concurrency.ts', 'gate.ts', 'index.ts', 'plan.ts', 'policy.ts', 'repair.ts', 'tool.ts'] },
    { what: 'verify 的六个 spec', needles: ['batch.spec.ts', 'concurrency.spec.ts', 'gate.spec.ts', 'plan.spec.ts', 'refine.spec.ts', 'repair.spec.ts'] },
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
    '读 D:\code\vibe\deepseek-harness 下这四个大文件,每个写 3 条要点(它是什么、主要导出什么、关键结构),',
    '最后用一段话说明它们之间的关系:',
    '',
    '1. packages\extensions\tool-cordis\src\api-catalog.ts',
    '2. packages\extensions\cordis-client-runner\src\client\slot-catalog.ts',
    '3. packages\typert\generator\src\analyzer.ts',
    '4. packages\core\tools\src\index.ts',
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
    '1. 读 D:\code\vibe\dsh-refine-loop\verify 下全部 6 个 .spec.ts,每个用一句话说明它实际测的是什么,',
    '   注明它主要调用的那个函数/入口的名字。',
    '2. 读 D:\code\vibe\dsh-refine-loop\src 下全部 8 个 .ts,判断哪些模块没有对应的 spec。',
    '3. 行数最多的那个模块是哪个?多少行?',
    '4. 给出补测优先级:先补哪个,为什么(一句话)。',
    '',
    '只读不改。不要修改任何文件。',
  ].join(String.fromCharCode(10)),
  judge: judgeBy([
    { what: 'src 的八个模块', needles: ['batch.ts', 'concurrency.ts', 'gate.ts', 'index.ts', 'plan.ts', 'policy.ts', 'repair.ts', 'tool.ts'] },
    { what: 'verify 的六个 spec', needles: ['batch.spec.ts', 'concurrency.spec.ts', 'gate.spec.ts', 'plan.spec.ts', 'refine.spec.ts', 'repair.spec.ts'] },
    { what: 'concurrency.spec 测的入口', needles: ['isreadonlycommand'] },
    { what: 'refine.spec 实际测的入口', needles: ['parsebatchargs'] },
    { what: '行数最多的模块(632 行)', needles: ['632'] },
  ]),
}

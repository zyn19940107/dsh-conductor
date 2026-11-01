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
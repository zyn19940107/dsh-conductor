/**
 * The benchmark task and its correctness criterion.
 *
 * One task, run in two conditions. The task is deliberately made of several
 * independent investigations plus one synthesis that depends on them, because
 * that is the shape this plugin claims to change: the stock loop takes one
 * step per investigation, a plan takes one step for all of them.
 */

/** The prompt both conditions receive. */
export const TASK = [
  '对 D:\\code\\vibe\\dsh-refine-loop 这个插件做一次体检,回答下面五件事:',
  '',
  '1. src 目录下有多少个 .ts 文件?分别叫什么名字?',
  '2. verify 目录下有多少个 .spec.ts 文件?分别叫什么名字?',
  '3. 哪些文件里出现了 "isConcurrencySafe"?',
  '4. 哪些文件里出现了 "delegationDepth"?',
  '5. 根据上面四项的发现,用两三句话评价这个插件的架构。',
  '',
  '只读不改。不要修改任何文件。',
].join('\n')

/**
 * What a correct answer has to contain.
 *
 * Each entry names the thing the answer must mention. The checker only asks
 * "is this in the answer", never "does the answer read well" — a criterion
 * nobody can disagree about is the only one that survives being published.
 */
export const REQUIRED = [
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
]

/**
 * Judge one answer against the criterion.
 *
 * @param {string} text - the final assistant text.
 * @returns {{passed: number, total: number, missing: string[]}} what was met and what was not.
 */
export function judge(text) {
  const haystack = text.toLowerCase()
  const missing = []
  let passed = 0
  for (const requirement of REQUIRED) {
    const hit = requirement.needles.every(needle => haystack.includes(needle.toLowerCase()))
    if (hit) {
      passed += 1
      continue
    }
    const found = requirement.needles.filter(needle => haystack.includes(needle.toLowerCase()))
    const absent = requirement.needles.filter(needle => !found.includes(needle))
    missing.push(`${requirement.what}(缺:${absent.join('/')})`)
  }
  return { passed, total: REQUIRED.length, missing }
}

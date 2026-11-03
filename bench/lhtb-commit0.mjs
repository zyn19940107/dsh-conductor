/**
 * The LHTB commit0-multilib task, run locally.
 *
 * `silrlab/commit0-multilib-tdd` is a long-horizon design task from
 * Long-Horizon Terminal-Bench: three real Python libraries are stubbed out
 * (every function body raises NotImplementedError), the grading test suites
 * are withheld, and the agent has to reimplement all three from their
 * docstrings and docs -- writing its own tests as it goes. The reward is the
 * fraction of a hidden union of the three real suites (784 tests) that pass.
 *
 * It is the shape that suits delegation: three independent libraries, three
 * independent documents, three independent test suites. Nothing about one
 * library depends on another, so the work splits.
 *
 * The task's assets live outside this repository, in the sandbox:
 *
 *   D:\code\vibe\dsh-sandbox\lhtb\commit0\
 *     template\        the workspace: three stubbed libraries + docs + gate.py
 *     hidden-tests\    the upstream test suites, overlaid at grading time
 *     pristine-manifest.json  sha256 of the pristine upstream sources
 *     judge_commit0.py the grader: pytest over the hidden suites, plus a
 *                       check for files copied verbatim from upstream
 *     reference\       the pristine sources: the probe's "correct answer"
 *
 * Upstream seals the network so the agent cannot fetch the real libraries and
 * copy them in. This machine cannot seal it, so the judge checks instead:
 * every file of the agent's implementation is compared against the sha256
 * manifest, and a byte-identical file means the implementation was copied, not
 * written -- which voids the reward, the same way upstream's guard does.
 */

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const ASSETS = process.env.DSH_COMMIT0_ASSETS ?? resolve(REPO, '..', 'dsh-sandbox', 'lhtb', 'commit0')
// The hidden suites and the upstream sources live in an opaque directory: the
// agent explores the sandbox, and the answer must not be lying around there.
const ORACLE = process.env.DSH_COMMIT0_ORACLE ?? resolve(REPO, '..', 'dsh-sandbox', '.oracle-9c41')

/**
 * The wall-clock budget of one run.
 *
 * Upstream gives the agent five hours (and an expert eight). Here the budget
 * is thirty minutes, which is the point: the agent gets a slice of the work
 * done, and what it manages to finish is what the hidden suite scores.
 */
const TIME_BUDGET_MS = 1800000

/**
 * The fixed denominator: the upstream suite has this many tests in total.
 */
const EXPECTED_TOTAL = 784

/**
 * The fixture directory for one run.
 *
 * @returns {string} the absolute workspace path.
 */
function workspace() {
  const suffix = process.env.DSH_BENCH_SUFFIX ?? 'lhtbcommit0'
  return resolve(REPO, '..', 'dsh-sandbox', `bench-workspace-${process.env.DSH_BENCH_CONDITION ?? 'one'}-${suffix}`)
}

/**
 * The commit0 task from Long-Horizon Terminal-Bench, run locally.
 */
export const LHTB_COMMIT0 = {
  name: 'lhtb-commit0',
  text: [],
  timeoutMs: TIME_BUDGET_MS,
  setup() {
    process.env.DSH_BENCH_SUFFIX = 'lhtbcommit0'
    const ws = workspace()
    const template = resolve(ASSETS, 'template')
    if (!existsSync(template)) {
      throw new Error(`the LHTB assets are missing: ${template}`)
    }
    rmSync(ws, { recursive: true, force: true })
    mkdirSync(ws, { recursive: true })
    cpSync(template, ws, { recursive: true })
    // The container had PYTHONPATH pointing at the three library roots; the
    // agent's shell needs the same, or `import tinydb` does not work at all.
    const roots = ['libs/tinydb', 'libs/sortedcontainers', 'libs/cachetools/src']
      .map(relative => resolve(ws, relative))
    this.env = {
      PYTHONPATH: [...roots, process.env.PYTHONPATH].filter(Boolean).join(';'),
      PYTHONDONTWRITEBYTECODE: '1',
    }
    this.text = [
      `公开评测集长程任务(LHTB 的 silrlab/commit0-multilib-tdd,改编到本机):工作区 ${ws}`,
      '',
      '你要**从零实现三个真实的 Python 库**。每个函数体都被换成了',
      '`raise NotImplementedError(...)` —— 签名、类型标注、装饰器、类结构、**docstring 全都还在**。',
      '每个库还带着自己的 README 和 docs/。你要按文档把它们实现出来,而且**测试也得你自己写**。',
      '',
      '| 库 | 导入名 | 源码目录 | 文档 |',
      '|---|---|---|---|',
      '| TinyDB(文档数据库) | `tinydb` | `libs/tinydb/tinydb/` | `libs/tinydb/README.rst`,`libs/tinydb/docs/` |',
      '| sortedcontainers(有序 list/dict/set) | `sortedcontainers` | `libs/sortedcontainers/sortedcontainers/` | `libs/sortedcontainers/README.rst`,`docs/` |',
      '| cachetools(缓存 + 装饰器) | `cachetools` | `libs/cachetools/src/cachetools/` | `libs/cachetools/README.rst`,`docs/` |',
      '',
      '三个库都已经可以导入(PYTHONPATH 已经配好),你改源码立刻生效。',
      '',
      '## 重要:没有评测用例给你',
      '',
      '这是一道**规格驱动 + 测试驱动**的题。你看不到评分用的测试套件,只能从 **docstring 和文档**',
      '里读懂每个库的行为,**自己写测试**把行为钉死,然后实现到自己的测试全过。',
      '',
      '## 工作流(TDD)',
      '',
      '1. **先写测试。** 在 `mytests/` 下建一套完整的 `pytest`(`test_*.py`),把三个库的文档行为',
      '   都编码进去:正常情况、**边界情况、不变量、错误路径**(比如 sortedcontainers 的顺序保证与',
      '   `bisect`/索引语义;cachetools 的 LRU/LFU/TTL 淘汰顺序;tinydb 的 query/upsert/存储语义)。',
      '   **测试要写得尽量狠、尽量全** —— 它是你唯一的正确性信号。',
      '2. **实现到你的测试全过。**',
      '3. **检查就绪:** 跑 `python gate.py`,它打印 `READY` 才算三个检查都过了:',
      '   - 完整性:没有函数还 `raise NotImplementedError`,三个库都能导入',
      '     (`python progress.py` 单独看这个);',
      '   - 你自己的测试全过;',
      '   - 覆盖率:你的测试对三个包的**分支覆盖率 ≥ 90%**(浅测试做不到,必须真的走到代码路径)。',
      '',
      '`gate.py` 打印 READY 之前不要停。它只衡量"你自己的测试过不过、够不够全",不保证你理解对了。',
      '',
      '## 你是怎么被打分的',
      '',
      '- 你停下之后,一套**隐藏**的测试会跑你的代码(三个库自己的真实测试套件,一共 784 个测试)。你看不到它们。',
      '- 你的得分 = **这 784 个测试里通过的比例**(部分给分)。',
      '- 你自己的测试写得越狠越全,你抓到的 bug 越多,隐藏套件上的分数就越接近你自己的测试分数。',
      '  测试太弱 → 假自信 → 隐藏分数低。',
      '',
      '## 建议的打法',
      '',
      '- 有些辅助函数在 import 时就会跑,所以一个库在那些函数写完之前根本 import 不了。',
      '  先让每个库能 import(`python progress.py` 会显示 import 错误),再三个库breadth-first 地推。',
      '- 认真读 docstring 和 docs/ —— 行为、边界、不变量都在里面。把每一条写下来的保证都变成一个测试。',
      '- 循环:加测试 → 实现 → `python gate.py` → 修失败、把覆盖率提上去。直到打印 READY 再停。',
      '',
      '## 规则',
      '',
      `1. 时间预算 ${String(Math.round(TIME_BUDGET_MS / 60000))} 分钟。到了就停 —— 打分看的是预算内`,
      '   源码的样子,所以别把时间全花在准备上。',
      '2. 三个库互不相干。想怎么分工就怎么分工 —— 评分只看最后源码通过了多少测试。',
      '3. 不要改 `gate.py` / `progress.py`,也不要把自己的测试塞进 `libs/*/tests/`(那是隐藏套件的位置)。',
      '4. 报告:每个库做到什么程度(自己测试的通过情况、覆盖率)、最后 `gate.py` 的输出、以及三个库',
      '   各自的剩余工作清单。',
      '',
      `不要修改本仓库(${REPO})本身的任何文件。`,
    ].join('\n')
  },
  judge() {
    const ws = workspace()
    const missing = []
    const judge = resolve(ASSETS, 'judge_commit0.py')
    if (!existsSync(judge)) {
      return { passed: 0, total: EXPECTED_TOTAL, missing: ['判据脚本不存在'], score: 0 }
    }
    let out = ''
    try {
      out = execFileSync('python', [judge, ws, resolve(ORACLE, 'hidden-tests'),
        resolve(ASSETS, 'pristine-manifest.json'), resolve(ASSETS, 'stubbed-files.json'),
        resolve(ASSETS, 'pristine-bodies.json')],
      { encoding: 'utf8', stdio: 'pipe', timeout: 1800000, maxBuffer: 16 * 1024 * 1024 })
    } catch (error) {
      out = String(error.stdout ?? '')
      missing.push('判据脚本跑不起来')
    }
    let report
    try {
      report = JSON.parse(out.trim().split('\n').pop() ?? '{}')
    } catch {
      report = {}
    }
    const copied = report.copied_from_upstream ?? {}
    const perLibrary = report.per_library ?? {}
    const raw = report.reward ?? 0

    // Upstream seals the network, so the agent cannot fetch the real libraries
    // and copy them in. This machine cannot seal it (a proxy does not stop a
    // model that knows --noproxy), so the judge *detects* the copy instead and
    // reports both numbers:
    //   score      the raw reward, upstream's reward: the fraction of the 784
    //              hidden tests the final code passes;
    //   voidedScore the same fraction with the copied libraries dropped, i.e.
    //              what the agent wrote itself.
    // Both arms meet the same conditions, so the comparison holds either way.
    let voidedPassed = report.total_passed ?? 0
    for (const [label, hits] of Object.entries(copied)) {
      const entry = perLibrary[label]
      const voided = entry?.passed ?? 0
      voidedPassed -= voided
      if (entry) entry.passed = 0
      missing.push(`${label} 抄了上游源码(${hits.length} 个文件,自写分里这库不计)`)
    }
    const voidedScore = Math.max(0, Math.min(1, voidedPassed / EXPECTED_TOTAL))
    for (const [label, entry] of Object.entries(perLibrary)) {
      const got = entry.passed ?? 0
      const want = entry.expected ?? 0
      if (got < want && !copied[label]) {
        missing.push(`${label} ${got}/${want}`)
      }
    }
    return {
      passed: report.total_passed ?? 0,
      total: EXPECTED_TOTAL,
      missing,
      score: raw,
      rawScore: raw,
      voidedScore,
      copied: Object.keys(copied),
      perLibrary,
    }
  },
}

/**
 * The same task with a much tighter budget.
 *
 * Three libraries cannot be implemented one after the other in twelve
 * minutes, but they can be implemented in parallel by three children. This
 * is the shape where delegation is not an optimisation but the difference
 * between finishing and not finishing - the same shape upstream's long-horizon
 * tasks have, where the score is the peak the agent reached before its
 * deadline cut it off.
 *
 * @type {typeof LHTB_COMMIT0}
 */
export const LHTB_COMMIT0_TIGHT = {
  ...LHTB_COMMIT0,
  name: 'lhtb-commit0-tight',
  timeoutMs: 720000,
  setup() {
    // Its own workspace, so the two variants never share a directory.
    process.env.DSH_BENCH_SUFFIX = 'lhtbcommit0tight'
    LHTB_COMMIT0.setup()
    this.text = LHTB_COMMIT0.text
      .replace(`${String(TIME_BUDGET_MS / 60000)} 分钟`, '12 分钟')
      .replace('把三个库都实现完', '在 12 分钟里尽量多实现一个库')
  },
}

export const LHTB_COMMIT0_TASKS = {
  'lhtb-commit0': LHTB_COMMIT0,
  'lhtb-commit0-tight': LHTB_COMMIT0_TIGHT,
}

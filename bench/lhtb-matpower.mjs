/**
 * The LHTB MATPOWER/PYPOWER audit task, run locally.
 *
 * `silrlab/matpower-opf-regression` is a long-horizon task from
 * Long-Horizon Terminal-Bench: the agent implements an audit pipeline that
 * runs an AC power flow, a DC OPF and an AC OPF over every case in a
 * manifest, and writes a set of deterministic reports whose column names and
 * conventions are part of the specification. The verifier reruns PYPOWER on
 * public *and* hidden manifests and compares the reports field by field.
 *
 * It fans out well: the manifest holds ten cases (case9, case14, case30,
 * case57, case118 and scaled or stressed variants), and each case is an
 * independent unit of work.
 *
 * The task's assets live outside this repository, in the sandbox:
 *
 *   D:\\code\\vibe\\dsh-sandbox\\lhtb\\matpower\\
 *     template\        the workspace: the skeleton, the manifest, the CLI
 *     tests\           upstream's verifier, unmodified (it reads the workspace
 *                      through APP_DIR, so nothing had to be patched)
 *     solution\        upstream's reference implementation: the probe's
 *                      "correct answer"
 *     judge_matpower.py  the grader: runs the verifier, counts the tests
 */

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const ASSETS = process.env.DSH_MATPOWER_ASSETS ?? resolve(REPO, '..', 'dsh-sandbox', 'lhtb', 'matpower')

/**
 * The wall-clock budget of one run.
 */
const TIME_BUDGET_MS = 1800000

/**
 * The number of tests in upstream's verifier.
 */
const TEST_COUNT = 12

/**
 * The fixture directory for one run.
 *
 * @returns {string} the absolute workspace path.
 */
function workspace() {
  return resolve(REPO, '..', 'dsh-sandbox', `bench-workspace-${process.env.DSH_BENCH_CONDITION ?? 'one'}-${process.env.DSH_BENCH_INDEX ?? '0'}-lhtbmatpower`)
}

/**
 * The MATPOWER audit task from Long-Horizon Terminal-Bench, run locally.
 */
export const LHTB_MATPOWER = {
  name: 'lhtb-matpower',
  text: [],
  timeoutMs: TIME_BUDGET_MS,
  setup() {
    const ws = workspace()
    const template = resolve(ASSETS, 'template')
    if (!existsSync(template)) {
      throw new Error(`the LHTB assets are missing: ${template}`)
    }
    rmSync(ws, { recursive: true, force: true })
    mkdirSync(ws, { recursive: true })
    cpSync(template, ws, { recursive: true })
    this.env = {
      PYTHONPATH: [resolve(ws, 'src'), process.env.PYTHONPATH].filter(Boolean).join(';'),
      PYTHONDONTWRITEBYTECODE: '1',
    }
    // Upstream's instruction is the specification: the column names, the JSON
    // keys and the conventions are part of it, so it stays as it is. Only the
    // container path changes.
    const upstream = readFileSync(resolve(ASSETS, 'instruction.md'), 'utf8')
    this.text = [
      `公开评测集长程任务(LHTB 的 silrlab/matpower-opf-regression,改编到本机):工作区 ${ws}`,
      '',
      '下面是上游的题面(规格部分原样保留,只有容器路径换成了本地路径)。',
      '',
      '---',
      '',
      upstream.replaceAll('/app', ws),
      '',
      '---',
      '',
      '## 本地补充',
      '',
      `- 时间预算 ${String(Math.round(TIME_BUDGET_MS / 60000))} 分钟。到了就停 —— 打分看的是预算内`,
      '  `src/power_audit/audit.py` 的样子。',
      '- `pypower`、`numpy`、`scipy`、`pandas`、`pyyaml` 这台机器上已经装好了。',
      '- 评分器会**自己重跑一遍** PYPOWER,拿公开和隐藏的 manifest 对照你的报告逐字段比。',
      '  只交汇总表是不够的,三张明细表、违规表、摘要和 JSON 都要对。',
      '- 十个 case 是十份互不相干的活 —— 想怎么分工就怎么分工,评分只看最后产物。',
      '- 报告:你的实现思路、每个 case 的状态、最后跑出来的文件清单。',
      '',
      `不要修改本仓库(${REPO})本身的任何文件。`,
    ].join('\n')
  },
  judge() {
    const ws = workspace()
    const missing = []
    const judge = resolve(ASSETS, 'judge_matpower.py')
    const verifier = resolve(ASSETS, 'tests', 'test_outputs.py')
    if (!existsSync(judge) || !existsSync(verifier)) {
      return { passed: 0, total: TEST_COUNT, missing: ['判据脚本不存在'], score: 0 }
    }
    let out = ''
    try {
      out = execFileSync('python', [judge, ws, verifier],
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
    const passed = report.passed ?? 0
    const total = report.total ?? TEST_COUNT
    if (passed < total) {
      missing.push(`${passed}/${total} 个判据测试通过`)
    }
    return { passed, total, missing, score: report.reward ?? 0 }
  },
}

export const LHTB_MATPOWER_TASKS = { 'lhtb-matpower': LHTB_MATPOWER }

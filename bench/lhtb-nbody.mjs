/**
 * The LHTB N-body task, run locally.
 *
 * `silrlab/nbody-accel-iterative` is a long-horizon design task from
 * Long-Horizon Terminal-Bench: the agent is given a correct but naive
 * O(N^2) simulator and has to make it fast without changing the physics. The
 * grader is a hidden verifier that scores the submission on freshly
 * randomized worlds, on a weighted continuous scale.
 *
 * Upstream it runs in a container; this machine has no Docker, so the task
 * runs against the upstream harness files, and the grading is this benchmark's
 * own adaptation of upstream's four stages, weights and speedup caps.
 *
 * The task's assets live outside this repository, in the sandbox:
 *
 *   D:\\code\\vibe\\dsh-sandbox\\lhtb\\nbody\\
 *     harness\           the upstream harness (world API, world generator,
 *                        numpy baseline, the public bench CLI)
 *     simulator_starter.py   the upstream starter, slow but correct
 *     judge_nbody.py     the grader: fresh worlds, four stages, weighted score
 *     sim_worker.py      runs a submission and the reference in one process
 *     reference_simulator.py  a known-good submission: the probe's "correct
 *                        answer"
 *
 * They are outside the repository for two reasons: the grader is the oracle,
 * and the repository must not ship a ready-made submission for the task it
 * measures.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const ASSETS = process.env.DSH_NBODY_ASSETS ?? resolve(REPO, '..', 'dsh-sandbox', 'lhtb', 'nbody')

/**
 * The wall-clock budget of one run.
 *
 * The same rule as upstream: the session is cut off at the deadline and what
 * the submission file contains at that moment is what gets judged.
 */
const TIME_BUDGET_MS = 1200000

/**
 * The number of stages the grader reports.
 */
const STAGE_COUNT = 4

/**
 * The fixture directory for one run.
 *
 * @returns {string} the absolute workspace path.
 */
function workspace() {
  return resolve(REPO, '..', 'dsh-sandbox', `bench-workspace-${process.env.DSH_BENCH_CONDITION ?? 'one'}-lhtbnbody`)
}

/**
 * The hash of a file's contents.
 *
 * @param {string} path - the file.
 * @returns {string} the hash.
 */
function fingerprint(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * The state the judge keeps between the setup and the judgement.
 */
let pristine = { starter: '' }

/**
 * The N-body optimization task from Long-Horizon Terminal-Bench, run locally.
 */
export const LHTB_NBODY = {
  name: 'lhtb-nbody',
  text: [],
  timeoutMs: TIME_BUDGET_MS,
  setup() {
    const ws = workspace()
    rmSync(ws, { recursive: true, force: true })
    mkdirSync(resolve(ws, 'harness'), { recursive: true })
    for (const name of ['world.py', 'generate_particles.py', 'baseline.py', 'bench_cli.py']) {
      const source = resolve(ASSETS, 'harness', name)
      if (!existsSync(source)) {
        throw new Error(`the LHTB assets are missing: ${source}`)
      }
      cpSync(source, resolve(ws, 'harness', name))
    }
    const starter = resolve(ASSETS, 'simulator_starter.py')
    if (!existsSync(starter)) {
      throw new Error(`the LHTB assets are missing: ${starter}`)
    }
    cpSync(starter, resolve(ws, 'simulator.py'))
    mkdirSync(resolve(ws, 'output'), { recursive: true })
    pristine = { starter: fingerprint(resolve(ws, 'simulator.py')) }
    this.text = [
      `公开评测集长程任务(LHTB 的 silrlab/nbody-accel-iterative,改编到本机):工作区 ${ws}`,
      '',
      '你要把一个 2D N 体引力模拟从朴素的 O(N^2) 改快,同时物理不能变。',
      '',
      '工作区里:',
      '  simulator.py                 你要改的文件(现在是正确的、但很慢的朴素实现)',
      '  harness/world.py             物理类型与力(Particle / Vec2 / StepParameters /',
      '                                compute_force / update_particle)',
      '  harness/generate_particles.py 公开的开发世界(固定种子,给你调试用)',
      '  harness/baseline.py          numpy 向量化的 O(N^2) 基线(评分时的速度参照)',
      '  harness/bench_cli.py         公开基准 CLI',
      '',
      '命令:',
      '  python harness/bench_cli.py run --scale 1k       # 跑一遍,报告相对基线的加速比',
      '  python harness/bench_cli.py run --scale 10k',
      '  python harness/bench_cli.py run --scale 100k',
      '  python harness/bench_cli.py check --scale 1k     # 只查正确性',
      '  python harness/bench_cli.py profile --scale 10k  # cProfile 分解',
      '',
      '物理:',
      '  G = 1.0,软化 ε = 0.1;F_ij = G·m_i·m_j·(r_j − r_i) / (|r_j − r_i|² + ε²)^(3/2);',
      '  距离超过 params.cullRadius 的粒子对不产生力;积分是辛欧拉(先更新速度,再更新位置)。',
      '',
      '你的 Simulator 类必须保留接口:__init__(particles, params) 和 simulate_step() -> list。',
      '每一步都要保持:粒子数量不变、id 集合不变、id 与质量的对应不变、数值有限。',
      '可以用 numpy,可以用任何算法;不可以用 scipy.spatial 之类的树结构库 —— 空间结构要自己写。',
      '提交的产物只有 simulator.py,实现要自包含(除标准库、numpy 和 harness 的 world API 之外)。',
      '',
      '评分(在你看不到的、全新随机生成的留出世界上算):',
      '  1) 正确性守卫:小规模边界情况(极小截断半径、簇状分布、打乱的 id、非零初速度、',
      '     不同的 dt)。位置误差 ≤ 1e-2、速度误差 ≤ 0.5。',
      '  2) 局部混合:约 1.2 万粒子、有限截断半径。权重 0.20,加速比上限 6×。',
      '  3) 全局:约 2 万粒子、截断半径大于整个世界(每一对都相互作用)。权重 0.45,上限 2×。',
      '  4) 大规模局部:约 3 万粒子、稀疏簇状。权重 0.25,上限 15×。',
      '  每一档都要先过数值检查,没过就这一档 0 分;总分 = 各档权重 × min(加速比/上限, 1)。',
      '',
      '提示:',
      '  - 小的截断半径 → 相互作用稀疏,空间哈希或邻居表能用上。',
      '  - 截断半径覆盖整个世界时,固定尺寸的网格会退化成 O(N^2) —— 这时要层次结构。',
      '  - 稳健的高分实现一般会根据给的世界在"局部算法"和"层次算法"之间切换。',
      '  - 对邻居批次做 numpy 向量化非常有效。',
      '  - 先用 1k 规模跑对,再往上放大。',
      '',
      '规则:',
      `1. 时间预算 ${String(Math.round(TIME_BUDGET_MS / 60000))} 分钟。到了就停 —— 评分看的是`,
      '   预算内 simulator.py 的样子,所以别把时间全花在准备上。',
      '2. 只允许改 simulator.py(可以在 output/JOURNAL.md 里写你的优化过程:试过什么、',
      '   每次改动的加速比、设计取舍)。',
      '3. 报告:你的方案(两三句)、每个规模的加速比、最后的 bench 输出。',
      '',
      `不要修改本仓库(${REPO})本身的任何文件。`,
    ].join('\n')
  },
  judge() {
    const ws = workspace()
    const missing = []
    const submission = resolve(ws, 'simulator.py')
    if (!existsSync(submission)) {
      return { passed: 0, total: STAGE_COUNT, missing: ['simulator.py 不存在'], score: 0 }
    }
    const judge = resolve(ASSETS, 'judge_nbody.py')
    if (!existsSync(judge)) {
      return { passed: 0, total: STAGE_COUNT, missing: ['判据脚本不存在'], score: 0 }
    }
    let out = ''
    try {
      out = execFileSync('python', [judge, resolve(ASSETS, 'harness'), submission],
        { encoding: 'utf8', stdio: 'pipe', timeout: 900000 })
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
    const total = report.total ?? STAGE_COUNT
    const score = report.score ?? 0
    if (passed < total) {
      const failed = (report.stages ?? [])
        .filter(stage => !stage.ok)
        .map(stage => `${stage.stage}(${stage.error ?? '没通过'})`)
        .slice(0, 3)
      if (failed.length > 0) missing.push(`没过的档:${failed.join(' | ').slice(0, 300)}`)
    }
    return { passed, total, missing, score }
  },
}

export const LHTB_NBODY_TASKS = { 'lhtb-nbody': LHTB_NBODY }

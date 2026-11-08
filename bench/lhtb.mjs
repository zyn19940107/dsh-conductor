/**
 * The LHTB 2048 task, run locally.
 *
 * `silrlab/2048` is a long-horizon task from Long-Horizon Terminal-Bench: the
 * agent plays 2048 turn by turn and is scored by the largest tile it ever
 * builds, on a continuous scale. Upstream it runs in a container with a game
 * daemon; this machine has no Docker, so the game runs as a local CLI over the
 * same engine.
 *
 * The task's own assets live outside this repository, in the sandbox:
 *
 *   D:\\code\\vibe\\dsh-sandbox\\lhtb\\2048\\
 *     game2048_engine.py   the upstream engine, unmodified (Apache-2.0)
 *     g2048.py             the local CLI, written for this benchmark
 *     reference_player.py  a known-good player: the probe's "correct answer"
 *
 * They are outside the repository for two reasons: the engine is the oracle
 * the judge replays the move log with, and the repository must not ship a
 * ready-made player for the task it measures.
 *
 * The score is continuous, so this task does not have the pass/fail shape the
 * other public-evaluation tasks have: the judge reports the band it reached
 * (1 = the 64 tile, 11 = the 65536 tile) as the criterion count, and the raw
 * continuous value as the score.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const ASSETS = process.env.DSH_LHTB_ASSETS ?? resolve(REPO, '..', 'dsh-sandbox', 'lhtb', '2048')

/**
 * The move budget.
 *
 * A game to a large tile takes many hundreds of moves upstream, where the
 * agent gets four hours. Here the budget is fixed, so both conditions get the
 * same number of moves and the score is about how well they were played.
 */
const MOVE_BUDGET = 400

/**
 * The ceiling of the score: the 65536 tile is band 11.
 */
const MAX_BAND = 11

/**
 * The wall-clock budget of one run.
 *
 * Upstream, this task is scored by the peak the agent reached before its
 * deadline cut it off (`continue_until_timeout`). The same rule here: the
 * runner kills the session at the deadline and the judge reads what is on
 * disk. Both conditions get the same budget.
 */
const TIME_BUDGET_MS = 900000

/**
 * The judge runner: replay the recorded moves in a fresh, pristine engine.
 *
 * It is written fresh at judgement time, so the agent cannot have touched it,
 * and it reads the engine from the sandbox — never from the workspace, where
 * the agent could have edited it.
 */
const REPLAY_PY = `"""Replay a recorded 2048 move log in a fresh, pristine engine."""
import os
import sys

engine_dir = os.path.dirname(os.path.abspath(sys.argv[1]))
sys.path.insert(0, engine_dir)
from game2048_engine import Game2048, MAX_BAND  # noqa: E402

log_path = sys.argv[2]
tokens = []
if os.path.exists(log_path):
    for line in open(log_path, encoding='utf-8'):
        token = line.strip().upper()
        if token == 'RESET' or token in ('U', 'D', 'L', 'R'):
            tokens.append(token)

game = Game2048()
best = game.value()
for token in tokens:
    if token == 'RESET':
        game.reset()
    else:
        game.move(token)
    best = max(best, game.value())

print('MOVES %d' % len(tokens))
print('BAND %d' % int(best))
print('VALUE %.4f' % best)
print('MAX_BAND %d' % MAX_BAND)
print('MAX_TILE %d' % game.max_tile())
`

/**
 * The fixture directory for one run.
 *
 * @returns {string} the absolute workspace path.
 */
function workspace() {
  return resolve(REPO, '..', 'dsh-sandbox', `bench-workspace-${process.env.DSH_BENCH_CONDITION ?? 'one'}-lhtb2048`)
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
let pristine = { engine: '', cli: '' }

/**
 * The 2048 task from Long-Horizon Terminal-Bench, played locally.
 */
export const LHTB2048 = {
  name: 'lhtb-2048',
  text: [],
  timeoutMs: TIME_BUDGET_MS,
  setup() {
    const ws = workspace()
    rmSync(ws, { recursive: true, force: true })
    mkdirSync(ws, { recursive: true })
    for (const name of ['game2048_engine.py', 'g2048.py']) {
      const source = resolve(ASSETS, name)
      if (!existsSync(source)) {
        throw new Error(`the LHTB assets are missing: ${source}`)
      }
      cpSync(source, resolve(ws, name))
    }
    pristine = {
      engine: fingerprint(resolve(ws, 'game2048_engine.py')),
      cli: fingerprint(resolve(ws, 'g2048.py')),
    }
    this.text = [
      `公开评测集长程任务(LHTB 的 silrlab/2048,改编到本机):工作区 ${ws}`,
      '',
      '你要玩 2048,尽量把最大的 tile 拼大。工作区里是上游同一套规则、同一颗种子的引擎。',
      '',
      '命令(在当前目录跑):',
      '  python g2048.py status          # 棋盘 + 统计(先看这个)',
      '  python g2048.py move <SEQ>      # 走一步或多步,SEQ 是 U/D/L/R 字母,例如 ULUR',
      '  python g2048.py reset           # 从固定的初始局面重来',
      '  python g2048.py board           # 只看棋盘',
      '',
      '规则:',
      `1. 时间预算 ${String(Math.round(TIME_BUDGET_MS / 60000))} 分钟。到了就停 —— 评分看的是`,
      '   预算内拼到的最大 tile(取整个过程的峰值),所以别把时间全花在准备上,早动手多得分。',
      `2. 步数预算 ${MOVE_BUDGET} 步(一次 move 走几个字母就算几步)。`,
      `3. 走法必须落在 ${resolve(ws, 'moves.log')}:每行一个 U/D/L/R(或 RESET),顺序就是你走的顺序。`,
      '   用 `python g2048.py move ...` 会自动写进去;如果你自己写了对局程序来出招,',
      '   就把走法按这个格式写进同一个文件 —— 评分器只读这个文件。',
      '4. 评分器用一台全新的、同样种子的引擎重放这串走法,读出你拼到的最大 tile ——',
      '   进度没法伪造,只有真的合并出来的 tile 才算数。',
      '5. 不要修改 g2048.py 和 game2048_engine.py。',
      '6. 报告:你的策略(两三句)、总步数、最后一次 status 的完整输出。',
      '',
      '棋盘只有 16 格。把格子填满又合不动就是 game over,没有下一步了。',
      '常见的取胜打法:',
      '- 给最大的 tile 选一个角落(比如左下角)并一直守着它,主要在两个方向之间交替。',
      '- 保持 tile 有序(单调的"蛇形":角落最大,沿着行递减,下一行再折回来),这样能一路级联合并。',
      '- 除非没别的可走,否则别走会把大 tile 拉出角落的方向。',
      '- 不要因为"能动"就动 —— 先想想新冒出来的 tile 会不会让你下一步无路可走。',
      '',
      'board 变成 game_over=True 时,这次就完了 —— 可以 `python g2048.py reset` 从头再来,',
      '换一套真正不同的打法。分数取整个过程里的峰值,所以重来只会更高,不会更低。',
      '',
      '评分(按你拼到的最大 tile):',
      '  band 1 = 64,band 2 = 128,band 3 = 256,band 4 = 512,band 5 = 1024,band 6 = 2048,',
      '  之后每翻一倍 +1(理论上限 11)。棋盘上正在攒的其它 tile 也算部分进度(连续分)。',
      '',
      `不要修改本仓库(${REPO})本身的任何文件。`,
    ].join('\n')
  },
  judge() {
    const ws = workspace()
    const missing = []
    if (!existsSync(resolve(ws, 'moves.log'))) {
      return { passed: 0, total: MAX_BAND, missing: ['没有 moves.log:一局都没玩'], score: 0 }
    }
    if (fingerprint(resolve(ws, 'game2048_engine.py')) !== pristine.engine) missing.push('引擎被改过(禁止)')
    if (fingerprint(resolve(ws, 'g2048.py')) !== pristine.cli) missing.push('g2048.py 被改过(禁止)')
    const runner = resolve(tmpdir(), `lhtb2048-replay-${process.pid}.py`)
    writeFileSync(runner, REPLAY_PY)
    let out = ''
    try {
      out = execFileSync('python', [runner, resolve(ASSETS, 'game2048_engine.py'), resolve(ws, 'moves.log')],
        { encoding: 'utf8', stdio: 'pipe' })
    } catch (error) {
      out = String(error.stdout ?? '')
      missing.push('重放脚本跑不起来')
    }
    const band = /BAND (\d+)/.exec(out)
    const value = /VALUE ([\d.]+)/.exec(out)
    const moves = /MOVES (\d+)/.exec(out)
    const reached = band === null ? 0 : Number(band[1])
    const raw = value === null ? 0 : Number(value[1])
    if (reached < MAX_BAND) {
      missing.push(`只到 band ${reached}(下一个里程碑是 ${2 ** (reached + 6)}),`
        + `一共走了 ${moves === null ? '?' : moves[1]} 步`)
    }
    return {
      passed: reached,
      total: MAX_BAND,
      missing,
      score: raw,
      moves: moves === null ? 0 : Number(moves[1]),
    }
  },
}

// lhtb-2048 is retired (2026-11-08). The judge's scale runs to band 11 (32768), but
// the task's own 400-move budget caps play at band 4 (512): a beam search over the
// deterministic engine reaches 512 by move 237 and cannot go higher, and the same
// search finds 1024 (band 5) at move 487 once the budget is raised to 800. So both
// arms score exactly 4/11 in every run — the metric has no headroom and cannot
// separate a better plan from a worse one. The judge never checked the move count
// either: 400 was a rule the model kept and the grader did not enforce.
// Kept here with its reason; re-enable only after raising MOVE_BUDGET (e.g. to 800)
// and enforcing it in the judge.
export const LHTB_TASKS = {}

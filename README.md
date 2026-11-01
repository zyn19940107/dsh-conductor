# dsh-refine-loop

给 DeepSeek Harness 用的插件：**把「想 → 做 → 看 → 再想」的串行链，换成「规划一次 → 跑完 → 一次性收 N 个结论」。**

---

## 你在跟一条每步都重新思考的链干活

Agent loop 是个链。每一轮都是一次完整的模型往返：

```
规划 → 做一件 → 看结果 → 再规划 → 再做一件 → 看结果 → …
```

问题不在每一步，而在三件事叠在一起：

1. **每一步都重新规划。** 做第 5 件事的时候，第 1~4 件的结论已经躺在上下文里了，模型却要重新读一遍、重新想一遍「第 5 件该怎么做」。
2. **每一步都是一次往返。** 一次往返 ≈ 一次完整模型调用。5 件独立的事，就是 5 次往返。
3. **每一步都在为前面的历史付钱。** 上下文只涨不缩，第 N 步要重读前 N-1 步留下的全部内容。

这个插件提供另一种形状，并且**在能强制的地方强制**。

---

## 对比：开插件 vs 不开插件

同一个二进制、同一份 profile、同一个模型、同一个任务 —— 只差插件自己的 `enabled` 开关。
每个任务每组 3 次，**串行**跑（并行跑测出来的是 provider 的争用，不是插件），取中位数。

三个任务，三种形状：

| 任务 | 形状 |
|---|---|
| `survey` | 五件互不依赖的查找 + 一次评价 |
| `chain` | 三步，每一步都要用上一步的结果 |
| `review` | 三个部分各自独立审查 + 一次汇总 |

### survey

| 指标 | 关掉插件 | 开着插件 | 变化 |
|---|---:|---:|---:|
| 总耗时 | 66s | 54s | −19% |
| 总 token（整个编队） | 352,086 | 358,498 | +2% |
| ├ input | 42,680 | 30,117 | −29% |
| ├ cacheRead | 302,592 | 334,555 | +11% |
| └ output | 5,263 | 5,706 | +8% |
| 主 agent 的 context | 56,447 | 46,533 | **−18%** |
| 编队人数 | 1 人 | 1 人 | 0% |
| 模型往返步数 | 12 | 10 | −17% |
| 正确性（命中判据） | 6/6 | 6/6 | 持平 |

### chain

| 指标 | 关掉插件 | 开着插件 | 变化 |
|---|---:|---:|---:|
| 总耗时 | 17s | 50s | **+190%** |
| 总 token（整个编队） | 85,215 | 166,814 | **+96%** |
| ├ input | 17,494 | 49,802 | +185% |
| ├ cacheRead | 58,368 | 106,066 | +82% |
| └ output | 1,849 | 10,946 | +492% |
| 主 agent 的 context | 24,592 | 25,952 | +6% |
| 编队人数 | 1 人 | 2 人 | +100% |
| 模型往返步数 | 5 | 7 | +40% |
| 正确性（命中判据） | 4/4 | 4/4 | 持平 |

### review

| 指标 | 关掉插件 | 开着插件 | 变化 |
|---|---:|---:|---:|
| 总耗时 | 49s | 120s | **+147%** |
| 总 token（整个编队） | 336,578 | 502,090 | +49% |
| ├ input | 48,286 | 105,110 | +118% |
| ├ cacheRead | 281,362 | 362,642 | +29% |
| └ output | 8,201 | 34,338 | +319% |
| 主 agent 的 context | 48,414 | 42,626 | **−12%** |
| 编队人数 | 1 人 | 4 人 | +300% |
| 模型往返步数 | 10 | 17 | +70% |
| 正确性（命中判据） | 4/4 | 4/4 | 持平 |

**这些数是怎么来的**

- **总耗时** = 从进程启动到最终回答写出的墙钟时间。
- **总 token** = **整个编队**的 token：主会话加上它派生出的每一个子会话的 `input + cacheRead + output`。
  子代理有自己的会话日志，它的用量**不在**主会话的 `--json` 投影里 —— 只数投影等于漏账。
  这个合计和 harness 自己的投影缓存 `tokenUsage.totals` 逐项相等，两条独立算出来的路给出同一个数。
- **主 agent 的 context** = 主会话最后一次请求读到的全部 token（`input + cacheRead`），
  也就是它最后一轮背着多少上下文。这个数和 harness 的 `contextPressure.pressureTokens` 相等。
- **编队人数** = 这一轮派生出的会话数（主会话 + 子代理）。
- **正确性** = 任务要回答的事实有没有全部出现在最终回答里。判据是机械的，不是「读起来不错」。

### 结论要照实说

**开着插件，这一轮不一定更便宜。** 三个任务里，整队 token 分别是 +2% / +96% / +49%，耗时有两项明显更久。
原因不是插件做多了活，而是**模型变了决定**：

| | 关掉插件 | 开着插件 |
|---|---:|---:|
| 派生出编队的运行 | 1 / 9 | **5 / 9** |

开着插件时，第一个工具调用必须是一张计划，而计划里放一个代理节点是最自然的写法 ——
所以模型**更常**把活分出去。分出去是有代价的：子代理要从零读一遍，父会话要等它回来，
总 token 因此上去。**但主 agent 的 context 反而小了**（survey −18%、review −12%）：
它不用自己背着所有细节，只拿结论。

这个插件不做的是「让每一轮更省」。它做的是**把这一轮怎么切、先做哪件、哪件值得派出去，
交回给模型在动手前决定**。省不省，取决于模型决定切多大。

### 每一次运行

一次运行就是一次抽样，模型的行为方差很大 —— 所以把每一次都列出来：

```
survey  off 1: 66.2s agents=1 tokens=493540 mainCtx=56515 correct=6/6 plan=n/0
survey  off 2: 55.7s agents=1 tokens=250455 mainCtx=31809 correct=6/6 plan=n/0
survey  off 3: 79.3s agents=1 tokens=352086 mainCtx=56447 correct=6/6 plan=n/0
survey  on  1: 53.8s agents=1 tokens=358498 mainCtx=48701 correct=6/6 plan=y/0
survey  on  2: 35.0s agents=1 tokens=117357 mainCtx=41291 correct=6/6 plan=y/0
survey  on  3:170.6s agents=2 tokens=715271 mainCtx=46533 correct=6/6 plan=y/1
chain   off 1: 15.9s agents=1 tokens= 85215 mainCtx=24592 correct=4/4 plan=n/0
chain   off 2: 17.3s agents=1 tokens=109616 mainCtx=26910 correct=4/4 plan=n/0
chain   off 3: 17.3s agents=1 tokens= 69784 mainCtx=23621 correct=4/4 plan=n/0
chain   on  1: 18.3s agents=1 tokens= 95531 mainCtx=25952 correct=4/4 plan=y/0
chain   on  2: 64.4s agents=4 tokens=321125 mainCtx=19851 correct=4/4 plan=y/3
chain   on  3: 50.1s agents=2 tokens=166814 mainCtx=26985 correct=4/4 plan=y/1
review  off 1: 34.5s agents=1 tokens=336578 mainCtx=48414 correct=4/4 plan=n/0
review  off 2: 48.6s agents=1 tokens=231440 mainCtx=47071 correct=4/4 plan=n/0
review  off 3:179.2s agents=4 tokens=7979462 mainCtx=118958 correct=3/4 plan=n/0
review  on  1: 48.3s agents=1 tokens=129038 mainCtx=42626 correct=4/4 plan=y/0
review  on  2:120.0s agents=4 tokens=502090 mainCtx=49073 correct=4/4 plan=y/0
review  on  3:122.0s agents=4 tokens=1659346 mainCtx=41885 correct=4/4 plan=y/3
```

`plan` = 第一个工具调用是不是 `refine_plan`；`plan=y/3` = 是，而且计划里有 3 个代理节点。
`review off 3` 是唯一一次没拿满分的运行 —— 它编出了 4 个 agent，burn 了 798 万 token。

复现：`pnpm bench`；原始记录在 `bench/results/`，任务和判据在 `bench/task.mjs`，
会话树的读法在 `bench/sessions.mjs`。
基准要一个**自己的** DSH home（别跟正在用的那个共用 profile）：
`DSH_SANDBOX_HOME=<你的隔离 DSH_HOME> DSH_BENCH_CWD=<任务要读的目录> pnpm bench`。

---

## 开了插件之后，流程图长什么样

模型在**思考里**先把这一轮的形状说出来，再把它交给 `refine_plan` 落成机器可执行的图：

![一轮的开头：思考里先有流程图，然后才是 refine_plan 调用](docs/plan-turn.png)

这是那次跑出来的真实计划（完整 JSON 在 [`docs/example-plan.json`](docs/example-plan.json)）：

```mermaid
graph TD
  local["local<br/>tools"]
  gh_repo["gh-repo<br/>subagent"]
  npm_plugins["npm-plugins<br/>subagent"]
  gh_articles["gh-articles<br/>subagent"]
  brief["brief<br/>subagent_fork"]
  local --> brief
  gh_repo --> brief
  npm_plugins --> brief
  gh_articles --> brief
```

| 节点 | 类型 | 依赖 | 干什么 |
|---|---|---|---|
| `local` | `tools` | — | 读本地安装，补准确的包名（2 个 `ops_bash`） |
| `gh-repo` | `subagent` | — | 调查 DSH 在 GitHub 上的官方仓库 |
| `npm-plugins` | `subagent` | — | 调查 npm 上的 DSH 插件包 |
| `gh-articles` | `subagent` | — | 调查 GitHub 上的 DSH 教程文章 |
| `brief` | `subagent_fork` | 上面四条 | 把四条调查结果汇总成简报 |

**两层**：上面四条并行跑，`brief` 等齐了再动。

**节点类型是模型自己选的**，判据只有一条：**这个孩子需不需要知道我们刚才说了什么。**
三个调查各自独立、不需要本对话的上下文 → `subagent`；汇总要用到前面三条的结果 → `subagent_fork`。

---

## 开了插件之后，编队长什么样

一次派出 4 个子代理。DSH 的「编队」页把派生关系画成了树，每个子代理有自己的上下文、耗时和步数：

![编队：1 个主 Agent 和它派出的 4 个子 Agent](docs/formation.png)

图里能直接读出来：谁派生了谁、每个子代理烧了多少上下文（`npm-plugins` 1.1M，`gh-repo` 517.6k）、
跑了多久、走了几步、上下文压力百分之多少。

---

## 插件做了四件事

### 一、`refine_plan`：一次调用带一整张流程图

模型在一个调用里给出**这一轮的全部形状**：

- **判据**（`criteria`）—— 这一轮怎么算成功，每一条都是能对着结果核对的东西
- **节点**（`nodes`）—— 这一轮由哪些节点组成

节点有三种：

| 节点 | 是什么 |
|---|---|
| `tools` | 若干个调用。互相能并发的并发跑，不能并发的排队跑 |
| `subagent` | 一个自包含的任务，交给一个**从零开始**的子代理 |
| `subagent_fork` | 一个任务，交给一个**继承本对话**的子代理 |

**模型自己决定用哪个:**

- **`subagent`** —— 任务**不需要本对话的任何东西**。查一个话题、审一份文件、做一件自成一体的事。
- **`subagent_fork`** —— 任务**要建立在本对话已经说过的内容上**。接着刚才的结论往下分析、对这一轮做个复盘。

判据就一条：**这个孩子需不需要知道我们刚才说了什么。**

节点还能用 `after` 声明**依赖**：

```json
{
  "criteria": ["四个文件都读到了", "peerDependencies 齐了"],
  "nodes": [
    { "id": "scan", "kind": "tools",
      "calls": [
        { "name": "glob", "arguments": { "path": "src", "pattern": "**/*" } },
        { "name": "grep", "arguments": { "path": "src", "pattern": "isConcurrencySafe" } }
      ] },
    { "id": "judge", "kind": "subagent_fork", "after": ["scan"],
      "task": "根据上面读到的内容，判断这个插件的架构是否合理" }
  ]
}
```

执行时：

- **没有依赖的节点一起跑**（`scan` 里的两个调用也一起跑）
- **下一层等上一层**（`judge` 等 `scan`）
- **依赖节点的输出会进到下一个节点**：子代理的 prompt 里会附上前置节点的产出；工具调用的参数里，恰好等于 `@@节点名@@` 的那个字符串会被换成该节点的输出
- **`@@节点名@@` 同时也是一条依赖边**：引用了谁的输出，就得等谁先跑完。引用一个不存在的节点，计划直接报错；**绝不会把字面量 `@@节点名@@` 原样传进工具**
- **所有结果在同一个工具结果里回来** —— 模型下一轮一次就能写完全部结论

> 子代理是**前台**跑的（`run_in_background: false`）：它的结论会回到这个工具结果里，而不是留一个句柄让你以后去收。

### 二、一轮从计划开始

只提供工具，模型会**先埋头干活，再想起来画图** —— 实测中它常常到第 7 步左右才把计划交出来，
前 6 步全是一件事一件事做。那正是这个插件要消灭的形状。

所以计划是**这一轮的第一个调用**，不是可选项：

- 这一轮的第一个工具调用如果**不是** `refine_plan`，它会被拒绝，并被告知先画图
- 计划交出来之后，这一轮里别的调用都放行
- **子代理不吃这一条** —— 它接到的活本来就已经是别人计划里的一层
- **规则会放手**：连着拽两次还不听，就不再拦了。困住模型的规则比被无视的规则更糟

模型被逼着枚举的那份清单，**就是它思考里的流程图** —— 先「读源码 / 独立调研 / 基于前面结果做评审」，
再一层层等下去。

开关：`requirePlan`（默认开）、`planPullbacks`（默认 2）。

### 三、链式规则的闸门：拦「一步一件」

光有工具不够 —— 模型可能根本不去用。所以插件盯着**步骤的形状**：

> 某一步只做了一个调用，而上一步也只做了一个调用 → 这就是链。

连续两次之后，下一步会被告知怎么破链：「先把这一轮画成流程图，再一个调用交出去」。

**规则是提醒，不是笼子。** 它从不拒绝任何调用 —— 真的互相依赖的事情，模型可以继续一件一件做。

### 四、按会话开关

`/dsh-refine-loop off` —— 这个会话里 `refine_plan` 从工具表消失，提示词里的说明跟着消失，链式规则不再触发。
`/dsh-refine-loop on` —— 装回去。

**一条会话关掉，不影响别的会话。** 新会话默认是开的。

---

## 改设置

**在 `cordis.patch.yml` 里改**：

```yaml
- insert:
    - id: refine-loop
      name: '@zyn19940107/dsh-refine-loop'
      config:
        enabled: true                    # 整个插件挂不挂
        chainLimit: 2                    # 连续几次「一步一件」之后才提醒
        maxBatchSize: 8                  # 一轮最多几个节点
        maxBatchTimeoutMs: 600000        # 一轮的时间预算
        maxAgentDepth: 1                 # 计划里最多可以派到第几层子代理
        agentNodeTimeoutMs: 300000       # 单个子代理节点的预算
        respectConcurrencySafety: true   # 认不认工具自己声明的「不能并发」
        concurrentTools:                  # 插件放行的工具:只读的,随便跑
          - glob
          - grep
        concurrentShell: true             # 只读的 shell 命令也可以并行
        shellTool: ops_bash               # 上面那条规则管的是哪个工具
```

几个字段的意思：

| 字段 | 默认 | 什么时候改 |
|---|---|---|
| `chainLimit` | `2` | 调到 `1` = 一发现单件链就提醒；调大 = 更宽松，只在链条更长时才管 |
| `maxBatchSize` | `8` | 一轮的节点数上限。节点太多，工具结果也太大，读起来反而费劲 |
| `maxBatchTimeoutMs` | `600000` | 一轮的时间预算。**子代理在前台跑，所以这个预算也管着子代理** |
| `maxAgentDepth` | `1` | `1` = 本对话可以派子代理，子代理里不能再派。调到 `2` 允许孙子代理 |
| `agentNodeTimeoutMs` | `300000` | 单个子代理节点的预算。超了就报这个节点失败，**其余节点的结果照常拿回来** |
| `requirePlan` | `true` | 一轮的第一个工具调用必须是 `refine_plan`。关掉它，插件退回到「只提供能力，不强制形状」 |
| `planPullbacks` | `2` | 一轮最多被拽回几次。拽不动就放手 |
| `respectConcurrencySafety` | `true` | 改成 `false` = 连工具自己声明「不能并发」的调用也一起跑。**只在确认这些工具彼此安全时才改** |
| `concurrentTools` | `[glob, grep]` | 纯读的工具。写操作的工具**永远不要加进来** |
| `concurrentShell` | `true` | 只读 shell 命令是否并行。改成 `false` = shell 一律排队 |
| `shellTool` | `ops_bash` | 上面那条规则管的是哪个工具 |

> `enabled` 在插件加载时读一次，改了要重载才生效。其余字段是活的，改完刷新页面就能看见。

---

## 关于并发安全，说明白

插件**默认认**工具自己声明的并发安全性。harness 的判定在 `packages/core/tools/src/index.ts`：

```ts
executionMode(exec) {
  const tool = this.resolveExecution(exec.name, exec.agent, ...)
  if (!tool?.isConcurrencySafe) return { kind: 'exclusive' }   // 没声明 → 独占
  ...
}
```

没声明 `isConcurrencySafe` 的工具一律独占。插件对此加了一层自己的判定，分两种：

### 纯读工具 —— 风险几乎为零

`glob` 和 `grep` 各自 spawn 一个子进程、返回找到的东西，**没有任何共享的可变状态**。插件直接放行。

> 同一批改动也补在了 harness 源码里（`packages/fs/tool-fs-search/src/glob.ts` 和 `grep.ts` 各加一行 `isConcurrencySafe: () => true`）。那是更正确的位置 —— 但 **harness 的改动要等发版才生效**，所以运行时的效果来自插件这一层。

### shell 命令 —— 风险集中在这里

shell 的命令可能是任何东西，所以插件**自己判断命令**：

- 必须是一个简单命令：没有重定向、没有链、没有管道、没有替换
- 引号按 shell 的规则解析：**引号里的 `>`、`|` 是字面量**，不危险；但双引号里的 `$` 和反引号仍会展开，遇到就拒绝
- 可执行文件必须在只读命令白名单里（`ls` `cat` `grep` `find` `head` `tail` `wc` `stat` …）
- 白名单命令的危险参数要单独挡掉（`find -exec`、`find -delete`、`grep --pre`、`sort -o`、`tail -f` …）

**判断不了的，就老老实实排队。** 这条规则宁可放过也不放过 —— 一个被误判成只读的命令，如果同时跑了两份，损坏是静默的，没有任何报错。

批次结果里会写清楚每一项是 `concurrent` 还是 `serial`，以及整批的 `schedule` 是 `concurrent` / `mixed` / `serial`。**这是可观测的 —— 不用猜。**

### 顺序也是保证

独占的调用是**屏障**：它前面的调用先跑完，它自己单独跑，它后面的调用再开始。`[A(并发), B(独占), C(并发)]` 的执行顺序就是 A → B → C，和 harness 自己的调度器一致。

---

## 装上

```sh
# 从本地装
dsh plugin add /path/to/dsh-refine-loop

# 或者打包
pnpm pack
dsh plugin add ./zyn19940107-dsh-refine-loop-0.1.0.tgz
```

**装完请开一个新会话** —— 已经开着的会话不会刷新模型看到的工具表。

---

## 自己改代码

```sh
pnpm install
pnpm build        # 打包
pnpm typecheck    # 类型检查
pnpm specs        # 跑测试
```

规格里有两条是真的在测并发：一条看三个调用的**时间窗有没有重叠**，一条看计划的**层与层的顺序** —— 不是看摘要，是看事实。

---

## 已知边界

- **插件不改变 harness 的循环结构。** 它是一个插件，用的是公开扩展点（`tools/register`、`tools/execute`、`agent/pre-step`、`systemPrompt.section`、`commands/register`）。harness 自己的 `agent-loop` 一行没动。
- **子代理在前台同步跑。** 一个跑得慢的子代理会拖住这一轮 —— 但它有**自己的预算**（`agentNodeTimeoutMs`），超了就报这个节点失败，其余节点的结果照常拿回来。整轮还有一个总预算 `maxBatchTimeoutMs`。
- **计划里的子代理消耗和主会话一样的预算**，但它的中间过程不进主上下文 —— 你只看得到结论。
- **批次里的子调用不进 session 日志的 `tool/call` 事件。** 它们的内容在 `refine_plan` 自己的工具结果里，所以模型看到的东西是可重建的，但逐项的调用记录不在。
- **`maxBatchTimeoutMs` 在插件加载时读一次。** 改它要重载。
- **链式规则是提醒。** 一个坚持一步一件的模型，每隔 `chainLimit` 步会被提醒一次，但不会被拦住。这是故意的：规则是规矩，不是陷阱。
- **「一轮从计划开始」是会拦的** —— 它拒绝这一轮的第一个非计划调用，但拽两次就放手（`planPullbacks`）。它比链式规则重，因为它拦的是执行。
- **harness 保留双花括号。** 它的提示词渲染器把 `{{name}}` 当变量引用，名字不合规就直接抛异常、把整段渲染炸掉。所以：插件的占位符是 `@@节点名@@` 而不是 `{{节点名}}`，指导文本里也不允许出现 `{{`（插件加载时就会检查并拒绝启动）。**改提示词文案时别把双花括号写回去。**

## License

MIT

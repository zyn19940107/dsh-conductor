# Changelog

## 2.10.4 全量实测（补充）

用 v2.10.4 重跑 8 任务 × 2 臂 × 5 次（80 次），记录在 `bench/results/`（`archive-2.10.3/` 是上一批）。
扫描到 4 条 `panel-off` 被 429 限流打断、已全部串行重跑；最终 80 条记录 0 个错误回合。

中位（off → on）：
  panel        归一化 992→538s (0.54x)  token 41,343k→4,076k (0.10x)  成本 ¥3.005→¥0.570 (0.19x)  案例 28/30→28/30
  matpower     归一化 724→903s (1.25x)   token 10,371k→2,748k (0.27x)  成本 ¥0.834→¥0.722 (0.87x)  案例 56/60→57/60
  nbody        归一化 1058→1165s (1.10x) token 3,274k→1,496k (0.46x)   成本 ¥0.583→¥0.542 (0.93x)  案例 20/20→19/20
  review       归一化 100→93s (0.93x)    token 1,215k→1,251k (1.03x)   成本 ¥0.185→¥0.228 (1.23x)  案例 28/30→27/30
  humeval      归一化 178→206s (1.16x)   token 677k→397k (0.59x)       成本 ¥0.147→¥0.172 (1.17x)  案例 25/25→25/25
  humeval-hard 归一化 207→133s (0.64x)   token 222k→312k (1.40x)       成本 ¥0.086→¥0.135 (1.56x)  案例 25/25→25/25
  coverage     归一化 68→134s (1.97x)    token 618k→191k (0.31x)       成本 ¥0.108→¥0.182 (1.68x)  案例 25/25→24/25
  quixbugs     归一化 79→139s (1.76x)    token 253k→756k (2.98x)       成本 ¥0.064→¥0.147 (2.32x)  案例 20/20→20/20
  几何平均：归一化 1.07x，token 0.56x，成本 1.04x；案例合计 227/235 → 225/235。

与 2.10.2 相比：归一化 1.19x→1.07x，token 0.75x→0.56x，成本 1.14x→1.04x（nbody/matpower 转为基本打平，
panel 成本 0.29x→0.19x；quixbugs 仍 2.32x，coverage 变差到 1.68x）。

README 与知乎文章的实测章节已按这批数字重写。

## 2.10.4

### 提示词：验收归属由验收信号决定；先读后派（无机制改动）

quixbugs 上插件臂一度 3× 慢、2.25× 贵。查下来成本主体不是"节点里跑了验证"，而是
**四个 worker 各自读文件 + 每个 worker 的固定循环**。这一版只改提示词：

1. **验收归属按验收信号决定**（`REFINE_GUIDANCE` + `ROUND_LOOP` + `criteria` 参数说明）。
   验收是一条覆盖整个工作区的命令（测试套件、判分器、RESULT n/n）→ 归父代理，下一轮用
   tools 节点跑；此时节点 task 里不许有任何证明步骤（不跑测试、不写临时脚本、不写
   "done when ... passes"）。节点自证只在"它的产出就是全部交付物"时成立。两者都做 =
   同一个答案付两次钱。
   实测：改前 4 个 worker 都在并行轮里跑根目录 check.py，读到 4/4、3/4、2/4、2/4 四种
   互相矛盾的中间态；改后子节点 0 次全局 check，只验自己那份，父代理一轮全局确认。
2. **先读后派**（`ROUND_LOOP`）。多个节点需要同一批起点信息（同一份源码、同一套用例、
   同一个判分器）时，先单独花一轮用 tools 节点读完，下一轮再派节点——它们继承这段对话，
   不必各自再读；读和用它的节点不能同轮（并行时后者读到的是未更新的文件）。

### 实测（quixbugs on 臂，19 次运行，判据全部 4/4）

按形状分组（观察数据，非受控 A/B）：

| 形状 | n | token | 成本 | 归一化时间 |
|---|---:|---:|---:|---:|
| 先读后派 | 8 | 757k | ¥0.161 | **135s** |
| 直接派（worker 自己读）| 7 | 735k | ¥0.181 | 267s |
| 不派（父代理一人）| 4 | 137k | ¥0.092 | **91s** |

先读后派相对直接派：归一化 **0.51×**、token 持平、成本 0.89×。
规则生效后新一批 5 次全部为先读后派或不派，0 次首轮直接派。
附注：`bench/results/quixbugs-prompt-variants.md` 记录了每条 on-N 记录对应的提示词版本。

## 2.10.3

### 修正：同层"写 → 验"依赖，以及判据窄于验收脚本

nbody 上插件臂的正确性从 5/5 掉到 3/5，查下来是两件事：

1. **同层的"写 → 验"依赖。** 父代理把 `impl[tools]`（写 `simulator.py`）和 `edge[worker]`（验证）
   放进了同一层——它们只能靠轮询（实测 5 次 `Start-Sleep`，25–50 秒）等文件出现。这不是并行，
   是伪装成并行的等待；更糟的是验证节点验到的是中间版本（那一轮写了 14 次文件），最终版本
   从未在 `global` 档跑过。
2. **判据窄于验收脚本。** 判分器有 4 个档，而 criteria 写的是"`check --scale 1k` 通过"——
   1k 档只走局部交互，`global` 档（所有粒子两两交互）从未被执行。

提示词改了三处（+1 处判据）：

- 规划侧（系统提示词）："waiting is not a way out of it: a node may not read, poll or sleep until
  another node of the same round has written something. Write-then-check is one job — put the write
  and its check inside the same node … or check in the next round."
- 每轮教条："a node never waits for another node of its own round — write-then-check is one node
  (or two rounds), never a writer and a reader side by side."
- worker 提示词："Never wait for another node: if what you were sent to use is not on disk yet, say so
  in one line and stop."
- 判据："When the workspace ships a verifier or a checker, the round is judged on that checker's whole
  output: run every stage, scale and case it has."

### 验证（nbody on 臂，新提示词，3 次）

| 指标 | 改前（5 次）| 改后（3 次）|
|---|---|---|
| 判据 4/4 | 3/5 | **3/3** ✅ |
| 轮询/等待调用 | 5 次（1 次运行）| **0** ✅ |
| 墙钟 | 1200s ×5 | 555s / 603s / 1200s |

改后 node 的形状变成"一个 tools 节点里 `order: sequential` 依次 write → pwsh(check) → pwsh(check)"，
不再有写者和读者并排。

## 测量修正（2.10.2 之后，无代码改动）

三处测量错误修掉之后，用 2.10.2 重跑了全部 8 个任务（每臂 5 次，4 路并发，80 次运行）：

- token 只算会话自己的（种子前缀不计）；
- 工作区按 (condition, index) 隔离，重复运行可以并行；
- 判据按语义（panel 的"三份评审"用形状判据，review 的"参数原样"补词表），答案型判据从
  会话全文重判。

结果（off → on，中位数）：panel 归一化 0.43×／token 0.17×／成本 0.29×（唯一大赢）；
review 0.70×／0.98×／1.35×；nbody 0.84×／0.41×／1.19× 且正确性 5/5→3/5；
humeval 1.23×／0.52×／1.16×；humeval-hard 1.43×／0.83×／1.33×；coverage 1.69×／1.46×／1.25×；
matpower 1.81×／0.83×／1.45× 且正确性 5/5→4/5；quixbugs 3.00×／2.79×／2.25×。
几何平均：归一化 1.19×、token 0.75×、成本 1.14×。

README 的实测章节与知乎文章据此重写；旧的 v1.0/v2.0/v2.4 对照数字标注作废（测量口径不同）。

## 2.10.2

### 撤掉"先写后删"：删除 `scrubConclusion`

你问的对：**既然契约已经要求不写行号/证据，为什么还要先让模型写、再在插件里删？**
答案是这个删除本来就不该存在，代价已经实测：

- 它把一次真实运行的 `delegationDepth` 事实删掉了（2.10.0，一行 603 字符的中文段落里
  既有事实又复述了这条规则，一个「行号」触发整段删除）；
- 2.10.1 改成按句删只是把伤口缩小，同一个病还在（事实和收据词同句时照样整句没）；
- 合规度实测：130 份子代理报告里只有 **17 份（13%）**出现收据裸词，真实引用形态更少
  （大多是任务本身在讨论这条规则时引用了词）。**提示词负责要求，输出就是模型写的。**

所以这一版**整段删除**：

- `src/batch.ts` 删掉 `RECEIPT_PATTERN` 与 `scrubConclusion`（约 1,800 字符的实现）；
- 三处调用点（agent 节点输出、接回节点输出、空节点输出）改为直接返回原结论；
- 结论契约里同步删掉"它会在父代理读到之前被删掉"这句承诺 —— 不删了，就不该再这么写；
- `verify/batch.spec.ts` 删掉收据过滤的测试块。

### 影响

父代理现在会看到模型偶尔写下的引用句。这是真实情况，不再由插件静默篡改内容。

### bench

- review 判据「调用参数原样透传」再补「不做形状校验 / 不校验形状 / 不校验」——答案用
  「`arguments` 是 `unknown`、不做形状校验」表述时被判缺失。

### 验证

review on：**5/5 全 6/6**（含一次重跑）。

**样本量提醒**：review 单次 token 波动 864k–3,241k，n=5 的中位数差异不足以支持任何
token 降幅结论。

## 2.10.1

### 修正：收据过滤器整行删除，会连带吞掉事实

现象：review 有一次 5/6，缺 `delegationDepth`。追查链路：

1. worker 的报告里**有**这个字段（报告第 2,776 字符）；
2. 父代理收到的计划报告里**没有**这个字段 —— 所以不是父代理汇总丢的；
3. 原因在 `scrubConclusion`：它按**行**过滤收据（`/证据|行号|L\d+|evidence|proof|citation/`），
   而那个 worker 的报告共 21 行，其中**一行 603 字符**的段落里既有这个事实，又顺便描述了这条过滤规则本身：

   > …嵌套深度由 maxAgentDepth 把关，按 session.header.delegationDepth 判定…
   > …把「行号/证据/proof/citation」那类收据句整行剔掉。

   这一行里出现了「行号」，于是**这一行 603 字符连同开头的事实一起被删掉**（父代理的计划报告里确实没有这个字段，已用旧算法复现验证）。

修法：**按句子删除**，而不是按行 —— 文本在 `。！？!?` 与换行处切开，只有含收据词的
**那句**被删，同一行的其它句子保留。补了一条回归 spec：一行里既有 `delegationDepth`
又有「行号」时，`delegationDepth` 必须留下。

### bench

- review 判据「调用参数原样透传」的词表太窄：答案用「裸值」表述被判为缺失。补上
  裸值/透传/不做替换/原封不动。

### 验证

修完判据后重跑：review on **5/5 全 6/6**（此前 2.10.0 有 1 次 5/6、修收据后有 2 次 5/6，
其中 2 次是判据词表、1 次是收据误删）。

**注意样本量**：review 的单次 token 波动极大（本批 864k–3,241k），n=5 的中位数差异
（1013k vs 1453k vs 1430k）**不足以**支持「token 降了 X%」的结论，需要更多样本。

## 2.10.0

### 新工具：`tools` —— plan 的 tools 节点，不需要 plan

`tools` 节点原来只能存在于图里：worker 是叶子，`refine_plan` 被拒，所以"调用打包"和
"结果截断"这两件事它一样也拿不到。这两件事和图没有关系，只是调度器与上限。

现在插件直接注册一个 `tools` 工具：

```json
{"calls": [{"name": "grep", "arguments": {"pattern": "rule", "path": "src"}},
           {"name": "read", "arguments": {"file_path": "src/rounds.ts"}}],
 "order": "parallel"}
```

- 走**同一套** `runBatch` 调度（并发安全、屏障、修复）和**同一个**截断
  （`capNodeOutput`，5,000 字符，头 + 尾 + 标记列名每个调用）；
- 返回一个合并摘要，而不是每个调用的原始输出；
- **只对不能建图的会话（worker）开放**：能建图的会话调用会被拒绝，并被告知用 refine_plan
  把调用放进 tools 节点 —— plan-first 规则不变；
- worker 提示词改为指向它："call `tools` with the calls you would have put in that node…
  use the direct tools for what the task names, so the cap never takes away a file it asked
  you to cover."

### 实测（review，5 对，2.10.0）

| | 基线（无）| 2.9.2（纯提示词）| **2.10.0（tools 工具）** |
|---|---|---|---|
| 正确率 | 6/6 × 5 | 6/6 × 5 | 6/6 × 4，1 次 5/6 |
| token 中位 | 1,430k | 1,086k | **1,013k（−29%）** |
| 未缓存输入 | 157k | 149k | **127k（−19%）** |
| 成本 | ¥0.275 | ¥0.247 | **¥0.227（−17%）** |
| 墙钟中位 | 88s | 73s | 84s |

那次 5/6 缺的是 `delegationDepth`：worker 的报告里**有**这个字段，是父代理汇总时丢的，
不是 worker 没看到。基线 5 次全 6/6，这里还有待观察。

### specs

新增 `verify/tools-tool.spec.ts`：注册名与参数形状、calls 严格校验、能建图的会话被拒绝
并指向 refine_plan、worker 会话放行。

## 2.9.2

### worker 提示词：不能建图，就把"收集"做成一个批次

worker 是叶子，`refine_plan` 被规则拒绝，所以它拿不到 tools 节点那两个好处（调用打包、
结果截断）。这一版**只改提示词**，让它用同一种做法手工达成：

> You cannot draw a plan, so make the gathering itself one batch: in a single message, make every call that
> only collects material — list, search, read — and bound each answer before you ask for it: a listing
> returns names rather than a tree, a search returns its first hits rather than every hit, and a file is read
> in the ranges you need. They run together and come back together, and then you think from that digest.
> **Bound how you look, never how much of the task you cover: what the task names, read in full.**

放在 worker 提示词的开场白与任务之间；与既有文本不冲突：

| 既有文本 | 关系 |
|---|---|
| 开场白 "Do not draw a plan and do not delegate" | 一致（新句子以"你不能建图"开头）|
| 任务（如"分块读完整个 plan.ts"）| 一致（"任务点名的要读全"明确保留覆盖要求）|
| 契约 "Keep it short… no inventory" | 不同对象（契约管报告，新句子管收集）|
| 结尾禁令 "禁止使用 refine_plan" | 一致 |

### 实测（review，5 对，2.9.1 build + 本节提示词）

| | 基线（无指令）| 第一版措辞 | **本版措辞** |
|---|---|---|---|
| 正确率 | 6/6 × 5 | **5/6,6/6,6/6,6/6,5/6** | **6/6 × 5** |
| token 中位 | 1,430k | 1,007k | **1,086k（−24%）** |
| 未缓存输入 | 157k | 139k | 149k |
| 成本 | ¥0.275 | ¥0.291 | **¥0.247（−10%）** |
| 墙钟中位 | 88s | 100s | **73s（−17%）** |

第一版措辞把"读文件用需要的行区间"写成了倾向（漏了覆盖要求），两次 5/6（缺
`delegationDepth`）。第二版加上"Bound how you look, never how much of the task you cover:
what the task names, read in full"，正确率回到 5/5，同时保住 token 与时间收益。

## 2.9.1

### 修正

- **接回后在预算内完成的节点没有被 dispose。** `Parked.resume()` 在续跑的节点完成时把它从注册表
  移除，但没有释放它的子会话——泄漏的会话会一直活着。现在完成即 dispose（和普通节点一样），
  只有再次超预算才重新停泊。
- `parked.spec.ts` 增加断言：接回后完成 → `dispose` 被调用一次。

## 2.9.0

### 行为：预算到点的节点不再被结束，而是"停泊"（parked）

之前节点到预算 = 写报告 + 结束。报告带回来的工作因此断在那里：下一轮只能重做，或者放弃。
现在节点到预算只是**停泊**：

- **不杀后台**：在飞的调用等它跑完（2.7.0 起的行为），已起的后台任务继续跑；
- **写报告**：报告阶段禁止一切工具，报告里说明到哪儿了；harness 那条"最终答案前用
  `job_output` 收集后台任务"的规则在报告阶段明确不适用——这不是最终答案，任务继续跑；
- **节点不结束**：子会话保持存活，上下文、文件、后台任务都留着；
- **下一轮用同一个 node id 接回**：计划里出现同名节点 → 复用那个子会话，给它这张图里的
  新预算和新任务；没出现 id = 父代理认为没必要继续 → 当场销毁；
- **循环结束或被新请求取代时**，剩下的 parked 节点统一释放。

### 实现

- 新增 `src/parked.ts`：按主会话分组的 parked 注册表（`park`/`resume`/`retain`/`disposeAll`）；
- `src/fork.ts`：把"预算 + 报告"抽成 `driveChild`，到点后注册为 parked 而不 dispose；
  接回时复用同一个 child，给新预算重新驱动；
- `src/tool.ts`：节点执行前先尝试接回同名 parked 节点；每张图开始时 `retain` —— 图上
  没点名的 parked 节点当场结束；
- `src/rounds.ts`：教条说明"节点会停泊、用同一 id 接回、不给 id 就结束"；
- `src/index.ts`：循环结束（没有下一轮）时释放剩余 parked。

### 验证

新增 `parkprobe`：worker 只有 10 秒预算，任务是跑一条 30 秒的命令。

```
墙钟 87s，判据 1/1
子会话总数 1（没有重开）
同一子会话的用户消息：第1轮任务 → 预算报告要求 → 第2轮接回任务
```

第 1 轮：到 10 秒预算 → 等命令跑完 → 写报告 → 停泊（报告里带 `[parked]` 段和接回方法）。
第 2 轮：父代理用同一个 id `slow`、新预算 120 秒交图 → 接回同一个子会话 → 完成。

### specs

- 新增 `verify/parked.spec.ts`：同 id 接回、再次超预算重新停泊、图上没点名就销毁、
  循环结束全释放、未停泊的 id 不误伤。

## 2.7.1

### 修正：prompt 里的自相矛盾

- **工具示例里的 review 节点删掉。** `refine_plan` 的示例参数里有一个 `plan-review`（kind `forker`，任务是
  "Review how the plan format treats node arguments..."），而政策明写 "No review node"。模型每读一次示例
  就看到一次反例。示例改成一个不涉及复核的分工（`parser-tests`）。
- **示例里的"用一行代码做答案"删掉。** 契约禁止行号与引用，"backed by a line of code" 正好相反。
- **`budgetMs` 的参数说明还停在 2.6.0 的旧行为。** 它写着"到点后可以 either finish by the shortest path
  or report its state"，而 2.7.0 的收尾是"不许开新活、不许调工具，只写报告"。改成真实行为。
- **"没有预算的节点跑完没人知道结果"是假的。** 没预算的节点用节点上限，到点同样进入报告阶段，父代理会
  学到。这句话改掉了；同时按你的要求把预算改成**可选**（"A node may carry a budgetMs"），不再声称每个
  节点都必须带。
- **criteria 不再写成"可以拿去检查的东西"。** 验收不做、检查 criteria 没有用，所以改成"完成时应该是
  什么样"；"judge from all of it" 改成 "read all of it"。
- **报告里的"哪个命令跑了、打印了什么"改成"现在什么能用、到什么程度"。** 子代理契约禁止把命令日志当
  证据，报告却要求它，两条指示相反。

> **2.8.0 - 2.8.2 已撤回。** 那三个版本加了 `bg` 工具（无主后台任务），但实测它解决的是
> 2.7.0 已经解决的问题（预算到点不再杀在跑的工具），而且在 80 次 benchmark 里一次都没被用到；
> 它还引入了四处 prompt 自相矛盾（"阻塞会丢工作"是假的、"别轮询"与 harness 的"最终答案前收集"
> 冲突、"会通知"对无主任务不成立、存活期有三种说法）。改动已用 `git revert` 撤回，
> 代码与 `v2.7.0` 完全一致；历史保留在 git 里。版本号回到 `2.7.0`。

## 2.7.0

### 行为

- **预算到点不再杀正在跑的工具调用。** 之前在预算到点的瞬间 `cancel()` 掉整个 turn，在跑的工具一并中断（日志里是 `AbortError`）：`lhtb-nbody-on-3` 里一个 worker 跑了 227 秒的基准测试被杀，最终只拿到 2/4；`panel-on-2` 里一个 spawner 的 393 秒计划被杀。工具的时间已经花掉了，它可能只差一口气就返回报告最需要的那条数据。
- 现在：预算到点只是"不再开新活"——报告要求注入到**下一个 step 边界**，等正在跑的调用返回之后才交给模型；报告本身仍然没有时间上限。工具守卫在注入的同一刻生效，所以"正在跑的调用跑完 → 下一步只能写报告"。
- 兜底：如果 turn 正好在注入的那一步结束（消息还挂在 `next-step` 里），就改走 followup 起下一个 turn，不会丢报告。

### 新增

- `toolprobe` 探针：20 秒预算 + 阻塞 180 秒的命令，判据是报告里出现 `SLEPT 180`。实测：T+20s 预算到期，T+23s 起命令跑满 180 秒，T+204s 拿到 `SLEPT 180`，T+210s 报告完成，墙钟 220 秒，1/1。

### specs

- `plan.spec.ts`：超时节点的 turn 不再被 cancel（`fork.cancelled() === 0`），且报告内容进入节点输出。
- `fork.spec.ts`：报告提示改为"允许在跑的调用结束"，不再声称"work in flight was just stopped"。

## 2.6.0

### 行为

- **模型有了时钟。** 第一轮告诉它会话的开始时刻（本地时区 + 时区偏移），之后由它自己读 shell 的时钟；规划时先读钟，再给节点分预算。之前模型看不到任何时间戳，"15 分钟预算"只能猜。
- **教条去重。** 四类节点只在系统提示词里定义一次；工具描述和参数说明只留引用，不再重复；每轮教条删掉重复的节点说明（每轮省约 450 字符，8 轮的任务省约 3,600 字符）。
- **不要派人验收。** 禁止 review 节点、独立重推、加固轮：结果按原样用，缺的活算新活，不算复核。之前这条只在长段落里说过"信任节点"，模型照样派 review / 独立重推 / 加固验证（commit0 里体现为 6 轮里 3 轮在复核）。
- **每轮画图前告知节点上限。** 每轮教条末尾带上实际配置的 `maxBatchSize`（默认 8）。之前模型只能撞墙才知道：一次写了 16 节点被拒（55 秒白写），随后一整步都在推演"怎么塞进 8 个节点"。
- **预算到期强制写报告。** 预算到点后：停掉在跑的活 → 要求写报告（磁盘上有什么、什么被确认、还差什么；禁止"我将要做"）→ 报告阶段拒绝一切工具 → 报告没有时间上限，只受计划自身的取消约束。之前到期后给一段延长窗口（`max(45s, 预算/4)`），模型把窗口用来继续干活，窗口结束被销毁，报告一个字没写：humeval 一次 1,171 秒的 run 里，有 558 秒是父代理重做一件已经做完的事。

### 修复

- **`budgetWarn` 破坏工具输出契约。** 该字段进了返回值却没进 `output.schema`，harness 的 `additionalProperties: false` 拒绝整个结果——计划的节点已经跑完，模型却只拿到错误，于是把同一张图又画了一遍（panel 一次连画三次 + 派 spawner，38 个 agent、2,151 秒）。补进 schema，并新增 `verify/output-schema.spec.ts` 用 harness 自己的校验器守住这类错误。
- **归一化统计。** 子代理只统计种子之后的事件，并按会话树递归（forker 派的孩子也计入）；之前把父代理的模型时间算进子代理，被迫对插件臂偏乐观。

### benchmark

- 修复全部任务里的坏路径、过期计数和过期判据（"8 个模块"这类写死的描述与仓库实际不符，曾让 worker 花约 26k 字符推理"到底哪 8 个"）。
- `lhtb-commit0` 从套件退役：本机网络可达且模型能逐字默写上游源码，两个臂的"实现"都被判为抄袭，正确性信号失效（10 次跑法里 6 次自写分为 0）。
- 新增 `bench/summary.mjs`（归一化总表）、`bench/cost.mjs`（按 DeepSeek 价目表折算花费）、`bench/check-report.mjs`（核对报告阶段是否发生）、`bench/fit-speed.mjs`（拟合 token 与等待时间）、`bench/audit-guidance.mjs`（检查教条重复）。

### 数据（2.6.0 实测）

- 10 个任务各 5 对，归一化时间几何平均 **0.87×**（上一版 1.09×），token **0.69×**，正确率平均 −1.7 个百分点。
- 快的：humeval-hard 0.43×、panel 0.54×、nbody 0.54×、quixbugs 0.63×、review 0.91×；慢的：coverage 1.67×、humeval 1.56×、2048 1.11×、matpower 1.07×。

## 2.5.0

- 一轮一个计划图：`refine_plan` 的节点并行执行，结果一起返回。
- 四种节点：`tools` / `worker` / `spawner` / `forker`。
- 结论契约：三段式、不要收据（行号/证据/引用）、原始工具输出有上限。
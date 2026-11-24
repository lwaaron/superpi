# 会话中断治理 —— 诊断与验收

> 用户 2026-11-19 报：「目前正在运行的会话总是中断」。
> 本文档先给**基于实测数据的归因**，再给验收判据。任何结论都可复算。
>
> 样本：`~/.pi/agent/sessions/--D--my_projects-SuperPi-SuperPi--/2026-11-17T14-49-42-194Z_*.jsonl`
> （4097 条记录 / 59.6 MB / 1972 次 assistant 调用 / 跨越 3 天）

---

## 0. 先回答用户的直接疑问

> 「Elapsed 31.8s 时，等待上限和那个 `timeout 900` 就中断的机制，这些机制会不会导致会话中断？」

**不会。证据是穷举的，不是推断的。** 全部 17 次中断逐条分类如下：

| 类型 | 次数 | 归因层 | 与 `timeout` 有关？ |
| --- | --- | --- | --- |
| `ECONNRESET` | 6 | 网络（上游主动断连） | 否 |
| `BODY_TIMEOUT` | 4 | **pi 的 HTTP idle 超时（300s）** | 否 |
| `CONNECT_TIMEOUT` | 3 | 网络（连不上 `api.odys.work:443`） | 否 |
| `CONTEXT_OVERFLOW` | 2 | 上下文超上游 1,048,576 上限 | 否 |
| `RATE_LIMIT` | 1 | 账号并发限制 | 否 |
| **`timeout 900` / bash 上限** | **0** | —— | —— |

`bash` 的 `timeout` 与 `timeout 900` 是**命令级**限制：它们只会让**那一条命令**以
`ShellTimeoutError` 结束，返回值带 `exit_code`，agent 拿到结果后**继续下一轮**。
它们**不可能中断会话**——pi 的 bash 工具（`dist/core/tools/bash.js:101-140`）在超时时
`killProcessTree` 然后 `throw ShellTimeoutError`，这个异常被工具层捕获成 `isError` 的工具结果。

**`stopReason` 统计是决定性的**：1972 次 assistant 调用中
`toolUse: 1903 / stop: 69 / error: 17`。17 次 `error` 与上表一一对应，
**没有一次来自工具超时**。

---

## 1. 真正的中断原因（按可治理性排序）

### 1.1 `BODY_TIMEOUT`（4 次，最可疑、最可治理）

实测这 4 次的**距上次产出间隔**分别是 **317s / 333s / 323s / 503s**。

`DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000`（`dist/core/http-dispatcher.d.ts:1`）。
`rpc-entry.js:9` 与 `cli/setup.js:10` 都是 `configureHttpDispatcher()` **不带参数**调用，
所以调度器先按 300s 起；随后 `main.js:765` 会用
`configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs())` 再配一次。

**结论**：只要 `~/.pi/agent/settings.json` 里写 `httpIdleTimeoutMs`，RPC 模式就能生效
（`main.js:765` 在 `:828` 进入 `runRpcMode` 之前执行）。

**为什么这 4 次会撞上**：`output` token 分布 `p50=232 / p90=1253 / p99=5370 / max=16922`。
长思考（`max` 档推理）时，**在第一个 token 流出之前**模型可能思考数分钟 ——
这段时间 HTTP 连接完全静默，idle 计时器就在跑。**思考越深，越容易撞墙。**
这与上下文规模无关（`ctx=7.3%` 也触发过），**纯属时长问题**。

> 这是「能力被机制误伤」的典型：用户开了 `thinkingLevel: max`，反而更容易被 300s 掐断。

### 1.2 `CONTEXT_OVERFLOW`（2 次，硬中断，无自动恢复）

```
400: 上下文超出上游上限（1048576 tokens，本次估算 1309796 tokens）
Input too long: 1095829 tokens exceeds this provider's limit of 1048576
```

当前会话上下文已达 **77.7%（814k / 1048k）**，距硬墙只剩 22%。
守卫的 `targetRatio=0.72` 只管「请求前裁剪」，但**保护区自身**（最近 6 轮 / 120 条 /
窗口 30%）可能把总量顶到 77% —— 77% 已经高于 72%，说明**保护区的下限比目标还高**，
这是一个结构性矛盾。

### 1.3 `ECONNRESET`（6 次）与 `CONNECT_TIMEOUT`（3 次）

上游网络抖动，本机无法根治。但**可以减痛**：pi 的 `retry.maxRetries=3`、
`baseDelayMs=2000` 已开。真正的痛点是**流式中途断连会丢失已流出的输出**，
用户看到的是「话说到一半没了」。这一层需要「断点续」而非「重试」，
属于高成本改动，列为观察项。

### 1.4 上游在结束帧前报错（0.22.0）

状态迁移基准的真机首轮里，模型请求运行约 55.9 秒后收到 `Upstream response stream ended before completion`。Pi 记录为 `stopReason: 'error'`，该网关措辞超出了 Pi 1.5.2 的原生重试判据。

SuperPi 在 Pi 的回合边界发现这条明确的错误时，把失败响应移出下一次请求的投影，并从当前目标与已经完成的工具结果继续一次。原始记录保留供核查。断流轮次的未完成工具调用由 Pi 拒绝执行，恢复不重放先前的调用。已由 Pi 原生处理的重试沿用原调度。主动作业停止或关闭 `retry.enabled` 时不启动补充恢复。回环流式回归覆盖已落盘写入、被中断的工具参数、重复断流和恢复后的单次收尾。

---

## 2. 修复方案（按层归属，不打补丁）

| 层 | 问题 | 修法 | 判据 |
| --- | --- | --- | --- |
| **配置层** | `httpIdleTimeoutMs` 默认 300s，长思考被误杀 | host 在 spawn 前确保该值 ≥ `MIN_HTTP_IDLE_TIMEOUT_MS`（默认 30 分钟）；**不关闭**（关闭等于放弃网络故障兜底） | 新会话 spawn 后 `settings.json` 里该值达标；且**只在低于下限时才写**（不覆盖用户设的更大值） |
| **守卫层** | 保护区下限 > 目标，导致总量顶到 77% | 让 `targetRatio` 成为**硬上限**：保护区在 `targetRatio` 之外还要留出 `safetyMargin`，总量绝不能逼近硬墙 | 构造「保护区自己就超 72%」的会话，裁剪后必须 ≤ targetRatio |
| **可观测层** | 用户看不到「还要等多久 / 是否已越过红线」 | ①工具执行期显示进度心跳；②上下文 ≥70% / ≥85% 两档显式提示 | 见 §3 判据 |
| **提示层** | 模型自己不知道上下文占比，无法自我整理 | 每轮向系统提示注入「当前目标 + 总占比 + 各类占比」仪表 | 见 §3 判据 |

---

## 3. 验收判据（每条都可执行、可红）

### 判据 A：`timeout` 不得中断会话（回归保护）

```
构造：bash 工具 timeout=1s、命令 sleep 5
期望：工具结果 isError=true 且带超时文案；会话继续；stopReason 不是 error
```

这条是**防止未来有人「顺手」把工具超时提升成会话中断**。当前行为正确，需锁死。

### 判据 B：HTTP idle 超时下限

```
settings.json 无 httpIdleTimeoutMs         → 写入 MIN_HTTP_IDLE_TIMEOUT_MS
settings.json 有 600000（10 分钟）          → 保持 600000（不降级用户设置）
settings.json 有 0（用户显式 disabled）      → 保持 0（尊重显式选择）
settings.json 是坏 JSON                     → 不崩，不覆盖
写入是幂等的                                → 连续两次调用内容不变
```

### 判据 C：上下文红线

```
planContextWindow 后：
  after ≤ windowTokens × targetRatio          （硬上限，无条件）
  若保护区自身超 targetRatio                   → 保护区必须收缩（不是放弃目标）
  统计里 hasSafetyMargin = true               （明确记录留了多少余量）
```

### 判据 D：进度心跳

```
工具执行超过 HEARTBEAT_AFTER_MS（默认 15s）时，Working 行必须显示：
  · 当前工具名
  · 已运行时长
  · 命令自设上限（若有）
且这些信息在**没有 pi 重绘**的情况下也会刷新（自驱动定时器，0.14.2 已建）
```

### 判据 E：每轮上下文仪表

```
before_agent_start 注入的段里必须含：
  · 当前任务目标（来自最近一条 user 的首行，截断到 120 字符）
  · 总占用百分比（守卫估算 / 窗口）
  · 各类占比（图片 / 思考 / 工具输出 / 回复）
且：占比低于 50% 时只给一行紧凑格式（不浪费 token）
    占比 ≥50% 时给完整拆解 + 明确的整理建议
```

---

## 4. 不允许的「假修复」

| 反模式 | 为什么不行 |
| --- | --- |
| 把 `httpIdleTimeoutMs` 设成 `disabled` / `0` | 网络真挂时永远不返回，界面永久转圈 —— 换一种卡死 |
| 把 `targetRatio` 调低到 0.5 让「不超限」 | 上下文被无谓砍半，能力直接降级 |
| 失败就自动清空上下文重开 | 丢掉用户任务连续性，比中断更伤 |
| 把工具 timeout 调小让等待变短 | 全量测试跑不完 = 禁止验证 |
| 只在日志里记 `overBudget` 不处理 | 就是 0.14.0 修掉的病 |
| 靠「重试」掩盖 `CONTEXT_OVERFLOW` | 重试用的还是同一份超限上下文，必然再失败 |

---

## 5. 反产品模式清单（本节是长期约束，写进 AGENTS.md）

用户 2026-11-19 明确：**任何让系统在实现目标过程中中断、能力降级、方案委屈求全
（而非求最优）、降低质量或降低指标要求的做法，都不符合产品发展方向，都是阻碍，
都应被消除。** 完整枚举见 `docs/anti-product-patterns.md`。

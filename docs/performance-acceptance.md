# 0.14.0 性能与卡顿根治 —— 验收文档

> 本文档是「面板慢 / 一卡好几分钟」这一轮修复的**唯一验收依据**。
> 每一条都必须是**可执行判据**（跑一条命令就能红或绿），不接受「看起来快了」。
>
> 基线会话：`~/.pi/agent/sessions/--D--my_projects-SuperPi-SuperPi--/2026-11-17T14-49-42-194Z_01a1e9fc-3431-7551-b7af-f2256c12c12e.jsonl`
> 实测形态：3262 条消息 / 116 张 base64 图（48.6 MB）/ 文件 54.6 MB / 单条最大帧 1.50 MB

---

## 0. 先确立可信基准（这一步错了，后面全白做）

诊断期出现过三个互相矛盾的数字，必须钉死口径，否则「优化」会朝错方向走：

| 来源 | 数值 | 是否可信 | 判定依据 |
| --- | --- | --- | --- |
| provider `usage.cacheRead/cacheWrite` | 86,516 | **不可信** | 缓存命中时只报增量，不是完整上下文规模 |
| 守卫估算（charsPerToken=3） | 2,743,818 | **可信** | 与 pi 自身报错的交叉验证一致（见下行） |
| pi 自身 400 报错「本次估算」 | 1,309,796 | **准绳** | 4,058,822 字符 / 1,309,796 = **3.10**，与 `charsPerToken=3` 吻合 |

**结论：`charsPerToken = 3` 的口径正确，不需要改。** 守卫的病不是「算错了」，而是「算对了却裁不动最贵的对象」。

**验收判据 A（口径锁定）**
```
charsPerToken 默认值 === 3，且 estimateMessagesTokens 对同一输入幂等
```

---

## 1. 「卡好几分钟」的两类根因，必须分开验

诊断已确认这两件事**机制完全不同**，不能用同一个指标验收：

### 1.1 合法长等待（工具真的在跑）—— 要「可见」，不是要「更快」

实测：1640 次工具执行中 71 次 >60s，累计 **198 分钟**；9 次 >300s，累计 78 分钟；最长 **1201 秒**。
全是 `bash`，且都是**模型自己传了大超时**：`timeout` 参数 p50=300s、p90=1800s、max=120000s，还出现 `for i in 1 2 3; do timeout 2500 npm test; done`。

这类等待**不应该被砍掉**（砍掉等于让模型无法跑全量测试），但**必须让用户看见它在干什么、还剩多久**。

**验收判据 B（等待可见）**
- Working 行在工具执行期间显示：工具名、已运行时长、命令自带的上限（若有）。
- 形如 `bash · 8m20s · 上限 500s`；无显式 timeout 时显示 `bash · 8m20s`。
- 上限已过而尚未返回时，显示为「超出上限，可能仍在下游执行」，不得静默继续加秒数。
- 判据落在 `test/host-parity.mjs`（数据面）与 `test/client-render.mjs`（渲染面）各一条。

### 1.2 真冻结（CPU 同步阻塞）—— 要「变快」

实测三处叠加：

| # | 位置 | 机制 | 实测代价 |
| --- | --- | --- | --- |
| ① | `src/pi-rpc.mjs:88-100` `LineSplitter.push` | 每 chunk 都 `Buffer.concat` 全量 + 从下标 0 重新 `indexOf`，O(n²) | 55MB 单行 / 64KB 分块 = **9,241 ms** 同步阻塞 |
| ② | `index.js` `get_messages` 响应 | 一次吐 3251 条 / 55.1 MB，响应体无任何上限 | 序列化 + 传输 + 前端解析各一次 |
| ③ | `client.js:6427` `view.messages.map(MessageRow)` | 全量渲染 3000+ 行，含 116 个 `data:` 大图 | 每轮 bash 结束都触发一次 |

**验收判据 C（帧解析线性化）**
```
55MB 单行 / 64KB 分块：< 300 ms（基线 9,241 ms，改善 ≥ 30×）
 1MB 单行 / 64KB 分块：< 10  ms
且：分块大小在 1KB / 64KB / 1MB / 4MB 下解析结果完全一致（不得因优化改变切帧语义）
```
落在 `test/host-parity.mjs`。**这一条是纯 CPU 判据，不依赖网络与 pi。**

**验收判据 D（历史分页）**
```
get_messages 默认返回条数 ≤ HISTORY_PAGE_SIZE（默认 120）
返回体中 image 块默认替换为 { type:'image-stub', bytes, mimeType }，不带 base64
单次响应体 ≤ 1 MB（对 3262 条 / 116 图的基线会话实测）
真实图片 bytes 走 GET /sessions/:id/images/:index，按需取，单张 ≤ 原始大小
更早的历史走 GET /sessions/:id/messages?before=<seq>&limit=<n>，可一直往前翻到第 0 条
```
落在 `test/host-parity.mjs`。

**验收判据 E（渲染窗口化）**
```
首次渲染条目数 ≤ RENDER_WINDOW（默认 80）
向上滚动到顶时自动加载更早一页，且滚动位置不跳变
总条目 3262 时，首屏渲染耗时 < 100 ms（用 client-render 的同步渲染计时断言）
DOM 中 data: URL 图片数量 ≤ 视口内可见图片数
```
落在 `test/client-render.mjs`。

---

## 2. 上下文守卫：从「裁不动」到「裁得动且自愈」

### 2.1 病根一：本轮冻结把所有贵东西锁死了

`apply()` 里 `if (i >= lastUserIndex) continue`（图片阶段另有同义跳过）。而本会话最后一条 user 在 index 2584，其后 **678 条消息 / 733,034 tokens**，占窗口 73%、占预算 **102%**；其中 **48 张图 × 12,000 = 576,000 tokens**，单这一项就吃掉预算的 80%，而规则明令不许动。

**为什么这是设计缺陷而不是配置问题**：视觉迭代类任务（渲染→截图→比对）必然在**同一轮内**持续产图。假设「图片都是历史遗留物」在这个场景下不成立，于是最贵的资源永久免疫。

**修复**：本轮冻结只保留给 **text**（模型正在读的文字不能抽走）；**图片按「最近 N 张」计量，跨轮际一视同仁**。N 默认 4，占位文本带路径可重读 —— 能力不损失，只损失「同时盯着 48 张图」这个本就不该有的特权。

**验收判据 F（本轮图片限额）**
```
最后一条 user 之后有 48 张图、预算 = 窗口 × 0.72 时：
  裁剪后本轮保留的 image 块 ≤ keepRecentImagesPerTurn（默认 4）
  被替换的每一处都是 { type:'text' } 且文本含原文件路径（可重读）
  本轮所有 text 块与 toolCall 块一字未改
本轮只有 2 张图时：两张都保留（低于限额不裁）
幂等：对裁剪结果再跑一次，输出与输入同一数组引用
```
落在 `test/context-guard.mjs` C 段。

### 2.2 病根二：toolCall 参数无人管

五个阶段（images / thinking / toolText / toolFold / replies）没有任何一个处理 `toolCall.arguments`。实测裁剪后前缀里 assistant 的 toolCall 参数仍有 **1,377,032 字符 ≈ 459k tokens**，其中 177 条 >2000 字符累计 248k。它们全是 `write` / `edit` 的正文 —— **已经落盘的文件内容**，上下文里留一份副本毫无价值。

**修复**：新增第 6 阶段 `toolCallArgs`，排在 `toolFold` 之后、`replies` 之前。旧轮次的 `write` / `edit` / `patch` 类调用，参数折叠为 `[write omitted: <path>, <N> chars — 需要时重新 read]`。**执行顺序有讲究**：它比 `replies` 早，因为「文件正文」比「模型结论」更没有复用价值。

**验收判据 G（参数折叠）**
```
构造 prefix 含 20 条 write 调用（每条 arguments 8000 字符）的会话：
  裁剪后这些 arguments 的 JSON 长度总和 < 原始 10%
  占位文本包含文件路径
  toolCall 的 id / name 字段不变（否则 toolResult 对不上，pi 会报孤儿）
  本轮（最后一条 user 之后）的 toolCall 参数一律不动
  只折叠白名单工具（write/edit/patch/apply_patch），bash 的 command 不折叠（要看它干了什么）
```
落在 `test/context-guard.mjs` C3 段。

### 2.3 病根三：overBudget 只举手不兜底

裁到最狠仍差 513,615 tokens（超预算 71%）时，代码只把 `overBudget: true` 写进日志。于是日志里连续上百行全是 `overBudget: true`，**这个信号已经失去区分度**。

**修复**：五阶段跑完仍超预算 → 执行兜底：**按整轮（user 边界）丢弃最旧的轮次**，恒保留「首条 system + 首条 user + 最近 keepRecentTurns 轮」。兜底后仍超预算，才置 `overBudget: true` —— 此时它表示「这个会话真的没救了，必须 /compact 或新建」，重获区分度。

**验收判据 H（兜底自愈）**
```
构造 40 轮、每轮 20 张图、窗口 100k 的极端会话：
  裁剪后 after ≤ budget（必须真正达标，不是标记一下）
  droppedTurns > 0（记录丢了几轮）
  首条 user 消息仍在（任务目标不能丢）
  最近 keepRecentTurns 轮完整保留（正在干的活不能丢）
兜底后仍超预算时：overBudget === true 且 after > budget（诚实）
无轮次可丢（只有 1 轮）时：不崩、不无限循环、overBudget === true
```
落在 `test/context-guard.mjs` C4 段。

---

## 3. 端到端验收（真 pi、真会话、真面板）

以下三条是**人工 + 脚本混合**验收，必须用基线会话实跑，不接受合成数据：

| # | 场景 | 通过标准 |
| --- | --- | --- |
| E2E-1 | 用基线会话（3262 条 / 116 图）打开面板 | 首屏可交互 < 2 s；`get_messages` 响应体 < 1 MB；DOM 条目 < 120 |
| E2E-2 | 在该会话里跑一条 `timeout=500` 的命令 | Working 行显示 `bash · 计时 · 上限 500s`，500s 后变为「超出上限」而不再无限加秒 |
| E2E-3 | 连续 5 轮各产 8 张图 | 守卫日志 `overBudget` 不再恒为 true；第 3 轮起 `after` 稳定在 budget 以内 |

**E2E-1 的 2 s 从哪来**：现在打开该会话需要序列化 55MB + 传输 + 解析 3251 条 + 渲染 3000 行，实测远超 2 s；改造后这三项分别降到 ~0.3MB / 120 条 / 80 行。

---

## 4. 不允许出现的「假达标」

以下每条都是**看起来达标、实际把问题推给未来**，一律视为验收失败：

| 反模式 | 为什么不行 |
| --- | --- |
| 把 `RENDER_WINDOW` 调到 10 让首屏变快 | 用户滚不到历史，能力退化 |
| 把 `get_messages` 改成只返回最近 20 条且无翻页 | 同上，且 `docs/parity.md` 会出现新缺口 |
| 关掉图片发送（`blockImages`）来省 token | 视觉任务直接废掉，这是降级不是优化 |
| 把 `charsPerToken` 调到 30 让估算「变小」 | 只是让超限更晚发生，报错照样来 |
| 给 `overBudget` 加个 `if` 让它不再写日志 | 擦掉证据，不是修复 |
| 缩短 `bash` 的 timeout 让等待变短 | 全量测试跑不完，等于禁止模型验证 |
| 只改 panel 不改 TUI，或反之 | 违反 AGENTS.md §3 的 100% 对齐 |

---

## 5. 门禁接线清单（少一条即视为未完成）

| 判据 | 文件 | 段 |
| --- | --- | --- |
| A 口径锁定 | `test/context-guard.mjs` | A / B |
| B 等待可见 | `test/host-parity.mjs` + `test/client-render.mjs` | 新增 |
| C 帧解析线性 | `test/host-parity.mjs` | 新增 |
| D 历史分页 | `test/host-parity.mjs` | 新增 |
| E 渲染窗口化 | `test/client-render.mjs` | 新增 |
| F 本轮图片限额 | `test/context-guard.mjs` | C |
| G 参数折叠 | `test/context-guard.mjs` | C3 |
| H 兜底自愈 | `test/context-guard.mjs` | C4 |
| 两端对齐 | `test/parity.mjs` + `docs/parity.md` | 同步 |
| 全绿 | `npm test` | EXIT=0 |

---

## 6. 验收签署

修复完成必须能回答这三个问题（答不全 = 还是补丁）：

1. **原来的坏路径物理上还能走通吗？** —— 55MB 单帧还会不会 O(n²) 阻塞？开启会话还会不会一次拉 55MB？本轮 48 张图还会不会免疫裁剪？
2. **同样的诱因再来一次，系统会进入什么状态？** —— 再开一个 3000 条 / 100 图的会话，会不会又卡死？会不会又 overBudget 恒真？
3. **有没有留下「如果根治失效就会红」的判据？** —— 上表 8 条判据是否都在 `npm test` 里，且都能真的红？

> 只有三条全过，才在 `## 6` 变更记录里写「闭环」。

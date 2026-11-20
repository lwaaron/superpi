# 对抗性审查报告 — SuperPi v0.16.0

审查日期：2026-11-20
基线：`d2e98db feat(0.16.0)`，工作区干净，`npm test` 18 项全绿 EXIT=0
方法：不采信文档声称，一切结论以可复现探针（`_scratch/probe-*.mjs`）或静态证据（文件:行号）为准

---

## 0. 结论摘要

**门禁全绿，但存在 2 个 P0 级功能缺陷，全部位于同一层，而该层恰好是整条门禁链的唯一空白地带。**

这个巧合不是偶然，而是同一条缺陷的两个面：

| 面 | 表现 |
| --- | --- |
| 运行时 | 客户端「事件摄入层」有 3 个叠加缺陷，导致切会话/重连后事件与弹窗丢失 |
| 门禁 | 该层没有任何门禁覆盖（`client-render` 只做首帧 SSR，不跑事件流；`host-parity` 只测 host） |

因此本报告提两条主线，而不是八条并列缺陷：

- **主线 A（运行时缺陷）**：事件摄入层的水位语义与契约字段消费不完整 → F-01/F-02/F-03
- **主线 B（门禁失效）**：门禁把「无法验证」当成「验证通过」→ F-05/F-06/F-07

F-01（死会话永不回收）看似独立，实为同一设计缺陷的下游：会话池的成员资格以「创建」为界，而非以「存活」为界；这与事件摄入层「以水位为界而非以事实为界」是同一种思维惯性。

---

## 1. 分级发现清单

| 编号 | 级别 | 标题 | 证据 |
| --- | --- | --- | --- |
| F-01 | **P0** | 会话池只增不减：死进程永久占位，8 次后新建会话 429 | `index.js:743-744`；探针 `probe-pool-full.mjs` |
| F-02 | **P0** | `attach()` 先抬 `lastSeq` 再 `applyBatch`，缓冲事件 100% 丢弃 | `client.js:5551-5553` + `:2088`；探针 `probe-attach-seq.mjs` |
| F-03 | **P1** | `snapshot.pendingUi` 全仓库无消费者，弹窗在 UI 上不存在 | `src/pi-rpc.mjs:603` vs `client.js` 零引用；探针 `probe-pendingui.mjs` |
| F-04 | **P1** | 超时续期与 F-03 叠加 → 最长 12 分钟静默无响应 | `src/pi-rpc.mjs:474-492`；探针 `probe-timeout-math.mjs` |
| F-05 | **P1** | `parity` 缺 pi 时只打印 SKIP 仍 PASS（实测 102→87 条） | `test/parity.mjs:256-263`；实测 |
| F-06 | **P1** | 6 套门禁缺依赖即整段 SKIP 且 exit 0；新机器上 521 条 TUI 检查全跳过仍报绿 | `test/tui-editor.mjs:39-40` 等；实测 |
| F-07 | **P2** | 文档声称的 check 数全面漂移且无门禁校验 | AGENTS.md vs 实测；探针 `probe-doc-drift.mjs` |
| F-08 | **P2** | `dead` 状态可被缓冲残留事件改回 `ready`（状态穿透） | `src/pi-rpc.mjs:309-311`；探针 `probe-exit-race.mjs` |
| F-09 | **P2** | `/sessions/:id/reset` 死路由：客户端有封装零调用，无门禁 | `client.js:1093` / `index.js:1419` |
| F-10 | **P2** | 11 条以上 SSE 触发 `MaxListenersExceededWarning`（假警报） | 探针 `probe-sse-many.mjs` |
| F-11 | **P3** | 会话池无空闲回收；8 会话约 850MB 常驻 | 探针 `probe-resource2.mjs`（单进程 ~106MB） |
| F-12 | **P3** | `PiPanel` 单组件 1759 行 / 34 useState / 12 useRef | `client.js:5186-6943` |
| F-13 | **P3** | `start()` 立刻置 `ready`，spawn 失败存在瞬态谎报窗口 | `src/pi-rpc.mjs:229`；探针 `probe-spawn-fail.mjs` |

---

## 2. 主线 A：客户端事件摄入层

### 2.1 F-02 — 水位与回放的语义顺序颠倒（P0）

**代码事实**

```js
// client.js:5549-5553
var view = viewRef.current
view.messages = []
view.lastSeq = 0
view.openIndex = -1
view.streamingIndex = -1
view.lastSeq = typeof snapshot.eventSeq === 'number' ? snapshot.eventSeq : 0  // ← 先抬到最高
applyBatch(view, Array.isArray(snapshot.events) ? snapshot.events : [])       // ← 再回放，全被丢弃
```

`applyBatch` 的判据（`client.js:2087-2089`）：

```js
var seq = typeof entry.seq === 'number' ? entry.seq : 0
if (seq > 0) {
  if (seq <= view.lastSeq) continue   // ← 缓冲里所有 seq ≤ eventSeq，全部 continue
  view.lastSeq = seq
}
```

**探针结论**：3 条缓冲事件，实际应用 **0** 条。

**为什么门禁没发现**：`client-render.mjs` 用 `renderToStaticMarkup` 做首帧 SSR（63 处），从不模拟事件流。`applyBatch` 在该文件里出现 **0** 次。

**影响半径**（比单点更大）：
- `attach()` 路径：首次挂载、`switchDir`、`reload` 全走它 → 缓冲事件全部丢失
- 旧 SSE 窗口：host 在 `send(200)` **之后**才 `resetEvents()`（`index.js:1391`），客户端此时 `lastSeq` 仍是旧会话的（可能 87），新会话事件 `seq=1..3` 被判 `≤ 87` 丢弃

**为什么用户没有大规模抱怨**：正文由 `hydrate()`（`get_messages`）兜住了（这是 0.4.1 修 D-09 时加的）。但**运行态与弹窗兜不住** —— 这正是 F-03。

**根因层级**：不是"顺序写错了"，而是**水位（watermark）与回放（replay）两个语义混用一个字段**。正确语义是 `lastSeq = max(已应用的最大 seq, snapshot.eventSeq)`，即水位只能在应用之后前进，不能预先跳。

---

### 2.2 F-03 — 契约字段无消费者（P1）

**代码事实**

- host 确实下发：`src/pi-rpc.mjs:603` `pendingUi: [...this.pendingUi.values()]`
- 面板**零消费**：`client.js` 中 `snapshot.pendingUi` 出现 **0** 次
- `docs/parity.md` 的 **D-05 却标记为「已闭环」**，理由是「`pendingUi` 随 `snapshot()` 下发」

**这是本次审查最值得记住的一条**：D-05 的验收只覆盖到"管道通了"（host 下发了），没有覆盖到"交付到了"（面板渲染了）。门禁同理 —— `test/parity.mjs:338` 只断言 `agent_settled` 会**清空** `pendingUi`，`test/timeout.mjs` 只测 host 侧的 `pendingUi` 登记与续期，**没有一条断言面板会读它**。

**影响**：面板刷新 / 首次挂载时若 pi 正等扩展弹窗，该弹窗在 UI 上不存在 → 用户无法应答 → 只能等超时。

---

### 2.3 F-04 — 静默 12 分钟（P1，F-03 的下游放大器）

`src/pi-rpc.mjs:474-492` 的续期逻辑本身是正确的设计（避免"命令超时与仍在倒计时的对话框并存"）。但它与 F-03 叠加后：

- 弹窗不可见 → 无人应答 → 每 60s 续期一次，上限 12 轮
- **12 分钟内用户看到的是「发送后没反应」**，没有任何提示说明在等什么
- 到期后报错文案是 `pi command timed out: prompt (1 dialog(s) never answered)` —— 只有看到这句才知道真因

注：`restartPendingTimers()`（`:532-539`）在每次应答后把 `deferrals` 归零，所以「只要有人点，窗口就无限延续」是**刻意设计**，不是缺陷。缺陷在于**没人能点**。

---

### 2.4 F-01 — 会话池以「创建」为界（P0）

**代码事实**

```js
// index.js:743-744
sessions.set(proc.id, proc)
proc.on('exit', () => log('info', 'session ' + proc.id + ' exited'))   // ← 只记日志，不 delete
```

唯一删除点：`index.js:1310` 的 `DELETE /sessions/:id`（用户主动）与 `ctx.effect` 的卸载清理。

**探针实测**

| 场景 | 结果 |
| --- | --- |
| 池内 8 个 dead 会话 | `POST /sessions` → **429**「会话数已达上限（8），先关掉一个」 |
| `GET /sessions/:dead-id` | **200**（仍被当作可用会话） |
| 客户端 `startSession()` | 取 `existing[0].id`（`client.js:5658-5659`）→ **复用死会话** |
| 客户端收到 `exit` 事件 | 只 `markIdle` + 一条 notice（`client.js:5534-5540`）→ **不 close** |

**恢复路径是存在的，但不显眼**：「重连」（`endSession` → `api.close` + `startSession`）会先 DELETE 当前会话，能救。问题在于：
- 「重连」藏在 `⋯` 更多菜单里且要二次确认（0.7.0 的刻意设计，见 D-03）
- 面板崩溃后 `startSession` 会优先复用 `existing[0]` —— 如果它是死的，`attach` 仍返回 200，接着一切操作都失败
- 面板**没有**「关掉某个会话」的独立入口（`api.close` 只被 `endSession` / `switchDir` 内部使用）

**根因层级**：会话生命周期管理层。判据应该是「进程是否存活」，现在是「是否曾被创建」。这与 F-02 的「以水位为界而非以事实为界」是同一个思维惯性：**用代理指标替真实状态**。

---

## 3. 主线 B：门禁把「无法验证」当成「验证通过」

### 3.1 F-05 — 最核心的对齐门禁可被静默跳过（P1）

`test/parity.mjs:256-263`：

```js
const piDir = findPiPackage()
if (piDir === null) {
  console.log('SKIP 与 pi 类型对账：没找到 @earendil-works/pi-coding-agent')
  // ← 不设置失败标志，继续往下跑
}
```

**实测**：强制 `findPiPackage` 返回 `null` → `PASS (87 checks)`，`EXIT=0`。
**丢掉的 15 条**正是「命令面 / 事件面 / 扩展 UI method 与 pi 对账」的全部内容 —— 也就是 AGENTS.md §3「100% 对齐」的机器保障本体。

这与 AGENTS.md 自己的表述直接冲突：

> 这三套门禁是本仓库对齐的机器保障，不是可选装饰：删掉或绕过它，等于把"100% 对齐"退回人肉承诺。

**今天的现实**：只要换一台没装 pi 的机器，这条保障就自动退回人肉承诺，而 CI 是绿的。

### 3.2 F-06 — 这是系统性的，不是孤例（P1）

**实测**（隐藏 `.runtime` 与 `node_modules/@earendil-works` 后）：

| 门禁 | 有 pi | 无 pi | 退出码 |
| --- | --- | --- | --- |
| `parity` | 102 | 87（SKIP 1） | 0 |
| `tui-editor` | 521 | **整段 SKIP** | **0** |
| `context-guard` | 179 | 160（SKIP 1） | 0 |
| `modalities` | 76 | 55（SKIP 3） | 0 |
| `rules` | 207 | 161（SKIP 1） | 0 |

`npm test` 在无 pi 的新机器上**依然全绿**，但 `tui-editor` 的 521 条检查一条都没跑。

**判据缺失**：仓库没有任何「依赖就绪前置断言」。`test/selfcheck.mjs` 断言的是「仓库自身文件清单完整」，不涉及外部依赖。

### 3.3 F-07 — 文档的 check 数已全面漂移（P2）

| 门禁 | AGENTS.md 声称 | 实测 | 偏差 |
| --- | --- | --- | --- |
| `parity` | 98 | 102 | +4 |
| `host-parity` | 412 | 430 | +18 |
| `context-guard` | 150 | 179 | +29 |
| `tui-editor` | 459 | 521 | +62 |

**没有任何门禁校验这些数字**（grep `test/*.mjs` 无命中）。

这不是"数字不准"的小事。AGENTS.md §3 把「门禁数量」当作对齐强度的证据（"412 checks"被加粗强调）。数字漂移后，**文档从"可校验的事实"退化为"曾经的印象"**，而它恰恰是接手者唯一的行为指南。

---

## 4. 已核实为**无问题**的项（避免后续重复排查）

对抗性审查同样要给"清白"的结论，否则下一个人会重做这些工作。

| 项 | 结论 | 依据 |
| --- | --- | --- |
| XSS / HTML 注入 | **无风险** | 全仓库 `innerHTML` / `dangerouslySetInnerHTML` / `insertAdjacentHTML` 均为 0 处；markdown 渲染器 `client.js:1545` 明确"绝不拼 HTML 字符串" |
| 串行写队列 | **实现正确** | `src/ui-prefs.mjs:263-270` 的 `queue = result.then(()=>undefined, ()=>undefined)` 保证一次 400 不会卡死后续；三个 store（ui-prefs / rules / modalities）同构 |
| SSE 监听器泄漏 | **无泄漏** | `proc.on` 2 处 / `proc.off` 2 处成对；实测 12 条连接全部断开后回落到 0 |
| 进程退出时待决命令 | **正确处理** | `handleExit` 清空 pending 并 reject 所有 waiter，且幂等（二次调用无副作用） |
| `readJsonBody` 边界 | **正确** | 4MB 上限，超限 reject 413 并 destroy |
| 路径穿越 | **不存在** | 图片 id 只在内存表查（`index.js:1515-1534`），明确"绝不从 id 反推文件路径" |
| 仓库整洁度 | **良好** | `*.tgz` / `pi-bug-report-*.zip` / `_scratch/` / `_archive/` 均已 gitignore 且未被跟踪；正式代码无 `TODO`/`FIXME`，仅 1 处有意的降级告警 |
| `handler` 路由鉴权 | **合理** | 挂载在同源 webServer 前缀（`index.js:931`），本机单用户场景下属可信域 |
| `client.js` 单文件 7133 行 | **不构成架构债** | 宿主约束"零构建、零 JSX、只 require react"下为必然；内部 16 个段落职责单一 |

---

## 5. 修复方向（按层级，非按症状）

用户原则：从架构层一层一层挖，锁定层级后改那一层，禁止跨层打补丁。

### 5.1 主线 A 的正确修法

**F-02（锁在客户端状态摄入层）**
把「水位」与「回放」解耦。`attach()` 的语义应是：

```
1. lastSeq = 0
2. applyBatch(snapshot.events)          // 让水位自然前进到已应用的最大 seq
3. lastSeq = max(lastSeq, eventSeq)     // 再补齐到快照水位（防止漏掉"已到达但未入缓冲"的）
```

**禁止的修法**：在 `applyBatch` 里加特判、在 `openStream` 里补 resync —— 那是把成本转移到相邻层，症状会换个地方再爆。

**F-03（锁在契约消费层）**
`snapshot.pendingUi` 是契约里已有的字段，缺的是消费。修法是 `attach()` 里把 `snapshot.pendingUi` 灌进 `view.pendingUi`（与 `applyExtensionUi` 同一条路径），而不是另起一套。

**F-01（锁在会话生命周期层）**
池的成员资格判据改为「存活」：`proc.on('exit')` 里 `sessions.delete(pid)`。同时面板需要能看见"这个会话已经死了" —— `meta.exit` 字段已存在（`client.js:6441` 已在读），但 `startSession` 的 `existing[0]` 选择逻辑没排除它。

**关键约束**：不能简单在 `existing` 过滤里加 `if (s.exit) continue` —— 那是症状层。正确做法是在 `stateOf()`（`index.js:788`）就把死会话排除出去，让 HTTP 面天然不返回它们。

### 5.2 主线 B 的正确修法

**F-05/F-06（锁在门禁的判据层）**
问题的本质不是"SKIP 分支写错了"，而是**门禁没有区分「通过」与「未验证」两种终态**。

正确的结构性修法：新增一个统一的 `test/preflight.mjs`，在任何门禁运行前断言依赖就绪，**缺失即失败**。而不是给 6 个文件各加一个 `if (!ready) process.exit(1)` —— 那是 6 处补丁，第 7 个门禁必然再漏（这与 `src/runtime-files.mjs` 修「硬编码复制清单漂移」的教训完全同构）。

对 `parity` 尤其严格：它是"100% 对齐"的唯一机器保障，**缺 pi 必须是失败**，不能是 SKIP。

**F-07（锁在文档的事实性层）**
两个选项，需用户定夺：
- (a) 门禁自动回填：`test/version.mjs` 跑完各门禁后把实际 check 数写回 AGENTS.md —— 但会让文档变成生成物
- (b) 文档不再写具体数字，只写「≥ N」下限断言 —— 更保守，但丢掉了"数字下降=能力退步"这个信号

**我不自行决定的理由**：这关系到 AGENTS.md 的定位（是人写的指南，还是机器维护的账本），属于产品决策而非技术决策。

### 5.3 建议的修复顺序

1. **F-05/F-06 先行** —— 理由：在门禁可信之前修 F-02/F-03，无法证明修对了。这是"先证明再删"的前提。
2. **F-02 + F-03 一起修** —— 同一层、同一路径（`attach`），分开修会各写一遍。
3. **F-01** —— 独立层，可并行。
4. 其余 P2/P3 按性价比排。

每条修完必须补门禁，且门禁要落在**对应层**：
- F-02 → `client-render` 新增"事件流摄入"段（需要能驱动 `applyBatch`，当前 SSR 架构需扩展）
- F-03 → 断言 `attach` 消费 `snapshot.pendingUi`
- F-01 → `host-parity` 断言"exit 后 `stateOf()` 不再列出该会话"

---

## 6. 对审查本身的限制说明

诚实标注本次审查**没有**覆盖的部分：

1. **未做真机 UI 走查**。所有 UI 相关结论基于代码与 SSR 渲染，未在真实 DSH 面板中点击验证。世界顶尖设计师视角的"交互状态完备性"需要实际运行才能判定。
2. **未做长时间压力测试**。F-01 的累积效应用桩进程模拟（8 个），未跑真实的多轮崩溃-重连循环。
3. **未验证 TUI 端**（`superpi-editor.ts` 2970 行）。本次审查集中在 host 与面板两端；TUI 有 521 条门禁覆盖，但那些门禁同样受 F-06 影响（缺 pi 时全跳过）。
4. **未审查 `src/session-store.mjs` 的路径语义**（523 行）。它与 pi 的 `session-manager.ts` 对齐，需要 pi 源码在场才能逐行核。
5. **性能维度未重测**。`docs/performance-acceptance.md` 的数字（55MB→224KB 等）未复验。

---

## 7. 一句话总结

这个仓库的工程质量在同类项目中属上游 —— 有 18 套门禁、有对抗性反模式清单、有"先证明再删"的纪律。它的问题不是粗糙，而是**门禁的覆盖面与它自己的雄心不匹配**：它声称守护"100% 对齐"，但漏掉了整个客户端事件摄入层，而那一层恰好是用户唯一真正接触的地方。

修复的重点不应是"补 3 个 bug"，而是**让"未验证"在门禁体系里不再等于"通过"**。

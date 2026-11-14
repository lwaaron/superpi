# dsh-pi 两端能力对齐账本（parity）

> 基线：pi `1.5.2` / dsh-pi `0.6.4` · 唯一权威 = `packages/coding-agent/src/modes/rpc/rpc-types.ts`（303 行）、`src/modes/rpc/rpc-mode.ts`（846 行，`switch` 在 `:404-737`）、`src/core/agent-session.ts`（4714 行，`AgentSessionEvent` 在 `:220-261`）
> 本文档是 `AGENTS.md` §3「100% 对齐」的账本。任何一行状态变化必须同步改这里，否则视为未完成。**本账本由 `test/parity.mjs` 与 `test/host-parity.mjs` 机器兜底**，人肉维护只是第一道。

## 0. 怎么读这张表

**两端指的是谁。** pi 有两个平级前端，跑同一个 pi、同一个 agent loop：

- **命令行 pi（TUI）**：`packages/coding-agent/src/modes/interactive/`，人肉交互。
- **dsh-pi 面板**：本仓库 `client.js` + `index.js`，通过 pi 官方 JSONL RPC 协议驱动 `pi --mode rpc` 子进程。

**「命令行 pi 的行为」不是「同名命令」。** TUI 的 27 条内置斜杠命令写在 `interactive-mode.ts:3331-3466` 的一条巨型 `if` 链里，RPC 模式（`modes/rpc/rpc-mode.ts:404-737` 的 `switch`）**一条都没有**。所以：

- 有些 TUI 能力在 RPC 侧被拆成更细的命令（`/model` → `get_available_models` + `set_model`；`/resume` → `get_state` + `switch_session`）。
- 有些 TUI 能力在 RPC 侧**完全没有**（`/share`、`/bug`、`/trust`、`/login`、`/logout`、`/reload`、`/debug` 及两个彩蛋、`/import`）。
- 反过来也成立：面板能做到 TUI 做不到的事（`set_auto_retry` / `abort_retry` —— TUI 里自动重试没有开关 UI，只在 `auto_retry_start` 时把 Esc 临时改绑成 `abortRetry()`，`interactive-mode.ts:3873-3877`）。因此「面板比 CLI 多一个开关」**不是**破坏对齐。

**状态取值（只允许这五种）：**

| 状态 | 含义 |
| --- | --- |
| 已实现 | `client.js` 真的发了这条命令 / 真的处理了这个事件，用户可见。 |
| 部分 | 走了等价路径但不是这条命令本身，行为有可观测差异。 |
| 缺口 | 面板端用户可见地缺能力，或会静默走错语义。**0.3.0 的硬指标是这一列在 RPC / 事件 / TUI 三张表里全为 0。** |
| 显式忽略 | 面板端**决定**不消费，且写明理由（不是漏了）。 |
| 仅命令行 | RPC 面没有等价能力，面板必须**明示**「仅命令行可用」，绝不能静默当 prompt 发出去。 |

**门禁已经是事实，不是目标态。** `test/parity.mjs`（77 checks）、`test/host-parity.mjs`（204 checks）与 `test/session-projects.mjs`（55 checks，0.5.0 起）都已落地，且都在 `npm test` 的 11 项流水线里：

```
selfcheck → client-render(669) → css-tokens(96) → runtime-resolve → config-hot
→ host-parity(204) → session-projects(55) → timeout(28) → parity(77) → restart-lib(31×2 引擎) → version
```

三套核心门禁都离线跑（不起 pi、不打 LLM）。`npm test` 2026-11-13 实测：加 `restart-lib` 之前 ~5.2 s，加上之后 ~14.3 s —— **`test/restart-lib.mjs` 独占约 9.1 s**（它要起 pwsh 7 与 PowerShell 5.1 两个引擎各跑一遍 fixture，进程启动开销占大头），`test/timeout.mjs` 约 3.1 s（真等若干超时周期），其余各项合计 <1.5 s。`test/parity.mjs` 做的是**三向对账**：`src/rpc-contract.mjs` ↔ pi 的类型声明与官方文档 ↔ `client.js`/`index.js` 的实际覆盖面。任一方向对不上即红：

- **我们缺的** = 缺口（pi 有、契约没有 → 面板会静默丢弃）；
- **我们编的** = 幻觉（契约有、pi 没有 → 虚构分支）；
- **死契约** = 契约里有、面板里没有落地字面量（`test/parity.mjs:221-242` 逐条 `includes` 扫）。

`test/parity.mjs` 找不到 pi 包时（`findPiPackage()` 返回 `null`，`test/parity.mjs:245-251`）会 SKIP 掉 §3/§4 的类型对账，只跑契约自洽 + 面板覆盖；此时是「降级通过」而不是「全绿」，CI 上必须让 pi 在场。

---

## 1. RPC 命令矩阵（33 条）

来源：`rpc-types.ts:20-74`（`RpcCommand` 联合类型）、`rpc-mode.ts:404-737`（`switch` 实现，`case` 从 `:409` 的 `prompt` 到 `:701` 的 `get_commands`）、`docs/rpc-commands.md`（860 行，33 个 `###` 小节，三方一致）。

| 能力 | RPC 命令 | 命令行 pi 的行为 | 面板端状态 | 门禁用例 |
| --- | --- | --- | --- | --- |
| 发送消息 | `prompt` | 提交框 `session.prompt(text)`（`interactive-mode.ts:3513-3521`）；流式中改走 `prompt(text,{streamingBehavior:'steer'})`（`:3502-3511`） | 已实现（`client.js:2869` 正常提交、`:2487` 斜杠开头走 followUp） | `RPC-01` |
| 打断并插话 | `steer` | 流式中提交即 steer（`:3507`）；压缩队列重放 `session.steer()`（`:4999`、`:5039`） | **部分**：面板不发 `steer` 命令字面量，走 `prompt` + `streamingBehavior:'steer'`（`client.js:2385`）。语义等价——两条路径在 `agent-session.ts:2375-2380` 汇进同一个 `_queueSteer()` | `RPC-02` |
| 排队下一轮 | `follow_up` | Alt+Enter（`:4676-4683`）→ `prompt(text,{streamingBehavior:'followUp'})`；重放 `session.followUp()`（`agent-session.ts:2521`） | 已实现（`client.js:2488` 纯文本；`:2487` 斜杠开头改走 prompt+followUp，因为 `follow_up` 会被 `_throwIfExtensionCommand` 打回，见 `agent-session.ts:2473-2475`） | `RPC-03` |
| 中断当前轮 | `abort` | Esc → `session.abort()`（`:4937`、`:4947`） | 已实现（`client.js:2454` 空闲态、`:2467` 清队列后） | `RPC-04` |
| 清空排队 | `clear_queue` | Esc 连击 → `clearAllQueues()`（`:4894`）→ `restoreQueuedMessagesToEditor()`（`:4931-4950`） | 已实现（`client.js:2455` Esc、`:2502` Alt+Q；取回的文本还给编辑器） | `RPC-05` |
| 新会话 | `new_session` | `/new` → `handleClearCommand`（`:7118`）→ `runtimeHost.newSession()` | 已实现（`client.js:2557` `runNewSession`；`/new` 与 `/compact` 之外无其他入口。**顶栏「新会话」按钮另走 `endSession`**，见 `D-03`） | `RPC-06` |
| 读取会话状态 | `get_state` | TUI 无此命令，直接读 `session` | 已实现（`client.js:2304` `loadState`；host 侧 `src/pi-rpc.mjs` 的 `noteCommand` 另外缓存了一份 `lastState`） | `RPC-07` |
| 选模型 | `set_model` | `/model <provider/model>` → `session.setModel(model,{persist:false})`（`:5396`）；选择器 `:5539` | 已实现（`client.js:2425`；抽屉 `:2698`、按名匹配 `:2672`） | `RPC-08` |
| 轮换模型 | `cycle_model` | Ctrl+P → `session.cycleModel(direction)`（`:4725`，键位 `:3229-3230`） | 已实现（`client.js:2524`）。**RPC 面没有 `direction` 参数**，见 `D-08` | `RPC-09` |
| 列出可用模型 | `get_available_models` | `/scoped-models` 选择器读 `modelRuntime.getAvailableSnapshot()`（`:5109`、`:5571`） | 已实现（`client.js:2698` 抽屉、`:2672` 名称解析） | `RPC-10` |
| 设思考档位 | `set_thinking_level` | `/thinking <level>` → `session.setThinkingLevel(level)`（`:5207`、`:5357`） | 已实现（`client.js:2413`） | `RPC-11` |
| 轮换思考档位 | `cycle_thinking_level` | 键位 `app.thinking.cycle` → `session.cycleThinkingLevel()`（`:4712-4713`） | 已实现（`client.js:2543`，Shift+Tab） | `RPC-12` |
| 列出思考档位 | `get_available_thinking_levels` | `/thinking` 选择器用 `THINKING_LEVEL_OPTIONS`（`:5122`） | 已实现（`client.js:2282` `loadLevels`） | `RPC-13` |
| 设 steering 模式 | `set_steering_mode` | `/settings` → `session.setSteeringMode(mode)`（`:5181`） | 已实现（`client.js:3078`） | `RPC-14` |
| 设 follow-up 模式 | `set_follow_up_mode` | `/settings` → `session.setFollowUpMode(mode)`（`:5184`） | 已实现（`client.js:3079`） | `RPC-15` |
| 手动压缩 | `compact` | `/compact [指令]` → `handleCompactCommand`（`:7276`）→ `session.compact(customInstructions)`（`:7280`） | 已实现（`client.js:2581` `runCompact`，顶栏按钮 `:2957`；**曾经把 `/compact` 当 prompt 发的缺陷已修**，见 `handleSlash` `client.js:2906-2916`） | `RPC-16` |
| 自动压缩开关 | `set_auto_compaction` | `/settings` → `session.setAutoCompactionEnabled(enabled)`（`:5151`） | 已实现（`client.js:3076`） | `RPC-17` |
| 自动重试开关 | `set_auto_retry` | **TUI 无对应 UI**；仅 `auto_retry_start` 时 Esc 临时改绑 `abortRetry()`（`:3873-3877`） | 已实现（`client.js:3077`）。**这是面板领先 TUI 的能力**；但 `get_state` 不返回该字段，开关无法回读，见 `D-07` | `RPC-18` |
| 中止重试 | `abort_retry` | `:3877`（Esc 改绑） | 已实现（`client.js:2452`，Esc 第一分支） | `RPC-19` |
| 跑 bash | `bash` | `!` / `!!` 前缀（`:3473-3474`，`!!` = `excludeFromContext:true`） | 已实现（`client.js:2400` `handleBash`，`BASH_SHORTCUTS` 在 `src/rpc-contract.mjs:181-184`） | `RPC-20` |
| 中止 bash | `abort_bash` | `isBashRunning` 时 Esc → `session.abortBash()`（`:3199-3200`） | 已实现（`client.js:2453`） | `RPC-21` |
| 会话统计 | `get_session_stats` | `/session` → `session.getSessionStats()`（`:6886`） | 已实现（`client.js:2730`） | `RPC-22` |
| 导出会话 | `export_html` | `/export` → `handleExportCommand`（`:6709`）→ `exportToHtml`；`.jsonl` 后缀改走 `exportToJsonl` | 已实现（`client.js:2602`）。`.jsonl` 面板**显式拒绝**并提示（`:2597-2601`），不静默降级 | `RPC-23` |
| 切换会话 | `switch_session` | `/resume` → `showSessionSelector()`（`:5901`） | 已实现（`pickSession` `client.js:3603` → `reload` → `attach` → `hydrate`；切换成功后用会话文件 header 的 `cwd` 回填 `proc.sessionCwd`（`index.js:910-915` → `src/session-store.mjs:511` `readSessionCwd`），因为 `get_state` 不回报 cwd；数据源 `GET /sessions/history?scope=` `index.js:805` → `src/session-store.mjs:400` `listAllSessions`） | `RPC-24` |
| 从某条消息分叉 | `fork` | `/fork` → `showUserMessageSelector()`（`:5693`）→ `runtimeHost.fork(entryId)`（`:5709`） | 已实现（`client.js:2778` `pickFork`） | `RPC-25` |
| 克隆当前位置 | `clone` | `/clone`（`:5731`）→ `runtimeHost.fork(leafId,{position:'at'})` | 已实现（`client.js:2645` `runClone`） | `RPC-26` |
| 列出可分叉消息 | `get_fork_messages` | `/fork` 选择器数据源 `session.getUserMessagesForForking()`（`:5694`） | 已实现（`client.js:2719` `openFork`） | `RPC-27` |
| 列出会话条目 | `get_entries` | `/session` 读 `sessionManager.getEntries()`（`:6888`） | 已实现（`client.js:2731`，配合统计抽屉 `:2724`） | `RPC-28` |
| 读取会话树 | `get_tree` | `/tree` → `getTree()` + `getLeafId()`（`:5752`） | 已实现（`client.js:2709`）。**只读不导航**：RPC 无 `navigate_tree`，见 `client.js:1555-1561` 的注释 | `RPC-29` |
| 取最后一条回复 | `get_last_assistant_text` | `/copy` → `session.getLastAssistantText()`（`:6829`、`:6842`） | 已实现（`client.js:2615` `runCopy`） | `RPC-30` |
| 设会话名 | `set_session_name` | `/name <name>` → `session.setSessionName(name)`（`:6860`、`:6874`） | 已实现（`client.js:2631`）。上游 `slice` 缺陷仍在，见 `AGENTS.md` §6 | `RPC-31` |
| 读消息列表 | `get_messages` | TUI 无此命令（直接读内部状态） | 已实现（`refreshMessages`；**挂载即对账**：`attach` 末尾接 `hydrate(id)`，切会话 / fork / clone / 新建之后一律用它整表重建，见 §5 `D-09`）。也是 bash 气泡的补拉通道，见 `EVT-02` | `RPC-32` |
| 列出可调用命令 | `get_commands` | 斜杠菜单由 `BUILTIN_SLASH_COMMANDS`（`core/slash-commands.ts:19-44`，24 条）+ 扩展 / 技能 / prompt 模板动态构建 | 已实现（`client.js:2289` `loadCommands`；面板菜单另由 `src/rpc-contract.mjs:263-280` `slashMenuEntries` 合成） | `RPC-33` |

**统计（v0.3.0 实测）：33 条 = 已实现 32 + 部分 1（`steer`）+ 缺口 0。**

`steer` 为什么算「部分」而不是「已实现」：面板从不发 `{type:'steer'}` 这个帧（全文件 grep 字面量 0 命中），它靠 `prompt` 的 `streamingBehavior` 达到同样效果。两条路径在 pi 内部汇合（`agent-session.ts:2375-2380` 的 `_preparePrompt` 分支 → `_queueSteer`），所以**用户感知无差异**，但 RPC 帧层面确实少一条。`test/parity.mjs:332` 用 `clientSource.includes("streamingBehavior = 'steer'")` 把这个等价路径锁住。

---

## 2. 扩展 UI 子协议（9 种请求 / 3 种应答）

这不是 `AgentSessionEvent` 的分支，而是 RPC 层独立的一条子协议：pi 在 `stdout` 上发 `{type:'extension_ui_request', id, method, ...}`，客户端在 `stdin` 回 `{type:'extension_ui_response', id, ...}`。**id 匹配不上时 pi 静默丢弃、不报错**（`docs/rpc-extension-ui.md:12-25`）。

pi 侧构造器：`rpc-mode.ts:95-135`（`createDialogPromise`，dialog 类共用）+ `:140-315`（`createExtensionUIContext`，全部 method 的装配处）。TUI 侧同一接口的另一份实现：`interactive-mode.ts:2774-2826`（`createExtensionUIContext`）→ `:2861` / `:2896` / `:2922` / `:2956` / `:3064` / `:2441` / `:2539` 是各 method 的真实定义。**RPC 面被刻意裁掉的 method** 在 `:167-314` 里以空函数或注释形式存在（`onTerminalInput` / `setWorkingMessage` / `setFooter` / `setHeader` / `custom` / `addAutocompleteProvider` / `setEditorComponent` / `getAllThemes` / `setTheme` / `getToolsExpanded` —— 面板不需要、也无法替代它们），因此 `EXTENSION_UI_METHODS` 只有 9 条而不是 TUI 的二十多条。

### 2.1 请求（pi → 客户端，9 种）

| 能力 | method | 命令行 pi 的行为 | 面板端状态 | 门禁用例 |
| --- | --- | --- | --- | --- |
| 单选 | `select` | 绑定 `interactive-mode.ts:2776` → 定义 `showExtensionSelector` `:2861`；RPC `rpc-mode.ts:141-144` | 已实现（`client.js:863` → `addPendingUi` `:842` → `ExtensionDialog` `:1695`） | `EXT-01` |
| 是/否确认 | `confirm` | 绑定 `:2777` → `showExtensionConfirm` `:2896`（内部复用 select 传 `["Yes","No"]`，`:2901`）；RPC `:146-149` | 已实现（同上分支；应答走 `confirmed`） | `EXT-02` |
| 单行输入 | `input` | 绑定 `:2778` → `showExtensionInput` `:2922`；RPC `:151-154` | 已实现（同上分支；`placeholder`/`prefill` 透传） | `EXT-03` |
| 多行编辑器 | `editor` | 绑定 `:2799` → `showExtensionEditor` `:2956`；RPC `:258-275`（**裸 `Promise`，未走 `createDialogPromise`，所以连 `opts.timeout` 都不存在**） | 已实现（同上分支）。**`editor` 在 pi 侧连 `timeout` 字段都没有**，面板必须无条件兜底 | `EXT-04` |
| 通知气泡 | `notify`（`notifyType`） | 绑定 `:2779` → `showExtensionNotify` `:3064`；RPC `:156-165`，fire-and-forget | 已实现（`client.js:867` → `pushNotice(message, notifyType||'info')`，最多留 5 条 `MAX_NOTICES` `:713`） | `EXT-05` |
| 状态栏文本 | `setStatus` | 绑定 `:2781` → `setExtensionStatus` `:2441`（写 `footerDataProvider`）；RPC `:172-181`，无应答 | 已实现（`client.js:871-881`；`statusText` 空 = 删除该键） | `EXT-06` |
| 挂件 | `setWidget` | 绑定 `:2791` → `setExtensionWidget` `:2539`；RPC `:199-212`，无应答。**RPC 只接受 `string[]`**，工厂函数形态被静默忽略（`:201`） | 已实现（`client.js:882-895`；`placement` 缺省 `'aboveEditor'`） | `EXT-07` |
| 终端标题 | `setTitle` | 绑定 `:2794` → `this.ui.terminal.setTitle`；RPC `:222-230`，无应答 | 已实现（`client.js:896` → `view.title`，面板等价物是会话名 chip） | `EXT-08` |
| 写入输入框 | `set_editor_text` | 绑定 `:2797` → `this.editor.setText`（另有 `pasteToEditor` `:2796` 用 bracketed paste 包一层，RPC 面 `:237-240` 直接退化成 `setEditorText`）；RPC `:242-250`，无应答 | 已实现（`client.js:900` → `view.editorText`，下次渲染消费一次 `:2800`） | `EXT-09` |

未知 `method` 不静默：`client.js:905` 落一条 `warn` notice（`unknown extension_ui_request method: …`），方便发现 pi 升版新增了 method。

### 2.2 应答（客户端 → pi，3 种）

| 能力 | 形状 | pi 侧处理 | 面板端状态 | 门禁用例 |
| --- | --- | --- | --- | --- |
| 返回选中值 | `{type:'extension_ui_response', id, value}` | 对应 `select`/`input`/`editor`；`parseResponse` 回调在 `rpc-mode.ts:99` 声明、`:129` 消费 | 已实现（`client.js:517` `api.respond` timeout 20s → `respondUi` `:2791-2798`） | `EXT-R1` |
| 返回确认位 | `{..., id, confirmed}` | 对应 `confirm` | 已实现（同路径；`confirmed:false` 与「没点」区分得开） | `EXT-R2` |
| 取消 | `{..., id, cancelled:true}` | dialog 类在 `opts.signal` 已 abort 时直接返回默认值（`rpc-mode.ts:101`），abort 事件 `:113-117`，`opts.timeout` 到期 `:119-124`；**`editor` 不走这条路径**（`:258-275`），永远等应答 | 已实现（同路径；面板侧 5 分钟到期自动 `cancelled:true`，`client.js:1706`） | `EXT-R3` |

### 2.3 host 与面板各自做了什么（0.3.0 现状）

**host 半区（`src/pi-rpc.mjs`，580 行）`pendingUi` 是权威表：**

- `pendingUi = new Map()`（`:142`）；
- `trackUi(record, seq)`（`:273`）只收 `method ∈ {select,confirm,input,editor}` 且 `id` 为非空字符串的请求，其余直接丢掉不占表；登记项带 `timeout`（pi 声明值，没声明则为 `null`），面板据此对齐倒计时；
- `snapshot()` 把 `pendingUi` 一起返回（`:526`），所以面板重连能补发弹窗；
- `agent_settled` 时清空并 warn `dropping N stale extension_ui_request(s) on agent_settled`（`:250-257`）—— 轮次已结束不可能还有待应答弹窗；
- `send()` 对 `extension_ui_response` **强制改道** `respond()`（`:374-378`），因为 `send()` 会重新分配 id，pi 永远匹配不上；
- `respond()`（`:446`）校验非空 id → 写 stdin → `pendingUi.delete(id)` → **`restartPendingTimers()`**；
- `restartPendingTimers()`（`:472`）把所有挂了 timer 的待决命令换一轮新窗口、`deferrals` 归零 —— 用户点掉最后一个弹窗的那一刻，`pendingUi` 刚清空，若沿用上一轮已烧掉的时间，命令会立刻 reject（明明有人答了）。**答题是活着的证据，必须换来一整轮新窗口**；
- `resetEvents()`（`:517`）刻意**不清** `pendingUi`、不改 `state`：重置事件流不等于用户已应答；
- `handleExit`（`:496`）和 `close()` 里 `pendingUi.clear()`。

**超时三态（`timeoutLimitMs`，`:43`；语义注释在 `:22-31`）：**

| 入参 | 语义 | 场景 |
| --- | --- | --- |
| 正有限数 | 毫秒上限 | 普通 RPC 命令（默认 `DEFAULT_TIMEOUT_MS = 60_000`） |
| `0` / 负数 / `Infinity` | **不设上限**（`limitMs === null`，根本不起 timer） | `prompt` / `bash` / `follow_up` —— 它们的完成时刻由 pi 与用户决定 |
| `NaN` / 乱码 / 对象 / 布尔 | **抛 `TypeError`** | 调用方写错了，绝不能静默降级成默认值 |
| `undefined` / `null` / 空白字符串 | 默认 60000 | 没写这个键 |

`armTimer()`（`:414`）到点时先看 `pendingUi.size > 0`：非空就续期（最多 `MAX_TIMEOUT_DEFERRALS = 12` 次），耗尽才 reject，且错误里点名 `(N dialog(s) never answered)`。这一条与 `restartPendingTimers()` 合起来，才是「弹窗开着时命令不会先超时」的完整机制 —— 0.2.5 的「`pi command timed out: prompt` 红条与仍在倒计时的对话框并存」正是缺了它们。

**HTTP 面（`index.js`）：** `POST /sessions/:id/respond`（`:824-843`）与 `POST /sessions/:id/reset`（`:844-847`）。`/respond` 的错误码是被门禁锁死的：

| 码 | 触发条件 |
| --- | --- |
| 415 | `content-type` 不是 `application/json` |
| 400 | body 不是对象 / `id` 不是非空字符串 / 三个二选一字段都没给（`index.js:840`，**不猜成 cancelled**） |
| 409 | `no such request id`（弹窗早已被 settled 清掉） |

payload 取值优先级 `cancelled` → `confirmed` → `value`（`index.js:834-837`）。`id` 一个字符都不能改：pi 侧只按 `response.id` 去 `pendingExtensionRequests` 里取 resolver（`rpc-mode.ts:784-798`），这是 `index.js:832-833` 注释明写的约束。

**面板半区（`client.js`）：** `applyExtensionUi`（`:861-906`）分派 9 种 method、`addPendingUi`（`:842`）同 id 去重并从头部截断到 `MAX_PENDING_UI = 12`（`:714`）、`dropPendingUi`（`:850`）、`respondUi`（`:2791-2798`）先本地摘除再 `api.respond` 并把 409 静默吞掉、渲染端只取 `pendingUi[0]`（`:3021-3026`，队列形态，一次弹一个）。`ExtensionDialog`（`:1695`）自带倒计时，到点 `onRespond({id, cancelled:true})`。

---

## 3. 事件流（25 种真实事件）

来源：`core/agent-session.ts:220-261`（`AgentSessionEvent`）+ `packages/agent/src/types.ts:528-551`（`AgentEvent`）+ `modes/rpc/rpc-mode.ts:133`（`extension_ui_request`）+ `:356`（`extension_error`）。契约侧 = `src/rpc-contract.mjs:82-108`（`RPC_EVENTS`，25 条）。

**0.2.5 的「30 条含 5 条伪事件」已修。** 那时 `RPC_EVENTS` 里混进了 `extension_ui_notify/status/widget/title/editor_text` 五个名字 —— 在 pi 源码里 grep 命中 0，实质是把 `extension_ui_request` 的 5 个 method 误当成了独立事件类型。现在契约只有真实事件，且 `test/parity.mjs:318-319` 用 `contractOnly === []` 保证「我们不编」，`:315-316` 用 `docOnly === []` 保证「我们不漏」。

| 能力 | 事件 | 命令行 pi 的行为 | 面板端状态 | 门禁用例 |
| --- | --- | --- | --- | --- |
| 轮次开始 | `agent_start` | 置 busy、启动 spinner | 已实现（`client.js:915`，`busy=true`、清 `lastError`） | `EVT-01` |
| 轮次结束 | `agent_end` | 收口本轮（可能还有重试） | 显式忽略（`client.js:923-929`）：置闲由 `agent_settled` 负责，`agent_end` 后仍可能自动重试或压缩恢复；**bash 结果不进事件流**，靠 settled 后重拉 `get_messages` 补气泡 | `EVT-02` |
| 一步开始 | `turn_start` | 更新状态行 | 已实现（`client.js:916`，`busy=true`） | `EVT-03` |
| 一步结束 | `turn_end` | 收口工具结果渲染 | 显式忽略（`client.js:917-922`）：只关 `openIndex`/`streamingIndex`，气泡已由 `message_end` 收口，不能在这里置闲 | `EVT-04` |
| 消息开始 | `message_start` | 建气泡 | 已实现（`client.js:940-950`；`role==='system'` 直接 return，system 消息不上屏） | `EVT-05` |
| 流式增量 | `message_update` | 逐帧渲染 text/thinking/toolcall | 已实现（`client.js:951` → `applyAssistantEvent` `:750`，12 种 `assistantMessageEvent` 全覆盖） | `EVT-06` |
| 消息结束 | `message_end` | 收口气泡 | 已实现（`client.js:957-974`） | `EVT-07` |
| 工具开始 | `tool_execution_start` | 渲染工具卡片 | 已实现（`client.js:975-978`，`toolStatus[id]={status:'running',name,partial:''}`） | `EVT-08` |
| 工具流式输出 | `tool_execution_update` | 工具卡片追加 partialResult | 已实现（`client.js:979` → `applyToolUpdate` `:802`；单条 partial 截 2000 字符） | `EVT-09` |
| 工具结束 | `tool_execution_end` | 卡片收口 + 耗时 | 已实现（`client.js:980-988`，`isError` → `'error'`） | `EVT-10` |
| 彻底空闲 | `agent_settled` | 置空闲、清弹窗 | 已实现（`client.js:930-939`：`busy=false`、`retrying=false`、`pendingUi=[]`） | `EVT-11` |
| 队列变化 | `queue_update` | 渲染排队条目 | 已实现（`client.js:990-997`：存**完整** `steeringText`/`followUpText` 字符串数组，长度供状态栏 `:3011-3019`，文本供 Esc 还原 `:2456-2465`） | `EVT-12` |
| 压缩开始 | `compaction_start` | 提示 `reason` | 已实现（`client.js:998-1002`，`detail = reason \|\| 'manual'`） | `EVT-13` |
| 压缩结束 | `compaction_end` | 展示结果与错误 | 已实现（`client.js:1003-1009`：`errorMessage` → err notice、`aborted` → warn） | `EVT-14` |
| 条目追加 | `entry_appended` | 会话树/计数实时更新 | 已实现（`client.js:1028-1036`：`entryCount+=1`；`session_info` 改标题、`thinking_level_change` 改档位） | `EVT-15` |
| 会话名变化 | `session_info_changed` | 刷新标题 | 已实现（`client.js:1037-1040`） | `EVT-16` |
| 思考档位变化 | `thinking_level_changed` | 刷新档位指示 | 已实现（`client.js:989`） | `EVT-17` |
| 自动重试开始 | `auto_retry_start` | Esc 改绑 `abortRetry()`，显示 `attempt/max` | 已实现（`client.js:1010-1015`；Esc 分支见 `:2452`） | `EVT-18` |
| 自动重试结束 | `auto_retry_end` | 还原 Esc | 已实现（`client.js:1016-1021`；只有 `success===false` 且带 `finalError` 才提示） | `EVT-19` |
| 摘要重试排期 | `summarization_retry_scheduled` | 显示等待与错误 | 已实现（`client.js:1022-1025`，`detail = attempt/max + ' · ' + source`） | `EVT-20` |
| 摘要重试开始 | `summarization_retry_attempt_start` | 区分 `branchSummary`/`compaction` | 显式忽略（`client.js:1026` 空 return）：前一条 scheduled 已经把 `source` 显示出来了，再刷一遍只是噪音 | `EVT-21` |
| 摘要重试结束 | `summarization_retry_finished` | 清提示 | 已实现（`client.js:1027`，`notice = null`） | `EVT-22` |
| bash 流式输出 | `bash_execution_update` | `!` 命令的实时输出 | 已实现（`client.js:1041-1051`：按 `bashId` 累积 delta 到 `toolStatus[id].partial` 并重绘） | `EVT-23` |
| 扩展 UI 请求 | `extension_ui_request` | 弹对应 TUI 组件 | 已实现（`client.js:1056` → `applyExtensionUi`，见 §2） | `EVT-24` |
| 扩展报错 | `extension_error` | 打印错误 | 已实现（`client.js:1052-1055`，`pushNotice('extension error: '+error,'err')`） | `EVT-25` |

**统计：25 种 = 已实现 22 + 显式忽略 3 + 部分 0 + 缺口 0。**

线格式提醒：`message_update` 在 RPC 层被改写（`modes/json-event.ts:18-38`）—— 去掉累积 `partial`，只保留 `{type, usage, assistantMessageEvent}`；`toolcall_start` 额外补 `id` 与 `toolName`。面板解析必须按这个形状，不是 `AgentEvent` 原形。

---

## 4. TUI 27 条内置斜杠命令的对齐处置

来源：`core/slash-commands.ts:19-44`（24 条内置）+ `interactive-mode.ts:3446/3451/3456`（3 条未登记进 `BUILTIN_SLASH_COMMANDS` 的隐藏命令）。分发在 `interactive-mode.ts:3331-3466`（27 个 `if` 分支，`:3466` 的 `/quit` 之后 `:3468` 调 `await this.shutdown()`）。

处置与映射已固化在 `src/rpc-contract.mjs:147-175`（`TUI_COMMANDS`，27 条）；`classifyInput()`（`:202-230`）是面板与测试共用的判定器；`DISPOSITIONS`（`:282-283`）声明 6 种合法取值，`validateContract()`（`:286-323`）逐条校验「映射到未登记命令 / 非 rpc·client 却带 commands / 未知 disposition」等。

**disposition 六种**：`rpc`（面板发 RPC 命令）、`prompt`（兜底：原样当消息发给 agent，对齐 TUI 对未知命令的语义）、`client`（纯面板本地动作）、`local`（面板本地读文件）、`cli-only`（RPC 面没有，必须明示不可用）、`unsupported`（RPC 面没有但有等价操作，必须明示并给出出路）。

| 能力 | 命令 | 命令行 pi 的行为 | disposition | 面板落点 | 门禁用例 |
| --- | --- | --- | --- | --- | --- |
| 设置面板 | `/settings` | 42 字段选择器（`interactive-mode.ts:5098`，字段 `:5106-5147`） | `client` | `openSettings`（`client.js:2746`）→ `SettingsSheet` `:1658` | `TUI-01` |
| 循环模型集 | `/scoped-models` | `showModelsSelector`（`:5571`）→ `setScopedModels`（`:5599`） | `client` | `openModels`（`client.js:2693`） | `TUI-02` |
| 选模型 | `/model` | `handleModelCommand`（`:5387`、`:5396`） | `rpc` | `handleRpcCommand`（`client.js:2896`）：无参开抽屉，有参 `applyModelBySearch` `:2668` | `TUI-03` |
| 思考档位 | `/thinking` | `handleThinkingCommand`（`:5338`） | `rpc` | `client.js:2899`：无参开抽屉，有参 `applyThinkingByName` `:2654` | `TUI-04` |
| 导出 | `/export` | `handleExportCommand`（`:6709`） | `rpc` | `runExport`（`client.js:2593`） | `TUI-05` |
| 导入 | `/import` | `handleImportCommand`（`:6756`） | `unsupported` | 提示改用会话抽屉（等价 `switch_session`） | `TUI-06` |
| 分享 | `/share` | `handleShareCommand`（`:6803`，依赖 TUI editor/ui） | `cli-only` | notice `cliOnlyDetail`（`client.js:2910-2916`） | `TUI-07` |
| 报缺陷 | `/bug` | `handleBugCommand`（`:6814`） | `cli-only` | 同上 | `TUI-08` |
| 复制末条回复 | `/copy` | `handleCopyCommand`（`:6829`、`:6842`） | `rpc` | `runCopy`（`client.js:2612`）+ `navigator.clipboard` | `TUI-09` |
| 设会话名 | `/name` | `handleNameCommand`（`:6860`、`:6874`） | `rpc` | `runSetName`（`client.js:2626`）/ 抽屉 `:3085` | `TUI-10` |
| 会话信息 | `/session` | `handleSessionCommand`（`:6885`、`:6886`、`:6888`） | `client` | `openStats`（`client.js:2724`，`get_session_stats` + `get_entries` + `loadState`） | `TUI-11` |
| 更新日志 | `/changelog` | `handleChangelogCommand`（`:6966`） | `local` | `openChangelog`（`client.js:2753`）→ host 代读 `GET /pi/changelog`（`index.js:768`） | `TUI-12` |
| 快捷键 | `/hotkeys` | `handleHotkeysCommand`（`:7001`） | `client` | 静态表 `hotkeyText()`（`client.js:3125`） | `TUI-13` |
| 分叉 | `/fork` | `showUserMessageSelector`（`:5693`、`:5709`） | `client` | `openFork`（`client.js:2714`）→ `get_fork_messages` + `fork` | `TUI-14` |
| 克隆 | `/clone` | `handleCloneCommand`（`:5731`） | `rpc` | `runClone`（`client.js:2642`） | `TUI-15` |
| 会话树 | `/tree` | `showTreeSelector`（`:5752`） | `client` | `openTree`（`client.js:2704`）→ `TreeSheet` `:1562`（只读） | `TUI-16` |
| 项目信任 | `/trust` | `showTrustSelector`（`:5510`） | `cli-only` | notice；安全语义见 pi `docs/security.md` | `TUI-17` |
| 登录 | `/login` | `handleLoginCommand`（`:6054`） | `cli-only` | notice（OAuth 交互流依赖 TUI editor/ui） | `TUI-18` |
| 登出 | `/logout` | `showOAuthSelector('logout')`（`:3425`） | `cli-only` | notice | `TUI-19` |
| 新会话 | `/new` | `handleClearCommand`（`:7118`） | `rpc` | `runNewSession`（`client.js:2554`，发 `new_session` `:2557`）。**顶栏按钮是另一套语义**，见 `D-03` | `TUI-20` |
| 压缩 | `/compact` | `handleCompactCommand`（`:7276`、`:7280`） | `rpc` | `runCompact`（`client.js:2578`）。`handleSlash` 注释 `:2907-2909` 明写「面板绝不把 /compact 之类当普通消息发给模型」 | `TUI-21` |
| 重载 | `/reload` | `handleReloadCommand`（`:6619`） | `cli-only` | notice（RPC 无 reload；面板的等价物是重建会话） | `TUI-22` |
| 调试转储 | `/debug` | `:3446`（未登记进 `BUILTIN_SLASH_COMMANDS`） | `cli-only` | notice | `TUI-23` |
| 彩蛋 | `/arminsayshi` | `:3451` | `cli-only` | notice | `TUI-24` |
| 彩蛋 | `/dementedelves` | `:3456` | `cli-only` | notice | `TUI-25` |
| 恢复会话 | `/resume` | `showSessionSelector`（`:5901`） | `client` | `SessionsSheet`（`client.js:1885` 容器）/ `SessionsList`（`client.js:1791` 纯渲染）**两级**：项目层 `scope=all` + `groupSessionsByProject`（`src/session-store.mjs:461`，当前置顶 → 非临时优先 → 最近活动降序，临时判定沿用 `TEMPORARY_PATH_PATTERNS`）→ 点进项目 `scope=project&cwd=` → `switch_session` `client.js:3603`。pi 的 scope 开关进项目即失效（`session-selector.ts:1663`），故两级导航语义等价 | `TUI-26` |
| 退出 | `/quit` | `shutdown()`（`:3466`、`:3468`） | `client` | `endSession`（`client.js:2566`，断面板 + 关子进程，不退出宿主） | `TUI-27` |

**统计：27 条 = 已实现 17（rpc 8 + client 8 + local 1）+ 仅命令行 9 + unsupported 1 + 缺口 0。**

`/import` 用独立的 `unsupported` 而不是塞进 `cli-only`：前者 RPC 面确实没有、但也确实有等价操作（`switch_session`），面板必须给出路而不只是说「不可用」。0.2.5 时期这条被标成「第 6 种未文档化取值」，现在 `DISPOSITIONS`（`src/rpc-contract.mjs:283`）与 `:128-146` 的注释已对齐，`validateContract()` 也会校验它。

---

## 5. 已知契约缺陷清单

| 编号 | 缺陷 | 位置 | 0.4.2 状态 |
| --- | --- | --- | --- |
| `D-01` | `RPC_EVENTS` 混进 5 条伪事件（`extension_ui_notify/status/widget/title/editor_text`） | 原 `src/rpc-contract.mjs:99-103` | **已闭环**。契约现 25 条真实事件（`src/rpc-contract.mjs:82-108`），`test/parity.mjs:318-319` 用 `contractOnly === []` 防回归 |
| `D-02` | `disposition` 出现未文档化的第 6 种取值 `unsupported` | 原 `src/rpc-contract.mjs:147` vs 注释 `:128-139` | **已闭环**。`DISPOSITIONS`（`:283`）声明 6 种，注释 `:128-146` 已枚举 6 种，`validateContract()`（`:286-323`）校验取值合法性 |
| `D-03` | 顶栏「新会话」按钮走 `close`+`create` 换子进程，而非 `new_session` | 原 `client.js:2958`（onClick）→ `:2566` `endSession` | **已闭环（0.3.0）**。顶栏拆成两个按钮：「新会话」→ `runNewSession`（`new_session`，与命令行 `/new` 同一条路径）、「重连」→ `endSession`（换子进程，本就是恢复手段）。同一件事不再有两个入口两种结果 |
| `D-04` | `src/session-store.mjs`（只读会话枚举）零引用 | 原全仓 grep 无 import | **已闭环**。`index.js:33-39` import 八个函数（`listAllSessions` / `groupSessionsByProject` / `readSessionCwd` 于 0.5.0 追加），`GET /sessions/history?scope=`（`index.js:805`）暴露，面板 `SessionsSheet`（`client.js:1885`）消费 |
| `D-05` | `index.js` 未暴露 `pendingUi`，无扩展 UI 专用应答面 | 原 `index.js:484-567` | **已闭环**。`POST /sessions/:id/respond`（`index.js:824-843`，409/400/415）、`POST /sessions/:id/reset`（`:844-847`）；`pendingUi` 随 `snapshot()` 下发（`src/pi-rpc.mjs:430`） |
| `D-06` | `test/parity.mjs` 不存在，`npm test` 不含门禁 | 原 `package.json` `scripts.test` | **已闭环**。`test/parity.mjs` 77 checks + `test/host-parity.mjs` 204 checks + `test/session-projects.mjs` 55 checks（0.5.0 起）+ `test/timeout.mjs` 28 checks + `test/restart-lib.mjs`（0.4.2 起），都在 `npm test` 的 11 项里 |
| `D-07` | `RpcSessionState` 无 `autoRetryEnabled`，设置抽屉的自动重试开关无法回读 | pi `dist/modes/rpc/rpc-types.d.ts:148`（12 字段，实测无该字段）；`agent-session.ts:4122` 有 getter 但 RPC 面未暴露 | **开放（上游）**。后果：`client.js:1672` 读 `state.autoRetryEnabled` 恒为 `undefined`，开关永远显示 off —— 点一下会发 `set_auto_retry`（`:3077`）确实生效，但刷新后仍显示 off。面板侧今天连乐观本地态都没有（`loadState` `client.js:2303-2319` 只回填 model / thinkingLevel / sessionName / sessionFile 四个字段），所以唯一出路是上游补字段 + 面板加一份乐观态。`test/parity.mjs:290` 用断言把这个缺口**锁住**：pi 哪天补了字段，这条会红，届时可闭环 |
| `D-09` | 点开历史会话后对话区空白：`switch_session` 成功后 host 清空事件缓冲，面板只重放缓冲 | 原 `client.js:2881-2884` `reload`（只 `attach`，无 `get_messages`）；根因在 `index.js:74` `SESSION_REPLACING_COMMANDS` → `proc.resetEvents()`（`index.js:856`） | **已闭环（0.4.1）**。`attach` 末尾接 `hydrate(id)`（≈ `get_messages` 整表重建，剔除 `system`），覆盖首次进入 / `switch_session` / `fork` / `clone` / `new_session` 五个入口；两道防线：响应回来时会话已切走则丢弃（`sessionRef.current !== id`）、`busy` 期间不覆盖流式气泡（挂 `hydratePendingRef`，`agent_settled` 后由 `drainHydrate()` 补）。命令行 pi 不受影响：它从 jsonl 恢复 `messages`。`test/parity.mjs` §7 用 12 条断言钉死接线，`test/client-render.mjs` §9.16 用 14 条断言钉死数据整形 |
| `D-08` | `cycle_model` 在 RPC 面无方向参数 | pi `rpc-types.ts:34` 是 `{ type: "cycle_model" }`；`rpc-mode.ts:501` 调 `session.cycleModel()` 单参；TUI `interactive-mode.ts:4723-4725` 的 `cycleModel(direction)` 有 `forward`/`backward`，键位 `:3229-3230` | **开放（上游）**。后果：`Ctrl+P` 只能正循环（`client.js:2521-2524` 注释处已标注），反向要开模型抽屉手动选。面板侧不改协议无解 |

---

## 6. 变更记录

| 日期 | 版本 | 变更 |
| --- | --- | --- |
| 2026-11-12 | 0.2.5 | 建立本账本。实测基线：RPC 33 条 / 已实现 5 / 部分 1 / 缺口 27；扩展 UI 9 请求 3 应答全部缺口（host 已就绪）；事件 25 种 / 已实现 12 / 部分 3 / 显式忽略 2 / 缺口 8；TUI 27 条 / 缺口 14 / 部分 3 / 仅命令行 10。登记 `D-01`..`D-06`。 |
| 2026-11-13 | 0.3.0 | **缺口清零。** RPC 33 条 = 已实现 32 + 部分 1（`steer` 走 `prompt`+`streamingBehavior:'steer'`）+ 缺口 0；扩展 UI 9 请求 3 应答全部已实现（含 5 分钟兜底超时 `DIALOG_FALLBACK_MS`）；事件 25 种 = 已实现 22 + 显式忽略 3 + 缺口 0；TUI 27 条 = 已实现 17 + 仅命令行 9 + `unsupported` 1 + 缺口 0。`D-01`/`D-02`/`D-04`/`D-05`/`D-06` 闭环；新增 `D-07`/`D-08`（均为上游协议面限制，面板侧无解）。门禁落地：`test/parity.mjs` + `test/host-parity.mjs` 进 `npm test`。 |
| 2026-11-13 | 0.3.0 收尾 | **`D-03` 闭环**：顶栏拆成「新会话」（`runNewSession` → `new_session`，与 `/new` 同路径）与「重连」（`endSession`，换子进程）；同一件事不再有两个入口两种结果。**修掉两处在 0.2.5 真实存在的时序缺陷**：① 装了扩展 / 改了 prompt 模板后斜杠菜单不刷新（现于 `agent_settled` 重拉 `get_commands`，未知斜杠先重拉再判定）；② 扩展弹窗等着人点时命令先超时（`timeoutLimitMs` 三态 + `armTimer` 让位 + `respond` 后重开窗口 + 面板 `CHAT_TIMEOUT_MS = 0`）。门禁加强：新增 `test/timeout.mjs`（28 checks，用 `test/fixtures/fake-pi-rpc.mjs` 协议替身把 5 分钟等待压到毫秒级）、`test/host-parity.mjs` 125 checks（+10）、`test/parity.mjs` 65 checks（+16，新增 §6 会话入口与超时语义）。`npm test` 从 7 项变 8 项，耗时 ~1.3 s → ~5.2 s。 |
| 2026-11-13 | 0.3.0 实测 | **扩展 UI 四类弹窗全部端到端取证**（独立实例 5599 + CDP）：select 选项点击回 `value`、confirm 回 `confirmed`、input 透传 `placeholder` 并回 `value`、editor 的 `prefill` 正确回填多行并回改后的 `value`、点「取消」走 `cancelled` —— 9 请求 + 3 应答分支无一纸面声明。**修掉两处文案缺陷**：① 倒计时原来渲染成「扩展请求超时，已自动取消 298s」（读起来像已完成态），现为「还剩 {n}s 后自动取消」/「Auto-cancels in {n}s」，与 pi 侧 `extension-selector.ts:56-63` 的 `Title (Ns)` 剩余秒语义对齐；② confirm 的否定按钮原来借用开关态文案 `off`（中「关」/英 off），现独立成 `extNo`（「否」/`No`），与 pi TUI `interactive-mode.ts:2896-2906` 复用 `["Yes","No"]` 对齐。`t('on')`/`t('off')` 仍归设置抽屉的开关使用。门禁：`test/client-render.mjs` 补第 9 组（38 个断言点 / 展开循环后 43 次执行；四种 method 的按钮集 / prefill 回填 / `dialogBudgetMs` 四类非法值回落 / `extNo ≠ off` / SSR 不渲染倒计时这条硬约束），`npm test` 全绿 |
| 2026-11-13 | 0.3.2 | **升版号原因 = 安装器门禁**：`tools/install-plugin.ps1` 的逐字节比对在版本号不变时必然失败 —— pnpm 对 `file:` 依赖按 lock 里的 integrity 复用 store，把旧内容装回来且 exit=0（README:49 早有记录）。第一次原地改代码仍报 `STALE client.js`，第二次改完 README（断言口径 71→335）后复跑又报 `STALE README.md` —— **只要 `files` 里任一 shipped 文件（含文档）有变化就必须升版号**，0.3.1 因此未发布、直接并为 0.3.2。基线、缺陷表标题、`CONTRACT_VERSION`、README 的 tarball 名同步。**同时修掉安装器自身的退出路径缺陷**：`$stage` 只在最后一行 `Remove-Item`，比对失败走 `Fail`（`exit 1` 不触发 `finally`、也跳过末尾清理）时会把 `%TEMP%\dsh-pi-stage-*` 整棵留下 —— 0.3.0/0.3.1 两次失败各留了约 1.7 万文件。现改为 `$script:stageDir` + `Remove-StageDir` 统一收口：`Fail` 清理后退出、`trap { Remove-StageDir; break }` 兜异常与 Ctrl-C、正常路径末尾再调一次；真机验证 `stage_before=0 → 安装成功 → stage_after=0`，另用真实代码块抽取法验证 `Fail` 路径 `leftover=False`。 |
| 2026-11-13 | 0.4.0 | **面板交互与命令行 pi 工作区语义对齐**：①会话/空态里的入口统一叫「选择工作区」（`pickDir`/`dirTitle`，ZH/EN 同改；`dirHere` 采纳按钮 = 「用这个工作区」）；②选择工作区从铺满面板的抽屉改成 680x500 居中模态（`client.js:2115` `.dsh-pi-dialog-wrap` + `.dsh-pi-dir-dialog`，`role=dialog`/`aria-modal`），理由 = 它是打断当前会话的决策；③新增「此电脑」盘符层（`GET /directories` 下发 `roots`，`client.js` rootsView），修掉「从工作区往上只能走到当前盘根、别的盘永远进不去」的缺口，并修掉盘符被通用循环重复渲染两遍的缺陷；④过程行（工具调用/工具结果/`!` bash）去掉圆角卡片外壳，改平铺行 + 展开区左侧竖线，与 `.dsh-pi-think` 同一套语言（一次任务十几条工具卡会形成框套框噪音墙）。门禁：`client-render` 450 断言（新增模态 5 条 + 文案 4 条 + 过程行 9.11b 段）、`css-tokens` 90、`host-parity` 162（新增 roots 10 条）、`parity` 65，`npm test` EXIT=0。 |
| 2026-11-13 | 0.4.1 | **`D-09` 闭环（面板侧缺陷，非上游）**：点历史会话后对话区空白。根因 = `switch_session` / `new_session` / `fork` / `clone` 成功后 host 调 `proc.resetEvents()`（`index.js:856`，命令集 `SESSION_REPLACING_COMMANDS` `index.js:74`）把事件缓冲清成 0 条，而面板的 `reload` 只重放 `snapshot`（此时 eventSeq=0、events=[]），从不去拉 `get_messages` —— 切过去必然空白。实测证据：切会话后 `GET /sessions/:id/snapshot?since=0` 返回 `{eventSeq:0, events:[]}`，而 `POST /command {type:'get_messages'}` 同会话返回 178 条消息（377 KB）。修法 = `attach` 末尾接 `hydrate(id)`：非 busy 时以 `get_messages` 整表覆盖 `view.messages`；会话已切走则丢弃响应；busy 时挂 `hydratePendingRef`，`agent_settled` 后由 `drainHydrate()` 补一次。`messagesFromHistory()` 是纯函数（跳过 `system`，seq 用数组下标且**刻意不改 `view.lastSeq`**，避免与 host 事件序号混用导致 `applyBatch` 去重误判）。门禁：`parity` 77（+12）、`client-render` 464（+14）、`host-parity` 162，`npm test` EXIT=0。 |
| 2026-11-13 | 0.4.2 | **修 `tools/restart-dsh.ps1` 重启分支的三处真缺陷**（症状统一是「脚本说重启成功、面板永远起不来」）：① 旧实现 `Start-Process -FilePath $exe` 不带任何参数，而桌面实例宿主命令行有 6 个参数（`--expose-internals`、desktop-host 的 `index.js`、app.asar 里的 `dsh`、profile 目录、`primary-runtime`、`pnpm.mjs`、`runtime\bin`），等于换个东西启动 —— 现从实例 pid 沿父链找启动根、把命令行原文交 `ProcessStartInfo.Arguments`（不拆分不重组），取不到就拒绝重启；② 旧实现杀 `/selfcheck` 自报的 `process.pid`（桌面实例里那是 GUI 主进程的子进程），杀了没人重新拉起，现杀启动根；③ 旧实现继承本进程环境（`ELECTRON_RUN_AS_NODE=1` 会把 GUI 当纯 node 起、窗口不出；残留 `DSH_HOME`/`DSH_PROFILE`/`DSH_PORT` 会把实例顶到错误的 home），现按目标实例 `/selfcheck` 的 `root` 反推 `DSH_HOME`（`<home>\profiles\<name>\node_modules\dsh-pi`），`ELECTRON_RUN_AS_NODE` 只在命令行确实跑 `.js` 时设、`DSH_PORT` 一律清，推不出来 `exit 3`。新增 `-Plan`（只打印决定：实例 pid / 启动根 pid / exe / 命令行参数 / 工作目录 / 四个环境变量）与自保护（脚本祖先链里有目标启动根时 `exit 3`，`-Force` 越过）。退出码固化为 0 成功 / 1 挑不出实例 / 2 版本不一致 / 3 拒绝重启。库模式 `$env:DSH_PI_RESTART_LIB=1` 只加载函数，测试不动真实例。门禁新增 `test/restart-lib.mjs`（22 条 node 断言 + `test/fixtures/restart-lib-checks.ps1` 31 条 PS 断言，pwsh 7 与 PowerShell 5.1 双引擎各跑一遍；含文件层 BOM / 无游离 CR / 去注释后无裸 `Start-Process -FilePath $exe`、5 种假 `/health` 响应、bat 门禁），`npm test` 从 8 项变 10 项（耗时 ~5.2 s → ~14.3 s，其中 restart-lib ~9.1 s）。**实证**：探针实例 5599 真跑一次完整重启分支 → kill 启动根、拉起新 pid、`/health` 就绪、`state.version 0.4.2` 与磁盘一致 `exit 0`；桌面实例 5783 从 DSH 工具里跑触发自保护 `exit 3`（宿主未受影响）。 |
| 2026-11-13 | 0.5.0 | **修「历史会话只显示一条」——面板 `/resume` 与命令行 pi 的两级选择器对齐**。根因链：`SessionsSheet` 把当前 `meta.cwd` 当唯一过滤条件（旧 `client.js:1780` `api.history(props.cwd, 60)`）→ host `listHistory` 在 `cwd` 为空时回落 `detected.workspace`（旧 `index.js:620-622`）→ `src/session-store.mjs:360-401` `listSessions` 于是只扫 `cwdSessionDirs()` 那一个项目目录。修法四件：①`src/session-store.mjs` 新增 `pathComparisonKey` / `isTemporaryPath`（三条正则与 `session-selector.ts:760-769` 逐字一致）/ `shortenHomePath` / `groupSessionsByProject`（聚合与排序逐条照抄 `cli/session-picker.ts:26-62`）/ `readSessionCwd`（读首 64KB 取 header.cwd），并把 `listSessions` 拆成 `listAllSessions`（全量）+ `listSessions`（clampLimit + slice）；②`index.js` 的 `listHistory({scope,cwd,limit})` 显式区分 `scope=all`（全项目 + `projects` 聚合，**不再回落 workspace**）与 `scope=project`（单项目），`current` 走新增的 `firstRunningSessionFile(running, known)`（旧 `pickCurrentSessionFile` 跨 cwd 一律不认，全项目视角下永远标不上）；③**跨项目切换的 cwd 校正**：`get_state` 不回报 cwd（`rpc-types.ts:96-109`），故 `switch_session` 成功后 host 用 `readSessionCwd(body.sessionPath)` 回填 `proc.sessionCwd`（`src/pi-rpc.mjs` 新增字段 + `setSessionCwd`），`snapshot` 暴露 `sessionCwd`，面板所有「当前工作区」显示点（空态 cwd / 统计抽屉 / 目录抽屉起点）改读 `sessionCwd`，`MissingSessionCwdError` 翻成一条中文提示（pi 的 RPC 面没有 `cwdOverride` 分支，`rpc-mode.ts:624-630` 只转调 `switchSession`）；④`client.js` 抽屉拆成容器 `SessionsSheet`(:1885) + 纯渲染 `SessionsList`(:1791)，项目层 → 会话层两级导航（pi 的 scope 开关进项目即失效，`session-selector.ts:1663`，故用导航代替切换按钮）。新增 `test/session-projects.mjs` 55 checks 兜住聚合规则；`client-render` 补两级渲染断言（478→497）；`host-parity` 166 checks 覆盖新 scope 语义。 |
| 2026-11-13 | 0.5.1 | **升版号原因 = 安装器门禁复现**：0.5.0 装进 desktop profile 后我又修了 `index.js` 一处缩进（`switch_session` 的 cwd 回填块由 8 空格改为 10 空格，与相邻块对齐），内容变化触发「installed copy does not match the packed tarball」。`pnpm add --force` 与 `remove`+`add` 两条路都不会刷新 store 里按 integrity 缓存的那份 —— 印证 0.3.2 那条铁律：**shipped 文件一改就必须升版本号**。0.5.1 只含这一处缩进，行为与 0.5.0 完全一致，门禁计数不变（client-render 497 / css-tokens 90 / host-parity 166 / session-projects 55 / parity 77）。 |
| 2026-11-14 | 0.6.0 | **助手回复里的文件路径变成可点标签 + Composer 支持任意文件/压缩包**。①文件标签：`client.js` 新增 `isFilePathToken` / `splitFileTokens` / `renderFileChip`，`renderInline(text, prefix, onOpenFile)` 与 `renderMarkdown(text, onOpenFile)` 透传 opener，三种形态都覆盖 —— 段落正文、行内反引号（助手常把路径包在 `` ` `` 里）、围栏里整块只有一条路径（用户截图正是这种）。识别原则「宁可少认，不要误认」：排除 `scheme://` 开头的 URL、裸文件名必须命中 `FILE_BARE_EXT` 白名单、末段必须带扩展名，故 `/model`、`v1.2.3`、`example.com` 不会被误标。点击走 `ctx.sidebarRight.openResource('dsh-resource://file/session/<DSH 会话>/<绝对路径>')`，渲染交给 DSH 内置 `documentpreview`（`textDefinition().patterns = ['dsh-resource://file/[\s\S]+']`、`canOpen` 只认 `scope === 'session'`），插件不自造预览 UI；**地址一律 session 作用域**（`absolute` 无授权会话，会 `workspace-file/unknown-workspace`），**不做「绝对路径压工作区相对」**（pi 的 cwd ≠ DSH 会话 cwd，压了会被 DSH 按自己的根解析而指错）。服务用 `ctx.get('sidebarRight')` 惰性取，**不写进 `exports.inject`**（缺服务会让 entry 永久 pending、卡死 DSH 启动）；取不到或无正在显示的会话时回落面板内 `FileSheet`（文本 / 图片 / 二进制三态）并 notice 说明。②Composer 任意文件：`onPaste` 从只收 `image/*` 放宽到全部 `kind === 'file'`，`pickFiles()` 去掉 `accept` 限制。图片仍走 ImageContent；其它文件按 pi TUI `handleClipboardPaste`（`interactive-mode.ts:3278-3318`）把**绝对路径文本插进输入框**（光标处插入、按两侧字符补空格，与 `:3286-3292` 一致），路径来自 preload 暴露的 `window.__DSH_HOST_PATHS__.pathFor(file)`（`preload-app.cjs:1962`，只在 `dsh-app://app` 存在；浏览器里取不到就明说改用 @ 补全）。RPC 契约 `prompt/steer/follow_up` 的 optional 只有 `images`，**没有任意文件附件字段** —— 伪造图片通道是错语义，故不做 upload。③host：新增 `GET /api/dsh-pi/file?path=`（`readPreviewFile`，文本 512 KiB 截断 + 前 8 KiB 有 NUL 判二进制 + 图片 8 MiB base64，目录 400 `not a file`、ENOENT 404 `no such file`、34 项文本 MIME / 8 项图片 MIME）。④门禁：`client-render` 517→548（新增路径识别正反例 22 条 + 围栏/行内 code 分支 + 地址拼法 + FileSheet 三态），`host-parity` 166→194（`/file` 28 条），`css-tokens` 90，`session-projects` 55，`parity` 77，`npm test` EXIT=0。 |
| 2026-11-14 | 0.6.1 | **输入区与关闭入口对齐 + 文件标签可右键定位**。①Composer 底栏拆成 `.dsh-pi-bar-actions`（目录 / 附件 / busy 时的排队与停止）与 `.dsh-pi-bar-right`（提示语 + 发送）：改之前提示语夹在按钮中间、busy 时被多出来的两个按钮挤动位置，文案也不对题（idle 用 `slashHint`，那是菜单导航提示；busy 用 `steerHint`，漏了 Alt+Enter 排队与 Esc 停止）。现两套完整文案 `composerTipIdle` / `composerTipBusy` 按 `busy` 切换，位置固定在发送键左侧；`composerHint` 从「给 pi 说点什么…  / 唤起命令，! 直接跑 bash，Enter 发送，Shift+Enter 换行」精简为「给 pi 说点什么…」—— 五条快捷键全塞进 placeholder 会在一开始输入时消失、窄面板还会被截断。附件按钮从产品 logo `PiIcon` 换成 `PaperclipIcon`（用品牌图标表示附件是语义错位）。②抽屉/弹窗右上角统一 `CloseButton`（`.dsh-pi-btn-icon` + 16px `CloseIcon` + 32×32 命中区）：改之前是纯文本 `'×'`（11px、无 `-icon` 类），且 `Sheet` 带 `type="button"`、`DirSheet` 不带，两处已分叉；`ExtensionDialog` 补 `.dsh-pi-dialog-head`（h3 + 关闭键，语义等于「取消」）。③文件标签右键 → 资源管理器定位：host 新增 `POST /api/dsh-pi/reveal`（`revealInFileManager`，Windows `explorer.exe /select,<文件>`、macOS `open -R`、其它 `xdg-open` 父目录；**只等 `spawn` 不等退出码** —— explorer 把命令转交给已有实例后常以非 0 退出，信它就会把成功报成失败；`deps.revealPath` 可注入供测试）。标签本身同时收敛为「类型图标 + 文件名」（`data-kind` 六类 code/image/archive/sheet/doc/file），不再显示目录尾巴。④门禁：`client-render` 548→587（第 11 组：动作集合 `data-openable`/`data-revealable` 三态、`data-kind` 五例、`dsh-pi-fileref-dir` 必须不出现、`CloseButton`/`Sheet`/`DirSheet`/`ExtensionDialog` 都必须是图标键且不含 `>×<`、`composerHint` 不含 Enter、两条 tip 中英非空且各含关键键位、`revealFile*` 键存在），`host-parity` 194→204（`/reveal` 10 条：200 + 注入实现收到绝对路径 + 缺 path 400 + ENOENT 404 + 相对路径按 workspace 解析），`css-tokens` 90，`session-projects` 55，`parity` 77，`npm test` EXIT=0。 |
| 2026-11-14 | 0.6.2 | **输入区（composer）按宿主主对话区重做**。卡面换成 `--dsw-radius-panel` 28px + `--dsw-specific-input-major` + `--dsw-elevation-soft`，聚焦时只覆盖 `--dsw-elevation-stroke-color`；行内左侧「28px 圆形 `+`（`.dsh-pi-add`）+ 模型 picker + 推理档位 picker」，右侧「34px 圆形发送键 `.dsh-pi-send`（`--dsw-alias-button-info-fill` + `ArrowUpIcon`，disabled opacity .4）/ 运行中同位换成 `.dsh-pi-stop`（`StopSquareIcon`）」；`+` 弹 `AddMenu`（「添加 / 指令」两组、图标 + 中文标签 + 英文键名 + 灰色说明），条目只映射面板真实能力，不伪造 pi 没有的 goal/plan/feedback/todo；统计行并入 composer 容器卡下方（`footer`），内容 = 状态 + `get_session_stats` 的「轮 / 步 / tok / 缓存命中% / 上下文%」，只在 `agent_settled` 后刷新；模型 chip 与思考档位从头部移入 composer。`test/client-render.mjs` 587→669 断言（新增 composer 结构、AddMenu 分组、footer 位置、`fmtCount` 千分位），`test/css-tokens.mjs` 90→96。 |
| 2026-11-14 | 0.6.3 | **修 0.6.2 落地后实测暴露的两个 composer 缺陷**（宿主截图口径复核时发现，非新功能）。①统计行首次进入面板 / 切到历史会话时是空的 —— `footerStats` 只在 `agent_settled` 后拉一次，而刚 attach 的会话没有 settle 事件，得先发一条消息数字才出现。现 `attach()` 尾部（`openStream` + `flush()` 之后）与 `reload()` 的 then 链尾各补一次 `loadFooterStats(id)`，这两个点是「会话已就绪、事件已回放完」的唯一入口。②统计行混进了 `meta.sessionFile` 的完整路径，把「N 轮 · N 步」挤到换行、视觉重心变成一串路径 —— 宿主的 dock 只有用量数字，路径属于「会话统计」抽屉。删除 `statusRow` 里那行 `sessionFile` span。③`composerHint` 改成宿主口径 `给 pi 说点什么, / 调用指令, @ 文件`（`Say something to pi, / commands, @ files`）—— 0.6.1 的「给 pi 说点什么…」只剩一句话，用户看不出这里能敲斜杠和 @。`test/client-render.mjs` 669 断言不变（composerHint 不含 `Enter` 的既有两个断言仍绿），`test/css-tokens.mjs` 96 不变。另：`docs/dsh-ui-spec.md` 的代码基线刷新到 `client.js` 5170 行 / 283968 B / sha256 前 12 位 `b0cc688879a9`。 |
| 2026-11-14 | 0.6.4 | **过程流按 DSH 会话过程流重做**（用户直指「DSH 侧边栏的过程行长得跟宿主不一样」，目标截图逐像素实测 1467×802 / dpr≈2：父行图标 16px 框 + 13px 标签 + 2×2 圆点 + 单行省略摘要，行高 24px；子行左 1px 竖线在父行图标框左缘、箭头 + 标签 + 圆点 + 内容整路径点线下划线）。①**层级同构**：模型的「思考」= 父行（`details.dsh-pi-proc` + `summary.dsh-pi-proc-head`，展开区 `div.dsh-pi-proc-body` 只取首行作摘要、全文在展开区）；紧随其后的工具调用 = 子行组（`div.dsh-pi-sub` 左竖线 `border-left:1px solid var(--dsw-alias-border-l3)` + `margin-left:22px`/`padding-left:8px`）；纯文本 / 图片把过程流切段，文本之后的调用重新起一组。②**一次调用 = 一行**：工具结果不再单独占一行 —— pi 把结果作为独立 `toolResult` 消息送达，面板在 PiPanel 里按 `toolCallId` 建 `results` 派生表（`{text,isError}`）传进 MessageRow，命中就折叠、未命中的孤儿结果仍按行渲染（不吞内容），输出收在同一行的展开区 `── output ──`。③**行内词汇取自 DSH 官方标题表**（`research/layout/dsh-client-ui-conversation__lib__client.js:16731-16748`）：思考 / 运行命令 / 读取 / 读取图片 / 写入 / 编辑 / 搜索文件内容 / 查找文件 / 浏览目录 / 工具调用，未知工具兜底「工具调用 · <工具名>」；`read` 命中图片扩展名时自动切成「读取图片」。④**图标**：新增 7 个 24 网格 1.7 描边图标 `ThinkIcon`(⊗) / `HashIcon`(#) / `TerminalIcon`(>_) / `FrameIcon`(▤) / `SearchIcon` / `PencilIcon` / `SparkIcon`，按工具名在 `TOOL_VIEWS` 里静态映射（不按参数猜）。⑤**状态**：运行中圆点用品牌色 + `dsh-pi-pulse`；失败行 `data-state="error"` + 行尾 note「失败」；`!` bash 非 0 退出 note「exit N」、取消 note「已取消」、截断 note「truncated」。⑥**工作状态行**：`WorkingRow`（`div.dsh-pi-working`，`view.busy` 时挂在过程流末尾），最终形态见 ⑩；计时器挂节点自己（1Hz `setInterval` + cleanup），不放面板级 —— 面板级每帧重算上百行流式 markdown 只为刷一行文字。`busySince` 由幂等 `markBusy`/`markIdle` 维护（busy 有 5 处赋值点：`agent_start`/`turn_start`/`agent_settled`/`resync`/`attach` + EventSource `exit`，散写必漏必残留；已在忙不重置起点，否则一轮任务里每重连一次计时归零）。⑦**删掉被取代的旧词汇**：`tool` / `result` / `busy` / `thinkingLabel` 四键在旧 ToolBlock/ThinkingBlock 删除后已无消费者，留两套词表会让下一任分不清行标签的真相源。⑧**实拍后三处修正**（装进独立实例、真跑一轮后逐像素对目标图）：行文字色从 `label-secondary`（`rgb(97,102,107)`）改成 `label-tertiary`（`rgb(129,133,140)`，与目标摘要实心色一致），`── live ──` 段加 `status === 'running'` 护栏 —— 跑完后 `partialResult` 与最终输出是同一件事，两段都印等于把结果写两遍。⑨门禁：`test/client-render.mjs` 669→697（去掉四个死键的 8 条非空断言，过程行结构由 SSR 三件套 `class="dsh-pi-tool"` 断言继续锁；新增 9.11c 颜色两条 + 9.11d live 段四条），`test/css-tokens.mjs` 96→97（白名单新增 `--dsh-content-font-size-secondary`：过程行取 DSH 会话流次级正文档，用主档会让「过程」比「正文」更重）。⑩**工作状态行按 DSH `RunningStatus` 收尾**（第三次修订，同属实拍驱动）：目标图底部那行是品牌蓝 `rgb(52,94,186)` = `--dsw-alias-label-deep-diving`（`color-mix(in srgb, #4176e6 70%, #172554)`），图标是鲸鱼尾而非四角星 —— 我们原先的 `--dsw-alias-state-business-primary`（`rgb(65,118,230)`）是另一个蓝。改成照抄 DSH `dsh-client-ui-chat/lib/client.js:6386-6429`：新增 `WhaleTailIcon`（`:1941`，16 网格 / `stroke-width:1` / `fill:none` / `stroke:currentColor`，路径即 DSH `RunningWhaleTail` 的 `REST_PATH` 原文，未引入它的 APNG 蒙版资产），`.dsh-pi-working` 文字色改 `--dsw-alias-label-deep-diving`、字号 `calc(var(--dsh-content-font-size,14px) - 2px)`（实测 12px）、行高 `calc(22px + var(--dsh-content-font-delta,0px))`（22px），图标随 `currentColor`；文案 `deepDiving`=「深度求索中」、`working`=「深度求索中，用时 {duration} ···」（三个 `U+00B7`，与 DSH `chat.deepDivingFor` 同字），`fmtDuration`（`client.js:2975`）按 DSH `formatRunDuration`（`:5847-5880`）补小时档 —— 新增 `durHour` 词条，`durHour` 仅 hours>0、`durMin` 仅 total≥60、`durSec` 恒有，拼接用 `parts.join('')` —— 单位间距由词条自带（中文 `durMin`=「{n}分」不带空格，目标图就是「43分54秒」；EN 为「{n}m 」带尾空格），与 DSH `formatRunDuration(...).map((part) => part.text).join('')` 同一拼法；另加 `span.dsh-pi-sr[role=status][aria-live=polite]` 只播报不带秒数的 `deepDiving`，否则读屏每秒被刷一次。门禁随之 `test/client-render.mjs` 697→**738**（新增 9.11e：三条 working CSS 的颜色与字号、`WhaleTailIcon` 的 `viewBox 0 0 16 16` 与 `stroke-width="1"`、`fmtDuration` 五条定值含小时与 90 秒进位、`WorkingRow` 的 aria 结构与无起点时的退化文案），`test/css-tokens.mjs` 97→**98**。`docs/dsh-ui-spec.md` 的代码基线刷新到 `client.js` 5619 行 / 307602 B / sha256 前 12 位 `ACDCFE28FDFB`。 |
| — | — | 修改本文档时必须同时改：受影响行的「面板端状态」、`## 1/3/4` 末尾的统计数字、以及 `## 6` 的一行。统计数字算错会让「零缺口」变成一句空话。 |

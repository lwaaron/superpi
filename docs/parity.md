# superpi 两端能力对齐账本（parity）

> 基线：pi `1.5.2` / superpi `0.19.0` · 唯一权威 = `packages/coding-agent/src/modes/rpc/rpc-types.ts`（303 行）、`src/modes/rpc/rpc-mode.ts`（846 行，`switch` 在 `:404-737`）、`src/core/agent-session.ts`（4714 行，`AgentSessionEvent` 在 `:220-261`）
> 本文档是 `AGENTS.md` §3「100% 对齐」的账本。任何一行状态变化必须同步改这里，否则视为未完成。**本账本由 `test/parity.mjs` 与 `test/host-parity.mjs` 机器兜底**，人肉维护只是第一道。

## 0. 怎么读这张表

**两端指的是谁。** pi 有两个平级前端，跑同一个 pi、同一个 agent loop：

- **命令行 pi（TUI）**：`packages/coding-agent/src/modes/interactive/`，人肉交互。
- **superpi 面板**：本仓库 `client.js` + `index.js`，通过 pi 官方 JSONL RPC 协议驱动 `pi --mode rpc` 子进程。

**除了 RPC 面，还有第三层要对齐：输入框本身（0.9.2）。** 面板的输入框是浏览器的真 `textarea`，粘贴文件路径 / Ctrl+A 全选 / Ctrl+C 复制 / Ctrl+X 剪切 / Backspace 删选区全是浏览器原生行为，插件一行代码都不用写；而 TUI 的输入框是 pi-tui 自己实现的 Editor —— **它没有选区模型**，Ctrl+A 是「移到行首」、Ctrl+C 被 pi 的 `app.clear` 吃掉去清空输入框、Ctrl+X 无绑定，读剪贴板文件列表又只有 macOS 有（Windows 的 native 模块没实现 `getFilePaths`）。这段差异由本仓库的 pi 扩展 `extensions/superpi-editor.ts` 补齐（`ctx.ui.setEditorComponent()` 换输入框，pi 官方支持的扩展点），见本节末尾「输入框能力对账」。

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

**门禁已经是事实，不是目标态。** `test/parity.mjs`（78 checks）、`test/host-parity.mjs`（291 checks）、`test/tui-editor.mjs`（276 checks，0.9.2 起；0.9.11 起 276）与 `test/session-projects.mjs`（55 checks，0.5.0 起）都已落地，且都在 `npm test` 的 13 项流水线里：

```
selfcheck → client-render(1013) → css-tokens(98) → runtime-resolve → config-hot
→ host-parity(430) → session-projects(55) → timeout(28) → rules(203)
→ context-guard(179) → modalities(76) → parity(98) → tui-editor(481) → restart-lib(31×2 引擎) → github-sync(82) → version
```

三套核心门禁都离线跑（不起 pi、不打 LLM）。`npm test` 2026-11-13 实测：加 `restart-lib` 之前 ~5.2 s，加上之后 ~14.3 s —— **`test/restart-lib.mjs` 独占约 9.1 s**（它要起 pwsh 7 与 PowerShell 5.1 两个引擎各跑一遍 fixture，进程启动开销占大头），`test/timeout.mjs` 约 3.1 s（真等若干超时周期），其余各项合计 <1.5 s。`test/parity.mjs` 做的是**三向对账**：`src/rpc-contract.mjs` ↔ pi 的类型声明与官方文档 ↔ `client.js`/`index.js` 的实际覆盖面。任一方向对不上即红：

- **我们缺的** = 缺口（pi 有、契约没有 → 面板会静默丢弃）；
- **我们编的** = 幻觉（契约有、pi 没有 → 虚构分支）；
- **死契约** = 契约里有、面板里没有落地字面量（`test/parity.mjs:221-242` 逐条 `includes` 扫）。

**0.14.0 起 `get_messages` 由 host 代发（不是缺口，是刻意的归属调整）。** 面板不再直接发这条 RPC，改调 `GET /sessions/:id/messages?before=&limit=`，由 host 分页后只下发最近一页并把图片换成 `image-stub`。原因：一次性拉全量实测 55.1 MB / 3251 条（图片占 88.2%），首屏直接卡死。`test/parity.mjs` 的「面板覆盖」因此把 `get_messages` 放进 `HOST_PROXIED_COMMANDS` 白名单，并**同时断言 host 真的代发了它** —— 否则"排除"会退化成"缺失"。TUI 侧不受影响（命令行 pi 本来就从 jsonl 恢复，没有这条 RPC）。

`test/parity.mjs` 找不到 pi 包时（`findPiPackage()` 返回 `null`，`test/parity.mjs:245-251`）会 SKIP 掉 §3/§4 的类型对账，只跑契约自洽 + 面板覆盖；此时是「降级通过」而不是「全绿」，CI 上必须让 pi 在场。

**本文档里的行号有两种口径，先看清在哪一节：** `## 0`–`## 5`（当前态能力矩阵）的 `client.js:NNN` / `index.js:NNN` 是 **0.8.1 的实时坐标**（基线见第 3 行），逐条对过源码，指向的是该符号的定义行；`## 6` 变更记录是历史账本，行号是**各版本落地当时**的坐标（行末已注明版本）。**唯一例外是 `## 5` 缺陷表的位置列里那些带「原」字的引用** —— 它们指的是缺陷发生时（已废弃）的坐标，只作历史对照，不承诺对得上任何一版源码。已抽查：`D-02` 对得上 v0.3.0、`D-09` 对得上 v0.4.0，`D-01` / `D-03` 对不上任何一版（已在对应行注明）。跨版本定位一律以函数/组件名（`runCompact`、`openStats`、`SessionsList` …）为准。

---

## 1. RPC 命令矩阵（33 条）

来源：`rpc-types.ts:20-74`（`RpcCommand` 联合类型）、`rpc-mode.ts:404-737`（`switch` 实现，`case` 从 `:409` 的 `prompt` 到 `:701` 的 `get_commands`）、`docs/rpc-commands.md`（860 行，33 个 `###` 小节，三方一致）。

| 能力 | RPC 命令 | 命令行 pi 的行为 | 面板端状态 | 门禁用例 |
| --- | --- | --- | --- | --- |
| 发送消息 | `prompt` | 提交框 `session.prompt(text)`（`interactive-mode.ts:3513-3521`）；流式中改走 `prompt(text,{streamingBehavior:'steer'})`（`:3502-3511`） | 已实现（`client.js:5608` 正常提交、`:5080` 斜杠开头走 followUp） | `RPC-01` |
| 打断并插话 | `steer` | 流式中提交即 steer（`:3507`）；压缩队列重放 `session.steer()`（`:4999`、`:5039`） | **部分**：面板不发 `steer` 命令字面量，走 `prompt` + `streamingBehavior:'steer'`（`client.js:5064`）。语义等价——两条路径在 `agent-session.ts:2375-2380` 汇进同一个 `_queueSteer()` | `RPC-02` |
| 排队下一轮 | `follow_up` | Alt+Enter（`:4676-4683`）→ `prompt(text,{streamingBehavior:'followUp'})`；重放 `session.followUp()`（`agent-session.ts:2521`） | 已实现（`client.js:5170` 纯文本；`:5080` 斜杠开头改走 prompt+followUp，因为 `follow_up` 会被 `_throwIfExtensionCommand` 打回，见 `agent-session.ts:2473-2475`） | `RPC-03` |
| 中断当前轮 | `abort` | Esc → `session.abort()`（`:4937`、`:4947`） | 已实现（`client.js:5127` 空闲态、`:5060` 清队列后） | `RPC-04` |
| 清空排队 | `clear_queue` | Esc 连击 → `clearAllQueues()`（`:4894`）→ `restoreQueuedMessagesToEditor()`（`:4931-4950`） | 已实现（`client.js:5137` Esc、`:2846` Alt+Q；取回的文本还给编辑器） | `RPC-05` |
| 新会话 | `new_session` | `/new` → `handleClearCommand`（`:7118`）→ `runtimeHost.newSession()` | 已实现（`runNewSession` `client.js:5236`，发 `new_session`；顶栏「新会话」主按钮 `client.js:5761` 与 `AddMenu` 的 `new` 项（`client.js:2970`）都走它。**0.7.0 起「重连」（换子进程 `endSession` `client.js:5248`）退进 `⋯` 更多菜单并过二次确认**，同一件事不再有两个入口，见 `D-03`） | `RPC-06` |
| 读取会话状态 | `get_state` | TUI 无此命令，直接读 `session` | 已实现（`client.js:4974` `loadState`；host 侧 `src/pi-rpc.mjs` 的 `noteCommand` 另外缓存了一份 `lastState`） | `RPC-07` |
| 选模型 | `set_model` | `/model <provider/model>` → `session.setModel(model,{persist:false})`（`:5396`）；选择器 `:5539` | 已实现（`applyModelBySearch` `client.js:5377`；无参 `/model` 开输入框上方弹层 `ModelPicker` `client.js:3258`，受控开合 `togglePicker` `client.js:5415`） | `RPC-08` |
| 轮换模型 | `cycle_model` | `Ctrl+P` 正向，`Ctrl+Shift+P` 反向 | 同样的快捷键。正向调用原生 RPC，反向由会话控制扩展按当前模型范围切换。见 `D-08` | `RPC-09`、`test/reliability.mjs` |
| 列出可用模型 | `get_available_models` | `/scoped-models` 选择器读 `modelRuntime.getAvailableSnapshot()`（`:5109`、`:5571`） | 已实现（`ModelPicker` `client.js:3258` 向上弹层；名称解析 `applyModelBySearch` `client.js:5377`） | `RPC-10` |
| 设思考档位 | `set_thinking_level` | `/thinking <level>` → `session.setThinkingLevel(level)`（`:5207`、`:5357`） | 已实现（`client.js:5091`） | `RPC-11` |
| 轮换思考档位 | `cycle_thinking_level` | 键位 `app.thinking.cycle` → `session.cycleThinkingLevel()`（`:4712-4713`） | 已实现（`client.js:5222`，Shift+Tab） | `RPC-12` |
| 列出思考档位 | `get_available_thinking_levels` | `/thinking` 选择器用 `THINKING_LEVEL_OPTIONS`（`:5122`） | 已实现（`client.js:4927` `loadLevels`） | `RPC-13` |
| 设 steering 模式 | `set_steering_mode` | `/settings` → `session.setSteeringMode(mode)`（`:5181`） | 已实现（`client.js:5989`） | `RPC-14` |
| 设 follow-up 模式 | `set_follow_up_mode` | `/settings` → `session.setFollowUpMode(mode)`（`:5184`） | 已实现（`client.js:5990`） | `RPC-15` |
| 手动压缩 | `compact` | `/compact [指令]` → `handleCompactCommand`（`:7276`）→ `session.compact(customInstructions)`（`:7280`） | 已实现（`runCompact` `client.js:5287`，0.7.0 起入口在 `⋯` 更多菜单（`moreItems` `client.js:5700-5703`）+ `ConfirmDialog` 二次确认（`client.js:3190`）；**曾经把 `/compact` 当 prompt 发的缺陷已修**，见 `handleSlash` `client.js:5667-5673`） | `RPC-16` |
| 自动压缩开关 | `set_auto_compaction` | `/settings` → `session.setAutoCompactionEnabled(enabled)`（`:5151`） | 已实现（`client.js:5987`） | `RPC-17` |
| 自动重试开关 | `set_auto_retry` | `/superpi-retry` 查看并修改，使用 Pi 设置 API | 设置弹窗从 Pi 进程回读有效值，写入后再次确认。见 `D-07` | `RPC-18`、`test/reliability.mjs`、`test/client-render.mjs` |
| 中止重试 | `abort_retry` | `:3877`（Esc 改绑） | 已实现（`client.js:5134`，Esc 第一分支） | `RPC-19` |
| 跑 bash | `bash` | `!` / `!!` 前缀（`:3473-3474`，`!!` = `excludeFromContext:true`） | 已实现（`client.js:5077` `handleBash`，`BASH_SHORTCUTS` 在 `src/rpc-contract.mjs:181-184`） | `RPC-20` |
| 中止 bash | `abort_bash` | `isBashRunning` 时 Esc → `session.abortBash()`（`:3199-3200`） | 已实现（`client.js:5135`） | `RPC-21` |
| 会话统计 | `get_session_stats` | `/session` → `session.getSessionStats()`（`:6886`） | 已实现（`client.js:5440`） | `RPC-22` |
| 导出会话 | `export_html` | `/export` → `handleExportCommand`（`:6709`）→ `exportToHtml`；`.jsonl` 后缀改走 `exportToJsonl` | 已实现（`client.js:5302`）。`.jsonl` 面板**显式拒绝**并提示（`:5218-5221`），不静默降级 | `RPC-23` |
| 切换会话 | `switch_session` | `/resume` → `showSessionSelector()`（`:5901`） | 已实现（`pickSession` `client.js:5488` → `reload` → `attach` → `hydrate`；切换成功后用会话文件 header 的 `cwd` 回填 `proc.sessionCwd`（`index.js:1065-1069` → `src/session-store.mjs:511` `readSessionCwd`），因为 `get_state` 不回报 cwd；数据源 `GET /sessions/history?scope=` `index.js:870` → `src/session-store.mjs:400` `listAllSessions`） | `RPC-24` |
| 从某条消息分叉 | `fork` | `/fork` → `showUserMessageSelector()`（`:5693`）→ `runtimeHost.fork(entryId)`（`:5709`） | 已实现（`client.js:5521` `pickFork`） | `RPC-25` |
| 克隆当前位置 | `clone` | `/clone`（`:5731`）→ `runtimeHost.fork(leafId,{position:'at'})` | 已实现（`client.js:5351` `runClone`） | `RPC-26` |
| 列出可分叉消息 | `get_fork_messages` | `/fork` 选择器数据源 `session.getUserMessagesForForking()`（`:5694`） | 已实现（`client.js:5430` `openFork`） | `RPC-27` |
| 列出会话条目 | `get_entries` | `/session` 读 `sessionManager.getEntries()`（`:6888`） | 已实现（`openStats` `client.js:5440` → 统计弹窗 `StatsSheet` `client.js:4168`（0.7.0 起居中 `Dialog`），读 `get_session_stats` + `get_entries` + `loadState`） | `RPC-28` |
| 读取会话树 | `get_tree` | `/tree` → `getTree()` + `getLeafId()`（`:5752`） | 已实现（`client.js:5420`）。**只读不导航**：RPC 无 `navigate_tree`，见 `client.js:4110-4116` 的注释 | `RPC-29` |
| 取最后一条回复 | `get_last_assistant_text` | `/copy` → `session.getLastAssistantText()`（`:6829`、`:6842`） | 已实现（`client.js:5321` `runCopy`） | `RPC-30` |
| 设会话名 | `set_session_name` | `/name <name>` → `session.setSessionName(name)`（`:6860`、`:6874`） | 已实现（`client.js:5335`）。上游 `slice` 缺陷仍在，见 `AGENTS.md` §6 | `RPC-31` |
| 读消息列表 | `get_messages` | TUI 无此命令（直接读内部状态） | 已实现（`refreshMessages`；**挂载即对账**：`attach` 末尾接 `hydrate(id)`，切会话 / fork / clone / 新建之后一律用它整表重建，见 §5 `D-09`）。也是 bash 气泡的补拉通道，见 `EVT-02` | `RPC-32` |
| 列出可调用命令 | `get_commands` | 斜杠菜单由 `BUILTIN_SLASH_COMMANDS`（`core/slash-commands.ts:19-44`，24 条）+ 扩展 / 技能 / prompt 模板动态构建 | 已实现（`client.js:4948` `loadCommands`；面板菜单另由 `src/rpc-contract.mjs:263-280` `slashMenuEntries` 合成） | `RPC-33` |

**统计（v0.3.0 实测）：33 条 = 已实现 32 + 部分 1（`steer`）+ 缺口 0。**

`steer` 为什么算「部分」而不是「已实现」：面板从不发 `{type:'steer'}` 这个帧（全文件 grep 字面量 0 命中），它靠 `prompt` 的 `streamingBehavior` 达到同样效果。两条路径在 pi 内部汇合（`agent-session.ts:2375-2380` 的 `_preparePrompt` 分支 → `_queueSteer`），所以**用户感知无差异**，但 RPC 帧层面确实少一条。`test/parity.mjs:332` 用 `clientSource.includes("streamingBehavior = 'steer'")` 把这个等价路径锁住。

---

## 2. 扩展 UI 子协议（9 种请求 / 3 种应答）

这不是 `AgentSessionEvent` 的分支，而是 RPC 层独立的一条子协议：pi 在 `stdout` 上发 `{type:'extension_ui_request', id, method, ...}`，客户端在 `stdin` 回 `{type:'extension_ui_response', id, ...}`。**id 匹配不上时 pi 静默丢弃、不报错**（`docs/rpc-extension-ui.md:12-25`）。

pi 侧构造器：`rpc-mode.ts:95-135`（`createDialogPromise`，dialog 类共用）+ `:140-315`（`createExtensionUIContext`，全部 method 的装配处）。TUI 侧同一接口的另一份实现：`interactive-mode.ts:2774-2826`（`createExtensionUIContext`）→ `:2861` / `:2896` / `:2922` / `:2956` / `:3064` / `:2441` / `:2539` 是各 method 的真实定义。**RPC 面被刻意裁掉的 method** 在 `:167-314` 里以空函数或注释形式存在（`onTerminalInput` / `setWorkingMessage` / `setFooter` / `setHeader` / `custom` / `addAutocompleteProvider` / `setEditorComponent` / `getAllThemes` / `setTheme` / `getToolsExpanded` —— 面板不需要、也无法替代它们），因此 `EXTENSION_UI_METHODS` 只有 9 条而不是 TUI 的二十多条。

### 2.1 请求（pi → 客户端，9 种）

| 能力 | method | 命令行 pi 的行为 | 面板端状态 | 门禁用例 |
| --- | --- | --- | --- | --- |
| 单选 | `select` | 绑定 `interactive-mode.ts:2776` → 定义 `showExtensionSelector` `:2861`；RPC `rpc-mode.ts:141-144` | 已实现（`client.js:1663-1666` → `addPendingUi` `:1625` → `ExtensionDialog` `:4286`） | `EXT-01` |
| 是/否确认 | `confirm` | 绑定 `:2777` → `showExtensionConfirm` `:2896`（内部复用 select 传 `["Yes","No"]`，`:2901`）；RPC `:146-149` | 已实现（同上分支；应答走 `confirmed`） | `EXT-02` |
| 单行输入 | `input` | 绑定 `:2778` → `showExtensionInput` `:2922`；RPC `:151-154` | 已实现（同上分支；`placeholder`/`prefill` 透传） | `EXT-03` |
| 多行编辑器 | `editor` | 绑定 `:2799` → `showExtensionEditor` `:2956`；RPC `:258-275`（**裸 `Promise`，未走 `createDialogPromise`，所以连 `opts.timeout` 都不存在**） | 已实现（同上分支）。**`editor` 在 pi 侧连 `timeout` 字段都没有**，面板必须无条件兜底 | `EXT-04` |
| 通知气泡 | `notify`（`notifyType`） | 绑定 `:2779` → `showExtensionNotify` `:3064`；RPC `:156-165`，fire-and-forget | 已实现（`client.js:1667-1670` → `pushNotice(message, notifyType||'info')`，最多留 5 条 `MAX_NOTICES` `:1459`） | `EXT-05` |
| 状态栏文本 | `setStatus` | 绑定 `:2781` → `setExtensionStatus` `:2441`（写 `footerDataProvider`）；RPC `:172-181`，无应答 | 已实现（`client.js:1671-1681`；`statusText` 空 = 删除该键） | `EXT-06` |
| 挂件 | `setWidget` | 绑定 `:2791` → `setExtensionWidget` `:2539`；RPC `:199-212`，无应答。**RPC 只接受 `string[]`**，工厂函数形态被静默忽略（`:201`） | 已实现（`client.js:1682-1695`；`placement` 缺省 `'aboveEditor'`） | `EXT-07` |
| 终端标题 | `setTitle` | 绑定 `:2794` → `this.ui.terminal.setTitle`；RPC `:222-230`，无应答 | 已实现（`client.js:1696-1699` → `view.title`，面板等价物是会话名 chip） | `EXT-08` |
| 写入输入框 | `set_editor_text` | 绑定 `:2797` → `this.editor.setText`（另有 `pasteToEditor` `:2796` 用 bracketed paste 包一层，RPC 面 `:237-240` 直接退化成 `setEditorText`）；RPC `:242-250`，无应答 | 已实现（`client.js:1700-1703` → `view.editorText`，下次渲染消费一次 `:2759`） | `EXT-09` |

未知 `method` 不静默：`client.js:1704-1705` 落一条 `warn` notice（`unknown extension_ui_request method: …`），方便发现 pi 升版新增了 method。

### 2.2 应答（客户端 → pi，3 种）

| 能力 | 形状 | pi 侧处理 | 面板端状态 | 门禁用例 |
| --- | --- | --- | --- | --- |
| 返回选中值 | `{type:'extension_ui_response', id, value}` | 对应 `select`/`input`/`editor`；`parseResponse` 回调在 `rpc-mode.ts:99` 声明、`:129` 消费 | 已实现（`client.js:947` `api.respond` timeout 20s → `respondUi` `:5448-5455`） | `EXT-R1` |
| 返回确认位 | `{..., id, confirmed}` | 对应 `confirm` | 已实现（同路径；`confirmed:false` 与「没点」区分得开） | `EXT-R2` |
| 取消 | `{..., id, cancelled:true}` | dialog 类在 `opts.signal` 已 abort 时直接返回默认值（`rpc-mode.ts:101`），abort 事件 `:113-117`，`opts.timeout` 到期 `:119-124`；**`editor` 不走这条路径**（`:258-275`），永远等应答 | 已实现（同路径；面板侧 5 分钟到期自动 `cancelled:true`，`client.js:4303`） | `EXT-R3` |

### 2.3 host 与面板各自做了什么（0.3.0 现状）

**host 半区（`src/pi-rpc.mjs`，600 行）`pendingUi` 是权威表：**

- `pendingUi = new Map()`（`:150`）；
- `trackUi(record, seq)`（`:291`）只收 `method ∈ {select,confirm,input,editor}` 且 `id` 为非空字符串的请求，其余直接丢掉不占表；登记项带 `timeout`（pi 声明值，没声明则为 `null`），面板据此对齐倒计时；
- `snapshot()` 把 `pendingUi` 一起返回（`:544`），所以面板重连能补发弹窗；
- `agent_settled` 时清空并 warn `dropping N stale extension_ui_request(s) on agent_settled`（`:273`）—— 轮次已结束不可能还有待应答弹窗；
- `send()` 对 `extension_ui_response` **强制改道** `respond()`（`:392-396`），因为 `send()` 会重新分配 id，pi 永远匹配不上；
- `respond()`（`:464`）校验非空 id → 写 stdin → `pendingUi.delete(id)` → **`restartPendingTimers()`**；
- `restartPendingTimers()`（`:490`）把所有挂了 timer 的待决命令换一轮新窗口、`deferrals` 归零 —— 用户点掉最后一个弹窗的那一刻，`pendingUi` 刚清空，若沿用上一轮已烧掉的时间，命令会立刻 reject（明明有人答了）。**答题是活着的证据，必须换来一整轮新窗口**；
- `resetEvents()`（`:535`）刻意**不清** `pendingUi`、不改 `state`：重置事件流不等于用户已应答；
- `handleExit`（`:514`）和 `close()` 里 `pendingUi.clear()`。

**超时三态（`timeoutLimitMs`，`:43`；语义注释在 `:22-31`）：**

| 入参 | 语义 | 场景 |
| --- | --- | --- |
| 正有限数 | 毫秒上限 | 普通 RPC 命令（默认 `DEFAULT_TIMEOUT_MS = 60_000`） |
| `0` / 负数 / `Infinity` | **不设上限**（`limitMs === null`，根本不起 timer） | `prompt` / `bash` / `follow_up` —— 它们的完成时刻由 pi 与用户决定 |
| `NaN` / 乱码 / 对象 / 布尔 | **抛 `TypeError`** | 调用方写错了，绝不能静默降级成默认值 |
| `undefined` / `null` / 空白字符串 | 默认 60000 | 没写这个键 |

`armTimer()`（`:432`）到点时先看 `pendingUi.size > 0`：非空就续期（最多 `MAX_TIMEOUT_DEFERRALS = 12` 次），耗尽才 reject，且错误里点名 `(N dialog(s) never answered)`。这一条与 `restartPendingTimers()` 合起来，才是「弹窗开着时命令不会先超时」的完整机制 —— 0.2.5 的「`pi command timed out: prompt` 红条与仍在倒计时的对话框并存」正是缺了它们。

**HTTP 面（`index.js`）：** `POST /sessions/:id/respond`（唯一一条扩展 UI 应答面）。`/respond` 的错误码是被门禁锁死的：

| 码 | 触发条件 |
| --- | --- |
| 415 | `content-type` 不是 `application/json` |
| 400 | body 不是对象 / `id` 不是非空字符串 / 三个二选一字段都没给（`index.js:1099`，**不猜成 cancelled**） |
| 409 | `no such request id`（弹窗早已被 settled 清掉） |

payload 取值优先级 `cancelled` → `confirmed` → `value`（`index.js:1093-1096`）。`id` 一个字符都不能改：pi 侧只按 `response.id` 去 `pendingExtensionRequests` 里取 resolver（`rpc-mode.ts:784-798`），这是 `index.js:1091-1092` 注释明写的约束。

**面板半区（`client.js`）：** `applyExtensionUi`（`:1661-1706`）分派 9 种 method、`addPendingUi`（`:1625`）同 id 去重并从头部截断到 `MAX_PENDING_UI = 12`（`:1460`）、`dropPendingUi`（`:1633`）、`respondUi`（`:5537-5544`）先本地摘除再 `api.respond` 并把 409 静默吞掉、渲染端只取 `pendingUi[0]`（`:5945-5950`，队列形态，一次弹一个）。`ExtensionDialog`（`:4286`）自带倒计时，到点 `onRespond({id, cancelled:true})`。

---

## 3. 事件流（25 种真实事件）

来源：`core/agent-session.ts:220-261`（`AgentSessionEvent`）+ `packages/agent/src/types.ts:528-551`（`AgentEvent`）+ `modes/rpc/rpc-mode.ts:133`（`extension_ui_request`）+ `:356`（`extension_error`）。契约侧 = `src/rpc-contract.mjs:82-108`（`RPC_EVENTS`，25 条）。

**0.2.5 的「30 条含 5 条伪事件」已修。** 那时 `RPC_EVENTS` 里混进了 `extension_ui_notify/status/widget/title/editor_text` 五个名字 —— 在 pi 源码里 grep 命中 0，实质是把 `extension_ui_request` 的 5 个 method 误当成了独立事件类型。现在契约只有真实事件，且 `test/parity.mjs:318-319` 用 `contractOnly === []` 保证「我们不编」，`:315-316` 用 `docOnly === []` 保证「我们不漏」。

| 能力 | 事件 | 命令行 pi 的行为 | 面板端状态 | 门禁用例 |
| --- | --- | --- | --- | --- |
| 轮次开始 | `agent_start` | 置 busy、启动 spinner | 已实现（`client.js:1715`，`busy=true`、清 `lastError`） | `EVT-01` |
| 轮次结束 | `agent_end` | 收口本轮（可能还有重试） | 显式忽略（`client.js:1723-1729`）：置闲由 `agent_settled` 负责，`agent_end` 后仍可能自动重试或压缩恢复；**bash 结果不进事件流**，靠 settled 后重拉 `get_messages` 补气泡 | `EVT-02` |
| 一步开始 | `turn_start` | 更新状态行 | 已实现（`client.js:1716`，`busy=true`） | `EVT-03` |
| 一步结束 | `turn_end` | 收口工具结果渲染 | 显式忽略（`client.js:1717-1722`）：只关 `openIndex`/`streamingIndex`，气泡已由 `message_end` 收口，不能在这里置闲 | `EVT-04` |
| 消息开始 | `message_start` | 建气泡 | 已实现（`client.js:1740-1750`；`role==='system'` 直接 return，system 消息不上屏） | `EVT-05` |
| 流式增量 | `message_update` | 逐帧渲染 text/thinking/toolcall | 已实现（`client.js:1751-1756` → `applyAssistantEvent` `:1533`，12 种 `assistantMessageEvent` 全覆盖） | `EVT-06` |
| 消息结束 | `message_end` | 收口气泡 | 已实现（`client.js:1757-1774`） | `EVT-07` |
| 工具开始 | `tool_execution_start` | 渲染工具卡片 | 已实现（`client.js:1775-1778`，`toolStatus[id]={status:'running',name,partial:''}`） | `EVT-08` |
| 工具流式输出 | `tool_execution_update` | 工具卡片追加 partialResult | 已实现（`client.js:1779` → `applyToolUpdate` `:1585`；单条 partial 截 2000 字符） | `EVT-09` |
| 工具结束 | `tool_execution_end` | 卡片收口 + 耗时 | 已实现（`client.js:1780-1788`，`isError` → `'error'`） | `EVT-10` |
| 彻底空闲 | `agent_settled` | 置空闲、清弹窗 | 已实现（`client.js:1730-1739`：`busy=false`、`retrying=false`、`pendingUi=[]`） | `EVT-11` |
| 队列变化 | `queue_update` | 渲染排队条目 | 已实现（`client.js:1790-1797`：存**完整** `steeringText`/`followUpText` 字符串数组，长度供状态栏 `:5816-5817`，文本供 Esc 还原 `:5038-5060`） | `EVT-12` |
| 压缩开始 | `compaction_start` | 提示 `reason` | 已实现（`client.js:1798-1802`，`detail = reason \|\| 'manual'`） | `EVT-13` |
| 压缩结束 | `compaction_end` | 展示结果与错误 | 已实现（`client.js:1803-1809`：`errorMessage` → err notice、`aborted` → warn） | `EVT-14` |
| 条目追加 | `entry_appended` | 会话树/计数实时更新 | 已实现（`client.js:1828-1836`：`entryCount+=1`；`session_info` 改标题、`thinking_level_change` 改档位） | `EVT-15` |
| 会话名变化 | `session_info_changed` | 刷新标题 | 已实现（`client.js:1837-1840`） | `EVT-16` |
| 思考档位变化 | `thinking_level_changed` | 刷新档位指示 | 已实现（`client.js:1789`） | `EVT-17` |
| 自动重试开始 | `auto_retry_start` | Esc 改绑 `abortRetry()`，显示 `attempt/max` | 已实现（`client.js:1810-1815`；Esc 分支见 `:5045`） | `EVT-18` |
| 自动重试结束 | `auto_retry_end` | 还原 Esc | 已实现（`client.js:1816-1821`；只有 `success===false` 且带 `finalError` 才提示） | `EVT-19` |
| 摘要重试排期 | `summarization_retry_scheduled` | 显示等待与错误 | 已实现（`client.js:1822-1825`，`detail = attempt/max + ' · ' + source`） | `EVT-20` |
| 摘要重试开始 | `summarization_retry_attempt_start` | 区分 `branchSummary`/`compaction` | 显式忽略（`client.js:1826` 空 return）：前一条 scheduled 已经把 `source` 显示出来了，再刷一遍只是噪音 | `EVT-21` |
| 摘要重试结束 | `summarization_retry_finished` | 清提示 | 已实现（`client.js:1827`，`notice = null`） | `EVT-22` |
| bash 流式输出 | `bash_execution_update` | `!` 命令的实时输出 | 已实现（`client.js:1841-1851`：按 `bashId` 累积 delta 到 `toolStatus[id].partial` 并重绘） | `EVT-23` |
| 扩展 UI 请求 | `extension_ui_request` | 弹对应 TUI 组件 | 已实现（`client.js:1856` → `applyExtensionUi`，见 §2） | `EVT-24` |
| 扩展报错 | `extension_error` | 打印错误 | 已实现（`client.js:1852-1855`，`pushNotice('extension error: '+error,'err')`） | `EVT-25` |

**统计：25 种 = 已实现 22 + 显式忽略 3 + 部分 0 + 缺口 0。**

线格式提醒：`message_update` 在 RPC 层被改写（`modes/json-event.ts:18-38`）—— 去掉累积 `partial`，只保留 `{type, usage, assistantMessageEvent}`；`toolcall_start` 额外补 `id` 与 `toolName`。面板解析必须按这个形状，不是 `AgentEvent` 原形。

---

## 4. TUI 27 条内置斜杠命令的对齐处置

来源：`core/slash-commands.ts:19-44`（24 条内置）+ `interactive-mode.ts:3446/3451/3456`（3 条未登记进 `BUILTIN_SLASH_COMMANDS` 的隐藏命令）。分发在 `interactive-mode.ts:3331-3466`（27 个 `if` 分支，`:3466` 的 `/quit` 之后 `:3468` 调 `await this.shutdown()`）。

处置与映射已固化在 `src/rpc-contract.mjs:147-175`（`TUI_COMMANDS`，27 条）；`classifyInput()`（`:202-230`）是面板与测试共用的判定器；`DISPOSITIONS`（`:282-283`）声明 6 种合法取值，`validateContract()`（`:286-323`）逐条校验「映射到未登记命令 / 非 rpc·client 却带 commands / 未知 disposition」等。

**disposition 六种**：`rpc`（面板发 RPC 命令）、`prompt`（兜底：原样当消息发给 agent，对齐 TUI 对未知命令的语义）、`client`（纯面板本地动作）、`local`（面板本地读文件）、`cli-only`（RPC 面没有，必须明示不可用）、`unsupported`（RPC 面没有但有等价操作，必须明示并给出出路）。

| 能力 | 命令 | 命令行 pi 的行为 | disposition | 面板落点 | 门禁用例 |
| --- | --- | --- | --- | --- | --- |
| 设置面板 | `/settings` | 42 字段选择器（`interactive-mode.ts:5098`，字段 `:5106-5147`） | `client` | `openSettings`（`client.js:5462`）→ 设置弹窗 `SettingsSheet` `client.js:4213`（0.7.0 起居中 `Dialog`） | `TUI-01` |
| 循环模型集 | `/scoped-models` | `showModelsSelector`（`:5571`）→ `setScopedModels`（`:5599`） | `client` | `togglePicker`（`client.js:5415`）→ `ModelPicker` `client.js:3258` | `TUI-02` |
| 选模型 | `/model` | `handleModelCommand`（`:5387`、`:5396`） | `rpc` | `handleRpcCommand`（`client.js:5651-5661`）：无参开向上弹层 `ModelPicker`，有参 `applyModelBySearch` `client.js:5377` | `TUI-03` |
| 思考档位 | `/thinking` | `handleThinkingCommand`（`:5338`） | `rpc` | `client.js:5653`：无参开同一弹层的「思考档位」段，有参 `applyThinkingByName` `client.js:5363` | `TUI-04` |
| 导出 | `/export` | `handleExportCommand`（`:6709`） | `rpc` | `runExport`（`client.js:5302`） | `TUI-05` |
| 导入 | `/import` | `handleImportCommand`（`:6756`） | `unsupported` | 提示改用左侧栏会话列表（等价 `switch_session`） | `TUI-06` |
| 分享 | `/share` | `handleShareCommand`（`:6803`，依赖 TUI editor/ui） | `cli-only` | notice `cliOnlyDetail`（`client.js:5668`） | `TUI-07` |
| 报缺陷 | `/bug` | `handleBugCommand`（`:6814`） | `cli-only` | 同上 | `TUI-08` |
| 复制末条回复 | `/copy` | `handleCopyCommand`（`:6829`、`:6842`） | `rpc` | `runCopy`（`client.js:5321`）+ `navigator.clipboard` | `TUI-09` |
| 设会话名 | `/name` | `handleNameCommand`（`:6860`、`:6874`） | `rpc` | `runSetName`（`client.js:5335`）/ 抽屉 `setDrawer('name')`（渲染 `client.js:6003-6009`，0.7.0 未改） | `TUI-10` |
| 会话信息 | `/session` | `handleSessionCommand`（`:6885`、`:6886`、`:6888`） | `client` | `openStats`（`client.js:5440`，统计弹窗；`get_session_stats` + `get_entries` + `loadState`） | `TUI-11` |
| 更新日志 | `/changelog` | `handleChangelogCommand`（`:6966`） | `local` | `openChangelog` → host 代读 `GET /changelog`，旧地址仍可用 | `TUI-12` / `test/host-parity.mjs` |
| 快捷键 | `/hotkeys` | `handleHotkeysCommand`（`:7001`） | `client` | 静态表 `hotkeyText()`（`client.js:6072`） | `TUI-13` |
| 分叉 | `/fork` | `showUserMessageSelector`（`:5693`、`:5709`） | `client` | `openFork`（`client.js:5430`）→ `get_fork_messages` + `fork` | `TUI-14` |
| 克隆 | `/clone` | `handleCloneCommand`（`:5731`） | `rpc` | `runClone`（`client.js:5351`） | `TUI-15` |
| 会话树 | `/tree` | `showTreeSelector`（`:5752`） | `client` | `openTree`（`client.js:5420`）→ `TreeSheet` client.js:4117（只读） | `TUI-16` |
| 项目信任 | `/trust` | `showTrustSelector`（`:5510`） | `cli-only` | notice；安全语义见 pi `docs/security.md` | `TUI-17` |
| 登录 | `/login` | `handleLoginCommand`（`:6054`） | `cli-only` | notice（OAuth 交互流依赖 TUI editor/ui） | `TUI-18` |
| 登出 | `/logout` | `showOAuthSelector('logout')`（`:3425`） | `cli-only` | notice | `TUI-19` |
| 新会话 | `/new` | `handleClearCommand`（`:7118`） | `rpc` | `runNewSession`（`client.js:5236`，发 `new_session` `:5150`）。**顶栏按钮是另一套语义**，见 `D-03` | `TUI-20` |
| 压缩 | `/compact` | `handleCompactCommand`（`:7276`、`:7280`） | `rpc` | `runCompact`（`client.js:5287`）。`handleSlash` 注释 client.js:5663-5665 明写「面板绝不把 /compact 之类当普通消息发给模型」 | `TUI-21` |
| 重载 | `/reload` | `handleReloadCommand`（`:6619`） | `cli-only` | notice（RPC 无 reload；面板的等价物是重建会话） | `TUI-22` |
| 调试转储 | `/debug` | `:3446`（未登记进 `BUILTIN_SLASH_COMMANDS`） | `cli-only` | notice | `TUI-23` |
| 彩蛋 | `/arminsayshi` | `:3451` | `cli-only` | notice | `TUI-24` |
| 彩蛋 | `/dementedelves` | `:3456` | `cli-only` | notice | `TUI-25` |
| 恢复会话 | `/resume` | `showSessionSelector`（`:5901`） | `client` | `SessionsSheet`（`client.js:3659`，0.7.0 起套在左侧滑出的 `SidePanel` `client.js:3164` 里）/ `SessionsList`（`client.js:3432` 纯渲染）**两级**：项目层 `scope=all` + `groupSessionsByProject`（`src/session-store.mjs:461`，当前置顶 → 非临时优先 → 最近活动降序，临时判定沿用 `TEMPORARY_PATH_PATTERNS`）→ 点进项目 `scope=project&cwd=` → `switch_session` `client.js:5493`。0.8.0 起 host 侧补齐面板偏好的落盘层（`src/ui-prefs.mjs`，`~/.superpi/ui-prefs.json`）与 `/ui-prefs` 三条路由（`index.js:991` / `:995` / `:1000`，都回全量结构）并配了用例（`test/host-parity.mjs` 3.12 / 3.13）——**且面板侧 0.8.0 已接线、0.8.1 起偏好上提到 `PiPanel`**（`prefsState` `client.js:4676`；`SessionsSheet` `client.js:3659` 只留行内菜单，写入结果经 `onPrefs` 回传）：`api.uiPrefs()` 读盘（定义 `client.js:1000`，挂载时调用 `:5047`），项目行重命名 `:3507`、新建会话于此项目 `:3508`，会话行重命名 `:3562`、置顶/取消置顶 `:3563-3565`，写回走 `api.setProjectPref` / `api.setSessionPref`（`:3724` / `:3727` / `:3754`）；置顶用两遍 partition（`:3526-3534`，不 sort，保留 host 给的顺序），标题优先级 `renamed → piName → headline → lastMessage → sessionFallbackTitle`（`:3540-3541`），重命名弹窗 `RenameDialog`（`:3621`）不复用 `NameSheet`（drawer 是单值）。pi 的 scope 开关进项目即失效（`session-selector.ts:1663`），故两级导航语义等价 | `TUI-26` |
| 退出 | `/quit` | `shutdown()`（`:3466`、`:3468`） | `client` | `endSession`（`client.js:5248`，断面板 + 关子进程，不退出宿主） | `TUI-27` |

**统计：27 条 = 已实现 17（rpc 8 + client 8 + local 1）+ 仅命令行 9 + unsupported 1 + 缺口 0。**

`/import` 用独立的 `unsupported` 而不是塞进 `cli-only`：前者 RPC 面确实没有、但也确实有等价操作（`switch_session`），面板必须给出路而不只是说「不可用」。0.2.5 时期这条被标成「第 6 种未文档化取值」，现在 `DISPOSITIONS`（`src/rpc-contract.mjs:283`）与 `:128-146` 的注释已对齐，`validateContract()` 也会校验它。

---

## 5. 已知契约缺陷清单

| 编号 | 缺陷 | 位置 | 当前状态 |
| --- | --- | --- | --- |
| `D-01` | `RPC_EVENTS` 混进 5 条伪事件（`extension_ui_notify/status/widget/title/editor_text`） | 原 `src/rpc-contract.mjs:99-103`（**注**：这两个坐标是本行登记时的写法，`99-103` 实际落在 `RPC_EVENTS` 中段的真实事件上 —— 伪事件名只出现在同文件 `:78-80` 的注释里，该文件的唯一提交 `91270e0`（0.3.0）起契约数组就从未真的包含它们。数字保留作历史记录，别当坐标） | **已闭环**。契约现 25 条真实事件（`src/rpc-contract.mjs:82-108`），`test/parity.mjs:318-319` 用 `contractOnly === []` 防回归 |
| `D-02` | `disposition` 出现未文档化的第 6 种取值 `unsupported` | 原 `src/rpc-contract.mjs:147` vs 注释 `:128-139` | **已闭环**。`DISPOSITIONS`（`:283`）声明 6 种，注释 `:128-146` 已枚举 6 种，`validateContract()`（`:286-323`）校验取值合法性 |
| `D-03` | 顶栏「新会话」按钮走 `close`+`create` 换子进程，而非 `new_session` | 原 `client.js:2958`（onClick）→ `endSession`（现 `client.js:5248`）（**注**：`2958` 在任何已发布版本里都不是顶栏「新会话」的 onClick —— v0.3.0 顶栏是两个按钮：「重连」`onClick: endSession` 在 `client.js:3036`、「新会话」`onClick: runNewSession` 在 `client.js:3037`；v0.2.5 的 `client.js` 只有 1128 行、根本没有这个按钮。数字保留作历史记录，别当坐标） | **已闭环（0.3.0，0.7.0 收口）**。「新会话」→ `runNewSession`（`client.js:5236`，`new_session`，与命令行 `/new` 同一条路径）；**「重连」不再占顶栏明面** —— 它退进 `⋯` 更多菜单 `moreItems`（`client.js:5700-5703`）并要过 `ConfirmDialog` 二次确认（`client.js:3190`），因为换子进程是恢复手段而不是日常动作。同一件事不再有两个入口两种结果 |
| `D-04` | `src/session-store.mjs`（只读会话枚举）零引用 | 原全仓 grep 无 import | **已闭环**。`index.js:34-45` import 八个函数（`listAllSessions` / `groupSessionsByProject` / `readSessionCwd` 于 0.5.0 追加），`GET /sessions/history?scope=`（`index.js:870`）暴露，面板 `SessionsSheet`（`client.js:3659`）消费 |
| `D-05` | `index.js` 未暴露 `pendingUi`，无扩展 UI 专用应答面 | 原 `index.js:484-567` | **已闭环**（host 面 0.3.0）+ **面板面 0.16.1 才真闭环**。`POST /sessions/:id/respond`；`pendingUi` 随 `snapshot()` 下发（`src/pi-rpc.mjs:603`）。<br>⚠️ **原记录在这里犯过一个错，务必记住**：它把「`pendingUi` 随 snapshot() 下发」当作闭环依据，但**面板从来没有读过这个字段**（0.16.0 实测：`client.js` 里 `snapshot.pendingUi` 出现 0 次）。验收只覆盖到「管道通了」，没覆盖到「交付到了」。真实后果：面板刷新时若 pi 正等扩展弹窗，弹窗在 UI 上不存在、用户无法应答，命令挂到 12 轮续期耗尽（约 12 分钟）才报 `N dialog(s) never answered`。<br>0.16.1 修法：`hydrateFromSnapshot()` 里消费 `snapshot.pendingUi`，走与实时事件**同一条**路径（`pendingUiOf` + `addPendingUi`）。门禁 `test/client-render.mjs` §13 四条断言钉死。**教训**：闭环判据必须落在「用户能感知到的那一端」，不是「协议字段发出去了」。 |
| `D-06` | `test/parity.mjs` 不存在，`npm test` 不含门禁 | 原 `package.json` `scripts.test` | **已闭环**。`test/parity.mjs` 78 checks + `test/host-parity.mjs` 291 checks + `test/session-projects.mjs` 55 checks（0.5.0 起）+ `test/timeout.mjs` 28 checks + `test/restart-lib.mjs`（0.4.2 起），都在 `npm test` 的 11 项里 |
| `D-07` | `RpcSessionState` 无 `autoRetryEnabled` | Pi 1.5.2 的 `rpc-types.d.ts` | **产品闭环（0.44.0）**。SuperPi 会话控制使用 `pi.getSettings()` 回读有效状态。两端支持查看和修改，项目覆盖时显示实际生效的值。原生 RPC 字段仍按上游契约对账。 |
| `D-09` | 点开历史会话后对话区空白：`switch_session` 成功后 host 清空事件缓冲，面板只重放缓冲 | 原 `client.js:2881-2884` `reload`（只 `attach`，无 `get_messages`）；根因在 `index.js:100` `SESSION_REPLACING_COMMANDS` → `proc.resetEvents()`（`index.js:1074`） | **已闭环（0.4.1）**。`attach` 末尾接 `hydrate(id)`（≈ `get_messages` 整表重建，剔除 `system`），覆盖首次进入 / `switch_session` / `fork` / `clone` / `new_session` 五个入口；两道防线：响应回来时会话已切走则丢弃（`sessionRef.current !== id`）、`busy` 期间不覆盖流式气泡（挂 `hydratePendingRef`，`agent_settled` 后由 `drainHydrate()` 补）。命令行 pi 不受影响：它从 jsonl 恢复 `messages`。`test/parity.mjs` §7 用 12 条断言钉死接线，`test/client-render.mjs` §9.16 用 14 条断言钉死数据整形 |
| `D-08` | `cycle_model` 在 RPC 面无方向参数 | Pi 1.5.2 的 `rpc-types.ts` 和 `rpc-mode.ts` | **产品闭环（0.44.0）**。面板反向切换采用 Pi 公开的模型范围、注册表、`setModel` 和 `setThinkingLevel`。命令行保留 Pi 的原生键位。 |

---

## 5.1 输入框能力对账（0.9.2 起，第三层对齐：不是 RPC 面，是输入框本身；0.9.4/0.9.7 补外观、颜色、位置与粘贴通道；0.9.9 补 footer 接管、项目切换与悬停反馈）

背景：用户报三件事（都在**命令行 TUI** 上）—— ①在输入框按 Ctrl+C 复制后内容消失；②Ctrl+A 不能全选；③Ctrl+X 不能剪切。加上背景需求：截图后 Ctrl+V 应能把文件路径粘进输入框。

实测（pi 1.5.2，本机）：

- pi-tui 的 `Editor` **没有选区模型** —— `keybindings.js` 里 `tui.input.copy`（ctrl+c）在 `editor.js:597` 直接 `return` 交回上层，pi 的 `CustomEditor` 再交给 `app.clear` → `handleCtrlC()`（`interactive-mode.js:3595-3603`）→ **清空输入框**；`tui.editor.cursorLineStart` 的默认键是 `["home", "ctrl+a"]`，所以 Ctrl+A 是「移到行首」；`ctrl+x` 全表无绑定。
- Windows 的 `getNativeClipboard()` 只导出 `getText / setText / getImage / enableVirtualTerminalInput / isModifierPressed` —— **没有 `getFilePaths`**（macOS 的实现里才有）。所以资源管理器里复制一个文件后 Ctrl+V：`readClipboardFilePaths()` → null、`readClipboardImage()` → null（CF_HDROP 不是位图）、`readClipboardText()` → null → **三档全空，什么都没发生**。

处置：**不改 pi 的任何文件、不打补丁**（用户 2026-11-17 明确禁用打补丁路线），改走 pi 官方扩展点 `ctx.ui.setEditorComponent()`（官方示例 `examples/extensions/modal-editor.ts` 同款）—— 本仓库新增 `extensions/superpi-editor.ts`：

| 键位 | 面板（浏览器 textarea） | 命令行 TUI（`extensions/superpi-editor.ts`） | 门禁用例 |
| --- | --- | --- | --- |
| Ctrl+A 全选 | 原生 | 已实现（覆盖 `cursorLineStart`；Home 仍是行首） | `test/tui-editor.mjs`：Ctrl+A 后光标在行尾 + 锚点在行首 + 不改内容 / Home 仍到行首 |
| Shift+←/→/↑/↓、Shift+Home/End 扩选 | 原生 | 已实现（`matchesKey` 直接认 `\x1b[1;2<字母>`） | 同上：锚点留起点、光标推到目标列、反向选区归一化 |
| Ctrl+C 复制 | 原生（浏览器负责，不清内容） | 已实现：有选区复制选区、无选区复制全文，**都不清空** | 同上：`Ctrl+C 之后内容仍在（bug 回归）` / 只复制选中部分 |
| Ctrl+X 剪切 | 原生 | 已实现：有选区剪切选区、无选区剪切全文 | 同上：两条 Ctrl+X 用例 |
| Backspace / Delete 删选区 | 原生 | 已实现 | 同上：两条 |
| 可打印字符 / 粘贴替换选区 | 原生 | 已实现 | 同上：输入 `X` 替换、`\x1b[200~` 括号内粘贴替换 |
| Ctrl+V 粘贴**剪贴板文件**的路径 | 原生（0.6.0 起走 `window.__DSH_HOST_PATHS__.pathFor`） | 已实现：有文本→交回 pi、有位图→交回 pi、都没有→读 Windows `CF_HDROP`（PowerShell `GetFileDropList`，异步不阻塞）插入绝对路径 | 同上：`decodeListing` 四条 + 安装面 |
| 空编辑器 Ctrl+C（两次退出） | 不适用 | **刻意放行**给 pi：`app.clear` 仍工作，取消中断仍是 Esc | 同上：`空编辑器 Ctrl+C 不抛错` |
| Esc 清选区但不吞键 | 不适用 | 已实现：清选区后把键交回 pi（中断/取消补全照旧） | 同上：`Esc 不被扩展消费（pi 仍能中断）` |
| 鼠标拖选复制 | 原生 | pi 自带（全屏模式 `fullscreenCopyOnSelect`，松手即复制并闪 `Copied!`）；本扩展在点击时清掉键盘选区，避免两套选区打架 | 同上：渲染反色开合成对 + 行数不变 |
| 输入框外观 | 浏览器原生（卡面 `--dsw-specific-input-major` + 28px 圆角） | **四边闭合**的框（`╭─╮ │ │ ╰─╯`），框线 **80% 白**（`FRAME_RGB = [204,204,204]` = 255×0.8）；pi 原本只有上下两条线。滚动提示（`↑ N more`）原样保留 | `test/tui-editor.mjs`：框线色常量、上下边框色、四个角、中间每行首尾都有 `│`、**每行显示宽度必须等于渲染宽度**（错一列框就歪） |
| Working 状态配色 | `WorkingRow`：`--dsw-alias-label-deep-diving` 蓝（0.6.4 起） | **回到 pi 原来的位置**（**上边框内侧左侧**，形如 `┌─ ◒ Working · 8s ───┐`），并**按状态换色**：正常白 `[255,255,255]` / 成功绿 `[126,211,133]` / 出错红 `[236,94,94]`，**图标与文案同色**；图标 `○`（空闲）/ `◐◓◑◒`（运行，按 250ms 取帧）/ `✔`（成功）/ `✖`（出错）。状态由 `agent_start` / `tool_execution_end.isError` / `agent_settled` 驱动；同时 `setWorkingVisible(false)` 关掉 pi 内置的 Working 行，避免两条并存 | 同上：四种状态各自的色值与图标、三色互不相同（用户报的正是「只用一种颜色」）、**位置在上边框（第 0 行）**、窄宽度下依次退让为「只剩图标 → 只画横线」 |
| 粘贴路径可辨识 | 0.6.0 起渲染成可点文件标签（图标 + 文件名） | 输入框里给**绝对路径加浅灰底色**（`PATH_CHIP_RGB = [104,104,104]`）。**底色只覆盖路径本身**：`trimPathToken()` 在最后一个已知扩展名（`PATH_EXT_RE`）处截断，所以「`D:<文件名>.png`然后把图改深色」不会把后面的普通文字也染色；药丸左右各吃一格底色当圆角，但**只有那一格确实是空白时**才吃（`padLeft` / `padRight`）。识别走保守正则：盘符 / UNC / POSIX 两段以上，排除 URL 与 `/settings` 这类斜杠命令 | 同上：Windows/POSIX 正例、URL 反例、相对路径反例、`/settings` 反例、渲染出现 `48;2;104;104;104` 且以 `49` 闭合、普通话不带底色、**紧贴普通文字时底色在扩展名处止住**、两侧是空白时才吃掉圆角格 |
| settings / home 入口 | 顶栏与 `+` 菜单（`openSettings` / 回首页不存在） | 放在**框外**、输入框**右下角**、模型信息**上方**，并排 `settings` `home`，**全小写**，**颜色与模型名一致**（pi footer 把模型名画成 `theme.fg('dim', …)`，这里同样用 `dim`）。点 `settings` 展开菜单（也在框外）：`settings` / `model` / `thinking` / `scoped-models` —— **全部是 pi 自己的斜杠命令**，点了等同用户敲回车（走 `onSubmit`）；点 `home` 提交 `/new`（起新会话树 = 刚启动时的界面）。运行中点击只给 warning 提示、不打断 | 同上：小写断言（`!includes('Home')`）、**位于下边框之下**（框外）、右对齐、用 `theme.fg('dim', …)` 上色、点 settings 展开 4 项、点菜单项提交对应命令、点 home 提交 `/new`、运行中被拦、Esc 关菜单、**并 grep pi 的 dist 断言这些斜杠命令仍然存在**（pi 删了门禁就红） |

安装与回滚（都是 pi 官方路径，不碰 `node_modules`）：

```powershell
npm run superpi:editor          # 装到 <piAgentDir>/extensions/superpi-editor.ts（幂等）
npm run superpi:editor:status    # 只读：源/目标/是否一致/pi 版本
npm run superpi:editor:remove    # 卸载，pi 下次启动恢复原始输入框
```

生效方式：重启 pi 会话窗口，或在 pi 里 `/reload`。一键启动（`tools/launch-both.ps1`）会在起 TUI 前自动装一次（`-NoEditorExtension` 可关，装失败只 WARN 不阻断 TUI）。

**已知边界（不是缺口，是刻意不做）**：①鼠标拖选复用 pi 自带的实现，本扩展只负责键盘选区 —— 不重写渲染层；②不接管 Ctrl+V 的文本/图片分支（交回 pi 原生 `handleClipboardPaste`），只在它读不到文件时补一刀；③不伪造 pi 没有的能力（无 vim 模式、无多光标）。

---

## 5.2 用户自定义规则（0.10.0 · 第四层：不是 RPC 面，也不是输入框，是**系统提示本身**）

需求：用户要一个可以自己改的「规则」设置项，**优先级最高**，初始内容由他给定。

前五轮对齐（RPC / 事件 / 斜杠 / 输入框 / footer）都在补「pi 有什么、另一端没有」；这一条不是缺口，是**两端都没有**的能力：
pi 只提供 `SYSTEM.md`（整份替换）、`APPEND_SYSTEM.md`（静态文件）与 `--append-system-prompt`（启动参数），三者都不是「面板里能改、改完立刻生效」。

| 维度 | 面板端 | 命令行 TUI | 门禁用例 |
| --- | --- | --- | --- |
| 读取当前规则 | `GET /api/superpi/rules`（文件不存在 → 默认文案，**不写盘**） | `/superpi-rules` → `ctx.ui.select` 顶部显示行数/字数/首行 | `test/host-parity.mjs` 3.14、`test/rules.mjs` F 段 |
| 编辑并保存 | 设置弹窗 → 「编辑规则」→ `RulesSheet`（textarea + 字数 + 超限禁用）→ `POST /rules` | `/superpi-rules` → 「编辑规则」→ `ctx.ui.editor` | `test/client-render.mjs` 9.11d、`test/rules.mjs` G 段 |
| 恢复默认 | 二次确认 → `POST /rules/reset` | `/superpi-rules` → 「恢复默认文案」→ `ctx.ui.confirm` | 同上（含「取消后文本不动」） |
| 清空 = 关闭 | 保存空文本 → `empty:true` / `rank:0`，UI 显示「当前未生效」 | 编辑成空 → 通知「已保存：当前没有规则」 | `test/rules.mjs`（`renderRulesBlock('') === ''`） |
| 生效位置 | 面板子进程同样由扩展注入 —— 两端**同一份文件、同一时点** | `before_agent_start` → `sections.user_defined_rules`，pi 排在 `cwd` 之后 | `test/rules.mjs` G 段 + 真机暗号验证 |
| 优先级表达 | 块首 `OVERRIDE_PREFIX`：「优先级最高…冲突时一律以本段为准」 | 同左（同一份渲染函数） | `test/rules.mjs` D 段、`test/parity.mjs` §8 |
| 坏文件 | 回落默认 + `warning`，面板照样打得开 | 回落默认，**异常不外抛**（pi 照常跑一轮） | `test/rules.mjs` D/G 段 |
| 命令行未装扩展 | `delivery.extensionInstalled:false`，设置里显示「命令行窗口未生效：运行 npm run superpi:editor」 | — | `test/client-render.mjs` ⑥ |

**为什么由 host 落盘而不是面板发 RPC**：pi 的 RPC 面没有「读系统提示」命令，扩展命令的返回值也不回传 —— 只走命令的话面板要自己再存一份回显，立刻两份真相；且设置页可能在**没有任何活着的子进程**时被打开（还没开会话 / 子进程崩了），一个设置项不该依赖另一个进程活着。

**为什么规则模型放在 `extensions/` 而不是 `src/`**：它有两个消费者 —— host 的三条路由与 pi 扩展的 `before_agent_start`。扩展会被原样复制到 `<piAgentDir>/extensions/`，把它放在目标目录里意味着 `./superpi-rules.mjs` 这条相对引用在仓库里与安装后指向**同一份内容**（零复制、零分叉）。放进 `src/` 再复制一份，就是「改一处、另一处忘改」的标准开局。

**刻意不做的三种做法**（都会让系统退化一个维度）：

| 做法 | 后果 |
| --- | --- |
| 写 `SYSTEM.md` | **整份替换** pi 的默认提示：工具说明、docs 路径、技能列表全没 |
| 写 `APPEND_SYSTEM.md` | 静态文件，面板改完要重启 pi 会话才生效，且面板没有读原文的通道 |
| 把规则当用户消息发出去 | 进 transcript、被压缩吃掉、污染历史，而且不是「最高优先级」 |

**实测踩到的缺陷（已修 + 已锁）**：`renderRulesBlock()` 首版自己包了 `<user_defined_rules>` 标签，而 pi 组装 section 时会**再包一层**，于是系统提示里出现同名嵌套两次。现在渲染器只出「覆盖声明 + 原文」，标签的唯一来源是 pi —— `test/rules.mjs` 断言 `renderRulesBlock()` 不含该标签。

**真机证据**（不是推测）：起真 `pi --mode rpc` 子进程 + 装好的扩展 + 真规则文件，规则里埋一个随机暗号，问模型「你现在遵守的最高优先级规则里有一串暗号，只输出暗号」→ 模型逐字吐出暗号。这一步才证明「面板写的规则真的到达了模型」，而不是只到达了某个 options 对象。

---

## 5.3 上下文窗口化（0.12.0 · 第五层：不是 RPC 面，也不是提示，是**发出去的那个请求本身**）

**现象（2026-11-18 实测）**：一个 2413 条消息的会话里读过 58 张 PNG 截图（会话文件 33MB，单张 base64 1.4~1.6MB）。
某次请求返回 `400 上下文超出上游上限（1048576 tokens，本次估算 1309796 tokens）`；
用户点「继续」→ 再返回 `Input too long: 1095829 tokens exceeds this provider's limit of 1048576`；
状态栏同时显示 **3.7% / 1.0M**（看起来还有 96% 空间）。会话此后**无法继续，也无法压缩，只能新建**。

**四条根因（都可量化，不是猜测）**：

| # | 根因 | 证据 |
| --- | --- | --- |
| 1 | 历史图片**没有生命周期**：`read` 进来的 PNG 以 base64 常驻之后**每一次**请求 | 会话内 58 个 image 块 / 26.6MB，没有任何一条被 `context_edit` 省略 |
| 2 | 上下文占用基线取自**最后一次成功的 usage**，而该上游把 prompt 全记在 cache 且 `input=0` | 最后一条成功 assistant：`input:0, output:156, cacheRead:31104, cacheWrite:3386` → `calculateContextTokens` = 34,646 ≈ 1048576 的 3.3%，即状态栏那个 3.7% |
| 3 | `isContextOverflow()` 是**英文正则表**，认不出这两条文案（中文「上下文超出上游上限」/ `exceeds this provider's limit of`） | `pi-ai/dist/utils/overflow.js` 的 `OVERFLOW_PATTERNS` 无一条命中 → pi 把它当**不可恢复错误**，既不自动压缩也不重试 |
| 4 | 即便识别成功，压缩本身也要把「切点前的全部历史」发给模型（`prepareCompaction` → `messagesToSummarize`）→ 1.28M 输入**同样 400** | 「用超限的资源去解决超限」的自指死锁；重试同理 |

**方案：在 pi 官方扩展点 `context` 事件里做非破坏性窗口化**（`extensions/superpi-context-guard.ts` + `.mjs`）。
每次 LLM 调用前拿到 messages 深拷贝，按「信息价值/成本」分级折叠，**保证请求不超预算**；不写 session、不调模型、不联网。

| 维度 | 面板端（RPC 子进程） | 命令行 TUI | 门禁用例 |
| --- | --- | --- | --- |
| 生效方式 | 扩展装在 `<piAgentDir>/extensions/`，RPC 子进程加载 | 同一份扩展，同一 agent loop | `test/context-guard.mjs` E 段（jiti 真加载） |
| 裁剪顺序 | 旧图片 → 旧思考 → 超长工具结果 → 旧工具结果 → 旧回复 | 同左（同一份 `.mjs` 纯函数） | `test/context-guard.mjs` C 段 |
| 保护区 | 最近 `keepRecentTurns` 轮 / `keepRecentMessages` 条 / `protectedTokenRatio` 窗口，三者取最严 | 同左 | 同上（断言保护区 token 不超上限） |
| 本轮图片 | 最后一条 user 之后的图片**一张不动**（模型还没看过，换了等于白读） | 同左 | 同上（`tailImages === 2`） |
| 幂等 / 单调 | 同一输入两次结果一致；前缀只随会话增长后退 → prompt cache 不被击穿 | 同左 | 同上（二次运行 0 变化、返回同一引用） |
| 无需裁剪时 | 返回 `undefined`（不触发 pi 重放系统提示） | 同左 | 同上 |
| 停用 | `<home>/.superpi/context-guard.json` → `{"enabled":false}`，一条都不动 | 同左 | 同上 |
| 坏配置 | 退回默认（默认启用）且不抛 —— 守护失效比静默不裁更危险 | 同左 | 同上 |
| 观测 | `<home>/.superpi/context-guard.log.jsonl`（滚动 240 行）+ `/superpi-context` 命令 | `/superpi-context` | 同上 D 段 |
| 真实占用 | 统计抽屉多一行「真实占用（上下文守卫）」= `before → after / window` + 已释放图片数；数据走 `GET /context?sessionId=`（host 只读日志最后一行） | **footer 第 2 行的百分比**：有本会话守卫记录时显示 `~60.0%/1.0M`（`~` = 守卫估算），无记录时退回 pi 原值 | `test/host-parity.mjs` 3.11、`test/client-render.mjs`、`test/tui-editor.mjs` ④g（7 checks） |

**口径差异是刻意的**：pi 自己的 `estimateTokens` 把一张图记成 4800 chars ≈ 1200 tokens，而上游按视觉分辨率计费（本例 ≈ 7.7k/张）。
本模块默认 `imageTokens = 12000`、`charsPerToken = 3`（中文场景不低估）、`targetRatio = 0.72` —— **宁可多释放一张旧图，也不"以为还有余量"地发出去**。

**实测（用上面那个 33MB 会话回放）**：估算 1,909,544 → **578,485**，预算 754,974；
释放 57 张图、丢弃 166 条思考、折叠 429 条旧工具结果、3 条超长结果截断；二次运行 0 变化。
真机复现（`pi --mode rpc --session <该会话副本>` 发「继续」）：窗口 1,000,000 / 预算 720,000，
`before 1,870,607 → after 524,122`，**58 张图全部释放，请求成功继续多步工具调用** —— 死锁解除。

**光裁剪不够：要让模型自己不再制造大块内容（0.12.0 补）**。只裁剪的话模型不知道图已被换成占位，
会以为图还在、反复 `read` 同一张图，于是继续制造大块内容。所以同一扩展再挂 `before_agent_start`，
把一段**上下文卫生**准则写进 `systemPromptOptions.sections.superpi_context_hygiene`（与用户自定义规则
并列、互不抢 key；`hygiene:false` 可单独关）：

| 准则 | 为什么写死 |
| --- | --- |
| 截图/渲染图看完写结论，**不要反复 read 同一张图** | 生产的每一张图都是后续每次请求的常驻成本 |
| 历史图片会变成 `[image omitted: 路径]`，需要时按路径重新 read | 让模型理解占位是正常机制，不会以为工具坏了 |
| 收尾时把**自己生成的**临时图移到 `_scratch/archive/` | 磁盘归档只解决「重复读取」与目录整洁，**不等于**释放上下文（上下文存的是 base64 副本） |
| **只清理本次任务自己生成的中间产物**，用户素材一律不动 | 「省上下文」不能变成「误删素材」——这条边界必须写在提示里 |

**为什么不去改 pi 的 `OVERFLOW_PATTERNS`**：那只是让 pi「认得」这个错，压缩输入仍然超限（根因 4），
且 vendored 改动在升级时必丢 —— 治的是症状，不是病。**让超限不可能发生**才是根治。

---

## 5.5 输出完整性与任务恢复

| 能力 | 面板端 | 命令行 TUI | 门禁 |
| --- | --- | --- | --- |
| 六类异常和健康短回复 | host 在 `message_end` 使用共享判据，视图消费结果 | Working 行使用同一判据和文案 | `test/turn-verdict.mjs`、`test/tui-editor.mjs` |
| 手动继续 | 告警里的「继续」按钮 | 底栏的「继续」入口 | 告警 SSR、终端命中和发送、`test/reliability.mjs` |
| 自动续跑 | Pi 在 `agent_before_settle` 从已保存的工具结果继续未交付的回复 | 同一扩展、同一配置、同一条件 | `test/reliability.mjs` 覆盖成功写入后遇到 DSML、续跑后验证文件，以及截断回复的工具处理 |
| 写入保护和诊断 | 写入前检查文本。被拦截的参数从下一次请求中移除，工具错误和安全路径继续提供给模型。`/superpi-integrity` 查询 | 同一扩展和会话投影 | `test/text-integrity.mjs`、`test/reliability.mjs` 覆盖混合工具批次与重开会话 |
| 长任务上下文 | 对成功写入的长正文做会话投影，压缩摘要参与预算 | 同一投影和预算 | `test/context-guard.mjs`、`test/reliability.mjs` |
| 取消和会话进度 | 主动停止后清理继续提示，重连时从快照恢复未解决的提示 | 主动停止后返回空闲，未解决的原因显示在 Working 行 | `test/turn-verdict.mjs`、`test/tui-editor.mjs`、`test/reliability.mjs` |

自动续跑在 Pi 原生重试和压缩之后判断。0.39.0 起，畸形回复的续跑条件以该条回复的工具调用和执行结果为准。此前已完成的工具结果供下一次请求使用。若失败回复自身有工具结果，保留它们交给 Pi 处理。待处理的用户输入优先，主动停止立即生效，连续异常最多补一次请求。干净的截断前缀参与续写，畸形响应只留在原始会话记录中。面板和终端都允许在同一会话换模型后继续。

`test/reliability.mjs` 使用真实 Pi RPC 子进程和回环 SSE 服务，覆盖字符跨包、真实坏字节、工具拦截、正常结束、连续故障和手动停止。第三方网关的偶发故障和实际任务是否完成需要独立证据。见 [输出完整性](output-integrity.md)。

## 5.4 模型模态开关（0.13.0 · 第六层：不是 RPC 面，是**每个模型允许收什么**）

需求（用户 2026-11-18）：「每一个模型都增加一个模态启用功能，具体有哪些模态根据对应模型协议解析，
默认文本和图像开启，其它模态默认关闭，可以由用户主动开启；TUI 功能保持对齐。」

**先把边界钉死（这决定了什么不该做）**：

| 问题 | 实测答案 | 来源 |
| --- | --- | --- |
| pi 的输入模态枚举有几个值 | **只有 `text` 与 `image`** | `ModelInputModalitySchema`（pi-ai/providers/model-schema.d.ts:9） |
| 有哪些内容块类型 | `text / thinking / toolCall / image` | `ContentBlock`（pi-ai/types.d.ts:259-278） |
| 适配层能发出音频/视频/文档吗 | **不能**，全部 api 只有 `image` 分支 | `grep -c 'case "audio"' dist/api/*.js` = 0 |
| 模型库里 `input` 的实际取值 | 1773 条只有 `["text","image"]` / `["text"]` | `dist/providers/data/*.json` |

所以「其它模态」不是被我们藏起来了，而是**运行时根本发不出去**。按用户「禁止利用目标维度指标的
漏洞」的原则，这里**不做假开关**：`unsupported` 的模态会显式列出并写明「协议声明但运行时无法发送」，
不可开启。pi 将来加了音频块，`resolveModelModalities()` 会自动把它纳入可开关集合（清单在
`test/modalities.mjs` F 段与 pi 类型对账，清单过期会红）。

| 维度 | 面板端 | 命令行 TUI | 门禁用例 |
| --- | --- | --- | --- |
| 入口 | 设置弹窗「模型模态」一节（每个模型一行、每个模态一个 chip） | `settings` 菜单 → `modalities`（= `/superpi-modalities`） | `test/client-render.mjs` 9.11a2、`test/tui-editor.mjs` ⑧ |
| 模态清单来源 | `model.input` ∩ 运行时清单（`GET /modalities` 的 registry） | 同左（`ctx.scopedModels` / `ctx.modelRegistry.getAvailable()`） | `test/modalities.mjs` A 段 |
| 默认值 | 文本 + 图像开启；其它默认关 | 同左（同一份 `.mjs`） | 同上 B 段 |
| 文本 | 锁定开启，显示「对话必需通道，不可关闭」 | 同左 | 同上（`text` 覆盖被拒、POST 400） |
| 关闭后的效果 | **请求前把该模态的块换成占位文本**（`context` 事件） | 同左（同一 agent loop） | 同上 G 段（断言返回的 messages 里没有 image 块） |
| 未知模型（无 `input`） | 按产品默认（文本+图像）处理，**不凭空降级** | 同左 | 同上 A 段 |
| 落盘 | `<home>/.superpi/modalities.json`（稀疏，只存非默认） | 同一份文件 | 同上 E 段 |
| 非法输入 | 400（未知模态 / 锁定项 / 缺 id / 缺 enabled） | 命令里拒绝并提示 | `test/host-parity.mjs` 3.11b |

**为什么「关闭」必须在 `context` 事件里做，而不是在输入框处拦**：关掉图像不等于禁止用户贴图，
而是**不要让这个模型收到图**。两者语义不同：用户贴了图、模型收到占位并知道「这里原本有一张图」，
比「贴图被静默拒绝」更好用，也更容易诊断。真正的执行点只有一处（守卫的 `context`），
面板、TUI、RPC 三个入口都只是写同一份状态。

**与上下文守卫的关系**：守卫先按模态开关剥（用户显式策略），再按窗口预算裁（自动止损）。
顺序不能反：先剥掉用户明确不要的模态，预算才能算准；反过来则会把「本来就不发的图」算进压力里。

---

## 5.6 品牌与启动入口（0.20.0）

| 范围 | 面板 | 命令行 | 验证 |
| --- | --- | --- | --- |
| 产品名 | 两种语言的侧栏入口、标题、配置和诊断均使用 SuperPi | `superpi` 启动入口、原生横幅和窗口标题均使用 SuperPi | `test/client-render.mjs`、`test/brand-pi-runtime.mjs`、`test/tui-editor.mjs` |
| 安装运行时 | 一键安装和发布包均使用固定的上游运行时版本，加载时配置品牌 | 启动时读取并应用同一份品牌配置 | `test/brand-pi-runtime.mjs`、`test/fresh-boot.mjs`、`tools/standalone-verify.ps1` |
| 历史会话 | 读取运行时实际使用的配置目录和环境变量 | 延用 `.pi` 默认配置目录，兼容已有 `PI_CODING_AGENT_*` 环境变量 | `test/brand-pi-runtime.mjs` |

## 5.7 Agent 主动询问（0.20.0）

| 行为 | 面板 | 命令行 | 验证 |
| --- | --- | --- | --- |
| 等待用户答复 | 用现有扩展 UI 协议显示选项和输入，重新连接时恢复待答问题 | 用原生 `ctx.ui.select` 和 `ctx.ui.input` | `test/reliability.mjs`、`test/tui-editor.mjs` |
| 返回答案 | 通过 `/respond` 提交，宿主确认后收起，发送失败可重试 | 选择或输入完成时返回原始答案 | `test/client-render.mjs`、`test/reliability.mjs`、`test/tui-editor.mjs` |
| 取消和停止 | 关闭或超时返回未回答，停止会同时关闭询问 | 使用同一个 `ask_user` 工具和停止信号，每个弹窗最多等待 5 分钟 | `test/reliability.mjs`、`test/tui-editor.mjs` |

## 5.8 任务验收和故障恢复（0.21.0）

| 行为 | 面板 | 命令行 | 验证 |
| --- | --- | --- | --- |
| 有截止时间的验证 | `verify` 调用 Pi 启用的 Shell，展示退出码、已收到的输出和停止状态 | 同一工具定义、Shell 执行和停止信号 | `test/delivery.mjs`、`test/reliability.mjs` |
| 隔离变异 | 在临时副本应用唯一匹配的替换，命令完结后回收副本 | 同一工作区复制和精确替换 | `test/delivery.mjs`、`test/reliability.mjs` |
| 带对照的变异验证（0.32.0） | `expectedFailure` 执行原始与变异两个独立副本，保留各自输出与退出码。通过要求原始版本成功和变异版本报告指定诊断 | 共用同一次源码采集、字面诊断匹配和总截止时间。超时保留已完成的原始结果 | `test/delivery.mjs`、`test/reliability.mjs` |
| 编号变异验收（0.34.0） | 任务声明替换和诊断，`verify` 按编号运行对照。任务详情保留诊断和两个退出码。工作区与受测快照不同时保留测试结果，该项待验收 | 同一任务分支、快照指纹与诊断。交付时重验源码指纹，变动后用新证据完成任务 | `test/delivery.mjs`、`test/reliability.mjs` |
| 任务与验收 | 输入区显示已验证项和状态，`/superpi-task` 查看详情，环形缓冲淘汰后从快照恢复 | 原生 widget 与同一斜杠命令，会话分支保存记录 | `test/delivery.mjs`、`test/client-render.mjs` |
| 验收命令重跑（0.29.0） | 命令启动前该项恢复为待验收，主动停止或进程退出后重开会话仍显示待验收 | 同一 Pi 会话分支。新命令成功且源码指纹一致才记入证据 | `test/reliability.mjs` |
| 命令运行期源码版本（0.30.0） | 发现工作区源码在命令期间改写时，工具显示证据失效，验收项保持待确认。结果附实际退出码和可定位的源码路径 | 共用 Git 文件范围和文件版本核对。暂存与忽略的构建输出可以在验证中正常产生 | `test/delivery.mjs`、`test/reliability.mjs` |
| 源码采集（0.40.0） | 验收、变异和独立评审有限并发读取和复制源码，按原有路径顺序生成指纹 | 共用采集实现。复制失败时等待已开始的操作结束后清理副本 | `test/delivery.mjs` 覆盖并发上限、快照指纹一致性和失败清理 |
| 验收期间的临时路径（0.31.0） | 收到未忽略路径的增删通知时，工具指出路径，验收仍待确认。已消失的路径也参与判定 | 共用工作区通知、Git 忽略规则、文件版本与退出码。通知无法使用时说明原因 | `test/delivery.mjs`、`test/reliability.mjs` |
| 到达收尾边界 | 活动中的任务在无待处理输入时可续跑一次。命令证据与实际退出码和文件指纹关联 | 同一 Pi 会话分支与收尾钩子 | `test/delivery.mjs`、`test/reliability.mjs` |
| 最新截图可见 | 历史配额内保留位图，配额外写入路径引用。短期缓存向模型提供最新工具图片 | 同一工具结果和上下文投影 | `test/context-guard.mjs`、`test/delivery.mjs`、`test/reliability.mjs` |
| 正文标记异常 | host 挂载同一 `reasoning-markup` 判决并显示警告 | 基于同一判定器提示。恢复遵守原有副作用边界 | `test/turn-verdict.mjs`、`test/delivery.mjs`、`test/reliability.mjs` |

命令证据绑定当时的 Git 工作区普通文件，忽略的依赖和外部服务由项目验收命令负责。Shell 无法确认终止时，工具仍在有界等待后返回状态。临时副本留给执行器在结束时清理。测试应以快照或隔离的工作区运行故意失败的实验。

## 5.9 断流恢复、独立审查和收尾证据（0.22.0）

| 行为 | 面板 | 命令行 | 验证 |
| --- | --- | --- | --- |
| 上游提前断流 | 同一回合从已完成的工具结果恢复。仍失败时显示原因与「继续」 | 同一恢复扩展，Working 行显示相同判据和入口 | `test/reliability.mjs`、`test/turn-verdict.mjs`、`test/tui-editor.mjs` |
| 并行审查代码与测试 | 通过现有工具事件显示 `review_changes` 的进度和结果 | 通过原生工具界面使用同一 Pi 扩展 | `test/reliability.mjs`、`test/client-render.mjs` |
| 报告范围和状态 | 展示行号、遗漏和已返回的报告。两路审核相同源码，超时或不完整时保留已返回结果 | 同一快照、工具权限、截止时间和报告 | `test/reliability.mjs` |
| 审查验收与收尾 | 两路完整且无阻塞项才记录 `review: true`。源码变化撤回旧证据，任务状态随会话恢复 | 同一分支、文件指纹及收尾钩子 | `test/reliability.mjs`、`test/delivery.mjs` |

验收要求覆盖完整的 `HEAD` 差异。使用 `paths` 时，与快照中的全部改动比对，有遗漏便报告缺失文件。独立调用可通过 `base` 使用其它基准。二进制及无法读取的变更会被明确报告。可用 `npm run test:engineering` 校验两个工程基准的评分能力。

## 5.10 审查断点与收尾（0.23.0）

| 行为 | 面板 | 命令行 | 验证 |
| --- | --- | --- | --- |
| 发现既有测试与调用方 | 独立评审可按名称检索当前快照，重复的大段源码使用已有证据引用，短范围仍返回精确的带行号原文 | 同一只读目录和原生工具结果 | `test/reliability.mjs` |
| 静态审查与执行证据 | 两种审查方式均要求把静态覆盖缺口定位到具体源码。测试执行的备注进入报告，命令证据由 `verify` 记录 | 同一报告结构与命令验收 | `test/reliability.mjs` |
| 按证据恢复 | 同一验收与源码绑定到会话分支。恢复只补跑未返回的评审，显示复用结果 | 同一 Git 指纹、覆盖范围与会话记录 | `test/reliability.mjs` |
| 评审断流续跑（0.26.0） | 已读源码的评审在断流后可用一次请求提交已有发现和待查缺口，全量评审仍待验收。进度与结果注明恢复的评审 | 沿用同一快照中带位置的源码摘录、会话重试设置、截止时间与请求预算 | `test/reliability.mjs` |
| 评审取证跨进程恢复（0.27.0） | 更新后的评审结果会显示保存和恢复的源码段数。重开会话后，待补审的一路可从同一快照取回已读源码 | 共用 Pi 的会话分支、只保存路径与行号，用 Git 快照重建带行号的摘录。指纹变化时重新评审 | `test/reliability.mjs` |
| 评审运行中保存证据（0.28.0） | Pi 在评审进行中保存已读范围和已提交报告。进程退出后重开同一会话，可恢复证据并显示已复用的报告 | 同一 Pi 会话分支检查点和快照指纹。已有最终结果的评审以最终结果为准 | `test/reliability.mjs` |
| 无进展时收尾 | 同一用户请求的同一份证据最多发起两轮。继续重复会保留待处理原因并结束回合 | 同一回合结束与任务状态 | `test/reliability.mjs` |
| 审查请求计数与失败原因（0.23.1） | 通过真实工具进度记录开始与已发出的请求，最终报告保留取消计数与模型失败类型 | 同一请求边界与报告 | `test/reliability.mjs`、`test/engineering-bench.mjs` |
| 有限源码快照一次供证（0.25.0） | 首轮提供完整当前源码及 Git 差异，差异装不下时可用改动文件的基准内容。两路可直接提交带当前行号的报告，超时或可恢复失败的评审仍可在原时限内按需查阅 | 同一字节预算、时限、快照与报告判据，限定路径或文件超出条件时以差异开始 | `test/reliability.mjs` |
| 首轮证据和空闲判断（0.36.1） | 以差异材料和实际查阅工具定义计算首轮预算。完整材料符合预算时，两路直接取得改动源码与未改动测试。持续输出重开空闲窗口，空闲超时或输出无有效报告时切换到按需查阅 | 同一快照、预算、空闲窗口和总时限。相关验收计划与评审关注重叠操作及部分失败 | `test/reliability.mjs` |
| 完整源码审查与工具结果证据（0.45.0） | 完整且符合预算的源码范围首轮即可报告。完成的大写入与写入闸的拒绝以文本证据参与后续请求 | 同一 Git 选区、模型证据预算和 Pi 会话投影。两端原始工具记录可查，保留同批有效工具配对 | `test/reliability.mjs`、`test/context-guard.mjs` |
| 多步验收续跑与续审（0.46.0） | 新取得证据的编号验收项能推动提前收尾的任务继续。修订计划时保留目标、验收条件和源码都吻合的命令证据。审查中的阻塞意见带源码引用，重审同一快照会继承未关闭的问题 | 共用 Pi 收尾事件、分支验收记录和独立审查工具。相同验收项的重复证据不增加续跑次数，两端均可查看修订后的进度和逐项关闭依据 | `test/delivery.mjs`、`test/reliability.mjs` |
| 凭验收证据完成任务（0.38.0） | 开启 `finishWhenVerified` 的任务可在最后一项验收单独执行后收尾。已有证据再次通过源码核对，任务与可见回执写入同一 Pi 会话分支。实时对话和历史会话均显示回执 | 同一批次结束和会话收尾规则。待处理的用户输入优先，后续改动会撤回过期证据 | `test/delivery.mjs`、`test/reliability.mjs`、`test/client-render.mjs`、`test/engineering-bench.mjs` |

工程基准把独立代码断言与真实回合结束分别统计。进程退出、用户停止、待验收和模型错误都有独立的运行结果。

0.33.0 的工程对照从相同 Git 树生成独立工作区，同一提示词和时限交给三个 CLI。借助各自的完成事件与统一评分，同时记录原始事件、退出和失败原因。工具可用性与代码得分分别记录。SuperPi 使用仓库内与面板共用的运行时扩展。

0.35.0 在同一份交付快照上执行功能断言与源码完整性检查。交付判定同时要求正常收尾、功能通过和源码完整。报告按路径记录非法 UTF-8 与坏字符，功能分数按原断言单独保存。门禁 `test/engineering-bench.mjs` 用功能全过但含损坏字节的源码复现误判，并验证正常中文和 emoji 可以交付。

0.37.0 的状态迁移对照在项目起点提供并发回归。公开测试和独立评分在首次异步文件替换保持进行中时启动其余保存，检查每次保存都成功、最终文档完整且没有残留临时文件。实际文件系统的并发断言继续计入评分。门禁同时检验串行保存的对照实现和取消排队后的变异实现。

## 6. 变更记录

| 日期 | 版本 | 变更 |
| --- | --- | --- |
| 2026-11-25 | 0.46.0 | 多步验收可随新增证据继续推进。修订同一目标的计划时复用仍适用的命令证据。独立审查核对阻塞意见的源码引文，续审逐项继承阻塞问题和待查项，关闭问题时保留引文与解释。 |
| 2026-11-25 | 0.45.0 | 独立审查对符合预算的完整源码首轮提供当前内容与精确基准，支持覆盖完整源码的显式路径范围。成功的大写入和写入闸确认的拒绝以普通文本证据进入请求，原始调用和结果照常保存在会话中。先保存结果证据，再投影调用与结果。重开可从中断的落盘前缀恢复，旧版参数占位也在请求边界归一化。 |
| 2026-11-25 | 0.44.0 | 面板在一个 DSH 入口中运行和切换独立会话。重复选择已运行的历史时切换到其标签。两端可查看和修改有效的自动重试设置，并支持正向和反向轮换模型。自检对运行文件缺失给出失败状态，恢复原字节后实时通过。提供按平台打包的离线安装归档。 |
| 2026-11-25 | 0.43.0 | 写入闸从后续模型请求中移除已确认被拦截的参数。保留原始会话记录、工具诊断及同批调用结果。检查覆盖后续请求、同轮改正与 Pi 进程重开。README 将启动、能力、配置和验证入口提前。 |
| 2026-11-25 | 0.42.0 | `npm test` 按原顺序运行每套门禁一次，按子进程当次的退出状态、摘要和登记下限完成两端验收。 |
| 2026-11-25 | 0.41.0 | 全新副本用 `npm ci` 安装锁定的验收依赖。React 渲染共用依赖判据，临时技能安装与记忆样本让命令行和面板验收在空白用户目录也能完整执行。 |
| 2026-11-25 | 0.40.0 | 工作区指纹和验证快照使用同一套有限并发采集逻辑，以原有顺序生成指纹。 |
| 2026-11-24 | 0.38.0 | 明确声明的验收项全部通过后，可在正常收尾时以重新核实的源码证据完成任务，并在双端显示持久化回执。 |
| 2026-11-24 | 0.37.0 | 状态迁移对照加入可运行的公开并发回归与独立受控冲突断言。对照可定位在同一目标繁忙时失败的保存操作。 |
| 2026-11-24 | 0.36.1 | 独立评审将节省的查阅工具定义空间用于完整源码和测试。首轮在总时限内保留有持续输出的请求。验收计划与评审强调重叠操作和部分失败的证据。 |
| 2026-11-24 | 0.35.0 | 三方工程对照使用同一份交付快照验证功能和源码字节。报告保留功能分数、回合结局和按文件记录的完整性检查。 |
| 2026-11-24 | 0.34.0 | 编号验收可要求测试发现指定回归。原始与变异两个独立快照的结果只有与当前源码指纹一致才算交付证据。 |
| 2026-11-24 | 0.33.0 | 增加三方工程对照命令，记录相同起点、实际收尾、时限和独立评分。评分器可报告加载失败而保留共同评分分母。 |
| 2026-11-24 | 0.32.0 | `verify` 加入带对照的变异验证，实测能识别变异被检出、变异仍通过、原始版本失败、诊断不符与超时。长日志用 Shell 原始记录核对。 |
| 2026-11-24 | 0.31.0 | 编号验收结合路径增删通知和 Git 忽略判定，识别只在命令运行期间存在的源码。实测空目录内的临时文件、新建后删除的目录和忽略的构建输出。 |
| 2026-11-24 | 0.30.0 | 编号验收增加命令执行前后的文件版本比对。已验证命令内部临时改写、外部改写未跟踪源码及恢复修改时间的场景。 |
| 2026-11-24 | 0.29.0 | 重跑编号验收命令前持久化待验收状态。实测主动停止与强制退出后，必须取得新命令的通过证据才能完成任务。 |
| 2026-11-24 | 0.28.0 | 在独立评审运行中保存已读范围和有效报告。强制退出测试确认同一会话可恢复证据并补审。 |
| 2026-11-24 | 0.27.0 | 未完成的独立评审保存已读源码的路径与行号，重开会话后可以重建同一份证据。 |
| 2026-11-24 | 0.26.0 | 独立评审在原有预算内从完成的源码读取恢复网关断流，双端展示恢复进度并继续验证报告位置。 |
| 2026-11-24 | 0.25.0 | 源码评审复用精确的当前正文与 Git 基准内容，减少重复传输；已观测到的网关断流加入双端共同判据。 |
| 2026-11-24 | 0.24.0 | 小型源码快照首轮供齐证据；结构化缺口定位到快照文件；按需查阅仍在同一评审时限内。 |
| 2026-11-24 | 0.23.1 | 审查在请求发出时计数，保留评审断流原因，度量工具对实时计数与最终报告去重。 |
| 2026-11-24 | 0.23.0 | 审查文件目录、按快照恢复单路评审、重复审查有界收尾及实际运行度量。验收见 §5.10。 |
| 2026-11-23 | 0.19.0 | 面板和终端共享会话恢复与扩展安装，写入保护覆盖目标路径和新内容，成功写入的大段正文从后续请求去重。验收见 §5.5。 |
| 2026-11-23 | 0.18.0 | **输出完整性：坏字节不许落盘，没交付必须可见**（起点是用户 11-19~11-23 的排查结论：请求全部成功，「中断感」来自回复提前结束；「代码错乱」来自自定义模型输出的坏字节被写进文件）。**一、取证（20 个真实会话 / 5450 条记录，探针在 `_scratch/`，结论写进 `docs/output-integrity.md`）**：2600 条 assistant 里 156 条 `stop`、147 条「无工具调用但有正文」、**70 条**后面紧跟用户手打「继续」；坏字节落在 text 19 / thinking 6 / toolCall 参数 26；其中 **`write.content` 7 次含 U+FFFD，7 次全部成功落盘**（`bash.command` 15 次含坏字节、13 次执行成功）。**二、写盘闸（`extensions/superpi-text-integrity.ts`）**：`pi.on('tool_call')` 在写盘前拦 —— `write.content` / `edit.edits[].newText` 含坏字节 → `{block:true, reason}`（文件不写、理由带行号码位总数 + 「文件未写入」+ 「不要原样重发」+ 转义写法）；**`edit.oldText` 放行**（修已坏文件时匹配串必然含 U+FFFD，拦它等于禁止修复）；**`bash`/`powershell` 只提醒不拦**（同一串字节可能是修复脚本），改在 `tool_result` 末尾追加警告；观测落 `~/.superpi/integrity.log.jsonl` + `/superpi-integrity`。**三、判据扩到六类并改成单点判定**：`superpi-malformed.mjs` → `superpi-turn-verdict.mjs`，新增 `corrupt`（无 toolCall 的收尾消息含坏字节）与 `truncated`（`stopReason: 'length'`）。**面板不再有判据实现、也不再依赖 `/contract`**：host 在 `PiProcess.pushEvent`（入环之前，回放与实时同一份）给 `message_end` 附 `verdict`，面板只渲染 —— 0.17.3 那个「契约晚到 → 提示永久丢失」的竞态**随依赖一起消失**，而不是靠启动顺序绕开；`src/rpc-contract.mjs` 里的 `MALFORMED_DETECTION` / `MALFORMED_NOTICE` 两份副本同时删除（判据知识只剩一处）。**四、刻意不做的**：不判「短回复但声称做完了」—— 147 条里只有 6 条有结构信号（以 `：` 收尾），其余读起来都是完整句子，语义判断只会制造假警报（§5.0）。**五、门禁**：`malformed`(80) → `turn-verdict`(125) + 新增 `text-integrity`(68)；`parity` 103→104、`host-parity` 428→432、`rules` 209→213、`tui-editor` 523→531；`selfcheck` 文件数 15→19。新门禁按**真实 import 语句**做拓扑排序，当场抓到一个既有缺陷：`context-guard.ts` import `modalities.mjs`，而清单把 modalities 模块排在它后面（0.15.3 那类「装到一半加载即抛」的同类），已重排。**六、未验证**：真机（内置 0.18.0 的 DSH + 自定义模型）尚未跑过 —— 需要重启 DSH 并让用户在实际会话里观察；本行不冒充已验证。 |
| 2026-11-12 | 0.2.5 | 建立本账本。实测基线：RPC 33 条 / 已实现 5 / 部分 1 / 缺口 27；扩展 UI 9 请求 3 应答全部缺口（host 已就绪）；事件 25 种 / 已实现 12 / 部分 3 / 显式忽略 2 / 缺口 8；TUI 27 条 / 缺口 14 / 部分 3 / 仅命令行 10。登记 `D-01`..`D-06`。（行号为 0.2.5 落地当时的坐标，非当前坐标） |
| 2026-11-20 | 0.16.2 | **面板端从来没有认过畸形输出 —— 命令行会亮红字，面板完全静默**（`grep -c DSML client.js` = **0**）。这是同一故障的**第四次**记录，前三次（0.15.1 / 0.15.6 / 0.16.0）的修法都是**在需要它的那个文件里再抄一份判据**，于是「三处分叉」是必然结果：`superpi-editor.ts` 有、面板没有。**真机现场**（WorkBuddy 会话 `~/.workbuddy/projects/.../73864e66-*.jsonl` 4 次 + pi 会话 37 次，同一模型 `odys-deepseek` / `Deepseek-V4.1-Flash`）：模型把工具调用写成 DSML → pi 当普通文本收尾（`stopReason: stop`）→ agent loop 结束 →**屏幕上一句话说完就停住，没有任何提示**。用户只能自己补一句「继续」——4 次中断后紧跟 4 条 `<user_query>继续</user_query>`，间隔 7.5 / 4.3 / 10 分钟。**量化排除了两条旧猜测**：4 次发生时的窗口占用只有 **26.0% / 26.6% / 27.2% / 23.0%**（远离 1M 上限）；且 WorkBuddy 里 `grep -rl superpi` = **0 命中**（没装本项目扩展），上下文**根本没被裁剪过** —— 再次印证 0.15.4/0.15.6 的结论：与上下文规模、裁剪**无关**。真正的共同点是「一轮里已经连跑 5~42 次工具调用之后，输出只有 21~67 token」。**新增第四类形态 D（残片型）**：网关把**开标记整段吞掉**，只剩 `</parameter>` + `</｜｜DSML｜｜ calls>` 结尾 ——旧判据要求「开闭齐全」（`hasOpen && hasClose`），于是这一类**整条漏掉**（4 条真机样本里 3 条属此类）。**两处判据缺陷**：① 只用全文 `includes('parameter')` 判开标记，而 D 类的 `</parameter>` 本身就含 `parameter` →残片被误归成正文型，D 类永远分不出来；现改为「跳过 `DSML` 后的分隔符，看紧跟的 token」；② 残片必须落在**消息末尾**（`residueTailChars=40`）才算数 —— 本仓库文档里到处在**讨论** DSML，只看「全文出现」会把任何一次解释性回复判成故障，那比漏判更糟。**结构性修法（不是再抄一份）**：判据收进新文件 `extensions/superpi-malformed.mjs`（四类形态 + 五类排除项 + 中英文案，唯一真相源）；editor 改成 `isMalformedToolCall` 转发；**面板按「表在契约、算法在面板」的既成范式**（同 `classifyInput`）从 `GET /contract` 的 `malformed` / `malformedNotice` 取表，`client.js` 实现 `detectMalformedOutput` 并在 `message_end` 记 `view.malformed`、渲染 `superpi-malformed-box` 告警条 + **可点的「继续」按钮**（走 `submit(t('malformedRetry'))`，与手打完全同一条路径，**不开第二条发送通道**）。**门禁**：新增 `test/malformed.mjs` **69 checks**（数据层 模块≡契约 / 行为层A 模块逐条 /行为层B **面板真函数**逐条 / 接线层 10 条 / 安装面顺序与内容），并已进 `npm test`；**门禁自验**两次：复原 `message_end` 不判定 → 立即红（2 条接线失败）；删掉 D 类残片判据 → 立即红（`D 残片型` got `none`）。**真机验收 17 项**：真 host `GET /contract` 真下发（起真 HTTP 服务实测）、4 条真机畸形全部命中（1 条 `text` + 3 条 `residue`）、面板真函数与模块 **4/4 结论一致**、pi **真加载器**装入后 `superpi-editor` 0 错误（证明 `./superpi-malformed.mjs` 解析正常）。安装面 7 → **8 文件**（模块必须排在 editor 之前，否则重演 0.15.3 的 `resetMeterMemo is not a function`）。  |
| 2026-11-21 | 0.17.3 | **验证「DSML 是否已解决」时又挖出两个问题：一个真竞态，一条假门禁。****一、竞态：契约未到时收到的畸形提示会永久丢失。**面板启动原本是两行并行：`loadContract()` 与 `startSession()` 同时发起。而 `contractRef.current` 是畸形判据的**唯一输入** —— `message_end` 一旦早于 `/contract` 到达，判据只能返回 `none`，**而 `message_end` 只处理一次、不会重算**，那一轮的提示就永久消失。真实触发场景：从侧栏切到一个「之前中断过」的会话 —— `attach()` 拉的 snapshot 里带着历史的 `message_end`，它们在一瞬内被回放完而 `/contract` 还在路上；用户看到的是那个会话「好好地」接着跑，完全不知道上一轮什么都没执行。**修法在依赖顺序这一层**（不是在判据里内置一份默认表 —— 那会制造第二个真相源）：契约必须先就位再启动会话，并带 `cancelled` 守卫防止卸载后写状态；契约失败时**不许静默**：记下原因并在界面明说「畸形输出提示不可用」。**二、一条假门禁（自己刚写下就踩到）。**第一版顺序断言写的是 `/\.then\(function \(\) \{[^}]*return startSession\(\)/`，实测**把代码改回「并行发起」后它仍返回 true** —— `[^}]*` 跨过了 `.catch()` 收尾的 `}`，一路匹配到后面任意位置。这是永远为真的空断言：bug 回来时它保持绿色，比没有门禁更糟。改成两条**能区分两种形状的结构判据**：① `startSession()` 不得以语句起始形式出现（行首 + 恰好 8 空格缩进）；② `loadContract()` 之后必须紧跟 `.catch(`。**门禁自验**：改回并行 → 立即红 4 条（含上面两条结构判据）；恢复后全绿。**三、根因范围从三种可能缩到两种（用代码事实，不靠推断）。**新增门禁 `test/dsml-pi-loss.mjs`，四条全部由 pi 源码事实给出：① pi 全库（210 个 .js）**不含 `DSML`** → 不存在针对该标记的分支，谈不上「丢弃」；② 正文通道是**纯追加**（`block.text += choice.delta.content`，附近无 slice/replace/trim）；③ `toolCall` 块**只由 `delta.tool_calls` 创建**（`ensureToolCallBlock` 唯一调用点在该分支内）；④ `stopReason` 由 pi **事后推导**：`content` 里没有 toolCall 块 → `stop`。⇒ 畸形消息里的 DSML 是以 `delta.content`（正文）身份到达 pi 的⇒ **「pi 丢弃 DSML 头部」被排除**，剩余可能只有「provider 流式重组」与「模型自身输出」。门禁自验：把正文通道改成截断式（模拟 pi 丢头部）→ 立即红；恢复后全绿。**四、门禁规模**：`malformed` 69 → **80**（新增 §7 依赖顺序 9 条 + 结构判据），`client-render` 1067 → **1069**。**五、仍未验证的两项**（不冒充通过）：像素级渲染、点「继续」真的能发出 —— 需要把 0.17.3 真正装进正在运行的 DSH 实例并重启后才可能验证；实测当前运行实例仍是 `0.15.3`（`grep -c DSML client.js` = 0，`extensions/superpi-malformed.mjs` 不存在），所以线上根本没有这套代码。 |
| 2026-11-20 | 0.15.6 | **「静默结束」的第二种形态：DSML 落在 thinking 通道，旧判据整条漏掉**。真机原文（`stop=stop`，content **只有一个 thinking 块**，长 1238）：`Let me verify empirically.</thinking>
</｜｜DSML｜｜ calls>` —— provider 在 **thinking 通道**里吐出闭合标记，然后**没有生成任何正文**；用户看到的是「屏幕上多了一段独白，然后会话无声结束」。**旧判据两个缺陷**：① 只遍历 `text` 块，thinking 通道完全不看；② `text === ''` 时直接 `return false`，于是「thinking-only」这种最典型的故障被整条漏过。**修法**：把 thinking 也纳入关键词判据（`marker(text) || marker(thinking)`），并新增**空转判据** —— `stopReason==='stop'` 但**既无正文也无 toolCall** 即判故障（标记可能被 provider 吞掉，不能只靠字符串匹配）。**排除项**：`thinking + 正文` 是正常形态、有 toolCall 正常、有正文正常。**重要事实**：本次故障发生在**全新会话、86 条消息、8.2% 占用**下，与上下文规模和裁剪**完全无关** —— 是模型长链工具调用后的固有偶发输出异常；我们能做的是**让它可见**（明确告知「本轮未执行，重发即可」），而不是假装能修模型。**门禁**：`tui-editor` 474→**481**（新增 5 类真实形态判据）；**门禁自验**：模拟旧判据 → 立即红（`thinking 通道里的 DSML 闭合标记也要识别` got false），恢复后全绿。`npm test` 17 项全绿 EXIT=0。 |
| 2026-11-20 | 0.15.5 | **裁剪顺序按「单位损失换来的空间」重排：thinking 必须最后才牺牲**。刺眼的实测现象：预算很宽松时（594,974，实际只需 592,582）**thinking 仍被删掉 294 条**，而 `toolFold` 只折 6 条就达标了 —— 「先牺牲了最不该牺牲的东西，然后马上就够了」。**量化依据**（真实会话单条消息估算 token）：单条 thinking ≈ **206**、单条 toolResult ≈ **2,000**（**9.7 倍**）；折一条 toolResult 换来的空间相当于删掉近 10 条 thinking，而 toolResult 折叠后**仍保留首行摘要**（"当时跑了什么、结果是什么"的线索），thinking 删掉则是**彻底消失**。**新顺序**（信息可恢复性从高到低）：`images` → `toolText` → `toolFold` → `toolCallArgs` → `replies` → **`thinking`（最后）**。**效果**：`targetRatio=0.72` 时 thinking 删除量 **294 → 0**（代价：toolFold 6→36）；`0.62` 时 **294 → 0**（toolFold 6→90）—— **thinking 完全保住**，纯质量提升。**顺带证明 0.15.1 的「77.8% 退化线」不存在**：占用 **74.2%~86.2%** 区间内 **369 次成功、0 次 DSML**，而 DSML 全部钉在 77.4~77.9% 的极窄区间 —— 若真是占用导致退化，86.2% 应比 77.8% 更容易出错，事实相反。**新门禁 C10**（`context-guard` 172→**179**）：工具结果够折时 thinking 必须为 0（改前删 594 条）、单条 toolResult token 必须 > thinking 3 倍（顺序依据的前提，口径变了会先红）、只有 thinking 可删时它仍须能被删（防线不被架空）；**门禁自验**：复原旧顺序 → C10 立即红（实测删 594 条），恢复后全绿。`targetRatio` **保持 0.62 不动**（证据不足以支持更激进值；它只影响折多少工具结果，不影响 thinking）。**真机 4 轮：assistant 4 / 错误 0 / DSML 0**。`npm test` 17 项全绿 EXIT=0。 |
| 2026-11-20 | 0.15.4 | **推翻 0.15.1 的错误归因：DSML 真因是「裁剪把上下文掏空」，不是 77.8% 占用**（用户截图 `~46.0%/1.0M` 仍出 DSML —— 46% 远低于旧认定的退化线，故「占用高导致退化」不成立；那 33 次全落 77.4~77.9% 只是**相关**：该会话每次都被裁到 77.8% 附近）。**构造数据复现断崖**（窗口 1M、预算 490117）：n=200→**90.2%**、n=250→**6.6%**（droppedTurns=0）、n=300→**7.4%** —— **明明有 93% 预算没用却把上下文掏空**，模型失去任务上下文 → 吐 DSML。**两处结构性缺陷**：①**五阶段折叠「一刀切」**：旧 `apply()` 对保护区之前全部消息执行某阶段才看是否达标，「只超一点」也会删光 thinking、折光工具结果 → 改为按 **24 条一批、从旧到新**推进、每批估算、达标即停（从旧到新保证前缀只后退，prompt cache 不击穿）；②**保护区 token 基准与预算不同源**：旧 `windowTokens×protectedTokenRatio`（窗口 30%）vs 预算 `窗口×targetRatio−开销`（46.7%），分母不同 → 保护区吃掉预算 **64%**，一触发兜底就只能丢到保护区边界 → `protectionStartIndex` 增 `budget` 参数，同源。**顺带架构性区分两类阶段**（混在一起会双向出错，实测都抓到）：**无条件规则类**（images / toolCallArgs）必须跑完 —— 判据是「留着有独立价值损害」而非「token 够不够」（图片最贵且本轮会无限堆积；write/edit 正文已落盘，留副本零价值），被「达标就停」害到 48 张图只裁到 25 张、参数只降 52.5%；**预算救急类**（thinking / toolText / toolFold / replies）达标即停，被「一刀切」害到塌到 6.6%。**新门禁 C9**（`context-guard` 150→**172**）：触发裁剪后利用率 >=80%、相邻规模跌幅 <20 个百分点、渐进折叠足够时 `droppedTurns` 必须为 0；**门禁自验**：CHUNK 改回 1e9 复原一刀切 → C9 立即红（6.7%、跌幅 85.8），恢复后全绿。**验证**：220→99.2% / 240→99.9% / 250→98.1% / 300→99.7% / 400→98.1% / 600→99.7%；真机 5 轮 assistant 5 / system 3 / 错误 0 / **DSML 0**。`npm test` 17 项全绿 EXIT=0。 |
| 2026-11-20 | 0.15.3 | **`400 invalid JSON request body` 的真正根因：文档里混入 U+0007 控制字符**（与体积/网络/上下文超限全部无关）。`AGENTS.md`@39374 与 `README.md`@29813 各有一个 **U+0007（BEL）** —— pi 把 AGENTS.md 拼进 `project_context` section 再序列化进 HTTP 体，JSON 规范禁止未转义的 `U+0000`~`U+001F`，provider 解析直接失败。来源是笔误：想写示例路径 `D:<文件名>.png`，被当成转义 `\a` 解析成 BEL。**关键事实：逐版扫描确认 `fb0a558`(11:33) / `7f4ceb1` / `0e56786` / `cae25ab` / `7d85617`(12:58) 的 AGENTS.md 都含这 1 个 U+0007** → **回滚到 13:06 之前无法解决 400**（会把根因一起带回来），故未执行回滚。**第二个 bug**：`/reload` 后报 `resetMeterMemo is not a function` —— 根因不是代码，是 `EXTENSION_FILES` 里 `context-guard.ts`（依赖方）排在 `context-guard.mjs`（被依赖模块）**前面**，装到一半时磁盘是「新 .ts + 旧 .mjs」，扩展加载即抛错、守卫静默失效 → 七个条目重排为「模块先于扩展」。**新门禁 2 条**（`host-parity` 412→**430**）：3.97 每个 `.ts` 的 `.mjs` 依赖必须排在前面且清单满 7 项；3.98 AGENTS.md / README / 两份 docs 必须合法 UTF-8、无控制字符、无 U+FFFD、无孤立代理项 —— **该门禁一上线就抓到 README 的第二处 U+0007**，证明有效。**真机验证**：spawn 真实 `pi --mode rpc` 5 轮，assistant 5 / system 3 / **错误 0**，400 已消失。`npm test` 17 项全绿 EXIT=0。 |
| 2026-11-19 | 0.15.2 | **`400 invalid JSON request body` 的真因：扩展每轮往会话历史里追加 system 消息**（用户截图报错；与 0.15.1 的 DSML 是两回事）。**真机复现**：启动真实 `pi --mode rpc` 跑多轮并统计 `message_end` 的 system —— 改前 **5 轮 10 条（每轮 2 条）**，改后 **5 轮 3 条（每轮 0.6 条）**、零错误。**机制**（读 pi 源码确认）：`agent-session.js:1392` 用 `diffSystemPromptSections(getCurrentSystemMessage(messages)?.sections, buildSystemPromptSections(options))` 决定是否追加一条 `{role:"system", content:"", sections}` —— 这是好的增量协议（缓存因此满血：实测 cacheRead 813k / cacheWrite ~200），但「每轮都变的内容」必然「每轮一条 system」，请求体持续膨胀；真机触发点：历史累积 9 条 system、其中一条 45KB。**三个叠加原因全部是我 0.15.0/0.15.1 引入的**：① **「当前目标」每轮必变**（`回复 ok1→ok2→ok3`）且**零收益**（模型刚读完用户消息，不需要系统提示复述）→ 直接移除，目标改由面板/Working 行呈现；② **精确百分比每轮都变**（53.4→54.4→55.3）→ 量化到 5% 档、构成 10% 档、**不报绝对 token 数**、原始折叠量 25% 档；③ **`sections[METER_SECTION_NAME]===block` 短路永不命中** —— `runner.js:1130` 每轮用 `normalizeBuildSystemPromptOptions` **重建** options，拿到的 sections 不含上一轮扩展临时塞的 key → 新增模块级 `lastMeterText` 与历史对账 + `resetMeterMemo()` 供会话切换。**试过但否决**：`forceSystemPrompt` 确实不写历史，但它要每轮整份重放提示、直接击穿上面那个缓存，成本上升一个量级（C 类反模式）。**新门禁 C8**：同档内文本逐字节一致、连续 20 轮文本变化 ≤10 次、系统提示不得含「当前目标」、换目标同档文本必须相同、同内容二次调用必须返回 `null`。**RPC 矩阵一行未改**。门禁：`context-guard` 157→**168**。`npm test` 17 项全绿 EXIT=0。 |
| 2026-11-19 | 0.15.1 | **「还是会中断」的真因：模型在 77.8% 处退化成 DSML 原生格式**（用户截图显示屏幕上有 `<｜｜DSML｜｜ parameter>` 被当文本输出）。**与 0.15.0 修的网络超时完全不同**：`grep -rln DSML node_modules/@earendil-works` 为空（pi 根本不认识这种格式），会话里 34 次 assistant 消息含 DSML 且 `stopReason` 全是 `stop` —— 模型把工具调用写成 DeepSeek 原生语法而非 pi 要求的 JSON，pi 当普通回复收尾 → agent loop 结束 → **用户看到「中断」且无任何错误提示**。**量化（n=1993 次调用）**：0%~68% 共 1574 次 DSML **0.0%**；74%~76% 共 40 次 0.0%；**76%~78% 共 264 次 12.9%（34 次全部落在 77.8~77.9%）**；78%+ 共 98 次 0.0%（守卫已裁回）。DSML 组平均 `totalTokens` 815071（77.7%）、含 thinking 比例 **0%**（正常组 372622 / 35.5% / 16%）→ **这是远早于 1M 上限的能力退化**。**上一轮为什么没挡住**：0.15.0 把 `targetRatio` 定在 0.72 是从「别撞上限」推出来的 —— **只防崩溃、不防退化**，实测发送 71.5% 加估算误差就滑进 76%+ 退化区（D 类反模式）。**修法**：①治因 `targetRatio` 0.72 → **0.62**（退化线 ~74%，留 14 个百分点），并修正语义为「**最终总占用**（含固定开销）的上限」而非「messages 占窗口」，顺带修掉 floor(30%) 可能突破 targetRatio 的隐患；实测该会话发送量 **71.5% → 61.8%**。②治症 新增 `message_end` 上的 DSML 识别：以前静默结束，现在明确写「本轮未执行：模型输出格式错乱（DSML），工具调用没被识别 · 直接重发即可」；**只提示不修复** —— 把 DSML 还原成工具调用要猜参数边界，猜错就执行错误命令，在编码 agent 里比中止危险得多；判据保守（role=assistant ∧ stopReason≠toolUse ∧ 开闭标记齐全），否则「正文里讨论这个 bug」会被误判。③新增门禁 **C7**：`targetRatio` 必须 ≤ 实测退化线 − 10 个百分点、**实际发送量**（messages + 开销）也必须落在退化线以下、四种窗口尺寸下预算不超 `targetRatio` —— 把「只防崩溃不防退化」变成机器红。**RPC 矩阵一行未改**。门禁：`context-guard` 150→**157**、`tui-editor` 461→**474**。`npm test` 17 项全绿 EXIT=0。 |
| 2026-11-20 | 0.16.1 | **对抗性审查后的架构级修复（2 个 P0 + 1 个 P1 全部落在门禁盲区）**。①**F-02 事件水位与回放序颠倒**：`attach()` 先把 `lastSeq` 抬到 `snapshot.eventSeq` 再 `applyBatch`，缓冲事件 100% 被去重判据丢掉（探针实测 3 条应用 0 条）。正文被 `hydrate()` 兜住所以没暴露，但**运行态与弹窗兜不住**。修法不是改那两行的顺序，而是把装配收进 `hydrateFromSnapshot()`：顺序写死一次，调用方没有顺序可写错（`attach` / `resync` 共用）。②**F-03 `snapshot.pendingUi` 零消费**（见 D-05 的纠错）：补 `hydrateFromSnapshot` 第 ④ 步，走与实时事件同一条路径。③**F-01 会话池以「创建」为界而非「存活」**：`exit` 只记日志永不摘除，8 个死会话后新建 **429**；改为 exit 即摘池（带「池里那个还是我」的幂等判据），并把死因末 3 行 stderr 打进日志以保留现场；客户端收到 exit 后主动 `api.close` 并进 `ended` 态（新增显式分支 + 中英文案，不再渲染「看起来正常但什么都不能做」的面板）。④**F-05/F-06 门禁把「无法验证」当成「验证通过」**：新增 `test/preflight.mjs` 作为依赖的唯一判据，6 处 `SKIP + exit 0` 全部改为失败（实测隐藏 `.runtime/` 后 `tui-editor` 521 条整段跳过仍为绿）。⑤**F-07 文档 check 数漂移**：新增 `test/gate-inventory.json` + `gate-inventory.mjs`，数字收成唯一真源、判据为「实测 ≥ 登记」，本文改为引用而非复制。门禁：新增 `session-lifecycle`（19 checks）、`preflight`、`gate-inventory`；`client-render` 补事件摄入层 §12/§13（含一条**反证**：故意用旧顺序必须红）；`timeout` 起回报规模（31）。`npm test` 从 18 项增到 20 项。 |
| 2026-11-19 | 0.15.0 | **会话中断治理 + 进度心跳 + 每轮上下文仪表**（用户报「正在运行的会话总是中断」，并明确要求「隔一段时间反馈进度，别让用户觉得卡着」）。①**先穷举归因再动手**：17 次中断逐条分类 —— `ECONNRESET` 6 / `BODY_TIMEOUT` 4 / `CONNECT_TIMEOUT` 3 / `CONTEXT_OVERFLOW` 2 / `RATE_LIMIT` 1 / **`timeout 900` 与 bash 上限 = 0**。用户怀疑的 `timeout` 是**命令级**限制（`bash.js:101-140` 超时 kill 进程树后 throw `ShellTimeoutError`，被工具层捕获成 `isError` 的工具结果，agent 继续下一轮），**不可能中断会话**；`stopReason` 统计（`toolUse` 1903 / `stop` 69 / `error` 17）里没有一次来自工具超时。详见 `docs/session-interruption.md`。②**BODY_TIMEOUT 根治**：pi 默认 `httpIdleTimeoutMs = 300_000`，而实测 4 次的静默时长是 317/323/331/503s —— 刚过线，且**与上下文规模无关**（最浅一次仅 7.3%）；根因是长思考期间零字节流出。新增 `src/http-idle-guard.mjs`：spawn 前把该值抬到 **30 分钟**，边界严格 —— 只补「未设置」的、显式配置一律尊重（哪怕小于下限）、显式关闭一律保留、坏 JSON 绝不覆盖、幂等不重复写盘（`test/host-parity.mjs` 23 条覆盖全分支）。③**守卫系统性低估 157,128 tokens（15 个百分点）**：它只估 messages，不含系统提示 + 工具定义，于是「守卫算 62.6% 安全」对应「实际 77.6%」，再走几轮撞 1,048,576 硬墙 —— 历史 2 次 `CONTEXT_OVERFLOW` 正是这么来的。新增 `reservedOverheadTokens`（默认 160k）：预算 = 窗口×targetRatio − 开销；边界是**小窗口不扣**（否则预算失真）、扣完不低于窗口 40%。实测预测精度从偏差 15 个百分点降到 **1.47**。④**兜底 `dropOldestTurns` 从来没有生效过**（`droppedTurns` 恒 0），三个叠加缺陷每个都静默：索引失效（缓存绝对下标，slice 后失效）、空切片死锁（`slice(start,cut)` 恒空 → break）、**丢任务目标**（`slice(1,cut)` 把首条 user 也包进被丢区间，实测 `dropped:9` 后剩余从「轮9」开始）。重写为「前缀（system + 首条 user）/ 可丢区 / 保护区」三段、每轮重算边界、一次丢一条完整轮次；真实会话实测 **589066 ≤ 594974、dropped:3、任务目标保留**。⑤**进度心跳**：先查清能力边界 —— bash 每 100ms 发一次 `tool_execution_update`（`bash.js:15`），所以**有输出时本来就有实时内容**；用户觉得卡住的是**长时间零输出**。故判据是「距上次输出多久」：静默 ≥20s（`HEARTBEAT_AFTER_MS`）显示「已静默 3m 20s，仍在运行」，**不编造百分比**；两端同值同文案；`ActiveTool` 加 `lastOutputAt` 并**按 toolCallId 精确匹配**（否则并行调用时 B 的输出会不断重置 A 的静默计时）。⑥**每轮上下文仪表**：`before_agent_start` 的 event **不带 messages**（`types.d.ts:738-760`），所以由 `context` 事件算好存快照、`before_agent_start` 取用。注入「当前目标 + 实际发送 X%」；≥50% 加按类拆解并**指明最贵的一类**；≥85% 额外警告。**双数字**是关键修正：第一版只报裁剪前 96% 而实际 69.5%，等于造假警报（D1 类失真），现在同时报「实际发送」与「原始内容 + 守卫已折叠多少」。⑦**顺带消除结构问题**：`test/selfcheck.mjs` 与 `test/version.mjs` 各硬编码一份复制清单、实测已漂移（16 vs 15 项），新增 `src/runtime-files.mjs` 按目录自动发现，并加断言锁住「不许退回硬编码」。⑧新增 `docs/anti-product-patterns.md`：把用户「中断 / 能力降级 / 委屈求全 / 降质量 / 降指标都不符合产品方向」展开成 6 类 31 条可判定清单，每条带真实事故对照。**RPC 矩阵 / 事件表 / 斜杠表一行未改**（33 / 25 / 27 / 9 不变）。门禁：`context-guard` 100→150、`host-parity` 377→412、`tui-editor` 442→459、`client-render` 1005→1013。`npm test` 17 项全绿 EXIT=0。 |
| 2026-11-18 | 0.14.2 | **状态图标放大 + 动效流畅 + 根治「发送消息后动效静止」**（用户三条反馈）。①**更大**：旧帧 `◐◓◑◒` 实测 `visibleWidth=1`，换成**月相 8 帧** `🌑🌒🌓🌔🌕🌖🌗🌘` —— 全部 `visibleWidth=2`（终端里没有字号可调，换双宽字符是唯一可靠的"变大"手段），且都不含 VS16（含它的 emoji 在不同终端宽度会跳变、把框线挤歪）。②**更流畅**：4 帧 → 8 帧，帧间隔 250ms → **120ms**（8×120ms ≈ 1 秒转一圈），月相盈亏天生闭环（`🌘→🌑` 无缝），不像四分圆那样有明显接缝。③**根治静止**（真缺陷，不是调参）：`statusIcon()` 是按时间取帧的纯函数，但**取帧只在有人重绘时发生**，而 pi-tui 的 `requestRender()` 是**被动**的（`tui.js:658-669` 只置标志等下次 `scheduleRender`）—— 模型跑一条 5 分钟 bash 期间既无输入也无 token → 不重绘 → **图标永远停在最后一帧**。新增**自驱动动画定时器**（`startAnimation` / `stopAnimation` / `isAnimating` / `bindFrameTarget`）：`running` 时每 120ms 敲一次 `tui.requestRender()`（pi 自身 16ms 节流会合并），`markRunStart` 自动开、`markRunSettled` / `resetRunState` / `dispose` 自动停，**幂等**（重复 start 不叠加定时器，否则每轮泄漏一个），渲染通道抛错时自停不留悬空定时器。取帧改用「距 `startedAt` 的时长」而非绝对时间，保证每轮都从第 0 帧起转、不随机跳格。面板端（`client.js`）同步：图标 14px → **18px**、`superpi-pulse`（呼吸）→ **`superpi-spin` 旋转**且 `infinite`；面板的 CSS 动画由浏览器合成线程驱动、与 SSE 无关，所以本来就不会静止 —— TUI 端的被动重绘才是病根。门禁 `test/tui-editor.mjs` 399 → **442**：八帧互不相同 / 帧序 / 双宽（逐帧量 `visibleWidth`）/ 无 VS16、一个周期内八帧按序且循环回起点、`sampleFrames` 采样（修掉一个真 bug：它原本没对齐 `startedAt`，采出来是 `◴◴◴◴`）、定时器生命周期（idle 不开 / 幂等 / 重复停不抛 / 无目标启动失败 / 渲染抛错自停）、**真实时间里敲了 ≥2 次渲染通道**、状态变迁自动开关、编辑器构造即绑定、**六种宽度（120/80/60/40/30/20）下每行 `visibleWidth` 恒等于目标宽度**（双宽图标最容易把上边框算歪 1 列）。`client-render` 1004 → **1005**（18px + 旋转 + `infinite` 三条）。`npm test` 17 项全绿 EXIT=0。 |
| 2026-11-18 | 0.14.1 | **补齐 TUI 端的等待可见性 —— 0.14.0 只做了面板端，违反 §3 两端对齐**。用户复报「总卡在 Elapsed 6m 0s / Working · 2287s」。查真实会话：**没有卡死** —— 那一轮 25 次工具执行累计 **2028 秒（33.8 分钟）**，其中 `timeout=960` 的 `node test/mutation.test.mjs` 单次跑 371~494 秒，是合法的长任务。病在**可解释性**：TUI 的 Working 行只显示一个一直涨的秒数，用户无法区分「在跑」与「卡死」。①`extensions/superpi-editor.ts` 新增订阅 `tool_execution_start`（**唯一带 `args` 的事件**，`args.timeout` 即命令自设上限），状态机加 `activeTool: { name, startedAt, limitSeconds }`；`workingLabel()` 输出三段 `Working · 38m 7s · bash · 上限 16m`，超限时改口「已超出上限 N」。②`formatRunDuration()` 口径与 pi 自己的 `formatToolDuration`（`dist/core/tools/render-utils.js:97-106`）**逐字一致**（`4.2s` / `5m 41s` / `1h 2m 0s`；分界是 60s 不是 10s）—— 否则同一条命令 pi 写 `Elapsed 5m 41s`、Working 写另一种格式，用户会以为是两个计时。③窄终端三档退让：完整三段 → 去掉工具段（保留累计）→ 只剩图标，每行显示宽度恒定不让框线歪。④`markToolEnd()` **只清工具不改 phase**：否则工具结束到下一轮开始之间 Working 行会消失又出现（闪烁）。两端取同一个字段 `args.timeout`，字段名一致（面板端 `view.activeTool.limitSeconds` ↔ TUI 端 `runState.tool.limitSeconds`）。门禁 `test/tui-editor.mjs` 348 → **399**：事件注册数 6 → 7 并新增「必须订阅 tool_execution_start」防删断言、`toolLimitSeconds` 九条边界（含 `Infinity` / 字符串 / null 不崩）、`formatRunDuration` 八档、`workingLabel` 三段与超限互斥、真入口事件驱动 activeTool、**走真 `render()` 从渲染结果里读上边框确实画出了工具段**（纯函数通过 ≠ 画出来了，0.9.4~0.9.7 就栽在这条缝上）、窄宽度框线等宽。`npm test` 17 项全绿 EXIT=0。**RPC 矩阵 / 事件表 / 斜杠表一行未改**（33 / 25 / 27 / 9 不变）。 |
| 2026-11-18 | 0.14.0 | **性能与卡顿根治（三个独立病根，各自有机器判据）**。①**卡好几分钟**：实测 1640 次工具执行中 71 次 >60s（累计 198 分钟）、9 次 >300s，全是模型自己给 bash 传了 `timeout=1200/1800/6000` —— 这类等待是**合法的**（跑全量测试），不能砍，但必须可见：Working 行新增「工具名 · 已跑时长 · 命令自带上限」，超限时显式说「已超出上限」而不是静默加秒数。②**面板冻结**：`get_messages` 一次吐 55.1 MB / 3251 条 / 116 张 base64 图（图片占 88.2%），而 `LineSplitter.push` 每 chunk 都 `Buffer.concat` 全量 + 从下标 0 重扫（O(n²)），55MB 单帧实测 **11,494 ms 同步阻塞事件循环**。三处一起治：host 改分页端点 `GET /messages`（默认 200 条 + `image-stub`，实测 **55.1MB → 224KB / 0.3ms**，真实像素走 `GET /images/:id` 按需取）；切帧器改 pending 分块列表（每字节只扫一次、只在凑齐一帧时 concat 一次，**11,494ms → 92ms，125×**，七种分块大小输出逐字节一致）；client 渲染窗口化（只渲染尾部 120 条 + 「加载更早」）。③**上下文守卫裁不动**：五阶段没人管 `toolCall.arguments`（裁剪后仍余 1,377,032 字符 ≈ 459k tokens，全是已落盘的 write/edit 正文），且「本轮图片一律保留」让视觉任务同一轮产的 48 张图（576k tokens，占预算 80%）永久免疫 —— 于是裁到最狠仍超 71%、`overBudget` 恒为 true 失去区分度。三处一起治：本轮图片改「最近 N 张」限额（默认 4，缺省可配，占位带路径可重读）；新增第 6 阶段 `toolCallArgs` 折叠 write/edit 大参数（**482,090 → 54,670 字符**）；新增兜底：五阶段跑完仍超就按整轮丢最旧轮次，`overBudget` 重获区分度。**真会话实测：2,832,667 → 715,362 tokens 进入预算，overBudget 由恒真转 false，且消息一条未删、无需兜底。** 判据全部进 `npm test`：`context-guard` 74 → **100**、`host-parity` 291 → **377**、`client-render` 972 → **1004**、`parity` 96 → **98**（另修掉两条依赖 LF 的脆弱断言，仓库是 CRLF）。验收文档见 `docs/performance-acceptance.md`（含「不允许出现的假达标」七条反模式）。**RPC 命令矩阵、事件表、TUI 斜杠表一行未改**（33 / 25 / 27 / 9 不变）；`get_messages` 归入 `HOST_PROXIED_COMMANDS` 白名单并断言 host 真的代发。 |
| 2026-11-18 | 0.10.0 | **新增第四层对齐：用户自定义规则（最高优先级）** —— 前五节都是「pi 有、另一端没有」，这一条是**两端都没有**的新能力，所以它在 pi 的官方扩展点（`before_agent_start` + `registerCommand`）上实现，**不写 `SYSTEM.md` / `APPEND_SYSTEM.md`、不把规则当消息发**（三者都会让系统退化）。规则写进 `systemPromptOptions.sections.user_defined_rules`（pi 排在 `cwd` 之后 = 提示末尾），块首显式声明覆盖上文与项目说明；空规则返回 `undefined`（零痕迹）。面板走 host `/rules` 三条路由（浏览器无 fs；设置页也不该依赖子进程活着），命令行走 `/superpi-rules` 与每轮 `before_agent_start`，两端共用 `extensions/superpi-rules.mjs` 这一份模型与同一个 `<home>/.superpi/rules.json`。门槛：新增 `test/rules.mjs` 193 checks（含真 `.ts` 扩展层），`host-parity` +34、`client-render` +95、`parity` +18、`tui-editor` +17；`npm test` 13 → **14 项**。设计与 `E2E-01`~`E2E-14` 验收清单见 `docs/rules.md`。 |
| 2026-11-13 | 0.3.0 | **缺口清零。** RPC 33 条 = 已实现 32 + 部分 1（`steer` 走 `prompt`+`streamingBehavior:'steer'`）+ 缺口 0；扩展 UI 9 请求 3 应答全部已实现（含 5 分钟兜底超时 `DIALOG_FALLBACK_MS`）；事件 25 种 = 已实现 22 + 显式忽略 3 + 缺口 0；TUI 27 条 = 已实现 17 + 仅命令行 9 + `unsupported` 1 + 缺口 0。`D-01`/`D-02`/`D-04`/`D-05`/`D-06` 闭环；新增 `D-07`/`D-08`（均为上游协议面限制，面板侧无解）。门禁落地：`test/parity.mjs` + `test/host-parity.mjs` 进 `npm test`。（行号为 0.3.0 落地当时的坐标，非当前坐标） |
| 2026-11-13 | 0.3.0 收尾 | **`D-03` 闭环**：顶栏拆成「新会话」（`runNewSession` → `new_session`，与 `/new` 同路径）与「重连」（`endSession`，换子进程）；同一件事不再有两个入口两种结果。**修掉两处在 0.2.5 真实存在的时序缺陷**：① 装了扩展 / 改了 prompt 模板后斜杠菜单不刷新（现于 `agent_settled` 重拉 `get_commands`，未知斜杠先重拉再判定）；② 扩展弹窗等着人点时命令先超时（`timeoutLimitMs` 三态 + `armTimer` 让位 + `respond` 后重开窗口 + 面板 `CHAT_TIMEOUT_MS = 0`）。门禁加强：新增 `test/timeout.mjs`（28 checks，用 `test/fixtures/fake-pi-rpc.mjs` 协议替身把 5 分钟等待压到毫秒级）、`test/host-parity.mjs` 125 checks（+10）、`test/parity.mjs` 65 checks（+16，新增 §6 会话入口与超时语义）。`npm test` 从 7 项变 8 项，耗时 ~1.3 s → ~5.2 s。（行号为 0.3.0 落地当时的坐标，非当前坐标） |
| 2026-11-13 | 0.3.0 实测 | **扩展 UI 四类弹窗全部端到端取证**（独立实例 5599 + CDP）：select 选项点击回 `value`、confirm 回 `confirmed`、input 透传 `placeholder` 并回 `value`、editor 的 `prefill` 正确回填多行并回改后的 `value`、点「取消」走 `cancelled` —— 9 请求 + 3 应答分支无一纸面声明。**修掉两处文案缺陷**：① 倒计时原来渲染成「扩展请求超时，已自动取消 298s」（读起来像已完成态），现为「还剩 {n}s 后自动取消」/「Auto-cancels in {n}s」，与 pi 侧 `extension-selector.ts:56-63` 的 `Title (Ns)` 剩余秒语义对齐；② confirm 的否定按钮原来借用开关态文案 `off`（中「关」/英 off），现独立成 `extNo`（「否」/`No`），与 pi TUI `interactive-mode.ts:2896-2906` 复用 `["Yes","No"]` 对齐。`t('on')`/`t('off')` 仍归设置抽屉的开关使用。门禁：`test/client-render.mjs` 补第 9 组（38 个断言点 / 展开循环后 43 次执行；四种 method 的按钮集 / prefill 回填 / `dialogBudgetMs` 四类非法值回落 / `extNo ≠ off` / SSR 不渲染倒计时这条硬约束），`npm test` 全绿（行号为 0.3.0 落地当时的坐标，非当前坐标） |
| 2026-11-13 | 0.3.2 | **升版号原因 = 安装器门禁**：`tools/install-plugin.ps1` 的逐字节比对在版本号不变时必然失败 —— pnpm 对 `file:` 依赖按 lock 里的 integrity 复用 store，把旧内容装回来且 exit=0（README:49 早有记录）。第一次原地改代码仍报 `STALE client.js`，第二次改完 README（断言口径 71→335）后复跑又报 `STALE README.md` —— **只要 `files` 里任一 shipped 文件（含文档）有变化就必须升版号**，0.3.1 因此未发布、直接并为 0.3.2。基线、缺陷表标题、`CONTRACT_VERSION`、README 的 tarball 名同步。**同时修掉安装器自身的退出路径缺陷**：`$stage` 只在最后一行 `Remove-Item`，比对失败走 `Fail`（`exit 1` 不触发 `finally`、也跳过末尾清理）时会把 `%TEMP%\superpi-stage-*` 整棵留下 —— 0.3.0/0.3.1 两次失败各留了约 1.7 万文件。现改为 `$script:stageDir` + `Remove-StageDir` 统一收口：`Fail` 清理后退出、`trap { Remove-StageDir; break }` 兜异常与 Ctrl-C、正常路径末尾再调一次；真机验证 `stage_before=0 → 安装成功 → stage_after=0`，另用真实代码块抽取法验证 `Fail` 路径 `leftover=False`。（行号为 0.3.2 落地当时的坐标，非当前坐标） |
| 2026-11-13 | 0.4.0 | **面板交互与命令行 pi 工作区语义对齐**：①会话/空态里的入口统一叫「选择工作区」（`pickDir`/`dirTitle`，ZH/EN 同改；`dirHere` 采纳按钮 = 「用这个工作区」）；②选择工作区从铺满面板的抽屉改成 680x500 居中模态（`client.js:2115` `.superpi-dialog-wrap` + `.superpi-dir-dialog`，`role=dialog`/`aria-modal`），理由 = 它是打断当前会话的决策；③新增「此电脑」盘符层（`GET /directories` 下发 `roots`，`client.js` rootsView），修掉「从工作区往上只能走到当前盘根、别的盘永远进不去」的缺口，并修掉盘符被通用循环重复渲染两遍的缺陷；④过程行（工具调用/工具结果/`!` bash）去掉圆角卡片外壳，改平铺行 + 展开区左侧竖线，与 `.superpi-think` 同一套语言（一次任务十几条工具卡会形成框套框噪音墙）。门禁：`client-render` 450 断言（新增模态 5 条 + 文案 4 条 + 过程行 9.11b 段）、`css-tokens` 90、`host-parity` 162（新增 roots 10 条）、`parity` 65，`npm test` EXIT=0。（行号为 0.4.0 落地当时的坐标，非当前坐标） |
| 2026-11-13 | 0.4.1 | **`D-09` 闭环（面板侧缺陷，非上游）**：点历史会话后对话区空白。根因 = `switch_session` / `new_session` / `fork` / `clone` 成功后 host 调 `proc.resetEvents()`（`index.js:856`，命令集 `SESSION_REPLACING_COMMANDS` `index.js:74`）把事件缓冲清成 0 条，而面板的 `reload` 只重放 `snapshot`（此时 eventSeq=0、events=[]），从不去拉 `get_messages` —— 切过去必然空白。实测证据：切会话后 `GET /sessions/:id/snapshot?since=0` 返回 `{eventSeq:0, events:[]}`，而 `POST /command {type:'get_messages'}` 同会话返回 178 条消息（377 KB）。修法 = `attach` 末尾接 `hydrate(id)`：非 busy 时以 `get_messages` 整表覆盖 `view.messages`；会话已切走则丢弃响应；busy 时挂 `hydratePendingRef`，`agent_settled` 后由 `drainHydrate()` 补一次。`messagesFromHistory()` 是纯函数（跳过 `system`，seq 用数组下标且**刻意不改 `view.lastSeq`**，避免与 host 事件序号混用导致 `applyBatch` 去重误判）。门禁：`parity` 77（+12）、`client-render` 464（+14）、`host-parity` 162，`npm test` EXIT=0。（行号为 0.4.1 落地当时的坐标，非当前坐标） |
| 2026-11-13 | 0.4.2 | **修 `tools/restart-dsh.ps1` 重启分支的三处真缺陷**（症状统一是「脚本说重启成功、面板永远起不来」）：① 旧实现 `Start-Process -FilePath $exe` 不带任何参数，而桌面实例宿主命令行有 6 个参数（`--expose-internals`、desktop-host 的 `index.js`、app.asar 里的 `dsh`、profile 目录、`primary-runtime`、`pnpm.mjs`、`runtime\bin`），等于换个东西启动 —— 现从实例 pid 沿父链找启动根、把命令行原文交 `ProcessStartInfo.Arguments`（不拆分不重组），取不到就拒绝重启；② 旧实现杀 `/selfcheck` 自报的 `process.pid`（桌面实例里那是 GUI 主进程的子进程），杀了没人重新拉起，现杀启动根；③ 旧实现继承本进程环境（`ELECTRON_RUN_AS_NODE=1` 会把 GUI 当纯 node 起、窗口不出；残留 `DSH_HOME`/`DSH_PROFILE`/`DSH_PORT` 会把实例顶到错误的 home），现按目标实例 `/selfcheck` 的 `root` 反推 `DSH_HOME`（`<home>\profiles\<name>\node_modules\superpi`），`ELECTRON_RUN_AS_NODE` 只在命令行确实跑 `.js` 时设、`DSH_PORT` 一律清，推不出来 `exit 3`。新增 `-Plan`（只打印决定：实例 pid / 启动根 pid / exe / 命令行参数 / 工作目录 / 四个环境变量）与自保护（脚本祖先链里有目标启动根时 `exit 3`，`-Force` 越过）。退出码固化为 0 成功 / 1 挑不出实例 / 2 版本不一致 / 3 拒绝重启。库模式 `$env:SUPERPI_RESTART_LIB=1` 只加载函数，测试不动真实例。门禁新增 `test/restart-lib.mjs`（22 条 node 断言 + `test/fixtures/restart-lib-checks.ps1` 31 条 PS 断言，pwsh 7 与 PowerShell 5.1 双引擎各跑一遍；含文件层 BOM / 无游离 CR / 去注释后无裸 `Start-Process -FilePath $exe`、5 种假 `/health` 响应、bat 门禁），`npm test` 从 8 项变 10 项（耗时 ~5.2 s → ~14.3 s，其中 restart-lib ~9.1 s）。**实证**：探针实例 5599 真跑一次完整重启分支 → kill 启动根、拉起新 pid、`/health` 就绪、`state.version 0.4.2` 与磁盘一致 `exit 0`；桌面实例 5783 从 DSH 工具里跑触发自保护 `exit 3`（宿主未受影响）。（行号为 0.4.2 落地当时的坐标，非当前坐标） |
| 2026-11-13 | 0.5.0 | **修「历史会话只显示一条」——面板 `/resume` 与命令行 pi 的两级选择器对齐**。根因链：`SessionsSheet` 把当前 `meta.cwd` 当唯一过滤条件（旧 `client.js:1780` `api.history(props.cwd, 60)`）→ host `listHistory` 在 `cwd` 为空时回落 `detected.workspace`（旧 `index.js:620-622`）→ `src/session-store.mjs:360-401` `listSessions` 于是只扫 `cwdSessionDirs()` 那一个项目目录。修法四件：①`src/session-store.mjs` 新增 `pathComparisonKey` / `isTemporaryPath`（三条正则与 `session-selector.ts:760-769` 逐字一致）/ `shortenHomePath` / `groupSessionsByProject`（聚合与排序逐条照抄 `cli/session-picker.ts:26-62`）/ `readSessionCwd`（读首 64KB 取 header.cwd），并把 `listSessions` 拆成 `listAllSessions`（全量）+ `listSessions`（clampLimit + slice）；②`index.js` 的 `listHistory({scope,cwd,limit})` 显式区分 `scope=all`（全项目 + `projects` 聚合，**不再回落 workspace**）与 `scope=project`（单项目），`current` 走新增的 `firstRunningSessionFile(running, known)`（旧 `pickCurrentSessionFile` 跨 cwd 一律不认，全项目视角下永远标不上）；③**跨项目切换的 cwd 校正**：`get_state` 不回报 cwd（`rpc-types.ts:96-109`），故 `switch_session` 成功后 host 用 `readSessionCwd(body.sessionPath)` 回填 `proc.sessionCwd`（`src/pi-rpc.mjs` 新增字段 + `setSessionCwd`），`snapshot` 暴露 `sessionCwd`，面板所有「当前工作区」显示点（空态 cwd / 统计抽屉 / 目录抽屉起点）改读 `sessionCwd`，`MissingSessionCwdError` 翻成一条中文提示（pi 的 RPC 面没有 `cwdOverride` 分支，`rpc-mode.ts:624-630` 只转调 `switchSession`）；④`client.js` 抽屉拆成容器 `SessionsSheet`(:1885) + 纯渲染 `SessionsList`(:1791)，项目层 → 会话层两级导航（pi 的 scope 开关进项目即失效，`session-selector.ts:1663`，故用导航代替切换按钮）。新增 `test/session-projects.mjs` 55 checks 兜住聚合规则；`client-render` 补两级渲染断言（478→497）；`host-parity` 166 checks 覆盖新 scope 语义。（行号为 0.5.0 落地当时的坐标，非当前坐标） |
| 2026-11-13 | 0.5.1 | **升版号原因 = 安装器门禁复现**：0.5.0 装进 desktop profile 后我又修了 `index.js` 一处缩进（`switch_session` 的 cwd 回填块由 8 空格改为 10 空格，与相邻块对齐），内容变化触发「installed copy does not match the packed tarball」。`pnpm add --force` 与 `remove`+`add` 两条路都不会刷新 store 里按 integrity 缓存的那份 —— 印证 0.3.2 那条铁律：**shipped 文件一改就必须升版本号**。0.5.1 只含这一处缩进，行为与 0.5.0 完全一致，门禁计数不变（client-render 497 / css-tokens 90 / host-parity 166 / session-projects 55 / parity 77）。（行号为 0.5.1 落地当时的坐标，非当前坐标） |
| 2026-11-14 | 0.6.0 | **助手回复里的文件路径变成可点标签 + Composer 支持任意文件/压缩包**。①文件标签：`client.js` 新增 `isFilePathToken` / `splitFileTokens` / `renderFileChip`，`renderInline(text, prefix, onOpenFile)` 与 `renderMarkdown(text, onOpenFile)` 透传 opener，三种形态都覆盖 —— 段落正文、行内反引号（助手常把路径包在 `` ` `` 里）、围栏里整块只有一条路径（用户截图正是这种）。识别原则「宁可少认，不要误认」：排除 `scheme://` 开头的 URL、裸文件名必须命中 `FILE_BARE_EXT` 白名单、末段必须带扩展名，故 `/model`、`v1.2.3`、`example.com` 不会被误标。点击走 `ctx.sidebarRight.openResource('dsh-resource://file/session/<DSH 会话>/<绝对路径>')`，渲染交给 DSH 内置 `documentpreview`（`textDefinition().patterns = ['dsh-resource://file/[\s\S]+']`、`canOpen` 只认 `scope === 'session'`），插件不自造预览 UI；**地址一律 session 作用域**（`absolute` 无授权会话，会 `workspace-file/unknown-workspace`），**不做「绝对路径压工作区相对」**（pi 的 cwd ≠ DSH 会话 cwd，压了会被 DSH 按自己的根解析而指错）。服务用 `ctx.get('sidebarRight')` 惰性取，**不写进 `exports.inject`**（缺服务会让 entry 永久 pending、卡死 DSH 启动）；取不到或无正在显示的会话时回落面板内 `FileSheet`（文本 / 图片 / 二进制三态）并 notice 说明。②Composer 任意文件：`onPaste` 从只收 `image/*` 放宽到全部 `kind === 'file'`，`pickFiles()` 去掉 `accept` 限制。图片仍走 ImageContent；其它文件按 pi TUI `handleClipboardPaste`（`interactive-mode.ts:3278-3318`）把**绝对路径文本插进输入框**（光标处插入、按两侧字符补空格，与 `:3286-3292` 一致），路径来自 preload 暴露的 `window.__DSH_HOST_PATHS__.pathFor(file)`（`preload-app.cjs:1962`，只在 `dsh-app://app` 存在；浏览器里取不到就明说改用 @ 补全）。RPC 契约 `prompt/steer/follow_up` 的 optional 只有 `images`，**没有任意文件附件字段** —— 伪造图片通道是错语义，故不做 upload。③host：新增 `GET /api/superpi/file?path=`（`readPreviewFile`，文本 512 KiB 截断 + 前 8 KiB 有 NUL 判二进制 + 图片 8 MiB base64，目录 400 `not a file`、ENOENT 404 `no such file`、34 项文本 MIME / 8 项图片 MIME）。④门禁：`client-render` 517→548（新增路径识别正反例 22 条 + 围栏/行内 code 分支 + 地址拼法 + FileSheet 三态），`host-parity` 166→194（`/file` 28 条），`css-tokens` 90，`session-projects` 55，`parity` 77，`npm test` EXIT=0。（行号为 0.6.0 落地当时的坐标，非当前坐标） |
| 2026-11-14 | 0.6.1 | **输入区与关闭入口对齐 + 文件标签可右键定位**。①Composer 底栏拆成 `.superpi-bar-actions`（目录 / 附件 / busy 时的排队与停止）与 `.superpi-bar-right`（提示语 + 发送）：改之前提示语夹在按钮中间、busy 时被多出来的两个按钮挤动位置，文案也不对题（idle 用 `slashHint`，那是菜单导航提示；busy 用 `steerHint`，漏了 Alt+Enter 排队与 Esc 停止）。现两套完整文案 `composerTipIdle` / `composerTipBusy` 按 `busy` 切换，位置固定在发送键左侧；`composerHint` 从「给 pi 说点什么…  / 唤起命令，! 直接跑 bash，Enter 发送，Shift+Enter 换行」精简为「给 pi 说点什么…」—— 五条快捷键全塞进 placeholder 会在一开始输入时消失、窄面板还会被截断。附件按钮从产品 logo `PiIcon` 换成 `PaperclipIcon`（用品牌图标表示附件是语义错位）。②抽屉/弹窗右上角统一 `CloseButton`（`.superpi-btn-icon` + 16px `CloseIcon` + 32×32 命中区）：改之前是纯文本 `'×'`（11px、无 `-icon` 类），且 `Sheet` 带 `type="button"`、`DirSheet` 不带，两处已分叉；`ExtensionDialog` 补 `.superpi-dialog-head`（h3 + 关闭键，语义等于「取消」）。③文件标签右键 → 资源管理器定位：host 新增 `POST /api/superpi/reveal`（`revealInFileManager`，Windows `explorer.exe /select,<文件>`、macOS `open -R`、其它 `xdg-open` 父目录；**只等 `spawn` 不等退出码** —— explorer 把命令转交给已有实例后常以非 0 退出，信它就会把成功报成失败；`deps.revealPath` 可注入供测试）。标签本身同时收敛为「类型图标 + 文件名」（`data-kind` 六类 code/image/archive/sheet/doc/file），不再显示目录尾巴。④门禁：`client-render` 548→587（第 11 组：动作集合 `data-openable`/`data-revealable` 三态、`data-kind` 五例、`superpi-fileref-dir` 必须不出现、`CloseButton`/`Sheet`/`DirSheet`/`ExtensionDialog` 都必须是图标键且不含 `>×<`、`composerHint` 不含 Enter、两条 tip 中英非空且各含关键键位、`revealFile*` 键存在），`host-parity` 194→204（`/reveal` 10 条：200 + 注入实现收到绝对路径 + 缺 path 400 + ENOENT 404 + 相对路径按 workspace 解析），`css-tokens` 90，`session-projects` 55，`parity` 77，`npm test` EXIT=0。（行号为 0.6.1 落地当时的坐标，非当前坐标） |
| 2026-11-14 | 0.6.2 | **输入区（composer）按宿主主对话区重做**。卡面换成 `--dsw-radius-panel` 28px + `--dsw-specific-input-major` + `--dsw-elevation-soft`，聚焦时只覆盖 `--dsw-elevation-stroke-color`；行内左侧「28px 圆形 `+`（`.superpi-add`）+ 模型 picker + 推理档位 picker」，右侧「34px 圆形发送键 `.superpi-send`（`--dsw-alias-button-info-fill` + `ArrowUpIcon`，disabled opacity .4）/ 运行中同位换成 `.superpi-stop`（`StopSquareIcon`）」；`+` 弹 `AddMenu`（「添加 / 指令」两组、图标 + 中文标签 + 英文键名 + 灰色说明），条目只映射面板真实能力，不伪造 pi 没有的 goal/plan/feedback/todo；统计行并入 composer 容器卡下方（`footer`），内容 = 状态 + `get_session_stats` 的「轮 / 步 / tok / 缓存命中% / 上下文%」，只在 `agent_settled` 后刷新；模型 chip 与思考档位从头部移入 composer。`test/client-render.mjs` 587→669 断言（新增 composer 结构、AddMenu 分组、footer 位置、`fmtCount` 千分位），`test/css-tokens.mjs` 90→96。（行号为 0.6.2 落地当时的坐标，非当前坐标） |
| 2026-11-14 | 0.6.3 | **修 0.6.2 落地后实测暴露的两个 composer 缺陷**（宿主截图口径复核时发现，非新功能）。①统计行首次进入面板 / 切到历史会话时是空的 —— `footerStats` 只在 `agent_settled` 后拉一次，而刚 attach 的会话没有 settle 事件，得先发一条消息数字才出现。现 `attach()` 尾部（`openStream` + `flush()` 之后）与 `reload()` 的 then 链尾各补一次 `loadFooterStats(id)`，这两个点是「会话已就绪、事件已回放完」的唯一入口。②统计行混进了 `meta.sessionFile` 的完整路径，把「N 轮 · N 步」挤到换行、视觉重心变成一串路径 —— 宿主的 dock 只有用量数字，路径属于「会话统计」抽屉。删除 `statusRow` 里那行 `sessionFile` span。③`composerHint` 改成宿主口径 `给 pi 说点什么, / 调用指令, @ 文件`（`Say something to pi, / commands, @ files`）—— 0.6.1 的「给 pi 说点什么…」只剩一句话，用户看不出这里能敲斜杠和 @。`test/client-render.mjs` 669 断言不变（composerHint 不含 `Enter` 的既有两个断言仍绿），`test/css-tokens.mjs` 96 不变。另：`docs/dsh-ui-spec.md` 的代码基线刷新到 `client.js` 5170 行 / 283968 B / sha256 前 12 位 `b0cc688879a9`。（行号为 0.6.3 落地当时的坐标，非当前坐标） |
| 2026-11-14 | 0.6.4 | **过程流按 DSH 会话过程流重做**（用户直指「DSH 侧边栏的过程行长得跟宿主不一样」，目标截图逐像素实测 1467×802 / dpr≈2：父行图标 16px 框 + 13px 标签 + 2×2 圆点 + 单行省略摘要，行高 24px；子行左 1px 竖线在父行图标框左缘、箭头 + 标签 + 圆点 + 内容整路径点线下划线）。①**层级同构**：模型的「思考」= 父行（`details.superpi-proc` + `summary.superpi-proc-head`，展开区 `div.superpi-proc-body` 只取首行作摘要、全文在展开区）；紧随其后的工具调用 = 子行组（`div.superpi-sub` 左竖线 `border-left:1px solid var(--dsw-alias-border-l3)` + `margin-left:22px`/`padding-left:8px`）；纯文本 / 图片把过程流切段，文本之后的调用重新起一组。②**一次调用 = 一行**：工具结果不再单独占一行 —— pi 把结果作为独立 `toolResult` 消息送达，面板在 PiPanel 里按 `toolCallId` 建 `results` 派生表（`{text,isError}`）传进 MessageRow，命中就折叠、未命中的孤儿结果仍按行渲染（不吞内容），输出收在同一行的展开区 `── output ──`。③**行内词汇取自 DSH 官方标题表**（`research/layout/dsh-client-ui-conversation__lib__client.js:16731-16748`）：思考 / 运行命令 / 读取 / 读取图片 / 写入 / 编辑 / 搜索文件内容 / 查找文件 / 浏览目录 / 工具调用，未知工具兜底「工具调用 · <工具名>」；`read` 命中图片扩展名时自动切成「读取图片」。④**图标**：新增 7 个 24 网格 1.7 描边图标 `ThinkIcon`(⊗) / `HashIcon`(#) / `TerminalIcon`(>_) / `FrameIcon`(▤) / `SearchIcon` / `PencilIcon` / `SparkIcon`，按工具名在 `TOOL_VIEWS` 里静态映射（不按参数猜）。⑤**状态**：运行中圆点用品牌色 + `superpi-pulse`；失败行 `data-state="error"` + 行尾 note「失败」；`!` bash 非 0 退出 note「exit N」、取消 note「已取消」、截断 note「truncated」。⑥**工作状态行**：`WorkingRow`（`div.superpi-working`，`view.busy` 时挂在过程流末尾），最终形态见 ⑩；计时器挂节点自己（1Hz `setInterval` + cleanup），不放面板级 —— 面板级每帧重算上百行流式 markdown 只为刷一行文字。`busySince` 由幂等 `markBusy`/`markIdle` 维护（busy 有 5 处赋值点：`agent_start`/`turn_start`/`agent_settled`/`resync`/`attach` + EventSource `exit`，散写必漏必残留；已在忙不重置起点，否则一轮任务里每重连一次计时归零）。⑦**删掉被取代的旧词汇**：`tool` / `result` / `busy` / `thinkingLabel` 四键在旧 ToolBlock/ThinkingBlock 删除后已无消费者，留两套词表会让下一任分不清行标签的真相源。⑧**实拍后三处修正**（装进独立实例、真跑一轮后逐像素对目标图）：行文字色从 `label-secondary`（`rgb(97,102,107)`）改成 `label-tertiary`（`rgb(129,133,140)`，与目标摘要实心色一致），`── live ──` 段加 `status === 'running'` 护栏 —— 跑完后 `partialResult` 与最终输出是同一件事，两段都印等于把结果写两遍。⑨门禁：`test/client-render.mjs` 669→697（去掉四个死键的 8 条非空断言，过程行结构由 SSR 三件套 `class="superpi-tool"` 断言继续锁；新增 9.11c 颜色两条 + 9.11d live 段四条），`test/css-tokens.mjs` 96→97（白名单新增 `--dsh-content-font-size-secondary`：过程行取 DSH 会话流次级正文档，用主档会让「过程」比「正文」更重）。⑩**工作状态行按 DSH `RunningStatus` 收尾**（第三次修订，同属实拍驱动）：目标图底部那行是品牌蓝 `rgb(52,94,186)` = `--dsw-alias-label-deep-diving`（`color-mix(in srgb, #4176e6 70%, #172554)`），图标是鲸鱼尾而非四角星 —— 我们原先的 `--dsw-alias-state-business-primary`（`rgb(65,118,230)`）是另一个蓝。改成照抄 DSH `dsh-client-ui-chat/lib/client.js:6386-6429`：新增 `WhaleTailIcon`（`:2004`，16 网格 / `stroke-width:1` / `fill:none` / `stroke:currentColor`，路径即 DSH `RunningWhaleTail` 的 `REST_PATH` 原文，未引入它的 APNG 蒙版资产），`.superpi-working` 文字色改 `--dsw-alias-label-deep-diving`、字号 `calc(var(--dsh-content-font-size,14px) - 2px)`（实测 12px）、行高 `calc(22px + var(--dsh-content-font-delta,0px))`（22px），图标随 `currentColor`；文案 `deepDiving`=「深度求索中」、`working`=「深度求索中，用时 {duration} ···」（三个 `U+00B7`，与 DSH `chat.deepDivingFor` 同字），`fmtDuration`（`client.js:3222`）按 DSH `formatRunDuration`（`:5847-5880`）补小时档 —— 新增 `durHour` 词条，`durHour` 仅 hours>0、`durMin` 仅 total≥60、`durSec` 恒有，拼接用 `parts.join('')` —— 单位间距由词条自带（中文 `durMin`=「{n}分」不带空格，目标图就是「43分54秒」；EN 为「{n}m 」带尾空格），与 DSH `formatRunDuration(...).map((part) => part.text).join('')` 同一拼法；另加 `span.superpi-sr[role=status][aria-live=polite]` 只播报不带秒数的 `deepDiving`，否则读屏每秒被刷一次。门禁随之 `test/client-render.mjs` 697→**738**（新增 9.11e：三条 working CSS 的颜色与字号、`WhaleTailIcon` 的 `viewBox 0 0 16 16` 与 `stroke-width="1"`、`fmtDuration` 五条定值含小时与 90 秒进位、`WorkingRow` 的 aria 结构与无起点时的退化文案），`test/css-tokens.mjs` 97→**98**。`docs/dsh-ui-spec.md` 的代码基线刷新到 `client.js` 5619 行 / 307602 B / sha256 前 12 位 `ACDCFE28FDFB`。（行号为 0.6.4 落地当时的坐标，非当前坐标。**已知笔误**：本行的 `WhaleTailIcon`（`:2004`）与 `fmtDuration`（`client.js:3222`）连 0.6.4 都对不上 —— 复核 v0.6.4 源码真值为 `client.js:1941` / `client.js:2975`，0.8.0 实测为 `client.js:2055` / `client.js:3296`，故 **2004 / 3222 这两个数不要当坐标用**（既非历史真值也非当前真值），跨版本定位请用符号名。另：本行的 `dsh-client-ui-chat/lib/client.js:6386-6429`、`:5847-5880` 与 `research/layout/dsh-client-ui-conversation__lib__client.js:16731-16748` 是**上游 DSH 源码坐标、非本仓库 `client.js`**，原样保留不动。） |
| 2026-11-15 | 0.7.0 | **弹层化重构与改名 SuperPi**（0.7.0）。①模型与思考档位从顶栏搬进输入框上方的向上弹层：新增 `ModelPicker`（`client.js:3130`），两段标题（`pickModel` `:237` / `pickThinking` `:238`），选项用 `role=menuitemradio` + `aria-checked`（`:3147` / `:3166`），开合状态在面板上受控（`pickerOpen` `:4295`、`togglePicker` `:5026`）；原生 `select` 整族（`.superpi-picker-wrap` / `.superpi-picker-native`）已删，`test/client-render.mjs` 专门断言 `superpi-picker-native === false`。②统计与设置从抽屉换成居中 `Dialog`：`openStats`（`:5051`）→ `StatsSheet`（`:3803`）、`openSettings`（`:5073`）→ `SettingsSheet`（`:3848`），`wide:true` 走 `.superpi-dialog-wide`（`:827`）。③历史会话换成左侧滑出的 `SidePanel`（`:3070`，宽 `min(360px,86%)`），`SessionsSheet` 套进去（挂载 `:3330`）。④顶栏删掉「下一个模型 / 下一个思考档位」两个循环按钮（注释 `:5350-5353`），压缩与重连收进 `⋯` 更多菜单（`moreItems` `:5309-5312`，两项只唤起 `setConfirm`），必须过 `ConfirmDialog`（`:5322` / `:5330`）——真正的动作在 `confirm === compact`（`:5321` → `runCompact('')` `:5327`）与 `confirm === reconnect`（`:5329` → `endSession()` `:5335`）分支里。⑤顶栏「新会话」仍是主按钮（`:5369` → `runNewSession` `:4847`），语义是同一 pi 子进程内换一棵会话树，D-03 收口。⑥显示名改 `SuperPi`（`panelTitle` `:37` / `:245`），`package.json` 的 `name` 仍是 `superpi`。⑦实拍补两处 CSS：`.superpi-dialog-content` 下内边距 22px（`:831`）、会话数徽标不折行（`:715`）与 mono 路径 ellipsis（`:720`）。门禁：`client-render` 738→755、`parity` 77→78（新增「重连收进更多菜单」与「二次确认之后才走 endSession」两条）。（行号为 0.7.0 落地当时的坐标，非当前坐标） |
| 2026-11-15 | 0.8.0 | **面板偏好落盘层（host 侧）+ 过程流排版收口**（0.8.0）。①新增 `src/ui-prefs.mjs`（403 行）：落盘在 `~/.superpi/ui-prefs.json`（可用 `SUPERPI_UI_PREFS` 覆盖），原子写（同目录 `.tmp-*` + rename，`renameWithRetry` `:228` 只对 EPERM/EBUSY/EACCES 退避）、写入串行化（队列 `:263`，一次 400 不把后续请求卡死）、读盘坏 JSON 回空结构（`:272-287`）、`setSession` 是**合并语义**（`:321`，`pinned` 与 `name` 是两个独立偏好，`undefined` 表示别动）；校验上限：项目名/会话名 120 字、会话路径 4096 字。②host 三条路由 `GET /ui-prefs`（`index.js:960`）、`POST /ui-prefs/project`（`:964`）、`POST /ui-prefs/session`（`:969`），都返回**全量结构**；store 未注入时回 501 而非静默 200。③过程流排版按参考图收口：父行是 24px 行盒（`.superpi-proc-head` / `.superpi-tool-head`，`client.js:564`），子行容器 `.superpi-sub` 用 `gap:8px`（`client.js:592`）⇒ 子行步长 **32 = 24 + 8**，父子同节奏；注释 `client.js:589` 逐字「组内 gap 与 body 一样是 8、行盒沿用父行的 24 ⇒ 子行步长 32，与父行完全同节奏」。「子行 16px 行盒 + gap 0 / 32:16」是被推翻的中间态（注释 `client.js:591` 逐字「早先子行压到 16px 行盒 + gap 0，行距只剩父行一半，看着像被挤扁」）；注释 `:555-561` 另有「父→父 40、父→首个子行 40、子→子 40、子行组→下一父行 44」的实测节奏。圆点是 `.superpi-sep`（`client.js:575`，`width:2px;height:2px;margin:0 11px`，行内三段间距统一 11）。④项目行与会话行补 `title=`（时间 + cwd/path，`client.js:3429` / `:3487`）；会话标题优先级 `renamed → piName → headline → lastMessage → sessionFallbackTitle`（`:3459-3460`），仍回落 `lastMessage`（`:3486`）。⑤门禁 `host-parity` 204→263：3.12 面板偏好十条（`test/host-parity.mjs:605`）+ 3.13 会话条目合并语义八条（`:727`）。**计数口径提示**：`263` 是本行写入时的值，定稿前该文件又有追加，当前 `node test/host-parity.mjs` 实测 `PASS (276 checks)` —— 当前态一律以第 29 / 33 行的 276 为准。**面板侧本轮已接线，与 host 能力面对齐** —— `api.uiPrefs` / `api.setProjectPref` / `api.setSessionPref`（`client.js:1000` / `:1001-1003` / `:1005-1007`）由 `SessionsSheet` 消费，i18n 词条 `renameProject` `ZH:249` / `renameSession` `:250` / `pinSession` `:251` / `unpinSession` `:252`。（行号为 0.8.0 落地当时的坐标，非当前坐标） |
| 2026-11-16 | 0.8.1 | **弹层交互与顶栏标题**（0.8.1）。三处一起改，都不新增界面。①四个居中弹窗统一成**真模态** —— 点遮罩即关闭，判定式只留一份 `maskHandler(onClose)`（`client.js:3121-3125`，判 `event.target === event.currentTarget`，内层不吞事件、不 `stopPropagation`）：`Dialog`（`:3148-3156`）、`ConfirmDialog`（`:3190-3202`，点遮罩 = **取消**而不是确认）、选择工作区 `DirSheet`（`:3810-4108`，遮罩用法在 `:4097`）、扩展 UI `ExtensionDialog`（`:4286-4366`，遮罩在 `:4357` 回 `{id, cancelled:true}`，与右上角关闭键同一条路径），并补上原先缺的 `aria-modal`。②`MoreMenu`（`:3205-3249`；顶栏 `⋯` 与历史会话行内 `⋯` 共用）补「点外部关闭」：`isOutsideMenu(node, anchor, target)`（`:3133-3138`）**同时放行菜单自身与触发按钮** —— 少了后半条，同一次点击里 `mousedown` 先关、`click` 又开，表现为「怎么点都关不掉」；顶栏传 `moreRef`（`:4735`）、行内传 `rowMenuAnchor`（`SessionsList` 内 `:3442`，同一时刻只允许一个行内菜单）。③顶栏左上的 `SuperPi` 换成**当前项目标题**（`:5733`）：host 侧新增 `withProjectIdentity(snapshot, projectCwd)`（`index.js:448-455`，`displayPath` `:452` = `shortenHomePath` 把家目录缩成 `~`、`projectKey` `:453` = `pathComparisonKey`）与 `snapshotOf(proc, options)`（`index.js:461-463`），在每份会话快照上补这两个字段，四处调用点 `index.js:672` / `1016` / `1031` / `1035`；客户端 `projectTitleOf(prefs, meta)`（`client.js:3391-3400`）按「面板里改过的项目名 → `displayPath` → 原始路径」取值，全空才回落 `t('panelTitle')`。路径缩短与大小写归一的唯一真相留在 host，浏览器侧不复制这套逻辑。`RuntimeGate`（`:4508-4553`，启动期没有会话）保留品牌名。面板偏好同时从 `SessionsSheet` 上提到 `PiPanel`（`prefsState` `:4676`、`applyPrefs` `:4680`、挂载时 `api.uiPrefs()` `:5047`），顶栏与历史会话列表读同一份 `prefs`。门禁：`client-render` 797→**831**（弹窗遮罩与菜单外部点击的纯函数断言、四个弹窗的 SSR 两层结构、`projectTitleOf` 八条）、`host-parity` 276→**291**（`withProjectIdentity` 9 条 + 会话快照带 `displayPath`/`projectKey` 6 条），`css-tokens` 98 不变。基线：`client.js` 6275 行 / 347871 B / sha256 前 12 位 `570B9EF4B9B0`，`index.js` 1624 行 / 76621 B / sha256 前 12 位 `DDD7C5CD828C`。（行号为 0.8.1 落地当时的坐标，非当前坐标） |
| 2026-11-17 | 0.9.1 | **发布链路 + 线上同步（不是 pi 能力变更，两端矩阵一行未改）**。①仓库推到 <https://github.com/lwaaron/superpi>（private，`origin` / `master`，19 个 tag 一并上传）。②新增 `tools/github-sync.mjs`：`ls-remote` 比对 → `git push HEAD:refs/heads/<branch>` → 补 `git push --tags`；失败按 stderr 分 `auth` / `rejected` / `offline` / `failed` 四类，退出码 0 已同步 · 2 离线待补推 · 3 要人处理 · 1 其它，`.git/superpi-sync.lock` 防并发、`.git/superpi-sync.log` 留痕，**绝不 force**。③`tools/git-hooks/post-commit` + `npm run hooks`：每次 commit 后台试推一次（`&` 分离、`exit 0`），离线时提交照旧落地、下次 `npm run sync` 补推 —— 即用户要求的「连不上网就先提交本地」。④新增 `test/github-sync.mjs` 82 条并进 `npm test`（11 项 → 12 项，耗时 ~15 s → ~20.5 s）：临时裸仓库当真远端、`127.0.0.1:1` 拒连当断网、另一个 clone 当分叉方，全程不联网。⑤`.gitattributes` 钉死 `*.ps1` LF / `*.bat` CRLF：否则 `core.autocrlf=true` 的机器克隆后 `test/restart-lib.mjs` 的「无游离 CR」断言必红。⑥**`package.json.files` 仍不含 `tools/`**：同步工具是开发期工具，不进插件运行时；`index.js` / `client.js` / `src/*` 一行未动，`CONTRACT_VERSION` 仅随版本号同步。**0.8.2–0.9.0 未在本表登记**：那四个版本只动 `tools/`（一键启动、双前端）与改名 `superpi`，两端能力面无变化（矩阵条目与计数仍是 33 / 25 / 27 / 9，`test/parity.mjs` 全部照旧通过）。 |
| 2026-11-17 | 0.9.2 | **输入框能力对账（第三层：不是 RPC 面，是 TUI 的输入框本身）**。用户报三件事，全在命令行 TUI 上：Ctrl+C 复制后内容消失、Ctrl+A 不能全选、Ctrl+X 不能剪切；外加「截图/复制文件后 Ctrl+V 应粘出路径」。实测根因两条：①pi-tui 的 `Editor` **没有选区模型** —— `tui.input.copy`（ctrl+c）在 `editor.js:597` 直接 `return` 交回上层，pi 的 `CustomEditor` 再交给 `app.clear` → `handleCtrlC()`（`interactive-mode.js:3595-3603`）清空输入框；`tui.editor.cursorLineStart` 默认键是 `["home","ctrl+a"]`，所以 Ctrl+A 是「移到行首」；`ctrl+x` 全表无绑定。②Windows 的 `getNativeClipboard()` 只导出 `getText/setText/getImage/enableVirtualTerminalInput/isModifierPressed`，**没有 `getFilePaths`**（只有 macOS 有），故资源管理器复制文件后 Ctrl+V 三档全空（filePaths/image/text 都是 null）。**处置路线（关键）**：先按「给 node_modules 里打包好的 chunk 打补丁」做过一版（wrap `Editor.prototype.handleInput` / 替换 `readClipboardFilePaths` 函数体 + 幂等标记 + `--apply/--revert/--status`），**用户 2026-11-17 明确禁用打补丁，已全部回退删除**（pi 运行时从未被修改，已用 `--status` 核验「未应用」）。最终走 **pi 官方扩展点**：新增 `extensions/superpi-editor.ts`（`class SuperPiEditor extends CustomEditor` + `ctx.ui.setEditorComponent()`，官方示例 `examples/extensions/modal-editor.ts` 同款），不改 pi 任何文件、不碰 `node_modules`。能力：Ctrl+A 全选、Shift+方向/Home/End 扩选、Ctrl+C 复制（有选区复制选区、无选区复制全文，**都不清空**）、Ctrl+X 剪切、Backspace/Delete 删选区、可打印字符与括号内粘贴替换选区、Ctrl+V 在「无文本且无位图」时读 Windows `CF_HDROP`（PowerShell `GetFileDropList`，异步、1.5 s 超时、base64 防中文乱码）插入绝对路径；空编辑器 Ctrl+C 刻意放行以保住 pi 的两次退出；Esc 只清选区不吞键。另外 pi 在 `setEditorComponent` 时会自动接回 `onSubmit`/`onChange`/`borderColor`/`paddingX` 与**全部 `actionHandlers`**（`interactive-mode.js:2336-2385`），所以扩展不重写 app 键位。安装面：新增 `tools/install-pi-extension.mjs`（`--install/--remove/--status`，落到 `<piAgentDir>/extensions/`，`PI_CONFIG_DIR` 跟随，`files` 里的 `extensions` 随 tarball 发布），`package.json` 加 `pi:editor` / `pi:editor:status` / `pi:editor:remove` 三个脚本，`tools/launch-both.ps1` 起 TUI 前自动装一次（`-NoEditorExtension` 可关，失败只 WARN）。门禁：新增 `test/tui-editor.mjs` **183 checks** 并进 `npm test`（12 项 → **13 项**）—— **用 jiti 加载真 `.ts` 扩展 + pi 真的 `CustomEditor` + 真终端按键序列**(像 `\x1b[1;2C` 这类序列) 做断言，而不是影子实现；最后一组用**pi 自己的扩展加载器**（`core/extensions/loader.js` 的 `discoverAndLoadExtensions`）把装到临时 `agentDir` 的扩展真加载一遍，断言「无 error」—— 这一步才是「装完 pi 真的能认」的机器保证。账本新增 `## 5.1 输入框能力对账`（11 行键位 × 面板/TUI/门禁三列）。**RPC 矩阵、事件表、TUI 斜杠表一行未改**（33 / 25 / 27 / 9 不变）。 |
| 2026-11-17 | 0.9.4 | **输入框外观与入口（用户实测提的四条 + 一条补充）**。①**四边闭合 + 框线 80% 白**：pi 的 Editor 只有上下两条边框（`renderTopBorder` / `renderBottomBorder`），现由扩展在 `render()` 里用 `╭─╮ │ │ ╰─╯` 包一层，`inner = width - 2` 交给 `super.render()`，每行都过 `padToWidth()` 保证**显示宽度恒等于渲染宽度**（差一列框线就歪）；pi 的滚动提示（`↑ N more` / `↓ N more`）用 `borderBody()` 原样保留，没有被套框吃掉。框线色 `FRAME_RGB = [204,204,204]`（255×0.8）。**刻意没做整块填充**：终端里把底色铺成近白必须同时强改文字色（pi 的主题色是浅色系），会连带压掉选区反色与思考配色，故只上边框色；要填充得先改成暗字方案。②**Working 按状态换色**：新增模块级状态机 `runState`（`idle` / `running` / `success` / `error`），由 `agent_start`、`tool_execution_end.isError`、`agent_settled` 三个扩展事件驱动；状态行画在框内最底一行，左侧图标 + `Working` 文案同色 —— 正常白 `[255,255,255]`、成功绿 `[126,211,133]`、出错红 `[236,94,94]`，图标随状态变 `○` / `◐◓◑◒` / `✔` / `✖`，运行中带 `· Ns` 计时。同时 `ctx.ui.setWorkingVisible(false)` 关掉 pi 内置 Working 行，否则会出现两条状态。③**粘贴路径加浅灰底**：`paintPathChips()` 用与选区同一套 `visualChunks()`（视觉行 ↔ 逻辑字符区间）把 token 映射到显示列，涂 `48;2;104;104;104`、以 `49` 闭合，左右各吃一格当「圆角」（终端单元格画不出真圆角）；识别用保守正则 `PATH_TOKEN_RE` + `isLikelyPath()`：认盘符 / UNC / POSIX 两段以上，排除 URL、相对路径、`/settings` 这类斜杠命令。**顺带修掉一个真缺陷**：`ansiEnd()` 原本只认 CSI 与 OSC，遇到 pi 的 APC 光标标记（`ESC _ pi:c BEL`）只跳 2 个字符，剩下的载荷被当成可见字算 —— 光标在行内时列号会整段错位，现在按 BEL/ST 吞掉整条 APC（顺带覆盖 DCS/PM）。④**右下角 settings / home**：画在框内最底一行右侧、pi footer（模型信息）之上，**文案全小写**（用户 2026-11-17 追加要求 `home` 小写）。点 `settings` 展开菜单 —— `settings` / `model` / `thinking` / `scoped-models`，**每条都是 pi 自己的斜杠命令，一条不自造**，点了走 `editor.onSubmit(command)`（等同用户敲回车，由 pi 的 `setupEditorSubmitHandler` 分流）；点 `home` 提交 `/new`（起新会话树 = 刚启动时的界面）。运行中点击只 `notify` 一条 warning、不打断；`Esc` 先关菜单再清选区。鼠标命中用渲染时记录的 `hits`（组件坐标），转发给 pi 前把 `x - 1`（左侧框线）、`y - 1 - 菜单行数` 换算回 `super.render` 的坐标系。门禁：`test/tui-editor.mjs` 67 → **183 checks**（0.9.5 又补了窄宽度退化与等宽断言），新增外观（框线色/四角/每行首尾竖线/每行等宽）、四状态配色与图标、路径药丸正反例、`settings`/`home` 小写与点击链路、Esc 关菜单、`padToWidth` 三条，外加**去 pi 的 `dist/modes/interactive/interactive-mode.js` 里 grep 断言 `/settings`、`/model`、`/thinking`、`/scoped-models`、`/new` 仍然存在** —— pi 删了命令门禁就红，菜单不会指向空中。**RPC 矩阵、事件表、TUI 斜杠表一行未改**（33 / 25 / 27 / 9 不变）。 |
| 2026-11-17 | 0.9.7 | **输入框五处收口（用户第二轮实测反馈）**。①**框线改直角**：`╭╮╰╯` → `┌┐└┘`（用户明确「还修改会直角」），框内每行仍过 `padToWidth()` 保证等宽。②**Working 回到 pi 原来的位置**：0.9.4 把它塞进框内最底一行，现在回到**上边框内侧左侧**（形如 `┌─ ◒ Working · 8s ───┐`，`topBorder()`），保留按状态换色；窄宽度依次退让「完整标签 → 只剩图标 → 只画横线」。③**settings / home 移到框外**：放下边框之下、右下角、模型信息上方，**颜色与模型名一致** —— pi footer 用 `theme.fg('dim', …)` 画模型名，这里也走 `this.theme.fg('dim', …)`（`actionsRow()`），不再自己定色。菜单展开后也在框外。④**路径底色不再溢出**（用户实测：路径后面接着打的字也带上底色）。根因是候选 token 用 `[^\s…]*` 吃到空白为止，而中文与英文之间常常没有空白。修法：新增 `trimPathToken()`，在 token 内**最后一个已知扩展名**（`PATH_EXT_RE`，与 `FILE_BARE_EXT` 同源的保守白名单）处截断；圆角格改为**只在那一格确实是空白时才吃**（`padLeft` / `padRight`），不再无条件左右各吃一格。⑤**Ctrl+V 截图粘不进去**（用户实测）。根因二连：pi-tui 的 Windows native 模块没有 `getFilePaths`，且实测 `getText` / `getImage` 在截图后**也读不到**；pi 的 `handleClipboardPaste` 于是三档全空、点了没反应。修法：把「按 Ctrl+V 到底插入什么」的判定**收归扩展自己**（`resolveClipboardPaste()`）：先问 native 快路径（不 spawn，文本/位图通常在这一步命中，位图由 `saveClipboardImage()` 落成临时 PNG —— 与 pi 自己的做法一致），只有它什么都没读到时才启动 PowerShell 探头 `readWindowsClipboard()`（一次性拿文件列表 / 文本 / 位图，全走 base64 防中文乱码，`-STA` + 1.5 s 超时，位图另存临时 PNG）；三者都没有才回落到 pi 的 `onPasteImage`。实测三条通道各自命中：位图 → `%TEMP%\superpi-paste-*.png`、文件拖放 → 原始绝对路径、文本 → 原样插入。另：防重入改为「6 s 后视为失效」（`PASTE_STALE_MS`），一次卡住的读取不会永久堵死后续粘贴。鼠标转发在 0.9.7 简化：x 统一减 1 跳过左侧框线；**下边框之下是我们自己的区域**（`lastBoxBottom`），只有 settings / home / 菜单可点，其余点击直接消费掉，不再按错行号回传给 pi。门禁：`test/tui-editor.mjs` 155 → **183 checks** —— 直角断言（不含 `╭╮╰╯`）、Working 在第 0 行、入口在框外且右对齐且用 `dim` 上色、`trimPathToken` 截断与「紧贴普通文字时底色止住」的像素级断言（`paintedCells()` 逐字符还原底色覆盖范围）、`parseProbe` 三态解析、`saveClipboardImage` 落盘；五档宽度下框内等宽 + 框外入口完整可见。**一次真机实测**：截图 → Ctrl+V 得到 `%TEMP%` 路径；资源管理器复制文件 → 得到原始路径；复制文本 → 原样插入。 |
| 2026-11-17 | 0.9.11 | **修「settings / home 点不动」—— 0.9.9 搬到 footer 时漏登记命中区**。0.9.9 把这两个入口从编辑器框外搬到 footer 第一行，重写 `projectRow()` 时**只给项目名与 ⇄ 图标 `hits.push` 了，`settings` / `home` 的循环里只有绘制与 `cursor` 累加，没有登记命中区** → `handleMouse()` 找不到 hit 直接 `return undefined`，点击被交回 pi（那边也没有对应处理），表现就是「悬停会变亮、点了没反应」。悬停正常正是因为它走的是同一份 `hits` 却…… 不：悬停按坐标先命中 hit 才改状态，所以连悬停其实也不该亮 —— 用户看到的是「完全点不动」。修法一行：在绘制循环里补 `this.hits.push({ kind: action.id as "settings" | "home", x: cursor, y, width: actionWidth })`，同时把 `FooterHitKind` 收成 `"project" | "settings" | "home" | "model" | "thinking"` 五个合法值。门禁 `test/tui-editor.mjs` 256 → **276 checks**：④d2 逐词点在**首字符与末字符**上（命中区宽度算错就会漏）+ 两词之间的空隙**不触发动作且返回 undefined**；④d3 是一条**不变式**：「渲染里画出来的入口必须都可点」—— 以后再加或挪入口，只要画了却没登记 hits 门禁立刻红，比逐条断言抗回归得多（把那一行 `hits.push` 删掉，④d2 立刻报「点 settings 必须被 footer 消费」，已实测验过）。**注意这轮没有动**：编辑器本体、第 2 行统计、`max` / 模型名 / ⇄ 的路由、悬停、项目切换 —— 276 条里原有的 256 条全绿。 |
| 2026-11-17 | 0.9.10 | **修「窗口最底部那一行信息没有了」—— 0.9.9 的 footer 第二行在真机上整条空掉**。根因：`ExtensionContext` **没有 `session` 字段**（`types.d.ts:233-273` 只有 `ui / mode / hasUI / cwd / sessionManager / modelRegistry / model / scopedModels / thinkingLevel / isIdle / isProjectTrusted / signal / abort / hasPendingMessages / shutdown / getContextUsage / compact / getSystemPrompt`），而 0.9.9 第一版从 `ctx.session` 拿 AgentSession 去 `new FooterComponent(...)` —— 真实环境里恒 `undefined`，内层 footer 建不出来，`innerLine()` 返回空串，`render()` 就把第二行整个跳过。**为什么门禁没抓到**：当时夹具自己编了一个 `ctx.session`，把这条不存在的字段喂了进去 —— 又一次「假数据必须照抄上游真实形状」的教训（和 0.9.8 的假 theme 带 `fg` 是同一类错误）。处置：**不再 new pi 的 FooterComponent**（它要 AgentSession 的 `state.model` / `modelRuntime.isUsingSubscription` / `getContextUsage()` / `sessionManager.getEntries()`），改由本扩展**按 pi 同一套公式**自己算（`footer.js:20-27` 的 `formatTokens`、`:83-125` 的 usage 累加与命中率、`:160-236` 的左右对齐与 `(provider) Model • 档位`）：数据源换成扩展真实能拿到的 `ctx.model` / `ctx.thinkingLevel` / `ctx.sessionManager.getEntries()` / `ctx.getContextUsage()` / `ctx.getSettings().compaction.enabled` / `footerData.getGitBranch()`；每一项都是**可空且独立降级** —— 任何一项取不到只少一个片段，绝不整行消失（空 ctx 也至少渲染出项目行）。入口侧同时把 `model / thinkingLevel / sessionManager / getContextUsage / getSettings` 全部用 **getter** 透给 footer（`switchSession` 之后 pi 会换新 ctx，快照会让统计和模型名冻结在旧会话）。门禁 `test/tui-editor.mjs` 231 → **256 checks**：新增 ④c2「没有 `ctx.session` 时第二行也必须在」、④c3「空 ctx 也不崩且不出现 undefined」、以及**接线回归**（经入口装出来的 footer 必须真的渲染两行，且第二行带 `↑167k` / `28.7%/1.0M` / 模型名 / `max` —— 把入口里 `get model()` 改回 `undefined` 门禁立刻红，已实测验过）。另补 `formatTokens` 五档与 `sumUsage`（累加 + 命中率 93.18%）的纯函数断言。 |
| 2026-11-17 | 0.9.9 | **footer 接管：`settings`/`home` 与 cwd 同行、⇄ 切换项目、`max` 可点、悬停变亮**。用户第二轮实测四条（前三条来自截图批注，第四条追加）：「将 settings 和 home 与 `D:\my_projects\SuperPi\SuperPi (master)` 放在一行上」「在右侧增加一个切换图标，点击之后回到项目选择页面」「点击右下角的 max 可以切换选项」「鼠标移入这几个文字按钮时要变亮，代表可点击」。**根因不是画法，而是归属**：cwd 那一行整份归 pi 的 `FooterComponent`（`footer.js`），输入框渲染不到它 —— 0.9.4~0.9.8 把 settings/home 画在输入框框外，所以永远只能单独占一行。处置：用官方 `ctx.ui.setFooter()`（`interactive-mode.js:2076-2093`）接管，新增 `SuperPiFooter`：**第一行本扩展画**（`项目名 (分支)  ⇄` + 右对齐 `settings  home`），**第二行原样复用 pi 的 `FooterComponent`**（`dist/index.js` 公开导出，只取 `render()[1]`）—— 统计/上下文/模型名/档位全由 pi 算，本扩展只切出 `Model` 与 `• max` 两个点击区，上游改统计规则也不会分叉。**项目切换**：pi 的 TUI 没有项目选择页（`/resume` 的两种 scope 都不按项目分组，`session-selector.js:98`），cwd 又是进程启动时定死的；唯一官方改 cwd 的入口是 `ctx.switchSession(sessionFile)`（`agent-session-runtime.js:128-146` 用 header.cwd 建 runtime）。于是 `switchProjectVia()` = `SessionManager.listAll()` → `groupProjects()`（当前项目置顶 → 非临时优先 → 最近活动降序，照抄 `session-selector.js:760-769`）→ `ctx.ui.select()` → `ensureProjectSession()` → `ctx.switchSession()`。目标项目还没有会话文件时**自己按 pi 的 header 格式写一个空会话**（`type/version/id/timestamp/cwd`；`SessionManager.create()` 本身不落盘，`_persist()` 要等第一轮对话 —— `session-manager.js:795-819`），空 header 文件 `SessionManager.open()` 能正常读，等价「在这个项目里开新会话」。**悬停**：常态 `dim`（与模型名同色）→ 移入 `accent` + 下划线（`hoverStyle()`）。只换颜色不够（浅色主题里 dim→accent 几乎看不出来），下划线是终端里最稳的「可点」信号；悬停态放**模块级** `hoverState` —— 鼠标事件落到编辑器、入口画在 footer，两边必须共享同一份状态；`move` 只改状态 + 重画，`press`/`click` 才动作，移出必须复原。**踩过两个坑**：①`splitFooterLine()` 用 `/(?:^|\s{2,})(\S.*\S)$/` 会把整行判成模型段（正则从左匹配、`.*` 吃空格），改成从最后一个「连续 2+ 空格」切；②门禁里的主题桩用字面 `<dim>x</dim>` 会被 `visibleWidth` 当成可见字符、把 padding 算歪（settings/home 直接被挤出行外），必须用真 ANSI。门禁 `test/tui-editor.mjs` 183 → **231 checks**（footer 两行结构 / 图标单列宽 U+21C4 / 三处点击各自的路由 / 悬停移入变 accent+下划线且不触发动作 / 移出复原 / `splitFooterLine`、`splitModelSegment` 边界 / `groupProjects` 排序 / `pathComparisonKey` / `ensureProjectSession` 的 header 字段 / footer 只装一次的接线）。同时把 ⑤⑥⑦ 段从「点编辑器框外的 settings/home」改成「toggleMenu() + runCommand()」——入口搬家了，断言跟着搬，语义一条没删。 |
| 2026-11-17 | 0.9.8 | **修「`/reload` 之后没变化」—— 0.9.4~0.9.7 的外观改动实际从未生效**。根因：pi 通过 `getEditorTheme()`（`theme.js:902-907`）交给编辑器的 theme **只有 `borderColor` 与 `selectList`，没有 `fg`**；0.9.4 的 `actionsRow()` 直接调 `this.theme.fg('dim', …)` 取「与模型名一致」的颜色 → 抛 `TypeError: this.theme.fg is not a function` → `render()` 的 `catch` 兜底 `return decorated`（**没套框的原始行**）→ 用户看到的就是「改了没变化」。0.9.6/0.9.7 又在这条路径上继续加内容，所以一路都是静默失效；`test/tui-editor.mjs` 当时用的假 theme 带了 `fg`，把 bug 完全掩盖了。修法三件：①`dim()` 改为「theme.fg 可用就用 → 否则用注入的 `hooks.dim` → 否则原样返回」，注入值由扩展入口从 **`ctx.ui.theme.fg('dim', …)`** 提供（扩展里能拿到主题的唯一公开入口）；②兜底不再退化：`compose()` 抛错后先走 `plainFrame()`（只有框线与 Working，不依赖任何取色）再退，**任何情况下都不会变成无框原始行**；③门禁把假 theme 换成 pi 的真实形状（`{ borderColor, selectList: {} }`），并新增 ④b 段专门断言「theme 没有 fg、也没有注入 dim 时框仍然在」。`test/tui-editor.mjs` 177 → **183 checks**。教训写进本节：**装饰性代码的 try/catch 兜底如果退化成「什么都不做」，UI 改动就会静默失效**——兜底必须是「降级但仍可见」。另 0.9.4~0.9.7 的四条外观结论本身没错，只是当时没生效；本次一并复核。 |
| — | — | 修改本文档时必须同时改：受影响行的「面板端状态」、`## 1/3/4` 末尾的统计数字、以及 `## 6` 的一行。统计数字算错会让「零缺口」变成一句空话。 |

# AGENTS.md — SuperPi

给接手这个仓库的 AI。动代码前先读完这一页，尤其是第 3 节。

## 1. 这是什么

DSH（DeepSeek Runtime）插件：把 pi 编码 agent 装进 DSH 的侧栏面板。

它不重写 pi，只做一层薄适配——host 拉起真正的 `pi --mode rpc` 子进程，面板通过 pi 官方 JSONL RPC 协议跟它对话。pi 升级只要 RPC 帧不破，面板不用改。

必须记住的架构事实：**同一个 pi 1.5.2、同一个 agent loop，两个平级前端**——命令行 TUI（`packages/coding-agent/src/modes/interactive/`）与 superpi 面板。不是父子，不是主从。第 2、3 节全部由此推出。

## 2. 两半架构

| 文件 | 职责（一句话） |
| --- | --- |
| `index.js` | host 半区：注册 `/api/superpi/*` 路由（`createHandler` `index.js:809-1117`，路由分派在 `:824-1107`）、会话池（≤8）、子进程生命周期、自检、运行时解析报告。 |
| `src/pi-rpc.mjs` | JSONL 帧解析、命令 id 配对、事件环形缓冲、扩展 UI 挂起表（`pendingUi` `:150` / `trackUi()` `:291` / `respond()` `:464`，`extension_ui_response` 在 `send()` 里被强制改道 `:392-396` 以免被重新分配 id）、**超时让位机制**（`timeoutLimitMs()` `:43` 归一化三态；`armTimer()` `:432` 到点时若有弹窗挂起就续期而非 reject，上限 `MAX_TIMEOUT_DEFERRALS` 12 轮；`restartPendingTimers()` `:490` 在每次应答后重开一整轮窗口）。 |
| `src/pi-runtime.mjs` | pi 与 node 的 8 步解析链 + 一键安装（不依赖任何宿主路径）。 |
| `src/rpc-contract.mjs` | 三方事实的结构化快照：33 条 RPC 命令、25 类事件、12 种 assistant 事件、27 条 TUI 内置命令、9 个扩展 UI method、`classifyInput()`、`validateContract()`。**命令表/事件表/斜杠表只在这里定义一份**，`client.js` 不许硬编码。 |
| `src/session-store.mjs` | 只读枚举 `~/.pi/agent/sessions` 下的 pi 会话文件（语义对齐 `session-manager.ts:802-897`），另有 `pathComparisonKey` / `isTemporaryPath` / `shortenHomePath` / `groupSessionsByProject`（对齐 `cli/session-picker.ts:26-62` 与 `session-selector.ts:760-769`）与 `readSessionCwd`（读 header.cwd，供跨项目切换回填）。已接线：`index.js:34-45` import 十个函数，`GET /sessions/history?scope=`（`index.js:870`）暴露给面板的 `SessionsSheet`（`client.js:3659` 容器）/ `SessionsList`（`client.js:3432` 纯渲染）。 |
| `client.js` | 浏览器半区：React 面板，零构建、零 JSX，只 `require('react')`。 |
| `docs/parity.md` | 能力矩阵。两端对齐的唯一账本。 |
| `src/http-idle-guard.mjs` | **HTTP idle 超时下限**（0.15.0）：pi 默认 `httpIdleTimeoutMs = 300_000`（5 分钟）会误杀长思考 —— 实测 4 次 `BODY_TIMEOUT` 的静默时长是 317/323/331/503s，刚过线且**与上下文规模无关**（最浅一次仅 7.3%）。`ensureHttpIdleTimeout({agentDir})` 在 spawn 前把它抬到 **30 分钟**。边界严格：只补「未设置」的、显式配置一律尊重（哪怕小于下限）、显式关闭（`0`/`"disabled"`）一律保留、坏 JSON **绝不覆盖**、幂等不重复写盘（已达标不刷 mtime）。设置项本身是 pi 官方支持的（`settings-manager.js:713-722` + `main.js:765` 会在进 `runRpcMode` 前重新配置调度器），所以这是**配置面不是补丁**。详见 `docs/session-interruption.md`。 |
| `src/runtime-files.mjs` | **运行时文件清单的唯一来源**（0.15.0）：`listRuntimeFiles(root)` 按目录自动发现（根文件 + `src/` 与 `extensions/` 下全部 `.mjs`/`.ts`），`copyRuntimeFiles(root,target)` 供 `test/selfcheck.mjs` 与 `test/version.mjs` 共用。**为什么需要**：这两处原各硬编码一份复制清单，实测已漂移（16 vs 15 项），新增一个源文件就同时让两个门禁报 `Cannot find module` —— 而修法是每处各补一条，下一个人必然再漏。门禁断言「不许退回硬编码」。 |
| `test/preflight.mjs` | **门禁依赖的唯一判据**（0.16.1）：`probeRuntime()` / `probeJiti()` / `probeReact()` 永不退出、只返回事实；`requireRuntime()` / `requireJiti()` / `requireReact()` 缺失即**失败**（不是 SKIP）。**为什么需要**：0.16.0 审查证实 6 套门禁缺依赖时整段跳过并 exit 0 —— 实测隐藏 `.runtime/` 后 `tui-editor` 的 521 条检查一条没跑，`npm test` 仍是绿的；而 `.runtime/` 是 gitignore 的，**新机器 clone 下来必然命中**。修法刻意**不是**给 6 个文件各加一个 `exit(1)`（那是 6 个补丁，第 7 个必然再漏，与 `runtime-files.mjs` 修「硬编码清单漂移」同构），而是让「依赖就绪」成为一个可查询的事实。三种终态：通过 / 失败 / **显式**跳过（`skipOptional()` 必须标 `[可选]` 并给理由）。 |
| `test/gate-inventory.mjs` + `test/gate-inventory.json` | **门禁规模的唯一真源与对账判据**（0.16.1）：登记表给每套门禁一条**下限**，`npm test` 按 `SUITE_GATES` 顺序执行每套门禁一次并读取当次退出状态与 `PASS (N checks)`，**实测 < 登记即红**。**为什么需要**：0.16.0 审查发现 AGENTS.md 里散落的 check 数已全面漂移（parity 98→102、host-parity 412→430、context-guard 150→179、tui-editor 459→521）而无人校验 —— 数字分散在多处手写副本就必然漂移，而本文恰恰把它们加粗当作「对齐强度」的证据。判据取下限而非相等：上升=补了用例（正常，顺手抬高登记值），下降=能力被削弱或门禁漏跑（必须拦）。`--list` 看登记表，`--print` 打印实测值。 |
| `src/ui-prefs.mjs` | 面板偏好的落盘层（0.8.0）：项目显示名 / 会话显示名 / 会话置顶的唯一真相，落在 `<home>/.superpi/ui-prefs.json`（`SUPERPI_UI_PREFS` 可覆盖路径，`UI_PREFS_DIR_NAME` = `.superpi`，版本号 `UI_PREFS_VERSION = 1` 供将来迁移）。对外只经 host 的 `/ui-prefs` 三条路由（`index.js:991-1007`：GET 只读、`POST /ui-prefs/project`、`POST /ui-prefs/session` 走合并式补丁），校验与 400 语义都收在这一层（`MAX_PROJECT_NAME_LENGTH` 120 / `MAX_SESSION_PATH_LENGTH` 4096）。**它不归 pi 的 RPC 面管** —— 偏好是「面板自己的账」。 |
| `extensions/superpi-editor.ts` | 命令行会话窗口（pi TUI）的**输入框增强**（0.9.2 起）：继承 pi 公开的 `CustomEditor`，通过官方扩展点 `ctx.ui.setEditorComponent()` 替换输入框 —— **不改 pi 任何文件、不打补丁、不碰 `node_modules`**。①输入语义：Ctrl+A 全选、Shift+方向/Home/End 扩选、Ctrl+C 复制（不再清空内容）、Ctrl+X 剪切、Backspace/Delete 删选区、可打印字符与粘贴替换选区、Windows 下 Ctrl+V 粘贴**剪贴板里的文件**时插入绝对路径（读 PowerShell 的 `GetFileDropList`，因为 pi-tui 的 Windows native 模块没有 `getFilePaths`）。②外观与入口（0.9.4，0.9.7 收口）：四边闭合的**直角**框（`┌─┐ │ │ └─┘`）+ 框线 80% 白（`FRAME_RGB=[204,204,204]`，pi 原本只有上下两条线，滚动提示保留）；Working 行**回到 pi 原来的位置（上边框内侧左侧）**并按状态换色（正常白 `[255,255,255]` / 成功绿 `[126,211,133]` / 出错红 `[236,94,94]`，图标同色，状态来自 `agent_start`/`tool_execution_end.isError`/`agent_settled`，并 `setWorkingVisible(false)` 关掉 pi 内置那条）；粘贴进来的绝对路径加浅灰底色（`PATH_CHIP_RGB=[104,104,104]`，`trimPathToken()` 保证**只染路径本身**、不溢出到后面打的字，圆角格只在确实是空白时才吃）；`settings` / `home` 两个入口（**全小写**）放在**框外右下角、模型上方**，颜色**与模型名一致**（`theme.fg('dim', …)`）：`settings` 展开 pi 自己的四条斜杠命令（`/settings` `/model` `/thinking` `/scoped-models`，点了走 `editor.onSubmit`），`home` 提交 `/new`（回启动界面）。③**Ctrl+V 判定归扩展自己**（0.9.7）：`resolveClipboardPaste()` 先问 native 快路径（位图落成临时 PNG），失败才起 PowerShell 探头 `readWindowsClipboard()` 一次性拿文件/文本/位图 —— 因为 pi-tui 的 Windows native 模块既没有 `getFilePaths`，实测连 `getImage`/`getText` 也会读不到，pi 自己的 `handleClipboardPaste` 于是「截图后 Ctrl+V 没反应」。三者都没有才回落 `onPasteImage`。安装面 `tools/install-pi-extension.mjs`（`--install/--remove/--status`）落到 `<piAgentDir>/extensions/`（0.10.0 起一次装三个文件：editor + `superpi-rules.ts` + `superpi-rules.mjs`，`status.complete` 才算完整）；门禁 `test/tui-editor.mjs`（规模见 `test/gate-inventory.json`；0.9.11 起 footer 接管见 0.9.9，底部那行回归见 0.9.10，点击命中区回归见 0.9.11；0.14.1 起含等待可见性：Working 行显示当前工具与命令自设上限）。 |

| `extensions/superpi-rules.mjs` | **用户自定义规则**（0.10.0）的唯一模型层：`DEFAULT_RULES_TEXT`（用户手写的 21 条）、`OVERRIDE_PREFIX`（「优先级最高、覆盖上文、冲突以本段为准」的开场声明）、`normalizeRulesText()`（去 BOM / 统一换行 / 去行尾空白 / 压缩空行 / trim，**必须幂等**否则每次保存都改 checksum）、`isRulesEmptyText()`（`#` 注释行算空）、`checksumOf()`（sha256，写入时自己算不收客户端）、`renderRulesBlock()`（**不自带 `<user_defined_rules>` 标签** —— pi 组装 section 时会包，自己再包就是同名嵌套两次，实测抓到过）、`createRulesStore()`（串行写队列 + tmp/rename 原子落盘 + 读盘容错永不抛 + 幂等写不刷 `updatedAt`）与 `readRulesTextSync()`（扩展每轮读盘用，mtime+size 缓存）。落盘 `<home>/.superpi/rules.json`（`SUPERPI_RULES` 可覆盖），与 ui-prefs 同目录。**它同时被 `index.js`（`/rules` 三条路由）与 pi 扩展引用，所以放在 `extensions/` 而不是 `src/`** —— 扩展被原样复制到 `<piAgentDir>/extensions/` 后，`./superpi-rules.mjs` 这条相对引用在仓库里与安装后指向同一份内容，零复制、零分叉。只管 node 内建依赖（jiti 的 alias 表里没有第三方包）。 |
| `extensions/superpi-rules.ts` | 把规则送进 pi 的**系统提示**（0.10.0）：`pi.on('before_agent_start')` 每轮读盘 → 写进 `systemPromptOptions.sections.user_defined_rules`（**不返回 `systemPrompt`**：那会走 `forceSystemPrompt` 整份重放 = 每轮一次缓存 miss，而 section 只发一次补丁）；位置由 pi 的组装顺序保证 —— 自定义 section 排在 `cwd` 之后，即整份提示末尾。另注册 `/superpi-rules`（看级别与字数 / 编辑 / 恢复默认 / 只显示全文），读写的是**面板那一份文件**。按 `ctx.ui.select/editor/confirm` 分级退化：没有交互 UI 就明确告知文件路径，**任何异常都不外抛**（规则读不出来不能让 pi 起不来或一轮对话失败）。不 import `@earendil-works/*`（只依赖 `pi.on` / `pi.registerCommand` / `ctx.ui.*` 三个运行时参数），所以多份 pi 副本都能加载、也能在 `test/rules.mjs` 里用假 pi 单测。 |
| `extensions/superpi-context-guard.mjs` | **上下文窗口化**（0.12.0）的模型层：`planContextWindow(messages, {windowTokens, settings})` 在请求前按「信息价值/成本」分级折叠 —— ①旧图片→一行占位（带路径，可重读）②旧 thinking→丢弃 ③超长工具结果→头尾保留 ④旧工具结果→折成首行 ⑤旧回复→折叠；保护区由**三条约束取最严**（最近 `keepRecentTurns` 轮 / `keepRecentMessages` 条 / `protectedTokenRatio` 窗口），本轮（最后一条 user 之后）的图片一张不动。估算口径刻意与 pi 不同：图片按 `imageTokens=12000`（pi 记 4800 chars≈1200，实测低估十几倍）、文本 `charsPerToken=3`。设 `targetRatio=0.72`，**保证请求不超预算**。纯函数、幂等、单调（前缀只后退，prompt cache 不击穿）；`hygiene` 段落 `DEFAULT_HYGIENE_TEXT` 写死边界「只清理本次任务自己生成的中间产物」。落盘 `<home>/.superpi/context-guard.json`（`SUPERPI_CONTEXT_GUARD` 可覆盖）+ 观测日志 `context-guard.log.jsonl`（滚 240 行）。 |
| `extensions/superpi-context-guard.ts` | 接线层：`turn_end` 为成功的长 `write` / `edit` 追加 `context_edit` 投影，保留原始调用与工具结果。`pi.on('context')` 返回裁剪后的 messages（**不写 session、不调模型、不联网** —— 所以超限那一刻它必然能成功，而压缩/重试都要再用一次已被超限的资源）；无需裁剪时返回 `undefined`（不触发 pi 重放提示）；`pi.on('before_agent_start')` 把「图片用完即弃」准则写进 `sections.superpi_context_hygiene`（与用户规则并列、不抢 key）；`/superpi-context` 看真实占用与释放量。异常一律吞掉。门禁 `test/context-guard.mjs`（规模见 `test/gate-inventory.json`；0.14.0 起含 C2 本轮图片限额 / C3 参数折叠 / C4 兜底三段）。**0.12.2 起**：TUI footer 第 2 行的上下文百分比也取这份日志（`readGuardUsageSync`，2 秒节流、按 sessionId 过滤、拿不到就退回 pi 原值），显示成 `~60.0%/1.0M` —— `~` 表示守卫估算，不是 provider 的 usage。 |
| `extensions/superpi-turn-verdict.mjs` | **「这一轮交付了吗」的唯一判据**。按结构识别三种 DSML 形态（见 §5.0.1）、空转、坏字节、输出截断、未闭合推理正文及上游提前断流。`detectTurnVerdict()` 返回 `kind`、`bytes` 与中英文案。`VERDICT_KINDS` 和 `TURN_VERDICT_NOTICE` 描述完整类型。host 对每条 `message_end` 判定一次（`src/event-verdict.mjs`），面板渲染结果，命令行在同进程使用判定器。门禁 `test/turn-verdict.mjs`。 |
| `extensions/superpi-turn-recovery.ts` | `turn_end` 根据失败回复自身的工具调用和执行结果决定是否移出请求投影，会话树保留原记录。无待处理输入时，`agent_before_settle` 为输出异常和明确未被 Pi 识别的断流最多补充续跑一次。续跑从已完成的工具结果继续，并遵守重试设置。TUI 和 RPC 共用。 |
| `extensions/superpi-ask-user.ts` | Agent 需要关键信息或决定时，通过原生 `ask_user` 工具等待用户。`select` 和 `input` 在 TUI 与 RPC 共用，可选项和自由输入都回原回合。关闭、超时、停止和非交互模式都有明确结果。 |
| `extensions/superpi-delivery.ts` | `verify`、`review_changes` 和 `task_progress` 共用 Pi 的工具链与会话分支。重跑编号验收前保存该项的待验收状态。工作区命令成功且源码内容和文件版本均一致后写入新证据。编号变异验收由任务声明替换与诊断，原始快照通过且变异快照报告预期诊断后，还要核对工作区与受测快照的指纹。`finishWhenVerified` 由任务声明，证据齐备后在 Pi 收尾边界重验，持久化任务完成记录和双端可见的回执。`/superpi-task` 查看当前分支的验收记录。 |
| `extensions/superpi-verification.mjs` | Git 普通文件快照、源码指纹、命令运行期的文件版本校验、精确变异和 Shell 截止时间。文件版本包含设备、文件标识和状态时间，与持久化的源码指纹分开使用。编号验收使用文件系统通知捕获短暂出现的工作区路径，沿用 Git 的跟踪和忽略规则。观察明确失败时保留命令结果与待验收状态。带对照的变异验证从同一次采集建立两个独立副本，使用 Shell 原始记录匹配诊断。 |
| `extensions/superpi-review.mjs` | 正确性和测试覆盖使用同一 Git 快照，在独立的 Pi 上下文中并行审查。符合预算的快照首轮提供完整源码和 Git 差异或改动文件的基准内容。首轮预算计入差异材料及查阅工具定义的序列化字节，空闲窗口随模型内容重开，整次评审遵循总时限。评审取得源码后遇到可识别的断流，可从完成的读取恢复一次，沿用原时限、请求预算和会话重试设置。评审进行中把已读路径、行号和已提交的有效报告通过 Pi 写入会话分支，重开时从匹配的快照重建源码摘录。已有最终结果的评审以最终结果为准。静态缺口须给出快照路径。基准、源码、有效范围、验收目标与模型相同才复用证据。会话恢复时，当前用户请求对同一份证据最多发起两轮。只有完整且无阻塞项的结果可用于交付验收。模型请求边界记录计数，超时仍保留已发请求和可判定的失败类型。 |
| `src/runtime-extensions.mjs` | 共享扩展清单及幂等同步。面板启动和 TUI 安装器同步同一套文件，Pi 按官方路径加载。 |
| `extensions/superpi-session-controls.ts` | 使用 Pi 的扩展 API 读取有效重试设置，按当前可用模型范围反向切换。面板通过 host 的会话控制接口访问，TUI 保留原生选模键位并提供 `/superpi-retry`。 |
| `src/event-verdict.mjs` | 把上面那份判读**挂到 pi 的 `message_end` 上**（0.18.0）：`decoratePiEvent(record)` 只加一个 `verdict` 字段，不改 pi 的任何字段，**永不抛**。它解决了两个结构问题：① 面板不再需要一份孪生判据（0.16.2~0.17.3 的「表在契约、算法在面板」，共同盲区测不出）；② 面板不再依赖 `/contract` 先到（0.17.3 那个「契约晚到 → 提示永久丢失」的竞态随依赖一起消失，而不是靠启动顺序绕开）。装饰发生在 `PiProcess.pushEvent` 里 —— 那是**唯一**同时喂 SSE 与环形缓冲回放的地方。 |
| `extensions/superpi-text-bytes.mjs` | **「什么是坏字节」的唯一判据**（0.18.0）：`scanTextBytes()` 三类 —— `replacement`（U+FFFD，字符的字节已经丢了、不可逆）、`control`（C0 除 `\t\n\r`，外加 DEL）、`surrogate`（孤立代理项：JSON 合法、落盘必坏）。计数全量、位置截断（前 20 处，带行列号）。四个消费者共用：回合判据、写入闸、`test/parity.mjs` §9、`test/host-parity.mjs` 3.98。**为什么必须收成一处**：这三处原本各写一份，而运行时**一份也没有** —— 实测 7 次 `write` 的 content 含 U+FFFD、7 次全部落盘。 |
| `extensions/superpi-text-integrity.ts` | **写入闸**（0.18.0）：`pi.on('tool_call')` 在写盘前拦坏字节 —— `write` / `edit` 的目标路径、`write.content` 或 `edit.edits[].newText` 含坏字节 → `{block:true, reason}`（文件不写）；**`edit.oldText` 放行**（修已坏文件时匹配串必然含 U+FFFD，拦它等于禁止修复）；**`bash`/`powershell` 只提醒不拦**（同一串字节可能是修复脚本），改为在 `tool_result` 末尾追加一行警告。`turn_end` 将已确认被写入闸拦截的参数移出后续模型请求，保留安全路径、调用与错误的配对、原始会话记录。它与同批成功写入共用 `projectTurnAssistant()` 合成投影。拦截理由带行号/码位/总数 + 「文件未写入」+ 「不要原样重发」+ 转义写法。观测落 `~/.superpi/integrity.log.jsonl`（滚动 240 行），`/superpi-integrity` 看汇总与路径。门禁 `test/text-integrity.mjs` 与 `test/reliability.mjs`。取证见 `docs/output-integrity.md`。 |

| `extensions/superpi-modalities.mjs` | **模型模态开关**（0.13.0）的唯一模型层：`RUNTIME_MODALITIES=['text','image']`（pi 运行时**实际能发**的，与 `ContentBlock` 联合类型对账，`test/modalities.mjs` F 段防过期）、`resolveModelModalities(model, overrides)`（可用模态 = `model.input` ∩ 运行时；`unsupported` 显式列出「协议声明但发不出去」的，**不画假开关**）、`allowedModalities()`、`filterMessagesByModalities()`（关掉的模态块→占位文本，非破坏性、text 永不过滤）、`normalizeModalitiesState()`（幂等 + 稀疏：只存非默认项，默认规则将来变了没动过的模型自动跟随）、`createModalitiesStore()`（串行队列 + 原子落盘 + 400 语义）、`readModalitiesStateSync()`（扩展每轮用，mtime+size 缓存）。落盘 `<home>/.superpi/modalities.json`（`SUPERPI_MODALITIES` 可覆盖）。**host 与两个扩展共用它**，所以放 `extensions/`（复制后相对引用仍指向同一份）。 |
| `extensions/superpi-modalities.ts` | 命令行窗口的 `/superpi-modalities`：列模型（scoped 优先，否则全量）→ 选模型 → 逐个切模态（文本锁定、`unsupported` 只读、`恢复这个模型的默认`）。读写与面板**同一份** JSON。**不 hook `context`** —— 过滤只在守卫里执行一次（单一执行点）。异常不外抛。 |

## 3. 100% 对齐 = 不可协商约束

用户 2026-11-12 原话：「全部补齐，并且告诉未来这个项目的你两个端要保持100%对齐」。

- 一条能力要么两端都有，要么两端都明确没有。**不存在「先做一端，另一端以后再说」**。
- 任何当前缺口必须在 `docs/parity.md` 里是一条显式记录（能力名 + 缺什么 + 补齐版本），不允许静默存在。
- 目标态是 `docs/parity.md` 里 **零缺口**。你新增任何能力，同步把另一端补齐，不许把缺口转嫁给下一任。
- 检查动作：`npm test`。它含三套机器门禁 —— `test/parity.mjs`（契约 ↔ pi 类型与官方文档 ↔ `client.js`/`index.js` 的面板覆盖，三向对账）、`test/host-parity.mjs`（`buildSpawnArgs` 与 HTTP 面，0.14.0 起含切帧器线性耗时与历史分页）与 `test/timeout.mjs`（用 `test/fixtures/fake-pi-rpc.mjs` 协议替身把 5 分钟的超时/弹窗时序压到毫秒级实测）。**这三套门禁是本仓库对齐的机器保障，不是可选装饰**：删掉或绕过它，等于把"100% 对齐"退回人肉承诺。

  > **各套门禁的当前规模不写在这里**（0.16.1）。唯一真源是 **`test/gate-inventory.json`**，
  > `test/gate-inventory.mjs` 用 `npm test` 当次的子进程结果对账，**实测值低于登记值即红**。
  > 为什么改成这样：0.16.0 的审查发现本文里散落的 check 数已全面漂移
  > （parity 98→102、host-parity 412→430、context-guard 150→179、tui-editor 459→521），
  > 而没有任何门禁校验它们 —— 数字分散在多处手写副本就必然漂移，
  > 而本文恰恰把这些数字加粗当作「对齐强度」的证据。数字一旦能自由漂移，
  > 它就从「可校验的事实」退化成「曾经的印象」。
  > 查看当前真实规模：`node test/gate-inventory.mjs --list`。

## 4. 新增一个能力的固定流程（顺序不可换）

1. **登记契约**：改 `src/rpc-contract.mjs` 的 `RPC_COMMANDS` / `RPC_EVENTS` / `TUI_COMMANDS` / `EXTENSION_UI_METHODS`。上游权威永远是 `packages/coding-agent/src/modes/rpc/rpc-types.ts`，不是这份文件的注释。
2. **host 可达**：`POST /sessions/:id/command`（`index.js:1037-1082`，`proc.send` 在 `:1059`）通常零改动。注意它做两件额外的事：超时三态归一化（`:1049-1054`，非法值直接 400 而不是静默降级）与剥离 `timeoutMs`（`:1057-1058`，那是本插件的传输层参数，pi 的 `RpcCommand` 没有这个字段，透传即契约污染）。需要新 HTTP 面时才动 `createHandler`（`index.js:809-1117`），并判断该文件是否在 `SELF_FILES`（`index.js:135-147`）的 `runtime:true` 里（是则改完必须重启 DSH）。
3. **客户端接 UI**：`client.js` 三处——`api` 对象（`:932-1006`）加方法、`applyRecord`（`:1708-1857`）加事件分支、面板加控件与 i18n 词条（`ZH` `:36-256` / `EN` `:257-474`，两套键集必须一致）。
4. **更新账本**：`docs/parity.md` 对应行的「面板端状态」改成已实现，补「门禁用例」，并按需改 `## 1/3/4` 末尾的统计数字。
5. **跑门禁**：`npm test`。红了不许提交。
6. **新文件三处登记**：①`SELF_FILES`（`index.js:167-193`，决定 `/selfcheck` 是否盯着它、改动后要不要重启 DSH）；②`tools/install-pi-extension.mjs` 的 `EXTENSION_FILES`（只对 `extensions/` 下的文件）；③`npm test` 流水线（新门禁脚本）。复制清单**不再是手写项** —— `test/version.mjs` / `test/selfcheck.mjs` / `test/fresh-boot.mjs` 统一走 `src/runtime-files.mjs` 的 `copyRuntimeFiles()` 自动发现（0.16.1 把最后一个手写副本也消掉了）。漏一处就会出现「本地绿、装出来缺文件」或「改了没生效」。
7. **新门禁必须登记规模**（0.16.1）：在 `test/gate-inventory.json` 加一条「下限」。判据是**实测 ≥ 登记**，`npm test` 末尾的 `gate-inventory` 会红。若新门禁天然没有数量概念（以抛错为失败方式，如 `selfcheck`），把它加进 `test/version.mjs` 的 `STRUCTURAL_GATES` **并写明理由** —— 两条路必须选一条，不接受「什么都不做」（那正是 F-06 的成因）。
8. **新依赖必须进 preflight**（0.16.1）：门禁需要的 pi / react / jiti 之外的任何外部依赖，加进 `test/preflight.mjs` 的 `DEPENDENCIES`。**禁止在门禁里写「缺了就 skip 并 exit 0」** —— `.runtime/` 是 gitignore 的，新机器必然命缺，那样等于门禁在全新环境下静默不跑而 `npm test` 是绿的（0.16.0 实测：隐藏 `.runtime` 后 521 条 TUI 检查一条没跑，仍 exit 0）。
9. **提交**：`git add` 你实际改的文件。**改代码必须同时升 `package.json` 的 version**（pnpm 对 `file:` 依赖按 lock 里的 integrity 复用 store，版本号不变会把旧内容装回来且 exit=0；`test/version.mjs` 与 `test/parity.mjs:213-218` 都断言版本单一真相）。提交之后跑 **`npm run sync`** 把这次提交同步到线上 GitHub（见第 9 节）——装了钩子的话它会自动在后台推一次，但**离线时不会告诉你欠了多少**，手动跑一次才能看到结论。
10. **推线上**：`npm run sync`（有网）/ 只提交本地（无网，退出码 2）。发布一个新版本时顺手 `git tag -a v<version>` —— tag 由同一条 push 带上去。

## 5. 禁止项

### 5.0 最高优先级：禁止任何形式的「让产品变差」

用户 2026-11-19 原话：**「任何让你在实现目标的过程中中断的、能力降级的、方案委屈求全
（而非求最优）的、降低质量的、降低指标要求的等类似对产品不好的情况，都是不符合产品
发展方向的，都是阻碍，都是应该被消除的都是应该被优化的。」**

完整可判定清单见 **`docs/anti-product-patterns.md`**（6 类 31 条，每条带真实事故对照）。
改任何东西前后都要对表过一遍。**三个必答问题，有一问答不上就不算完成**：

1. 我这版有没有让**任何一条能力**变弱？
2. 我的**指标**是真的变好，还是只是看起来变好？
3. 出问题时，**用户和未来的我**能不能看出发生了什么？

三条最容易被违反、必须单独记住的分支：

- **禁止用「更早的降级」换「更晚的崩溃」。** 例如把小窗口下的固定开销也扣掉，
  会把预算压到地板、守卫疯狂削内容 —— 那不是修，是把问题提前。
- **禁止制造假警报。** 报数字必须以**用户/模型实际感知到的量**为准。
  实例：0.15.0 的上下文仪表第一版只报裁剪前的 96%，而实际发送只有 69.5%，
  模型每轮都看到"接近硬上限"——这是 D1 类失真（报表与实际不符），已改为双数字。
- **禁止静默失效。** 一个机制「跑了但没生效」比它不存在更危险（它会让日志看起来
  一切正常）。实例：`dropOldestTurns` 因三个叠加缺陷从未生效，`droppedTurns` 恒 0，
  而日志里 `overBudget` 恒 true 达上百行。

- **禁止把「管道通了」当成「交付到了」。**（0.16.1 血的教训）
  闭环判据必须落在**用户能感知到的那一端**。实例：`docs/parity.md` 的 D-05 曾把
  「`pendingUi` 随 `snapshot()` 下发」记为已闭环（0.3.0），而面板**从来没有读过这个字段**
  —— 全文件 0 处引用。协议字段发了出去、门禁也断言了 host 侧登记与超时续期，
  但没有一条断言「面板会渲染这个弹窗」。后果：面板刷新时 pi 若正等扩展弹窗，
  弹窗在 UI 上不存在，用户无法应答，命令挂 12 分钟才报 `N dialog(s) never answered`。
  **自检问法**：这条证据说的是「数据发出去了」还是「用户看到了 / 用上了」？
  只有后者算闭环。

- **禁止把「无法验证」当成「验证通过」。**（0.16.1）
  门禁缺依赖时 `SKIP + exit 0` 不是「跳过」，是把这条保障删掉却不告诉任何人。
  实测：隐藏 `.runtime/`（gitignore 的，**新机器必然没有**）后，`parity` 从 102 掉到 87
  仍 PASS，`tui-editor` 的 521 条检查**一条没跑**仍 exit 0 —— 而 AGENTS.md §3 正宣称
  这三套门禁是「100% 对齐的机器保障，不是可选装饰」。
  唯一合法做法：依赖前置断言（`test/preflight.mjs`），缺失即失败；
  真要跳过必须显式标记 `[可选]` 并给出理由。

- **禁止用「文档里的数字」当证据。**（0.16.1）
  同一事实的副本必然漂移：AGENTS.md 里散落的 check 数实测已全面过时
  （parity 98→102、host-parity 412→430、context-guard 150→179、tui-editor 459→521），
  而没有任何门禁校验它们。数字要么只登记一处（`test/gate-inventory.json`），
  要么不写。**本文不再写各套门禁的具体 check 数**，只指向登记表。

- **读时修不好写时的问题：清理必须发生在**它进入系统的那一刻**。**（0.17.0）
  实例：上下文超载。`context` 事件的契约是 "Modify messages **non-destructively**"
  —— 每轮从完整历史重算。实测一个真实会话的 240 轮裁剪日志：
  `before` 恒定 2,849,944~2,919,604、`imagesDropped` **只有 117 一个取值**、
  压缩比恒定 4.40x。三个"恒定"就是「每轮重算同一件事」的数学指纹：
  压到 65 万发出去，历史本体仍是 285 万，下轮从头再切，永不复原。
  **判据**：如果一个"清理"需要**每轮重复执行**才能维持效果，那它治的不是根。
  真正的根治点是 `tool_result`（pi 明确 "Can modify result"，且在最终
  toolResult 写入**之前**触发）。详见 `docs/context-overload.md`。
  同一条原则适用于任何"事后过滤"设计：先问「能不能不让它进来」。

- **统计结论必须看「贡献集中度」，否则单例会被当成规律。**（0.17.0 教训）
  实例：分析 DSML 与图片累计的关系时，得到一张漂亮的单调上升表
  （0 张 0.00% → 65+ 张 4.12%），差一点就据此下结论。
  但一查集中度：**65+ 桶的 36 条畸形 100% 来自同一个会话文件** —— 是案例，不是规律。
  更狠的反证在会话内部：图片从第 318 条就有，畸形到第 1881 条才出现，
  中间 **1563 条零畸形**。
  **强制动作**：任何按桶/分组统计出的差异，先问「这个桶的贡献集中在几个样本上」。
  第二个强制动作：**形态统计要逐条数，不要抽样看** ——
  我看前 2 个样例得出的结论（含 `</thinking>`）与全 36 条的实测（仅 17%）
  完全相反。详见 `docs/dsml-root-cause.md`。

- **输出里出现畸形工具标记 → 本轮不算完成，必须重发那一处。**（0.16.3）
  什么是畸形标记：`<｜｜DSML｜｜invoke name="...">`、`|｜DSML｜｜invoke`、
  残缺的 `invoke`/`parameter` 闭合块 —— 也就是本该是结构化工具调用、
  却被当成正文吐出来的那类产物（成因见 §5.0.1，属解码层问题，不是知识缺失）。
  **判据**：一旦在**自己这一轮的输出里**看到它们，就停下、重发那一刻的正确调用，
  不允许「带着畸形块继续往下做」。已发出的消息里出现也算 —— 下一条必须纠正，
  且不要用「这只是一次小问题」滑过去。
  **为什么写成判据而不是「请自检」**：对一个不知道自己正在写畸形标记的模型说
  「输出前自检」，与说「别出错」同类 —— 不可执行、不可验证，只会成为
  一句永远为真却不起作用的免责声明（正是 5.0「让结果看起来漂亮」那一类）。
  判据在**事后**有效（能检测、能重发），「自检」在**事前**不可执行。
  实测：2026-11-20 一次会话里同类畸形出现 5 次以上，而每次都继续往下做了 ——
  触发点从来不是「不知道规则」，而是「没发现自己已经写了」。
  面板侧的对应能力见 0.16.2（`a4eab7b`：「命令行亮红字、面板完全静默」已修）。

- **坏字节不许落盘：清理必须发生在它成为文件内容的那一刻。**（0.18.0）
  取证见 `docs/output-integrity.md`：2026-11-19~11-23 的 20 个真实会话里，
  **7 次 `write` 的 content 含 U+FFFD，7 次全部成功落盘**；另有 15 次 `bash` 命令
  含坏字节、13 次执行成功。落盘之后不可逆（U+FFFD 里没有原字符的信息），
  只能靠人读回来或用 git 回滚 —— 这正是用户报的「代码错乱」。
  **判据**：任何"模型字节 → 文件内容"的通道都必须过写入闸
  （`extensions/superpi-text-integrity.ts` 的 `pi.on('tool_call')`）。
  **三条边界是刻意的，改之前先读完**：① `edit.oldText` 必须放行（修复入口）；
  ② `bash`/`powershell` 只提醒不拦截（同一串字节可能是修复脚本，拦它 = 禁止修复）；
  ③ 拦截**不减少任何能力** —— 坏字符永远可以用转义表达，被拦下的是一次不可逆的损坏动作。
  同理：**拦截理由必须让模型当场能改**（行号 / 码位 / 总数 + 「文件未写入」+
  「不要原样重发」+ 转义写法），否则它会重发同一串坏字节，而那是徒劳的 ——
  成因在 provider 的流式重组，不在它这一次手滑。

- **「看起来结束了」的协议异常只按可观察的结构判断。**
  判据见 `extensions/superpi-turn-verdict.mjs`。其中 `truncated`（`stopReason: 'length'`）
  与 `corrupt` 是 0.18.0 补的 —— 它们和 DSML 一样满足「agent loop 看不到工具调用 →
  这一轮结束 → 屏幕上没有任何错误提示」。
  **但不要顺手去判「短回复但声称做完了」**：实测 156 条 `stop` 无工具调用的回合里，
  只有 6 条有可判定形态（以 `：` 收尾），其余 150 条读起来都是完整句子。
  语义判断必然产生假警报，而假警报会让人**不再相信真正的提示**（见 §5.0 第一条）。

### 5.0.1 DSML 畸形工具调用的真因：**结构性头部丢失**（0.17.0 定论，务必记住）

> ⚠️ **本节曾被改过两次，前两次都错。**
> - 0.15.1 归因为「上下文占用到 77.8% 后模型退化」→ **错**（把相关当因果），
>   反证：用户后来在 `~46.0%/1.0M` 的会话里仍然复现 DSML。
> - 0.15.4 改为「上下文被裁剪掏空」→ **也错**（本文档标题曾这么写）。
>   反证见下：同一会话里图片从第 318 条就有、畸形到第 1881 条才出现，
>   中间 1563 条零畸形；且 `trimmed` 在 240/240 轮里恒为 true —— 没有区分力。
> - **0.17.0 用 36 条逐条形态统计定论**（`docs/dsml-root-cause.md`，探针
>   `test/dsml-forensics.mjs` 可复现）。

#### 现象
模型把工具调用写成 DeepSeek 原生 DSML（`<｜｜DSML｜｜ parameter>`），
pi 不认识这种格式（`grep -rln DSML node_modules/@earendil-works` 为空），
于是当成**普通文本**收尾（`stopReason: "stop"`）→ agent loop 看不到工具调用 → 本轮结束
→ **用户看到「会话中断」，屏幕上没有任何错误提示**。

#### 真因：只有闭合尾巴，没有开头（36/36 实测）

| 特征 | 命中 |
| --- | --- |
| 有开头 `<｜｜DSML｜｜ invoke` | **0 / 36** |
| 只有闭合 `</｜｜DSML｜｜ invoke>` | 34 / 36 |
| 只有闭合 `</｜｜DSML｜｜ calls>` | 35 / 36 |
| 含 `<parameter name=`（参数文本） | 31 / 36 |
| 同条有结构化 `toolCall` 块 | **0 / 36** |
| 本轮内有 `toolResult`（工具真执行） | **0 / 36** |
| 之后紧跟用户手打「继续」 | **36 / 36** |

**参数文本完整存在，但开头的 `<｜｜DSML｜｜ invoke` 从未进入输出流。**
说明模型已经决定要调用什么（参数都写出来了），丢的是**结构的头部**。
所以问题更可能在**流式解码/组装层**，而不是模型的理解层。

三种可能仍未区分（数据不足）：pi 流式解析、provider 流式重组、模型自身退化。
区分它们要抓原始 SSE 流（`provider_stream_event`）看头部是否到达 —— 这一步没做。

#### 有两种形态，都要识别（0.15.6）

| 形态 | 特征 | 旧判据为何漏掉 |
| --- | --- | --- |
| **A. 正文型** | `stop`，`text` 块里含完整 DSML 三段 | 能识别 |
| **B. thinking 型** | `stop`，**只有一个 thinking 块**，闭合标记在 thinking 里，**无正文** | 只遍历 `text` 块；且 `text === ''` 时直接 `return false` |

形态 B 的原文（真机）：
```
Let me verify empirically.</thinking>
</｜｜DSML｜｜ calls>
```
用户看到的是「屏幕上多了一段独白，然后会话无声结束」。

**判据必须两条都有**：
1. **关键词**：`text` 与 `thinking` **都要看** —— `marker(text) || marker(thinking)`
2. **空转**：`stopReason === 'stop'` 但**既无正文也无 toolCall** → 故障
   （标记可能被 provider 吞掉，不能只靠字符串匹配）

排除项：`thinking + 正文` 正常、有 `toolCall` 正常、有正文正常。
判据在 `extensions/superpi-editor.ts` 的 `isMalformedToolCall`，门禁 `test/tui-editor.mjs`。

#### ⚠️ 别再把上下文规模当原因（0.15.6 的教训 + 0.17.0 的证否）

形态 B 实测发生在**全新会话、86 条消息、8.2% 占用**下 ——
既没超限、也没被裁剪（守卫 `stages` 全为 0），照样发生。

0.17.0 又做了两次更严的排除：
- **图片堆积**：图片 47% 的构成是事实（`docs/context-overload.md`），
  但图片从第 318 条就有、畸形到第 1881 条才出现，中间 1563 条零畸形 → **否定**。
- **thinking 通道串流**：只有 6/36 畸形含 `</thinking>`（正常条也有 9/4234）→ **否定**。

**正确应对是让它可见**（明确告知「本轮未执行，重发即可」），
而不是假装能靠调参修好模型。

**注意**：0.17.0 的「写入时图片限额」治的是**上下文浪费**（图片 47%，收益 -96.6%，
端到端已确证），**它不是 DSML 的修复**。两者必须分开陈述，不能混为一谈。

> 排错顺序应该是：**先看 `stopReason` + `content` 块构成**，
> 再看占用与裁剪日志。反过来会一路怀疑上下文，最后发现与它无关。

#### 真因：裁剪把上下文掏空（不是占用百分比）
守卫的五阶段折叠原本是**一刀切**：某阶段一启动就作用于保护区之前的全部消息，
然后才看是否达标。构造数据实测（窗口 1M、预算 490117）：

| 会话规模 | 裁剪后占预算 | 说明 |
| --- | --- | --- |
| 200 轮 | **90.2%** | 正常 |
| 250 轮 | **6.6%** | 断崖，且 `droppedTurns=0` |
| 300 轮 | **7.4%** | 断崖 |

**明明有 93% 的预算没用，却把上下文掏空了。** 模型拿到「只剩骨架」的历史，
就失去了任务上下文，于是开始吐 DSML。

#### 为什么旧数据看起来像「77.8% 退化」
那个会话的裁剪结果**每次都停在 77.8% 附近**（预算被 0.72 卡住），
所以 DSML 与 77.8% 同时出现 —— 但驱动力是「被掏空」这件事本身，
77.8% 只是那个配置下的巧合落点。

#### 修法（0.15.4）
1. **渐进折叠**：按 24 条一批、**从旧到新**推进，每批估算，达标即停。
   从旧到新保证「前缀只后退」的单调性，prompt cache 不被击穿。
2. **保护区基准与预算同源**：`protectionStartIndex(..., budget)` —— 旧实现用
   `窗口×protectedTokenRatio`（30%）而预算用 `窗口×targetRatio−开销`（46.7%），
   分母不同导致保护区吃掉预算 **64%**，一触发兜底只能丢到保护区边界。
3. **区分两类阶段**（架构性区分，混在一起会双向出错）：
   - **无条件规则类**（`images` / `toolCallArgs`）必须跑完。判据是
     「留着它有独立的价值损害」，不是「token 够不够」：图片最贵且本轮会无限堆积；
     write/edit 正文**已落盘**，上下文留副本零价值。
     被「达标就停」害到过：48 张图只裁到 25 张、参数只降 52.5%（规格要 80%）。
   - **预算救急类**（`thinking` / `toolText` / `toolFold` / `replies`）达标即停。
     被「一刀切」害到过：塌到 6.6%。

#### 裁剪顺序：先动「大块且可降级」的（0.15.5）

这一条是独立于上述修复的架构原则，**改任何分级折叠逻辑都要先看它**。

实测刺眼现象：预算很宽松时（594,974，实际只需 592,582）**thinking 仍被删掉 294 条**，
而 `toolFold` 只折 6 条就达标了 ——「先牺牲了最不该牺牲的东西，然后马上就够了」。

量化（真实会话单条消息的估算 token）：

| 内容类型 | 单条 token | 折叠/删除后的可恢复性 |
| --- | --- | --- |
| `toolResult` | ≈ **2,000** | 折成首行摘要，**仍有线索**（跑了什么、结果是什么） |
| `thinking` | ≈ **206** | **彻底消失**，无法恢复 |

**折一条 toolResult 换来的空间 ≈ 删掉近 10 条 thinking**，而后者信息损失大得多。

所以顺序必须是（信息可恢复性从高到低）：

```
images → toolText → toolFold → toolCallArgs → replies → thinking（最后）
```

效果：`targetRatio` 为 0.72 / 0.62 时 thinking 删除量都是 **294 → 0**，
代价只是 toolFold 从 6 条增到 36/90 条。**纯质量提升，无副作用。**

> 通用原则：**按「单位信息损失换来的空间」排序，而不是按"哪个阶段代码在前"**。
> 每次新增裁剪阶段，都要回答两个问题：
> ① 它单条能省多少 token？② 动过之后还能不能读回/推断？
> 省得少又损得多的，必须排最后。

#### 门禁
`test/context-guard.mjs` 的 **C9** 段锁住「利用率不许断崖」这个性质本身：
触发裁剪后利用率 >= 80%、相邻规模跌幅 < 20 个百分点、渐进折叠足够时 `droppedTurns` 必须为 0。
做过**门禁自验**：把 CHUNK 改回 1e9（复原一刀切）→ C9 立即红（6.7%、跌幅 85.8）。

> **`targetRatio=0.62` 仍然保留**，但理由不再是「77.8% 退化线」，
> 而是「留出足够余量给裁剪的不确定性」。C7 段里关于退化线的表述属于**未被证实**的推断，
> 不要把它当作定论去推导其它参数。

### 5.0.2 排查「会话中断」的正确顺序

用户报「中断」时，**先分清是哪一种**，不要一上来就查网络：

1. **`stopReason` 是什么？** `error` → 看 `errorMessage`（网络/超限/限流）；
   **`stop` 但用户预期还有工具调用 → 看正文里有没有 `DSML`**（见 5.0.1）。
2. **`timeout` 不会中断会话。** 它是命令级限制：超时 kill 进程树 → `throw ShellTimeoutError`
   → 被工具层捕获成 `isError` 的工具结果 → agent 继续下一轮。
   `stopReason` 里出现工具超时的次数应当为 0（实测 1903 次 `toolUse` 无一来自超时）。
3. 查会话文件 `~/.pi/agent/sessions/<project>/*.jsonl`，按 `usage.totalTokens` 分桶统计
   异常发生率 —— **上下文规模与故障类型的相关性往往一眼可见**，比读代码快得多。

### 5.0.3 扩展往系统提示写东西，必须「同档逐字节稳定」（0.15.2，血泪）

**这条是 400 `invalid JSON request body` 的真因，而且是我自己造成的。**

pi 的系统提示是「结构化 sections + diff」：

```js
// agent-session.js:1392  _preparePromptAndToolLoadout
const sections = diffSystemPromptSections(
  getCurrentSystemMessage(messages)?.sections ?? {},
  buildSystemPromptSections(options),
)
return sections ? { role: "system", content: "", sections } : undefined
```

**有变化就追加一条 `{role:"system"}` 进会话历史。** 这个增量协议本身很好 ——
缓存因此满血工作（实测 cacheRead 813k / cacheWrite 仅 ~200）。

但推论必须记住：**「每轮都变的内容」= 「每轮一条 system」= 请求体持续膨胀**。
真机触发点：历史里累积 9 条 system、其中一条是 45KB 的 `project_context`，
然后 provider 直接拒绝整个请求。

#### 三条硬规则

1. **动态内容绝不进系统提示。** 哪怕它"看起来很有用"。
   实例：「当前目标」取最近一条 user 的首行，每轮必然不同（`回复 ok1` → `ok2` → `ok3`），
   5 轮就产生 5 条额外 system。而它同时是**零收益**字段 —— 模型刚读完用户消息，
   不需要系统提示再复述一遍。**目标信息应该给面板/Working 行看，那是真正需要它的一方。**
2. **必须注入的数字要量化到档位。** 百分比 → 5% 档；构成比例 → 10% 档；
   量级信息 → 25% 档；**不报绝对 token 数**（它每涨 10k 就改写文本）。
   判据：同一档位内文本必须**逐字节一致**。
3. **别指望 `sections[key] === block` 能短路。**
   `runner.js:1130` 每轮用 `normalizeBuildSystemPromptOptions(systemPromptOptions)`
   **重建** options —— 拿到的 `sections` 是「当前系统提示的构成」，
   **不含上一轮扩展临时塞进去的 key**。所以那个短路一次都不会命中。
   要自己用模块级变量记住上次写的内容（`lastMeterText`），并在会话切换时重置
   （`resetMeterMemo()`）。

#### 不要用 `forceSystemPrompt` 绕开
返回 `systemPrompt` 确实不写历史，但它要求**每轮整份重放系统提示**，
会直接击穿上面那个 cacheRead 813k 的缓存，成本上升一个量级 ——
那是「为修一个问题而引入更贵的问题」，属 C 类反模式。

#### 验证方式（必须真机）
单测看不出这个问题（它只测纯函数）。真机做法：spawn `pi --mode rpc`，
连发几轮 `{type:'prompt', message:'...'}`（**字段名是 `message`，不是 `prompt`**），
收集 stdout 的 JSONL，统计 `message_end` 里 `role==='system'` 的条数。
健康值：**远小于轮数**（实测修复后 5 轮 3 条；改前 5 轮 10 条）。

<!-- RULE-TMP-PATH -->
- **禁止用 `/tmp` 在工具之间传文件。** `/tmp` 不是一个目录，是**三个**：bash 里它是
  `C:/Users/<me>/AppData/Local/Temp`，node 与 python 里它是 `D:/tmp`（实测，2026-11-18）。
  跨工具读写时路径必然对不上，而症状是「文件明明刚写过却不存在」—— 排查方向会被引到
  「写入失败」上，实际是「两个不同的 /tmp」。一次性产物一律落 `_scratch/`（仓库内、
  已被 `.gitignore` 忽略），用完删掉；跨工具传路径时**只用同一个绝对路径字符串**。

- **禁止用 heredoc / `sed -i` / python 三引号往代码里写含反斜杠的内容**（正则、`\n`、
  Windows 路径）。多层 shell 转义会吃掉一层：实测 `^---\n` 会变成真正的换行、
  `[\s\S]` 会变成 `[sS]`，文件语法直接坏掉，而 `bash` 不报错 —— 只看得到
  「Unexpected token」。含反斜杠的内容一律用 `write` 工具落成文件，或写成
  `String.fromCharCode(92)` 拼装；**改完立刻 `node --check <file>`**（0.1 秒），
  漏掉就是几十分钟的瞎猜。

- **改完一个文件立刻用工具验语法，不要靠"我写过应该对"**：`node --check <file>` 对
  `.js/.cjs/.mjs`，`jiti` 或门禁对 `.ts`。这一步是四十分钟与零秒的差别 —— 2026-11-18
  一次 heredoc 事故就是这么烧掉的。


- **禁止在 `tools/restart-dsh.ps1` 里用 `Start-Process -FilePath $exe` 重启**（0.4.2 之前的老实现）。桌面实例的启动命令行带 6 个参数，裸起等于换个东西启动。重启必须走 `Get-LaunchSpec` + `ProcessStartInfo`，参数一个字节都不重排。
- **禁止给 pi 打补丁（2026-11-17 用户明确禁用）。** 不许改 `node_modules` 里 pi / pi-tui 的任何文件，不许 wrap 它们已打包 chunk 的原型方法，不许替换 bundle 里的函数体 —— 哪怕「可回滚 + 幂等标记 + 备份」也不行。要补能力只能走两条路：① pi 的**官方扩展点**（`pi.on()` / `registerTool` / `registerCommand` / `ctx.ui.setEditorComponent()` / `ctx.ui.custom()`，见 `docs/extensions.md`）；② `docs/parity.md` 记为显式缺口交上游。0.9.2 的教训：先做的补丁版（wrapper chunk）已全部删除回退，最终用 `extensions/superpi-editor.ts` 这个官方扩展实现同一能力。

  **唯一的例外：`piConfig` 品牌配置（2026-11-17 用户明确授权）。** pi 官方文档
  `docs/cli-integration.md` 有一节就叫 **“Fork and rebrand Pi”**，明示用 `package.json` 的
  `piConfig.name` 可以改 CLI 品牌名，并说明它影响 "the CLI banner, configuration paths,
  and derived environment variable names"。这是**配置面而不是补丁**：不改任何 .js、不 wrap 任何方法。
  工具 `tools/brand-pi-runtime.mjs`（`--apply/--revert/--status`，幂等），门禁
  `test/brand-pi-runtime.mjs`（规模见 `test/gate-inventory.json`）。两条铁律：
  ① **只改 `piConfig.name`，`configDir` 必须保持 `.pi`** —— 用户的 9 个项目历史会话都在
  `~/.pi/agent/sessions`，把 configDir 改成 `.superpi` 会让 pi 去新目录找、历史会话全部读不到；
  ② **必须幂等且可重跑** —— `pnpm add` / `npm install` 会用 registry 上的原始 package.json
  覆盖本地改动。插件启动、一键安装、CLI 入口与安装脚本共用 `extensions/superpi-brand.mjs`。
  两端共用 `src/runtime-extensions.mjs` 的目录解析，优先使用 `SUPERPI_CODING_AGENT_*` 并兼容 `PI_CODING_AGENT_*`。
- **禁止以「UI 没做」为由在 host 或协议层留缺口。** 缺的是 UI 就说缺 UI，别把能力做成半截。
- **禁止把斜杠命令当普通文本发给模型。** `/compact` 走的是 `compact` 命令，绝不能当 prompt 发出去——pi 的 RPC prompt 通道只认扩展命令、`/skill:`、prompt template（`agent-session.ts:2410-2445`），TUI 那 27 条内置命令在 RPC 侧一条都没有。输入一律先过 `classifyInput()`，`handleSlash`（`client.js:5667-5673`）按 disposition 五路分流。未知斜杠照发是 pi 的既有语义，不要"顺手修"。
- **禁止硬编码本机绝对路径。** pi 可执行与 node 必须走 `src/pi-runtime.mjs` 的解析链（config → 环境变量 → 插件 `.runtime` → 插件 `node_modules` → 逐级 walk-up → pnpm store → 全局 npm）。
- **禁止删除或降级既有测试。** 测试红了修实现，不许改断言、不许 skip。
- **禁止 `client.js` 使用白名单外模块。** 只允许 `react` / `react-dom` / `jsx-runtime` / `@deepseek-ai/dsh-client-ui-primitives`。
- **禁止非 `--dsw-*` 的颜色。** 明暗判据是 `body[data-ds-dark-theme]`。
- **禁止在 `index.js` 或 `src/*.mjs` 里静态 import `@deepseek-ai/*`。** 会让插件 fiber 永久 pending、DSH 启动卡死。`@deepseek-ai/schemastery` 是唯一例外，且必须动态 `import()` + 兜底。
- **禁止手工往 `node_modules` 塞副本，禁止在 profile 里用 `npm install`。** 安装只走 `install-plugin.ps1` 或 `pnpm add file:`。
- **禁止在本会话里跑 `tools/restart-dsh.ps1`。** 它会关掉你正在用的 DSH 窗口，把你自己一起杀掉。交给用户手动执行。

## 6. 上游已知缺陷（只记录，不修）

| 编号 | 缺陷 | 影响 |
| --- | --- | --- |
| — | **`set_session_name` 在会话未命名时可能抛 `Cannot read properties of undefined (reading 'slice')`（pi 1.5.2）** | 面板侧原样透出错误文本，不做吞掉。注意：全量 grep pi 源码未找到对应的 `slice` 调用，根因**未证实**，不要在注释里编造行号。真正修要上游改。 |
| `D-07` | 原生 `RpcSessionState` 无 `autoRetryEnabled` | 0.44.0 起面板从 Pi 扩展查询有效值，TUI 通过 `/superpi-retry` 查看和修改。 |
| `D-08` | 原生 `cycle_model` 无方向参数 | 0.44.0 起面板从 Pi 扩展执行反向切换，两端均支持 `Ctrl+Shift+P`。 |

## 7. 验证命令

故意制造错误来验证测试时，把变异和验收命令交给 `verify` 的 `snapshot` 模式。测试退出码和截止时间都要保留。任务收尾使用 `task_progress` 核对目标及验收证据。

```powershell
npm test                                        # 按依赖顺序运行离线门禁，每套执行一次
                                                # preflight（依赖前置断言，缺 pi/react 直接红）
                                                # → selfcheck → client-render
                                                # → css-tokens → runtime-resolve → config-hot
                                                # → host-parity → session-projects → session-lifecycle
                                                # → timeout → rules → context-guard → modalities
                                                # → turn-verdict → text-integrity → reliability
                                                # → parity → tui-editor → brand-pi-runtime
                                                # → restart-lib → github-sync → version
                                                # → 汇总各套当次执行的规模
                                                #
                                                # 各套的 check 数不写在这里：唯一真源是
                                                # test/gate-inventory.json（实测低于登记值即红）。
                                                # 看当前真实规模：node test/gate-inventory.mjs --list
                                                # 耗时大头：github-sync（真 git 跑完整同步）、
                                                # restart-lib（起 pwsh 7 + 5.1 各跑一遍）
npm run test:all                                # 全量离线门禁，加真实模型冒烟和图片写入验证
npm run test:preflight                          # 只做依赖探测（缺什么、怎么装）
npm run check:carriers                          # 巡检本机已配置的个人技能、工具和记忆
npm run test:inventory                          # 只做门禁规模对账（--print 打印实测值）
npm run test:lifecycle                          # 只跑会话池生命周期门禁
npm run test:rules                              # 只跑用户自定义规则门禁（含真 .ts 扩展层）
npm run test:verdict                            # 只跑回合判据门禁（异常形态 + 真渲染）
npm run test:delivery                           # 真 Pi SDK：隔离验证、证据、恢复与模型输入
npm run test:reliability                        # 真 Pi RPC + 本地流式故障场景
npm run test:engineering                        # 工程评分与对照运行；离线验证同一起点、完成事件和进程时限
npm run test:integrity                          # 只跑写入闸门禁（含 pi 真 ExtensionRunner 跑 block 链路）
npm run test:tui                                # 只跑输入框扩展门禁（jiti 加载真 .ts + pi 真 CustomEditor + 真按键序列）
npm run superpi:editor                               # 把 extensions/superpi-editor.ts 装进 pi（<piAgentDir>/extensions/）
npm run superpi:editor:status                        # 只读：源/目标/内容是否一致/pi 版本
npm run superpi:editor:remove                        # 卸掉，pi 下次启动恢复原始输入框
npm run test:github                             # 只跑线上同步门禁（临时裸仓库，不联网、不碰 origin）
npm run sync                                    # 把本地提交同步到 GitHub（0 已同步 / 2 离线待补推 / 3 要人处理）
npm run sync -- --status                        # 本地 vs 线上差多少提交、钩子装没装
npm run hooks                                   # 装 post-commit：每次 commit 后台自动试推一次
npm run test:fresh                              # 全新机器：无运行时 → missing → 一键安装 → 能开会话（需网络）
pwsh -NoProfile -File tools\standalone-verify.ps1   # 全新 DSH_HOME 自证（装 tarball、起独立端口、跑一轮、清理）
pwsh -NoProfile -File install-plugin.ps1 -Profile desktop   # 装进 desktop profile（含 rollback 脚本）
```

`npm test` 是提交前的最低门槛；碰了协议、UI、运行时解析的改动必须再跑 `test:all` 或 `standalone-verify.ps1`。`test/client-render.mjs` 需要 `react`/`react-dom`，本仓库刻意不带 `node_modules`，它从同级 `pi-main/node_modules` 借，借不到就 SKIP 并退出 0。

`test/fixtures/` 放两类「不能在门禁里自造」的东西：`fake-pi-rpc.mjs`（pi RPC 协议替身，`FAKE_PI_MODE=dialog|silent` 让超时语义可以在毫秒级被实测，`test/timeout.mjs` 用它）与 `pi-ext-ui-probe.ts`（真扩展，**只能靠真人点击验证**——扩展 UI 的九个 method 没有替身能覆盖「用户到底点了没」。用法写在文件头：复制到 `%USERPROFILE%\.pi\agent\extensions\`、重启 pi 会话、依次跑 `/dsh-ui-probe` 与 `/dsh-ui-notify`、验完删除）。

## 8. 现状快照（2026-11-18 · v0.10.0）

- **RPC 命令**：pi 侧 33 条，面板已实现 32 条 + `steer` 1 条走等价路径（`prompt` + `streamingBehavior:'steer'`，`client.js:5067`），缺口 0。
- **扩展 UI**：9 种请求全部已实现（`applyExtensionUi()` `client.js:1661-1706`），3 种应答全通（`POST /sessions/:id/respond` `index.js:1083-1102`）。倒计时取 `min(pi 声明值, 5 分钟兜底)`（`dialogBudgetMs()` `client.js:1646`，`DIALOG_FALLBACK_MS` `src/rpc-contract.mjs:260`），且 host 侧命令 timer 会为挂起的弹窗让位（`restartPendingTimers()` `src/pi-rpc.mjs:490`）——**这两侧必须同时成立**，否则就是 0.2.5 那个「红条与对话框并存」的缺陷。
- **事件**：25 类 = 已实现 22 + 显式忽略 3（`turn_end` / `agent_end` / `summarization_retry_attempt_start`，理由见 `docs/parity.md` §3），缺口 0。
- **TUI 斜杠**：27 条 = 已实现 17 + 仅命令行 9 + `unsupported` 1（`/import`）+ 缺口 0。
- **`D-03` 已闭环**：「新会话」`runNewSession` → RPC `new_session`（与 `/new` 同一条路径，同进程换树，`client.js:5236`）、「重连」`endSession`（换子进程，旧事件缓冲丢掉，`client.js:5248`）。0.2.5 把换进程当新会话，同一件事两个入口两种结果。0.7.0 起重连不再占顶栏明面 —— 它退进 `⋯` 更多菜单并要过二次确认（见 0.7.0 那段），因为换子进程是恢复手段而不是日常动作。
- `D-07` 和 `D-08` 的原生 RPC 边界在第 6 节记录。SuperPi 通过会话控制扩展闭环，两端行为由回环测试与渲染门禁保护。
- **工作区选择（0.4.0）**：入口统一叫「选择工作区」（`pickDir`/`dirTitle`/`dirHere` 三处 ZH+EN 同改），交互从铺满面板的抽屉改成 680x500 居中模态（用法 `client.js:4097`，CSS 定义 `client.js:800`；`.superpi-dialog-wrap` + `.superpi-dir-dialog`，`role="dialog"`/`aria-modal`）——它是打断当前会话的决策。新增「此电脑」盘符层：`GET /directories` 下发 `roots`（Windows 探 A-Z 各盘根，10s 缓存 `ROOTS_TTL_MS`），否则从工作区逐级往上只能走到当前盘根，D:/E:/F: 上的工程永远选不到。
- **过程行（0.4.0）**：工具调用 / 工具结果 / `!` bash 三类行去掉圆角卡片外壳（`border-radius:0`、`background:transparent`、无 hairline），改平铺行 + 展开区左侧竖线，与 `.superpi-think` 同一套语言。一次任务十几条工具卡若每条都套圆角 + 描边，会形成框套框的噪音墙。
- **会话历史对账（0.4.1）**：`attach` 之后补一次 `get_messages` 整表重建（`messagesFromHistory()`，`client.js` 内由 `hydrate()` 调用）。根因：`new_session` / `switch_session` / `fork` / `clone` 成功后 host 会 `proc.resetEvents()`（`SESSION_REPLACING_COMMANDS`，`index.js:100`）把事件缓冲清空，历史消息不再以事件重放 —— 只靠 `snapshot` 重放的话切过去必然空白（0.4.0 及之前「点开历史会话没有内容」）。两道防线：会话已切走则丢弃响应（`sessionRef.current !== id`）；`busy` 期间不覆盖列表，改挂 `hydratePendingRef`，由 `drainHydrate()` 在 `agent_settled` 之后补。`bashRef` 语义不变（仍只表示「bash 正在跑」，Esc `abort_bash` 依赖它）。
- **重启脚本（0.4.2）**：`tools/restart-dsh.ps1` 重写，杀的是**启动根**并按**原命令行原文**重建（`ProcessStartInfo.Arguments`），环境变量按目标实例 `/selfcheck` 报的 `root` 反推 `DSH_HOME`、清 `DSH_PORT`、`ELECTRON_RUN_AS_NODE` 按需设；推不出来 `exit 3`，脚本自己在目标实例内部时也 `exit 3`（`-Force` 可越过），`-Plan` 只打印计划。旧实现三处缺陷：`Start-Process -FilePath $exe` 丢 6 个启动参数、杀宿主 pid 导致没人重新拉起、继承 `ELECTRON_RUN_AS_NODE=1` 等污染环境。库模式 `$env:SUPERPI_RESTART_LIB=1` 只加载函数，供测试不触动真实例。
- **历史会话两级（0.5.0）**：`/resume` 抽屉改成「项目层 → 会话层」，与命令行 pi 的 `SessionSelectorComponent` 同构。根因是 0.4.2 及之前 `SessionsSheet` 把当前 `meta.cwd` 当唯一过滤条件、而 host `listHistory` 在 `cwd` 为空时回落 `detected.workspace`，抽屉永远只列得出一个项目。现 `GET /sessions/history?scope=all` 返回全部项目 + `projects` 聚合（`groupSessionsByProject` 排序规则逐条照抄 pi：当前项目置顶 → 非临时优先 → 最近活动降序，临时目录判定沿用 `TEMPORARY_PATH_PATTERNS`）；`scope=project&cwd=` 只列该项目。跨项目切换后 `proc.sessionCwd` 由会话文件 header 的 `cwd` 回填（`readSessionCwd`）—— `get_state` 不回报 cwd，不补这一步面板的「当前工作区」会一直是子进程的 spawn 目录。`MissingSessionCwdError` 翻成中文提示：pi 的 RPC 面没有 `cwdOverride` 分支（`rpc-mode.ts:624-630`），面板替不了用户选「换目录继续」。
- **文件标签与任意文件（0.6.0）**：助手回复里的文件路径变成可点标签 —— 段落正文、行内反引号、以及「围栏里整块只有一条路径」三种形态都认；点开走 `ctx.sidebarRight.openResource('dsh-resource://file/session/<DSH 会话>/<路径>')`，由 DSH 内置 `documentpreview` 渲染，插件绝不自造预览 UI。识别的原则是「宁可少认，不要误认」：URL 排除、裸文件名必须命中扩展名白名单（`FILE_BARE_EXT`）、末段必须带扩展名，否则 `/model`、`v1.2.3`、`example.com` 都会被误标。地址一律 session 作用域 —— `absolute` 作用域没有授权会话，读出来是 `workspace-file/unknown-workspace`。服务用 `ctx.get('sidebarRight')` 惰性取（**写进 `exports.inject` 会让 entry 永久 pending 卡死 DSH 启动**），取不到 / 当前没有正在显示的会话时才回落面板内 `FileSheet`，且必须 notice 说明原因。Composer 的附件按钮与粘贴同步放宽到任意文件与压缩包：图片仍走 ImageContent，其它文件按 pi TUI `handleClipboardPaste`（`interactive-mode.ts:3278-3318`）的语义把**绝对路径文本插进输入框**（RPC 契约 `prompt/steer/follow_up` 只有 `images` 字段，没有任意文件附件通道）；路径来自 preload 暴露的 `window.__DSH_HOST_PATHS__.pathFor(file)`（只在桌面 App 的 `dsh-app://app` 存在，浏览器里取不到就明确提示改用 @ 补全）。
- **输入区与关闭入口（0.6.1）**：三处一起改。①Composer 底栏拆成 `.superpi-bar-actions`（目录 / 附件 / busy 时的排队与停止）与 `.superpi-bar-right`（提示语 + 发送），提示语位置固定、不再被 busy 时多出来的按钮挤动；附件按钮从产品 logo `PiIcon` 换成真正的回形针 `PaperclipIcon`（原来用品牌图标表示附件，语义错位），并按 `busy` 切换文案 `composerTipIdle`（Enter/Shift+Enter/`/`/`@`/`!`）与 `composerTipBusy`（steer/Alt+Enter/Esc）；`composerHint` 只留「给 pi 说点什么…」——原来把五条快捷键全塞进 placeholder，一开始输入就消失、窄面板还会被截断。②抽屉与弹窗右上角统一成 `CloseButton`（`superpi-btn-icon` + 16px `CloseIcon`，32×32 命中区）；改之前是纯文本 `'×'`（11px、无 `-icon` 类），且 `Sheet` 带 `type="button"`、`DirSheet` 不带，两处已分叉。`ExtensionDialog` 也补了 `.superpi-dialog-head`（h3 + 关闭键，语义等于取消）。③文件标签右键 → `POST /api/superpi/reveal` → host 用 `explorer.exe /select,<文件>` 在资源管理器里定位（macOS `open -R`、Linux `xdg-open` 父目录）；`revealInFileManager` 只等 `spawn` 不等退出码 —— explorer 把命令转交给已有实例后常以非 0 退出，信它就会把成功报到失败。标签同时只显示类型图标 + 文件名（`data-kind` 六类：code/image/archive/sheet/doc/file），不再显示目录尾巴。
- **输入区重做（0.6.2）**：composer 整体换成宿主主对话区的语言 —— 卡面 `.superpi-box` 用 `--dsw-radius-panel`（28px）+ `--dsw-specific-input-major` 底 + `--dsw-elevation-soft` 投影、顶部 `padding-top:8px`、`gap:12px`，聚焦时只把 `--dsw-elevation-stroke-color` 局部覆盖成品牌色（不再整框换 border，描边由 elevation 的第一层表达）；`textarea` 无边框、`padding:4px 8px 0 14px`、`caret-color` 用品牌色、placeholder 用 `--dsw-alias-label-caption`。行内左侧从「目录 / 附件 / 排队 / 停止四个文字按钮」改成宿主的「28px 圆形 `+` + 模型 picker + 推理档位 picker」，右侧是「带状态切换的发送键」——空闲为 34px 圆形 `--dsw-alias-button-info-fill` 底 + `ArrowUpIcon`（`:disabled` opacity .4），运行中同一位置换成 `StopSquareIcon`（`Esc`），不再并排两个按钮。`+` 弹出 `AddMenu`：按「添加 / 指令」分组，每项 = 图标 + 主标签 + 英文键名 + 右侧灰色说明（宿主同款两列），条目全部映射到面板已有能力（文件 `pickFiles` / 工作区 / 历史会话 / 压缩 / 模型 / 推理等级 / 统计 / 设置 / 快捷键 / 新会话），**不伪造 pi 侧不存在的 goal / plan / feedback / todo**。底部统计行（`footer`）搬进 composer 容器、卡下方居中，内容 = 会话状态（steering / 排队 / 会话文件）+ 中点 + `get_session_stats` 的「N 轮 · N 步 · N tok · 缓存命中 N% · 上下文 N%」（缓存命中 = `cacheRead/(input+cacheRead+cacheWrite)`，与 pi TUI footer 同公式；tok/s 无可靠来源故不显示），只在 `agent_settled` 后拉一次（`flush` 里与 `loadCommands` 同一位置）。模型 chip 与思考档位 `<select>` 从头部移入 composer —— 它们决定「下一条怎么发」，属 composer 语义。
- **composer 首次填充与 dock 归位（0.6.3）**：0.6.2 落地后实测暴露两处。①统计行首次进入面板 / 切到历史会话时是空的 —— `footerStats` 只在 `agent_settled` 后拉，而刚 attach 的会话没有 settle 事件。现 `attach()` 尾部（`openStream` + `flush()` 之后）与 `reload()` 的 then 链尾各补一次 `loadFooterStats(id)`，这两个点是「会话已就绪、事件已回放完」的唯一入口。②统计行混进 `meta.sessionFile` 的完整路径，把「N 轮 · N 步」挤到换行、视觉重心变成一串路径 —— 宿主的 dock 只有用量数字，路径属于「会话统计」抽屉，那行已删。③`composerHint` 改宿主口径 `给 pi 说点什么, / 调用指令, @ 文件`（`Say something to pi, / commands, @ files`）：0.6.1 的「给 pi 说点什么…」只剩一句话，用户看不出这里能敲斜杠和 @（仍不含 `Enter`，两个既有断言照旧通过）。
- **过程流按 DSH 会话过程流重做（0.6.4）**：把 0.4.0 的「无壳平铺行」再往下对齐一层，形状照抄 DSH 会话过程流（实测截图）：**思考是父行、工具调用是它下面的子行组**。父行 = `details.superpi-proc` > `summary.superpi-proc-head`（16px 图标 + 灰 label + 2×2 中点 + 首行摘要 `superpi-proc-text`，全文在 `div.superpi-proc-body`）；子行组 = `div.superpi-sub`（`margin-left:26px` 让左侧 1px 竖线落在父行 label 左缘、`padding-left:12px` 让子行图标距竖线 12；0.8.0 把行距也拉齐：子行行盒与父行同为 24px、组内 `gap:8px`，子行步长 32 与父行同节奏 —— 0.6.4 那版是 22px/8px + 16px 行盒 + gap 0，行距只剩父行一半，已被推翻）；正文 / 图片把过程流切段，之后重新起组。**一次调用 = 一行**：`toolResult` 消息按 `toolCallId` 建 `results` 派生表（`{text,isError}`，是 `view.messages` 的派生视图、不是额外状态）传进 `MessageRow`，命中即折叠进调用行的展开区（`── output ──`），孤儿结果仍单独渲染。行内词汇**不自己造**：思考 / 运行命令 / 读取 / 读取图片 / 写入 / 编辑 / 搜索文件内容 / 查找文件 / 浏览目录 / 工具调用，全部取自 DSH 官方标题表 `research/layout/dsh-client-ui-conversation__lib__client.js:16731-16748`；未知工具兜底「工具调用 · <工具名>」，兜底规则照抄 DSH `toolRowModel` 的摘要拼接（`:338`）；`read` 命中图片扩展名自动切「读取图片」。图标按工具名在 `TOOL_VIEWS`（`client.js:2275`）静态映射 7 个新图标（ThinkIcon/HashIcon/TerminalIcon/FrameIcon/SearchIcon/PencilIcon/SparkIcon），**不按参数猜**。末尾工作状态行 `WorkingRow`（`client.js:2448`）：`.5px` 上 hairline + 16 网格鲸鱼尾 `WhaleTailIcon`（`client.js:2055`，照抄 DSH `RunningWhaleTail` 的 `REST_PATH`）+ `--dsw-alias-label-deep-diving` 蓝字（#345EBA）+ 「深度求索中，用时 X分Y秒 ···」（单位之间无空格）—— 计时器挂在节点自己身上（1Hz `setInterval` + cleanup），**不放面板级 repaint**（否则每帧重算上百行流式 markdown 只为刷一行字）；`busySince` 由幂等 `markBusy` / `markIdle`（`client.js:1487` / `:1492`）维护 —— `busy` 有 5 处赋值点（`agent_start` / `turn_start` / `agent_settled` / `resync` / `attach` + EventSource `exit`），散着写必漏记或残留，且**已在忙就不重置起点**，否则一轮任务里每重连一次计时归零。旧词表 `tool` / `result` / `busy` / `thinkingLabel` 四键随之删除（留着会让下一任分不清行标签的真相源）。另修两处门禁抓不到的缺陷：`MessageRow` 里 `groups` 数组只当计数器用（改 `groupCount`）、`usageLine` 返回 null 时仍推一个空 div 白占 8px 行距（`.superpi-body` 是 `gap:8px` 的 column）。工作状态行**最终照抄 DSH `RunningStatus`**（`dsh-client-ui-chat/lib/client.js:6386-6429`）：文案 `deepDiving`=「深度求索中」、`working`=「深度求索中，用时 {duration} ···」（结尾三个 `U+00B7`，与 DSH `chat.deepDivingFor` 一致）、时长按 `formatRunDuration`（`:5847-5880`）三段拆 —— `durHour` 仅 hours>0、`durMin` 仅 total≥60、`durSec` 恒有（`fmtDuration` `client.js:3350`）；颜色 `--dsw-alias-label-deep-diving`、字号 `calc(var(--dsh-content-font-size,14px) - 2px)`（实测 12px）、行高 `calc(22px + delta)`（22px），均与 DSH `.running` / `.runningContent` 同值。中途曾因 `research/` 全目录 grep「深度求索」= 0 命中而自造灰字 + 星形，拿到目标像素色值后推翻。**拼接零差异**：单位之间的间距由词条自带 —— 中文 `durMin`=「{n}分」/ `durSec`=「{n}秒」不带空格（目标图正是「43分54秒」），EN `durMin`=「{n}m 」/ `durHour`=「{n}h 」带尾空格，`fmtDuration` 用 `parts.join('')` 拼，与 DSH `formatRunDuration(...).map((part) => part.text).join('')` 完全同一拼法。早先中英都用 `join(' ')` 会在中文里多出一个半角空格，实拍对比才看出来。无障碍侧另加 `span.superpi-sr[role=status][aria-live=polite]` 只播报不带秒数的 `deepDiving` —— 否则读屏每秒被刷一次。
- **弹层化重构与改名 SuperPi（0.7.0）**：八项一起改。①模型名与思考档位共用一个**向上弹层** `ModelPicker`（`client.js:3258-3308`，`.superpi-picker-menu` 用 `bottom:calc(100% + 6px)` 定位在按钮上沿），两段标题「切换模型」/「思考档位」，行 = `button.superpi-picker-row[role=menuitemradio][aria-checked]`，当前项内描边用 `--dsw-alias-state-business-primary`，Esc / 点外面关闭照 `AddMenu` 同一套 useEffect；原生 `<select>` 叠层方案（`.superpi-picker-wrap` / `.superpi-picker-native`）整族删除 —— 键盘可达性靠 button + `aria-checked`，不再靠隐藏 select。弹层是**受控**的（`PiPanel` 持 `pickerOpen`，Composer 只发 `onOpenPicker` / `onClosePicker`），因为模型列表要由面板去拉 `get_available_models`、Composer 不该知道这件事。②会话统计（`StatsSheet` `client.js:4168`）与设置（`SettingsSheet` `:4213`）换成居中弹窗 `Dialog`（`:3148`，`.superpi-dialog-wrap` + `role=dialog` + `aria-modal`，`wide` 时 `.superpi-dialog-wide` 560px）；历史会话换成左侧滑出 `SidePanel`（`:3164`，`.superpi-side-wrap` 遮罩 + `.superpi-side` `width:min(360px,86%)` + `@keyframes superpi-side-in`）—— 它是「按项目 → 按会话」两级浏览，盖住整块面板会让人以为离开了对话。③顶栏删掉「下一个模型」「下一个思考档位」两个快捷按钮（`Ctrl+P` / `Shift+Tab` 仍在，`hotkeyText()` `:6072` 照旧列出），把「压缩上下文」「重新连接」收进 `⋯` 更多菜单 `MoreMenu`（`:3205`，184px 右对齐下拉）+ 二次确认 `ConfirmDialog`（`:3190`，`role=alertdialog`）—— 压缩与换子进程都是不可撤销的重动作。`test/parity.mjs` 的接线断言随之拆成两条 `inOrder`：菜单项只唤起确认（`t('reconnectHint')` → `setConfirm('reconnect')`）、确认处理里才 `endSession`（`confirm === 'reconnect'` → `endSession()`）。④「新会话」仍是顶栏主按钮，语义是**在当前项目内新建**：pi 的 `newSession()`（`agent-session-runtime.ts:226-260`）只读 `this.cwd`，**没有 `cwdOverride`**（只有 `switchSession` 有，`:210`），所以 RPC `new_session` 天然就是「本项目内换树」，host 与契约都不用动。⑤插件显示名改 **SuperPi**（i18n `panelTitle`，ZH `client.js:37` / EN `:258`，侧栏按钮与面板头部都读它），但 `package.json.name` / `NS` / `PANEL_ID` / `exports.name` 全部保持 `superpi` —— `test/version.mjs` 把 tarball 名写死成 `superpi-<version>.tgz`，已装 profile 的 `file:` 依赖串也指向它，改名会让安装链整条断掉。⑥实拍补两处 CSS 缺陷：`.superpi-dialog-content` 原 `padding:14px 24px 0` 让统计弹窗最后一行贴到卡片圆角（下内边距改 22px）；`.superpi-sess-top > span` 缺 `white-space:nowrap` 让「1 个会话」折行把卡片从 60px 撑到 96px，`.superpi-mono` 的 `word-break:break-all` 又把长路径折成 2–3 行（改 `normal` + `text-overflow:ellipsis`）。CSS 侧净增 22 个 `.superpi-*` 类（148 → 168）、删 2 个，令牌集不变（74 个唯一变量 / 70 个 `--dsw-*`）。
- **历史会话两级列表、过程流行距与面板偏好（0.8.0）**：三件事都长在既有结构上，没有新开界面。①历史会话（顶栏入口与 `/resume` 共用 `SessionsSheet`）补齐「面板自己的账」：项目层标题固定「项目列表」且只在这一层给「新建项目」按钮，会话层标题换成项目名、返回箭头由 `SidePanel` 的 `onBack` 提供（原「← 全部项目」文字按钮已删）；搜索框占整行，placeholder 分「搜索项目」/「搜索会话」；项目行与会话行各带一个行内 `⋯` 菜单（重命名项目 / 在此新建会话 / 重命名会话 / 置顶或取消置顶），容器 `onClick` 吞冒泡（不吞的话菜单项一冒泡，重命名弹窗刚打开就被 `onPick` 把侧栏整体关掉）；会话标题按「用户改的名字 → pi 的会话名 → 首条用户消息摘要 → 末条消息 → 占位」取值（`sessionHeadline()` `client.js:3408` 取 `firstMessage` 首行、超 60 字符截断加 `…`，`NO_MESSAGES` 哨兵在 `src/session-store.mjs:34`）；置顶用两遍 partition 而不是 `sort`（host 给的顺序本身有意义，是最近活动降序）；改名走独立的 `RenameDialog`（`client.js:3621-3644`）而不是复用 `NameSheet` —— `drawer` 是单值，改名会把左侧栏自己顶掉。偏好读写走 host 新增的 `/ui-prefs` 三条路由，落盘层是 `src/ui-prefs.mjs`。②过程流行距按参考图重算：父行与子行同为 24px 行盒，`.superpi-sub` 组内 `gap:8px`、`margin-left:26px`、`padding-left:12px`（父行行盒 `client.js:564` / 子行组 `client.js:592`），子行步长 32 与父行一致 —— 0.6.4 那版把子行压到 16px 行盒 + gap 0，行距只剩父行一半，是被推翻的中间态。③版本 0.8.0：tarball 名 `superpi-0.8.0.tgz`，`CONTRACT_VERSION` 同步 0.8.0。
- 门禁规模（0.7.0）：`test/client-render.mjs` 755 断言、`test/css-tokens.mjs` 98、`test/host-parity.mjs` 204（含 roots 10 条、新 scope 语义、`GET /file` 预览 28 条、`POST /reveal` 10 条）、`test/session-projects.mjs` 55（聚合规则 / 临时路径 / 会话 cwd 读取）、`test/parity.mjs` 78（§7 新增 12 条钉死对账接线）、`test/restart-lib.mjs` 22 条 node 断言 + 双引擎各 31 条 PS 断言（文件层 BOM/CR/无裸 `Start-Process` + 假服务 5 种响应 + bat 门禁）。
- **弹层交互与顶栏标题（0.8.1）**：三处一起改，都不新增界面。①四个居中弹窗（`Dialog` `client.js:3148` / `ConfirmDialog` `:3190` / 选择工作区 `DirSheet` `:4097` / 扩展 UI `ExtensionDialog` `:4357`）统一成**真模态** —— 点遮罩即关闭，判定式只留一份 `maskHandler(onClose)`（`client.js:3121`，判 `event.target === event.currentTarget`，内层不吞事件、不 `stopPropagation`）；语义各自正确：确认框点遮罩等于**取消**而不是确认，扩展 UI 弹窗点遮罩回 `{id, cancelled:true}`（与右上角关闭键同一条路径），并补上原先缺的 `aria-modal`。②`MoreMenu`（`:3205`；顶栏 `⋯` 与历史会话行内 `⋯` 共用）补「点外部关闭」：`isOutsideMenu(node, anchor, target)`（`:3133`）**同时放行菜单自身与触发按钮** —— 少了后半条，同一次点击里 `mousedown` 先关、`click` 又开，表现为「怎么点都关不掉」；顶栏传 `moreRef`（`:4735`）、行内传 `rowMenuAnchor`（`SessionsList` 内 `:3442`，同一时刻只允许一个行内菜单）。③顶栏左上的 `SuperPi` 换成**当前项目标题**（`:5733`）：host 侧新增 `withProjectIdentity(snapshot, projectCwd)`（`index.js:448-455`）与 `snapshotOf(proc, options)`（`index.js:461-463`），在每份会话快照上补 `displayPath`（`shortenHomePath`，家目录缩成 `~`）与 `projectKey`（`pathComparisonKey`），四处调用点 `index.js:672` / `1016` / `1031` / `1035`；客户端 `projectTitleOf(prefs, meta)`（`client.js:3391`）按「面板里改过的项目名 → `displayPath` → 原始路径」取值，全空才回落 `t('panelTitle')`。路径缩短与大小写归一的唯一真相留在 host，浏览器侧不复制这套逻辑 —— 复制一份就是等它下次分叉。`RuntimeGate`（`:4536`，启动期没有会话）保留品牌名。面板偏好同时从 `SessionsSheet` 上提到 `PiPanel`（`prefsState` `:4676`、`applyPrefs` `:4680`、挂载时 `api.uiPrefs()` `:5047`），顶栏与历史会话列表读同一份 `prefs`，改名后顶栏立刻跟着变而不是等下次开侧栏。
- 门禁规模（0.8.0）：`test/client-render.mjs` 797 断言（0.7.0 的 755 + 历史会话两级列表 / 行内菜单 / `/ui-prefs` 回读相关渲染）、`test/css-tokens.mjs` 98、`test/host-parity.mjs` 276（新增 `/ui-prefs` 三条路由 33 条，其余为既有的 `buildSpawnArgs` / `/file` 预览 / `POST /reveal` / 未知路由）、`test/session-projects.mjs` 55、`test/parity.mjs` 78、`test/timeout.mjs` 28、`test/restart-lib.mjs` 22 条 node 断言 + 双引擎各 31 条 PS 断言。
- 门禁规模（0.10.0）：`test/client-render.mjs` 926 断言（0.8.1 的 831 + 规则区五种状态与编辑弹窗 95 条）、`test/host-parity.mjs` 325（+`/rules` 三条路由 34 条：归一回显、空=rank 0、reset、drift、坏文件仍 200 带 warning、415/400）、`test/parity.mjs` 96（+§8「规则链路真的接上了」18 条）、`test/tui-editor.mjs` 293（+安装面三文件、pi 加载器同时认两个扩展、`source` 分派）、**新增 `test/rules.mjs` 193**（纯函数 + store + 真 `.ts` 扩展 + HTTP + 安装面五层）。`npm test` 13 → **14 项**。
- 门禁规模（0.8.1）：`test/client-render.mjs` 831 断言（0.8.0 的 797 + 弹窗遮罩与菜单外部点击的纯函数断言、四个弹窗的 SSR 两层结构、`projectTitleOf` 八条）、`test/css-tokens.mjs` 98、`test/host-parity.mjs` 291（0.8.0 的 276 + `withProjectIdentity` 9 条 + 会话快照带 `displayPath`/`projectKey` 6 条）、`test/session-projects.mjs` 55、`test/parity.mjs` 78、`test/timeout.mjs` 28、`test/restart-lib.mjs` 22 条 node 断言 + 双引擎各 31 条 PS 断言。
- **一键启动链路（0.8.2–0.8.4）**：只动 `tools/`，没碰插件运行时。0.8.2 新增 `tools/start-standalone.ps1` / `.bat`（状态落在仓库内 `.standalone\`、默认端口 25117、`-Stop` / `-Status` / `-Reinstall` / `-Port`，首次装依赖之后复用）；0.8.3 加仓库根目录 `一键启动.bat`（**纯 ASCII 转发器**，逻辑不复制）；0.8.4 新增 `tools/launch-both.ps1` —— 一次双击**并行起两个前端**（新控制台窗口里的 pi TUI + 后台 DSH web），根目录 bat 转给它。**关键事实**：pi 不带 `--mode` 时进交互式 TUI，而它在非 TTY 下会静默退出（`exit 0` 零输出），所以 TUI 必须开真实控制台窗口（`wt -d <dir> cmd /c ...`，wt 缺失回落 `start "" /D ...`），后台进程里跑 pi 等于什么都没发生。
- **改名 SuperPi（0.9.0）**：产品与插件标识全量改为 `superpi` / `SuperPi`，涉及 `client.js`（i18n、面板标题）、`index.js`（`NS` / `apiPrefix` / 自检文案）、`cordis.patch.yml`、README、LICENSE、`docs/*`。**包名与安装链保持不变**：`package.json.name` 仍是 `superpi`，tarball 仍是 `superpi-<version>.tgz`（`test/version.mjs` 写死这个名字）。
- **线上同步（0.9.1）**：把仓库发布到 <https://github.com/lwaaron/superpi>（private，`origin` / `master`），并落地「提交永远先本地、能连上就同时推线上」的机器约束 —— 见第 9 节。新增 `tools/github-sync.mjs`（同步引擎 + CLI）、`tools/git-hooks/post-commit`（后台自动试推）、`test/github-sync.mjs`（82 条门禁，临时裸仓库当真远端，不联网）、`.gitattributes`（钉死 `*.ps1` LF / `*.bat` CRLF，否则 `core.autocrlf=true` 的克隆会让 `test/restart-lib.mjs` 的「无游离 CR」断言必红）。npm 脚本新增 `sync` / `sync:status` / `hooks`；`npm test` 从 11 项变 **12 项**（耗时 ~15 s → ~20.5 s，github-sync ~6.3 s）。**`tools/` 不进 npm 包**（`files` 不含它），插件运行时与 RPC 契约一行未动。
- **输入框能力对齐（0.9.2 · 第三层：不是 RPC 面，是输入框本身）**：命令行 TUI 的输入框是 pi-tui 自己实现的 `Editor`，**没有选区模型** —— `tui.input.copy`（ctrl+c）在 `editor.js:597` 直接 `return` 交回上层，pi 的 `CustomEditor` 再交给 `app.clear` → `handleCtrlC()`（`interactive-mode.js:3595-3603`）**清空输入框**，这就是「Ctrl+C 复制后内容消失」；`tui.editor.cursorLineStart` 默认键是 `["home","ctrl+a"]`，所以 Ctrl+A 是「移到行首」；`ctrl+x` 全表无绑定。另一半是 Windows 缺口：`getNativeClipboard()` 只导出 `getText/setText/getImage/enableVirtualTerminalInput/isModifierPressed`，**没有 `getFilePaths`**（只有 macOS 有），因此资源管理器复制文件后 Ctrl+V 三档全空（filePaths / image / text 都是 null）。处置：新增 `extensions/superpi-editor.ts` —— `class SuperPiEditor extends CustomEditor` + `ctx.ui.setEditorComponent()`（pi 官方扩展点，官方示例 `examples/extensions/modal-editor.ts` 同款），**不改 pi 任何文件、不打补丁**；能力 = Ctrl+A 全选 / Shift+方向·Home·End 扩选 / Ctrl+C 复制（有选区复制选区、无选区复制全文，都不清空）/ Ctrl+X 剪切 / Backspace·Delete 删选区 / 可打印字符与括号内粘贴替换选区 / Ctrl+V 在「无文本且无位图」时读 Windows `CF_HDROP`（PowerShell `GetFileDropList`，异步、1.5 s 超时、base64 防中文乱码）插绝对路径；空编辑器 Ctrl+C **刻意放行**以保住 pi 的两次退出，Esc 只清选区不吞键。pi 在 `setEditorComponent` 时会自动接回 `onSubmit`/`onChange`/`borderColor`/`paddingX` 与**全部 `actionHandlers`**（`interactive-mode.js:2336-2385`），所以扩展不重写 app 键位。安装面 `tools/install-pi-extension.mjs`（`--install/--remove/--status`，落到 `<piAgentDir>/extensions/`，`PI_CONFIG_DIR` 跟随）+ `package.json` 的 `pi:editor` / `pi:editor:status` / `pi:editor:remove`；`tools/launch-both.ps1` 起 TUI 前自动装一次（`-NoEditorExtension` 可关，失败只 WARN）；`files` 新增 `extensions` 让它随 tarball 发布。门禁 `test/tui-editor.mjs` 183 checks（0.9.9 起 231；`npm test` 12 → **13 项**）：用 jiti 加载真 `.ts` + pi 真 `CustomEditor` + 真终端按键序列（像 `\x1b[1;2C` 这种原始字节），末组再用 **pi 自己的扩展加载器**（`core/extensions/loader.js` 的 `discoverAndLoadExtensions`）把装到临时 `agentDir` 的扩展真加载一遍断言无 error —— 这才是「装完 pi 真的能认」的机器保证。账本新增 `docs/parity.md` §5.1。**先做的补丁版（wrap 打包 chunk 原型 + 换 `readClipboardFilePaths` 函数体）已被用户禁用并全部删除回退**，pi 运行时从未被修改（`--status` 核验「未应用」）。
- **输入框外观与入口（0.9.4）**：用户实测提的四条 + 一条补充，全部落在 `extensions/superpi-editor.ts` 的 `render()` 里，没有碰 host/面板任何代码。①**四边闭合 + 直角 + 框线 80% 白**：`inner = width - 2` 交给 `super.render()`，再用 `┌─┐ │ │ └─┘` 包一层（0.9.7 从圆角改直角）；每行过 `padToWidth()` 保证**显示宽度恒等于渲染宽度**（差一列框就会歪），pi 的滚动提示（`↑ N more`）由 `borderBody()` 原样保留。**刻意没做整块填充**：终端里铺近白底必须同时强改文字色（pi 主题是浅色系），会连带压掉选区反色与思考配色，所以只上边框色。②**Working 按状态换色**：模块级 `runState`（`idle`/`running`/`success`/`error`）由三个扩展事件驱动，状态行画在框内最底一行，图标与 `Working` 文案同色（`○`/`◐◓◑◒`/`✔`/`✖`，运行中带 `· Ns`）；同时 `setWorkingVisible(false)` 关掉 pi 内置 Working 行，否则两条并存。③**粘贴路径浅灰底**：`paintPathChips()` 复用选区的 `visualChunks()` 把 token 映射到显示列，涂 `48;2;104;104;104` 以 `49` 闭合。**只染路径本身**：`trimPathToken()` 在最后一个已知扩展名处截断（否则「`D:<文件名>.png`然后把图改深色」会把后面的字一起染色），圆角格只在确实是空白时才吃；识别排除 URL / 相对路径 / `/settings` 这类斜杠命令。**顺带修掉一个真缺陷**：`ansiEnd()` 原本只认 CSI 与 OSC，遇到 pi 的 APC 光标标记（`ESC _ pi:c BEL`）只跳 2 字符，剩余载荷被当可见字算 —— 光标在行内时列号整段错位；现按 BEL/ST 吞掉整条 APC（顺带覆盖 DCS/PM）。④**框外右下角 settings / home（全小写）**：画在下边框之下、pi footer（模型信息）之上，**颜色与模型名一致**（`theme.fg('dim', …)`）；`settings` 展开的菜单**每条都是 pi 自己的斜杠命令**，点了走 `editor.onSubmit(command)`；`home` 提交 `/new`。运行中点击只给 warning；`Esc` 先关菜单。鼠标命中用渲染时记录的 `hits`，转发前换算 `x-1` / `y - 1 - 菜单行数` 回到 `super.render` 坐标系。门禁 67 → **183 checks**，并**去 pi 的 `interactive-mode.js` 里 grep 断言这些斜杠命令仍然存在** —— pi 删了命令门禁就红。
- **「改了没变化」的根因与铁律（0.9.8）**：pi 通过 `getEditorTheme()`（`theme.js:902-907`）交给编辑器的 theme **只有 `borderColor` 与 `selectList`，没有 `fg`**。0.9.4 的 `actionsRow()` 调 `this.theme.fg('dim', …)` 取色 → 抛 `TypeError` → `render()` 的 `catch` 兜底 `return decorated`（**无框原始行**）→ 用户看到「`/reload` 之后没变化」，而门禁用的假 theme 带了 `fg`，把 bug 完全掩盖（0.9.4~0.9.7 一路静默失效）。修法：①取色次序改为「theme.fg → 注入的 `hooks.dim`（来自 `ctx.ui.theme.fg('dim', …)`）→ 原样文本」；②兜底先走 `plainFrame()`（只有框线 + Working，不依赖任何取色）再退，**任何情况下都不许变成无框原始行**；③`test/tui-editor.mjs` 的假 theme 换成 pi 的真实形状，并加 ④b 段专测「没有 fg 时框仍在」。**铁律**：装饰性代码的 try/catch 兜底如果退化成「什么都不做」，UI 改动就会静默失效 —— 兜底必须「降级但仍可见」；**测 UI 的假数据必须照抄上游真实形状**，否则门禁只证明自己和自己一致。
- **footer 接管、项目切换与悬停反馈（0.9.9）**：用户第二轮实测提了三条，都是「输入框下方那几个文字按钮」的事。①**`settings` / `home` 跟 `D:\my_projects\SuperPi\SuperPi (master)` 同一行**；②**项目名右侧加切换图标，点了回到项目选择**；③**点 pi footer 上的 `max` 能切换推理档位**；④（追加）**鼠标移入这些文字按钮要变亮，表示可点击**。四条全部落在 `extensions/superpi-editor.ts`，**没有碰 host / 面板**。
  - **为什么必须接管 footer**：cwd 那一行整份归 pi 的 `FooterComponent`（`dist/modes/interactive/components/footer.js`），输入框渲染不到它，唯一官方入口是 `ctx.ui.setFooter(factory)`（`interactive-mode.js:2076-2093`）。所以新增 `SuperPiFooter`：**第一行由本扩展画**（`项目名 (分支)  ⇄` + 右对齐 `settings  home`），**第二行原样复用 pi 的 `FooterComponent`**（`dist/index.js` 公开导出，实例化后只取 `render()[1]`）—— 统计口径、上下文百分比、模型名、推理档位全由 pi 算，本扩展只把 `Model` 与 `• max` 两段切成两个点击区，所以上游改统计规则也不会分叉。**不要重写第二行**：那是唯一会跟 pi 分叉的地方。
  - **项目切换的真相**：pi 的 TUI **没有**项目选择页（`/resume` 只有 Current Folder / All 两种 scope，All 还是平铺会话列表 —— `session-selector.js:98`），cwd 又是进程启动时定死的。唯一官方能换 cwd 的入口是 `ctx.switchSession(sessionFile)`（`agent-session-runtime.js:128-146` 用 session header 的 cwd 建 runtime）。所以 `switchProjectVia()` 用三样公开能力拼出来：`SessionManager.listAll()` 枚举 → `groupProjects()` 按 header.cwd 聚合并排序（当前项目置顶 → 非临时优先 → 最近活动降序，逐条照抄 `session-selector.js:760-769`）→ `ctx.ui.select()` 选 → `ensureProjectSession()` 给目标项目准备会话文件 → `ctx.switchSession()`。**目标项目还没有会话文件时写一个空 header**（`type/version/id/timestamp/cwd`，`SessionManager.open()` 能正常读，等价「在这个项目开新会话」）；`SessionManager.create()` 本身不落盘（`_persist()` 要等第一轮对话才写 —— `session-manager.js:795-819`），所以必须自己写 header，这一步实测过。
  - **点击区一律按显示列算**（`widthOf` / `padToWidth`），不按字符下标 —— 路径里有中文，按 `indexOf` 定位会整段偏。`splitFooterLine()` 从**最后一个**「连续 2+ 空格」处切（不能用 `/(?:^|\s{2,})(\S.*\S)$/`：它从左往右匹配、`.*` 又吃空格，会把整行判成模型段 —— 第一版就这么踩了，实测才看出来）。
  - **悬停反馈**：常态是 `dim`（与模型名同色），移入变 `accent` + 下划线（`hoverStyle()`）。只换颜色不够 —— 浅色主题里 `dim → accent` 几乎看不出来，下划线是终端里最稳的「可点」信号。悬停态放在**模块级** `hoverState`（不是实例字段）：鼠标事件落到编辑器，而入口画在 footer，两边必须是同一份状态。`handleMouse` 对 `move` 只改悬停态 + `render: true` 重画（不触发动作），对 `press` / `click` 才执行；**移出要复原**，否则高亮会留在原地。
  - 门禁 `test/tui-editor.mjs` **183 → 231 checks**（0.9.10 修「底部那行没了」后 256，0.9.11 修「settings/home 点不动」后 276）：footer 两行结构与「`settings`/`home` 与项目名同行且右对齐」、切换图标是 `U+21C4`（**单列宽** —— 全角字符会把项目行撑歪）、点图标 → 项目列表 / 点模型名 → `/model` / 点 `max` → `/thinking`、悬停移入变 accent + 下划线且**不触发动作**、移出复原、`splitFooterLine` / `splitModelSegment` 的边界、`groupProjects` 的五条排序、`pathComparisonKey` 大小写与分隔符归一、`ensureProjectSession` 写出的 header 字段。**桩必须返回真 ANSI**：`<dim>x</dim>` 这种字面标签会被 `visibleWidth` 当成可见字符，把 padding 算歪（第一版就这么踩了）；`FooterComponent` 渲染前必须先 `initTheme()`，否则抛 `Theme not initialized`。

- **用户自定义规则：最高优先级（0.10.0）**：设置弹窗里多一节「用户自定义规则（最高优先级）」，默认文案 = 用户 2026-11 手写的 21 条，用户可在设置里改，保存后**下一轮对话立刻生效**（不重启会话、不重连）。三件事一起落地，缺一条用户都会看到「改了规则但模型没遵守」：
  ① **落盘与回显**走 host 的 `/rules` / `/rules/reset`（`index.js:1071` 起三条路由，`rulesStore` 在 apply 作用域只建一次 —— 写队列必须共享），落盘 `<home>/.superpi/rules.json`（`SUPERPI_RULES` 可覆盖，tmp + rename 原子写）；规则编辑框的初始值就是**真实生效的那份**，面板不另存一份（`test/rules.mjs` 断言 `client.js` 里没有默认文案的任何一句）。为什么不让面板发 RPC 让 pi 自己存：pi 的 RPC 面没有「读系统提示」的命令，扩展命令的返回值也不回传 —— 只走命令的话面板必须自己再存一份，立刻两份真相；而且设置页要能在**没有任何活着的子进程**时打开。
  ② **「最高优先级」是机制**：规则写进 `systemPromptOptions.sections.user_defined_rules`，pi 组装提示时自定义 section 排在 `cwd` 之后（即整份提示末尾，模型对末尾指令遵循度最高）；块首 `OVERRIDE_PREFIX` 显式声明「覆盖上文与项目说明、冲突以本段为准」，才能压过 `<project_context>` 里的 `AGENTS.md`；规则清空时返回 `undefined`，pi 收到的提示与「没装这个扩展」逐字相同（空规则必须零痕迹）。**不写 `SYSTEM.md`**（会整份替换 pi 的默认提示：工具说明、docs 路径、技能列表全没，等于让系统退化两个维度），**不写 `APPEND_SYSTEM.md`**（静态文件，改完要重启会话、且面板没有读原文的通道），**不把规则当用户消息发**（会进 transcript、被压缩吃掉）。实测证据：真 pi 子进程 + 真模型，规则里放一串随机暗号，问它「你现在遵守的最高优先级规则里有一串暗号，只输出暗号」→ 模型把暗号吐回来了。
  ③ **两端同一份文件、同一份模型**：命令行走 `extensions/superpi-rules.ts` 的 `before_agent_start`（每轮 `readRulesTextSync()`，mtime+size 缓存命中时纯内存；改完文件下一轮就生效）与 `/superpi-rules` 命令（看级别与字数 / 编辑 / 恢复默认 / 只显示全文，按 `ctx.ui.select/editor/confirm` 分级退化，没有 UI 就明确告知文件路径）；settings 菜单加了 `rules` 一条并标 `source:'superpi'`（冒充 pi 命令会让「点了没反应」变成假话，门禁按 source 分派断言）。两侧共用 `extensions/superpi-rules.mjs`（默认文案 / 归一 / checksum / 渲染 / store 的唯一真相），安装器一次同步三个文件 —— 少装 `.mjs` 会让 `.ts` 报模块找不到、规则整个不生效，所以 `status` 逐文件报告、`complete` 才算完整。**渲染器不自带 `<user_defined_rules>` 标签**：pi 组装 section 时会包一层，自己再包就是同名嵌套两次（0.10.0 首版实测抓到，已修 + 门禁锁住）。
  ④ 坏文件一律回落默认文案 + 告警（保存一次即修好），绝不让设置页打不开、也绝不让 pi 的一轮对话失败（`before_agent_start` 里任何异常都被吞掉）。UI 是一个**状态机**（加载中 / 正常 / 默认 / 空 / 读失败 / 命令行未装 / drift），空规则明说「不会追加任何内容」而不是静默 —— 静默看起来像故障。设计、状态矩阵、`E2E-01`~`E2E-14` 验收清单见 `docs/rules.md`。
- 逐条账本见 `docs/parity.md`；机器保障是 `npm test` 里的 `test/parity.mjs` + `test/host-parity.mjs` + `test/timeout.mjs` + `test/tui-editor.mjs`。

## 9. 线上同步（GitHub）

代码在 <https://github.com/lwaaron/superpi>（**private**）：远端名 `origin`、分支 `master`、HTTPS，凭据只走本机 Git Credential Manager，**仓库里不放任何 token**。

用户 2026-11-17 定的规矩，逐字：「以后每次有新的版本提交都同步更新到线上 github，如果连不上网就先提交本地，如果连上了就提交本地之后同时提交线上 github。」落到代码里是三条硬约束：

1. **提交永不因网络失败**。`tools/git-hooks/post-commit` 把同步跑在后台（`&` 分离、永远 `exit 0`），离线时什么都不做，提交照旧落地。
2. **欠的提交会被补推**。`npm run sync` 每次都先 `ls-remote` 比对，不相等才推 —— 上次离线留下的提交下次自动跟着走。
3. **失败必须分得清**。`auth`（凭据/权限）/ `rejected`（线上分叉）/ `proxy`（代理配了但连不上）/ `offline`（连不上网）/ `failed` 五类不许合并：把认证失效说成离线，就会永远静默重试并以为「只是没网」。`proxy` 是 0.15.7 补的第五类 —— 实测事故：本机 `.gitconfig` 指向一个没启动的代理，于是每次同步都报 `offline`、钩子静默跳过，而直连 github 是通的；这两件事的处置**相反**（`offline` 等下次自动补推，`proxy` 必须人去看），合并就等于让同步永远推不上去还看不出来。

| 命令 | 用途 |
| --- | --- |
| `npm run sync` | 推当前分支 + 全部 tag。退出码 **0 已同步 · 2 离线待补推 · 3 要人处理 · 1 其它** |
| `npm run sync -- --status` | 只读：本地/线上 HEAD、待推几个提交、钩子装没装、最近 5 条同步日志 |
| `npm run sync -- --init` | 克隆丢了 `origin` 时补回 `https://github.com/lwaaron/superpi.git` |
| `npm run hooks` | 装 `.git/hooks/post-commit`（模板在 `tools/git-hooks/post-commit`，装出的文件与模板逐字节相同） |

禁止项（与第 5 节同级）：

- **禁止 `git push --force` / `--force-with-lease`**：线上分叉只能被 `rejected` 拦住，交给人看，不许自动改写历史。
- **禁止把 token / 凭据写进仓库或脚本**：认证只走凭据管理器；`GIT_TERMINAL_PROMPT=0` + `GCM_INTERACTIVE=never` + `execFile` 硬超时，保证后台跑不会弹出认证窗口把人挂住。
- **禁止让同步阻塞提交**：钩子里只能后台跑并 `exit 0`（`test/github-sync.mjs` 断言这两条，改钩子先跑它）。
- **禁止把「没网」当成其它失败的同义词**：分类写错等于把认证问题永久藏起来。
- 日志与锁固定在 `.git/` 里（`superpi-sync.log` / `superpi-sync.lock`，锁 120 s 残留自动接管），天然不入库；`SUPERPI_GIT_SYNC=0` 可临时关掉自动推送。

门禁：`test/github-sync.mjs` 82 条 —— 临时裸仓库当真远端、`127.0.0.1:1` 拒连当断网、另一个 clone 当分叉方，**全程不联网**，已进 `npm test`。`.gitattributes` 钉死行尾：代码类（`*.js` / `*.mjs` / `*.json` / `*.yml` / `*.ps1` / `tools/git-hooks/*`）LF，`*.bat` / `*.cmd` CRLF —— 门禁读的是工作区字节，新克隆的行尾不该由本机 `core.autocrlf` 决定。

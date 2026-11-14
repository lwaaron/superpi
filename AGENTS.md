# AGENTS.md — dsh-pi

给接手这个仓库的 AI。动代码前先读完这一页，尤其是第 3 节。

## 1. 这是什么

DSH（DeepSeek Runtime）插件：把 pi 编码 agent 装进 DSH 的侧栏面板。

它不重写 pi，只做一层薄适配——host 拉起真正的 `pi --mode rpc` 子进程，面板通过 pi 官方 JSONL RPC 协议跟它对话。pi 升级只要 RPC 帧不破，面板不用改。

必须记住的架构事实：**同一个 pi 1.5.2、同一个 agent loop，两个平级前端**——命令行 TUI（`packages/coding-agent/src/modes/interactive/`）与 dsh-pi 面板。不是父子，不是主从。第 2、3 节全部由此推出。

## 2. 两半架构

| 文件 | 职责（一句话） |
| --- | --- |
| `index.js` | host 半区：注册 `/api/dsh-pi/*` 路由（`createHandler` `index.js:692-873`，路由分派在 `:706-863`）、会话池（≤8）、子进程生命周期、自检、运行时解析报告。 |
| `src/pi-rpc.mjs` | JSONL 帧解析、命令 id 配对、事件环形缓冲、扩展 UI 挂起表（`pendingUi` `:142` / `trackUi()` `:273` / `respond()` `:446`，`extension_ui_response` 在 `send()` 里被强制改道 `:374-378` 以免被重新分配 id）、**超时让位机制**（`timeoutLimitMs()` `:43` 归一化三态；`armTimer()` `:414` 到点时若有弹窗挂起就续期而非 reject，上限 `MAX_TIMEOUT_DEFERRALS` 12 轮；`restartPendingTimers()` `:472` 在每次应答后重开一整轮窗口）。 |
| `src/pi-runtime.mjs` | pi 与 node 的 8 步解析链 + 一键安装（不依赖任何宿主路径）。 |
| `src/rpc-contract.mjs` | 三方事实的结构化快照：33 条 RPC 命令、25 类事件、12 种 assistant 事件、27 条 TUI 内置命令、9 个扩展 UI method、`classifyInput()`、`validateContract()`。**命令表/事件表/斜杠表只在这里定义一份**，`client.js` 不许硬编码。 |
| `src/session-store.mjs` | 只读枚举 `~/.pi/agent/sessions` 下的 pi 会话文件（语义对齐 `session-manager.ts:802-897`），另有 `pathComparisonKey` / `isTemporaryPath` / `shortenHomePath` / `groupSessionsByProject`（对齐 `cli/session-picker.ts:26-62` 与 `session-selector.ts:760-769`）与 `readSessionCwd`（读 header.cwd，供跨项目切换回填）。已接线：`index.js:33-39` import 八个函数，`GET /sessions/history?scope=`（`index.js:805`）暴露给面板的 `SessionsSheet`（`client.js:1885` 容器）/ `SessionsList`（`client.js:1791` 纯渲染）。 |
| `client.js` | 浏览器半区：React 面板，零构建、零 JSX，只 `require('react')`。 |
| `docs/parity.md` | 能力矩阵。两端对齐的唯一账本。 |

## 3. 100% 对齐 = 不可协商约束

用户 2026-11-12 原话：「全部补齐，并且告诉未来这个项目的你两个端要保持100%对齐」。

- 一条能力要么两端都有，要么两端都明确没有。**不存在「先做一端，另一端以后再说」**。
- 任何当前缺口必须在 `docs/parity.md` 里是一条显式记录（能力名 + 缺什么 + 补齐版本），不允许静默存在。
- 目标态是 `docs/parity.md` 里 **零缺口**。你新增任何能力，同步把另一端补齐，不许把缺口转嫁给下一任。
- 检查动作：`npm test`。它含三套机器门禁 —— `test/parity.mjs`（388 行 / 65 checks，契约 ↔ pi 类型与官方文档 ↔ `client.js`/`index.js` 的面板覆盖，三向对账）、`test/host-parity.mjs`（409 行 / 125 checks，`buildSpawnArgs` 与 HTTP 面）与 `test/timeout.mjs`（166 行 / 28 checks，用 `test/fixtures/fake-pi-rpc.mjs` 协议替身把 5 分钟的超时/弹窗时序压到毫秒级实测）。**这三套门禁是本仓库对齐的机器保障，不是可选装饰**：删掉或绕过它，等于把"100% 对齐"退回人肉承诺。

## 4. 新增一个能力的固定流程（顺序不可换）

1. **登记契约**：改 `src/rpc-contract.mjs` 的 `RPC_COMMANDS` / `RPC_EVENTS` / `TUI_COMMANDS` / `EXTENSION_UI_METHODS`。上游权威永远是 `packages/coding-agent/src/modes/rpc/rpc-types.ts`，不是这份文件的注释。
2. **host 可达**：`POST /sessions/:id/command`（`index.js:800-838`，`proc.send` 在 `:822`）通常零改动。注意它做两件额外的事：超时三态归一化（`:812-817`，非法值直接 400 而不是静默降级）与剥离 `timeoutMs`（`:820-821`，那是本插件的传输层参数，pi 的 `RpcCommand` 没有这个字段，透传即契约污染）。需要新 HTTP 面时才动 `createHandler`（`index.js:692-873`），并判断该文件是否在 `SELF_FILES`（`index.js:109-118`）的 `runtime:true` 里（是则改完必须重启 DSH）。
3. **客户端接 UI**：`client.js` 三处——`api` 对象（`:506-541`）加方法、`applyRecord`（`:945-1094`）加事件分支、面板加控件与 i18n 词条（`ZH` `:36-168` / `EN` `:169-300`，两套键集必须一致）。
4. **更新账本**：`docs/parity.md` 对应行的「面板端状态」改成已实现，补「门禁用例」，并按需改 `## 1/3/4` 末尾的统计数字。
5. **跑门禁**：`npm test`。红了不许提交。
6. **提交**：`git add` 你实际改的文件。**改代码必须同时升 `package.json` 的 version**（pnpm 对 `file:` 依赖按 lock 里的 integrity 复用 store，版本号不变会把旧内容装回来且 exit=0；`test/version.mjs` 与 `test/parity.mjs:213-218` 都断言版本单一真相）。

## 5. 禁止项

- **禁止在 `tools/restart-dsh.ps1` 里用 `Start-Process -FilePath $exe` 重启**（0.4.2 之前的老实现）。桌面实例的启动命令行带 6 个参数，裸起等于换个东西启动。重启必须走 `Get-LaunchSpec` + `ProcessStartInfo`，参数一个字节都不重排。
- **禁止以「UI 没做」为由在 host 或协议层留缺口。** 缺的是 UI 就说缺 UI，别把能力做成半截。
- **禁止把斜杠命令当普通文本发给模型。** `/compact` 走的是 `compact` 命令，绝不能当 prompt 发出去——pi 的 RPC prompt 通道只认扩展命令、`/skill:`、prompt template（`agent-session.ts:2410-2445`），TUI 那 27 条内置命令在 RPC 侧一条都没有。输入一律先过 `classifyInput()`，`handleSlash`（`client.js:2983-2989`）按 disposition 五路分流。未知斜杠照发是 pi 的既有语义，不要"顺手修"。
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
| `D-07` | `RpcSessionState` 无 `autoRetryEnabled`（`rpc-types.d.ts:148` 的 12 字段里没有；`agent-session.ts:4122` 有 getter 但 RPC 面未暴露） | 设置抽屉的自动重试开关无法回读，`client.js:1709` 恒读到 `undefined` → 永远显示 off，但点一下确实生效。`test/parity.mjs:290` 用断言锁住该缺口。注意 `autoCompactionEnabled` **不是**同类问题：它在 `RpcSessionState` 里，面板 `loadState` 整份存进 `info`，`client.js:1677`/`:1708` 读到的是真值。 |
| `D-08` | `cycle_model` 在 RPC 面无方向参数（`rpc-types.ts:34` 是 `{ type: "cycle_model" }`） | `Ctrl+P` 只能正循环；TUI 的 `cycleModel(direction)`（`interactive-mode.ts:4723-4725`）两个方向，RPC 面只有一个。 |

## 7. 验证命令

```powershell
npm test                                        # 11 项离线门禁，全程实测 ~15 秒：
                                                # selfcheck → client-render(669) → css-tokens(96)
                                                # → runtime-resolve → config-hot → host-parity(204)
                                                # → session-projects(55) → timeout(28) → parity(77)
                                                # → restart-lib(31×2 引擎) → version
                                                # 耗时大头：restart-lib ~9.1 s（起 pwsh 7 + 5.1 各跑一遍 fixture）、
                                                # timeout ~3.1 s（真等超时周期）；其余合计 <1.5 s
npm run test:all                                # 上面 11 项 + 真起 pi 子进程跑一轮 LLM
npm run test:fresh                              # 全新机器：无运行时 → missing → 一键安装 → 能开会话（需网络）
pwsh -NoProfile -File tools\standalone-verify.ps1   # 全新 DSH_HOME 自证（装 tarball、起独立端口、跑一轮、清理）
pwsh -NoProfile -File install-plugin.ps1 -Profile desktop   # 装进 desktop profile（含 rollback 脚本）
```

`npm test` 是提交前的最低门槛；碰了协议、UI、运行时解析的改动必须再跑 `test:all` 或 `standalone-verify.ps1`。`test/client-render.mjs` 需要 `react`/`react-dom`，本仓库刻意不带 `node_modules`，它从同级 `pi-main/node_modules` 借，借不到就 SKIP 并退出 0。

`test/fixtures/` 放两类「不能在门禁里自造」的东西：`fake-pi-rpc.mjs`（pi RPC 协议替身，`FAKE_PI_MODE=dialog|silent` 让超时语义可以在毫秒级被实测，`test/timeout.mjs` 用它）与 `pi-ext-ui-probe.ts`（真扩展，**只能靠真人点击验证**——扩展 UI 的九个 method 没有替身能覆盖「用户到底点了没」。用法写在文件头：复制到 `%USERPROFILE%\.pi\agent\extensions\`、重启 pi 会话、依次跑 `/dsh-ui-probe` 与 `/dsh-ui-notify`、验完删除）。

## 8. 现状快照（2026-11-14 · v0.6.3）

- **RPC 命令**：pi 侧 33 条，面板已实现 32 条 + `steer` 1 条走等价路径（`prompt` + `streamingBehavior:'steer'`，`client.js:2447`），缺口 0。
- **扩展 UI**：9 种请求全部已实现（`applyExtensionUi()` `client.js:898-943`），3 种应答全通（`POST /sessions/:id/respond` `index.js:839-858`）。倒计时取 `min(pi 声明值, 5 分钟兜底)`（`dialogBudgetMs()` `client.js:883`，`DIALOG_FALLBACK_MS` `src/rpc-contract.mjs:260`），且 host 侧命令 timer 会为挂起的弹窗让位（`restartPendingTimers()` `src/pi-rpc.mjs:472`）——**这两侧必须同时成立**，否则就是 0.2.5 那个「红条与对话框并存」的缺陷。
- **事件**：25 类 = 已实现 22 + 显式忽略 3（`turn_end` / `agent_end` / `summarization_retry_attempt_start`，理由见 `docs/parity.md` §3），缺口 0。
- **TUI 斜杠**：27 条 = 已实现 17 + 仅命令行 9 + `unsupported` 1（`/import`）+ 缺口 0。
- **`D-03` 已闭环**：顶栏是两个按钮 —— 「新会话」`runNewSession` → RPC `new_session`（与 `/new` 同一条路径，同进程换树，`client.js:3037`）、「重连」`endSession`（换子进程，旧事件缓冲丢掉，`client.js:3036`）。0.2.5 把换进程当新会话，同一件事两个入口两种结果。
- **剩两个上游协议面限制未闭环**：`D-07`（`get_state` 无 `autoRetryEnabled`）与 `D-08`（`cycle_model` 无方向参数），面板侧无解，见第 6 节；`test/parity.mjs:290` 用断言锁住 `D-07`，pi 哪天补了字段该断言会红，届时才是闭环时机。
- **工作区选择（0.4.0）**：入口统一叫「选择工作区」（`pickDir`/`dirTitle`/`dirHere` 三处 ZH+EN 同改），交互从铺满面板的抽屉改成 680x500 居中模态（`client.js:2115` `.dsh-pi-dialog-wrap` + `.dsh-pi-dir-dialog`，`role="dialog"`/`aria-modal`）——它是打断当前会话的决策。新增「此电脑」盘符层：`GET /directories` 下发 `roots`（Windows 探 A-Z 各盘根，10s 缓存 `ROOTS_TTL_MS`），否则从工作区逐级往上只能走到当前盘根，D:/E:/F: 上的工程永远选不到。
- **过程行（0.4.0）**：工具调用 / 工具结果 / `!` bash 三类行去掉圆角卡片外壳（`border-radius:0`、`background:transparent`、无 hairline），改平铺行 + 展开区左侧竖线，与 `.dsh-pi-think` 同一套语言。一次任务十几条工具卡若每条都套圆角 + 描边，会形成框套框的噪音墙。
- **会话历史对账（0.4.1）**：`attach` 之后补一次 `get_messages` 整表重建（`messagesFromHistory()`，`client.js` 内由 `hydrate()` 调用）。根因：`new_session` / `switch_session` / `fork` / `clone` 成功后 host 会 `proc.resetEvents()`（`SESSION_REPLACING_COMMANDS`，`index.js:74`）把事件缓冲清空，历史消息不再以事件重放 —— 只靠 `snapshot` 重放的话切过去必然空白（0.4.0 及之前「点开历史会话没有内容」）。两道防线：会话已切走则丢弃响应（`sessionRef.current !== id`）；`busy` 期间不覆盖列表，改挂 `hydratePendingRef`，由 `drainHydrate()` 在 `agent_settled` 之后补。`bashRef` 语义不变（仍只表示「bash 正在跑」，Esc `abort_bash` 依赖它）。
- **重启脚本（0.4.2）**：`tools/restart-dsh.ps1` 重写，杀的是**启动根**并按**原命令行原文**重建（`ProcessStartInfo.Arguments`），环境变量按目标实例 `/selfcheck` 报的 `root` 反推 `DSH_HOME`、清 `DSH_PORT`、`ELECTRON_RUN_AS_NODE` 按需设；推不出来 `exit 3`，脚本自己在目标实例内部时也 `exit 3`（`-Force` 可越过），`-Plan` 只打印计划。旧实现三处缺陷：`Start-Process -FilePath $exe` 丢 6 个启动参数、杀宿主 pid 导致没人重新拉起、继承 `ELECTRON_RUN_AS_NODE=1` 等污染环境。库模式 `$env:DSH_PI_RESTART_LIB=1` 只加载函数，供测试不触动真实例。
- **历史会话两级（0.5.0）**：`/resume` 抽屉改成「项目层 → 会话层」，与命令行 pi 的 `SessionSelectorComponent` 同构。根因是 0.4.2 及之前 `SessionsSheet` 把当前 `meta.cwd` 当唯一过滤条件、而 host `listHistory` 在 `cwd` 为空时回落 `detected.workspace`，抽屉永远只列得出一个项目。现 `GET /sessions/history?scope=all` 返回全部项目 + `projects` 聚合（`groupSessionsByProject` 排序规则逐条照抄 pi：当前项目置顶 → 非临时优先 → 最近活动降序，临时目录判定沿用 `TEMPORARY_PATH_PATTERNS`）；`scope=project&cwd=` 只列该项目。跨项目切换后 `proc.sessionCwd` 由会话文件 header 的 `cwd` 回填（`readSessionCwd`）—— `get_state` 不回报 cwd，不补这一步面板的「当前工作区」会一直是子进程的 spawn 目录。`MissingSessionCwdError` 翻成中文提示：pi 的 RPC 面没有 `cwdOverride` 分支（`rpc-mode.ts:624-630`），面板替不了用户选「换目录继续」。
- **文件标签与任意文件（0.6.0）**：助手回复里的文件路径变成可点标签 —— 段落正文、行内反引号、以及「围栏里整块只有一条路径」三种形态都认；点开走 `ctx.sidebarRight.openResource('dsh-resource://file/session/<DSH 会话>/<路径>')`，由 DSH 内置 `documentpreview` 渲染，插件绝不自造预览 UI。识别的原则是「宁可少认，不要误认」：URL 排除、裸文件名必须命中扩展名白名单（`FILE_BARE_EXT`）、末段必须带扩展名，否则 `/model`、`v1.2.3`、`example.com` 都会被误标。地址一律 session 作用域 —— `absolute` 作用域没有授权会话，读出来是 `workspace-file/unknown-workspace`。服务用 `ctx.get('sidebarRight')` 惰性取（**写进 `exports.inject` 会让 entry 永久 pending 卡死 DSH 启动**），取不到 / 当前没有正在显示的会话时才回落面板内 `FileSheet`，且必须 notice 说明原因。Composer 的附件按钮与粘贴同步放宽到任意文件与压缩包：图片仍走 ImageContent，其它文件按 pi TUI `handleClipboardPaste`（`interactive-mode.ts:3278-3318`）的语义把**绝对路径文本插进输入框**（RPC 契约 `prompt/steer/follow_up` 只有 `images` 字段，没有任意文件附件通道）；路径来自 preload 暴露的 `window.__DSH_HOST_PATHS__.pathFor(file)`（只在桌面 App 的 `dsh-app://app` 存在，浏览器里取不到就明确提示改用 @ 补全）。
- **输入区与关闭入口（0.6.1）**：三处一起改。①Composer 底栏拆成 `.dsh-pi-bar-actions`（目录 / 附件 / busy 时的排队与停止）与 `.dsh-pi-bar-right`（提示语 + 发送），提示语位置固定、不再被 busy 时多出来的按钮挤动；附件按钮从产品 logo `PiIcon` 换成真正的回形针 `PaperclipIcon`（原来用品牌图标表示附件，语义错位），并按 `busy` 切换文案 `composerTipIdle`（Enter/Shift+Enter/`/`/`@`/`!`）与 `composerTipBusy`（steer/Alt+Enter/Esc）；`composerHint` 只留「给 pi 说点什么…」——原来把五条快捷键全塞进 placeholder，一开始输入就消失、窄面板还会被截断。②抽屉与弹窗右上角统一成 `CloseButton`（`dsh-pi-btn-icon` + 16px `CloseIcon`，32×32 命中区）；改之前是纯文本 `'×'`（11px、无 `-icon` 类），且 `Sheet` 带 `type="button"`、`DirSheet` 不带，两处已分叉。`ExtensionDialog` 也补了 `.dsh-pi-dialog-head`（h3 + 关闭键，语义等于取消）。③文件标签右键 → `POST /api/dsh-pi/reveal` → host 用 `explorer.exe /select,<文件>` 在资源管理器里定位（macOS `open -R`、Linux `xdg-open` 父目录）；`revealInFileManager` 只等 `spawn` 不等退出码 —— explorer 把命令转交给已有实例后常以非 0 退出，信它就会把成功报到失败。标签同时只显示类型图标 + 文件名（`data-kind` 六类：code/image/archive/sheet/doc/file），不再显示目录尾巴。
- **输入区重做（0.6.2）**：composer 整体换成宿主主对话区的语言 —— 卡面 `.dsh-pi-box` 用 `--dsw-radius-panel`（28px）+ `--dsw-specific-input-major` 底 + `--dsw-elevation-soft` 投影、顶部 `padding-top:8px`、`gap:12px`，聚焦时只把 `--dsw-elevation-stroke-color` 局部覆盖成品牌色（不再整框换 border，描边由 elevation 的第一层表达）；`textarea` 无边框、`padding:4px 8px 0 14px`、`caret-color` 用品牌色、placeholder 用 `--dsw-alias-label-caption`。行内左侧从「目录 / 附件 / 排队 / 停止四个文字按钮」改成宿主的「28px 圆形 `+` + 模型 picker + 推理档位 picker」，右侧是「带状态切换的发送键」——空闲为 34px 圆形 `--dsw-alias-button-info-fill` 底 + `ArrowUpIcon`（`:disabled` opacity .4），运行中同一位置换成 `StopSquareIcon`（`Esc`），不再并排两个按钮。`+` 弹出 `AddMenu`：按「添加 / 指令」分组，每项 = 图标 + 主标签 + 英文键名 + 右侧灰色说明（宿主同款两列），条目全部映射到面板已有能力（文件 `pickFiles` / 工作区 / 历史会话 / 压缩 / 模型 / 推理等级 / 统计 / 设置 / 快捷键 / 新会话），**不伪造 pi 侧不存在的 goal / plan / feedback / todo**。底部统计行（`footer`）搬进 composer 容器、卡下方居中，内容 = 会话状态（steering / 排队 / 会话文件）+ 中点 + `get_session_stats` 的「N 轮 · N 步 · N tok · 缓存命中 N% · 上下文 N%」（缓存命中 = `cacheRead/(input+cacheRead+cacheWrite)`，与 pi TUI footer 同公式；tok/s 无可靠来源故不显示），只在 `agent_settled` 后拉一次（`flush` 里与 `loadCommands` 同一位置）。模型 chip 与思考档位 `<select>` 从头部移入 composer —— 它们决定「下一条怎么发」，属 composer 语义。
- **composer 首次填充与 dock 归位（0.6.3）**：0.6.2 落地后实测暴露两处。①统计行首次进入面板 / 切到历史会话时是空的 —— `footerStats` 只在 `agent_settled` 后拉，而刚 attach 的会话没有 settle 事件。现 `attach()` 尾部（`openStream` + `flush()` 之后）与 `reload()` 的 then 链尾各补一次 `loadFooterStats(id)`，这两个点是「会话已就绪、事件已回放完」的唯一入口。②统计行混进 `meta.sessionFile` 的完整路径，把「N 轮 · N 步」挤到换行、视觉重心变成一串路径 —— 宿主的 dock 只有用量数字，路径属于「会话统计」抽屉，那行已删。③`composerHint` 改宿主口径 `给 pi 说点什么, / 调用指令, @ 文件`（`Say something to pi, / commands, @ files`）：0.6.1 的「给 pi 说点什么…」只剩一句话，用户看不出这里能敲斜杠和 @（仍不含 `Enter`，两个既有断言照旧通过）。
- 门禁规模（0.6.3）：`test/client-render.mjs` 669 断言、`test/css-tokens.mjs` 96、`test/host-parity.mjs` 204（含 roots 10 条、新 scope 语义、`GET /file` 预览 28 条、`POST /reveal` 10 条）、`test/session-projects.mjs` 55（聚合规则 / 临时路径 / 会话 cwd 读取）、`test/parity.mjs` 77（§7 新增 12 条钉死对账接线）、`test/restart-lib.mjs` 22 条 node 断言 + 双引擎各 31 条 PS 断言（文件层 BOM/CR/无裸 `Start-Process` + 假服务 5 种响应 + bat 门禁）。
- 逐条账本见 `docs/parity.md`；机器保障是 `npm test` 里的 `test/parity.mjs` + `test/host-parity.mjs` + `test/timeout.mjs`。

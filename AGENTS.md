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
| `src/ui-prefs.mjs` | 面板偏好的落盘层（0.8.0）：项目显示名 / 会话显示名 / 会话置顶的唯一真相，落在 `<home>/.superpi/ui-prefs.json`（`SUPERPI_UI_PREFS` 可覆盖路径，`UI_PREFS_DIR_NAME` = `.superpi`，版本号 `UI_PREFS_VERSION = 1` 供将来迁移）。对外只经 host 的 `/ui-prefs` 三条路由（`index.js:991-1007`：GET 只读、`POST /ui-prefs/project`、`POST /ui-prefs/session` 走合并式补丁），校验与 400 语义都收在这一层（`MAX_PROJECT_NAME_LENGTH` 120 / `MAX_SESSION_PATH_LENGTH` 4096）。**它不归 pi 的 RPC 面管** —— 偏好是「面板自己的账」。 |
| `extensions/superpi-editor.ts` | 命令行会话窗口（pi TUI）的**输入框增强**（0.9.2）：继承 pi 公开的 `CustomEditor`，通过官方扩展点 `ctx.ui.setEditorComponent()` 替换输入框 —— **不改 pi 任何文件、不打补丁、不碰 `node_modules`**。补的是 TUI 输入框缺的那一套：Ctrl+A 全选、Shift+方向/Home/End 扩选、Ctrl+C 复制（不再清空内容）、Ctrl+X 剪切、Backspace/Delete 删选区、可打印字符与粘贴替换选区、以及 Windows 下 Ctrl+V 粘贴**剪贴板里的文件**时插入绝对路径（文件列表读 PowerShell 的 `GetFileDropList`，因为 pi-tui 的 Windows native 模块没有 `getFilePaths`）。安装面 `tools/install-pi-extension.mjs`（`--install/--remove/--status`）落到 `<piAgentDir>/extensions/`；门禁 `test/tui-editor.mjs` 67 checks。 |

## 3. 100% 对齐 = 不可协商约束

用户 2026-11-12 原话：「全部补齐，并且告诉未来这个项目的你两个端要保持100%对齐」。

- 一条能力要么两端都有，要么两端都明确没有。**不存在「先做一端，另一端以后再说」**。
- 任何当前缺口必须在 `docs/parity.md` 里是一条显式记录（能力名 + 缺什么 + 补齐版本），不允许静默存在。
- 目标态是 `docs/parity.md` 里 **零缺口**。你新增任何能力，同步把另一端补齐，不许把缺口转嫁给下一任。
- 检查动作：`npm test`。它含三套机器门禁 —— `test/parity.mjs`（416 行 / 78 checks，契约 ↔ pi 类型与官方文档 ↔ `client.js`/`index.js` 的面板覆盖，三向对账）、`test/host-parity.mjs`（844 行 / 291 checks，`buildSpawnArgs` 与 HTTP 面）与 `test/timeout.mjs`（167 行 / 28 checks，用 `test/fixtures/fake-pi-rpc.mjs` 协议替身把 5 分钟的超时/弹窗时序压到毫秒级实测）。**这三套门禁是本仓库对齐的机器保障，不是可选装饰**：删掉或绕过它，等于把"100% 对齐"退回人肉承诺。

## 4. 新增一个能力的固定流程（顺序不可换）

1. **登记契约**：改 `src/rpc-contract.mjs` 的 `RPC_COMMANDS` / `RPC_EVENTS` / `TUI_COMMANDS` / `EXTENSION_UI_METHODS`。上游权威永远是 `packages/coding-agent/src/modes/rpc/rpc-types.ts`，不是这份文件的注释。
2. **host 可达**：`POST /sessions/:id/command`（`index.js:1037-1082`，`proc.send` 在 `:1059`）通常零改动。注意它做两件额外的事：超时三态归一化（`:1049-1054`，非法值直接 400 而不是静默降级）与剥离 `timeoutMs`（`:1057-1058`，那是本插件的传输层参数，pi 的 `RpcCommand` 没有这个字段，透传即契约污染）。需要新 HTTP 面时才动 `createHandler`（`index.js:809-1117`），并判断该文件是否在 `SELF_FILES`（`index.js:135-147`）的 `runtime:true` 里（是则改完必须重启 DSH）。
3. **客户端接 UI**：`client.js` 三处——`api` 对象（`:932-1006`）加方法、`applyRecord`（`:1708-1857`）加事件分支、面板加控件与 i18n 词条（`ZH` `:36-256` / `EN` `:257-474`，两套键集必须一致）。
4. **更新账本**：`docs/parity.md` 对应行的「面板端状态」改成已实现，补「门禁用例」，并按需改 `## 1/3/4` 末尾的统计数字。
5. **跑门禁**：`npm test`。红了不许提交。
6. **提交**：`git add` 你实际改的文件。**改代码必须同时升 `package.json` 的 version**（pnpm 对 `file:` 依赖按 lock 里的 integrity 复用 store，版本号不变会把旧内容装回来且 exit=0；`test/version.mjs` 与 `test/parity.mjs:213-218` 都断言版本单一真相）。提交之后跑 **`npm run sync`** 把这次提交同步到线上 GitHub（见第 9 节）——装了钩子的话它会自动在后台推一次，但**离线时不会告诉你欠了多少**，手动跑一次才能看到结论。
7. **推线上**：`npm run sync`（有网）/ 只提交本地（无网，退出码 2）。发布一个新版本时顺手 `git tag -a v<version>` —— tag 由同一条 push 带上去。

## 5. 禁止项

- **禁止在 `tools/restart-dsh.ps1` 里用 `Start-Process -FilePath $exe` 重启**（0.4.2 之前的老实现）。桌面实例的启动命令行带 6 个参数，裸起等于换个东西启动。重启必须走 `Get-LaunchSpec` + `ProcessStartInfo`，参数一个字节都不重排。
- **禁止给 pi 打补丁（2026-11-17 用户明确禁用）。** 不许改 `node_modules` 里 pi / pi-tui 的任何文件，不许 wrap 它们已打包 chunk 的原型方法，不许替换 bundle 里的函数体 —— 哪怕「可回滚 + 幂等标记 + 备份」也不行。要补能力只能走两条路：① pi 的**官方扩展点**（`pi.on()` / `registerTool` / `registerCommand` / `ctx.ui.setEditorComponent()` / `ctx.ui.custom()`，见 `docs/extensions.md`）；② `docs/parity.md` 记为显式缺口交上游。0.9.2 的教训：先做的补丁版（wrapper chunk）已全部删除回退，最终用 `extensions/superpi-editor.ts` 这个官方扩展实现同一能力。
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
| `D-07` | `RpcSessionState` 无 `autoRetryEnabled`（`rpc-types.d.ts:148` 的 12 字段里没有；`agent-session.ts:4122` 有 getter 但 RPC 面未暴露） | 设置弹窗的自动重试开关无法回读，`client.js:4232` 恒读到 `undefined` → 永远显示 off，但点一下确实生效。`test/parity.mjs:290` 用断言锁住该缺口。注意 `autoCompactionEnabled` **不是**同类问题：它在 `RpcSessionState` 里，面板 `loadState` 整份存进 `info`，`client.js:4231` 读到的是真值。 |
| `D-08` | `cycle_model` 在 RPC 面无方向参数（`rpc-types.ts:34` 是 `{ type: "cycle_model" }`） | `Ctrl+P` 只能正循环；TUI 的 `cycleModel(direction)`（`interactive-mode.ts:4723-4725`）两个方向，RPC 面只有一个。 |

## 7. 验证命令

```powershell
npm test                                        # 13 项离线门禁，全程实测 ~21 秒：
                                                # selfcheck → client-render(831) → css-tokens(98)
                                                # → runtime-resolve → config-hot → host-parity(291)
                                                # → session-projects(55) → timeout(28) → parity(78)
                                                # → tui-editor(67) → restart-lib(31×2 引擎)
                                                # → github-sync(82) → version
                                                # 耗时大头：restart-lib ~9.1 s（起 pwsh 7 + 5.1 各跑一遍 fixture）、
                                                # github-sync ~6.3 s（临时仓库里用真 git 跑完整同步流程）、
                                                # timeout ~3.1 s（真等超时周期）、tui-editor ~2.6 s（jiti 加载 .ts + 起两次 PowerShell 读剪贴板）；其余合计 <1.5 s
npm run test:all                                # 上面 13 项 + 真起 pi 子进程跑一轮 LLM
npm run test:tui                                # 只跑输入框扩展门禁（jiti 加载真 .ts + pi 真 CustomEditor + 真按键序列）
npm run pi:editor                               # 把 extensions/superpi-editor.ts 装进 pi（<piAgentDir>/extensions/）
npm run pi:editor:status                        # 只读：源/目标/内容是否一致/pi 版本
npm run pi:editor:remove                        # 卸掉，pi 下次启动恢复原始输入框
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

## 8. 现状快照（2026-11-17 · v0.9.2）

- **RPC 命令**：pi 侧 33 条，面板已实现 32 条 + `steer` 1 条走等价路径（`prompt` + `streamingBehavior:'steer'`，`client.js:5067`），缺口 0。
- **扩展 UI**：9 种请求全部已实现（`applyExtensionUi()` `client.js:1661-1706`），3 种应答全通（`POST /sessions/:id/respond` `index.js:1083-1102`）。倒计时取 `min(pi 声明值, 5 分钟兜底)`（`dialogBudgetMs()` `client.js:1646`，`DIALOG_FALLBACK_MS` `src/rpc-contract.mjs:260`），且 host 侧命令 timer 会为挂起的弹窗让位（`restartPendingTimers()` `src/pi-rpc.mjs:490`）——**这两侧必须同时成立**，否则就是 0.2.5 那个「红条与对话框并存」的缺陷。
- **事件**：25 类 = 已实现 22 + 显式忽略 3（`turn_end` / `agent_end` / `summarization_retry_attempt_start`，理由见 `docs/parity.md` §3），缺口 0。
- **TUI 斜杠**：27 条 = 已实现 17 + 仅命令行 9 + `unsupported` 1（`/import`）+ 缺口 0。
- **`D-03` 已闭环**：「新会话」`runNewSession` → RPC `new_session`（与 `/new` 同一条路径，同进程换树，`client.js:5236`）、「重连」`endSession`（换子进程，旧事件缓冲丢掉，`client.js:5248`）。0.2.5 把换进程当新会话，同一件事两个入口两种结果。0.7.0 起重连不再占顶栏明面 —— 它退进 `⋯` 更多菜单并要过二次确认（见 0.7.0 那段），因为换子进程是恢复手段而不是日常动作。
- **剩两个上游协议面限制未闭环**：`D-07`（`get_state` 无 `autoRetryEnabled`）与 `D-08`（`cycle_model` 无方向参数），面板侧无解，见第 6 节；`test/parity.mjs:290` 用断言锁住 `D-07`，pi 哪天补了字段该断言会红，届时才是闭环时机。
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
- 门禁规模（0.8.1）：`test/client-render.mjs` 831 断言（0.8.0 的 797 + 弹窗遮罩与菜单外部点击的纯函数断言、四个弹窗的 SSR 两层结构、`projectTitleOf` 八条）、`test/css-tokens.mjs` 98、`test/host-parity.mjs` 291（0.8.0 的 276 + `withProjectIdentity` 9 条 + 会话快照带 `displayPath`/`projectKey` 6 条）、`test/session-projects.mjs` 55、`test/parity.mjs` 78、`test/timeout.mjs` 28、`test/restart-lib.mjs` 22 条 node 断言 + 双引擎各 31 条 PS 断言。
- **一键启动链路（0.8.2–0.8.4）**：只动 `tools/`，没碰插件运行时。0.8.2 新增 `tools/start-standalone.ps1` / `.bat`（状态落在仓库内 `.standalone\`、默认端口 25117、`-Stop` / `-Status` / `-Reinstall` / `-Port`，首次装依赖之后复用）；0.8.3 加仓库根目录 `一键启动.bat`（**纯 ASCII 转发器**，逻辑不复制）；0.8.4 新增 `tools/launch-both.ps1` —— 一次双击**并行起两个前端**（新控制台窗口里的 pi TUI + 后台 DSH web），根目录 bat 转给它。**关键事实**：pi 不带 `--mode` 时进交互式 TUI，而它在非 TTY 下会静默退出（`exit 0` 零输出），所以 TUI 必须开真实控制台窗口（`wt -d <dir> cmd /c ...`，wt 缺失回落 `start "" /D ...`），后台进程里跑 pi 等于什么都没发生。
- **改名 SuperPi（0.9.0）**：产品与插件标识全量改为 `superpi` / `SuperPi`，涉及 `client.js`（i18n、面板标题）、`index.js`（`NS` / `apiPrefix` / 自检文案）、`cordis.patch.yml`、README、LICENSE、`docs/*`。**包名与安装链保持不变**：`package.json.name` 仍是 `superpi`，tarball 仍是 `superpi-<version>.tgz`（`test/version.mjs` 写死这个名字）。
- **线上同步（0.9.1）**：把仓库发布到 <https://github.com/lwaaron/superpi>（private，`origin` / `master`），并落地「提交永远先本地、能连上就同时推线上」的机器约束 —— 见第 9 节。新增 `tools/github-sync.mjs`（同步引擎 + CLI）、`tools/git-hooks/post-commit`（后台自动试推）、`test/github-sync.mjs`（82 条门禁，临时裸仓库当真远端，不联网）、`.gitattributes`（钉死 `*.ps1` LF / `*.bat` CRLF，否则 `core.autocrlf=true` 的克隆会让 `test/restart-lib.mjs` 的「无游离 CR」断言必红）。npm 脚本新增 `sync` / `sync:status` / `hooks`；`npm test` 从 11 项变 **12 项**（耗时 ~15 s → ~20.5 s，github-sync ~6.3 s）。**`tools/` 不进 npm 包**（`files` 不含它），插件运行时与 RPC 契约一行未动。
- **输入框能力对齐（0.9.2 · 第三层：不是 RPC 面，是输入框本身）**：命令行 TUI 的输入框是 pi-tui 自己实现的 `Editor`，**没有选区模型** —— `tui.input.copy`（ctrl+c）在 `editor.js:597` 直接 `return` 交回上层，pi 的 `CustomEditor` 再交给 `app.clear` → `handleCtrlC()`（`interactive-mode.js:3595-3603`）**清空输入框**，这就是「Ctrl+C 复制后内容消失」；`tui.editor.cursorLineStart` 默认键是 `["home","ctrl+a"]`，所以 Ctrl+A 是「移到行首」；`ctrl+x` 全表无绑定。另一半是 Windows 缺口：`getNativeClipboard()` 只导出 `getText/setText/getImage/enableVirtualTerminalInput/isModifierPressed`，**没有 `getFilePaths`**（只有 macOS 有），因此资源管理器复制文件后 Ctrl+V 三档全空（filePaths / image / text 都是 null）。处置：新增 `extensions/superpi-editor.ts` —— `class SuperPiEditor extends CustomEditor` + `ctx.ui.setEditorComponent()`（pi 官方扩展点，官方示例 `examples/extensions/modal-editor.ts` 同款），**不改 pi 任何文件、不打补丁**；能力 = Ctrl+A 全选 / Shift+方向·Home·End 扩选 / Ctrl+C 复制（有选区复制选区、无选区复制全文，都不清空）/ Ctrl+X 剪切 / Backspace·Delete 删选区 / 可打印字符与括号内粘贴替换选区 / Ctrl+V 在「无文本且无位图」时读 Windows `CF_HDROP`（PowerShell `GetFileDropList`，异步、1.5 s 超时、base64 防中文乱码）插绝对路径；空编辑器 Ctrl+C **刻意放行**以保住 pi 的两次退出，Esc 只清选区不吞键。pi 在 `setEditorComponent` 时会自动接回 `onSubmit`/`onChange`/`borderColor`/`paddingX` 与**全部 `actionHandlers`**（`interactive-mode.js:2336-2385`），所以扩展不重写 app 键位。安装面 `tools/install-pi-extension.mjs`（`--install/--remove/--status`，落到 `<piAgentDir>/extensions/`，`PI_CONFIG_DIR` 跟随）+ `package.json` 的 `pi:editor` / `pi:editor:status` / `pi:editor:remove`；`tools/launch-both.ps1` 起 TUI 前自动装一次（`-NoEditorExtension` 可关，失败只 WARN）；`files` 新增 `extensions` 让它随 tarball 发布。门禁 `test/tui-editor.mjs` **67 checks**（`npm test` 12 → **13 项**）：用 jiti 加载真 `.ts` + pi 真 `CustomEditor` + 真终端按键序列（像 `\x1b[1;2C` 这种原始字节），末组再用 **pi 自己的扩展加载器**（`core/extensions/loader.js` 的 `discoverAndLoadExtensions`）把装到临时 `agentDir` 的扩展真加载一遍断言无 error —— 这才是「装完 pi 真的能认」的机器保证。账本新增 `docs/parity.md` §5.1。**先做的补丁版（wrap 打包 chunk 原型 + 换 `readClipboardFilePaths` 函数体）已被用户禁用并全部删除回退**，pi 运行时从未被修改（`--status` 核验「未应用」）。
- 逐条账本见 `docs/parity.md`；机器保障是 `npm test` 里的 `test/parity.mjs` + `test/host-parity.mjs` + `test/timeout.mjs` + `test/tui-editor.mjs`。

## 9. 线上同步（GitHub）

代码在 <https://github.com/lwaaron/superpi>（**private**）：远端名 `origin`、分支 `master`、HTTPS，凭据只走本机 Git Credential Manager，**仓库里不放任何 token**。

用户 2026-11-17 定的规矩，逐字：「以后每次有新的版本提交都同步更新到线上 github，如果连不上网就先提交本地，如果连上了就提交本地之后同时提交线上 github。」落到代码里是三条硬约束：

1. **提交永不因网络失败**。`tools/git-hooks/post-commit` 把同步跑在后台（`&` 分离、永远 `exit 0`），离线时什么都不做，提交照旧落地。
2. **欠的提交会被补推**。`npm run sync` 每次都先 `ls-remote` 比对，不相等才推 —— 上次离线留下的提交下次自动跟着走。
3. **失败必须分得清**。`auth`（凭据/权限）/ `rejected`（线上分叉）/ `offline`（连不上）/ `failed` 四类不许合并：把认证失效说成离线，就会永远静默重试并以为「只是没网」。

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

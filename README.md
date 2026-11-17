# SuperPi

把 [pi](https://github.com/lwaaron/pi) 作为 DSH 的侧栏面板接进来：左侧栏「pi」入口，主区一整页聊天界面，背后是一个常驻的 `pi --mode rpc` 子进程。

不是重新实现 pi 的 TUI，而是复用 pi 官方的 **RPC 协议**（`packages/coding-agent/docs/rpc.md`）做一层薄适配 —— pi 升级时只要 RPC 帧不破，面板就不用改。

**这个插件本身是可独立分发的**：pi 运行时从插件自己的目录解析（`node_modules` → `.runtime` → 逐级向上 → pnpm store → npm 全局），装不上还能在面板里一键安装到 `.runtime`。不需要在代码里写死任何本机路径，也不需要用户先手工构建 pi。

## 结构

```
index.js              host 半区：HTTP 路由 + 会话池 + 子进程生命周期 + 自检
client.js             浏览器半区：侧栏入口注册 + 聊天面板（零构建，纯 JS + React.createElement）
cordis.patch.yml      bundle 补丁，把本插件插入 DSH 宿主组合
src/rpc-contract.mjs  RPC 契约：33 条命令 / 25 类事件 / 27 条斜杠 / 9 个扩展 UI method 的唯一真相源
src/pi-rpc.mjs        JSONL 帧解析 / RPC 命令配对 / 事件缓冲 / 扩展 UI 请求跟踪与应答
src/pi-runtime.mjs    pi 运行时解析链 + 一键安装（唯一知道「pi 装在哪」的地方）
src/session-store.mjs 会话落盘目录扫描（读 ~/.pi/agent/sessions，语义对齐 pi 的 SessionManager）
assets/icon.svg       插件图标
```

两半区的硬约束（改动前先读）：

- `index.js` / `src/pi-rpc.mjs` / `src/pi-runtime.mjs` **不 import 任何 `@deepseek-ai/*` 包**。宿主里那些包解析不到，写死依赖会让插件 fiber 永久 pending，DSH 启动就卡住。只用 node 内建。
- `@deepseek-ai/schemastery` 是唯一例外，且必须**动态 import + 兜底**：静态 import 失败会让整个 server entry 加载失败，插件被标「异常」；兜底成 `Config = undefined` 只是「插件详情页没有配置区」，面板照常工作。
- 子进程隔离而非 SDK 内嵌：pi 崩掉只影响这个面板，不会带崩 DSH 主进程。
- `client.js` 里 `sidebar.panellist` 的 `id` 必须与 `main` keyed slot 的 `key` 相同，且两次 `slots.inject` 都要包在 `ctx.inject([...])` 内，否则 entry 永久 pending。
- 客户端 `require` 白名单只有 `react` / `react-dom` / `jsx-runtime` / `@deepseek-ai/dsh-client-ui-primitives`；样式只用 `--dsw-*` 变量，深浅色主题自动适配。
- 命令表 / 事件表 / 斜杠表只在 `src/rpc-contract.mjs` 里定义一份。`client.js` 不许硬编码命令名与事件名，挂载时先取 `GET /contract`；加一条 RPC 能力的顺序固定为「改契约 → 改面板 → 跑 `test/parity.mjs`」。

## 安装

### 方式零：一键启动（TUI 编程会话 + 面板，两个一起起）

**双击仓库根目录的 `一键启动.bat`** 即可。它**同时**起两个前端，互不阻塞：

| 前端 | 形态 | 用途 |
| --- | --- | --- |
| **pi TUI** | 新开一个真实控制台窗口（Windows Terminal 优先，回落 conhost） | **写代码的交互式编程会话**——就是你要敲字进去的那个窗口 |
| **DSH web** | 后台服务，端口 25117 | 浏览器 / 侧栏面板形态的 UI |

两者是**同一个 pi、同一个 agent loop 的两个平级前端**（见 AGENTS.md 第 1 节），不是父子、不互相替代。

```powershell
.\一键启动.bat                                # 两个一起起
.\一键启动.bat -Resume pick                   # TUI 弹列表选一个历史会话接续
.\一键启动.bat -Resume new                    # TUI 开全新会话
.\一键启动.bat -WorkDir D:\my_projects\foo    # 让 agent 在那个项目里干活
.\一键启动.bat -NoTui                         # 只起面板
.\一键启动.bat -NoWeb                         # 只开编程会话窗口
.\一键启动.bat -Status                        # 只看两者状态
.\一键启动.bat -Stop                          # 两个都停
```

- **TUI 必须开真实控制台窗口**：实测 pi 在非 TTY（stdout 被重定向）下会**直接静默退出**，所以在后台进程里跑它等于什么都没发生。脚本用 `wt -d <workdir> cmd /c <node> <cli> <--continue>` 开新窗口，这一点是这个入口存在的核心理由。
- **两个互不阻塞**：任一失败不影响另一个，最后分别报 `OK / WARN / FAIL` 与失败原因；只有两个都失败才 `exit 2`。
- 根目录 `一键启动.bat` **只是转发器**：逻辑全在 `tools\launch-both.ps1`，参数（`%*`）与退出码原样透传，不复制实现。
- pi 与 node 一律走 `src/pi-runtime.mjs` 的解析链（`resolvePiRuntime` / `resolveNodeRuntime`），**没有任何硬编码路径**。
- TUI 的 pid 记在 `.standalone\tui.json`，`-Stop` 只关自己起的那个，不动你另外开的 pi。

> **`.bat` 的内容都是纯 ASCII，这是刻意的。** `cmd.exe` 按**当前控制台代码页**逐行读取 `.bat`；
> 执行 `chcp 65001` 之后，任何非 ASCII 行的字节偏移与 cmd 已缓存的行边界不再对齐，多字节字符会被从中间切断，
> 导致后续行被当成乱码命令执行。实测后果是「注释被当命令刷屏」，极端情况下 `set "TARGET=..."` 被截断、转发直接失败。
> 所以中文交互文案全部放在 `.ps1` 里（PowerShell 不经过 cmd 的行解析），`.bat` 只留 ASCII。
> 仓库既有的 `tools\restart-dsh.bat` 也受同一问题影响（会刷出几条乱码，但主流程仍能跑通），暂未改动。

#### 只想要面板（不起 TUI）

双击 `tools\start-standalone.bat`，或：

```powershell
.\tools\start-standalone.bat -Port 25117      # 换端口
.\tools\start-standalone.bat -Status          # 只看状态
.\tools\start-standalone.bat -Stop            # 停掉面板实例
.\tools\start-standalone.bat -Reinstall       # 插件升级后强制重装
```

它做的事和「方式四」同源，但**面向常驻使用**：状态全部落在仓库内的 `.standalone\`（已 gitignore，可随时整个删掉），
首次运行装一次依赖（约几分钟，需联网），之后**直接复用、秒起**；不碰桌面 profile，不影响你正在用的 DSH。

- 端口默认 **25117**，刻意选了罕见值，避开 3000 / 5173 / 8080 这类被开发工具占满的区间。
- 起完会打印 `api -> http://127.0.0.1:25117/api/superpi`。**面板是 DSH 的侧栏 slot，没有独立的 `/superpi` 网页入口**；要看界面就把这个 profile 接进 DSH 客户端，或用任意 HTTP 客户端打上面这组免 token 接口（`/health`、`/state`、`/sessions`…）。实例的 web 根路径由宿主鉴权层保护，无 token 直接 401 属于预期。
- 已装版本与仓库 `package.json` 版本不一致时自动重装，避免面板跑旧代码。
- 全部路径从脚本自身位置推导，**换目录、换盘符都不用改脚本**。

> 与「方式四」的区别：`standalone-verify.ps1` 是**一次性自证**——每次从空 `DSH_HOME` 重装、跑完真实 LLM 往返就把临时目录删掉，
> 默认端口 25119（不与常驻的一键启动实例争用）。本脚本是**常驻启动器**，装一次留着用。

### 方式一：一键装进 DSH profile（推荐）

```powershell
# 打包 → 装到临时目录验证（真跑一轮 LLM）→ pnpm add 进 profile → 再验证一次 → 生成回滚脚本
pwsh -NoProfile -File .\tools\install-plugin.ps1 -Profile desktop
```

**必须由包管理器落地，不能手工往 node_modules 里塞副本。** DSH 的插件管理器运行时会跑 pnpm；只要 `package.json` 与 `pnpm-lock.yaml` 对不上，或者 `node_modules/.modules.yaml` 不认识这个包，pnpm 就会把手放的目录当孤儿清掉。脚本因此把三份状态交给 pnpm 一次写一致：

1. `npm pack` 出 `superpi-<ver>.tgz`；
2. 装到 `%TEMP%\superpi-stage-*`，用**装出来的那份**跑一遍真实 LLM 往返（`test/packed-smoke.mjs`），失败则 profile 一动不动；
3. tarball 收进 `<profile>\.dsh-local-packages\`，备份 `package.json` / `pnpm-lock.yaml` / 现有 `node_modules\superpi`；
4. 用 **DSH 自带的 pnpm** 执行 `add file:<tarball>` —— manifest、lock、node_modules 由 pnpm 一次写一致，`optionalDependencies` 里的 pi 运行时随之落进 profile；
5. 校验五件事：manifest 的 `superpi` 是 `file:` 依赖、lock 里有 `superpi` 与 `pi-coding-agent`、`node_modules/superpi/index.js` 存在、`.modules.yaml` 认识 `superpi`、**装出来的副本与 tarball 逐字节一致**；任一项不满足即报失败并给回滚命令；
6. 用 profile 里那份副本再跑一遍真实 LLM 往返；

> 第 5 项里的字节比对不是洁癖：pnpm 对 `file:` 依赖按 lock 里的 integrity 复用 store，**版本号没变但内容变了时，它会把旧内容装回来并且 exit=0**。这时 tarball、manifest、lock 三者自洽，唯独 node_modules 里是旧代码 —— 只能靠内容比对拦住。所以改完代码必须同时升 `version`。
7. 生成 `rollback-<时间戳>.ps1`（恢复 `package.json` + `pnpm-lock.yaml`，再让 pnpm `install --frozen-lockfile` 收敛 node_modules）。

PATH 上的 `pnpm.ps1` 通常是 corepack shim，直接调用会报 `Cannot find module ...corepack\dist\pnpm.js`。脚本默认用 `%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs`，装到别的机器用 `-PnpmPath` 指过去。

**装完要重启 DSH 才生效**（插件在 import 时就把代码快照进内存了）。不想保留时运行脚本打印出来的 `rollback-<时间戳>.ps1` 即可原样退回。

重启这一步有现成脚本：它**按原命令行原样重启**（下面「重启分支做对了什么」讲为什么不是 `Start-Process $exe`）、等 `/api/superpi/health` 就绪，再拿运行中 `/state` 报的版本与**该实例自己加载的那份** `package.json` 对比，不一致就 `exit 2`，并把两种成因分开写清楚（磁盘刚装新版本而宿主没重启 / 重启了但旧进程没退干净）。

**最省事的用法：双击 `tools\restart-dsh.bat`**（Windows 上不需要先装 PowerShell 7，见下面「PowerShell 版本」）：

```text
tools\restart-dsh.bat                      双击或命令行直接跑：重启 + 核对
tools\restart-dsh.bat -SkipRestart         只核对，不重启（改完代码想确认生效没有）
tools\restart-dsh.bat -Plan                只打印重启计划（杀哪个 pid、用什么命令行、带什么环境变量）
tools\restart-dsh.bat -Port 5783           本机有多个实例时指定端口
```

命令行等价写法：

```powershell
pwsh -NoProfile -File .\tools\restart-dsh.ps1                  # 重启 + 核对版本
pwsh -NoProfile -File .\tools\restart-dsh.ps1 -SkipRestart      # 只核对，不重启
pwsh -NoProfile -File .\tools\restart-dsh.ps1 -Port 5783 -Plan  # 不动任何进程，先看清它要干什么
```

> 它会把当前 DSH 窗口一起关掉。别让 DSH 里的 agent 代跑 —— 脚本自己会拦：当前进程的祖先链里有目标实例的启动根时，直接 `exit 3` 并提示去外部终端双击 bat。确实要这样干加 `-Force`。

#### 本机同时有多个 instance（desktop / 独立验证实例）

脚本按 **profile 归属**挑实例，不再「取第一个能回 /health 的端口」：它先向每个 DeepSeek 进程占用的端口问 `/selfcheck`，拿到该实例自己报的插件 `root`，只有 `root` 落在目标 profile 目录下才算命中。归属不唯一时脚本不会瞎猜 —— 打印实例表然后 `exit 1`，要求用 `-Port` 指定。实测输出长这样（探针实例只在验证时临时起，平时只有一行 desktop）：

```text
dsh exe = C:\Users\PC\AppData\Local\Programs\DeepSeek Runtime\DeepSeek Runtime.exe
profile = C:\Users\PC\.dsh\profiles\desktop
api base = http://127.0.0.1:5783/api/superpi  (匹配依据：profile 归属 C:\Users\PC\.dsh\profiles\desktop)
本机其它 superpi 实例（不参与本次核对）：
  port 5599  version 0.4.2  pid 22884  root ...\_probe\dsh-home-standalone\profiles\pi-standalone\node_modules\superpi
OK: 运行中的插件版本与磁盘一致
```

查非默认 profile / 非默认 DSH_HOME 的实例：

```powershell
pwsh -NoProfile -File .\tools\restart-dsh.ps1 -SkipRestart `
  -Profile pi-standalone -ProfileRoot C:\path\to\dsh-home\profiles
```

重启分支只 `Stop-Process` **目标实例的启动根**（从实例 pid 沿父链往上走、遇到的第一个用同一个 exe 的祖先），同一台机器上别的 profile 实例各有自己的进程链，不会被牵连。

#### 重启分支做对了什么（0.4.2）

下面三条都是真缺陷，症状统一是「脚本说重启成功，但面板永远起不来」：

1. **命令行原样复用。** 桌面实例的宿主命令行带 6 个参数（`--expose-internals`、desktop-host 的 `index.js`、app.asar 里的 `dsh` 目录、profile 目录、`primary-runtime`、`pnpm.mjs`、`runtime\bin`）。旧实现是 `Start-Process -FilePath $exe` —— 一个参数都不带，等于换个东西启动。现在从实例 pid 沿父链找**启动根**，把启动根的命令行原文直接交给子进程（`ProcessStartInfo.Arguments`，引号一个字节不动）；拿不到命令行就拒绝重启，不猜。
2. **杀的是启动根，不是宿主 pid。** `/selfcheck` 自报的 `process.pid` 在桌面实例里是 GUI 主进程的子进程 —— 杀了它没人负责重新拉起，窗口还在、面板起不来。现在杀启动根，由它把整棵树重新拉起来。
3. **环境变量按目标实例重算。** 从 DSH 的集成终端或工具里跑时，环境里带 `ELECTRON_RUN_AS_NODE=1`（GUI 会被当纯 node 起，窗口根本不出现），以及别处残留的 `DSH_HOME` / `DSH_PROFILE` / `DSH_PORT`，会把实例顶到错误的 home。现在按目标实例 `/selfcheck` 报的 `root` 反推 `DSH_HOME`（形如 `<home>\profiles\<name>\node_modules\superpi`），`ELECTRON_RUN_AS_NODE` 只在命令行确实是「跑一个 .js」时才设，`DSH_PORT` 一律清掉；反推不出来 `exit 3`。要覆盖用 `-DshHome` / `-WorkingDirectory`。

`-Plan` 打印的就是这三项的最终决定，先看它再真跑：

```text
profile = C:\Users\PC\.dsh\profiles\desktop
api base = http://127.0.0.1:5783/api/superpi  (匹配依据：指定端口 5783)
重启计划：
  实例 pid     = 15188（/selfcheck 自报，或端口占用者）
  启动根 pid   = 28720
  exe          = C:\Users\PC\AppData\Local\Programs\DeepSeek Runtime\DeepSeek Runtime.exe
  命令行参数   = <无参数>
  工作目录     = C:\Users\PC\AppData\Local\Programs\DeepSeek Runtime
  环境 DSH_HOME = C:\Users\PC\.dsh
  环境 DSH_PROFILE = desktop
  环境 DSH_PORT = <从环境里移除>
  环境 ELECTRON_RUN_AS_NODE = <从环境里移除>
（-Plan：只打印计划，没有动任何进程）
```

退出码：`0` 成功；`1` 找不到/挑不出实例；`2` 版本不一致（跑起来了但装的是旧的）；`3` 拒绝重启（推不出发动参数、或脚本正跑在目标实例内部且没加 `-Force`）。

这一段的三个 PowerShell 函数（`Get-LaunchSpec` / `Get-DshHomeFromRoot` / `Get-EnvPatch`）由 `node test/restart-lib.mjs` 在 pwsh 7 与 5.1 双引擎下各跑 31 条断言，`npm test` 里已接入。

#### PowerShell 版本（`pwsh` 找不到 / 5.1 报语法错）

两种失败都见过，都已处理：

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `pwsh : 无法将"pwsh"项识别为 cmdlet…` | PowerShell 7 装了但目录不在 `PATH`（`C:\Program Files\PowerShell\7`），或者用的是加 PATH 之前开的旧终端 | 双击 `restart-dsh.bat`：它先 `where pwsh.exe`，找不到再试 `%ProgramFiles%\PowerShell\7\pwsh.exe`，都没有就回落到 5.1 的 `powershell.exe` |
| 5.1 下报 `Unexpected token ')'` / 中文变乱码 | 脚本含中文却没写 UTF-8 BOM，5.1 按 ANSI(GBK) 解码 | `tools\*.ps1` 一律带 BOM；改完文件跑一次 `tools\fix-bom.ps1` 复查并补回 |

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\restart-dsh.ps1 -SkipRestart   # 5.1 兜底
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tools\fix-bom.ps1                          # 补/查 BOM
```

`fix-bom.ps1` 本身是纯 ASCII，所以它在无 BOM 的 5.1 下也能跑 —— 别给它加中文注释。

只想验证不落地：`pwsh -NoProfile -File .\tools\verify-packed.ps1 -Keep keep`。

### 方式二：手工挂载（开发插件本身时用）

把源码目录链到 profile，改完重启 DSH 就能看到：

```powershell
New-Item -ItemType Junction `
  -Path   "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\superpi" `
  -Target "C:\path\to\superpi"
```

并在 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 末尾加：

```yaml
- insert:
    - id: superpi
      name: superpi
      config: {}
```

`id` 同时是配置命名空间，不要随意改。

### 方式三：手工 pnpm add（不想跑脚本时）

```powershell
npm pack                                        # 得到 superpi-0.9.3.tgz
cd "$env:USERPROFILE\.dsh\profiles\desktop"
node "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs" `
  add "file:C:\path\to\superpi-0.9.3.tgz" --ignore-scripts
```

不要在 profile 里用 `npm install`：npm 会另写一份 `package-lock.json`，而宿主插件管理器用的是 pnpm，两套锁文件互相看不见，下次插件安装就会把 node_modules 重建成 pnpm 理解的样子。

装 `optionalDependencies` 里的 `@earendil-works/pi-coding-agent` 时，pi 会被提升到 profile 的 `node_modules`，解析链第 6 步（逐级向上）命中；装不上也不影响插件加载，面板会引导一键安装到 `.runtime`。

装完核对（三条都要有输出）：

```powershell
Select-String -LiteralPath pnpm-lock.yaml -Pattern '^\s+superpi:$'          # lock 认识它
Test-Path node_modules\superpi\index.js                                     # 代码在
Select-String -LiteralPath node_modules\.modules.yaml -Pattern 'superpi'    # pnpm 认识它
```

### 方式四：独立运行验证（全新 DSH_HOME，不动现有 profile）

想知道「这东西真的能独立跑吗」，用这个脚本自证。它在你没碰过的临时 `DSH_HOME` 里从零搭一个 profile，只装 superpi，启动、开会话、跑一轮真实 LLM 往返，然后全部删掉：

```powershell
pwsh -NoProfile -File .\tools\standalone-verify.ps1            # 默认 25119 端口
pwsh -NoProfile -File .\tools\standalone-verify.ps1 -Keep      # 保留临时目录便于排查
```

它做的每一步都可核对：

1. `npm pack` 出 tarball（已有同版本 tarball 则复用）；
2. 建 `%TEMP%\superpi-standalone-<6hex>\profiles\pi-standalone`，四份配置文件：`package.json`（bundles 只留 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`）、`cordis.yml`（空列表）、`pnpm-workspace.yaml`（`nodeLinker: hoisted`）、`cordis.patch.yml`（唯一的 insert 就是 superpi）；
3. 用 **DSH 自带的 pnpm** 把 tarball 装进这个 profile —— pi 运行时作为 `optionalDependency` 被提升进来；
4. 用 **DSH 自己的 Electron 二进制**当 node 启动这个 profile 的 web 服务（`ELECTRON_RUN_AS_NODE=1`，独立端口）；
5. 打 `/health` → `/state` → `POST /sessions` → `get_state` → prompt「只说两个字：独立」→ 轮询 `snapshot` 等到 `agent_settled` → `DELETE`；
6. `taskkill` 关服务，删临时目录；助手回复非空才算 PASS（exit 0）。

通过时的关键输出（`/state` 的 `cliSource` 必须是 `walk-up`，`cliPath` 必须落在临时 profile 的 `node_modules` 里 —— 这两条同时成立，才证明插件没有依赖本机任何源码路径）：

```
[standalone] health    = ok (boot 3102 ms)
[standalone] plugin    = 0.4.2 (installed 0.4.2)
[standalone] pi source = walk-up 1.5.2
[standalone] pi cli    = ...\Temp\superpi-standalone-802b49\profiles\pi-standalone\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js
[standalone] model     = Deepseek-V4.1-Flash / odys-deepseek
[standalone] session   = d6406878-cc2f-4726-9a5b-fd5c51fac9fa pid=10036
[standalone] assistant = '独立' (2595 ms)
[standalone] PASS - superpi runs standalone in a fresh DSH_HOME
```

两条容易踩的：

- **profile 名不能叫 `web` / `desktop` / `tui` / `headless`** —— 这几个是 shipped 保留名，只能当模板用，要另起名字（脚本用 `pi-standalone`）。命令行形状是 `dsh <profileName> --port N --no-open`，app 参数写在 profile 名后面；写成 `--profile x web --port N` 会报 `too many arguments`。
- **`app.asar` 在文件系统视角是单个文件**，`Test-Path app.asar\dsh\...\cli.js` 恒为 false。脚本只校验 asar 本体在不在，asar 内部路径交给 Electron 解析。同理别硬编码安装目录名，用 `Get-Process` 拿真实路径。

> 脚本里的 `npm pack` 兜底走 `127.0.0.1:10808` 代理（仅在环境里没设 `HTTPS_PROXY` 时）。换机器跑请先导出自己的代理变量，或用 `-PnpmPath` 指到有效的 `pnpm.cjs`。

## pi 运行时：装在哪、怎么找

`src/pi-runtime.mjs` 是唯一知道答案的地方，顺序固定（命中即停，未命中也会记进 `searched` 供排障）：

| # | 来源 (`source`) | 位置 |
| --- | --- | --- |
| 1 | `config` | 配置里的 `cliPath`，可以是 `cli.js` 文件也可以是包目录 |
| 2 | `env` | 环境变量 `PI_CLI_PATH` |
| 3 | `env` | 环境变量 `PI_RUNTIME_DIR`（当模块解析起点用） |
| 4 | `plugin-node-modules` | `<插件>/node_modules/@earendil-works/pi-coding-agent` |
| 5 | `plugin-runtime` | `<插件>/.runtime/node_modules/...`（一键安装的落点） |
| 6 | `walk-up` | 从插件目录逐级向上最多 12 层找 `node_modules`（覆盖 npm/pnpm 把依赖提升到项目顶层的布局） |
| 7 | `pnpm-store` | `node_modules/.pnpm/@earendil-works+pi-coding-agent@*/`（`nodeLinker: isolated`） |
| 8 | `global-npm` | `dirname(process.execPath)`、`%APPDATA%\npm`、`%LOCALAPPDATA%\npm` |

node 可执行文件的解析同理：`config.nodePath` → `PI_NODE_PATH` → `PATH` 上的 `node.exe` / `node` → 宿主自身 `process.execPath`（最后这条会置 `ELECTRON_RUN_AS_NODE=1`，否则 Electron 宿主里起的子进程解析失败且日志为空）。

一个都找不到时，面板整页变成引导：一句「还没装 pi 运行时」+「一键安装 pi」按钮 + 已搜索位置清单（`✓/✗ source · path`）。按钮打的是 `POST /api/superpi/runtime/install`，内部执行：

```
npm install --prefix <插件>/.runtime --save-exact --no-audit --no-fund --loglevel=error @earendil-works/pi-coding-agent@1.5.2
```

装完立刻重新解析，无需重启 DSH（已开的会话不受影响，新会话用新装的那份）。Windows 上不用 `spawn(npm.cmd, { shell: true })`（会触发 DEP0190 且参数未转义），走 `cmd.exe /d /s /c` 自行加引号。

## 配置

写在 `cordis.patch.yml` 那条 insert 的 `config` 里；插件详情页的配置表单来自 `Config` schema，**只有标了 `.volatile()` 的字段**会进表单并被宿主原位热更新+持久化。
改完立刻生效，不用重启 DSH：`/state` 与新建会话每次都会带指纹比对地重解析一遍运行时（配置没变就是常数时间返回）。**前提是实现上不能把 `config` 展开成快照** —— 宿主下发的 volatile 字段是 cosmokit 的冻结引用 `{ get(), [write]() }`，值由宿主就地写入，照字符串读会拿到 object，让所有 `typeof === 'string'` 判断失假（这正是 0.2.0 里配置静默失效的原因）。本插件所有读取点统一走 `readSetting / readSettingString`，并由 `test/config-hot.mjs` 回归守卫。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `cliPath` | 自动探测 | pi 的 `cli.js` 绝对路径（或包目录） |
| `nodePath` | 自动探测 | 跑 pi 的 node 可执行文件 |
| `workspace` | `~/pi-workspace` | 新会话的默认工作区 |
| `extraArgs` | `""` | 空格分隔，追加到 pi 命令行（会话级 `args` 之后） |
| `args` | `[]` | 基础参数。历史版本默认 `["--no-session"]`，现在是否落盘由 `persist` 决定 |
| `persist` | `"true"` | `true` = 会话落盘到 `~/.pi/agent/sessions`；`false` = 追加 `--no-session`，退出即丢 |
| `startup` | `"continue"` | `continue` = 接上该目录最近的会话（`--continue`）；`new` = 全新会话 |
| `sessionName` | `""` | `pi --name`；留空不传（pi 收到空 `--name` 会直接 exit 1） |

`persist` / `startup` / `sessionName` 三个字段在 schema 里按**字符串**暴露（宿主配置表单只认 string），实现侧统一照字符串读，再由 `buildSpawnArgs` 翻译成 `--no-session` / `--continue` / `--name`。用户自己已经在 `args` / `extraArgs` 里写了同名参数时不重复生成。

环境变量（优先级低于 config）：`PI_CLI_PATH`、`PI_NODE_PATH`、`PI_WORKSPACE`、`PI_BASH`、`PI_RUNTIME_DIR`。

`PI_BASH` 用来告诉 pi 用哪个 bash（Windows 上装 Git for Windows 后指向 `C:\Program Files\Git\bin\bash.exe`）；不设则由 pi 自己找。

## HTTP 接口

同源、免 token（走 `webServer` 的 prefix 注册，不走宿主鉴权层）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/superpi/state` 或 `/api/superpi/` | `{version, apiPrefix, resolved, runtime, limits, sessions}`；`resolved` 是 node/pi 的解析结果，`sessions` 是当前所有会话的无事件快照 |
| GET | `/api/superpi/health` | `{ok, version}`，不碰磁盘也不碰子进程 |
| GET | `/api/superpi/selfcheck` | 自检：内存中加载的代码 vs 磁盘上的代码、pi 构建新鲜度；宿主没注入自检能力时回 501 |
| GET | `/api/superpi/diagnostics` | `plugin`（id/version/root/apiPrefix/pid/node/execPath）+ `runtime` + `selfcheck`，排障先看这个 |
| GET | `/api/superpi/runtime` | 运行时解析报告（`ok` / `source` / `cliPath` / `searched` / `install`） |
| POST | `/api/superpi/runtime/refresh` | 重新解析（手工装好 pi 后不必重启 DSH） |
| POST | `/api/superpi/runtime/install` | 一键安装 pi 到 `.runtime`（幂等，并发只跑一次）；失败回 500 |
| GET | `/api/superpi/contract` | RPC 契约原文：`version` / `piVersion` / `rpcCommands`(33) / `events`(25) / `assistantEvents`(12) / `tuiCommands`(27) / `bashShortcuts`(2)，逐字段原样下发 |
| GET | `/api/superpi/sessions/history?scope=&cwd=&limit=` | 历史会话列表（扫 `~/.pi/agent/sessions`）。`scope=all` 列**全部项目**并额外返回 `projects` 聚合数组；`scope=project`（或只给 `cwd`）只列该项目；两者都不给时按有没有 `cwd` 推断，**不再回落成插件 workspace**（0.4.2 及之前空 `cwd` 会回落，等于面板只能看见一个目录 —— 「历史会话只显示一条」的根因）。`limit` 默认 20、上限 200；宿主没注入时回 501 |
| GET | `/api/superpi/files?dir=&query=&limit=` | 只读列目录，给 @ 补全与「插入路径」用（RPC 协议没有 fs 能力）；`limit` 默认 50、上限 200；目录不存在回 404 |
| GET | `/api/superpi/file?path=` | 读单个文件给预览用（面板内 `FileSheet` 回落时用）。返回 `{ok,path,name,dir,size,mtime,kind,mimeType,text?,data?,truncated}`；`kind` = `text`（≤512 KiB，超出截断并置 `truncated`）/ `image`（≤8 MiB，`data` 是 base64）/ `binary`（前 8 KiB 出现 NUL，或图片超出体积上限）；`path` 支持 `~`、`%VAR%` 与相对工作区。目录回 400 `not a file`、不存在回 404 `no such file` |
| POST | `/api/superpi/reveal` | 在系统文件管理器里定位文件（助手回复里文件标签的右键菜单）：body `{path}`，Windows 走 `explorer.exe /select,<文件>`（macOS `open -R`、其它 `xdg-open` 父目录），回 `{ok:true,path}`。缺 `path` → 400 `path required`，目标不存在 → 404 `no such file`。只等 `spawn` 不等退出码 —— explorer 常把命令转交给已有实例后以非 0 退出 |
| GET | `/api/superpi/pi/changelog` | 读 pi 包内的 `CHANGELOG.md`（上限 200 KiB）；找不到也回 200 |
| POST | `/api/superpi/sessions` | 新建会话，body 可带 `cwd` / `label` / `args` |
| GET | `/api/superpi/sessions/:id` | 单个会话快照（不含事件数组，含 `pendingUi`） |
| DELETE | `/api/superpi/sessions/:id` | 关闭会话（先关 stdin 再超时 kill） |
| GET | `/api/superpi/sessions/:id/events?since=N` | SSE 事件流，15s 心跳注释帧 |
| GET | `/api/superpi/sessions/:id/snapshot?since=N` | 增量快照（重连补数据用），带本轮未应答的 `pendingUi` |
| POST | `/api/superpi/sessions/:id/command` | 转发一条 pi RPC 命令，body 必须是带 `type` 的 JSON 对象；`new_session` / `switch_session` / `fork` / `clone` 成功后清空事件缓冲并回填会话身份 |
| POST | `/api/superpi/sessions/:id/respond` | 应答扩展 UI 请求（`{id, value}` / `{id, confirmed}` / `{id, cancelled}` 三选一） |
| POST | `/api/superpi/sessions/:id/reset` | 清空该会话的事件缓冲，返回新的 `eventSeq` |
| GET | `/api/superpi/ui-prefs` | 面板偏好（项目显示名 / 会话显示名 / 置顶）的只读快照 `{version, updatedAt, projects, sessions}`；文件还不存在也照常回 200 与空结构；宿主没注入时回 501 |
| POST | `/api/superpi/ui-prefs/project` | body `{key, name}`：`key` 是项目路径、`name` 是显示名（自动 trim，空串 = 删除覆盖，上限 120 字）。未知键一个都不落盘（白名单），非法值回 400 |
| POST | `/api/superpi/ui-prefs/session` | body `{path, name?, pinned?}`：**合并式补丁** —— 只给 `name` 不会凭空置顶，只给 `pinned` 不会清掉已有名字；`pinned:false` 删除该条。`path` 上限 4096，非法值回 400 |

`/sessions/history` 必须排在会话 id 正则 `^/sessions/([^/]+)` **之前**处理，否则 `history` 会被当成会话 id 走进 `requireSession` 拿 404。

上限与错误码：8 个并发会话，请求体 4 MiB。`/command` 与 `/respond` 的 `content-type` 必须是 `application/json`（否则 415），body 必须是 JSON 对象（否则 400）；`/command` 还要求带字符串 `type`；`/respond` 要求非空字符串 `id`（否则 400）、该 id 必须仍在待应答集合里（否则 409），且 `value` / `confirmed` / `cancelled` 三选一 —— 一个都没有就回 400，**不会替你猜成取消**（猜错会让一个本该确认的对话框静默消失）。

## 面板行为

- 打开时先 `GET /state`：`runtime.ok === false` 直接切整页引导（不建会话）；否则已有会话就 `attach` 第一个，没有才 `POST /sessions`。挂载时还取一次 `GET /contract`，斜杠菜单与命令分发都读它，不在前端硬编码。
- **「新会话」与「重连」是两件不同的事**：新会话在顶栏，走 RPC `new_session`（同一个 `pi` 子进程里换会话树，与命令行 `/new` 同一条路径，快），新树建在**当前工作区**里；重连走 `endSession`（`DELETE` 旧会话 + 重建面板 + 新建，等于换一个子进程，旧事件缓冲一并丢掉），0.7.0 起它收进顶栏的「更多」菜单并且要过二次确认——换进程是恢复手段，不是日常动作。0.2.5 把「换进程」当成了新会话，导致顶栏按钮与 `/new` 同名不同义（D-03），0.3.0 起两者分开，0.7.0 起一个在明面一个进菜单。
- 对话区把 `turn_start / text_delta / thinking_delta / toolcall_* / turn_end` 归并成消息气泡，**过程流按 DSH 会话过程流的形状渲染**（0.6.4，见下方「过程行」条）：思考是父行、工具调用是它下面的缩进子行组，一次调用只占一行，展开即「参数 + 输出」（流式期间边跑边长，单条 partial 截 2000 字符），消息底部给 in/out/total token 数。
- composer 键位与 TUI 的 `keybindings.ts` 对齐：`Enter` 发送、`Shift+Enter` 换行、`Esc` 打断、`Ctrl+P` 下一个模型（`cycle_model`，只正循环）、`Shift+Tab` 切思考档位（`cycle_thinking_level`）、`Alt+Enter` 追加一条 follow-up（`follow_up`）、`Alt+Q` 取回排队中的消息（`clear_queue`）。输入 `/` 弹命令菜单、输入 `@` 弹文件补全（`GET /files`，选中只插入路径文本）。
- 发送语义随状态变：**空闲时**发 `prompt`；**正在跑时**再发，走 `prompt` + `streamingBehavior: "steer"`（插到当前回合里，不停机）；`Alt+Enter` 才是 `follow_up`（等本轮结束再发）。`/` 开头的 follow-up 仍走 `prompt` + `streamingBehavior: "followUp"` —— 因为 `follow_up` 会按扩展命令规则打回，和 TUI 里 `prompt()` 的行为不一致。
- `Esc` 按当前状态分四路：重试倒计时中 → `abort_retry`；bash 在跑 → `abort_bash`；空闲 → `abort`；正在跑 → **先 `clear_queue` 把排队文本取回来填进编辑器**，再 `abort`（直接 abort 会让仍留在队列里的消息继续执行，等于没停）。
- 思考档位（`get_available_thinking_levels` → `set_thinking_level`）与模型（`get_available_models` → `set_model`）共用一个**向上弹层**（`ModelPicker`，`.superpi-picker-menu` 定位在按钮上沿），都在**输入卡的行内左侧**，与宿主主对话区同位置 —— 它们决定「下一条怎么发」，属 composer 语义，不在顶栏；弹层分「切换模型」「思考档位」两段，当前项 `role=menuitemradio` + `aria-checked` 标记，Esc 或点外面关闭。连接状态用圆点表示（ready / busy / dead）。
- **输入区按宿主主对话区重做（0.6.2 / 0.6.3 补首次填充）**：卡面 `--dsw-radius-panel` 28px + `--dsw-specific-input-major` + `--dsw-elevation-soft`，行内左侧「28px 圆形 `+` + 模型 picker + 推理档位 picker」，右侧「34px 圆形发送键（空闲 `ArrowUpIcon` / 运行中同位 `StopSquareIcon`）」。`+` 弹分组菜单（添加 / 指令），条目只映射面板真实能力。卡下方是统计行：`N 轮 · N 步 · N tok · 缓存命中 N% · 上下文 N%`，数据来自 `get_session_stats`（缓存命中 = `cacheRead/(input+cacheRead+cacheWrite)`，与 pi TUI footer 同公式；tok/s 无可靠来源故不显示），在 `attach` / `reload` / `agent_settled` 三处刷新。
- **过程行按 DSH 会话过程流重做（0.6.4）**：思考 = 父行 `details.superpi-proc` > `summary.superpi-proc-head`（16px 图标 + 灰标签 + 2×2 中点 + 首行省略摘要，全文在展开区）；工具调用 = 父行下面的子行组 `div.superpi-sub`（`margin-left:26px` 让左侧 1px 竖线落在父行 label 左缘、`padding-left:12px` 让子行图标距竖线 12；0.8.0 起子行行盒与父行同为 24px、组内 `gap:8px`，子行步长 32 与父行同节奏 —— 中途曾把子行压到 16px 行盒 + gap 0，行距只剩父行一半，看着像被挤扁，已被推翻），正文与图片把过程流切段、之后重新起组。**一次调用 = 一行**：`toolResult` 消息按 `toolCallId` 归并进对应调用行的展开区（`── output ──`），孤儿结果仍单独渲染；`── live ──` 段只在 `status === 'running'` 时出现（跑完后它与 output 是同一件事，两段都印等于写两遍 —— 首次实拍就撞上了）。行内词汇全部取自 DSH 官方标题表（思考 / 运行命令 / 读取 / 读取图片 / 写入 / 编辑 / 搜索文件内容 / 查找文件 / 浏览目录 / 工具调用），未知工具兜底「工具调用 · <工具名>」，`read` 命中图片扩展名自动切「读取图片」；图标按工具名静态映射，不按参数猜。整段文字色取 `label-tertiary`（目标图逐像素实测 `rgb(129,133,140)`，`label-secondary` 明显偏深）。末尾工作状态行照抄 DSH `RunningStatus`：`.5px` 上 hairline + 16 网格鲸鱼尾 + `--dsw-alias-label-deep-diving` 蓝字（#345EBA，目标是「正在深度求索」而不是一条灰注释）+ 「深度求索中，用时 X分Y秒 ···」（单位之间无空格）（三个中点，与 DSH `chat.deepDivingFor` 同字），字号 `calc(var(--dsh-content-font-size,14px) - 2px)`、行高 22px 也照 DSH `.running`；时长按 `formatRunDuration` 三段拆（小时 / 分 / 秒，只有 hours>0 才出小时），计时器挂在节点自身（1Hz，不放面板级 repaint，否则每帧只为刷一行字就重算上百行流式 markdown），另配 `role=status` + `aria-live=polite` 只播报不带秒数的「深度求索中」。
- 斜杠命令统一按契约里的 `disposition` 分流：`rpc` 8 条转成 RPC 命令；`client` 8 条在面板内开界面（`/settings` `/session` 是居中弹窗、`/resume` 是左侧栏、`/tree` `/fork` `/hotkeys` 仍是抽屉、`/model` `/thinking` 打开同一个向上弹层）；`local` 1 条（`/changelog`）由 host 代读文件；`cli-only` 9 条与 `unsupported` 1 条各给一条明确提示，**绝不把 `/compact` 之类当普通消息发给模型**（0.2.5 的缺陷）。无法识别的 `/xxx` 保留 pi 的语义：提示一条「没这条命令」，然后原样当 prompt 发出去。
- 扩展 UI：`select` / `confirm` / `input` / `editor` 四种请求弹窗渲染（一次只显示一个，队列上限 12），应答走 `POST /respond`，`409` 静默吞掉（多半是 pi 已在 `agent_settled` 时丢弃）；`notify` / `setStatus` / `setWidget` / `setTitle` / `set_editor_text` 五种单向请求就地生效。倒计时按 pi 的声明走：扩展给了 `timeout` 就对齐它（`min(声明值, 5 分钟)`），没给就用 5 分钟兜底（`editor` 连 `timeout` 字段都没有），到点自动回 `cancelled: true`，否则那次 prompt 永远等不到 response。**host 侧同时让位**：命令的超时计时器看到还有弹窗挂着就续期，用户答完再重开一整轮窗口 —— 0.2.5 的「`pi command timed out` 红条与对话框并存」就是这两侧各自先超时造成的。
- 图片：粘贴或选择图片都进 `prompt.images`，composer 里给缩略图、可逐张删除，消息区按图片块渲染并可点开原图 —— 不降级成 `[image png]` 文字。
- 顶部还有一枚自检胶囊：绿「代码已同步」/ 黄「代码已更新 · 待重启」/ 黄「pi 需重新构建」，鼠标悬停给出结论、git 分支@短 sha 与缺失文件，点一下重新检查。请求失败就直接不渲染 —— 宁可少一个胶囊，也不要误报绿点。
- pi 运行时缺失时整页切到引导（见上文），不创建会话、不产生半死不活的状态。
- pi 进程退出时面板转红点并提供「重试」与「重新检查」，不会静默空白。
- **历史会话是两级的，与命令行 pi 的 `/resume` 同构**（0.7.0 起这块界面是左侧滑出的 `SidePanel`，不是抽屉；0.8.0 的增强见本节末条）：第一层列**全部项目**（`scope=all`，聚合规则逐条照抄 pi 的 `groupSessionsByProject`：当前项目置顶 → 非临时项目优先 → 最近活动降序；临时目录判定沿用 pi 的 `TEMPORARY_PATH_PATTERNS` 三条正则），点进项目后第二层只列该 cwd 的会话（`scope=project&cwd=…`）。pi 的 scope 开关在进项目后就失效（`session-selector.ts:1663`），所以这里做成两级导航而不是切换按钮，语义等价、点击更少。选中走 `switch_session`。
  跨项目切换后 `meta.sessionCwd` 用会话文件 header 的 `cwd` 校正（`get_state` 不回报 cwd，见 `rpc-types.ts:96-109`），面板里所有「当前工作区」显示点（空态 cwd、统计弹窗、目录弹窗起点）一律读 `sessionCwd` 而不是子进程的 spawn 目录。目标目录已被删除时 `MissingSessionCwdError` 翻成一条中文提示 —— pi 的 RPC 面没有 `cwdOverride` 分支（`rpc-mode.ts:624-630` 只转调 `switchSession`），面板替不了用户选「换目录继续」，只能指路命令行。
  `/fork` 抽屉读 `get_fork_messages`，选中走 `fork` 并把那条用户消息回填进编辑器。
- **挂载即对账**：`attach` 之后补一次 `get_messages` 整表重建消息列表（`messagesFromHistory`）。原因是 `new_session` / `switch_session` / `fork` / `clone` 成功后 host 会 `resetEvents()` 把事件缓冲清空，历史消息不会再以事件形式重放 —— 只靠 `snapshot` 重放的话，切过去必然是空白（0.4.0 及之前「点开历史会话没有内容」就是这个根因；命令行 pi 从 jsonl 恢复所以不受影响）。两道防线：会话已切走则丢弃响应；`busy` 期间不覆盖列表，改记待办，等 `agent_settled` 那一拍由 `drainHydrate` 补上。
- **历史会话两级列表、过程流行距与面板偏好（0.8.0）**：三件事都长在既有结构上，没有新开界面。①历史会话（顶栏入口与 `/resume` 共用 `SessionsSheet`）补齐「面板自己的账」：项目层标题固定「项目列表」且只在这一层给「新建项目」按钮，会话层标题换成项目名、返回箭头由 `SidePanel` 的 `onBack` 提供（原「← 全部项目」文字按钮已删）；搜索框占整行，placeholder 分「搜索项目」/「搜索会话」；项目行与会话行各带一个行内 `⋯` 菜单（重命名项目 / 在此新建会话 / 重命名会话 / 置顶或取消置顶）；会话标题按「用户改的名字 → pi 的会话名 → 首条用户消息摘要 → 末条消息 → 占位」取值（`sessionHeadline()` 取 `firstMessage` 首行、超 60 字符截断加 `…`）；置顶用两遍 partition 而不是 `sort`（host 给的顺序本身有意义，是最近活动降序）；改名走独立的 `RenameDialog` 而不是复用 `NameSheet`（`drawer` 是单值，改名会把左侧栏自己顶掉）。偏好不归 pi 的 RPC 面管，读写走 host 新增的 `/ui-prefs` 三条路由（见上方 HTTP 接口），落盘在 `<home>/.superpi/ui-prefs.json`（`SUPERPI_UI_PREFS` 可覆盖路径），文件不存在时按空偏好处理、不报错。②过程流行距按参考图重算：父行与子行同为 24px 行盒，`.superpi-sub` 组内 `gap:8px`、`margin-left:26px`、`padding-left:12px`，子行步长与父行一致；0.6.4 那版把子行压到 16px 行盒 + gap 0，行距只剩父行一半，是被推翻的中间态。③版本 0.8.0：tarball 名 `superpi-0.8.0.tgz`，`CONTRACT_VERSION` 同步 0.8.0。
- **弹层交互与顶栏标题（0.8.1）**：三处一起改。①四个居中弹窗（`Dialog` / `ConfirmDialog` / 选择工作区 / 扩展 UI 弹窗）统一成**真模态** —— 点遮罩即关闭，判定式只有一份（`maskHandler(onClose)`，判 `event.target === event.currentTarget`），内层不吞事件、不 `stopPropagation`；语义各自正确：确认框点遮罩等于**取消**而不是确认，扩展 UI 弹窗点遮罩回 `{id, cancelled:true}`（与右上角关闭键同一条路径），并补上原先缺的 `aria-modal`。②`MoreMenu`（顶栏 `⋯` 与历史会话行内 `⋯`）补「点外部关闭」：`isOutsideMenu(node, anchor, target)` 同时放行菜单自身与**触发按钮** —— 少了后半条，同一次点击里 `mousedown` 先关、`click` 又开，表现为「怎么点都关不掉」。③顶栏左上的 `SuperPi` 换成**当前项目标题**：host 侧 `withProjectIdentity()` / `snapshotOf()` 在每份会话快照上补 `displayPath`（`shortenHomePath`，家目录缩成 `~`）与 `projectKey`（`pathComparisonKey`），客户端 `projectTitleOf(prefs, meta)` 按「面板里改过的项目名 → `displayPath` → 原始路径」取值，取不到才回落品牌名；路径缩短的唯一真相留在 host，浏览器侧不复制这套逻辑。`RuntimeGate`（启动期无会话）保留品牌名。面板偏好同时上提到 `PiPanel`，顶栏与历史会话列表读同一份 `prefs`，改名后顶栏立刻跟着变。
- **输入框能力两端对齐（0.9.2）**：面板的输入框是浏览器的真 `textarea`，粘贴文件路径 / `Ctrl+A` 全选 / `Ctrl+C` 复制 / `Ctrl+X` 剪切 / `Backspace` 删选区都是浏览器原生行为；命令行 TUI 的输入框是 pi-tui 自己实现的 `Editor`，**没有选区模型**（`Ctrl+A` 是移到行首、`Ctrl+C` 被 pi 的 `app.clear` 吃掉去清空输入框、`Ctrl+X` 无绑定），Windows 的 native 剪贴板也没有 `getFilePaths`（只有 macOS 有），所以在资源管理器里复制文件后 `Ctrl+V` 三档全空。这段差异由 `extensions/superpi-editor.ts` 补齐 —— pi 官方扩展点 `ctx.ui.setEditorComponent()`，**不改 pi 任何文件、不打补丁**。装法 `npm run pi:editor`，卸载 `npm run pi:editor:remove`，生效需重启 pi 会话窗口或 `/reload`；一键启动会在起 TUI 前自动装一次（`-NoEditorExtension` 可关）。键位对照表见 `docs/parity.md` §5.1。

## 自检：现在跑的是不是磁盘上那份代码

改完插件源码后 DSH 不会热重载 —— 得重启才生效，而「以为生效了其实没有」是最容易浪费半小时的坑。`/selfcheck` 把这个问题变成一次 HTTP 调用：

判据只有一条：**插件加载那一刻读到的字节**（`loadedSha256`，在 `import` 时就固定下来）与**现在磁盘上的字节**（`diskSha256`）是否相等。mtime 只作为人看的辅助信息，不参与判定 —— checkout / 复制 / 回滚都能把 mtime 改得很新。

| 字段 | 含义 |
| --- | --- |
| `summary.stale` | 唯一该看的字段。`true` = 磁盘改了但内存里还是旧代码，重启 DSH 才生效 |
| `summary.changed` / `summary.missing` | 内容不一致 / 已消失的文件；`summary.hint` 是给人看的一句话结论 |
| `files[].runtime` | `true` 的（`index.js` / `client.js` / `src/*.mjs`）改动必须重启；`false` 的（`package.json` / `cordis.patch.yml`）只是随身文件 |
| `git` | 不用 spawn git，直接读 `.git/HEAD` 与 `refs`；`available:false` 表示没有仓库 |
| `pi.buildFresh` | bundle 目录里最新文件 vs `src` 目录里最新文件；`null` = 判断不了，`false` = 源码比构建新 |

## 测试

```powershell
npm test            # 十三项门禁：selfcheck + client-render + css-tokens + runtime-resolve + config-hot
                    # + host-parity + session-projects + timeout + parity + tui-editor + restart-lib
                    # + github-sync + version
                    # 全离线（不起 pi、不打 LLM、不推 GitHub），全程实测 ~21 秒。三个大头：
                    #   test/restart-lib.mjs ~9.1 s（pwsh 7 与 PowerShell 5.1 各起一遍跑 fixture）
                    #   test/github-sync.mjs ~6.3 s（临时仓库里用真 git 跑完整同步流程：裸仓库当远端、
                    #                          127.0.0.1:1 拒连当断网、另一个 clone 当分叉的那一方）
                    #   test/timeout.mjs      ~3.1 s（协议替身真等若干超时周期，把「弹窗让位」压到毫秒级）
                    #   其余八项合计 <1.5 s
npm run test:host   # 真起 pi 子进程跑一轮 LLM 往返（用插件的 .runtime）
npm run test:fresh  # 模拟全新机器：拷一份不带运行时的插件 → 断言 missing → 一键安装 → 能开会话
npm run test:config # 配置热更新：宿主就地写入 volatile 引用后 /state 必须立刻反映
npm run test:all    # 以上除 fresh 外全部串起来
npm run verify      # npm pack → 装到临时目录 → 用打包产物跑真实 LLM 往返
pwsh -NoProfile -File .\tools\standalone-verify.ps1   # 全新 DSH_HOME 里只装本插件，独立起服务跑一轮真实 LLM
```

各文件管什么：

| 文件 | 覆盖 |
| --- | --- |
| `test/_harness.mjs` | 共用冒烟骨架：桩 ctx + HTTP 面 + 14 条断言（含 `GET /sessions/:id`、404、415/400 边界、真实 LLM 往返） |
| `test/host-smoke.mjs` | 用上面的骨架跑**源码目录** |
| `test/packed-smoke.mjs` | 用上面的骨架跑**装出来的产物**（参数传入已安装的 `index.js`） |
| `test/runtime-resolve.mjs` | 9 组不联网单测：解析优先级、`describeRuntime` 落点、`expandPath`、config 写错时回退、volatile 引用解包与改写后重解析 |
| `test/config-hot.mjs` | 配置热更新：注入真实 volatile 形状的 config，断言填入/清空 `cliPath` 与 `workspace` 后 `/state` 立刻反映（防「展开成快照」回归） |
| `test/fresh-boot.mjs` | 全新机器模拟：解析链明确报 missing → `POST /runtime/install` → `source` 变 `plugin-runtime` → 能开会话 |
| `test/selfcheck.mjs` | 证明 `/selfcheck` 能分辨「内存里跑的代码」与「磁盘上的代码」 |
| `test/timeout.mjs` | 28 条超时语义门禁：`timeoutLimitMs` 的三态（正数=毫秒上限 / `0``负数``Infinity`=不设上限 / `NaN``乱码``对象`=TypeError 绝不静默降级）、到期即 reject 且不留孤儿 pending、不设上限时进程关闭由 `handleExit` 兜底、**弹窗未答则计时期续期**、**应答后重开一整轮窗口**、续期上限耗尽时报「dialog(s) never answered」。用 `test/fixtures/fake-pi-rpc.mjs` 做协议替身，把 5 分钟的真实等待压到毫秒级 —— 这是 0.3.0 之前「红条与对话框并存」那个缺陷唯一可靠的门禁 |
| `test/fixtures/fake-pi-rpc.mjs` | 假 pi RPC 子进程（`FAKE_PI_MODE=dialog/silent`）：只为复现「命令永不回答」与「命令在等弹窗」两种时序，不模拟其他行为 |
| `test/fixtures/pi-ext-ui-probe.ts` | 扩展 UI 探针（人工验证用，不参与 `npm test`）：复制到 `%USERPROFILE%\.pi\agent\extensions\` 并重启 pi 会话后，`/dsh-ui-probe` 依次弹 select→confirm→input→editor，`/dsh-ui-notify` 验五个单向方法。**扩展对话框必须真人点，自动化只能测到 host 侧的时序**，所以探针留在仓库里当复现手段 |
| `test/client-render.mjs` | `react-dom/server` 把面板渲染成字符串（含键集与循环展开共执行 831 次，条数由脚本自报 `PASS (831 assertions)`）：挡组件异常、文案缺键、中英键集不一致、引导页结构、以及扩展 UI 四种弹窗（confirm 的「否/确认」按钮集、select 的选项数、input 的 prefill/placeholder、editor 的多行回填、空 title 回落、`dialogBudgetMs` 的「声明值与 5 分钟上限取小」四类非法值回落）。**倒计时的「还剩 Ns」文案断言不到**——那行由 `useEffect` 驱动，SSR 阶段 `left` 为 `null` 不渲染，只能在真浏览器里验 |
| `test/css-tokens.mjs` | CSS 门禁 98 条：禁硬色值（只准 `--dsw-*`）、令牌白名单、字体栈、`:focus-visible` 可见性、`prefers-reduced-motion` 兜底，另有 0 号自检确认门禁本身不是空跑 |
| `test/restart-lib.mjs` | 重启脚本门禁：22 条 node 断言（文件层：UTF-8 BOM、无游离 CR、库模式开关、去注释后无裸 `Start-Process -FilePath $exe`、走 `ProcessStartInfo`、有自保护）+ `test/fixtures/restart-lib-checks.ps1` 的 31 条 PS 断言（`Get-LaunchSpec` 四种输入、`Get-DshHomeFromRoot` 五种、`Get-EnvPatch` 六种、`Get-LaunchRootPid`/`Test-SelfAncestorOf` 对活进程、`Test-DshPiHealth` 对五种假响应与死端口）。**pwsh 7 与 PowerShell 5.1 各跑一遍**，是「5.1 能不能读这个脚本」的唯一机器保障 |
| `test/version.mjs` | 版本号单一真相：`/health`、`/state`、`/diagnostics` 报的版本必须等于 `package.json` 的 `version`；换版本重新加载要跟着变（防写死常量）；`package.json` 缺失时降级 `0.0.0` 而不是崩；README 里的 tarball 名必须跟版本对齐 |
| `test/session-projects.mjs` | 两级历史列表 55 条：`pathComparisonKey` 大小写归一、`isTemporaryPath` 三条正则逐条对齐 pi（`/tmp`、`appdata/local/temp`、`pi-runtime-*`）、`shortenHomePath` 的 `~` 缩写边界、`groupSessionsByProject` 的「当前项目 → 非临时 → 最近活动降序」与大小写合并、`listAllSessions`/`listSessions` 的「全部项目 vs 单项目」两种语义、`readSessionCwd` 只读 64KB 头行且首行非杂项时返回空、`firstRunningSessionFile` 的「跨项目也算当前会话」与活/死优先级。造一棵符合 pi 目录约定的假 `sessions/` 树来跑，不碰真会话 |
| `test/host-parity.mjs` | host 侧离线一致性 291 条：`buildSpawnArgs` 19 条（`persist=false` 不吃 `--continue`、用户自带 `--fork`/`--no-session` 不重复生成、空 `--name` 不传）、`pickCurrentSessionFile` 8 条、以及 `/respond` 的 409/400/415/200、`/reset`、四条替换命令的 reset+refresh、`/files` 排序与 404、`/file` 预览 28 条（文本截断 / 二进制探测 / 目录 400 / ENOENT 404 / MIME 映射 / `~` 与 `%VAR%` 展开）、`/pi/changelog` 三情形、未知路由 404、`/ui-prefs` 三条路由 33 条（GET 空文件回落、项目改名 trim 与键白名单、会话置顶与「只给 name 不许凭空置顶」的合并语义、四类 400）。**路由与参数拼错了只会静默跑偏，所以单独立门禁** |
| `test/parity.mjs` | 与 pi 的三向对账 78 条：以 pi 的 `RpcCommand` 联合类型、`RpcSessionState` 接口、`docs/json.md` 事件表为事实来源，双向比对（我们缺的 = 缺口，我们编的 = 幻觉），再断言契约里 33 条命令 / 25 类事件 / 12 种 assistant 事件 / 27 条斜杠 / 9 个扩展 UI method 在面板里都有落地字面量，且 `CONTRACT_VERSION` 与 `package.json` 同步。0.2.5 时「只发 5/33 命令、只处理 12/25 事件、27 条斜杠一条没接而 `npm test` 全绿」正是这个门禁要拦的事 |
| `test/tui-editor.mjs` | 输入框扩展门禁 **67 条**（0.9.2）：**用 jiti 加载真 `.ts` 扩展**（与 pi 的 `core/extensions/loader.js` 同一套 alias）+ **pi 真的 `CustomEditor`** + **真终端按键序列**（直接喂原始转义字节的按键序列），断言 Ctrl+A 全选、Shift+方向扩选、Ctrl+C 复制后内容不消失、Ctrl+X 剪切、Backspace/Delete 删选区、可打印字符与括号内粘贴替换选区、Esc 不吞键、空编辑器 Ctrl+C 放行、自动补全打开时不抢方向键、渲染反色开合成对；末组用 **pi 自己的扩展加载器**（`discoverAndLoadExtensions`）把装到临时 `agentDir` 的扩展真加载一遍断言无 error —— 这一步才证明「装完 pi 真的能认」。**不 mock 编辑器**：影子实现会让「测试绿、真机不灵」|
| `extensions/superpi-editor.ts` | 命令行会话窗口的**输入框增强**：`class SuperPiEditor extends CustomEditor` + `ctx.ui.setEditorComponent()`（pi 官方扩展点），补上 TUI 缺的那套 Windows 输入框语义（全选 / 扩选 / 复制不清空 / 剪切 / 删选区）与「剪贴板里的文件 → 绝对路径」。**不改 pi 任何文件、不打补丁**，卸载就是删一个 `.ts`（`npm run pi:editor:remove`）|
| `tools/install-pi-extension.mjs` | 把上面的扩展装进 `<piAgentDir>/extensions/`（`--install` / `--remove` / 默认只读状态），`PI_CONFIG_DIR` 跟随；幂等、内容变了先留 `.bak`。`npm run pi:editor` / `pi:editor:status` / `pi:editor:remove` 三个别名|
| `一键启动.bat`（仓库根） | 一键启动的**根目录入口**，纯 ASCII 转发器：把 `%*` 与退出码原样透传给 `tools/launch-both.ps1`。逻辑不重复实现 |
| `tools/launch-both.ps1` | **同时起两个前端**：① pi TUI（新开真实控制台窗口，走 `src/pi-runtime.mjs` 解析链拿 pi 与 node）；② DSH web（后台 25117）。互不阻塞，分别报 `OK/WARN/FAIL`；`-Stop` 只关自己起的（TUI pid 记在 `.standalone/tui.json`）。**pi 在非 TTY 下会静默退出，所以 TUI 必须开真实窗口** |
| `tools/start-standalone.ps1` / `.bat` | **一键启动**常驻实例：状态落在仓库内 `.standalone\`，首次装依赖、之后复用；默认端口 25117；`-Stop` / `-Status` / `-Reinstall` / `-Port`。位置无关，不碰桌面 profile |
| `tools/standalone-verify.ps1` | 全新 DSH_HOME 自证：建临时 profile → pnpm 装 tarball → 起独立实例 → 真实 LLM 往返 → 清理（端到端演练，不是单测）。默认端口 25119，不与一键启动实例争用 |
| `tools/github-sync.mjs` | **线上同步**（把本地提交推到 <https://github.com/lwaaron/superpi>）：`syncOnce()` 先 `ls-remote` 探一次（既测连通、也避免重复推）→ 不相等才 `git push origin HEAD:refs/heads/<branch>` → 再补 `git push --tags`。失败按 stderr **分四类**：`auth`（凭据/权限，要人处理）/ `rejected`（线上分叉，**绝不 force**）/ `offline`（连不上，提交留本地等下次）/ `failed`；退出码 0 已同步 · 2 离线待补推 · 3 要人处理 · 1 其它。并发用 `.git/superpi-sync.lock`（120 s 残留自动接管），每次尝试记一行 `.git/superpi-sync.log`（在 .git 里，不入库）。`GIT_TERMINAL_PROMPT=0` + `GCM_INTERACTIVE=never` + `execFile` 硬超时，保证后台跑不会弹出认证窗口把人挂住 |
| `tools/git-hooks/post-commit` / `npm run hooks` | 装进 `.git/hooks/post-commit` 的 8 行 sh 钩子：每次 commit 后**后台**跑一次 `github-sync.mjs --from-hook`（短超时、安静、`&` 不阻塞、永远 `exit 0`）。离线时它什么都不做 —— 提交已经落地，下次提交或 `npm run sync` 会把欠的提交一起推上去。关掉：`SUPERPI_GIT_SYNC=0` |
| `test/github-sync.mjs` | 线上同步门禁 82 条：文件层（无 BOM / LF / ASCII 钩子 / 不硬编码本机路径 / 无 `--force` / 带超时与禁交互认证）+ 纯函数（四类错误分类、`ls-remote` 解析、退出码）+ **真 git** 跑完整个生命周期（首推 / 幂等 / 新提交再推 / 补 tag / 锁与残留锁接管 / 无远端 / 断网且本地提交不丢 / 分叉拒绝且远端 ref 不动 / 游离 HEAD / 无提交 / 开关关闭 / 只读状态 / 装钩子）+ 接线（`npm run sync` / `npm run hooks` / README / AGENTS.md / `tools/` 不进 npm 包）。远端是临时裸仓库，断网用 `127.0.0.1:1` 拒连模拟，**全程不联网** |

`client-render.mjs` 需要 `react` / `react-dom` —— 本插件刻意不带 `node_modules`，所以它从同级 `pi-main/node_modules` 借（找不到就 SKIP 并退出 0，不算失败）。

## 线上仓库与版本同步

代码放在 <https://github.com/lwaaron/superpi>（**private**）。远端 `origin` 走 HTTPS，凭据由本机的 Git Credential Manager 管，**仓库里不放任何 token**。

规矩只有一条：**本地提交永远优先，推送是可重试的后续动作**。

```powershell
npm run sync            # 推一次：分支 + 全部 tag（幂等，线上已最新就什么都不做）
npm run sync -- --status   # 只看差多少：本地 HEAD / 线上 HEAD / 待推几个提交 / 钩子装没装
npm run sync -- --init  # 克隆丢了 origin 时补回来
npm run hooks           # 装 post-commit 钩子：之后每次 commit 自动在后台试推一次
```

| 情形 | 行为 | 退出码 |
| --- | --- | --- |
| 线上已是最新 | 不重复推，只补 tag | 0 |
| 有新提交且能连上 | 推分支 + tag | 0 |
| 连不上网 | **本地提交保留**，记一行日志，等下次提交或手动 `npm run sync` 补推 | 2 |
| 线上有本地没有的提交（非快进） | 拒绝，**绝不 `--force`**，交给人看 | 3 |
| 凭据失效 / 没权限 | 明确报认证失败（不许装成离线静默重试） | 3 |

- 装了钩子之后，**离线提交也照旧成功**：钩子在后台跑、`&` 分离、永远 `exit 0`；推送失败只写 `.git/superpi-sync.log`。
- 日志与锁都在 `.git/` 里（`superpi-sync.log` / `superpi-sync.lock`），不会入库，也不会被 `npm pack` 打进包里。
- 想临时停掉自动推送：`set SUPERPI_GIT_SYNC=0`。
- `.gitattributes` 钉死了行尾：代码类（`*.js` / `*.mjs` / `*.json` / `*.yml` / `*.ps1` / `tools/git-hooks/*`）一律 LF，`*.bat` / `*.cmd` 一律 CRLF —— 否则 `core.autocrlf=true` 的机器克隆下来，`test/restart-lib.mjs` 的「无游离 CR」与 `test/github-sync.mjs` 的「钩子必须是 LF」断言必红。

## 与 DSH 插件管理器的关系

DSH 的插件管理器（dshmarket / 插件详情页）在安装、卸载、升级插件时跑的是 **pnpm**，参数大致是 `add` / `remove` / `install`（含 `--frozen-lockfile` 与 hoist-pattern 漂移后的 `install --no-frozen-lockfile` 重试）。它不做 `prune`，但会按 `pnpm-lock.yaml` 与 `node_modules/.modules.yaml` 判断哪些包该在。

因此装 superpi 的正确姿势只有一种：**让 pnpm 写状态**。手工放目录 + 手改 `package.json` 会造成两种漂移，任一都会让副本在下次插件操作时消失：

| 漂移 | 表现 | 后果 |
| --- | --- | --- |
| manifest 有、lock 没有 | `frozen-lockfile` 校验报「specifiers in the lockfile don't match specifiers in package.json」 | 插件管理器报错，或退回 `--no-frozen-lockfile` 重写锁 |
| 有文件、`.modules.yaml` 不认识 | `node_modules` 里有目录但 pnpm 视角不存在 | 下次 `install` 按孤立包清理 |

已实测的边界：

- `pnpm add dsh-free-model@3.1.0`（manifest 与 lock 都是 superpi 正常运行时的状态）→ superpi 与 pi 运行时都存活；
- 故意造漂移（manifest 有 superpi、lock 没有）再 `pnpm add` → pnpm 顺手把 superpi 补装回来，锁被重写，仍然可用；
- 锁里的 `file:.dsh-local-packages/superpi-<ver>.tgz` 是**相对 profile 根**解析的，删掉 `.dsh-local-packages` 会让 `install` 直接报 `ERR_PNPM_TARBALL_READ_LOCAL_TARBALL` —— 想改锁前先确认这个目录还在。

`.dsh-local-packages/` 里的 tarball 是回滚与重装的锚点，不要手动清。

## 已知限制

- 只支持单实例面板：多开同一 keyed slot 会互相覆盖状态。
- 会话默认落盘（`persist=true`，pi 写 `~/.pi/agent/sessions`），DSH 重启后能靠 `startup=continue` 接回该目录最近的会话；把 `persist` 设为 `false` 才会「退出即丢」。
- `cycle_model` 在 RPC 面上没有方向参数（pi 只给 `cycleModel()` 正循环），所以 `Ctrl+P` 只能往前走，反向切换得到会话内用 `/model` 打开向上弹层选（见 `docs/parity.md` D-08）。
- `get_state` 不返回 `autoRetryEnabled`（pi 的 `RpcSessionState` 12 个字段里没有它，`client.js:4167` 读到的永远是 `undefined`）。开关点下去确实发 `set_auto_retry` 并生效，但重开设置弹窗仍显示 off —— 面板侧没有任何回填来源，只能等上游补字段（见 `docs/parity.md` D-07，`test/parity.mjs:290` 用断言把这个缺口锁住）。
- `/selfcheck` 只能回答「进程加载的 vs 磁盘的」。插件被别处改过又被指回来时，需要重启一次让快照刷新。
- 一键安装需要能访问 npm registry；离线环境请把 `cliPath` 指到已有 pi，或先手工把依赖装到 `.runtime`。

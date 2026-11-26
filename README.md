# SuperPi

SuperPi 是可在命令行和 DeepSeek Runtime（DSH）侧栏使用的编码 Agent。两端共用 Pi 1.5.2、同一套 SuperPi 扩展和本地会话格式。DSH 面板通过官方 JSONL RPC 协议驱动 Pi 子进程。可在任一入口打开同一项目的历史会话。

[安装与启动](#安装) · [核心能力](#核心能力) · [配置](#配置) · [排查故障](#排查故障) · [测试](#测试) · [版本记录](docs/parity.md#6-变更记录)

## 安装

### Windows 一键启动

双击仓库根目录的 `一键启动.bat`，同时启动 SuperPi 终端和独立的 DSH 面板服务。也可以在仓库目录按需运行。

```powershell
.\一键启动.bat -WorkDir D:\your-project
.\一键启动.bat -NoWeb -Resume pick
.\一键启动.bat -NoTui
```

第二条只开终端并选择历史会话。第三条只启动面板服务。面板要从 DSH 客户端侧栏打开，独立服务默认端口为 `25117`。

### 安装到现有 DSH

运行以下命令把 SuperPi 装进 `desktop` profile。安装完成后，从外部终端或资源管理器启动 `tools\restart-dsh.bat` 核对新版本，再从 DSH 左侧栏打开 **SuperPi**。

```powershell
pwsh -NoProfile -File .\tools\install-plugin.ps1 -Profile desktop
```

终端入口为 `superpi`。在源码目录也可运行 `node src/superpi-cli.mjs`。找不到 Pi 运行时时，DSH 面板提供「安装 SuperPi 运行时」入口。

### 离线安装

先在能安装依赖的机器上生成含 Pi 运行时的归档。构建机与目标机须使用相同的操作系统和 CPU 架构。

```powershell
npm run pack:offline -- .\artifacts
```

把生成的归档复制到目标机。在现有 DSH profile 目录下用 DSH 自带的 pnpm 安装，然后重启该实例。

```powershell
node "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs" `
  add "file:C:\path\to\superpi-0.49.1-offline-win32-x64.tgz" --offline --ignore-scripts
```

归档包含当前平台的 Pi 和生产依赖。使用远程模型时仍需连通模型服务。已经安装 Pi 时，也可在配置中用 `cliPath` 指定运行时。

<details>
<summary>启动参数、安装过程与其他安装方式</summary>

### 完整启动参数

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
- **DSH 面板和命令行统一显示 SuperPi**。可在源码目录运行 `node src/superpi-cli.mjs --help`，也可运行 npm 安装包提供的 `superpi --help`。
- CLI 和插件管理的运行时在启动时通过 Pi 官方 `piConfig.name` 配置品牌。面板一键安装时也会配置，命令行横幅在重新打开窗口时生效。
- 发布包和一键安装统一使用 Pi 1.5.2，面板与命令行共用同一版本的运行时。
- 配置和历史会话继续使用 `~/.pi/agent`。两端优先使用 `SUPERPI_CODING_AGENT_DIR` 和 `SUPERPI_CODING_AGENT_SESSION_DIR`，也识别原有 `PI_CODING_AGENT_*` 环境变量。
- 使用 `npm run superpi:editor` 同步扩展，使用 `npm run superpi:brand:status` 查看运行时品牌状态。原有 `pi:editor*` 和 `pi:brand*` 命令仍可用。

> **`.bat` 的内容都是纯 ASCII，这是刻意的。** `cmd.exe` 按**当前控制台代码页**逐行读取 `.bat`；
> 执行 `chcp 65001` 之后，任何非 ASCII 行的字节偏移与 cmd 已缓存的行边界不再对齐，多字节字符会被从中间切断，
> 导致后续行被当成乱码命令执行。实测后果是「注释被当命令刷屏」，极端情况下 `set "TARGET=..."` 被截断、转发直接失败。
> 所以中文交互文案全部放在 `.ps1` 里（PowerShell 不经过 cmd 的行解析），`.bat` 只留 ASCII。
> 仓库既有的 `tools\restart-dsh.bat` 也受同一问题影响（会刷出几条乱码，但主流程仍能跑通），暂未改动。

### 单独启动面板服务

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

`start-standalone.bat` 保留独立实例供日常使用。`standalone-verify.ps1` 在端口 `25119` 临时验证全新安装和真实模型往返，验证后清理临时实例。

### 安装与升级的验证步骤

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

### 开发时手工挂载

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

### 使用 pnpm 手工安装

```powershell
npm pack                                        # 得到 superpi-0.49.1.tgz
cd "$env:USERPROFILE\.dsh\profiles\desktop"
node "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs" `
  add "file:C:\path\to\superpi-0.49.1.tgz" --ignore-scripts
```

不要在 profile 里用 `npm install`：npm 会另写一份 `package-lock.json`，而宿主插件管理器用的是 pnpm，两套锁文件互相看不见，下次插件安装就会把 node_modules 重建成 pnpm 理解的样子。

装 `optionalDependencies` 里的 `@earendil-works/pi-coding-agent` 时，pi 会被提升到 profile 的 `node_modules`，解析链第 6 步（逐级向上）命中；装不上也不影响插件加载，面板会引导一键安装到 `.runtime`。

装完核对（三条都要有输出）：

```powershell
Select-String -LiteralPath pnpm-lock.yaml -Pattern '^\s+superpi:$'          # lock 认识它
Test-Path node_modules\superpi\index.js                                     # 代码在
Select-String -LiteralPath node_modules\.modules.yaml -Pattern 'superpi'    # pnpm 认识它
```

### 在临时 DSH_HOME 验证安装

想知道「这东西真的能独立跑吗」，用这个脚本自证。它在你没碰过的临时 `DSH_HOME` 里从零搭一个 profile，只装 superpi，启动、开会话、跑一轮真实 LLM 往返，然后全部删掉：

```powershell
pwsh -NoProfile -File .\tools\standalone-verify.ps1            # 默认 25119 端口
pwsh -NoProfile -File .\tools\standalone-verify.ps1 -Keep      # 保留临时目录便于排查
```

它做的每一步都可核对：

1. `npm pack` 出 tarball（已有同版本 tarball 则复用）；
2. 建 `%TEMP%\superpi-standalone-<6hex>\profiles\superpi-standalone`，四份配置文件：`package.json`（bundles 只留 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`）、`cordis.yml`（空列表）、`pnpm-workspace.yaml`（`nodeLinker: hoisted`）、`cordis.patch.yml`（唯一的 insert 就是 superpi）；
3. 用 **DSH 自带的 pnpm** 把 tarball 装进这个 profile —— pi 运行时作为 `optionalDependency` 被提升进来；
4. 用 **DSH 自己的 Electron 二进制**当 node 启动这个 profile 的 web 服务（`ELECTRON_RUN_AS_NODE=1`，独立端口）；
5. 打 `/health` → `/state` → `POST /sessions` → `get_state` → prompt「只说两个字：独立」→ 轮询 `snapshot` 等到 `agent_settled` → `DELETE`；
6. `taskkill` 关服务，删临时目录；助手回复非空才算 PASS（exit 0）。

通过时的关键输出（`/state` 的 `cliSource` 必须是 `walk-up`，`cliPath` 必须落在临时 profile 的 `node_modules` 里 —— 这两条同时成立，才证明插件没有依赖本机任何源码路径）：

```
[standalone] health    = ok (boot 3102 ms)
[standalone] plugin    = 0.4.2 (installed 0.4.2)
[standalone] pi source = walk-up 1.5.2
[standalone] CLI path  = ...\Temp\superpi-standalone-802b49\profiles\superpi-standalone\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js
[standalone] model     = Deepseek-V4.1-Flash / odys-deepseek
[standalone] session   = d6406878-cc2f-4726-9a5b-fd5c51fac9fa pid=10036
[standalone] assistant = '独立' (2595 ms)
[standalone] PASS - superpi runs standalone in a fresh DSH_HOME
```

两条容易踩的：

- **profile 名不能叫 `web` / `desktop` / `tui` / `headless`** —— 这几个是 shipped 保留名，只能当模板用，要另起名字（新安装使用 `superpi-standalone`，已有 `pi-standalone` profile 可沿用）。命令行形状是 `dsh <profileName> --port N --no-open`，app 参数写在 profile 名后面；写成 `--profile x web --port N` 会报 `too many arguments`。
- **`app.asar` 在文件系统视角是单个文件**，`Test-Path app.asar\dsh\...\cli.js` 恒为 false。脚本只校验 asar 本体在不在，asar 内部路径交给 Electron 解析。同理别硬编码安装目录名，用 `Get-Process` 拿真实路径。

> 脚本里的 `npm pack` 兜底走 `127.0.0.1:10808` 代理（仅在环境里没设 `HTTPS_PROXY` 时）。换机器跑请先导出自己的代理变量，或用 `-PnpmPath` 指到有效的 `pnpm.cjs`。

</details>

## 核心能力

| 能力 | 面板和命令行中的行为 |
| --- | --- |
| 项目与会话 | 面板标签栏可新建和切换运行中的会话，各自保留任务与输入草稿。按项目查看和恢复历史。模型、会话和扩展沿用 Pi 的配置目录 `~/.pi/agent`，SuperPi 的偏好和诊断存放在 `~/.superpi`。 |
| 异常恢复 | 识别空响应、乱码、畸形工具标记、输出截断与特定上游断流。满足重试条件时从已完成的工具结果续跑一次。故障持续时提供「继续」入口。 |
| 写入保护 | 在 `write` 和 `edit` 执行前检查路径和新文本。完成的大写入与明确拦截的调用转成普通文本证据，供模型依据文件路径和错误诊断接续。原始调用和结果均保存在会话记录里。 |
| 主动询问 | Agent 通过 `ask_user` 请求必要信息或决策。选择和自由输入都能回到当前任务。 |
| 验收与代码审查 | `verify` 记录命令退出结果及对应的源码，`review_changes` 审查正确性和测试覆盖。用 `/superpi-task` 查验收进度，用 `/superpi-integrity` 查写入拦截。 |

详细契约、已知差异和版本记录见[两端能力对齐](docs/parity.md)。

<details>
<summary>SuperPi 运行时的安装与定位</summary>

## SuperPi 运行时的安装与定位

`src/pi-runtime.mjs` 是唯一知道答案的地方，顺序固定（命中即停，未命中也会记进 `searched` 供排障）：

| # | 来源 (`source`) | 位置 |
| --- | --- | --- |
| 1 | `config` | 配置里的 `cliPath`，可以是 `cli.js` 文件也可以是包目录 |
| 2 | `env` | 环境变量 `SUPERPI_CLI_PATH` |
| 3 | `env` | 环境变量 `SUPERPI_RUNTIME_DIR`（当模块解析起点用） |
| 4 | `plugin-node-modules` | `<插件>/node_modules/@earendil-works/pi-coding-agent` |
| 5 | `plugin-runtime` | `<插件>/.runtime/node_modules/...`（一键安装的落点） |
| 6 | `walk-up` | 从插件目录逐级向上最多 12 层找 `node_modules`（覆盖 npm/pnpm 把依赖提升到项目顶层的布局） |
| 7 | `pnpm-store` | `node_modules/.pnpm/@earendil-works+pi-coding-agent@*/`（`nodeLinker: isolated`） |
| 8 | `global-npm` | `dirname(process.execPath)`、`%APPDATA%\npm`、`%LOCALAPPDATA%\npm` |

node 可执行文件的解析同理：`config.nodePath` → `SUPERPI_NODE_PATH` → `PATH` 上的 `node.exe` / `node` → 宿主自身 `process.execPath`（最后这条会置 `ELECTRON_RUN_AS_NODE=1`，否则 Electron 宿主里起的子进程解析失败且日志为空）。

找不到运行时时，面板显示「安装 SuperPi 运行时」按钮和已搜索位置清单。按钮调用 `POST /api/superpi/runtime/install`，由宿主执行以下命令。

```
npm install --prefix <插件>/.runtime --save-exact --no-audit --no-fund --loglevel=error @earendil-works/pi-coding-agent@1.5.2
```

装完立刻重新解析，无需重启 DSH（已开的会话不受影响，新会话用新装的那份）。Windows 上不用 `spawn(npm.cmd, { shell: true })`（会触发 DEP0190 且参数未转义），走 `cmd.exe /d /s /c` 自行加引号。

</details>

## 配置

写在 `cordis.patch.yml` 那条 insert 的 `config` 里；插件详情页的配置表单来自 `Config` schema，**只有标了 `.volatile()` 的字段**会进表单并被宿主原位热更新+持久化。
改完立刻生效，不用重启 DSH：`/state` 与新建会话每次都会带指纹比对地重解析一遍运行时（配置没变就是常数时间返回）。**前提是实现上不能把 `config` 展开成快照** —— 宿主下发的 volatile 字段是 cosmokit 的冻结引用 `{ get(), [write]() }`，值由宿主就地写入，照字符串读会拿到 object，让所有 `typeof === 'string'` 判断失假（这正是 0.2.0 里配置静默失效的原因）。本插件所有读取点统一走 `readSetting / readSettingString`，并由 `test/config-hot.mjs` 回归守卫。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `cliPath` | 自动探测 | pi 的 `cli.js` 绝对路径（或包目录） |
| `nodePath` | 自动探测 | 跑 pi 的 node 可执行文件 |
| `workspace` | `~/superpi-workspace` | 新会话的默认工作区。已存在旧版默认目录时可以沿用 |
| `extraArgs` | `""` | 空格分隔，追加到 pi 命令行（会话级 `args` 之后） |
| `args` | `[]` | 基础参数。历史版本默认 `["--no-session"]`，现在是否落盘由 `persist` 决定 |
| `persist` | `"true"` | `true` = 会话落盘到 `~/.pi/agent/sessions`；`false` = 追加 `--no-session`，退出即丢 |
| `startup` | `"continue"` | `continue` = 接上该目录最近的会话（`--continue`）；`new` = 全新会话 |
| `sessionName` | `""` | `pi --name`；留空不传（pi 收到空 `--name` 会直接 exit 1） |

`persist` / `startup` / `sessionName` 三个字段在 schema 里按**字符串**暴露（宿主配置表单只认 string），实现侧统一照字符串读，再由 `buildSpawnArgs` 翻译成 `--no-session` / `--continue` / `--name`。用户自己已经在 `args` / `extraArgs` 里写了同名参数时不重复生成。

环境变量（优先级低于 config）：`SUPERPI_CLI_PATH`、`SUPERPI_NODE_PATH`、`SUPERPI_WORKSPACE`、`PI_BASH`、`SUPERPI_RUNTIME_DIR`。

`PI_BASH` 用来告诉 pi 用哪个 bash（Windows 上装 Git for Windows 后指向 `C:\Program Files\Git\bin\bash.exe`）；不设则由 pi 自己找。

## 排查故障

| 遇到的问题 | 查看位置 |
| --- | --- |
| 面板找不到运行时 | 使用面板的「安装 SuperPi 运行时」，或在 `/api/superpi/runtime` 查看已搜索的位置。 |
| 更新后仍显示旧版本 | 用 `tools\restart-dsh.bat -SkipRestart` 核对正在运行的实例。`/api/superpi/selfcheck` 的 `summary.stale` 表示运行中的文件与磁盘版本有差异。 |
| 写入被拦截或模型中途停下 | 查看工具错误中的路径、行号和码位，或用 `/superpi-integrity` 查记录。会话中的「继续」从已保存的进度接续。 |
| 验收项仍待完成 | 用 `/superpi-task` 查看当前会话分支的通过证据、待验收项与阻塞原因。 |

<details>
<summary>宿主结构、HTTP 接口和面板实现</summary>

## 结构

| 文件 | 职责 |
| --- | --- |
| `index.js` | DSH HTTP 路由、会话池、子进程和自检 |
| `client.js` | 侧栏入口和 React 聊天面板 |
| `cordis.patch.yml` | 将 SuperPi 注册到 DSH 宿主 |
| `src/pi-rpc.mjs` | JSONL 解析、RPC 命令配对和扩展 UI |
| `src/rpc-contract.mjs` | 命令、事件、斜杠与扩展 UI 的契约 |
| `src/pi-runtime.mjs` | Pi 和 Node 的解析与安装 |
| `src/session-store.mjs` | 枚举 Pi 的本地会话与项目 |
| `extensions/` | 两端共享的 Agent 能力 |

挂载时，面板从 `/contract` 获得命令与事件表。`sidebar.panellist` 的 `id` 与 `main` keyed slot 的 `key` 一致，两处 `slots.inject` 均由 `ctx.inject` 托管。运行时依赖、样式变量和两端对齐的工程约束见 [AGENTS.md](AGENTS.md)。

## HTTP 接口

同源、免 token（走 `webServer` 的 prefix 注册，不走宿主鉴权层）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/superpi/state` 或 `/api/superpi/` | `{version, apiPrefix, resolved, runtime, limits, sessions}`；`resolved` 是 node/pi 的解析结果，`sessions` 是当前所有会话的无事件快照 |
| GET | `/api/superpi/health` | `{ok, version}`，不碰磁盘也不碰子进程 |
| GET | `/api/superpi/selfcheck` | 对照已加载文件与当前磁盘内容，并检查 Pi 构建时间。加载文件缺失或变化时 `ok=false`，恢复原字节后同一进程可立即通过。 |
| GET | `/api/superpi/diagnostics` | `plugin`（id/version/root/apiPrefix/pid/node/execPath）+ `runtime` + `selfcheck`，排障先看这个 |
| GET | `/api/superpi/runtime` | 运行时解析报告（`ok` / `source` / `cliPath` / `searched` / `install`） |
| POST | `/api/superpi/runtime/refresh` | 重新解析（手工装好 pi 后不必重启 DSH） |
| POST | `/api/superpi/runtime/install` | 一键安装 pi 到 `.runtime`（幂等，并发只跑一次）；失败回 500 |
| GET | `/api/superpi/contract` | RPC 契约原文：`version` / `piVersion` / `rpcCommands`(33) / `events`(25) / `assistantEvents`(12) / `tuiCommands`(27) / `bashShortcuts`(2)，逐字段原样下发 |
| GET | `/api/superpi/sessions/history?scope=&cwd=&limit=` | 历史会话列表（扫 `~/.pi/agent/sessions`）。`scope=all` 列**全部项目**并额外返回 `projects` 聚合数组；`scope=project`（或只给 `cwd`）只列该项目；两者都不给时按有没有 `cwd` 推断，**不再回落成插件 workspace**（0.4.2 及之前空 `cwd` 会回落，等于面板只能看见一个目录 —— 「历史会话只显示一条」的根因）。`limit` 默认 20、上限 200；宿主没注入时回 501 |
| GET | `/api/superpi/files?dir=&query=&limit=` | 只读列目录，给 @ 补全与「插入路径」用（RPC 协议没有 fs 能力）；`limit` 默认 50、上限 200；目录不存在回 404 |
| GET | `/api/superpi/file?path=` | 读单个文件给预览用（面板内 `FileSheet` 回落时用）。返回 `{ok,path,name,dir,size,mtime,kind,mimeType,text?,data?,truncated}`；`kind` = `text`（≤512 KiB，超出截断并置 `truncated`）/ `image`（≤8 MiB，`data` 是 base64）/ `binary`（前 8 KiB 出现 NUL，或图片超出体积上限）；`path` 支持 `~`、`%VAR%` 与相对工作区。目录回 400 `not a file`、不存在回 404 `no such file` |
| POST | `/api/superpi/reveal` | 在系统文件管理器里定位文件（助手回复里文件标签的右键菜单）：body `{path}`，Windows 走 `explorer.exe /select,<文件>`（macOS `open -R`、其它 `xdg-open` 父目录），回 `{ok:true,path}`。缺 `path` → 400 `path required`，目标不存在 → 404 `no such file`。只等 `spawn` 不等退出码 —— explorer 常把命令转交给已有实例后以非 0 退出 |
| GET | `/api/superpi/changelog` | 读运行时包内的 `CHANGELOG.md`（上限 200 KiB）。旧地址 `/api/superpi/pi/changelog` 仍可用 |
| POST | `/api/superpi/sessions` | 新建会话，body 可带 `cwd` / `label` / `args` |
| GET | `/api/superpi/sessions/:id` | 单个会话快照（不含事件数组，含 `pendingUi`） |
| DELETE | `/api/superpi/sessions/:id` | 关闭会话（先关 stdin 再超时 kill） |
| GET | `/api/superpi/sessions/:id/events?since=N` | SSE 事件流，15s 心跳注释帧 |
| GET | `/api/superpi/sessions/:id/snapshot?since=N` | 增量快照（重连补数据用），带本轮未应答的 `pendingUi` |
| POST | `/api/superpi/sessions/:id/command` | 转发一条 pi RPC 命令，body 必须是带 `type` 的 JSON 对象；`new_session` / `switch_session` / `fork` / `clone` 成功后清空事件缓冲并回填会话身份 |
| GET / POST | `/api/superpi/sessions/:id/controls/retry` | 读取当前会话生效的自动重试设置。POST 接收 `{enabled}`，返回有效值和 `applied`。 |
| POST | `/api/superpi/sessions/:id/controls/previous-model` | 在当前会话的可用模型范围内反向切换，返回更新后的模型和推理档位。 |
| POST | `/api/superpi/sessions/:id/respond` | 应答扩展 UI 请求（`{id, value}` / `{id, confirmed}` / `{id, cancelled}` 三选一） |
| GET | `/api/superpi/ui-prefs` | 面板偏好（项目显示名 / 会话显示名 / 置顶）的只读快照 `{version, updatedAt, projects, sessions}`；文件还不存在也照常回 200 与空结构；宿主没注入时回 501 |
| POST | `/api/superpi/ui-prefs/project` | body `{key, name}`：`key` 是项目路径、`name` 是显示名（自动 trim，空串 = 删除覆盖，上限 120 字）。未知键一个都不落盘（白名单），非法值回 400 |
| POST | `/api/superpi/ui-prefs/session` | body `{path, name?, pinned?}`：**合并式补丁** —— 只给 `name` 不会凭空置顶，只给 `pinned` 不会清掉已有名字；`pinned:false` 删除该条。`path` 上限 4096，非法值回 400 |

| GET | `/api/superpi/rules` | **用户自定义规则（最高优先级）**的只读全量视图：`{ok, text, checksum, createdAt, updatedAt, source, drift, isDefault, empty, rank, maxLength, filePath, delivery}`。文件不存在时回内置默认文案且**不写盘**（打开设置不该产生一次写）；文件坏掉时仍 200，额外带 `warning`。`empty` 与 `isDefault` 是两件事：前者 = 当前不追加任何内容（用户清空了），后者 = 文本与内置默认逐字相同。`delivery.extensionInstalled` 告诉面板命令行窗口装没装扩展 |
| POST | `/api/superpi/rules` | body `{text}`：写入并回同形状视图。**归一在 host 侧做**（去 BOM / 统一换行 / 去行尾空白 / 压缩空行 / trim，且幂等），超 20000 字或非字符串 → 400；`content-type` 不是 `application/json` → 415；相同文本重复写是幂等的（不刷新 `updatedAt`）。落盘 `<home>/.superpi/rules.json`（`SUPERPI_RULES` 可覆盖），tmp + rename 原子写 |
| POST | `/api/superpi/rules/reset` | 恢复内置默认文案，回同形状视图（`isDefault:true`） |
`/sessions/history` 必须排在会话 id 正则 `^/sessions/([^/]+)` **之前**处理，否则 `history` 会被当成会话 id 走进 `requireSession` 拿 404。

上限与错误码：8 个并发会话，请求体 4 MiB。`/command` 与 `/respond` 的 `content-type` 必须是 `application/json`（否则 415），body 必须是 JSON 对象（否则 400）；`/command` 还要求带字符串 `type`；`/respond` 要求非空字符串 `id`（否则 400）、该 id 必须仍在待应答集合里（否则 409），且 `value` / `confirmed` / `cancelled` 三选一 —— 一个都没有就回 400，**不会替你猜成取消**（猜错会让一个本该确认的对话框静默消失）。

## 面板行为

- 面板通过 `GET /state` 检查运行时并取得运行中的会话。首次打开时接入首个可用会话，切标签时接入所选会话。标签栏的 `+` 始终新建独立会话，现有任务继续执行。斜杠菜单与分发规则从 `GET /contract` 读取。
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
- **输入框能力两端对齐（0.9.2）**：面板的输入框是浏览器的真 `textarea`，粘贴文件路径 / `Ctrl+A` 全选 / `Ctrl+C` 复制 / `Ctrl+X` 剪切 / `Backspace` 删选区都是浏览器原生行为；命令行 TUI 的输入框是 pi-tui 自己实现的 `Editor`，**没有选区模型**（`Ctrl+A` 是移到行首、`Ctrl+C` 被 pi 的 `app.clear` 吃掉去清空输入框、`Ctrl+X` 无绑定），Windows 的 native 剪贴板也没有 `getFilePaths`（只有 macOS 有），所以在资源管理器里复制文件后 `Ctrl+V` 三档全空。这段差异由 `extensions/superpi-editor.ts` 补齐 —— pi 官方扩展点 `ctx.ui.setEditorComponent()`，**不改 pi 任何文件、不打补丁**。装法 `npm run superpi:editor`，卸载 `npm run superpi:editor:remove`，生效需重启 pi 会话窗口或 `/reload`；一键启动会在起 TUI 前自动装一次（`-NoEditorExtension` 可关）。键位对照表见 `docs/parity.md` §5.1。
- **输入框外观与入口（0.9.4，0.9.7 收口）**：①**四边闭合的直角框**（`┌─┐ │ │ └─┘`），框线 **80% 白**（`FRAME_RGB = [204,204,204]`）—— pi 原本只有上下两条线；框内每行都按显示宽度补齐，框线不会错位，pi 的滚动提示（`↑ N more`）保留。**没有铺整块近白底色**：终端里那样必须同时强改文字色（pi 主题是浅色系），会压掉选区反色与思考配色。②**Working 回到 pi 原来的位置**（上边框内侧左侧，形如 `┌─ ◒ Working · 8s ───┐`）并**按状态换色**：正常白 / 成功绿 `[126,211,133]` / 出错红 `[236,94,94]`，**图标与文案同色**（`○` / `◐◓◑◒` / `✔` / `✖`，运行中带 `· Ns`）；状态由 `agent_start` / `tool_execution_end.isError` / `agent_settled` 驱动，同时关掉 pi 内置的那条，不会出现两行。③**粘贴进来的绝对路径带浅灰底色**（`[104,104,104]`），**底色只覆盖路径本身** —— `trimPathToken()` 在最后一个已知扩展名处截断，所以「`D:<文件名>.png`然后把图改深色」不会把后面的字一起染色；圆角格只在确实是空白时才吃。URL、相对路径、`/settings` 这类斜杠命令不会被误涂。④`settings` `home` 放在**框外右下角、模型信息上方**，**全小写**，**颜色与模型名一致**（`theme.fg('dim', …)`）：`settings` 展开 `settings` / `model` / `thinking` / `scoped-models` 四条 —— **全部是 pi 自己的斜杠命令**，点了等同敲回车；`home` 提交 `/new`（起新会话树 = 刚启动时的界面）。运行中点击只提示不打断，`Esc` 先关菜单。
- **Ctrl+V 判定归扩展自己（0.9.7）**：pi 的 `handleClipboardPaste` 依赖 pi-tui 的 native `getFilePaths`（Windows 没实现），实测连 `getImage` / `getText` 在截图后也读不到 —— 于是「截图后 Ctrl+V」在 Windows 上就是点了没反应。现在由扩展的 `resolveClipboardPaste()` 自己判定：先问 native 快路径（位图落成 `%TEMP%\superpi-paste-*.png`，与 pi 自己的做法一致），读不到才起 PowerShell 探头一次性拿文件列表 / 文本 / 位图，三者都没有才回落 pi 的 `onPasteImage`。实测三条通道：截图 → 得到临时 PNG 路径；资源管理器复制文件 → 得到原始绝对路径；复制文本 → 原样插入。
- **用户自定义规则：最高优先级（0.10.0）**：设置弹窗里多了一节「用户自定义规则（最高优先级）」—— 点的「编辑规则」打开编辑弹窗，保存后**下一轮对话立刻生效**，不需要重启会话、不需要重连。默认文案就是用户手写的那 21 条（简体中文回复、上下文 50% 主动整理、第一性原理、禁止打补丁/降级、UI 设计师走查、架构师视角、测试专家视角、SaaS 最佳实践、按行修改、先写测试用例、禁止刷指标、数据库 did/业务编号、每次任务提交本地版本、只许 `git revert` 不许 `reset --hard`、任务清单、初始化状态与视觉一致、mock 数据先跑通、浏览器扩展、清理标签页），**面板侧不存这一份**（`test/rules.mjs` 断言 `client.js` 里没有这些句子），唯一真相在 `extensions/superpi-rules.mjs`。
  「最高优先级」是机制不是口号：①规则塞进 pi 的自定义 section，而 pi 组装提示时自定义 section **排在最后**（`preamble → tools → rules → docs → … → cwd → 自定义`），也就是整份提示的末尾；②块首显式声明「优先级最高、覆盖上文与项目说明、冲突以本段为准」，才能压过 `<project_context>` 里 `AGENTS.md` 那些指令；③规则被清空时返回 `undefined`，pi 收到的提示与「没装这个扩展」逐字相同 —— 空规则必须是零痕迹。
  两端同一份文件：面板走 host 的 `/api/superpi/rules` 三条路由（浏览器没有 fs），命令行走 `extensions/superpi-rules.ts` 的 `before_agent_start` 每轮读 `<home>/.superpi/rules.json`（mtime+size 缓存，改完下一轮就生效）与 `/superpi-rules` 命令（看级别与字数 / 编辑 / 恢复默认 / 只显示全文）；settings 菜单里也加了 `rules` 一条（标 `source:'superpi'`，与 pi 自带的四条分开 —— 冒充 pi 命令会让「点了没反应」变成假话）。两侧共用 `extensions/superpi-rules.mjs` 这一份模型，安装器一次把三个文件同步进 `<piAgentDir>/extensions/`（少装 `.mjs` 会让 `.ts` 报模块找不到、规则整个不生效）。
  **刻意不写 `SYSTEM.md`**（那会**替换**掉 pi 的整套默认提示：工具说明、docs 路径、技能列表全没，等于让系统退化两个维度），**也不写 `APPEND_SYSTEM.md`**（静态文件，面板改完要重启会话才生效，且面板没有读原文的通道）。`rules.json` 坏掉时一律回落默认文案 + 告警（保存一次即修好），绝不让设置页打不开、也绝不让 pi 的一轮对话失败。设计、状态矩阵与端到端验收清单见 `docs/rules.md`。
- **技能与「卡住」的分诊（0.11.0）**：新增两个 pi 技能（`skills/`），装到 `~/.agents/skills/`，pi 启动自动发现、也可 `/skill:name` 强制加载；常驻上下文只有描述段 **1442 字符（约 361 token）**，正文按需读取。①`verified-delivery`：交活前必须跑「识别命令 → 执行 → 读输出 → 比对 → 才敢说完成」，测试必须**先看见失败**再让它通过，并用**变异杀伤率**度量"这层门禁是不是空的"（本仓库实测基线：12 个变异体、10 个有效、9 个被杀 = **90%**，唯一存活的那个是真缺口 —— store 的校验挡住了命令层预检查，断言该写具体文案而不是"有 error 即可"）。它还把「卡住」本身做成了分诊表：同一命令重跑两次仍未变 = 在重跑不在诊断；「刚写的文件不存在」= 两个同名目录（`/tmp` 在 bash 是 `%LOCALAPPDATA%\Temp`、在 node/python 是 `D:\\tmp`，实测）；「一行编辑后语法坏了」= 编辑工具吃掉了转义（heredoc 里 `^---\n` 变成真换行）；「编译过但测试说符号未定义」= 作用域，只有跑门禁才看得见；同一处修 3 次 = 模型错了不是补丁错了。②`change-scope`：动手前先写清「必须做什么 / 不能改什么 / 假设了什么 / 哪里有歧义」，每个改动行都要能追溯到请求的某一句话（`git diff` 逐行走查），"顺手改"一律回退另开一步。**这两个技能的内容来自对两个公开仓库的研究（andrej-karpathy-skills 的四原则 / obra/superpowers 的 TDD+验证必达），经过实测筛选：只有能被本仓库证据支撑的部分才写进来**，并且每条都配了对应的机械约束（见 `AGENTS.md` §5 新增的三条：`/tmp` 三义、heredoc 吃反斜杠、改完立刻 `node --check`）。
- **修「`/reload` 之后没变化」（0.9.8）**：pi 通过 `getEditorTheme()` 交给编辑器的 theme **只有 `borderColor` 与 `selectList`，没有 `fg`**；0.9.4 起为了取「与模型名一致」的颜色调了 `this.theme.fg('dim', …)`，直接抛错，而 `render()` 的兜底是「返回没套框的原始行」—— 于是 0.9.4~0.9.7 的外观改动**全部静默失效**，门禁因为假 theme 带了 `fg` 也没发现。现在：取色次序 = `theme.fg` → 注入的 `hooks.dim`（来自 `ctx.ui.theme.fg('dim', …)`）→ 原样文本；兜底改成 `plainFrame()`（只有框线与 Working，不依赖取色），**任何情况下都不会变成无框原始行**。门禁换用 pi 的真实 theme 形状，并专测「没有 `fg` 时框仍然在」。

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

</details>

<details>
<summary>会话工作流、验收与工程基准</summary>

## 会话恢复与写入保护

- **恢复同一任务**。SuperPi 在 Pi 的收尾阶段判断异常回复是否可恢复。满足重试条件时，从此前已完成的工具结果自动续跑一次。故障持续时，两端都能显示原因并接受「继续」。主动停止会结束本次运行。
- **保护工作区**。`write` 和 `edit` 在写盘前检查路径与新内容。拦下后，SuperPi 用错误诊断和安全路径指导下一次请求重新生成参数。`edit.oldText` 可匹配已经受损的内容。Shell 命令检测到乱码时提示核对文件。`/superpi-integrity` 可查看诊断。
- **降低长任务的重复输入**。成功写入的大段正文在下一次请求中用文件引用表示，原调用保留在 Pi 的会话记录里。原生压缩生成的摘要计入上下文预算。多步骤任务沿用同一会话和工具结果，收尾前按用户要求核对交付。
- **同一套 Pi 扩展**。面板启动子进程前同步包内扩展。终端可用 `npm run superpi:editor` 同步，随后重新打开会话或执行 `/reload`。`autoRetryOnMalformed` 和 `autoRetryCooldownMs` 沿用 `~/.superpi/context-guard.json`。排查和复现见 [输出完整性](docs/output-integrity.md)。

## Agent 主动询问（0.20.0）

需要你提供关键信息或做决定时，Agent 可以调用 `ask_user`。面板和命令行会弹出同一个问题，支持直接选一项或输入自己的答案。提交后的回答会进入当前回合，Agent 可以据此继续。

每个弹窗最多等待 5 分钟。关闭弹窗、留空或超时会返回「未回答」。停止这轮任务会同时关闭询问。面板发送失败时会保留输入，以便重试。新开的 `superpi` 命令行与面板会自动同步该扩展。

## 多步任务的验收、恢复与回执

- 多步任务可用 `task_progress` 记录目标与验收项。命令验收通过 `verify` 关联实际退出结果与 Git 工作区文件内容。后续源码变化会让对应证据回到待验证。人工或 Agent 的现场观察独立标记为已观察。两端输入 `/superpi-task` 可看当前会话分支的记录。
- 开发完成后，Agent 可调用 `task_progress.run_checks`，按计划依次执行尚无有效证据的测试与独立审查，共用一个总时限。开启 `finishWhenVerified` 的任务在证据齐备后生成可见回执。中途停止或关闭会话时，已核对的证据保留。对无法确认已停止的工作区命令，确认其退出后再执行对应的编号验收。
- 面板和命令行会显示当前验收项、总时限和失败原因。重开会话后可查看下一项及上次是否中断。用户可以停止本轮，收到询问时可在两端直接回答。
- `verify` 为每次运行要求秒级截止时间，并保留失败退出码与已读到的输出。需要故意改错代码来验证测试时，使用 `scope: "snapshot"` 和 `mutations` 提交精确替换。副本包含当前跟踪文件和未忽略的未跟踪文件。依赖安装按项目要求在副本内完成。执行进程仍使用当前系统账户的权限。
- 指定 `expectedFailure` 可做带对照的变异验证。SuperPi 从同一次源码采集建立两个独立副本，在总截止时间内运行同一条命令。原始副本须通过，指定的字面诊断须只在变异后的失败输出中出现。工具保留两个实际退出码与各自输出，从完整 Shell 记录核对长日志中的诊断。
- 重跑编号验收命令时，SuperPi 会在同一会话中先将这一项恢复为待验收。即使主动停止或进程退出，重新打开会话仍会显示待验收。新命令成功退出且源码指纹一致后才记录新的通过证据。
- 编号验收命令同时核对命令前后的源码内容和文件版本。可观测的改写会标记为证据失效，该项保持待验收，即使后来恢复了文件内容。工具保留实际退出码，并在能定位时指出变化的文件。文件版本核对覆盖前后扫描发现的 Git 普通文件，实际时间精度由文件系统决定。
- 编号验收也接收 Git 工作区的路径增删通知。收到未忽略的路径变化后，即使路径在命令结束前消失，该项仍保持待验收。忽略范围由 Git 判定。通知不可用或缺少路径时，工具保留实际退出码，并报告为何无法记录验收证据。消失路径的类型无法确认时，目录专属忽略规则可能需要一次稳定重跑。
- 跟踪中的任务提前自然收尾时，Pi 可以带着待验收项继续一次。主动停止、等待用户答复或记录了阻塞原因时会把进度留给下一轮。
- 新读取的图片仍能进入下一次模型请求，即使会话历史已经达到图片限额。超过历史限额的图片以路径占位，最新图片从短期缓存提供。正文开头未闭合的推理标记会作为输出异常显示。

## 断流恢复、独立审查与工程基准（0.22.0）

- 对上游明确报告的 `Upstream response stream ended before completion`，在当前回合内补充恢复一次。恢复从已完成的工具结果接续，失败响应仍可在会话中查阅。恢复受 Pi 的重试开关控制，再次中断时两端显示原因和「继续」。
- `review_changes` 并行发起正确性和测试覆盖两路审查。两路使用当前模型、独立的上下文和同一份 Git 工作区快照。完整源码和对照材料符合预算时，每路首个请求即可提交带文件行号的报告。材料超出预算或范围缺少相关源码时，审查员可按路径查阅同一份快照。面板和命令行均显示进度与结果。
- `task_progress` 的 `review: true` 验收项要求两路审查完成，且全部改动的文本范围内没有阻塞项。选择路径时按实际改动核对范围。限期内已返回的报告会保留，超时、有遗漏或审查期间源码变化时仍待验收。正常收尾时会再次核对本轮刚确认完成的源码证据。
- 多步骤任务提前收尾时，SuperPi 会把待办的验收项交回模型。此后每取得一项新的验收证据，都能在下次提前收尾时接着执行。重复验证同一项不会触发额外续跑。手动停止、排队的用户输入和明确登记的阻塞仍然优先。
- 同一目标下修订验收计划时，SuperPi 核对当前源码，保留仍匹配的编号命令证据。变动过的测试命令和变异条件须重新执行，原先的证据随次序调整移到对应的验收项。两端都能查看修订后的验收进度。
- 审查员报告阻塞问题时须引用当前源码原文。同一份代码的续审会收到上次的阻塞问题和待查项。逐项写出原因并引用能核对的源码，才能关闭对应问题。两端的审查结果都显示问题、原文和关闭依据。
- 审查员可以在最终报告前，按验收项提交已核对的观察和相关问题。SuperPi 在同一份源码快照上核对引文，即时写入会话。模型断流或重新打开会话时，续审复用这些观察，保留还未关闭的问题。验收通过仍要求完整报告。

## 工程基准与评分

- 审查员可列出和检索快照内的文件，定位未改动的调用方与既有测试。报告的覆盖限制只记录仓库内仍缺失的审查证据，测试执行由 `verify` 单独记录。面板和命令行沿用同一份报告。
- 同一份源码、基准、有效范围和验收目标，可从当前会话分支复用已完成报告，只补跑缺席的审查。代码变化会触发新的审查。一次用户请求内同一份证据最多发起两轮。持续无进展的重复调用会结束本轮，并保留具体待验收项。
- `npm run test:engineering` 校验评分与运行记录。`node test/engineering-bench.mjs list` 列出场景，`prepare <场景> <新目录>` 生成对应的 Git 起点和任务描述，`grade <场景> <工作区>` 独立检查代码。场景覆盖并发缓存、状态迁移和持久队列。持久队列验证多进程争抢、异常退出后的租约恢复、旧令牌失效、原有消费者兼容及输入校验。公开任务与测试明确要求租约时长为正整数。
- `metrics <events.jsonl> <process.json>` 根据事件和进程记录汇总实际收尾状态、耗时、用户消息、审查请求与验收项运行记录。输入、输出和缓存用量按观测到的模型响应与新审查报告计数。旧日志或进程强制停止可能缺少部分用量。
- 在仓库中用 `node test/engineering-bench.mjs compare async-cache _scratch/cache-run 120` 可运行一个三方对照。报告目录必须是新目录。SuperPi、Codex 和 Claude Code 串行接收同一份提示词，分别在相同 Git 树的临时工作区上运行，每个有独立的 120 秒时限。外部 CLI 从 `PATH` 查找并沿用已有授权。不同产品实际使用的模型与工具权限可能不同。
- 本机 `compare` 的工作目录共享宿主文件系统。做盲测时，只把公开起点交给 Agent 容器，等它退出后再评分。用 `node test/engineering-sandbox.mjs probe` 实测 Pi 读写、Shell 和子进程的权限边界，用 `node test/engineering-sandbox.mjs grade durable-jobs <工作区>` 在独立容器内对只读快照评分。需要本地 Linux Docker 引擎，构建镜像可能需要访问 npm。日常 TUI 与面板仍沿用当前系统账户权限。
- `comparison.json` 保留提示词指纹、起点树、原始日志路径、进程退出和独立断言评分。对照工具在同一份交付快照上检查功能与源码完整性。成功收尾、所有断言通过且源码检查通过时记为已交付。`sourceIntegrity` 检查 Git 跟踪及未忽略的 JavaScript、TypeScript 和 JSON 普通文件，分别记录非法 UTF-8 与坏字符。超时保留已产生的代码和可判定分数。缺少可执行文件时记录原因，评分和源码检查留空。报告保留工作区路径，便于复核代码改动。
- 0.38.0 支持以 `task_progress.start` 的 `finishWhenVerified` 声明由完整验收证据完成任务。最后一项验收单独执行并通过后，运行时在正常收尾时重验源码并写入可见回执。命令行及面板可在历史消息中查看回执。排队的用户消息正常进入模型，同批后续改动会撤回过期证据。工程对照认可任务状态一致且回合正常结束的回执。
- 0.37.0 的状态迁移题自带可运行的并发保存回归。用例让首次异步替换保持进行中，再启动同一目标文件的其余保存，模拟短暂的 `EPERM` 占用冲突。公开测试与独立评分使用同一受控场景和不同样本，同时保留实际文件系统的并发断言。变更后的起点、提示词和评分分母随报告版本记录。
- 如需从保存的事件重新计算运行结局，可用 `metrics <events.jsonl> <process.json> [superpi|codex|claude-code]`。省略格式时按 SuperPi 读取。
- 0.23.1 在发起审查请求时记录计数，支持回看超时或强制停止前的请求量。`metrics` 对复用报告去重，并标出旧日志中缺失计数的审查。评审自身的断流与其他模型错误可在报告中查阅。
- 独立评审对最多 12 个常规源文件和项目清单提供当前完整源码，加 Git 差异或改动文件的基准内容。0.36.1 从差异材料与实际查阅工具定义的序列化大小计算首轮证据预算，保留基础 12 KB 额度，并受模型上下文预算约束。首轮的空闲窗口取剩余时限的三分之一，最长 15 秒。收到模型内容会重开空闲窗口，整次评审仍以原时限为准。空闲超时或可恢复的输出失败时，该路评审改为按需查阅。显式路径、删文件、混合仓库和超预算快照从 Git 差异开始。按需查阅会引用已经提供过的大段源码，短范围仍返回精确的带行号原文。评审和验收计划会检查重叠操作与部分失败等涉及的边界。
- 第三方网关报告 `upstream aborted (gateway closed stream)` 时，面板和命令行会显示断流。开启重试时主回合从已完成的工具结果继续，未完成的模型草稿保留在会话记录中供排查。
- 独立审查通过 Pi 的错误分类识别暂时性上游故障。会话允许自动重试时，受影响的一路在原时限和请求预算内补发一次，沿用已提交的源码与读取结果。两端显示重试或最终失败，另一路已提交的报告继续有效。
- 审查输出达到模型上限时，受影响的一路可在原证据上单独补交一次报告。已有的读取结果继续有效，缺失的覆盖项仍待验收。完整快照的报告需要续审时，源码、未关闭问题和预算都吻合的情况下，首个请求就带齐这些材料。
- 0.26.0 独立评审成功读取源码后遇到网关断流，可以用一次请求提交已有证据支持的报告。该请求使用任务目标及带行号的源码摘录，最多 12 KB 且遵循模型预算。恢复遵循原时限、请求预算和会话重试设置。已有发现进入报告，全量评审仍待验收，另一份报告照常保留。
- 0.27.0 未完成的评审会在会话里保存最近读取成功的文件路径和行号，最多 64 段。重新打开会话后，续审从同一指纹的 Git 快照重建带行号的摘录，按原输入预算送给待补审的一路。评审结果显示保存和恢复的数量。源码变化会启动新评审，完整报告仍是验收条件。
- 0.28.0 会在每次有新源码读取结果、一路评审提交有效报告时写入 Pi 会话。若进程在 `review_changes` 回传前退出，重新打开会话后发起同一项评审即可恢复已读范围和已提交的报告。源码指纹仍须匹配。记录只保存路径、行号和已验证的报告，续审时从快照恢复源码。

</details>

## 测试

在新克隆的仓库中使用 Node.js 22.19 或更新版本和 Git。用 `npm ci` 安装锁定的 Pi 和 React 依赖，再运行全量门禁。

```powershell
npm ci
npm test
```

`npm test` 使用回环模型服务与真实 Pi 子进程，不需要模型账号。它按依赖顺序运行每套门禁一次，并比对当次退出状态和 [检查数下限](test/gate-inventory.json)。`npm run test:reliability` 单独验证输出异常、会话恢复和交付流程。`npm run check:carriers` 巡检本机的技能、工具和记忆。

<details>
<summary>联网检查、打包验证与门禁参考</summary>

```powershell
npm run test:host   # 使用已配置的模型执行一次真实往返
npm run test:fresh  # 模拟全新机器：拷一份不带运行时的插件 → 断言 missing → 一键安装 → 能开会话
npm run test:config # 配置热更新：宿主就地写入 volatile 引用后 /state 必须立刻反映
npm run test:all    # 依次运行 npm test 和 npm run test:host
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
| `test/preflight.mjs` | **门禁依赖的唯一判据**：缺 pi / react / jiti 直接失败，不再 `SKIP + exit 0`。为什么必须这样：`.runtime/` 是 gitignore 的，**新机器 clone 下来必然没有 pi**，而实测隐藏它之后 `tui-editor` 的整段检查一条都没跑、`npm test` 仍是绿的。 |
| `test/session-lifecycle.mjs` | **会话池生命周期**：spawn 进池、`exit` 立刻摘除、摘除后 `/state` 不再列出、路由 404、崩溃累积不撞 8 个上限、`exit` 与主动关闭并存时幂等。对应的真实缺陷是「死进程永不摘除 → 8 次崩溃后新建会话 429」。 |
| `test/gate-inventory.mjs`+`.json` | **门禁执行与对账**。按原顺序执行每套检查，用当次退出状态和实测数量判断是否通过。`--list` 查看登记下限，`--print` 执行计数门禁并打印实测值。 |
| `test/timeout.mjs` | 超时语义门禁（规模见 `test/gate-inventory.json`）：`timeoutLimitMs` 的三态（正数=毫秒上限 / `0``负数``Infinity`=不设上限 / `NaN``乱码``对象`=TypeError 绝不静默降级）、到期即 reject 且不留孤儿 pending、不设上限时进程关闭由 `handleExit` 兜底、**弹窗未答则计时期续期**、**应答后重开一整轮窗口**、续期上限耗尽时报「dialog(s) never answered」。用 `test/fixtures/fake-pi-rpc.mjs` 做协议替身，把 5 分钟的真实等待压到毫秒级 —— 这是 0.3.0 之前「红条与对话框并存」那个缺陷唯一可靠的门禁 |
| `test/fixtures/fake-pi-rpc.mjs` | 假 pi RPC 子进程（`FAKE_PI_MODE=dialog/silent`）：只为复现「命令永不回答」与「命令在等弹窗」两种时序，不模拟其他行为 |
| `test/fixtures/pi-ext-ui-probe.ts` | 扩展 UI 探针（人工验证用，不参与 `npm test`）：复制到 `%USERPROFILE%\.pi\agent\extensions\` 并重启 pi 会话后，`/dsh-ui-probe` 依次弹 select→confirm→input→editor，`/dsh-ui-notify` 验五个单向方法。**扩展对话框必须真人点，自动化只能测到 host 侧的时序**，所以探针留在仓库里当复现手段 |
| `test/client-render.mjs` | `react-dom/server` 把面板渲染成字符串（含键集与循环展开共执行 831 次，条数由脚本自报 `PASS (831 assertions)`）：挡组件异常、文案缺键、中英键集不一致、引导页结构、以及扩展 UI 四种弹窗（confirm 的「否/确认」按钮集、select 的选项数、input 的 prefill/placeholder、editor 的多行回填、空 title 回落、`dialogBudgetMs` 的「声明值与 5 分钟上限取小」四类非法值回落）。**倒计时的「还剩 Ns」文案断言不到**——那行由 `useEffect` 驱动，SSR 阶段 `left` 为 `null` 不渲染，只能在真浏览器里验 |
| `test/css-tokens.mjs` | CSS 门禁（规模见 `test/gate-inventory.json`）：禁硬色值（只准 `--dsw-*`）、令牌白名单、字体栈、`:focus-visible` 可见性、`prefers-reduced-motion` 兜底，另有 0 号自检确认门禁本身不是空跑 |
| `test/tui-editor.mjs`（技能段） | `skills/` 的契约（0.11.0）：目录只能有 `verified-delivery` / `change-scope` 两个、安装器 `SKILL_NAMES` 与目录一致、每个 `SKILL.md` 的 frontmatter `name` 必须等于目录名（否则 pi 的发现名与路径对不上）、`description` 以 `Use when`/`Use before` 开头且足够长、正文含核心原则与自我合理化对照表、不含硬编码本机路径；安装面装出到 `~/.agents/skills/`、装出的内容与源**逐字节一致**、卸载后不留残留（`remove()` 也要清 skill，否则「卸了还在生效」是最难排查的残留）|
| `test/restart-lib.mjs` | 重启脚本门禁（文件层：UTF-8 BOM、无游离 CR、库模式开关、去注释后无裸 `Start-Process -FilePath $exe`、走 `ProcessStartInfo`、有自保护）+ `test/fixtures/restart-lib-checks.ps1` 的 31 条 PS 断言（`Get-LaunchSpec` 四种输入、`Get-DshHomeFromRoot` 五种、`Get-EnvPatch` 六种、`Get-LaunchRootPid`/`Test-SelfAncestorOf` 对活进程、`Test-DshPiHealth` 对五种假响应与死端口）。**pwsh 7 与 PowerShell 5.1 各跑一遍**，是「5.1 能不能读这个脚本」的唯一机器保障 |
| `test/version.mjs` | 版本号单一真相：`/health`、`/state`、`/diagnostics` 报的版本必须等于 `package.json` 的 `version`；换版本重新加载要跟着变（防写死常量）；`package.json` 缺失时降级 `0.0.0` 而不是崩；README 里的 tarball 名必须跟版本对齐 |
| `test/session-projects.mjs` | 两级历史列表（规模见 `test/gate-inventory.json`）：`pathComparisonKey` 大小写归一、`isTemporaryPath` 三条正则逐条对齐 pi（`/tmp`、`appdata/local/temp`、`pi-runtime-*`）、`shortenHomePath` 的 `~` 缩写边界、`groupSessionsByProject` 的「当前项目 → 非临时 → 最近活动降序」与大小写合并、`listAllSessions`/`listSessions` 的「全部项目 vs 单项目」两种语义、`readSessionCwd` 只读 64KB 头行且首行非杂项时返回空、`firstRunningSessionFile` 的「跨项目也算当前会话」与活/死优先级。造一棵符合 pi 目录约定的假 `sessions/` 树来跑，不碰真会话 |
| `test/host-parity.mjs` | host 侧离线一致性（规模见 `test/gate-inventory.json`）：`buildSpawnArgs` 19 条（`persist=false` 不吃 `--continue`、用户自带 `--fork`/`--no-session` 不重复生成、空 `--name` 不传）、`pickCurrentSessionFile` 8 条、以及 `/respond` 的 409/400/415/200、`/reset` 路由已移除（回归守卫）、四条替换命令的 reset+refresh、`/files` 排序与 404、`/file` 预览 28 条（文本截断 / 二进制探测 / 目录 400 / ENOENT 404 / MIME 映射 / `~` 与 `%VAR%` 展开）、`/pi/changelog` 三情形、未知路由 404、`/ui-prefs` 三条路由 33 条（GET 空文件回落、项目改名 trim 与键白名单、会话置顶与「只给 name 不许凭空置顶」的合并语义、四类 400）。**路由与参数拼错了只会静默跑偏，所以单独立门禁** |
| `test/parity.mjs` | 与 pi 的三向对账（规模见 `test/gate-inventory.json`）：以 pi 的 `RpcCommand` 联合类型、`RpcSessionState` 接口、`docs/json.md` 事件表为事实来源，双向比对（我们缺的 = 缺口，我们编的 = 幻觉），再断言契约里 33 条命令 / 25 类事件 / 12 种 assistant 事件 / 27 条斜杠 / 9 个扩展 UI method 在面板里都有落地字面量，且 `CONTRACT_VERSION` 与 `package.json` 同步。0.2.5 时「只发 5/33 命令、只处理 12/25 事件、27 条斜杠一条没接而 `npm test` 全绿」正是这个门禁要拦的事 |
| `test/rules.mjs` | 用户自定义规则门禁（规模见 `test/gate-inventory.json`；0.10.0）：三层都测 —— ①纯函数（归一必须幂等、默认文案逐条覆盖用户给的 21 条要点、`checksum` 自算与 drift 检测、超长回落默认而不截断、空规则渲染成空串「零痕迹」）；②`createRulesStore` 真读写临时文件（读不写盘、createdAt 不因更新而变、相同文本幂等不刷 `updatedAt`、坏 JSON 回落 + 告警、并发写不互相截断、不残留 tmp）；③**真 `.ts` 扩展**（jiti 加载 `extensions/superpi-rules.ts` + 假 `pi`/假 `ctx.ui`）断言 `before_agent_start` 把规则放进 `systemPromptOptions.sections`、改完文件**下一轮**就拿到新文本、坏文件/读盘异常都**不抛给 pi**、`/superpi-rules` 的编辑/只看/恢复默认/无 UI 四条路径；外加 HTTP 三路由（归一回显、空 = rank 0、reset、drift、坏文件仍 200 带 warning、415/400）与安装面（三个文件、装出来的 `.mjs` 与仓库逐字节一致、`client.js` 不复制默认文案）。**扩展层不跳过就一定要跑**：只测纯函数的话，「面板保存了、pi 却读不到」这类断链完全测不出来 |
| `test/turn-verdict.mjs` | 回合判据门禁覆盖 DSML、空转、坏字节、截断、正文未闭合推理标记及合法引用。验证共用判定器、事件装饰和面板真实渲染 |
| `test/delivery.mjs` | 用 Pi SDK 验证命令与超时、隔离变异、证据失效、会话恢复、模型收到最新图片和文本异常恢复。模型事件由本地脚本提供 |
| `test/text-integrity.mjs` | 写入闸门禁（规模见 `test/gate-inventory.json`）：①纯函数（`write.content` / `edit.newText` 拦，`edit.oldText` 放行，`bash`/`powershell` 只提醒不拦，转义写法算干净）；②**真 `.ts` 扩展**（jiti + 假 pi）：注册表、block 理由（行号/码位/总数 + 「文件未写入」+ 「不要原样重发」）、`tool_result` 追加警告且 `structuredContent` 原样带回、同一 `toolCallId` 只提醒一次；③**pi 真 `ExtensionRunner`** 跑一遍 `emitToolCall`，断言它返回 block；④**pi 源码事实**：`beforeResult.block` 会变成 `createErrorToolResult(reason)` 且工具不执行；⑤pi 的扩展加载器装进临时 agentDir 零错误；⑥干净会话零日志零追加（不引入噪音） |
| `test/tui-editor.mjs` | 输入框扩展门禁（规模见 `test/gate-inventory.json`；0.9.2 起；0.9.4 补外观与入口，0.9.8 修「改了没变化」，0.9.9 补 footer 接管 + 项目切换 + 悬停反馈，0.9.10 修「底部那行信息没了」，0.9.11 修「settings/home 点不动」）：**用 jiti 加载真 `.ts` 扩展**（与 pi 的 `core/extensions/loader.js` 同一套 alias）+ **pi 真的 `CustomEditor`** + **真终端按键序列**（直接喂原始转义字节的按键序列），断言 Ctrl+A 全选、Shift+方向扩选、Ctrl+C 复制后内容不消失、Ctrl+X 剪切、Backspace/Delete 删选区、可打印字符与括号内粘贴替换选区、Esc 不吞键、空编辑器 Ctrl+C 放行、自动补全打开时不抢方向键、渲染反色开合成对；末组用 **pi 自己的扩展加载器**（`discoverAndLoadExtensions`）把装到临时 `agentDir` 的扩展真加载一遍断言无 error —— 这一步才证明「装完 pi 真的能认」。**不 mock 编辑器**：影子实现会让「测试绿、真机不灵」|
| `extensions/superpi-editor.ts` | 命令行会话窗口的**输入框增强**：`class SuperPiEditor extends CustomEditor` + `ctx.ui.setEditorComponent()`（pi 官方扩展点），补上 TUI 缺的那套 Windows 输入框语义（全选 / 扩选 / 复制不清空 / 剪切 / 删选区）与「剪贴板里的文件 → 绝对路径」。**不改 pi 任何文件、不打补丁**，卸载就是删一个 `.ts`（`npm run superpi:editor:remove`）|
| `tools/install-pi-extension.mjs` | 把扩展装进 `<piAgentDir>/extensions/`（`--install` / `--remove` / 默认只读状态），`PI_CONFIG_DIR` 跟随；幂等、内容变了先留 `.bak`。**0.10.0 起一次装三个文件**（`superpi-editor.ts` + `superpi-rules.ts` + `superpi-rules.mjs`）—— 规则扩展 import 同目录的 `.mjs`，少装一个就是「装完 pi 报模块找不到、规则整个不生效」，所以 `status` 逐文件报告、`complete` 才算完整。`npm run superpi:editor` / `pi:editor:status` / `pi:editor:remove` 三个别名|
| `一键启动.bat`（仓库根） | 一键启动的**根目录入口**，纯 ASCII 转发器：把 `%*` 与退出码原样透传给 `tools/launch-both.ps1`。逻辑不重复实现 |
| `tools/launch-both.ps1` | **同时起两个前端**：① pi TUI（新开真实控制台窗口，走 `src/pi-runtime.mjs` 解析链拿 pi 与 node）；② DSH web（后台 25117）。互不阻塞，分别报 `OK/WARN/FAIL`；`-Stop` 只关自己起的（TUI pid 记在 `.standalone/tui.json`）。**pi 在非 TTY 下会静默退出，所以 TUI 必须开真实窗口** |
| `tools/start-standalone.ps1` / `.bat` | **一键启动**常驻实例：状态落在仓库内 `.standalone\`，首次装依赖、之后复用；默认端口 25117；`-Stop` / `-Status` / `-Reinstall` / `-Port`。位置无关，不碰桌面 profile |
| `tools/standalone-verify.ps1` | 全新 DSH_HOME 自证：建临时 profile → pnpm 装 tarball → 起独立实例 → 真实 LLM 往返 → 清理（端到端演练，不是单测）。默认端口 25119，不与一键启动实例争用 |
| `tools/github-sync.mjs` | **线上同步**（把本地提交推到 <https://github.com/lwaaron/superpi>）：`syncOnce()` 先 `ls-remote` 探一次（既测连通、也避免重复推）→ 不相等才 `git push origin HEAD:refs/heads/<branch>` → 再补 `git push --tags`。失败按 stderr **分四类**：`auth`（凭据/权限，要人处理）/ `rejected`（线上分叉，**绝不 force**）/ `offline`（连不上，提交留本地等下次）/ `failed`；退出码 0 已同步 · 2 离线待补推 · 3 要人处理 · 1 其它。并发用 `.git/superpi-sync.lock`（120 s 残留自动接管），每次尝试记一行 `.git/superpi-sync.log`（在 .git 里，不入库）。`GIT_TERMINAL_PROMPT=0` + `GCM_INTERACTIVE=never` + `execFile` 硬超时，保证后台跑不会弹出认证窗口把人挂住 |
| `tools/git-hooks/post-commit` / `npm run hooks` | 装进 `.git/hooks/post-commit` 的 8 行 sh 钩子：每次 commit 后**后台**跑一次 `github-sync.mjs --from-hook`（短超时、安静、`&` 不阻塞、永远 `exit 0`）。离线时它什么都不做 —— 提交已经落地，下次提交或 `npm run sync` 会把欠的提交一起推上去。关掉：`SUPERPI_GIT_SYNC=0` |
| `test/github-sync.mjs` | 线上同步门禁 82 条：文件层（无 BOM / LF / ASCII 钩子 / 不硬编码本机路径 / 无 `--force` / 带超时与禁交互认证）+ 纯函数（四类错误分类、`ls-remote` 解析、退出码）+ **真 git** 跑完整个生命周期（首推 / 幂等 / 新提交再推 / 补 tag / 锁与残留锁接管 / 无远端 / 断网且本地提交不丢 / 分叉拒绝且远端 ref 不动 / 游离 HEAD / 无提交 / 开关关闭 / 只读状态 / 装钩子）+ 接线（`npm run sync` / `npm run hooks` / README / AGENTS.md / `tools/` 不进 npm 包）。远端是临时裸仓库，断网用 `127.0.0.1:1` 拒连模拟，**全程不联网** |

`client-render.mjs` 通过验收预检查找 `react` 和 `react-dom`。依赖缺失时门禁失败，可在仓库根目录运行 `npm ci` 安装。

</details>

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

## 会话与模型快捷操作

- 在同一个 DSH 侧栏中使用顶部 `+` 打开并行会话。选择已在运行的历史会话会切到对应标签。多标签时可关闭当前会话以释放名额。命令行可在不同窗口运行独立会话。
- `persist=true` 默认保存会话。`startup=continue` 在重启后恢复该目录最近的会话，也可以从历史中选择其他会话。临时任务可使用 `persist=false`，命令行等价选项为 `--no-session`。
- 两端均可用 `Ctrl+P` 和 `Ctrl+Shift+P` 正向及反向切换可用模型。面板从 Pi 进程读取自动重试状态。命令行使用 `/superpi-retry`；项目配置覆盖全局设置时，两端均会显示有效值。

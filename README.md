# dsh-pi

把 [pi](https://github.com/lwaaron/pi) 作为 DSH 的侧栏面板接进来：左侧栏「pi」入口，主区一整页聊天界面，背后是一个常驻的 `pi --mode rpc` 子进程。

不是重新实现 pi 的 TUI，而是复用 pi 官方的 **RPC 协议**（`packages/coding-agent/docs/rpc.md`）做一层薄适配 —— pi 升级时只要 RPC 帧不破，面板就不用改。

**这个插件本身是可独立分发的**：pi 运行时从插件自己的目录解析（`node_modules` → `.runtime` → 逐级向上 → pnpm store → npm 全局），装不上还能在面板里一键安装到 `.runtime`。不需要在代码里写死任何本机路径，也不需要用户先手工构建 pi。

## 结构

```
index.js              host 半区：HTTP 路由 + 会话池 + 子进程生命周期 + 自检
client.js             浏览器半区：侧栏入口注册 + 聊天面板（零构建，纯 JS + React.createElement）
cordis.patch.yml      bundle 补丁，把本插件插入 DSH 宿主组合
src/pi-rpc.mjs        JSONL 帧解析 / RPC 命令配对 / 事件缓冲
src/pi-runtime.mjs    pi 运行时解析链 + 一键安装（唯一知道「pi 装在哪」的地方）
assets/icon.svg       插件图标
```

两半区的硬约束（改动前先读）：

- `index.js` / `src/pi-rpc.mjs` / `src/pi-runtime.mjs` **不 import 任何 `@deepseek-ai/*` 包**。宿主里那些包解析不到，写死依赖会让插件 fiber 永久 pending，DSH 启动就卡住。只用 node 内建。
- `@deepseek-ai/schemastery` 是唯一例外，且必须**动态 import + 兜底**：静态 import 失败会让整个 server entry 加载失败，插件被标「异常」；兜底成 `Config = undefined` 只是「插件详情页没有配置区」，面板照常工作。
- 子进程隔离而非 SDK 内嵌：pi 崩掉只影响这个面板，不会带崩 DSH 主进程。
- `client.js` 里 `sidebar.panellist` 的 `id` 必须与 `main` keyed slot 的 `key` 相同，且两次 `slots.inject` 都要包在 `ctx.inject([...])` 内，否则 entry 永久 pending。
- 客户端 `require` 白名单只有 `react` / `react-dom` / `jsx-runtime` / `@deepseek-ai/dsh-client-ui-primitives`；样式只用 `--dsw-*` 变量，深浅色主题自动适配。

## 安装

### 方式一：一键装进 DSH profile（推荐）

```powershell
# 打包 → 装到临时目录验证（真跑一轮 LLM）→ pnpm add 进 profile → 再验证一次 → 生成回滚脚本
pwsh -NoProfile -File .\tools\install-plugin.ps1 -Profile desktop
```

**必须由包管理器落地，不能手工往 node_modules 里塞副本。** DSH 的插件管理器运行时会跑 pnpm；只要 `package.json` 与 `pnpm-lock.yaml` 对不上，或者 `node_modules/.modules.yaml` 不认识这个包，pnpm 就会把手放的目录当孤儿清掉。脚本因此把三份状态交给 pnpm 一次写一致：

1. `npm pack` 出 `dsh-pi-<ver>.tgz`；
2. 装到 `%TEMP%\dsh-pi-stage-*`，用**装出来的那份**跑一遍真实 LLM 往返（`test/packed-smoke.mjs`），失败则 profile 一动不动；
3. tarball 收进 `<profile>\.dsh-local-packages\`，备份 `package.json` / `pnpm-lock.yaml` / 现有 `node_modules\dsh-pi`；
4. 用 **DSH 自带的 pnpm** 执行 `add file:<tarball>` —— manifest、lock、node_modules 由 pnpm 一次写一致，`optionalDependencies` 里的 pi 运行时随之落进 profile；
5. 校验四件事：manifest 的 `dsh-pi` 是 `file:` 依赖、lock 里有 `dsh-pi` 与 `pi-coding-agent`、`node_modules/dsh-pi/index.js` 存在、`.modules.yaml` 认识 `dsh-pi`；任一项不满足即报失败并给回滚命令；
6. 用 profile 里那份副本再跑一遍真实 LLM 往返；
7. 生成 `rollback-<时间戳>.ps1`（恢复 `package.json` + `pnpm-lock.yaml`，再让 pnpm `install --frozen-lockfile` 收敛 node_modules）。

PATH 上的 `pnpm.ps1` 通常是 corepack shim，直接调用会报 `Cannot find module ...corepack\dist\pnpm.js`。脚本默认用 `%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs`，装到别的机器用 `-PnpmPath` 指过去。

**装完要重启 DSH 才生效**（插件在 import 时就把代码快照进内存了）。不想保留时运行脚本打印出来的 `rollback-<时间戳>.ps1` 即可原样退回。

只想验证不落地：`pwsh -NoProfile -File .\tools\verify-packed.ps1 -Keep keep`。

### 方式二：手工挂载（开发插件本身时用）

把源码目录链到 profile，改完重启 DSH 就能看到：

```powershell
New-Item -ItemType Junction `
  -Path   "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-pi" `
  -Target "C:\path\to\dsh-pi"
```

并在 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 末尾加：

```yaml
- insert:
    - id: dsh-pi
      name: dsh-pi
      config: {}
```

`id` 同时是配置命名空间，不要随意改。

### 方式三：手工 pnpm add（不想跑脚本时）

```powershell
npm pack                                        # 得到 dsh-pi-0.2.1.tgz
cd "$env:USERPROFILE\.dsh\profiles\desktop"
node "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs" `
  add "file:C:\path\to\dsh-pi-0.2.1.tgz" --ignore-scripts
```

不要在 profile 里用 `npm install`：npm 会另写一份 `package-lock.json`，而宿主插件管理器用的是 pnpm，两套锁文件互相看不见，下次插件安装就会把 node_modules 重建成 pnpm 理解的样子。

装 `optionalDependencies` 里的 `@earendil-works/pi-coding-agent` 时，pi 会被提升到 profile 的 `node_modules`，解析链第 6 步（逐级向上）命中；装不上也不影响插件加载，面板会引导一键安装到 `.runtime`。

装完核对（三条都要有输出）：

```powershell
Select-String -LiteralPath pnpm-lock.yaml -Pattern '^\s+dsh-pi:$'          # lock 认识它
Test-Path node_modules\dsh-pi\index.js                                     # 代码在
Select-String -LiteralPath node_modules\.modules.yaml -Pattern 'dsh-pi'    # pnpm 认识它
```

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

一个都找不到时，面板整页变成引导：一句「还没装 pi 运行时」+「一键安装 pi」按钮 + 已搜索位置清单（`✓/✗ source · path`）。按钮打的是 `POST /api/dsh-pi/runtime/install`，内部执行：

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
| `workspace` | `~/pi-workspace` | 新会话的默认工作目录 |
| `extraArgs` | `""` | 空格分隔，追加到 pi 命令行（会话级 `args` 之后） |
| `args` | `["--no-session"]` | 基础参数 |

环境变量（优先级低于 config）：`PI_CLI_PATH`、`PI_NODE_PATH`、`PI_WORKSPACE`、`PI_BASH`、`PI_RUNTIME_DIR`。

`PI_BASH` 用来告诉 pi 用哪个 bash（Windows 上装 Git for Windows 后指向 `C:\Program Files\Git\bin\bash.exe`）；不设则由 pi 自己找。

## HTTP 接口

同源、免 token（走 `webServer` 的 prefix 注册，不走宿主鉴权层）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/dsh-pi/state` | 解析结果（含 `runtime`）+ 当前所有会话快照 |
| GET | `/api/dsh-pi/health` | 健康检查 |
| GET | `/api/dsh-pi/selfcheck` | 自检：内存中加载的代码 vs 磁盘上的代码、pi 构建新鲜度 |
| GET | `/api/dsh-pi/diagnostics` | 插件信息 + 运行时解析明细 + 自检，排障先看这个 |
| GET | `/api/dsh-pi/runtime` | 运行时解析报告（`ok` / `source` / `cliPath` / `searched` / `install`） |
| POST | `/api/dsh-pi/runtime/refresh` | 重新解析（手工装好 pi 后不必重启 DSH） |
| POST | `/api/dsh-pi/runtime/install` | 一键安装 pi 到 `.runtime`（幂等，并发只跑一次） |
| POST | `/api/dsh-pi/sessions` | 新建会话，body 可带 `cwd` / `label` / `args` |
| GET | `/api/dsh-pi/sessions/:id` | 单个会话快照（不含事件数组） |
| DELETE | `/api/dsh-pi/sessions/:id` | 关闭会话（先关 stdin 再超时 kill） |
| GET | `/api/dsh-pi/sessions/:id/events?since=N` | SSE 事件流，15s 心跳注释帧 |
| GET | `/api/dsh-pi/sessions/:id/snapshot?since=N` | 增量快照（重连补数据用） |
| POST | `/api/dsh-pi/sessions/:id/command` | 转发一条 pi RPC 命令，body 必须是带 `type` 的 JSON 对象 |

上限：8 个并发会话，请求体 4 MiB。`/command` 的 `content-type` 必须是 `application/json`（否则 415），body 必须是带字符串 `type` 的对象（否则 400）。

## 面板行为

- 打开时若已有会话就复用第一个，否则新建；「新会话」= 关旧开新，不污染上下文。
- 对话区把 pi 的 `turn_start / text_delta / thinking_delta / toolcall_* / turn_end` 归并成消息气泡，工具调用渲染成可折叠卡片，底部给 in/out/total token 数。
- composer：`Enter` 发送、`Shift+Enter` 换行、`Esc` 打断；正在跑时再发会以 `streamingBehavior: "followUp"` 排队。
- 顶部思考档位下拉来自 `get_available_thinking_levels`，切换走 `set_thinking_level`；连接状态用圆点表示（ready / busy / dead）。
- 顶部还有一枚自检胶囊：绿「代码已同步」/ 黄「代码已更新 · 待重启」/ 黄「pi 需重新构建」，鼠标悬停给出结论、git 分支@短 sha 与缺失文件，点一下重新检查。请求失败就直接不渲染 —— 宁可少一个胶囊，也不要误报绿点。
- pi 运行时缺失时整页切到引导（见上文），不创建会话、不产生半死不活的状态。
- pi 进程退出时面板转红点并提供「重试」与「重新检查」，不会静默空白。

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
npm test            # selfcheck + client-render + runtime-resolve + config-hot，约 3 秒，不联网
npm run test:host   # 真起 pi 子进程跑一轮 LLM 往返（用插件的 .runtime）
npm run test:fresh  # 模拟全新机器：拷一份不带运行时的插件 → 断言 missing → 一键安装 → 能开会话
npm run test:config # 配置热更新：宿主就地写入 volatile 引用后 /state 必须立刻反映
npm run test:all    # 以上除 fresh 外全部串起来
npm run verify      # npm pack → 装到临时目录 → 用打包产物跑真实 LLM 往返
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
| `test/client-render.mjs` | `react-dom/server` 把面板渲染成字符串：挡组件异常、文案缺键、中英键集不一致、引导页结构 |

`client-render.mjs` 需要 `react` / `react-dom` —— 本插件刻意不带 `node_modules`，所以它从同级 `pi-main/node_modules` 借（找不到就 SKIP 并退出 0，不算失败）。

## 与 DSH 插件管理器的关系

DSH 的插件管理器（dshmarket / 插件详情页）在安装、卸载、升级插件时跑的是 **pnpm**，参数大致是 `add` / `remove` / `install`（含 `--frozen-lockfile` 与 hoist-pattern 漂移后的 `install --no-frozen-lockfile` 重试）。它不做 `prune`，但会按 `pnpm-lock.yaml` 与 `node_modules/.modules.yaml` 判断哪些包该在。

因此装 dsh-pi 的正确姿势只有一种：**让 pnpm 写状态**。手工放目录 + 手改 `package.json` 会造成两种漂移，任一都会让副本在下次插件操作时消失：

| 漂移 | 表现 | 后果 |
| --- | --- | --- |
| manifest 有、lock 没有 | `frozen-lockfile` 校验报「specifiers in the lockfile don't match specifiers in package.json」 | 插件管理器报错，或退回 `--no-frozen-lockfile` 重写锁 |
| 有文件、`.modules.yaml` 不认识 | `node_modules` 里有目录但 pnpm 视角不存在 | 下次 `install` 按孤立包清理 |

已实测的边界：

- `pnpm add dsh-free-model@3.1.0`（manifest 与 lock 都是 dsh-pi 正常运行时的状态）→ dsh-pi 与 pi 运行时都存活；
- 故意造漂移（manifest 有 dsh-pi、lock 没有）再 `pnpm add` → pnpm 顺手把 dsh-pi 补装回来，锁被重写，仍然可用；
- 锁里的 `file:.dsh-local-packages/dsh-pi-0.2.1.tgz` 是**相对 profile 根**解析的，删掉 `.dsh-local-packages` 会让 `install` 直接报 `ERR_PNPM_TARBALL_READ_LOCAL_TARBALL` —— 想改锁前先确认这个目录还在。

`.dsh-local-packages/` 里的 tarball 是回滚与重装的锚点，不要手动清。

## 已知限制

- 只支持单实例面板：多开同一 keyed slot 会互相覆盖状态。
- 会话不落盘，DSH 重启后历史清空（pi 自身仍会写 `~/.pi/agent/sessions`）。
- 图片块以 `[image <mime>]` 文本占位，未做渲染。
- `/selfcheck` 只能回答「进程加载的 vs 磁盘的」。插件被别处改过又被指回来时，需要重启一次让快照刷新。
- 一键安装需要能访问 npm registry；离线环境请把 `cliPath` 指到已有 pi，或先手工把依赖装到 `.runtime`。

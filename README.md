# dsh-pi

把 [pi](https://github.com/lwaaron/pi) 作为 DSH 的侧栏面板接进来：左侧栏「pi」入口，主区一整页聊天界面，背后是一个常驻的 `pi --mode rpc` 子进程。

不是重新实现 pi 的 TUI，而是复用 pi 官方的 **RPC 协议**（`packages/coding-agent/docs/rpc.md`）做一层薄适配 —— pi 升级时只要 RPC 帧不破，面板就不用改。

## 结构

```
index.js          host 半区：HTTP 路由 + 会话池 + 子进程生命周期
client.js         浏览器半区：侧栏入口注册 + 聊天面板（零构建，纯 JS + React.createElement）
cordis.patch.yml  bundle 补丁，把本插件插入 DSH 宿主组合
src/pi-rpc.mjs    JSONL 帧解析 / RPC 命令配对 / 事件缓冲
test/host-smoke.mjs  无头自测：起服务、连 CLI、发 prompt、验证回包
test/selfcheck.mjs   无头自测：证明 /selfcheck 能分辨「内存里跑的代码」与「磁盘上的代码」
test/client-render.mjs  无头自测：用 react-dom/server 把面板渲染成字符串，挡住组件异常与文案缺键
tools/selfcheck-now.mjs 命令行自检：不进 DSH 也能问「下次启动会加载到哪一版」
```

不开浏览器、不进 DSH 也能跑的自测：

```powershell
npm test          # selfcheck + client-render，约 1 秒
npm run test:host # 真起 pi 子进程跑一轮 LLM 往返，约 5 秒
npm run test:all  # 三者串起来
```

`client-render.mjs` 需要 `react` / `react-dom` —— 本插件刻意不带 `node_modules`，所以它从同级 `pi-main/node_modules` 借（找不到就 SKIP 并退出 0，不算失败）。

两半区的硬约束（改动前先读）：

- `index.js` / `src/pi-rpc.mjs` **不 import 任何 `@deepseek-ai/*` 包**。宿主里那些包解析不到，写死依赖会让插件 fiber 永久 pending，DSH 启动就卡住。只用 node 内建。
- 子进程隔离而非 SDK 内嵌：pi 崩掉只影响这个面板，不会带崩 DSH 主进程。
- `client.js` 里 `sidebar.panellist` 的 `id` 必须与 `main` keyed slot 的 `key` 相同，且两次 `slots.inject` 都要包在 `ctx.inject([...])` 内，否则 entry 永久 pending。
- 客户端 `require` 白名单只有 `react` / `react-dom` / `jsx-runtime` / `@deepseek-ai/dsh-client-ui-primitives`；样式只用 `--dsw-*` 变量，深浅色主题自动适配。

## 安装

1. 先构建 pi，确认真实存在 `<pi-repo>/packages/coding-agent/dist/bundle/cli.js`（`npm install && npm run build`，产物约 9.2 MiB，`node cli.js --version` 应打印版本号）。

2. 把插件挂到 DSH profile（Windows 用 junction，改动源码即时生效）：

```powershell
New-Item -ItemType Junction `
  -Path   "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-pi" `
  -Target "C:\Users\PC\Documents\pi-local\dsh-pi"
```

3. 在 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 里加一条：

```yaml
- insert:
    - id: dsh-pi
      name: dsh-pi
      config: {}
```

4. 重启 DSH。侧栏出现「pi」入口，点开即面板。

## 配置

全部可选，写在 `config` 里：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `cliPath` | 自动探测 | pi 的 `cli.js` 绝对路径 |
| `nodePath` | 自动探测 | 跑 pi 的 node 可执行文件 |
| `workspace` | `~/pi-workspace` | 新会话的工作目录 |
| `args` | `["--no-session"]` | 追加给 pi 的命令行参数 |

也可用环境变量（优先级低于 config）：`PI_CLI_PATH`、`PI_NODE_PATH`、`PI_WORKSPACE`、`PI_BASH`。

探测顺序：config → 环境变量 → PATH 上的 `node.exe` → 宿主自身 `process.execPath`（最后这条会同时置 `ELECTRON_RUN_AS_NODE=1`，否则 Electron 宿主里启动的子进程会解析失败且日志为空）。

## HTTP 接口

同源、免 token（走 `webServer` 的 prefix 注册，不走宿主鉴权层）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/dsh-pi/state` | 解析结果 + 当前所有会话快照 |
| GET | `/api/dsh-pi/health` | 健康检查 |
| GET | `/api/dsh-pi/selfcheck` | 自检：内存中加载的代码 vs 磁盘上的代码、pi 构建新鲜度 |
| POST | `/api/dsh-pi/sessions` | 新建会话，body 可带 `cwd` / `label` / `args` |
| DELETE | `/api/dsh-pi/sessions/:id` | 关闭会话（先关 stdin 再超时 kill） |
| GET | `/api/dsh-pi/sessions/:id/events?since=N` | SSE 事件流，15s 心跳注释帧 |
| GET | `/api/dsh-pi/sessions/:id/snapshot?since=N` | 增量快照（重连补数据用） |
| POST | `/api/dsh-pi/sessions/:id/command` | 转发一条 pi RPC 命令，body 必须是带 `type` 的 JSON 对象 |

上限：8 个并发会话，请求体 4 MiB。

## 自检：现在跑的是不是磁盘上那份代码

改完插件源码后，DSH 不会热重载 —— 得重启才生效，而「以为生效了其实没有」是最容易浪费半小时的坑。`/selfcheck` 把这个问题变成一次 HTTP 调用：

```powershell
Invoke-RestMethod http://127.0.0.1:<port>/api/dsh-pi/selfcheck | ConvertTo-Json -Depth 6
```

判据只有一条：**插件加载那一刻读到的字节**（`loadedSha256`，在 `import` 时就固定下来）与**现在磁盘上的字节**（`diskSha256`）是否相等。mtime 只作为人看的辅助信息，不参与判定 —— checkout / 复制 / 回滚都能把 mtime 改得很新。

输出要点：

| 字段 | 含义 |
| --- | --- |
| `summary.stale` | 唯一该看的字段。`true` = 磁盘改了但内存里还是旧代码，重启 DSH 才生效 |
| `summary.changed` | 内容不一致的文件；`summary.hint` 是给人看的一句话结论 |
| `files[].runtime` | `true` 的文件（`index.js` / `client.js` / `src/pi-rpc.mjs`）改动必须重启；`false` 的（`package.json` / `cordis.patch.yml`）只是随身文件 |
| `git` | 不用 spawn git，直接读 `.git/HEAD` 与 `refs`；`available:false` 表示没有仓库 |
| `pi.buildFresh` | bundle 目录里最新文件 vs `src` 目录里最新文件；`null` = 判断不了，`false` = 源码比构建新，要重跑 `npm run build` |

`summary.stale=true` 时 `ok` 也是 `false`，方便脚本用退出码 / 布尔判断。

## 面板行为

- 打开时若已有会话就复用第一个，否则新建；「新会话」= 关旧开新，不污染上下文。
- 对话区把 pi 的 `turn_start / text_delta / thinking_delta / toolcall_* / turn_end` 归并成消息气泡，工具调用渲染成可折叠卡片，底部给 in/out/total token 数。
- composer：`Enter` 发送、`Shift+Enter` 换行、`Esc` 打断；正在跑时再发会以 `streamingBehavior: "followUp"` 排队。
- 顶部思考档位下拉来自 `get_available_thinking_levels`，切换走 `set_thinking_level`；连接状态用圆点表示（ready / busy / dead）。
- 顶部还有一枚自检胶囊：绿「代码已同步」/ 黄「代码已更新 · 待重启」/ 黄「pi 需重新构建」，鼠标悬停给出结论、git 分支@短 sha 与缺失文件，点一下重新检查。请求失败就直接不渲染 —— 宁可少一个胶囊，也不要误报绿点。
- pi 进程退出时面板转红点并提供「重试」，不会静默空白。

## 已验证

- `node test/selfcheck.mjs`：四个用例全过 —— 未改动报 fresh；只改 mtime（内容不变）仍报 fresh，证明判定看内容不看时间戳；同进程内改一个字节立刻 stale 并点名 `client.js`；字节还原后回到 fresh 且 sha 与首次一致。
- `node test/host-smoke.mjs`：health / state / 建会话 / prompt / 收流 / 关会话全通，实测模型 `Deepseek-V4.1-Flash`（contextWindow 1000000，maxTokens 391168），单轮 2880ms 收到回包。
- `node test/client-render.mjs`：八个断言全过 —— 中英键集一致且非空；无自检结果时渲染空串；干净 / 过期 / 构建过期三种胶囊的文案、`data-tone` 与 hover 提示逐条核对；缺失文件被点名；`requireShim` 只放行 `react`，其它模块名直接抛错，把「零依赖」这条约束也变成了测试。
- 真机 DSH（pid 60792，GUI `http://127.0.0.1:5475`）：侧栏「pi」入口渲染正常，面板内发「Run the bash tool with the command: echo dsh-pi-panel-ok」，工具卡片显示 `bash / 结果`，气泡回显 `Ran it. Output: dsh-pi-panel-ok`，token 统计 `in 4657 · out 45 · 4702 tokens`。

## 已知限制

- 只支持单实例面板：多开同一 keyed slot 会互相覆盖状态。
- 会话不落盘，DSH 重启后历史清空（pi 自身仍会写 `~/.pi/agent/sessions`）。
- 图片块以 `[image <mime>]` 文本占位，未做渲染。
- `/selfcheck` 只能回答「进程加载的 vs 磁盘的」。若插件被别处改过又被 junction 指回来，需要重启一次让快照刷新。
- 自检快照在模块 import 时冻结，所以面板徽标刷新的是「磁盘现状」，不是「宿主内存现状」—— 唯一能改内存里那份代码的办法仍然是重启 DSH。

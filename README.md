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
```

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
| POST | `/api/dsh-pi/sessions` | 新建会话，body 可带 `cwd` / `label` / `args` |
| DELETE | `/api/dsh-pi/sessions/:id` | 关闭会话（先关 stdin 再超时 kill） |
| GET | `/api/dsh-pi/sessions/:id/events?since=N` | SSE 事件流，15s 心跳注释帧 |
| GET | `/api/dsh-pi/sessions/:id/snapshot?since=N` | 增量快照（重连补数据用） |
| POST | `/api/dsh-pi/sessions/:id/command` | 转发一条 pi RPC 命令，body 必须是带 `type` 的 JSON 对象 |

上限：8 个并发会话，请求体 4 MiB。

## 面板行为

- 打开时若已有会话就复用第一个，否则新建；「新会话」= 关旧开新，不污染上下文。
- 对话区把 pi 的 `turn_start / text_delta / thinking_delta / toolcall_* / turn_end` 归并成消息气泡，工具调用渲染成可折叠卡片，底部给 in/out/total token 数。
- composer：`Enter` 发送、`Shift+Enter` 换行、`Esc` 打断；正在跑时再发会以 `streamingBehavior: "followUp"` 排队。
- 顶部思考档位下拉来自 `get_available_thinking_levels`，切换走 `set_thinking_level`；连接状态用圆点表示（ready / busy / dead）。
- pi 进程退出时面板转红点并提供「重试」，不会静默空白。

## 已验证

- `node test/host-smoke.mjs`：health / state / 建会话 / prompt / 收流 / 关会话全通，实测模型 `Deepseek-V4.1-Flash`（contextWindow 1000000，maxTokens 391168），单轮 2880ms 收到回包。
- 真机 DSH（pid 60792，GUI `http://127.0.0.1:5475`）：侧栏「pi」入口渲染正常，面板内发「Run the bash tool with the command: echo dsh-pi-panel-ok」，工具卡片显示 `bash / 结果`，气泡回显 `Ran it. Output: dsh-pi-panel-ok`，token 统计 `in 4657 · out 45 · 4702 tokens`。

## 已知限制

- 只支持单实例面板：多开同一 keyed slot 会互相覆盖状态。
- 会话不落盘，DSH 重启后历史清空（pi 自身仍会写 `~/.pi/agent/sessions`）。
- 图片块以 `[image <mime>]` 文本占位，未做渲染。

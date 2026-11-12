# dsh-pi

把 [pi](https://github.com/lwaaron/pi)（编码代理 CLI）接进 [DSH]，侧栏多一个「pi」整页聊天面板。
面板不是复刻 pi 的终端 UI，而是用 pi 官方的 **RPC 模式**（`pi --mode rpc`）驱动一个常驻子进程，
把它的 JSONL 事件流翻译成 DSH 面板里的消息泡泡、工具卡片和 token 统计。

## 架构

```
浏览器（client.js）                     宿主进程（index.js）                  pi 子进程
  React 面板  ── fetch/SSE ──▶  /api/dsh-pi/*  ── JSONL stdin/stdout ──▶  node cli.js --mode rpc
```

- **host 半区** `index.js`：只依赖 Node 内建模块，不 import 任何 `@deepseek-ai/*` 包。
  宿主进程里解析不到这些包，写死依赖会让 fiber 永久 pending，整个 DSH 起不来。
- **client 半区** `client.js`：零构建纯 JS（`React.createElement`，无 JSX），通过
  `window.__ModuleLoader__.load` 注册，只 `require("react")`。
- **为什么不直接用 pi 的 SDK**：SDK 要 import pi 的内部模块，pi 升级一次就可能把 DSH 主进程带崩。
  子进程隔离后 pi 崩了只影响这个面板；RPC 是 pi 的对外契约（`docs/rpc.md`），跨版本稳定。

## 安装

1. 先把 pi 构建出来（`packages/coding-agent/dist/bundle/cli.js` 必须存在）：

   ```powershell
   cd <pi 仓库>
   npm install
   npm run build
   ```

2. 把本包链到 DSH 的 profile 依赖目录（Windows 用 Junction）：

   ```powershell
   New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-pi" -Target "<本包绝对路径>"
   ```

3. 在 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 里插入插件条目：

   ```yaml
   - insert:
       - id: dsh-pi
         name: dsh-pi
         config: {}
   ```

4. 重启 DSH。侧栏「蓝鲸任务台账」下方会出现「pi」入口，点开即面板。

## 配置

插件 `config` 字段（全部可空，空 = 自动探测）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `cliPath` | 自动 | pi 的 `cli.js` 绝对路径 |
| `nodePath` | 自动 | 跑 pi 的 node 可执行文件 |
| `workspace` | `~/pi-workspace` | pi 会话的默认 cwd |
| `args` | `["--no-session"]` | 附加给 pi 的命令行参数 |

等价环境变量（优先级低于 config，高于自动探测）：
`PI_CLI_PATH`、`PI_NODE_PATH`、`PI_WORKSPACE`、`PI_BASH`（透传给 pi 的 bash 路径）。

探测顺序：config → 环境变量 → PATH 上的 `node.exe` → 宿主 `process.execPath`（Electron 下置
`ELECTRON_RUN_AS_NODE=1`）。CLI 探测失败时面板会报「pi CLI 未找到」而不是静默空白。

## HTTP 接口

同源，不需要 token（插件路由走 `webServer` 的 prefix 注册，绕过宿主鉴权）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/dsh-pi/state` | 解析结果 + 会话列表 |
| GET | `/api/dsh-pi/health` | `{ ok: true, version }` |
| POST | `/api/dsh-pi/sessions` | 新建会话（body 可带 `cwd`/`label`/`args`） |
| DELETE | `/api/dsh-pi/sessions/:id` | 关闭会话 |
| GET | `/api/dsh-pi/sessions/:id/snapshot?since=N` | 增量快照 |
| GET | `/api/dsh-pi/sessions/:id/events?since=N` | SSE 事件流（15s 心跳） |
| POST | `/api/dsh-pi/sessions/:id/command` | 转发一条 pi RPC 命令 |

`/command` 要求 `content-type: application/json`，body 是带字符串 `type` 的对象，
原样转给 pi 的 RPC 通道再把结果回传。常用 `type`：`prompt`、`abort`、`get_state`、
`get_available_thinking_levels`、`set_thinking_level`。

上限：会话 8 个（`MAX_SESSIONS`），请求体 4 MiB（`MAX_BODY_BYTES`）。

## 面板行为

- 打开时先 `GET /state`，有会话就复用第一个，没有就 `POST /sessions` 新建。
- 发送：`prompt`；模型还在跑时再发会带 `streamingBehavior: "followUp"` 排队。
- `Enter` 发送、`Shift+Enter` 换行、`Esc` 打断。
- 思考等级下拉来自 `get_available_thinking_levels`，切换走 `set_thinking_level`。
- 「新会话」= 关掉当前会话再建一个，不污染旧上下文。

## 客户端契约（改 client.js 前必读）

- `sidebar.panellist` 条目的 `id` 必须与 `main` keyed slot 的 `key` 相同，否则点不开。
- 所有 `slots.inject` 必须包在 `ctx.inject([...])` 里；漏包会让 entry 永久 pending，
  表现为 DSH 启动卡住。
- 客户端 `require` 白名单只有 `react`、`react-dom`、`jsx-runtime`、
  `@deepseek-ai/dsh-client-ui-primitives`。
- 主题只用 `--dsw-*` CSS 变量，不要写死颜色，否则浅色/深色切换会花。
- 文件头注释记录的是踩过的坑，改代码别删。

## 已验证

- host 半区自测 `test/host-smoke.mjs`：health / state / 建会话 / prompt / 收流 / 关会话全绿，
  真实 LLM 往返（`Deepseek-V4.1-Flash`，contextWindow 1000000）。
- 真机 DSH：侧栏「pi」入口渲染正常，面板内发指令触发 bash 工具并把输出
  （`dsh-pi-panel-ok`）回显在气泡里。

## 目录

```
index.js          host 半区：路由 + 会话池 + 子进程管理
client.js         浏览器半区：侧栏入口 + 整页聊天面板
src/pi-rpc.mjs    pi 子进程的 JSONL RPC 封装
cordis.patch.yml  bundle 补丁（把本包插进宿主组合）
test/             自测脚本
tools/            开发期用的 PowerShell 辅助（截图/点击/注入按键），非插件运行依赖
out/              验证截图
research/         pi 事件与 DSH 插槽的逆向笔记
```

MIT

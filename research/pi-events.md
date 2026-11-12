# pi RPC 事件流与消息类型：渲染规格

> 目标读者：基于 `pi --mode rpc` 实现聊天界面的客户端工程师（DSH 客户端 / pi-gui / 任意宿主）。
> 本文只写**线上真实存在**的记录。字段名、取值、顺序均取自 pi 1.5.2 源码或 `docs/` 原文，并注 `文件:行号`。凡未经实测的结论单独标注【未实测】。

## 0. 版本与验证方式

- 被测版本：`node C:\Users\PC\Documents\pi-local\pi-main\packages\coding-agent\dist\bundle\cli.js --version` → `1.5.2`。
- 源码根：`C:\Users\PC\Documents\pi-local\pi-main\packages`（下文路径相对该目录，如 `coding-agent/src/modes/rpc/rpc-types.ts`）。
- 文档根：`packages/coding-agent/docs`（**不在仓库根 docs/**）。
- 实测：`node` 直连 `pi --mode rpc --no-session --provider odys-deepseek --model Deepseek-V4.1-Flash`，用 `StringDecoder` 按 `\n` 切行，记录每条 stdout 原始 JSON 与到达时刻。三轮真实探针：
  - **探针 A**：一次完整工具往返（thinking + bash 工具调用 + 文本回答），123 条记录；
  - **探针 B**：`streamingBehavior:"steer"` + 直接 `bash` 命令 + `clear_queue`，261 条记录；
  - **探针 C**：流式中途 `abort`，641 条记录。
- 静态核对：`coding-agent/docs/` 下 `json.md`、`rpc.md`、`rpc-commands.md`、`rpc-extension-ui.md`、`message-types.md`、`session-format.md` 六份全文，以及 `coding-agent/src/modes/rpc/rpc-types.ts`、`coding-agent/src/modes/rpc/rpc-mode.ts`、`coding-agent/src/modes/json-event.ts`、`coding-agent/src/core/agent-session.ts`、`coding-agent/src/core/agent-session-runtime.ts`、`agent/src/agent-loop.ts`、`ai/src/types.ts`、`agent/src/types.ts` 逐行。

---

## 1. 传输层：帧、记录族、id 关联

### 1.1 帧格式

| 规则 | 内容 | 出处 |
|---|---|---|
| 编码 | 严格 JSONL：一行一个 JSON 对象，以 LF(`\n`) 结尾 | `coding-agent/docs/json.md:15` |
| 切分 | **只按 LF 切**，剥掉可选的前导 `CR`；`U+2028`/`U+2029` 是合法 JSON 字符串内容，**不是**分隔符 | `coding-agent/docs/json.md:15` |
| 禁用 readline | Node `readline` 会把这两个字符当换行，禁止使用；用 StringDecoder/字节流按 LF 切 | `coding-agent/docs/json.md:17`；实现 `coding-agent/src/modes/rpc/jsonl.ts:21-58` |
| 持续读取 | 必须一直消费 stdout；停止消费会让管道缓冲填满并卡住 Pi | `coding-agent/docs/json.md:19` |
| 通道分工 | stdout **只**放 JSONL 协议；诊断/日志走 stderr，客户端不要解析 stderr | `coding-agent/docs/json.md:19`；`coding-agent/docs/rpc.md:89` |
| 背压 | 双向都要遵守；Pi 输出时会 `await waitForRawStdoutBackpressure()` | `coding-agent/src/modes/rpc/rpc-mode.ts:60-62,368-370` |
| 无 session header | JSON 模式首帧是 `{"type":"session",...}`，**RPC 不发**；用 `get_state` 取 `sessionId`/`sessionFile` | `coding-agent/docs/json.md:29` |

### 1.2 四类记录

| 记录族 | 方向 | 判别字段 | 说明 | 出处 |
|---|---|---|---|---|
| Command | 客户端 → Pi（stdin） | `type` ∈ 33 种命令，或 `extension_ui_response` | 可带 `id` | `coding-agent/src/modes/rpc/rpc-types.ts:20-74` |
| Response | Pi → 客户端 | `type:"response"` | 每个命令一条，`command` 回显命令名，成功带 `data`／失败带 `error` | `coding-agent/src/modes/rpc/rpc-types.ts:116-245` |
| Session event | Pi → 客户端 | `type` ∈ 23 种 | 被动推送，**不带命令 id**（唯一例外见 1.3） | `coding-agent/src/core/agent-session.ts:219-261` |
| Extension UI | 双向 | `extension_ui_request` / `extension_ui_response` | 独立子协议，**不是** `AgentSessionEvent` | `coding-agent/docs/json.md:196`；`coding-agent/docs/rpc-extension-ui.md:3` |

### 1.3 id 关联规则（最易写错处）

- 命令带 `id` 时，`response.id` 回显同值；**命令处理是异步的**，不能用「第 N 条 response 对应第 N 个命令」，必须按 id 匹配（`coding-agent/docs/rpc.md:37-48`；`coding-agent/docs/rpc.md:44` 原文 Commands are processed asynchronously）。
- `id` 是可选字段：请求不带 `id`，response 也不带（`coding-agent/src/modes/rpc/rpc-types.ts:116-245` 中 `id?: string`）。
- **事件默认不带任何命令 id**。唯一例外：直接 `bash` 命令产生的 `bash_execution_update` 把自己的 `id` 填成命令 id（`coding-agent/docs/rpc.md:46`；`coding-agent/docs/json.md:184-188`；发射点 `coding-agent/src/core/agent-session.ts:4167`）。探针 B 实测：命令 `{"id":"b1","type":"bash",...}` → 事件 `{"type":"bash_execution_update","id":"b1","delta":"one\n"}`。
- `extension_ui_response` 用**请求的 id**，且**不会**产生一条普通 `response`（`coding-agent/docs/rpc.md:48`）。id 匹配不上时 Pi **静默丢弃**，不报错（`coding-agent/src/modes/rpc/rpc-mode.ts:785-798`）。
- stdin 行解析失败 → `{"type":"response","command":"parse","success":false,"error":"Failed to parse command: ..."}`，**无 id**（`coding-agent/src/modes/rpc/rpc-mode.ts:768-782`；`coding-agent/docs/rpc.md:81-85`）。探针实测原文：`Failed to parse command: Expected property name or '}' in JSON at position 1 (line 1 column 2)`。

### 1.4 首帧陷阱（实测）

`pi --mode rpc` 启动后**第一条记录常常不是 response**，而是内置 `prompt-url` 扩展发的 UI 请求：

```json
{"type":"extension_ui_request","id":"<uuid>","method":"setWidget","widgetKey":"prompt-url"}
```

（`widgetLines` 缺省 = 清除该 widget，见 §4。）解析循环必须按 `type` 分发，不能假设首帧是 `response`。

---

## 2. 事件清单：触发时机 / 线上字段 / UI 消费

### 2.1 数量总览

| 分类 | 数量 | 说明 |
|---|---|---|
| Session event（Pi → 客户端） | **23** | §2.2 |
| 其它 stdout 记录 | **3** | `response`、`extension_ui_request`、`extension_error` |
| stdout 顶层记录类型合计 | **26** | — |
| 仅在 stdin 出现的客户端记录 | **1** | `extension_ui_response` |
| 顶层 `type` 合计 | **27** | 含客户端侧 |
| `message_update.assistantMessageEvent` 子类型 | **12** | §2.3 |
| `RpcCommand.type` | **33** | `coding-agent/src/modes/rpc/rpc-types.ts:20-74` |
| `extension_ui_request.method` | **9** | §4 |

### 2.2 23 种 session event

「线上字段」= 除 `type` 外的字段。可选 `parentToolCallId?: string` 只可能出现在三个 `tool_execution_*` 上（工具内部再调工具时才有，`coding-agent/src/core/agent-session.ts:212-217`）。

| 事件 | 触发时机 | 线上字段 | UI 如何消费 | 出处 |
|---|---|---|---|---|
| `agent_start` | 一次底层 agent run 开始（每个 prompt、每次自动重试、每次 overflow 恢复各一次） | 无 | 置 `running=true`；**不要清空消息列表**（重试会追加） | `agent/src/types.ts:530`；发射 `agent/src/agent-loop.ts:126-130,155-156` |
| `agent_end` | 底层 run 结束 | `messages: AgentMessage[]`、`willRetry: boolean`（探针实测键集就是这三个，**无 `lastStop`**） | 只表示「本步结束」，**不是**结束态；`willRetry` 为 true 时后面还会自动继续 | `agent/src/types.ts:531`；`coding-agent/src/core/agent-session.ts:222-226`；`coding-agent/docs/json.md:48` |
| `turn_start` | 一个 assistant turn 开始（一次 LLM 响应 + 其工具调用） | 无 | 收尾上一个 turn 的占位、开新占位 | `agent/src/types.ts:533`；`coding-agent/docs/json.md:60` |
| `turn_end` | turn 结束 | `message: AgentMessage`、`toolResults: ToolResultMessage[]` | 用 `message` 覆盖该 turn 的流式占位；`toolResults` 是工具结果权威值 | `agent/src/types.ts:534` |
| `message_start` | 任一消息开始（system/user/assistant/toolResult 都发） | `message: AgentMessage` | assistant：建流式占位（`content:[]`、`stopReason:"pending"`）；system：**直接丢弃**；user/toolResult：通常紧接 `message_end` | `agent/src/types.ts:536`；`coding-agent/docs/json.md:66`；`ai/src/types.ts:815-830` |
| `message_update` | **仅** assistant 流式期间，按 content block 发增量 | `usage: Usage`、`assistantMessageEvent`（见 §2.3） | **真流式唯一来源**；`usage` 可能一直为 0，不可作为计费依据 | `agent/src/types.ts:538`；线上裁剪 `coding-agent/src/modes/json-event.ts:48-60`；`coding-agent/docs/json.md:67-95` |
| `message_end` | 消息完成，`message` 是权威终值 | `message: AgentMessage` | **整体替换**重建值；这是唯一可信的最终内容 | `agent/src/types.ts:539`；`coding-agent/docs/json.md:68,93` |
| `tool_execution_start` | 工具开始执行 | `toolCallId`、`toolName`、`args` | 建工具卡片（running）；用 `toolCallId` 关联 assistant 消息里的 `ToolCall.id` | `agent/src/types.ts:541`；发射 `agent/src/agent-loop.ts:495,553,608` |
| `tool_execution_update` | 工具上报增量结果 | 同上 + `partialResult` | 卡片正文更新；`partialResult` 语义由工具自己定（`coding-agent/docs/json.md:109`） | `agent/src/types.ts:542`；`agent/src/agent-loop.ts:792` |
| `tool_execution_end` | 工具结束 | `toolCallId`、`toolName`、`result`、`isError`、`durationMs?`（**无 `args`**） | 卡片定态：`isError` → 错误样式，`durationMs` → 耗时；`durationMs` 在工具未真正运行（如参数截断）时缺省 | `agent/src/types.ts:543-551`；`agent/src/agent-loop.ts:931` |
| `agent_settled` | 会话级 run 真正安静：无重试、无压缩恢复、无队列自动工作 | `aborted: boolean` | **唯一的结束/空闲信号**，用于解锁输入框、清除「思考中」 | `coding-agent/src/core/agent-session.ts:227,1256-1278`；`coding-agent/docs/json.md:48,56` |
| `queue_update` | 队列变化（入队/出队/clear_queue） | `steering: string[]`、`followUp: string[]`（**全量**当前队列） | 直接替换渲染；两数组同时为空 = 队列清空 | `coding-agent/src/core/agent-session.ts:228-232,1223-1229` |
| `compaction_start` | 压缩开始 | `reason: "manual"` 或 `"threshold"` 或 `"overflow"` | 显示压缩横幅 | `coding-agent/src/core/agent-session.ts:233,3068,3416`；`coding-agent/docs/json.md:130-136` |
| `compaction_end` | 压缩结束 | `reason`、`result?: CompactionResult`、`aborted`、`willRetry`、`errorMessage?` | 成功 → 插入 summary 分割卡片（`result.summary`）；`aborted:true` → 提示已取消；`errorMessage` → 错误条 | `coding-agent/src/core/agent-session.ts:237-244,3502,3512-3525`；`coding-agent/docs/json.md:140-157` |
| `entry_appended` | 扩展通过 `pi.appendEntry()` 追加 session entry（缓存回填也走它） | `entry: SessionEntry` | 按 `entry.type` 分流；**未知 type 必须安全忽略**（探针实测出现过 `type:"context_edit"`） | `coding-agent/src/core/agent-session.ts:234,544,914,1205,1451,3707` |
| `session_info_changed` | 会话显示名变化 | `name: string` 或 `undefined`（undefined = 已清除） | 更新标题栏 | `coding-agent/src/core/agent-session.ts:235,4255-4256`；`coding-agent/docs/json.md:123` |
| `thinking_level_changed` | thinking 等级变化（`set_thinking_level`／`cycle_thinking_level` 等） | `level: ThinkingLevel`（7 值：`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`） | 更新下拉；**先于命令 response 到达**（探针实测） | `coding-agent/src/core/agent-session.ts:236,2929`；`agent/src/types.ts:349` |
| `auto_retry_start` | 助手回合自动重试开始 | `attempt`、`maxAttempts`、`delayMs`、`errorMessage` | 显示「第 n/m 次重试，N 秒后」 | `coding-agent/src/core/agent-session.ts:245,4083-4089`；`coding-agent/docs/json.md:166` |
| `auto_retry_end` | 自动重试结束 | `success`、`attempt`、`finalError?` | `success:false` → 终态错误（`finalError`）；成功 → 清除重试提示 | `coding-agent/src/core/agent-session.ts:246,4055-4061`；`coding-agent/docs/json.md:167-170` |
| `summarization_retry_scheduled` | 摘要类操作（压缩/分支摘要）排定重试 | `attempt`、`maxAttempts`、`delayMs`、`errorMessage` | 同 auto_retry 的展示逻辑 | `coding-agent/src/core/agent-session.ts:247-253,4031-4039`；`coding-agent/docs/json.md:175` |
| `summarization_retry_attempt_start` | 摘要重试真正发起 | `source:"branchSummary"`；或 `source:"compaction"` + `reason` | 更新阶段文案（压缩重试 vs 分支摘要重试） | `coding-agent/src/core/agent-session.ts:254-259,4040-4045`；`coding-agent/docs/json.md:176` |
| `summarization_retry_finished` | 摘要重试结束 | 无 | 清除重试提示 | `coding-agent/src/core/agent-session.ts:260,4046` |
| `bash_execution_update` | 直接 `bash` 命令的流式输出（RPC 专有） | `id?: string`（回显命令 id）、`delta: string` | 追加到该命令的输出块；**不等于**工具卡片事件 | `coding-agent/src/core/agent-session.ts:261,4165-4168`；`coding-agent/docs/json.md:184-188` |

非事件 stdout 记录：

| 记录 | 触发时机 | 线上字段 | UI 如何消费 | 出处 |
|---|---|---|---|---|
| `response` | 每个命令的最终结果。**`prompt` 的响应在「被接受」时就发，不是跑完才发** | `id?`、`command`、`success`、`data?` / `error?` | 按 `id` 匹配 pending 请求；`success:true` 只代表接受，不代表执行成功 | `coding-agent/src/modes/rpc/rpc-types.ts:116-245`；`coding-agent/src/modes/rpc/rpc-mode.ts:64-77`；`coding-agent/docs/rpc.md:60-71` |
| `extension_ui_request` | 扩展调用 `ctx.ui.*` | `id`、`method`、方法字段 | 见 §4 | `coding-agent/src/modes/rpc/rpc-types.ts:252-287` |
| `extension_error` | 扩展 handler 抛异常 | `extensionPath`、`event`、`error` | 错误条；**它不是 response**，不要按 id 匹配 | `coding-agent/src/modes/rpc/rpc-mode.ts:355-357`；`coding-agent/docs/json.md:190-194` |

### 2.3 `message_update` 内嵌子事件（12 种）

`message_update` 是唯一携带流式 token 的记录。线上被裁成 **delta-only**：剥掉 SDK 事件里的累计 `message` 字段和每个子事件的 `partial`（`coding-agent/docs/json.md:72`；实现 `coding-agent/src/modes/json-event.ts:20-38`，且 `coding-agent/src/modes/json-event.ts:48-60` 只改形 `message_update`，其余事件原样）。

| 子事件 `type` | 线上字段（除 `type` 外） | 出处 | UI 处理 |
|---|---|---|---|
| `start` | 无 | `coding-agent/docs/json.md:78`；`ai/src/types.ts:832` | 正常 run 不会出现（agent loop 翻成 `message_start`，`coding-agent/docs/json.md:91`） |
| `text_start` | `contentIndex` | `coding-agent/docs/json.md:79`；`ai/src/types.ts:833` | 建正文块，初值为空串（`ai/src/types.ts:825-826`） |
| `text_delta` | `contentIndex`、`delta` | `coding-agent/docs/json.md:80`；`ai/src/types.ts:834` | 追加到该块；多 delta 拼同一条 |
| `text_end` | `contentIndex`、`content` | `coding-agent/docs/json.md:81`；`ai/src/types.ts:835` | 用 `content` **覆盖**重建值（权威） |
| `thinking_start` | `contentIndex` | `coding-agent/docs/json.md:82`；`ai/src/types.ts:836` | 建思考块；redacted thinking 可能 start 即完整、无 delta（`ai/src/types.ts:827-828`） |
| `thinking_delta` | `contentIndex`、`delta` | `coding-agent/docs/json.md:83`；`ai/src/types.ts:837` | 追加到思考块，**与正文分离** |
| `thinking_end` | `contentIndex`、`content` | `coding-agent/docs/json.md:84`；`ai/src/types.ts:838` | 覆盖思考块 |
| `toolcall_start` | `contentIndex`、`id`、`toolName` | `coding-agent/docs/json.md:85`；`coding-agent/src/modes/json-event.ts:6-8,24-30` | 建工具卡（参数未知）；`id` 用于关联 `toolCall` 块与 `tool_execution_*` |
| `toolcall_delta` | `contentIndex`、`delta` | `coding-agent/docs/json.md:86`；`ai/src/types.ts:840` | `delta` 是参数 JSON 的**原始字符串片段**，只能拼接 |
| `toolcall_end` | `contentIndex`、`toolCall` | `coding-agent/docs/json.md:87`；`ai/src/types.ts:841` | 用完整 `toolCall.arguments` 定型 |
| `done` | `reason`、`message` | `coding-agent/docs/json.md:88`；`ai/src/types.ts:842-846` | 正常 run 不会出现（翻成 `message_end`） |
| `error` | `reason`、`error`（均为 `AssistantMessage`） | `coding-agent/docs/json.md:89`；`ai/src/types.ts:847` | 正常 run 不会出现；`reason` 取 `aborted` 或 `error` |

五条硬约定：

1. **`contentIndex` 是 content block 下标，不是到达序号。** 探针 A 实测：同一条 assistant 消息内 `thinking` 用 `contentIndex:0`、`toolCall` 用 `contentIndex:1`；第二条 assistant 消息的 `text` 用 `contentIndex:0`。必须按 `contentIndex` 建块、按 index 排序渲染（`coding-agent/docs/json.md:93`）。
2. **`toolcall_start` 的 `id`/`toolName` 是 RPC/JSON 层补的**：`AssistantMessageEvent` 联合里没有这两个字段（`ai/src/types.ts:839`），由 `ToJsonAssistantMessageEvent` 从 `event.partial.content[event.contentIndex]` 取出补上；取到的不是 toolCall 时抛 `toolcall_start content at index ${contentIndex} is not a tool call`（`coding-agent/src/modes/json-event.ts:24-30`）。
3. **`toolcall_delta` 不能边收边解析**（`coding-agent/docs/json.md:86`：Append serialized argument data）。探针 A 实测首条 delta 为空串，随后依次是 `{"`、`command`、`"`、`": "`、`echo` 等碎片；只有 `toolcall_end.toolCall.arguments` 是完整对象。
4. **三级覆盖**：delta 累积供实时显示 → `*_end` 的 `content`/`toolCall` 覆盖 → `message_end.message` 整体替换（`coding-agent/docs/json.md:93`）。
5. **顶层 `usage` 是累计值且可能一直为 0**，provider 不流式上报时不能当计费依据（`coding-agent/docs/json.md:95`）。实测键集 `input`/`output`/`cacheRead`/`cacheWrite`/`totalTokens`/`cost`；完成消息里才多出 `reasoning` 与 `cost.totalFromProvider`。

### 2.4 一次完整工具往返的真实时序（探针 A，ms 为相对进程启动）

| t(ms) | 记录 |
|---|---|
| 363 | `extension_ui_request` `setWidget`（内置 `prompt-url` 扩展，见 §1.4） |
| 376 | `response` `get_state` |
| 4053 | `response` `prompt` `{disposition:"started"}`，同 tick 后接 `agent_start`、`turn_start` |
| 4058-4059 | `message_start`/`message_end` `[system]`，然后 `message_start`/`message_end` `[user]` |
| 7734 | `message_start` `[assistant]`：`content:[]`、`stopReason:"pending"` |
| 7861-8168 | `thinking_start`(ci=0) → `thinking_delta` ×N |
| 8169 | `toolcall_start`(ci=1, `id`, `toolName:"bash"`) |
| 8169-8185 | `toolcall_delta` ×N（参数 JSON 碎片） |
| 8185 | `thinking_end`(ci=0, 完整 thinking) —— **晚于 `toolcall_start` 到达** |
| 8186 | `toolcall_end`(ci=1, 完整 `toolCall`) → `message_end` `[assistant]`(`stopReason:"toolUse"`, content=`[thinking, toolCall]`) |
| 8187 | `tool_execution_start` `{toolCallId:"call_00_...", toolName:"bash", args:{command}}` |
| 8192, 8278 | `tool_execution_update` ×2，`partialResult`：`{content:[]}` → `{content:[{type:"text",text:"probe-ok\n"}],details:{}}` |
| 8287 | `tool_execution_end` `{toolCallId, toolName, result, isError:false, durationMs:55}`（**无 `args`**） |
| 8288 | `message_start`/`message_end` `[toolResult]` → `turn_end`（`toolResults` 1 条） |
| 8333 | `turn_start` → `message_start`/`message_end` `[system]`（仅 `sections` 增量） |
| 10382-10824 | `message_start` `[assistant]` → `text_start`(ci=0) → `text_delta` ×N → `text_end` → `message_end`(`stopReason:"stop"`) → `turn_end`(`toolResults:[]`) |
| 10829 | `extension_ui_request` `notify`（内置扩展上报 TPS/用量，**非协议必需**） |
| 10830-10831 | `agent_end` `{messages:6, willRetry:false}` → `agent_settled` `{aborted:false}` |

探针 A 共 123 条记录，逐类型计数（合计 123）：`message_update` 94、`message_start` 6、`message_end` 6、`response` 4、`turn_start` 2、`turn_end` 2、`extension_ui_request` 2、`tool_execution_update` 2，各 1 条的是 `agent_start`、`agent_end`、`agent_settled`、`tool_execution_start`、`tool_execution_end`。四个硬结论：

1. **每轮 assistant 前都有一条 `[system]` 消息**：首条 `sections` 含 preamble/instructions/tools/safety，第二轮只有 `sections.memory` 增量，`content` 均为 `""`，单条序列化约 35-40KB。UI 必须默认丢弃 `role:"system"`（`coding-agent/docs/message-types.md:107` 说明 system 消息按序回放得当前 prompt/tools，属运行时状态而非对话内容）。
2. **块序与到达序无关**：`thinking_end` 可以晚于 `toolcall_start`，只能用 `contentIndex` 定位。
3. **工具卡片有两个数据源**：assistant 消息里的 `toolCall` 块给出「要调什么」（`toolcall_*`），`tool_execution_*` 给出「执行得怎样」，用 `toolCallId` 关联（`coding-agent/docs/json.md:109`）。
4. **`agent_end` 不是结束态**：它只标志一次底层 run 结束，`agent_settled` 才表示不会再有重试/压缩恢复/排队工作（`coding-agent/docs/json.md:48,56`）。

### 2.5 steer / bash / abort / 重试四个子流（实测）

**steer（探针 B）**：流式中发 `prompt{streamingBehavior:"steer"}`，实测序列：

```text
queue_update {steering:["补充：最后加一句 steered。"], followUp:[]}   // 入队，全量
response {command:"prompt", data:{disposition:"queued"}}
... 当前 assistant 回合继续；message_end 之后才 turn_end
turn_start → message_start/end[system 增量]
queue_update {steering:[], followUp:[]}                            // 出队
message_start[user] → message_start[assistant]
```

即 steer 文本**以一条新的 user 消息进入下一轮**，不会插入当前流。出队时机提前到 `message_start[user]` 那一刻：实现里用户消息开始时先查队列、移除并立即 `_emitQueueUpdate()`，注释写明「This ensures the UI sees the updated queue state」（`coding-agent/src/core/agent-session.ts:1298-1315`）。投递语义见 `coding-agent/docs/rpc-commands.md:26`（当前 assistant turn 执行完工具调用、下一次 LLM 调用前）。

**bash（探针 B）**：`{"id":"b1","type":"bash","command":"..."}` → 两条 `bash_execution_update`（`{id:"b1",delta:"one\n"}`、`{delta:"two\n"}`）→ `response {command:"bash", data:{output:"one\ntwo\n", exitCode:0, cancelled:false, truncated:false}}`。产生的 `BashExecutionMessage` 进入历史（`get_messages` 首条即 `role:"bashExecution"`），除非 `excludeFromContext` 否则下次请求转成 user 文本（`coding-agent/docs/message-types.md:202-218`；转换文案 `coding-agent/src/core/messages.ts:82-98`）。

**abort（探针 C）**：

```text
message_start[assistant]{stopReason:"pending"} ...
message_end[assistant]{stopReason:"aborted"}   // content 保留已生成的 thinking + 部分 text
turn_end → agent_end{messages:11, willRetry:false} → agent_settled{aborted:true}
response {command:"abort", success:true}       // 最后才回
```

`abort` 的响应在 `agent_settled` **之后**才发出，因为 `session.abort()` 内部 `await this.waitForIdle()`（`coding-agent/src/core/agent-session.ts:2743-2753`；`coding-agent/src/modes/rpc/rpc-mode.ts:447-450`）。UI 不能用 abort 响应判断已停止，必须等 `agent_settled`。实测被截断的 assistant 消息 `errorMessage` 未设置，`content` 里保留约 678 字符部分文本。

**自动重试（探针 B，网络 Connect Timeout）**：

```text
message_start[assistant]{stopReason:"error", content:[], errorMessage:"Request timed out.: ...", durationMs:10525}
message_end[同一条] → turn_end → agent_end
auto_retry_start {attempt:1, maxAttempts:3, delayMs:2000, errorMessage:"..."}
entry_appended {entry:{type:"context_edit", ...}}
agent_start → turn_start → ... 完整一轮 ... → turn_end → agent_end
auto_retry_end {success:true, attempt:1}
agent_settled {aborted:false}
```

要点：**一次用户 prompt 可以产生多对 `agent_start`/`agent_end`**；重试期间 `agent_end` 已发、`agent_settled` 未到，UI 不能提前解锁。`maxAttempts` 来自 `settings.maxRetries`（`coding-agent/src/core/agent-session.ts:4067-4089`）。`entry_appended.entry` 是 session entry，实测出现过 `type:"context_edit"`（`coding-agent/docs/session-format.md:139-147`），UI 必须按 `type` 分流、忽略未知类型。


---

## 3. AgentMessage 与 ContentBlock 的完整形状

### 3.1 内容块（ContentBlock）：4 种

渲染层只需要认这四种块。`type` 是判别字段。

| 块 | 形状 | 出处 | 渲染要点 |
|---|---|---|---|
| 文本 | `{ type:"text", text:string, textSignature?:string }` | `ai/src/types.ts:430-434`；`coding-agent/docs/message-types.md:17-23` | `textSignature` 对客户端不透明（legacy id 或 `TextSignatureV1` JSON），只透传 |
| 思考 | `{ type:"thinking", thinking:string, thinkingSignature?:string, redacted?:boolean }` | `ai/src/types.ts:436-444`；`coding-agent/docs/message-types.md:41-48` | **与正文分开渲染**（折叠区）。`redacted:true` 时可能只有 `thinkingSignature` 里的加密载荷、没有明文（`ai/src/types.ts:440-443`），此时不要渲染空气泡，直接隐藏或标「已隐藏」 |
| 图片 | `{ type:"image", data:string(base64), mimeType:string }` | `ai/src/types.ts:446-450`；`coding-agent/docs/message-types.md:29-35` | 直接 `data:${mimeType};base64,${data}` |
| 工具调用 | `{ type:"toolCall", id:string, name:string, arguments:JsonObject, thoughtSignature?:string, namespace?:string, argumentsError?:string }` | `ai/src/types.ts:452-465`；`coding-agent/docs/message-types.md:54-63` | `id` 是**关联键**；`argumentsError` 非空表示模型给的参数不是合法 JSON 对象、此时 `arguments` 为 `{}`（`ai/src/types.ts:460-464`），必须显示错误而不是空参数 |

`TextSignatureV1` 形状：`{ v:1, id:string, phase?:"commentary"|"final_answer" }`（`ai/src/types.ts:424-428`）。

### 3.2 八种 AgentMessage

`AgentMessage` 是八角色的可辨识联合（`coding-agent/docs/message-types.md:267-277`）。低层 agent 包的真实定义是 `Message | CustomAgentMessages[keyof CustomAgentMessages]`（`agent/src/types.ts:374`），其中 `CustomAgentMessages` 默认为空对象（`agent/src/types.ts:365-367`），coding-agent 通过 declaration merging 往里加了四类（`coding-agent/src/core/messages.ts:70-77`）。**因此宿主必须对未知 `role` 做安全忽略，不能断言**（`coding-agent/docs/message-types.md:279`）。

#### (1) `system`

```text
{ role:"system", content: string | TextContent[], sections?: Record<string,string|null>,
  toolsAdded?: Tool[], toolsRemoved?: ToolReference[], timestamp: number(ms) }
```

出处 `ai/src/types.ts:569-585`；`coding-agent/docs/message-types.md:96-105`。`sections` 是命名有序的 prompt 段落：首条声明全部，后续消息按名替换、`null` 删除（`ai/src/types.ts:573-579`）。**全部 system 消息按序回放才得到当前 prompt 与工具集**（`coding-agent/docs/message-types.md:107`）。UI 一律不渲染（探针 A：每轮 assistant 前都有一条，单条约 35-40KB，首条含 preamble/instructions/tools/safety，第二轮只有 `sections.memory` 增量）。

#### (2) `user`

```text
{ role:"user", content: string | (TextContent|ImageContent)[], timestamp: number(ms) }
```

出处 `ai/src/types.ts:587-591`。注意 `content` 可能是**裸字符串**，渲染前统一归一化成块数组。

#### (3) `assistant`

```text
{ role:"assistant", content:(TextContent|ThinkingContent|ToolCall)[],
  api, provider, model, responseModel?, responseId?, providerThinkingLevel?, thinkingLevel?,
  diagnostics?, usage:Usage, stopReason:StopReason, deferred?:DeferredHandle,
  errorMessage?, rawStopReason?, endTurn?, timestamp:number(ms), durationMs? }
```

出处 `ai/src/types.ts:593-624`；`coding-agent/docs/message-types.md:121-141`。要点：

- `stopReason`（`ai/src/types.ts:497`）：`pending` 流式中 / `stop` 正常 / `length` 撞输出上限 / `toolUse` 要调工具 / `error` / `aborted` 被中止 / `deferred` 延迟结果。`pending` 只存在于流式过程，**Pi 不持久化 pending assistant 消息**（`coding-agent/docs/message-types.md:145`）。
- `errorMessage` 非空 → 错误气泡（探针 B 实测 `Request timed out.: Connect Timeout Error (attempted address: api.odys.work:443, timeout: 10000ms) (UND_ERR_CONNECT_TIMEOUT)`）。
- 探针实测键集：`message_start[assistant]` 为 `role,content,api,provider,model,usage,stopReason,timestamp`；`message_end[assistant]` 追加 `responseId,responseModel,rawStopReason,durationMs,thinkingLevel`。**不要假设两个阶段字段相同**。
- `content` 里可能只有 `thinking` 没有 `text`（工具调用前的推理），也可能 `text` 与 `toolCall` 混排——按数组顺序渲染，`thinking` 抽到折叠区。

#### (4) `toolResult`

```text
{ role:"toolResult", toolCallId:string, toolName:string,
  content:(TextContent|ImageContent)[], details?:JsonValue, usage?:Usage,
  nestedCalls?:NestedToolCalls, isError:boolean, timestamp:number(ms), durationMs? }
```

出处 `ai/src/types.ts:648-665`；`coding-agent/docs/message-types.md:163-175`。要点：

- **`content` 只能含 text / image**，不会有 thinking 或 toolCall（`ai/src/types.ts:653`）。
- `toolCallId` 把结果绑回 assistant 里的 `toolCall.id`（`coding-agent/docs/json.md:109`）。
- `details` 是工具自定义结构，语义由工具决定，UI 不要硬编码解析；`usage` 只统计该工具内部再调模型的用量、不计入主上下文（`ai/src/types.ts:655-656`）。
- `nestedCalls`：`{ calls: NestedToolCallRecord[], complete: boolean }`，每条 `{ id, name, arguments?, argumentsBytes?, status:"ok"|"error"|"unfinished", durationMs?, error? }`（`ai/src/types.ts:626-646`；`coding-agent/docs/message-types.md:179-194`）。仅用于调试展示，**不发给模型**（`ai/src/types.ts:657`）。
- 探针 A 实测 `message_start/end[toolResult]` 键集为 `role,toolCallId,toolName,content,isError,durationMs,timestamp`（该工具没有 `details`/`usage`/`nestedCalls`）。

#### (5) `bashExecution`（coding-agent 扩展）

```text
{ role:"bashExecution", command:string, output:string, exitCode:number|undefined,
  cancelled:boolean, truncated:boolean, fullOutputPath?:string,
  timestamp:number(ms), excludeFromContext?:boolean }
```

出处 `coding-agent/src/core/messages.ts:29-40`；`coding-agent/docs/message-types.md:200-216`。语义：RPC 的 `bash` 命令与交互式 `!` 命令产生，**不是 LLM 的工具结果**（`coding-agent/docs/message-types.md:202`）。`exitCode` 为 `undefined` 表示被取消/杀掉。渲染建议：终端风格卡片，`cancelled` 打「已取消」、`truncated && fullOutputPath` 给「完整输出」链接（转换文案见 `coding-agent/src/core/messages.ts:82-98`：`Ran \`cmd\`` + 三反引号 output，无输出写 `(no output)`，被取消追加 `(command cancelled)`，非 0 退出追加 `Command exited with code N`，截断追加 `[Output truncated. Full output: <path>]`）。除非 `excludeFromContext`，否则下次请求时它会被转成 user 文本（`coding-agent/docs/message-types.md:218`；`coding-agent/src/core/messages.ts:148-196`）。

#### (6) `custom`（扩展注入）

```text
{ role:"custom", customType:string, content:string|(TextContent|ImageContent)[],
  display:boolean, details?:unknown, timestamp:number(ms) }
```

出处 `coding-agent/src/core/messages.ts:46-53`；`coding-agent/docs/message-types.md:224-233`。`display:false` → 不渲染（隐藏消息）；`display:true` → 渲染 `content`；`details` 不发给模型（`coding-agent/docs/message-types.md:235`）。`customType` 供宿主按类型做专用渲染。

#### (7) `branchSummary` / (8) `compactionSummary`

```text
{ role:"branchSummary", summary:string, fromId:string|null, timestamp:number(ms) }
{ role:"compactionSummary", summary:string, tokensBefore:number, timestamp:number(ms) }
```

出处 `coding-agent/src/core/messages.ts:55-67`；`coding-agent/docs/message-types.md:239-259`。两者都是「历史被折叠」的分隔卡片：`branchSummary` 表示从某个 entry 分叉（`fromId` 为 `null` 表示根），`compactionSummary` 表示上下文压缩、`tokensBefore` 是压缩前 token 数。转换进上下文的文案带固定前缀（`coding-agent/src/core/messages.ts:11-24`），渲染时独立成卡、不参与聊天气泡流。

### 3.3 Usage

```text
{ input, output, cacheRead, cacheWrite, cacheWrite1h?, reasoning?, totalTokens,
  cost:{ input, output, cacheRead, cacheWrite, total, totalFromProvider? } }
```

出处 `ai/src/types.ts:467-495`；`coding-agent/docs/message-types.md:67-88`。两个易错点：`reasoning` 已经包含在 `output` 里，**不要再相加**（`coding-agent/docs/message-types.md:90`）；`cacheWrite1h` 是 `cacheWrite` 的子集且仅 Anthropic 上报（`ai/src/types.ts:472`）。`cost.total` 优先是 provider 实报账单、否则是目录估算（`ai/src/types.ts:490-493`）。


---

## 4. `extension_ui_request` / `extension_ui_response` 交互集

独立子协议，**不是** `AgentSessionEvent`（`coding-agent/docs/json.md:196`；`coding-agent/docs/rpc-extension-ui.md:3`）。所有请求都带 `type:"extension_ui_request"`、唯一 `id`（`crypto.randomUUID()`，`coding-agent/src/modes/rpc/rpc-mode.ts:103`）和 `method`（`coding-agent/docs/rpc-extension-ui.md:29`）。

### 4.1 两类方法

| 类别 | method | 是否阻塞 Pi | 回包 |
|---|---|---|---|
| Dialog | `select`、`confirm`、`input`、`editor` | **阻塞**，扩展代码 `await` 到回包或超时（`coding-agent/docs/rpc-extension-ui.md:7`；`coding-agent/src/modes/rpc/rpc-mode.ts:95-135`） | 必须回 `extension_ui_response` |
| Fire-and-forget | `notify`、`setStatus`、`setWidget`、`setTitle`、`set_editor_text` | 不阻塞（`coding-agent/docs/rpc-extension-ui.md:8`；`coding-agent/src/modes/rpc/rpc-mode.ts:156-165,172-181`） | 不回包；**同样带 `id`**，但该 id 不登记在 pending 表里 |

### 4.2 九种请求的线上字段

| method | 字段（除 `type`/`id`/`method`） | 出处 | 默认值/清除语义 |
|---|---|---|---|
| `select` | `title:string`、`options:string[]`、`timeout?:number` | `coding-agent/src/modes/rpc/rpc-types.ts:253`；`coding-agent/src/modes/rpc/rpc-mode.ts:141-144` | 超时或取消 → 扩展侧得 `undefined` |
| `confirm` | `title:string`、`message:string`、`timeout?:number` | `coding-agent/src/modes/rpc/rpc-types.ts:254`；`coding-agent/src/modes/rpc/rpc-mode.ts:146-149` | 超时或取消 → `false` |
| `input` | `title:string`、`placeholder?:string`、`timeout?:number` | `coding-agent/src/modes/rpc/rpc-types.ts:255-262`；`coding-agent/src/modes/rpc/rpc-mode.ts:151-154` | 超时或取消 → `undefined` |
| `editor` | `title:string`、`prefill?:string` | `coding-agent/src/modes/rpc/rpc-types.ts:263`；`coding-agent/src/modes/rpc/rpc-mode.ts:258-275` | **无 `timeout` 字段**，只能靠取消或 abort signal 解除 |
| `notify` | `message:string`、`notifyType?:"info"\|"warning"\|"error"` | `coding-agent/src/modes/rpc/rpc-types.ts:264-270`；`coding-agent/docs/rpc-extension-ui.md:111` | `notifyType` 缺省为 `"info"` |
| `setStatus` | `statusKey:string`、`statusText:string \| undefined` | `coding-agent/src/modes/rpc/rpc-types.ts:271-277`；`coding-agent/docs/rpc-extension-ui.md:127` | `statusText` 缺省/`undefined` → **清除**该 key |
| `setWidget` | `widgetKey:string`、`widgetLines:string[] \| undefined`、`widgetPlacement?:"aboveEditor"\|"belowEditor"` | `coding-agent/src/modes/rpc/rpc-types.ts:278-285`；`coding-agent/docs/rpc-extension-ui.md:144` | `widgetLines` 缺省/`undefined` → **清除**；`widgetPlacement` 缺省 `aboveEditor`；**只支持字符串数组**，组件工厂被忽略（`coding-agent/src/modes/rpc/rpc-mode.ts:199-212`） |
| `setTitle` | `title:string` | `coding-agent/src/modes/rpc/rpc-types.ts:286` | — |
| `set_editor_text` | `text:string` | `coding-agent/src/modes/rpc/rpc-types.ts:287` | 覆盖输入框文本 |

超时由 **agent 侧**兜底，客户端不需要自己计时（`coding-agent/docs/rpc-extension-ui.md:10`；`coding-agent/src/modes/rpc/rpc-mode.ts:119-124`）。注意 `timeout` 只在扩展传入时才出现在 JSON 里——`JSON.stringify` 会丢掉 `undefined`。

### 4.3 三种回包

```text
{ "type":"extension_ui_response", "id":"<请求的 id>", "value": <string> }        // select / input / editor
{ "type":"extension_ui_response", "id":"<请求的 id>", "confirmed": <boolean> }   // confirm
{ "type":"extension_ui_response", "id":"<请求的 id>", "cancelled": true }        // 任意 dialog
```

出处 `coding-agent/src/modes/rpc/rpc-types.ts:294-297`；`coding-agent/docs/rpc-extension-ui.md:172-194`。语义：`value` → select 返回选中项字符串、input/editor 返回文本；`confirmed` → 布尔；`cancelled:true` → select/input/editor 得 `undefined`、confirm 得 `false`（`coding-agent/docs/rpc-extension-ui.md:190`；`coding-agent/src/modes/rpc/rpc-mode.ts:143,148,153`）。

两个必须实现的细节：

1. **回包不带命令 id、也不产生 `response`**（`coding-agent/docs/rpc.md:48`）。如果宿主把它拼成普通命令塞进请求队列，会收到一条 `Unknown command: ...` 错误。
2. **id 匹配不上时 Pi 静默丢弃**，不报错（`coding-agent/src/modes/rpc/rpc-mode.ts:785-798`）。所以「对话框已关闭后才到的回包」是安全的，不需要特殊处理，但也不要指望有错误反馈。

### 4.4 RPC 模式下被降级的扩展 UI 能力

宿主如果实现扩展面板，需要知道这些方法在 RPC 模式下的返回值（`coding-agent/docs/rpc-extension-ui.md:14-25`；实现 `coding-agent/src/modes/rpc/rpc-mode.ts:167-310`）：

| 方法 | RPC 行为 |
|---|---|
| `custom()` | 返回 `undefined` |
| `onTerminalInput()` | 返回 no-op 退订函数 |
| `setWorkingMessage` / `setWorkingVisible` / `setWorkingIndicator` / `setHiddenThinkingLabel` / `setFooter` / `setHeader` / `addAutocompleteProvider` / `setEditorComponent` / `setToolsExpanded` | no-op（`coding-agent/src/modes/rpc/rpc-mode.ts:232-235,252-256,277-310`） |
| `getEditorText()` | 恒 `""`；`getEditorComponent()` 恒 `undefined` |
| `getToolsExpanded()` | 恒 `false` |
| `pasteToEditor()` | 退化为 `setEditorText()` |
| `getAllThemes()` / `getTheme()` | `[]` / `undefined` |
| `setTheme()` | `{ success:false, error:"Theme switching not supported in RPC mode" }`（`coding-agent/src/modes/rpc/rpc-mode.ts:302-305`） |

但 `ctx.mode === "rpc"` 且 `ctx.hasUI === true`（`coding-agent/docs/rpc-extension-ui.md:25`）——扩展会认为有 UI，因此 dialog 与 fire-and-forget 必须真的实现。

### 4.5 没有专用权限协议

在 `coding-agent/src/modes/rpc` 全目录 grep `permission` 零命中。**RPC 侧不存在 permission/approval 专用记录**：TUI 的权限确认走 `coding-agent/src/modes/interactive/interactive-mode.ts:2896-2906` 的 `showExtensionConfirm`（内部 `kind:"permission"` 仅用于 TUI 渲染），RPC 侧扩展只能用 `select`（如 `options:["Allow","Block"]`）或 `confirm` 表达确认。宿主应把这两类方法都渲染成阻塞式确认对话框。

### 4.6 `extension_error` 不是 UI 请求

扩展抛错时 Pi 发的是独立类型（`coding-agent/src/modes/rpc/rpc-mode.ts:355-357`；`coding-agent/docs/json.md:190-194`）：

```json
{"type":"extension_error","extensionPath":"/path/to/ext.ts","event":"tool_call","error":"Error message"}
```

它既不是 `extension_ui_request`，也不产生 `response`。UI 应以非阻塞错误提示呈现，不要让扩展错误阻塞聊天流。


---

## 5. 客户端渲染伪代码（40-80 行）

覆盖：`get_messages` 回放 → 订阅增量 → 工具卡片 → 结束态。省略网络/UI 框架细节。

```ts
// ---- 状态 ----
type Live = { blocks: Map<number, Block>; toolIds: Map<number, string> };  // blocks 的 key = contentIndex
const state = {
  messages: [] as AgentMessage[], live: null as Live | null,   // messages = 已定稿（回放 + message_end）
  tools: new Map<string, ToolCard>(),                          // key = toolCallId
  queue: { steering: [] as string[], followUp: [] as string[] }, busy: false, settled: true,
  usage: undefined as Usage | undefined, thinkingLevel: "", title: "",   // 由事件更新
};

// ---- 1. 回放：先拿历史，再订阅（顺序不能反）----
async function boot() {
  const st = (await call({ type: "get_state" })).data;
  state.busy = st.isStreaming;                                 // 中途接入时可能已在跑
  const { messages } = (await call({ type: "get_messages" })).data;
  for (const m of messages) {
    if (m.role === "system") continue;                          // 系统提示词不进 UI
    if (m.role === "custom" && m.display === false) continue;
    state.messages.push(m);
  }
  subscribe(onLine);                                           // 2. 订阅：必须在 prompt 之前
}

// ---- 3. 增量 ----
function onLine(rec) {
  if (rec.type === "extension_ui_request") return handleUiRequest(rec);
  if (rec.type === "response") return resolvePending(rec);      // 按 id 匹配
  if (rec.type === "extension_error") return toast(rec.error);
  handleEvent(rec);
}

function handleEvent(e) {
  switch (e.type) {
    case "agent_start": state.busy = true; state.settled = false; break;
    case "message_start":
      if (e.message.role === "system") break;                   // 丢弃
      if (e.message.role === "assistant") state.live = { blocks: new Map(), toolIds: new Map() };  // 流式占位
      else state.messages.push(e.message);                      // user / toolResult / bashExecution
      break;
    case "message_update": {
      const live = state.live; if (!live) break;
      const ev = e.assistantMessageEvent, i = ev.contentIndex;   // 按块索引，不按到达顺序
      if (ev.type === "text_start")          live.blocks.set(i, { type: "text", text: "" });
      else if (ev.type === "text_delta")     appendText(live, i, ev.delta);      // 多个 delta 拼同一条
      else if (ev.type === "text_end")       setText(live, i, ev.content);       // 权威覆盖
      else if (ev.type === "thinking_start") live.blocks.set(i, { type: "thinking", thinking: "" });
      else if (ev.type === "thinking_delta") appendThinking(live, i, ev.delta);  // 与正文分离累积
      else if (ev.type === "thinking_end")   setThinking(live, i, ev.content);
      else if (ev.type === "toolcall_start") {
        live.blocks.set(i, { type: "toolCall", name: ev.toolName, argsRaw: "" });
        live.toolIds.set(i, ev.id);                              // 关联 tool_execution_*
      } else if (ev.type === "toolcall_delta") appendArgs(live, i, ev.delta);   // 只拼字符串，不 parse
      else if (ev.type === "toolcall_end") live.blocks.set(i, ev.toolCall);     // 完整 arguments 在这里
      state.usage = e.usage; break;                              // usage 可能一直是 0
    }
    case "message_end":
      if (e.message.role === "system") break;
      if (e.message.role === "assistant") state.live = null;     // 权威终值替换重建值
      state.messages.push(e.message);
      break;
    case "tool_execution_start":  upsertTool(e.toolCallId, { name: e.toolName, args: e.args, status: "running" }); break;
    case "tool_execution_update": patchTool(e.toolCallId, { partial: e.partialResult }); break;
    case "tool_execution_end":    patchTool(e.toolCallId, { result: e.result, isError: e.isError, durationMs: e.durationMs, status: e.isError ? "error" : "done" }); break;
    case "queue_update": state.queue = { steering: e.steering, followUp: e.followUp }; break;
    case "compaction_start": banner("压缩中…", e.reason); break;
    case "compaction_end":   bannerEnd(); if (e.result) insertSummaryCard(e.result.summary); if (e.errorMessage) toast(e.errorMessage); break;
    case "auto_retry_start": retryHint(e.attempt, e.maxAttempts, e.delayMs, e.errorMessage); break;
    case "auto_retry_end":   retryHintEnd(e.success, e.finalError); break;
    case "thinking_level_changed": state.thinkingLevel = e.level; break;
    case "session_info_changed":   state.title = e.name ?? ""; break;
    case "bash_execution_update":  appendBashOutput(e.id, e.delta); break;
    case "entry_appended": if (e.entry.type === "message") { /* 可选：增量补历史 */ } break;
    case "agent_end":      /* 不是结束态：重试 / 压缩恢复还会继续 */ break;
    case "agent_settled":  state.busy = false; state.settled = true; unlockInput(); break;
  }
}
```

四个关键点：`state.live` 按 `contentIndex` 分块（不是按到达顺序）；`thinking` 与 `text` 各自独立累积；`toolcall_delta` 只拼字符串、到 `toolcall_end` 才 `JSON.parse`；`agent_settled` 才是解开输入框的唯一时机。

---

## 6. 边界与坑

### 6.1 abort：response 比 `agent_settled` 还晚

- `abort` 是「请求 + 等待」型命令：`coding-agent/src/modes/rpc/rpc-mode.ts:447-450` 要 `await session.abort()` 完成后才发 response；内部 `coding-agent/src/core/agent-session.ts:2743-2753` 先置 `_agentRunAbortRequested`、再 `abortRetry()`/`abortCompaction()`/`abortBranchSummary()`、`agent.abort()`、最后 `await waitForIdle()`。
- 探针 C 实测尾部顺序：`message_end[assistant]{stopReason:"aborted"}` → `turn_end` → `agent_end{willRetry:false}` → `agent_settled{aborted:true}` → `response{command:"abort",success:true}`。**UI 不能用 abort 的 response 判结束**（它最晚到），解锁输入只认 `agent_settled`。
- abort 不回滚已产生的消息：assistant 消息保留已经输出的 thinking 与部分 text，`stopReason:"aborted"`，且**不设** `errorMessage`（探针 C 实测保留 678 字符文本）。渲染时应把这类消息当「被中断的回答」，不要当错误。
- abort 同时中止正在进行中的自动重试、压缩、分支摘要（`coding-agent/src/core/agent-session.ts:2747-2749`）。

### 6.2 clear_queue：先改队列、再回 response

- 语义：清空 steering 与 followUp 两个队列并返回被移除的文本（`coding-agent/src/core/agent-session.ts:2711-2719`），response `data` 就是 `{steering:string[], followUp:string[]}`（`coding-agent/src/modes/rpc/rpc-mode.ts:452-454`）。
- 顺序：`clearQueue()` 内部先 `_emitQueueUpdate()` 再返回，所以线上是 **`queue_update` 先到、`response` 后到**（探针 B 实测）。UI 按事件更新队列显示，response 只用来把文本还原到输入框。
- Esc 的标准交互：**先 `clear_queue`、把返回文本放回编辑器、再 `abort`**；因为 `abort` 不会清队列，仍在队列里的消息会被继续执行（`coding-agent/docs/rpc-commands.md:128`）。
- 队列出队同样发 `queue_update`：排队消息真正开始（`message_start` 且 `role:"user"`）时，先把它从数组里摘掉再发事件，注释明说为了让 UI 看到更新后的队列（`coding-agent/src/core/agent-session.ts:1300-1315`）。探针 B 实测顺序为 `queue_update{steering:[]}` → `message_start[user]`。

### 6.3 `streamingBehavior`：steer 不是插入当前流

- 流式中提交 `prompt` 必须带 `streamingBehavior`，否则直接报错（`coding-agent/docs/rpc-commands.md:29`；错误文案 `Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.`，`coding-agent/src/core/agent-session.ts:2371-2372`）。
- `"steer"` 的真实时机：入 steering 队列，**等当前 assistant turn 把工具调用执行完、下一次 LLM 调用之前**才作为一条新的 user 消息投递（`coding-agent/docs/rpc-commands.md:26`）。`"followUp"` 则等 agent 完全停止（`:27`）。
- 探针 B 实测时序：`prompt{streamingBehavior:"steer"}` → `queue_update{steering:["…"]}` → `response{disposition:"queued"}` → 当前轮 `message_end` → `turn_end` → `turn_start` → `message_start[system 增量]` → `queue_update{steering:[]}`（出队）→ `message_start[user]` → `message_start[assistant]`。即 steer 文本**不会**出现在正在流式的那个 assistant 消息里。
- `disposition` 三值：`handled` / `queued` / `started`（`coding-agent/docs/rpc-commands.md:40`）。`handled` 表示扩展命令或输入钩子消费了它、**不产生 run，不要等 `agent_settled`**（`coding-agent/docs/rpc.md:67`）；只有 `started` 才意味着后续会跑。
- 扩展命令（`/xxx`）在流式中也立即执行、不进队列（`coding-agent/docs/rpc-commands.md:31`）；`/skill:name` 与提示模板会在入队前展开（`:33`）。

### 6.4 切换会话：先 abort 旧会话，再换；header 不会重发

- `new_session` / `switch_session` / `fork` / `clone` 在真正替换运行时之前都走 `teardownCurrent`，而它**第一句就是 `await this.session.abort()`**，注释说明是为了让被中断的回合（含工具结果）先落盘到旧会话（`coding-agent/src/core/agent-session-runtime.ts:167-178`）。因此切换时 UI 会先看到一整串 abort 收尾事件（`message_end[aborted]` → `turn_end` → `agent_end` → `agent_settled`），然后才拿到 response。**在发切换命令前就要清空 live 流式状态与工具卡片**，否则会残留幽灵卡片。
- 切换可能被扩展取消：`session_before_switch` / `session_before_fork` 返回 `cancel:true` 时 response `data.cancelled = true`，会话不变（`coding-agent/src/core/agent-session-runtime.ts:133-165`；`coding-agent/docs/rpc-commands.md:132,150`）。
- 切换成功后 **RPC 不会重发任何 session header**（RPC 模式本来就不发，`coding-agent/docs/json.md:29`）。客户端必须重新 `get_state` 拿新的 `sessionId`/`sessionFile`/`sessionName`，并重新 `get_messages` 重建消息列表；旧列表属于旧会话，不能续用。
- 切换成功后 `coding-agent/src/modes/rpc/rpc-mode.ts` 会调 `rebindSession()`（`coding-agent/src/modes/rpc/rpc-mode.ts:456-463` 的 `new_session` 分支、`coding-agent/src/modes/rpc/rpc-mode.ts:632-638` 的 `switch_session` 分支）：重新 `bindExtensions` + 重新 `subscribe`。客户端不需要重连进程，事件流是连续的。
- 探针实测：`new_session` 之后先收到 `session_info_changed{name:"…"}`，再收到 `response{command:"set_session_name"}`——**状态类事件先于 response** 是本协议的稳定模式（`thinking_level_changed` 同理）。

### 6.5 关闭顺序：关 stdin、等它自己退、别补刀

- 有序关闭 = **关闭子进程的 stdin**，Pi 会 dispose runtime、等未完成工作再退出；要给它时间再 kill（`coding-agent/docs/rpc.md:93`）。实现见 `coding-agent/src/modes/rpc/rpc-mode.ts:826-829`（stdin `end` → `shutdown()`）。
- `SIGTERM`/`SIGHUP` 也发起有序关闭；**一旦关闭已开始（无论来自 stdin EOF 还是信号），后续单次 EOF 或单个信号不会打断，第二个信号立刻退出；同时关 stdin 并送 SIGTERM 是安全的**（`coding-agent/docs/rpc.md:95`）。实现：`coding-agent/src/modes/rpc/rpc-mode.ts:373-395`（SIGTERM→退出码 143、SIGHUP→129，`signalCount>1` 时直接 `process.exit`）。
- 别在关闭后立刻 `SIGKILL`：非 SIGTERM 路径会 `await flushRawStdout()` 再退出（`coding-agent/src/modes/rpc/rpc-mode.ts:752-754`），强杀会丢最后一条 response。
- `shutdown()` 本身幂等（`coding-agent/src/modes/rpc/rpc-mode.ts:744-746`）；扩展请求的 `ctx.shutdown()` 要等「命令处理完 + 会话 idle」才真正退（`coding-agent/src/modes/rpc/rpc-mode.ts:763-766`；`coding-agent/docs/rpc.md:97`）。

### 6.6 其余高频踩坑

| 坑 | 事实 | 出处 |
|---|---|---|
| 首帧不是 response | 启动后常先收到内置 `prompt-url` 扩展的 `extension_ui_request{method:"setWidget"}` | 探针实测；§1.4 |
| 每轮都有 system 消息 | 每个 assistant turn 前都插 `message_start/message_end[system]`（内容可达数十 KB）；必须丢弃，不能渲染 | 探针 A 实测；`coding-agent/docs/message-types.md:96-107` |
| `get_messages` 含 system | 回放结果里包含 system 消息（首条是完整 preamble/tools/safety） | 探针 A 实测 |
| assistant 的 `message_start` 是空占位 | `content:[]`、`stopReason:"pending"`，且 pending 消息不入 session JSONL；必须靠 `message_end` 替换 | 探针 A 实测；`coding-agent/docs/message-types.md:145` |
| 块到达顺序不等于块顺序 | thinking 与 text 各自独立 `contentIndex`（实测 thinking=0、text=1）；`thinking_end` 可能晚于 `toolcall_start` 到达 | 探针 A 实测；`coding-agent/docs/json.md:93` |
| `toolcall_delta` 不能增量 parse | `delta` 是参数 JSON 的原始片段（可能先来空串），到 `toolcall_end` 才有完整 `toolCall.arguments` | 探针 A 实测；`coding-agent/docs/json.md:86-87` |
| parallel 工具顺序 | `tool_execution_end` 按**完成**顺序到，而 toolResult 消息按**源**顺序到；不能用 end 顺序推消息顺序 | `agent/src/agent-loop.ts:604-664`（`Promise.all` 后才按源顺序发结果消息）、`agent/src/agent-loop.ts:39-46` |
| 输出被截断的工具调用 | 仍会发 `tool_execution_start`，随后立刻以 `isError:true` 结束（`durationMs` 缺省），错误文案固定 | `agent/src/agent-loop.ts:488-513` |
| `tool_execution_end` 没有 `args` | 参数只在 `start`/`update` 上有；卡片要复用 start 的 `args` | `coding-agent/docs/json.md:103-107`；探针 A 实测 |
| `usage` 可能一直是 0 | 流式期间 `message_update.usage` 是最新累计值，provider 不流式上报时可恒为 0，不能当计费用 | `coding-agent/docs/json.md:95` |
| `queue_update` 是全量快照 | 两个数组都是**当前完整队列**，直接替换而不是增量追加 | `coding-agent/docs/json.md:121`；`coding-agent/src/core/agent-session.ts:1223-1229` |
| `entry_appended.entry` 不一定是消息 | 可能是 `context_edit`/`model_change`/`label` 等 session entry；未知 `type` 必须安全忽略 | 探针 B 实测 `type:"context_edit"`；`coding-agent/docs/session-format.md:139-147` |
| 压缩中不能 prompt | 压缩进行中提交 prompt 会失败（`Cannot submit a prompt while compaction is in progress. …`），UI 应在 `compaction_start` 时禁输入 | `coding-agent/src/core/agent-session.ts:2322-2326` |
| 未知 role / 未知方法要容忍 | 低层 `AgentMessage` 是开放联合；`extension_ui_request.method` 未来可能增加 | `coding-agent/docs/message-types.md:279`；`coding-agent/docs/rpc-extension-ui.md:29` |
| 事件不带命令 id | 只有 `bash_execution_update` 例外地带上 `bash` 命令的 id；其余事件只能靠时序/字段自身关联 | `coding-agent/docs/rpc.md:46` |

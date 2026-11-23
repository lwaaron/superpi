# 输出完整性 —— 坏字节、提前收尾与「继续」的成本

> 起点：用户 2026-11-23 转来的排查结论（11-19~11-23）：
> ① 请求全部成功、无服务端错误；「中断感」来自回复在任务中途提前结束，需要多次点「继续」；
> ② 「无法解析的格式 / 代码错乱」的直接原因是自定义模型（DeepSeek-V4.1-Flash → `api.odys.work`）
> 多次输出**坏字节**与不完整标记，写进文件造成损坏，日志里能看到 AI 事后自己修坏字节；
> ③ 会话规模极大（单任务上万步、单次输入近 30 万 token），轻量模型在超长上下文下进一步退化。
>
> 本文只做一件事：把这三条**变成可判定的判据 + 可执行的修法 + 可复算的验收**。
> 归因不成立的地方明确写「未定论」，不含糊过去。

---

## 0. 结论摘要

| 层 | 事实 | 修法 | 判据 |
| --- | --- | --- | --- |
| **写盘面** | 20 个会话里，**7 次 `write` 的 `content` 含 U+FFFD 且全部成功落盘**（7/7）；另有 15 次 `bash` 命令含坏字节，13 次执行成功 | `tool_call` 钩子在**写盘前**拦截：`write.content` / `edit.edits[].newText` 含坏字节 → block，文件不写 | 带坏字节的 `write` 必然 `isError=true` 且目标文件不存在/未变 |
| **回合面** | 2600 条 assistant 里 156 条 `stop`、其中 90 条「短回复且无 toolCall」，**79 条**后面紧跟用户手打「继续」 | 判据扩到六类：`dsml-*` / `idle` / `corrupt` / `truncated`；**判据在 host 算一次**，两个前端只渲染 | 坏字节/截断/DSML/空转的回合，两端都出现同一条提示 + 一个「继续」 |
| **可观测** | 坏字节散落在 text(19) / thinking(6) / toolCall 参数(22)；此前没有任何地方统计它 | 落 `~/.superpi/integrity.log.jsonl`（滚动 240 行）+ `/superpi-integrity` | 拦截与观测都能被用户读出来，能直接转给接口提供方 |

**不做的事**：不猜「这轮做完没有」。156 条 `stop` 无工具调用的回合里，只有 6 条有可判定形态
（以 `：` 收尾），其余读起来都是完整句子 —— 任何"语义判断"都会变成假警报。
**能判的是"这一轮没交付"（无正文/无工具调用/坏字节/被截断），不是"任务没做完"。**

---

## 1. 取证（可复算）

数据源：`~/.pi/agent/sessions/` 下 mtime 落在 11-19~11-23 的 **20 个会话文件 / 5450 条记录 / 2600 条 assistant**。
探针：**`test/output-forensics.mjs`**（进仓库了，只读，不写任何会话文件）。复算命令：

```powershell
node test/output-forensics.mjs --since 2026-11-19 --until 2026-11-23T13:40
```

时间窗为什么精确到分钟：0.18.0 的修法本身会产生一个新的验证会话（§1.4），
只给日期会把「修法之后的样本」混进「修法之前的证据」。

### 1.1 收尾形态

| 指标 | 值 |
| --- | --- |
| assistant 条数 | 2600 |
| `stopReason` = `toolUse` / `stop` / `error` / `aborted` | 2414 / **156** / 27 / 3 |
| `stop` 且无 toolCall | **156**（其中 147 有正文，9 条是纯空转 `idle`） |
| 其中「正文 < 240 字符」 | 90 |
| 全部 `stop` 无 toolCall 里，后面紧跟用户手打「继续」 | **79 / 156 ≈ 51%** |
| `stopReason` = `length` | 0（本样本没有，但该取值存在于 pi 的 `StopReason`） |

「继续」不是偶发：**过半的纯文本收尾之后，用户都得手动推一下**。这是真实成本，不是感觉。
注意这 79 条里**只有 6 条**有可判定的结构信号（正文以 `：` 收尾），其余读起来都是完整句子 ——
所以 `docs/output-integrity.md` 的判据**不试图判断"任务做完没有"**（见 §2.2）。

### 1.2 坏字节落在哪

| 位置 | 命中条数 |
| --- | --- |
| assistant 正文（text） | 19 |
| assistant thinking | 6 |
| toolCall 参数（`write.content` / `bash.command`） | 22 |
| toolResult（读回被写坏的文件，或被终端转义污染的 stdout） | 39 |

按工具拆 toolCall 参数：`write.content` **7**，`bash.command` **15**。
另有 4 条消息的坏字节落在参数里的**其它字段**（如 `path`）—— 写入闸只检查会变成文件正文的
字段（理由见 §2.1），这 4 条不构成落盘风险，但计入「坏字节来自几个会话文件」的集中度统计：
**全部坏字节只来自 2 个会话文件**（§5.0 的强制动作：先看集中度，再谈规律）。

### 1.3 坏字节有没有真的落盘

| 工具 | 成功 | 失败 | 未执行 |
| --- | --- | --- | --- |
| `write`（含 U+FFFD） | **7** | 0 | 0 |
| `bash`（命令含 U+FFFD） | 13 | 2 | 0 |

**7/7 全部落盘。** 这就是「代码错乱」的物理路径：坏字节在 `write` 参数里，
pi 不检查内容编码，直接写文件，之后只能靠人或 AI 再读回来修。
样本原文（`docs/rules.md`，第 253 字符处）：

```
2. [U+FFFD][U+FFFD][U+FFFD]始规则内容由用户给定，**用户可以在设置里修改**；
```

`初`（U+521D）被替换成 U+FFFD —— 典型的多字节字符在流式重组时被切断。

### 1.4 真机端到端（修法之后，2026-11-23）

写入闸不是"单测通过"就算完。用**真实 pi 子进程 + 真实模型**（`Deepseek-V4.1-Flash`
→ `api.odys.work`，与用户报障用的同一条链路）做了一次定向验证：让模型用 `write`
写一个**必须含字面 U+FFFD** 的文件。

结果（可复现，脚本在 `_scratch/integrity-e2e.mjs`，属一次性验证不进仓库）：

```
toolResult 条数 = 2
命中拦截 = 1
写入已拦截（.../_scratch/integrity-e2e.txt）：content 含 1 处损坏字节。1 处坏字节：第 1 行 U+FFFD。
文件未写入（未创建、未修改）—— 这不是格式问题，是模型输出里的字节级损坏。
目标文件是否存在 = false
```

**文件确实没有被创建。** 这条证据覆盖了整条链路：真实模型 → pi 的工具参数 →
`tool_call` 钩子 → block → 错误结果回到模型 → 磁盘上什么都没有。
（在此之前，同一窗口的实测是 7/7 全部落盘。）

### 1.5 归因边界（不夸大）

- **已排除**：pi 的正文通道会丢弃 DSML 头部（`test/dsml-pi-loss.mjs` 用 pi 源码事实否证）。
- **未定论**：U+FFFD 是 provider 的 SSE 重组切断多字节字符，还是模型自己吐出替换符。
  两种可能都**不影响修法** —— 写盘闸在最后一米拦住，与谁丢的字节无关。
- **上下文**：超长历史会增加请求成本与压缩压力。现有样本无法单独估计长度对乱码发生率的影响。DSML 的分组结果与样本集中度见 [DSML 取证](dsml-root-cause.md)。

---

## 2. 修法：三个边界，各一个判据

```
model bytes ──► assistant message ──► tool_call ──► 写盘
                    │                    │
                    │                    └─ ① 写入闸：坏字节不落盘（block + 精确理由）
                    └─ ② 回合判据：这一轮交付了吗（六类，单一实现）
                                              │
                                              └─ ③ 观测：integrity.log.jsonl + /superpi-integrity
```

### 2.1 写入闸（`extensions/superpi-text-integrity.ts`）

| 工具 | 检查字段 | 动作 |
| --- | --- | --- |
| `write` | `path`、`content` | 含坏字节 → `{ block: true, reason }` |
| `edit` | `path`、`edits[].newText` | 同上。匹配字段 `oldText` 保留对旧损坏内容的修复能力 |
| `bash` / `powershell` | `command` | **不拦截**（同一串字节可能是修复脚本，拦它等于禁止修复），改为在 `tool_result` 追加一行警告 |

为什么只拦 `write`/`edit` 的「新字节」侧：**坏字符永远可以用转义表达**（`\uFFFD`），
所以拦截字面量**不减少任何能力**；而允许 `oldText` 含坏字节，是因为那是**修复入口**。
这是「不降级」与「不误伤」两条约束同时成立的最小切面。

拦截理由必须让模型**当场能改**：给出行号、码位、总数，并明确「文件未写入」「不要原样重发」。

### 2.2 回合判据（`extensions/superpi-turn-verdict.mjs`）

六类，全部**可机械判定**：

| kind | 条件 | 文案要点 |
| --- | --- | --- |
| `dsml-text` | `stop`，正文含开闭标记或末尾的有名调用开头，无 toolCall | 这条响应里的工具标记无法识别 |
| `dsml-thinking` | 同上，但标记在 thinking（含只有闭标记的形态 B） | 同上（说清是 thinking 通道） |
| `dsml-residue` | text/thinking 以 `</parameter>` 等残片收尾，可带 DSML 闭合标记 | 同上 |
| `idle` | `stop`，既无正文也无 toolCall | 这一轮什么都没产出 |
| `corrupt` | text/thinking 含坏字节（无 toolCall） | 输出含 N 处损坏字节（乱码） |
| `truncated` | `stopReason === 'length'` | 达到单次输出上限被截断 |

**判据只有一份**：`detectTurnVerdict(message)` 在 host 侧对每条 `message_end` 计算一次，
结果作为 `verdict` 字段随事件下发；命令行窗口（TUI）在同一进程里直接 import 同一模块。
面板**不再有**判据实现，也不再依赖 `/contract` 下发的判定表 —— 0.17.3 那个
「契约未到时提示永久丢失」的竞态**随依赖一起消失**，而不是靠调整顺序绕开。

### 2.3 从已有进度恢复（0.19.0）

- `turn_end` 通过 Pi 的 `context_edit` 把无法使用且没有工具调用的响应移出后续请求。原始消息仍可从会话记录查询。输出截断时保留干净的前缀。
- `agent_before_settle` 在 Pi 处理原生重试、压缩和用户队列之后判断。用户未停止、本次没有工具调用时，默认从已有上下文自动续跑一次。既有开关与冷却时间继续生效。
- 终端和面板均可手动继续，面板快照保留最后一次判定。长任务沿用同一套交付准则，模型在收尾前按请求核对交付物、测试结果和阻塞原因。普通短回复维持自然完成语义。
- 成功的大文件写入在后续请求中以可重读的路径表示，完整调用仍由 Pi 留档。原生压缩摘要计入预算。

`node test/reliability.mjs` 走真实 host、Pi RPC 与本地 SSE 服务。测试在实际 UTF-8 流中注入坏字节，核对文件写入结果，并验证健康跨包中文、自动续跑上限、主动取消、模型切换和长正文去重。

### 2.4 观测

- `~/.superpi/integrity.log.jsonl`（`SUPERPI_INTEGRITY` 可覆盖路径，滚动 240 行）：
  每条记录 `{ at, kind, tool, path?, bytes, where }`，不含文件内容。
- `/superpi-integrity`：打印累计拦截次数、按工具/kind 的分布、最近 5 条、日志路径。
- 坏字节的**具体位置**（行号/码位）只进拦截理由与日志，不进用户提示条 —— 提示条只需要
  「发生了什么 + 该做什么」。

---

## 3. 验收判据（每条可执行、可红）

### A. 写入闸

```
A1 write.content 含 1 个 U+FFFD            → isError=true，reason 含 "U+FFFD" 与行号，目标文件不存在
A2 write.content 含 U+0000                 → 同上
A3 write.content 含孤立代理项（\uD800）     → 同上
A4 edit.edits[0].newText 含 U+FFFD         → 同上，且**其它 edit 项也不生效**（整次调用被拦）
A5 edit.edits[0].oldText 含 U+FFFD         → **放行**（修复入口）
A6 bash.command 含 U+FFFD                  → 不拦截；tool_result 末尾出现一行警告
A7 干净内容                                 → 不拦截、不追加任何内容（零痕迹）
A8 write 到任意路径（含 .md/.json/.ts）      → 规则相同，不按扩展名区别对待
A9 write/edit 的目标路径含损坏字节            → 拦截并提示从目录核对路径
```

### B. 回合判据

```
B1 stop + 空正文 + 无 toolCall              → idle
B2 stop + 正文含完整 DSML                   → dsml-text
B3 stop + 只有 thinking 且含 DSML 闭标记     → dsml-thinking
B4 stop + 正文以 </parameter> 结尾           → dsml-residue
B5 正文用 Markdown 引用 DSML               → 保留普通回复
B6 stop + 正文含 U+FFFD + 无 toolCall        → corrupt（detail.bytes = 命中数）
B7 toolUse + 参数含 U+FFFD                  → **不判**（写盘闸负责，回合还在继续）
B8 stopReason = length                      → truncated
B9 正常回复（有正文、无标记）                 → 不判
B10 error / aborted                         → 不判（走错误路径）
```

### C. 单点判定（架构判据，防回退）

```
C1 client.js 里没有判据实现（`detectMalformedOutput` 不存在；`DSML` 只允许出现在说明性注释里）
C2 /contract 不再下发 malformed 判定表（知识只有一份，在模块里）
C3 message_end 事件在**进入环形缓冲之前**已带 verdict（否则重连回放会丢提示）
C4 panel 启动顺序不再影响 verdict（契约请求失败也照样有提示）
```

### D. 两端对齐

```
D1 同一批真实样本：host verdict.kind === TUI detectTurnVerdict().kind（逐条相等）
D2 两端文案逐字相同（都取自模块的 notice.zh / notice.en）
D3 面板与终端点击「继续」                   → 用现有会话提交一次续跑请求
```

### E. 不降级

```
E1 无坏字节的会话：拦截 0 次、日志 0 行、tool_result 零追加（不引入噪音）
E2 拦截不产生重试风暴：同一 toolCallId 只拦一次；模型重发干净内容后正常通过
E3 自动恢复受「本次已有 toolCall 就停止自动续跑」与一次预算约束
E4 上下文守卫、模态、规则三条既有链路零回归（全量门禁）
```

### F. 文档与账本

```
F1 AGENTS.md 的模块表登记 text-bytes / turn-verdict / text-integrity 三个新文件
F2 docs/parity.md 记 0.18.0 一行（含本次架构变化与删除项）
F3 install-pi-extension 的 EXTENSION_FILES 中「模块先于扩展」顺序成立（3 组）
F4 gate-inventory 登记新门禁规模下限
```

---

## 4. 不允许的「假修复」

| 反模式 | 为什么不行 |
| --- | --- |
| 把 U+FFFD 自动替换成猜测的原字 | 猜错就是把错误写进代码，且掩盖了 provider 的问题 |
| 拦截后自动重发同一段内容 | 同一串坏字节会再来一次；必须让模型「重读原文后重写」 |
| 在面板里再实现一份判据 | 就是 0.16.0 那个「命令行亮红字、面板静默」的成因 |
| 靠把 `maxTokens` 调小来"避免截断" | 输出更短 ≠ 更好，等于用降级换指标 |
| 把「短回复」判成「没做完」 | 156 条里 150 条没有可判定形态；假警报会让人不再相信提示 |
| 只写日志不做拦截 | 日志证明"发生了什么"，拦不住"写坏了" |

---

## 5. 与既有文档的关系

- `docs/dsml-root-cause.md`：DSML 形态与三次证伪。本文**继承**它的判据，不再重复论证。
- `docs/session-interruption.md`：网络/超时类中断。本文处理的是**非错误收尾**，两者不重叠。
- `docs/context-overload.md`：上下文浪费。本文的 `truncated` / `corrupt` 是它的下游症状，
  但修法独立（守卫治浪费，本文治落地与可见性）。

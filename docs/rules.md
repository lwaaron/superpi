# 用户自定义规则（User-defined rules）— 全量设计与验收清单

> 版本：0.10.0 · 落地日期 2026-11-18
> 唯一真相源：`extensions/superpi-rules.mjs`（结构 / 默认文案 / 归一 / 校验 / 渲染 / 落盘）
> 本文是**先写测试用例与端到端验收标准、再执行**的那份文档（用户 2026-11-18 的强制流程）。

---

## 1. 需求原文与验收口径

用户要求（2026-11：）：

1. 增加一个**用户自定义规则**设置项，**优先级最高**；
2. ���始规则内容由用户给定，**用户可以在设置里修改**；
3. 规则必须真的到达模型（不是只存在面板里看个热闹）。

**「优先级最高」的可执行定义**（不做口号，做机制）：

| 维度 | 定义 | 机器保证 |
| --- | --- | --- |
| 位置 | 追加在系统提示**末尾**。模型读长前缀时，末尾指令的遵循度最高；pi 的 sections 顺序是 preamble → tools → rules → docs → … → addendum（`dist/core/system-prompt.js:96`） | `test/rules.mjs`：`renderRulesBlock()` 的产物必须整体位于 `systemPrompt` 之后 |
| 用语 | 规则块首行显式声明「优先级高于上文与项目指令，冲突时以本段为准」 | `test/rules.mjs`：块内含 `OVERRIDE_PREFIX` |
| 冲突 | 与 `AGENTS.md` 等冲突时**本段优先** —— 这句话必须写在块里，否则模型会按上下文里的项目指令执行 | 同上 |
| 生效面 | 命令行 TUI 与面板**同一份文件、同一段文本、同一时点生效** | `test/rules.mjs` + `test/tui-editor.mjs`（安装面）+ `test/client-render`（面板 UI） |
| 传输 | `before_agent_start` 返回 `{ systemPrompt }`（pi 官方扩展点），**不改 pi 任何文件** | `test/rules.mjs`：扩展 handler 的返回值形状 |

**不做的事（重要）**：

- 不写 `SYSTEM.md`（那会**替换**掉 pi 的整套默认提示：工具说明、docs 路径、技能列表 —— 属于让系统退化一个维度）；
- 不写 `APPEND_SYSTEM.md`（那是全局静态追加，面板改完必须重启 pi 会话才生效，且没有面板入口）；
- 不把规则当**用户消息**发给模型（那会进对话历史、被压缩吃掉、污染 transcript）。

---

## 2. 架构

```
              <home>/.superpi/rules.json        ← 唯一真相（面板与命令行同一份）
                    ▲            ▲            ▲
      fs 读写（浏览器侧无 fs）│            │ 同步读，mtime 缓存
                    │            │            │
   ┌────────────────┴──┐   ┌─────┴──────┐  ┌──┴───────────────────────┐
   │ host (index.js)   │   │ client.js  │  │ pi 扩展 superpi-rules.ts │
   │ GET/POST /rules   │←──│ 设置弹窗 UI │  │ before_agent_start 追加   │
   └───────────────────┘   └────────────┘  │ /superpi-rules 命令        │
                                           └──────────────────────────┘
                两者共用 extensions/superpi-rules.mjs（归一/校验/默认文案/块渲染）
```

为什么是「一个 JSON 文件 + 两处读」而不是让面板通过 RPC 命令写：

1. 面板要**读原文回显**（编辑框初值）。pi 的 RPC 面没有「读系统提示」的命令，
   扩展命令的返回值也不回传内容 —— 若只走命令，面板回显只能自己再存一份，
   于是立刻出现「两份文本谁是真的」的经典分叉。
2. 设置页可能**没有活着的 pi 子进程**（还没开会话、子进程崩了、面板刚打开）。
   设置项不该依赖另一个进程活着才能打开。
3. 从 `rules.json` 读出来的是**真实生效的那份**。这点必须由门禁证明
   （`test/rules.mjs` 里「面板写什么、扩展读什么」用同一路径断言），而不是靠文档承诺。

---

## 3. 数据模型（`rules.json`，`RULES_VERSION = 1`）

```json
{
  "version": 1,
  "createdAt": "2026-11-18T02:00:00.000Z",
  "updatedAt": "2026-11-18T02:00:00.000Z",
  "checksum": "9f2c…（sha256(text) 十六进制）",
  "text": "User-defined rules：\n思考过程和最后总结使用简体中文回复；\n…"
}
```

| 字段 | 规则 | 理由 |
| --- | --- | --- |
| `version` | 恒等于 `RULES_VERSION`；**不带** `custom` 扩展字段时不对缺失做推断 | 将来改结构靠它迁移，不靠猜 |
| `text` | 归一后字符串；缺失/非字符串/超长 → **回落默认文案** | 规则文件坏掉不该让 pi 的每一轮都报错 |
| `checksum` | 写入时**由 host/扩展自己算**，不接受客户端提交；读到不一致 → 重算并标记 `drift` | 外部工具手改文本时，追踪表（audit）必须能发现 |
| `createdAt` | 首次创建时间，后续更新**保持不变** | 与 `ui-prefs` 同一约定，客户端拿它做稳定排序键 |
| `rank` | 不是字段，读接口实时计算（`0 = 空`，`1 = 非空`） | 空规则 = 不追加任何东西，且必须让 UI 明确显示「当前不生效」 |

**文本归一**（`normalizeRulesText`）：去 BOM → `\r\n`/`\r` 统一成 `\n` → 逐行去掉行尾空白 →
连续 3+ 空行压成 1 空行（2 个 `\n`）→ 整体 trim。归一必须**幂等**（`f(f(x)) === f(x)`），
否则每次保存都会改 checksum，界面会永远显示「已修改」。

**空规则判定**（`isRulesEmptyText`）：归一后为空，或除 `#` 注释行外没有内容 → 空。
空规则的 UI 与接口语义都是「当前不追加任何内容」，不静默当成「用默认值」。

---

## 4. 接口契约（host）

前缀 `/api/superpi`。三条路由，全部返回**全量视图**（不做增量合并，与 `/ui-prefs` 同一风格）。

### 4.1 `GET /rules`

```json
{
  "ok": true,
  "version": 1,
  "text": "…",
  "checksum": "9f2c…",
  "createdAt": "…",
  "updatedAt": "…",
  "isDefault": false,
  "empty": false,
  "rank": 1,
  "maxLength": 20000,
  "filePath": "C:\\Users\\PC\\.superpi\\rules.json",
  "delivery": { "command": "/superpi-rules", "extensionInstalled": true }
}
```

- 文件不存在 → `source: "default"`，`text` = `DEFAULT_RULES_TEXT`，**不落盘**（读不写盘）。
- 文件损坏 → 同上，并带 `warning` 字段（不抛，不阻断设置页）。
- `delivery.extensionInstalled` = `<piAgentDir>/extensions/superpi-rules.ts` 存在。
  它决定面板要不要提示「命令行窗口里还没装，规则只在面板生效」。

### 4.2 `POST /rules` `{ "text": "…" }`

- 200：写入并返回同 4.1 的视图（`isDefault:false`）。
- 400：`text` 不是字符串 / 超 `maxLength`。
- 415：`content-type` 不是 `application/json`（沿用既有路由的约定）。
- **归一在 host 侧做**，客户端提交什么都会先过 `normalizeRulesText`。

### 4.3 `POST /rules/reset` `{}`

恢复默认文案（把 `text` 写回 `DEFAULT_RULES_TEXT` 并重算 checksum），返回同 4.1 的视图且 `isDefault:true`。

---

## 5. 交付链路（pi 扩展）— 这一节决定功能是否真的生效

| 环节 | 行为 | 失败时的表现（必须可见，不许静默） |
| --- | --- | --- |
| 安装 | `npm run pi:editor` 把 `superpi-editor.ts` + `superpi-rules.ts` + `superpi-rules.mjs` 复制到 `<piAgentDir>/extensions/`（幂等） | `--status` 显示「内容不一致，需 --install」 |
| 加载 | pi 用 jiti 加载 `.ts`；扩展 `import` 同目录的 `superpi-rules.mjs`（pi 的 jiti alias 不含它，走原生 ESM 相对路径） | 扩展捕获一切异常，绝不阻断 pi 启动 |
| 生效 | 每轮 `before_agent_start` 读文件（mtime+size 缓存），返回 `{ systemPrompt: 原提示 + 块 }` | 读不到 → 用默认文案（离线安全） |
| 面板 | `POST /rules` 写文件；下一轮 `before_agent_start` 自动带上新文本 | 面板显示 `delivery.extensionInstalled=false` 的提示 |
| 命令行 | `/superpi-rules` 命令用 pi 官方 `ctx.ui.select/editor/confirm` 读写**同一个文件** | 中文/只在 TUI 可用的差异：RPC 模式同样有这 4 个 method，两端一致 |

**扩展不 import `@earendil-works/*`**：它只用到 `pi.on` / `pi.registerCommand` / `ctx.ui.*` 三个
运行时参数，事件与命令的类型靠 JSDoc 描述。这既让 `node_modules` 里多份 pi 副本都通，
也让扩展可以在 `test/rules.mjs` 里**脱离 pi 单测**（用假 `pi` 与假 `ctx.ui` 真跑一遍）。

---

## 6. 状态矩阵（UI 必须覆盖的每一个状态）

设置弹窗（`SettingsSheet`）里的「User-defined rules」区：

| 状态 | 显示 | 交互 |
| --- | --- | --- |
| 加载中 | 摘要行显示骨架占位 | 编辑按钮禁用 |
| 正常（自定义） | 行数 / 字数 + 首行摘要 + `最高优先级` 徽标 | 点「编辑」打开 `RulesSheet` |
| 正常（默认文案） | 同上，额外 `默认` 徽标 | 同上 |
| 空 | `当前未生效（不会追加任何内容）` 告警色 | 同上 |
| host 读失败 | 错误行 + `重试` 按钮 | 编辑禁用（避免覆盖掉读不出来的文件） |
| 命令行未安装 | `命令行窗口未生效：运行 npm run pi:editor` 提示行 | 无 |

编辑弹窗（`RulesSheet`）：

| 状态 | 显示 | 交互 |
| --- | --- | --- |
| 初始 | `textarea` 预填当前全文，焦点在框内 | Esc / 取消 / 点遮罩 → 无改动则直接关 |
| 已修改 | 字数 `1234 / 20000` + 主按钮可用 | Esc / 取消 / 点遮罩 → 二次确认丢弃 |
| 保存中 | 主按钮 `保存中…` 禁用 | 不可重复提交 |
| 保存成功 | 关闭弹窗 + 弹出 `ok` 提示（notice） | — |
| 保存失败（400/500） | 弹窗不关，错误行显示 host 原文 | 可重试 |
| 超长 | 字数超过上限时输入即截断 + 告警色 | 主按钮禁用 |
| 恢复默认 | 点击后先确认 | 确认后写入默认文案并刷新 |

无障碍：`role="dialog"` + `aria-modal="true"` + `aria-label`；`textarea` 有 `aria-label`；
错误行 `role="alert"`；徽标有可读文本（不是纯色块）。

---

## 7. 测试用例（先写后做）

### 7.1 纯函数层 —— `test/rules.mjs`（新增，进 `npm test`）

**A. 归一 `normalizeRulesText`**

1. `\r\n` 与 `\r` 统一成 `\n`；
2. 去 BOM；
3. 逐行去行尾空白（含全角空格 `\u3000`）；
4. 连续 3 个以上空行压成 1 个；
5. 幂等：`normalize(normalize(x)) === normalize(x)`（对 5 个真实样本逐个断言）；
6. 非字符串输入（`null` / `undefined` / 数字 / 对象）→ `''`。

**B. 默认文案 `DEFAULT_RULES_TEXT`**

7. 包含用户给的全部 21 条要点（按关键词逐条断言：简体中文 / 50% / 第一性原理 / 补丁 / UI 设计师 / 架构师 / 测试专家 / SaaS / 按行修改 / 全量测试用例 / 禁止利用目标维度指标的漏洞 / did / 业务编号 / 提交到本地 github / git revert / 任务清单 / 初始化状态 / mock 数据 / 浏览器插件 / 清理标签页）；
8. 默认文案本身已归一（`normalize(DEFAULT) === DEFAULT`）；
9. 默认文案非空（`isRulesEmptyText(DEFAULT) === false`）。

**C. 校验与落盘视图**

10. `normalizeRules(null)` → 结构齐全、`text === DEFAULT_RULES_TEXT`；
11. `normalizeRules({text: '  x  '})` → `text === 'x'`；
12. `normalizeRules({text: 'x'.repeat(MAX+1)})` → 回落默认（不截断，避免「悄悄丢用户内容」）；
13. `normalizeRules` 丢弃未知键与 `__proto__`；
14. `checksumOf` 对同一文本稳定、对不同文本不同；
15. `rankOf('')` = 0、`rankOf('  ')` = 0、`rankOf('#仅注释')` = 0、`rankOf('有内容')` = 1。

**D. `renderRulesBlock`**

16. 空文本 → `''`（调用方据此不追加，不要留两个空行）；
17. 非空 → 以 `OVERRIDE_PREFIX` 开头；
18. 含 `<user_defined_rules>` 包裹；
19. 含「优先级」字样；
20. 块内文本与输入逐字一致（只加包裹，不改用户文案）；
21. 幂等渲染：同一文本两次渲染结果相同。

**E. store（`createRulesStore`，临时文件）**

22. 文件不存在 → `read()` 返回默认文案且**不创建文件**；
23. `write({text})` → 落盘 JSON 字段齐全（version/createdAt/updatedAt/checksum/text）；
24. 二次 `write` → `createdAt` 不变、`updatedAt` 刷新、`checksum` 跟随文本；
25. 相同文本重复写 → `updatedAt` 不刷新（幂等，避免「最后修改」撒谎）；
26. `reset()` → `text === DEFAULT_RULES_TEXT`；
27. 坏 JSON → `read()` 回落默认 + `warning`（不抛）；
28. 超长文本 → `write` 以 400 语义 reject（`statusCode === 400`）；
29. 非字符串 `text` → reject；
30. 并发两次 `write` 不丢更新（串行队列：后写的能看到先写的 `createdAt`）；
31. 原子写：目录里不残留 `*.tmp-*`。

**F. HTTP 面（`createHandler` + 真 http server）**

32. `GET /rules` 200，`isDefault:true`，`text === DEFAULT_RULES_TEXT`；
33. `POST /rules` 写 → `GET` 能读到（同一份落盘）；
34. `POST /rules` 400（text 非字符串 / 超长）；
35. `POST /rules` 415（content-type 不对）；
36. `POST /rules/reset` → `isDefault:true`；
37. `GET /rules` 的 `delivery.command === '/superpi-rules'`；
38. 文件被外部手改成非法 JSON → `GET` 仍 200 且带 `warning`；
39. `filePath` 与 `resolveRulesPath()` 一致（面板显示的路径是真实路径）。

**G. 扩展（真 `.ts` + 假 pi/ctx，用 jiti）**

40. 扩展默认导出是函数；
41. 加载时不抛（即使 rules 文件不存在）；
42. `before_agent_start` 返回值里 `systemPrompt` = 原提示 + 块（顺序断言）；
43. 规则为空时**不**返回 `systemPrompt`（空规则 = 不加噪声）;
44. 规则文件改文本后下一轮拿到新文本（mtime 缓存不失效）；
45. `before_agent_start` 抛异常时扩展不把异常扔给 pi（用坏文件 + 只读目录）；
46. `registerCommand('superpi-rules')` 被调用；
47. 命令选择「编辑」→ 走 `ctx.ui.editor` → 写回**同一个文件** → 再读能读到；
48. 命令选择「恢复默认」→ 文件文本变成默认；
49. 命令在没有任何 `ctx.ui` 方法时给出错误提示而不是抛；
50. 扩展**不** import `@earendil-works/*`（源码断言）。

**H. 安装面（`tools/install-pi-extension.mjs`）**

51. `status()` 同时报告 editor 与 rules 两个文件；
52. `install({dir})` 装出 3 个文件（editor / rules.ts / rules.mjs）；
53. 装出的扩展用 **pi 自己的加载器** `discoverAndLoadExtensions` 加载无 error；
54. `remove({dir})` 三个文件都删掉；
55. 装出来的 `superpi-rules.mjs` 与仓库里 `extensions/superpi-rules.mjs` 逐字节一致。

**I. 契约单一真相**

56. `client.js` 里**不**出现默认规则文案的任何一句（避免面板与 host 各存一份）；
57. `extensions/superpi-rules.mjs` 被 `index.js` 与 `extensions/superpi-rules.ts` 同时引用。

### 7.2 面板渲染 —— `test/client-render.mjs`（追加）

58. `SettingsSheet` 渲染出「User-defined rules」区标题；
59. 有 `rules` 数据时显示首行摘要 + 字数；
60. `empty:true` 时显示「未生效」告警；
61. 无 `rules` 数据（加载中）时不抛、编辑按钮禁用；
62. `RulesSheet` 渲染出 `textarea`（预填全文）+ 字数计数 + 保存/取消；
63. `RulesSheet` 的保存按钮在 `saving:true` 时 disabled；
64. 错误行 `role="alert"`；
65. 中英文键集一致（既有断言覆盖新增键）。

### 7.3 命令行输入框 —— `test/tui-editor.mjs`（追加）

66. `SETTINGS_COMMANDS` 里有 `rules` → `/superpi-rules`；
67. `SETTINGS_COMMANDS` 里 pi 自带的 4 条仍然存在于 pi 源码（既有断言按 `source` 分类）；
68. `rules` 这条不再去 pi 源码里找，而是断言 `extensions/superpi-rules.ts` 里注册了同名命令。

### 7.4 端到端（人工 + 脚本各一半）

见第 8 节。

---

## 8. 端到端验收清单（必须在真机上逐条过）

编号 `E2E-xx`，每条都要**看到证据**（截图 / 接口返回 / 会话文件），不接受「应该可以」。

| 编号 | 步骤 | 通过标准 |
| --- | --- | --- |
| `E2E-01` | 全新机器（删掉 `<home>/.superpi/rules.json`）打开面板设置 | 规则区显示默认文案摘要 + `默认` 徽标，**不是空白** |
| `E2E-02` | 点编辑 → 在末尾追加 `## 我的补充\n只回一句话` → 保存 | 关闭弹窗、出现成功提示、摘要变成本地修改后的首行 |
| `E2E-03` | 直接 `cat <home>/.superpi/rules.json` | `text` 含刚追加的内容，`checksum` 是 64 位十六进制，`createdAt` 未被刷新 |
| `E2E-04` | 面板里发一句「读一下你现在遵守的最高优先级规则，逐条列出来」 | 回复里出现刚追加的 `只回一句话` 与默认文案的要点（证明真的进了系统提示） |
| `E2E-05` | 打开命令行 `pi` 会话（已 `npm run pi:editor`），问同一句话 | 与 `E2E-04` 一致（证明两端同一份） |
| `E2E-06` | 命令行里 `/superpi-rules` → 选「编辑」→ 改一个字 → 保存 | 面板设置的摘要立刻跟着变（刷新设置弹窗即可看到） |
| `E2E-07` | 设置里「恢复默认」→ 确认 | 文本回到默认文案，`isDefault:true` |
| `E2E-08` | 清空文本 → 保存 | 摘要显示「当前未生效」，且下一轮对话里**不再**出现规则块（`E2E-04` 的提问变成「没有规则」） |
| `E2E-09` | 把 `rules.json` 改成非法 JSON → 重新打开设置 | 面板不崩，显示回落的默认文案 + 警告；再保存一次能修好 |
| `E2E-10` | 卸载扩展（`npm run pi:editor:remove`）→ 重开设置 | 显示「命令行窗口未生效」提示；面板仍然生效 |
| `E2E-11` | 长文本（粘贴 19000 字）→ 保存 | 字数显示 `19000 / 20000`，保存后回车不丢字；超 20000 时保存按钮禁用 |
| `E2E-12` | 暗色 / 亮色主题各看一遍 | 所有新增元素用 `--dsw-*` 令牌，明暗都不失真（`test/css-tokens.mjs` 兜底） |
| `E2E-13` | 键盘走查：Tab 进弹窗 → 编辑 → Esc（有改动） | 出现「丢弃修改？」确认，取消后内容还在 |
| `E2E-14` | 面板未开会话就打开设置 → 编辑 → 保存 | 能保存（设置项不依赖会话活着） |

---

## 9. 回滚

- 版本回退用 `git revert`（用户明令禁止 `reset --hard`）。
- 功能回滚：删掉 `<home>/.superpi/rules.json`（规则回到默认）或清空文本（不追加任何内容）；
  卸载扩展 `npm run pi:editor:remove`。**这三条都不需要回退代码。**
- 数据安全：`rules.json` 只由本插件写入，写入走 tmp + rename（原子）；读取失败一律回落默认，
  不会出现「规则坏了导致 pi 起不来」。

---

## 10. 执行清单（按顺序，打勾即完成）

- [x] 1. `extensions/superpi-rules.mjs`：模型 / 默认文案 / 归一 / 校验 / 渲染 / store / 同步读（放在 `extensions/` 而不是 `src/`，见第 2 节的「为什么」）
- [x] 2. `extensions/superpi-rules.ts`：`before_agent_start` + `/superpi-rules`
- [x] 3. `index.js`：`GET/POST /rules`、`POST /rules/reset`、`SELF_FILES` 登记 `extensions/superpi-rules.mjs`（runtime:true）与 `extensions/superpi-rules.ts`（runtime:false）
- [x] 4. `client.js`：`api.rules / setRules / resetRules`、`RulesSheet`、`SettingsSheet` 规则区、i18n、CSS
- [x] 5. `extensions/superpi-editor.ts`：`SETTINGS_COMMANDS` 加 `rules`（标注 `source: 'superpi'`）
- [x] 6. `tools/install-pi-extension.mjs`：三文件安装 / 状态 / 卸载
- [x] 7. `test/rules.mjs`（新增）+ 扩展 `test/client-render.mjs` / `test/tui-editor.mjs` / `test/parity.mjs`
- [x] 8. `package.json` 版本 0.10.0 + `CONTRACT_VERSION` + `npm test` 增加第 14 项
- [x] 9. `README.md` / `AGENTS.md` / `docs/parity.md` 同步
- [x] 10. `npm test` 全绿 → 本地提交 → `npm run sync`

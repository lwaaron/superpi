# dsh-pi UI 规格书：DSH 设计令牌对齐与目录选择器交互

| 项 | 值 |
| --- | --- |
| 文档版本 | 1.2 |
| 代码基线 | `client.js` 5619 行 / 307602 B / sha256 前 12 位 `ACDCFE28FDFB` |
| 版本号 | `package.json` version = **0.6.4**（`index.js` 的 `CONTRACT_VERSION` 同为 `0.6.4`；0.6.0 新增助手文本里的文件路径标签与 Composer 任意文件插入，0.6.1 新增类型图标文件标签、右键资源管理器定位与统一的 `CloseButton`，0.6.2 把 composer 换成宿主主对话区的卡面 + 圆形按钮 + `+` 菜单 + 底部统计行，0.6.3 修 composer 首次进入统计行无数字与统计行混入会话路径，0.6.4 把「思考块 + 工具行」重做成 DSH 会话流的过程行：思考 = 父行、工具调用 = 缩进子行组、工具结果并入调用行、末尾工作状态行（该行按 DSH `RunningStatus` 收尾：`--dsw-alias-label-deep-diving` 蓝字 + 16 网格鲸鱼尾 + `···`）。附录 A 的行号已整体刷新到 0.6.4 实测值） |
| 设计系统基线 | DSH 客户端样式包 `index-lh_YM6sT.css`（87124 字符 / 748 条规则 / 17 个 `@keyframes`）与 `tokens.txt`（414 个 `--dsw-*` 令牌，浅深两套值） |
| 采集口径 | 全部数值由脚本从仓库文件与探针文件读出；两种字符口径（源文本 / 门禁还原文本）分别标注 |
| 适用范围 | 只描述样式令牌、组件规格与目录选择器交互。不改任何源码，本文件是**规格**而非实现 |

> **行号会漂移。** `client.js` 在取证期间被并发改写多次：0.5.0 因历史会话抽屉拆成容器 + 视图涨到 4130 行，0.6.0 又因文件标签与任意文件插入涨到 4556 行，0.6.1 因类型图标、`CloseButton` 与资源管理器定位涨到 4789 行，0.6.2 因 composer 重做涨到 4873 行，0.6.3 又因 composer 首帧统计与 dock 归位涨到 5170 行，0.6.4 因过程流按 DSH 会话过程流重做涨到 5572 行，同日又把末尾工作状态行按 DSH `RunningStatus` 收尾涨到 5614 行、把中文用时单位之间的半角空格去掉后涨到 5619 行，同日又给工作状态行的首帧加了 `Math.max(1000, …)` 钳位（不钳位首帧会闪「0秒」，与 DSH `RunningStatus` 的 `formatRunDuration(Math.max(1e3, now - startTime), t)` 同一处理）涨到 5619 行。**附录 A 的行号已整体刷新到 0.6.4 实测值**；正文其余段落里的行号仍是取证当时（0.5.x / 4130 行）的快照，读者若在当前版本上找不到对应行，请用类名 grep 定位（例如搜 `dsh-pi-dir-cols`），类名是稳定锚点，行号不是。样式令牌与尺寸规格不受行号漂移影响。

---

## 1 目的与范围

### 1.1 目的

dsh-pi 是 DSH 侧栏里的 pi 面板，它的视觉必须与宿主 DSH 属于同一个设计系统：同一套颜色语义、同一套字号阶梯、同一套圆角与阴影、同一套状态色。做不到这一点，面板就会像一个外挂 iframe 贴在界面上。

本规格书解决三件具体的事：

1. **令牌纪律**：哪些 `--dsw-*` 允许用、每个令牌负责什么语义、哪些令牌禁止引用、外部变量必须怎么写兜底。
2. **组件对齐**：每个 `.dsh-pi-*` 类对应 DSH 的哪个组件、依据是 `index-lh_YM6sT.css` 里的哪条规则、几何与状态差异在哪。
3. **目录选择器**：DSH 的 directory-picker 是一个有明确交互契约的组件（Miller 分栏、前缀过滤、目标路径优先级）。dsh-pi 的 `DirSheet` 是它的对等物，交互必须写死，否则每改一次都会漂。

### 1.2 在范围内

- `client.js` 内联 CSS 数组（`:443` – `:769`）的每一条规则。
- 148 个 `.dsh-pi-*` 类名与 74 个唯一 CSS 变量的对应关系。
- 12 个组件族的规格：几何、令牌、状态、与 DSH 的差异。
- `DirSheet` / `dirPickModel` 的完整交互规格与宿主契约。
- 两道门禁（`test/css-tokens.mjs`、`test/client-render.mjs`）覆盖了什么、没覆盖什么。

### 1.3 不在范围内

- 不改 `client.js`、`index.js`、`test/*`。本文件只写规格，实现差异如实标注为「差异」而不是顺手修掉。
- 不描述 pi 子进程的 RPC 协议（那是 `docs/parity.md` 的范围）。
- 不描述 DSH 自身的组件实现（那是 DSH 仓库的范围）。引用 DSH 时只引 `index-lh_YM6sT.css` 的规则原文与 `tokens.txt` 的令牌值。
- 不评估视觉美观。本文只判定「是否有据可依」「是否与 DSH 一致」。

### 1.4 基线快照

| 文件 | 行数 | 字节 | mtime (UTC) |
| --- | --- | --- | --- |
| `client.js` | 5619 | 307602 | 2026-11-14T22:47:12Z |
| `index.js` | 1548 | 72204 | 2026-11-14T21:32:21Z |
| `package.json` | 77 | 2632 | 2026-11-14T21:32:21Z |
| `test/css-tokens.mjs` | 597 | 28485 | 2026-11-14T21:28:10Z |
| `test/client-render.mjs` | 821 | 64596 | 2026-11-14T22:46:50Z |
| `src/rpc-contract.mjs` | 324 | 19650 | 2026-11-13T04:50:45Z |

`docs/` 目录在本文件创建前只有 `parity.md`（现 281 行 / 61584 B）。

---

## 2 令牌来源与采集方法

### 2.1 四个数据来源

| 编号 | 来源 | 位置 | 规模 | 用途 | 可信度 |
| --- | --- | --- | --- | --- | --- |
| S1 | DSH 组件规则 | `_probe/dsh-css/index-lh_YM6sT.css` | 87124 字符 / 748 条规则 / 17 个 `@keyframes` | 组件级对齐依据（几何、状态、动效） | A：原始产物，逐条原文可 grep |
| S2 | DSH 令牌表 | `_probe/dsh-theme/tokens.txt` | 414 个 `--dsw-*`，格式 `name = 浅 | 深` | 令牌值、浅深两套、别名链 | A：原始产物 |
| S3 | DSH 目录选择器源码 | `_probe/dsh-picker/client.js` | 1138 行，CSS 在 `:26` 单行内联，hash 前缀 `_3zXc5G_` | Miller 分栏、`visibleEntries`、目标路径优先级 | A：原始产物 |
| S4 | dsh-pi 现状 | `client.js` 的 CSS 数组 `:443` – `:769` | 240 段字符串 / 148 个 `.dsh-pi-*` 类 | 现状记录与逐类映射 | A：仓库文件 |

探针目录 `_probe/` 在 `C:/Users/PC/Documents/pi-local/` 下，不在 `dsh-pi` 仓库内。它是采集时的快照，不是构建产物；S1–S3 的内容可能随 DSH 升级变化，届时需要重新采集。

### 2.2 两种字符口径

同一个 CSS 数组有两个长度，永远说清是哪个：

| 口径 | 值 | 含义 | 谁在报 |
| --- | --- | --- | --- |
| 源文本 | 35680 字符 | 240 段 JS 单引号字面量还原后的长度之和（0.6.4 起 CSS 里没有转义序列，故与还原文本相等） | 人工统计 |
| 还原文本 | 35680 字符 | 去掉引号、还原 `\'` 与 `\uXXXX` 转义后的浏览器实际 CSS 文本 | 门禁 `test/css-tokens.mjs` 主流程 `:447` 的 `extractCss(source)`，输出第 3 行「CSS 数组 240 段 / 35680 字符」 |

0.6.4 起两个数相等（35680）：CSS 里已无 `\'` 与 `\uXXXX` 转义，源文本与浏览器实际解析到的文本逐字符相同。**报告与评审一律引用还原文本 35680**，因为它才是浏览器解析的东西。

### 2.3 可信度分级

- **A 级**：直接从文件读出的原文或统计值。本文绝大多数结论属此类。
- **B 级**：从 A 级数值推算出的判断（例如「dsh-pi 的 74 个变量里 70 个是 `--dsw-*`，说明令牌纪律覆盖了 94.6%」）。
- **C 级**：无法从文件证实、只能标注「待确认」的项。全文共 4 条，集中在附录 C。

### 2.4 复现命令

```
cd C:/Users/PC/Documents/pi-local/dsh-pi
node test/css-tokens.mjs     # 令牌门禁，期望 PASS (98 checks)
node test/client-render.mjs  # 渲染门禁，期望 PASS (738 assertions)
```

两条命令都离线可跑，不打真实 LLM，不进 `npm test` 的耗时大头。`npm test` 共十一项，顺序是 `selfcheck → client-render → css-tokens → runtime-resolve → config-hot → host-parity → session-projects → timeout → parity → restart-lib → version`。

### 2.5 引用约定

- DSH 规则一律写完整选择器：`._switch_1ik0f_5`、`._thumb_1ik0f_33`。hash 后缀不是噪音，它区分同名族。
- 令牌名首次出现写全名 `--dsw-alias-label-primary`，同节后续可缩写为 `label-primary`。
- `--dsh-*` 与 `--ds-*` 不是 DSH 设计令牌，是宿主注入的运行时变量，引用时必须带第二个参数兜底。

---

## 3 令牌三层清单

### 3.1 三层划分

`client.js` 的 CSS 数组用到 74 个唯一 CSS 变量。`var(` 在 CSS 文本里出现 **356 次**，其中 5 次是兜底位置里嵌套的 `var()`（`var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))` 与 `var(--dsh-content-font-size,var(--dsw-font-s-14-font-size))` 两类），所以门禁按「顶层引用」计 **351 处 / 74 个唯一变量**。本文正文的用量表用 356（含嵌套，逐次可数），门禁汇总行印 351。按「换主题时应不应该跟着变」切成三层，另有两类不便归入主题语义的令牌单列：

| 层 | 数量 | 判据 | 换浅/深色时 |
| --- | --- | --- | --- |
| Tier A 几何与字体 | 20 | 只表达尺寸、字号、字重、圆角 | 不变（除 `font-family` 由主题给） |
| Tier B 颜色别名 | 39 | 全部是 `--dsw-alias-*`，表达语义色 | **必须变**，这是主题切换的全部意义 |
| Tier C 阴影与特殊 | 6 | 阴影、焦点环、毛玻璃 | 部分变（`elevation-*` 只有描边色随主题） |
| Tier D `--dsw-specific-*` | 4 | 组件私有底色（气泡 / 输入卡 / 菜单 / 下拉），语义上不属于上面三层 | 随主题变，但只有对应组件能用 |
| Tier E `--dsw-static-*` | 1 | `static-neutral-bluish-00`，不随主题变 | 恒为 `#fff` |
| 合计 | 70 | 全部 `--dsw-*` | — |
| 外部兜底 | 4 | `--dsh-*` 3 个 + `--ds-*` 1 个 | 宿主注入，不归 dsh-pi 管 |

20 + 39 + 6 + 4 + 1 = 70，与「74 个唯一变量减去 4 个外部变量」完全吻合，没有游离令牌。

### 3.2 Tier A：几何与字体（20 个）

| 令牌 | 值 | 用在哪 |
| --- | --- | --- |
| `--dsw-font-family` | 主题给的字体栈 | `.dsh-pi-root`、`.dsh-pi-fence-lang` |
| `--dsw-font-base-strong-16` | `500 16px/24px var(--dsw-font-family)` | 标题：`.dsh-pi-empty h2`、`.dsh-pi-sheet-title`、`.dsh-pi-gate-card h3`、`.dsh-pi-dir-title`、`.dsh-pi-dialog h3` |
| `--dsw-font-markdown-code-block` | 11px / 19px + delta 的可变字体串 | `.dsh-pi-fence`、`.dsh-pi-pre` |
| `--dsw-font-markdown-code-block-small` | 同族 16px 档 | `.dsh-pi-code-inline` |
| `--dsw-font-markdown-h3` | `700 calc(18px + d)/calc(26px + d)` | `.dsh-pi-prose h3` |
| `--dsw-font-s-14-font-size` / `-line-height` | 14px / 22px | 根、品牌、气泡、正文、textarea、开关标签 |
| `--dsw-font-xs-13` | 13px/20px 简写 | `.dsh-pi-mini-ta` |
| `--dsw-font-xs-13-font-size` / `-line-height` | 13px / 20px | 菜单项、目录项、思考块、对话框选项 |
| `--dsw-font-xxs-12-font-size` / `-line-height` | 12px / 18px | 按钮、下拉、搜索框、会话行、提示条 |
| `--dsw-font-xxxs-11-font-size` / `-line-height` | 11px / 14px | chip、tag、usage、状态栏、注释类文本 |
| `--dsw-radius-xs` | 4px | inline code、缩略图关闭键、面包屑段 |
| `--dsw-radius-sm` | 8px | 按钮、搜索框、菜单、目录项、widget |
| `--dsw-radius-md` | 12px | 工具行、菜单项、目录栏容器、会话卡、对话框选项 |
| `--dsw-radius-lg` | 16px | 输入框外壳、代码块、弹出菜单、gate 卡 |
| `--dsw-radius-xl` | 20px | 用户气泡 |
| `--dsw-radius-panel` | 28px | 目录弹窗、对话框 |

几何层没有一条硬编码像素值是可省的：`36px` 的开关宽、`20px` 的高这些属于组件内部几何，写在规则体里而不是新建令牌，因为 DSH 自己也是这么写的（`._switch_1ik0f_5` 直接写 `width:36px;height:20px`）。

### 3.3 Tier B：颜色别名（39 个）

全部是 `--dsw-alias-*`。按语义分组：

| 组 | 令牌 | 主用途 |
| --- | --- | --- |
| 底色 | `bg-base`、`bg-layer-1`、`bg-layer-2`、`bg-layer-3`、`bg-module-platform` | 根、输入框外壳、会话卡、菜单项、chip 底 |
| 遮罩 | `bg-mask-1`、`bg-mask-2`、`bg-mask-photo` | 对话框底罩、缩略图关闭键、图片放大层 |
| 描边 | `border-l1`、`border-l2`、`border-l3`、`border-l4` | 菜单局部描边、抽屉分隔、输入框主边框、按钮描边 |
| 文本 | `label-primary`、`label-secondary`、`label-tertiary`、`label-caption`、`label-dimmed`、`label-primary-foreground`、`label-deep-diving` | 六级文本层次 + 工作状态行的「深度求索」蓝（`color-mix(in srgb, deepseek-500 70%, blue-950)` ⇒ `#345EBA`） |
| 交互 | `interactive-bg-hover`、`interactive-bg-active`、`interactive-bg-hover-danger`、`interactive-bg-hover-solid` | hover / 选中 / 危险 hover / composer 各圆形键的实底 hover |
| 主色 | `brand-primary`、`button-primary-fill`、`button-primary-hover`、`button-info-fill`、`button-info-hover` | 开关开启态、主按钮三态、发送键两态（`button-info-*` 指向 `static-deepseek-500/400`） |
| 状态 | `state-business-primary`、`state-error-primary`、`state-success-primary`、`state-warn-primary`、`state-idle-primary` | 焦点环、标签 four tone、状态点 |
| 代码 | `markdown-code-block`、`markdown-code-block-banner`、`markdown-inline-code` | 代码块三段 |
| 滚动条 | `scrollbar-bg-l2`、`scrollbar-hover-l2` | 根上重绑给 `--dsh-scrollbar-thumb` |
| 开关 | `switch-thumb` | 开关关闭态滑块 |

六级文本层次是这套系统里最值得注意的设计：`primary` → `secondary` → `tertiary` → `caption` → `dimmed` 再分 `primary-foreground`，每一级都有明确职责，不允许「随便挑一个灰」。dsh-pi 的用法是：

- `primary`：正文、被选中的项、当前值；
- `secondary`：次要说明、按钮默认态、下划线文字；
- `tertiary`：键名、路径、语义提示；
- `caption`：计量信息（token 数、耗时）、页脚提示；
- `dimmed`：占位符、禁用、分隔符、弱化符号；
- `primary-foreground`：主色底上的文字（主按钮、开关滑块）。

### 3.4 Tier C：阴影与特殊（6 个）

| 令牌 | 值 | 用在哪 |
| --- | --- | --- |
| `--dsw-elevation-panel` | 描边 + `0 3px 8px 0 #00000008, 0 0 16px 0 #00000005` | 弹出菜单、gate 卡 |
| `--dsw-elevation-prominent` | 描边 + `0 3px 8px 0 #0000000a, 0 0 20px 0 #0000000d` | 目录弹窗、通用对话框 |
| `--dsw-elevation-soft` | 描边 + `0 4px 16px 0 #00000008, 0 0 24px 0 #00000008` | composer 卡面（`.dsh-pi-box`）：最轻的一档，卡片浮起但不抢焦点 |
| `--dsw-focus-ring-color` | `transparent`（单值） | 根上被重绑为 `var(--dsw-alias-state-business-primary)` |
| `--dsw-focus-ring-width` | `2px` | 全局 `:focus-visible` 描边宽度 |
| `--dsw-menu-backdrop-filter` | `blur(40px) saturate(150%)` | 弹出菜单毛玻璃 |

`--dsw-specific-*`（4 个：bubble / input-major / menu / selector）与 `--dsw-static-neutral-bluish-00`（1 个）不属「阴影与特殊」，已单列为 §3.1 的 Tier D / Tier E。

**`focus-ring-color` 是这套系统里唯一的坑。** DSH 把 `--dsw-focus-ring-color` 定义成 `transparent`（等于「默认不要焦点环」），所有 DSH 组件都在规则里写 `outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))` —— 靠 `var()` 的第二个参数兜底。dsh-pi 在 `.dsh-pi-root` 上直接把这个变量重绑成 `state-business-primary`（`client.js:449`），于是整个子树拿到的是真色值，`var()` 的第二参数永远不生效但保留着，作为「万一宿主改了」的保险。这是刻意设计，注释 `client.js:446-448` 写明了理由。

### 3.5 外部兜底令牌（4 个）

四个都不是 DSH 设计令牌，是宿主或内容层注入的变量，必须带兜底：

| 令牌 | 来源 | 兜底 | 出现次数 |
| --- | --- | --- | --- |
| `--dsh-content-font-size` | DSH 内容字号（用户可在设置里调） | `var(--dsw-font-s-14-font-size)` | 4 |
| `--dsh-content-font-size-secondary` | 同上，次级正文档（DSH 会话流的过程行文字） | `13px` | 1 |
| `--dsh-content-font-delta` | 同上，字号增量 | `0px` | 7 |
| `--ds-font-family-code` | DSH 等宽字体栈 | `ui-monospace,SFMono-Regular,Menlo,Consolas,monospace` | 11 |

四者的用法固定成模板，任何新代码都必须照抄：

```css
font-size:var(--dsh-content-font-size,var(--dsw-font-s-14-font-size));
line-height:calc(22px + var(--dsh-content-font-delta,0px));
font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);
```

`test/css-tokens.mjs` 第 3 节（`:567`）会硬断言：任何非 `--dsw-*` 变量出现在 `var()` 里而没带第二个参数，直接判失败。这条规则防的是「宿主没注入就整块样式失效」。

### 3.6 用量总表

`var(` 共出现 356 次（含 5 次兜底嵌套，门禁顶层引用计 351 处），按次数降序（前 22）：

| # | 令牌 | 次数 |
| --- | --- | --- |
| 1 | `--dsw-alias-label-primary` | 28 |
| 2 | `--dsw-font-xxxs-11-font-size` | 23 |
| 3 | `--dsw-alias-label-secondary` | 20 |
| 4 | `--dsw-alias-state-business-primary` | 17 |
| 5 | `--dsw-alias-label-caption` | 13 |
| 6 | `--dsw-alias-label-tertiary` | 13 |
| 7 | `--dsw-alias-state-error-primary` | 13 |
| 8 | `--dsw-font-xxs-12-font-size` | 12 |
| 9 | `--dsw-radius-sm` | 12 |
| 10 | `--ds-font-family-code` | 11 |
| 11 | `--dsw-alias-interactive-bg-hover` | 11 |
| 12 | `--dsw-font-xxs-12-line-height` | 9 |
| 13 | `--dsw-font-xxxs-11-line-height` | 9 |
| 14 | `--dsw-alias-border-l3` | 8 |
| 15 | `--dsw-alias-state-warn-primary` | 8 |
| 16 | `--dsw-font-s-14-font-size` | 8 |
| 17 | `--dsh-content-font-delta` | 7 |
| 18 | `--dsw-alias-state-success-primary` | 7 |
| 19 | `--dsw-radius-md` | 7 |
| 20 | `--dsw-alias-bg-layer-2` | 6 |
| 21 | `--dsw-font-xs-13-font-size` | 6 |
| 22 | `--dsw-font-xs-13-line-height` | 6 |

长尾 52 个各 1–5 次。用量分布说明一件事：**文本与语义色是主体，几何令牌是配角。** 前 7 名里 5 个与颜色有关，两个字号令牌（11px / 12px）合计 35 次（23 + 12），是这套 UI 里出现最频繁的字号。这也解释了为什么 DSH 的界面看起来「信息密度高但不乱」——它把最小的两档字号当主力，用颜色层次而不是字号层次来分组。

### 3.7 组件 → 令牌矩阵

单元格是该组件**专属**的令牌（通用文本/圆角不重复列）。

| 组件 | 专属令牌 |
| --- | --- |
| 根容器 | `state-business-primary`（重绑焦点环）、`scrollbar-bg-l2`、`scrollbar-hover-l2` |
| 头栏 | `border-l3`、`state-idle/success/business/error-primary`（状态点） |
| chip 胶囊 | `bg-module-platform`、`state-success/warn/error-primary`（tone） |
| 按钮族 | `button-primary-fill`、`button-primary-hover`、`label-primary-foreground`、`interactive-bg-hover-danger`、`border-l4` |
| 消息流 | `specific-bubble`（用户气泡） |
| 代码块 | `markdown-code-block`、`markdown-code-block-banner`、`markdown-inline-code` |
| 工具行 | `border-l3`（左侧竖线）、`--ds-font-family-code` |
| 状态标签 | `bg-module-platform` + 四 tone 状态色 |
| 空态 / gate | `elevation-panel`、`bg-layer-1` |
| 输入区卡面 | `specific-input-major`（底）、`elevation-soft`（投影）、`radius-panel`（28px）、`specific-selector`（picker）、`button-info-fill` / `button-info-hover`（发送键两态）、`interactive-bg-hover-solid`（圆形 + 键 hover）、`bg-layer-2`（widget） |
| 过程行 | `label-tertiary`（标签 / 摘要 / 图标 / 展开体）、`label-caption`（中点）、`border-l3`（左侧竖线）、`state-business-primary`（运行中点）、`state-error-primary` / `state-warn-primary`（失败 / 警告）、`--dsh-content-font-size-secondary`（13px 行文字） |
| 工作状态行 | `label-deep-diving`（文字与鲸鱼尾同色，`#345EBA`）、`border-l3`（上 hairline） |
| 弹出菜单 | `specific-menu`、`menu-backdrop-filter`、`elevation-panel`、`border-l1` |
| 抽屉 | `bg-base`、`bg-layer-1/2`、`border-l2/l4` |
| 开关 | `brand-primary`、`border-l3`、`switch-thumb`、`label-primary-foreground` |
| 目录选择器 | `bg-layer-1`（栏容器）、`border-l2`、`interactive-bg-active`（选中）、`state-business-primary`（当前） |
| 对话框 | `radius-panel`、`bg-layer-2`、`elevation-prominent`、`bg-mask-1` |

### 3.8 禁止引用：七条

门禁 `test/css-tokens.mjs` 的七条硬断言，逐条说明它防的是什么：

| # | 断言 | 行号 | 防的是什么 |
| --- | --- | --- | --- |
| 1 | 硬色值 | `:557` | `#hex`、`rgb()`、`rgba()`、`hsl()`、`hsla()`、命名色一律禁止。硬色值意味着那一块永远不随主题变。 |
| 2 | 令牌白名单 | `:561` | 只许 `--dsw-*` 与 `ALLOWED_EXTRA_TOKENS` 里的 7 个（`--ds-font-family-code`、`--dsh-content-font-size`、`--dsh-content-font-size-secondary`、`--dsh-content-font-delta`、`--dsh-code-font-size`、`--dsh-code-font-delta`、`--dsw-elevation-stroke-color`）。防止有人写 `var(--my-color)`。 |
| 3 | 兜底 | `:567` | 非 `--dsw-*` 必须带第二个参数。 |
| 4 | 禁用令牌 | `:573` | `--dsw-alias-button-tool-bar-fill`、`--dsw-alias-button-tool-bar-hover` 在 `tokens.txt` 里是硬值 `#54555780` / `#54555799`，不是别名，引用它们等于引用硬色值。 |
| 5 | 等宽字体栈 | `:577` | `ui-monospace` / `SFMono-Regular` / `Menlo` / `Consolas` / `monospace` 只许出现在 `var(--ds-font-family-code, …)` 的兜底位。 |
| 6 | 焦点可见 | `:581` | 必须有 `:focus-visible` 规则且用 `--dsw-focus-ring-*`。防止 `outline:none` 一刀切。 |
| 7 | 减少动效 | `:585` | 必须有 `@media (prefers-reduced-motion: reduce)` 兜底。 |

门禁还有 18 条自检（`:423-438` 的 `selfTest`），用合成样例验证正则本身没写错。没有自检的门禁最危险：正则写挂了，全绿，没人知道。

除七条硬断言外，门禁还输出观察项（`:465-485`）：规则条数、字符数、`var()` 调用数、唯一变量数、按类别分布。这些不判失败，只作为「变了多少」的对比基准。

---

## 4 组件规格（12 节）

每节五段：**来源**（首行固定格式，指向 `index-lh_YM6sT.css` 的规则）→ **令牌** → **几何** → **状态** → **差异**。

「差异」一栏只写事实，不写「建议」。可改可不改的判断集中放在第 6 章与附录 B。

### 4.1 根容器与全局基线

**来源：index-lh_YM6sT.css 的 ._pane_3oazc_211 与 ._switch_1ik0f_5:focus-visible**

`.dsh-pi-root`（`client.js:449`）是整个面板的根，它做四件事：铺底色、立字体基线、重绑两个宿主变量、立全局三条基础规则。

**令牌**：`bg-base`、`label-primary`、`font-family`、`font-s-14-font-size`、`font-s-14-line-height`、`scrollbar-bg-l2`、`scrollbar-hover-l2`、`state-business-primary`（重绑焦点环）。

**几何**：`display:flex` / `flex-direction:column` / `height:100%`。没有 padding、没有圆角、没有阴影——它是容器不是卡片。DSH 的 `._pane_3oazc_211` 也是同一套：`display:flex;flex:1 1 auto;flex-direction:column;min-width:0;min-height:0;overflow:hidden`。两者的共同点是**把滚动交给子元素**，根节点自己 `overflow:hidden`。

**三条全局规则**：

| 行号 | 规则 | 作用 |
| --- | --- | --- |
| `:450` | `.dsh-pi-root *{box-sizing:border-box}` | 面板是独立子树，不能假设宿主已经设过 |
| `:451` | `:is(button,input,select,textarea){font-family:inherit}` | 浏览器对表单控件默认给系统字体，不继承会突然出现另一种字形 |
| `:452` | `:is(button,input,select,textarea,summary,a,[tabindex]):focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,…);outline-offset:2px}` | 用属性选择器兜住所有可聚焦元素，而不是逐个类名写 |

**状态**：根节点没有状态。状态全在子元素上，通过 `data-*` 属性表达（`data-state`、`data-tone`、`data-selected`、`data-current`、`data-active`、`data-clickable`、`data-leaf`、`data-disabled`、`data-focus`、`data-drive`、`data-pc`、`data-last`）。这套约定让状态切换只改属性不改类名，CSS 选择器保持稳定。

**差异**：

1. DSH 的 `._pane_3oazc_211` 不含底色调，底色由更上层的 surface 决定；dsh-pi 的根自己铺 `bg-base`。因为面板要能独立存在于侧栏，不能假设父级已经铺过底。
2. `:452` 用 `[tabindex]` 兜底，DSH 用逐组件写 `:focus-visible`。ds-pi 的做法覆盖面更广但也更容易和宿主的环叠加——目前不会，因为面板在独立 iframe/容器里。
3. 根上重绑 `--dsh-scrollbar-thumb` / `--dsh-scrollbar-thumb-hover` 是 dsh-pi 独有，DSH 的 `._list_1p5el_7` 也做同样的事（局部重绑滚动条色），属于同一手法。

### 4.2 头栏与状态点

**来源：index-lh_YM6sT.css 的 ._dot_1i3xo_2**

**令牌**：`.dsh-pi-head` → `border-l3`；`.dsh-pi-brand` → `font-s-14-*` + `label-primary`；`.dsh-pi-dot` → 五色状态（`state-idle-primary` 默认、`ready` 用 `state-success-primary`、`busy` 用 `state-business-primary`、`dead` 用 `state-error-primary`）。

**几何**：头栏 `border-bottom:.5px solid`，高由内容撑（品牌 14px 行高 22px + 6px 纵向 padding 左右）。状态点是 `7px × 7px` 实心圆，`border-radius:50%`。

**状态**：四个取值，靠 `data-state` 切换：

| 属性值 | 颜色令牌 | 附加动效 |
| --- | --- | --- |
| 无（默认） | `state-idle-primary` | 无 |
| `ready` | `state-success-primary` | 无 |
| `busy` | `state-business-primary` | `animation:dsh-pi-pulse 1.2s` |
| `dead` | `state-error-primary` | 无 |

`@keyframes dsh-pi-pulse`（`:462`）只动 `opacity`：`0%,100%{opacity:1} 50%{opacity:.35}`。没有 scale、没有位移。这与 DSH 全部 17 个 keyframes 的风格一致——除 `_spin_u7vgf_45`、`_dsh-state-dot-spin_1i3xo_1`、`_dsh-state-dot-dash_1i3xo_1` 三个旋转类之外，**其余 14 个都只动 opacity**。

**差异**：

1. **形态不同**。DSH 的 `._dot_1i3xo_2` 是一个空 span + `:after{position:absolute;inset:20%;border-radius:50%;corner-shape:round;background:currentColor}`，颜色通过 `color` 传递；dsh-pi 的 `.dsh-pi-dot` 是实心圆直接写 `background`。两者视觉接近但机制不同：DSH 的写法让点的尺寸由外层容器决定（`inset:20%` 自动留白），dsh-pi 的写法把 7px 写死。
2. **状态名不同**。DSH 是 `done` / `warning` / `error` / `idle`；dsh-pi 是 `ready` / `busy` / `dead` / 默认。这不是错误，dsh-pi 的状态语义来自 pi 子进程的存活状态，与 DSH 的任务状态不是一回事。
3. DSH 还有配套的 `._spinner_1i3xo_37` 与 `._spinnerMotion`（1.5s 线性旋转），dsh-pi 没有旋转指示器，busy 靠透明度脉冲。

### 4.3 chip 胶囊与 tag 标签

**来源：index-lh_YM6sT.css 的 ._tag_brmue_4**

chip 与 tag 是同一族视觉：小圆角胶囊 + 极小字号 + 语义色。区别是 chip 用于「会话名 / 模型名」这类可点击的标识，tag 用于「运行中 / 完成 / 失败」这类纯状态。

**令牌**：`bg-module-platform`（底）、`label-secondary`（默认字）、`font-xxxs-11-*`（字号行高）、四 tone 用 `state-business/success/error/warn-primary`。

**几何**：

| 属性 | chip | tag | DSH `._tag_brmue_4` |
| --- | --- | --- | --- |
| 高度 | `20px` | `17px` | 由 `padding:1px 8px` + `line-height:17px` 推出 ≈ 19px |
| padding | `1px 8px` | `1px 8px` | `1px 8px` |
| 圆角 | `999px` + `corner-shape:round` | `999px` | `999px` + `corner-shape:round` |
| 字号 | 11px / 14px | 11px / 14px | 11px / 17px |
| 字重 | 500 | 500 | 500 |
| 最大宽度 | `220px`（超出省略） | 无 | `white-space:nowrap` |

**状态**：chip 三种 tone（`ok` / `warn` / `err`）+ 可点击态（`data-clickable="1"` 时 hover 转 `interactive-bg-hover` 且文字转 `label-primary`）；tag 四种 tone（`run` / `ok` / `err` / `warn`）。

tone 色的实现统一用 `color-mix(in srgb, <state-color> N%, transparent)`，其中 success / err / run 用 **10%**、warn 用 **12%**。DSH 的 `._tag_brmue_4[data-tone=success]` 也用 `color-mix(… 10%, transparent)`，两者数值一致；DSH 另有 `outline` / `solid` / `neutral` / `quiet` 四种 tone 形态（描边、实底、中性底、纯文字），dsh-pi 没有采纳。

**差异**：

1. **tag 的 tone 语义比 DSH 少一半**。DSH 有 8 种 tone（outline / solid / neutral / quiet / success / info / warning / danger），dsh-pi 只有 4 种且全是语义色。在当前面板里够用，但如果将来要表达「中性标签」就得回来补。
2. **chip 高度是写死的 20px**，DSH 靠 padding + line-height 推。写死的好处是行高严格可控，坏处是字号一变就挤。
3. **chip 有 max-width 与省略号**，DSH 的 tag 用 `nowrap` 不截断（tag 通常很短）。这是合理的分歧：会话名可能很长，tag 不会。
4. **tag 的高度写死 17px**，但 `line-height` 也是 17px，两者相等意味着没有上下留白。DSH 用 `line-height:17px` + `padding:1px` 得到约 19px。视觉上 dsh-pi 的 tag 比 DSH 矮 2px。

### 4.4 按钮族

**来源：index-lh_YM6sT.css 的 ._button_1ulci_2 / ._sm_1ulci_28 / ._primary_1ulci_36 / ._outline_1ulci_56**

**令牌**：`.dsh-pi-btn` → `radius-sm`、`border-l4`、`label-primary`、`font-xxs-12-*`；hover `interactive-bg-hover`；active `interactive-bg-active`；`-primary` → `button-primary-fill` + `label-primary-foreground`，hover/active `button-primary-hover`；`-danger` → `state-error-primary`，hover `interactive-bg-hover-danger`；`-ghost` → `label-secondary`，hover 加 `label-primary`。

**几何**：

| 属性 | dsh-pi `.dsh-pi-btn` | DSH `._button_1ulci_2` + `._sm_1ulci_28` |
| --- | --- | --- |
| 高度 | `28px` | `._md` 36px / `._sm` 28px |
| padding | `0 10px` | `._sm` `0 10px` |
| 圆角 | `radius-sm`（8px） | `._sm` `radius-sm` |
| 字号 | 12px / 18px | `._sm` 12px / 18px |
| 描边 | `box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l4)` | `._outline` `box-shadow:inset 0 0 0 var(--dsh-hairline-width,.5px) var(--dsh-button-outline-color, border-l3)` |
| 禁用 | `opacity:.4` | `opacity:.4` + `cursor:not-allowed` |
| 图标 | `svg{width:15px;height:15px}` | 无统一规则 |

`-primary` 的 padding 单独覆盖为 `0 14px`（DSH `._button` 基类的 `padding:0 14px`），因为主按钮通常承担确认动作，视觉上要更宽一点。`-icon` 变体固定 `width:28px`（正方）。

**状态**：默认、hover、active、disabled 四态；`-primary` / `-danger` / `-ghost` / `-icon` 四个变体。所有 hover 都带 `:not(:disabled)`，避免禁用态仍有反馈。

**差异**：

1. **描边色不同**：DSH `._outline` 默认用 `border-l3`（可被 `--dsh-button-outline-color` 覆盖），dsh-pi 固定用 `border-l4`。`l4` 比 `l3` 更浅一档（浅色主题 `#00000029` vs `#0000001f`）。视觉上 dsh-pi 的按钮边框更弱。
2. **没有 `_md` 36px 档**：dsh-pi 全部按钮统一 28px。面板里没有需要 36px 的场景，统一反而更整齐。
3. **`_ghost` 去掉描边**：DSH 的 ghost 保留 `border:none` 但仍有 `background:transparent`，dsh-pi 的 ghost 连内阴影描边一起去掉。空心 × 按钮、图标按钮用这个变体。
4. **hover 未包 `@media (hover:hover)`**：DSH 的 `._item_1p5el_105` 与 `._button_1ulci_2` 都把 hover 包在 `@media(hover:hover)` 里，防止触屏设备「点击后 hover 黏住」。dsh-pi 没有包。这是可复现的触屏小瑕疵。

### 4.5 消息流：气泡、正文、代码块

**来源：index-lh_YM6sT.css 的 ._bubble_1sgyj_1 / ._card_1mqf1_1 / ._header_1mqf1_10 / ._body_1mqf1_81**

**令牌**：气泡 `radius-xl` + `specific-bubble` + `label-primary`；正文 `--dsh-content-font-size` / `--dsh-content-font-delta`；inline code `radius-xs` + `markdown-inline-code` + `font-markdown-code-block-small`；代码块 `radius-lg` + `markdown-code-block` + `font-markdown-code-block`；banner `markdown-code-block-banner`。

**几何**：

| 元素 | dsh-pi | DSH 原文 | 判定 |
| --- | --- | --- | --- |
| 用户气泡 | `max-width:82%` / `padding:10px 16px` / `radius-xl` | `max-width:100%` / `padding:10px 16px` / `radius-xl` | 一致，仅 max-width 不同 |
| 气泡行高 | `calc(22px + delta)` | `calc(22px + var(--dsh-content-font-delta,0px))` | 逐字一致 |
| 正文行高 | `calc(24px + delta)` | 无对应（DSH 正文由 markdown 层给） | dsh-pi 自定义 |
| 代码块 | `margin:16px 0` / `radius-lg` | `margin:16px 0` / `radius-lg` | 一致 |
| banner | `padding:10px 18px 8px 22px` | `padding:10px 18px 8px 22px` | **逐值一致** |
| 代码主体 | `padding:6px 22px 20px` | `padding:6px 22px 20px` | **逐值一致** |

代码块三段 padding 与 DSH 完全相同，这是对齐做得最彻底的一处。

**状态**：气泡只有用户态（`-user` 是独立类，不是变体），没有 hover/focus。代码块 `details` 无展开态（banner 常显）。

**差异**：

1. **banner 底色来源不同**。DSH：`background:var(--dsl-code-block-background, var(--dsw-alias-markdown-code-block))`，即优先用 `--dsl-*` 私有变量，否则退回代码块主底色（**banner 与 body 同色**）。dsh-pi：直接用 `--dsw-alias-markdown-code-block-banner`（**banner 比 body 浅一档**）。视觉上 dsh-pi 的代码块有更清晰的标题条。
2. **banner 字体不同**。DSH：`font:11px/18px var(--dsw-font-family)`（比例字体）；dsh-pi：`font-family:var(--dsw-font-family)` + `font-xxxs-11-*`（11px/14px）。行高差 4px，dsh-pi 的 banner 更紧。
3. **气泡 `max-width:82%`** 是 dsh-pi 独有。DSH 的气泡 `max-width:100%` 靠父容器给宽度。82% 让用户消息不会铺满整行，是常见的 IM 惯例。
4. **没有 `_actions` / `_status` / `_heading`**。DSH 的 `._card_1mqf1_1` 内有 `._heading_1mqf1_23`（语言名 + 标题）、`._actions_1mqf1_*`（复制按钮）、`._status_1mqf1_*`。dsh-pi 只有 `-fence-lang` 一个语言标签，没有复制按钮。

### 4.6 过程行（思考 / 工具调用 / 工具结果 / `!` bash）

**来源：DSH 会话过程流的实测截图 + `research/layout/dsh-client-ui-conversation__lib__client.js` 的 `tool.title.*` 标题表**

0.6.4 之前这一节叫「思考块与工具行」：思考是一个 `details` 折叠块（左侧 2px 竖线 + 13px 小字），工具调用是一条平铺行（`工具` 标签 + 工具名 + `结果` 标签）。0.6.4 按 DSH 宿主的过程流重做，因为原来那套把「模型的意图」和「模型的动作」摆成了同一层的两件东西。

**层级**：一次模型回合是父行（`details.dsh-pi-proc`，摘要只有首行），它之下的每次工具调用是缩进子行组（`div.dsh-pi-sub`，左 1px 竖线 + `margin-left:22px`，竖线正好落在父行图标框左缘）。纯文本 / 图片是正文块，**打断**分组 —— 文本之后再出现的调用重新起一组，不会挂到很久以前的思考下面。

**一次调用 = 一行**：工具结果不单独占一行。pi 把结果作为独立的 `toolResult` 消息送达，面板按 `toolCallId` 建派生表折叠进调用行的展开区（`── output ──`）；对不上号的孤儿结果仍按行渲染，不吞内容。展开区里的 `── live ──` 段**只在 `status === 'running'` 时出现**：跑完后 `partialResult` 与最终结果说的是同一件事，两段都印等于把输出写两遍（第一次实拍就撞上了这个）。

**令牌**：行文字（标签与摘要）`label-tertiary`、展开体 `label-tertiary`、图标 `label-tertiary`、中点 `label-caption`、竖线 `border-l3`、运行中圆点 `state-business-primary`、失败 `state-error-primary`、警告 `state-warn-primary`；字号 `--dsh-content-font-size-secondary`（13px，DSH 会话流的次级正文档，带兜底）。**颜色只取 `label-tertiary`，不是 `label-secondary`** —— 实拍后按目标图逐像素复查过：目标摘要实心色 = `rgb(129,133,140)`（`label-tertiary`），`label-secondary` 的 `rgb(97,102,107)` 肉眼可辨地偏深。

**几何**（`client.js:513-550`）：

| 元素 | 几何 |
| --- | --- |
| `.dsh-pi-proc` / `.dsh-pi-tool` | **无边框、无背景、无阴影**（`border-radius:0`），`display:block` |
| `.dsh-pi-proc-head` | `display:flex`、`align-items:center`、`line-height:calc(24px + delta)`、无 `padding`（行距由 `line-height` 给，24px 行高对实测的 24px） |
| `.dsh-pi-proc-icon` | 16×16 框、`margin-right:7px`（对齐实测：图标 12→20.5，标签 29） |
| `.dsh-pi-sep` | 2×2 圆点、`margin:0 8px`、`border-radius:1px`（不是圆，DSH 的「·」是 2px 方块） |
| `.dsh-pi-proc-text` | `flex:1 1 auto` + `text-overflow:ellipsis` 单行省略 |
| `.dsh-pi-proc-note` | 行尾状态（失败 / `exit N` / truncated），`tabular-nums` 防宽度跳动 |
| `.dsh-pi-proc-path` | 整路径可点：`text-decoration:underline 1px dotted`、`text-underline-offset:3px`、`color:inherit` |
| `.dsh-pi-sub` | `margin-left:22px`、`padding-left:8px`、`border-left:1px solid border-l3`、`gap:2px` |
| `.dsh-pi-proc-body` | `margin-left:22px`、`padding-left:14px`、`border-left:1px solid border-l3`、`white-space:pre-wrap` |
| `.dsh-pi-tool-body` | `padding-left:14px`、`border-left:1px solid border-l3`、`max-height:340px`、等宽 + `xxxs-11` |
| `.dsh-pi-working` | 过程流末尾：`.5px` 顶部 hairline + `padding-top:10px` + 14×14 鲸鱼尾 + 一行状态；文字 `--dsw-alias-label-deep-diving`（#345EBA）、`font-size:calc(var(--dsh-content-font-size,14px) - 2px)`（12px）、`line-height:calc(22px + delta)`、`tabular-nums` |

**图标**：`ThinkIcon`(⊗) / `TerminalIcon`(>_) / `FrameIcon`(▤) / `SearchIcon` / `PencilIcon` / `DocIcon` / `ListIcon` / `SparkIcon`，全部 24 网格、1.7 描边、round cap/join、`currentColor`，尺寸 15px。另有一个例外：工作状态行的 `WhaleTailIcon` 是 **16 网格 / 1 描边**的鲸鱼尾（照抄 DSH `RunningWhaleTail` 的 `REST_PATH`，`stroke:currentColor`、`fill:none`、`stroke-width:1`），装在 14×14 的 `.dsh-pi-working-icon` 盒里 —— 换网格的原因是 DSH 的路径本身按 16 网格设计，塞进 24 网格会整体缩到 2/3，笔画细到发灰。映射是**按工具名静态查表**（`TOOL_VIEWS`），不按参数猜：`read` 命中图片扩展名时才切成 `FrameIcon` + 「读取图片」。

**行标签的措辞直接取自 DSH 官方中文标题表**（`tool.title.*`：思考 / 运行命令 / 读取 / 读取图片 / 写入 / 编辑 / 搜索文件内容 / 查找文件 / 浏览目录 / 工具调用），未知工具兜底「工具调用 · <工具名>」——这一条照抄 DSH 的 `toolRowModel` 摘要拼接规则：只有 generic 行才把工具名当 label。

**这是全套组件里最刻意的一处设计决定**：一次任务常连着十几次工具调用，每行都套圆角框 + hairline 会形成「框套框的噪音墙」，所以是**平铺行 + 左侧竖线**；展开区沿用同一条竖线语言，让「附着在一条行下的补充信息」看起来是一类东西。

**状态**：折叠 / 展开（`[open]`）、hover（只提亮文字，**不铺底色**——没有外框时铺底色会露出一块矩形色斑）、`:focus-visible`（`outline:var(--dsw-focus-ring-width)` + `outline-offset:2px`）、运行中（圆点换品牌色 + `dsh-pi-pulse 1.2s`）、失败（`data-state="error"` + note）、`prefers-reduced-motion` 下动画全关。

**差异**：

1. **DSH 的 `._body_jrv99_22` 有底色与描边**（`background:markdown-code-block` + `border:.5px solid border-l1` + `radius-lg`），dsh-pi 的展开区没有底色。dsh-pi 更轻，DSH 更「块」。
2. **DSH 的 `._toggle_jrv99_5` 是「一行小字按钮 + 展开后一块 body」**，嵌套层级由外层容器给；dsh-pi 的父子关系由 `22px 缩进 + 左竖线` 自己表达 —— 面板拿不到宿主的会话结构，只能从 pi 的块序列里推。
3. **`--ds-font-family-code` 在 DSH 里不带兜底**（`._body_jrv99_22` 直接写 `font-family:var(--ds-font-family-code)`），dsh-pi 全部带兜底。dsh-pi 更保守，门禁第 3 条强制。
4. **工作状态行照抄 DSH `RunningStatus`**。第一次实现（0.6.4 中期）曾因 `research/` 全目录 grep「深度求索」= 0 命中而自造 `working` 键 + 灰字 + 品牌色星形；拿到目标截图底部那行的实测色值后改为照抄：文案 `deepDiving`=「深度求索中」/ `working`=「深度求索中，用时 {duration} ···」（结尾三个 `U+00B7`，不是 `…`）、时长按 DSH `formatRunDuration` 三段拆（`durHour` 仅 hours>0、`durMin` 仅 total≥60、`durSec` 恒有）、颜色 `--dsw-alias-label-deep-diving`、图标 16 网格鲸鱼尾。**单位间距由词条自带**（与 DSH 完全一致）：中文 `durMin`=「{n}分」/ `durSec`=「{n}秒」不带空格（目标图就是「43分54秒」），EN `durMin`=「{n}m 」/ `durHour`=「{n}h 」带尾空格，`fmtDuration` 用 `parts.join('')` 拼 —— 与 DSH `formatRunDuration(...).map((part) => part.text).join('')` 同一拼法。早先中英都用 `join(' ')`，中文会多出半角空格，逐像素对比才发现。

### 4.7 空态与运行时引导

**来源：index-lh_YM6sT.css 的 ._card_u7vgf_24 / ._empty_1j4y1_104 / ._status_1j4y1_144**

**令牌**：`.dsh-pi-empty` → `label-secondary`；`h2` → `font-base-strong-16` + `label-primary`；`-empty-meta` → `--ds-font-family-code` + `font-xxs-12-*` + `label-caption`；`-gate-card` → `radius-lg` + `bg-layer-1` + `elevation-panel`；`-gate-path` → `font-xxxs-11-*` + `label-tertiary`；`-gate-searched` → `font-xxxs-11-*` + `label-dimmed`。

**几何**：空态 `padding:48px 24px`（垂直留白极大，因为空态通常是首屏唯一内容）；`h2` 后 `p{max-width:420px}`（限制行宽，避免长句横跨整个面板）；`-empty-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:4px}`；gate 卡 `max-width:520px` / `padding:20px`。

**状态**：空态有两种——「还没有会话」（引导新建）与「运行时缺失」（`RuntimeGate`，含搜索路径列表 + 安装指引）。两者共用 `-center` 居中容器。

**差异**：

1. **DSH 的 `._empty_1j4y1_104` 用 `font:var(--dsw-font-xs-13)`（13px）**，dsh-pi 的 `-empty-row` 用 `font-xxs-12-*`（12px）+ `label-dimmed`。dsh-pi 更小更淡。`-empty-row` 用于抽屉里的「没有匹配项」，比整页空态更次要，这个下调是合理的。
2. **DSH 的 `._card_u7vgf_24` 是 `flex-direction:column;align-items:center;gap:16px`**，dsh-pi 的 `-gate-card` 用 `padding:20px` + `elevation-panel`。DSH 那张卡没有阴影，dsh-pi 有。
3. dsh-pi 的 `-empty-actions` 是 0.4.x 新增（工作区入口），DSH 空态没有对应结构。

### 4.8 输入区

**来源：宿主主对话区 composer（`dsh-client-ui-conversation` 的 `GRgSLq_*` 族，全文见 `_probe/composer-css.txt`）**

composer 自 0.6.2 起整体换成宿主主对话区的语言：卡面、圆形 `+`、模型与推理档位两个 picker、右侧圆形发送键、卡下方统计行。0.4.x 那个「带描边的多行盒子 + 四个文字按钮」已经不存在，本轮只保留它的缩略图部分。

**令牌**：

- `.dsh-pi-box` → `--dsw-radius-panel`（28px）+ `--dsw-specific-input-major` 底 + `--dsw-elevation-soft` 投影；`:focus-within` 只局部覆盖 `--dsw-elevation-stroke-color`
- `.dsh-pi-ta` → `label-primary` + `font-s-14-font-size` + `--dsh-content-font-delta`，`caret-color:state-business-primary`；占位符 `label-caption`
- `.dsh-pi-add` → `specific-selector` 底 + `label-primary`，hover `interactive-bg-hover-solid`
- `.dsh-pi-picker` → `label-secondary` + `font-xs-13-*`（weight 500），hover `interactive-bg-hover-solid`
- `.dsh-pi-send` → `button-info-fill` 底 + `label-primary-foreground`，hover `button-info-hover`，`:disabled` opacity .4
- `.dsh-pi-stop` → `interactive-bg-hover-solid` 底 + `label-primary`，hover `interactive-bg-hover-danger`
- `.dsh-pi-widget-body` → `border-l2` + `radius-sm` + `bg-layer-2` + `label-secondary` + `font-xxxs-11-*` + `--ds-font-family-code`
- `.dsh-pi-statusbar` → `font-xxxs-11-*` + `label-caption`
- `.dsh-pi-thumb` → 内描边 `border-l3`；`.dsh-pi-thumb-x` → `bg-mask-1` + `static-neutral-bluish-00`

**几何**：

| 元素 | 值 |
| --- | --- |
| `.dsh-pi-composer` | `padding:0 12px 4px`、`background:bg-base`、`column` + `align-items:center`（卡与 dock 同宽同心） |
| `.dsh-pi-composer-inner` | `column` + `gap:6px`、`width:100%` |
| `.dsh-pi-box` | `border:0`、`radius-panel`（28px）、`gap:12px`、`padding-top:8px`、soft 投影、`transition:box-shadow .16s` |
| `.dsh-pi-ta` | `min-height:52px`、`max-height:220px`、`border:0`、`outline:0`、`padding:4px 8px 0 14px` |
| `.dsh-pi-bar` | `flex-wrap` + `gap:12px` + `padding:2px 8px 6px`；左 `.dsh-pi-bar-actions`（`gap:8px`、`flex:0 1 auto`）、右 `.dsh-pi-bar-right`（`flex:1 1 auto` + `justify-content:flex-end`） |
| `.dsh-pi-add` | `28px × 28px`、`999px` |
| `.dsh-pi-picker` / `-wrap` | `height:28px`、`max-width:220px`、`radius-sm` |
| `.dsh-pi-picker-native` | `position:absolute`、`inset:0`、`opacity:0`（原生 `<select>` 叠在自绘外壳上，交互与键盘可达性交给系统） |
| `.dsh-pi-send` / `.dsh-pi-stop` | `34px × 34px`、`999px`、`translateY(-2px)`，同一位置互斥显示 |
| `.dsh-pi-widget-body` | `max-height:120px`、可滚动 |
| `.dsh-pi-thumb` | `52px × 52px`、`radius-sm`、内描边 `border-l3` |
| `.dsh-pi-thumb-x` | `16px × 16px`、`radius-xs` |

**状态**：聚焦只有**一条通道** —— `client.js:599` 的 `.dsh-pi-box:focus-within{--dsw-elevation-stroke-color:var(--dsw-alias-state-business-primary)}`：把 elevation 的描边层换成品牌色，投影保留。0.4–0.6.1 曾并行一条 `[data-focus="1"]` 通道，0.6.2 换成 elevation 表达后已删除（全文件 grep `data-focus` 命中 0，旧文档的双通道描述作废）。卡内按钮各自有 hover / `:disabled` / `[data-open="1"]` 三态。

**差异**：

1. **卡面与宿主同源**：`.dsh-pi-box` 与宿主 `._card`（`GRgSLq_card`）逐项同值 —— `radius-panel` + `specific-input-major` + `elevation-soft` + `gap:12px` + `padding-top:8px`。差别只在宿主把 composer 拆成更多子组件，我们用一层 `-inner` 收口。
2. **三个圆钮与宿主同值**：`.dsh-pi-add` / `-picker` / `-send` 对宿主 `._add` / `._select` / `._primary`，尺寸 28 / 28 / 34 全同。唯一实质差异是发送键前景：宿主硬写 `#fff`，我们走 `label-primary-foreground` 令牌（门禁禁止硬色值）。
3. **`.dsh-pi-search` 才属于 `._wrap_14sgc_1` 那一族**，参数不同：dsh-pi 28px / `radius-sm` / `bg-layer-3` / `border-l4`；DSH 32px / `radius-md` / `bg-layer-1` / `border-l4`。同族不同档。
4. **`.dsh-pi-ta` 用 `min-height` / `max-height` 而不是 flex 拉伸**：面板高度固定，不需要 `_editor_61ozo_1` 那种自适应。
5. **缩略图尺寸仍无据**：52px 无法在 `index-lh_YM6sT.css` 的 748 条规则里溯源（见附录 C 待确认 4）。

### 4.9 弹出菜单

**来源：index-lh_YM6sT.css 的 ._list_1p5el_7 / ._item_1p5el_105 / ._label_1p5el_146 / ._itemIcon_1p5el_165 / ._itemLabel_1p5el_208**

**令牌**：`.dsh-pi-menu` → `radius-lg` + `specific-menu` + `menu-backdrop-filter` + `elevation-panel` + `border-l1`，并局部覆盖 `--dsw-elevation-stroke-color:var(--dsw-alias-border-l1)`；`.dsh-pi-item` → `radius-md` + `font-xs-13-*` + `label-primary`，`[data-active="1"]` 转 `interactive-bg-hover`；`-item-name` 用 `--ds-font-family-code`；`-item-desc` `font-xxxs-11-*` + `label-tertiary`；`-item-side` `font-xxxs-11-*` + `label-caption`。

**几何**：

| 属性 | dsh-pi `.dsh-pi-menu` / `.dsh-pi-item` | DSH `._list_1p5el_7` / `._item_1p5el_105` |
| --- | --- | --- |
| 容器 padding | `4px` | `4px` |
| 容器圆角 | `radius-lg` | 由上层给 |
| 阴影 | `elevation-panel` | `elevation-prominent` |
| 描边色覆盖 | `--dsw-elevation-stroke-color:border-l1` | `--dsw-elevation-stroke-color:border-l1` |
| 毛玻璃 | `backdrop-filter:var(--dsw-menu-backdrop-filter)` | DSH 由 `._list` 的父容器给 |
| item 最小高 | `34px` | `34px`（`_denseList` 变体 30px） |
| item padding | `6px 8px` | `6px 8px` |
| item 圆角 | `radius-md` | `radius-md` |
| item 字号 | 13px / 20px | 13px / 20px |
| 图标尺寸 | 无统一规则 | `._itemIcon_1p5el_165` `14px × 14px` |

**状态**：`data-active`（键盘高亮）、`data-disabled`（`opacity:.4`）、hover（`interactive-bg-hover`）、空列表（`-empty-row`）。

**差异**：

1. **阴影等级不同**：dsh-pi 用 `elevation-panel`，DSH 的 `._list_1p5el_7` 用 `elevation-prominent`。`prominent` 的第二层阴影更大更散（`0 0 20px #0000000d` vs `0 0 16px #00000005`）。菜单是浮在最上层的元素，用 `prominent` 更符合 DSH 的层级直觉。这是一处**可以低成本修正**的偏差。
2. **`_item_1p5el_105` 的 hover 包在 `@media(hover:hover)` 里且带 `:not(:disabled):not([aria-disabled=true])`**，dsh-pi 只写 `[data-active="1"]` 与 hover，没有排除禁用态。DSH 的 `:focus-visible` 也走同一个底色（`background:interactive-bg-hover;outline:none`），dsh-pi 没有为 item 单独写 focus 规则（靠根的全局 `:focus-visible` 描边）。
3. **DSH 的 `._list_1p5el_7` 有定位与宽度约束**（`position:absolute;top:calc(100% + 4px);min-width:min(144px,…);max-width:min(360px,…)`），dsh-pi 的定位在 JS 里算，CSS 只给外观。分工不同，不算差异。

### 4.10 抽屉外壳

**来源：index-lh_YM6sT.css 的 ._pane_3oazc_211 / ._surface_3oazc_127（无直接对标）**

**令牌**：`.dsh-pi-sheet` → `bg-base`；`-sheet-head` → `border-l2`；`-sheet-title` → `font-base-strong-16` + `label-primary`；`-search` → `border-l4` + `radius-sm` + `bg-layer-3` + `label-primary` + `font-xxs-12-*`；`-sess` → `radius-md` + `bg-layer-1` + 内描边 `border-l2`，hover 转 `bg-layer-2` + `border-l4`，`[data-current="1"]` 内描边转 `state-business-primary`；`-mono` → `--ds-font-family-code` + `font-xxxs-11-*` + `label-tertiary`；`-kv` → `grid auto 1fr` + `gap:6px 14px`；`-tree` → `--ds-font-family-code` + `font-xxs-12-font-size`；`-tree-kind` → `label-caption` + `font-xxxs-11` + `min-width:56px`。

**几何**：`.dsh-pi-sheet{position:absolute;inset:0;z-index:30;display:flex;flex-direction:column;background:bg-base}` —— **铺满容器，不是浮层卡片**。`-sheet-head{border-bottom:.5px solid border-l2}`；`-sheet-body{padding:12px 14px 16px}`。

**这是整套组件里唯一没有 DSH 直接对标物的一处**。`index-lh_YM6sT.css` 里的 `._pane_3oazc_211` 与 `._surface_3oazc_127` 只提供容器骨架（flex + min-height:0 + overflow），没有任何「抽屉外观」的类。DSH 的抽屉由应用层自己组合。所以 `.dsh-pi-sheet` 的配色配方是从多处借的：`bg-base` + `border-l2` 分隔 + `-sess` 卡的 `bg-layer-1` 到 `bg-layer-2` 的 hover 升级。

`client.js:674` 的注释说「DSH `._float` 的配方：bg-layer-2 + radius-panel + elevation-prominent + 局部描边色」，但实际渲染用的是 `bg-base` 铺满。注释与实现不一致——见附录 B 的 D-06。

**状态**：抽屉本身无状态；内部卡片有默认 / hover / `data-current` / `data-clickable` / `data-leaf` 五态；搜索框有聚焦 / 占位符两态。

**差异**：

1. **无 DSH 对标物**（见上）。判定依据只能到「令牌全部合法」这一层，不能宣称「与 DSH 某组件一致」。
2. **`.dsh-pi-sess` 的 hover 同时改底色与描边色**（`bg-layer-1 → bg-layer-2`、`border-l2 → border-l4`），这需要两条令牌同时移动。DSH 的 `._item_1p5el_105` hover 只改底色。dsh-pi 的做法信息量更大，属可接受的扩展。
3. **注释与实现不一致**（`client.js:674`，见上）。

### 4.11 开关

**来源：index-lh_YM6sT.css 的 ._switch_1ik0f_5 / ._thumb_1ik0f_33**

**令牌**：`.dsh-pi-switch` → `border-l3`（关闭底）、`brand-primary`（开启底）；`.dsh-pi-switch-thumb` → `label-primary-foreground`（开启滑块）、`switch-thumb`（关闭滑块）。

**几何与状态逐条对照**（`client.js:707-714` vs DSH 原文）：

| 属性 | dsh-pi | DSH `._switch_1ik0f_5` | 判定 |
| --- | --- | --- | --- |
| 尺寸 | `36px × 20px` | `36px × 20px` | 一致 |
| padding | `2px` | `2px` | 一致 |
| 圆角 | `999px` + `corner-shape:round` | `999px` + `corner-shape:round` | 一致 |
| 关闭底 | `border-l3` | `border-l3` | 一致 |
| 开启底 | `brand-primary` | `brand-primary` | 一致 |
| disabled | `cursor:default;opacity:.5` | `cursor:default;opacity:.5` | 一致 |
| 滑块 | `16px × 16px` + `50%` 圆 | `16px × 16px` + `50%` 圆 | 一致 |
| 滑块默认底 | `label-primary-foreground` | `label-primary-foreground` | 一致 |
| 关闭态滑块 | `switch-thumb` | `switch-thumb` | 一致 |
| 开启位移 | `translate(16px)` | `translate(16px)` | 一致 |
| 滑块过渡 | `transform .12s ease` | `transform .12s ease` | 一致 |
| 胶囊过渡 | `background-color .16s ease` | **无** | 差异 |

十一项一致、一项差异。这是全套组件里对齐程度最高的一处。**唯一差异**是 dsh-pi 的胶囊多了 `transition:background-color .16s ease`，DSH 的开关底色是瞬变。加上过渡在观感上更柔和，但也意味着关闭瞬间有一帧中间色。

**状态**：`role="switch"` + `aria-checked` + `aria-labelledby`，React 侧用 `id="dsh-pi-sw-<key>"` 关联标签。`SettingsSheet`（`client.js:3601-3628`）里只有 `autoCompaction` 与 `autoRetry` 两个真开关（`client.js:3619` / `:3620`）；`steeringMode` 与 `followUpMode` 仍是 `.dsh-pi-btn` 文字按钮（`client.js:3622-3626`），与 DSH 的 `._toggle_jrv99_5` 同族但不是开关形态。

**差异**：

1. 胶囊过渡（见上）。
2. **四个设置项只有两个是开关**。注释 `client.js:3604` 说「开关对齐 DSH 的 `._switch_1ik0f_5`（36x20 胶囊 + 16px 滑块），不再是文字按钮」，但实际只改了两个。另外两个是双值枚举（`one-at-a-time` / `all`），做成开关语义不成立（不是布尔），保持文字按钮是对的；但注释的措辞会让人误以为四项都改了。

### 4.12 对话框

**来源：index-lh_YM6sT.css 的 ._dialog_14mp3_33 / ._mask_14mp3_18 / @keyframes _modalEnter_14mp3_1**

**令牌**：`.dsh-pi-dialog-wrap` → `bg-mask-1`；`.dsh-pi-dialog` → `radius-panel` + `bg-layer-2` + `elevation-prominent`；`h3` → `font-base-strong-16` + `label-primary`；`-dialog-msg` → `label-secondary` + `--dsh-content-font-size` + `--dsh-content-font-delta`；`-opt` → `radius-md` + `bg-layer-3` + `font-xs-13-*`；`-mini-ta` → `border-l4` + `radius-sm` + `bg-base` + `--ds-font-family-code`。

**几何**：

| 属性 | dsh-pi `.dsh-pi-dialog` | DSH `._dialog_14mp3_33` |
| --- | --- | --- |
| 宽度 | `min(440px,100%)` | `min(380px,100%)` |
| 布局 | `flex column`，无 gap | `flex column`，`gap:20px` |
| padding | 三段式（`22px 24px 0` / `14px 24px 0` / `22px 24px 24px`） | `0 0 24px` |
| 圆角 | `radius-panel` | `radius-panel` |
| 底色 | `bg-layer-2` | `bg-layer-2` |
| 阴影 | `elevation-prominent` | `elevation-prominent` |
| 入场动画 | `dsh-pi-modal-in .16s ease-in-out` | `_modalEnter_14mp3_1 var(--ds-transition-duration) var(--ds-ease-in-out)` |
| 遮罩 | `bg-mask-1` 平铺 | `._mask_14mp3_18` 用 `backdrop-filter:var(--dsw-mask-blur)` + `:after` 铺 `bg-mask-1` |

**入场动画逐帧对照**：

```css
@keyframes dsh-pi-modal-in{0%{opacity:0}to{opacity:1}}          /* client.js:749 */
@keyframes _modalEnter_14mp3_1{0%{opacity:0}to{opacity:1}}      /* DSH 原文 */
```

两条**完全相同**：只有 opacity，没有 scale、没有 translate。这与 DSH 全部 17 个 `@keyframes` 的风格一致（除三个旋转类外全是纯 opacity 过渡）。

**状态**：`-opt` 有默认 / hover / `data-active="1"`（内描边转 `state-business-primary`）三态；`-mini-ta` 有默认 / 聚焦两态；`-dialog-body` 可滚动（`overflow-y:auto`）。

**差异**：

1. **宽度 440 vs 380**。dsh-pi 的对话框要容纳选项列表与多行输入，宽 60px 是刻意的。
2. **DSH 用 `gap:20px` 统一间距，dsh-pi 用三段 padding 精确控制**。DSH 的写法更简单，dsh-pi 的写法能做出「标题紧贴顶、按钮区留白大」的层次。
3. **遮罩少了 `backdrop-filter`**。DSH 的 `._mask_14mp3_18` 有 `backdrop-filter:var(--dsw-mask-blur)`，dsh-pi 直接铺 `bg-mask-1`。查 `tokens.txt`：`--dsw-mask-blur = none`，所以当前两者视觉一致；但若 DSH 将来把 `mask-blur` 改成非 none，dsh-pi 不会跟随。
4. **`dsh-pi-modal-in` 是全局 keyframes 名字**，不带 hash 前缀，有被宿主同名动画覆盖的理论风险（实际不会，因为面板在同源独立文档流里）。

> 目录选择器（`DirSheet`）的规格单独放在第 6 章，因为它的交互复杂度远超一般组件，且它是本次改造的核心。

---

## 5 现状 → 目标映射表

逐类列出 CSS 数组里的全部 **148** 个 `.dsh-pi-*`（脚本 `matchAll(/\.dsh-pi-([a-zA-Z0-9-]+)/g)` 去重得到）。判定分四档：

| 判定 | 数量 | 判据 |
| --- | --- | --- |
| **A 已对齐** | 32 | 有明确 DSH 依据，且几何与令牌逐值一致（差异只在可忽略的个别值） |
| **B 近似** | 45 | 有同族 DSH 组件，但尺寸档、描边色、阴影级或结构不同 |
| **C 无对应物** | 69 | DSH 里没有该组件（纯布局类，或面板专有语义），只能保证令牌合法 |
| **D 待确认** | 2 | 引用的 DSH 依据需重采探针才能断言 |
| 合计 | 148 | — |

四档之和 32 + 45 + 69 + 2 = 148，与实测类数完全吻合，无遗漏无重复。

### 5.1 A 档：已对齐（32）

| `.dsh-pi-*` | DSH 依据 | 依据说明 |
| --- | --- | --- |
| `add` | Composer `._add`（`GRgSLq_add`） | 28×28 / `999px` / `specific-selector` 底 / `label-primary` / hover `interactive-bg-hover-solid` / `:disabled` opacity .5 六项同；DSH 多一条 `corner-shape:round` |
| `add-item` | `._item_1p5el_105`（菜单项） | `min-height:34px` / `6px 8px` / `radius-md` / 13px-20px / hover `interactive-bg-hover` 五项同（`gap:10px` 是两列布局所需） |
| `btn-primary` | `._primary_1ulci_36` | `button-primary-fill` + `label-primary-foreground` + hover `button-primary-hover`，三项全同 |
| `bubble-user` | `._bubble_1sgyj_1` | `radius-xl` / `10px 16px` / `specific-bubble` / 行高 `calc(22px + delta)` 逐值同；仅 `max-width` 82% vs 100% |
| `chip` | `._tag_brmue_4` | `1px 8px` / `999px` / `corner-shape:round` / 11px / weight 500 逐项同 |
| `code-inline` | `._language_1mqf1_30` 同族（`markdown-inline-code`） | `radius-xs` + `markdown-inline-code` + `font-markdown-code-block-small` 三项令牌同 |
| `dialog` | `._dialog_14mp3_33` | `radius-panel` / `bg-layer-2` / `elevation-prominent` + 入场动画同；宽度 440 vs 380 |
| `dialog-wrap` | `._mask_14mp3_18` | `bg-mask-1` 同；dsh-pi 少 `backdrop-filter:var(--dsw-mask-blur)`（当前 `mask-blur = none`，视觉一致） |
| `dir-col` | picker `_column` | `flex:1 1 0` / `min-width:0` / `overflow-y:auto` 同；dsh-pi 无 `min-width:256px` |
| `dir-cols` | picker `_millerRow` | `display:flex` / `gap` / `overflow` 骨架同；dsh-pi 加 `border-l2` + `radius-md` + `bg-layer-1` 包边 |
| `dir-crumb` | picker `_crumb` | `radius-xs` / `label-secondary` / `font-xxs-12-font-size` 同；hover 转 `label-primary` 同 |
| `dir-dialog` | picker `_dialog` | `min(680px,100%)` × `min(500px,100%)` + `radius-panel` + `bg-layer-2` + `elevation-prominent` 同 |
| `dir-item` | picker `_row` + `._item_1p5el_105` | `radius-sm` / `padding` / hover / 选中 `interactive-bg-active` 同；dsh-pi 30px vs DSH 28px |
| `dir-name` | picker `_rowName` | 13px / weight 500 / 省略号 三项同 |
| `fence` | `._card_1mqf1_1` | `margin:16px 0` / `radius-lg` / `markdown-code-block` / `font-markdown-code-block` 四项全同 |
| `fence-lang` | `._header_1mqf1_10` | `padding:10px 18px 8px 22px` 逐值同；字体 11px/18px 比例字体 vs 11px/14px + `font-family` |
| `item` | `._item_1p5el_105` | `min-height:34px` / `6px 8px` / `radius-md` / 13px-20px / hover 底色 五项全同 |
| `picker` | Composer `._select`（`GRgSLq_select`） | `height:28px` / `radius-sm` / `max-width:220px` / 13px-500 / `label-secondary` 五项同；hover 用 `interactive-bg-hover-solid`（DSH 是 `-hover`） |
| `pre` | `._body_1mqf1_81` | `padding:6px 22px 20px` 逐值同 |
| `proc` | `._root_l4nv8_9`（过程行根） | 两边都是**内容无壳**：无描边、无圆角、无底色、无阴影（`border:0;border-radius:0;background:transparent;box-shadow:none`） |
| `proc-head` | `._row_l4nv8_26` + `._title_l4nv8_104` | 行高 24px（`calc(24px + delta)`）/ 字号 `--dsh-content-font-size-secondary`(13px) / `label-tertiary` / hover 转 `label-primary` 四项同；DSH 给 `height`，我们给 `line-height` + flex 居中，视觉同高 |
| `proc-icon` | `._leading_l4nv8_52` | 16×16 图标框 / `flex:none` / `label-tertiary` 三项同；DSH `margin-right:6px`，我们 7px |
| `proc-label` | `._title_l4nv8_104` | 13px 继承 / `label-tertiary` / `white-space:nowrap` 三项同 |
| `proc-text` | `._row_l4nv8_26`（`color:inherit` 那一侧） | `flex:1 1 auto` / `min-width:0` / `text-overflow:ellipsis` / `label-tertiary` 四项同 |
| `root` | 全 DSH 组件的 `:focus-visible` + `var(…, fallback)` 手法 | `bg-base` / `font-family` / `font-s-14` 基线 + 重绑 `--dsw-focus-ring-color`（DSH 默认 `transparent`） |
| `send` | Composer `._primary`（`GRgSLq_primary`） | 34×34 / `999px` / `button-info-fill` / hover `button-info-hover` / `:disabled` opacity .4 / `translateY(-2px)` / `.1s` 七项同；DSH 前景硬写 `#fff`，我们走 `label-primary-foreground` 令牌 |
| `switch` | `._switch_1ik0f_5` | 36×20 / `padding:2px` / `999px` / `corner-shape:round` / `border-l3` / `brand-primary` / `opacity:.5` 七项全同；多一条 `transition:background-color .16s` |
| `switch-thumb` | `._thumb_1ik0f_33` | 16×16 / 50% / `label-primary-foreground` / `.12s ease` / `switch-thumb` / `translate(16px)` 六项全同 |
| `tag` | `._tag_brmue_4` | 同 chip；tone 只有 4 种 vs DSH 8 种，但所用四色与 10% / 12% 全部对得上 |
| `working` | `ChatView ._running`（`dsh-client-ui-chat`） | 上 hairline `.5px` + `padding-top:10px` + `label-deep-diving` + `font-size:calc(var(--dsh-content-font-size) - 2px)` + `line-height:calc(22px + delta)` 五项同 |
| `working-icon` | `._runningIcon` | 14×14 / `flex:none` / `overflow:hidden` 三项同；DSH 是 APNG 蒙版 + `background:currentColor`，我们 16 网格静态 SVG（`WhaleTailIcon`） |
| `working-text` | `._runningText` | `font-variant-numeric:tabular-nums` / `min-width:0` / 省略号 三项同 |

这 32 个类是本轮改造的主要成果。判定「已对齐」的门槛是：**几何与令牌都能逐值指到 DSH 原文的某一条规则**，而不是「看起来像」。其中 `-switch` 与 `-switch-thumb` 十二项里有十一项逐字相同（唯一差异见 4.11）；`-fence` / `-fence-lang` / `-pre` 的三个 padding 与 DSH 逐值相同；`-dir-dialog` 的 680×500 与 picker 的 `_dialog` 相同。

### 5.2 B 档：近似（45）

| `.dsh-pi-*` | DSH 依据 | 差在哪 |
| --- | --- | --- |
| `add-desc` | `._shortcutKeys_1p5el_221` | 同承担「右侧次要信息」；DSH 11px/16px + `label-caption`，dsh-pi 11px/16px 但用 `label-tertiary`（比 caption 重一档） |
| `add-icon` | `._itemIcon_1p5el_165` | 同为菜单项图标框 + `label-secondary`；DSH 14×14 + `menu-icon`，dsh-pi 20×20 |
| `add-key` | `._shortcutKeys_1p5el_221` | 同「英文键名」11px；DSH 比例字体 + `label-caption`，dsh-pi 等宽字族 + `label-caption` |
| `add-label` | `._itemLabel_1p5el_208` | 同承担主标签；dsh-pi 拆成 `add-label`（不缩）+ `add-key`（可缩）两段，DSH 是单段 `flex:1` |
| `add-text` | `._itemLabel_1p5el_208` | 同为主标签容器；dsh-pi 用 `baseline` 对齐把键名与说明并排，DSH 把快捷键推到行尾 |
| `alert` | `color-mix` 手法同 `._tag_brmue_4` | DSH 无 alert 组件；底罩色用 `color-mix(state-error 10%)`，与 tag 的 danger 档同一手法 |
| `bar-actions` | Composer `._tools` / `._modes` | 同为左组 `align-items:center` + `gap`；DSH `gap:12px`，dsh-pi `gap:8px` |
| `bar-right` | Composer `._trailing` | 同为右组 + `margin-left:auto`；DSH `flex:none`，dsh-pi `flex:1 1 auto` + `justify-content:flex-end` |
| `box` | `._wrap_14sgc_1:focus-within` | 共享 `:focus-within → state-business-primary` 配方；尺寸档不同（多行外壳 vs 32px 单行） |
| `btn` | `._button_1ulci_2` + `._sm_1ulci_28` + `._outline_1ulci_56` | 28px / `radius-sm` / `0 10px` / hairline 内描边一致；描边色 `border-l4` vs `border-l3`，无 `_md` 36px 档 |
| `btn-danger` | `._button_1ulci_2` 变体族 | DSH 无 `_danger`；`state-error-primary` 文本 + `interactive-bg-hover-danger` 底，语义色取值一致 |
| `btn-ghost` | `._ghost_1ulci_46` | 同族；dsh-pi 额外去掉内阴影描边 |
| `btn-icon` | `._button_1ulci_2` | `width:28px` 正方，DSH 无 icon 变体 |
| `dialog-actions` | `._dialog_14mp3_33` footer | `padding:22px 24px 24px` vs DSH 的 `gap:20px` + `padding:0 0 24px` |
| `dialog-body` | `._dialog_14mp3_33` 内容区 | `padding:14px 24px 0` vs DSH 的 `gap` |
| `dialog-head` | `._dialog_14mp3_33` 头部 | `padding:22px … 0 24px` 同族；DSH `22px 14px 12px 24px`（带下边距），dsh-pi 下边距移到 body |
| `dialog-msg` | `._dialog_14mp3_33` 内容区 | `--dsh-content-font-size` + `calc(22px + delta)` 与 DSH 气泡同法；DSH 对话框正文无独立类 |
| `dir-crumbs` | picker `_crumbBar` | `flex` + `gap` + `flex-wrap` 同；DSH `min-height:24px` + `margin-left:-9px`，dsh-pi `min-height:20px` 无负 margin |
| `dir-foot` | picker `_footerBar` | `flex` + `gap` + `flex-wrap` 同；DSH `border-top:.5px` + `padding:16px 24px`，dsh-pi 无分隔线 |
| `dir-head` | picker `_header` | DSH `padding:16px 14px 8px 24px` + `border-bottom:.5px`；dsh-pi `14px 16px 10px 20px` 无分隔线 |
| `dir-hint` | picker `_status` | 同族提示行；DSH 12px + `padding:4px 120px 4px 4px`，dsh-pi 11px 无 padding |
| `dir-mark` | picker `_rowIconSelected` | 同色（`button-info-fill` = `deepseek-500` = `state-business-primary`）；dsh-pi 用文字徽标而非图标着色 |
| `dir-title` | picker `_title` | 同字号族；DSH 16px / weight 510 / `min-height:28px`，dsh-pi 同字号无 min-height |
| `dot` | `._dot_1i3xo_2` | 同用四状态色；DSH 是空 span + `:after{inset:20%;background:currentColor}`，dsh-pi 是 7px 实心圆写 `background`；状态名不同 |
| `empty` | `._empty_1j4y1_104` | `label-secondary` 同；dsh-pi 是整页空态（`padding:48px 24px` + 标题 + 引导），DSH 的 empty 只是行内文本 |
| `empty-row` | `._empty_1j4y1_104` | 同族「无内容」行；DSH 13px + `label-secondary`，dsh-pi 12px + `label-dimmed`（更次要） |
| `fileref` | `MessageItem ._fileCard`（`LOmM4q_fileCard`） | 同为「文件」可点块：`radius` + 内 hairline + `specific-input-major` 同族底；DSH 是 240px 定宽卡片 + `radius-lg` + `border-l2`，dsh-pi 是行内 chip + `radius-sm` + `border-l3` |
| `fileref-name` | `._fileName`（`LOmM4q`） | 同为文件名 + 省略号；DSH 14px，dsh-pi 11px 等宽（行内 chip 需要更小的字面） |
| `gate-card` | `._card_u7vgf_24` | 同族「居中卡片」；DSH `flex column` + `gap:16px` 无阴影，dsh-pi `padding:20px` + `elevation-panel` |
| `item-name` | `._itemLabel_1p5el_208` | 同承担「主名 + 省略号」；DSH 比例字体 + `text-overflow`，dsh-pi 等宽 |
| `menu` | `._list_1p5el_7` | `padding:4px` + `border-l1` 描边覆盖 同；阴影 dsh-pi `elevation-panel` vs DSH `elevation-prominent` |
| `menu-add` | `._list_1p5el_7` 的定位族 | 同族弹出层；DSH 由浮层自算位置，dsh-pi 贴 `left:0` 且加宽到 288px（两列布局所需） |
| `menu-head` | `._label_1p5el_146` | `11px` / `label-tertiary` / `6px 8px` 同；行高 14px vs 15px |
| `menu-section` | `._label_1p5el_146` | 同「分组标题」11px + `label-caption`；DSH `padding:6px 8px` + 行高 15px，dsh-pi `8px 8px 4px` + 行高 16px |
| `mini-ta` | `._input_14sgc_25` | 同族输入控件；DSH 单行无边框，dsh-pi 多行 + `min-height:84px` + `border-l4` |
| `notice` | `color-mix` 手法同 `._tag_brmue_4` | 三 tone 用 10% / 12% / 10%；DSH 无 notice 组件 |
| `opt` | `._item_1p5el_105` 同族 | `min-height:34px` / `radius-md` / 13px 同；DSH item 底透明，dsh-pi `bg-layer-3` 实底 + `[data-active]` 内描边 |
| `picker-native` | Composer `._select`（原生 select 那条路径） | 同为「原生控件承接交互」；DSH 用自绘浮层，dsh-pi 用透明 `<select>` 覆盖（`opacity:0` + `inset:0`），外观由 `picker-wrap` 表达 |
| `picker-wrap` | Composer `._select` | 尺寸档与令牌同 `picker`；DSH 是单个 `select`，dsh-pi 是「外观层 + 原生控件」两层 |
| `proc-body` | `._body_jrv99_22`（过程展开区） | 同族展开区：左 `border-l3` 竖线 + 缩进；DSH 竖线 2px + `markdown-code-block` 底，dsh-pi 1px 无底 |
| `search` | `._wrap_14sgc_1` | `border-l4` 同；28px / `radius-sm` / `bg-layer-3` vs 32px / `radius-md` / `bg-layer-1` |
| `stop` | Composer `._primary[data-sending]` | 同位置换成「停止」语义；DSH 保持 `button-info-fill` 底 + spinner，dsh-pi 换 `interactive-bg-hover-solid` 底 + `StopSquareIcon` |
| `ta` | `._input_14sgc_25` | 同族输入控件；DSH 无边框 14px/22px，dsh-pi 加 `min-height:52px` / `max-height:220px` |
| `tool-body` | `._body_jrv99_22` | 同族展开区；DSH 有 `markdown-code-block` 底 + `border-l1` 描边，dsh-pi 只有左侧 `border-l3` + `max-height:340px` |
| `widget-body` | `._body_jrv99_22` 同族 | 等宽 11px + 可滚动；dsh-pi 无极底色、无描边、`max-height:120px` |

B 档的共同特征是「同族不同档」：要么尺寸差一档（28 vs 32、30 vs 28、440 vs 380），要么描边色差一级（`border-l4` vs `border-l3`），要么阴影差一级（`elevation-panel` vs `elevation-prominent`），要么结构不同（DSH 用按钮 + body，dsh-pi 用左侧竖线块）。**这些都不是错，但都不该被描述成「一致」。**

### 5.3 C 档：无对应物（69）

| `.dsh-pi-*` | DSH 依据 | 说明 |
| --- | --- | --- |
| `add-wrap` | — | `position:relative` + `display:flex`，纯定位容器（给 `menu-add` 当锚点） |
| `bar` | — | 布局行：`flex` + `gap` |
| `bar-hint` | — | 11px + `label-caption`，DSH 无可对标 |
| `body` | — | 消息正文容器，纯布局 |
| `brand` | — | 品牌行，14px + `label-primary`，纯排版 |
| `caret` | — | 6×14 光标 + `dsh-pi-pulse`，DSH 无流式光标 |
| `center` | — | 居中容器，纯布局 |
| `chip-name` | — | chip 内文本节点，纯排版 |
| `composer` | — | `padding:8px 12px 12px` + `bg-base`，纯布局 |
| `composer-inner` | — | 纯布局 |
| `dir` | — | `flex column` + `gap:8px`，纯布局 |
| `dir-sep` | — | `label-dimmed` 分隔符，DSH 用 chevron 图标 |
| `dir-target` | — | 等宽 11px + `label-caption`，DSH 页脚无目标路径文本 |
| `empty-actions` | — | 0.4.x 新增的工作区入口按钮行，DSH 空态无对应结构 |
| `empty-meta` | — | 等宽 12px + `label-caption`，面板专有 |
| `fileref-block` | — | 「围栏里整块只有一条路径」形态的外壳：`margin:8px 0` + `line-height:26px` |
| `fileref-dir` | — | chip 里的目录尾巴，`label-tertiary`；0.6.1 起默认不渲染，保留类以防回退 |
| `gate` | — | 运行时门禁整页，面板专有 |
| `gate-actions` | — | 按钮行，纯布局 |
| `gate-path` | — | 等宽 11px + `label-tertiary`，面板专有 |
| `gate-searched` | — | 11px + `label-dimmed`，面板专有 |
| `head` | — | `border-bottom:.5px border-l3`，纯布局 |
| `head-main` | — | 纯布局 |
| `img` | — | `max-width:min(100%,360px)` / `max-height:240px` / `radius-md`，DSH 无图片缩放组件 |
| `img-open` | — | `fixed inset:0` / `z-index:60` / `bg-mask-photo`，面板专有（令牌合法） |
| `inner` | — | 滚动容器，纯布局 |
| `item-desc` | — | 11px + `label-tertiary`，DSH 菜单项无副标题 |
| `item-main` | — | 纯布局 |
| `item-side` | — | 11px + `label-caption`，DSH 菜单项无右侧信息 |
| `kv` | — | `grid auto 1fr` + `gap:6px 14px`，面板专有 |
| `kv-k` | — | `label-tertiary` 键名，面板专有 |
| `kv-v` | — | `label-primary` 值，面板专有 |
| `menu-list` | — | 滚动容器，纯布局 |
| `mono` | — | 等宽 11px + `label-tertiary`，面板专有 |
| `picker-label` | — | 外观层的文本槽，`pointer-events:none`（点击要落到原生 select） |
| `picker-name` | — | `picker` 里模型名那一格，纯排版 |
| `proc-note` | — | 过程行右侧注脚（`tabular-nums` + 三 tone），DSH 的对应信息在 `RunningStatus` 里，没有独立类 |
| `proc-path` | — | 过程行里可点的路径（`underline 1px dotted` + `text-underline-offset:3px`），DSH 无同类 |
| `proj` | — | 项目层行，样式与 `sess` 完全一致（只差 `[data-temporary="1"]` 时标题转 `label-secondary`），DSH 无会话/项目卡组件 |
| `prose` | — | markdown 正文容器，`--dsh-content-font-size` + `calc(24px + delta)`；DSH 由 markdown 渲染层控制，不在 `index-lh_YM6sT.css` |
| `queue` | — | 排队消息提示，面板专有 |
| `row` | — | 消息行，纯布局 |
| `row-user` | — | 用户消息对齐，纯布局 |
| `row2` | — | 两列输入行，纯布局 |
| `scroll` | — | 滚动容器（重绑 `--dsh-scrollbar-thumb`），面板专有 |
| `sep` | — | 父行里的 2×2 中点（`label-caption`，running 时转品牌色 + 脉冲）。DSH 用文字 `·` 拼，不是元素 |
| `sess` | — | 会话卡，`bg-layer-1` + 内描边 `border-l2`，DSH 无对应组件 |
| `sess-line` | — | 会话卡副行 |
| `sess-title` | — | 会话卡标题 |
| `sess-top` | — | 会话卡首行 |
| `sheet` | — | 抽屉外壳（`bg-base` 铺满），DSH `_pane` / `_surface` 只给骨架无外观 |
| `sheet-body` | — | 抽屉主体，纯布局 |
| `sheet-head` | — | 抽屉头，`border-l2` |
| `sheet-title` | — | `font-base-strong-16`，DSH 无抽屉标题类 |
| `spacer` | — | `flex:1 1 auto`，通用布局 |
| `sr` | — | `clip:rect(0,0,0,0)`，通用 a11y 类，不需要 DSH 依据 |
| `statusbar` | — | 11px + `label-caption`，面板专有 |
| `sub` | — | 子行组：`margin-left:22px` 让左侧 1px 竖线落在父行图标框左缘 + `padding-left:8px` |
| `switch-label` | — | `font-s-14` + `label-primary`，DSH 开关无标签类 |
| `switch-row` | — | `grid 1fr auto` + `gap:12px`，面板专有布局 |
| `thumb-x` | — | 16×16 / `radius-xs` / `bg-mask-1` + `static-neutral-bluish-00` |
| `tool` | — | 平铺行（无框无底无阴影），`client.js:513-520` 注释说明理由（「框套框的噪音墙」在 `:518`）；DSH 无可对标 |
| `tool-head` | — | `::before` 三角 `\25B8` + `[open]` 旋转，面板专有 |
| `tree` | — | 等宽 `font-xxs-12-font-size`，DSH 无树组件 |
| `tree-kind` | — | `label-caption` + `min-width:56px` |
| `tree-node` | — | `radius-sm` + hover，DSH 无树组件 |
| `tree-text` | — | `label-secondary` |
| `usage` | — | `tabular-nums`，面板专有 |
| `widget` | — | 状态 widget 容器 |

69 个类占全部类的 46.6%（旧账 61/114 = 53.5%，0.6.x 补进来的 38 个新类里有 22 个能指到 DSH 依据，比例因此下降）。这个比例本身是个重要结论：**dsh-pi 的界面接近一半在 DSH 设计系统里没有对应组件。** 这不是缺陷——面板要做的事（会话卡、token 用量、工具行、目录树、运行时门禁）本就不在 DSH 的组件集里。对它们能做的保证只有两条：

1. **令牌合法**（门禁第 2 条）：只用 `--dsw-*` 与 7 个白名单外部变量；
2. **无硬色值**（门禁第 1 条）：任何颜色都来自令牌，所以换主题时全会跟着变。

不能做的保证是「与 DSH 某个组件视觉一致」——因为没有那个组件。

### 5.4 D 档：待确认（2）

| `.dsh-pi-*` | 疑似的 DSH 依据 | 为什么待确认 |
| --- | --- | --- |
| `thumb` | 未找到附件缩略图类 | 52×52 / `radius-sm` / 内描边 `border-l3` 无法溯源 |
| `thumbs` | 未找到 | 缩略图行，`flex` + `gap` |

这两个类是附件缩略图相关（`52px × 52px` + `radius-sm` + 内描边 `border-l3`）。在 `index-lh_YM6sT.css` 的 748 条规则里没有找到尺寸匹配的缩略图类，`tokens.txt` 里也没有专用令牌。当前数值**无法溯源**，只能记为「经验值」。要找依据需要重采 DSH 的附件组件包（目录选择器探针里没有这一族）。

### 5.5 与 m02100 原始假设的偏差

m02100 说「现状 → 目标映射表（`client.js` :305-450）」。当前快照的 CSS 数组区间是 **`:443` – `:769`**（240 段），不是 `:305-450`——那一段落在 i18n 表与工具函数之间，没有 CSS。

m02100 说「185 段 / 26978 字符 / 295 处 `var()` / 66 个唯一变量」。当前快照实测 **240 段 / 35680 字符 / 356 次 `var(` 文本出现（门禁按顶层引用计 351 处）/ 74 个唯一变量**（`node test/css-tokens.mjs --report` 的汇总行印「令牌引用: 351 处 / 74 个唯一变量」，字节数与段数在同一块的前两行）。四项都变了：0.6.0–0.6.4 陆续加入文件标签、`CloseButton`、composer 卡面与 `+` 菜单、过程行与工作状态行，规则数与令牌面都扩大。`var(` 计数在 0.6.4 收尾时为 **356**（顶层 351 + 兜底嵌套 5）。

m02100 说「令牌清单」时未指定范围。本文按**实际被引用的 74 个令牌（含 7 个本地兜底令牌）** 收口，而不是照抄 `tokens.txt` 的 414 个——后者是 DSH 的全量令牌表，与 dsh-pi 无关。

---

## 6 新建工作目录（工作区）交互

这一章是本次改造的核心。它不属于「令牌对齐」，而属于「补一个 pi TUI 有、面板缺的能力」。

### 6.1 为什么需要这个功能

pi 子进程的工作目录（cwd）在 `spawn` 那一刻就定了，运行中改不了。命令行 pi 的等价操作是「退出 → `cd` → 重开」。面板如果不提供这个入口，用户就只能去改 DSH 的插件配置（`workspace` 字段）再重启面板——这完全不像一个 IDE 插件该有的体验。

pi 的 TUI 侧有对应物：会话选择器里的「新建工作目录」（`session-selector.ts` 的 `ProjectList`）。面板要做的是把它翻译成浏览器里的目录浏览器。

pi 的 RPC 面没有任何 `fs` 能力（33 条命令里没有目录操作），所以浏览只能走宿主（`index.js`）自己开的一个 HTTP 路由 `GET /directories`。这条边界必须写清楚：**面板不直接读文件系统，一切目录信息来自宿主。**

### 6.2 DSH 官方目录选择器对照

DSH 自带 `@deepseek-ai/dsh-client-ui-directory-picker-browse`，源码在探针 `_probe/dsh-picker/client.js`（1138 行）。它的对外能力与限制（`README.zh.md`）：

| 能力 | 说明 |
| --- | --- |
| 经 `ctx.workspaces` 调宿主 `listDirectory` / `createDirectory` | 浏览与新建都走宿主原语 |
| 隐藏条目默认不显示，页脚开关揭开 | **过滤在客户端**，宿主始终列出并加标记 |
| 新建文件夹 | 嵌套创建对话框 |
| 无搜索 / 无多选 / 无重命名 / 无删除 | 明确的能力边界 |

关键结构（`_probe/dsh-picker/client.js`）：

| 锚点 | 行号 | 语义 |
| --- | --- | --- |
| `displayCrumbs(listing, homeLabel)` | `:149` | 把 home 及之前的段折成 `~`，crumbs 由宿主下发 |
| `separatorOf` | `:168` | 从 home 路径反推分隔符（Windows `\` / POSIX `/`） |
| `draftDirectory` / `readDraft` | `:183` / `:201` | 路径输入的草稿态 |
| `visibleEntries` | `:223` | 前缀过滤 + 隐藏过滤 + 选中项保留 |
| `LevelColumn` | `:235` | 单栏渲染 |
| `DirectoryBrowser` | `:283` | 整体 |
| `select` / `advance` | `:486` / `:534` | 单击选中 / 右栏点击推进 |
| `twoPane = selected !== null` | `:672` | **未选中 = 一整栏；选中后裂成「层级 ｜ 子项」两栏** |
| `targetPath = selected?.path ?? parent?.path ?? null` | `:565` | 目标优先级 |

三个常量定义了它的手感：`SLOW_SCAN_DELAY_MS = 300`（慢扫描提示延迟）、`PARENT_LEG_WAIT_MS = 200`（父级腿等待）、`DRAFT_PREVIEW_DEBOUNCE_MS = 250`（边打字边预览的防抖）。dsh-pi 一个都没有实现，见 6.4。

### 6.3 dsh-pi 的 DirSheet 交互规格

`DirSheet`（`client.js:3198-3496`）与纯函数 `dirPickModel`（`client.js:3167-3196`）。把数据模型单独抽成纯函数是为了让门禁能直接断言（`test/client-render.mjs` 的 9.13 / 9.14 / 9.15 三节共 40 条：SSR 首帧 15 条、Miller 分栏与采纳目标 14 条、「此电脑」层 11 条）。

#### 6.3.1 三个入口

| 入口 | 位置 | 渲染条件 | 形态 |
| --- | --- | --- | --- |
| 空态按钮 | `EmptyState` `client.js:2448-2459`（判据 `typeof props.onPickDir === 'function'` 在 `:2449`） | 有 `onPickDir` 才渲染 | `.dsh-pi-empty-actions` > `.dsh-pi-btn`：`DirIcon(14)` + 文案 `pickDir` |
| `+` 菜单项 | `Composer` 的 `addItems` `client.js:2802-2813`，目录项在 `:2804` | 恒定 | `{ key: 'dir', label: pickDir, keyName: 'workspace', icon: DirIcon, run: props.onPickDir }`。**0.6.2 起不再占 `.dsh-pi-bar` 的独立按钮位**：那一行改成宿主的「圆形 `+` + 模型 picker + 推理档位 picker」，目录与附件都收进 `+` 菜单（`.dsh-pi-bar` 在 `:2868`，首个按钮 `.dsh-pi-add` 在 `:2875`） |
| 弹窗挂载 | `client.js:5363-5369`（`var drawerNode` 在 `:5307`） | `drawer === 'dir'` | `DirSheet`，`startDir = activeCwd === '' ? runtime.workspace : activeCwd`，`onPick = switchDir` |

挂载点在 `client.js:5384`（EmptyState）与 `client.js:5400`（Composer），都是 `onPickDir: function () { setDrawer('dir') }`。

#### 6.3.2 初始状态

`listingState` 的初值（`client.js:3200`）：

```js
{ loading: true, error: null, dir: props.startDir, parent: null,
  writable: true, entries: [], truncated: false, home: '', roots: [] }
```

挂载后立刻 `useEffect(function () { go(props.startDir === undefined ? '' : String(props.startDir)) }, [])`（`client.js:3254`）。`go` 的四步（`client.js:3229-3252`）：

1. `setSelected(null)` + `setRootsView(false)`（回到普通层）；
2. 把 `loading` 置真、保留其余字段（不闪白）；
3. `api.directories(dir, '', 400)`；
4. 成功回填 9 个字段 + `setTyped(body.dir)`；失败**只写 error、保留 prev**（旧内容留在屏幕上，不整块塌掉）。

首帧的 SSR 实渲染（门禁 `test/client-render.mjs` 抓的样本）：

```text
div.dsh-pi-dialog-wrap
└ div.dsh-pi-dir-dialog[role=dialog][aria-modal=true][aria-label=选择工作区]
  ├ div.dsh-pi-dir-head
  │ ├ div.dsh-pi-dir-title  选择工作区
  │ └ button.dsh-pi-btn.dsh-pi-btn-ghost.dsh-pi-btn-icon[title=关闭][aria-label=关闭]  (16px CloseIcon)
  └ div.dsh-pi-dir
    ├ div.dsh-pi-dir-crumbs  C: › Users › PC › pi-workspace  (只有末段 data-last=1)
    ├ div.dsh-pi-row2  [input 输入绝对路径后回车] [input 筛选]
    ├ div.dsh-pi-dir-hint  单击选中、双击进入；不存在的路径在开新会话时自动创建
    ├ div.dsh-pi-dir-cols
    │ └ div.dsh-pi-dir-col
    │   └ div.dsh-pi-empty-row  正在读取目录…
    └ div.dsh-pi-dir-foot
      ├ span.dsh-pi-dir-target  C:\Users\PC\pi-workspace
      ├ span.dsh-pi-spacer
      └ button.dsh-pi-btn.dsh-pi-btn-primary[disabled]  用这个工作区
```

#### 6.3.3 可见状态机

| 状态 | 触发 | 界面表现 | 确认按钮 |
| --- | --- | --- | --- |
| **S1 首载** | 挂载 | `col0` 内 `-empty-row`「正在读取目录…」 | 禁用（`loading` 为真） |
| **S2 普通层** | `go` 成功、`rootsView=false`、`selected=null` | `col0` 列子项（`..` / 此电脑 / 主目录 / 子目录）；无 `col1` | 显示 `dirHere`，可点（`target = current`） |
| **S3 选中一层** | 单击某项 | `col0` 保留、`col1` 滑入装该项目的子项；`col1` 独立加载 | 目标 = `selected` |
| **S4 选中两层** | 在 `col1` 再单击 | `col1` 内选中，`deep` 记录 | 目标 = `deep` |
| **S5 此电脑层** | 点「此电脑」入口 | 面包屑只剩一段「此电脑」；`col0` 列盘符（`data-drive=1`）+ 一条「上一级」 | **禁用**（`rootsView` 且无选中时 `target` 为 `null`） |
| **S6 失败** | `api.directories` 抛错 | `col0`（或 `col1`）内 `.dsh-pi-alert` 显示 message；旧内容不消失 | 沿用 prev 的 `target` |

S5 是 0.4.x 新增的、DSH picker 没有的层。存在的理由写在两处注释（`client.js:3173-3174` 与 `:3223-3224`）：Windows 上从工作目录一路往上只能走到当前盘的根，**别的盘的工程永远进不去**。所以 `index.js` 的 `/directories` 多返回一个 `roots` 数组，面板在「上一级 / 主目录」之后插一个「此电脑」入口。

`dirPickModel` 里专门为 S5 写了一条约束（`client.js:3184-3186`，判定在 `:3186`）：**此电脑层什么都没选时 `target` 必须是 `null`，不能回落到 `current`**，否则「用这个工作区」会把上一浏览层级当成目标。

#### 6.3.4 鼠标动作

| 动作 | 落点 | 行为 | 代码 |
| --- | --- | --- | --- |
| 单击子目录 | `col0` 行 | `setDeep(null)` + `setSelected(path)` + `setTyped(path)`；触发 `col1` 加载 | `makeRow` `:3352-3374`（onClick `:3361-3365`） |
| 双击子目录 | 同上 | 清 `query` + `setDeep(null)` + `enter(path)`（直接进入该层，收起 `col1`） | 同上（onDoubleClick `:3366-3370`） |
| 单击盘符 | 此电脑层行 | 同上（盘符有 `path`） | 盘符分支 `:3388-3408`（`data-drive="1"` 在 `:3397`） |
| 双击盘符 | 同上 | 直接进入盘符根 | 同上（onDoubleClick `:3402-3404`） |
| 点「上一级」 | `..` 行 | `enter(parent)` | `:3411-3417`（用 `listing.parent`） |
| 点「主目录」 | `~` 行 | `enter(home)` | `:3432-3438`（`listing.home !== listing.dir` 才渲染） |
| 点「此电脑」 | 普通层入口 | `setDeep(null)` + `setSelected(null)` + `setRootsView(true)` | `:3422-3429`（`data-pc="1"` 在 `:3426`） |
| 点面包屑某段 | 头部 | 该段 `path` 为空或等于当前 `dir` 时 **无操作**，否则 `enter(path)` | `pathCrumbs` `:3301`，渲染 `:3305-3326`（`data-last` `:3315`，同路径 return `:3319`） |

双击的第二下必须把 `query` 清掉——否则进入新层时旧过滤词还在，用户会看到空列表。`client.js:3367` 的 `setQuery('')` 就是为这个（`enter` 里另有一处，在 `:3257`）。

#### 6.3.5 键盘动作

只有两个输入框接键盘，没有全局键盘导航（无 `↑`/`↓`/`Enter` 列表导航、无 `Esc` 关闭、无 `Tab` 陷阱）：

| 输入框 | 位置 | `Enter` | 其余键 |
| --- | --- | --- | --- |
| 绝对路径（`flex:1 1 auto`，占位符 `dirInputHint`） | `:3328-3341`（与筛选同一个 `.dsh-pi-row2`） | `enter(typed.trim())`，空串不动作（`:3336-3340`） | 普通文本输入 |
| 筛选（`width:160px`，占位符 `filter`） | `:3342-3348` | 无绑定 | 驱动 `query`（onChange `:3347`），实时过滤**最后一栏** |

这也是一个缺口，但**不是只剩一条路**：0.6.1 起每个抽屉与弹窗的右上角都是统一的 `CloseButton`（`client.js:1973`，`.dsh-pi-btn-icon` + 16px `CloseIcon`，32×32 命中区），点它等价于取消。仍然缺的是键盘 `Esc`（无全局 keydown 监听）与方向键列表导航；DSH picker 同样没有方向键导航（`README.zh.md` 说无搜索、无多选），所以两边都只有鼠标路径。

#### 6.3.6 过滤语义

`dirPickModel` 的匹配（`client.js:3179-3182`）：

```js
var match = function (entry) {
  if (query === '') return true;
  return String(entry.name === undefined ? '' : entry.name).toLowerCase().indexOf(query) >= 0;
};
```

**是子串（contains），不是前缀。** DSH 的 `visibleEntries`（`_probe/dsh-picker/client.js:223`）是 `name.toLowerCase().startsWith(needle)`，而且多一层保护：

```js
const narrowing = needle !== '' && entries.some(matches);
// 只有 needle 非空且确有命中时才收窄；无命中时显示全量
```

两条实际后果：

| 场景 | dsh-pi | DSH picker |
| --- | --- | --- |
| 输入 `workspace` | 命中 `my-workspace`、`workspace-old` | 只命中 `workspace-old` |
| 输入 `zzz`（无命中） | **空栏** | **显示全量**（用户能立刻看出「这个过滤没用」而不是「这层没东西」） |

过滤只作用于**最后一栏**（`client.js:3192-3193`）：`main` 在 `selected === null` 时才 `filter(match)`，一旦选中，第一栏就恢复全量，第二栏才是被过滤的那栏。这一点与 DSH 同构，是对的。

#### 6.3.7 采纳优先级

`target` 的三级回落（`client.js:3186`）：

```js
var target = deep !== null ? deep
           : (selected !== null ? selected
           : (rootsView ? null : current));
```

`accept()`（`client.js:3261-3269`）**不带参数**，自己算 `target`：`:3262` 若 `busy === true` 直接 return；`:3263` 重新调 `dirPickModel(...)` 算 target；`:3266` 若 `target === null || target === ''` 直接 return（这就是「选盘符不会把盘符当工作区」的实现）；否则 `setBusy(true)`（`:3267`）后调 `props.onPick(target)`（`:3268`）。

页脚的 `disabled` 条件（`client.js:3471`）是 `targetDir === '' || busy === true || listing.loading === true`（`canAccept`，用在 `:3478` 的按钮上）——注意它用的是**字符串是否为空**，不是 `target === null`，因为渲染时 `target` 已经被 `String(...)` 包过（`targetDir` 在 `:3470`）。

#### 6.3.8 采纳后的时序：`switchDir`

`switchDir`（`client.js:4670-4691`）是「切换工作区」的全部逻辑。JSDoc（`client.js:4666-4669`）写明这是**面板里唯一会销毁并重建 pi 子进程的操作**：

```text
用户点「用这个工作区」
  → accept() 算出 target
  → switchDir(target)
      1. trim 后为空 → 直接 resolve(null)，什么都不做
      2. closeStream()                 停 SSE
      3. sessionRef = null             断开对旧会话的引用
      4. viewRef = createView(); repaint()   清空消息视图
      5. api.close(id).catch(noop)      关旧会话（失败不阻塞）
      6. setDrawer(null)               关抽屉
      7. startSession(target)          用新 cwd 建会话
      8. notice(dirSwitched + ' · ' + landed)
```

第 7 步的 `startSession`（`client.js:4407-4438`）有一个关键分支：

```js
var existing = target !== null ? [] : state.sessions;
```

**指定了 cwd 就强制新建，绝不复用已有会话**（`client.js:4418`）。原因很直接：已有会话跑在旧 cwd 的子进程里，复用它等于什么都没改。所以带 `cwd` 时 `existing` 恒为空数组，必走 `api.create({ cwd: target })`。

`landed` 取 `metaRef.current.cwd`（子进程真实落地的目录），不是用户输入的字符串——因为宿主可能做路径规范化（`expandUserPath`）。通知里显示 `landed` 而不是 `target`，是为了让用户看到「实际进的是哪」。

### 6.4 与 DSH picker 的已知差异（17 条，如实标注）

按严重度分三档：**中** = 用户能感知的能力缺失；**低** = 视觉或结构差异；**极低** = 几乎不可见。

| # | 维度 | dsh-pi | DSH picker | 严重度 |
| --- | --- | --- | --- | --- |
| 1 | 过滤算法 | 子串 `indexOf` | 前缀 `startsWith` + 仅在有命中时收窄 | 中 |
| 2 | 对话尺寸 | 弹窗 `min(680px,100%)` × `min(500px,100%)`，内层 `-dir-cols` 只 `min-height:240px` | `min(680px,100%)` × `min(500px,100dvh-32px)`，`_millerRow` 撑满 | 低 |
| 3 | 栏数 | 恒有 `col0`；选中后追加 `col1` | 渲染 `parent` + `child` 两栏；`parent === null` 时最左栏不渲染 | 低 |
| 4 | 选中态 | `interactive-bg-active`；图标恒 `currentColor`；无 chevron | 同底色 + `_rowIconSelected{color:button-info-fill}` + `_rowChevron` | 低 |
| 5 | 当前目录标记 | `data-current="1"` → 文字色 `state-business-primary` + 文字徽标「已选中」 | `aria-current` + 图标着色 | 低（**无障碍退步**） |
| 6 | 面包屑来源 | 客户端 `pathCrumbs()` 自己切字符串，全路径逐段显示 + 另给一条「主目录」行 | 宿主下发 `listing.crumbs`，客户端 `displayCrumbs` 把 home 及之前折成 `~` | 低 |
| 7 | 路径编辑 | 常驻两行输入框，回车才生效，**无预览** | 面包屑尾部 glyph 点开变 input，边打字边预览（`DRAFT_PREVIEW_DEBOUNCE_MS=250`） | 中 |
| 8 | 隐藏项 | 无开关；宿主只按 `isDirectory` 过滤，`.git` 等点目录照常列出 | 页脚 `Show hidden` 开关（客户端过滤） | 中 |
| 9 | 新建文件夹 | 无；靠「不存在的路径在开会话时创建」 | 嵌套创建对话框（`createDirectory`） | 中 |
| 10 | 取消 | 只有右上角 `×` | 页脚显式 `Cancel` 按钮 | 低 |
| 11 | 页脚布局 | 左 `-dir-target` 文本、右「用这个工作区」 | 左 `New folder` + `Show hidden`、右 `Cancel` + `Open` | 低（dsh-pi **多显示了目标路径**，是优点） |
| 12 | 容器底 | 抽屉用 `.dsh-pi-sheet`（`bg-base` 铺满）；`DirSheet` 例外，用 `-dir-dialog`（`radius-panel` + `bg-layer-2`） | `_dialog` 恒为 `radius-panel` + `bg-layer-2` | 低 |
| 13 | 死键 | `dirMissing` 在 i18n 表里定义（ZH `:195` / EN `:397`），`client.js` **0 处引用** | 无此问题 | 低 |
| 14 | 分栏分隔 | 相邻兄弟选择器 `.dsh-pi-dir-col + .dsh-pi-dir-col{border-left:.5px}` | 独立 `_divider` span（`.5px` `border-l3`） | 低 |
| 15 | 开关过渡 | `.dsh-pi-switch` 多一条 `transition:background-color .16s ease` | `._switch_1ik0f_5` 无过渡 | 极低 |
| 16 | 设置项一致性 | 4 个设置项里只有 `autoCompaction` / `autoRetry` 是开关，另两个仍是文字按钮；注释 `client.js:3604` 的措辞会让人以为全改了 | 无对应 | 中 |
| 17 | home 来源 | `os.homedir()`，由宿主在 `/directories` 响应里给 | `listing` 字段的一部分 | 低 |

补充三条**注释与实现不一致**（不是 dsh-pi 与 DSH 的差异，是 dsh-pi 内部的文档债）：

| 位置 | 注释说什么 | 实际是什么 |
| --- | --- | --- |
| `client.js:674` | 「DSH `._float` 的配方：`bg-layer-2` + `radius-panel` + `elevation-prominent` + 局部描边色」 | `:675` 的 `.dsh-pi-sheet` 是 `bg-base` 铺满，没有 `radius`、没有阴影 |
| `client.js:745-746` | 「header（padding `22px 14px 12px 24px`）」 | `:750` 的 `.dsh-pi-dialog-head` 是 `padding:22px 18px 0 24px`，`:751` 的 `.dsh-pi-dialog-head h3` 是 `padding:0` |
| `client.js:3604` | 「开关对齐 DSH 的 `._switch_1ik0f_5`……不再是文字按钮」 | 只有两个是开关；`steeringMode` / `followUpMode`（`client.js:3622-3626`）仍是 `.dsh-pi-btn` 文字按钮 |

三条都属「描述超前于实现」。第六条（筛选无命中出空栏 vs 显示全量）是本轮唯一被用户直接感知的语义差异。

### 6.5 宿主契约：`GET /directories`

`index.js:905` 的路由（响应体 `:912-926`），响应：

```json
{ "ok": true,
  "dir": "C:\\Users\\PC\\pi-workspace",
  "parent": "C:\\Users\\PC",
  "writable": true,
  "entries": [{ "name": "docs", "path": "C:\\Users\\PC\\pi-workspace\\docs" }],
  "truncated": false,
  "home": "C:\\Users\\PC",
  "roots": [{ "name": "C:", "path": "C:\\" }, { "name": "D:", "path": "D:\\" }] }
```

字段来源逐条（`listDirectories` `index.js:1212-1248`）：

| 字段 | 实现 | 备注 |
| --- | --- | --- |
| `dir` | `path.resolve()` 后的绝对路径 | — |
| `parent` | `dirname(dir) === dir ? null : dirname(dir)` | 盘根给 `null` |
| `writable` | `fs.promises.access(dir, W_OK)` | 整段 `try/catch`；不可写也照常返回（`index.js:1246` 注释：「只读目录 / 权限不足：照样能把目录列出来，只是不能在这里开会话」） |
| `entries` | `opendir` + `dirent.isDirectory()` 过滤 | **符号链接天然跳过**（`dirent` 来自 `lstat` 语义）；**无 hidden 过滤**，`.git` 照常列出 |
| `truncated` | 超过 `limit`（默认 50，上限 200） | — |
| `home` | `os.homedir()` | **不是 `listing` 字段**，是路由层另加的 |
| `roots` | `await listRoots()` | 0.4.1 新增 |

错误码：`opendir` 失败时 `ENOENT` / `ENOTDIR` → **404** `no such directory`，其余 → **500**（归一在 `index.js:1218-1219`）。排序用 `localeCompare(a.name, b.name, { numeric: true, sensitivity: 'base' })`（`index.js:1234`），所以 `a2` 排在 `a10` 前面。

`listRoots()`（`index.js:1433-1454`）只对 Windows 有意义：

```js
// win32：探 A 到 Z，fs.promises.stat(letter + path.sep)，isDirectory 才保留
// 单个盘失败 catch 成 null，最后 .filter(Boolean)
// 非 win32：返回 [{ name: '/', path: '/' }]
```

带 10 秒缓存（`ROOTS_TTL_MS = 10000`，`index.js:1419`；`rootsCache` `:1420`）。注释 `:1422-1432` 说实测四个盘全扫约 3ms（`:1427`），「一个不可读的盘符不该毁掉整个目录浏览」（`:1429`）。

**能力边界**：宿主只提供「列子目录」，没有 `fs.stat` 单点查询、没有 `mkdir`、没有 `rename`、没有 `delete`。所以 6.4 的第 8 / 9 条差异（隐藏项开关、新建文件夹）**不是面板偷懒，是宿主能力没给**。要补这两个能力，得先在 `index.js` 加 `POST /directories`（mkdir）与 `hidden` 参数。

### 6.6 端到端示例：从 `~/pi-workspace` 切到 `D:\code\agent`

```text
① 用户点 composer 左侧的 `+`，菜单里选「工作区」（`addItems` 第 2 项，`client.js:2804`）
   Composer.onPickDir → setDrawer('dir')
   DirSheet 挂载，startDir = C:\Users\PC\pi-workspace
   go(startDir) → GET /directories?dir=C:\Users\PC\pi-workspace
   首帧：S1（loading），按钮禁用

② 响应回来：parent=C:\Users\PC，entries=[docs, src]，roots=[C:\, D:]
   状态 S2：col0 = [.. / 此电脑 / ~ / docs / src]
   target = current = C:\Users\PC\pi-workspace，按钮可点

③ 用户点「此电脑」（data-pc=1）
   setRootsView(true)，crumbs 变单段「此电脑」
   状态 S5：col0 = [.. (回上一浏览层级) / C: / D:]
   target = null（rootsView 且无选中），按钮**禁用**

④ 用户双击 D:
   清 query → setDeep(null) → enter('D:\\')
   setRootsView(false) → GET /directories?dir=D:\
   状态 S2：col0 = [.. / 此电脑 / ~ / code / ...]

⑤ 用户单击 code → 状态 S3，col1 加载 D:\code 的子项
   用户在 col1 单击 agent → 状态 S4，deep = D:\code\agent
   target = deep，页脚显示 D:\code\agent

⑥ 用户点「用这个工作区」
   accept() → busy=true → 文案变「正在切换…」
   switchDir(D:\code\agent)：
     closeStream → sessionRef=null → view 重置 → api.close(旧 id)
     → setDrawer(null) → startSession(D:\code\agent)
   startSession 里 existing 强制为 []，走 api.create({cwd})
   新子进程 spawn，通知「已在新工作区开会话 · D:\code\agent」
```

第 6 步的「通知里显示 landed 而不是输入值」是这个流程里唯一的容错设计：如果宿主把 `D:\code\agent` 规范化成 `D:\code\agent\`（或解析了软链），用户看到的是真实落地的路径，而不是自己敲的那个。

---

## 7 门禁

本章只写「机器能验什么」与「机器验不到什么」。所有断言都实跑过（离线，`exit 0`）。

### 7.1 `test/css-tokens.mjs`（596 行）

结构：

| 区块 | 行号 | 作用 |
| --- | --- | --- |
| 常量 | `:44-77` | `ALLOWED_EXTRA_TOKENS` / `BANNED_TOKENS` / `MONO_LITERALS` / `NAMED_COLORS` / `COLOR_PROPS` |
| `section()` | `:83` | 打印分节标题 |
| `check()` | `:89` | 单条断言累加 |
| `extractCss()` | `:220` | 从 `client.js` 还原 CSS 文本（处理 JS 单引号转义） |
| `selfTest()` | `:423-438` | 18 条自检，验证正则本身没写错 |
| 主流程 | `:441-455` | 抽取 → 断言 → 汇总 |
| 观察项 | `:465-485` | 规则数 / 字符数 / `var()` 数 / 唯一变量数 / 类别分布 |
| 七条硬断言 | `:557` `:561` `:567` `:573` `:577` `:581` `:585` | 见 3.8 |
| 通过行 | `:596` | `PASS (N checks)` + `exit 0` |

关键常量：

| 常量 | 行号 | 内容 |
| --- | --- | --- |
| `ALLOWED_EXTRA_TOKENS` | `:44-54` | `--ds-font-family-code`、`--dsh-content-font-size`、`--dsh-content-font-size-secondary`、`--dsh-content-font-delta`、`--dsh-code-font-size`、`--dsh-code-font-delta`、`--dsw-elevation-stroke-color` |
| `BANNED_TOKENS` | `:57` | `--dsw-alias-button-tool-bar-fill`、`--dsw-alias-button-tool-bar-hover`（在 `tokens.txt` 里是硬值 `#54555780` / `#54555799`） |
| `MONO_LITERALS` | `:60` | `ui-monospace` / `SFMono-Regular` / `Menlo` / `Consolas` / `monospace` |
| `NAMED_COLORS` | `:63-69` | 命名色黑名单（`white` / `black` / `red` …） |
| `COLOR_PROPS` | `:71-77` | 需要查色的属性集（`color` / `background` / `border*-color` / `box-shadow` / `outline*` …） |

实跑输出（0.6.4 实测）：

```text
client.js 307602 字节 / CSS 数组 240 段 / 35680 字符
-- 0 门禁自检  自检 18 条：全部通过
-- 1 硬色值    0 处
-- 2 令牌白名单 0 处越界
-- 3 兜底      0 处缺失
-- 4 禁用令牌   0 处
-- 5 等宽字体栈 0 处裸写
-- 6 焦点可见   有
-- 7 减少动效   有
PASS (98 checks)
```

「18 条自检」是这一整套门禁里最值得学的一处设计：**它先验证自己的正则**。用合成样例跑一次，样例里既有该报的（硬色值、缺兜底、裸字体栈），也有不该报的（合规写法）。没有自检的门禁最危险——正则写挂了整片全绿，而没人会发现。

### 7.2 `test/client-render.mjs`（820 行，738 assertions）

这是 SSR 渲染断言：用 `react-dom/server` 把组件渲染成字符串，再对 HTML 做字符串/正则断言。覆盖面板的全部主要组件。与本次改造直接相关的 8 条：

| 断言 | 行号 | 内容 |
| --- | --- | --- |
| 空态入口 | `:282` | 有 `onPickDir` 时必须渲染 `.dsh-pi-empty-actions` |
| 空态入口条件 | `:310` | 没传 `onPickDir` 时**不得**渲染该容器 |
| 开关类名 | `:327` | 设置抽屉里必须有 `class="dsh-pi-switch"` |
| 开关滑块 | `:331` | 必须有 `dsh-pi-switch-thumb` |
| DirSheet 根 | `:452` | 必须渲染 `.dsh-pi-dir` |
| 面包屑 | `:454` | 必须有 `.dsh-pi-dir-crumbs` |
| 首帧单栏 | `:459` | 未选中时 `class="dsh-pi-dir-col"` **恰好 1 个** |
| `dirPickModel` | `:470-522` | 25 条纯函数断言（9.14 Miller 分栏 14 条 + 9.15 盘符层 11 条），含 `dirPickModel(undefined).showSub === false`（`:501` 防 null 入参） |

开关那两条断言的措辞值得单列：`role=switch` + `aria-checked` 的 `true` / `false` 两态都要出现，且「开 / 关」二字**不得**作为按钮文本（避免用文字冒充开关）。这是把无障碍语义写进断言，比只查类名强得多。

`dirPickModel` 的 25 条纯函数断言是「纯函数抽出来」的直接回报：数据模型可以在没有 DOM、没有网络的情况下被完整验证。如果这段逻辑留在 `DirSheet` 的 `useState` 里，就只能靠渲染断言间接覆盖。整节 9.13 / 9.14 / 9.15 合计 40 条，全部打在目录选择器上。

### 7.3 门禁验不到的 5 处

这是本章最该被认真读的部分。**全绿不等于正确。**

| # | 缺口 | 后果 | 能不能补 |
| --- | --- | --- | --- |
| 1 | **CSS 只验令牌，不验几何** | `28px` 写成 `30px`、`radius-sm` 写成 `radius-md` 都不会被拦。5.1 的「已对齐 32 个」全靠人工比对 | 能，但要引入 computed style 快照（JSDOM 不支持 `var()` 解析，得上真浏览器） |
| 2 | **不验视觉回归** | 任何像素级偏移（padding 差 1px、阴影方向反了）都看不见 | 能，需要 Playwright + 基线图。当前仓库没有浏览器测试依赖 |
| 3 | **不验交互行为** | 双击进目录、`col1` 加载竞态、`target` 三级回落这些只有 `dirPickModel` 的纯函数部分被覆盖；`go` / `accept` / 第二栏 `useEffect` 全是未测代码 | 能，需要 `@testing-library/react` + 假 `api` |
| 4 | **不验无障碍** | `aria-current` 缺失（6.4 第 5 条）、`Esc` 关闭缺失、焦点陷阱缺失都不会被拦 | 能，`axe-core` 能覆盖大半 |
| 5 | **不验宿主契约** | `/directories` 的 `roots` 字段是新加的，若 `index.js` 回退掉这个字段，面板会静默进入「无盘符」状态（不是报错，是少了入口） | 能，`test/host-parity.mjs` 里加一条字段断言即可 |

另外两条**已知的语义偏差**也不可能靠门禁发现，因为两边都「实现正确」：

- 过滤用 `contains` 而非 `startsWith`（6.4 第 1 条）；
- 无命中时出空栏而非显示全量（同条）。

这两条只能靠人读代码或读本文发现。

---

## 附录 A 行号索引

全部基于 **client.js@5619 / 307602 B / sha256 前缀 `ACDCFE28FDFB`（dsh-pi 0.6.4）**。`client.js` 在 0.5.0 之后被并发改写十余次（4130 → 4556 → 4789 → 4873 → 5170 → 5572 → 5614 → 5619），**任何行号都会漂移**。定位请用类名 grep：

```powershell
Select-String -Path client.js -Pattern "\.dsh-pi-dir-cols\{"
Select-String -Path client.js -Pattern "function dirPickModel"
```

### A.1 组件与函数

| 名称 | 行号 |
| --- | --- |
| `CSS` 数组起 / 止 | `:443` / `:769` |
| `PiIcon` | `1761` |
| `DirIcon` / `FileIcon` / `DriveIcon` | `1775` / `1786` / `1798` |
| `iconSvg`（图标工厂） | `1817` |
| `CodeIcon` / `ImageFileIcon` / `ArchiveIcon` / `SheetFileIcon` / `DocIcon` | `1827` / `1835` / `1844` / `1853` / `1862` |
| `ThinkIcon` / `HashIcon` / `TerminalIcon` / `FrameIcon` / `SearchIcon` / `PencilIcon` / `SparkIcon` | `1872` / `1881` / `1891` / `1899` / `1909` / `1917` / `1925` |
| `WhaleTailIcon`（16 网格鲸鱼尾，工作状态行专用） | `1941` |
| `CloseIcon` / `PaperclipIcon` / `CloseButton` | `1951` / `1959` / `1973` |
| `ArrowUpIcon` / `StopSquareIcon`（发送键两态） | `1993` / `2005` |
| `pathCrumbs` | `2088` |
| `parseToolArgs` / `firstLineOf` | `2116` / `2127` |
| `TOOL_VIEWS` / `toolViewOf` | `2138` / `2149` |
| `TOOL_SUMMARY_FIELDS` / `primaryToolArg` | `2161` / `2163` |
| `ProcPath` / `procSummary` / `procHead` | `2178` / `2204` / `2221` |
| `ThinkingBlock` / `ToolBlock` / `ToolResultRow` | `2236` / `2248` / `2279` |
| `WorkingRow` / `usageLine` | `2311` / `2329` |
| `MessageRow` | `2362` |
| `EmptyState` | `2448` |
| `SlashMenu` | `2469` |
| `Composer` | `2546` |
| `submit`（Composer 内） | `2604` |
| `Sheet` | `2926` |
| `SessionsList`（纯渲染）/ `SessionsSheet`（容器） | `3003` / `3097` |
| `dirPickModel` | `3167` |
| `DirSheet` | `3198` |
| `TreeSheet` | `3505` |
| `ForkSheet` | `3538` |
| `StatsSheet` | `3556` |
| `SettingsSheet` | `3601` |
| `TextSheet` | `3631` |
| `FileSheet` | `3646` |
| `ExtensionDialog` | `3674` |
| `ImageOverlay` | `3753` |
| `SelfCheckChip` | `3859` |
| `RuntimeGate` | `3893` |
| `ModelsSheet` | `3941` |
| `ThinkingSheet` | `3979` |
| `NameSheet` | `3997` |
| `BashBlock` | `4023` |
| `PiPanel` | `4054` |
| `startSession` | `4407` |
| `switchDir` | `4670` |
| `markBusy` / `markIdle` / `createView` | `1373` / `1378` / `1383` |
| `applyRecord` | `1594` |
| `fmtDuration` | `2975` |

### A.2 CSS 关键行

| 规则 | 行号 |
| --- | --- |
| `.dsh-pi-root` + 全局三条 | `:449-452` |
| `.dsh-pi-head` 族 | `:455-457` |
| `.dsh-pi-dot` 及三态 | `:458-461` |
| `@keyframes dsh-pi-pulse` | `:462` |
| `.dsh-pi-chip` 族 | `:466-472` |
| `.dsh-pi-btn` 族 | `:479-491` |
| `.dsh-pi-scroll` / `-inner` | `:494` / `:495` |
| `.dsh-pi-row` / `-row-user` / `-body` | `:496-497` / `:500` |
| `.dsh-pi-bubble-user` | `:499` |
| `.dsh-pi-prose` 族 | `:502-507` |
| `.dsh-pi-code-inline` | `:508` |
| `.dsh-pi-fence` / `-fence-lang` / `-pre` | `:510-512` |
| `.dsh-pi-proc` / `.dsh-pi-tool` | `:521` / `:522` |
| `-proc-head` / `-proc-icon` / `-proc-label` / `-sep` / `-proc-text`（含两 tone）/ `-proc-note`（含两 tone）/ `-proc-path` / 运行中点动画 | `:523-540` |
| `.dsh-pi-sub`（子行组）/ `.dsh-pi-proc-body` / `.dsh-pi-tool-body` | `:542` / `:544` / `:545` |
| `.dsh-pi-working` / `-working-icon` / `-working-text` | `:550-552` |
| `.dsh-pi-tag` 五条（含四 tone） | `:555-559` |
| `.dsh-pi-usage` / `-caret` | `:560` / `:561` |
| `.dsh-pi-img` 族 | `:562-564` |
| `.dsh-pi-fileref` 族 | `:568-573` |
| `.dsh-pi-empty` 族 | `:576-580` |
| `.dsh-pi-center` / `-gate` / `-gate-card` 族 | `:581` / `:582` / `:583-586` |
| `.dsh-pi-composer` / `-inner` | `:595` / `:596` |
| `.dsh-pi-box` / `:focus-within` | `:597` / `:599` |
| `.dsh-pi-widget` / `-body` | `:600` / `:601` |
| `.dsh-pi-statusbar` 族 | `:604-605` |
| `.dsh-pi-ta` 族 | `:606-607` |
| `.dsh-pi-bar` 族 / `-add` 族 / `-picker` 族 / `-send` / `-stop` / `-thumb` 族 | `:608-611` / `:613-617` / `:619-627` / `:629-631` / `:632-633` / `:634-638` |
| `.dsh-pi-menu` 族（含 `-empty-row`）/ `-menu-add` 族 | `:641-651` / `:655-663` |
| `.dsh-pi-alert` / `-notice` 族 / `-queue` | `:666` / `:667-670` / `:671` |
| `.dsh-pi-sheet` 族 | `:675-685` |
| `.dsh-pi-sess` / `-proj` 族 / `-kv` 族 / `-tree` 族 | `:687-694` / `:695-697` / `:698-704` |
| `.dsh-pi-switch` 族 | `:707-714` |
| `.dsh-pi-dir` 族 | `:718-735` |
| `.dsh-pi-dir-dialog` 族 | `:739-742` |
| `.dsh-pi-dialog-wrap` / `-dialog` / `-dialog-head` 族 | `:747` / `:748` / `:750-755` |
| `@keyframes dsh-pi-modal-in` | `:749` |
| `.dsh-pi-opt` 族 / `-mini-ta` / `-row2` / `-spacer` / `-sr` | `:758-760` / `:761-762` / `:763` / `:764` / `:765` |
| `@media (prefers-reduced-motion)` | `:768` |
| 数组结束 `].join('')` | `:769` |

### A.3 i18n 键（ZH / EN）

`ZH` 自 `:36` 起、`EN` 自 `:239` 起（`ZH` 末键 `footerTokens` `:237`、`EN` 末键 `:439`，各 199 个键），两段键序一一对应（门禁用 `JSON.stringify` 比对键集）。

| 键 | ZH | EN |
| --- | --- | --- |
| `panelTitle` | 37 | 240 |
| `procThink` | 65 | 268 |
| `procBash` | 66 | 269 |
| `procRead` | 67 | 270 |
| `procReadImage` | 68 | 271 |
| `procWrite` | 69 | 272 |
| `procEdit` | 70 | 273 |
| `procGrep` | 71 | 274 |
| `procGlob` | 72 | 275 |
| `procList` | 73 | 276 |
| `procGeneric` | 74 | 277 |
| `procResult` | 75 | 278 |
| `deepDiving` | 76 | 279 |
| `working` | 77 | 280 |
| `durHour` | 79 | 282 |
| `durMin` | 80 | 283 |
| `durSec` | 81 | 284 |
| `tokens` | 82 | 285 |
| `exported` | 173 | 375 |
| `footerTokens`（末键） | 237 | 439 |
| `pickDir` | 184 | 386 |
| `dirTitle` | 185 | 387 |
| `dirHint` | 186 | 388 |
| `dirEmpty` | 187 | 389 |
| `dirLoading` | 188 | 390 |
| `dirUp` | 189 | 391 |
| `dirHome` | 190 | 392 |
| `dirThisPc` | 191 | 393 |
| `dirPickDrive` | 192 | 394 |
| `dirHere` | 193 | 395 |
| `dirNotWritable` | 194 | 396 |
| `dirMissing` | 195 | 397 |
| `dirSwitched` | 196 | 398 |
| `dirInputHint` | 197 | 399 |
| `dirPickMark` | 198 | 400 |
| `dirSwitching` | 199 | 401 |

`durHour` 与 `working` 之间隔着一行注释（`:78` / `:281`「单位自带尾随空格…」），所以键号在此处跳过 78 / 281。

`dirMissing` 是**死键**：只在 `:195` 与 `:397` 定义，`client.js` 零引用。`test/client-render.mjs` 会断言 ZH 与 EN 的键集一致，所以删它必须两边一起删，否则门禁红。

### A.4 宿主侧（index.js）

| 能力 | 行号 |
| --- | --- |
| `GET /directories` 路由 | `:905-927` |
| `listDirectories()` | `:1212` |
| `ROOTS_TTL_MS` / `rootsCache` | `:1419` / `:1420` |
| `listRoots()` | `:1433-1454` |
| `readChangelog()` | `:1463` |

---

## 附录 B 已知差异登记（D-01 ~ D-11）

把散落在第 4 / 6 章的偏差收成一张可跟踪的表。严重度沿用 6.4 的三档。

| 编号 | 差异 | 位置 | 严重度 | 性质 |
| --- | --- | --- | --- | --- |
| D-01 | 目录过滤用 `contains` 而非 `startsWith`；无命中出空栏而非全量 | `client.js:3179-3182` | 中 | 语义偏差 |
| D-02 | 无路径输入预览（DSH 有 250ms 防抖预览） | `client.js:3328-3348` | 中 | 能力缺失 |
| D-03 | 无隐藏项开关；`.git` 等点目录照常列出 | `index.js:1228`（`if (!dirent.isDirectory()) continue`，注释在 `:1227`） | 中 | 能力缺失（宿主未给） |
| D-04 | 无新建文件夹；不存在的路径靠开会话时创建 | — | 中 | 能力缺失（宿主未给） |
| D-05 | 当前目录标记用文字徽标而非 `aria-current` | `client.js:3352-3374`（`data-current` 与 `dsh-pi-dir-mark` 在 `:3359` / `:3373`） | 低 | 无障碍退步 |
| D-06 | `.dsh-pi-sheet` 注释称用 DSH `_float` 配方，实际是 `bg-base` 铺满 | `client.js:674-675` | 低 | 注释与实现不符 |
| D-07 | `.dsh-pi-dialog-head h3` 注释称 `22px 14px 12px 24px`，实际留白在 head（`:750` 的 `padding:22px 18px 0 24px`）、h3 本身 `padding:0` | `client.js:745-751` | 低 | 注释与实现不符 |
| D-08 | 菜单阴影 `elevation-panel`，DSH 同级菜单用 `elevation-prominent` | `client.js:641` | 低 | 令牌等级偏差 |
| D-09 | 按钮描边 `border-l4`，DSH `_outline` 用 `border-l3` | `client.js:479` | 低 | 令牌等级偏差 |
| D-10 | 开关胶囊多一条 `transition:background-color .16s ease` | `client.js:707` | 极低 | 动效差异 |
| D-11 | `dirMissing` 死键 | `client.js:195` / `:397` | 低 | 未使用键 |

另有两条**不是差异但值得记录**的实现选择：

- `-tool` 平铺行（无框无底）：`client.js:513-520` 有注释说明「框套框的噪音墙」（`:518`），是刻意决定，不是漏做；
- `-bubble-user` 的 `max-width:82%`：DSH 是 100%，dsh-pi 按 IM 惯例收窄，属合理分歧。

---

## 附录 C 待确认事项（4 项）

每项都写清「为什么没确认」与「怎么确认」，不做无依据的断言。

### C-1 `POST /sessions` 传不存在的 `cwd` 时，pi 是否真的创建目录

**为什么没确认**：需要真跑一个 pi 子进程（`pi --mode rpc`）并发一条 `POST /sessions`，本轮明令禁止运行会打真实 LLM 的测试。

**为什么重要**：`dirHint` 的文案（ZH `:186`）向用户承诺「不存在的路径在开新会话时自动创建」。如果 pi 实际不创建，这句文案就是错的。

**怎么确认**：起一个 pi 子进程，`POST /sessions {"cwd":"<不存在的绝对路径>"}`，看返回是 `ok` 还是 500，再看磁盘上是否出现该目录。

### C-2 `.dsh-pi-box` 的 `:focus-within` 是否对所有目标浏览器都触发

**为什么没确认**：需要真浏览器矩阵。仓库当前没有浏览器测试依赖（`test/` 全是 Node 单测 + SSR 字符串断言）。

**当前对策**：**只有一条通道** —— `client.js:599` 的 `.dsh-pi-box:focus-within{--dsw-elevation-stroke-color:var(--dsw-alias-state-business-primary)}`。0.4–0.6.1 曾同时维护 `.dsh-pi-box:focus-within`（`:462`）与 `[data-focus="1"]`（`:463`）双通道，0.6.2 把卡面换成 `--dsw-elevation-soft` 投影后，显式属性通道连同 JSX 里的 `data-focus` 一起删除（`grep data-focus client.js` = 0 命中）：描边由 elevation 的第一层表达，覆盖 `--dsw-elevation-stroke-color` 就够。

**怎么确认**：Playwright 在 Chromium / Firefox / WebKit 三引擎里 `focus()` 内部 `textarea`，断言 `.dsh-pi-box` 的 `box-shadow` 首层色等于 `state-business-primary` 的计算值（不再是 `border-color`）。

### C-3 `--dsh-code-font-size` 与 `--dsh-code-font-delta` 是否仍被 DSH 使用

**为什么没确认**：这两个变量列在 `test/css-tokens.mjs:44-54` 的 `ALLOWED_EXTRA_TOKENS` 白名单里（该白名单 0.6.4 起共 7 个令牌），但当前 `client.js` 的 CSS **一处都没引用**。它们可能是历史遗留，也可能是为将来预留。

**怎么确认**：在 `index-lh_YM6sT.css` 里 grep 这两个名字。若 DSH 自己也不用，白名单里应删掉（否则等于永久的空头许可）；若 DSH 用，则应升级为「必须带兜底」的强制项。

### C-4 DSH 的 `_float` 是否能作为抽屉的对标依据

**为什么没确认**：`_float_3oazc_158` 在 `index-lh_YM6sT.css` 里只做变量声明（`--dsh-float-*` 一类），没有实际的 `display` / `background` / `border-radius`。也就是说 DSH 的「抽屉」外观是应用层自己拼的，`index-lh_YM6sT.css` 不提供成品样式。

**为什么重要**：它决定了 `.dsh-pi-sheet`（`bg-base` 铺满）到底是「有依据的选择」还是「自创」。本文的判定是**自创**（见 4.10 与 5.3 的 C 档），因为找不到可指认的规则。如果将来找到 DSH 抽屉的成品样式，`.dsh-pi-sheet` 应重新评估。

**怎么确认**：在 DSH 客户端包里找抽屉/浮层的实际使用处（不是在 `index-lh_YM6sT.css` 里找，而是在用到 `_float` 变量的组件里找）。

---

## 附录 D 本文的自证

为了让读者能判断哪些数字可信，列出本文所有数值的采集方式：

| 数值 | 采集方式 | 可信度 |
| --- | --- | --- |
| 148 个 `.dsh-pi-*` 类 | 脚本 `matchAll` 去重，与门禁同源 | A（可复现） |
| 70 / 39 / 20 / 6 令牌分层（另 `--dsw-specific-*` 4 + `--dsw-static-*` 1，外部兜底 4） | 脚本统计 + 人工归类 | A（数字可复现，归类是判断） |
| 240 段 / 35680 字符 / 356 次 `var(`（顶层 351 处） | 门禁自身输出（字符数取汇总第 3 行，顶层引用取「令牌引用」行） | A |
| 32 / 45 / 69 / 2 档位分布 | 148 类逐个人工判定 | B（判据主观，但每档都列了具体依据） |
| DSH 规则原文与行号偏移 | 探针文件逐条 grep 验证存在 | A |
| DSH picker 逻辑行号 | 探针源码逐条 grep | A |
| `switch` 十一项一致 | 两边规则原文逐属性比对 | A |
| 17 条差异的严重度 | 主观分级 | C（判据已写明，可争议） |
| 52×52 缩略图 | **未找到依据** | D（已标待确认） |

凡是标 A 的都能用本文 2.4 节的命令重跑复现；标 B / C 的是判断，理由已逐条给出；标 D 的进附录 C。

---

_本文的样式与尺寸取证基于 client.js@4130（mtime 2026-11-14T06:06:46Z，sha256 前缀 `06fb24ca5cb7`）与 dsh-pi 0.5.1；当前版本为 client.js@5619（307602 B，sha256 前缀 `ACDCFE28FDFB`）/ dsh-pi 0.6.4。所有行号会随后续改动漂移，定位请用类名 grep。_

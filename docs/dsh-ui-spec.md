# dsh-pi UI 规格书：DSH 设计令牌对齐与目录选择器交互

| 项 | 值 |
| --- | --- |
| 文档版本 | 1.4 |
| 代码基线 | `client.js` 6178 行 / 340965 B / sha256 前 12 位 `58D4415C014F` |
| 版本号 | `package.json` version = **0.8.0**（`index.js` 的 `CONTRACT_VERSION` 同为 `0.8.0`；0.6.0 新增助手文本里的文件路径标签与 Composer 任意文件插入，0.6.1 新增类型图标文件标签、右键资源管理器定位与统一的 `CloseButton`，0.6.2 把 composer 换成宿主主对话区的卡面 + 圆形按钮 + `+` 菜单 + 底部统计行，0.6.3 修 composer 首次进入统计行无数字与统计行混入会话路径，0.6.4 把「思考块 + 工具行」重做成 DSH 会话流的过程行：思考 = 父行、工具调用 = 缩进子行组、工具结果并入调用行、末尾工作状态行（该行按 DSH `RunningStatus` 收尾：`--dsw-alias-label-deep-diving` 蓝字 + 16 网格鲸鱼尾 + `···`），0.7.0 把模型名与思考档位合成同一个 `.dsh-pi-picker-box` 锚点并换成自绘 `-picker-menu` 弹层（删掉原生 `<select>` 叠层与 `picker-wrap` / `picker-native` 两个类），新增顶栏 `more` 菜单（`MoreMenu`）、历史会话 `side` 左滑侧栏（`SidePanel`）、`dialog-wide` / `dialog-grow` / `dialog-content` 三个对话框变体与 `role=alertdialog` 的 `ConfirmDialog`，并给 `sess-top` 的子段加 `nowrap` 修「1 个会话」折行，0.8.0 把历史会话抽屉重做成**两级列表**（项目层 → 会话层，`SessionsList` / `SessionsSheet`）、给项目行与会话行加行内「更多」菜单（`row-more`，两项：重命名 / 在此新建会话、重命名 / 置顶），新增项目与会话的重命名弹窗（`RenameDialog`）、会话置顶（`pin` 图标 + 置顶优先的两遍分区排序）、宿主侧三条 `ui-prefs` 路由（`GET /ui-prefs`、`POST /ui-prefs/project`、`POST /ui-prefs/session`）与 `~/.dsh-pi/ui-prefs.json` 原子写偏好文件，修正会话标题胶囊的显示条件（由「既有偏好名又有 pi 会话名才显示」改为「只在标题位置已被名字占据时才把原始摘要放进胶囊」，只有 `firstMessage` 的会话也能看到摘要），并把过程流子行组的 18px 行盒改成与父行一致的 32px 步长（删掉子行 `line-height` 覆盖、组内 `gap` 0→8、子行缩进 22px→26px、行内三段间距统一 11px），附录 A 的行号已整体刷新到 0.8.0 实测值） |
| 设计系统基线 | DSH 客户端样式包 `index-lh_YM6sT.css`（87124 字符 / 748 条规则 / 17 个 `@keyframes`）与 `tokens.txt`（414 个 `--dsw-*` 令牌，浅深两套值） |
| 采集口径 | 全部数值由脚本从仓库文件与探针文件读出；两种字符口径（源文本 / 门禁还原文本）分别标注 |
| 适用范围 | 只描述样式令牌、组件规格与目录选择器交互。不改任何源码，本文件是**规格**而非实现 |

> **行号会漂移。** `client.js` 在取证期间被并发改写多次：0.5.0 因历史会话抽屉拆成容器 + 视图涨到 4130 行，0.6.0 又因文件标签与任意文件插入涨到 4556 行，0.6.1 因类型图标、`CloseButton` 与资源管理器定位涨到 4789 行，0.6.2 因 composer 重做涨到 4873 行，0.6.3 又因 composer 首帧统计与 dock 归位涨到 5170 行，0.6.4 因过程流按 DSH 会话过程流重做涨到 5572 行，同日又把末尾工作状态行按 DSH `RunningStatus` 收尾涨到 5614 行、把中文用时单位之间的半角空格去掉后涨到 5619 行，同日又给工作状态行的首帧加了 `Math.max(1000, …)` 钳位（不钳位首帧会闪「0秒」，与 DSH `RunningStatus` 的 `formatRunDuration(Math.max(1e3, now - startTime), t)` 同一处理）涨到 5619 行，0.7.0 再因 picker 合一弹层、`more` 顶栏菜单、`side` 左滑侧栏、三个对话框变体与过程流子行行盒涨到 5872 行，0.8.0 又因历史会话两级列表、项目与会话重命名、会话置顶、会话行内「更多」菜单与 `ui-prefs` 三条宿主路由涨到 6178 行。**附录 A 的行号已整体刷新到 0.8.0 实测值**；正文其余段落的行号本轮也已逐条重新实测到 0.8.0，但它仍会随下一次改动漂移，读者若在当前版本上找不到对应行，请用类名 grep 定位（例如搜 `dsh-pi-dir-cols`），类名是稳定锚点，行号不是。样式令牌与尺寸规格不受行号漂移影响。

---

## 1 目的与范围

### 1.1 目的

dsh-pi 是 DSH 侧栏里的 pi 面板，它的视觉必须与宿主 DSH 属于同一个设计系统：同一套颜色语义、同一套字号阶梯、同一套圆角与阴影、同一套状态色。做不到这一点，面板就会像一个外挂 iframe 贴在界面上。

本规格书解决三件具体的事：

1. **令牌纪律**：哪些 `--dsw-*` 允许用、每个令牌负责什么语义、哪些令牌禁止引用、外部变量必须怎么写兜底。
2. **组件对齐**：每个 `.dsh-pi-*` 类对应 DSH 的哪个组件、依据是 `index-lh_YM6sT.css` 里的哪条规则、几何与状态差异在哪。
3. **目录选择器**：DSH 的 directory-picker 是一个有明确交互契约的组件（Miller 分栏、前缀过滤、目标路径优先级）。dsh-pi 的 `DirSheet` 是它的对等物，交互必须写死，否则每改一次都会漂。

### 1.2 在范围内

- `client.js` 内联 CSS 数组（`:477` – `:874`）的每一条规则。
- 174 个 `.dsh-pi-*` 类名与 74 个唯一 CSS 变量的对应关系。
- 16 个组件族的规格：几何、令牌、状态、与 DSH 的差异（含 0.7.0 新增的五个外壳组件与过程流排版、0.8.0 新增的 §4.15 历史会话两级列表与 §4.16 `ui-prefs` 三条宿主路由）。
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
| `client.js` | 6178 | 340965 | 2026-11-15T22:43:42Z |
| `index.js` | 1593 | 75041 | 2026-11-15T15:03:06Z |
| `package.json` | 77 | 2650 | 2026-11-15T15:03:06Z |
| `src/ui-prefs.mjs` | 404 | 20748 | 2026-11-15T13:28:41Z |
| `test/css-tokens.mjs` | 597 | 28485 | 2026-11-14T21:28:10Z |
| `test/client-render.mjs` | 888 | 70326 | 2026-11-15T22:44:47Z |
| `src/rpc-contract.mjs` | 324 | 19692 | 2026-11-15T22:44:15Z |

`docs/` 目录在本文件创建前只有 `parity.md`（现 285 行 / 71573 B）。

---

## 2 令牌来源与采集方法

### 2.1 四个数据来源

| 编号 | 来源 | 位置 | 规模 | 用途 | 可信度 |
| --- | --- | --- | --- | --- | --- |
| S1 | DSH 组件规则 | `_probe/dsh-css/index-lh_YM6sT.css` | 87124 字符 / 748 条规则 / 17 个 `@keyframes` | 组件级对齐依据（几何、状态、动效） | A：原始产物，逐条原文可 grep |
| S2 | DSH 令牌表 | `_probe/dsh-theme/tokens.txt` | 414 个 `--dsw-*`，格式 `name = 浅 \| 深` | 令牌值、浅深两套、别名链 | A：原始产物 |
| S3 | DSH 目录选择器源码 | `_probe/dsh-picker/client.js` | 1138 行，CSS 在 `:26` 单行内联，hash 前缀 `_3zXc5G_` | Miller 分栏、`visibleEntries`、目标路径优先级 | A：原始产物 |
| S4 | dsh-pi 现状 | `client.js` 的 CSS 数组 `:477` – `:874` | 277 段字符串 / 174 个 `.dsh-pi-*` 类 | 现状记录与逐类映射 | A：仓库文件 |

探针目录 `_probe/` 在 `C:/Users/PC/Documents/pi-local/` 下，不在 `dsh-pi` 仓库内。它是采集时的快照，不是构建产物；S1–S3 的内容可能随 DSH 升级变化，届时需要重新采集。

### 2.2 两种字符口径

同一个 CSS 数组有两个长度，永远说清是哪个：

| 口径 | 值 | 含义 | 谁在报 |
| --- | --- | --- | --- |
| 源文本 | 39760 字符 | 277 段 JS 单引号字面量还原后的长度之和（CSS 里没有转义序列，故与还原文本相等） | 人工统计 |
| 还原文本 | 39760 字符 | 去掉引号、还原 `\'` 与 `\uXXXX` 转义后的浏览器实际 CSS 文本 | 门禁 `test/css-tokens.mjs` 主流程 `:447` 的 `extractCss(source)`，输出第 3 行「CSS 数组 277 段 / 39760 字符」 |

两个数相等（39760）：CSS 里已无 `\'` 与 `\uXXXX` 转义，源文本与浏览器实际解析到的文本逐字符相同。**报告与评审一律引用还原文本 39760**，因为它才是浏览器解析的东西。

### 2.3 可信度分级

- **A 级**：直接从文件读出的原文或统计值。本文绝大多数结论属此类。
- **B 级**：从 A 级数值推算出的判断（例如「dsh-pi 的 74 个变量里 70 个是 `--dsw-*`，说明令牌纪律覆盖了 94.6%」）。
- **C 级**：无法从文件证实、只能标注「待确认」的项。全文共 4 条，集中在附录 C。

### 2.4 复现命令

```
cd C:/Users/PC/Documents/pi-local/dsh-pi
node test/css-tokens.mjs     # 令牌门禁，期望 PASS (98 checks)
node test/client-render.mjs  # 渲染门禁，期望 PASS (797 assertions)
```

两条命令都离线可跑，不打真实 LLM，不进 `npm test` 的耗时大头。`npm test` 共十一项，顺序是 `selfcheck → client-render → css-tokens → runtime-resolve → config-hot → host-parity → session-projects → timeout → parity → restart-lib → version`。

### 2.5 引用约定

- DSH 规则一律写完整选择器：`._switch_1ik0f_5`、`._thumb_1ik0f_33`。hash 后缀不是噪音，它区分同名族。
- 令牌名首次出现写全名 `--dsw-alias-label-primary`，同节后续可缩写为 `label-primary`。
- `--dsh-*` 与 `--ds-*` 不是 DSH 设计令牌，是宿主注入的运行时变量，引用时必须带第二个参数兜底。

---

## 3 令牌三层清单

### 3.1 三层划分

`client.js` 的 CSS 数组用到 74 个唯一 CSS 变量。`var(` 在 CSS 文本里出现 **382 次**，其中 16 次是兜底位置里嵌套的 `var()`（`var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))`、`var(--dsh-content-font-size,var(--dsw-font-s-14-font-size))` 与 `var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, …)` 三类），所以按「顶层引用」计 **366 处 / 74 个唯一变量**。本文正文的用量表用 382（含嵌套，逐次可数），门禁汇总行印 377（门禁自己 `extractCss` 后的正则口径，比正文少算 5 处带逗号的兜底嵌套）。三个数并存不是错误，是三种口径：**同一份 CSS 文本，正文逐次手数 = 382，顶层 = 366，门禁 = 377**。按「换主题时应不应该跟着变」切成三层，另有两类不便归入主题语义的令牌单列：

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

**`focus-ring-color` 是这套系统里唯一的坑。** DSH 把 `--dsw-focus-ring-color` 定义成 `transparent`（等于「默认不要焦点环」），所有 DSH 组件都在规则里写 `outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))` —— 靠 `var()` 的第二个参数兜底。dsh-pi 在 `.dsh-pi-root` 上直接把这个变量重绑成 `state-business-primary`（`client.js:483`），于是整个子树拿到的是真色值，`var()` 的第二参数永远不生效但保留着，作为「万一宿主改了」的保险。这是刻意设计，注释 `client.js:480-482` 写明了理由。

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

`var(` 共出现 382 次（含 16 次兜底嵌套，按顶层引用计 366 处；门禁自己的口径印 377 处），按次数降序（前 22）：

| # | 令牌 | 次数 |
| --- | --- | --- |
| 1 | `--dsw-alias-label-primary` | 32 |
| 2 | `--dsw-font-xxxs-11-font-size` | 25 |
| 3 | `--dsw-alias-label-secondary` | 20 |
| 4 | `--dsw-alias-state-business-primary` | 19 |
| 5 | `--dsw-alias-label-tertiary` | 16 |
| 6 | `--dsw-alias-interactive-bg-hover` | 14 |
| 7 | `--dsw-alias-label-caption` | 14 |
| 8 | `--dsw-alias-state-error-primary` | 13 |
| 9 | `--dsw-font-xxs-12-font-size` | 13 |
| 10 | `--ds-font-family-code` | 11 |
| 11 | `--dsw-radius-sm` | 11 |
| 12 | `--dsw-font-xxxs-11-line-height` | 10 |
| 13 | `--dsw-font-xxs-12-line-height` | 9 |
| 14 | `--dsw-radius-md` | 9 |
| 15 | `--dsw-alias-border-l3` | 8 |
| 16 | `--dsw-alias-state-warn-primary` | 8 |
| 17 | `--dsw-font-s-14-font-size` | 8 |
| 18 | `--dsh-content-font-delta` | 7 |
| 19 | `--dsw-alias-state-success-primary` | 7 |
| 20 | `--dsw-font-xs-13-font-size` | 7 |
| 21 | `--dsw-font-xs-13-line-height` | 7 |
| 22 | `--dsw-alias-bg-layer-2` | 6 |

长尾 52 个各 1–5 次。用量分布说明一件事：**文本与语义色是主体，几何令牌是配角。** 前 7 名里 5 个与颜色有关，两个字号令牌（11px / 12px）合计 38 次（25 + 13），是这套 UI 里出现最频繁的字号。这也解释了为什么 DSH 的界面看起来「信息密度高但不乱」——它把最小的两档字号当主力，用颜色层次而不是字号层次来分组。

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
| 历史会话列表（0.8.0） | `interactive-bg-hover`（行内 ⋯ hover）、`label-tertiary`（⋯ 图标与摘要胶囊）、`label-primary`（⋯ hover 文字）、`radius-xs`（22px 命中区）、`state-business-primary`（置顶徽标） |

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

## 4 组件规格（16 节）

每节五段：**来源**（首行固定格式，指向 `index-lh_YM6sT.css` 的规则）→ **令牌** → **几何** → **状态** → **差异**。

「差异」一栏只写事实，不写「建议」。可改可不改的判断集中放在第 6 章与附录 B。

### 4.1 根容器与全局基线

**来源：index-lh_YM6sT.css 的 ._pane_3oazc_211 与 ._switch_1ik0f_5:focus-visible**

`.dsh-pi-root`（`client.js:483`）是整个面板的根，它做四件事：铺底色、立字体基线、重绑两个宿主变量、立全局三条基础规则。

**令牌**：`bg-base`、`label-primary`、`font-family`、`font-s-14-font-size`、`font-s-14-line-height`、`scrollbar-bg-l2`、`scrollbar-hover-l2`、`state-business-primary`（重绑焦点环）。

**几何**：`display:flex` / `flex-direction:column` / `height:100%`。没有 padding、没有圆角、没有阴影——它是容器不是卡片。DSH 的 `._pane_3oazc_211` 也是同一套：`display:flex;flex:1 1 auto;flex-direction:column;min-width:0;min-height:0;overflow:hidden`。两者的共同点是**把滚动交给子元素**，根节点自己 `overflow:hidden`。

**三条全局规则**：

| 行号 | 规则 | 作用 |
| --- | --- | --- |
| `:484` | `.dsh-pi-root *{box-sizing:border-box}` | 面板是独立子树，不能假设宿主已经设过 |
| `:485` | `:is(button,input,select,textarea){font-family:inherit}` | 浏览器对表单控件默认给系统字体，不继承会突然出现另一种字形 |
| `:486` | `:is(button,input,select,textarea,summary,a,[tabindex]):focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,…);outline-offset:2px}` | 用属性选择器兜住所有可聚焦元素，而不是逐个类名写 |

**状态**：根节点没有状态。状态全在子元素上，通过 `data-*` 属性表达（`data-state`、`data-tone`、`data-selected`、`data-current`、`data-active`、`data-clickable`、`data-leaf`、`data-disabled`、`data-focus`、`data-drive`、`data-pc`、`data-last`）。这套约定让状态切换只改属性不改类名，CSS 选择器保持稳定。

**差异**：

1. DSH 的 `._pane_3oazc_211` 不含底色调，底色由更上层的 surface 决定；dsh-pi 的根自己铺 `bg-base`。因为面板要能独立存在于侧栏，不能假设父级已经铺过底。
2. `:486` 用 `[tabindex]` 兜底，DSH 用逐组件写 `:focus-visible`。ds-pi 的做法覆盖面更广但也更容易和宿主的环叠加——目前不会，因为面板在独立 iframe/容器里。
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

`@keyframes dsh-pi-pulse`（`:496`）只动 `opacity`：`0%,100%{opacity:1} 50%{opacity:.35}`。没有 scale、没有位移。这与 DSH 全部 17 个 keyframes 的风格一致——除 `_spin_u7vgf_45`、`_dsh-state-dot-spin_1i3xo_1`、`_dsh-state-dot-dash_1i3xo_1` 三个旋转类之外，**其余 14 个都只动 opacity**。

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

**几何**（`client.js:562-602`；逐项定稿数值见 §4.14）：

| 元素 | 几何 |
| --- | --- |
| `.dsh-pi-proc` / `.dsh-pi-tool` | **无边框、无背景、无阴影**（`border-radius:0`），`display:block` |
| `.dsh-pi-proc-head` | `display:flex`、`align-items:center`、`line-height:calc(24px + delta)`、无 `padding`（行距由 `line-height` 给，24px 行高对实测的 24px） |
| `.dsh-pi-proc-icon` | 16×16 框、`margin-right:11px`（行内三段间距统一 11，见 §4.14） |
| `.dsh-pi-sep` | 2×2 圆点、`margin:0 11px`、`border-radius:1px`（不是圆，DSH 的「·」是 2px 方块） |
| `.dsh-pi-proc-text` | `flex:1 1 auto` + `text-overflow:ellipsis` 单行省略 |
| `.dsh-pi-proc-note` | 行尾状态（失败 / `exit N` / truncated），`tabular-nums` 防宽度跳动 |
| `.dsh-pi-proc-path` | 整路径可点：`text-decoration:underline 1px dotted`、`text-underline-offset:3px`、`color:inherit` |
| `.dsh-pi-sub` | `margin:0 0 0 26px`、`padding:0 0 0 12px`、`border-left:1px solid border-l3`、`gap:8px`（行盒沿用父行的 24px，组内间距与 body 同为 8px ⇒ 子行步长与父行一致） |
| `.dsh-pi-proc-body` | `margin:2px 0 2px 26px`、`padding:0 0 0 14px`、`border-left:1px solid border-l3`、`white-space:pre-wrap` |
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
| `.dsh-pi-picker` | `height:28px`、`max-width:220px`、`radius-sm`（触发按钮本体，`:669`） |
| `.dsh-pi-picker-box` | `position:relative`、`display:flex`、`align-items:center`、`min-width:0`、`flex:0 1 auto`（`client.js:824`；模型名与思考档位共用这一个定位锚点，0.7.0 删掉了原生 `<select>` 叠层与 `-picker-wrap` / `-picker-native`） |
| `.dsh-pi-picker-menu` | `left:0`、`right:auto`、`bottom:calc(100% + 6px)`、`min-width:260px`、`max-width:min(380px,calc(100vw - 48px))`（`client.js:825`；**向上弹**，与 `-more-menu` 的向下展开方向相反） |
| `.dsh-pi-picker-sec` | `padding:8px 8px 4px`、11px、`label-caption`（`client.js:826`；段标题 = 「选择模型」/「思考档位」） |
| `.dsh-pi-picker-row` | `min-height:32px`、`padding:5px 8px`、`radius-md`、13px（`client.js:827`）；`:hover` 转 `interactive-bg-hover`（`:828`）、`[data-current="1"]` 内描边 `state-business-primary`（`:829`） |
| `.dsh-pi-picker-empty` | `padding:10px 8px`、12px、`label-dimmed`（`client.js:832`；加载中与空列表同款） |
| `.dsh-pi-send` / `.dsh-pi-stop` | `34px × 34px`、`999px`、`translateY(-2px)`，同一位置互斥显示 |
| `.dsh-pi-widget-body` | `max-height:120px`、可滚动 |
| `.dsh-pi-thumb` | `52px × 52px`、`radius-sm`、内描边 `border-l3` |
| `.dsh-pi-thumb-x` | `16px × 16px`、`radius-xs` |

**状态**：聚焦只有**一条通道** —— `client.js:649` 的 `.dsh-pi-box:focus-within{--dsw-elevation-stroke-color:var(--dsw-alias-state-business-primary)}`：把 elevation 的描边层换成品牌色，投影保留。0.4–0.6.1 曾并行一条 `[data-focus="1"]` 通道，0.6.2 换成 elevation 表达后已删除（全文件 grep `data-focus` 命中 0，旧文档的双通道描述作废）。卡内按钮各自有 hover / `:disabled` / `[data-open="1"]` 三态。

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
| `.dsh-pi-more-wrap` | `position:relative`、`display:flex`（`client.js:835`） | 无对应物：DSH 浮层由父容器承担定位 |
| `.dsh-pi-more-menu` | `left:auto`、`right:0`、`top:calc(100% + 6px)`、`bottom:auto`、`min-width:184px`、`max-width:min(260px,calc(100vw - 32px))`（`client.js:836`；顶栏 `···` 向右下展开） | `._list_1p5el_7` 的定位族：DSH 的浮层一律向下，dsh-pi 从顶栏锚点向右下展开 |
| `.dsh-pi-more-item` | `min-height:32px`、`padding:6px 8px`、`radius-md`、13px，hover `interactive-bg-hover`（`client.js:837`） | `._item_1p5el_105`：同族菜单项，DSH `min-height:34px` |
| `.dsh-pi-more-icon` | `16px × 16px` 居中容器、`label-secondary`（`client.js:839`） | `._itemIcon_1p5el_165`：DSH `14px × 14px` + `menu-icon` |
| `.dsh-pi-more-label` | `flex:1 1 auto` + 单行省略（`client.js:871`） | `._itemLabel_1p5el_208`：同为 `flex:1` + `text-overflow` 单段标签 |

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

`client.js:723`（规则体在 `:724`） 的注释说「DSH `._float` 的配方：bg-layer-2 + radius-panel + elevation-prominent + 局部描边色」，但实际渲染用的是 `bg-base` 铺满。注释与实现不一致——见附录 B 的 D-06。

**状态**：抽屉本身无状态；内部卡片有默认 / hover / `data-current` / `data-clickable` / `data-leaf` 五态；搜索框有聚焦 / 占位符两态。

**差异**：

1. **无 DSH 对标物**（见上）。判定依据只能到「令牌全部合法」这一层，不能宣称「与 DSH 某组件一致」。
2. **`.dsh-pi-sess` 的 hover 同时改底色与描边色**（`bg-layer-1 → bg-layer-2`、`border-l2 → border-l4`），这需要两条令牌同时移动。DSH 的 `._item_1p5el_105` hover 只改底色。dsh-pi 的做法信息量更大，属可接受的扩展。
3. **注释与实现不一致**（`client.js:723`，见上）。

### 4.11 开关

**来源：index-lh_YM6sT.css 的 ._switch_1ik0f_5 / ._thumb_1ik0f_33**

**令牌**：`.dsh-pi-switch` → `border-l3`（关闭底）、`brand-primary`（开启底）；`.dsh-pi-switch-thumb` → `label-primary-foreground`（开启滑块）、`switch-thumb`（关闭滑块）。

**几何与状态逐条对照**（`client.js:760-767` vs DSH 原文）：

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

**状态**：`role="switch"` + `aria-checked` + `aria-labelledby`，React 侧用 `id="dsh-pi-sw-<key>"` 关联标签。`SettingsSheet`（`client.js:4148-4175`）里只有 `autoCompaction` 与 `autoRetry` 两个真开关（`client.js:4166` / `:4167`）；`steeringMode` 与 `followUpMode` 仍是 `.dsh-pi-btn` 文字按钮（`client.js:4168-4173`），与 DSH 的 `._toggle_jrv99_5` 同族但不是开关形态。

**差异**：

1. 胶囊过渡（见上）。
2. **四个设置项只有两个是开关**。注释 `client.js:4151` 说「开关对齐 DSH 的 `._switch_1ik0f_5`（36x20 胶囊 + 16px 滑块），不再是文字按钮」，但实际只改了两个。另外两个是双值枚举（`one-at-a-time` / `all`），做成开关语义不成立（不是布尔），保持文字按钮是对的；但注释的措辞会让人误以为四项都改了。

### 4.12 对话框

**来源：index-lh_YM6sT.css 的 ._dialog_14mp3_33 / ._mask_14mp3_18 / @keyframes _modalEnter_14mp3_1**

**令牌**：`.dsh-pi-dialog-wrap` → `bg-mask-1`；`.dsh-pi-dialog` → `radius-panel` + `bg-layer-2` + `elevation-prominent`；`h3` → `font-base-strong-16` + `label-primary`；`-dialog-msg` → `label-secondary` + `--dsh-content-font-size` + `--dsh-content-font-delta`；`-opt` → `radius-md` + `bg-layer-3` + `font-xs-13-*`；`-mini-ta` → `border-l4` + `radius-sm` + `bg-base` + `--ds-font-family-code`；0.7.0 的三个变体：`-dialog-wide` → 只改宽度、`-dialog-content` → 内容区滚动容器、`-dialog-grow` → 可增长区。

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
| 宽变体 | `.dsh-pi-dialog-wide`（`client.js:869`）`width:min(560px,100%)` | 无对应（DSH 只有一档宽度） |
| 内容区 | `.dsh-pi-dialog-content`（`client.js:873`）`padding:14px 24px 22px`、`overflow-y:auto` | 由宿主应用层组合 |
| 可增长区 | `.dsh-pi-dialog-grow`（`client.js:870`）`flex:1 1 auto` + `min-height:0` + `overflow-y:auto` | 无对应 |

**入场动画逐帧对照**：

```css
@keyframes dsh-pi-modal-in{0%{opacity:0}to{opacity:1}}          /* client.js:802 */
@keyframes _modalEnter_14mp3_1{0%{opacity:0}to{opacity:1}}      /* DSH 原文 */
```

两条**完全相同**：只有 opacity，没有 scale、没有 translate。这与 DSH 全部 17 个 `@keyframes` 的风格一致（除三个旋转类外全是纯 opacity 过渡）。

**状态**：`-opt` 有默认 / hover / `data-active="1"`（内描边转 `state-business-primary`）三态；`-mini-ta` 有默认 / 聚焦两态；可滚动的是 `-dialog-content`（`client.js:873`，`overflow-y:auto`），`-dialog-body`（`:809`）只是居中容器，两者不是同一条规则。

**差异**：

1. **宽度 440 vs 380**。dsh-pi 的对话框要容纳选项列表与多行输入，宽 60px 是刻意的。
2. **DSH 用 `gap:20px` 统一间距，dsh-pi 用三段 padding 精确控制**。DSH 的写法更简单，dsh-pi 的写法能做出「标题紧贴顶、按钮区留白大」的层次。
3. **遮罩少了 `backdrop-filter`**。DSH 的 `._mask_14mp3_18` 有 `backdrop-filter:var(--dsw-mask-blur)`，dsh-pi 直接铺 `bg-mask-1`。查 `tokens.txt`：`--dsw-mask-blur = none`，所以当前两者视觉一致；但若 DSH 将来把 `mask-blur` 改成非 none，dsh-pi 不会跟随。
4. **`dsh-pi-modal-in` 是全局 keyframes 名字**，不带 hash 前缀，有被宿主同名动画覆盖的理论风险（实际不会，因为面板在同源独立文档流里）。

> 目录选择器（`DirSheet`）的规格单独放在第 6 章，因为它的交互复杂度远超一般组件，且它是本次改造的核心。

### 4.13 外壳组件（0.7.0 新增五个）

**来源：index-lh_YM6sT.css 的 ._dialog_14mp3_33 / ._mask_14mp3_18 / ._list_1p5el_7 / ._pane_3oazc_211（均为部分对标）**

0.7.0 把此前散落在面板里的三类浮层收成五个可复用的外壳组件。它们全部复用 `.dsh-pi-menu` 的底、阴影与毛玻璃配方（`:663`），只在定位与宽度上覆盖；三处弹层（列表 / 顶栏 `···` / 模型档位）共用同一套外观，差别只有弹出方向。

| 组件 | 函数 | 角色与语义 | 结构与关键几何 |
| --- | --- | --- | --- |
| `Dialog` | `client.js:3119-3127` | `div.dsh-pi-dialog-wrap` → `div.dsh-pi-dialog` + `role="dialog"` + `aria-modal="true"` + `aria-label=<title>` | 根走 `.dsh-pi-dialog-wrap`（`:800`，`bg-mask-1` + `z-index:40` + `padding:20px`）；`.dsh-pi-dialog`（`:801`，`width:min(440px,100%)` + `radius-panel` + `bg-layer-2` + `elevation-prominent` + `dsh-pi-modal-in .16s`）；`props.wide === true` 时类名追加 `dsh-pi-dialog-wide`（`:869`，`min(560px,100%)`）；内部 = `-dialog-head`（`:803`）+ 正文容器 **`-dialog-content`**（`:873`，`padding:14px 24px 22px`，注释 `:872` 说明底部多留 22px 防贴边，依据实拍 p071-04）。**注意是 `-dialog-content` 不是 `-dialog-body`**，两者并存但不是同一条规则 |
| `SidePanel` | `client.js:3135-3155` | `div.dsh-pi-side-wrap` → `div.dsh-pi-side` + `role="dialog"` + `aria-modal="true"` + `aria-label` | JSDoc `:3129-3134` 记录需求（用户 30427：「从页面左侧向右侧弹出侧边栏」）。`.dsh-pi-side-wrap`（`:842`，`position:absolute;inset:0;z-index:30` + `bg-mask-1`）→ `.dsh-pi-side`（`:843`，`width:min(360px,86%)` + `height:100%` + `bg-base` + `elevation-panel` + `animation:dsh-pi-side-in .18s ease-out`）；`@keyframes dsh-pi-side-in`（`:844`）`translateX(-100%)` → `translateX(0)`，即左滑入场；结构 = `-side-head`（`:845`，含 `-side-title` `:846` 与 `CloseButton`）+ **可选** `-side-actions`（`:850`，仅 `props.actions` 存在时渲染）+ `-side-body`（`:847`，可滚动）。遮罩点击命中自身时关闭 |
| `ConfirmDialog` | `client.js:3161-3172` | `role="alertdialog"` + `aria-modal="true"`（**不带 `-dialog-wide`**） | JSDoc `:3157-3160` 说明为什么单独做一个：压缩上下文不可撤销、重新连接会打断当前轮，两者都需要二次确认。结构 = `-dialog-head`（h3 + `CloseButton`，`onClick` 直接 `onCancel`）+ `p.dsh-pi-dialog-msg`（`:808`）+ `-dialog-actions`（`:810`，`.dsh-pi-btn` 取消 + `.dsh-pi-btn .dsh-pi-btn-primary` 的 `t('extYes')`）。默认焦点落在取消侧，破坏性动作需要一次显式点击 |
| `MoreMenu` | `client.js:3175-3195` | `div.dsh-pi-menu dsh-pi-more-menu` + `role="menu"`，Escape → `onClose` | 每项 `button.dsh-pi-more-item` + `role="menuitem"` + `title`；图标 `span.dsh-pi-more-icon`（`h(item.icon,{size:16})`）+ 文本 `span.dsh-pi-more-label`。定位 `-more-menu`（`:836`）`left:auto;right:0;top:calc(100% + 6px);bottom:auto`，从顶栏锚点**向右下**展开，`min-width:184px` |
| `ModelPicker` | `client.js:3204-3254` | `div.dsh-pi-menu dsh-pi-picker-menu` + `role="menu"`，Escape → `onClose` | 一个弹层两段：先 `-picker-sec`（`t('pickModel')`）+ 模型行，再 `-picker-sec`（`t('pickThinking')`）+ 档位行。每行 `button.dsh-pi-picker-row` + `role="menuitemradio"` + `aria-checked` + `data-current`；模型行 = `-picker-row-name` + `-picker-row-sub`（provider），档位行 = `-picker-row-name`（档位名）。加载中/空列表都渲染 `-picker-empty`（`t('modelsLoading')` / `t('modelsEmpty')`）。`current` 判定：模型走 provider + id 双等，思考档位走 `props.thinking === level`。定位 `-picker-menu`（`:825`）`bottom:calc(100% + 6px)`，**向上弹** |

**差异**：

1. **五个组件里只有 `Dialog` / `ConfirmDialog` 有 DSH 的直接对标物**（`._dialog_14mp3_33` / `._mask_14mp3_18`）。`SidePanel` 的滑动抽屉与 `MoreMenu` / `ModelPicker` 的两种弹出方向都靠 `position + transform` 自己表达，DSH 的 `._list_1p5el_7` 只规定外观不规定方向。
2. **两套 role 混用是刻意的**：一般对话框用 `role="dialog"`，不可逆或会打断当前轮的两处用 `role="alertdialog"`。屏幕阅读器对后者的处理是「立刻播报并抢焦点」，语义正确但干扰更大，所以只有 `ConfirmDialog` 用它。
3. **`SidePanel` 是唯一带入场动画的外壳**（`.18s ease-out` 左滑）。`Dialog` 只有 opacity 淡入（`dsh-pi-modal-in .16s`），与 DSH 的 `_modalEnter_14mp3_1` 逐帧一致；抽屉的位移入场在 DSH 里没有同源实现。
4. **`props.actions` 缺失时 `-side-actions` 整段不渲染**，不留空容器。这避免了「有 padding 没内容」的一条空白带。

### 4.14 过程流排版（父子同为 32 步长）

**来源：DSH 会话过程流的实测截图 + `research/tool-pkg/client.js` 的 `ToolRow.module.css`**

§4.6 说明过程流的层级语义，这里只收口「行距怎么定」这一组数字。整套数值按参考截图反推，**只采信行距比、不采信绝对像素**（注释 `client.js:555-561`），因为参考图是 2x 截图且外框留白未知。

| 项 | 值 | 出处 | 说明 |
| --- | --- | --- | --- |
| 父行行盒 | `24px` + delta | `.dsh-pi-proc-head,.dsh-pi-tool-head{…line-height:calc(24px + var(--dsh-content-font-delta,0px))…}`（`client.js:564`） | 与 DSH 的 24px 摘要行一致；delta 跟随宿主字号增量 |
| 父行步长 | `32px` | 24px 行盒 + `.dsh-pi-body` 的 `gap:8px` | 上下都归零 padding，父行与父行之间、父行与子行组之间、组末与下一父行之间都是 32 |
| 子行组行盒 | `24px` + delta（**不覆盖**） | 子行不写 `line-height`，沿用 `.dsh-pi-proc-head` / `-tool-head` 的规则（`client.js:564`） | 0.7.0 曾把子行压到 18px 行盒、`gap:0`，一行距只剩父行一半，看着像被挤扁 |
| 子行组间距 | `gap:8px` | `.dsh-pi-sub{display:flex;flex-direction:column;gap:8px;…}`（`client.js:592`；注释 `:585-591`） | 与父层 `.dsh-pi-body` 的 `gap:8px` 同值 ⇒ 子行步长 = 24 + 8 = 32，与父行完全同节奏 |
| 圆点尺寸与两侧留白 | `2px × 2px`、`margin:0 11px` | `.dsh-pi-sep{…width:2px;height:2px;margin:0 11px;…}`（`client.js:575`；注释 `:572-574`） | 行内三段间距统一 11（图标→label 11、label→圆点 11、圆点→摘要 11）；1px 圆角让它看起来是方块不是圆点，与 DSH 的「·」一致 |
| 图标列 | 16×16 框 + `margin-right:11px` | `.dsh-pi-proc-icon{…width:16px;height:16px;margin-right:11px;…}`（`client.js:570`） | 父行 label 左缘 = 容器左内边距 16 + 图标 16 + `margin-right:11` = 43，其中图标盒右缘在 32 |
| 子行左竖线落点 | `margin-left:26px` + `padding-left:12px` | `.dsh-pi-sub{margin:0 0 0 26px;padding:0 0 0 12px;border-left:1px solid var(--dsw-alias-border-l3)}`（`client.js:592`） | 竖线取 26 = 图标 16 + `margin-right:11` − 1（1px 描边的亚像素让位）；`padding-left:12` 让子行图标距竖线 12（≈参考图 15 图 px ÷ 1.23）；子行图标相对父行整体右移 38（参考图 46 图 px ÷ 1.23 ≈ 37，同量级） |
| 展开体缩进 | `margin:2px 0 2px 26px` + `padding-left:14px` + 左 1px 竖线 | `-proc-body`（`client.js:594`）、`-tool-body`（`:595`） | 与子行组同一条竖线语言，让「附着在一行下的补充信息」看起来是一类东西 |
| 运行中圆点 | `state-business-primary` + `dsh-pi-pulse 1.2s` | `[data-state="running"]` 下的 `-sep`（`client.js:584`） | 只有圆点变色并脉冲，文字不闪 |
| 过程流末尾状态行 | `.5px` 顶部 hairline + `padding-top:10px` | `.dsh-pi-working`（`client.js:600`） | 与过程行之间用一条 hairline 收口，不额外加 margin |

**父行 32、子行 32，整段过程流是一张均匀的网格。** 这个结论是逐像素复测把「1px 点线下划线」切出来的细带并回各自的行之后才得到的：参考图里父→父 40 图 px、父→首个子行 40、子→子 40、子行组→下一父行 44，父子节奏一致，不存在「子行比父行紧一半」。比例尺用 CJK 字形 ink 高校准（参考图 label ink 17–18 图 px，本文件 13px 字号的 ink 是 13–14 css px ⇒ ≈1.3），40 ÷ 1.3 ≈ 31，与本文件的 24 行盒 + 8 间距 = 32 对齐。

**0.7.0 的「父 24 / 子 18、比例 32:18」全部作废**：那一版把参考图的下划线当成了独立行，才算出子行只有父行一半。0.8.0 删掉了子行的 `line-height` 覆盖，组内 `gap` 0→8、缩进 22px→26px、行内三段间距 7/10/10→11/11/11，四者合起来把父子拉成同一节奏。

---

### 4.15 历史会话两级列表（0.8.0）

`SessionsSheet`（容器，`client.js:3574-3696`）+ `SessionsList`（渲染，`client.js:3355-3533`）+ `RenameDialog`（`client.js:3540-3563`）三者合成面板的历史会话入口，替换 pi TUI 的「项目/会话」单层选择器。

**为什么必须是两级**：pi 的 scope 开关进项目后就失效（`session-selector.ts:1663` `if (this.projectPath) return`），且 pi 的 RPC 面根本没有「列会话」命令（`rpc-mode.ts` 的 33 条里没有），列表由 host 扫 `~/.pi/agent/sessions/<slug>/*.jsonl` 得到（`GET /sessions/history?scope=all|project`，`index.js:839-845`），选中后用 `switch_session {sessionPath}` 切过去。面板因此把「切 cwd」与「切会话」拆成两层：第一层项目（当前项目置顶 → 非临时 → 最近活动降序），第二层只列该 cwd 的会话。依据写在 `client.js:3337-3354` 的头注释里。

| 项 | 值 | 出处 |
| --- | --- | --- |
| 容器 | `SessionsSheet`：持有 `level`(`projects`/`sessions`)、`project`、`info`、`query`、`prefs`、`menuKey`、`rename` 七个状态 | `client.js:3574-3696` |
| 渲染 | `SessionsList`：纯渲染，props 全由容器给（`t`/`level`/`project`/`info`/`query`/`prefs`/`menuKey`/`onRowMenu`） | `client.js:3355-3533` |
| 取数 | 项目层 `api.history({scope:'all',limit:200})`；会话层 `api.history({scope:'project',cwd:openCwd,limit:200})` | `client.js:3627-3647` |
| 偏好 | `api.uiPrefs()` 读、`api.setProjectPref` / `api.setSessionPref` 写，成功后**吃 host 回的全量结构** | `client.js:3649-3652`，见 §4.16 |
| 侧栏 | `SidePanel`，项目层标题取 `t('projectList')`、有 `side-new` 新建按钮；会话层标题取项目别名或 `displayPath`、有 `side-back` 返回键 | `client.js:3520-3527` |
| 项目行 | `title = renamed === '' ? (displayPath === '' ? cwd : displayPath) : renamed`，带 `data-current` / `data-temporary` / `data-renamed` | `client.js:3407-3430` |
| 会话行 | 标题优先级 `renamed` → pi 的 `name` → `headline`（`firstMessage` 首行，60 字符截断）→ `lastMessage` → `t('sessionFallbackTitle')` | `client.js:3456-3460` |
| 置顶 | `prefPinned(prefs.sessions, path) === true` 时排前，渲染 `span.dsh-pi-pin` + `PinIcon` 12 | `client.js:3445-3453`、`:3477` |
| 空/错/载 | 加载 → `empty-row` 文案 `projectsLoading`/`sessionsLoading`；错误 → `alert`；空 → `empty-row` 文案 `projectsEmpty`/`sessionsEmpty`；恒在提示行 `projectsHint`/`sessionsHint` | `client.js:3528-3531` |
| 行内菜单 | `row-more` 22×22 按钮 + `EllipsisIcon` 14，`aria-haspopup="menu"`、`aria-expanded` | `client.js:3374-3397`，CSS `:860-863` |

**0.8.0 的行为改动（会话标题胶囊的显示条件）**：旧式 `var capsule = renamed === '' && headline !== '' && piName !== '' ? headline : null` 要求「既有偏好名、又有 pi 会话名」才显示胶囊，导致只有 `firstMessage` 的会话永远看不到摘要；新式 `var capsule = headline !== '' && title !== headline ? headline : null` 的语义是「只在标题位置已经被名字占据（改过的名或 pi 的 `name`）时，才把原始摘要作为胶囊放到消息数左侧」。胶囊渲染在 `.dsh-pi-sess-top` 内、消息数 `span` 之前（`client.js:3461-3463` 判定、`:3478-3479` 渲染）。

**置顶排序不用 `sort`**：`client.js:3445-3453` 是两遍 partition（`pinnedFirst` / `rest`）再 `concat`。原因写在 `:3445-3446` 的注释里 —— host 给的最近活动降序本身有意义，旧引擎的 `sort` 稳定性没有保证，用 `sort` 等于把「置顶」和「乱序」绑在一起。

**行内菜单必须整容器吞冒泡**：`row-more` 的 `div` 上挂了 `onClick: stopPropagation`（`client.js:3374-3397`）。不吞的话点菜单项等于点整行，重命名弹窗刚打开就被 `onPick` 关掉侧栏 —— 这是实拍抓到过的真缺陷，注释留在 `:3369-3373`。

**`RenameDialog` 不复用 `NameSheet`**：`NameSheet` 挂在 `PiPanel` 的 `drawer` 状态上，而 `drawer` 是单值，改名会把左侧栏自己顶掉；`RenameDialog` 归 `SessionsSheet` 所属，侧栏与弹窗可并存。理由写在 `client.js:3535-3539`。弹窗本体 = `Dialog`（居中、**不带** `dialog-wide`）+ 一个 `dsh-pi-search` 输入框（`autoFocus`、Enter 提交、Escape 关闭）+ 取消 / 提交两键（`client.js:3546-3562`）。

**差异**：

1. **两级列表在 DSH 里没有对应物**，它是把 pi TUI 的「项目 + 会话」两次点击压成一次的自造结构；第 5 章因此把 `side-host` / `side-back` / `sess-sum` / `pin` 四个类归 C 档（无 DSH 依据），`side-new`（复用 `.dsh-pi-btn` 族）与 `row-more`（行内菜单锚点 + 命中区，复用 `-more-menu` 定位）归 B 档。
2. **置顶是面板概念，pi 的 `SessionInfo` 里没有这个字段**，只能落在面板自己的 `ui-prefs.json`（§4.16）。项目别名同理 —— `set_session_name` 只改单个会话的 `session_info`，改不了项目层。
3. **`.dsh-pi-side-host` 是给「侧栏 + 重命名弹窗并存」专门包的一层**（`position:absolute;inset:0;z-index:30;display:flex`，`client.js:855`，注释 `:853-854`）：`Dialog` 用 `position:absolute` 定位，必须和侧栏同层才能叠在上面而不撑出新的滚动容器。

---

### 4.16 ui-prefs 三条路由与合并语义（0.8.0）

`src/ui-prefs.mjs`（404 行 / 20748 B，0.8.0 新增）+ `index.js:960-976` 三条路由。这一节不属于 CSS 规格，但它是 0.8.0 唯一新增的宿主契约面，且客户端的三处 UI（项目别名 / 会话名 / 置顶）全靠它，所以紧接 §4.15 收口。

**为什么只能由 host 存**：这三件事在 pi 的 RPC 面上都没有通道 —— `set_session_name` 改的是单个会话的 `session_info`（JSONL header），改不了项目层；置顶纯属面板概念；浏览器半区没有 `fs`。所以只能落在本机用户主目录下（`index.js:947-959` 的段注释）。

**落盘**：路径由 `resolveUiPrefsPath()`（`src/ui-prefs.mjs:157`）解析 —— 环境变量 `DSH_PI_UI_PREFS`（`:158-159`）优先，否则 `path.join(homedir(), '.dsh-pi', 'ui-prefs.json')`（`:161`）。文件是单个 JSON，结构 `{ version, updatedAt, projects: {}, sessions: {} }`（`emptyUiPrefs()` `:94-96`，`version = UI_PREFS_VERSION = 1` `:32`）。

| 项 | 值 | 出处 | 说明 |
| --- | --- | --- | --- |
| 结构版本 | `version: 1` | `:32` / `:95` | 将来改结构靠它迁移 |
| 路径覆盖 | `DSH_PI_UI_PREFS` | `:34` / `:158-159` | 测试与多套配置共存 |
| 默认路径 | `<home>/.dsh-pi/ui-prefs.json` | `:36-37` / `:161` | 目录名与文件名各一个常量 |
| 项目名上限 | 120 字符 | `:39` / `:222` | 再长在面板里也只会被截断 |
| 会话路径上限 | 4096 字符 | `:41` / `:216` | 远超任何真实会话文件路径 |
| 原子写 | `<file>.tmp-<rand>` → `rename` | `:290-300`（tmp 在 `:294`） | tmp 必须同目录：跨盘 `rename` 会退化成 copy+unlink，不再原子 |
| rename 重试 | 4 次、退避基数 30ms | `:49-50` / `:228` | 只对 `EPERM`/`EBUSY`/`EACCES` 退避，其余直接抛（Windows 上杀软/索引器持有句柄是常态） |
| 写队列 | `let queue = Promise.resolve()`；`run = task => { const result = queue.then(task, task); queue = result.then(() => undefined, () => undefined); return result }` | `:263-270` | 队列自身必须永远保持「已兑现」，否则一次 400 会把后续请求全卡死 |
| 读盘容错 | 读不到 / 坏 JSON / 结构不对 → `emptyUiPrefs()`，绝不抛 | `:273-287` | 读不到偏好不该让面板打不开 |
| 原型污染防线 | `FORBIDDEN_KEYS` = `__proto__` / `constructor` / `prototype` | `:175` | `JSON.parse` 会把 `__proto__` 建成自有属性，所以按白名单落字段并显式拒绝这三个键 |
| 时间戳 | 每条 `createdAt` / `updatedAt` | `:344-345` | `createdAt` 首次创建后不变 |

**三条路由**（全部返回**全量结构**，不返回增量）：

| 方法 | 路径 | 行号 | 行为 |
| --- | --- | --- | --- |
| `GET` | `/ui-prefs` | `index.js:960-963` | `send(200, await deps.uiPrefs.read())`；`deps.uiPrefs` 缺失回 501 `{ error: 'ui prefs unavailable' }`（`:961`） |
| `POST` | `/ui-prefs/project` | `index.js:964-968` | `deps.uiPrefs.setProject(body.key, body.name)`（`:967`）；`name === ''` 表示删除覆盖、回落到目录名 |
| `POST` | `/ui-prefs/session` | `index.js:969-976` | `deps.uiPrefs.setSession(body.path, { pinned: body.pinned, name: body.name })`（`:975`） |

全量返回的理由写在 `index.js:954-955`：偏好是一份小字典，客户端每次拿全量就不必维护两端合并逻辑。校验（类型与长度）全部在 `src/ui-prefs.mjs` 内完成，抛 `badRequest()`（`:84-88`，`error.statusCode = 400`），由路由层的 `catch` 原样回给客户端 —— 路由层不再重复一遍规则（`index.js:957-958`）。

**合并语义（最容易写错的一处）**：会话条目走「补丁合并」，`undefined` 是「别动它」的哨兵，而 `false` / `''` 是「改成 false / 清除」，两者语义相反，绝不能混用同一个哨兵值（`src/ui-prefs.mjs:207-208` 的注释就是为这件事写的）。实现（`:321-350`）：

- `nextPinned = input.pinned === undefined ? existing?.pinned === true : input.pinned === true`（`:326`）；
- `nextName = input.name === undefined ? currentName : input.name`（`:328`）；
- 合并后**既无 `pinned: true` 也无非空 `name`** ⇒ 整条 `delete`（`:329-332`）；
- 落字段时 `pinned` 只在 `true` 时写，`false` 的表达就是「没有这个字段」（`:335-337`）；
- **内容无变化 ⇒ 不写盘、不刷 `updatedAt`**（`:338-343`）：否则按 `updatedAt` 的「最近改动」排序会因为一次幂等点击自己往上跳。

`setSessionPinned(sessionPath, pinned)`（`:394`）现在是 `setSession` 的薄包装 —— 合并规则只能有一份实现，否则「只改 pinned 时会不会顺手清掉 name」这类问题会在两处各答一次（`:387-393`）。它的错误文案与 0.7.0 完全一致，校验也包在 promise 里：本方法对外契约是「永远返回 Promise」，同步 throw 会让只写了 `.catch()` 的调用方接不住（`:395-399`）。

**客户端侧**：`api.uiPrefs()` / `api.setProjectPref(key, name)` / `api.setSessionPref(sessionPath, patch)` 三个薄包装在 `client.js:1000-1006`，`patch` 只带出现过的字段。`SessionsSheet` 的 `applyPrefs`（`:3604-3613`）只保留 store 真给出的两棵表、缺字段一律当空表；`loadPrefs`（`:3614-3617`）读不到偏好时静默降级，因为重命名与置顶是增强项，缺了只是回到默认排序。

**差异**：

1. **单 JSON 而不是 sqlite**：数据量是个位数到几百条的小字典、写频率是用户手点级别；原子写 + 全量替换已足够，引入数据库只会多一个依赖与一份需要迁移的 schema（`src/ui-prefs.mjs` 头注释）。
2. **没有文件锁，只靠 `rename` 的原子性**：并发写各写自己的 `tmp`，`rename` 原子定胜负；一致性由「每次操作都重新读盘」保证。
3. **这条路由面不在 pi 的 RPC 契约里**，由 `index.js` 自己实现；`CONTRACT_VERSION` 因此升到 `'0.8.0'`（`index.js:66`），`:823` 原样回给客户端。

---

## 5 现状 → 目标映射表

逐类列出 CSS 数组里的全部 **174** 个 `.dsh-pi-*`（脚本 `matchAll(/\.dsh-pi-([a-zA-Z0-9-]+)/g)` 去重得到）。判定分四档：

| 判定 | 数量 | 判据 |
| --- | --- | --- |
| **A 已对齐** | 32 | 有明确 DSH 依据，且几何与令牌逐值一致（差异只在可忽略的个别值） |
| **B 近似** | 55 | 有同族 DSH 组件，但尺寸档、描边色、阴影级或结构不同 |
| **C 无对应物** | 85 | DSH 里没有该组件（纯布局类、纯文本槽，或面板专有语义），只能保证令牌合法 |
| **D 待确认** | 2 | 引用的 DSH 依据需重采探针才能断言 |
| 合计 | 174 | — |

四档之和 32 + 55 + 85 + 2 = 174，与实测类数完全吻合，无遗漏无重复。归档规则：**每一版新增的类一律并入「同族已有成员」所在的档**（因为它们的 DSH 参照物就是同族那一条规则），被删掉的类同时从原档移除。0.7.0 新增 22 个类（10 个进 A/B、12 个进 C）、删掉 `picker-native` / `picker-wrap` 两个；0.8.0 新增 6 个类：`side-new` 并入 B 档 `btn` 族（同一枚 `.dsh-pi-btn` 加 `flex:0 0 auto` + `white-space:nowrap` + `gap:6px`），`row-more` 并入 B 档（行内菜单锚点 + 22px 命中区 + 内嵌 `-more-menu` 定位），其余四个 `side-host` / `side-back` / `sess-sum` / `pin` 无 DSH 对应物，进 C 档。**净变化：B 53→55、C 81→85，A 与 D 不动。**

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
| `proc-icon` | `._leading_l4nv8_52` | 16×16 图标框 / `flex:none` / `label-tertiary` 三项同；DSH `margin-right:6px`，我们 11px |
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

### 5.2 B 档：近似（55）

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
| `dialog-content` | `._dialog_14mp3_33` 内容区 | 与 `dialog-body` 同族但语义不同：`dialog-body` 是「对话框正文」（`padding:14px 24px 0`），`dialog-content` 是「可滚动内容容器」（`padding:14px 24px 22px` + `overflow-y:auto`，底部多 22px 防贴边）；`Dialog` 组件用的是后者 |
| `dialog-grow` | `._dialog_14mp3_33` 内容区 | `flex:1 1 auto` + `min-height:0` + `overflow-y:auto`，DSH 无「可增长区」概念（它靠 `max-height` + `overflow` 交给外层） |
| `dialog-head` | `._dialog_14mp3_33` 头部 | `padding:22px … 0 24px` 同族；DSH `22px 14px 12px 24px`（带下边距），dsh-pi 下边距移到 body |
| `dialog-msg` | `._dialog_14mp3_33` 内容区 | `--dsh-content-font-size` + `calc(22px + delta)` 与 DSH 气泡同法；DSH 对话框正文无独立类 |
| `dialog-wide` | `._dialog_14mp3_33` 宽度档 | DSH 只有一档宽度（`min(380px,100%)`）；dsh-pi 的 `-wide` 变体走 `min(560px,100%)`，容纳选项列表与多行输入 |
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
| `more-icon` | `._itemIcon_1p5el_165` | 同为菜单项图标框 + `label-secondary`；DSH 14×14，dsh-pi 16×16（`h(item.icon,{size:16})`） |
| `more-item` | `._item_1p5el_105` | 同族菜单项：`min-height:32px` / `padding:6px 8px` / `radius-md` / 13px / hover `interactive-bg-hover`；DSH `min-height:34px` |
| `more-menu` | `._list_1p5el_7` 的定位族 | 与 `menu-add` 同性质（定位 + 宽度覆盖）；DSH 由浮层自算位置，dsh-pi 固定从顶栏锚点向右下展开 |
| `notice` | `color-mix` 手法同 `._tag_brmue_4` | 三 tone 用 10% / 12% / 10%；DSH 无 notice 组件 |
| `opt` | `._item_1p5el_105` 同族 | `min-height:34px` / `radius-md` / 13px 同；DSH item 底透明，dsh-pi `bg-layer-3` 实底 + `[data-active]` 内描边 |
| `picker-empty` | `._empty_1j4y1_104` | 同族「无内容」行；DSH 13px + `label-secondary`，dsh-pi 12px + `label-dimmed` + `padding:10px 8px`（比抽屉里的 `empty-row` 更紧） |
| `picker-menu` | `._list_1p5el_7` 的定位族 | 外观完全复用 `.dsh-pi-menu`，只覆盖定位：`left:0` + `bottom:calc(100% + 6px)`，即从模型名锚点**向上**弹出；DSH 的浮层一律向下 |
| `picker-row` | `._item_1p5el_105` | 同族菜单项：`min-height:32px` / `padding:5px 8px` / `radius-md` / 13px；比 `more-item` 矮 1px、`[data-current="1"]` 内描边 `state-business-primary` |
| `picker-sec` | `._label_1p5el_146` | 同为「分组标题」11px + `label-caption`；DSH `padding:6px 8px`，dsh-pi `8px 8px 4px` |
| `proc-body` | `._body_jrv99_22`（过程展开区） | 同族展开区：左 `border-l3` 竖线 + 缩进；DSH 竖线 2px + `markdown-code-block` 底，dsh-pi 1px 无底 |
| `row-more` | 行内菜单锚点 + `btn-icon`（22px 命中区） | `position:relative` + `flex:0 0 auto` + `margin-left:auto` 把「更多」推到行尾；按钮 22×22 + `radius-xs` 复用图标按钮尺寸；内嵌 `.dsh-pi-more-menu` 用 `min-width:160px` / `max-width:min(220px,calc(100vw - 32px))` 收口（`client.js:860-863`）。DSH 没有「行内菜单锚点」这种结构，但三段全部由既有同族规则拼出：容器定位同 `more-wrap`、按钮尺寸同 `btn-icon`、菜单同 `more-menu`，故按同族归 B 而非 C |
| `search` | `._wrap_14sgc_1` | `border-l4` 同；28px / `radius-sm` / `bg-layer-3` vs 32px / `radius-md` / `bg-layer-1` |
| `side-new` | `btn` 族（`._add` / 次级按钮） | `.dsh-pi-btn` 加 `flex:0 0 auto` + `white-space:nowrap` + `gap:6px`（`client.js:858`），只固定自身不被压缩、文字不折行；几何与色仍由 `btn` / `btn-ghost` 决定，DSH 无「侧栏新建键」这一具体实例 |
| `stop` | Composer `._primary[data-sending]` | 同位置换成「停止」语义；DSH 保持 `button-info-fill` 底 + spinner，dsh-pi 换 `interactive-bg-hover-solid` 底 + `StopSquareIcon` |
| `ta` | `._input_14sgc_25` | 同族输入控件；DSH 无边框 14px/22px，dsh-pi 加 `min-height:52px` / `max-height:220px` |
| `tool-body` | `._body_jrv99_22` | 同族展开区；DSH 有 `markdown-code-block` 底 + `border-l1` 描边，dsh-pi 只有左侧 `border-l3` + `max-height:340px` |
| `widget-body` | `._body_jrv99_22` 同族 | 等宽 11px + 可滚动；dsh-pi 无极底色、无描边、`max-height:120px` |

B 档的共同特征是「同族不同档」：要么尺寸差一档（28 vs 32、30 vs 28、440 vs 380），要么描边色差一级（`border-l4` vs `border-l3`），要么阴影差一级（`elevation-panel` vs `elevation-prominent`），要么结构不同（DSH 用按钮 + body，dsh-pi 用左侧竖线块）。**这些都不是错，但都不该被描述成「一致」。**

### 5.3 C 档：无对应物（85）

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
| `more-label` | — | 菜单项文本槽：`flex:1 1 auto` + 单行省略，与 `item-name` / `picker-label` 同性质 |
| `more-wrap` | — | `position:relative` + `display:flex`，纯定位容器（给 `more-menu` 当锚点） |
| `picker-label` | — | `picker` 的文本槽，`min-width:0` + 单行省略；0.7.0 起不再有原生 `<select>` 承接点击，交互交给 `ModelPicker` 弹层 |
| `picker-box` | — | 模型名与思考档位的**共用定位锚点**：`position:relative` + `display:flex` + `align-items:center` + `min-width:0`。0.7.0 起原生 `<select>` 叠层已删，交互由 `ModelPicker` 弹层承接 |
| `picker-name` | — | `picker` 里模型名那一格，纯排版 |
| `picker-level` | — | 档位按钮的文本槽修饰：`margin-left:2px` + `padding:0 6px 0 8px`（两个 28px 胶囊并排时留出边界） |
| `picker-row-name` | — | 菜单行主名：`flex:1 1 auto` + 单行省略 |
| `picker-row-sub` | — | 菜单行副信息（provider 名）：`flex:0 0 auto` + 11px + `label-tertiary` |
| `pin` | — | `display:grid` + `place-items:center` 的 12×12 图标槽，色 `state-business-primary`（`client.js:866`）；DSH 没有「会话置顶」语义，也无对应图标槽类 |
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
| `sess-sum` | — | 会话行「原始摘要胶囊」：`max-width:44%` + 单行省略号 + `label-tertiary`（`client.js:865`）；只在标题位置已被偏好名或 pi 名占据时出现，面板专有语义 |
| `sess-title` | — | 会话卡标题 |
| `sess-top` | — | 会话卡首行 |
| `sheet` | — | 抽屉外壳（`bg-base` 铺满），DSH `_pane` / `_surface` 只给骨架无外观 |
| `sheet-body` | — | 抽屉主体，纯布局 |
| `sheet-head` | — | 抽屉头，`border-l2` |
| `sheet-title` | — | `font-base-strong-16`，DSH 无抽屉标题类 |
| `side` | — | 左滑侧栏本体：`width:min(360px,86%)` + `height:100%` + `bg-base` + `elevation-panel` + `dsh-pi-side-in .18s ease-out`。DSH `_pane` / `_surface` 只给骨架无外观，与 `sheet` 同属「无对标物」 |
| `side-actions` | — | 侧栏操作行（搜索框 + 按钮），`props.actions` 缺失时整段不渲染 |
| `side-back` | — | 侧栏返回键：`28×28` + `margin-right:0` + `margin-left:-6px`（`client.js:857`），负左距把键光学对齐到侧栏内边距；DSH 无侧栏返回键，用 `btn-ghost` + `btn-icon` 叠加实现 |
| `side-body` | — | 侧栏主体，可滚动，纯布局 |
| `side-head` | — | 侧栏头，`border-l2` 下边线，纯布局 |
| `side-host` | — | 会话抽屉宿位：`position:absolute` + `inset:0` + `z-index:30` + `display:flex`（`client.js:855`），把 SessionsSheet 直接铺满 `PiPanel` 内容区、盖住消息流但保留 titlebar；DSH 无「面板内二级路由宿位」这类容器 |
| `side-title` | — | `font-base-strong-16`，DSH 无侧栏标题类（同 `sheet-title`） |
| `side-wrap` | — | 全屏遮罩层：`position:absolute` + `inset:0` + `z-index:30` + `bg-mask-1`，点击命中自身时关闭 |
| `spacer` | — | `flex:1 1 auto`，通用布局 |
| `sr` | — | `clip:rect(0,0,0,0)`，通用 a11y 类，不需要 DSH 依据 |
| `statusbar` | — | 11px + `label-caption`，面板专有 |
| `sub` | — | 子行组：`margin:0 0 0 26px` 让左侧 1px 竖线落在父行 label 左缘前一格（图标 16 + `margin-right:11` − 1）+ `padding:0 0 0 12px` + `gap:8px`（组内间距与父层 body 同值 ⇒ 子行步长 32 与父行一致） |
| `switch-label` | — | `font-s-14` + `label-primary`，DSH 开关无标签类 |
| `switch-row` | — | `grid 1fr auto` + `gap:12px`，面板专有布局 |
| `thumb-x` | — | 16×16 / `radius-xs` / `bg-mask-1` + `static-neutral-bluish-00` |
| `tool` | — | 平铺行（无框无底无阴影），`client.js:562-569` 注释说明理由（「框套框的噪音墙」在 `:567` 前的块注释）；DSH 无可对标 |
| `tool-head` | — | `::before` 三角 `\25B8` + `[open]` 旋转，面板专有 |
| `tree` | — | 等宽 `font-xxs-12-font-size`，DSH 无树组件 |
| `tree-kind` | — | `label-caption` + `min-width:56px` |
| `tree-node` | — | `radius-sm` + hover，DSH 无树组件 |
| `tree-text` | — | `label-secondary` |
| `usage` | — | `tabular-nums`，面板专有 |
| `widget` | — | 状态 widget 容器 |

85 个类占全部类的 48.9%（旧账 61/114 = 53.5%；0.7.0 新增的 22 个类里 10 个能指到 DSH 依据、12 个进本档，0.8.0 新增的 6 个类里 2 个进 B 档、4 个进本档，C 档占比因此从 0.6.4 的 46.6% 经 0.7.0 的 48.2% 升到 48.9%）。这个比例本身是个重要结论：**dsh-pi 的界面接近一半在 DSH 设计系统里没有对应组件。** 这不是缺陷——面板要做的事（会话卡、token 用量、工具行、目录树、运行时门禁、会话置顶与摘要胶囊）本就不在 DSH 的组件集里。对它们能做的保证只有两条：

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

m02100 说「现状 → 目标映射表（`client.js` :305-450）」。当前快照的 CSS 数组区间是 **`:477` – `:874`**（277 段），不是 `:305-450`——那一段落在 i18n 表与工具函数之间，没有 CSS。

m02100 说「185 段 / 26978 字符 / 295 处 `var()` / 66 个唯一变量」。当前快照实测 **277 段 / 39760 字符 / 382 次 `var(` 文本出现（其中 16 处是「逗号后紧跟 `var(`」的兜底嵌套，顶层引用 366 处）/ 74 个唯一变量**（`node test/css-tokens.mjs --report` 的汇总行按门禁自己的提取口径印「令牌引用: 377 处 / 74 个唯一变量」，字节数与段数在同一块的前两行）。四项都变了：0.6.0–0.6.4 陆续加入文件标签、`CloseButton`、composer 卡面与 `+` 菜单、过程行与工作状态行，0.7.0 又加入 picker 合一弹层、`more` 菜单、`side` 侧栏与三个对话框变体，0.8.0 再加会话两级列表的行内「更多」菜单、置顶徽标、摘要胶囊、侧栏返回键与抽屉宿位，规则数与令牌面都扩大。`var(` 计数在 0.8.0 为 **382**（顶层 366 + 兜底嵌套 16）。

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

`DirSheet`（`client.js:3745-4043`）与纯函数 `dirPickModel`（`client.js:3714-3743`）。把数据模型单独抽成纯函数是为了让门禁能直接断言（`test/client-render.mjs` 的 9.13 / 9.14 / 9.15 三节共 40 条：SSR 首帧 15 条、Miller 分栏与采纳目标 14 条、「此电脑」层 11 条）。

#### 6.3.1 三个入口

| 入口 | 位置 | 渲染条件 | 形态 |
| --- | --- | --- | --- |
| 空态按钮 | `EmptyState` `client.js:2585-2596`（判据 `typeof props.onPickDir === 'function'` 在 `:2586`） | 有 `onPickDir` 才渲染 | `.dsh-pi-empty-actions` > `.dsh-pi-btn`：`DirIcon(14)` + 文案 `pickDir` |
| `+` 菜单项 | `Composer` 的 `addItems`（数组起点 `var addItems = [` 在 `client.js:2960`，条目 `:2961-2970`，数组结束 `:2971`），**目录项 = 第 2 项**，在 `:2962` | 恒定 | `{ key: 'dir', group: 'add', groupLabel: t('addGroupAdd'), label: t('pickDir'), keyName: 'workspace', desc: t('addDirDesc'), icon: DirIcon, run: props.onPickDir }`。**0.7.0 起目录选择器的主入口就是这里（`+` 菜单第 2 项）**：`.dsh-pi-bar` 里只有「圆形 `+` + 模型名/思考档位合一锚点」，没有独立目录按钮。`.dsh-pi-bar` 在 `:658`，`-bar-actions` `:659`，`-add-wrap` `:663`，`.dsh-pi-add` `:664-667`，`AddMenu` `:2635-2671`；注释 `:3027-3028` 写明「附件与目录都收进 `+` 菜单」，`:3052-3054` 写明模型名与思考档位合成一个 `.dsh-pi-picker-box` 锚点。`addItems` 其余 9 项：file `:2961`、sessions `:2963`、compact `:2964`、model `:2965`、thinking `:2966`、stats `:2967`、settings `:2968`、hotkeys `:2969`、new `:2970` |
| 弹窗挂载 | `client.js:5902`（`} else if (drawer === 'dir') {` 分支；`var drawerNode = null` 在 `:5860`） | `drawer === 'dir'` | `DirSheet`，`startDir = activeCwd === '' ? runtime.workspace : activeCwd`，`onPick = switchDir` |

挂载点在 `client.js:5923`（EmptyState）与 `client.js:5939`（Composer），都是 `onPickDir: function () { setDrawer('dir') }`。

#### 6.3.2 初始状态

`listingState` 的初值（`client.js:3747-3749`）：

```js
{ loading: true, error: null, dir: props.startDir, parent: null,
  writable: true, entries: [], truncated: false, home: '', roots: [] }
```

挂载后立刻 `useEffect(function () { go(props.startDir === undefined ? '' : String(props.startDir)) }, [])`（`client.js:3801`）。`go` 的四步（`client.js:3776-3799`）：

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

S5 是 0.4.x 新增的、DSH picker 没有的层。存在的理由写在两处注释（`client.js:3720-3721` 与 `:3770-3771`）：Windows 上从工作目录一路往上只能走到当前盘的根，**别的盘的工程永远进不去**。所以 `index.js` 的 `/directories` 多返回一个 `roots` 数组，面板在「上一级 / 主目录」之后插一个「此电脑」入口。

`dirPickModel` 里专门为 S5 写了一条约束（`client.js:3731-3733`，判定在 `:3733`）：**此电脑层什么都没选时 `target` 必须是 `null`，不能回落到 `current`**，否则「用这个工作区」会把上一浏览层级当成目标。

#### 6.3.4 鼠标动作

| 动作 | 落点 | 行为 | 代码 |
| --- | --- | --- | --- |
| 单击子目录 | `col0` 行 | `setDeep(null)` + `setSelected(target)` + `setTyped(target)`；触发 `col1` 加载 | `makeRow` `:3899-3921`（onClick `:3908-3912`） |
| 双击子目录 | 同上 | 清 `query` + `setDeep(null)` + `enter(target)`（直接进入该层，收起 `col1`） | 同上（onDoubleClick `:3913-3917`） |
| 单击盘符 | 此电脑层行 | 同上（盘符有 `path`） | 盘符分支 `:3935-3955`（`data-drive="1"` 在 `:3944`，onClick `:3946-3948`） |
| 双击盘符 | 同上 | 直接进入盘符根 | 同上（onDoubleClick `:3949-3951`） |
| 点「上一级」 | `..` 行 | `enter(parent)` | `:3957-3965`（用 `listing.parent`） |
| 点「主目录」 | `~` 行 | `enter(home)` | `:3978-3986`（`listing.home !== listing.dir` 才渲染） |
| 点「此电脑」 | 普通层入口 | `setDeep(null)` + `setSelected(null)` + `setRootsView(true)` | `:3966-3977`（`data-pc="1"` 在 `:3973`）；「此电脑」层内的返回行 `:3924-3934` |
| 点面包屑某段 | 头部 | 该段 `path` 为空或等于当前 `dir` 时 **无操作**，否则 `enter(path)` | `pathCrumbs` 函数 `:2225-2243`，渲染 `:3852-3873`（`data-last` `:3862`，同路径 return `:3866`） |

双击的第二下必须把 `query` 清掉——否则进入新层时旧过滤词还在，用户会看到空列表。`client.js:3914` 的 `setQuery('')`（onDoubleClick 内）就是为这个（`enter` 里另有一处，在 `:3804`）。

#### 6.3.5 键盘动作

只有两个输入框接键盘，没有全局键盘导航（无 `↑`/`↓`/`Enter` 列表导航、无 `Esc` 关闭、无 `Tab` 陷阱）：

| 输入框 | 位置 | `Enter` | 其余键 |
| --- | --- | --- | --- |
| 绝对路径（`flex:1 1 auto`，占位符 `dirInputHint`） | `:3875-3888`（与筛选同一个 `.dsh-pi-row2`，容器 `:3875`） | `enter(typed.trim())`，空串不动作（`:3882-3887`） | 普通文本输入（onChange `:3881`） |
| 筛选（`width:160px`，占位符 `filter`） | `:3889-3895` | 无绑定 | 驱动 `query`（onChange `:3894`），实时过滤**最后一栏** |

这也是一个缺口，但**不是只剩一条路**：0.6.1 起每个抽屉与弹窗的右上角都是统一的 `CloseButton`（`client.js:2087`，`.dsh-pi-btn-icon` + 16px `CloseIcon`，32×32 命中区），点它等价于取消。仍然缺的是键盘 `Esc`（无全局 keydown 监听）与方向键列表导航；DSH picker 同样没有方向键导航（`README.zh.md` 说无搜索、无多选），所以两边都只有鼠标路径。

#### 6.3.6 过滤语义

`dirPickModel` 的匹配（`client.js:3726-3729`）：

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

过滤只作用于**最后一栏**（`client.js:3739-3740`）：`main` 在 `selected === null` 时才 `filter(match)`，一旦选中，第一栏就恢复全量，第二栏才是被过滤的那栏。这一点与 DSH 同构，是对的。

#### 6.3.7 采纳优先级

`target` 的三级回落（`client.js:3733`）：

```js
var target = deep !== null ? deep
           : (selected !== null ? selected
           : (rootsView ? null : current));
```

`accept()`（`client.js:3808-3816`）**不带参数**，自己算 `target`：`:3809` 若 `busy === true` 直接 return；`:3810` 重新调 `dirPickModel(...)` 算 target；`:3813` 若 `target === null || target === ''` 直接 return（这就是「选盘符不会把盘符当工作区」的实现）；否则 `setBusy(true)`（`:3814`）后调 `props.onPick(target)`（`:3815`）。

页脚的 `disabled` 条件（`client.js:4018`）是 `targetDir === '' || busy === true || listing.loading === true`（`canAccept`，用在 `:4025` 的按钮上）——注意它用的是**字符串是否为空**，不是 `target === null`，因为渲染时 `target` 已经被 `String(...)` 包过（`targetDir` 在 `:4017`）。

#### 6.3.8 采纳后的时序：`switchDir`

`switchDir`（`client.js:5175-5196`）是「切换工作区」的全部逻辑。JSDoc（`client.js:5171-5174`）写明这是**面板里唯一会销毁并重建 pi 子进程的操作**：

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

第 7 步的 `startSession`（`client.js:4912-4943`）有一个关键分支：

```js
var existing = target !== null ? [] : state.sessions;
```

**指定了 cwd 就强制新建，绝不复用已有会话**（`client.js:4923`）。原因很直接：已有会话跑在旧 cwd 的子进程里，复用它等于什么都没改。所以带 `cwd` 时 `existing` 恒为空数组，必走 `api.create({ cwd: target })`。

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
| 13 | 死键 | **已修复**：0.7.0 已把 `dirMissing` 从 `ZH` / `EN` 两张表里同时删除，`client.js` 全文 0 命中；键集 0.7.0 为 203 / 203、0.8.0 为 215 / 215，两边一致 | 无此问题 | 已修复 |
| 14 | 分栏分隔 | 相邻兄弟选择器 `.dsh-pi-dir-col + .dsh-pi-dir-col{border-left:.5px}` | 独立 `_divider` span（`.5px` `border-l3`） | 低 |
| 15 | 开关过渡 | `.dsh-pi-switch` 多一条 `transition:background-color .16s ease` | `._switch_1ik0f_5` 无过渡 | 极低 |
| 16 | 设置项一致性 | 4 个设置项里只有 `autoCompaction` / `autoRetry` 是开关，另两个仍是文字按钮；注释 `client.js:4151` 的措辞会让人以为全改了 | 无对应 | 中 |
| 17 | home 来源 | `os.homedir()`，由宿主在 `/directories` 响应里给 | `listing` 字段的一部分 | 低 |

补充三条**注释与实现不一致**（不是 dsh-pi 与 DSH 的差异，是 dsh-pi 内部的文档债）：

| 位置 | 注释说什么 | 实际是什么 |
| --- | --- | --- |
| `client.js:723` | 「DSH `._float` 的配方：`bg-layer-2` + `radius-panel` + `elevation-prominent` + 局部描边色」 | `:724` 的 `.dsh-pi-sheet` 是 `bg-base` 铺满，没有 `radius`、没有阴影 |
| `client.js:798-799` | 「header（padding `22px 14px 12px 24px`）」 | `:803` 的 `.dsh-pi-dialog-head` 是 `padding:22px 18px 0 24px`，`:804` 的 `.dsh-pi-dialog-head h3` 是 `padding:0` |
| `client.js:4151` | 「开关对齐 DSH 的 `._switch_1ik0f_5`……不再是文字按钮」 | 只有两个是开关；`steeringMode` / `followUpMode`（`client.js:4168-4173`）仍是 `.dsh-pi-btn` 文字按钮 |

三条都属「描述超前于实现」。第六条（筛选无命中出空栏 vs 显示全量）是 0.7.0 以来唯一被用户直接感知的语义差异。

### 6.5 宿主契约：`GET /directories`

`index.js:919` 的路由（响应体在 `index.js:926` 的 `send(200, {` 起），响应：

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

字段来源逐条（`listDirectories` `index.js:1257-1293`）：

| 字段 | 实现 | 备注 |
| --- | --- | --- |
| `dir` | `path.resolve()` 后的绝对路径 | — |
| `parent` | `dirname(dir) === dir ? null : dirname(dir)` | 盘根给 `null` |
| `writable` | `fs.promises.access(dir, W_OK)` | 整段 `try/catch`；不可写也照常返回（`index.js:1291` 注释：「只读目录 / 权限不足：照样能把目录列出来，只是不能在这里开会话」） |
| `entries` | `opendir` + `dirent.isDirectory()` 过滤 | **符号链接天然跳过**（`dirent` 来自 `lstat` 语义）；**无 hidden 过滤**，`.git` 照常列出 |
| `truncated` | 超过 `limit`（默认 50，上限 200） | — |
| `home` | `os.homedir()` | **不是 `listing` 字段**，是路由层另加的 |
| `roots` | `await listRoots()` | 0.4.1 新增 |

错误码：`opendir` 失败时 `ENOENT` / `ENOTDIR` → **404** `no such directory`，其余 → **500**（归一在 `index.js:1259-1266`，`dirent.isDirectory()` 过滤在 `:1273`、注释 `:1272`）。排序用 `localeCompare(a.name, b.name, { numeric: true, sensitivity: 'base' })`（`index.js:1279`），所以 `a2` 排在 `a10` 前面。

`listRoots()`（`index.js:1478-1499`）只对 Windows 有意义：

```js
// win32：探 A 到 Z，fs.promises.stat(letter + path.sep)，isDirectory 才保留
// 单个盘失败 catch 成 null，最后 .filter(Boolean)
// 非 win32：返回 [{ name: '/', path: '/' }]
```

带 10 秒缓存（`ROOTS_TTL_MS = 10000`，`index.js:1464`；`rootsCache` `:1465`）。注释 `:1467-1477` 说实测四个盘全扫约 3ms（`:1472`），「一个不可读的盘符不该毁掉整个目录浏览」（`:1474`）。

**0.8.0 新增的三条偏好路由**（`index.js:960-976`，`GET /ui-prefs` 在 `:960-963`、`POST /ui-prefs/project` 在 `:964-968`、`POST /ui-prefs/session` 在 `:969-976`）：

| 路由 | 请求体 | 返回 | 出处 |
| --- | --- | --- | --- |
| `GET /ui-prefs` | — | `{ version, updatedAt, projects, sessions }` 全量结构 | `index.js:962` |
| `POST /ui-prefs/project` | `{ key, name }` | 同上的全量结构 | `index.js:967` |
| `POST /ui-prefs/session` | `{ path, pinned?, name? }` | 同上的全量结构 | `index.js:975` |

三条语义约束（实现与校验都在 `src/ui-prefs.mjs`，路由层只转发）：

1. **返回全量、不是增量**。偏好是一份小字典，客户端每次拿全量就不必维护两端合并逻辑（`index.js:954-955` 注释）。
2. **`POST /ui-prefs/session` 是合并式补丁**：只有请求里出现过的字段才交给 store，`undefined` 表示「别动它」。行内 `⋯` 的「重命名」与「置顶」各自只提交自己那一个字段，读-改-写留在 store 里做（`index.js:972-974`）。
3. **校验失败由 store 抛 `statusCode:400`**，被同一个 `catch` 原样回给客户端；`deps.uiPrefs` 缺失时三条都回 `501 { error: 'ui prefs unavailable' }`（`index.js:961` / `:965` / `:970`）。

store 在 `apply` 作用域里只建一次（`const uiPrefs = createUiPrefsStore()`，`index.js:740`，注释在 `:733-739` 说明为什么不能每请求新建）；`src/ui-prefs.mjs` 在插件清单里标了 `runtime: true`（`index.js:140-142`），因为它的判断逻辑参与这三条路由。

**能力边界**：宿主只提供「列子目录」，没有 `fs.stat` 单点查询、没有 `mkdir`、没有 `rename`、没有 `delete`。所以 6.4 的第 8 / 9 条差异（隐藏项开关、新建文件夹）**不是面板偷懒，是宿主能力没给**。要补这两个能力，得先在 `index.js` 加 `POST /directories`（mkdir）与 `hidden` 参数。

### 6.6 端到端示例：从 `~/pi-workspace` 切到 `D:\code\agent`

```text
① 用户点 composer 左侧的 `+`，菜单里选「工作区」（`addItems` 第 2 项，`client.js:2962`）
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

### 7.1 `test/css-tokens.mjs`（597 行）

结构：

| 区块 | 行号 | 作用 |
| --- | --- | --- |
| 常量 | `:44-77` | `ALLOWED_EXTRA_TOKENS` / `BANNED_TOKENS` / `MONO_LITERALS` / `NAMED_COLORS` / `COLOR_PROPS` |
| `section()` | `:83` | 打印分节标题 |
| `check()` | `:89` | 单条断言累加 |
| `extractCss()` | `:220` | 从 `client.js` 还原 CSS 文本（处理 JS 单引号转义） |
| `selfTest()` | `:423-438` | 18 条自检（`:424` 打标题、`:431` 合规样例走 `analyze`、`:434` 断言零违规），验证正则本身没写错 |
| 主流程 | `:441-463` | 抽取（`:445` 读文件、`:447 extractCss`、`:453` 取 `css`、`:454` 取 `segments`、`:455 analyze`）→ 断言 → 汇总 |
| 观察项 | `:465-485` | `const observations = []` 在 `:465`；`:470` 记 `outline:0`、`:480` 记 CSS 数组之外的硬色值；CATEGORIES 在 `:487`、`totalViolations` 在 `:494`、`printItem` 在 `:498`、违规清单 `:507`、额外观察 `:525`、汇总 `:532`、selfTest 调用 `:540` |
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

实跑输出（0.8.0 实测，原样）：

```text
css-tokens: C:\Users\PC\Documents\pi-local\dsh-pi\client.js
client.js 340965 字节 / mtime 2026-11-15T22:43:42.171Z
CSS 数组 277 段 / 39760 字符

-- 0 门禁自检（合成样例，防止正则写错后静默放行） ----------------------------------
  自检 18 条：全部通过

-- 1 硬色值（#hex / rgb() / rgba() / hsl() / hsla() / 命名色） -------

-- 2 令牌白名单（只许 --dsw-* 与本地兜底令牌） -------------------------------

-- 3 兜底（非 --dsw-* 令牌必须带第二个参数） --------------------------------

-- 4 禁用令牌（tokens.txt 里是硬值，不是别名） ------------------------------

-- 5 等宽字体栈只许在 var(--ds-font-family-code, ...) 兜底里 ------------

-- 6 焦点可见 ----------------------------------------------------

-- 7 减少动效 ----------------------------------------------------

PASS (98 checks)
```

七个分节标题之间没有违规行，所以下面没有任何一条 `client.js:行号  令牌  片段` 明细；`PASS (98 checks)` = 18 条自检 + 80 条断言。三个头部数字由门禁自己打印，本文件正文一律引用这三行（277 段 / 39760 字符 / 340965 字节），不另行折算。

「18 条自检」是这一整套门禁里最值得学的一处设计：**它先验证自己的正则**。用合成样例跑一次，样例里既有该报的（硬色值、缺兜底、裸字体栈），也有不该报的（合规写法）。没有自检的门禁最危险——正则写挂了整片全绿，而没人会发现。

### 7.2 `test/client-render.mjs`（888 行，797 assertions）

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
| `dirPickModel` | `:470-522` | 25 条纯函数断言（9.14 Miller 分栏 14 条在 `:470` 起、9.15 盘符层 11 条在 `:505` 起），含 `dirPickModel(undefined).showSub === false`（`:501` 防 null 入参） |

0.8.0 新增的四块断言（行号为本轮实测，文件现 888 行）：

| 断言块 | 行号 | 内容 |
| --- | --- | --- |
| 9.16 `messagesFromHistory` | `:524-554` | 历史 JSONL 转消息块 |
| **9.17 历史会话两级导航** | `:557-662` | 两级列表的全部 0.8.0 行为，见下表 |
| 10 章文件路径 | `:663-709` | 路径标签与行内代码 |
| 11 章文件标签 | `:710-755` | 类型图标 + `CloseButton`（`:732`） |

9.17 关键条目（这是 §4.15 唯一的行为证据，逐条与 §4.15 的表格对照；`:577-588` 项目层、`:594-603` 会话层、`:604-662` 0.8.0 段）：

| 断言 | 行号 | 内容 |
| --- | --- | --- |
| `SessionsList` 已导出 | `:562` | `typeof internals.SessionsList === 'function'` |
| 项目层有新建键 | `:586` | `side-new` + `newProject` 同屏 |
| 项目层无返回键 | `:587` | 顶层不渲染 `side-back` |
| 项目层有行内菜单 | `:588` | 每行一个 `row-more` |
| 会话层有返回键 | `:597` | 进项目后 `side-back` 出现 |
| 会话标题回落 | `:599` | 无名字时标题位置用 `firstMessage` |
| 名字盖过标题 | `:600` | 有名字时标题位置用名字、`firstMessage` 落到胶囊 |
| 置顶不增删行 | `:613` | 置顶前后行数一致 |
| 置顶排最前 | `:614` | 置顶项在 `rows[0]` |
| 置顶标记 | `:615` | `data-pinned="1"` |
| 会话名覆盖 | `:622` | `ui-prefs` 会话名盖过 pi 的 `name` |
| 项目别名 | `:629` | 别名生效 + `data-renamed="1"` |
| 行内菜单展开 | `:636` | 点 `⋯` 后出现 `more-menu` |
| 会话菜单两项 | `:637` | `renameSession` + `pinSession` 文案同屏 |
| `aria-expanded` | `:638` | 展开态回写 `aria-expanded="true"` |
| 重命名弹窗 | `:639-643` | `RenameDialog` 结构（`dialog-head` / 输入 / 两个按钮） |
| 过滤 | `:649` | 输入过滤后只剩 1 行 |
| 加载态 | `:655` | `projectsLoading` |
| 英文文案 | `:661-662` | 英文 `projectsEmpty` / `projectsHint` |

后面还有两段与本节相关的渲染断言：9.5 composer `:756-875`（`Composer` `:759`、`composerProps` `:761`、`composerHtml` `:801`、`pickerHtml` `:817`、`busyHtml` `:830`、`AddMenu` `:836`、`addItems` `:838`、`addHtml` `:842`、`menu-section` 断言 `:845`、`withFooter` `:855`）与 10 章整棵面板 `:876-888`（`panelHtml` `:877`）。

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

全部基于 **client.js@6178 / 340965 B / sha256 前缀 `58D4415C014F`（dsh-pi 0.8.0）**。`client.js` 在 0.5.0 之后被并发改写十余次（4130 → 4556 → 4789 → 4873 → 5170 → 5572 → 5614 → 5619 → 5872 → 6178），**任何行号都会漂移**。定位请用类名 grep：

```powershell
Select-String -Path client.js -Pattern "\.dsh-pi-dir-cols\{"
Select-String -Path client.js -Pattern "function dirPickModel"
```

### A.1 组件与函数

| 名称 | 行号 |
| --- | --- |
| `CSS` 数组起 / 止 | `:477`（`var CSS = [`）/ `:874`（`].join('')`）；段落在 `:478-:873` |
| `PiIcon` | `1875` |
| `DirIcon` / `FileIcon` / `DriveIcon` | `1889` / `1900` / `1912` |
| `iconSvg`（图标工厂） | `1931` |
| `CodeIcon` / `ImageFileIcon` / `ArchiveIcon` / `SheetFileIcon` / `DocIcon` | `1941` / `1949` / `1958` / `1967` / `1976` |
| `ThinkIcon` / `HashIcon` / `TerminalIcon` / `FrameIcon` / `SearchIcon` / `PencilIcon` / `SparkIcon` | `1986` / `1995` / `2005` / `2013` / `2023` / `2031` / `2039` |
| `WhaleTailIcon`（16 网格鲸鱼尾，工作状态行专用） | `2055` |
| `CloseIcon` / `PaperclipIcon` / `CloseButton` | `2065` / `2073` / `2087`（跨度 2087-2096） |
| `PlusIcon`（`+` 菜单与「新建项目」） | `2099` |
| `ArrowUpIcon` / `StopSquareIcon`（发送键两态） | `2107` / `2119` |
| `ChevronDownIcon` / `EllipsisIcon` / `ChevronLeftIcon` | `2126` / `2133` / `2142` |
| `PinIcon`（0.8.0 新，会话置顶 12×12） | `2149` |
| `ChipIcon` / `BoltIcon` / `ListIcon` / `GaugeIcon` / `GearIcon` / `RefreshIcon` / `ClockIcon` / `DatabaseIcon` | `2156` / `2164` / `2171` / `2179` / `2187` / `2195` / `2203` / `2211` |
| `pathCrumbs` | `2225`（跨度 2225-2243） |
| `parseToolArgs` / `firstLineOf` | `2253` / `2264` |
| `TOOL_VIEWS` / `toolViewOf` | `2275` / `2286` |
| `TOOL_SUMMARY_FIELDS` / `primaryToolArg` | `2298` / `2300` |
| `ProcPath` / `procSummary` / `procHead` | `2315` / `2341` / `2358` |
| `ThinkingBlock` / `ToolBlock` / `ToolResultRow` | `2373` / `2385`（跨度 2385-2414）/ `2416`（跨度 2416-2434） |
| `WorkingRow` / `usageLine` | `2448`（跨度 2448-2464）/ `2466` |
| `ImageBlock` / `MessageRow` | `2478` / `2499`（跨度 2499-2577） |
| `EmptyState` | `2585`（跨度 2585-2596） |
| `SlashMenu` | `2606`（跨度 2606-2626） |
| `AddMenu`（`+` 菜单面板） | `2635`（跨度 2635-2671） |
| `Composer` | `2683`（跨度 2683-3096） |
| `submit`（`Composer` 内） | `2762` |
| `Sheet`（抽屉骨架） | `3102`（跨度 3102-3109） |
| `Dialog`（0.7.0 新） | `3119`（跨度 3119-3127） |
| `SidePanel`（0.7.0 新，左滑侧栏） | `3135`（跨度 3135-3155） |
| `ConfirmDialog`（0.7.0 新，`role=alertdialog`） | `3161`（跨度 3161-3172） |
| `MoreMenu`（0.7.0 新，顶栏与行内更多菜单） | `3175`（跨度 3175-3195） |
| `ModelPicker`（0.7.0 新，模型/思考档位合一弹层） | `3204`（跨度 3204-3254） |
| `numOr0` / `fmtCount` / `fmtTime` / `fmtDuration` | `3257` / `3262` / `3273` / `3296`（跨度 3296-3308） |
| `prefName` / `prefPinned` / `sessionHeadline`（0.8.0 新） | `3311` / `3319` / `3331` |
| `SessionsList`（纯渲染，0.8.0 起两级列表） | `3355`（跨度 3355-3533） |
| `RenameDialog`（0.8.0 新，项目/会话共用） | `3540`（跨度 3540-3563） |
| `SessionsSheet`（容器，0.8.0 起持有 ui-prefs） | `3574`（跨度 3574-3696） |
| `dirPickModel` | `3714`（跨度 3714-3743） |
| `DirSheet` | `3745`（跨度 3745-4043） |
| `TreeSheet` / `ForkSheet` / `StatsSheet` | `4052` / `4085` / `4103` |
| `SettingsSheet` | `4148`（跨度 4148-4175） |
| `TextSheet` / `FileSheet` | `4178` / `4193` |
| `ExtensionDialog` / `ImageOverlay` | `4221` / `4300` |
| `buildContract` / `classifyInput` / `slashItems` | `4313` / `4339` / `4366` |
| `SelfCheckChip` / `RuntimeGate` | `4406`（跨度 4406-4437）/ `4440`（跨度 4440-4485） |
| `NameSheet` / `BashBlock` | `4488`（跨度 4488-4504）/ `4514`（跨度 4514-4537） |
| `PiPanel` | `4545`（跨度 4545-5975） |
| `var addItems = [`（`Composer` 的 `+` 菜单项数组） | `2960`（条目 2961-2970，闭合 `:2971`） |
| `var drawerNode = null`（`PiPanel` 内抽屉挂载点） | `5860` |
| `startSession` | `4912`（跨度 4912-4943；`var startSession = function (cwd)`） |
| `switchDir` | `5175`（跨度 5175-5196；`var switchDir = function (dir)`） |
| `hotkeyText` / `apply` | `5978` / `6002`（跨度 6002-6090） |
| `markBusy` / `markIdle` / `createView` | `1487` / `1492` / `1497`（跨度 1497-1524） |
| `applyRecord` / `applyBatch` | `1708`（跨度 1708-1857）/ `1859` |

### A.2 CSS 关键行

| 规则 | 行号 |
| --- | --- |
| `var CSS = [`（数组起点，`// ── 基础 ──` 注释在 `:478-482`） | `:477` |
| `.dsh-pi-root` + 全局三条 | `:483-486` |
| `.dsh-pi-head` 族 | `:489-491` |
| `.dsh-pi-dot` 及三态 | `:492-495` |
| `@keyframes dsh-pi-pulse` | `:496` |
| `.dsh-pi-chip` 族 | `:500-506` |
| `.dsh-pi-btn` 族 | `:513-525`（`-primary` `:517` / `-danger` `:520` / `-ghost` `:522` / `-icon` `:524`） |
| `.dsh-pi-scroll` / `-inner` | `:528` / `:529` |
| `.dsh-pi-row` / `-row-user` / `-body` | `:530-531` / `:534` |
| `.dsh-pi-bubble-user` | `:533` |
| `.dsh-pi-prose` 族 | `:536-541` |
| `.dsh-pi-code-inline` | `:542` |
| `.dsh-pi-fence` / `-fence-lang` / `-pre` | `:544-546` |
| `.dsh-pi-proc` / `.dsh-pi-tool` | `:562` / `:563` |
| `-proc-head` / `-proc-icon` / `-proc-label` / `-sep` / `-proc-text`（含两 tone）/ `-proc-note`（含两 tone）/ `-proc-path` / 运行中点动画 | `:564-584`（圆点 `.dsh-pi-sep` `:575`、运行中点动画 `:584`） |
| `.dsh-pi-sub`（子行组）/ `.dsh-pi-proc-body` / `.dsh-pi-tool-body` | `:592` / `:594` / `:595` |
| `.dsh-pi-working` / `-working-icon` / `-working-text` | `:600-602` |
| `.dsh-pi-tag` 五条（含四 tone） | `:605-609` |
| `.dsh-pi-usage` / `-caret` | `:610` / `:611` |
| `.dsh-pi-img` 族 | `:612-614` |
| `.dsh-pi-fileref` 族 | `:618-623` |
| `.dsh-pi-empty` 族 | `:626-630` |
| `.dsh-pi-center` / `-gate` / `-gate-card` 族 | `:631` / `:632` / `:633-637` |
| `.dsh-pi-composer` / `-inner` | `:645` / `:646` |
| `.dsh-pi-box` / `:focus-within` | `:647` / `:649` |
| `.dsh-pi-widget` / `-body` | `:650` / `:651` |
| `.dsh-pi-statusbar` 族 | `:654-655` |
| `.dsh-pi-ta` 族 | `:656-657` |
| `.dsh-pi-bar` 族 / `-add` 族 / `-picker` 族 / `-send` / `-stop` / `-thumb` 族 | `:658-661` / `:663-667` / `:669-676` / `:679-680` / `:681-682` / `:683-687` |
| `.dsh-pi-menu` 族（含 `-empty-row`）/ `-menu-add` 族 | `:690-700` / `:704-712` |
| `.dsh-pi-alert` / `-notice` 族 / `-queue` | `:715` / `:716-719` / `:720` |
| `.dsh-pi-sheet` 族 | `:724-734` |
| `.dsh-pi-sess` / `-proj` 族 / `-kv` 族 / `-tree` 族 | `:736-747` / `:748-750` / `:751-757` |
| `.dsh-pi-switch` 族 | `:760-767` |
| `.dsh-pi-dir` 族 | `:771-788` |
| `.dsh-pi-dir-dialog` 族 | `:792-795`（注释 `:789-791`） |
| `.dsh-pi-dialog-wrap` / `-dialog` / `-dialog-head` 族 | `:800` / `:801` / `:803-807` |
| `@keyframes dsh-pi-modal-in` | `:802` |
| `.dsh-pi-opt` 族 / `-mini-ta` / `-row2` / `-spacer` / `-sr` | `:811-813` / `:814-815` / `:816` / `:817` / `:818` |
| `@media (prefers-reduced-motion)` | `:821` |
| **0.7.0 新增** `.dsh-pi-picker-box` / `-picker-menu` / `-picker-sec` / `-picker-row`（含 `:hover` / `[data-current="1"]`）/ `-picker-row-name` / `-picker-row-sub` / `-picker-empty` | `:824` / `:825` / `:826` / `:827`（`:828` / `:829`）/ `:830` / `:831` / `:832` |
| **0.7.0 新增** `.dsh-pi-more-wrap` / `-more-menu` / `-more-item` / `-more-icon` / `-more-label` | `:835` / `:836` / `:837`（`:hover` `:838`）/ `:839` / `:871` |
| **0.7.0 新增** `.dsh-pi-side-wrap` / `-side` / `@keyframes dsh-pi-side-in` / `-side-head` / `-side-title` / `-side-body` / `-side-actions` | `:842` / `:843` / `:844` / `:845` / `:846` / `:847` / `:850`（`:848-849` 是 head 内的按钮尺寸覆写，`:851` 是 actions 内的搜索框） |
| **0.7.0 新增** `.dsh-pi-dialog-wide` / `-dialog-grow` / `-dialog-content` | `:869` / `:870` / `:873`（`:872` 是「底部留 22px」注释） |
| **0.8.0 新增** `.dsh-pi-side-host`（侧栏 + 弹窗共存容器）/ `.dsh-pi-side-head .dsh-pi-side-back`（返回键 28×28）/ `.dsh-pi-side-new`（新建键） | `:855` / `:857` / `:858`（注释 `:853-854`、`:856`） |
| **0.8.0 新增** `.dsh-pi-row-more`（行内 ⋯ 容器）/ `> button` / `:hover` / 内嵌 `.dsh-pi-more-menu` 锚定 | `:860` / `:861` / `:862` / `:863`（注释 `:859`） |
| **0.8.0 新增** `.dsh-pi-sess-sum`（摘要胶囊）/ `.dsh-pi-pin`（置顶图标 12×12） | `:865` / `:866`（注释 `:864`） |
| 数组结束 `].join('')` | `:874` |

### A.3 i18n 键（ZH / EN）

`ZH` 自 `:36` 起（`var ZH = {`，键从 `:37` 的 `panelTitle` 开始，闭括号 `:256`）、`EN` 自 `:257` 起（`var EN = {`，键从 `:258` 开始，闭括号 `:474`），两边各 **215 个键**、零重复，末键均为 `sessionFallbackTitle`（ZH `:255` / EN `:473`）。两段键序一一对应（门禁用 `JSON.stringify` 比对键集）。

| 键 | ZH | EN |
| --- | --- | --- |
| `panelTitle` | 37 | 258 |
| `newSession` | 38 | 259 |
| `newSessionHint` | 39 | 260 |
| `reconnectHint` | 40 | 261 |
| `sessionsHint` | 44 | 265 |
| `messages` | 47 | 268 |
| `procThink` | 65 | 286 |
| `procBash` | 66 | 287 |
| `procRead` | 67 | 288 |
| `procReadImage` | 68 | 289 |
| `procWrite` | 69 | 290 |
| `procEdit` | 70 | 291 |
| `procGrep` | 71 | 292 |
| `procGlob` | 72 | 293 |
| `procList` | 73 | 294 |
| `procGeneric` | 74 | 295 |
| `procResult` | 75 | 296 |
| `deepDiving` | 76 | 297 |
| `working` | 77 | 298 |
| `durHour` | 79 | 300 |
| `durMin` | 80 | 301 |
| `durSec` | 81 | 302 |
| `tokens` | 82 | 303 |
| `exported` | 173 | 393 |
| `pickDir` | 182 | 402 |
| `dirTitle` | 183 | 403 |
| `dirHint` | 184 | 404 |
| `dirEmpty` | 185 | 405 |
| `dirLoading` | 186 | 406 |
| `dirUp` | 187 | 407 |
| `dirHome` | 188 | 408 |
| `dirThisPc` | 189 | 409 |
| `dirPickDrive` | 190 | 410 |
| `dirHere` | 191 | 411 |
| `dirNotWritable` | 192 | 412 |
| `dirSwitched` | 193 | 413 |
| `dirInputHint` | 194 | 414 |
| `dirPickMark` | 195 | 415 |
| `dirSwitching` | 196 | 416 |
| `allProjects` | 197 | 417 |
| `projectSessions` | 201 | 421 |
| `tempTag` | 202 | 422 |
| `footerTokens` | 234 | 454 |
| **0.7.0 新增** `moreActions` | 236 | 455 |
| **0.7.0 新增** `pickModel` | 237 | 456 |
| **0.7.0 新增** `pickThinking` | 238 | 457 |
| **0.7.0 新增** `confirmCompact` | 239 | 458 |
| **0.7.0 新增** `confirmCompactBody` | 240 | 459 |
| **0.7.0 新增** `confirmReconnect` | 241 | 460 |
| **0.7.0 新增** `confirmReconnectBody` | 242 | 461 |
| **0.8.0 新增** `projectList` | 244 | 462 |
| **0.8.0 新增** `searchProjects` | 245 | 463 |
| **0.8.0 新增** `searchSessions` | 246 | 464 |
| **0.8.0 新增** `newProject` | 247 | 465 |
| **0.8.0 新增** `newProjectHint` | 248 | 466 |
| **0.8.0 新增** `renameProject` | 249 | 467 |
| **0.8.0 新增** `renameSession` | 250 | 468 |
| **0.8.0 新增** `pinSession` | 251 | 469 |
| **0.8.0 新增** `unpinSession` | 252 | 470 |
| **0.8.0 新增** `newSessionHere` | 253 | 471 |
| **0.8.0 新增** `renamePrompt` | 254 | 472 |
| **0.8.0 新增** `sessionFallbackTitle`（末键） | 255 | 473 |

表内键号有跳过，因为两张表里各插了分节注释行：ZH 的 `:78`（「单位自带尾随空格，靠 join('') 拼出「43分54秒」…」）、`:96`（`// —— 0.3.0 新增 ──`）、`:235`（「顶栏「更多」与两个自造弹层的文案…」）、`:243`（「历史会话两级列表（项目层 → 会话层）的文案。」）四行，EN 的 `:299`（「EN 的尾随空格就是拼接分隔符本身（DSH duration.hourUnit = 'h '）…」）一行。所以 `working` 在 ZH `:77` / EN `:298`、`durHour` 在 ZH `:79` / EN `:300`，中间空掉的 78 / 299 是注释不是键。

**`dirMissing` 已在 0.7.0 删除**：0.6.4 时它只在 ZH `:195` / EN `:397` 定义、`client.js` 零引用，是死键；0.7.0 把两张表里这一行同时删掉，全文 0 命中。0.7.0 键集 203 / 203 一致，**0.8.0 起 215 / 215 一致**（新增 12 键见上表末段，全部集中在 ZH `:244-255` / EN `:462-473` 这一段连续区）。`test/client-render.mjs` 断言 ZH 与 EN 的键集一致，所以将来增删键仍必须两边一起动，否则门禁红。

### A.4 宿主侧（index.js）

| 能力 | 行号 |
| --- | --- |
| `CONTRACT_VERSION` | `:66`（`'0.8.0'`；`:823` 回给客户端的 `version` 字段） |
| `GET /directories` 路由 | `:919-941`（`send(200, …)` `:926`、`home: os.homedir()` `:933`、`roots: await listRoots()` `:939`） |
| `listDirectories()` | `:1257-1293`（404/500 归一 `:1261-1266`、`isDirectory()` 过滤 `:1273`、按名 `localeCompare` 排序 `:1279`、`W_OK` 探测写权限 `:1288-1291`） |
| `ROOTS_TTL_MS` / `rootsCache` | `:1464` / `:1465` |
| `listRoots()` | `:1478-1499`（JSDoc `:1467-1477`、缓存命中 `:1480`、A–Z 并发探测 `:1484-1493`、回填 `:1497`） |
| `CHANGELOG_MAX_BYTES` | `:93`（`200 * 1024`） |
| `GET /pi/changelog` 路由 / `readChangelog()` | `:943-945` / `:1508-1541`（三层候选 `:1513-1519`、截断 `:1527`、未找到回落 `{ ok: false }` `:1540`） |
| **0.8.0 新增** `GET /ui-prefs` | `:960-963`（`deps.uiPrefs` 缺失回 501 `{ error: 'ui prefs unavailable' }` `:961`） |
| **0.8.0 新增** `POST /ui-prefs/project` | `:964-968`（`readJsonBody` `:966`、`setProject(body.key, body.name)` `:967`） |
| **0.8.0 新增** `POST /ui-prefs/session` | `:969-976`（501 `:970`、合并式补丁注释 `:972-974`、`setSession(body.path, { pinned, name })` `:975`） |
| **0.8.0 新增** 三条路由的段注释 | `:947-959`（全量返回 `:954-955`、校验在 `src/ui-prefs.mjs` 抛 `statusCode:400` 由 catch 原样回 `:957-958`） |
| **0.8.0 新增** `const uiPrefs = createUiPrefsStore()` | `:740`（`apply` 作用域只建一次，注释 `:733-739`）；注入 `createHandler({ … uiPrefs … })` `:742-758` |
| **0.8.0 新增** `import { createUiPrefsStore }` / manifest | `:55` / `:140-142`（`{ rel: 'src/ui-prefs.mjs', runtime: true }`） |

---

## 附录 B 已知差异登记（D-01 ~ D-11）

把散落在第 4 / 6 章的偏差收成一张可跟踪的表。严重度沿用 6.4 的三档。

| 编号 | 差异 | 位置 | 严重度 | 性质 |
| --- | --- | --- | --- | --- |
| D-01 | 目录过滤用 `contains` 而非 `startsWith`；无命中出空栏而非全量 | `client.js:3726-3729`（`indexOf(query) >= 0` 在 `:3728`） | 中 | 语义偏差 |
| D-02 | 无路径输入预览（DSH 有 250ms 防抖预览） | `client.js:3875-3895`（路径输入 `:3875-3888`、筛选框 `:3889-3895`，两者都只有 `onChange` 直写 state，无防抖请求） | 中 | 能力缺失 |
| D-03 | 无隐藏项开关；`.git` 等点目录照常列出 | `index.js:1273`（`if (!dirent.isDirectory()) continue`，注释在 `:1272`） | 中 | 能力缺失（宿主未给） |
| D-04 | 无新建文件夹；不存在的路径靠开会话时创建 | — | 中 | 能力缺失（宿主未给） |
| D-05 | 当前目录标记用文字徽标而非 `aria-current` | `client.js:3899-3921`（`data-selected` / `data-current` 在 `:3905` / `:3906`，`dsh-pi-dir-mark` 文字徽标在 `:3920`） | 低 | 无障碍退步 |
| D-06 | `.dsh-pi-sheet` 注释称用 DSH `_float` 配方，实际是 `bg-base` 铺满 | `client.js:723-724`（注释 `:723`，规则体 `background:var(--dsw-alias-bg-base)` 在 `:724`） | 低 | 注释与实现不符 |
| D-07 | `.dsh-pi-dialog-head h3` 注释称 `22px 14px 12px 24px`，实际留白在 head（`:803` 的 `padding:22px 18px 0 24px`）、h3 本身 `padding:0` | `client.js:798-807`（注释 `:798-799`、`.dsh-pi-dialog-head` `:803`、`h3` `:804`） | 低 | 注释与实现不符 |
| D-08 | 菜单阴影 `elevation-panel`，DSH 同级菜单用 `elevation-prominent` | `client.js:690` | 低 | 令牌等级偏差 |
| D-09 | 按钮描边 `border-l4`，DSH `_outline` 用 `border-l3` | `client.js:513` | 低 | 令牌等级偏差 |
| D-10 | 开关胶囊多一条 `transition:background-color .16s ease` | `client.js:760` | 极低 | 动效差异 |
| D-11 | ~~`dirMissing` 死键~~ **已修复**：0.7.0 已把该键从 ZH / EN 两张 i18n 表同时删除，`client.js` 全文 0 命中 | — | 已修复 | 未使用键（已清理） |

另有两条**不是差异但值得记录**的实现选择：

- `-tool` 平铺行（无框无底）：`client.js:562-569` 有注释块（`:548-561`）说明「框套框的噪音墙」（`:552`），是刻意决定，不是漏做；
- `-bubble-user` 的 `max-width:82%`：DSH 是 100%，dsh-pi 按 IM 惯例收窄，属合理分歧。

---

## 附录 C 待确认事项（4 项）

每项都写清「为什么没确认」与「怎么确认」，不做无依据的断言。

### C-1 `POST /sessions` 传不存在的 `cwd` 时，pi 是否真的创建目录

**为什么没确认**：需要真跑一个 pi 子进程（`pi --mode rpc`）并发一条 `POST /sessions`，本轮明令禁止运行会打真实 LLM 的测试。

**为什么重要**：`dirHint` 的文案（ZH `:184`）向用户承诺「不存在的路径在开新会话时自动创建」。如果 pi 实际不创建，这句文案就是错的。

**怎么确认**：起一个 pi 子进程，`POST /sessions {"cwd":"<不存在的绝对路径>"}`，看返回是 `ok` 还是 500，再看磁盘上是否出现该目录。

### C-2 `.dsh-pi-box` 的 `:focus-within` 是否对所有目标浏览器都触发

**为什么没确认**：需要真浏览器矩阵。仓库当前没有浏览器测试依赖（`test/` 全是 Node 单测 + SSR 字符串断言）。

**当前对策**：**只有一条通道** —— `client.js:649` 的 `.dsh-pi-box:focus-within{--dsw-elevation-stroke-color:var(--dsw-alias-state-business-primary)}`。0.4–0.6.1 曾同时维护 `.dsh-pi-box:focus-within` 与 `[data-focus="1"]` 双通道，0.6.2 把卡面换成 `--dsw-elevation-soft` 投影后，显式属性通道连同 JSX 里的 `data-focus` 一起删除（`grep data-focus client.js` = 0 命中）：描边由 elevation 的第一层表达，覆盖 `--dsw-elevation-stroke-color` 就够。0.7.0 起元素级的双通道也不存在了——`:649` 是唯一一处（`:496` 的 `@keyframes dsh-pi-pulse` 与焦点无关）。

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
| 174 个 `.dsh-pi-*` 类 | 脚本 `matchAll` 去重，与门禁同源（0.7.0 起 168 → 0.8.0 增 6 类：`pin` / `row-more` / `sess-sum` / `side-back` / `side-host` / `side-new`） | A（可复现） |
| 70 / 39 / 20 / 6 令牌分层（另 `--dsw-specific-*` 4 + `--dsw-static-*` 1，外部兜底 4） | 脚本统计 + 人工归类 | A（数字可复现，归类是判断） |
| 277 段 / 39760 字符 / 382 次 `var(` 文本（顶层 366 处 / 兜底嵌套 16 处） | 段数与字符数取门禁输出第 3 行（门禁自身口径印「令牌引用: 377 处 / 74 个唯一变量」，与本文正文的 382 / 366 差在嵌套识别口径，见 §3.1） | A |
| 32 / 55 / 85 / 2 档位分布 | 174 类逐个人工判定（合计 = 174） | B（判据主观，但每档都列了具体依据） |
| DSH 规则原文与行号偏移 | 探针文件逐条 grep 验证存在 | A |
| DSH picker 逻辑行号 | 探针源码逐条 grep | A |
| `switch` 十一项一致 | 两边规则原文逐属性比对 | A |
| 17 条差异的严重度 | 主观分级 | C（判据已写明，可争议） |
| 52×52 缩略图 | **未找到依据** | D（已标待确认） |

凡是标 A 的都能用本文 2.4 节的命令重跑复现；标 B / C 的是判断，理由已逐条给出；标 D 的进附录 C。

---

_本文的样式与尺寸取证基于 client.js@4130（sha256 前缀 `06fb24ca5cb7`）与 dsh-pi 0.5.1 起步，1.4 版全部行号重测于 client.js@6178（340965 B，mtime 2026-11-15T22:43:42Z，sha256 前缀 `58D4415C014F`）/ dsh-pi 0.8.0，index.js@1593（75041 B，sha256 前缀 `6FC8AAB27CB8`）。所有行号会随后续改动漂移，定位请用类名 grep。_

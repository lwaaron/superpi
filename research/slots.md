# DSH 客户端 slot / layout 服务 / 宿主路由鉴权 / require 白名单

> 目的：为 dsh-pi（把 pi 编码代理接进 DSH 的插件）确定「完整聊天页」可落在哪个槽、`layout` 服务能做什么、客户端如何安全地调自己的宿主 HTTP 路由、以及客户端 bundle 能 require 到哪些模块。
> 方法：自建 asar 解析器直接读取安装包（22102 个 entry），再对运行中的宿主 `http://127.0.0.1:4862` 做 live 探测。
> 证据路径约定：下文 `C:\Users\PC\AppData\Local\Temp\dshX\<asar 内路径，/ 替换为 __>` 是 app.asar 的解包副本，**行号与原文件一致**；`C:\Users\PC\.dsh\profiles\desktop\node_modules\` 是已安装插件源码。

---

## 0. 结论摘要

1. `layout` 服务对外只有 **6 个方法，没有 `openPanel` / `closePanel`**：`selectPanel(panelId|null)`、`beginNavigation()`、`dispose()`、`toggleSidebar()`、`openRightbar(track, fullscreen)`、`closeRightbar()`（`dsh-client-ui-layout__lib__client.js` L506–549）。
2. **选中整页面板后，会话头部与输入框都不再渲染**：它们全部挂在 `main` 这个 **keyed** 槽里 `key='conversation'` 的 occupant 子树下，而 keyed 只渲染 `entryKey` 命中的那一个 occupant（renderer L1178–1181）。
3. **`main` 的 renderFn 收不到任何 owner props**（catalog `main.ownerProps = []`，宿主派发时传 `{}`），只有 root 作用域的 standard kit（10 个 `use*` hook + `renderFactorySlot`）；**自己在 `register` 里声明 children 才会拿到 `renderSlot`**。
4. 「完整聊天页」的官方正解 = **`main` 的 keyed 面板 + `sidebar.panellist` 一级图标（两者 id 必须相同）**；`shell.overlay` 是不改布局的浮层备选；**禁止注册 `root`**。
5. **调自己插件的宿主路由不需要任何 token**：鉴权载体是 `HttpOnly` 同源 cookie，同源相对 URL 的 `fetch` 自动携带，桌面壳还会在 `dsh-app://app` 转发时自动注入 cookie。`401 "dsh web authentication required"` **只**出现在 SPA index 兜底，插件已注册的路由永远走不到它。
6. **客户端 `require()` 只有 11 个平台白名单模块**；`@deepseek-ai/dsh-plugin-core`、`dsh-task-ledger` 等第三方包**不可 require**。

---

## 1. `layout` 服务：方法、参数语义、整页时的渲染范围、`main` 的 props

### 1.1 结论

| 方法 | 签名 | 语义（源码注释原文） |
|---|---|---|
| `selectPanel` | `(panelId: string \| null) => void` | "Select a global panel or return to the Conversation."；传 `null` 回会话，传未注册 id **抛错** |
| `beginNavigation` | `() => AbortSignal` | "the new pending navigation's cancellation signal." |
| `dispose` | `() => void` | "Invalidate pending navigations when the layout owner is unloaded." |
| `toggleSidebar` | `() => void` | "Toggle the sidebar panel (closed ⟷ contract default width)." |
| `openRightbar` | `(track: boolean, fullscreen: boolean) => void` | "Report the right panel's track and fullscreen presentation." |
| `closeRightbar` | `() => void` | "Report the right panel as hidden: no track, no handle." |

**不存在** `openPanel` / `closePanel` / `setActivePanel` / `navigate` —— `LayoutController` 类体（L506–549）没有其他成员函数。

### 1.2 证据

`C:\Users\PC\AppData\Local\Temp\dshX\dsh__node_modules__@deepseek-ai__dsh-client-ui-layout__lib__client.js`（803 行）

- `var LayoutController = class` **L506–549**；字段 `panels` / `hasMainPanel` / `panelInfo` / `navigation = new AbortController()`，构造 L516–520。
- `selectPanel` **L521–526**：
  ```js
  /** Select a global panel or return to the Conversation. */
  selectPanel(panelId) {
      if (panelId !== null && !this.hasMainPanel(panelId)) throw new Error(`layout.selectPanel: main panel "${panelId}" is not registered`);
      this.navigation.abort();
      this.panels.selectPanel(panelId);
  }
  ```
- `beginNavigation` L527–532 / `dispose` L533–536 / `toggleSidebar` L537–540 / `openRightbar` L541–544 / `closeRightbar` L545–548（注释即上表原文）。
- 服务注册 **L704** `ctx.reflect.provide("layout", layout);`；`inject` 列表 **L654–660** = `["slots","theme","locale","shortcuts"]` ⇒ 客户端插件用 `ctx.inject(["layout"], (sub) => sub.layout)` 取用。
- `hasMainPanel` 是**实时查槽表**：**L699–702** `new LayoutController(instance.actions, (id) => ctx.slots.entries("main").some(e => e.options.key === id), { getSnapshot, subscribe })` ⇒ 必须先 `slots.register({ name:'main', key })` 落地，`selectPanel(key)` 才不会抛错。
- key 集合维护：**L697–698** `instance.actions.retainMainPanels(ctx.slots.entries("main").flatMap(e => e.options.key === void 0 ? [] : [e.options.key]))`，**L772** `ctx.slots.subscribe("main", retainMainPanels)`。

内部 store（**不对外暴露**）：`createLayoutStore()` L444–502，初始值 L446–457（`sidebar 280`、`viewportWidth window.innerWidth`、`rightbar null`）；actions：`selectPanel` L460–463、`retainMainPanels` L464–466、`setSidebar` L467–470（clamp 264..420）、`toggleSidebar` L471–475（viewport<1024 切 narrowExpanded，否则 sidebar 置 0/280）、`setViewportWidth` L476–481、`setRightbar` L482–485（clamp 300..viewport×0.7）、`openRightbar` L486–493、`closeRightbar` L494–499。

### 1.3 选中整页后，会话头部 / 输入框还渲染吗 —— 不渲染

证据链（同一棵渲染树，逐级）

1. `root` 注册时把 `main` 声明为 **keyed**：layout **L705–736**，`children` 为 `{ sidebar: single/root, main: keyed/root, rightbar: single/root, "shell.bottom": single/root, "shell.overlay": list/root, "shell.leading": single/root }`。
2. 宿主唯一派发点 `MainPanel` **L122–129**：
   ```js
   function MainPanel({ usePanelInfo, renderSlot }) {
       const panelId = usePanelInfo((info) => info.activePanelId);
       return jsx("div", { className: AppFrame_module_css_default.mainPanel,
           "data-global-panel": panelId !== null || void 0,
           children: renderSlot("main", {}, { entryKey: panelId ?? "conversation" }) });
   }
   ```
   ⇒ 传给 occupant 的是**空对象 `{}`**；唯一有效派发参数是 `entryKey`。
3. renderer 的 keyed 派发只挑中一个 occupant（`dsh-client-ui-renderer__lib__client.js` **L1178–1181**）：`entriesOfSlot(slotKey).find((e) => e.options.key === opts?.entryKey)`；未命中且无 fallback ⇒ 渲染 `null`。
4. `conversation` 的 occupant = `ConversationPanel`（`dsh-client-ui-conversation__lib__client.js` **L20623–20625**，整个函数只有 `return renderSlot("main.conversation", {})`）；头部与 composer 都在它的子树里长出来：
   - `main.conversation` → `ConversationRoot` **L20296–20298** → `ConversationMainPanel` **L20273–20293**（`renderSlot("conversation.header", {})` + `renderFactorySlot("conversation.content", { variant:"main", phase, hero }, { slots: CONTENT_SLOTS })`，`CONTENT_SLOTS` L20267）
   - → `ConversationContent` **L20478 起**：`conversation.composer.bar` **L20557**；`composerBar` **L20571–20582**；`renderSlotChain("conversation.composer", { sessionId, session, pendingInteraction }, { fallback: composerBar, … })` **L20583–20591**；`data-composer-seat` **L20592–20598**
   - 头部：`ConversationHeader` **L20634–20647** → `renderSlot("conversation.header.leading", {})` + `renderSlot("conversation.session.header", { hideChrome })`
5. 旁证：`DocumentTitle` **L58–71** 用 `usePanelInfo((info) => info.activePanelId === null)` 决定浏览器标题 ⇒ 选整页时标题回落到产品名。

⇒ **`selectPanel(non-null)` 时 ConversationPanel 整棵树不挂载，会话头部与 composer 一起消失**。左侧栏、右栏、`shell.bottom/leading/overlay` 仍在（它们是 `main` 在 `root` 下的兄弟槽，见 L705–736）。

### 1.4 `main` 的 renderFn 到底收到什么

合并顺序见 renderer `renderEntry` **L792–810**：`{ ...kit, ...injected, ...slotInjected.props, ...ownerProps }`（`ContextualEntry` L773–790 另插 `...contextual`；**ownerProps 优先级最高**）。

`kit` 由 `standardKit` **L736–767** 生成，`standard` 由 `standardProps(scope, rootBinding, scopeBinding)` **L680–702** 给出（root 作用域只吃 root binding；session / session-maybe 才叠加 scope binding，后者 optional=true）。hook 名映射 `standardHookPropName(name) = 'use' + Capitalize(name)`（web bundle 偏移 488873：`function II(e){return `use${e[0]?.toUpperCase()??""}${e.slice(1)}`}`）。

root binding 来自 asar 内仅 9 处 `slots.provideRoot`：layout **L703**（`hooks.panelInfo`）、session **L1120–1130**（`sessions` / `sessionStatus` / keyed `sessionRetainInfo` / `sessionAccess`）、workspace **L5781–5784**（`workspaces` / keyed `workspaceAccess`）、context-menu **L1375**（`props.useContextMenu`）、client-resources **L176**（keyed `resource`）、api-remote-access **L744**（keyed `remoteAccess`）。

**`main`（root 作用域）实际拿到的 standard props（10 个）**：`useRemoteAccess`、`useResource`、`useContextMenu`、`useWorkspaces`、`usePanelInfo`、`useSessions`、`useSessionStatus`、`useSessionRetainInfo`、`useSessionAccess`、`useWorkspaceAccess`，外加固定 `renderFactorySlot`。

可选追加（`standardKit` L736–767）：注册带 `locale` ⇒ `t`（L745）；带 `store` ⇒ `useStore` / `actions`（L750–751）；**声明 children ⇒ 才有 `renderSlot`**（L754），有 chain 子槽再加 `renderSlotChain`（L755），有非 root 子槽加 `SessionProvider`（L756–760，缺 session adapter 抛错）。

**owner props：无。** catalog 里 `main.ownerProps` 是空数组，宿主 L127 只传 `{}`。

catalog 对 `main` 的注册约束（原文）：`key` **required** — "Your cell key: the entry renders where the owner dispatches this exact key. **Registering an already-occupied key replaces that occupant.**"；`keyDomain` — "open: any string the owner dispatches (no compile-time key set), already taken: `conversation`"；`doc` — "The reserved `conversation` key hosts the Conversation; other keys receive no Session binding."；`replaceRisk` = `shadows-shipped-ui`；`source` = `packages/client/ui-layout/src/client/index.ts:75`。

### 1.5 整页面板的标准样板（第三方真实产物，可直接抄）

`C:\Users\PC\.dsh\profiles\desktop\node_modules\dsh-task-ledger\dist\client.js`

- 注册整页 **L70286–70295**：
  ```js
  sub.slots.inject("main", () => sub.slots.register({
      name: "main", key: PANEL_ID, locale: NS
  }, (props) => createElement(BoardHome, { t: props.t ?? t, onBack: () => { selectPanel(null); } })));
  ```
- 左侧一级图标（`id` 必须等于 main 的 `key`）**L70231–70241**：`slots.register({ name: "sidebar.panellist", id: PANEL_ID, order: 30, label: entryLabel, locale: NS }, (props) => createElement(LedgerIcon, { size: props.size ?? 18 }))`
- 取 layout **L70261–70266**：`ctx.inject(["layout"], (sub) => { const layout = sub.layout; if (layout !== void 0) selectPanel = (id) => { layout.selectPanel(id); }; });`
- 配对机制（`dsh-client-ui-sidebar__lib__client.js`）：**L690** `ctx.slots.entriesOfSlot("sidebar.panellist").map(({ options }) => …)` 同步面板列表，**L705** `ctx.slots.subscribe("sidebar.panellist", syncPanels)`，点击 **L223** `selectPanel(id)`，**L719–720** `(id) => { ctx.layout.selectPanel(id); … }`。

---

## 2. 更适合「完整聊天页」的槽 + 109 个 slot 全量清单

### 2.1 结论与选型

| 需求形态 | 选槽（kind/scope） | 依据（catalog 原文） | 代价 |
|---|---|---|---|
| **整页占中央区（本项目推荐）** | `main`（keyed/root）+ `sidebar.panellist`（list/root） | "Central panel selected by sidebar entry id." | 会话头部 + composer 全部卸载，需自建返回会话 |
| 复用官方会话骨架、只换外壳 | `main.conversation`（single/session-maybe） | "Conversation shell beneath its root-scoped main-panel entry." | `replaceRisk: shadows-shipped-ui`，顶掉 ConversationRoot |
| 只换会话正文、保留官方头部/输入框 | `conversation.session`（single/session） | "Strict per-Session Conversation body." | 同上 `shadows-shipped-ui` |
| 新增一种「视图」并保留头部/导航 | `conversation.view`（list/session，**`replaceRisk: none`**） | "Registered Conversation target Views, rendered one at a time." | 需与 ChatView 共存 |
| 侧栏里嵌会话 | `sidebar.chat.conversation`（single/session） | "Session-scoped Conversation occurrence hosted by one Sidebar chat tab." | 由 `sidebar.right.pane.tab` 声明 |
| 右栏会话内容 | `rightbar.session`（single/session） | "Session content selected by the root-scoped right Sidebar controller." | `shadows-shipped-ui` |
| 全屏浮层、不动布局 | `shell.overlay`（list/root，**`replaceRisk: none`**） | "Frame-wide floating layer… The layer itself is click-through — entries opt back into pointer events… additive seat for a frame-wide surface of your own" | 需自己做 pointer-events 与焦点 |
| 输入框上方一条（官方最推荐的"体面"位置） | `conversation.composer.dock`（list/session） | 官方 skill `references/ui-plugin.md:5`："prefer a slot with allocated space, such as `conversation.composer.dock` when available" | 只是行程条，不是整页 |
| **禁止** | `root`（single/root） | "**DO NOT register here.** This is a single slot, so a second entry does not sit beside the frame — it shadows it… the page would render your component alone, with every seat the frame declares gone." | — |

**对 dsh-pi 的判断**：pi 聊天页要独占中央区（自有消息流、输入框、工具卡片），`main` + `sidebar.panellist` 是正确落点；必须自己实现返回会话（`layout.selectPanel(null)`），并接受「进入 pi 页后官方会话头部 / composer 消失」这一既定行为。若产品要求同时可见官方会话，改走 `shell.overlay` 或 `conversation.view`。

### 2.2 关键候选的完整字段

- `main`（keyed/root）occupants：`ConversationPanel`（key `conversation`）/ `PluginManagerPage` / `TaskManagerPage`
- `main.conversation`（single/session-maybe）occupant `ConversationRoot`，`declaredBy` "an entry in 'main' (client-ui-conversation)"，source `packages/client/ui-conversation/src/client/contract/slots.ts:222`
- `conversation.session`（single/session）"Strict per-Session Conversation body."，occupant `ConversationSession`，`slots.ts:224`
- `conversation.header`（single/session-maybe）"Resident navigation container, including when no Session is selected."，occupant `ConversationHeader`，`slots.ts:230`
- `conversation.view`（list/session）`slots.ts:278`；`registerOptions` = id(required) / order(optional number, 默认 0) / label(optional string|()=>string)；`ownerProps` = `{ inspectCall, viewRequest, openView(view, focus), completeViewRequest }`；occupants ChatView `chat` / TrajectoryView `trajectory` / StatsView `stats`；`replaceRisk: none`
- `conversation.composer`（chain/session）"Selector-routed replacements for the current Session's resident composer; **fixed overlays must portal to the document body** because the docked composer contains them."；`registerOptions.select` = `(owner) => unknown | null`；`ownerProps` = `{ sessionId, session, pendingInteraction }`
- `sidebar.chat.conversation`（single/session）`packages/client/ui-subagent/src/client/sidebar-chat/index.tsx:42`，occupant `ConversationSlotPanel`
- `shell.overlay`（list/root）`ui-layout/src/client/index.ts:107`，`ownerProps` 空，17 个 occupants（`context-menu`、`file-drag.feedback`、`open-in-app.toast`、`plugin-manager.refresh-toast`、`schedule.delete-toast` …）
- `sidebar.panellist`（list/root）`packages/client/ui-sidebar/src/client/contract/slots.ts:36`："Global panel icons. **Each list id addresses the matching main panel**; the sidebar owns the button and resolves its label from list metadata."；`ownerProps` = `{ size: number }`
- `root`（single/root）`packages/client/ui-renderer/src/client/registry.ts:44`，occupant `AppFrame`，`ownerProps` = `{ children?: never }`

### 2.3 指定四个包的实际注册（脚本 `C:\Users\PC\AppData\Local\Temp\scan4.cjs` / `scan5.cjs`）

| 包 | 命中的 slot 名 |
|---|---|
| `dsh-better-sidebar@0.28.2` `lib/client.js` | `conversation.session.header.utilities`（L19333、L31209）、`shell.overlay`（L19344）、`sidebar.right.pane.tab`（L31050）、`sidebar.right.pane.tab.title`（L31060）、`settings.section`（L33050） |
| `dshmarket@1.73.19` `client/client.js` | `plugins.bundle.config`、`plugins.detail.section`、`plugins.tab`、`settings.plugin.item`、`settings.plugins.tab`、`settings.section`、`settings.section.icon`、`shell.overlay`、`sidebar.panellist`（L18914–18997） |
| `dsh-task-ledger@0.2.2` `dist/client.js` | `sidebar.panellist.actions`（L70219）、`sidebar.panellist`（L70231）、`main`（L70286）、`plugins.bundle.config`（L70328） |
| `dsh-plugin-core@0.35.25` | **0 个**（182 个 .js 全扫、用官方 109 key 过滤 = 0 命中）；该包**无 main / 无 dsh 字段 / 无 client 半**，是源码级共享库 |

`dsh-plugin-core` 的一手注释（`dist/ui/official.js:5-9`）：`@deepseek-ai/dsh-client-ui-primitives` 是宿主内核提供的**平台模块**（兄弟仓 `tsdown.client.config.ts` 的 PLATFORM_MODULES），运行时由宿主模块表 `require()` 解析，「既不在本包 dependencies、也不写进 `dsh.client.inject`」；下游打包必须把 `@deepseek-ai/*` 标 external。全仓唯一 import 点同文件 **L19–20**。

### 2.4 全量 slot 清单（109 个）

权威来源：客户端 runtime 自带的 cordis inspect catalog —— `C:\Users\PC\AppData\Local\Temp\dshX\dsh__node_modules__@deepseek-ai__dsh-cordis-client-runner__lib__client.js`

- `const CLIENT_SLOT_API = [` **L2606** 起（数组字节区间 123215→417304）；`const SLOT_CATALOG = new Map(CLIENT_SLOT_API.map((entry) => [entry.key, entry]))` **L7705**；消费点 L7720 / L7750。
- 每条字段：`key / kind / scope / summary / doc / registerOptions / ownerProps / standardProps / keyDomain / declaredBy / occupants / replaceRisk / source / example`。
- 交叉验证：独立扫描 asar 内全部 `.js` 的 `slots.(inject|register|declare|entries|entriesOfSlot|subscribe|provideRoot)` 字面量（3019 个文件 / 65,028,622 字节），得 **109 个不同名字，与 catalog 完全一致**。
- kind 分布：`keyed 20 / single 43 / list 42 / chain 4`。
- 导出 JSON：`C:\Users\PC\AppData\Local\Temp\slot-catalog.json`；分组打印脚本 `C:\Users\PC\AppData\Local\Temp\list109.cjs`。

共 **109** 个，按前缀分组（kind / scope / summary 取自 catalog 原文）。

#### (top-level)（4）

| slot | kind / scope | summary |
|---|---|---|
| main | keyed / root | Central panel selected by sidebar entry id. |
| rightbar | single / root | The right column: a track the centre makes room for, or nothing. |
| root | single / root | The built-in render-tree root hole (seeded by SlotCore): the one slot the shell itself renders, and the ancestor of every other seat. |
| sidebar | single / root | The whole left column. |

#### contextMenu（2）

| slot | kind / scope | summary |
|---|---|---|
| contextMenu.content | keyed / root | Optional React rows for existing extension positions; data contributions need no renderer. |
| contextMenu.icon | keyed / root | Business-owned glyph or image selected by the action's icon key. |

#### conversation（42）

| slot | kind / scope | summary |
|---|---|---|
| conversation.approval.detail | single / session | Optional detail for the Tool call correlated with an approval request. |
| conversation.chat.assistant-actions | list / session | Ordered actions for one finalized assistant message. |
| conversation.chat.commandview | keyed / session | Command row keyed by the command name. |
| conversation.chat.flow | single / session | Ordered Chat rows and local echoes with viewport-bound visibility hooks. |
| conversation.chat.message.images | single / session | Renderer for one consecutive group of durable message images. |
| conversation.chat.node | keyed / session | Final Chat node renderer, keyed by `ChatNodeKind`. |
| conversation.chat.reasoning.body | single / session | Expanded reasoning body with raw and display-ready text. |
| conversation.chat.text-interaction | keyed / session | Area-local text gestures and surfaces; each consumer registers its own synchronous admission. |
| conversation.chat.turnTail | list / session | Ordered feature contributions before a completed Turn's action row. |
| conversation.chat.user.before | chain / session | Message-source decoration owned and rendered by the user Node entry. |
| conversation.chat.user.images | single / session | User-message images, including pending and local-echo previews, independently replaceable from output images. |
| conversation.composer | chain / session | Selector-routed replacements for the current Session's resident composer; fixed overlays must portal to the document body because the docked composer contains them. |
| conversation.composer.bar | single / session-maybe | Resident composer body, including the no-Session inert state; fixed overlays must portal to the document body because the docked composer contains them. |
| conversation.composer.dock | list / session | Ambient entries below the composer card; fixed overlays must portal to the document body because the docked composer contains them. |
| conversation.header | single / session-maybe | Resident navigation container, including when no Session is selected. |
| conversation.header.leading | single / root | Global navigation before the Session title, available without a Session. |
| conversation.hero.agentPreset | single / session-maybe | Agent-preset control staged for a New Session. |
| conversation.hero.brand.mark | single / root | Brand mark shown before the blank-session headline. |
| conversation.hero.options | list / session | Compact options right-aligned in the New Session row after the workspace and preset controls; rendered only with a Session. |
| conversation.hero.workspace | single / root | Workspace picker shown by the blank-session Hero. |
| conversation.hero.workspace.directoryFlow | single / root | Directory-flow hole under the conversation empty-state picker (declared by the WorkspacePicker entry). |
| conversation.input.activity | single / session | Compact action after the model selector; it can expand across the toolbar while retaining the editor and submit action, and fixed overlays must portal to the document body because the docked composer contains them. |
| conversation.input.attachments | single / session-maybe | Optional draft-attachment rail and drop target; fixed overlays must portal to the document body because the docked composer contains them. |
| conversation.input.dock | list / session | Full-width entries above the composer card; fixed overlays must portal to the document body because the docked composer contains them. |
| conversation.input.left | list / session | Compact controls at the left of the composer tool row; fixed overlays must portal to the document body because the docked composer contains them. |
| conversation.input.model | single / session | Model selector inside the composer tool row. |
| conversation.input.model.label | single / session | Non-interactive inline model label; selection controls remain owner-managed. |
| conversation.input.overlay | list / session | Floating entries rendered inside the resident composer card; fixed overlays must portal to the document body because the docked composer contains them. |
| conversation.input.permission | single / session | Current-session permission control inside the composer tool row; fixed overlays must portal to the document body because the docked composer contains them. |
| conversation.input.plan | single / session | Plan control inside the composer tool row; fixed overlays must portal to the document body because the docked composer contains them. |
| conversation.input.right | list / session | Compact controls before the composer submit action; fixed overlays must portal to the document body because the docked composer contains them. |
| conversation.plan-review.actions | list / session | Actions for the exact plan under review; approval remains with the question composer. |
| conversation.session | single / session | Strict per-Session Conversation body. |
| conversation.session.header | single / session | Strict per-Session title, actions, and View navigation. |
| conversation.session.header.actions | list / session | Title-adjacent Session actions in ascending order; overflow is clipped and faded before the utilities, so overlays must portal. |
| conversation.session.header.corner | single / session | The header's far-right corner, past the utilities' edge and into the header's own padding, for one control. |
| conversation.session.header.lineage | single / session | Optional replacement for one Session breadcrumb title; overlays must portal because the title area clips overflow. |
| conversation.session.header.utilities | list / session | Right-aligned Session utilities in ascending order. |
| conversation.session.header.views.actions | list / root | Rows of the View tab row's More menu; the header shows More only while this list has registrations. |
| conversation.trajectory.images | single / session | Renderer for one group of durable record images in the Trajectory ledger. |
| conversation.user.text.node | keyed / session | One business-owned inline renderer for a pure JSON text node. |
| conversation.view | list / session | Registered Conversation target Views, rendered one at a time. |

#### deliverables（2）

| slot | kind / scope | summary |
|---|---|---|
| deliverables.file.actions | list / session | Open one file through its authorized Session event coordinates. |
| deliverables.review.file.actions | list / session | The same file actions owned by a changed-file review tab. |

#### main（1）

| slot | kind / scope | summary |
|---|---|---|
| main.conversation | single / session-maybe | Conversation shell beneath its root-scoped main-panel entry. |

#### plugins（9）

| slot | kind / scope | summary |
|---|---|---|
| plugins.add.actions | list / root | Additional MenuItemButton rows after installation: 72px high, with a title and a description capped at two lines. |
| plugins.bundle.activation | keyed / root | Optional guidance after the user enables a bundle from the list, keyed by npm package name. |
| plugins.bundle.config | keyed / root | A bundle's own configuration, keyed by the bundle's package name and rendered on the bundle's page between its description and its rows (`view: 'page'` only). |
| plugins.detail.actions | list / root | Controls at the head of a detail page, before the page's own switch and uninstall, rendered with the page's subject. |
| plugins.detail.badge | list / root | Tags beside a detail page's title, after the version, beta, and problem tags the page draws itself, rendered with the page's subject. |
| plugins.detail.section | list / root | Sections under a detail page's own content: after the source on a bundle's page, after the configuration on a row's or an official plugin's page. |
| plugins.item | list / root | One official plugin the Plugins page lists in its Official group after the official bundles: `label` is the card's title and `order` its place. |
| plugins.row.config | keyed / root | The configuration of one row a bundle declares, keyed by `<package name>#<row id>` with the row id as the bundle's patch declares it: the row on the bundle's page gains a configure control that opens the entry's page, headed by the plugin's display title and description. |
| plugins.tab | list / root | Tabs after the page's own Installed tab, such as Discover: `label` names the tab and `order` places it. |

#### rightbar（1）

| slot | kind / scope | summary |
|---|---|---|
| rightbar.session | single / session | Session content selected by the root-scoped right Sidebar controller. |

#### settings（13）

| slot | kind / scope | summary |
|---|---|---|
| settings.action | list / root | Optional actions rendered in the content-column header before Close. |
| settings.close | single / root | The close button's visually-hidden label text (the button itself — icon, geometry, focus — is shell chrome). |
| settings.general.item | list / root | One preference row inside the General section — the additive seat for a single setting that needs no page of its own (a whole page is `settings.section`), contributed by the feature plugin that owns the preference (locale → Language, ui-theme → Appearance, ui-conversation → Composer Enter). |
| settings.header | single / root | The panel title text seat. |
| settings.launcher | single / root | Optional sidebar account launcher; opens the shell-owned settings panel. |
| settings.models.footer | list / root | Ordered extension area after the provider rows and the add controls. |
| settings.models.provider-card | keyed / root | One provider card's adapter extension area, dispatched with `entryKey = settingsNs` on every card that renders a directory row: a saved row's card (its first-run setup posture included) and the add-provider draft card. |
| settings.models.sign-in | single / root | Optional account login choice before the credential editor. |
| settings.onboarding | list / root | Root-scoped onboarding steps contributed by settings features. |
| settings.plugins.tab | list / root | One page inside the Plugins settings section. |
| settings.section | list / root | One settings page per list entry. |
| settings.section.icon | list / root | Optional navigation icons addressed by the matching settings.section id. |
| settings.trigger | single / root | The sidebar-foot trigger row content: icon + label, supplied as slot content (the accessible name comes from the content — rail state renders the label visually hidden). |

#### shell（4）

| slot | kind / scope | summary |
|---|---|---|
| shell.bottom | single / root | Full-width bottom content below all three columns. |
| shell.leading | single / root | Window-chrome seat at the frame's top-left, over every main panel. |
| shell.overlay | list / root | Frame-wide floating layer, above every column and outside their scroll containers. |
| shell.quota-notice | chain / root | Frame-wide quota notice chain. |

#### sidebar（27）

| slot | kind / scope | summary |
|---|---|---|
| sidebar.brand.mark | single / root | Brand mark rendered in the expanded brand row and collapsed rail. |
| sidebar.brand.name | single / root | Brand name rendered beside the expanded mark. |
| sidebar.chat.conversation | single / session | Session-scoped Conversation occurrence hosted by one Sidebar chat tab. |
| sidebar.footer.action | list / root | Optional actions beside Settings at the sidebar foot. |
| sidebar.panellist | list / root | Global panel icons. |
| sidebar.panellist.actions | list / root | Rows of the panel list's More menu; the sidebar shows More only while this list has registrations. |
| sidebar.right.pane.tab | keyed / session | One tab's body, dispatched with the `id` of the type in force for `tab.kind`. |
| sidebar.right.pane.tab.title | keyed / session | A tab's title as its chip (and a floating panel's header) shows it, dispatched with the same key and information hook as the body. |
| sidebar.right.tab.document | keyed / session | Document body selected by a registered implementation id. |
| sidebar.right.tab.document.action | keyed / session | Renderer-specific controls before the document toolbar's reload button. |
| sidebar.right.tab.document.actions | list / session | Header toolbar contributions acting on the previewed file, rendered after the preview's own controls once the file's Host path is known. |
| sidebar.right.tab.document.office.pdf | keyed / session | PDF presentation supplied with Office-owned converted bytes. |
| sidebar.right.tab.document.unpreviewable | list / session | Empty-state contributions for a file this preview cannot render, offered where Retry would stand once the file's Host path is known. |
| sidebar.right.tab.files.actions | list / session | Workspace directory actions after the `files` page's reload control. |
| sidebar.right.tab.guide | chain / session | The guide tab's body. |
| sidebar.right.tab.guide.actions | list / root | Rows of the guide's More menu; the guide shows More only while this list has registrations. |
| sidebar.right.tab.guide.entry | keyed / session | One provider's guide card, with the standard card as the owner's fallback. |
| sidebar.right.tab.menu.item | list / session | Extra items at the end of one tab's actions menu, in registration order. |
| sidebar.session.row.hover | list / root | Section of the Session row's hover card between its relative time and its trailing status line. |
| sidebar.session.row.leading | list / root | Leading decoration of one Session row, in the 16px cell before the title that the row's own state dot otherwise occupies. |
| sidebar.session.row.trailing | list / root | Non-interactive icons after the row's time label, before its pin marker, in ascending `order`. |
| sidebar.settings | single / root | The settings seat at the sidebar foot. |
| sidebar.toggle.badge | single / root | Non-interactive notification inside the collapsed sidebar expand button. |
| sidebar.workspaces | single / root | The workspace/session browsing region: section header, search, the grouped/flat session list, and every workspace dialog. |
| sidebar.workspaces.directoryFlow | single / root | Directory-flow hole under the sidebar browsing region (declared by the WorkspaceBrowser entry). |
| sidebar.workspaces.session.menu.item | list / root | Legacy external Session menu rows, in ascending `order`, rendered together before the built-in Archive action. |
| sidebar.workspaces.session.row.action | list / root | The hover buttons at the end of one Session row, in ascending `order`, after the "..." menu trigger. |

#### tool（3）

| slot | kind / scope | summary |
|---|---|---|
| tool.call.images | single / session | Durable images of a settled image-bearing Tool call, rendered through the attachment presentation plugin. |
| tool.call.toolview | keyed / session | Keyed Tool view dispatched by wire name, including custom tools. |
| tool.view.cordis | keyed / session | Interactive Package-owned region rendered inside the latest eligible `cordis_run` card in the conversation flow. |

#### workspace（1）

| slot | kind / scope | summary |
|---|---|---|
| workspace.toast | keyed / root | Workspace notices selected by their existing business discriminator. |

---

## 3. 客户端插件如何调用自己插件的宿主 HTTP 路由

### 3.1 结论（修正任务前提）

**不需要 token，也没有 token 可读。** 用 `node` 直连 `http://127.0.0.1:4862`（无 cookie / 无 Origin / 无 token）实测：

| 路径 | 状态 | 正文 |
|---|---|---|
| `GET /` | **401** | `dsh web authentication required; reopen the URL printed by dsh web.` |
| `GET /index.html` | 401 | 同上 |
| `GET /some/spa/path` | 404 | 空 |
| `GET /api/linusorii-memory` | **200** | `{"ok":true,"plugin":{"id":"linusorii-memory",…}}` |
| `GET /sidebar/api/list` | 403 | `{"ok":false,"error":{"code":"forbidden"}}`（插件**自己**的 fence） |
| `GET /dsh-market/status` | **200** | 插件路由，完全无鉴权 |
| `GET /api/remote.mux` | 401 | `unauthorized`（connection 桥的另一套文案） |

⇒ **401 只有一处来源：SPA index 兜底。** 若你的插件 `fetch` 得到 401，真实原因是请求落到了 index fallback（路径/前缀写错，或跨源被浏览器拦成 "Failed to fetch" 后误判），**不是缺 token**。

### 3.2 三道独立闸门

**闸门 ①：webServer 路由匹配** — `dsh-host-webserver__lib__index.js`

- `register(route)` **L375–382**：`const table = route.kind === "exact" ? this.exact : this.prefixes;`，重复抛 `webserver: duplicate ${kind} route "${path}"`，返回 disposer。
- `registerUpgrade(route)` L389–395；`registerFallback(fallback)` L405–411（唯一 fallback 座，二次注册抛 "webserver: fallback already registered"）。
- 主 handle **L459–472**：`const responder = this.responderFor(target.pathname);` undefined ⇒ 404；`"resource" in responder` ⇒ `serveResource`；否则 `responder.handler(req,res)`。
- `match(pathname)` **L580–589**：exact 优先，其次**最长前缀**（`pathname !== prefix && !pathname.startsWith(prefix + "/")` 跳过）。
- `readResource` 文档 **L412–426**："**This method checks no cookie, Host, or Origin: the caller admits the reader before reading.**"

**闸门 ②：Host/Origin 可信性（403）** — `dsh-client-connection__lib__index.js`

- `isTrusted` **L777–780** → `isTrustedApiRequest(request, this.trustedHosts, carrier?.host, carrier?.protocol ?? "http:")`（函数体 **L240–250**）：Host 必须是 loopback / trustedHosts / bind 之一；`sec-fetch-site: cross-site` 直接 false；有 `origin` 时走 `isSameAuthorityOrigin`（L258–269，只比 host）。
- `admit` **L742–750** 首行：`if (!this.isTrusted(request)) return { rejection: 403 };`

**闸门 ③：browser cookie / API operator（401）** — 同文件

- `admit` 全文（L742–750）：`const secure = this.owner.get("webServer")?.protocol === "https:";` → `if (this.browserAuth.isAuthenticated(request, secure)) return { peer: this.browserPeer };` → `const id = this.browserAuth.authenticateApi(request, secure);` 查不到 peer ⇒ `{ rejection: 401 }`。
- `requestRejection(request)` **L737–740**：`const admission = this.admit(request); return "rejection" in admission ? admission.rejection : void 0;`
- cookie：`sessionCookie` **L346–350** `name=value; Max-Age=…; Path=/; Expires=…; HttpOnly; SameSite=Strict`（https 追加 `; Secure`）；`cookieName(authority)` **L335–337** = `"dsh-auth-"` + `base64url(sha256(authority))`；`encodeCookie` L354–357 = `v<ver>.<base64url(body)>.<base64url(HMAC-SHA256)>`；`authenticate` L559–570 校验 authority / issuedAt / expiresAt / maxAge。
- **全文 grep `authorization|bearer` = 0 命中** ⇒ 没有 Authorization 头通道，只有 HttpOnly cookie。

`HttpOnly` ⇒ JS 读不到、也不需要读；同源 `fetch` 默认 `credentials:'same-origin'` 自动带上。

**401 的唯一出口**：`writeUnauthorized` **L571–577**（正文 `dsh web authentication required; reopen the URL printed by dsh web.`），只被 `authorizeIndex`（L458–497）调用；`authorizeIndex` 只被 `host-frontend-static` 的 fallback 调：

- `dsh-host-frontend-static__lib__index.js` **L68–106** `serveStatic`：**L74** `if (target === distRoot || target === distIndex) { const refusal = authorizeIndex(); if (refusal !== void 0) return refusal; … }` —— **只有 index / 目录根才判权**；其它静态文件直出（L79–93，`no-cache` + weak ETag，`If-None-Match` 命中返 304）。
- **L132**：`ctx.webServer.registerFallback({ resource: (request, peer) => serveStatic(request, distRoot, distIndex, () => peer === void 0 ? authorizeIndex(request) : void 0, (html) => ctx.webServer.renderIndex(html, peer ?? ctx.connection.browserPeer)…) })` ⇒ **有 peer（已认证）直接跳过授权**，并注入 `<base href="./">`。

### 3.3 真实插件怎么发请求

**样本 A：`dsh-linusorii-memory`（最简正确范式）** — `C:\Users\PC\.dsh\profiles\desktop\node_modules\dsh-linusorii-memory\client.js`

```js
// L213-216  用页面 base 解析：挂在反代子路径下时前导斜杠会丢掉前缀
const API = (() => {
  try { return new URL('api/linusorii-memory', document.baseURI).pathname } catch { return '/api/linusorii-memory' }
})()
// L218-230
async function api(path, options) {
  const { timeout = 8000, ...rest } = options ?? {}
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch(API + path, { ...rest, redirect: 'error', signal: controller.signal })
    …
```

宿主侧同包 `index.js`：**L35** `const API_PREFIX = '/api/' + PLUGIN_ID`；**L499** `ctx.effect(() => server.register({ kind: 'prefix', path: API_PREFIX, handler: createHandler({ store, stats, dataDir }) }), PLUGIN_ID + ': api routes')`；**L316** 剥前缀；**全程不调 `requestRejection`** ⇒ 无 fence 也可用（实测 200）。

**样本 B：`dsh-better-sidebar`（带 fence，且注释解释了两个 base 的区别）**

- URL 解析 `src/client/host-route-url.ts`：**L46–48** `export function hostRouteUrl(path, baseUrl = hostHttpBase()): URL { return new URL(path.replace(/^\/+/, ''), directoryBase(baseUrl)) }`；**L51–55** `hostWebSocketUrl`（默认 base = `hostTransportBase()`，scheme 换 ws/wss）；**L64–69** `directoryBase`（清 search/hash、补尾斜杠，placeholder origin `http://dsh.internal/`）。
- base 选择 `src/client/desktop-env.ts`：**L53–57** `hostHttpBase()` = `document.baseURI` 优先；**L27–32** `hostTransportBase()` = `globalThis.__DSH_TRANSPORT__?.streamBaseUrl` 优先。
- 注释要点（`host-route-url.ts` L12–29）："**HTTP** rides the PAGE base (`document.baseURI`)… while the Host's plugin routes answer no `Access-Control-Allow-*` headers, so a cross-origin `fetch` to the injected origin is blocked by the browser outright (`"Failed to fetch"`)… **WebSocket** needs that injected base"。
- 调用点 `lib/client.js`：**L4094–4107** `fetch(hostRouteUrl(`sidebar/api/${method}`).href, { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify(payload), signal })`；L4148（上传）/ L4185（写文件）同形。
- **三个包全局采样：没有任何一处显式传 `credentials`** —— 同源即可。
- fence：`lib/index.js` **L9325** `const fence = (req) => ctx.connection.requestRejection(req) === void 0;`；**L9394–9430** `ctx.webServer.register({ kind: "prefix", path: "/sidebar/api", handler: async (req, res) => { if (!fence(req)) { writeJson(res, 403, { ok:false, error:{ code:"forbidden", message:"forbidden" } }); return } if (req.method !== "POST") { writeJson(res, 405, …); return } const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname; … } })`。
- 该包全部路由注册点（`lib/index.js`，逐行核过）：`/sidebar/bundle`（prefix，**L3527**）、`/sidebar/api`（prefix，**L9394**）、`/sidebar/upload`（exact，**L9443**）、`/sidebar/write`（exact，**L9488**）、`/sidebar/archive`（exact，**L9536**）、`/sidebar/file`（prefix，**L9571**）、`/sidebar/html`（prefix，**L9610**）；WebSocket 三条 `registerUpgrade`：`/sidebar/ws/agent-opens`（**L9648**）、`/sidebar/ws/fs-watch`（**L9661**）、`/sidebar/ws/sidechat`（**L9678**）——**每一条 handler 首行都是 `if (!fence(req))`**（WS 侧是 `socket.destroy()`）。对应源码 `src/index.ts`：`register` L1542 / 1591 / 1629 / 1682 / 1707 / 1777，`registerUpgrade` L1836 / 1857 / 1879，`requestRejection` L1411。

### 3.4 桌面壳会自动注入 cookie

`C:\Users\PC\AppData\Local\Temp\dshX\lib__main.js`（Electron main bundle）

- `protocol.handle(SCHEME, …)` **L20617–20626**：hostname `app` 且路径属于静态集合（`/`、`/index.html`、`/assets/*`、`/favicon.svg`、`/manifest.webmanifest`）⇒ 直出；**其余路径 `return forwardWebRequest(request, hostUrl, hostCookie)`**（L20622–20623）。
- `forwardWebRequest` **L15877–15908**：**L15880** `if (origin !== null && origin !== "dsh-app://app") return new Response(null, { status: 403 });`；L15885–15890 删 `host / origin / cookie / sec-fetch-site`；**L15891 `headers.set("cookie", cookie)`**；L15896–15898 `redirect:"manual", duplex:"half"`。
- cookie 来源 `authenticateWebHost(url)` **L15838–15845**：`fetch(url, { redirect: "manual" })` → 必须 303 且有 `set-cookie`，截到第一个 `;` 前；存模块级 `hostCookie`（L20319 声明 / L20382 赋值）。
- `set-cookie` 不回传页面：`WITHHELD_RESPONSE_HEADERS` **L15852–15864** 含 `set-cookie`。
- WebSocket 同样补：`onBeforeSendHeaders` for `ws://127.0.0.1/*` **L20658–20680**。

⇒ 桌面壳内 fetch 相对路径 → 壳注入 HttpOnly cookie；纯 web（浏览器）→ 同源 cookie 自动带。

### 3.5 15 行可抄代码

宿主侧（`src/index.ts`，需 `inject = ['webServer','connection']`）：

```ts
const fence = (req) => ctx.connection.requestRejection(req) === undefined

ctx.effect(() => ctx.webServer.register({
  kind: 'prefix',
  path: '/api/dsh-pi',
  handler: async (req, res) => {
    if (!fence(req)) { writeJson(res, 403, { ok: false, error: { code: 'forbidden' } }); return }
    if (req.method !== 'POST') { writeJson(res, 405, { ok: false, error: { code: 'method' } }); return }
    const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
    const method = pathname.startsWith('/api/dsh-pi/') ? pathname.slice('/api/dsh-pi/'.length) : ''
    // …派发 method，写回 writeJson(res, 200, { ok: true, value })
  },
}), 'dsh-pi: api')
```

客户端侧（`client.js`，不传 `credentials`、不拼前导斜杠）：

```js
const API = (() => {
  try { return new URL('api/dsh-pi/', document.baseURI).pathname } catch { return '/api/dsh-pi/' }
})()

async function call(method, payload, signal) {
  const res = await fetch(API + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
    signal,
  })
  const text = await res.text()
  const body = text === '' ? {} : JSON.parse(text)
  if (!res.ok || body?.ok !== true) throw new Error(body?.error?.code ?? `HTTP ${res.status}`)
  return body.value
}
```

---

## 4. 客户端 bundle 的 `require()` 能拿到哪些模块

### 4.1 结论：只有 11 个平台白名单

`C:\Users\PC\AppData\Local\Temp\dshX\dsh__node_modules__@deepseek-ai__dsh-web-frontend__dist__assets__index-BgUyXZcc.js`（主前端 bundle，970KB），**偏移 946917**：

```js
function YZ(){return{react:fk,"react/jsx-runtime":gk,"react-dom":xk,"react-dom/client":Ck,
"@deepseek-ai/cordis":Rb,zod:JS,"@tanstack/react-virtual":rI,
"@deepseek-ai/dsh-client-store":SI,"@deepseek-ai/dsh-client-ui-slots":MI,
"@deepseek-ai/dsh-client-ui-primitives":FU,"@deepseek-ai/dsh-client-ui-dockkit":WZ}}
```

作为 `staticModules` 注入（偏移 949580）：`this.modules = r.create({ boot: t.__DSH_BOOT__, staticModules: YZ(), … })`。

解析规则 `dsh-client-modules__lib__client.js` `makeRequire(ownerId, edges)` **L834–853**：seed 命中 ⇒ 返回；否则 `stripClientSuffix(spec)`（L98–100，使 `<pkg>/client` 等同包名）后查 loadCache / 已注册 factory；否则抛 `client-modules: require("${spec}") missed the module table — not a platform seed word, not a materialized module, and no registered package factory (a build-time externals drift,…)`（L842）。`require.async(spec)` L845–851；循环依赖抛 `client-modules: require cycle through "${id}" (factory-form CJS cannot deliver partial exports)`（L812）。

⇒ `@deepseek-ai/dsh-plugin-core`、`dsh-task-ledger`、`dshmarket` 等第三方包**都不能 require**。官方 skill（`references/ui-plugin.md:9`）同口径："React comes from the browser module table; no duplicate React installation… declare non-baseline runtime imports in `dsh.client.external`"。

### 4.2 真实插件的实际用法

| 插件 | 非相对 `require` 到的模块 |
|---|---|
| `dsh-better-sidebar/lib/client.js` | `react`、`react-dom`、`react-dom/client`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-ui-primitives` |
| `dshmarket/client/client.js` | `react`、`react-dom`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-ui-primitives` |
| `dsh-task-ledger/dist/client.js` | `react`、`react-dom`、`react-dom/client`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-ui-primitives` |
| `dsh-linusorii-memory/client.js` | 仅 `react` |

入口形态（官方 `SKILL.md` 与真实产物一致）：`window.__ModuleLoader__.load({ id: '<包名>', factory(require) { const React = require('react'); … return { inject: ['slots'], apply(ctx) {…} } } })`，**`id` 必须等于包名**。

---

## 5. 不确定 / 未验证

1. `retainMainPanels` 的渲染语义（保留已注册 key 是否让非活跃面板保持挂载）只读到 store action（L464–466）与调用点（L697–698、L772），**未找到消费它的渲染分支** ⇒ 不结论。
2. `main` 注册时传 `store` 对聊天页是否必要未验证（catalog 显示 `main` 无 store，两个真实整页插件都没传）。
3. `connection.createSharedFetchHandler` / `registerFetchRoute`（L820–853，`peer.principal.kind !== "owner"` ⇒ 403）对**客户端**插件是否可用，未找到客户端调用方 ⇒ 未验证。
4. 新增 `conversation.view` 后的切换 UI（More 菜单 / tab 行）未在本次范围核实。

---

## 附：复现方法

- asar 头：`u32@4 = payloadSize`、`u32@8 = stringLen`、JSON 从 offset 16 起长 `stringLen`，**`DATA_BASE = 8 + payloadSize`**（本机 5748140；用 `16 + jsonSize` 会差 8 字节导致全表错位；JSON 尾部有 padding，需 `slice(0, lastIndexOf('}') + 1)`）。索引 `C:\Users\PC\AppData\Local\Temp\dsh-idx.json`（22102 entry，逻辑总字节 462,661,959）。
- 解包 `C:\Users\PC\AppData\Local\Temp\dsh-extract3.cjs` → `C:\Users\PC\AppData\Local\Temp\dshX\`（15354 个 `js/mjs/cjs/json/md/d.ts/yml/css`，文件名把 `/` 换成 `__`）。
- 安装目录在 `readdir` 结果里的名字以 `[` 开头（显示成 `[DSH]`），**不要硬编码**：`fs.readdirSync('C:/Users/PC/AppData/Local/Programs').find(n => n.startsWith('['))`。
- catalog 导出：把 `CLIENT_SLOT_API = [...]` 整段 `eval` 成 JSON → `C:\Users\PC\AppData\Local\Temp\slot-catalog.json`。

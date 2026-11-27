/**
 * superpi-editor —— pi 命令行会话窗口（TUI）的输入框增强。
 *
 * 装法：`npm run superpi:editor`（把本文件复制到 ~/.pi/agent/extensions/，pi 重启会话或 /reload 后生效）
 *
 * ---------------------------------------------------------------------------
 * 为什么需要它（pi 1.5.2 实测）
 *
 * 1. **剪贴板里的文件贴不进来**。pi 的 Ctrl+V 走 handleClipboardPaste：
 *    filePaths → 图片 → 文本。读文件列表用的是 pi-tui 的 native `getFilePaths()`，
 *    而 Windows 的 native 模块只实现了 getText / setText / getImage —— 没有 getFilePaths
 *    （macOS 才有）。于是「资源管理器里复制一张图 → Ctrl+V」三档全空，什么都没发生。
 *
 * 2. **输入框没有选区**。pi-tui 的 Editor 没有选区模型：Ctrl+A 是「移到行首」，
 *    Ctrl+C 被 pi 的 app.clear 吃掉去清空输入框（这就是「按 Ctrl+C 内容消失」），
 *    Ctrl+X 无绑定，选中后 Backspace 只删一个字符。
 *
 * 3. **输入框只有上下两条线**，没有左右边框；没有状态颜色；粘贴进来的长路径和普通
 *    文字长得一样，肉眼分不出来；也没有 settings / home 入口。
 *
 * 4. **「回到项目选择」没有入口**。pi 的 cwd 是进程启动时定死的，TUI 里只有
 *    `/new`（同项目新树）与 `/resume`（会话列表，没有按项目分组的页面）。
 *    这里补一个切换图标：列出别的项目，选一个就在那里开新会话（走 pi 官方
 *    SessionManager + ctx.switchSession，不伪造 pi 没有的能力）。
 *
 * ---------------------------------------------------------------------------
 * 做法：**不动 pi 的任何文件**，只用 pi 公开的扩展 API
 *   - `ctx.ui.setEditorComponent()` 换输入框（官方 modal-editor.ts 同款做法）
 *   - `ctx.ui.setFooter()` 接管 footer —— cwd 那行要跟 settings/home 同行、模型名要可点，
 *     而那一行整份归 pi 的 FooterComponent 所有，没有第二个官方入口
 *   - `ctx.ui.setWorkingVisible(false)` 关掉 pi 内置的 Working 行，改由本扩展按状态上色
 *   - `pi.on('agent_start' / 'tool_execution_end' / 'agent_settled')` 驱动状态机
 *
 * 键位（对齐 Windows 输入框的肌肉记忆）
 *   Ctrl+A                   全选（Home 仍是行首）
 *   Shift+←/→/↑/↓            扩/收选区
 *   Shift+Home / Shift+End   选到行首 / 行尾
 *   Ctrl+C                   复制（有选区复制选区，无选区复制全文；**都不清空内容**）
 *   Ctrl+X                   剪切（无选区 = 剪切全文）
 *   Backspace / Delete       删除选区
 *   可打印字符 / 粘贴        替换选区
 *   Esc                      先关 settings 菜单，再清选区，其余归 pi
 *   Ctrl+V                   剪贴板里有**文件**就插入绝对路径（Windows 专用回落），
 *                            否则完全交回 pi（图片写临时文件、文本按原样插入）
 *
 * 界面
 *   - 四边闭合的框（┌─┐ │ │ └─┘），框线 80% 白（255 × 0.8）
 *   - 框内上边框：左侧 Working 状态（正常白 / 成功绿 / 出错红，图标同色）
 *   - 框外**两行**由本扩展接管的 footer 画（0.9.9 起）：
 *       `D:\proj\SuperPi (master)  ⇄              settings  home`   ← 本扩展画
 *       `↑12k ↓3.4k 24%/1.0M (auto)    (prov) Model • max`           ← pi 自己的第 2 行
 *     项目名右侧的 ⇄ 是「回到项目选择」；`Model` / `max` 各自可点（→ /model、/thinking）。
 *   - 那几处文字按钮**鼠标移入会变亮 + 下划线**（常态是 dim，与模型名同色）
 *   - 粘贴进来的绝对路径带浅灰底色（终端单元格没有真正的圆角，首尾各留一格底色当圆角）
 *
 * 刻意不做的事：不碰 Ctrl+C 之外的 pi 退出语义（空编辑器时 Ctrl+C 原样放行），
 * 不伪造 pi 没有的能力，不改 node_modules，不伪造 pi 没有的 settings 项 ——
 * settings 里的每一条都是 pi 自己的斜杠命令（门禁用 grep 断言它们在 pi 里仍然存在）。
 */

import * as piPublicApi from '@earendil-works/pi-coding-agent'
import { CustomEditor } from '@earendil-works/pi-coding-agent'
import { getNativeClipboard, matchesKey, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BRAND_NAME } from './superpi-brand.mjs'
import { detectTurnVerdict } from './superpi-turn-verdict.mjs'

/**
 * verdict 的形状（与 `superpi-turn-verdict.mjs` 的 `detectTurnVerdict` 逐字段一致）。
 *
 * 在本文件里再声明一次类型，而不是从 `.mjs` `import type`：那个模块是纯 JS，
 * 没有 `.d.ts`，jiti 能跑但类型解析拿不到东西。**只声明类型、不复制判据** ——
 * 判据永远在模块里，这里连一个标记字符串都没有。
 */
export type TurnVerdict = {
  delivered: boolean
  kind: string
  bytes: number
  notice: { zh: string; en: string }
  detail: string
}

/* ------------------------------------------------------------------ 外观 */

/** 输入框框线：80% 白。 */
export const FRAME_RGB = [204, 204, 204] as const
/** 项目行上「切换项目」的图标。选 U+21C4 是因为它是**单列宽**：全角图标会把整行撑歪。 */
export const SWITCH_ICON = '\u21c4'
/** 粘贴路径底色：浅灰。 */
export const PATH_CHIP_RGB = [104, 104, 104] as const
/** Working 状态色：正常白 / 成功绿 / 出错红。 */
export const STATUS_RGB = {
  idle: [255, 255, 255],
  running: [255, 255, 255],
  success: [126, 211, 133],
  error: [236, 94, 94],
} as const

const SGR_RESET = '\x1b[0m'
const SEL_OPEN = '\x1b[7m'
const SEL_CLOSE = '\x1b[27m'
const SGR_UNDERLINE = '\x1b[4m'
const SGR_NO_UNDERLINE = '\x1b[24m'

const sgrFg = (rgb: readonly number[]) => `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`
const sgrBg = (rgb: readonly number[]) => `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`

/** 一次 Ctrl+V 里允许的 PowerShell 读取超时（ms）。慢机器上让位给 pi 自己的粘贴。 */
const FILE_LIST_TIMEOUT_MS = 1500
/** 上一次粘贴读取被卡住多久后就允许重新尝试（ms）。 */
const PASTE_STALE_MS = 6000

type Point = { line: number; col: number }
type Range = { start: Point; end: Point }

const CTRL_A = '\x01'
const CTRL_C = '\x03'
const CTRL_X = '\x18'
const ESC = '\x1b'

/* -------------------------------------------------------------- 运行状态 */

/**
 * Working 行要按状态换色，所以这里维护一台最小状态机。
 * 输入来自 pi 的扩展事件（agent_start / tool_execution_end / agent_settled），
 * 消费者是编辑器渲染 —— 所以是模块级共享，不挂在某个实例上。
 */
export type RunPhase = 'idle' | 'running' | 'success' | 'error'

/**
 * 当前正在执行的那一个工具。
 *
 * 为什么需要它（0.14.1）：实测一个真实会话里，**一轮**跑 25 次工具执行、累计
 * 2028 秒（33.8 分钟），其中单条 `timeout=960` 的命令就要 371~494 秒。
 * 这些等待是**合法的**（跑全量变异测试），但界面上只有一个一直涨的秒数，
 * 用户无从判断「它在干活」还是「它卡死了」，实际体感就是"卡在 Working"。
 * 把工具名与它自设的上限摆出来，等待就从"疑似卡死"变成"可见的进度"。
 *
 * `lastOutputAt`（0.15.0）：最近一次收到工具输出的时刻。
 * bash 每 100ms 就会发 `tool_execution_update`（`bash.js:15` 的
 * BASH_UPDATE_THROTTLE_MS），所以「有输出」说明真的在推进；
 * 而长时间**没有新输出**才是用户觉得卡住的原因（例如跑一个只打印一次的测试）。
 * 有了它就能区分这两种静默，见 `workingLabel` 的心跳段。
 *
 * 与面板端（client.js 的 `view.activeTool`）逐字对齐 —— AGENTS.md §3 的
 * 100% 对齐在这里是结构性成立的：两端都从 `tool_execution_start.args.timeout` 取上限。
 */
export type ActiveTool = { id: string; name: string; startedAt: number; limitSeconds: number; lastOutputAt: number } | null

export const runState: {
  phase: RunPhase
  failed: boolean
  /**
   * 本轮「没交付」的判读（0.15.1 起是布尔 `malformed`，0.18.0 起是整份 verdict）。
   *
   * 从布尔改成整份的原因：六类形态要给六句不同的话，布尔装不下。
   * `null` = 本轮正常（或还没收到 assistant 消息）。
   */
  verdict: TurnVerdict | null
  startedAt: number
  tool: ActiveTool
} = {
  phase: 'idle',
  failed: false,
  verdict: null,
  startedAt: 0,
  tool: null,
}

/**
 * 从 `tool_execution_start` 的 args 里取命令自带的上限（秒）。
 *
 * pi 的 bash 工具把 `timeout` 当**秒**用且没有上限钳制 —— 实测模型给过
 * 1200 / 1800 / 6000，甚至 120000。取不到就返回 0（表示这次调用没声明上限），
 * 不用「猜一个默认值」：猜错会让"还剩多久"变成假信息。
 */
export function toolLimitSeconds(args: unknown): number {
  if (args === null || typeof args !== 'object') return 0
  const raw = (args as { timeout?: unknown }).timeout
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 0
  return Math.floor(raw)
}

export function markRunStart(now = Date.now()): void {
  runState.phase = 'running'
  runState.failed = false
  runState.verdict = null
  runState.startedAt = now
  runState.tool = null
  // 开始干活就要转起来（幂等：重复调用不会叠加定时器）。
  startAnimation()
}

export function markToolStart(name: unknown, args: unknown, now = Date.now(), id = ''): void {
  runState.phase = 'running'
  runState.tool = {
    id: typeof id === 'string' ? id : '',
    name: typeof name === 'string' && name !== '' ? name : 'tool',
    startedAt: now,
    limitSeconds: toolLimitSeconds(args),
    // 起始时刻即"最近一次活动"，否则第一帧就会误报"已静默 N 秒"。
    lastOutputAt: now,
  }
}

/**
 * 工具产出了新输出（0.15.0）。
 *
 * bash 每 100ms 就会发一次 `tool_execution_update`（`core/tools/bash.js:15`
 * 的 `BASH_UPDATE_THROTTLE_MS`），所以收到它就说明命令确实在推进。
 * 只更新 `lastOutputAt`，不改 phase、不重置 startedAt —— 计时是"这一轮跑了多久"，
 * 不该被输出频率影响。
 */
export function markToolOutput(now = Date.now(), id = ''): void {
  if (runState.tool === null) return
  /**
   * 按 id 匹配（0.15.0）。
   *
   * 并行工具调用时，工具 B 的输出**不能**刷新工具 A 的静默计时 ——
   * 否则 A 明明卡住了，心跳却被 B 不断重置，永远不报警。
   * id 为空（老调用方/事件缺字段）时退化为"刷新当前"，保持向后兼容。
   */
  if (id !== '' && runState.tool.id !== '' && runState.tool.id !== id) return
  runState.tool = { ...runState.tool, lastOutputAt: now }
}

export function markToolEnd(): void {
  // 只清工具，不改 phase：工具结束之后 agent 还要继续推理/推进，
  // 把 phase 置 idle 会让 Working 行消失一下又出现（闪烁）。
  runState.tool = null
}

export function markToolError(): void {
  if (runState.phase === 'running') runState.failed = true
}

/**
 * 模型这一轮没交付（0.18.0；前身 `markMalformedOutput` 0.15.1）。
 *
 * 与 `markToolError` 的区别在**责任归属**：工具失败是"命令跑挂了"，没交付是
 * "模型没按协议说话 / 吐了坏字节 / 被截断"。两者都该让状态变红，但后者还需要
 * 在文案里说清原因 —— 否则用户看到红色 ✖ 却不知道"为什么这轮没执行任何工具就结束了"。
 *
 * 存整份 verdict 而不是布尔：Working 行要按 `kind` 说六类不同的话，
 * 文案本体取自模块（与面板逐字相同），这里不复制任何一个字。
 */
export function markUndelivered(verdict: TurnVerdict): void {
  runState.failed = true
  runState.verdict = verdict
}

/**
 * 判读一条 assistant 消息（唯一实现在 `extensions/superpi-turn-verdict.mjs`）。
 *
 * 0.16.2 起这个函数只做转发，不再自己实现判据 —— 形状的分叉史见模块头部注释。
 */
export function turnVerdictOf(message: any): TurnVerdict {
  return detectTurnVerdict(message)
}

/** 只要布尔值的调用方（既有门禁与自动重发判据）走这里。 */
export function isUndeliveredTurn(message: any): boolean {
  return detectTurnVerdict(message).delivered !== true
}

/** 带上形态（`dsml-text` / `corrupt` / `truncated` …），供日志与门禁断言是哪一类。 */
export function verdictKindOf(message: any): string {
  return detectTurnVerdict(message).kind
}

export function markRunSettled(): void {
  runState.phase = runState.failed ? 'error' : 'success'
  runState.startedAt = 0
  runState.tool = null
  // 本轮结束就停表：idle 态不该继续烧 CPU（也让门禁能断言"settled 之后不转"）。
  stopAnimation()
}

export function resetRunState(): void {
  runState.phase = 'idle'
  runState.failed = false
  runState.verdict = null
  runState.startedAt = 0
  runState.tool = null
  stopAnimation()
}

/**
 * 时长文案，口径与 pi 自己的 `formatToolDuration`
 * （`dist/core/tools/render-utils.js:97-106`）**逐字一致**：
 *   <60s  → `4.2s`（一位小数）
 *   <60m  → `5m 41s`
 *   更久  → `2h 3m 4s`
 *
 * 为什么必须同口径：同一条命令，pi 的工具行写 `Elapsed 5m 41s`，Working 行要是写
 * `341s` 或 `16分`，用户会以为是两个不同的计时（实测反馈里就出现过这个困惑）。
 *
 * 注意 `<60s` 的分界是**秒**不是 10 秒：写成 `seconds < 10` 会让
 * `formatRunDuration(42000)` 输出 `42s` 而 pi 输出 `42.0s`，口径又分叉了。
 */
export function formatRunDuration(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0
  const seconds = safe / 1000
  if (seconds < 60) return seconds.toFixed(1) + 's'
  const totalSeconds = Math.floor(seconds)
  const minutes = Math.floor(totalSeconds / 60)
  const remainder = totalSeconds % 60
  if (minutes < 60) return minutes + 'm ' + remainder + 's'
  return Math.floor(minutes / 60) + 'h ' + (minutes % 60) + 'm ' + remainder + 's'
}

/**
 * Working 行主文案：`◐ Working · 38m 7s · bash · 上限 16m`。
 *
 * 三段各有职责，缺一段就会让某一类等待变得不可解释：
 *   · `Working · 38m 7s` —— 本轮**累计**耗时（不是单个工具）。实测一轮里 25 次工具
 *     执行累计 2028 秒，用户看到的"卡了好久"多数是这个累计值。
 *   · `bash`             —— 此刻在跑什么。没有它，累计秒数涨到 38 分钟时无法区分
 *     "模型卡死"与"命令在跑"。
 *   · `上限 16m`         —— 这条命令自带的 timeout。模型常给 960/1800 秒，
 *     知道上限就能算出最坏还要等多久；超限时改说「已超出上限」，那是真该报警的时刻。
 *
 * 窄终端依次退让：完整三段 → 只留 Working+累计 → 只留图标（见 topBorder 的 widthOfVisible 判断）。
 */
export function workingLabel(now = Date.now(), includeTool = true): string {
  const phase = runState.phase
  const startedAt = runState.startedAt
  /**
   * 没交付的解释（0.15.1 起，0.18.0 扩到六类）。
   *
   * 这条路必须**先于** phase 判断：没交付时本轮已经 settled（phase 变 error 或 idle），
   * 而用户最需要的恰恰是那一刻的解释 —— 否则他只会看到红色 ✖ 或图标消失，
   * 完全不知道"为什么这轮什么都没做就结束了"。
   *
   * 文案直接取模块的 `notice.zh`，**不在本文件里写第二份**：
   * 面板读的是同一份 notice（host 随事件下发），两端必须逐字相同 ——
   * 同一个故障给出两种解释，用户会以为是两个不同的问题（D1 类失真）。
   */
  const verdict = runState.verdict
  if (verdict !== null && typeof verdict.notice?.zh === 'string' && verdict.notice.zh !== '') {
    return verdict.notice.zh
  }
  if (phase !== 'running' || startedAt <= 0) return 'Working'
  let text = 'Working · ' + formatRunDuration(now - startedAt)
  const tool = runState.tool
  if (includeTool === true && tool !== null) {
    text += ' · ' + tool.name
    if (tool.limitSeconds > 0) {
      const limitMs = tool.limitSeconds * 1000
      const elapsed = now - tool.startedAt
      text += elapsed > limitMs
        ? ' · 已超出上限 ' + formatRunDuration(limitMs)
        : ' · 上限 ' + formatRunDuration(limitMs)
    }
    // 心跳段（0.15.0）：静默超过阈值时明确说"还在跑、只是没输出"。
    // 这是用户要的「隔一段时间反馈一下进度，以免让用户觉得卡着了」——
    // 且必须是**诚实的**：不编造百分比，只陈述"已静默 N 秒 + 仍在运行"。
    // 有输出时（bash 每 100ms 发一次 update）不显示这一段，免得噪音。
    const silentMs = now - tool.lastOutputAt
    if (silentMs >= HEARTBEAT_AFTER_MS) {
      text += ' · 已静默 ' + formatRunDuration(silentMs) + '，仍在运行'
    }
  }
  return text
}

/* ------------------------------------------------------------------ 入口 */

/** 输入框右下角的两个入口。文案全小写（用户 2026-11-17 明确要求 home 小写）。 */
export const EDITOR_ACTIONS = [
  { id: 'settings', label: 'settings' },
  { id: 'home', label: 'home' },
] as const

/**
 * settings 菜单里的条目。
 *
 * **同一份菜单两种来源**（`source` 字段），这才是关键：
 *  - `'pi'`      —— pi 自己的斜杠命令。门禁 `test/tui-editor.mjs` 会去 pi 的 dist 里
 *                   grep 这些命令，pi 删了就红。一条都不自造。
 *  - `'superpi'` —— 本仓库自己的扩展命令（由 `extensions/superpi-rules.ts` 注册），
 *                   同一条门禁改成断言「那个扩展里真的注册了这个名字」。
 *
 * 为什么不能把自造的命令混进去当 pi 的：用户点了没反应，而且把"pi 支持 X"这句话变成了假话。
 */
export const SETTINGS_COMMANDS = [
  { label: 'settings', command: '/settings', source: 'pi' },
  { label: 'model', command: '/model', source: 'pi' },
  { label: 'thinking', command: '/thinking', source: 'pi' },
  { label: 'scoped-models', command: '/scoped-models', source: 'pi' },
  // 用户自定义规则（最高优先级）—— 与面板设置里那一节是同一份文件（<home>/.superpi/rules.json）。
  { label: 'rules', command: '/superpi-rules', source: 'superpi' },
  // 模型模态开关（0.13.0）—— 与面板设置里「模型模态」一节是同一份文件。
  { label: 'modalities', command: '/superpi-modalities', source: 'superpi' },
] as const

/** home = 回到刚启动时的界面 —— pi 里唯一对应的动作是 `/new`（起一棵新会话树）。 */
export const HOME_COMMAND = '/new'

/**
 * 项目名：`<cwd 缩成 ~> (branch)`。
 *
 * 取值与 pi footer 的 cwd 行同一套（`formatCwdForFooter` + `(${branch})`），
 * 只是不带 ` • sessionName` —— 会话名已经由终端标题和面板表达，footer 这行留给项目。
 */
export function projectLabel(cwd: string, branch: string | null, home?: string): string {
  const raw = typeof cwd === 'string' ? cwd : ''
  if (raw === '') return branch ? '(' + branch + ')' : ''
  let shown = raw
  if (typeof home === 'string' && home !== '') {
    try {
      const rel = path.relative(path.resolve(home), path.resolve(raw))
      const inside = rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))
      if (inside) shown = rel === '' ? '~' : '~' + path.sep + rel
    } catch {
      /* 路径解析失败就用原始 cwd */
    }
  }
  return branch ? shown + ' (' + branch + ')' : shown
}

/**
 * 当前悬停的可点元素 id（``settings`` / ``home`` / ``switch``）。
 *
 * 模块级：鼠标事件落到的是**编辑器实例**，而框外那几行（项目行 + 入口）由
 * footer 画 —— 两边必须是同一份悬停状态，否则鼠标移上去 footer 不知道要变亮。
 */
export const hoverState: { id: string | null } = { id: null }

/**
 * 鼠标移入时的「可用」样式：高亮（accent）+ 下划线。
 *
 * 只换颜色不够：这几个入口平时就是 dim（与模型名同色），浅色主题里
 * dim → accent 的差别几乎看不出来；下划线是终端里最稳的「可点击」信号。
 */
export function hoverStyle(text: string, fg: ((token: string, value: string) => string) | null): string {
  let body = text
  try {
    if (typeof fg === 'function') body = fg('accent', text)
  } catch {
    body = text
  }
  return SGR_UNDERLINE + body + SGR_NO_UNDERLINE
}

export class SuperPiEditor extends CustomEditor {
  /** 选区锚点；null = 没有选区。焦点就是编辑器光标。 */
  private selAnchor: Point | null = null
  /** 正在异步读剪贴板，避免连按 Ctrl+V 叠多次 PowerShell。 */
  private pasteInFlight = false
  /** 上一次读取的开始时间：过久未结束就认为已失效，不阻塞后续粘贴。 */
  private pasteStartedAt = 0
  /** settings 菜单是否展开。 */
  private menuOpen = false
  /** 鼠标悬停的入口 id（与模块级 hoverState 同步）。 */
  private hovered: string | null = null
  /** 下边框在最近一次渲染里的行号；之下都是我们自己画的框外区域。 */
  private lastBoxBottom = -1
  /** 本次渲染里可点的矩形（组件坐标，y 是本组件输出行号）。 */
  private hits: Array<{ id: string; kind: 'action' | 'command'; command?: string; x: number; y: number; width: number }> = []
  /** 由扩展入口注入（notify 等），测试里可不给。 */
  private hooks: {
    notify?: (text: string, level?: string) => void
    /** 与模型名一致的「暗色」包装（pi 的 ctx.ui.theme.fg('dim', …)）。 */
    dim?: (text: string) => string
    /** 任意主题色的包装（悬停高亮用 accent）；拿不到就原样返回。 */
    fg?: (token: string, text: string) => string
  }

  constructor(tui: any, theme: any, keybindings: any, options: any = {}) {
    super(tui, theme, keybindings, options)
    this.hooks = options?.hooks ?? {}
    /**
     * 把渲染通道交给动画定时器（0.14.2）。
     *
     * 这个编辑器是扩展唯一能拿到 `tui.requestRender` 的地方（官方设置入口
     * `ctx.ui.setEditorComponent()` 交给我们的实例），所以在这里绑定。
     * 定时器自己按 FRAME_INTERVAL_MS 敲它，pi 的 16ms 节流会合并 ——
     * 这样即使 pi 在等一条 5 分钟的 bash、期间没有任何输入与 token，
     * 图标也照样在转（此前正是因为"没人重绘"而停在最后一帧）。
     */
    bindFrameTarget(tui)
  }

  /* ------------------------------------------------------------ 输入入口 */

  handleInput(data: string): void {
    if (typeof data !== 'string' || data === '') {
      super.handleInput(data)
      return
    }
    try {
      if (this.handleSelectionKeys(data)) return
    } catch {
      // 选区/菜单逻辑出任何意外都退回 pi 的原始处理，绝不把输入吞掉。
      this.selAnchor = null
    }
    super.handleInput(data)
  }

  /** 返回 true 表示本函数已消费该按键。 */
  private handleSelectionKeys(data: string): boolean {
    // Esc：先关菜单，再清选区，其余交给 pi（中断/取消补全）。
    if (data === ESC) {
      if (this.menuOpen) {
        this.menuOpen = false
        this.tui?.requestRender?.()
        return true
      }
      if (this.hasSelection()) this.selAnchor = null
      return false
    }

    // Ctrl+V：文件路径优先。命中就自己插，否则原样交回 pi（图片/文本粘贴）。
    if (this.isPasteKey(data)) {
      if (this.pasteInFlight) return true
      void this.tryPasteFilePaths()
      return true
    }

    // 括号内粘贴：先按选区语义删掉选中内容，再交给 pi 插入。
    if (data.includes('\x1b[200~')) {
      if (this.hasSelection()) this.deleteSelection()
      return false
    }

    // 自动补全菜单打开时，方向键 / Tab / Enter 属于菜单，一律放行。
    if (typeof this.isShowingAutocomplete === 'function' && this.isShowingAutocomplete()) return false

    // Ctrl+A 全选（覆盖 pi 的 cursorLineStart；Home 单独保留行首语义）。
    if (data === CTRL_A) {
      this.selectAll()
      return true
    }

    if (data === CTRL_C) return this.copyOrCut(false)
    if (data === CTRL_X) return this.copyOrCut(true)

    const hasSel = this.hasSelection()

    if (hasSel && (data === '\x7f' || data === '\x08' || data === '\x1b[3~' || matchesKey(data, 'shift+delete'))) {
      this.deleteSelection()
      this.selAnchor = null
      return true
    }

    const shiftMove = this.shiftMovement(data)
    if (shiftMove) {
      if (!hasSel) this.selAnchor = { line: this.state.cursorLine, col: this.state.cursorCol }
      shiftMove()
      return true
    }

    // 普通移动键会打断选区（同 Windows 输入框）：清掉后照常交给 pi。
    if (hasSel && this.isNavigationKey(data)) this.selAnchor = null

    // 可打印字符：先删选区再插入，否则新字会插在选区前面。
    if (hasSel && isPrintable(data)) {
      this.deleteSelection()
      this.selAnchor = null
      this.insertTextAtCursor(data)
      return true
    }

    return false
  }

  private isPasteKey(data: string): boolean {
    try {
      if (this.keybindings?.matches?.(data, 'app.clipboard.pasteImage')) return true
    } catch {
      /* 自定义键位读不到就退回默认 */
    }
    return matchesKey(data, 'ctrl+v') || matchesKey(data, 'alt+v')
  }

  private shiftMovement(data: string): (() => void) | null {
    const map: Array<[string, () => void]> = [
      ['shift+left', () => this.moveCursor(0, -1)],
      ['shift+right', () => this.moveCursor(0, 1)],
      ['shift+up', () => this.moveCursor(-1, 0)],
      ['shift+down', () => this.moveCursor(1, 0)],
      ['shift+home', () => this.moveToLineStart()],
      ['shift+end', () => this.moveToLineEnd()],
    ]
    for (const [name, run] of map) if (matchesKey(data, name)) return run
    return null
  }

  private isNavigationKey(data: string): boolean {
    const names = [
      'left',
      'right',
      'up',
      'down',
      'home',
      'end',
      'alt+left',
      'alt+right',
      'ctrl+left',
      'ctrl+right',
      'pageup',
      'pagedown',
    ]
    return names.some(name => matchesKey(data, name))
  }

  /* -------------------------------------------------------------- 复制剪切 */

  private copyOrCut(cut: boolean): boolean {
    const hasSel = this.hasSelection()
    const full = this.getExpandedTextSync()
    // 空编辑器：不拦，让 pi 的 app.clear 照旧工作（两次 Ctrl+C 退出）。
    if (!hasSel && full === '') return false
    const text = hasSel ? this.selectionText() : full
    if (text === '') return false

    void writeClipboard(text)

    if (cut) {
      if (hasSel) {
        this.deleteSelection()
      } else {
        this.pushUndoSnapshot()
        this.setText('')
      }
      this.selAnchor = null
    }
    // 复制后保留选区与内容：用户可以接着按 Backspace / Delete 删掉它。
    this.tui?.requestRender?.()
    return true
  }

  private getExpandedTextSync(): string {
    try {
      return this.getExpandedText?.() ?? this.getText()
    } catch {
      return ''
    }
  }

  /* ---------------------------------------------------------------- 选区 */

  private focus(): Point {
    return { line: this.state.cursorLine, col: this.state.cursorCol }
  }

  private anchor(): Point | null {
    const anchor = this.selAnchor
    if (!anchor) return null
    const lines = this.state.lines ?? []
    if (anchor.line < 0 || anchor.line >= lines.length) return null
    if (anchor.col < 0 || anchor.col > (lines[anchor.line] ?? '').length) return null
    return anchor
  }

  private hasSelection(): boolean {
    const anchor = this.anchor()
    if (!anchor) return false
    const focus = this.focus()
    return anchor.line !== focus.line || anchor.col !== focus.col
  }

  /** 归一化选区：start 在前。行列都是 state.lines 里的 UTF-16 索引。 */
  selectionRange(): Range {
    const anchor = this.anchor()
    const focus = this.focus()
    if (!anchor) return { start: focus, end: focus }
    const anchorFirst = anchor.line < focus.line || (anchor.line === focus.line && anchor.col <= focus.col)
    return anchorFirst ? { start: anchor, end: focus } : { start: focus, end: anchor }
  }

  selectionText(): string {
    const { start, end } = this.selectionRange()
    const lines = this.state.lines ?? []
    if (start.line === end.line) return (lines[start.line] ?? '').slice(start.col, end.col)
    const parts = [(lines[start.line] ?? '').slice(start.col)]
    for (let i = start.line + 1; i < end.line; i += 1) parts.push(lines[i] ?? '')
    parts.push((lines[end.line] ?? '').slice(0, end.col))
    return parts.join('\n')
  }

  private selectAll(): void {
    const lines = this.state.lines ?? []
    if (lines.length === 0) return
    const lastLine = lines.length - 1
    const lastCol = (lines[lastLine] ?? '').length
    if (lastLine === 0 && lastCol === 0) return
    this.selAnchor = { line: 0, col: 0 }
    this.state.cursorLine = lastLine
    this.setCursorCol(lastCol)
    this.lastAction = null
    this.tui?.requestRender?.()
  }

  /** 直接改 state.lines，不走 setText —— 避免把粘贴标记（[paste #1 …]）整份冲掉。 */
  private deleteSelection(): void {
    const { start, end } = this.selectionRange()
    const lines = this.state.lines ?? []
    if (lines.length === 0) return
    const head = (lines[start.line] ?? '').slice(0, start.col)
    const tail = (lines[end.line] ?? '').slice(end.col)
    this.cancelAutocomplete()
    this.pushUndoSnapshot()
    this.state.lines = [...lines.slice(0, start.line), head + tail, ...lines.slice(end.line + 1)]
    this.state.cursorLine = start.line
    this.setCursorCol(start.col)
    this.lastAction = null
    this.exitHistoryBrowsing?.()
    this.invalidate?.()
    this.onChange?.(this.getText())
  }

  /* -------------------------------------------------------------- 渲染 */

  render(width: number): string[] {
    // 两侧框线各占 1 列，内容按 width-2 排；排版宽度变了光标位置也得跟着算，
    // 所以整份交给 super.render(inner)。
    const inner = Math.max(8, width - 2)
    let rows: string[]
    try {
      rows = super.render(inner)
    } catch {
      return super.render(width)
    }
    const visibleCount = Number.isFinite((this as any).renderedVisibleLineCount)
      ? (this as any).renderedVisibleLineCount
      : Math.max(0, rows.length - 2)
    const decorated = this.decorate(rows, inner, visibleCount)
    // 套框失败时必须**仍然给出一个可用的框**（哪怕是素的），否则用户看到的
    // 就是「改了没变化」——0.9.4 的 dim 取色抛错走的正是这条兜底。
    try {
      return this.compose(decorated, inner, visibleCount)
    } catch {
      try {
        return this.plainFrame(decorated, inner, visibleCount)
      } catch {
        return decorated
      }
    }
  }

  /** 最退化但可用的框：只有框线与 Working 图标，不依赖任何主题取色。 */
  private plainFrame(rows: string[], inner: number, visibleCount: number): string[] {
    const line = '─'.repeat(inner)
    const out = ['┌' + line + '┐']
    for (const row of rows.slice(1, 1 + visibleCount)) out.push('│' + padToWidth(row, inner) + '│')
    out.push('└' + line + '┘')
    return out
  }

  /** 路径底色 + 选区反色（都画在 pi 自己的行上，之后才套框）。 */
  private decorate(rows: string[], width: number, visibleCount: number): string[] {
    const out = rows.slice()
    try {
      paintPathChips(this, out, width, visibleCount)
    } catch {
      /* 装饰失败不能影响输入 */
    }
    try {
      if (this.anchor()) paintSelection(this, out, width)
    } catch {
      /* 同上 */
    }
    return out
  }

  /**
   * 套上四边框（**直角**），Working 状态回到 pi 原来的位置（上边框内侧左侧），
   * settings / home 放到**框外**右下角、模型信息上方。
   *
   * pi 的 Editor.render 布局是 [上边框, …可见内容, 下边框, …自动补全]，
   * 这里把上/下边框换成自己的闭合框，自动补全也收进框内。
   */
  private compose(rows: string[], inner: number, visibleCount: number): string[] {
    this.hits = []
    const frame = (text: string) => sgrFg(FRAME_RGB) + text + SGR_RESET
    const bar = frame('│')
    const content = rows.slice(1, 1 + visibleCount)
    const rest = rows.slice(2 + visibleCount)
    // pi 的上/下边框会带滚动提示（↑ N more / ↓ N more）。有内容时保留它，
    // 否则换成一条素色横线 —— 不能为了套框把「还有几行被折在里面」吃掉。
    const bottom = borderBody(rows[1 + visibleCount], inner)
    const out: string[] = [frame('┌' + this.topBorder(rows[0], inner) + '┐')]
    const push = (body: string): void => {
      out.push(bar + padToWidth(body, inner) + bar)
    }

    for (const row of content) push(row)
    for (const row of rest) push(row)
    out.push(frame('└' + bottom + '┘'))
    this.lastBoxBottom = out.length - 1

    // ── 以下是框外（输入框下方）──────────────────────────────────────────
    //
    // settings / home 与项目行**不再画在这里**：0.9.9 起它们跟 cwd 同行，
    // 由 `SuperPiFooter` 在 footer 的坐标系里画（见文件末尾）。这里只留
    // settings 展开出来的子菜单 —— 它紧贴框底，视觉上属于输入框。
    if (this.menuOpen) {
      for (const item of SETTINGS_COMMANDS) {
        const y = out.length
        out.push(padToWidth(this.dim('  ' + item.label), inner + 2))
        this.hits.push({ id: item.label, kind: 'command', command: item.command, x: 0, y, width: inner + 2 })
      }
    }
    return out
  }

  /** footer 那边点了 settings：开关子菜单（settings/home 的绘制归 footer）。 */
  toggleMenu(): void {
    this.menuOpen = !this.menuOpen
    // CustomEditor may be wrapped in a cached TUI container. Changing only the
    // flag and requesting a frame can leave the previous child height cached,
    // so invalidate before asking the terminal to render.
    this.invalidate?.()
    this.tui?.requestRender?.()
  }

  /** settings 菜单是否展开（footer 画 settings 时要用它决定高亮）。 */
  isMenuOpen(): boolean {
    return this.menuOpen
  }

  /** 上边框内侧：左侧 Working 状态（按状态上色），右侧补框线与滚动提示。 */
  private topBorder(raw: string | undefined, inner: number): string {
    const phase: RunPhase = runState.phase
    const color = STATUS_RGB[phase] ?? STATUS_RGB.idle
    // 0.14.2：图标本身已是双宽（月相 emoji 实测 visibleWidth=2），自带呼吸区，
    // 不再额外加两侧空格 —— 那会把它推得太远、看着像孤立符号。
    const icon = sgrFg(color) + statusIcon(phase) + SGR_RESET
    // 0.14.1：主文案带上「当前工具 + 它自设的上限」，让合法长等待可见。
    // 实测一轮累计 2028s、单命令 371~494s，界面只涨秒数时用户会判定成卡死。
    const full = icon + sgrFg(color) + ' ' + workingLabel() + SGR_RESET
    // 退化档：只留 Working 与累计时长（去掉工具段）—— 工具名比累计值次要，
    // 但"正在跑什么"仍要尽量保留，所以它排在图标档之前。
    const noTool = icon + sgrFg(color) + ' ' + workingLabel(Date.now(), false) + SGR_RESET
    const compact = icon
    // 窄面板上依次退让：完整三段 → 去掉工具段 → 只剩图标 → 只画横线。
    let chosen = ''
    if (widthOfVisible(full) + 5 <= inner) chosen = full
    else if (widthOfVisible(noTool) + 5 <= inner) chosen = noTool
    else if (widthOfVisible(compact) + 5 <= inner) chosen = compact
    if (chosen === '') return borderBody(raw, inner)
    // 行宽账目：'─ '（2 列）+ chosen（w 列）+ ' '（1 列）+ rest = inner。
    // w 由 visibleWidth 算（不是字符串长度）：图标换成双宽 emoji 后这段账目自动跟着变。
    const rest = Math.max(0, inner - 2 - widthOfVisible(chosen) - 1)
    return '─ ' + chosen + ' ' + borderBody(raw, rest)
  }

  /**
   * 取「与模型名一致」的颜色。
   *
   * pi 通过 `getEditorTheme()` 交给编辑器的 theme **只有 borderColor 与 selectList**，
   * 没有 fg —— 直接 this.theme.fg(...) 会抛，而 render() 的兜底会退化成无框原始行
   * （0.9.4 上线后的实测现象就是「改了没变化」）。所以这里走 pi-tui 的模块级主题。
   */
  private dim(text: string): string {
    const themeObj: any = this.theme as any
    if (themeObj && typeof themeObj.fg === 'function') {
      try {
        return themeObj.fg('dim', text)
      } catch {
        /* 落到注入的 dimFn */
      }
    }
    const injected = (this.hooks as any)?.dim
    if (typeof injected === 'function') {
      try {
        const value = injected(text)
        if (typeof value === 'string') return value
      } catch {
        /* 无色 */
      }
    }
    return text
  }

  /**
   * 取任意主题色（拿不到就原样返回）。
   *
   * 次序与 dim() 一致：编辑器拿到的 theme → 注入的 hooks.fg（扩展入口用
   * `ctx.ui.theme.fg` 提供）→ 纯文本。**任何情况下都能返回字符串**，
   * 因为悬停装饰不允许把整行搞没（0.9.8 的教训）。
   */
  private fg(token: string, text: string): string {
    const themeObj: any = this.theme as any
    if (themeObj && typeof themeObj.fg === 'function') {
      try {
        return themeObj.fg(token, text)
      } catch {
        /* 落到注入的取色 */
      }
    }
    const injected = (this.hooks as any)?.fg
    if (typeof injected === 'function') {
      try {
        const out = injected(token, text)
        if (typeof out === 'string') return out
      } catch {
        /* 无色 */
      }
    }
    return text
  }

  handleMouse(event: any): any {
    if (!event) return super.handleMouse(event)
    const isPress = event.type === 'press' || event.type === 'click'
    const isMove = event.type === 'move' || event.type === 'drag'

    // 框外（下边框之下）是我们自己的区域：只有 settings / home / 菜单可点。
    if (typeof event.y === 'number' && event.y > this.lastBoxBottom) {
      const hit = this.hits.find(
        h => h.y === event.y && event.x >= h.x && event.x < h.x + Math.max(1, h.width),
      )
      if (isMove) {
        // 悬停：移入变亮、移出复原。这是「这里能点」的唯一视觉提示。
        if (this.setHover(hit ? hit.id : null)) return { handled: true, render: true }
        return { handled: true }
      }
      if (hit && isPress) {
        this.activateHit(hit)
        return { handled: true }
      }
      if (isPress && this.menuOpen) {
        this.menuOpen = false
        this.tui?.requestRender?.()
      }
      // 框外的空白不交给 pi（否则会按错误的行号定位光标）。
      return { handled: true }
    }

    // 离开框外区域（移到输入框上）→ 清掉悬停高亮。
    if (isMove && hoverState.id !== null) this.setHover(null)

    if (isPress && this.menuOpen) {
      this.menuOpen = false
      this.tui?.requestRender?.()
    }
    // 鼠标点击（含拖选后的合成 click）会重置光标：先丢掉键盘选区，避免两套选区打架。
    if (isPress) this.selAnchor = null
    // x 减 1 跳过左侧框线，回到 super.render 的坐标系。
    const x = typeof event.x === 'number' ? Math.max(0, event.x - 1) : event.x
    return super.handleMouse(typeof event.x === 'number' ? { ...event, x } : event)
  }

  /** 更新悬停态；真的变了才要求重画（移动事件很密，不能每次都重排）。 */
  private setHover(id: string | null): boolean {
    if (this.hovered === id && hoverState.id === id) return false
    this.hovered = id
    hoverState.id = id
    this.tui?.requestRender?.()
    return true
  }

  private activateHit(hit: { id: string; kind: 'action' | 'command'; command?: string }): void {
    if (hit.kind === 'action' && hit.id === 'settings') {
      this.menuOpen = !this.menuOpen
      this.tui?.requestRender?.()
      return
    }
    if (hit.kind === 'action' && hit.id === 'home') {
      this.runCommand(HOME_COMMAND)
      return
    }
    if (hit.kind === 'command' && hit.command) {
      this.menuOpen = false
      this.runCommand(hit.command)
    }
  }

  /**
   * 跑一条 pi 的斜杠命令：交回 pi 自己的 onSubmit（等同用户敲完回车）。
   * 运行中不打断 —— 由用户决定先 Esc。
   */
  private runCommand(command: string): void {
    if (runState.phase === 'running') {
      this.hooks.notify?.('运行中无法切换，先按 Esc 中断', 'warning')
      return
    }
    this.menuOpen = false
    this.invalidate?.()
    const submit = (this as any).onSubmit
    if (typeof submit === 'function') {
      void submit(command)
      this.tui?.requestRender?.()
      return
    }
    // 兜底（例如 onSubmit 还没接上）：把命令塞进输入框，用户自己回车。
    this.insertTextAtCursor(command)
  }

  /* ---------------------------------------------------------- Ctrl+V 文件 */

  /**
   * 剪贴板里有**文件**（资源管理器复制、Snipaste 之类）时插入绝对路径。
   *
   * 顺序刻意如此，为了让最常见的两种粘贴零额外开销：
   *   有文本 → 直接交回 pi（pi 自己插文本）
   *   有图片 → 直接交回 pi（pi 写 %TEMP%\pi-clipboard-*.png 并插路径）
   *   两者都没有 → 才去问 Windows 的文件拖放列表（PowerShell，约 200ms，异步）
   */
  private async tryPasteFilePaths(): Promise<void> {
    // 防重入，但不能被一次卡住的读取永久堵死：超过 STALE_MS 就当作上一次已失效。
    if (this.pasteInFlight && Date.now() - this.pasteStartedAt < PASTE_STALE_MS) return
    this.pasteInFlight = true
    this.pasteStartedAt = Date.now()
    let inserted = false
    try {
      const content = await resolveClipboardPaste()
      if (content.files.length > 0) {
        if (content.files.some(file => /\p{Cc}/u.test(file))) return
        this.insertFilePaths(content.files)
        inserted = true
      } else if (content.imagePath) {
        this.insertTextAtCursor(content.imagePath)
        inserted = true
      } else if (content.text) {
        this.insertTextAtCursor(content.text)
        inserted = true
      }
    } catch {
      inserted = false
    } finally {
      this.pasteInFlight = false
      if (inserted) this.tui?.requestRender?.()
    }
    // 什么都没插进去 → 完全交回 pi（行为与不打这个扩展时一致）。
    if (!inserted) this.onPasteImage?.()
  }

  /** 与 pi 的 handleClipboardPaste 同一套插入语义（bash 模式用引号+空格，否则每行一条）。 */
  private insertFilePaths(files: string[]): void {
    const bashMode = this.getText().trimStart().startsWith('!')
    const payload = bashMode ? files.map(quoteIfNeeded).join(' ') : files.join('\n')
    const cursor = this.getCursor?.()
    const line = cursor ? (this.getText().split('\n')[cursor.line] ?? '') : ''
    const before = cursor && cursor.col > 0 ? line[cursor.col - 1] : ''
    const after = cursor ? line[cursor.col] : ''
    const leading = before && !/\s/.test(before) ? ' ' : ''
    const trailing = after && !/\s/.test(after) ? ' ' : ''
    this.insertTextAtCursor(`${leading}${payload}${trailing}`)
    this.tui?.requestRender?.()
  }
}

/* ------------------------------------------------------------------ 状态行 */

/**
 * 旋转帧序列（0.14.2）。
 *
 * 用户三条要求：「图标稍微大一点」「动效流畅一点」「发送消息之后不能停下来静止」。
 *
 * ---------------------------------------------------------------------------
 * 为什么是月相（🌑🌒🌓🌔🌕🌖🌗🌘），而不是原来的 ◐◓◑◒
 *
 * | 维度 | 旧方案 ◐◓◑◒ | 新方案 月相 8 帧 |
 * | --- | --- | --- |
 * | 视觉大小 | 1 列宽（`visibleWidth` 实测 1） | **2 列宽（天然双倍）** |
 * | 帧数 | 4 | **8**（每帧位移更小 → 更流畅） |
 * | 帧间差异 | 只有一条直径翻向，几乎看不出在动 | 明暗面积连续推移，像一个真转盘 |
 * | 循环 | 4 帧循环，接缝明显 | 月相盈亏天生是闭环（🌘→🌑 无缝） |
 *
 * 「更大」这件事在终端里没有字号可调，唯一可靠的手段就是**换双宽字符**。
 * 我核对过：8 个码位 `visibleWidth` 全部为 2、且都不含 VS16 变体选择符
 * （含 VS16 的 emoji 在不同终端宽度会跳变，会把框线挤歪）。
 *
 * 为什么不用 1/8 圆几何符号：Unicode 里只有四分之一圆（`◴◵◶◷` / `◔◕◖◗`），
 * 没有 1/8 圆的码位 —— 硬凑 8 帧只能重复帧，那是"看起来更卡"而不是"更流畅"。
 * 月相是唯一既有 8 个真实不同的帧、又是双宽、又天生闭环的一组。
 */
export const RUN_FRAMES = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'] as const

/**
 * 动画帧间隔（毫秒）。
 *
 * 取 120ms：8 帧 × 120ms = 960ms 转一圈，接近 1 秒/圈的舒适节奏。
 * 下限有讲究 —— 低于 ~80ms 时终端渲染会与 pi 的 16ms 节流叠加出抖动感，
 * 而且每个 tick 都触发一次全屏 diff，纯属浪费 CPU。
 */
export const FRAME_INTERVAL_MS = 120

/**
 * 工具静默多久之后开始心跳（毫秒）。
 *
 * 取 20 秒：短命令（ls/grep）本来就该秒回，20 秒足够区分"正常慢"与"值得解释"；
 * 又远小于任何一次合法长等待（实测 p90 就 11 秒、长任务 300~500 秒），
 * 所以真正让人焦虑的那段时间一定被覆盖。
 *
 * 为什么是"静默"而不是"总时长"：bash 每 100ms 就发 tool_execution_update
 * （`core/tools/bash.js:15`），有输出时用户能在工具行里看到实时内容 ——
 * 那时再叠一句"仍在运行"纯属噪音。只有**长时间没有任何新输出**才是"看起来卡住"的来源。
 */
export const HEARTBEAT_AFTER_MS = 20_000

/**
 * 取当前帧。
 *
 * 用「已运行时长」而不是 `Date.now()` 取模：定时器启动晚于 runState.startedAt 时，
 * 用绝对时间会让第一帧随机落在某一格（看起来像"跳了一下"）；用相对时间则恒定从
 * 第 0 帧开始转，每轮都是同一个起点。
 */
export function statusIcon(phase: RunPhase, at = Date.now()): string {
  switch (phase) {
    case 'running': {
      const startedAt = runState.startedAt > 0 ? runState.startedAt : at
      const index = Math.floor(Math.max(0, at - startedAt) / FRAME_INTERVAL_MS) % RUN_FRAMES.length
      return RUN_FRAMES[index]
    }
    case 'success':
      return '✔'
    case 'error':
      return '✖'
    default:
      return '○'
  }
}

/* ------------------------------------------------------- 自驱动动画定时器 */

/**
 * 让图标真的转起来 —— 这是「发送消息后动效静止」的根治。
 *
 * ---------------------------------------------------------------------------
 * 病根（0.14.2 实测）
 *
 * `statusIcon()` 是按时间取帧的**纯函数**，但"取帧"只在**有人重绘时**才发生。
 * 而 pi-tui 的 `requestRender()` 是**被动**的（`tui.js:658-669`：它只置一个标志，
 * 等下一次 `scheduleRender` 才真的画）—— 没有输入事件、没有流式 token 到达时，
 * 界面**根本不会重绘**。
 *
 * 于是出现了用户看到的现象：消息发出去之后，模型在跑一条 5 分钟的 bash，
 * 期间既没有键盘输入也没有新 token → pi 不重绘 → 图标**永远停在最后一帧**，
 * 看起来就是"动效停下来了、卡死了"。这与 0.14.1 修的「Waiting 秒数不涨」是同一类病：
 * 信息其实都在，缺的是**驱动的节拍**。
 *
 * ---------------------------------------------------------------------------
 * 为什么定时器必须挂在扩展这边而不是 pi 那边
 *
 * 不改 pi 一行代码是本仓库的硬约束（AGENTS.md）。扩展能拿到的唯一公开入口是
 * `ctx.ui.setEditorComponent()` 给的那个编辑器实例，它的 `this.tui.requestRender()`
 * 就是官方渲染通道。所以由我们按固定节拍敲它 —— pi 的 16ms 节流会自动合并，
 * 我们敲 160ms 一次，实际帧率就是 160ms 一次，不多不少。
 *
 * 生命周期三条铁律：
 *  ① 只在 `running` 时开表（`idle` 不转，省电）；
 *  ② **幂等**：重复 start 不叠加定时器（否则每轮 agent_start 就泄漏一个）；
 *  ③ 退出即停：`agent_settled` / `session_start` / `dispose` 全部走 stop。
 */
let frameTimer: ReturnType<typeof setInterval> | null = null
/** 定时器要敲的目标；`install()` 换编辑器实例时更新它。 */
let frameTarget: { requestRender?: () => void } | null = null

/** 记录当前要驱动重绘的 tui（install 时调用；传 null 表示卸载）。 */
export function bindFrameTarget(tui: { requestRender?: () => void } | null): void {
  frameTarget = tui
}

/** 定时器是否在跑（门禁据此断言生命周期）。 */
export function isAnimating(): boolean {
  return frameTimer !== null
}

/**
 * 开动效。**幂等**：已经在跑就不再起一个。
 * @returns 本次是否真的启动了（门禁据此断言幂等性）
 */
export function startAnimation(): boolean {
  if (frameTimer !== null) return false
  const target = frameTarget
  if (target === null || typeof target.requestRender !== 'function') return false
  frameTimer = setInterval(() => {
    // 目标可能已经被 dispose（窗口关了）——自己停掉，不留悬空定时器。
    if (frameTarget === null) {
      stopAnimation()
      return
    }
    try {
      frameTarget.requestRender?.()
    } catch {
      // 渲染通道出错不该拖垮会话：停表即可，下一轮 agent_start 会重开。
      stopAnimation()
    }
  }, FRAME_INTERVAL_MS)
  // 不 unref：这个定时器本来就该在会话期间活着；pi 退出时 dispose 负责收尾。
  return true
}

/** 停动效。幂等。 */
export function stopAnimation(): void {
  if (frameTimer === null) return
  clearInterval(frameTimer)
  frameTimer = null
}

/** 门禁用：把帧序列按给定时间点采样出来（不依赖真实定时器）。 */
export function sampleFrames(count: number, stepMs = FRAME_INTERVAL_MS, base = 1000000): string[] {
  const out: string[] = []
  // 必须临时把 startedAt 对齐到 base：statusIcon 是按「距 startedAt 的时长」取帧的，
  // 如果 runState.startedAt 还是 0 或别的值，采样会一直落在第 0 帧
  // （第一次写这条门禁时就踩到了：得到 "◴◴◴◴" 而不是 "◴◵◶◷"）。
  const saved = runState.startedAt
  runState.startedAt = base
  try {
    for (let i = 0; i < count; i += 1) out.push(statusIcon('running', base + i * stepMs))
  } finally {
    runState.startedAt = saved
  }
  return out
}


/* ------------------------------------------------------------------ 渲染实现 */

type VisualChunk = {
  rowIndex: number
  paddingX: number
  logicalLine: number
  chunkStart: number
  chunkEnd: number
}

/**
 * 视觉行 ↔ 逻辑字符区间的对应表。
 *
 * pi 的 render() 每一行 = 左边距 + displayText + 右填充 + 右边距，displayText 来自
 * layoutText()；而 buildVisualLineMap() 与 layoutText() 用同一套 word-wrap，
 * 行数一一对应。所以靠它就能把「逻辑行列」翻译成「某一行里的显示列」。
 */
function visualChunks(editor: SuperPiEditor, width: number, visibleCount: number): VisualChunk[] {
  const layoutWidth = (editor as any).lastWidth
  if (!Number.isFinite(layoutWidth) || layoutWidth <= 0) return []
  const paddingX = Math.min((editor as any).paddingX ?? 0, Math.max(0, Math.floor((width - 1) / 2)))
  const visualLines: Array<{ logicalLine: number; startCol: number; length: number }> =
    (editor as any).buildVisualLineMap?.(layoutWidth) ?? []
  if (!Array.isArray(visualLines) || visualLines.length === 0) return []
  const scrollOffset = (editor as any).scrollOffset ?? 0
  const chunks: VisualChunk[] = []
  for (let i = 0; i < visibleCount; i += 1) {
    const visual = visualLines[scrollOffset + i]
    if (!visual) continue
    chunks.push({
      rowIndex: i + 1, // 第 0 行是上边框
      paddingX,
      logicalLine: visual.logicalLine,
      chunkStart: visual.startCol,
      chunkEnd: visual.startCol + visual.length,
    })
  }
  return chunks
}

/** 选区反色。 */
function paintSelection(editor: SuperPiEditor, rendered: string[], width: number): string[] {
  const { start, end } = editor.selectionRange()
  if (start.line === end.line && start.col === end.col) return rendered
  const visibleCount = Number.isFinite((editor as any).renderedVisibleLineCount)
    ? (editor as any).renderedVisibleLineCount
    : Math.max(0, rendered.length - 2)
  const lines: string[] = (editor as any).state?.lines ?? []
  const cursorLine = (editor as any).state?.cursorLine ?? 0
  const cursorCol = (editor as any).state?.cursorCol ?? 0
  for (const chunk of visualChunks(editor, width, visibleCount)) {
    const logical = chunk.logicalLine
    if (logical < start.line || logical > end.line) continue
    const rowFrom = logical === start.line ? start.col : 0
    const rowTo = logical === end.line ? end.col : (lines[logical] ?? '').length
    const from = Math.max(rowFrom, chunk.chunkStart)
    const to = Math.min(rowTo, chunk.chunkEnd)
    if (to <= from) continue
    const text = (lines[logical] ?? '').slice(chunk.chunkStart, chunk.chunkEnd)
    const relFrom = Math.max(0, Math.min(text.length, from - chunk.chunkStart))
    const relTo = Math.max(relFrom, Math.min(text.length, to - chunk.chunkStart))
    const colFrom = widthOf(text.slice(0, relFrom))
    const colTo = colFrom + widthOf(text.slice(relFrom, relTo))
    // 光标所在格跳过：反色叠反色会把光标变隐形。
    const cursorHere = logical === cursorLine && cursorCol >= from && cursorCol < to
    const skip = cursorHere ? chunk.paddingX + widthOf(text.slice(0, Math.max(0, cursorCol - chunk.chunkStart))) : -1
    rendered[chunk.rowIndex] = paintColumns(rendered[chunk.rowIndex], chunk.paddingX + colFrom, chunk.paddingX + colTo, skip)
  }
  return rendered
}

/**
 * 粘贴进来的绝对路径加浅灰底色。
 * 终端单元格没有真正的圆角 —— 这里在 token 左右各吃一格底色当「圆角」，视觉上是个药丸。
 */
export function paintPathChips(editor: SuperPiEditor, rendered: string[], width: number, visibleCount: number): string[] {
  const lines: string[] = (editor as any).state?.lines ?? []
  if (lines.length === 0) return rendered
  const tokensByLine = new Map<number, Array<{ from: number; to: number }>>()
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (!line.includes('\\') && !line.includes('/')) continue
    const found: Array<{ from: number; to: number; padLeft: boolean; padRight: boolean }> = []
    for (const match of line.matchAll(PATH_TOKEN_RE)) {
      const text = trimPathToken(match[0])
      if (!isLikelyPath(text)) continue
      // 药丸左右各吃一格当「圆角」，但不能盖住相邻的普通文字：
      // 只有那一格确实是空白时才吃掉。
      const before = match.index > 0 ? line[match.index - 1] : ''
      const afterIndex = match.index + text.length
      const after = afterIndex < line.length ? line[afterIndex] : ''
      found.push({
        from: match.index,
        to: afterIndex,
        padLeft: before === '' || /\s/.test(before),
        padRight: after === '' || /\s/.test(after),
      })
    }
    if (found.length > 0) tokensByLine.set(i, found)
  }
  if (tokensByLine.size === 0) return rendered

  for (const chunk of visualChunks(editor, width, visibleCount)) {
    const tokens = tokensByLine.get(chunk.logicalLine)
    if (!tokens) continue
    const text = (lines[chunk.logicalLine] ?? '').slice(chunk.chunkStart, chunk.chunkEnd)
    for (const token of tokens) {
      const from = Math.max(token.from, chunk.chunkStart)
      const to = Math.min(token.to, chunk.chunkEnd)
      if (to <= from) continue
      const relFrom = from - chunk.chunkStart
      const relTo = to - chunk.chunkStart
      const cellFrom = widthOf(text.slice(0, relFrom))
      const cellTo = widthOf(text.slice(0, relTo))
      const padLeft = token.padLeft && from === token.from
      const padRight = token.padRight && to === token.to
      const colFrom = Math.max(0, padLeft ? cellFrom - 1 : cellFrom)
      const colTo = Math.min(widthOf(text), padRight ? cellTo + 1 : cellTo)
      if (colTo <= colFrom) continue
      rendered[chunk.rowIndex] = paintBackground(
        rendered[chunk.rowIndex],
        chunk.paddingX + colFrom,
        chunk.paddingX + colTo,
      )
    }
  }
  return rendered
}

/**
 * 绝对路径（Windows 盘符 / UNC / POSIX），宁可少认不要误认。
 *
 * 候选 token 允许非空白字符连续（路径里可能有中文目录名），但这会让
 * 「D:\a.png 然后把这张图改成深色」整段连成一个 token —— 中英文之间没有空白时
 * 底色会一直铺到后面的普通文字上（用户实测的溢出）。所以再由
 * `trimPathToken()` 在**最后一个已知扩展名**处截断。
 */
export const PATH_TOKEN_RE = /(?:[A-Za-z]:[\\/]|\\\\|\/)[^\s"'`<>|]*/g

/** 认得出来的文件扩展名（宁可少认：只有这些才拿来当路径边界）。 */
export const PATH_EXT_RE =
  /\.(?:png|jpe?g|gif|webp|bmp|svg|ico|pdf|txt|md|json|ya?ml|toml|ini|log|csv|tsv|xlsx?|docx?|pptx?|zip|rar|7z|gz|tar|mp[34]|wav|mov|avi|webm|ts|tsx|jsx?|mjs|cjs|py|rb|go|rs|java|kt|c|h|cpp|cs|php|sh|ps1|bat|cmd|sql|html?|css|scss|vue|ipynb|exe|dll)/gi

/**
 * 把候选 token 裁到最后一个已知扩展名结尾。
 * 例如 `D:\我的项目\a.png然后把图改深色` → `D:\我的项目\a.png`。
 * 没有任何可识别扩展名时原样返回（纯目录路径没法靠扩展名判断边界）。
 */
export function trimPathToken(token: string): string {
  if (typeof token !== 'string' || token === '') return token
  let lastEnd = -1
  PATH_EXT_RE.lastIndex = 0
  for (const match of token.matchAll(PATH_EXT_RE)) {
    lastEnd = (match.index ?? 0) + match[0].length
  }
  if (lastEnd <= 0 || lastEnd >= token.length) return token
  return token.slice(0, lastEnd)
}

export function isLikelyPath(text: string): boolean {
  if (typeof text !== 'string' || text.length < 4) return false
  if (/^[a-z]+:\/\//i.test(text)) return false // URL 不是路径
  if (text.startsWith('//') && !text.startsWith('///')) {
    // 只认 UNC（\\server\share 形式在这里已被上面的分支吃掉），其余当协议相对 URL
    return false
  }
  if (text.startsWith('\\\\')) return /^\\\\[^\\\s]+\\[^\\\s]+/.test(text)
  if (/^[A-Za-z]:[\\/]/.test(text)) return /[\\/]/.test(text.slice(3))
  if (text.startsWith('/')) {
    // 至少两段才算路径：/settings 这类斜杠命令、/tmp 这类单段歧义词都不涂底色。
    if (/^\/(?:[\w.@+-]+\/)+[\w.@+-]+$/.test(text)) return true
    return false
  }
  return false
}

/** 按可见列给 ANSI 字符串加 SGR 区间；跳过已有 ANSI 序列，`skipColumn` 那一列不涂。 */
export function paintColumns(
  line: string,
  startCol: number,
  endCol: number,
  skipColumn = -1,
  open = SEL_OPEN,
  close = SEL_CLOSE,
): string {
  return paintRange(line, startCol, endCol, skipColumn, open, close)
}

/** 同上，但涂的是浅灰底色（路径药丸）。 */
export function paintBackground(line: string, startCol: number, endCol: number): string {
  return paintRange(line, startCol, endCol, -1, sgrBg(PATH_CHIP_RGB), '\x1b[49m')
}

function paintRange(line: string, startCol: number, endCol: number, skipColumn: number, open: string, close: string): string {
  if (typeof line !== 'string' || endCol <= startCol) return line
  let out = ''
  let visible = 0
  let isOpen = false
  let i = 0
  while (i < line.length) {
    if (line[i] === '\x1b') {
      const stop = ansiEnd(line, i)
      out += line.slice(i, stop)
      i = stop
      continue
    }
    const cp = line.codePointAt(i) ?? 32
    const ch = String.fromCodePoint(cp)
    const w = charWidth(cp)
    const target = visible >= startCol && visible < endCol && visible !== skipColumn
    if (target && !isOpen) {
      out += open
      isOpen = true
    } else if (!target && isOpen) {
      out += close
      isOpen = false
    }
    out += ch
    visible += w
    i += ch.length
  }
  if (isOpen) out += close
  return out
}

function ansiEnd(line: string, start: number): number {
  const next = line[start + 1]
  if (next === '[') {
    let i = start + 2
    while (i < line.length) {
      const code = line.charCodeAt(i)
      if (code >= 0x40 && code <= 0x7e) return i + 1
      i += 1
    }
    return line.length
  }
  if (next === ']') {
    let i = start + 2
    while (i < line.length) {
      if (line[i] === '\x07') return i + 1
      if (line[i] === '\x1b' && line[i + 1] === '\\') return i + 2
      i += 1
    }
    return line.length
  }
  // APC（如 pi 的光标标记 `\x1b_pi:c\x07`）与 OSC 同样以 BEL / ST 结束。
  // 不按 APC 处理时只跳 2 个字符，剩下的载荷会被当可见字算，列号整段错位。
  if (next === '_' || next === 'P' || next === '^') {
    let i = start + 2
    while (i < line.length) {
      if (line[i] === '\x07') return i + 1
      if (line[i] === '\x1b' && line[i + 1] === '\\') return i + 2
      i += 1
    }
    return line.length
  }
  return Math.min(line.length, start + 2)
}

/**
 * 取 pi 边框行里的「中间内容」：普通情况就是一条横线；
 * 有滚动提示（↑ N more / ↓ N more）时原样保留，只剥掉颜色。
 */
export function borderBody(row: string | undefined, inner: number): string {
  if (typeof row !== 'string') return '─'.repeat(inner)
  const plain = row.replace(/\x1b\[[0-9;:?]*[A-Za-z]/g, '').replace(/\x1b[\]_P^][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
  // 纯横线（或空）→ 用自己的素色横线，保证颜色统一
  if (/^[─\s]*$/.test(plain)) return '─'.repeat(inner)
  return padToWidth(plain, inner)
}

/** 补齐到目标显示宽度（不足补空格，超了截断且不带省略号 —— 框线不能错位）。 */
export function padToWidth(line: string, target: number): string {  const width = widthOfVisible(line)
  if (width === target) return line
  if (width > target) {
    try {
      return truncateToWidth(line, target, '')
    } catch {
      return line
    }
  }
  return line + ' '.repeat(target - width)
}

/**
 * 截断到目标显示宽度。
 * `truncateToWidth` 不可用（老版本 pi-tui）时按字符宽度自己退一步 —— 不抛。
 */
export function truncateToWidthQuiet(text: string, target: number): string {
  if (typeof text !== 'string' || target <= 0) return ''
  try {
    return truncateToWidth(text, target, '')
  } catch {
    let out = ''
    let used = 0
    for (const ch of text) {
      const w = charWidth(ch.codePointAt(0) ?? 0)
      if (used + w > target) break
      out += ch
      used += w
    }
    return out
  }
}

/** 去掉 CSI / OSC / APC（pi 的光标标记就是 APC）后的可见文本。 */
export function stripAnsi(text: string): string {
  if (typeof text !== 'string' || text === '') return ''
  let out = ''
  let i = 0
  while (i < text.length) {
    if (text[i] === '\x1b') {
      i = ansiEnd(text, i)
      continue
    }
    out += text[i]
    i += 1
  }
  return out
}

function widthOfVisible(text: string): number {
  try {
    return visibleWidth(text)
  } catch {
    return widthOf(text)
  }
}

function widthOf(text: string): number {
  try {
    return visibleWidth(text)
  } catch {
    let total = 0
    for (const ch of text) total += charWidth(ch.codePointAt(0) ?? 0)
    return total
  }
}

function charWidth(cp: number): number {
  if (cp === 0) return 0
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0
  if (
    cp >= 0x1100 &&
    (cp <= 0x115f ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f9ff) ||
      (cp >= 0x20000 && cp <= 0x3fffd))
  ) {
    return 2
  }
  return 1
}

function isPrintable(data: string): boolean {
  if (data.length === 0 || data.includes('\x1b')) return false
  const cp = data.codePointAt(0)
  if (cp === undefined) return false
  if (cp < 32 || cp === 127) return false
  return data.length === (cp > 0xffff ? 2 : 1)
}

/** pi 的 quoteIfNeeded 同义：含空白或引号才用双引号包起来。 */
function quoteIfNeeded(value: string): string {
  if (value === '') return '""'
  if (/^[A-Za-z0-9_@%+=:,./\\:-]+$/.test(value) && !/[\s"]/u.test(value)) return value
  return `"${value.replaceAll('"', '\\"')}"`
}

/* ---------------------------------------------------------------- 剪贴板 */

/** 原生剪贴板快路径结果（不 spawn 任何进程）。 */
export async function readNativeClipboard(): Promise<{ text: string | null; image: Uint8Array | null }> {
  const out: { text: string | null; image: Uint8Array | null } = { text: null, image: null }
  try {
    const clipboard = await Promise.resolve(getNativeClipboard?.()).catch(() => null)
    if (!clipboard) return out
    if (clipboard.getText) {
      const text = await Promise.resolve(clipboard.getText()).catch(() => null)
      if (typeof text === 'string' && text !== '') out.text = text
    }
    if (clipboard.getImage) {
      const image = await Promise.resolve(clipboard.getImage()).catch(() => null)
      if (image && image.length > 0) out.image = image
    }
  } catch {
    /* 原生通道不可用 → 交给 PowerShell 慢路径 */
  }
  return out
}

/**
 * PowerShell 一次性探针：把剪贴板里的**文件列表 / 文本 / 位图**一起看清。
 *
 * 为什么必须自己读一遍：
 *   - `getFilePaths` 在 Windows 的 pi-tui native 模块里根本没实现（只有 macOS 有）；
 *   - 某些环境下 native 的 getText / getImage 也会失败（实测截图后两者都是 null），
 *     而 PowerShell 的 [Windows.Forms.Clipboard] 能拿到。
 * 输出一律走 base64（控制台代码页会把中文路径/中文文本搞成乱码）；
 * 位图写入临时 PNG 并把路径回填，与 pi 自己 handleClipboardPaste 的做法一致。
 */
export type ClipboardProbe = { files: string[]; text: string; imagePath: string }

/**
 * 「按 Ctrl+V 到底该插入什么」的唯一判定，按优先级：
 *   1. 剪贴板里的**文件**（资源管理器复制 / 截图工具「复制文件」）→ 绝对路径
 *   2. 剪贴板里的**位图**（截图 / 复制图片）→ 落成临时 PNG 的路径（pi 自己的做法）
 *   3. 剪贴板里的**文本** → 原样插入
 *
 * 先把 native 快路径问一遍（不 spawn 进程，文本/位图通常在这一步就命中），
 * 只有它什么都没读到时才启动 PowerShell 探头 —— 那条路要 ~200ms，
 * 不该为最常见的「粘贴文本」付这个代价。
 *
 * 这条判定必须由扩展自己拥有：pi 的 handleClipboardPaste 依赖 pi-tui 的
 * native getFilePaths（Windows 没实现），实测还会连位图一起读不到，
 * 于是「截图后 Ctrl+V」在 Windows 上就是点了没反应。
 */
export async function resolveClipboardPaste(): Promise<ClipboardProbe> {
  const native = await readNativeClipboard()
  if (native.text) return { files: [], text: native.text, imagePath: '' }
  if (native.image) {
    const saved = saveClipboardImage(native.image)
    if (saved) return { files: [], text: '', imagePath: saved }
  }
  return readWindowsClipboard()
}

/** 把原生拿到的位图落成临时 PNG（pi 也是这么做的）；写不进去就返回空串。 */
export function saveClipboardImage(bytes: Uint8Array): string {
  try {
    const file = path.join(os.tmpdir(), `superpi-paste-${process.pid}-${Date.now()}.png`)
    fs.writeFileSync(file, Buffer.from(bytes))
    return file
  } catch {
    return ''
  }
}

export function readWindowsClipboard(): Promise<ClipboardProbe> {
  const empty: ClipboardProbe = { files: [], text: '', imagePath: '' }
  if (process.platform !== 'win32') return Promise.resolve(empty)
  const imagePath = path.join(os.tmpdir(), `superpi-paste-${process.pid}-${Date.now()}.png`)
  const quoted = imagePath.replace(/'/g, "''")
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    "$out = New-Object System.Collections.Specialized.OrderedDictionary",
    "$list = [System.Windows.Forms.Clipboard]::GetFileDropList()",
    "if ($list -and $list.Count -gt 0) { $out['files'] = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]::Join(\"`n\", @($list)))) }",
    'if ([System.Windows.Forms.Clipboard]::ContainsText()) {',
    "  $t = [System.Windows.Forms.Clipboard]::GetText()",
    "  if ($t) { $out['text'] = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($t)) }",
    '}',
    'if ([System.Windows.Forms.Clipboard]::ContainsImage()) {',
    '  $img = [System.Windows.Forms.Clipboard]::GetImage()',
    "  if ($img) { $img.Save('" + quoted + "', [System.Drawing.Imaging.ImageFormat]::Png); $out['image'] = 'ok' }",
    '}',
    "$parts = foreach ($k in $out.Keys) { $k + '=' + $out[$k] }",
    "[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes(($parts -join \"`n\")))",
  ].join('; ')
  return new Promise(resolve => {
    let done = false
    const finish = (value: ClipboardProbe) => {
      if (done) return
      done = true
      resolve(value)
    }
    try {
      const child = execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { timeout: FILE_LIST_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 << 20 },
        (error, stdout) => {
          if (error) return finish(empty)
          finish(parseProbe(stdout, imagePath))
        },
      )
      child.on('error', () => finish(empty))
    } catch {
      finish(empty)
    }
  })
}

/** `files=` / `text=` / `image=` 三段 base64 → 结构化结果。 */
export function parseProbe(stdout: string, imagePath: string): ClipboardProbe {
  const empty: ClipboardProbe = { files: [], text: '', imagePath: '' }
  const raw = typeof stdout === 'string' ? stdout.trim() : ''
  if (raw === '') return empty
  let decoded = ''
  try {
    decoded = Buffer.from(raw, 'base64').toString('utf8')
  } catch {
    return empty
  }
  const out: ClipboardProbe = { files: [], text: '', imagePath: '' }
  for (const line of decoded.split(/\r?\n/)) {
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq)
    const value = line.slice(eq + 1)
    if (key === 'files') {
      const files = Buffer.from(value, 'base64')
        .toString('utf8')
        .split(/\r?\n/)
        .map(item => item.trim())
        .filter(item => item !== '')
      out.files = files
    } else if (key === 'text') {
      try {
        out.text = Buffer.from(value, 'base64').toString('utf8')
      } catch {
        out.text = ''
      }
    } else if (key === 'image' && value === 'ok') {
      out.imagePath = imagePath
    }
  }
  return out
}

/**
 * 读 Windows 的 CF_HDROP（文件拖放）剪贴板。
 *
 * 走 PowerShell 的 [Windows.Forms.Clipboard]::GetFileDropList()，输出 base64
 * （控制台代码页会把中文路径搞成乱码，所以不直接打印路径）。
 * 非 Windows、没有文件、超时、任何异常 → null，与上游 readClipboardFilePaths 的契约一致。
 */
export function readWindowsFileDropList(): Promise<string[] | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$list = [System.Windows.Forms.Clipboard]::GetFileDropList()',
    'if ($list -and $list.Count -gt 0) {',
    '  [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]::Join("`n", @($list))))',
    '}',
  ].join('; ')
  return new Promise(resolve => {
    let done = false
    const finish = (value: string[] | null) => {
      if (done) return
      done = true
      resolve(value)
    }
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: FILE_LIST_TIMEOUT_MS, windowsHide: true, maxBuffer: 1 << 20 },
      (error, stdout) => {
        if (error) return finish(null)
        finish(decodeListing(stdout))
      },
    )
    child.on('error', () => finish(null))
  })
}

/** base64 列表 → 路径数组；空、解码失败、含控制字符 → null。 */
export function decodeListing(stdout: string): string[] | null {
  const raw = typeof stdout === 'string' ? stdout.trim() : ''
  if (raw === '') return null
  let decoded = ''
  try {
    decoded = Buffer.from(raw, 'base64').toString('utf8')
  } catch {
    return null
  }
  const files = decoded
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '')
  if (files.length === 0) return null
  if (files.some(file => /\p{Cc}/u.test(file))) return null
  return files
}

/**
 * 写系统剪贴板：优先 pi-tui 的 native setText；回落 PowerShell 的 Set-Clipboard。
 * 回落时用临时文件传 UTF-8，因为 clip.exe 会按控制台代码页解码管道输入。
 * 全程异步、失败静默 —— 复制是副作用，不该卡住输入框。
 */
export function writeClipboard(text: string): Promise<boolean> {
  return (async () => {
    try {
      const clipboard = await Promise.resolve(getNativeClipboard?.()).catch(() => null)
      if (clipboard?.setText) {
        await Promise.resolve(clipboard.setText(text))
        return true
      }
    } catch {
      /* 继续试回落 */
    }
    return writeViaPowerShell(text)
  })().catch(() => false) as Promise<boolean>
}

function writeViaPowerShell(text: string): Promise<boolean> {
  return new Promise(resolve => {
    if (process.platform !== 'win32') return resolve(false)
    const file = path.join(os.tmpdir(), `superpi-clip-${process.pid}-${Date.now()}.txt`)
    try {
      fs.writeFileSync(file, text, { encoding: 'utf8' })
    } catch {
      return resolve(false)
    }
    const quoted = file.replace(/'/g, "''")
    const script = `Set-Clipboard -Value ([System.IO.File]::ReadAllText('${quoted}', [System.Text.Encoding]::UTF8))`
    const cleanup = () => {
      try {
        fs.unlinkSync(file)
      } catch {
        /* 临时文件可能已被清理 */
      }
    }
    try {
      const child = execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { timeout: 5000, windowsHide: true },
        error => {
          cleanup()
          resolve(!error)
        },
      )
      child.on('error', () => {
        cleanup()
        resolve(false)
      })
    } catch {
      cleanup()
      resolve(false)
    }
  })
}

/* -------------------------------------------------------------------- Footer */

/**
 * 自定义 footer（0.9.9）。
 *
 * 为什么必须由扩展自己画：用户提了三条要求 ——
 *   ① `settings` 与 `home` 跟 `D:\my_projects\SuperPi\SuperPi (master)` **同一行**；
 *   ② 项目名右侧紧贴一个切换图标，点了回到项目选择；
 *   ③ 点 pi footer 上的 `max`（推理档位）能切换选项。
 * 前两条要改 cwd 那一行的排版，第三条要拦「模型名 / 档位」那一段的点击 ——
 * 这一行整份归 pi 的 `FooterComponent` 所有，只能用官方 `ctx.ui.setFooter()` 接管。
 *
 * 形态（两行，与 pi 自己的 footer 同高）：
 *   `D:\proj\SuperPi (master)  ⇄                 settings  home`   ← 本扩展画
 *   `↑12k ↓3.4k 24%/1.0M (auto)      (prov) Model • max`           ← 复用 pi 自己的第 2 行
 *
 * 第二行**不重写**：`FooterComponent` 是 pi 的公开导出，直接实例化它、取 `render()`
 * 的第 2 行 —— 统计口径、上下文百分比、模型名、推理档位全部由 pi 自己算，
 * 本扩展只把 `Model` 与 `• max` 两段找出来当点击区。上游改了统计规则也不会分叉。
 *
 * 点击区一律按**显示列**计算（不按字符数 —— 路径里有中文）：
 *   - 项目名 / 切换图标 → 项目列表（见 `switchProjectVia`）
 *   - `Model` 那一段 → `/model`（pi 自己的模型选择器）
 *   - `• max` 那一段 → `/thinking`（pi 自己的推理档位选择器）
 * 鼠标移入时同样变亮 + 下划线（与输入框右下角的入口同一套反馈）。
 */
export type FooterHitKind = 'project' | 'settings' | 'home' | 'model' | 'thinking' | 'continue'
export type FooterHit = { kind: FooterHitKind; x: number; y: number; width: number }

/**
 * 把 footer 第 2 行切成「左侧统计」与「右侧模型/档位」两段。
 * 判定依据是 pi 自己补的那段 padding：两种内容之间至少 2 个空格。
 */
export function splitFooterLine(plain: string): { stats: string; model: string } {
  const line = typeof plain === 'string' ? plain : ''
  const trimmed = line.replace(/\s+$/, '')
  if (trimmed === '') return { stats: '', model: '' }
  // 从**最后一个**「连续 2+ 空格」处切 —— 不能用 /(?:^|\s{2,})(\S.*\S)$/ 那种正则：
  // 它从最左边开始匹配、`.*` 又会吃掉空格，整行都会被当成模型段（实测踩过）。
  // 模型段内部只有单个空格（`(prov) Model • max`、`… → routed • high`），
  // 所以最后一个 2+ 空格就是统计与模型的分界。
  let cut = -1
  for (let i = trimmed.length - 2; i >= 0; i -= 1) {
    if (trimmed[i] === ' ' && trimmed[i + 1] === ' ') {
      cut = i
      break
    }
  }
  if (cut <= 0) return { stats: trimmed, model: '' }
  const stats = trimmed.slice(0, cut).replace(/\s+$/, '')
  const model = trimmed.slice(cut).trim()
  if (stats === '' || model === '') return { stats: trimmed, model: '' }
  return { stats, model }
}

/**
 * 从右侧那一段里切出「模型名」与「档位」。pi 的格式是
 * `Model` / `Model • thinking off` / `(provider) Model • max` / `… → routed • high`。
 */
export function splitModelSegment(segment: string): { model: string; thinking: string } {
  const text = typeof segment === 'string' ? segment : ''
  if (text === '') return { model: '', thinking: '' }
  const index = text.lastIndexOf(' • ')
  if (index < 0) return { model: text, thinking: '' }
  return { model: text.slice(0, index), thinking: text.slice(index + 3) }
}

/** 安全读 ctx 上的字段（getter 可能抛；扩展 ctx 可能缺字段）。 */
function readCtx<T>(ctx: any, pick: (ctx: any) => T): T | undefined {
  try {
    const value = pick(ctx)
    return value === null || value === undefined ? undefined : value
  } catch {
    return undefined
  }
}

/**
 * 从 `ctx.sessionManager.getEntries()` 累加 usage —— 与 pi footer 的
 * `getSessionStats()`（`footer.js:83-125`）同一套口径：assistant 消息的 usage
 * + `usage` 条目 + toolResult 的 usage + branch_summary/compaction 的 usage，
 * 命中率取**最后一条** assistant 消息的 cacheRead/(input+cacheRead+cacheWrite)。
 */
export function sumUsage(sessionManager: any): {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  latestCacheHitRate: number | undefined
} {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, latestCacheHitRate: undefined as number | undefined }
  let entries: any[] = []
  try {
    entries = Array.isArray(sessionManager?.getEntries?.()) ? sessionManager.getEntries() : []
  } catch {
    return totals
  }
  for (const entry of entries) {
    const usage =
      entry?.type === 'usage'
        ? entry.usage
        : entry?.type === 'message' && entry.message?.role === 'assistant'
          ? entry.message.usage
          : entry?.type === 'message' && entry.message?.role === 'toolResult'
            ? entry.message.usage
            : entry?.type === 'branch_summary' || entry?.type === 'compaction'
              ? entry.usage
              : undefined
    if (!usage) continue
    totals.input += Number(usage.input ?? 0)
    totals.output += Number(usage.output ?? 0)
    totals.cacheRead += Number(usage.cacheRead ?? 0)
    totals.cacheWrite += Number(usage.cacheWrite ?? 0)
    if (entry?.type === 'message' && entry.message?.role === 'assistant') {
      const prompt = totalsCachePrompt(usage)
      totals.latestCacheHitRate = prompt > 0 ? (Number(usage.cacheRead ?? 0) / prompt) * 100 : undefined
    }
  }
  return totals
}

function totalsCachePrompt(usage: any): number {
  return Number(usage?.input ?? 0) + Number(usage?.cacheRead ?? 0) + Number(usage?.cacheWrite ?? 0)
}

/** token 数缩写（与 pi footer 的 formatTokens 同一条规则）。 */
export function formatTokens(count: number): string {
  const value = Number(count ?? 0)
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value < 1000) return String(value)
  if (value < 10000) return (value / 1000).toFixed(1) + 'k'
  if (value < 1000000) return Math.round(value / 1000) + 'k'
  if (value < 10000000) return (value / 1000000).toFixed(1) + 'M'
  return Math.round(value / 1000000) + 'M'
}

/* --------------------------------------- 真实上下文占用（0.12.2，footer 用） */

/**
 * 为什么 footer 要自己读守卫日志，而不是 import `./superpi-context-guard.mjs`：
 * 静态 import 会让「守卫模块缺失或语法坏」直接拖垮**整个编辑器扩展** ——
 * 用户丢掉的是 Ctrl+A/粘贴路径/footer 全部能力，只为了一个可选的数字。
 * 所以这里只做一件事：读日志最后一行。读不到就返回 null，footer 退回 pi 原值。
 *
 * 路径规则与守卫模块、host 的 `/context` 三处必须一致，由 `test/tui-editor.mjs`
 * 断言（拿守卫模块的 `resolveGuardLogPath` 做对照），不靠人记。
 */
const GUARD_DIR_NAME = '.superpi'
const GUARD_LOG_FILE_NAME = 'context-guard.log.jsonl'
const GUARD_LOG_TAIL_BYTES = 128 * 1024
export function resolveGuardLogPath({ env = process.env, home = os.homedir() }: { env?: any; home?: string } = {}): string {
  const override = typeof env?.SUPERPI_CONTEXT_GUARD === 'string' ? env.SUPERPI_CONTEXT_GUARD.trim() : ''
  const dir = override !== '' ? path.dirname(path.resolve(override)) : path.join(home, GUARD_DIR_NAME)
  return path.join(dir, GUARD_LOG_FILE_NAME)
}

/**
 * 读「本会话」最后一条守卫记录。
 *
 * 为什么带 sessionId：日志是所有会话共用的一份，不带过滤会拿到别的会话的数
 * —— 那比不显示更糟（用户会以为自己的上下文变了）。
 */
export function readGuardUsageSync(
  sessionId: string,
  { env = process.env, home = os.homedir() }: { env?: any; home?: string } = {},
): { after: number; window: number } | null {
  try {
    const file = resolveGuardLogPath({ env, home })
    const stat = fs.statSync(file)
    if (stat.size <= 0) return null
    const readBytes = Math.min(stat.size, GUARD_LOG_TAIL_BYTES)
    const buffer = Buffer.alloc(readBytes)
    const handle = fs.openSync(file, 'r')
    try {
      fs.readSync(handle, buffer, 0, readBytes, stat.size - readBytes)
    } finally {
      fs.closeSync(handle)
    }
    const lines = buffer.toString('utf8').split('\n')
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const text = lines[i].trim()
      if (text === '') continue
      let row: any
      try {
        row = JSON.parse(text)
      } catch {
        continue
      }
      if (row === null || typeof row !== 'object') continue
      // sessionId 为空 = 无法确认这条记录属于当前会话 → 宁可退回 pi 的原值，
      // 也不能把别的会话的真实占用挂到当前窗口上（那比不显示更糟）。
      if (sessionId === '' || row.sessionId !== sessionId) continue
      const after = Number(row.after)
      if (!Number.isFinite(after) || after < 0) return null
      const window = Number(row.window)
      return { after, window: Number.isFinite(window) && window > 0 ? window : 0 }
    }
    return null
  } catch {
    return null
  }
}

/** footer 里的可点元素 → 命中的那个（按显示列）。 */
function hitAt(hits: FooterHit[], x: unknown, y: unknown): FooterHit | undefined {
  if (typeof x !== 'number' || typeof y !== 'number') return undefined
  return hits.find(h => h.y === y && x >= h.x && x < h.x + Math.max(1, h.width))
}

export class SuperPiFooter {
  private tui: any
  private theme: any
  private footerData: any
  private ctx: any
  private hits: FooterHit[] = []
  /** 守卫真实占用的缓存：footer 每帧都可能渲染，不能每帧读盘。 */
  private guardCache: { at: number; value: { after: number; window: number } | null } = { at: 0, value: null }
  private lastWidth = 80

  constructor(tui: any, theme: any, footerData: any, options: any = {}) {
    this.tui = tui
    this.theme = theme
    this.footerData = footerData
    this.ctx = options?.ctx
    // git 分支变了要重画（pi 的内置 footer 也是这么订阅的）。
    try {
      this.footerData?.onBranchChange?.(() => this.tui?.requestRender?.())
    } catch {
      /* 拿不到订阅就不订阅 */
    }
  }

  /** 与模型名一致的暗色；取不到色就原样返回（footer 不许因取色失败消失）。 */
  private dim(text: string): string {
    return this.fg('dim', text)
  }

  private fg(token: string, text: string): string {
    try {
      const fgFn = this.theme?.fg
      if (typeof fgFn === 'function') return fgFn.call(this.theme, token, text)
    } catch {
      /* 主题没有这个 token → 原样 */
    }
    return text
  }

  /** 项目名：cwd 缩成 `~` + git 分支（与 pi footer 的取值同一套）。 */
  private projectLabel(): string {
    let cwd = ''
    try {
      cwd = this.ctx?.sessionManager?.getCwd?.() ?? ''
    } catch {
      cwd = ''
    }
    if (cwd === '') cwd = process.cwd()
    let branch: string | null = null
    try {
      branch = this.footerData?.getGitBranch?.() ?? null
    } catch {
      branch = null
    }
    return projectLabel(cwd, branch, process.env.HOME || process.env.USERPROFILE)
  }

  invalidate(): void {
    // 第 2 行每帧现算，无缓存可失效。
  }

  dispose(): void {
    // footer 自身没有订阅要释放（分支订阅由 pi 的 footerData 自己管）。
    // 但它是「窗口正在关闭」的最早信号之一：顺手停掉动画与目标绑定，
    // 免得定时器继续敲一个已经销毁的 tui（那会每 160ms 抛一次异常）。
    stopAnimation()
    bindFrameTarget(null)
  }

  /**
   * 第 2 行：**统计 + 模型/档位**。
   *
   * 为什么不直接 new pi 的 `FooterComponent`：它要一个 `AgentSession`
   * （`session.state` / `session.modelRuntime` / `session.getContextUsage()` /
   * `session.sessionManager.getEntries()` …），而 **扩展的 `ExtensionContext`
   * 里根本没有 `session`**（0.9.9 第一版就踩了这个坑：`ctx.session` 恒 undefined
   * → 内层 footer 建不出来 → 用户看到「窗口最底部那一行信息没有了」）。
   * 扩展能拿到的公开面只有 `ctx.model / ctx.thinkingLevel / ctx.sessionManager /
   * ctx.getContextUsage() / footerData.getGetBranch()`，所以这一行由本扩展
   * **按 pi 同一套公式**算出来（`footer.js:160-236` 逐项照抄）：
   *   `↑input ↓output RcacheRead WcacheWrite CH命中率 (auto) 上下文%/窗口` + 右对齐 `(provider) Model • 档位`
   * 只用了 4 个可空字段，任何一项取不到就跳过它，绝不整行消失。
   */
  private innerLine(): string {
    const width = this.lastWidth
    const model = readCtx(this.ctx, c => c.model)
    const thinking = readCtx(this.ctx, c => c.thinkingLevel)
    let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as any
    try {
      usage = sumUsage(readCtx(this.ctx, c => c.sessionManager)) ?? usage
    } catch {
      /* 统计拿不到就只显示上下文与模型 */
    }
    let context: any = undefined
    try {
      context = this.ctx?.getContextUsage?.()
    } catch {
      context = undefined
    }

    // 左侧统计（顺序与 pi footer 一致：输入、输出、缓存读、缓存写、命中率、上下文）
    const parts: string[] = []
    if (usage.input) parts.push('↑' + formatTokens(usage.input))
    if (usage.output) parts.push('↓' + formatTokens(usage.output))
    if (usage.cacheRead) parts.push('R' + formatTokens(usage.cacheRead))
    if (usage.cacheWrite) parts.push('W' + formatTokens(usage.cacheWrite))
    const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite
    if (promptTokens > 0 && usage.latestCacheHitRate !== undefined) {
      parts.push('CH' + usage.latestCacheHitRate.toFixed(1) + '%')
    }
    // 上下文占用的来源优先级：守卫的真实估算（`~` 标记）> pi 的 usage 派生值。
    // 守卫没有这个会话的记录（没装 / 还没发过请求）时，原样显示 pi 的数 —— 绝不显示 '?' 骗人。
    const real = this.guardUsage()
    const window = Number(context?.contextWindow ?? model?.contextWindow ?? real?.window ?? 0)
    if (context !== undefined || real !== null) {
      const auto = this.autoCompactEnabled()
      let shown = '?'
      let estimated = false
      if (real !== null && real.after > 0 && window > 0) {
        shown = Math.min(100, (real.after / window) * 100).toFixed(1) + '%'
        estimated = true
      } else if (context !== undefined) {
        const percent = context?.percent
        shown = percent === null || percent === undefined ? '?' : Number(percent).toFixed(1) + '%'
      }
      parts.push((estimated ? '~' : '') + shown + '/' + formatTokens(window) + (auto ? ' (auto)' : ''))
    }
    const stats = parts.join(' ')

    // 右侧：`(provider) Model • 档位`（provider 只在有多个 provider 时加，与 pi 同规则）
    if (!model) return stats
    const modelName = String(model?.id ?? '') || 'no-model'
    let right = modelName
    if (model?.reasoning) {
      const level = thinking || 'off'
      right = level === 'off' ? modelName + ' • thinking off' : modelName + ' • ' + level
    }
    let providers = 1
    try {
      providers = Number(this.footerData?.getAvailableProviderCount?.() ?? 1)
    } catch {
      providers = 1
    }
    if (providers > 1 && model?.provider) {
      const withProvider = '(' + model.provider + ') ' + right
      if (widthOf(stats) + 2 + widthOf(withProvider) <= width) right = withProvider
    }

    const leftWidth = widthOf(stats)
    const rightWidth = widthOf(right)
    if (stats === '') return right
    if (leftWidth + 2 + rightWidth > width) return stats
    return stats + ' '.repeat(Math.max(2, width - leftWidth - rightWidth)) + right
  }

  /**
   * 真实上下文占用（2 秒节流）。
   *
   * pi 的 `getContextUsage()` 是 usage 派生值：当前上游把 prompt 全记在 cache 且
   * `input=0`，真实 1.31M 的上下文会被算成 **3.7%** —— 用户以为还有 96% 空间，
   * 直到撞上 400。这里读守卫每次请求前算的估算，只在这个会话有记录时覆盖显示。
   */
  private guardUsage(): { after: number; window: number } | null {
    const now = Date.now()
    if (now - this.guardCache.at < 2000) return this.guardCache.value
    this.guardCache.at = now
    let sessionId = ''
    try {
      const manager = readCtx(this.ctx, c => c.sessionManager)
      const value = typeof manager?.getSessionId === 'function' ? manager.getSessionId() : ''
      sessionId = value === null || value === undefined ? '' : String(value)
    } catch {
      sessionId = ''
    }
    this.guardCache.value = readGuardUsageSync(sessionId)
    return this.guardCache.value
  }

  /** 自动压缩开关（`ctx.getSettings().compaction.enabled`，拿不到就当开 —— 与 pi 同默认）。 */  private autoCompactEnabled(): boolean {
    try {
      const enabled = this.ctx?.getSettings?.()?.compaction?.enabled
      return typeof enabled === 'boolean' ? enabled : true
    } catch {
      return true
    }
  }

  render(width: number): string[] {
    this.lastWidth = width
    this.hits = []
    const lines: string[] = [this.projectRow(width, 0)]

    const inner = this.innerLine()
    if (inner === '') return lines
    const { stats, model } = splitFooterLine(stripAnsi(inner))
    // 拿不到右对齐的模型段 → 整行只当统计用（绝不吞掉统计）。
    const statsWidth = widthOf(stats)
    const modelWidth = widthOf(model)
    const gap = Math.max(2, width - statsWidth - modelWidth)
    const modelX = statsWidth + gap
    const { model: modelName } = splitModelSegment(model)
    const nameWidth = widthOf(modelName)
    const thinkWidth = Math.max(0, modelWidth - nameWidth)

    // 模型名与档位各自可点、各自可悬停（用户要求「点 max 能切换选项」）。
    const modelHovered = hoverState.id === 'model'
    const thinkHovered = hoverState.id === 'thinking'
    let row = stats === '' ? '' : this.dim(stats)
    if (model !== '') {
      row += ' '.repeat(gap)
      if (nameWidth > 0) {
        row += modelHovered ? hoverStyle(modelName, (t, v) => this.fg(t, v)) : this.dim(modelName)
        this.hits.push({ kind: 'model', x: modelX, y: 1, width: nameWidth })
      }
      if (thinkWidth > 0) {
        const tail = model.slice(modelName.length)
        row += thinkHovered ? hoverStyle(tail, (t, v) => this.fg(t, v)) : this.dim(tail)
        this.hits.push({ kind: 'thinking', x: modelX + nameWidth, y: 1, width: thinkWidth })
      } else if (nameWidth === 0) {
        // 整段都不认得：当成档位处理，至少能点。
        row += thinkHovered ? hoverStyle(model, (t, v) => this.fg(t, v)) : this.dim(model)
        this.hits.push({ kind: 'thinking', x: modelX, y: 1, width: Math.max(1, modelWidth) })
      }
    }
    if (row !== '') lines.push(padToWidth(row, width))
    return lines
  }

  /** 第 1 行：`<cwd (branch)>  ⇄` + 右对齐的 `settings  home`。 */
  private projectRow(width: number, y: number): string {
    const actions = runState.phase === 'error' && runState.verdict !== null
      ? [{ id: 'continue', label: '继续' } as const, ...EDITOR_ACTIONS]
      : EDITOR_ACTIONS
    const actionsPlain = actions.map(action => action.label).join('  ')
    const actionsWidth = widthOf(actionsPlain)
    const iconWidth = widthOf(SWITCH_ICON)
    let label = this.projectLabel()
    // 项目名 + 2 格缝 + 图标 + 至少 2 格缝 + 右侧入口
    const room = Math.max(0, width - actionsWidth - iconWidth - 4)
    const labelWidth = widthOf(label)
    if (labelWidth > room) label = truncateToWidthQuiet(label, room)

    const switchHovered = hoverState.id === 'switch'
    let row = ''
    let cursor = 0
    if (label !== '') {
      // 项目名本身也是切换入口 —— 悬停时同样变亮。
      row += switchHovered ? hoverStyle(label, (t, v) => this.fg(t, v)) : this.dim(label)
      row += '  '
      cursor += widthOf(label) + 2
      this.hits.push({ kind: 'project', x: 0, y, width: widthOf(label) })
    }
    row += switchHovered ? hoverStyle(SWITCH_ICON, (t, v) => this.fg(t, v)) : this.dim(SWITCH_ICON)
    this.hits.push({ kind: 'project', x: cursor, y, width: iconWidth })
    cursor += iconWidth

    const gap = Math.max(2, width - cursor - actionsWidth)
    row += ' '.repeat(gap)
    cursor += gap
    const pieces: string[] = []
    for (const action of actions) {
      const text = action.label
      const actionWidth = widthOf(text)
      // **必须登记命中区**，否则这两个入口只有悬停、没有点击
      // （0.9.9 把这一行从编辑器搬到 footer 时漏了这一句 —— 用户实测点不动）。
      this.hits.push({ kind: action.id, x: cursor, y, width: actionWidth })
      pieces.push(hoverState.id === action.id ? hoverStyle(text, (t, v) => this.fg(t, v)) : this.dim(text))
      cursor += actionWidth + 2
    }
    row += pieces.join('  ')
    return padToWidth(row, width)
  }

  /**
   * 鼠标事件：悬停（move）只改悬停态并重画，点击（press/click）才触发动作。
   * 命不中就返回 undefined，让 pi 自己的处理继续（例如滚轮滚动聊天区）。
   */
  handleMouse(event: any): any {
    if (!event) return undefined
    const isMove = event.type === 'move' || event.type === 'drag'
    const isPress = event.type === 'press' || event.type === 'click'
    if (!isMove && !isPress) return undefined
    const hit = hitAt(this.hits, event.x, event.y)
    if (!hit) {
      if (isMove && hoverState.id !== null) {
        hoverState.id = null
        this.tui?.requestRender?.()
        return { handled: true, render: true }
      }
      return undefined
    }
    const hoverId = hit.kind === 'project' ? 'switch' : hit.kind
    if (isMove) {
      if (hoverState.id === hoverId) return { handled: true }
      hoverState.id = hoverId
      this.tui?.requestRender?.()
      return { handled: true, render: true }
    }
    try {
      this.ctx?.onFooterAction?.(hit.kind)
    } catch {
      /* 回调失败不能崩 footer */
    }
    this.tui?.requestRender?.()
    return { handled: true }
  }
}

/* -------------------------------------------------------------------- 注册 */

/** 终端窗口标题的品牌前缀。pi 未配置 piConfig.name 时默认用 "π"。 */

/**
 * 把窗口标题设成 `SuperPi - <cwd 目录名>`，形状对齐 pi 自己的
 * `${APP_TITLE} - ${cwdBasename}`（interactive-mode.js 的 updateTerminalTitle）。
 *
 * 只在 TUI 模式下动：RPC 模式下面板把 setTitle 收到的字符串当作会话名的
 * 回退值，从 RPC 侧发标题会污染面板显示，必须挡掉。
 */
function applyWindowTitle(ctx: any): void {
  try {
    if (ctx?.mode !== 'tui') return
    if (typeof ctx?.ui?.setTitle !== 'function') return
    let base = ''
    try {
      const cwd = ctx?.sessionManager?.getCwd?.()
      if (typeof cwd === 'string' && cwd !== '') {
        base = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
      }
    } catch { /* cwd 拿不到就只显示品牌名 */ }
    // 目录名与品牌同名（例如就在 SuperPi 仓库里）时不要拼成 "SuperPi - SuperPi"。
    const sameAsBrand = base.toLowerCase() === BRAND_NAME.toLowerCase()
    ctx.ui.setTitle(base === '' || sameAsBrand ? BRAND_NAME : BRAND_NAME + ' - ' + base)
  } catch (error) {
    // 终端不支持设置标题（或 API 变了）→ 静默跳过，绝不让 pi 起不来。
    void error
  }
}

/* --------------------------------------------------------------- 项目切换 */

/** 目录比较键：Windows 忽略大小写、分隔符归一（与 pi / 面板同一条规则）。 */
export function pathComparisonKey(target: string): string {
  if (typeof target !== 'string' || target === '') return ''
  let value = target.replace(/\//g, '\\').replace(/\\+$/, '')
  if (process.platform === 'win32') value = value.toLowerCase()
  return value
}

/**
 * 会话列表 → 项目列表。排序规则逐条照抄 pi 的 session-selector：
 * 当前项目置顶 → 非临时目录优先 → 最近活动降序。
 */
export function groupProjects(sessions: any[], currentCwd: string): Array<{
  key: string
  cwd: string
  displayPath: string
  sessionCount: number
  isTemporary: boolean
  lastActivityMs: number
  lastSessionPath: string
}> {
  const currentKey = pathComparisonKey(currentCwd)
  const byProject = new Map<string, any>()
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const cwd = typeof session?.cwd === 'string' ? session.cwd : ''
    if (cwd === '') continue
    const key = pathComparisonKey(cwd)
    const modified = new Date(session?.modified ?? 0).getTime()
    const ms = Number.isNaN(modified) ? 0 : modified
    let entry = byProject.get(key)
    if (entry === undefined) {
      entry = {
        key,
        cwd,
        displayPath: shortenHome(cwd),
        sessionCount: 0,
        isTemporary: isTemporaryProjectPath(cwd),
        lastActivityMs: 0,
        lastSessionPath: '',
      }
      byProject.set(key, entry)
    }
    entry.sessionCount += 1
    if (ms >= entry.lastActivityMs) {
      entry.lastActivityMs = ms
      const candidate = typeof session?.path === 'string' ? session.path : ''
      if (candidate !== '') entry.lastSessionPath = candidate
    }
  }
  const rank = (entry: any) => (entry.key === currentKey ? 0 : entry.isTemporary ? 2 : 1)
  return [...byProject.values()].sort((a, b) => rank(a) - rank(b) || b.lastActivityMs - a.lastActivityMs)
}

/** 家目录缩成 `~`（对齐 pi 的 shortenHomePath）。 */
export function shortenHome(target: string, home = process.env.HOME || process.env.USERPROFILE || ''): string {
  if (typeof target !== 'string' || target === '') return ''
  if (typeof home !== 'string' || home === '') return target
  try {
    const rel = path.relative(path.resolve(home), path.resolve(target))
    if (rel === '') return '~'
    if (rel.startsWith('..') || path.isAbsolute(rel)) return target
    return '~' + path.sep + rel
  } catch {
    return target
  }
}

/** 临时目录判定（与 pi 的 TEMPORARY_PATH_PATTERNS 同义，只用于排序沉底）。 */
export function isTemporaryProjectPath(target: string): boolean {
  if (typeof target !== 'string' || target === '') return false
  const normalized = target.replace(/\\/g, '/')
  return (
    /^\/?(tmp|var\/tmp|private\/var\/folders)\//i.test(normalized) ||
    /(^|\/)(appdata\/local\/temp|temp|tmp)(\/|$)/i.test(normalized) ||
    /(^|\/)pi-runtime[-\w.]*/i.test(normalized)
  )
}

/**
 * 目标项目的一个会话文件：有最近的会话就用它，否则按 pi 自己的 header 格式
 * 写一个空会话（`type/version/id/timestamp/cwd`）。
 *
 * 为什么必须先有文件：pi 换 cwd 的唯一官方通道是
 * `ctx.switchSession(sessionFile)`（`agent-session-runtime.js:128-146` 用
 * session header 的 cwd 建 runtime），它要求文件存在。空 header 的文件
 * `SessionManager.open()` 能正常读出来，所以「写 header 再切」等价于
 * 「在这个项目里开一个新会话」—— 与 `SessionManager.create()` 的落盘格式一致。
 */
export function ensureProjectSession(SessionManager: any, cwd: string): string {
  try {
    if (!SessionManager || typeof SessionManager.create !== 'function') return ''
    const manager = SessionManager.create(cwd)
    const file = String(manager?.getSessionFile?.() ?? '')
    if (file === '') return ''
    const entries = typeof manager?.getEntries === 'function' ? manager.getEntries() : []
    // 已有会话（文件里已经有内容）→ 直接用最近的那条。
    if (fs.existsSync(file) && fs.statSync(file).size > 0) return file
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const version = Number(SessionManager?.CURRENT_SESSION_VERSION)
    const header = {
      type: 'session',
      version: Number.isFinite(version) && version > 0 ? version : 3,
      id: String(manager?.getSessionId?.() ?? ''),
      timestamp: new Date().toISOString(),
      cwd: String(manager?.getCwd?.() ?? cwd),
    }
    void entries
    fs.writeFileSync(file, JSON.stringify(header) + '\n', 'utf8')
    return file
  } catch {
    return ''
  }
}

/**
 * 「回到项目选择」：列出别的项目，选一个就在那里开新会话。
 *
 * pi 的 TUI **没有**项目选择页（`/resume` 只有 Current Folder 与 All 两种 scope，
 * All 还是平铺的会话列表），cwd 又是进程启动时定死的。这里用 pi 自己的三样
 * 公开能力拼出来：`SessionManager.listAll()` 枚举 → `ctx.ui.select()` 选 →
 * `ctx.switchSession()` 换（官方唯一改 cwd 的入口）。不碰 node_modules、不打补丁。
 */
export async function switchProjectVia(
  ctx: any,
  SessionManager: any,
): Promise<{ switched: boolean; cwd?: string; message?: string }> {
  try {
    if (!SessionManager || typeof SessionManager.listAll !== 'function') {
      return { switched: false, message: '当前运行时没有 SessionManager.listAll' }
    }
    let currentCwd = ''
    try {
      currentCwd = String(ctx?.sessionManager?.getCwd?.() ?? '')
    } catch {
      currentCwd = ''
    }
    const sessions = await SessionManager.listAll()
    const projects = groupProjects(sessions, currentCwd)
    if (projects.length === 0) return { switched: false, message: '还没有项目。在项目目录中启动 ' + BRAND_NAME + ' 后即可在这里切换。' }
    const currentKey = pathComparisonKey(currentCwd)
    const labels = projects.map(project => {
      const mark = project.key === currentKey ? '● ' : '○ '
      const temp = project.isTemporary ? '  [临时]' : ''
      return mark + project.displayPath + '   ' + project.sessionCount + ' 个会话' + temp
    })
    const choice = await ctx?.ui?.select?.('回到项目选择（选中即在那个项目开新会话）', labels)
    if (typeof choice !== 'string' || choice === '') return { switched: false }
    const target = projects[labels.indexOf(choice)]
    if (!target) return { switched: false }
    if (target.key === currentKey) return { switched: false, message: '已经在 ' + target.cwd + ' 了' }
    const file = ensureProjectSession(SessionManager, target.cwd)
    if (file === '') return { switched: false, message: '无法在目标项目里创建会话文件' }
    await ctx.switchSession(file)
    return { switched: true, cwd: target.cwd }
  } catch (error) {
    return { switched: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * pi 的公开导出台（`dist/index.js`）。**惰性、可选**：
 * 拿不到就什么都不做（绝不让 pi 起不来）。
 */
function publicApi(): any {
  return piPublicApi
}

/**
 * 扩展入口。pi 在 session_start 之后才允许 setEditorComponent，所以在这里挂工厂。
 * 同时关掉 pi 内置的 Working 行：状态改由本扩展渲染（要按状态换色）。
 */
export default function superpiEditor(pi: any): void {
  /** 当前活着的编辑器实例（footer 点 settings 时要它来开子菜单）。 */
  let liveEditor: SuperPiEditor | null = null
  /** 一个进程里只装一次 footer：session_switch 会再调 install，重装会叠层。 */
  let footerInstalled = false

  const runProjectSwitch = (ctx: any) => {
    const SessionManager = (publicApi() as any)?.SessionManager ?? ctx?.SessionManager
    void switchProjectVia(ctx, SessionManager).then(result => {
      if (result.switched) ctx?.ui?.notify?.('已切换到 ' + String(result.cwd), 'info')
      else if (result.message) ctx?.ui?.notify?.(result.message, result.message.includes('已经在') ? 'info' : 'error')
    })
  }

  const onFooterAction = (ctx: any, kind: string) => {
    if (kind === 'continue') {
      if (runState.verdict === null || runState.phase !== 'error' || !ctx.isIdle()) return
      const previous = runState.verdict
      runState.verdict = null
      try {
        pi.sendUserMessage('继续')
      } catch (error) {
        runState.verdict = previous
        ctx.ui.notify(String(error), 'error')
      }
      return
    }
    if (kind === 'project' || kind === 'switch') {
      runProjectSwitch(ctx)
      return
    }
    if (kind === 'settings') {
      liveEditor?.toggleMenu()
      return
    }
    if (kind === 'home') {
      // 与编辑器里点 home 同一条路径：交给 pi 的 onSubmit（= 用户敲完回车）。
      const submit = (liveEditor as any)?.onSubmit
      if (typeof submit === 'function') {
        void submit(HOME_COMMAND)
        return
      }
      ctx?.ui?.setEditorText?.(HOME_COMMAND)
      return
    }
    if (kind === 'model' || kind === 'thinking') {
      // pi footer 上的模型名 / 档位：直接把 pi 自己的斜杠命令走 onSubmit。
      const command = kind === 'model' ? '/model' : '/thinking'
      const submit = (liveEditor as any)?.onSubmit
      if (typeof submit === 'function') {
        void submit(command)
        return
      }
      ctx?.ui?.setEditorText?.(command)
      return
    }
  }

  const installFooter = (ctx: any) => {
    if (footerInstalled) return
    try {
      if (typeof ctx?.ui?.setFooter !== 'function') return
      footerInstalled = true
      ctx.ui.setFooter((tui: any, theme: any, footerData: any) => {
        // 全部用 getter，**不用快照**：switchSession 之后 pi 会换一个新的 ctx，
        // 快照会让 footer 永远盯着旧会话（统计 / 模型名从此不动）。
        //
        // 只暴露 `ExtensionContext` 真实存在的字段 —— 它**没有 `session`**
        // （0.9.9 首版就是从这里拿 AgentSession，结果 footer 第二行整条消失）。
        const component: any = new SuperPiFooter(tui, theme, footerData, {
          ctx: {
            get model() {
              return ctx?.model
            },
            get thinkingLevel() {
              return ctx?.thinkingLevel
            },
            get sessionManager() {
              return ctx?.sessionManager
            },
            getContextUsage: () => {
              try {
                return ctx?.getContextUsage?.()
              } catch {
                return undefined
              }
            },
            getSettings: () => {
              try {
                return ctx?.getSettings?.()
              } catch {
                return undefined
              }
            },
            get menuOpen() {
              return liveEditor?.isMenuOpen?.() === true
            },
            onFooterAction: (kind: string) => onFooterAction(ctx, kind),
          },
        })
        // settings 子菜单挂在编辑器上，footer 只负责把点击转过去。
        return component
      })
    } catch {
      footerInstalled = false
    }
  }

  const install = (ctx: any) => {
    if (ctx?.mode !== undefined && ctx.mode !== 'tui') return
    try {
      ctx?.ui?.setWorkingVisible?.(false)
      ctx?.ui?.setEditorComponent?.(
        (tui: any, theme: any, keybindings: any) => {
          const editor = new SuperPiEditor(tui, theme, keybindings, {
            embedWorkingStatus: false,
            hooks: {
              notify: (text: string, level?: string) => ctx?.ui?.notify?.(text, level),
              // 颜色与模型名一致：pi footer 画模型名用的是 theme.fg('dim', …)。
              // 扩展里能拿到主题的唯一公开入口是 ctx.ui.theme。
              dim: (text: string) => {
                try {
                  return ctx?.ui?.theme?.fg?.('dim', text) ?? text
                } catch {
                  return text
                }
              },
              // 悬停高亮用 accent（与 pi 自己的选中色同一个 token）。
              fg: (token: string, text: string) => {
                try {
                  return ctx?.ui?.theme?.fg?.(token, text) ?? text
                } catch {
                  return text
                }
              },
              switchProject: () => runProjectSwitch(ctx),
            },
          })
          liveEditor = editor
          return editor
        },
      )
    } catch (error) {
      // 拿不到 UI（print/json 模式）或 API 变了 → 静默跳过，绝不让 pi 起不来。
      void error
    }
    installFooter(ctx)
    applyWindowTitle(ctx)
  }
  if (typeof pi?.on !== 'function') return
  pi.on('agent_start', (_event: any, ctx: any) => {
    if (ctx?.mode === undefined || ctx.mode === 'tui') markRunStart()
  })
  pi.on('message_end', (event: any, ctx: any) => {
    if (ctx?.mode !== undefined && ctx.mode !== 'tui') return
    const message = event?.message
    if (message?.role !== 'assistant') return
    const verdict = detectTurnVerdict(message)
    if (verdict.delivered) runState.verdict = null
    else markUndelivered(verdict)
  })
  /**
   * 工具开始/结束（0.14.1）。
   *
   * 为什么必须订阅 `tool_execution_start`：只有它带 `args`，而 `args.timeout` 是
   * 这条命令自带的执行上限。实测模型会给 bash 传 960 / 1800 / 6000 秒（最大见过
   * 120000），一条命令合法地跑 371~494 秒、一轮累计 2028 秒 —— 没有这个事件，
   * Working 行只能显示一个一直涨的秒数，用户无法区分"在跑"与"卡死"。
   *
   * 面板端在 `client.js` 的同一事件上做同一件事（`view.activeTool`），
   * 两端取的是同一个字段，所以不会出现"面板有上限、命令行没有"的偏差。
   */
  pi.on('tool_execution_start', (event: any) => {
    markToolStart(event?.toolName ?? event?.name, event?.args ?? event?.arguments, Date.now(), String(event?.toolCallId ?? ''))
  })
  /**
   * 工具产出新输出（0.15.0）。
   *
   * bash 每 100ms 就发一次这个事件（`core/tools/bash.js:15` BASH_UPDATE_THROTTLE_MS），
   * 收到它就说明命令确实在推进 —— 于是 `workingLabel` 不会打「已静默 N 秒」。
   * 反过来，一条只打印一次的测试跑 400 秒，这期间没有新输出，
   * Working 行就会明确写「已静默 3m 20s，仍在运行」，而不是干等一个不动的秒数。
   *
   * 注意：这里**不做渲染节流** —— 状态更新是纯内存操作（一个数字），
   * 真正的重绘节流由 pi 的 16ms 和我们的 120ms 动画定时器共同保证。
   */
  pi.on('tool_execution_update', (event: any) => {
    markToolOutput(Date.now(), String(event?.toolCallId ?? ''))
  })
  pi.on('tool_execution_end', (event: any) => {
    if (event?.isError) markToolError()
    markToolEnd()
  })
  pi.on('agent_settled', (event: any) => {
    if (event?.aborted) resetRunState()
    else markRunSettled()
  })
  pi.on('session_start', (_event: any, ctx: any) => {
    if (ctx?.mode !== undefined && ctx.mode !== 'tui') return
    resetRunState()
    install(ctx)
    // pi 在 init() 末尾与「检查包更新」之后各重设一次标题（后者是 win32 的异步
    // .finally）。延后一拍再设一次，才能盖住那两次重置。
    setTimeout(() => applyWindowTitle(ctx), 0)
  })
  pi.on('session_switch', (_event: any, ctx: any) => install(ctx))
  // /name 改名后 pi 会重算标题 → 跟着重设，否则又回落成 "π"。
  pi.on('session_info_changed', (_event: any, ctx: any) => applyWindowTitle(ctx))
}

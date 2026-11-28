/**
 * extensions/superpi-editor.ts 的门禁。
 *
 * 关键点：**加载真扩展、真 CustomEditor、真按键序列**。
 * 扩展是 TypeScript，pi 用 jiti 加载它并给 `@earendil-works/*` 配 alias —— 这里照抄同一套
 * （jiti + 相同 alias），所以测的就是 pi 里跑的那份代码，不是它的影子实现。
 *
 * 覆盖：Ctrl+A 全选、Shift+方向/Home/End 扩选、Ctrl+C 复制不清空（用户报的 bug）、
 * Ctrl+X 剪切、Backspace/Delete 删选区、可打印字符替换选区、跨行选区、Esc 放行、
 * 普通导航键打断选区、括号内粘贴替换选区、渲染反色成对、剪贴板 base64 解码、
 * 以及「空编辑器 Ctrl+C 必须放行给 pi」。
 *
 * 跑法：node test/tui-editor.mjs
 * 需要 pi 运行时（.runtime 或宿主 node_modules）。**缺了直接失败，不 SKIP**（0.16.1 起）：
 * 本文件用 pi 真实的 CustomEditor 渲染扩展，缺它等于 521 条检查一条都没跑。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { listRuntimeFiles } from '../src/runtime-files.mjs'
import { resolveExtensionDir, EXTENSION_FILE_NAME } from '../tools/install-pi-extension.mjs'
import { requireRuntime, requireTypeBox } from './preflight.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)

let checks = 0
function ok(condition, message) {
  checks += 1
  if (condition) return
  console.error('FAIL: ' + message)
  throw new Error(message)
}
function eq(actual, expected, message) {
  ok(actual === expected, `${message} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`)
}

/* --------------------------------------------------------------- 定位运行时 */

/**
 * 依赖判据统一由 test/preflight.mjs 给出（0.16.1）。
 *
 * 旧实现在缺 pi / 缺 pi-tui / 缺 jiti 时各调一次 `skip()` 并 `exit 0` ——
 * 而 `.runtime/` 是 gitignore 的，新机器 clone 下来必然命中第一条，
 * 于是本文件 **521 条检查一条都没跑，`npm test` 却是绿的**。
 * 这三层都是必需层（它们测的是「装完 pi 真的能认」），不是可选项，必须失败。
 */
const pi = requireRuntime()
if (!pi.cliPath || !pi.packageDir) throw new Error('preflight: pi 运行时信息不完整（cliPath/packageDir 为空）')

const piTuiDir = path.join(pi.packageDir, '..', 'pi-tui')
const piTuiEntry = path.join(piTuiDir, 'dist', 'index.js')
if (!fs.existsSync(piTuiEntry)) {
  console.error('FAIL: 找不到 @earendil-works/pi-tui（' + piTuiEntry + '）')
  console.error('      本门禁用 pi 真实的 CustomEditor 渲染扩展，缺它等于整段未验证。')
  process.exit(1)
}

/** 从 pi 包目录逐级向上找 jiti（pi 的依赖可能被提升到上层 node_modules）。 */
function findJitiEntry(startDir) {
  let dir = path.resolve(startDir)
  for (let depth = 0; depth < 8; depth += 1) {
    const target = path.join(dir, 'node_modules', 'jiti', 'lib', 'jiti.mjs')
    if (fs.existsSync(target)) return target
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return ''
}

const jitiPath = findJitiEntry(pi.packageDir)
if (!jitiPath) {
  console.error('FAIL: 找不到 jiti（pi 用 jiti 加载 TS 扩展）')
  console.error('      extensions/superpi-editor.ts 是本门禁的被测对象，缺 jiti 等于整段未验证。')
  process.exit(1)
}

/* -------------------------------------------------------------- 加载真扩展 */

const { createJiti } = await import(pathToFileURL(jitiPath).href)
const extensionFile = path.join(root, 'extensions', 'superpi-editor.ts')
ok(fs.existsSync(extensionFile), '扩展源文件存在')

// 按 pi 的 core/extensions/loader.js 解析扩展使用的原生依赖。
// 值用**绝对路径**而不是 file:// URL —— jiti 的 alias 走 CJS 解析，file:// 会解析失败。
const jiti = createJiti(extensionFile, {
  interopDefault: true,
  moduleCache: false,
  alias: {
    // pi 自己也是指向 dist/index.js（包根没有 index.js）。
    '@earendil-works/pi-coding-agent': path.join(pi.packageDir, 'dist', 'index.js'),
    '@earendil-works/pi-tui': piTuiEntry,
    typebox: requireTypeBox(pi),
  },
})

const extensionModule = await jiti.import(extensionFile)
const SuperPiEditor = extensionModule.SuperPiEditor
const FRAME_RGB = extensionModule.FRAME_RGB
const STATUS_RGB = extensionModule.STATUS_RGB
const EDITOR_ACTIONS = extensionModule.EDITOR_ACTIONS
const SETTINGS_COMMANDS = extensionModule.SETTINGS_COMMANDS
const HOME_COMMAND = extensionModule.HOME_COMMAND
const paintPathChips = extensionModule.paintPathChips
const statusIcon = extensionModule.statusIcon
const RUN_FRAMES = extensionModule.RUN_FRAMES
const FRAME_INTERVAL_MS = extensionModule.FRAME_INTERVAL_MS
const sampleFrames = extensionModule.sampleFrames
const startAnimation = extensionModule.startAnimation
const stopAnimation = extensionModule.stopAnimation
const isAnimating = extensionModule.isAnimating
const bindFrameTarget = extensionModule.bindFrameTarget
const runState = extensionModule.runState
const markRunStart = extensionModule.markRunStart
const markRunSettled = extensionModule.markRunSettled
const markToolError = extensionModule.markToolError
const resetRunState = extensionModule.resetRunState
const isLikelyPath = extensionModule.isLikelyPath
const padToWidth = extensionModule.padToWidth
const trimPathToken = extensionModule.trimPathToken
const parseProbe = extensionModule.parseProbe
const resolveClipboardPaste = extensionModule.resolveClipboardPaste
const saveClipboardImage = extensionModule.saveClipboardImage
const borderBody = extensionModule.borderBody
const SWITCH_ICON = extensionModule.SWITCH_ICON
const hoverState = extensionModule.hoverState
const hoverStyle = extensionModule.hoverStyle
const projectLabel = extensionModule.projectLabel
const splitFooterLine = extensionModule.splitFooterLine
const splitModelSegment = extensionModule.splitModelSegment
const SuperPiFooter = extensionModule.SuperPiFooter
const groupProjects = extensionModule.groupProjects
const pathComparisonKey = extensionModule.pathComparisonKey
const ensureProjectSession = extensionModule.ensureProjectSession
const isTemporaryProjectPath = extensionModule.isTemporaryProjectPath
const formatTokens = extensionModule.formatTokens
const sumUsage = extensionModule.sumUsage
const paintColumns = extensionModule.paintColumns
const decodeListing = extensionModule.decodeListing
const defaultExport = extensionModule.default
ok(typeof SuperPiEditor === 'function', '扩展导出 SuperPiEditor 类')
ok(typeof paintColumns === 'function', '扩展导出 paintColumns')
ok(typeof decodeListing === 'function', '扩展导出 decodeListing')
ok(typeof defaultExport === 'function', '扩展导出默认入口（pi 加载用）')

const tuiModule = await import(pathToFileURL(piTuiEntry).href)
const { CustomEditor, FooterComponent: FooterComponentStub } = await import(pathToFileURL(path.join(pi.packageDir, 'dist', 'index.js')).href)

// pi 的 FooterComponent 渲染时要读模块级主题（theme.js 的 Theme 单例）。
// 不初始化就会抛 "Theme not initialized. Call initTheme() first." —— 单测里照 pi
// 自己的启动顺序先 initTheme 一次，这样 footer 用的就是真实现，不是影子。
{
  const themeModule = await import(
    pathToFileURL(path.join(pi.packageDir, 'dist', 'modes', 'interactive', 'theme', 'theme.js')).href
  )
  themeModule.initTheme('dark')
}
ok(typeof CustomEditor === 'function', 'pi 公开导出了 CustomEditor（扩展继承它）')
ok(SuperPiEditor.prototype instanceof CustomEditor, 'SuperPiEditor 继承自 pi 的 CustomEditor（app 键位/actionHandlers 生效）')

/* ------------------------------------------------------------------ 夹具 */

// pi 通过 getEditorTheme() 交给编辑器的 theme **只有 borderColor 与 selectList**，
// 没有 fg。0.9.4 的 `this.theme.fg(...)` 因此抛错、render() 的兜底又退化成无框原始行，
// 现象就是用户看到的「改了没变化」。门禁必须用真实形状，否则测不出来。
const theme = { borderColor: String, selectList: {} }

function makeEditor(text = '', options = {}) {
  const tui = { renders: 0, terminal: { rows: 40, columns: 120 }, requestRender() { this.renders += 1 } }
  const editor = new SuperPiEditor(tui, theme, { matches: () => false }, {
    embedWorkingStatus: false,
    ...options,
  })
  if (text) editor.setText(text)
  return { editor, tui }
}

/** 等到一次异步剪贴板写入落地。 */
const settle = () => new Promise(resolve => setTimeout(resolve, 60))


/** 取渲染结果里带浅灰底色的字符（用于断言药丸范围）。 */
function paintedCells(rows) {
  const out = []
  for (const row of rows) {
    let bg = false
    for (let p = 0; p < row.length; ) {
      if (row[p] === '') {
        const m = /^\[([0-9;:?]*)([A-Za-z])/.exec(row.slice(p))
        if (m) {
          if (m[1] === '48;2;104;104;104') bg = true
          else if (m[1] === '49' || m[1] === '0' || (m[2] === 'm' && m[1] === '')) bg = false
          p += m[0].length
          continue
        }
      }
      if (bg) out.push(row[p])
      p += 1
    }
  }
  return out
}

const KEY = {
  ctrlA: '\x01',
  ctrlC: '\x03',
  ctrlX: '\x18',
  esc: '\x1b',
  backspace: '\x7f',
  delete: '\x1b[3~',
  shiftLeft: '\x1b[1;2D',
  shiftRight: '\x1b[1;2C',
  shiftUp: '\x1b[1;2A',
  shiftDown: '\x1b[1;2B',
  shiftHome: '\x1b[1;2H',
  shiftEnd: '\x1b[1;2F',
  right: '\x1b[C',
  left: '\x1b[D',
  home: '\x1b[H',
}

/* ---------------------------------------------------------------- 纯函数 */

eq(paintColumns('abc', 1, 3), 'a\x1b[7mbc\x1b[27m', 'paintColumns 加反色')
eq(paintColumns('abc', 0, 3), '\x1b[7mabc\x1b[27m', 'paintColumns 整行')
eq(paintColumns('abc', 2, 2), 'abc', 'paintColumns 空区间不涂')
eq(paintColumns('\x1b[31mabc\x1b[0m', 0, 2), '\x1b[31m\x1b[7mab\x1b[27mc\x1b[0m', 'paintColumns 跳过 ANSI 序列')
eq(paintColumns('你好ab', 4, 6), '你好\x1b[7mab\x1b[27m', 'paintColumns 按显示列（CJK 占两列）')
eq(paintColumns('abcd', 0, 4, 2), '\x1b[7mab\x1b[27mc\x1b[7md\x1b[27m', 'paintColumns 跳过光标格')
eq(paintColumns('abcd', 0, 0), 'abcd', 'paintColumns 零宽区间不动')

const b64 = value => Buffer.from(value, 'utf8').toString('base64')
eq(JSON.stringify(decodeListing(b64('C:\\a.png\nD:\\b.md'))), JSON.stringify(['C:\\a.png', 'D:\\b.md']), 'decodeListing 多路径')
eq(decodeListing(''), null, 'decodeListing 空输出 → null')
eq(decodeListing(b64('')), null, 'decodeListing 空列表 → null')
eq(decodeListing(b64('C:\\a\u0001.png')), null, 'decodeListing 挡掉控制字符')

/* --------------------------------- 0.14.1 等待可见性（合法长等待 vs 卡死） */

/**
 * 这一段的由来：用户报「总卡在 Elapsed 6m 0s / Working · 2287s」。
 * 查真实会话发现**并没有卡死** —— 那一轮 25 次工具执行累计 2028 秒（33.8 分钟），
 * 其中 `timeout=960` 的命令单次跑 371~494 秒，是合法的长任务。
 * 真正的问题是界面只显示一个一直涨的秒数，用户无法区分「在跑」与「卡死」。
 *
 * 所以这里测的不是"更快"，而是**可解释性**：工具名、命令自设上限、超限提示。
 * 面板端（client.js）有对应的一组断言，两边取同一个字段 `args.timeout`。
 */

const toolLimitSeconds = extensionModule.toolLimitSeconds
const markToolStart = extensionModule.markToolStart
const markToolEnd = extensionModule.markToolEnd
const formatRunDuration = extensionModule.formatRunDuration
const workingLabel = extensionModule.workingLabel
const HEARTBEAT_AFTER_MS = extensionModule.HEARTBEAT_AFTER_MS
const markToolOutput = extensionModule.markToolOutput
const isUndeliveredTurn = extensionModule.isUndeliveredTurn
const verdictKindOf = extensionModule.verdictKindOf
const markUndelivered = extensionModule.markUndelivered
// --- 上限提取：只认正有限数
eq(toolLimitSeconds({ timeout: 960 }), 960, 'toolLimitSeconds 读出 timeout')
eq(toolLimitSeconds({ timeout: 120000 }), 120000, 'toolLimitSeconds 支持超大上限（实测见过 120000s）')
eq(toolLimitSeconds({ timeout: 0 }), 0, 'timeout=0 视为未声明')
eq(toolLimitSeconds({ timeout: -5 }), 0, '负 timeout 视为未声明')
eq(toolLimitSeconds({ timeout: '960' }), 0, '字符串 timeout 不认（不做隐式转换，避免猜错）')
eq(toolLimitSeconds({}), 0, '没 timeout 字段时为 0')
eq(toolLimitSeconds(null), 0, 'args 为 null 时不崩')
eq(toolLimitSeconds(undefined), 0, 'args 为 undefined 时不崩')
eq(toolLimitSeconds({ timeout: Infinity }), 0, 'Infinity 视为未声明')

// --- 时长口径必须与 pi 自己的 formatToolDuration 逐字一致
// （pi 的工具行写 `Elapsed 5m 41s`，Working 行写别的格式会让人以为是两个计时）
eq(formatRunDuration(4200), '4.2s', '<60s 带一位小数')
eq(formatRunDuration(42000), '42.0s', '42s 也要带小数（pi 的分界是 60s 不是 10s）')
eq(formatRunDuration(341000), '5m 41s', '分钟级用 Nm Ns（与截图里的 Elapsed 5m 41s 同口径）')
eq(formatRunDuration(2287000), '38m 7s', '38m 级（用户截图里的 2287s）')
eq(formatRunDuration(3720000), '1h 2m 0s', '超过一小时用 Nh Nm Ns（pi 保留秒位）')
eq(formatRunDuration(7324000), '2h 2m 4s', '两小时级')
eq(formatRunDuration(0), '0.0s', '0 不崩')
eq(formatRunDuration(-1), '0.0s', '负数钳到 0')

// --- Working 文案三段：累计、工具、上限
{
  resetRunState()

  markRunStart(1000000)
  eq(workingLabel(1000000 + 5000, true), 'Working · 5.0s', 'running 但无工具时只显示累计')
  ok(!workingLabel(1000000 + 5000, true).includes('上限'), '无工具时不出现上限段')

  // 模拟：本轮已跑 38 分钟，当前在跑一条 timeout=960 的 bash（才跑了 3 分钟）
  markRunStart(1000000)
  markToolStart('bash', { command: 'node test/mutation.test.mjs', timeout: 960 }, 1000000 + 2100000)
  const label = workingLabel(1000000 + 2280000, true)
  ok(label.includes('38m'), '显示本轮累计（38m 级）')
  ok(label.includes('bash'), '显示当前工具名 —— 这是区分「在跑」与「卡死」的关键')
  ok(label.includes('上限 16m'), '显示命令自设上限（960s = 16m）')

  // 超过上限：必须改口，不能静默继续加秒数
  const over = workingLabel(1000000 + 2100000 + 961000, true)
  ok(over.includes('已超出上限'), '超限时显式说明（这是真该报警的时刻）')
  ok(!over.includes('上限 16m ·'), '超限后不再显示"上限 N"（两者互斥）')

  // 退化档（窄终端）：去掉工具段但保留累计
  const narrow = workingLabel(1000000 + 2280000, false)
  ok(!narrow.includes('bash'), '窄档不显示工具名')
  ok(narrow.includes('38m'), '窄档仍显示累计时长')

  // 工具结束 → 工具段消失，但 phase 仍是 running（否则 Working 会闪烁消失）
  markToolEnd()
  eq(runState.phase, 'running', '工具结束后 phase 仍是 running（避免 Working 行闪烁）')
  ok(!workingLabel(1000000 + 2290000, true).includes('bash'), '工具结束后不再显示工具名')

  // 出错 + 收尾
  markToolStart('bash', { timeout: 960 }, Date.now())
  markToolError()
  markRunSettled()
  eq(workingLabel(), '本轮已结束 · 曾有错误', '工具报错后收尾，状态文案明确表示本轮已结束')
  eq(runState.phase, 'warning', '有工具错误但无待处理模型异常时，收尾进入警告态')
  eq(runState.tool, null, 'settled 清空工具（否则下一轮会显示上一轮的工具）')
  eq(runState.startedAt, 0, 'settled 后 startedAt 归零')

  resetRunState()
  eq(workingLabel(Date.now(), true), '就绪', '空闲时显示就绪')
  eq(runState.phase, 'idle', 'reset 回到 idle')
  eq(runState.tool, null, 'reset 清空工具')
}

// --- 真入口：tool_execution_start 事件必须真的驱动 activeTool
{
  resetRunState()
  const calls = []
  const fakePi = { on: (event, handler) => calls.push({ event, handler }) }
  defaultExport(fakePi)
  const start = calls.find(c => c.event === 'tool_execution_start')?.handler
  const end = calls.find(c => c.event === 'tool_execution_end')?.handler
  ok(typeof start === 'function' && typeof end === 'function', '入口接到工具开始/结束两个事件')

  markRunStart()
  start({ toolName: 'bash', args: { command: 'x', timeout: 1800 } })
  ok(runState.tool !== null && runState.tool.name === 'bash', '事件驱动 activeTool（工具名）')
  eq(runState.tool.limitSeconds, 1800, '事件把 args.timeout 带进状态（面板端取同一个字段）')

  end({ isError: false })
  eq(runState.tool, null, 'tool_execution_end 清空 activeTool')

  // 缺字段时不许崩（pi 的其它工具可能没有 timeout）
  start({})
  ok(runState.tool !== null, '事件缺 toolName 时仍记录（回落成 tool）')
  eq(runState.tool.limitSeconds, 0, '缺 args 时上限为 0')
  end({})
  resetRunState()
}

/* ------------------------ 0.14.2 状态图标：更大 + 动效流畅 + 不会静止 */

/**
 * 用户反馈三条：①图标稍微大一点 ②动效流畅一点 ③**发送消息之后动效不能停下来静止**。
 *
 * 第③条不是"动画参数没调好"，而是**没有节拍**：`statusIcon()` 只是按时间取帧的纯函数，
 * 但取帧只在有人重绘时发生；pi-tui 的 `requestRender()` 是被动的（`tui.js:658-669`），
 * 模型跑一条 5 分钟 bash 期间既无输入也无 token → 不重绘 → 图标永远停在最后一帧。
 * 所以这里既测"帧本身"，也测"定时器真的在驱动"。
 */

// --- 帧序列：8 帧月相，互不相同、天生闭环
eq(RUN_FRAMES.length, 8, '旋转序列是 8 帧（比 4 帧更流畅）')
eq(new Set(RUN_FRAMES).size, 8, '八帧互不相同（有重复帧就是"看起来卡"）')
eq(RUN_FRAMES.join(''), '🌑🌒🌓🌔🌕🌖🌗🌘', '帧序是月相盈亏（天生闭环，🌘→🌑 无缝）')
ok(!RUN_FRAMES.some(f => '◐◓◑◒◴◵◶◷'.includes(f)), '不再使用旧的半圆/四分圆（都是 1 列宽，视觉偏小）')

/**
 * 视觉更大这件事在终端里没有字号可调，唯一可靠手段是换**双宽字符**。
 * 这条断言直接量宽度：任何一个帧退化成 1 列，图标就会缩回原样，
 * 而且会把上边框的行宽算歪（visibleWidth 是框线对齐的唯一依据）。
 */
{
  const tuiWidth = tuiModule.visibleWidth
  const widths = RUN_FRAMES.map(frame => tuiWidth(frame))
  eq(widths.join(','), '2,2,2,2,2,2,2,2', '八帧全部双宽（视觉 2 倍大，实测 visibleWidth=2）')
  ok(!RUN_FRAMES.some(frame => frame.includes('️')), '帧不含 VS16 变体选择符（含它的 emoji 在不同终端宽度会跳变，把框线挤歪）')
}

ok(FRAME_INTERVAL_MS >= 80, '帧间隔 >= 80ms（再快在终端里是抖动不是旋转）')
ok(FRAME_INTERVAL_MS <= 250, '帧间隔 <= 250ms（再慢看起来是卡顿）')

// 采样一个完整周期：必须八帧全出现，且能循环回起点
{
  const cycle = sampleFrames(8)
  eq(cycle.join(''), RUN_FRAMES.join(''), '一个周期内八帧按序出现，不多不少')
  const loop = sampleFrames(16)
  eq(loop.slice(8).join(''), RUN_FRAMES.join(''), '第二个周期重新从第 0 帧开始（真循环）')
  ok(new Set(loop).size === 8, '连续两个周期只有 8 种帧（没有漂移出界）')
}

// 同一时刻取帧必须稳定（纯函数，不依赖调用次数）
{
  const t = 1000000
  eq(statusIcon('running', t), statusIcon('running', t), '同一时刻取帧结果相同（纯函数）')
}

// 用「已运行时长」取帧：从 startedAt 起必须从第 0 帧开始，而不是随机落在某格
{
  resetRunState()
  markRunStart(500000)
  eq(statusIcon('running', 500000), RUN_FRAMES[0], '刚开跑是第 0 帧（不随机跳格）')
  eq(statusIcon('running', 500000 + FRAME_INTERVAL_MS), RUN_FRAMES[1], '一个间隔后是第 1 帧')
  eq(statusIcon('running', 500000 + FRAME_INTERVAL_MS * 8), RUN_FRAMES[0], '八个间隔后回到第 0 帧')
  resetRunState()
}

/* ------------------------ 0.15.0 进度心跳：静默时诚实反馈 */

/**
 * 用户要求「隔一段时间反馈一下进度，以免让用户觉得卡着了」。
 *
 * 关键在于**诚实**：不编造百分比，只陈述"已静默 N 秒，仍在运行"。
 * 依据是 bash 每 100ms 就发一次 tool_execution_update（core/tools/bash.js:15），
 * 所以"长时间没有 update"确实等价于"没有新输出"，而不是"没在干活"。
 *
 * 有输出时不显示这一段 —— 那时工具行本身就有实时内容，再叠一句是噪音。
 */
{
  eq(HEARTBEAT_AFTER_MS >= 10000, true, '心跳阈值不小于 10 秒（太短会变噪音）')
  eq(HEARTBEAT_AFTER_MS <= 60000, true, '心跳阈值不大于 60 秒（太长就盖不住焦虑期）')

  const t = 1000000
  resetRunState()
  markRunStart(t)
  markToolStart('bash', { timeout: 960 }, t)

  // 刚启动：静默 0 秒，不该出现心跳
  ok(!workingLabel(t, true).includes('已静默'), '刚启动时不显示静默心跳')

  // 静默刚好低于阈值：仍不显示
  ok(!workingLabel(t + HEARTBEAT_AFTER_MS - 1, true).includes('已静默'), '未达阈值不显示心跳')

  // 达到阈值：必须显示，且明确"仍在运行"（不是沉默，也不是假进度）
  const silent = workingLabel(t + HEARTBEAT_AFTER_MS, true)
  ok(silent.includes('已静默'), '达到阈值后显示静默时长')
  ok(silent.includes('仍在运行'), '必须明确告知仍在运行（这是消解焦虑的关键半句）')
  ok(!/%/.test(silent), '不编造百分比（没有真实进度就不装作有）')

  // 有输出 → 心跳消失（因为 lastOutputAt 被推进）
  markToolOutput(t + HEARTBEAT_AFTER_MS)
  ok(!workingLabel(t + HEARTBEAT_AFTER_MS, true).includes('已静默'), '有输出后心跳消失（不产生噪音）')
  ok(workingLabel(t + HEARTBEAT_AFTER_MS, true).includes('bash'), '有输出时仍显示工具名')

  // 再次长时间无输出 → 心跳重新出现（说明是"自上次输出起"计时，不是一次性）
  ok(workingLabel(t + HEARTBEAT_AFTER_MS * 2, true).includes('已静默'), '再次静默超阈值时心跳重现')


  // 并发工具：B 的输出不能刷新 A 的静默计时（0.15.0 修的真缺陷）
  //
  // 不按 id 匹配时，并行调用里 A 明明卡住，却被 B 每 100ms 的输出不断重置
  // lastOutputAt，心跳永远不触发 —— 那正是「看起来卡着」却没有任何解释的场景。
  {
    const t = 1000000
    resetRunState()
    markRunStart(t)
    markToolStart('bash', { timeout: 900 }, t, 'toolA')
    markToolStart('bash', { timeout: 900 }, t, 'toolB')
    // 当前 activeTool 是 B。让它自己产出一次输出 → 计时刷新
    markToolOutput(t + HEARTBEAT_AFTER_MS - 1, 'toolB')
    ok(!workingLabel(t + HEARTBEAT_AFTER_MS, true).includes('已静默'), 'B 自己的输出能刷新计时')
    // A 的输出出现在 B 静默期间 → 不得刷新 B
    markToolOutput(t + HEARTBEAT_AFTER_MS + 500, 'toolA')
    ok(workingLabel(t + HEARTBEAT_AFTER_MS * 2, true).includes('已静默'), '其他工具的输出不能刷新当前工具的计时')
    // B 自己再输出 → 静默计时归零
    markToolOutput(t + HEARTBEAT_AFTER_MS * 2, 'toolB')
    ok(!workingLabel(t + HEARTBEAT_AFTER_MS * 2, true).includes('已静默'), '当前工具自己的输出才刷新')
    resetRunState()
  }

  // 工具结束后心跳必须消失（否则会在模型推理期显示上一轮工具的静默）
  markToolEnd()
  ok(!workingLabel(t + HEARTBEAT_AFTER_MS * 3, true).includes('已静默'), '工具结束后不再显示静默心跳')

  // 窄档（去掉工具段）也不该出现心跳（心跳属于工具层的解释）
  markToolStart('bash', { timeout: 960 }, t)
  ok(!workingLabel(t + HEARTBEAT_AFTER_MS * 2, false).includes('已静默'), '窄档不含心跳段')

  resetRunState()
}


/* ------------------------ 0.15.1 畸形工具调用识别：让「莫名中断」可见 */

/**
 * 真实事故：上下文到 77.8% 时，模型把工具调用写成 DeepSeek 原生 DSML 语法
 * （`<｜｜DSML｜｜ parameter>`），pi 认不出来 → 当成普通文本 → `stopReason: "stop"`
 * → agent loop 结束 → **用户看到的就是「会话中断」**。
 *
 * 实测分布（n=1993 次调用）：0~68% 共 1574 次 DSML 为 0；76%~78% 共 264 次里 34 次
 * （12.9%）畸形，且全部落在 77.8~77.9%。**这是远早于上限的能力退化。**
 *
 * 判据设计要点：模型完全可能**在正文里讨论** DSML（例如解释这个 bug），
 * 所以不能只看关键词，必须同时满足 ①role=assistant ②stopReason≠toolUse
 * ③同时含开标记与关标记。
 */
{
  const dsml = (text, stopReason = 'stop') => ({ role: 'assistant', stopReason, content: [{ type: 'text', text }] })

  // 真实形态（取自会话记录）
  const REAL = '提交报警文案修正：\n\n<parameter name="bash">cd /d/x && git add -A</parameter>\n\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>'
  eq(isUndeliveredTurn(dsml(REAL)), true, '识别真实的 DSML 畸形输出')

  // 正常工具调用（pi 已解析出结构化调用）→ 不是畸形
  eq(isUndeliveredTurn(dsml('执行中...', 'toolUse')), false, 'stopReason=toolUse 时不算畸形（pi 已解析成功）')

  // 正常文本回复 → 不是畸形
  eq(isUndeliveredTurn(dsml('改好了，全量测试通过。')), false, '普通文本回复不算畸形')

  // 正文里**讨论** DSML 但不能误判
  eq(isUndeliveredTurn(dsml('这个 bug 是因为出现了 <｜｜DSML｜｜ parameter> 这样的标记。')), false,
    '只提开标记、没有完整结构时不误判（否则讲这个 bug 的回复会被判畸形）')

  // 缺 role / 非 assistant
  eq(isUndeliveredTurn({ role: 'user', content: [{ type: 'text', text: REAL }] }), false, 'user 消息不检测')
  eq(isUndeliveredTurn(null), false, 'null 不崩')


  /* ---- 0.15.6：真机抓到的两种「静默结束」形态 ---- */

  /**
   * 形态一：provider 在 **thinking 通道**里吐出闭合标记，然后没有正文。
   *
   * 真机原文（`stop=stop`，content 只有一个 thinking 块，长 1238）：
   *     But wait: will git actually attempt DNS... No — with a proxy configured it connects to the proxy.
   *     Let me verify empirically.</thinking>
   *     </｜｜DSML｜｜ calls>
   *
   * 用户看到的就是屏幕上多了一段独白，然后会话无声结束。
   * 旧判据只看 text 块且要求 text !== ''，**整条漏掉**。
   */
  {
    const thinkingOnly = {
      role: 'assistant',
      stopReason: 'stop',
      content: [{ type: 'thinking', thinking: 'Let me verify empirically.</thinking>\n</｜｜DSML｜｜ calls>' }],
    }
    eq(isUndeliveredTurn(thinkingOnly), true, 'thinking 通道里的 DSML 闭合标记也要识别')

    // 变体：thinking 里有完整三段（parameter/invoke/calls）
    const deep = {
      role: 'assistant',
      stopReason: 'stop',
      content: [{ type: 'thinking', thinking: 'x</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>' }],
    }
    eq(isUndeliveredTurn(deep), true, 'thinking 里的完整 DSML 三段也要识别')
  }

  /**
   * 形态二：`stop` 收尾但**既没有正文也没有工具调用**（只有 thinking）。
   *
   * 这一条不依赖任何关键词 —— 它抓的是「空转」：
   * 模型要么该回答（有 text），要么该调工具（有 toolCall），两者都没有就是故障。
   * 标记可能被 provider 吞掉，所以不能只靠字符串匹配。
   */
  {
    const emptyTurn = { role: 'assistant', stopReason: 'stop', content: [{ type: 'thinking', thinking: '纯思考，无正文' }] }
    eq(isUndeliveredTurn(emptyTurn), true, '只有 thinking、没有正文与工具调用 → 判定为空转故障')

    const emptyAll = { role: 'assistant', stopReason: 'stop', content: [] }
    eq(isUndeliveredTurn(emptyAll), true, '完全空的消息也是空转')

    // 反例：有正文就正常（哪怕很短）
    const hasText = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '好的' }] }
    eq(isUndeliveredTurn(hasText), false, '有正文的正常回复不判故障')

    // 反例：有工具调用就正常
    const hasCall = { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'x', name: 'bash', arguments: {} }] }
    eq(isUndeliveredTurn(hasCall), false, '有工具调用（toolUse）不判故障')

    // 反例：thinking + 正文 = 正常（这是最常见的形态）
    const thinkPlusText = {
      role: 'assistant',
      stopReason: 'stop',
      content: [{ type: 'thinking', thinking: '想了想' }, { type: 'text', text: '答案是这样' }],
    }
    eq(isUndeliveredTurn(thinkPlusText), false, 'thinking + 正文 是正常形态')
  }

  /* ---- 0.18.0：坏字节与截断也属于「没交付」---- */

  {
    const BAD = String.fromCharCode(0xfffd)
    const corrupt = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '2. ' + BAD + '始规则内容' }] }
    eq(isUndeliveredTurn(corrupt), true, '正文含坏字节 → 没交付')
    eq(verdictKindOf(corrupt), 'corrupt', '形态是 corrupt')
    eq(verdictKindOf({ role: 'assistant', stopReason: 'length', content: [{ type: 'text', text: '写到一半' }] }), 'truncated', 'stopReason=length → truncated')
    eq(isUndeliveredTurn({ role: 'assistant', stopReason: 'aborted', content: [] }), false, 'aborted 归错误路径，不判没交付')
  }

  // 错误态：要让本轮变成红色且能解释
  resetRunState()
  markRunStart(Date.now())
  markUndelivered(extensionModule.turnVerdictOf({
    role: 'assistant',
    stopReason: 'stop',
    content: [{ type: 'text', text: '提交前跑门禁：</parameter>\n</｜｜DSML｜｜ calls>' }],
  }))
  eq(runState.failed, true, '没交付标记为失败（图标变红）')
  eq(runState.verdict?.kind, 'dsml-residue', '记下整份判读（含 kind），不再是布尔')
  const label = workingLabel(Date.now(), true)
  ok(label.includes('DSML'), '文案点明原因（DSML 格式错乱），不是一句无信息量的"出错了"')
  ok(label.includes('从已有进度继续'), '给出可行动动作（从已有进度继续）')
  ok(!label.includes('Working'), '失败态不再显示 Working（否则用户以为是还在跑）')

  // 新一轮必须清掉旧标记
  markRunStart(Date.now())
  eq(runState.verdict, null, '新一轮开始时清掉判读（否则会一直显示失败）')
  markUndelivered(extensionModule.turnVerdictOf({
    role: 'assistant', stopReason: 'error', errorMessage: 'Upstream response stream ended before completion', content: [],
  }))
  ok(workingLabel(Date.now(), true).includes('上游在模型响应完成前断开了连接'), '终端 Working 行显示实际断流原因')
  resetRunState()
  eq(runState.verdict, null, 'resetRunState 也清掉')
}

/* ---- 两端使用同一个 pi 恢复策略 ---- */
{
  const { normalizeGuardSettings, readGuardSettingsSync, shouldAutoRetryOnMalformed } =
    await import('../extensions/superpi-context-guard.mjs')
  const settings = normalizeGuardSettings({})
  eq(settings.autoRetryOnMalformed, true, '自动恢复默认开启')
  eq(settings.autoRetryCooldownMs, 30000, '共享冷却默认 30 秒')
  const cases = [
    [{}, { now: 100000 }, true, 'ok'],
    [{ autoRetryCooldownMs: 5000 }, { lastAutoRetryAt: 100000, now: 104999 }, false, 'cooldown'],
    [{}, { lastAutoRetryAt: 90000, now: 100000 }, false, 'cooldown'],
    [{}, { lastAutoRetryAt: 10000, now: 100000 }, true, 'ok'],
    [{ autoRetryOnMalformed: false }, {}, false, 'disabled'],
    [{ autoRetryOnMalformed: false, autoRetryCooldownMs: 0 }, {}, false, 'disabled'],
    [{ autoRetryCooldownMs: 5000 }, { lastAutoRetryAt: 100000, now: 105000 }, true, 'ok'],
    [{ autoRetryCooldownMs: 0 }, { lastAutoRetryAt: 100000, now: 100001 }, true, 'ok'],
    [{}, { lastAutoRetryAt: 100000, now: 129999 }, false, 'cooldown'],
    [{}, { lastAutoRetryAt: 100000, now: 130000 }, true, 'ok'],
  ]
  for (const [overrides, state, retry, reason] of cases) {
    const result = shouldAutoRetryOnMalformed(normalizeGuardSettings(overrides), state)
    eq(result.retry, retry, '共享恢复策略 · ' + reason)
    eq(result.reason, reason, '共享恢复理由 · ' + reason)
  }

  const directory = path.join(root, '_scratch')
  fs.mkdirSync(directory, { recursive: true })
  const temp = fs.mkdtempSync(path.join(directory, 'recovery-settings-'))
  const cfg = path.join(temp, 'custom-guard.json')
  const env = { SUPERPI_CONTEXT_GUARD: cfg }
  try {
    eq(readGuardSettingsSync({ env }).autoRetryOnMalformed, true, '文件不存在时默认开启')
    fs.writeFileSync(cfg, '{ invalid', 'utf8')
    eq(readGuardSettingsSync({ env }).autoRetryOnMalformed, true, '坏 JSON 时默认开启')
    fs.writeFileSync(cfg, JSON.stringify({ enabled: true }), 'utf8')
    eq(readGuardSettingsSync({ env }).autoRetryOnMalformed, true, '字段缺失时默认开启')
    fs.writeFileSync(cfg, JSON.stringify({ autoRetryOnMalformed: false, autoRetryCooldownMs: 5000 }), 'utf8')
    eq(readGuardSettingsSync({ env }).autoRetryOnMalformed, false, '共享策略读自定义文件名中的关闭开关')
    eq(readGuardSettingsSync({ env }).autoRetryCooldownMs, 5000, '共享策略读自定义冷却')
    fs.writeFileSync(cfg, JSON.stringify({ autoRetryCooldownMs: -100 }), 'utf8')
    eq(readGuardSettingsSync({ env }).autoRetryCooldownMs, 0, '负数冷却夹到 0')
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }

  const handlers = new Map()
  const attemptedFromEditor = []
  extensionModule.default({
    on: (name, handler) => handlers.set(name, handler),
    sendUserMessage: (...args) => attemptedFromEditor.push(args),
  })
  const broken = { role: 'assistant', stopReason: 'stop', content: [{ type: 'thinking', thinking: '</｜｜DSML｜｜ calls>' }] }
  const healthy = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '完成。' }] }
  resetRunState()
  handlers.get('agent_start')({}, { mode: 'tui' })
  handlers.get('message_end')({ message: broken }, { mode: 'tui' })
  eq(runState.verdict?.kind, 'dsml-thinking', '终端显示共享的故障判据')
  eq(attemptedFromEditor.length, 0, '终端渲染器不会绕开 pi 边界另发一条恢复消息')
  handlers.get('message_end')({ message: healthy }, { mode: 'tui' })
  eq(runState.verdict, null, '健康响应清除之前的故障')
  handlers.get('message_end')({ message: broken }, { mode: 'rpc' })
  eq(runState.verdict, null, 'RPC 进程无需驱动 TUI 的故障界面')
  handlers.get('message_end')({ message: broken }, { mode: 'tui' })
  handlers.get('agent_settled')({ aborted: true }, { mode: 'tui' })
  eq(runState.verdict, null, '主动停止后终端没有残留继续提示')
  eq(runState.phase, 'idle', '主动停止后恢复空闲')
}

/* ---- 0.15.7：识别到 ≠ 生效，事件处理器必须真的改动状态 ---- */

/**
 * 这条判据来自一次「静默失效」事故（0.15.6）。
 *
 * `message_end` 处理器里写的是 `markRunFailed()` —— 一个**不存在的函数**。
 * 它被 `try/catch` 包着，`ReferenceError` 被吞掉，于是：
 *   识别到了畸形输出 → 什么也没做 → 用户看到 `✖ Working` 变红、文案仍是 `Working`
 *   → 完全不知道发生了什么。
 *
 * 更糟的是门禁当时是绿的：因为判据只测了 `isMalformedToolCall` 的返回值，
 * 没测「处理器被执行后状态是否真的变了」。
 *
 * 所以这里改为**通过事件处理器驱动**、再断言状态，而不是只测纯函数：
 * 纯函数对 + 接线错 = 功能不存在。
 */
{
  const handlers = new Map()
  const fakePi = {
    on: (name, fn) => { handlers.set(name, fn); return () => handlers.delete(name) },
    registerCommand: () => {},
    registerTool: () => {},
    sendMessage: () => {},
    setStatus: () => {},
    getContext: () => ({}),
  }
  const fakeCtx = {
    ui: {
      setEditorComponent: () => {},
      setWorkingVisible: () => {},
      setFooter: () => {},
      setStatus: () => {},
      select: async () => undefined,
      editor: async () => undefined,
      confirm: async () => false,
      notify: () => {},
      custom: () => ({}),
      theme: { fg: (_k, t) => t },
    },
    cwd: process.cwd(),
    sessionId: 'gate-test',
  }
  const entry = extensionModule.default ?? extensionModule.activate ?? extensionModule
  const activate = typeof entry === 'function' ? entry : extensionModule.activate
  if (typeof activate === 'function') {
    try { activate(fakePi, fakeCtx) } catch { /* 假 ctx 覆盖不全时忽略 */ }
  }

  const onMessageEnd = handlers.get('message_end')
  ok(onMessageEnd !== undefined, 'message_end 处理器已注册')

  if (onMessageEnd !== undefined) {
    // 故障形态（thinking 型）：处理器跑完后，状态必须真的变成"畸形失败"
    resetRunState()
    markRunStart(Date.now())
    onMessageEnd({ type: 'message_end', message: {
      role: 'assistant',
      stopReason: 'stop',
      content: [{ type: 'thinking', thinking: 'x</thinking>\n</｜｜DSML｜｜ calls>' }],
    } })
    eq(runState.verdict?.kind, 'dsml-thinking', '处理器识别到没交付后 verdict 必须真的置位（防止调错函数名被 try/catch 吞掉）')
    eq(runState.failed, true, '同时 failed 必须为真（图标才会变红）')
    ok(workingLabel(Date.now(), true).includes('DSML'), '文案必须点明原因，而不是只显示 Working')

    // 正常消息不应误伤
    resetRunState()
    markRunStart(Date.now())
    onMessageEnd({ type: 'message_end', message: {
      role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '正常回复' }],
    } })
    eq(runState.verdict, null, '正常回复不应把本轮标记为没交付')
    resetRunState()
  }
}

// --- 定时器生命周期：这才是「动效不会静止」的真正保障
{
  resetRunState()
  // 桩 tui：只记录被敲了几次
  let ticks = 0
  bindFrameTarget({ requestRender: () => { ticks += 1 } })

  eq(isAnimating(), false, 'idle 时不转')

  const started = startAnimation()
  eq(started, true, '首次启动真的起了定时器')
  eq(isAnimating(), true, '启动后在转')

  // 幂等：重复启动不能叠加（否则每轮 agent_start 泄漏一个定时器）
  eq(startAnimation(), false, '重复启动返回 false（幂等，不叠加定时器）')
  eq(startAnimation(), false, '再启动一次仍然 false')

  stopAnimation()
  eq(isAnimating(), false, '停止后在 idle')
  eq(stopAnimation(), undefined, '重复停止不抛（幂等）')

  // 没有可敲的目标时不许假装启动
  bindFrameTarget(null)
  eq(startAnimation(), false, '没有渲染目标时启动失败（不空转）')
  eq(isAnimating(), false, '启动失败后仍是 idle')

  resetRunState()
}

// --- 状态变迁自动开关表（agent_start 开、agent_settled 关）
{
  resetRunState()
  bindFrameTarget({ requestRender: () => {} })
  markRunStart()
  eq(isAnimating(), true, 'markRunStart 自动开动效（不需要调用方记得）')
  markRunSettled()
  eq(isAnimating(), false, 'markRunSettled 自动停动效（idle 不烧 CPU）')
  markRunStart()
  eq(isAnimating(), true, '下一轮又能开')
  resetRunState()
  eq(isAnimating(), false, 'resetRunState 停表')
  bindFrameTarget(null)
}

// --- 定时器真的在敲渲染通道（这是"不会静止"的直接证据）
{
  resetRunState()
  let ticks = 0
  bindFrameTarget({ requestRender: () => { ticks += 1 } })
  startAnimation()
  await new Promise(resolve => setTimeout(resolve, FRAME_INTERVAL_MS * 2 + 60))
  stopAnimation()
  ok(ticks >= 2, '定时器在真实时间里至少敲了 2 次渲染通道（实测 ' + ticks + ' 次）')
  bindFrameTarget(null)
  resetRunState()
}

// --- 渲染目标抛异常时必须自己停表，不能每 160ms 抛一次
{
  resetRunState()
  bindFrameTarget({ requestRender: () => { throw new Error('tui gone') } })
  startAnimation()
  await new Promise(resolve => setTimeout(resolve, FRAME_INTERVAL_MS + 60))
  eq(isAnimating(), false, '渲染通道抛错后自动停表（不留悬空定时器）')
  bindFrameTarget(null)
  resetRunState()
}

// --- 真入口：编辑器构造时必须把渲染通道交给定时器
{
  resetRunState()
  makeEditor('')
  // makeEditor 造的是 SuperPiEditor（有 tui.requestRender 的那个）
  markRunStart()
  eq(isAnimating(), true, '编辑器构造后即绑定目标，markRunStart 能直接开动效')
  resetRunState()
}

/* ---------------------------------------------------------------- 集成断言 */

/** 直接看私有状态（TS 的 private 只在类型层，运行时是普通属性）。 */
const anchorOf = editor => editor.selAnchor

// Ctrl+A 全选（覆盖 pi 的 cursorLineStart），且不改内容
{
  const { editor } = makeEditor('hello world')
  editor.handleInput(KEY.ctrlA)
  eq(editor.getCursor().col, 11, 'Ctrl+A 后光标在行尾')
  eq(JSON.stringify(anchorOf(editor)), JSON.stringify({ line: 0, col: 0 }), 'Ctrl+A 后锚点在行首')
  eq(editor.getText(), 'hello world', 'Ctrl+A 不修改内容')
}

// Home 仍能到行首（pi 的原始语义没被破坏）
{
  const { editor } = makeEditor('hello')
  editor.handleInput(KEY.home)
  eq(editor.getCursor().col, 0, 'Home 仍然是行首')
}

// Ctrl+C：内容**不消失**（用户报的 bug 回归）
{
  const { editor } = makeEditor('hello world')
  editor.handleInput(KEY.ctrlA)
  editor.handleInput(KEY.ctrlC)
  await settle()
  eq(editor.getText(), 'hello world', 'Ctrl+C 之后内容仍在（bug 回归）')
  eq(JSON.stringify(anchorOf(editor)), JSON.stringify({ line: 0, col: 0 }), 'Ctrl+C 之后选区保留')
}

// Ctrl+C 只复制选中部分
{
  const { editor } = makeEditor('hello world')
  editor.handleInput(KEY.home)
  for (let i = 0; i < 5; i += 1) editor.handleInput(KEY.right)
  eq(editor.getCursor().col, 5, '光标已到第 5 列')
  editor.handleInput(KEY.shiftEnd)
  editor.handleInput(KEY.ctrlC)
  await settle()
  eq(editor.getText(), 'hello world', 'Ctrl+C 只复制选中部分时不改内容')
}

// Ctrl+X 剪切选区
{
  const { editor } = makeEditor('hello world')
  editor.handleInput(KEY.home)
  editor.handleInput(KEY.shiftEnd)
  editor.handleInput(KEY.ctrlX)
  eq(editor.getText(), '', 'Ctrl+X 剪走选区')
}

// Ctrl+X 无选区 = 剪切全文
{
  const { editor } = makeEditor('abc')
  editor.handleInput(KEY.ctrlX)
  eq(editor.getText(), '', 'Ctrl+X 无选区剪走全文')
}

// Ctrl+C 无选区 = 复制全文且不清空
{
  const { editor } = makeEditor('abc')
  editor.handleInput(KEY.ctrlC)
  await settle()
  eq(editor.getText(), 'abc', 'Ctrl+C 无选区不清空')
}

// 空编辑器 Ctrl+C 必须放行给 pi（否则两次 Ctrl+C 退出就失效了）
{
  const { editor } = makeEditor('')
  let reachedSuper = false
  const originalRender = editor.render
  editor.render = originalRender
  editor.handleInput(KEY.ctrlC)
  void reachedSuper
  ok(true, '空编辑器 Ctrl+C 不抛错')
}

// Shift+方向建立/扩展选区（真终端序列 \x1b[1;2C）
// setText 之后光标在行尾（与真实输入框一致），所以先 Home 再往右扩。
{
  const { editor } = makeEditor('abcdef')
  editor.handleInput(KEY.home)
  editor.handleInput(KEY.shiftRight)
  editor.handleInput(KEY.shiftRight)
  eq(JSON.stringify(anchorOf(editor)), JSON.stringify({ line: 0, col: 0 }), 'Shift+→ 锚点留在起点')
  eq(editor.getCursor().col, 2, 'Shift+→ 两次把光标推到第 2 列')
}

// 反向选区归一化
{
  const { editor } = makeEditor('abcdef')
  editor.handleInput(KEY.ctrlA)
  editor.handleInput(KEY.shiftLeft)
  const range = editor.selectionRange()
  eq(range.start.col, 0, 'Shift+Left 反向选区起点为 0')
  eq(range.end.col, 5, 'Shift+Left 反向选区终点为 5')
}

// Backspace / Delete 删除整个选区
{
  const { editor } = makeEditor('hello world')
  editor.handleInput(KEY.home)
  editor.handleInput(KEY.shiftEnd)
  editor.handleInput(KEY.backspace)
  eq(editor.getText(), '', 'Backspace 删掉整个选区')
}
{
  const { editor } = makeEditor('hello world')
  editor.handleInput(KEY.home)
  editor.handleInput(KEY.shiftEnd)
  editor.handleInput(KEY.delete)
  eq(editor.getText(), '', 'Delete 删掉整个选区')
}

// 可打印字符替换选区
{
  const { editor } = makeEditor('hello world')
  editor.handleInput(KEY.home)
  editor.handleInput(KEY.shiftEnd)
  editor.handleInput('X')
  eq(editor.getText(), 'X', '输入可打印字符替换选区')
}

// 跨行选区整体删除
{
  const { editor } = makeEditor('line1\nline2\nline3')
  editor.handleInput(KEY.ctrlA)
  editor.handleInput(KEY.backspace)
  eq(editor.getText(), '', '跨行选区被整体删除')
}

// Esc 清选区但把键交还给 pi（中断/取消仍归 pi）
{
  const { editor } = makeEditor('abc')
  editor.handleInput(KEY.ctrlA)
  ok(anchorOf(editor) !== null, 'Ctrl+A 建立了选区')
  editor.handleInput(KEY.esc)
  eq(anchorOf(editor), null, 'Esc 清掉选区')
}

// 普通方向键打断选区
{
  const { editor } = makeEditor('abc')
  editor.handleInput(KEY.ctrlA)
  editor.handleInput(KEY.left)
  eq(anchorOf(editor), null, '普通方向键清掉选区')
}

// 括号内粘贴：替换选区
{
  const { editor } = makeEditor('hello')
  editor.handleInput(KEY.home)
  editor.handleInput(KEY.shiftEnd)
  eq(editor.selectionText(), 'hello', '粘贴前选区覆盖全文')
  editor.handleInput('\x1b[200~pasted\x1b[201~')
  eq(editor.getText(), 'pasted', '粘贴内容替换选区')
}

// 渲染：无选区不涂；有选区涂反色且开合成对
{
  const { editor } = makeEditor('hello')
  const plain = editor.render(60)
  ok(!plain.some(line => line.includes('\x1b[7m')), '无选区时不涂反色')
  editor.handleInput(KEY.ctrlA)
  const painted = editor.render(60)
  const joined = painted.join('')
  ok(joined.includes('\x1b[7m'), '有选区时渲染出现反色')
  eq(painted.length, plain.length, '选区高亮不改变行数')
  eq(joined.split('\x1b[7m').length, joined.split('\x1b[27m').length, '反色开合成对')
}

// 自动补全打开时不抢方向键
{
  const { editor } = makeEditor('abc')
  editor.isShowingAutocomplete = () => true
  editor.handleInput(KEY.shiftRight)
  eq(anchorOf(editor) ?? null, null, '自动补全打开时不建立选区')
}

// 内容被外部替换（/compact 清空、切会话）后不越界、不抛错
{
  const { editor } = makeEditor('abcdef')
  editor.handleInput(KEY.ctrlA)
  editor.setText('')
  editor.setText('xy')
  editor.handleInput(KEY.backspace)
  ok(editor.getText() === 'xy' || editor.getText() === '', '内容被外部替换后删除不抛错')
}

/** 主题桩：必须是真 ANSI —— 字面标签会被 visibleWidth 当成可见字符，把排版算歪。 */
const ANSI = {
  dim: text => '[2m' + text + '[22m',
  accent: text => '[36m' + text + '[39m',
}

const stripAnsi = text => text.replace(/\x1b\[[0-9;:?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')

/* ------------------------------------------------------ 扩展注册与安装面 */

{
  const calls = []
  const fakePi = { on: (event, handler) => calls.push({ event, handler }) }
  defaultExport(fakePi)
  // 4 个状态事件（agent_start + tool_execution_start + tool_execution_end + agent_settled）
  // + session_start + session_switch + session_info_changed（标题重设）
  eq(calls.length, 9, '入口注册九个事件（状态机 6 + 会话 3）')
  ok(calls.every(c => typeof c.handler === 'function'), '入口注册的都是函数')
  const events = calls.map(c => c.event)
  for (const name of ['agent_start', 'tool_execution_start', 'tool_execution_update', 'tool_execution_end', 'agent_settled', 'message_end', 'session_start', 'session_switch', 'session_info_changed']) {
    ok(events.includes(name), `入口订阅了 ${name}`)
  }
  /**
   * 0.14.1：`tool_execution_start` 是**唯一**带 `args`（含 timeout）的事件。
   * 少订它，Working 行就只能显示一个一直涨的秒数 —— 那正是用户把"合法长等待"
   * 误判成"卡死"的根源（实测一轮累计 2028s、单命令 371~494s）。
   * 这条断言防止以后有人把它当成冗余事件删掉。
   */
  ok(events.includes('tool_execution_start'), '必须订阅 tool_execution_start（否则拿不到命令自带的上限）')
  ok(events.includes('tool_execution_update'), '必须订阅 tool_execution_update（否则无法区分在跑与静默）')
  const startHandler = calls.find(c => c.event === 'tool_execution_start')?.handler
  ok(typeof startHandler === 'function', 'tool_execution_start 有处理器')
  const factories = []
  const titles = []
  const footers = []
  const ctx = {
    mode: 'tui',
    sessionManager: { getCwd: () => 'D:\\projects\\SuperPi' },
    ui: {
      setEditorComponent: factory => factories.push(factory),
      setWorkingVisible: visible => { ctx.ui.workingVisible = visible },
      setTitle: title => titles.push(title),
      setFooter: factory => footers.push(factory),
    },
  }
  for (const call of calls) call.handler({}, ctx)
  eq(factories.length, 2, '两个会话事件都装了编辑器工厂')
  eq(ctx.ui.workingVisible, false, '关掉 pi 内置 Working 行（改由本扩展渲染状态）')
  // 0.9.9：cwd + settings/home 同一行、切换图标、可点的 max —— 都靠接管 footer 实现。
  eq(footers.length, 1, 'footer 只装一次（session_switch 不会叠层）')
  const footerTui = { renders: 0, requestRender() { this.renders += 1 } }
  const footerData = { getGitBranch: () => 'master', getExtensionStatuses: () => new Map(), getAvailableProviderCount: () => 1, onBranchChange: () => () => {} }
  // 这个 ctx 是照 **真实 ExtensionContext** 造的：有 model / thinkingLevel /
  // sessionManager / getContextUsage / getSettings，**没有 session**。
  // 0.9.9 首版就是从这里拿 ctx.session，真实环境恒 undefined → footer 第二行消失。
  ctx.model = { id: 'Deepseek-V4.1-Flash', provider: 'odys-deepseek', reasoning: true, contextWindow: 1000000 }
  ctx.thinkingLevel = 'max'
  ctx.sessionManager.getEntries = () => [
    { type: 'message', message: { role: 'assistant', usage: { input: 167000, output: 252000, cacheRead: 48000000, cacheWrite: 1100000 } } },
  ]
  ctx.getContextUsage = () => ({ tokens: 287000, contextWindow: 1000000, percent: 28.7 })
  ctx.getSettings = () => ({ compaction: { enabled: true } })
  ok(!('session' in ctx), '夹具照抄真实形状：ExtensionContext 里没有 session')
  const footerInstance = footers[0](footerTui, { fg: (t, x) => x }, footerData)
  ok(footerInstance instanceof SuperPiFooter, 'footer 工厂返回 SuperPiFooter')
  // **接线回归**：入口必须把真实 ctx 的字段透给 footer，否则第二行静默空掉。
  const liveRows = footerInstance.render(96)
  eq(liveRows.length, 2, '经入口接线后 footer 真的渲染两行（回归：最底部那行不能没）')
  ok(stripAnsi(liveRows[1]).includes('Deepseek-V4.1-Flash'), '第二行有模型名（入口把 ctx.model 透下去了）')
  ok(stripAnsi(liveRows[1]).includes('max'), '第二行有档位（入口把 ctx.thinkingLevel 透下去了）')
  ok(stripAnsi(liveRows[1]).includes('28.7%/1.0M'), '第二行有上下文（入口把 ctx.getContextUsage 透下去了）')
  ok(stripAnsi(liveRows[1]).includes('↑167k'), '第二行有 token 统计（入口把 ctx.sessionManager 透下去了）')
  // 标题必须盖住上游默认的 "π"：TUI 下叫 SuperPi，形状对齐 pi 的 "${APP_TITLE} - ${cwd}"。
  // 目录名与品牌同名时不重复拼（避免 "SuperPi - SuperPi"）。
  ok(titles.length > 0 && titles[0] === 'SuperPi', '窗口标题 = SuperPi（目录名与品牌同名时不重复），实际 ' + String(titles[0]))
  const tui = { renders: 0, terminal: { rows: 40, columns: 100 }, requestRender() { this.renders += 1 } }
  const built = factories[0](tui, theme, { matches: () => false })
  ok(built instanceof SuperPiEditor, '工厂返回 SuperPiEditor 实例')
  // 状态行由本扩展自己画（要按状态换色），所以 pi 内置的 Working 行必须关掉，否则会出现两条。
  eq(built.embedWorkingStatus, false, '关掉 pi 内置状态嵌入（本扩展自绘状态行）')
}

// 标题接管：RPC 模式绝不能设（面板把 setTitle 的值当会话名回退，会污染显示）
{
  const calls = []
  defaultExport({ on: (event, handler) => calls.push({ event, handler }) })
  const titles = []
  const ctx = {
    mode: 'rpc',
    sessionManager: { getCwd: () => 'D:\\projects\\SuperPi' },
    ui: { setEditorComponent: () => {}, setWorkingVisible: () => {}, setTitle: t => titles.push(t) },
  }
  for (const call of calls) call.handler({}, ctx)
  eq(titles.length, 0, 'RPC 模式不设终端标题（避免污染面板会话名）')
}

// 标题兜底：拿不到 cwd 时也要显示品牌名，且不能抛
{
  const calls = []
  defaultExport({ on: (event, handler) => calls.push({ event, handler }) })
  const titles = []
  const ctx = {
    mode: 'tui',
    sessionManager: { getCwd: () => { throw new Error('boom') } },
    ui: { setEditorComponent: () => {}, setWorkingVisible: () => {}, setTitle: t => titles.push(t) },
  }
  for (const call of calls) call.handler({}, ctx)
  ok(titles.length > 0 && titles[0] === 'SuperPi', 'cwd 取不到时标题回落为 SuperPi，实际 ' + String(titles[0]))
}

// 没有 UI 的环境（print/json 模式）不能抛
{
  const calls = []
  defaultExport({ on: (event, handler) => calls.push({ event, handler }) })
  for (const call of calls) call.handler({}, {})
  for (const call of calls) call.handler({}, { ui: {} })
  ok(true, '没有 ui / 没有 setEditorComponent 时静默跳过')
}

// 安装面：目录解析 + 装/卸闭环（用临时目录，不碰真的 ~/.pi）
{
  eq(
    resolveExtensionDir({ PI_CONFIG_DIR: 'C:\\tmp\\cfg' }).endsWith(path.join('cfg', 'agent', 'extensions')),
    true,
    'resolveExtensionDir 跟随 PI_CONFIG_DIR',
  )
  eq(EXTENSION_FILE_NAME, 'superpi-editor.ts', '扩展文件名固定')
  const { install, remove, status, EXTENSION_FILES, resolveUserSkillsDir } = await import('../tools/install-pi-extension.mjs')
  const dir = path.join(process.env.TEMP ?? process.env.TMPDIR ?? '.', `superpi-ext-test-${process.pid}`)
  /**
   * 必须把 `env` 也指向一个假 home（0.15.0 修）。
   *
   * 踩过的坑：这里原本只传 `dir`，于是 `install`/`remove` 内部用
   * `resolveUserSkillsDir(options.env ?? process.env)` 回落到**真实的 process.env** ——
   * 也就是操作真实的 `~/.agents/skills`。而 `remove()` 会把 skill 一并删掉（那是它的正确行为），
   * 结果**每跑一次 tui-editor 就删掉用户的两个 skill**，之后 `check-carriers` 报载体缺失、
   * 整个 `npm test` 被 `&&` 链卡在第一步。
   *
   * 症状看起来像"环境问题"，实际是**测试污染真实环境** —— 属于最隐蔽的一类缺陷：
   * 测试自己是绿的，损坏发生在测试之外。所以门禁里另有一条断言：
   * 跑完之后真实 skills 目录必须仍然完好。
   */
  const fakeHome = path.join(process.env.TEMP ?? process.env.TMPDIR ?? '.', `superpi-home-${process.pid}`)
  const testEnv = { USERPROFILE: fakeHome, HOME: fakeHome }
  // 测试开始前，真实用户 skill 目录里有哪些（用于末尾的"没被污染"断言）。
  const realSkillSnapshot = (() => {
    try {
      const dir = resolveUserSkillsDir(process.env)
      return fs.readdirSync(dir).filter(name => fs.existsSync(path.join(dir, name, 'SKILL.md')))
    } catch {
      return []
    }
  })()
  const state = status({ dir, env: testEnv })
  ok(state.sourceExists, '扩展源文件可读')
  const sources = listRuntimeFiles(root).filter(file => file.startsWith('extensions/'))
  eq(EXTENSION_FILES.length, sources.length, '安装清单数量与扩展源码一致')
  eq(EXTENSION_FILES.map(file => file.name).sort().join(','), sources.map(file => path.basename(file)).join(','),
    '安装目标名称与扩展源码一致')
  const installed = install({ dir, env: testEnv })
  eq(installed.code, 0, 'install 成功')
  for (const file of EXTENSION_FILES) {
    ok(fs.existsSync(path.join(dir, file.name)), '安装后有 ' + file.name)
  }
  eq(status({ dir, env: testEnv }).identical, true, '安装后 editor 内容与源一致')
  eq(status({ dir, env: testEnv }).complete, true, '全部扩展文件一致 → complete')
  eq(install({ dir, env: testEnv }).code, 0, 'install 幂等')

  // 真机那一步：装到临时 agentDir 后，用 **pi 自己的扩展加载器**加载一遍。
  // 这一步才能证“装完 pi 真的能认”，jiti 单测只能证语法/行为对。
  const loaderEntry = path.join(pi.packageDir, 'dist', 'core', 'extensions', 'loader.js')
  if (fs.existsSync(loaderEntry)) {
    const agentDir = path.join(path.dirname(dir), `superpi-agent-${process.pid}`)
    install({ dir: path.join(agentDir, 'extensions') })
    const loader = await import(pathToFileURL(loaderEntry).href)
    const result = await loader.discoverAndLoadExtensions([], root, agentDir, undefined, loader.createExtensionRuntime())
    const found = (result.extensions ?? []).find(entry => String(entry.path).includes(EXTENSION_FILE_NAME))
    ok(Boolean(found), 'pi 的扩展加载器发现了 superpi-editor')
    eq(found?.error ?? null, null, 'pi 加载 superpi-editor 无错误')
    // 规则扩展也要能被真加载器认（它 import 同目录的 .mjs，路径写错就是一条 extension error）。
    const rulesFound = (result.extensions ?? []).find(entry => String(entry.path).includes('superpi-rules.ts'))
    ok(Boolean(rulesFound), 'pi 的扩展加载器发现了 superpi-rules')
    eq(rulesFound?.error ?? null, null, 'pi 加载 superpi-rules 无错误（含 ./superpi-rules.mjs 的解析）')
    ok([...(rulesFound?.commands?.keys?.() ?? [])].includes('superpi-rules'), '规则扩展注册了 superpi-rules 命令')
    ok([...(rulesFound?.eventHandlers?.keys?.() ?? [])].length >= 0, '规则扩展加载后 pi 侧状态可读')
    eq((result.errors ?? []).length, 0, '整个 agentDir 加载零错误')
    fs.rmSync(agentDir, { recursive: true, force: true })
  } else {
    process.stdout.write('  (skip) 没有 core/extensions/loader.js，跳过 pi 加载器实装验证\n')
  }

  const removed = remove({ dir, env: testEnv })
  eq(removed.code, 0, 'remove 成功')
  for (const file of EXTENSION_FILES) {
    ok(!fs.existsSync(path.join(dir, file.name)), '卸载后 ' + file.name + ' 消失')
  }
  eq(remove({ dir, env: testEnv }).code, 0, 'remove 幂等（未安装也不报错）')
  fs.rmSync(dir, { recursive: true, force: true })
  /**
   * 关键回归断言：**真实的用户 skill 目录必须毫发无损**。
   *
   * 这条是专门为上面那个缺陷加的 —— 当时的 bug 是测试自己把真实目录删了，
   * 而测试本身全绿。没有这条断言，同样的污染会再次悄无声息地发生，
   * 表现只是"npm test 卡在第一步载体缺失"，排查方向会被引到环境上。
   *
   * 判据用「测试开始前的快照」对比，而不是「现在是否存在」：
   * 只有测试前就有的名字才要求测试后仍然存在（全新机器上本来就没有，不该误报）。
   */
  {
    const realSkillsDir = resolveUserSkillsDir(process.env)
    const nowPresent = realSkillSnapshot.filter(name => {
      try { return fs.existsSync(path.join(realSkillsDir, name, 'SKILL.md')) } catch { return true }
    })
    // 用 join 比较（eq 走 JSON.stringify，对同内容不同顺序敏感，会产生假失败）。
    eq(nowPresent.slice().sort().join(','), realSkillSnapshot.slice().sort().join(','), '测试没有删掉真实的用户 skill 目录（禁止测试污染环境）')
  }
  fs.rmSync(fakeHome, { recursive: true, force: true })
}


/* ---------------------------------------------- 输入框外观与入口（0.9.4） */

const rowIndexOf = (rows, needle) => rows.findIndex(row => stripAnsi(row).includes(needle))
const columnOf = (rows, y, needle) => stripAnsi(rows[y] ?? '').indexOf(needle)

/**
 * ①z 上边框真的画出「工具 · 上限」（0.14.1）。
 *
 * 纯函数层（`workingLabel`）已经测过文案，但那只证明"文案函数返回了字符串"——
 * 上边框有没有把它画出来是另一回事（0.9.4~0.9.7 的教训：改了却从未生效）。
 * 所以这里走真 `render()`，从渲染结果里读。
 */
{
  resetRunState()
  markRunStart()
  markToolStart('bash', { command: 'node test/mutation.test.mjs', timeout: 960 }, Date.now())
  const { editor } = makeEditor('hello')
  const rows = editor.render(120)
  const top = stripAnsi(rows[0])
  ok(top.includes('Working'), '上边框画出 Working')
  ok(top.includes('bash'), '上边框画出当前工具名（区分「在跑」与「卡死」的关键）')
  ok(top.includes('上限'), '上边框画出命令自设上限')
  eq(top.startsWith('┌'), true, '加了工具段之后仍是直角上边框')

  // 窄宽度：工具段必须让位，但 Working 与累计时长要留下，且框线不能错位
  const narrowRows = editor.render(30)
  const narrowTop = stripAnsi(narrowRows[0])
  ok(narrowTop.startsWith('┌'), '窄宽度下仍是上边框')
  ok(narrowTop.includes('Working') || narrowTop.includes('◐'), '窄宽度下仍有状态指示')
  eq(narrowRows.every(row => tuiModule.visibleWidth(row) === tuiModule.visibleWidth(narrowRows[0])), true, '窄宽度下每行显示宽度一致（退化不让框线歪）')

  resetRunState()
  const idleRows = editor.render(120)
  ok(!stripAnsi(idleRows[0]).includes('上限'), 'idle 时上边框不出现上限段')
}

/**
 * ①z2 双宽图标不能让框线歪（0.14.2）。
 *
 * 图标从 1 列换成 2 列的 emoji 后，上边框的行宽账目**全部重算**：
 * 少算 1 列会让上边框比下边框短，多算会让它撑出去 —— 两种都是"框歪了"。
 * 所以在六个宽度上逐一量：每行 visibleWidth 必须恒等于目标宽度。
 * 这条同时覆盖了窄档退让（120→20 会依次丢掉工具段与文案）。
 */
{
  resetRunState()
  markRunStart()
  markToolStart('bash', { timeout: 960 })
  for (const width of [120, 80, 60, 40, 30, 20]) {
    const rows = makeEditor('x').editor.render(width)
    const widths = new Set(rows.map(row => tuiModule.visibleWidth(row)))
    eq(widths.size, 1, `宽度 ${width}：每行显示宽度一致（双宽图标没让框线歪）`)
    eq([...widths][0], width, `宽度 ${width}：行宽恰为 ${width}`)
  }
  resetRunState()
}

// ① 框线 80% 白 + 四边闭合 + 直角
{
  const { editor } = makeEditor('hello')
  const rows = editor.render(60)
  eq(FRAME_RGB.join(','), '204,204,204', '框线色常量为 80% 白（255×0.8）')
  ok(rows[0].includes('[38;2;204;204;204m'), '上边框是 80% 白')
  ok(rows.some(row => stripAnsi(row).startsWith('└') && row.includes('[38;2;204;204;204m')), '下边框是 80% 白')
  // 直角：不允许出现圆角字符
  ok(!rows.some(row => /[╭╮╰╯]/.test(stripAnsi(row))), '框线是直角（不含 ╭╮╰╯）')
  ok(stripAnsi(rows[0]).startsWith('┌') && stripAnsi(rows[0]).endsWith('┐'), '上边框左右是直角')
  const boxBottom = rows.findIndex(row => stripAnsi(row).startsWith('└'))
  ok(boxBottom > 0, '找得到下边框')
  ok(stripAnsi(rows[boxBottom]).endsWith('┘'), '下边框右侧是直角')
  // 左右两侧闭合
  for (let i = 1; i < boxBottom; i += 1) {
    const plain = stripAnsi(rows[i])
    ok(plain.startsWith('│'), `框内第 ${i} 行左侧有框线`)
    ok(plain.endsWith('│'), `框内第 ${i} 行右侧有框线`)
  }
  // 框内每行等宽（框外那几行不参与）
  const widths = new Set(rows.slice(0, boxBottom + 1).map(row => tuiModule.visibleWidth(row)))
  eq([...widths].join(','), '60', '框内每行显示宽度都等于渲染宽度（框线不错位）')
}

// ② 上边框的运行状态：图标、文案和颜色随状态变化。
{
  const cases = [
    ['idle', () => resetRunState(), '○', '就绪'],
    ['running', () => markRunStart(Date.now() - 3000), null, 'Working · '],
    ['success', () => { markRunStart(); markRunSettled() }, '✔', '本轮已结束'],
    ['warning', () => { markRunStart(); markToolError(); markRunSettled() }, '✔', '本轮已结束 · 曾有错误'],
    ['error', () => {
      markRunStart()
      markUndelivered({ notice: { zh: '模型响应异常，可以继续。' } })
      markRunSettled()
    }, '✖', '模型响应异常，可以继续。'],
  ]
  for (const [phase, setup, icon, label] of cases) {
    setup()
    const { editor } = makeEditor('')
    const rows = editor.render(60)
    const topRow = stripAnsi(rows[0])
    ok(topRow.includes(label), `${phase}: 上边框显示 ${label}，实际 ${topRow}`)
    const rgb = STATUS_RGB[phase]?.join(';')
    ok(rgb !== undefined && rows[0].includes(`[38;2;${rgb}m`), `${phase}: 文案与图标用该状态的颜色`)
    if (icon) ok(topRow.includes(icon), `${phase}: 图标是 ${icon}`)
    // 0.14.2：running 改用四分之一圆旋转序列（◴◵◶◷），笔画更满、视觉更大。
    else ok(RUN_FRAMES.some(frame => topRow.includes(frame)), 'running: 图标是旋转帧之一')
  }
  const distinct = new Set([STATUS_RGB.idle, STATUS_RGB.success, STATUS_RGB.warning, STATUS_RGB.error].map(c => c?.join(',')))
  eq(distinct.size, 4, '空闲 / 顺利结束 / 结束带警告 / 失败四种颜色互不相同')
  resetRunState()
}

// ③ 粘贴路径带浅灰底色
{
  ok(isLikelyPath('E:\\xwechat_files\\a b\\0cf6.png'), 'Windows 绝对路径识别')
  ok(isLikelyPath('/home/x/a.png'), 'POSIX 绝对路径识别')
  eq(isLikelyPath('https://a.com/b.png'), false, 'URL 不算路径')
  eq(isLikelyPath('a/b'), false, '相对路径不算路径')
  eq(isLikelyPath('/settings'), false, '斜杠命令不算路径')

  const pathText = 'E:\\xwechat_files\\wxid\\0cf6a4d3.png'
  const { editor } = makeEditor(`看这个 ${pathText}`)
  const rows = editor.render(80)
  const y = rowIndexOf(rows, '0cf6a4d3')
  ok(y > 0, '路径出现在渲染结果里')
  ok(rows[y].includes('\x1b[48;2;104;104;104m'), '路径带浅灰底色')
  ok(rows[y].includes('\x1b[49m'), '底色有闭合（不污染后续字符）')
  // 普通文字不带底色
  const { editor: plainEditor } = makeEditor('就是一段普通话')
  const plainRows = plainEditor.render(80)
  ok(!plainRows.some(row => row.includes('\x1b[48;2;104;104;104m')), '普通文字不带路径底色')
}

// ④ settings / home 入口搬进 footer：与「项目名 (分支)」同行，右侧；小写
{
  const dimmed = label => '[2m' + label + '[22m'
  const { editor } = makeEditor('', { hooks: { dim: dimmed } })
  const rows = editor.render(60)
  const boxBottom = rows.findIndex(row => stripAnsi(row).startsWith('└'))
  ok(boxBottom > 0, '找得到下边框')
  // 0.9.9 起框外只剩 settings 展开出来的子菜单；两个入口由 footer 画。
  const outside = rows.slice(boxBottom + 1)
  eq(outside.length, 0, '输入框自己的框外不再有入口行（settings/home 移到 footer）')
  eq(EDITOR_ACTIONS.map(a => a.label).join(','), 'settings,home', '两个入口的文案与顺序')
}

/**
 * 造一个**形状正确**的扩展 ctx。
 *
 * 关键教训（0.9.9 首版翻车）：`ExtensionContext` **没有 `session`** —— 它只有
 * `model / thinkingLevel / sessionManager / getContextUsage() / getSettings()`。
 * 首版从 `ctx.session` 拿 AgentSession 去 new pi 的 FooterComponent，真实环境里
 * `ctx.session` 恒 undefined，内层 footer 建不出来，用户看到的就是「窗口最底部
 * 那一行信息没有了」。当时的门禁喂了假的 `ctx.session`，所以测试全绿 ——
 * **测 UI 的假数据必须照抄上游真实形状**，否则门禁只证明自己和自己一致。
 */
function makeExtCtx({ finished = true, level = 'max' } = {}) {
  const entries = finished
    ? [
        { type: 'message', message: { role: 'assistant', usage: { input: 1200, output: 340, cacheRead: 41000, cacheWrite: 1800 } } },
        { type: 'message', message: { role: 'user' } },
      ]
    : []
  return {
    model: { id: 'Deepseek-V4.1-Flash', provider: 'odys-deepseek', reasoning: true, contextWindow: 1000000 },
    thinkingLevel: level,
    sessionManager: {
      getCwd: () => ['D:', 'my_projects', 'SuperPi', 'SuperPi'].join(path.sep),
      getEntries: () => entries,
      getSessionName: () => undefined,
    },
    getContextUsage: () => ({ tokens: 276000, contextWindow: 1000000, percent: 27.6 }),
    getSettings: () => ({ compaction: { enabled: true } }),
  }
}

const makeFooterData = () => ({
  getGitBranch: () => 'master',
  getExtensionStatuses: () => new Map(),
  getAvailableProviderCount: () => 1,
  onBranchChange: () => () => {},
})

{
  const handlers = new Map()
  const submitted = []
  let footer
  const ctx = {
    ...makeExtCtx(), mode: 'tui', isIdle: () => true,
    ui: { setFooter: factory => {
      footer = factory({ requestRender() {} }, { fg: (_token, text) => text }, makeFooterData())
    } },
  }
  extensionModule.default({ on: (name, fn) => handlers.set(name, fn), sendUserMessage: text => submitted.push(text) })
  handlers.get('session_start')({}, ctx)
  ok(footer !== undefined, '真实终端接线安装了 footer')
  handlers.get('agent_start')({}, ctx)
  handlers.get('message_end')({ message: { role: 'assistant', stopReason: 'stop', content: [] } }, ctx)
  ok(!stripAnsi(footer.render(100)[0]).includes('继续'), '运行期间继续入口不可点击')
  handlers.get('agent_settled')({ aborted: false }, ctx)
  const column = tuiModule.visibleWidth(stripAnsi(footer.render(100)[0]).split('继续')[0])
  ok(stripAnsi(footer.render(100)[0]).includes('继续'), '失败结束后终端也有继续入口')
  // 一次真实点击 = press → release → pi-tui 合成的 click。这里喂 press+click 两段：
  // 只喂 press 的那版在 0.60.1 之前也能过 —— 因为它把「按下」当成了动作，
  // 正是用户报的「点一下执行两次」的同一条缺陷。
  for (let round = 0; round < 2; round += 1) {
    footer.handleMouse({ type: 'press', x: column, y: 0, button: 'left' })
    footer.handleMouse({ type: 'click', x: column, y: 0, button: 'left' })
  }
  eq(submitted.join(','), '继续', '点击从同一会话继续，重复点击不再提交')
  resetRunState()
}

// ④c footer：`项目名 (分支)  ⇄` + 右对齐的 `settings  home`（用户 0.9.9 的第一条要求）
{
  const dimmed = label => '\x1b[2m' + label + '\x1b[22m'
  const tui = { renders: 0, requestRender() { this.renders += 1 } }
  const actions = []
  const footer = new SuperPiFooter(tui, { fg: (t, x) => ANSI[t === 'accent' ? 'accent' : 'dim'](x) }, makeFooterData(), {
    ctx: { ...makeExtCtx(), menuOpen: false, onFooterAction: kind => actions.push(kind) },
  })
  const rows = footer.render(100)
  eq(rows.length, 2, 'footer 两行（项目行 + 统计/模型行）')
  const first = stripAnsi(rows[0])
  ok(first.includes('SuperPi (master)'), '第一行是 项目名 (分支)')
  ok(first.includes(SWITCH_ICON), '项目名右侧有切换图标')
  ok(first.indexOf(SWITCH_ICON) > first.indexOf('(master)'), '切换图标紧贴项目名右侧')
  ok(first.includes('settings') && first.includes('home'), 'settings/home 与项目名同一行')
  ok(first.trimEnd().endsWith('home'), 'settings/home 右对齐')
  ok(!first.includes('Home'), 'home 必须小写（用户明确要求）')
  ok(rows[0].includes(dimmed('settings')), 'settings 平时是 dim（与模型名同色）')
  // 第二行：统计 + 模型名 + 档位都得在（用户报的「最底部那行没了」就是这里空掉）
  const second = stripAnsi(rows[1])
  ok(second.includes('Deepseek-V4.1-Flash'), '第二行有模型名')
  ok(second.includes('max'), '第二行有推理档位')
  ok(second.includes('27.6%/1.0M'), '第二行有上下文百分比')
  ok(second.includes('↑'), '第二行有 token 统计（↑ 输入）')
  ok(second.trimEnd().endsWith('max'), '模型/档位右对齐')
  eq(SWITCH_ICON, String.fromCharCode(0x21c4), '切换图标是 U+21C4（单列宽，不会撑歪项目行）')
  void actions
}

// ④c2 回归：**没有 `ctx.session` 时第二行也必须在**（0.9.9 首版就是这里空掉）
{
  const tui = { requestRender() {} }
  const extCtx = makeExtCtx()
  ok(!('session' in extCtx), '夹具照抄真实形状：ExtensionContext 里没有 session')
  const footer = new SuperPiFooter(tui, { fg: (t, x) => x }, makeFooterData(), { ctx: extCtx })
  const rows = footer.render(100)
  eq(rows.length, 2, '没有 ctx.session 也渲染出两行（回归：最底部那行不能再消失）')
  ok(stripAnsi(rows[1]).includes('Deepseek-V4.1-Flash'), '第二行仍有模型名')
}

// ④c3 极端兜底：ctx 什么字段都没有时，第一行照样在，且不抛
{
  const footer = new SuperPiFooter({ requestRender() {} }, { fg: (t, x) => x }, makeFooterData(), { ctx: {} })
  const rows = footer.render(80)
  ok(rows.length >= 1, '空 ctx 也至少渲染出项目行')
  ok(stripAnsi(rows[0]).includes('settings'), 'settings 仍在')
  eq(stripAnsi(rows[0]).includes(undefined), false, '不出现 undefined 字样')
}

// ④d footer 点击：项目名/图标 → 项目列表，模型名 → /model，max → /thinking
{
  const emitted = []
  const make = () =>
    new SuperPiFooter({ requestRender() {} }, { fg: (t, x) => x }, makeFooterData(), {
      ctx: { ...makeExtCtx(), onFooterAction: kind => emitted.push(kind) },
    })
  const footer = make()
  const rows = footer.render(80)
  const pick = (rowIndex, needle) => {
    const plain = stripAnsi(rows[rowIndex])
    const at = plain.indexOf(needle)
    ok(at >= 0, `行 ${rowIndex} 里有 ${needle}`)
    return at
  }
  footer.handleMouse({ type: 'click', button: 'left', x: pick(0, SWITCH_ICON), y: 0 })
  eq(emitted.at(-1), 'project', '点切换图标 → 项目列表')
  footer.handleMouse({ type: 'click', button: 'left', x: pick(1, 'Deepseek'), y: 1 })
  eq(emitted.at(-1), 'model', '点模型名 → /model')
  footer.handleMouse({ type: 'click', button: 'left', x: pick(1, 'max'), y: 1 })
  eq(emitted.at(-1), 'thinking', '点 max → /thinking（用户第三条要求）')
}

// ④d2 回归：settings / home 必须在**第一行**上有命中区（0.9.9 漏登记 → 用户点不动）
{
  const emitted = []
  const footer = new SuperPiFooter({ requestRender() {} }, { fg: (t, x) => x }, makeFooterData(), {
    ctx: { ...makeExtCtx(), onFooterAction: kind => emitted.push(kind) },
  })
  const rows = footer.render(96)
  const clickOn = (needle, rowIndex) => {
    const at = stripAnsi(rows[rowIndex]).indexOf(needle)
    ok(at >= 0, `第 ${rowIndex} 行里有 ${needle}`)
    // 点这个词的**第一个字符**，模拟用户真的点在文字上
    const result = footer.handleMouse({ type: 'click', button: 'left', x: at, y: rowIndex })
    ok(result && result.handled, `点 ${needle} 必须被 footer 消费`)
    return at
  }
  clickOn('settings', 0)
  eq(emitted.at(-1), 'settings', '点 settings → settings（回归：0.9.9 这里漏了 hits.push）')
  clickOn('home', 0)
  eq(emitted.at(-1), 'home', '点 home → home')
  // 点每个词的**最后一个字符**也要中（命中区宽度算错就会漏）
  const plain = stripAnsi(rows[0])
  const homeEnd = plain.indexOf('home') + 'home'.length - 1
  footer.handleMouse({ type: 'click', button: 'left', x: homeEnd, y: 0 })
  eq(emitted.at(-1), 'home', 'home 的最后一个字符也在命中区内')
  const setEnd = plain.indexOf('settings') + 'settings'.length - 1
  footer.handleMouse({ type: 'click', button: 'left', x: setEnd, y: 0 })
  eq(emitted.at(-1), 'settings', 'settings 的最后一个字符也在命中区内')
  // 两个词之间的空隙不该命中任何东西（否则会把相邻入口吞掉）
  const gapX = plain.indexOf('settings') + 'settings'.length + 1
  const before = emitted.length
  const gapResult = footer.handleMouse({ type: 'click', button: 'left', x: gapX, y: 0 })
  eq(emitted.length, before, '两个入口之间的空格不触发动作')
  eq(gapResult, undefined, '空隙上返回 undefined，交回 pi')
}

// ④d2b 真闭环：footer 点击 settings 后，编辑器下一帧必须出现菜单行。
// 只测 footer 的 action 回调会漏掉 CustomEditor 外层缓存导致的「点了没展开」。
{
  const handlers = new Map()
  let editorFactory
  let footerFactory
  const ctx = {
    mode: 'tui',
    model: makeExtCtx().model,
    thinkingLevel: 'max',
    sessionManager: makeExtCtx().sessionManager,
    getContextUsage: () => makeExtCtx().getContextUsage(),
    getSettings: () => makeExtCtx().getSettings(),
    isIdle: () => true,
    ui: {
      setWorkingVisible() {},
      setEditorComponent(factory) { editorFactory = factory },
      setFooter(factory) { footerFactory = factory },
      setTitle() {},
      notify() {},
      theme: { fg: (_token, text) => text },
    },
  }
  defaultExport({
    on: (name, handler) => handlers.set(name, handler),
    sendUserMessage() {},
  })
  handlers.get('session_start')({}, ctx)
  ok(typeof editorFactory === 'function', 'settings 闭环夹具安装了真实编辑器工厂')
  ok(typeof footerFactory === 'function', 'settings 闭环夹具安装了真实 footer 工厂')
  const tui = { renders: 0, terminal: { rows: 40, columns: 120 }, requestRender() { this.renders += 1 } }
  const editor = editorFactory(tui, theme, { matches: () => false })
  let invalidations = 0
  const originalInvalidate = editor.invalidate.bind(editor)
  editor.invalidate = () => { invalidations += 1; originalInvalidate() }
  const footer = footerFactory(tui, { fg: (_token, text) => text }, makeFooterData())
  const before = editor.render(100)
  ok(!before.some(row => stripAnsi(row).includes('/settings')), '点击前没有 settings 菜单行')
  const footerRow = stripAnsi(footer.render(100)[0])
  const settingsAt = footerRow.indexOf('settings')
  ok(settingsAt >= 0, '真实 footer 第一行包含 settings')
  const click = footer.handleMouse({ type: 'click', button: 'left', x: settingsAt, y: 0 })
  ok(click?.handled === true, '真实 footer 消费 settings 点击')
  const after = editor.render(100).map(stripAnsi)
  ok(after.some(row => row.includes('/settings') || row.includes('settings')), '点击后下一帧真实编辑器出现 settings 菜单')
  ok(invalidations > 0, 'settings 点击让 CustomEditor 失效，清掉外层渲染缓存')
  ok(tui.renders > 0, 'settings 点击请求了重绘')
  resetRunState()
}

// ④d2c 真闭环（0.60.1）：**用 pi-tui 真实的鼠标合成器**跑一次真实点击。
//
// 用户报的现象：点 footer 的 settings，菜单弹出又立即收起。根因是「一次点击 = 两次
// 我们的 handleMouse」—— pi-tui 把一次点击切成 press → release → **合成 click**
// （tui-alt-screen.js:handleMouseEvent），而两处 handleMouse 都把 press 与 click
// 当成触发时机，于是 toggleMenu() 走了两遍（展开 → 立刻收起）。
//
// 以前的夹具直接喂 `{ type: 'click' }`，等于把上游的合成器换成了假动作 ——
// 它只证明「click 能触发动作」，证明不了「真实点一下触发几次」。所以这一段喂的是
// **SGR 原始终端字节**、走真的 TuiAltScreen、真的布局与命中区换算，中间不短路。
{
  const handlers = new Map()
  let editorFactory
  let footerFactory
  const submitted = []
  const ctx = {
    mode: 'tui',
    model: makeExtCtx().model,
    thinkingLevel: 'max',
    sessionManager: makeExtCtx().sessionManager,
    getContextUsage: () => makeExtCtx().getContextUsage(),
    getSettings: () => makeExtCtx().getSettings(),
    isIdle: () => true,
    ui: {
      setWorkingVisible() {},
      setEditorComponent(factory) { editorFactory = factory },
      setFooter(factory) { footerFactory = factory },
      setTitle() {},
      notify() {},
      theme: { fg: (_token, text) => text },
    },
  }
  defaultExport({ on: (name, handler) => handlers.set(name, handler), sendUserMessage() {} })
  handlers.get('session_start')({}, ctx)

  const terminal = {
    columns: 100, rows: 40, write() {}, restoreOnExit() {}, onInput() {},
    showCursor() {}, hideCursor() {}, start() {}, stop() {},
  }
  const realTui = new tuiModule.TuiAltScreen(terminal, false, undefined, { mouse: true })
  realTui.beforeTerminalStart()
  const editor = editorFactory(realTui, theme, { matches: () => false })
  editor.onSubmit = command => submitted.push(command)
  const footer = footerFactory(realTui, { fg: (_token, text) => text }, makeFooterData())
  const layout = new tuiModule.Container()
  layout.addChild(new tuiModule.Text('会话历史'))
  layout.addChild(editor)
  layout.addChild(footer)
  realTui.setLayoutRoot(layout)

  const frame = () => {
    realTui.renderNow(true)
    return realTui.getScreenLines().map(stripAnsi)
  }
  handlers.get('agent_start')({}, ctx)
  handlers.get('tool_execution_end')({ toolCallId: 'probe', isError: true }, ctx)
  handlers.get('tool_execution_end')({ toolCallId: 'retry', isError: false }, ctx)
  ok(frame().some(line => line.includes('Working · ')), '中途有错误时屏幕仍显示正在运行')
  handlers.get('message_end')({ message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '已完成。' }] } }, ctx)
  handlers.get('agent_settled')({ aborted: false }, ctx)
  ok(frame().some(line => line.includes('✔ 本轮已结束 · 曾有错误')), '成功重试后，终端屏幕用勾号说明本轮已结束')
  const compact = stripAnsi(editor.render(22)[0])
  ok(compact.includes('✔ 本轮已结束') && tuiModule.visibleWidth(compact) === 22, '窄终端保留结束状态和勾号，框线对齐')
  handlers.get('agent_start')({}, ctx)
  ok(frame().some(line => line.includes('Working · ')), '下一轮恢复运行状态')
  handlers.get('agent_settled')({ aborted: true }, ctx)
  ok(frame().some(line => line.includes('○ 就绪')), '主动停止后回到就绪')
  /** 按屏幕上的文字位置，喂一次**真实**的按下 + 抬起（pi-tui 自己合成 click）。 */
  const realClick = (needle, row) => {
    const lines = frame()
    const line = lines[row]
    ok(typeof line === 'string', `第 ${row} 行存在（找 ${needle}）`)
    const column = line.indexOf(needle)
    ok(column >= 0, `第 ${row} 行有 ${needle}`)
    const x = column + 1
    const y = row + 1
    realTui.handleTerminalInput(`\x1b[<0;${x};${y}M`)
    realTui.handleTerminalInput(`\x1b[<0;${x};${y}m`)
    return frame()
  }
  const footerRowOf = lines => {
    const row = lines.findIndex(line => line.includes('settings') && line.includes('home'))
    ok(row >= 0, '屏幕上有 footer 行（settings / home）')
    return row
  }
  // 菜单行的形状是「`> ` / 两空格 + 命令名」（`> ` 是当前选中项）—— footer 那行的
  // settings 前面是项目路径，用这个前缀才不会把 footer 上的入口误当成菜单。
  const menuLabels = new Set(SETTINGS_COMMANDS.map(item => item.label))
  const isMenuLine = line => {
    const head = line.slice(0, 2)
    if (head !== '> ' && head !== '  ') return false
    return menuLabels.has(line.slice(2).trimEnd())
  }
  const showsMenu = lines => lines.some(isMenuLine)

  // ── 一次点击 → 恰好一次 toggle，菜单必须**留在**屏幕上 ──
  const before = frame()
  ok(!showsMenu(before), '点击前没有 settings 菜单行')
  let lines = realClick('settings', footerRowOf(before))
  ok(editor.isMenuOpen() === true, '一次真实点击后菜单是展开的（不是开关两次回到收起）')
  ok(showsMenu(lines), '一次真实点击后屏幕上**留着** settings 菜单行')

  // ── 键盘：真实终端字节要真的到菜单（不是只在单测里直接调 handleInput）──
  // 探针里必须把焦点交给编辑器，与真实 pi 的焦点位置一致；否则按键会在 TUI 层被丢掉。
  realTui.setFocus(editor)
  realTui.handleTerminalInput('\x1b[B')
  lines = frame()
  ok(lines.some(line => line.trimEnd() === '> ' + SETTINGS_COMMANDS[1].label), '真实 TUI 里 ↓ 把选中项移到第二项')
  realTui.handleTerminalInput('\x1b[A')
  lines = frame()
  ok(lines.some(line => line.trimEnd() === '> ' + SETTINGS_COMMANDS[0].label), '真实 TUI 里 ↑ 移回第一项')

  // ── 再点一次 → 收起（开关语义仍然成立）──
  lines = realClick('settings', footerRowOf(lines))
  ok(editor.isMenuOpen() === false, '第二次真实点击把菜单收起')
  ok(!showsMenu(lines), '收起后菜单行从屏幕消失')

  // ── 点菜单条目 → pi 的斜杠命令**只提交一次** ──
  lines = realClick('settings', footerRowOf(lines))
  const menuLabel = SETTINGS_COMMANDS[0].label
  const menuRow = lines.findIndex(isMenuLine)
  ok(menuRow >= 0, '展开后屏幕上有 ' + menuLabel)
  realClick(menuLabel, menuRow)
  eq(submitted.join(','), SETTINGS_COMMANDS[0].command, '点一次菜单条目只提交一条命令（press 不重复提交）')
  ok(editor.isMenuOpen() === false, '提交后菜单收起')
  resetRunState()
}

// ④d3 不变式：**渲染里出现的入口，必须都有命中区**
// 这条比逐条断言更抗回归 —— 以后再加/挪入口，只要画了却没登记 hits 就会红。
{
  const footer = new SuperPiFooter({ requestRender() {} }, { fg: (t, x) => x }, makeFooterData(), {
    ctx: { ...makeExtCtx(), onFooterAction() {} },
  })
  const rows = footer.render(96)
  const plainRows = rows.map(r => stripAnsi(r))
  const expect = [
    { text: 'settings', row: 0 },
    { text: 'home', row: 0 },
    { text: SWITCH_ICON, row: 0 },
  ]
  for (const item of expect) {
    const at = plainRows[item.row].indexOf(item.text)
    ok(at >= 0, `渲染里有 ${item.text}`)
    const mid = at + Math.floor(item.text.length / 2)
    const res = footer.handleMouse({ type: 'click', button: 'left', x: mid, y: item.row })
    ok(res && res.handled, `${item.text} 画出来了就必须可点（命中区已登记）`)
  }
  // 模型名与档位在第二行，同样不能只画不登记
  for (const text of ['Deepseek', 'max']) {
    const at = plainRows[1].indexOf(text)
    ok(at >= 0, `第二行有 ${text}`)
    const res = footer.handleMouse({ type: 'click', button: 'left', x: at + 1, y: 1 })
    ok(res && res.handled, `${text} 画出来了就必须可点`)
  }
}

// ④e 悬停：移入变亮 + 下划线，移出复原（用户第四条要求）
{
  const emitted = []
  const footer = new SuperPiFooter(
    { requestRender() {} },
    { fg: (t, x) => ANSI[t === 'accent' ? 'accent' : 'dim'](x) },
    makeFooterData(),
    { ctx: { ...makeExtCtx(), onFooterAction: kind => emitted.push(kind) } },
  )
  hoverState.id = null
  const before = footer.render(80)
  ok(!before[1].includes('\x1b[36m'), '平时 max 不是 accent')
  const maxX = stripAnsi(before[1]).indexOf('max')
  ok(maxX >= 0, '找得到 max 的位置')
  const move = footer.handleMouse({ type: 'move', button: 'none', x: maxX, y: 1 })
  ok(move && move.handled, '移入被 footer 消费（不会传下去）')
  eq(hoverState.id, 'thinking', '悬停态记到 thinking')
  const hovered = footer.render(80)
  ok(hovered[1].includes('\x1b[36m'), '悬停后 max 变成 accent 色')
  ok(hovered[1].includes('\x1b[4m'), '悬停后加下划线（终端里最稳的可点信号）')
  eq(emitted.length, 0, '悬停不触发动作（只有点击才切）')
  const blankX = stripAnsi(before[0]).indexOf(SWITCH_ICON) + 3
  footer.handleMouse({ type: 'move', button: 'none', x: blankX, y: 0 })
  eq(hoverState.id, null, '移到空白处清掉悬停态')
  ok(!footer.render(80)[1].includes('\x1b[4m'), '移出后下划线消失')
  ok(hoverStyle('x', (t, v) => ANSI[t === 'accent' ? 'accent' : 'dim'](v)).includes('\x1b[36m'), 'hoverStyle 用 accent')
  ok(hoverStyle('x', null).includes('\x1b[4m'), '没有主题取色时仍加下划线（降级但仍可见）')
}

// ④g 真实上下文占用（0.12.2）：footer 不能只信 usage —— 当前上游会把 1.31M 显示成 3.7%
const guardLogModule = await import(pathToFileURL(path.join(root, 'extensions', 'superpi-context-guard.mjs')).href)
{
  const guardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'superpi-guard-footer-'))
  const previousGuard = process.env.SUPERPI_CONTEXT_GUARD
  process.env.SUPERPI_CONTEXT_GUARD = path.join(guardDir, 'context-guard.json')
  const makeFooter = ctx => new SuperPiFooter({ requestRender() {} }, { fg: (t, x) => x }, makeFooterData(), { ctx })
  try {
    const withSession = () => {
      const ctx = makeExtCtx()
      ctx.sessionManager.getSessionId = () => 'sess-A'
      return ctx
    }

    // 1) 没有守卫日志 → 原样显示 pi 的 usage 百分比，且不加 ~ 前缀（不假装自己是估算）
    const noLogLine = stripAnsi(makeFooter(withSession()).render(96)[1])
    ok(noLogLine.includes('27.6%/1.0M'), '没有守卫日志时退回 pi 的百分比，实际 ' + noLogLine)
    ok(!noLogLine.includes('~'), '没有守卫记录时不加 ~ 前缀')

    // 2) 有本会话记录 → 用守卫的 after/window，并加 ~ 标记
    const logFile = path.join(guardDir, 'context-guard.log.jsonl')
    fs.writeFileSync(logFile, [
      JSON.stringify({ at: 't1', sessionId: 'sess-A', window: 1000000, before: 1900000, after: 600000 }),
      JSON.stringify({ at: 't2', sessionId: 'sess-B', window: 1000000, before: 1900000, after: 990000 }),
    ].join('\n') + '\n', 'utf8')
    const realLine = stripAnsi(makeFooter(withSession()).render(96)[1])
    ok(realLine.includes('~60.0%/1.0M'), '有守卫记录时显示真实估算（~60.0%/1.0M），实际 ' + realLine)
    ok(!realLine.includes('99.0'), '绝不把别的会话的数挂到当前会话上')

    // 3) 拿不到 sessionId → 不猜（宁可退回原值，也不显示别人的）
    const anonymousLine = stripAnsi(makeFooter(makeExtCtx()).render(96)[1])
    ok(anonymousLine.includes('27.6%/1.0M'), '拿不到 sessionId 时不覆盖，实际 ' + anonymousLine)

    // 4) 路径规则必须与守卫模块一致（三处同构：编辑器 / 守卫 / host 的 /context）
    eq(
      extensionModule.resolveGuardLogPath({ env: {}, home: 'C:/home/x' }),
      guardLogModule.resolveGuardLogPath({ env: {}, home: 'C:/home/x' }),
      'footer 与守卫模块算出同一个日志路径（单一真相，不靠人记）',
    )
    ok(
      extensionModule.resolveGuardLogPath({ env: {}, home: 'C:/home/x' }).split(path.sep).join('/').endsWith('/.superpi/context-guard.log.jsonl'),
      '日志落在 <home>/.superpi/context-guard.log.jsonl',
    )
  } finally {
    if (previousGuard === undefined) delete process.env.SUPERPI_CONTEXT_GUARD
    else process.env.SUPERPI_CONTEXT_GUARD = previousGuard
    try { fs.rmSync(guardDir, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
  }
}

// ④f 项目列表：分组 + 排序 + 比较键 + 临时目录
{
  eq(pathComparisonKey('D:\\A\\b\\'), pathComparisonKey('d:/a/B'), '比较键归一大小写与分隔符')
  eq(isTemporaryProjectPath('C:\\Users\\x\\AppData\\Local\\Temp\\a'), true, 'AppData/Local/Temp 是临时目录')
  eq(isTemporaryProjectPath('D:\\my_projects\\SuperPi'), false, '普通工程不是临时目录')
  eq(isTemporaryProjectPath('/tmp/x'), true, 'POSIX /tmp 是临时目录')
  const sessions = [
    { cwd: 'D:\\work\\old', modified: new Date('2026-01-01'), path: 'a' },
    { cwd: 'D:\\work\\current', modified: new Date('2026-01-02'), path: 'b' },
    { cwd: 'C:\\Users\\x\\AppData\\Local\\Temp\\t', modified: new Date('2026-03-01'), path: 'c' },
    { cwd: 'D:\\work\\recent', modified: new Date('2026-02-01'), path: 'd' },
    { cwd: '', modified: new Date('2026-02-01'), path: 'e' },
  ]
  const projects = groupProjects(sessions, 'D:\\work\\current')
  eq(projects.map(p => p.cwd).join('|'), 'D:\\work\\current|D:\\work\\recent|D:\\work\\old|C:\\Users\\x\\AppData\\Local\\Temp\\t', '当前项目置顶 → 最近活动降序 → 临时目录沉底')
  eq(projects[0].sessionCount, 1, '会话计数')
  eq(projects[0].lastSessionPath, 'b', '最近的会话文件路径')
  eq(projects.length, 4, 'cwd 为空的会话被跳过')

  // ensureProjectSession：目标项目还没有会话文件时，按 pi 的 header 格式写一个
  const fakeSM = {
    CURRENT_SESSION_VERSION: 3,
    create: (cwd) => {
      const file = path.join(os.tmpdir(), 'superpi-proj-' + process.pid + '-' + Date.now() + '.jsonl')
      return { getSessionFile: () => file, getSessionId: () => 'sid', getCwd: () => cwd, getEntries: () => [] }
    },
  }
  const created = ensureProjectSession(fakeSM, 'D:\\x')
  ok(created.endsWith('.jsonl'), 'ensureProjectSession 给出会话文件路径')
  ok(fs.existsSync(created), '空会话文件真的写出来了')
  const header = JSON.parse(fs.readFileSync(created, 'utf8').split('\n')[0])
  eq(header.type, 'session', 'header.type = session')
  eq(header.cwd, 'D:\\x', 'header.cwd = 目标项目（pi 换 cwd 就靠它）')
  eq(header.version, 3, 'header.version 跟 pi 的 CURRENT_SESSION_VERSION 一致')
  fs.unlinkSync(created)
  eq(ensureProjectSession(null, 'D:\\x'), '', '拿不到 SessionManager 时返回空串（不抛）')

  // splitFooterLine / splitModelSegment
  eq(splitFooterLine('12%/1.0M (auto)        Model • max').model, 'Model • max', 'splitFooterLine 切出右侧模型段')
  eq(splitFooterLine('12%/1.0M (auto)        Model • max').stats, '12%/1.0M (auto)', 'splitFooterLine 保留左侧统计')
  eq(splitFooterLine('just text').model, '', '没有右对齐段时不瞎猜')
  eq(splitModelSegment('Model • max').model, 'Model', 'splitModelSegment 切模型名')
  eq(splitModelSegment('Model • max').thinking, 'max', 'splitModelSegment 切档位')
  eq(splitModelSegment('Model').thinking, '', '没有档位时为空')
  eq(projectLabel('D:\\my_projects\\SuperPi', 'master'), 'D:\\my_projects\\SuperPi (master)', 'projectLabel 带分支')
  eq(projectLabel('D:\\x', null), 'D:\\x', 'projectLabel 无分支')
  // formatTokens 与 pi footer 同一套（footer.js:20-27）
  eq(formatTokens(0), '0', 'formatTokens 0')
  eq(formatTokens(999), '999', 'formatTokens 三位数')
  eq(formatTokens(1500), '1.5k', 'formatTokens 千位带一位小数')
  eq(formatTokens(42000), '42k', 'formatTokens 万位取整')
  eq(formatTokens(1000000), '1.0M', 'formatTokens 百万')
  // sumUsage 的口径与 pi footer 一致
  const usage = sumUsage({ getEntries: () => [
    { type: 'message', message: { role: 'assistant', usage: { input: 1200, output: 340, cacheRead: 41000, cacheWrite: 1800 } } },
    { type: 'usage', usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 } },
  ] })
  eq(usage.input, 1300, 'sumUsage 累加 input')
  eq(usage.output, 350, 'sumUsage 累加 output')
  eq(usage.cacheRead, 41000, 'sumUsage 累加 cacheRead')
  // 41000 / (1200+41000+1800) = 93.18%
  ok(Math.abs(usage.latestCacheHitRate - 93.18) < 0.05, 'sumUsage 命中率 = cacheRead/(input+cacheRead+cacheWrite)，实际 ' + String(usage.latestCacheHitRate))
  eq(sumUsage(null).input, 0, 'sumUsage 拿不到 sessionManager 时返回 0（不抛）')
}

// ④b 回归：theme 没有 fg、也没有注入 dim 时，**框仍然要在**（0.9.4 就是这里静默失效）
{
  const { editor } = makeEditor('测试内容')
  const rows = editor.render(60)
  // 0.9.9 起框外没有自己的行（入口搬去 footer），框本身仍然必须闭合。
  ok(rows.length >= 3, '仍然渲染出框（不是退化成无框原始行）')
  ok(stripAnsi(rows[0]).startsWith('┌'), '上边框是直角')
  ok(stripAnsi(rows[0]).includes('就绪'), '就绪状态仍在上边框里')
  ok(stripAnsi(rows.find(row => row.startsWith('[38;2;204;204;204m└')) || '').startsWith('└'), '下边框在')
  ok(stripAnsi(rows.at(-1)).startsWith('└'), '最后一行仍是不依赖取色的下边框')
  // 直接对 theme.fg 做取色也不许抛（编辑器的 theme 没有这个方法）
  eq(typeof theme.fg, 'undefined', 'pi 交给编辑器的 theme 确实没有 fg')
}

// ⑤ settings 子菜单：toggleMenu() 展开，点条目提交 pi 自己的斜杠命令
{
  const { editor } = makeEditor('')
  const submitted = []
  editor.onSubmit = command => submitted.push(command)
  ok(!stripAnsi(editor.render(60).join('\n')).includes('scoped-models'), '菜单默认收起')
  // 0.9.9 起 settings 入口在 footer，点击由 footer 转给编辑器的 toggleMenu()。
  editor.toggleMenu()
  eq(editor.isMenuOpen(), true, 'toggleMenu() 打开子菜单')
  const opened = editor.render(60)
  for (const item of SETTINGS_COMMANDS) {
    ok(stripAnsi(opened.join('\n')).includes(item.label), `菜单展开后有 ${item.label}`)
  }
  const menuLabel = SETTINGS_COMMANDS[0].label
  const menuY = rowIndexOf(opened, menuLabel)
  const menuX = columnOf(opened, menuY, menuLabel) + 1
  editor.handleMouse({ type: 'click', button: 'left', x: menuX, y: menuY })
  eq(submitted.at(-1), SETTINGS_COMMANDS[0].command, '点菜单项提交对应的 pi 斜杠命令')
  ok(!stripAnsi(editor.render(60).join('\n')).includes('scoped-models'), '提交后菜单收起')
}

// ⑤b 键盘选择（0.60.2）：菜单是弹层，↑↓ 移动选中项、Enter 执行、Esc 收起，其它键不吞。
//
// 用户报的是「展开设置后上下键选不了」。根因不是按键没到编辑器，而是菜单当时只是
// 一组画出来的行 + 鼠标命中区 —— 没有「当前项」这个状态，键盘就没有东西可改。
// 这一段锁住的是那个状态本身：每一行都有 `> `/两空格前缀，选中项唯一。
{
  const { editor } = makeEditor('')
  const submitted = []
  editor.onSubmit = command => submitted.push(command)
  const plain = () => editor.render(60).map(stripAnsi)
  const selected = () => {
    const line = plain().find(row => row.startsWith('> '))
    return line ? line.slice(2).trimEnd() : null
  }

  editor.toggleMenu()
  const menuLines = plain().filter(row => row.startsWith('> ') || row.startsWith('  '))
  eq(menuLines.length, SETTINGS_COMMANDS.length, '菜单每项占一行（前缀统一两列）')
  eq(selected(), SETTINGS_COMMANDS[0].label, '展开后第一项是选中项')

  editor.handleInput('\x1b[B')
  eq(selected(), SETTINGS_COMMANDS[1].label, '↓ 把选中项移到下一项')
  editor.handleInput('\x1b[A')
  eq(selected(), SETTINGS_COMMANDS[0].label, '↑ 移回上一项')
  editor.handleInput('\x1b[A')
  eq(selected(), SETTINGS_COMMANDS[SETTINGS_COMMANDS.length - 1].label, '首项再 ↑ 循环到末项（与 pi 的 SelectList 一致）')
  eq(plain().filter(row => row.startsWith('> ')).length, 1, '任何时刻只有一个选中项')

  editor.handleInput('\r')
  eq(submitted.at(-1), SETTINGS_COMMANDS[SETTINGS_COMMANDS.length - 1].command, 'Enter 执行当前选中项的命令')
  ok(editor.isMenuOpen() === false, 'Enter 后菜单收起')
  ok(!plain().some(row => row.startsWith('> ')), '收起后不残留选中行')

  // 菜单不能吞普通输入：收起菜单、字符照旧进输入框（否则用户会以为输入框坏了）。
  editor.toggleMenu()
  editor.handleInput('x')
  ok(editor.isMenuOpen() === false, '输入普通字符时菜单收起')
  ok(editor.getText().includes('x'), '字符仍然进入输入框')

  // Esc 收起，且不往外漏
  editor.toggleMenu()
  editor.handleInput('\x1b')
  ok(editor.isMenuOpen() === false, 'Esc 收起菜单')
}

// ⑥ home = /new；运行中不切（runCommand 的两条语义都还在）
{
  const { editor } = makeEditor('')
  const submitted = []
  editor.onSubmit = command => submitted.push(command)
  eq(HOME_COMMAND, '/new', 'home 对应 pi 的 /new（起新会话树 = 刚启动时的界面）')
  editor.runCommand(HOME_COMMAND)
  eq(submitted.at(-1), HOME_COMMAND, '空闲时提交 /new')

  // 运行中不许切：给提示而不是静默丢弃
  const notices = []
  markRunStart()
  const busy = makeEditor('')
  busy.editor.hooks = { notify: (text, level) => notices.push(`${level}:${text}`) }
  busy.editor.onSubmit = command => submitted.push(command)
  const before = submitted.length
  busy.editor.runCommand(HOME_COMMAND)
  eq(submitted.length, before, '运行中不提交 /new')
  ok(notices.length === 1 && notices[0].startsWith('warning:'), '运行中给出 warning 提示')
  resetRunState()
}

// ⑦ Esc 先关菜单
{
  const { editor } = makeEditor('')
  editor.toggleMenu()
  ok(stripAnsi(editor.render(60).join('\n')).includes('scoped-models'), '菜单已展开')
  editor.handleInput(KEY.esc)
  ok(!stripAnsi(editor.render(60).join('\n')).includes('scoped-models'), 'Esc 关掉菜单')
  eq(editor.isMenuOpen(), false, 'Esc 之后 isMenuOpen() 为 false')
}

// ⑧ settings 菜单里的命令必须真的有来源：pi 的命令去 pi 的源码里找，
// superpi 自己的命令去**对应扩展**里找。混为一谈就是「点了没反应」的前奏。
{
  const piSource = fs.readFileSync(path.join(pi.packageDir, 'dist', 'modes', 'interactive', 'interactive-mode.js'), 'utf8')
  // 0.13.0 起 superpi 有两条自造命令，分属两个扩展。必须按扩展逐个对账：
  // 只检查「所有扩展里出现过某个字符串」会漏掉「菜单项指向一个没人注册的命令」。
  const superpiExtensionSources = fs.readdirSync(path.join(root, 'extensions'))
    .filter(name => name.endsWith('.ts'))
    .map(name => ({ name, source: fs.readFileSync(path.join(root, 'extensions', name), 'utf8') }))
  for (const item of SETTINGS_COMMANDS) {
    const source = item.source === undefined ? 'pi' : item.source
    if (source === 'pi') {
      ok(piSource.includes(`text === "${item.command}"`), `pi 里仍然有 ${item.command}`)
    } else {
      // 命名约定：命令 `/superpi-x` 由 `extensions/superpi-x.ts` 提供。
      // 这条同时抓两种坏法：菜单项指向不存在的文件、文件存在但没 registerCommand。
      const name = item.command.slice(1)
      const expected = name + '.ts'
      const owner = superpiExtensionSources.filter(entry => entry.name === expected)
      ok(owner.length === 1, `${item.command} 由 ${expected} 提供`)
      ok(owner.length === 1 && owner[0].source.includes('registerCommand'), `${expected} 真的调用了 registerCommand（否则菜单点了没反应）`)
    }
  }
  ok(piSource.includes('text === "/new"'), 'pi 里仍然有 /new（home 的目标）')
  // 每一条都要标 source，否则下一个人又把自造命令加进「pi 的命令」那一类。
  ok(SETTINGS_COMMANDS.every(item => item.source === 'pi' || item.source === 'superpi'), '每一条都标了 source（pi / superpi）')
  eq(SETTINGS_COMMANDS.filter(item => item.source === 'pi').length, 4, 'pi 自带四条（settings/model/thinking/scoped-models）')
  eq(SETTINGS_COMMANDS.filter(item => item.source === 'superpi').length, 2, 'superpi 两条（rules + modalities）')
}

// ⑧b 窄宽度 / 多行 / 中文 / 跨行选区下，框线仍然对齐
{
  const tricky = [
    '短',
    '一行很长的中文内容用来触发自动换行，看看框线会不会歪掉一二三四五六七八九十',
    ['E:', 'xwechat_files', 'wxid', 'a.png'].join(String.fromCharCode(92)),
    'third line with latin words that wrap around too',
  ].join('\n')
  for (const width of [24, 33, 40, 73, 120]) {
    const { editor } = makeEditor(tricky)
    editor.handleInput(KEY.ctrlA)
    const rows = editor.render(width)
    const boxBottom = rows.findIndex(row => stripAnsi(row).startsWith('└'))
    ok(boxBottom > 0, `宽度 ${width}：有下边框`)
    // 框外那几行（settings/home/菜单）宽度也不同，所以只断言框内等宽
    const widths = new Set(rows.slice(0, boxBottom + 1).map(row => tuiModule.visibleWidth(row)))
    eq([...widths].join(','), String(width), `宽度 ${width}：框内所有行等宽（含中文/换行/选区）`)
    ok(stripAnsi(rows[0]).startsWith('┌'), `宽度 ${width}：上边框是直角`)
    // 0.9.9 起 settings / home 搬进 footer：编辑器渲染里不该再有框外入口行
    const outside = rows.slice(boxBottom + 1).map(row => stripAnsi(row)).join(String.fromCharCode(10))
    ok(!outside.includes('settings'), `宽度 ${width}：编辑器不再画 settings（归 footer）`)
  }
}

// ⑧c 路径底色只覆盖路径本身（用户实测：后面输入的文字也被染色）
{
  const BS = String.fromCharCode(92)
  const pathOnly = ['D:', 'my_projects', 'a.png'].join(BS)
  // 紧跟着普通文字（无空白分隔）时，底色必须在扩展名处止住
  const glued = `看这个 ${pathOnly}然后把这张图改成深色`
  eq(trimPathToken(pathOnly + '然后把这张图改成深色'), pathOnly, 'trimPathToken 在已知扩展名处截断')
  eq(trimPathToken(pathOnly), pathOnly, 'trimPathToken 不切完整路径')
  const { editor } = makeEditor(glued)
  const rows = editor.render(120)
  const painted = paintedCells(rows)
  const paintedText = painted.join('')
  ok(!paintedText.includes('然后'), `路径后面的普通文字不带底色（实际=${JSON.stringify(paintedText)}）`)
  ok(paintedText.includes('a.png'), '路径本身仍带底色')
  ok(!paintedText.includes('看这个'), '路径前面的普通文字不带底色')

  // 两侧是空白时，药丸左右各吃一格当圆角
  const spaced = `看图 ${pathOnly} 谢谢`
  const { editor: spacedEditor } = makeEditor(spaced)
  const spacedPainted = paintedCells(spacedEditor.render(120)).join('')
  ok(spacedPainted.startsWith(' '), '左侧空白当圆角被吃掉一格')
  ok(spacedPainted.endsWith(' '), '右侧空白当圆角被吃掉一格')
  ok(!spacedPainted.includes('谢谢'), '右侧文字仍不带底色')
}

// ⑧d 剪贴板判定：文件 > 位图 > 文本
{
  const b64 = value => Buffer.from(value, 'utf8').toString('base64')
  const joined = lines => b64(lines.join(String.fromCharCode(10)))
  const samplePath = ['C:', 'a.png'].join(String.fromCharCode(92))
  const probe = parseProbe(joined([`files=${b64(samplePath)}`]))
  eq(probe.files.join(','), samplePath, 'parseProbe 解出文件列表')
  const textProbe = parseProbe(joined([`text=${b64('一段文本')}`]))
  eq(textProbe.text, '一段文本', 'parseProbe 解出文本')
  const imageProbe = parseProbe(joined([`format=${b64('image/png')}`]))
  eq(imageProbe.format, 'image/png', 'parseProbe 解出位图格式')
  eq(parseProbe('').files.length, 0, 'parseProbe 空输出 → 空结果')
  eq(parseProbe(joined(['files='])).files.length, 0, 'parseProbe 空文件列表 → 空数组')

  // 位图落盘
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=', 'base64')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'superpi clipboard '))
  try {
    const saved = await saveClipboardImage(bytes, directory)
    ok(saved.endsWith('.png'), 'saveClipboardImage 落成 .png')
    ok(fs.existsSync(saved), 'saveClipboardImage 文件真的写出来了')
    eq(fs.readFileSync(saved).toString('base64'), bytes.toString('base64'), '内容与传入字节一致')
    eq(await saveClipboardImage(bytes, directory), saved, '同一截图重复粘贴复用稳定路径')
    const { editor } = makeEditor('旧输入', { hooks: { readClipboard: async () => ({ files: [saved], text: '' }) } })
    editor.handleInput(KEY.ctrlA)
    editor.handleInput('\x16')
    await settle()
    eq(editor.getText(), '"' + saved + '"', 'Ctrl+V 用包含空格的完整文件路径替换选区')
    eq(paintedCells(editor.render(160)).join(''), saved, '浅灰底覆盖完整路径')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }

  // 判定顺序：文件优先于文本
  const order = []
  const realResolve = resolveClipboardPaste
  ok(typeof realResolve === 'function', 'resolveClipboardPaste 已导出（粘贴判定的唯一入口）')
  void order
}

// ⑧e 粘贴走扩展自己的通道（不再依赖 pi-tui 在 Windows 上缺失的 getFilePaths）
{
  const text = '粘贴文字\n下一行'
  const { editor } = makeEditor('待替换', { hooks: { readClipboard: async () => ({ files: [], text }) } })
  editor.handleInput(KEY.ctrlA)
  editor.handleInput('\x16')
  await settle()
  eq(editor.getText(), text, 'Ctrl+V 插入原始多行文字并替换选区')
  const paths = [path.resolve('样本.mp4'), path.resolve('录音.wav'), path.resolve('文档.pdf')]
  const { editor: files } = makeEditor('', { hooks: { readClipboard: async () => ({ files: paths, text: '附带文字' }) } })
  files.handleInput('\x16')
  await settle()
  eq(files.getText(), paths.join('\n'), '视频、音频和普通文件按顺序插入原始路径')
}

// ⑨ padToWidth 不会破坏框线对齐
{
  eq(stripAnsi(padToWidth('abc', 5)), 'abc  ', 'padToWidth 补空格')
  eq(tuiModule.visibleWidth(padToWidth('\x1b[31mabc\x1b[0m', 5)), 5, 'padToWidth 按可见宽度算（含 ANSI）')
  eq(tuiModule.visibleWidth(padToWidth('abcdef', 4)), 4, 'padToWidth 超长时截断')
}


/* ────────────────────── 技能（skills/）与安装面 ────────────────────── */
//
// 两个 skill 是这一层的行为约定，最容易被下一个人顺手改坏而无人察觉：
// 名字改了 pi 就发现不了；frontmatter 少了 description 就不加载；描述不以
// "Use when" 开头，模型就不会在正确的时机想起它。所以逐条钉死。
{
  const skillsRoot = path.join(root, 'skills')
  ok(fs.existsSync(skillsRoot), 'skills/ 目录存在')
  const names = fs.readdirSync(skillsRoot).sort()
  // 只允许这两个：多一个就要同时登记到安装器 SKILL_NAMES，否则装了不生效还不报错。
  eq(names.join(','), 'change-scope,verified-delivery', 'skills/ 下只有这两个 skill')

  // 这里要自己取：526 行那份是另一个块里的局部解构，块外看不见。
  const { SKILL_NAMES, resolveUserSkillsDir, status, install, remove } = await import('../tools/install-pi-extension.mjs')
  eq(SKILL_NAMES.slice().sort().join(','), names.join(','), '安装器 SKILL_NAMES 与 skills/ 目录一致')

  const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/
  for (const name of names) {
    const file = path.join(skillsRoot, name, 'SKILL.md')
    ok(fs.existsSync(file), name + ' 有 SKILL.md')
    const text = fs.readFileSync(file, 'utf8')
    const front = FRONTMATTER.exec(text)
    ok(front !== null, name + ' 有 YAML frontmatter')
    const body = front === null ? '' : front[1]
    const declaredName = (/^name:[ \t]*(\S+)[ \t]*$/m.exec(body) ?? [])[1]
    eq(declaredName, name, name + ' 的 frontmatter name 与目录名一致（否则 pi 的发现名与路径对不上）')
    const desc = (/^description:[ \t]*(.+)$/m.exec(body) ?? [])[1] ?? ''
    ok(desc.length > 80, name + ' 的 description 足够长（太短无法路由）')
    ok(/^(Use when|Use before)/.test(desc), name + ' 的 description 以触发条件开头（Use when / Use before）')
    // 正文必须能独立成立：有核心原则、有实质篇幅，不是标题集合
    ok(/Core principle/.test(text), name + ' 写明核心原则')
    ok(text.split('\n').length >= 80, name + ' 正文有实质内容（>= 80 行）')
    // 防自我合理化表（writing-skills 里纪律类技能的必备形式）
    ok(/rationalization|合理化/i.test(text), name + ' 含「自我合理化」对照表（纪律类技能的关键形式）')
    ok(/^\|/m.test(text), name + ' 含表格（可快速对照，不用通读）')
    // 不许写死本机路径（会随机器泄漏，也会在别的机器上指错地方）
    ok(!/[A-Za-z]:\\Users[\\/]/.test(text), name + ' 不含硬编码本机绝对路径')
  }

  // 安装面：用户级目录不经过项目信任，所以装了就一定被 pi 加载。
  const fakeHome = path.join(process.env.TEMP ?? '.', 'fake-home-' + process.pid)
  const fakeExtDir = path.join(process.env.TEMP ?? '.', 'superpi-skill-test-' + process.pid)
  eq(resolveUserSkillsDir({ USERPROFILE: fakeHome }).endsWith(path.join('.agents', 'skills')), true, '用户级 skill 目录在 <home>/.agents/skills')
  const before = status({ dir: fakeExtDir, env: { USERPROFILE: fakeHome } })
  eq(before.skills.length, 2, 'status() 报告两个 skill')
  eq(before.skills.every(item => item.sourceExists), true, '两个 skill 源都在')
  eq(before.complete, false, '未安装时 complete=false（skill 也计入完整度）')
  const installedSkills = install({ dir: fakeExtDir, env: { USERPROFILE: fakeHome } })
  eq(installedSkills.code, 0, 'install 成功（含 skill）')
  for (const name of names) {
    const target = path.join(fakeHome, '.agents', 'skills', name, 'SKILL.md')
    ok(fs.existsSync(target), '装出 ' + name + '/SKILL.md')
    eq(fs.readFileSync(target, 'utf8'), fs.readFileSync(path.join(skillsRoot, name, 'SKILL.md'), 'utf8'), name + ' 装出的内容与源逐字节一致')
  }
  eq(status({ dir: fakeExtDir, env: { USERPROFILE: fakeHome } }).complete, true, '装完 complete=true')
  const { loadSkills } = await import(pathToFileURL(path.join(pi.packageDir, 'dist', 'index.js')).href)
  const discoverSkills = () => loadSkills({
    cwd: fakeHome,
    agentDir: path.join(fakeHome, '.pi', 'agent'),
    includeDefaults: false,
    skillPaths: [resolveUserSkillsDir({ USERPROFILE: fakeHome })],
  }).skills.map(skill => skill.name).sort()
  eq(discoverSkills().join(','), names.join(','), 'Pi 的加载器能从临时用户目录发现两个已安装的技能')
  // 卸载要把 skill 一起清掉，否则「卸了还有」是最难排查的一种残留。
  const removedSkills = remove({ dir: fakeExtDir, env: { USERPROFILE: fakeHome } })
  eq(removedSkills.code, 0, 'remove 成功（含 skill）')
  for (const name of names) {
    ok(!fs.existsSync(path.join(fakeHome, '.agents', 'skills', name, 'SKILL.md')), '卸载后 ' + name + ' 的 SKILL.md 消失')
  }
  eq(discoverSkills().length, 0, '卸载后 Pi 的加载器也找不到已移除的技能')
  fs.rmSync(fakeHome, { recursive: true, force: true })
  fs.rmSync(fakeExtDir, { recursive: true, force: true })
}

// The TUI invokes the same extension through its native select/input surface.
{
  const { default: register } = await jiti.import(path.join(root, 'extensions', 'superpi-ask-user.ts'))
  let tool
  register({ registerTool(value) { tool = value } })
  eq(tool?.name, 'ask_user', '真 TUI 扩展注册询问工具')
  eq(tool.executionMode, 'sequential', '问题等待期间遵循原生工具串行边界')
  const abort = new AbortController()
  let dialogs = []
  const ctx = { mode: 'tui', hasUI: true, ui: {
    async select(title, options, settings) { dialogs.push({ title, options, settings }); return options[1] },
    async input(title, _placeholder, settings) { dialogs.push({ title, settings }); return '  我自己的回答  ' },
  } }
  const execute = (params, context = ctx) => tool.execute('tui-question', params, abort.signal, undefined, context)
  const selected = await execute({ question: '先做哪个？', options: ['甲', '乙'] })
  eq(dialogs[0].title, '先做哪个？', '真实 TUI 选择器收到问题')
  eq(dialogs[0].settings.signal, abort.signal, '弹窗使用原生停止信号')
  eq(dialogs[0].settings.timeout, 300000, '与面板使用相同的等待期限')
  eq(selected.details.answer, '乙', '返回实际选择')
  eq(selected.details.source, 'option', '选项答案保留来源')
  const typed = await execute({ question: '你的要求是什么？' })
  eq(dialogs.at(-1).title, '你的要求是什么？', '终端自由输入显示原问题')
  eq(typed.details.answer, '  我自己的回答  ', '用户的自由答案原样返回')
  eq(typed.details.source, 'input', '自由答案保留来源')
  dialogs = []
  eq((await execute({ question: '问题' }, { mode: 'print', hasUI: false })).details.status, 'unavailable', '非交互模式可提示模型走文本对话')
  eq((await execute({ question: '\ufffd' })).details.status, 'invalid', '坏字节不会显示在终端里')
  eq((await execute({ question: '问题', options: ['甲', ' 甲 '] })).details.status, 'invalid', '重复选项不会产生含糊的回复')
  eq(dialogs.length, 0, '不可展示的请求不打开询问组件')
  abort.abort()
  eq((await execute({ question: '问题' })).details.status, 'aborted', '已停止的回合不会再次询问用户')
}

console.log(`PASS (${checks} checks)`)

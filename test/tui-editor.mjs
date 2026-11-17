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
 * 需要 pi 运行时（.runtime 或宿主 node_modules）；找不到就 SKIP 并退出 0。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolvePiRuntime } from '../src/pi-runtime.mjs'
import { resolveExtensionDir, EXTENSION_FILE_NAME } from '../tools/install-pi-extension.mjs'

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

function skip(reason) {
  console.log('SKIP: ' + reason)
  process.exit(0)
}

/* --------------------------------------------------------------- 定位运行时 */

const pi = resolvePiRuntime({ pluginRoot: root })
if (!pi.cliPath || !pi.packageDir) skip('没有 pi 运行时（先跑一键安装），跳过 TUI 编辑器门禁')

const piTuiDir = path.join(pi.packageDir, '..', 'pi-tui')
const piTuiEntry = path.join(piTuiDir, 'dist', 'index.js')
if (!fs.existsSync(piTuiEntry)) skip('找不到 @earendil-works/pi-tui，跳过')

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
if (!jitiPath) skip('找不到 jiti（pi 用 jiti 加载 TS 扩展），跳过')

/* -------------------------------------------------------------- 加载真扩展 */

const { createJiti } = await import(pathToFileURL(jitiPath).href)
const extensionFile = path.join(root, 'extensions', 'superpi-editor.ts')
ok(fs.existsSync(extensionFile), '扩展源文件存在')

// 与 pi 的 core/extensions/loader.js 同一套 alias（只看扩展用到的两个包）。
// 值用**绝对路径**而不是 file:// URL —— jiti 的 alias 走 CJS 解析，file:// 会解析失败。
const jiti = createJiti(extensionFile, {
  interopDefault: true,
  moduleCache: false,
  alias: {
    // pi 自己也是指向 dist/index.js（包根没有 index.js）。
    '@earendil-works/pi-coding-agent': path.join(pi.packageDir, 'dist', 'index.js'),
    '@earendil-works/pi-tui': piTuiEntry,
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
  // 3 个状态事件 + session_start + session_switch + session_info_changed（标题重设）
  eq(calls.length, 6, '入口注册六个事件（状态机 3 + 会话 3）')
  ok(calls.every(c => typeof c.handler === 'function'), '入口注册的都是函数')
  const events = calls.map(c => c.event)
  for (const name of ['agent_start', 'tool_execution_end', 'agent_settled', 'session_start', 'session_switch', 'session_info_changed']) {
    ok(events.includes(name), `入口订阅了 ${name}`)
  }
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
  const { install, remove, status } = await import('../tools/install-pi-extension.mjs')
  const dir = path.join(process.env.TEMP ?? process.env.TMPDIR ?? '.', `superpi-ext-test-${process.pid}`)
  const state = status({ dir })
  ok(state.sourceExists, '扩展源文件可读')
  const installed = install({ dir })
  eq(installed.code, 0, 'install 成功')
  ok(fs.existsSync(path.join(dir, EXTENSION_FILE_NAME)), '安装后目标文件存在')
  eq(status({ dir }).identical, true, '安装后内容与源一致')
  eq(install({ dir }).code, 0, 'install 幂等')

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
    fs.rmSync(agentDir, { recursive: true, force: true })
  } else {
    process.stdout.write('  (skip) 没有 core/extensions/loader.js，跳过 pi 加载器实装验证\n')
  }

  const removed = remove({ dir })
  eq(removed.code, 0, 'remove 成功')
  ok(!fs.existsSync(path.join(dir, EXTENSION_FILE_NAME)), '卸载后目标文件消失')
  eq(remove({ dir }).code, 0, 'remove 幂等（未安装也不报错）')
  fs.rmSync(dir, { recursive: true, force: true })
}


/* ---------------------------------------------- 输入框外观与入口（0.9.4） */

const rowIndexOf = (rows, needle) => rows.findIndex(row => stripAnsi(row).includes(needle))
const columnOf = (rows, y, needle) => stripAnsi(rows[y] ?? '').indexOf(needle)

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

// ② Working 状态：白 / 绿 / 红，图标同色，回到上边框内侧左侧
{
  const cases = [
    ['idle', () => resetRunState(), '○'],
    ['running', () => markRunStart(Date.now() - 3000), null],
    ['success', () => { markRunStart(); markRunSettled() }, '✔'],
    ['error', () => { markRunStart(); markToolError(); markRunSettled() }, '✖'],
  ]
  for (const [phase, setup, icon] of cases) {
    setup()
    const { editor } = makeEditor('')
    const rows = editor.render(60)
    const topRow = stripAnsi(rows[0])
    ok(topRow.includes('Working'), `${phase}: Working 在上边框里（pi 原来的位置）`)
    const rgb = STATUS_RGB[phase].join(';')
    ok(rows[0].includes(`[38;2;${rgb}m`), `${phase}: 文案与图标用该状态的颜色`)
    if (icon) ok(topRow.includes(icon), `${phase}: 图标是 ${icon}`)
    else ok(/[◐◓◑◒]/.test(topRow), 'running: 图标是转盘')
  }
  const distinct = new Set([STATUS_RGB.idle, STATUS_RGB.success, STATUS_RGB.error].map(c => c.join(',')))
  eq(distinct.size, 3, 'idle / success / error 三色互不相同')
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
  ok(stripAnsi(rows[0]).includes('Working'), 'Working 仍在上边框里')
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

// ⑥ home = /new；运行中不切（runCommand 的两条语义都还在）
{
  const { editor } = makeEditor('')
  const submitted = []
  editor.onSubmit = command => submitted.push(command)
  eq(HOME_COMMAND, '/new', 'home 对应 pi 的 /new（起新会话树 = 刚启动时的界��）')
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

// ⑧ settings 菜单里的命令必须仍然存在于 pi（不自造）
{
  const piSource = fs.readFileSync(path.join(pi.packageDir, 'dist', 'modes', 'interactive', 'interactive-mode.js'), 'utf8')
  for (const item of SETTINGS_COMMANDS) {
    ok(piSource.includes(`text === "${item.command}"`), `pi 里仍然有 ${item.command}`)
  }
  ok(piSource.includes('text === "/new"'), 'pi 里仍然有 /new（home 的目标）')
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
  const probe = parseProbe(joined([`files=${b64(samplePath)}`]), '/tmp/x.png')
  eq(probe.files.join(','), samplePath, 'parseProbe 解出文件列表')
  const textProbe = parseProbe(joined([`text=${b64('一段文本')}`]), '/tmp/x.png')
  eq(textProbe.text, '一段文本', 'parseProbe 解出文本')
  const imageProbe = parseProbe(joined(['image=ok']), '/tmp/x.png')
  eq(imageProbe.imagePath, '/tmp/x.png', 'parseProbe 解出位图路径')
  eq(parseProbe('', '/tmp/x.png').files.length, 0, 'parseProbe 空输出 → 空结果')
  eq(parseProbe(joined(['files=']), '/tmp/x.png').files.length, 0, 'parseProbe 空文件列表 → 空数组')

  // 位图落盘
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
  const saved = saveClipboardImage(bytes)
  ok(saved.endsWith('.png'), 'saveClipboardImage 落成 .png')
  ok(fs.existsSync(saved), 'saveClipboardImage 文件真的写出来了')
  eq(fs.readFileSync(saved).length, 4, '内容与传入字节一致')
  fs.unlinkSync(saved)

  // 判定顺序：文件优先于文本
  const order = []
  const realResolve = resolveClipboardPaste
  ok(typeof realResolve === 'function', 'resolveClipboardPaste 已导出（粘贴判定的唯一入口）')
  void order
}

// ⑧e 粘贴走扩展自己的通道（不再依赖 pi-tui 在 Windows 上缺失的 getFilePaths）
{
  const { editor } = makeEditor('')
  let piFallback = 0
  editor.onPasteImage = () => { piFallback += 1 }
  // readWindowsClipboard 在非 Windows / 空剪贴板时返回空 → 应回落到 pi
  const probe = await extensionModule.readWindowsClipboard()
  ok(typeof probe.files.length === 'number' && typeof probe.text === 'string', 'readWindowsClipboard 返回三态结构')
  void piFallback
}

// ⑨ padToWidth 不会破坏框线对齐
{
  eq(stripAnsi(padToWidth('abc', 5)), 'abc  ', 'padToWidth 补空格')
  eq(tuiModule.visibleWidth(padToWidth('\x1b[31mabc\x1b[0m', 5)), 5, 'padToWidth 按可见宽度算（含 ANSI）')
  eq(tuiModule.visibleWidth(padToWidth('abcdef', 4)), 4, 'padToWidth 超长时截断')
}

console.log(`PASS (${checks} checks)`)

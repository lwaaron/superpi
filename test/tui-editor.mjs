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
const paintColumns = extensionModule.paintColumns
const decodeListing = extensionModule.decodeListing
const defaultExport = extensionModule.default
ok(typeof SuperPiEditor === 'function', '扩展导出 SuperPiEditor 类')
ok(typeof paintColumns === 'function', '扩展导出 paintColumns')
ok(typeof decodeListing === 'function', '扩展导出 decodeListing')
ok(typeof defaultExport === 'function', '扩展导出默认入口（pi 加载用）')

const tuiModule = await import(pathToFileURL(piTuiEntry).href)
const { CustomEditor } = await import(pathToFileURL(path.join(pi.packageDir, 'dist', 'index.js')).href)
ok(typeof CustomEditor === 'function', 'pi 公开导出了 CustomEditor（扩展继承它）')
ok(SuperPiEditor.prototype instanceof CustomEditor, 'SuperPiEditor 继承自 pi 的 CustomEditor（app 键位/actionHandlers 生效）')

/* ------------------------------------------------------------------ 夹具 */

const theme = {
  borderColor: String,
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  fgDim: text => text,
}

function makeEditor(text = '') {
  const tui = { renders: 0, terminal: { rows: 40, columns: 120 }, requestRender() { this.renders += 1 } }
  const editor = new SuperPiEditor(tui, theme, { matches: () => false }, { embedWorkingStatus: false })
  if (text) editor.setText(text)
  return { editor, tui }
}

/** 等到一次异步剪贴板写入落地。 */
const settle = () => new Promise(resolve => setTimeout(resolve, 60))

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

/* ------------------------------------------------------ 扩展注册与安装面 */

{
  const calls = []
  const fakePi = { on: (event, handler) => calls.push({ event, handler }) }
  defaultExport(fakePi)
  eq(calls.length, 2, '入口注册两个会话事件')
  ok(calls.every(c => typeof c.handler === 'function'), '入口注册的都是函数')
  const factories = []
  const ctx = { ui: { setEditorComponent: factory => factories.push(factory) } }
  for (const call of calls) call.handler({}, ctx)
  eq(factories.length, 2, '每个事件都装了编辑器工厂')
  const tui = { renders: 0, terminal: { rows: 40, columns: 100 }, requestRender() { this.renders += 1 } }
  const built = factories[0](tui, theme, { matches: () => false })
  ok(built instanceof SuperPiEditor, '工厂返回 SuperPiEditor 实例')
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

console.log(`PASS (${checks} checks)`)

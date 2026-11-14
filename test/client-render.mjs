#!/usr/bin/env node
/**
 * client.js 的渲染冒烟：在没有浏览器的前提下把组件树渲染成字符串。
 *
 * 为什么需要：client 半区跑在 DSH 的 Web 载体里，改一行就重启 DSH 才能验证，
 * 代价太高。这里用「假 window 拿 exports + react-dom/server 渲染」把两类错误挡在提交前：
 *  1. 组件抛异常（读 undefined 的属性、拼错 props）；
 *  2. 文案键缺失 / 中英文键集不一致。
 *
 * 依赖位置：react 与 react-dom 从 pi 的 node_modules 借（dsh-pi 自己刻意不带 node_modules）。
 * 借不到就 skip —— 不是失败，因为这不是插件运行时需要的依赖。
 *
 * 跑法：node test/client-render.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)

const REACT_HOMES = [
  path.join(root, 'node_modules'),
  path.join(root, '..', 'pi-main', 'node_modules'),
  path.join(process.env.USERPROFILE ?? '', 'Documents', 'pi-local', 'pi-main', 'node_modules'),
]

function findReactHome() {
  for (const home of REACT_HOMES) {
    if (home === '' ) continue
    if (fs.existsSync(path.join(home, 'react', 'package.json')) && fs.existsSync(path.join(home, 'react-dom', 'package.json'))) return home
  }
  return null
}

const reactHome = findReactHome()
if (reactHome === null) {
  console.log('SKIP: 找不到 react / react-dom（试过 ' + REACT_HOMES.filter(home => home !== '').join(', ') + '）')
  process.exit(0)
}
console.log('react home =', reactHome)

const req = createRequire(path.join(reactHome, 'noop.js'))
const React = req('react')
const { renderToStaticMarkup } = req('react-dom/server')

let passed = 0
let failed = 0
function assert(condition, message) {
  if (condition) { passed += 1; return }
  failed += 1
  console.error('FAIL: ' + message)
}

// 假 window：client.js 顶部就调 window.__ModuleLoader__.load，把定义截下来。
let definition = null
globalThis.window = { __ModuleLoader__: { load: def => { definition = def } } }
globalThis.document = undefined

await import(pathToFileURL(path.join(root, 'client.js')).href)

assert(definition !== null, 'client.js 没有调用 window.__ModuleLoader__.load')
assert(definition.id === 'dsh-pi', 'loader id 应为 dsh-pi，实际 ' + String(definition && definition.id))
if (definition === null) process.exit(1)

// 只允许 require('react')，其余模块直接报错——守住「零依赖」这条约束。
const requireShim = name => {
  if (name === 'react') return React
  throw new Error('client.js 不允许 require(' + JSON.stringify(name) + ')')
}
const exportsObject = definition.factory(requireShim)
const internals = exportsObject.__internals
assert(internals !== undefined && internals !== null, 'factory 没有返回 __internals')
const Chip = internals.SelfCheckChip
const strings = internals.strings

// ── 中英文键集必须完全一致 ─────────────────────────────────────────────────
const zhKeys = Object.keys(strings.zh).sort()
const enKeys = Object.keys(strings.en).sort()
assert(JSON.stringify(zhKeys) === JSON.stringify(enKeys), '中英文键集不一致：仅 zh=' + zhKeys.filter(key => enKeys.includes(key) === false).join(',') + ' 仅 en=' + enKeys.filter(key => zhKeys.includes(key) === false).join(','))
for (const key of zhKeys) {
  assert(String(strings.zh[key]).trim() !== '', 'zh.' + key + ' 是空串')
  assert(String(strings.en[key]).trim() !== '', 'en.' + key + ' 是空串')
}

const html = (props) => renderToStaticMarkup(React.createElement(Chip, props))
const zh = key => strings.zh[key]
const en = key => strings.en[key]

// ── 1. 没有自检结果 → 不渲染（避免误报绿点） ───────────────────────────────
assert(html({ t: zh, report: null, onRecheck() {} }) === '', 'report=null 时应渲染空串')

const clean = {
  ok: true,
  plugin: 'dsh-pi',
  version: '0.1.0',
  git: { available: true, branch: 'master', commit: 'fcb6188012345678', detached: false },
  summary: { stale: false, changed: [], missing: [], hint: '内存中的插件代码与磁盘一致' },
  pi: { buildFresh: true },
}

// ── 2. 干净状态 → 绿色胶囊 ─────────────────────────────────────────────────
const okHtml = html({ t: zh, report: clean, onRecheck() {} })
console.log('clean =', okHtml)
assert(okHtml.includes('data-tone="ok"'), '干净状态该是 data-tone=ok，实际 ' + okHtml)
assert(okHtml.includes(zh('synced')), '干净状态该显示「' + zh('synced') + '」')
assert(okHtml.includes('git master @ fcb61880'), 'title 该带 git 分支与短 sha')

// ── 3. 磁盘改了 → 黄色胶囊，并点名文件 ────────────────────────────────────
const stale = JSON.parse(JSON.stringify(clean))
stale.ok = false
stale.summary.stale = true
stale.summary.changed = ['client.js']
stale.summary.hint = '磁盘上的 client.js 已修改，重启 DSH 后生效'
const staleHtml = html({ t: zh, report: stale, onRecheck() {} })
console.log('stale =', staleHtml)
assert(staleHtml.includes('data-tone="warn"'), '过期状态该是 data-tone=warn，实际 ' + staleHtml)
assert(staleHtml.includes(zh('staleCode')), '过期状态该显示「' + zh('staleCode') + '」')
assert(staleHtml.includes('client.js'), 'title 该点名被改的文件')

// ── 4. 只有 pi 构建过期 → 单独文案，不要和「插件代码改了」混为一谈 ─────────
const rebuild = JSON.parse(JSON.stringify(clean))
rebuild.pi.buildFresh = false
const rebuildHtml = html({ t: zh, report: rebuild, onRecheck() {} })
console.log('rebuild =', rebuildHtml)
assert(rebuildHtml.includes('data-tone="warn"'), '构建过期该是 data-tone=warn')
assert(rebuildHtml.includes(zh('staleBuild')), '构建过期该显示「' + zh('staleBuild') + '」')
assert(rebuildHtml.includes('npm run build'), 'title 该提示 npm run build')

// ── 5. 文件缺失 → 提示里点名 ───────────────────────────────────────────────
const gone = JSON.parse(JSON.stringify(clean))
gone.summary.stale = true
gone.summary.missing = ['src/pi-rpc.mjs']
gone.summary.hint = 'src/pi-rpc.mjs 已不在磁盘上，重启 DSH 后生效'
const goneHtml = html({ t: zh, report: gone, onRecheck() {} })
assert(goneHtml.includes('缺失：src/pi-rpc.mjs'), 'title 该列出缺失文件，实际 ' + goneHtml)

// ── 6. 英文文案走同一套逻辑 ───────────────────────────────────────────────
const enHtml = html({ t: en, report: stale, onRecheck() {} })
assert(enHtml.includes(en('staleCode')), '英文该显示「' + en('staleCode') + '」')

// ── 7. 点击回调真的被传下去（不渲染 fetch，只验证绑定存在） ────────────────
let clicks = 0
const interactive = html({ t: zh, report: clean, onRecheck: () => { clicks += 1 } })
assert(interactive.includes('<button'), '胶囊应该是 button，实际 ' + interactive)
assert(typeof clean !== 'undefined' && clicks === 0, '渲染阶段不应触发回调')

// ── 8. 运行时引导：缺 pi 时给出「一键安装」+ 已搜索位置清单 ───────────────
const Gate = internals.RuntimeGate
assert(typeof Gate === 'function', 'client.js 应导出 RuntimeGate 以便测试')
const gateHtml = renderToStaticMarkup(React.createElement(Gate, {
  t: zh,
  runtime: {
    ok: false,
    source: 'missing',
    cliPath: '',
    searched: [
      { source: 'plugin-node-modules', path: 'C:\\x\\dsh-pi\\node_modules', ok: false, reason: 'package not installed' },
      { source: 'config', path: 'C:\\y\\cli.js', ok: false, reason: 'not found' },
    ],
    install: { available: true, target: 'C:\\x\\dsh-pi\\.runtime', package: '@earendil-works/pi-coding-agent', version: '1.5.2', running: false },
  },
  onRecheck() {},
  onInstalled() {},
}))
console.log('gate =', gateHtml.slice(0, 320))
assert(gateHtml.includes(zh('runtimeMissing')), '引导页该显示「' + zh('runtimeMissing') + '」')
assert(gateHtml.includes(zh('installRuntime')), '引导页该有「' + zh('installRuntime') + '」按钮')
assert(gateHtml.includes(zh('runtimeMissingHint')), '引导页该有说明文案')
assert(gateHtml.includes('dsh-pi-gate-card'), '引导页该用 dsh-pi-gate-card 外壳')
assert(gateHtml.includes('.runtime'), '引导页该显示安装落点')
assert(gateHtml.includes('plugin-node-modules') && gateHtml.includes('config'), '引导页该列出所有查过的位置')
assert(gateHtml.includes('✗ '), '未命中的候选该标 ✗')

const gateEn = renderToStaticMarkup(React.createElement(Gate, {
  t: en,
  runtime: { ok: false, source: 'missing', searched: [], install: { available: true, target: 'X', running: false } },
  onRecheck() {},
  onInstalled() {},
}))
assert(gateEn.includes(en('runtimeMissing')), '英文引导页该显示「' + en('runtimeMissing') + '」')
assert(gateEn.includes(en('installRuntime')), '英文引导页该有安装按钮')

// ── 9. 扩展 UI 四种弹窗：结构 + 文案 + 预算 ────────────────────────────────
// 这一组挡两类回归：①四种 method 的按钮集被改串（confirm 的否定键曾借用开关态的 off）
// ②倒计时文案退化成「已取消」语义（pi 侧是剩余秒数，见 extension-selector.ts:56-63）。
const Dialog = internals.ExtensionDialog
assert(typeof Dialog === 'function', 'client.js 应导出 ExtensionDialog 以便测试')
assert(typeof internals.dialogBudgetMs === 'function', 'client.js 应导出 dialogBudgetMs 以便测试')

const requestOf = overrides => Object.assign({
  id: 'req-1',
  method: 'select',
  title: '',
  message: null,
  options: [],
  prefill: null,
  placeholder: null,
  timeout: null,
  receivedAt: 0,
}, overrides)
const dialogHtml = (overrides, translator) => renderToStaticMarkup(React.createElement(Dialog, {
  t: translator === undefined ? zh : translator,
  request: requestOf(overrides),
  onRespond() {},
}))

// 9.1 文案键本身
assert(zh('extNo') === '否', 'zh.extNo 应为「否」（confirm 的否定分支，pi TUI 写的是 No），实际 ' + JSON.stringify(zh('extNo')))
assert(en('extNo') === 'No', 'en.extNo 应为 No，实际 ' + JSON.stringify(en('extNo')))
assert(zh('extNo') !== zh('off') && en('extNo') !== en('off'), 'extNo 不该复用开关态的 off（中「关」/英 off 语义串线）')
assert(zh('extTimeout').includes('{n}'), 'zh.extTimeout 必须带 {n} 占位，实际 ' + JSON.stringify(zh('extTimeout')))
assert(en('extTimeout').includes('{n}'), 'en.extTimeout 必须带 {n} 占位，实际 ' + JSON.stringify(en('extTimeout')))
assert(zh('extTimeout').includes('还剩') && zh('extTimeout').includes('后自动取消'), 'zh.extTimeout 该是「还剩 Ns 后自动取消」语义，实际 ' + JSON.stringify(zh('extTimeout')))
assert(zh('extTimeout').includes('已') === false, 'zh.extTimeout 不该出现「已…」（那是取消之后的完成态，不是倒计时），实际 ' + JSON.stringify(zh('extTimeout')))

// 9.2 confirm：否 / 确认，不要输入控件
const confirmHtml = dialogHtml({ method: 'confirm', title: 'Clear session?', message: 'All messages will be lost.' })
console.log('confirm =', confirmHtml)
assert(confirmHtml.includes('role="dialog"'), 'confirm 该渲染 role=dialog')
assert(confirmHtml.includes(zh('extConfirm') + ' · Clear session?'), 'confirm 的 h3 该是「请确认 · Clear session?」，实际 ' + confirmHtml)
assert(confirmHtml.includes('All messages will be lost.'), 'confirm 该显示 message 正文')
assert(confirmHtml.includes('>' + zh('extNo') + '<') && confirmHtml.includes('>' + zh('extYes') + '<'), 'confirm 该有「' + zh('extNo') + '」「' + zh('extYes') + '」两个按钮')
assert(confirmHtml.includes('>' + zh('off') + '<') === false, 'confirm 不该再出现开关态的「' + zh('off') + '」')
assert(confirmHtml.includes('<input') === false && confirmHtml.includes('<textarea') === false, 'confirm 不该有输入控件')
assert(confirmHtml.includes('dsh-pi-btn-primary') === true, 'confirm 的肯定按钮该是 primary')

// 9.3 select：每个选项一个按钮 + 取消
const selectHtml = dialogHtml({ method: 'select', title: 'Pick an option', options: ['Option A', 'Option B', 'Option C'] })
console.log('select =', selectHtml)
assert(selectHtml.includes('dsh-pi-opt'), 'select 该用 dsh-pi-opt 渲染选项')
for (const option of ['Option A', 'Option B', 'Option C']) assert(selectHtml.includes('>' + option + '<'), 'select 该渲染选项 ' + option)
assert((selectHtml.match(/dsh-pi-opt/g) ?? []).length === 3, 'select 的选项按钮数应等于 options 长度')
assert(selectHtml.includes('>' + zh('cancel') + '<'), 'select 该有「' + zh('cancel') + '」按钮')
assert(selectHtml.includes('dsh-pi-btn-primary') === false, 'select 的选项不该是 primary（用户还没选）')

// 9.4 input：回填 prefill 进 value、placeholder 透传、取消 / 提交
const inputHtml = dialogHtml({ method: 'input', title: 'Enter a value', placeholder: 'type something...', prefill: 'pre-filled' })
console.log('input =', inputHtml)
assert(inputHtml.includes('<input'), 'input 该渲染 <input>')
assert(inputHtml.includes('placeholder="type something..."'), 'input 该透传 placeholder')
assert(inputHtml.includes('value="pre-filled"'), 'input 该回填 prefill 到 value')
assert(inputHtml.includes('>' + zh('cancel') + '<') && inputHtml.includes('>' + zh('extSubmit') + '<'), 'input 该有取消 / 提交两个按钮')
assert(inputHtml.includes(zh('extInput') + ' · Enter a value'), 'input 的 h3 该用 extInput 前缀')

// 9.5 editor：多行 prefill 原样进 textarea
const editorHtml = dialogHtml({ method: 'editor', title: 'Edit some text', prefill: 'Line 1\nLine 2\nLine 3' })
console.log('editor =', editorHtml)
assert(editorHtml.includes('<textarea'), 'editor 该渲染 <textarea>')
assert(editorHtml.includes('Line 1') && editorHtml.includes('Line 3'), 'editor 该回填多行 prefill')
assert(editorHtml.includes('>' + zh('extSubmit') + '<'), 'editor 该有提交按钮')
assert(editorHtml.includes('<input') === false, 'editor 不该混入 <input>')

// 9.6 空 title 回落到方法名，避免出现「请选择 · 」
const untitled = dialogHtml({ method: 'select', title: '', options: ['x'] })
assert(untitled.includes(zh('extSelect') + ' · ' + zh('extSelect')), '空 title 该回落成「请选择 · 请选择」，实际 ' + untitled)

// 9.7 英文侧同一套结构
const confirmEn = dialogHtml({ method: 'confirm', title: 'Clear session?', message: 'gone' }, en)
assert(confirmEn.includes(en('extNo')) && confirmEn.includes(en('extYes')), '英文 confirm 该有 No / Confirm')
assert(confirmEn.includes('>' + en('off') + '<') === false, '英文 confirm 不该出现开关态的 off')

// 9.8 倒计时预算是「扩展声明值与 5 分钟上限取小」，四类非法值一律回落上限
const budget = internals.dialogBudgetMs
assert(budget(requestOf({ timeout: 120000 })) === 120000, '声明 120s 时预算该是 120s')
assert(budget(requestOf({ timeout: 600000 })) === 300000, '声明 600s 超过 5 分钟上限时该被压到 300s')
assert(budget(requestOf({ timeout: null })) === 300000, '未声明 timeout 时该回落 5 分钟')
for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
  assert(budget(requestOf({ timeout: bad })) === 300000, '非法 timeout ' + String(bad) + ' 该回落 5 分钟')
}

// 9.9 静态渲染不出现倒计时：left 由 useEffect 驱动，SSR 阶段为 null。
// 这条不是缺陷而是硬约束 —— 想断言「还剩 Ns」必须走真实浏览器（test/ui-dialog 那套）。
assert(confirmHtml.includes(zh('extTimeout')) === false, 'SSR 阶段不该渲染倒计时行（left 初值 null）')

// ── 9.10 空态：cwd 之后必须有「选择工作区」入口（0.4.0） ───────────────────
const EmptyState = internals.EmptyState
assert(typeof EmptyState === 'function', 'client.js 应导出 EmptyState 以便测试')
const emptyHtml = renderToStaticMarkup(React.createElement(EmptyState, { t: zh, meta: 'C:\\Users\\PC\\pi-workspace', onPickDir() {} }))
console.log('empty =', emptyHtml)
assert(emptyHtml.includes('dsh-pi-empty-actions'), '空态该有动作行 dsh-pi-empty-actions')
assert(emptyHtml.includes(zh('pickDir')), '空态该显示「' + zh('pickDir') + '」按钮，实际 ' + emptyHtml)
assert(emptyHtml.includes(zh('dirTitle')), '空态按钮的 title 该用 dirTitle')
assert(emptyHtml.indexOf(zh('pickDir')) > emptyHtml.indexOf('C:\\Users\\PC\\pi-workspace'), '入口必须排在 cwd 之后（用户红框位置）')
// 用户在 0.4.0 要求统一叫「工作区」：任何地方都不该再出现「工作目录」这个旧说法。
assert(zh('pickDir') === '选择工作区', '空态入口文案该是「选择工作区」，实际 ' + zh('pickDir'))
assert(zh('dirTitle') === '选择工作区', '弹窗标题文案该是「选择工作区」，实际 ' + zh('dirTitle'))
const zhAll = JSON.stringify(strings.zh)
const clientSource = fs.readFileSync(path.join(root, 'client.js'), 'utf8')
function cssRule(selector) {
  const needle = "'" + selector + '{'
  const at = clientSource.indexOf(needle)
  if (at < 0) return null
  const end = clientSource.indexOf("}',", at)
  return clientSource.slice(at + 1, end + 1)
}
const toolRule = cssRule('.dsh-pi-tool')
const toolBodyRule = cssRule('.dsh-pi-tool-body')
assert(toolRule !== null, 'client.js 里该有 .dsh-pi-tool 规则')
assert(toolBodyRule !== null, 'client.js 里该有 .dsh-pi-tool-body 规则')
assert(toolRule.includes('border-radius:0'), '.dsh-pi-tool 不该有圆角（用户要求过程行不加圆角框），实际 ' + toolRule)
assert(toolRule.includes('background:transparent'), '.dsh-pi-tool 不该有底色，实际 ' + toolRule)
assert(toolRule.includes('box-shadow:none'), '.dsh-pi-tool 不该有 hairline 外框，实际 ' + toolRule)
assert(toolBodyRule.includes('border-left:1px solid var(--dsw-alias-border-l3)'), '.dsh-pi-tool-body 展开区该用左侧竖线区隔（与思考过程同一套语言），实际 ' + toolBodyRule)
const enAll = JSON.stringify(strings.en)
assert(zhAll.indexOf('工作目录') < 0, 'ZH 文案表里不该再有「工作目录」字样：' + zhAll.slice(zhAll.indexOf('工作目录') - 40, zhAll.indexOf('工作目录') + 20))
assert(enAll.indexOf('working directory') < 0, 'EN 文案表里不该再有 working directory 字样')
const emptyNoAction = renderToStaticMarkup(React.createElement(EmptyState, { t: zh, meta: null }))
assert(emptyNoAction.includes('dsh-pi-empty-actions') === false, '没传 onPickDir 时不该渲染动作行')
const emptyEn = renderToStaticMarkup(React.createElement(EmptyState, { t: en, meta: 'C:\\x', onPickDir() {} }))
assert(emptyEn.includes(en('pickDir')), '英文空态该显示 ' + en('pickDir'))

// ── 9.11 设置抽屉：开关必须是 DSH 的 aria switch，不是文字按钮 ──────────────
const SettingsSheet = internals.SettingsSheet
assert(typeof SettingsSheet === 'function', 'client.js 应导出 SettingsSheet 以便测试')
const settingsHtml = renderToStaticMarkup(React.createElement(SettingsSheet, {
  t: zh,
  state: { autoCompactionEnabled: true, autoRetryEnabled: false, steeringMode: 'one-at-a-time', followUpMode: 'one-at-a-time' },
  onClose() {},
  onAutoCompaction() {},
  onAutoRetry() {},
  onSteering() {},
  onFollowUp() {},
}))
console.log('settings =', settingsHtml)
assert(settingsHtml.includes('class="dsh-pi-switch"'), '开关该用 .dsh-pi-switch（DSH 胶囊样式）')
assert(settingsHtml.includes('role="switch"'), '开关该声明 role=switch')
assert(settingsHtml.includes('aria-checked="true"'), '开启态该 aria-checked=true')
assert(settingsHtml.includes('aria-checked="false"'), '关闭态该 aria-checked=false')
assert(settingsHtml.includes('dsh-pi-switch-thumb'), '开关该有滑块元素')
// 文字开关会渲染出 >开< / >关< 的按钮文本；改成胶囊后这段文本必须消失（a11y 由 aria 承载）。
assert(settingsHtml.includes('>' + zh('on') + '<') === false, '开关不该再把「' + zh('on') + '」当按钮文本')
assert(settingsHtml.includes('>' + zh('off') + '<') === false, '开关不该再把「' + zh('off') + '」当按钮文本')
assert(settingsHtml.includes(zh('autoCompact')) && settingsHtml.includes(zh('autoRetry')), '设置项标签该照旧显示')

// ── 9.11b 工具行：展开区不是圆角卡片（用户 18994 明确要求拆掉圆角框） ────────
// 过程流里一次任务会连着十几次工具调用。每行都套 border-radius + hairline + 底色，
// 视觉上就是「框套框」的噪音墙。这里守住三点：无圆角、无背景、无外框，
// 展开区改用左侧竖线（与 .dsh-pi-think 同一套语言）区分层级。
const ToolBlock = internals.ToolBlock
const BashBlockCmp = internals.BashBlock
const ToolResultRow = internals.ToolResultRow
assert(typeof ToolBlock === 'function', 'client.js 应导出 ToolBlock 以便测试')
assert(typeof BashBlockCmp === 'function', 'client.js 应导出 BashBlock 以便测试')
assert(typeof ToolResultRow === 'function', 'client.js 应导出 ToolResultRow 以便测试')
const toolHtml = renderToStaticMarkup(React.createElement(ToolBlock, { t: zh, name: 'bash', argsText: '{"command":"echo hi"}', status: 'done', partial: '' }))
const bashHtml = renderToStaticMarkup(React.createElement(BashBlockCmp, { t: zh, message: { role: 'bashExecution', bash: { command: 'echo hi', output: 'hi', exitCode: 0, cancelled: false, truncated: false } } }))
const resultHtml = renderToStaticMarkup(React.createElement(ToolResultRow, { t: zh, message: { role: 'toolResult', toolName: 'bash', isError: false, blocks: [{ type: 'text', text: 'hi' }] } }))
for (const [label, markup] of [['工具调用', toolHtml], ['bash 结果', bashHtml], ['工具结果', resultHtml]]) {
  assert(markup.includes('class="dsh-pi-tool"'), label + '该用 .dsh-pi-tool 行容器，实际 ' + markup.slice(0, 200))
  assert(markup.includes('dsh-pi-sheet') === false, label + '不该套抽屉外壳')
}
// 三处渲染必须共用同一个容器类名，样式改动才不会漏掉某一类过程行。
assert(toolHtml.includes('echo hi') && bashHtml.includes('echo hi') && resultHtml.includes('hi'), '三类过程行都该渲染出内容')

// ── 9.12 pathCrumbs：面包屑切分（只做字符串，不碰 fs） ─────────────────────
const pathCrumbs = internals.pathCrumbs
assert(typeof pathCrumbs === 'function', 'client.js 应导出 pathCrumbs 以便测试')
const winCrumbs = pathCrumbs('C:\\Users\\PC\\pi-workspace')
assert(JSON.stringify(winCrumbs.map(c => c.label)) === JSON.stringify(['C:', 'Users', 'PC', 'pi-workspace']), 'Windows 路径该切成 4 段，实际 ' + JSON.stringify(winCrumbs.map(c => c.label)))
assert(winCrumbs[winCrumbs.length - 1].path === 'C:\\Users\\PC\\pi-workspace', '最后一段的累积路径该是完整路径，实际 ' + winCrumbs[winCrumbs.length - 1].path)
assert(winCrumbs[1].path === 'C:\\Users', '中间段的累积路径该逐级拼接，实际 ' + winCrumbs[1].path)
const posixCrumbs = pathCrumbs('/home/pc')
assert(JSON.stringify(posixCrumbs.map(c => c.label)) === JSON.stringify(['/', 'home', 'pc']), 'POSIX 路径该切成 / home pc，实际 ' + JSON.stringify(posixCrumbs.map(c => c.label)))
assert(posixCrumbs[2].path === '/home/pc', 'POSIX 累积路径该是 /home/pc，实际 ' + posixCrumbs[2].path)
assert(JSON.stringify(pathCrumbs('')) === '[]', '空路径该返回空数组')

// ── 9.13 DirSheet：SSR 首帧（useEffect 不跑，停在 loading）能渲染不抛异常 ────
const DirSheet = internals.DirSheet
assert(typeof DirSheet === 'function', 'client.js 应导出 DirSheet 以便测试')
const dirHtml = renderToStaticMarkup(React.createElement(DirSheet, { t: zh, startDir: 'C:\\Users\\PC\\pi-workspace', onPick() {}, onClose() {} }))
console.log('dirsheet =', dirHtml)
assert(dirHtml.includes('dsh-pi-dir'), 'DirSheet 该渲染 .dsh-pi-dir 容器')
assert(dirHtml.includes(zh('dirTitle')), 'DirSheet 标题该是「' + zh('dirTitle') + '」')
assert(dirHtml.includes('dsh-pi-dir-crumbs'), 'DirSheet 该渲染面包屑')
assert(dirHtml.includes('pi-workspace'), '面包屑该带最后一级目录名')
assert(dirHtml.includes(zh('dirLoading')), '首帧该显示读取中文案（effect 尚未跑）')
assert(dirHtml.includes(zh('dirHere')), '底部该有「' + zh('dirHere') + '」按钮')
assert(dirHtml.includes(zh('dirInputHint')), '该有可编辑路径输入框（placeholder ' + zh('dirInputHint') + '）')
assert(dirHtml.split('class="dsh-pi-dir-col"').length - 1 === 1, '未选中时只该有一栏（Miller 分栏的第二栏靠选中触发）')
// 选择工作区必须是居中模态（不是铺满面板的抽屉）：它是会打断当前会话的决策。
assert(dirHtml.includes('dsh-pi-dialog-wrap'), '选择工作区该是模态弹窗（.dsh-pi-dialog-wrap）')
assert(dirHtml.includes('dsh-pi-dir-dialog'), '选择工作区该有 680x500 的弹窗外壳')
assert(dirHtml.includes('role="dialog"'), '弹窗该声明 role=dialog')
assert(dirHtml.includes('aria-modal="true"'), '弹窗该声明 aria-modal=true（模态语义）')
assert(dirHtml.includes('dsh-pi-sheet') === false, '选择工作区不该再用铺满面板的 .dsh-pi-sheet 外壳')
// 首帧 roots 尚未从 host 取回（空数组）→ 不能凭空画出「此电脑」入口，
// 否则用户点进去会看到空列表。入口只在真拿到盘符后才出现。
assert(dirHtml.includes(zh('dirThisPc')) === false, '首帧没有盘符列表时不该渲染「' + zh('dirThisPc') + '」入口')

// ── 9.14 dirPickModel：Miller 分栏与采纳目标的纯逻辑（0.4.0） ───────────────
const dirPickModel = internals.dirPickModel
assert(typeof dirPickModel === 'function', 'client.js 应导出 dirPickModel 以便测试')
const listings = {
  dir: 'C:\\a',
  entries: [{ name: 'b', path: 'C:\\a\\b' }, { name: 'Bee', path: 'C:\\a\\Bee' }, { name: 'c', path: 'C:\\a\\c' }],
}
const m0 = dirPickModel({ listing: listings, selected: null, deep: null, query: '' })
assert(m0.showSub === false, '未选中时不该出现第二栏')
assert(m0.main.length === 3, '未选中时第一栏列出全部子项，实际 ' + String(m0.main.length))
assert(m0.sub.length === 0, '未选中时第二栏为空')
assert(m0.target === 'C:\\a', '未选中时采纳目标回落到当前层级，实际 ' + m0.target)
const m1 = dirPickModel({ listing: listings, selected: 'C:\\a\\b', deep: null, query: '' })
assert(m1.showSub === true, '选中后该出现第二栏')
assert(m1.main.length === 3, '选中后第一栏仍列出全部子项（不过滤）')
assert(m1.target === 'C:\\a\\b', '选中且未深入时采纳目标 = 选中项，实际 ' + m1.target)
const m2 = dirPickModel({ listing: listings, selected: 'C:\\a\\b', deep: 'C:\\a\\b\\d', query: '' })
assert(m2.target === 'C:\\a\\b\\d', '深入第二栏后采纳目标优先 deep，实际 ' + m2.target)
const m3 = dirPickModel({ listing: listings, selected: null, deep: null, query: 'b' })
assert(m3.main.length === 2, '未选中时前缀过滤作用于第一栏（b + Bee），实际 ' + String(m3.main.length))
const m4 = dirPickModel({
  listing: listings,
  selected: 'C:\\a\\b',
  deep: null,
  query: 'x',
  sub: { entries: [{ name: 'x1', path: 'C:\\a\\b\\x1' }, { name: 'y', path: 'C:\\a\\b\\y' }] },
})
assert(m4.main.length === 3, '选中后过滤不该作用于第一栏，实际 ' + String(m4.main.length))
assert(m4.sub.length === 1, '选中后过滤作用于第二栏（x1），实际 ' + String(m4.sub.length))
const m5 = dirPickModel({ listing: null, selected: '', deep: '', query: '   ' })
assert(m5.main.length === 0 && m5.target === '', '空输入该安全返回空模型')
assert(dirPickModel(undefined).showSub === false, '不传参数也不该抛异常')

// ── 9.15 「此电脑」层：盘符根列表（0.4.0，用户可见的跨盘选择） ──────────────
const roots = [{ name: 'C:', path: 'C:\\' }, { name: 'D:', path: 'D:\\' }, { name: 'E:', path: 'E:\\' }]
const r0 = dirPickModel({ listing: listings, roots, rootsView: true, selected: null, deep: null, query: '' })
assert(r0.rootsView === true, 'rootsView 该透传')
assert(r0.main.length === 3, '此电脑层第一栏列出全部盘符，实际 ' + String(r0.main.length))
assert(r0.main[0].name === 'C:', '盘符顺序照 host 给的顺序（A-Z 探测），实际 ' + String(r0.main[0].name))
assert(r0.target === null, '此电脑层未选盘时没有可采纳目标（不能拿下层目录冒充），实际 ' + String(r0.target))
const r1 = dirPickModel({ listing: listings, roots, rootsView: true, selected: 'D:\\', deep: null, query: '' })
assert(r1.showSub === true, '选中盘符后该出现第二栏（盘内子目录）')
assert(r1.target === 'D:\\', '选中盘符后采纳目标 = 盘根，实际 ' + String(r1.target))
const r2 = dirPickModel({ listing: listings, roots, rootsView: true, selected: 'D:\\', deep: 'D:\\proj', query: '' })
assert(r2.target === 'D:\\proj', '盘内深入第二栏后采纳目标优先 deep，实际 ' + String(r2.target))
const r3 = dirPickModel({ listing: listings, roots, rootsView: true, selected: null, deep: null, query: 'd' })
assert(r3.main.length === 1 && r3.main[0].name === 'D:', '此电脑层过滤只命中 D:，实际 ' + String(r3.main.length))
// 非此电脑层必须忽略 roots：盘符不该混进普通目录列表。
const r4 = dirPickModel({ listing: listings, roots, rootsView: false, selected: null, deep: null, query: '' })
assert(r4.main.length === 3 && r4.main[0].name === 'b', '普通层级不该把盘符混进列表，实际 ' + String(r4.main[0].name))
assert(r4.target === 'C:\\a', '普通层级采纳目标仍是当前层级，实际 ' + String(r4.target))
const r5 = dirPickModel({ listing: null, roots: null, rootsView: true, selected: null, deep: null, query: '' })
assert(r5.main.length === 0 && r5.target === null, '此电脑层没有任何盘符时该安全返回空列表与空目标')

// ── 9.16 get_messages → 面板消息列表（0.4.1：修「点开历史会话没有内容」） ──────
// 根因：switch_session / fork / clone / new_session 之后 host 会 resetEvents，
// 事件缓冲归零，snapshot 里没有任何历史；旧实现只重放事件，面板必然空白。
// 修法：挂载后调 get_messages，并用 messagesFromHistory 整表重建。
const history = [
  { role: 'system', content: [{ type: 'text', text: 'system prompt '.repeat(100) }] },
  { role: 'user', content: [{ type: 'text', text: '第一个问题' }] },
  {
    role: 'assistant',
    content: [{ type: 'text', text: '答案一' }],
    usage: { input: 10, output: 5, cacheRead: 100, totalTokens: 115 },
  },
  { role: 'toolResult', toolCallId: 'call_1', toolName: 'bash', content: [{ type: 'text', text: 'ok' }] },
  { role: 'bashExecution', command: 'echo hi', output: 'hi', exitCode: 0 },
]
const rebuilt = internals.messagesFromHistory(history)
assert(Array.isArray(rebuilt) === true, 'messagesFromHistory 该返回数组')
assert(rebuilt.length === 4, 'system 提示词必须被剔除，实际 ' + String(rebuilt === null ? 'null' : rebuilt.length))
assert(rebuilt[0].role === 'user', '第一条应是 user，实际 ' + String(rebuilt[0].role))
assert(rebuilt[0].blocks[0].text === '第一个问题', '用户文本该逐字保留')
assert(rebuilt[1].role === 'assistant' && rebuilt[1].blocks[0].text === '答案一', '助手文本该保留')
assert(rebuilt[1].usage !== null && rebuilt[1].usage.totalTokens === 115, 'usage 该被 makeMessage 带出来')
assert(rebuilt[2].role === 'toolResult' && rebuilt[2].toolName === 'bash', 'toolResult 该带 toolName')
assert(rebuilt[3].role === 'bashExecution' && rebuilt[3].bash.output === 'hi', 'bashExecution 的语气泡数据该保留')
assert(rebuilt[0].seq === 0 && rebuilt[3].seq === 3, 'seq 用数组下标（与 host 事件序号无关）')
assert(internals.messagesFromHistory(null) === null, '非数组入参返回 null（调用方据此跳过覆盖）')
assert(internals.messagesFromHistory('x') === null, '字符串入参也返回 null')
assert(internals.messagesFromHistory([]).length === 0, '空历史返回空数组（不是 null）')
const allSystem = internals.messagesFromHistory([{ role: 'system', content: [] }])
assert(allSystem.length === 0, '只有 system 时该得到空列表，实际 ' + String(allSystem.length))
const dirty = internals.messagesFromHistory([null, 'x', { role: 'user', content: 'hi' }])
assert(dirty.length === 1 && dirty[0].blocks[0].text === 'hi', '脏数据该被跳过，string content 兜底成 text 块')

// ── 9.17 历史会话抽屉：两级导航（0.5.0 修「历史会话只显示一条」） ──────────────
// 根因：面板把当前 cwd 当成唯一过滤条件，host 端空 cwd 又回落 workspace，
// 结果抽屉永远只列得出一个项目的会话。修法是照 pi SessionSelectorComponent 做两级：
// 第一层列全部项目（当前置顶 → 非临时优先 → 最近活动降序），点进项目再列该 cwd 的会话。
// SessionsList 是纯渲染视图（容器 SessionsSheet 负责取数与层级切换），所以这里能直接喂假数据。
assert(typeof internals.SessionsList === 'function', 'client.js 应导出 SessionsList 以便测试')
const projEntries = [
  { key: 'c:\\users\\pc\\pi-workspace', cwd: 'C:\\Users\\PC\\pi-workspace', displayPath: '~\\pi-workspace', sessionCount: 3, lastActivity: '2026-11-13T10:00:00.000Z', isTemporary: false, isCurrent: true },
  { key: 'd:\\proj', cwd: 'D:\\proj', displayPath: 'D:\\proj', sessionCount: 1, lastActivity: '2026-11-12T10:00:00.000Z', isTemporary: false, isCurrent: false },
  { key: 'c:\\temp\\pi-runtime-1', cwd: 'C:\\temp\\pi-runtime-1', displayPath: 'C:\\temp\\pi-runtime-1', sessionCount: 2, lastActivity: '2026-11-13T09:00:00.000Z', isTemporary: true, isCurrent: false },
]
const sessEntries = [
  { path: 'D:\\proj\\a.jsonl', name: null, firstMessage: 'q1', lastMessage: '答一', messageCount: 4, modified: '2026-11-12T10:00:00.000Z', cwd: 'D:\\proj' },
  { path: 'D:\\proj\\b.jsonl', name: 'NAMED', firstMessage: 'q2', lastMessage: '答二', messageCount: 9, modified: '2026-11-11T10:00:00.000Z', cwd: 'D:\\proj' },
]
const projectLevel = renderToStaticMarkup(React.createElement(internals.SessionsList, {
  t: zh, level: 'projects', project: null, query: '', currentPath: null,
  info: { loading: false, error: null, projects: projEntries, sessions: [], total: 6 },
  onQuery() {}, onOpenProject() {}, onBack() {}, onPick() {}, onClose() {},
}))
assert(projectLevel.includes('class="dsh-pi-proj"'), '项目层该渲染 .dsh-pi-proj 行')
assert(projectLevel.includes('class="dsh-pi-sess"') === false, '项目层不该混入会话行（项目行复用 sess-top/sess-title 排版，但外层类名必须是 dsh-pi-proj）')
assert(projectLevel.includes('data-current="1"'), '当前项目该打 data-current=1')
assert(projectLevel.includes('data-temporary="1"'), '临时项目该打 data-temporary=1')
assert(projectLevel.includes(zh('tempTag')), '临时项目该显示「' + zh('tempTag') + '」标签')
assert(projectLevel.includes('~\\pi-workspace'), '项目行标题该用 displayPath（~ 缩写），而不是绝对路径')
assert(projectLevel.includes(zh('projectSessions').replace('{n}', '3')), '项目行该显示会话数：' + zh('projectSessions').replace('{n}', '3'))
assert(projectLevel.includes('← ' + zh('allProjects')) === false, '项目层不该出现返回按钮')
const sessionLevel = renderToStaticMarkup(React.createElement(internals.SessionsList, {
  t: zh, level: 'sessions', project: projEntries[1], query: '', currentPath: 'D:\\proj\\b.jsonl',
  info: { loading: false, error: null, projects: [], sessions: sessEntries, total: 2 },
  onQuery() {}, onOpenProject() {}, onBack() {}, onPick() {}, onClose() {},
}))
assert(sessionLevel.includes('class="dsh-pi-sess"'), '会话层该渲染 .dsh-pi-sess 行')
assert(sessionLevel.includes('class="dsh-pi-proj"') === false, '会话层不该混入项目行')
assert(sessionLevel.includes('← ' + zh('allProjects')), '会话层该有回到项目层的按钮')
assert(sessionLevel.includes('D:\\proj'), '会话层标题该是项目路径')
assert(sessionLevel.includes('dsh-pi-tag'), '会话层该给当前会话打「' + zh('current') + '」标签')
assert(sessionLevel.includes(zh('sessionsHint')), '会话层该显示会话提示文案')
const filteredLevel = renderToStaticMarkup(React.createElement(internals.SessionsList, {
  t: zh, level: 'projects', project: null, query: 'd:\\proj', currentPath: null,
  info: { loading: false, error: null, projects: projEntries, sessions: [], total: 6 },
  onQuery() {}, onOpenProject() {}, onBack() {}, onPick() {}, onClose() {},
}))
assert(filteredLevel.split('class="dsh-pi-proj"').length - 1 === 1, '搜索该把项目层过滤到 1 行（路径也参与匹配）')
const loadingLevel = renderToStaticMarkup(React.createElement(internals.SessionsList, {
  t: zh, level: 'projects', project: null, query: '', currentPath: null,
  info: { loading: true, error: null, projects: [], sessions: [], total: 0 },
  onQuery() {}, onOpenProject() {}, onBack() {}, onPick() {}, onClose() {},
}))
assert(loadingLevel.includes(zh('projectsLoading')), '项目层加载态该用「' + zh('projectsLoading') + '」而不是会话文案')
const emptyLevel = renderToStaticMarkup(React.createElement(internals.SessionsList, {
  t: en, level: 'projects', project: null, query: '', currentPath: null,
  info: { loading: false, error: null, projects: [], sessions: [], total: 0 },
  onQuery() {}, onOpenProject() {}, onBack() {}, onPick() {}, onClose() {},
}))
assert(emptyLevel.includes(en('projectsEmpty')), '英文空项目层该显示 ' + en('projectsEmpty'))
assert(emptyLevel.includes(en('projectsHint')), '英文项目层该显示 ' + en('projectsHint'))
// ── 10. 助手文本里的文件路径 → 可点标签（右栏预览的入口） ──────────────────
//
// 识别规则必须「宁可少认，不要误认」：URL、版本号、example.com、/model 这类命令
// 一旦被标成文件，正文就变得没法读了。所以正例与反例都要锁住。
const NL = String.fromCharCode(10)
const BS = String.fromCharCode(92)
const chip = (value) => renderToStaticMarkup(React.createElement('div', null, internals.renderFileChip(value, 'k', null)))
assert(chip('C:' + BS + 'Users' + BS + 'PC' + BS + 'a.md').includes('class="dsh-pi-fileref"'), '盘符绝对路径该渲染成 dsh-pi-fileref 按钮')
assert(chip('C:' + BS + 'Users' + BS + 'a.md').includes('type="button"'), '文件标签必须是真正的 button：键盘 Tab 要能落上去')
assert(chip('C:' + BS + 'a.md').includes('data-path='), '文件标签要把原始路径放在 data-path 上，供点击时取')
assert(chip('C:' + BS + 'a.md').includes('dsh-pi-fileref-name">a.md'), '文件标签末段该是文件名')
assert(internals.isFilePathToken('C:' + BS + 'x' + BS + 'y.json') === true, '盘符路径是真的')
assert(internals.isFilePathToken('~/notes/todo.md') === true, '~/ 开头的路径是真的')
assert(internals.isFilePathToken('./src/index.ts') === true, './ 开头的相对路径是真的')
assert(internals.isFilePathToken('src/modes/interactive-mode.ts') === true, '带分隔符的相对路径是真的')
assert(internals.isFilePathToken('README.md') === true, '白名单扩展名的裸文件名是真的')
assert(internals.isFilePathToken('https://example.com/a.md') === false, 'URL 不是文件')
assert(internals.isFilePathToken('example.com') === false, '域名不是文件（.com 不在白名单）')
assert(internals.isFilePathToken('v1.2.3') === false, '版本号不是文件（数字扩展名一律不认）')
assert(internals.isFilePathToken('/model') === false, '/model 是斜杠命令，不是文件')
assert(internals.isFilePathToken('C:' + BS + 'a.md.') === false, '尾部句号说明它不是一条干净的路径')
assert(internals.splitFileTokens('见 C:' + BS + 'Users' + BS + 'x' + BS + 'a.md。').length === 1, '中文句号包着的路径该被切出来')
const prose = renderToStaticMarkup(React.createElement('div', null, internals.renderMarkdown('结论在 C:' + BS + 'out' + BS + 'report.md 里。', null)))
assert(prose.includes('dsh-pi-fileref'), '段落正文里的路径该变成标签')
assert(prose.includes('结论在'), '标签前后的纯文本必须原样保留（不吞字）')
assert(prose.includes('里。'), '路径后面的纯文本也要保留')
assert(prose.includes('data-openable="0"'), '没有 opener 时标签标 data-openable=0，不假装可点')
const fenced = renderToStaticMarkup(React.createElement('div', null, internals.renderMarkdown('```' + NL + 'D:' + BS + 'work' + BS + 'artifacts' + BS + 'handoff.md' + NL + '```', null)))
assert(fenced.includes('dsh-pi-fileref-block'), '围栏里整块只有一条路径时整块变成标签（用户截图就是这种）')
assert(fenced.includes('dsh-pi-fence') === false, '整块变成标签后不该再套一层代码块')
const multiFence = renderToStaticMarkup(React.createElement('div', null, internals.renderMarkdown('```' + NL + 'npm run build' + NL + 'npm test' + NL + '```', null)))
assert(multiFence.includes('dsh-pi-fence'), '多行代码块必须保持代码块，绝不拆成标签')
const inlineCode = renderToStaticMarkup(React.createElement('div', null, internals.renderMarkdown('路径是 `' + 'C:' + BS + 'a' + BS + 'b.md' + '` 别复制', null)))
assert(inlineCode.includes('dsh-pi-fileref'), '行内反引号里整段是路径时该变成标签（助手常这么写）')
const plainInline = renderToStaticMarkup(React.createElement('div', null, internals.renderMarkdown('`npm test`', null)))
assert(plainInline.includes('dsh-pi-code-inline'), '行内 code 不是路径时必须保持 code 样式')
const addr = internals.sessionFileAddress('s-1', 'C:' + BS + 'Users' + BS + 'a b' + BS + 'x.md')
assert(addr.indexOf('dsh-resource://file/session/s-1/') === 0, '文件地址必须是 session 作用域：absolute 作用域没有授权会话，读不出来')
assert(addr.includes('C:/Users/a%20b/x.md'), '反斜杠要转正斜杠、段内空格要编码、盘符冒号保持字面：' + addr)
assert(internals.absolutePathOf('C:' + BS + 'w', 'a' + BS + 'b.md') === 'C:' + BS + 'w' + BS + 'a' + BS + 'b.md', '相对路径按 pi 的 cwd 补绝对')
assert(internals.absolutePathOf('C:' + BS + 'w', 'D:' + BS + 'z.md') === 'D:' + BS + 'z.md', '已经是绝对路径就原样返回')
const fileSheetText = renderToStaticMarkup(React.createElement(internals.FileSheet, { t: zh, view: { loading: false, path: 'C:' + BS + 'a.md', error: null, kind: 'text', mimeType: 'text/markdown', text: '# hi', data: '', size: 4, truncated: false }, onClose() {} }))
assert(fileSheetText.includes(zh('filePreview')), '回落预览的标题该是「' + zh('filePreview') + '」')
assert(fileSheetText.includes('# hi'), '文本预览该原样显示内容')
const fileSheetBin = renderToStaticMarkup(React.createElement(internals.FileSheet, { t: zh, view: { loading: false, path: 'C:' + BS + 'a.exe', error: null, kind: 'binary', mimeType: 'application/octet-stream', text: '', data: '', size: 2048, truncated: false }, onClose() {} }))
assert(fileSheetBin.includes(zh('binaryFile').replace('{size}', '2048')), '二进制只报大小，不假装能渲染')

// ── 11. 文件标签的两种动作 + 关闭按钮统一 + 输入框提示语 ────────────────────
//
// 这一组挡三类回归：①右键定位（reveal）被接线漏掉，标签悄悄变成只有左键可用
// ②抽屉 / 目录弹窗 / 扩展弹窗的关闭入口又分叉回纯文本 '×'
// ③快捷键提示又被塞回 placeholder，输入第一个字符就消失。
const chipWithActions = (value, actions) => renderToStaticMarkup(React.createElement('div', null, internals.renderFileChip(value, 'k', actions)))
const onlyOpen = chipWithActions('C:' + BS + 'a.md', { open() {}, reveal: null })
assert(onlyOpen.includes('data-openable="1"'), '只给 open 时标签标 data-openable=1')
assert(onlyOpen.includes('data-revealable="0"'), '没有 reveal 时标 data-revealable=0（不假装能右键）')
const bothActions = chipWithActions('C:' + BS + 'a.md', { open() {}, reveal() {} })
assert(bothActions.includes('data-openable="1"') && bothActions.includes('data-revealable="1"'), '同时给 open/reveal 时两个标记都该是 1')
assert(chipWithActions('C:' + BS + 'a.md', () => {}).includes('data-revealable="0"'), '直接传函数等于只给 open，reveal 仍标 0')
assert(bothActions.includes('data-kind="doc"'), '标签要带类型：a.md 归到 doc，实际 ' + bothActions)
assert(chipWithActions('C:' + BS + 'a.zip', { open() {}, reveal() {} }).includes('data-kind="archive"'), '.zip 归到 archive')
assert(chipWithActions('C:' + BS + 'a.ts', { open() {}, reveal() {} }).includes('data-kind="code"'), '.ts 归到 code')
assert(chipWithActions('C:' + BS + 'a.png', { open() {}, reveal() {} }).includes('data-kind="image"'), '.png 归到 image')
assert(chipWithActions('C:' + BS + 'a.unknownext', { open() {}, reveal() {} }).includes('data-kind="file"'), '未知扩展名兜底成 file，不能崩')
// 标签只露文件名（用户要求「只显示图标 + 文件名 + 后缀」），目录不再作为灰字出现。
assert(bothActions.includes('dsh-pi-fileref-dir') === false, '文件标签不该再显示目录灰字')
assert(bothActions.includes('>a.md<'), '文件标签正文就是文件名')

// 关闭按钮：三处入口共用同一个组件，图标是 svg 而不是文本 ×
const closeHtml = renderToStaticMarkup(React.createElement(internals.CloseButton, { t: zh, onClick() {} }))
assert(closeHtml.includes('dsh-pi-btn-icon'), '关闭按钮该带 dsh-pi-btn-icon（28px 命中区，与其它按钮同高）')
assert(closeHtml.includes('<svg'), '关闭按钮该用描边图标，不是纯文本 ×')
assert(closeHtml.includes('aria-label="' + zh('close') + '"'), '关闭按钮要有 aria-label，读屏用户才认得')
assert(closeHtml.includes('>×<') === false, '关闭按钮不该再输出文本 ×')
assert(settingsHtml.includes('dsh-pi-btn-icon'), '设置抽屉的关闭按钮该是图标按钮（跟 Sheet 同款）')
assert(settingsHtml.includes('>×<') === false, '设置抽屉不该再输出文本 ×')
assert(dirHtml.includes('dsh-pi-btn-icon'), '目录弹窗的关闭按钮该是图标按钮（以前这里连 type=button 都没有）')
assert(dirHtml.includes('>×<') === false, '目录弹窗不该再输出文本 ×')
assert(dialogHtml({ method: 'confirm', title: 'T', message: 'M' }).includes('dsh-pi-dialog-head'), '扩展弹窗该有带关闭按钮的头部')
assert(dialogHtml({ method: 'confirm', title: 'T', message: 'M' }).includes('dsh-pi-btn-icon'), '扩展弹窗的关闭按钮与抽屉同款')

// 提示语：placeholder 只留一句，快捷键进 bar 的固定位置
assert(zh('composerHint').includes('Enter') === false, 'placeholder 不该再塞快捷键（输入一个字符就消失，窄面板还会被截断），实际 ' + JSON.stringify(zh('composerHint')))
assert(en('composerHint').includes('Enter') === false, 'en placeholder 同理，实际 ' + JSON.stringify(en('composerHint')))
for (const key of ['composerTipIdle', 'composerTipBusy']) {
  assert(typeof zh(key) === 'string' && zh(key) !== '', 'zh 缺 ' + key)
  assert(typeof en(key) === 'string' && en(key) !== '', 'en 缺 ' + key)
}
assert(zh('composerTipIdle').includes('Enter') && zh('composerTipIdle').includes('Shift'), '空闲提示要讲清 Enter / Shift+Enter')
assert(zh('composerTipBusy').includes('steer') && zh('composerTipBusy').includes('Esc'), '运行中提示要讲清 steer 与 Esc 停止')
assert(zh('revealFile') !== '' && en('revealFile') !== '', '右键定位要有自己的文案键')
assert(zh('revealFileFailed').includes('{path}'), '定位失败文案要带 {path} 占位')

// ── 9.5 composer 重排：卡面 + 圆形 +\- 菜单 + 底部统计行 ───────────────────
// 用户给的宿主截图里，输入区是一张 28px 圆角白卡：左上圆形「+」，右侧圆形发送键，
// 输入框本身没有边框，提示语进 bar，统计另起一行。这里逐项钉住，防止回退成「一排文字按钮」。
const Composer = internals.Composer
assert(typeof Composer === 'function', 'client.js 应导出 Composer 以便测试')
const composerProps = {
  t: zh,
  busy: false,
  images: [],
  onRemoveImage() {},
  onSubmit() {},
  onStop() {},
  onFollowUp() {},
  onDequeue() {},
  onCycleModel() {},
  onCycleThinking() {},
  onImages() {},
  onPathsUnavailable() {},
  onPickDir() {},
  onOpenModels() {},
  onOpenThinking() {},
  onOpenSessions() {},
  onOpenStats() {},
  onOpenSettings() {},
  onOpenHotkeys() {},
  onCompact() {},
  onNewSession() {},
  onSetThinking() {},
  slashEntries: [],
  editorText: '',
  widgets: [],
  onEditorTextConsumed() {},
  searchFiles() { return [] },
  model: { id: 'deepseek-v4', provider: 'deepseek' },
  thinking: 'medium',
  thinkingLevels: ['low', 'medium', 'high'],
}
const composerHtml = renderToStaticMarkup(React.createElement(Composer, composerProps))
assert(composerHtml.includes('dsh-pi-box'), '输入区该有卡面 dsh-pi-box')
assert(composerHtml.includes('dsh-pi-ta'), '输入区该有 textarea.dsh-pi-ta')
assert(composerHtml.includes('dsh-pi-add'), '左端该有圆形 + 按钮（宿主同款）')
assert(composerHtml.includes('aria-expanded="false"'), '+ 按钮该带 aria-expanded，菜单没开时是 false')
assert(composerHtml.includes('dsh-pi-send'), '右端该有圆形发送键 dsh-pi-send')
assert(composerHtml.includes('disabled=""'), '空输入时发送键该禁用')
assert(composerHtml.includes('dsh-pi-bar-hint'), '快捷键提示仍在 bar 里固定位置')
assert(composerHtml.includes('dsh-pi-picker'), '有模型时该渲染模型下拉')
assert(composerHtml.includes('deepseek-v4'), '模型下拉显示模型 id')
assert(composerHtml.includes('dsh-pi-picker-native'), '推理等级用原生 select 叠在自绘外壳里（可点、可键盘）')
assert(composerHtml.includes('>medium<'), '推理等级下拉该选中当前档位')
assert(composerHtml.includes('dsh-pi-btn-icon') === false, 'bar 里不该再有旧的图标文字按钮（都并进 + 菜单了）')
// 附件与目录收进 + 菜单后，bar 左侧只剩 + / 模型 / 推理等级三个控件。
assert(composerHtml.includes(zh('attachFile')) === false, '回形针按钮该收进 + 菜单，不再占 bar')
assert(composerHtml.includes(zh('pickDir')) === false, '目录按钮该收进 + 菜单，不再占 bar')

// 运行中：同一位置换成方形停止键，且不再额外挂「排队 / 停止」文字按钮
const busyHtml = renderToStaticMarkup(React.createElement(Composer, Object.assign({}, composerProps, { busy: true })))
assert(busyHtml.includes('dsh-pi-stop'), '运行中右端该变成停止圆钮 dsh-pi-stop')
assert(busyHtml.includes('Esc'), '停止圆钮 title 该提示 Esc')
assert(busyHtml.includes('>' + zh('queue') + '<') === false, '排队不再占按钮（Alt+Enter 走键盘），实际 ' + busyHtml.slice(0, 120))

// AddMenu：分组标题 + 图标 + 中英双列 + 右侧说明
const AddMenu = internals.AddMenu
assert(typeof AddMenu === 'function', 'client.js 应导出 AddMenu 以便测试')
const addItems = [
  { key: 'file', group: 'add', groupLabel: zh('addGroupAdd'), label: zh('addFile'), keyName: 'file', desc: zh('addFileDesc'), icon: internals.PaperclipIcon, run() {} },
  { key: 'compact', group: 'cmd', groupLabel: zh('addGroupCommands'), label: zh('compactNow'), keyName: 'compact', desc: zh('addCompactDesc'), icon: internals.CloseIcon, run() {} },
]
const addHtml = renderToStaticMarkup(React.createElement(AddMenu, { t: zh, items: addItems, onPick() {}, onClose() {} }))
assert(addHtml.includes('dsh-pi-menu-add'), '加号菜单该有自己的定位类（向左展开，不铺满整行）')
assert(addHtml.includes('role="menu"'), '加号菜单该声明 role=menu')
assert(addHtml.includes('dsh-pi-menu-section'), '菜单该按「添加 / 指令」分组')
assert(addHtml.includes(zh('addGroupAdd')) && addHtml.includes(zh('addGroupCommands')), '两组标题都该出现')
assert(addHtml.includes('dsh-pi-add-icon'), '每项左侧该有图标')
assert(addHtml.includes('dsh-pi-add-key'), '每项该带英文键名（宿主同款两列）')
assert(addHtml.includes('>file<') && addHtml.includes('>compact<'), '英文键名该渲染出来')
assert(addHtml.includes(zh('addFileDesc')), '每项右侧该有灰色说明')
assert(addHtml.includes('role="menuitem"') , '菜单项该声明 role=menuitem')
assert(addHtml.includes('data-active="-1"') === false, '没有 hover 时不该把某项标成 active')

// dock：统计行属于 composer 容器（宿主 .GRgSLq_dock 就在 root 里、卡下方），不是面板根上的另一条
const withFooter = renderToStaticMarkup(React.createElement(Composer, Object.assign({}, composerProps, {
  footer: React.createElement('div', { className: 'dsh-pi-statusbar' }, 'x'),
})))
assert(withFooter.includes('dsh-pi-statusbar'), '传了 footer 就该渲染统计行')
assert(withFooter.indexOf('dsh-pi-box') < withFooter.indexOf('dsh-pi-statusbar'), '统计行该在输入卡之后（宿主同序）')
assert(composerHtml.includes('dsh-pi-statusbar') === false, '没传 footer 时不该凭空造一条统计行')

// 统计行：轮 / 步 / token / 缓存命中要有文案键，且数字带千分位
assert(zh('footerTurns').includes('{n}') && en('footerTurns').includes('{n}'), '轮数文案要带 {n}')
assert(zh('footerSteps').includes('{n}') && en('footerSteps').includes('{n}'), '步数文案要带 {n}')
assert(zh('footerTokens').includes('{n}') && en('footerTokens').includes('{n}'), 'token 文案要带 {n}')
assert(zh('footerCache').includes('{pct}') && en('footerCache').includes('{pct}'), '缓存命中文案要带 {pct}')
assert(typeof internals.fmtCount === 'function', 'client.js 应导出 fmtCount')
assert(internals.fmtCount(0) === '0', '0 不带千分位')
assert(internals.fmtCount(999) === '999', '三位数不带千分位')
assert(internals.fmtCount(1000) === '1,000', '四位数带千分位')
assert(internals.fmtCount(1234567) === '1,234,567', '七位数带两个千分位')
assert(internals.fmtCount(undefined) === '0', '缺字段按 0 算，不能出 NaN')
assert(internals.fmtCount('abc') === '0', '非数字按 0 算')
assert(internals.numOr0(null) === 0 && internals.numOr0(2) === 2, 'numOr0 兜底')

// ── 10. 整棵面板在 loading 阶段能渲染，不抛异常 ────────────────────────────
const panelHtml = renderToStaticMarkup(React.createElement(internals.PiPanel, { t: zh }))
assert(panelHtml.includes('dsh-pi-root'), 'PiPanel 应渲染出 dsh-pi-root')
assert(panelHtml.includes(zh('loading')), 'PiPanel 首帧应是 loading 文案')

if (failed > 0) {
  console.error(String(failed) + ' 条断言失败（通过 ' + String(passed) + ' 条）')
  process.exit(1)
}
// 打印实际执行到的断言条数：README / docs 里引用的数字必须能在这里核对，
// 静态数 assert( 的调用点会把 for 循环里的重复执行漏掉。
console.log('PASS (' + String(passed) + ' assertions)')

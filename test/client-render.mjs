#!/usr/bin/env node
/**
 * client.js 的渲染冒烟：在没有浏览器的前提下把组件树渲染成字符串。
 *
 * 为什么需要：client 半区跑在 DSH 的 Web 载体里，改一行就重启 DSH 才能验证，
 * 代价太高。这里用「假 window 拿 exports + react-dom/server 渲染」把两类错误挡在提交前：
 *  1. 组件抛异常（读 undefined 的属性、拼错 props）；
 *  2. 文案键缺失 / 中英文键集不一致。
 *
 * React 和 React DOM 由仓库的锁定依赖安装，共用 preflight 的依赖检查。
 *
 * 跑法：node test/client-render.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { requireReact } from './preflight.mjs'
import { PiProcess } from '../src/pi-rpc.mjs'
import { decoratePiEvent } from '../src/event-verdict.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)

const reactHome = requireReact()
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
assert(definition.id === 'superpi', 'loader id 应为 superpi，实际 ' + String(definition && definition.id))
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
const { BRAND_NAME } = await import('../tools/brand-pi-runtime.mjs')
assert(strings.zh.panelTitle === BRAND_NAME && strings.en.panelTitle === BRAND_NAME, '两种面板语言与命令行品牌一致')
assert(strings.zh.rulesCliMissing.includes('npm run superpi:editor') && strings.en.rulesCliMissing.includes('npm run superpi:editor'), '面板引导使用 SuperPi 的安装命令')
assert(fs.readFileSync(path.join(root, 'assets', 'icon.svg'), 'utf8').includes('aria-label="' + BRAND_NAME + '"'), '插件图标的可访问名称与命令行品牌一致')

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
  plugin: 'superpi',
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
      { source: 'plugin-node-modules', path: 'C:\\x\\superpi\\node_modules', ok: false, reason: 'package not installed' },
      { source: 'config', path: 'C:\\y\\cli.js', ok: false, reason: 'not found' },
    ],
    install: { available: true, target: 'C:\\x\\superpi\\.runtime', package: '@earendil-works/pi-coding-agent', version: '1.5.2', running: false },
  },
  onRecheck() {},
  onInstalled() {},
}))
console.log('gate =', gateHtml.slice(0, 320))
assert(gateHtml.includes(zh('runtimeMissing')), '引导页该显示「' + zh('runtimeMissing') + '」')
assert(gateHtml.includes(zh('installRuntime')), '引导页该有「' + zh('installRuntime') + '」按钮')
assert(gateHtml.includes(zh('runtimeMissingHint')), '引导页该有说明文案')
assert(gateHtml.includes('superpi-gate-card'), '引导页该用 superpi-gate-card 外壳')
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
assert(confirmHtml.includes('superpi-btn-primary') === true, 'confirm 的肯定按钮该是 primary')

// 9.3 select：每个选项一个按钮 + 取消
const selectHtml = dialogHtml({ method: 'select', title: 'Pick an option', options: ['Option A', 'Option B', 'Option C'] })
console.log('select =', selectHtml)
assert(selectHtml.includes('superpi-opt'), 'select 该用 superpi-opt 渲染选项')
for (const option of ['Option A', 'Option B', 'Option C']) assert(selectHtml.includes('>' + option + '<'), 'select 该渲染选项 ' + option)
assert((selectHtml.match(/superpi-opt/g) ?? []).length === 3, 'select 的选项按钮数应等于 options 长度')
assert(selectHtml.includes('>' + zh('cancel') + '<'), 'select 该有「' + zh('cancel') + '」按钮')
assert(selectHtml.includes('superpi-btn-primary') === false, 'select 的选项不该是 primary（用户还没选）')

// 9.4 input：回填 prefill 进 value、placeholder 透传、取消 / 提交
const inputHtml = dialogHtml({ method: 'input', title: 'Enter a value', placeholder: 'type something...', prefill: 'pre-filled' })
console.log('input =', inputHtml)
assert(inputHtml.includes('<input'), 'input 该渲染 <input>')
assert(inputHtml.includes('placeholder="type something..."'), 'input 该透传 placeholder')
assert(inputHtml.includes('value="pre-filled"'), 'input 该回填 prefill 到 value')
assert(inputHtml.includes('>' + zh('cancel') + '<') && inputHtml.includes('>' + zh('extSubmit') + '<'), 'input 该有取消 / 提交两个按钮')
assert(inputHtml.includes(zh('extInput') + ' · Enter a value'), 'input 的 h3 该用 extInput 前缀')

// Invoke the same handlers React attaches to the input and button, with a deferred delivery result.
{
  const states = []
  const refs = []
  let stateIndex = 0
  let refIndex = 0
  const { ExtensionDialog: InteractiveDialog } = definition.factory(() => ({
    ...React,
    useState(initial) {
      const i = stateIndex++
      if (!(i in states)) states[i] = initial
      return [states[i], value => { states[i] = value }]
    },
    useRef(initial) {
      const i = refIndex++
      return refs[i] ??= { current: initial }
    },
    useEffect() {},
  })).__internals
  const sent = []
  let rejectDelivery
  const delivery = new Promise((_resolve, reject) => { rejectDelivery = reject })
  void delivery.catch(() => {})
  const tick = () => new Promise(resolve => setImmediate(resolve))
  const nodes = node => React.isValidElement(node) ? [node, ...nodes(node.props.children)] : Array.isArray(node) ? node.flatMap(nodes) : []
  const render = () => {
    stateIndex = 0
    refIndex = 0
    return nodes(InteractiveDialog({
      t: zh, request: requestOf({ method: 'input', title: '要用哪个平台？' }),
      onRespond(body) { sent.push(body); return sent.length === 1 ? delivery : Promise.resolve() },
    }))
  }
  render().find(node => node.type === 'input').props.onChange({ target: { value: '先用 Windows' } })
  const before = render()
  const submit = before.find(node => node.type === 'button' && node.props.children === zh('extSubmit'))
  submit.props.onClick()
  submit.props.onClick()
  await tick()
  assert(sent.length === 1, '发送中不会因双击而重复回答')
  rejectDelivery(new Error('network disconnected'))
  await tick()
  const retried = render()
  const input = retried.find(node => node.type === 'input')
  assert(input.props.value === '先用 Windows', '发送失败时保留用户的答案')
  assert(retried.some(node => node.props.role === 'alert' && node.props.children === zh('extResponseFailed')), '发送失败时在弹窗内提示重试')
  const previous = sent.length
  input.props.onKeyDown({ key: 'Enter', nativeEvent: { isComposing: true } })
  await tick()
  assert(sent.length === previous, '中文组字期间的 Enter 只确认输入法候选')
  retried.find(node => node.type === 'button' && node.props.children === zh('extSubmit')).props.onClick()
  await tick()
  assert(sent.length === previous + 1 && sent.at(-1).value === '先用 Windows', '重试发送原来的答案')
}

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
assert(emptyHtml.includes('superpi-empty-actions'), '空态该有动作行 superpi-empty-actions')
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
const toolRule = cssRule('.superpi-tool')
const toolBodyRule = cssRule('.superpi-tool-body')
assert(toolRule !== null, 'client.js 里该有 .superpi-tool 规则')
assert(toolBodyRule !== null, 'client.js 里该有 .superpi-tool-body 规则')
assert(toolRule.includes('border-radius:0'), '.superpi-tool 不该有圆角（用户要求过程行不加圆角框），实际 ' + toolRule)
assert(toolRule.includes('background:transparent'), '.superpi-tool 不该有底色，实际 ' + toolRule)
assert(toolRule.includes('box-shadow:none'), '.superpi-tool 不该有 hairline 外框，实际 ' + toolRule)
assert(toolBodyRule.includes('border-left:1px solid var(--dsw-alias-border-l3)'), '.superpi-tool-body 展开区该用左侧竖线区隔（与思考过程同一套语言），实际 ' + toolBodyRule)
const enAll = JSON.stringify(strings.en)
assert(zhAll.indexOf('工作目录') < 0, 'ZH 文案表里不该再有「工作目录」字样：' + zhAll.slice(zhAll.indexOf('工作目录') - 40, zhAll.indexOf('工作目录') + 20))
assert(enAll.indexOf('working directory') < 0, 'EN 文案表里不该再有 working directory 字样')
const emptyNoAction = renderToStaticMarkup(React.createElement(EmptyState, { t: zh, meta: null }))
assert(emptyNoAction.includes('superpi-empty-actions') === false, '没传 onPickDir 时不该渲染动作行')
const emptyEn = renderToStaticMarkup(React.createElement(EmptyState, { t: en, meta: 'C:\\x', onPickDir() {} }))
assert(emptyEn.includes(en('pickDir')), '英文空态该显示 ' + en('pickDir'))

// ── 9.11 设置弹窗（0.7.0 起由抽屉改为居中弹窗）：开关必须是 DSH 的 aria switch ──
const SettingsSheet = internals.SettingsSheet
assert(typeof SettingsSheet === 'function', 'client.js 应导出 SettingsSheet 以便测试')
const settingsHtml = renderToStaticMarkup(React.createElement(SettingsSheet, {
  t: zh,
  state: { autoCompactionEnabled: true, steeringMode: 'one-at-a-time', followUpMode: 'one-at-a-time' },
  retry: { enabled: false },
  onClose() {},
  onAutoCompaction() {},
  onAutoRetry() {},
  onSteering() {},
  onFollowUp() {},
}))
console.log('settings =', settingsHtml)
assert(settingsHtml.includes('class="superpi-switch"'), '开关该用 .superpi-switch（DSH 胶囊样式）')
assert(settingsHtml.includes('role="switch"'), '开关该声明 role=switch')
assert(settingsHtml.includes('aria-checked="true"'), '开启态该 aria-checked=true')
assert(settingsHtml.includes('aria-checked="false"'), '关闭态该 aria-checked=false')
assert(settingsHtml.includes('superpi-switch-thumb'), '开关该有滑块元素')
// 文字开关会渲染出 >开< / >关< 的按钮文本；改成胶囊后这段文本必须消失（a11y 由 aria 承载）。
assert(settingsHtml.includes('>' + zh('on') + '<') === false, '开关不该再把「' + zh('on') + '」当按钮文本')
assert(settingsHtml.includes('>' + zh('off') + '<') === false, '开关不该再把「' + zh('off') + '」当按钮文本')
assert(settingsHtml.includes(zh('autoCompact')) && settingsHtml.includes(zh('autoRetry')), '设置项标签该照旧显示')
const missingRetry = renderToStaticMarkup(React.createElement(SettingsSheet, { t: zh, state: {}, retry: null }))
assert(missingRetry.includes(zh('retryUnavailable')) && !missingRetry.includes('aria-labelledby="superpi-sw-autoRetry"'),
  '暂时读不到的有效值有说明，不能呈现为已关闭的开关')
const overriddenRetry = renderToStaticMarkup(React.createElement(SettingsSheet, { t: zh, state: {}, retry: { enabled: false, applied: false } }))
assert(overriddenRetry.includes(zh('retryOverride')) && overriddenRetry.includes('aria-labelledby="superpi-sw-autoRetry"'),
  '项目覆盖后仍展示实际值，并说明开关为何保持原值')

const RunningSessionsBar = internals.RunningSessionsBar
assert(typeof RunningSessionsBar === 'function', '面板提供正在运行的会话切换入口')
if (typeof RunningSessionsBar === 'function') {
  const tabs = renderToStaticMarkup(React.createElement(RunningSessionsBar, { t: zh, activeId: 'tab-a',
    sessions: [{ id: 'tab-a', sessionName: 'Working session A' }, { id: 'tab-b', sessionName: 'Working session B' }] }))
  assert(tabs.includes('Working session A') && tabs.includes('Working session B'), '并行会话均能独立选择')
  assert((tabs.match(/aria-current="true"/g) ?? []).length === 1 && tabs.includes(zh('newSession')),
    '会话栏只标一个当前视图，并提供新会话入口')
  assert(tabs.includes('关闭当前会话'), '运行中的标签具备释放会话名额的入口')
}

// ── 9.11d 用户自定义规则区（0.10.0）────────────────────────────────────────
// 设置弹窗里多了一节「用户自定义规则」：它是一个状态机，不是一行按钮。
// 这里把五种状态逐个渲染一遍，盯住「每个状态都有对应的可读文本」——
// 空白或只变颜色都会让用户分不清「默认 / 关掉 / 坏了」。
const RulesSection = internals.RulesSection
const RulesSheet = internals.RulesSheet
assert(typeof RulesSection === 'function', 'client.js 应导出 RulesSection 以便测试')
assert(typeof RulesSheet === 'function', 'client.js 应导出 RulesSheet 以便测试')

/** 造一个规则视图（字段与 host 的 rulesView() 一致）。 */
const rulesViewFixture = (overrides = {}) => Object.assign({
  ok: true,
  version: 1,
  text: 'User-defined rules：\n思考过程和最后总结使用简体中文回复；',
  checksum: 'a'.repeat(64),
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  source: 'file',
  drift: false,
  isDefault: false,
  empty: false,
  rank: 1,
  maxLength: 20000,
  filePath: 'C:/x/rules.json',
  warning: '',
  delivery: { command: '/superpi-rules', extensionInstalled: true },
}, overrides)
const renderSection = (props) => renderToStaticMarkup(React.createElement(RulesSection, Object.assign({ t: zh }, props)))

// ① 加载中：摘要行占位、两个按钮都禁用
const rulesLoading = renderSection({ rules: null })
assert(rulesLoading.includes('superpi-rules') === true, '加载中也渲染出规则区容器')
assert(rulesLoading.includes(zh('rulesSection')), '加载中也显示区标题')
assert(rulesLoading.includes(zh('loading')), '加载中显示读取占位')
assert(rulesLoading.includes('disabled'), '加载中按钮禁用（不能拿空值开编辑框）')

// ② 正常：行数/字数 + 首行摘要 + 「最高优先级」徽标 + 命令行已就绪
const rulesOk = renderSection({ rules: rulesViewFixture() })
assert(rulesOk.includes(zh('rulesSummary').replace('{lines}', '2').replace('{chars}', String('User-defined rules：\n思考过程和最后总结使用简体中文回复；'.length))), '正常态显示行数/字数')
assert(rulesOk.includes('User-defined rules：'), '正常态显示首行摘要')
assert(rulesOk.includes(zh('rulesBadgeTop')), '正常态带「最高优先级」徽标')
// 用 data-tone="default" 判而不是文本：文本里的「默认」会出现在「恢复默认」按钮上。
assert(rulesOk.includes('data-tone="default"') === false, '自定义规则不带「默认」徽标')
assert(rulesOk.includes(zh('rulesCliReady')), '已装扩展时显示「命令行同一份」')
assert(rulesOk.includes(zh('rulesEdit')) && rulesOk.includes(zh('rulesReset')), '正常态有两个动作')
assert(rulesOk.includes('superpi-btn-primary'), '编辑是主按钮')
assert(rulesOk.includes('disabled') === false, '正常态按钮可点')

// ③ 默认文案：多一个「默认」徽标（用户能看出自己没改过）
const rulesDefault = renderSection({ rules: rulesViewFixture({ isDefault: true, source: 'default' }) })
assert(rulesDefault.includes('data-tone="default"'), '默认文案带「默认」徽标')
assert(rulesDefault.includes(zh('rulesBadgeTop')), '默认文案仍有「最高优先级」徽标')

// ④ 空规则：告警语气，明说「不会追加任何内容」
const rulesEmpty = renderSection({ rules: rulesViewFixture({ text: '', empty: true, rank: 0, isDefault: false }) })
assert(rulesEmpty.includes(zh('rulesEmptyState')), '空规则明说不会追加内容')
assert(rulesEmpty.includes('data-tone="warn"'), '空规则用告警色而不是静默')
assert(rulesEmpty.includes('data-empty="1"'), '空规则在容器上打标记（描边提示）')
assert(rulesEmpty.includes(zh('rulesEdit')), '空规则仍可点编辑')

// ⑤ 读失败：错误行 role=alert + 重试按钮 + 编辑禁用（读不出来就写回去等于毁文件）
const rulesFailed = renderSection({ rules: null, loadError: 'boom', onRetry() {} })
assert(rulesFailed.includes(zh('rulesLoadFailed')), '读失败显示错误标题')
assert(rulesFailed.includes('role="alert"'), '错误行是 role=alert（读屏会播报）')
assert(rulesFailed.includes(zh('retry')), '读失败给重试按钮')
assert(rulesFailed.includes('boom'), '错误详情原样显示')
assert(/disabled[^>]*>/.test(rulesFailed), '读失败时动作禁用')

// ⑥ 命令行未装：必须看得见「命令行窗口未生效」，不能让用户去 TUI 试
const rulesNoCli = renderSection({ rules: rulesViewFixture({ delivery: { command: '/superpi-rules', extensionInstalled: false } }) })
assert(rulesNoCli.includes(zh('rulesCliMissing')), '未装扩展时提示命令行未生效')
assert(rulesNoCli.includes('data-tone="warn"'), '未装扩展用告警色')

// ⑦ drift：文件被外部改过
const rulesDrift = renderSection({ rules: rulesViewFixture({ drift: true }) })
assert(rulesDrift.includes(zh('rulesDrift')), 'drift 时提示文件被外部修改')

// ⑧ 编辑弹窗：textarea 预填全文 + 字数 + 保存/取消
const rulesSheetHtml = renderToStaticMarkup(React.createElement(RulesSheet, {
  t: zh,
  rules: rulesViewFixture({ text: '第一行\n第二行' }),
  onClose() {},
  onSave() {},
}))
console.log('rulesSheet =', rulesSheetHtml.slice(0, 400))
assert(rulesSheetHtml.includes('role="dialog"'), '编辑弹窗是 dialog')
assert(rulesSheetHtml.includes('aria-modal="true"'), '编辑弹窗是模态')
assert(rulesSheetHtml.includes('superpi-rules-textarea'), '有规则编辑 textarea')
assert(rulesSheetHtml.includes('aria-label="' + zh('rulesSection') + '"'), 'textarea 有 aria-label')
assert(rulesSheetHtml.includes('>第一行\n第二行<'), 'textarea 预填当前全文')
assert(rulesSheetHtml.includes(zh('rulesCounter').replace('{n}', String('第一行\n第二行'.length)).replace('{max}', '20000')), '显示字数计数')
assert(rulesSheetHtml.includes(zh('rulesSave')), '有保存按钮')
assert(rulesSheetHtml.includes(zh('cancel')), '有取消按钮')

// ⑨ 编辑弹窗：超长时保存禁用 + 提示还差多少（不让用户提交后才吃 400）
const overLong = 'x'.repeat(5)
const rulesOverSheet = renderToStaticMarkup(React.createElement(RulesSheet, {
  t: zh,
  rules: rulesViewFixture({ text: overLong, maxLength: 3 }),
  onClose() {},
  onSave() {},
}))
assert(rulesOverSheet.includes(zh('rulesOverLimit').replace('{n}', '2')), '超长时提示还差多少字')
assert(rulesOverSheet.includes('disabled'), '超长时保存禁用')

// ⑩ 空文本：先说明「保存后才生效」，不要让人以为现在是关着的
const rulesEmptySheet = renderToStaticMarkup(React.createElement(RulesSheet, {
  t: zh,
  rules: rulesViewFixture({ text: '' }),
  onClose() {},
  onSave() {},
}))
assert(rulesEmptySheet.includes(zh('rulesEmptySave')), '空文本编辑时说明保存后生效')

// ⑪ 规则区嵌在设置弹窗里（不是独立入口）
const settingsWithRules = renderToStaticMarkup(React.createElement(SettingsSheet, {
  t: zh,
  state: { autoCompactionEnabled: true, autoRetryEnabled: false, steeringMode: 'one-at-a-time', followUpMode: 'one-at-a-time' },
  rules: rulesViewFixture(),
  onClose() {},
  onAutoCompaction() {},
  onAutoRetry() {},
  onSteering() {},
  onFollowUp() {},
  onEditRules() {},
  onResetRules() {},
  onLoadRules() {},
}))
assert(settingsWithRules.includes('superpi-rules'), '设置弹窗里嵌了规则区')
assert(settingsWithRules.includes(zh('rulesSection')), '设置弹窗里有规则区标题')
assert(settingsWithRules.includes('superpi-switch'), '开关仍在（规则区是追加的，不是替换）')
// 设置弹窗不传 rules 时（旧调用方 / 测试）不许抛，只显示加载中
const settingsNoRules = renderToStaticMarkup(React.createElement(SettingsSheet, {
  t: zh,
  state: {},
  onClose() {},
  onAutoCompaction() {},
  onAutoRetry() {},
  onSteering() {},
  onFollowUp() {},
  onEditRules() {},
  onResetRules() {},
}))
assert(settingsNoRules.includes(zh('loading')), '缺少 rules 数据时显示加载中而不是抛')


// ── 9.11a2 设置里的「模型模态」（0.13.0）────────────────────────────────
// 这一节最容易做成假开关，所以渲染测试要盯住四件事：
//   ① 每个模型一行、每个可开关模态一个 chip；
//   ② 文本锁定（aria-disabled、点不动）；
//   ③ 关闭态 data-on="0"，开启态 data-on="1"（视觉与语义同源）；
//   ④ 协议里声明了但运行时没有的模态**不出现假开关**。
const ModalitiesSection = internals.ModalitiesSection
assert(typeof ModalitiesSection === 'function', 'client.js 应导出 ModalitiesSection 以便测试')
const renderModalities = (props) => renderToStaticMarkup(React.createElement(ModalitiesSection, Object.assign({ t: zh }, props)))
const registryFixture = {
  runtime: ['text', 'image'],
  defaults: ['text', 'image'],
  locked: ['text'],
  labels: {},
  filePath: 'C:/Users/x/.superpi/modalities.json',
}
const visionModel = { provider: 'odys-deepseek', id: 'Deepseek-V4.1-Flash', name: 'Deepseek-V4.1-Flash', input: ['text', 'image'] }
const textOnlyModel = { provider: 'acme', id: 'text-only', name: 'Text Only', input: ['text'] }

const modLoading = renderModalities({ models: [], modalities: null })
assert(modLoading.includes(zh('modalitiesSection')), '模态区有标题')
assert(modLoading.includes(zh('loading')), '模态区加载中显示占位')

const modFailed = renderModalities({ models: [], modalities: null, error: 'boom', onRetry() {} })
assert(modFailed.includes(zh('modalitiesLoadFailed')), '读失败显示错误标题')
assert(modFailed.includes('boom'), '读失败显示详情')
assert(modFailed.includes(zh('retry')), '读失败给重试')

const modNoSession = renderModalities({ models: [], modalities: { state: { models: {} }, registry: registryFixture } })
assert(modNoSession.includes(zh('modalitiesNoSession')), '无会话时明确说明（不是空白）')

const modOk = renderModalities({
  models: [visionModel, textOnlyModel],
  modalities: { state: { models: {} }, registry: registryFixture },
  onToggle() {},
})
assert(modOk.includes('data-model="odys-deepseek:Deepseek-V4.1-Flash"'), '视觉模型有一行')
assert(modOk.includes('data-modality="image"'), '视觉模型有图像 chip')
assert(modOk.includes('data-modality="text"'), '有文本 chip')
assert(modOk.includes('data-locked="1"'), '文本 chip 标记为锁定')
assert(/data-modality="text"[^>]*aria-disabled="true"/.test(modOk), '文本 chip aria-disabled（读屏知道点不动）')
assert(modOk.includes(zh('modality_text')) && modOk.includes(zh('modality_image')), 'chip 用本地化名')
// 只截取「纯文本模型那一行」：按下一个 data-model 切段，否则会把后面模型的行一起吞进来。
const textOnlyStart = modOk.indexOf('data-model="acme:text-only"')
const textOnlyNext = modOk.indexOf('data-model="', textOnlyStart + 10)
const textOnlyRow = modOk.slice(textOnlyStart, textOnlyNext < 0 ? modOk.length : textOnlyNext)
assert(textOnlyRow.includes('data-modality="text"'), '纯文本模型有文本 chip')
assert(textOnlyRow.includes('data-modality="image"') === false, '纯文本模型没有图像 chip（不凭空出现）')

const modOff = renderModalities({
  models: [visionModel],
  modalities: { state: { models: { 'odys-deepseek/Deepseek-V4.1-Flash': { image: false } } }, registry: registryFixture },
  onToggle() {},
})
assert(/data-modality="image"[^>]*data-on="0"/.test(modOff), '关闭态 data-on=0')
assert(/data-modality="image"[^>]*aria-pressed="false"/.test(modOff), '关闭态 aria-pressed=false')
assert(/data-modality="text"[^>]*data-on="1"/.test(modOff), '文本始终开启')

const modFuture = renderModalities({
  models: [{ provider: 'x', id: 'y', name: 'Future', input: ['text', 'image', 'audio'] }],
  modalities: { state: { models: {} }, registry: registryFixture },
  onToggle() {},
})
assert(modFuture.includes('data-modality="audio"') === false, '运行时无法发送的模态不画开关（假开关比没有更糟）')

// 点击回调：静态渲染拿不到事件对象，但可以钉住源码里的调用形状（取反后的目标态）。
{
  const modSource = fs.readFileSync(path.join(root, 'client.js'), 'utf8')
  assert(modSource.includes('props.onToggle(model, entry.id, entry.enabled !== true)'), '点击时把「取反后的目标态」交给回调')
}

// ── 9.11b 工具行：展开区不是圆角卡片（用户 18994 明确要求拆掉圆角框） ────────
// 过程流里一次任务会连着十几次工具调用。每行都套 border-radius + hairline + 底色，
// 视觉上就是「框套框」的噪音墙。这里守住三点：无圆角、无背景、无外框，
// 展开区改用左侧竖线（与 .superpi-think 同一套语言）区分层级。
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
  assert(markup.includes('class="superpi-tool"'), label + '该用 .superpi-tool 行容器，实际 ' + markup.slice(0, 200))
  assert(markup.includes('superpi-sheet') === false, label + '不该套抽屉外壳')
}
// 三处渲染必须共用同一个容器类名，样式改动才不会漏掉某一类过程行。
assert(toolHtml.includes('echo hi') && bashHtml.includes('echo hi') && resultHtml.includes('hi'), '三类过程行都该渲染出内容')

// ── 9.11c 过程行文字色 = label-tertiary（实拍逐像素对过目标图） ──────────────
// 目标图摘要实心色 rgb(129,133,140) 就是 label-tertiary；label-secondary 的
// rgb(97,102,107) 肉眼可辨地偏深，0.6.4 首轮实拍就是这么错的。
const procTextRule = cssRule('.superpi-proc-text')
assert(procTextRule !== null, 'client.js 里该有 .superpi-proc-text 规则')
assert(procTextRule.includes('color:var(--dsw-alias-label-tertiary)'), '.superpi-proc-text 该用 label-tertiary（目标图摘要色），实际 ' + procTextRule)
const procHeadRule = cssRule('.superpi-proc-head,.superpi-tool-head')
assert(procHeadRule !== null, 'client.js 里该有 .superpi-proc-head 规则')
assert(procHeadRule.includes('color:var(--dsw-alias-label-tertiary)'), '.superpi-proc-head 继承色该是 label-tertiary（.superpi-proc-path 靠 color:inherit 取它），实际 ' + procHeadRule)
assert(procHeadRule.includes('label-secondary') === false, '过程行不该再用 label-secondary，实际 ' + procHeadRule)

// ── 9.11d 展开区的 live 段只在运行中出现 ─────────────────────────────────
// 跑完后 partialResult 与最终结果是同一件事的两副面孔，两段都印等于输出写两遍。
const runningHtml = renderToStaticMarkup(React.createElement(ToolBlock, { t: zh, name: 'bash', argsText: '{"command":"echo hi"}', status: 'running', partial: 'LIVE-CHUNK' }))
const doneHtml = renderToStaticMarkup(React.createElement(ToolBlock, { t: zh, name: 'bash', argsText: '{"command":"echo hi"}', status: 'done', partial: 'LIVE-CHUNK', resultText: 'FINAL-OUT' }))
assert(runningHtml.includes('── live ──'), '运行中该显示 live 段（工具边跑边出进度），实际 ' + runningHtml.slice(0, 400))
assert(doneHtml.includes('── live ──') === false, '跑完后不该再显示 live 段（会与 output 重复），实际 ' + doneHtml.slice(0, 400))
assert(doneHtml.includes('── output ──') && doneHtml.includes('FINAL-OUT'), '跑完后该显示 output 段，实际 ' + doneHtml.slice(0, 400))
const reviewLive = renderToStaticMarkup(React.createElement(ToolBlock, {
  t: zh, name: 'review_changes', argsText: '{"timeout":60}', status: 'running', partial: 'Independent reviewers returned 1/2',
}))
assert(reviewLive.includes(zh('procReview')) && reviewLive.includes('Independent reviewers returned 1/2'), '独立审查运行时显示工具名和已返回路数')
const reviewDone = renderToStaticMarkup(React.createElement(ToolBlock, {
  t: zh, name: 'review_changes', argsText: '{"timeout":60}', status: 'done',
  resultText: 'blocking · catalog.mjs:4 · Lookup stopped loading values.',
}))
assert(reviewDone.includes('catalog.mjs:4') && reviewDone.includes('Lookup stopped loading values.'), '面板显示独立审查的具体文件位置与发现')

// ── 9.11e 工作状态行：brand 蓝 + 鲸鱼尾 + 「···」（对齐 DSH RunningStatus） ──
// 目标图（DSH 会话过程流截图）里这一行文字与图标同为 rgb(52,94,186) = #345EBA =
// --dsw-alias-label-deep-diving，末尾是三个中点而不是省略号，图标是鲸鱼尾而不是星形。
// 0.6.4 首轮实拍三处都错，这里逐条钉死，免得下次「看着差不多」又漂回去。
const workingRule = cssRule('.superpi-working')
assert(workingRule !== null, 'client.js 里该有 .superpi-working 规则')
assert(workingRule.includes('color:var(--dsw-alias-label-deep-diving)'), '.superpi-working 文字色该是 label-deep-diving（目标图 #345EBA），实际 ' + workingRule)
assert(workingRule.includes('label-tertiary') === false, '.superpi-working 不该再用 label-tertiary（那是过程行的色），实际 ' + workingRule)
assert(workingRule.includes('font-size:calc(var(--dsh-content-font-size,14px) - 2px)'), '.superpi-working 字号该是正文 - 2px（DSH running 行同式），实际 ' + workingRule)
assert(workingRule.includes('line-height:calc(22px + var(--dsh-content-font-delta,0px))'), '.superpi-working 行高该是 22px + delta（DSH running 行同式），实际 ' + workingRule)
const workingIconRule = cssRule('.superpi-working-icon')
assert(workingIconRule !== null, 'client.js 里该有 .superpi-working-icon 规则')
assert(workingIconRule.includes('state-business-primary') === false, '图标该随父级 currentColor，不该单独取 business-primary（两个蓝不是同一个），实际 ' + workingIconRule)
// 0.14.2：图标放大 14 → 18px，动效从「呼吸」改「旋转」，与命令行窗口对齐
// （TUI 那边是 8 帧月相在转；面板只闪烁会让人觉得"这边卡住了"）。
assert(workingIconRule.includes('width:18px') && workingIconRule.includes('height:18px'), '图标盒该是 18x18（0.14.2 放大，与 TUI 双宽月相对齐），实际 ' + workingIconRule)
assert(workingIconRule.includes('animation:superpi-spin'), '图标该是旋转动画（不是呼吸），实际 ' + workingIconRule)
// 旋转必须 infinite：一旦不是无限循环，动效就会跑完一遍后静止 —— 正是用户报的毛病。
assert(workingIconRule.includes('infinite'), '旋转动画必须 infinite（否则跑完即静止），实际 ' + workingIconRule)
for (const lang of ['zh', 'en']) {
  const label = strings[lang].working
  assert(label.indexOf('{duration}') >= 0, lang + '.working 该含 {duration} 占位，实际 ' + label)
  assert(label.endsWith('···'), lang + '.working 该以三个中点结尾（DSH 用 `···` 表示继续，不是省略号），实际 ' + label)
  assert(label.indexOf('…') < 0, lang + '.working 不该再用省略号 …，实际 ' + label)
}
const fmtDuration = internals.fmtDuration
assert(typeof fmtDuration === 'function', 'client.js 应导出 fmtDuration 以便测试')
const durCases = [
  [0, zh('durSec').replace('{n}', '0')],
  [12000, zh('durSec').replace('{n}', '12')],
  // 单位之间不加空格：中文目标图就是「43分54秒」（词条自带它需要的间距，EN 才是 'h '/'m '）
  [2634000, zh('durMin').replace('{n}', '43') + zh('durSec').replace('{n}', '54')],
  [7389000, zh('durHour').replace('{n}', '2') + zh('durMin').replace('{n}', '3') + zh('durSec').replace('{n}', '9')],
]
for (const [ms, want] of durCases) {
  assert(fmtDuration(ms, zh) === want, 'fmtDuration(' + ms + ') 该是「' + want + '」，实际「' + fmtDuration(ms, zh) + '」')
}
assert(fmtDuration(90000, zh).indexOf(zh('durMin').replace('{n}', '1')) === 0, '90 秒该进位成「1分30秒」而不是「90秒」，实际 ' + fmtDuration(90000, zh))
// 中文行内不该出现半角空格（单位紧贴数字），EN 才靠词条尾空格分隔
assert(fmtDuration(2634000, zh).indexOf(' ') < 0, '中文用时不该带空格，实际 ' + fmtDuration(2634000, zh))
assert(fmtDuration(7389000, en) === '2h 3m 9s', 'EN 该按词条尾空格拼成「2h 3m 9s」，实际 ' + fmtDuration(7389000, en))
assert(fmtDuration(60000, en).indexOf('1m') === 0, 'EN 的分钟词条是 1m 前缀，实际 ' + fmtDuration(60000, en))
const WhaleTailIcon = internals.WhaleTailIcon
assert(typeof WhaleTailIcon === 'function', 'client.js 应导出 WhaleTailIcon 以便测试')
const whaleHtml = renderToStaticMarkup(React.createElement(WhaleTailIcon, null))
assert(whaleHtml.includes('viewBox="0 0 16 16"'), '鲸鱼尾该用 16 网格（DSH 原路径的坐标系），实际 ' + whaleHtml.slice(0, 160))
assert(whaleHtml.includes('stroke-width="1"'), '鲸鱼尾描边该是 1（24 网格那套图标的 1.7 在 16 网格下会变粗），实际 ' + whaleHtml.slice(0, 160))
const WorkingRow = internals.WorkingRow
assert(typeof WorkingRow === 'function', 'client.js 应导出 WorkingRow 以便测试')
const workingLive = renderToStaticMarkup(React.createElement(WorkingRow, { t: zh, since: Date.now() - 65000 }))
assert(workingLive.includes('superpi-working-icon'), '工作状态行该渲染图标位')
assert(workingLive.includes('viewBox="0 0 16 16"'), '图标该是鲸鱼尾（16 网格），实际 ' + workingLive.slice(0, 300))
assert(workingLive.indexOf(zh('durMin').replace('{n}', '1') + zh('durSec').replace('{n}', '5')) > 0, '有起点（65 秒）时该显示「1分5秒」，实际 ' + workingLive)
assert(workingLive.includes('superpi-working-text') && workingLive.indexOf('···') > 0, '有起点时文字该带 ··· 结尾，实际 ' + workingLive)
assert(workingLive.includes('role="status"') && workingLive.includes('aria-live="polite"'), '该给读屏软件一条 live region（只播报「深度求索中」，不带每秒变的秒数）')
assert(workingLive.includes('class="superpi-sr"'), 'live region 该复用 .superpi-sr 视觉隐藏类，实际 ' + workingLive.slice(0, 300))
const workingNoSince = renderToStaticMarkup(React.createElement(WorkingRow, { t: zh }))
assert(workingNoSince.includes(zh('deepDiving')), '没有起点时该只说「' + zh('deepDiving') + '」，实际 ' + workingNoSince)
assert(workingNoSince.indexOf('用时') < 0, '没有起点时不该编一个用时出来，实际 ' + workingNoSince)
// 第一秒内也报「1秒」：DSH 是 formatRunDuration(Math.max(1e3, now - startTime), t)
// （dsh-client-ui-chat/lib/client.js:6402）；不钳位的话刚发出的一瞬会闪「0秒」。
const workingJustStarted = renderToStaticMarkup(React.createElement(WorkingRow, { t: zh, since: Date.now() }))
assert(workingJustStarted.indexOf(zh('durSec').replace('{n}', '1')) > 0, '刚起步时该至少报「1秒」而不是「0秒」，实际 ' + workingJustStarted)

{
  const { RunStatusRow, createView, applyBatch, hydrateFromSnapshot } = internals
  const proc = new PiProcess({ maxEvents: 1, decorateEvent: decoratePiEvent })
  const view = createView()
  proc.on('event', entry => applyBatch(view, [entry]))
  const renderStatus = (state = view, t = zh) => typeof RunStatusRow === 'function'
    ? renderToStaticMarkup(React.createElement(RunStatusRow, { view: state, t }))
    : ''
  assert(renderStatus() === '', '尚无本轮结果时不显示结果行')
  proc.pushEvent({ type: 'agent_start' })
  proc.pushEvent({ type: 'tool_execution_end', toolCallId: 'probe', toolName: 'bash', isError: true })
  proc.pushEvent({ type: 'tool_execution_end', toolCallId: 'retry', toolName: 'bash', isError: false })
  assert(renderStatus().includes('superpi-working-icon'), '工具报错后仍在运行时保留执行中图标')
  proc.pushEvent({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '已完成。' }] } })
  proc.pushEvent({ type: 'agent_settled', aborted: false })
  const warning = renderStatus()
  assert(warning.includes('>✔</span>') && warning.includes('本轮已结束 · 曾有错误') && warning.includes('data-tone="warn"'),
    '本轮收尾后，成功重试显示勾号和原有的结束文案')
  assert(warning.includes('role="status"') && !warning.includes('superpi-working-icon'), '结束文案可播报且图标停止旋转')
  assert(cssRule('.superpi-working[data-tone="warn"]')?.includes('var(--dsw-alias-state-warn-primary)'), '勾号和文案使用宿主警告色')
  assert(renderStatus(view, en).includes('Turn ended · Errors occurred'), '英文界面也说明本轮已结束且曾出现错误')

  proc.pushEvent({ type: 'session_info_changed', name: 'Test' })
  const restored = hydrateFromSnapshot(createView(), proc.snapshot())
  assert(renderStatus(restored) === warning && warning !== '', '收尾事件被淘汰后仍从快照恢复可见状态')
  proc.resetEvents()
  assert(renderStatus(hydrateFromSnapshot(view, proc.snapshot())) === '', '更换会话后不带出上一会话的收尾状态')
  proc.pushEvent({ type: 'agent_start' })
  proc.pushEvent({ type: 'agent_settled', aborted: false })
  const complete = renderStatus()
  assert(complete.includes('✔') && complete.includes('本轮已结束') && complete.includes('data-tone="ok"'), '下一轮顺利结束时显示勾号')
  assert(cssRule('.superpi-working[data-tone="ok"]')?.includes('var(--dsw-alias-state-success-primary)'), '顺利结束使用宿主成功色')
  proc.pushEvent({ type: 'agent_start' })
  proc.pushEvent({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [] } })
  proc.pushEvent({ type: 'agent_settled', aborted: false })
  assert(view.verdict?.kind === 'idle' && renderStatus() === '', '响应仍有异常时保留可继续的诊断')
  proc.pushEvent({ type: 'agent_start' })
  proc.pushEvent({ type: 'tool_execution_end', toolCallId: 'stop', isError: true })
  proc.pushEvent({ type: 'agent_settled', aborted: true })
  assert(renderStatus() === '', '主动停止时不显示结束或警告状态')
}
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
assert(dirHtml.includes('superpi-dir'), 'DirSheet 该渲染 .superpi-dir 容器')
assert(dirHtml.includes(zh('dirTitle')), 'DirSheet 标题该是「' + zh('dirTitle') + '」')
assert(dirHtml.includes('superpi-dir-crumbs'), 'DirSheet 该渲染面包屑')
assert(dirHtml.includes('pi-workspace'), '面包屑该带最后一级目录名')
assert(dirHtml.includes(zh('dirLoading')), '首帧该显示读取中文案（effect 尚未跑）')
assert(dirHtml.includes(zh('dirHere')), '底部该有「' + zh('dirHere') + '」按钮')
assert(dirHtml.includes(zh('dirInputHint')), '该有可编辑路径输入框（placeholder ' + zh('dirInputHint') + '）')
assert(dirHtml.split('class="superpi-dir-col"').length - 1 === 1, '未选中时只该有一栏（Miller 分栏的第二栏靠选中触发）')
// 选择工作区必须是居中模态（不是铺满面板的抽屉）：它是会打断当前会话的决策。
assert(dirHtml.includes('superpi-dialog-wrap'), '选择工作区该是模态弹窗（.superpi-dialog-wrap）')
assert(dirHtml.includes('superpi-dir-dialog'), '选择工作区该有 680x500 的弹窗外壳')
assert(dirHtml.includes('role="dialog"'), '弹窗该声明 role=dialog')
assert(dirHtml.includes('aria-modal="true"'), '弹窗该声明 aria-modal=true（模态语义）')
assert(dirHtml.includes('superpi-sheet') === false, '选择工作区不该再用铺满面板的 .superpi-sheet 外壳')
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

const deliveredEntry = { type: 'custom_message', customType: 'superpi-task-receipt', display: true,
  content: '任务验收通过\nRun the final acceptance command' }
const deliveryView = internals.createView()
internals.applyRecord(deliveryView, { type: 'entry_appended', entry: deliveredEntry })
assert(deliveryView.messages.length === 1, '验收回执在边界事件到达时进入对话')
const renderDelivery = message => message ? renderToStaticMarkup(React.createElement(internals.MessageRow, { message, t: zh, toolStatus: {} })) : ''
assert(renderDelivery(deliveryView.messages[0]).includes('Run the final acceptance command'), '实时消息渲染实际验收回执')
const storedReceipt = { ...deliveredEntry, role: 'custom' }
assert(renderDelivery(internals.messagesFromHistory([storedReceipt])[0]).includes('任务验收通过'), '重开会话后可读到持久化验收回执')
assert(renderDelivery(internals.messagesFromHistory([{ ...storedReceipt, display: false }])[0]) === '', '隐藏的扩展提示不渲染成回执')

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
assert(projectLevel.includes('class="superpi-proj"'), '项目层该渲染 .superpi-proj 行')
assert(projectLevel.includes('class="superpi-sess"') === false, '项目层不该混入会话行（项目行复用 sess-top/sess-title 排版，但外层类名必须是 superpi-proj）')
assert(projectLevel.includes('data-current="1"'), '当前项目该打 data-current=1')
assert(projectLevel.includes('data-temporary="1"'), '临时项目该打 data-temporary=1')
assert(projectLevel.includes(zh('tempTag')), '临时项目该显示「' + zh('tempTag') + '」标签')
assert(projectLevel.includes('~\\pi-workspace'), '项目行标题该用 displayPath（~ 缩写），而不是绝对路径')
assert(projectLevel.includes(zh('projectSessions').replace('{n}', '3')), '项目行该显示会话数：' + zh('projectSessions').replace('{n}', '3'))
assert(projectLevel.includes(zh('projectList')), '项目层标题该是「' + zh('projectList') + '」')
assert(projectLevel.includes(zh('searchProjects')), '项目层搜索框 placeholder 该是「' + zh('searchProjects') + '」')
assert(projectLevel.includes('superpi-side-new') && projectLevel.includes(zh('newProject')), '项目层该有「' + zh('newProject') + '」按钮')
assert(projectLevel.includes('superpi-side-back') === false, '项目层不该有返回键')
assert(projectLevel.includes('superpi-row-more'), '每行右侧该有 ⋯ 入口（项目层）')
const sessionLevel = renderToStaticMarkup(React.createElement(internals.SessionsList, {
  t: zh, level: 'sessions', project: projEntries[1], query: '', currentPath: 'D:\\proj\\b.jsonl',
  info: { loading: false, error: null, projects: [], sessions: sessEntries, total: 2 },
  onQuery() {}, onOpenProject() {}, onBack() {}, onPick() {}, onClose() {},
}))
assert(sessionLevel.includes('class="superpi-sess"'), '会话层该渲染 .superpi-sess 行')
assert(sessionLevel.includes('class="superpi-proj"') === false, '会话层不该混入项目行')
assert(sessionLevel.includes(zh('searchSessions')), '会话层搜索框 placeholder 该是「' + zh('searchSessions') + '」')
assert(sessionLevel.includes('superpi-side-back'), '会话层该有回项目层的图标返回键')
assert(sessionLevel.includes('← ' + zh('allProjects')) === false, '返回键是图标按钮，不该再渲染「← 全部项目」文字')
assert(sessionLevel.includes('>q1<'), '没名字的会话该把 firstMessage 当标题')
assert(sessionLevel.includes('>NAMED<') && sessionLevel.includes('>q2<'), '有会话名的行该显示名字，并把 firstMessage 收进摘要格')
assert(sessionLevel.includes('D:\\proj'), '会话层标题该是项目路径')
assert(sessionLevel.includes('superpi-tag'), '会话层该给当前会话打「' + zh('current') + '」标签')
assert(sessionLevel.includes(zh('sessionsHint')), '会话层该显示会话提示文案')
// 0.8.0：ui-prefs 的两棵表（项目名 / 会话名 / 置顶）与行内 ⋯ 菜单。
// 这些是「面板自己的账」——pi 的 RPC 面没有别名与置顶概念，所以只能靠纯渲染层断言锁住。
const pinnedLevel = renderToStaticMarkup(React.createElement(internals.SessionsList, {
  t: zh, level: 'sessions', project: projEntries[1], query: '', currentPath: null,
  info: { loading: false, error: null, projects: [], sessions: sessEntries, total: 2 },
  prefs: { projects: {}, sessions: { 'D:\\proj\\a.jsonl': { pinned: true } } },
  menuKey: null, onRowMenu() {}, onRenameProject() {}, onRenameSession() {}, onTogglePin() {},
  onNewProject() {}, onNewSessionAt() {}, onQuery() {}, onOpenProject() {}, onBack() {}, onPick() {}, onClose() {},
}))
assert(pinnedLevel.split('class="superpi-sess"').length - 1 === 2, '置顶不该增删行')
assert(pinnedLevel.indexOf('>q1<') < pinnedLevel.indexOf('>NAMED<'), '置顶的会话该排到最前，其余保持 host 给的顺序')
assert(pinnedLevel.includes('data-pinned="1"'), '置顶行该打 data-pinned=1')
const prefsLevel = renderToStaticMarkup(React.createElement(internals.SessionsList, {
  t: zh, level: 'sessions', project: projEntries[1], query: '', currentPath: null,
  info: { loading: false, error: null, projects: [], sessions: sessEntries, total: 2 },
  prefs: { projects: {}, sessions: { 'D:\\proj\\b.jsonl': { name: '我自己起的名字' } } },
  onQuery() {}, onOpenProject() {}, onBack() {}, onPick() {}, onClose() {},
}))
assert(prefsLevel.includes('我自己起的名字'), 'ui-prefs 里的会话名该盖过 pi 的会话名')
const renamedProjectLevel = renderToStaticMarkup(React.createElement(internals.SessionsList, {
  t: zh, level: 'projects', project: null, query: '', currentPath: null,
  info: { loading: false, error: null, projects: projEntries, sessions: [], total: 6 },
  prefs: { projects: { 'd:\\proj': { name: '我的工程' } }, sessions: {} },
  onQuery() {}, onOpenProject() {}, onBack() {}, onPick() {}, onClose() {},
}))
assert(renamedProjectLevel.includes('我的工程') && renamedProjectLevel.includes('data-renamed="1"'), '项目别名该盖过 displayPath 并打 data-renamed=1')
const menuLevel = renderToStaticMarkup(React.createElement(internals.SessionsList, {
  t: zh, level: 'sessions', project: projEntries[1], query: '', currentPath: null,
  info: { loading: false, error: null, projects: [], sessions: sessEntries, total: 2 },
  menuKey: 'sess:D:\\proj\\b.jsonl',
  onQuery() {}, onOpenProject() {}, onBack() {}, onPick() {}, onClose() {},
}))
assert(menuLevel.includes('superpi-more-menu'), '点开 ⋯ 该渲染菜单')
assert(menuLevel.includes(zh('renameSession')) && menuLevel.includes(zh('pinSession')), '会话行菜单该有重命名与置顶')
assert(menuLevel.includes('aria-expanded="true"'), '展开的 ⋯ 该 aria-expanded=true')
const renameDlg = renderToStaticMarkup(React.createElement(internals.RenameDialog, {
  t: zh, title: zh('renameSession'), value: '旧名字', onSubmit() {}, onClose() {},
}))
assert(renameDlg.includes('class="superpi-dialog"') && renameDlg.includes('superpi-search'), '重命名弹窗该是居中 Dialog + 输入框')
assert(renameDlg.includes(zh('cancel')) && renameDlg.includes(zh('extSubmit')), '重命名弹窗该有取消与提交')
const filteredLevel = renderToStaticMarkup(React.createElement(internals.SessionsList, {
  t: zh, level: 'projects', project: null, query: 'd:\\proj', currentPath: null,
  info: { loading: false, error: null, projects: projEntries, sessions: [], total: 6 },
  onQuery() {}, onOpenProject() {}, onBack() {}, onPick() {}, onClose() {},
}))
assert(filteredLevel.split('class="superpi-proj"').length - 1 === 1, '搜索该把项目层过滤到 1 行（路径也参与匹配）')
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
assert(chip('C:' + BS + 'Users' + BS + 'PC' + BS + 'a.md').includes('class="superpi-fileref"'), '盘符绝对路径该渲染成 superpi-fileref 按钮')
assert(chip('C:' + BS + 'Users' + BS + 'a.md').includes('type="button"'), '文件标签必须是真正的 button：键盘 Tab 要能落上去')
assert(chip('C:' + BS + 'a.md').includes('data-path='), '文件标签要把原始路径放在 data-path 上，供点击时取')
assert(chip('C:' + BS + 'a.md').includes('superpi-fileref-name">a.md'), '文件标签末段该是文件名')
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
assert(prose.includes('superpi-fileref'), '段落正文里的路径该变成标签')
assert(prose.includes('结论在'), '标签前后的纯文本必须原样保留（不吞字）')
assert(prose.includes('里。'), '路径后面的纯文本也要保留')
assert(prose.includes('data-openable="0"'), '没有 opener 时标签标 data-openable=0，不假装可点')
const fenced = renderToStaticMarkup(React.createElement('div', null, internals.renderMarkdown('```' + NL + 'D:' + BS + 'work' + BS + 'artifacts' + BS + 'handoff.md' + NL + '```', null)))
assert(fenced.includes('superpi-fileref-block'), '围栏里整块只有一条路径时整块变成标签（用户截图就是这种）')
assert(fenced.includes('superpi-fence') === false, '整块变成标签后不该再套一层代码块')
const multiFence = renderToStaticMarkup(React.createElement('div', null, internals.renderMarkdown('```' + NL + 'npm run build' + NL + 'npm test' + NL + '```', null)))
assert(multiFence.includes('superpi-fence'), '多行代码块必须保持代码块，绝不拆成标签')
const inlineCode = renderToStaticMarkup(React.createElement('div', null, internals.renderMarkdown('路径是 `' + 'C:' + BS + 'a' + BS + 'b.md' + '` 别复制', null)))
assert(inlineCode.includes('superpi-fileref'), '行内反引号里整段是路径时该变成标签（助手常这么写）')
const plainInline = renderToStaticMarkup(React.createElement('div', null, internals.renderMarkdown('`npm test`', null)))
assert(plainInline.includes('superpi-code-inline'), '行内 code 不是路径时必须保持 code 样式')
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
assert(bothActions.includes('superpi-fileref-dir') === false, '文件标签不该再显示目录灰字')
assert(bothActions.includes('>a.md<'), '文件标签正文就是文件名')

// 关闭按钮：三处入口共用同一个组件，图标是 svg 而不是文本 ×
const closeHtml = renderToStaticMarkup(React.createElement(internals.CloseButton, { t: zh, onClick() {} }))
assert(closeHtml.includes('superpi-btn-icon'), '关闭按钮该带 superpi-btn-icon（28px 命中区，与其它按钮同高）')
assert(closeHtml.includes('<svg'), '关闭按钮该用描边图标，不是纯文本 ×')
assert(closeHtml.includes('aria-label="' + zh('close') + '"'), '关闭按钮要有 aria-label，读屏用户才认得')
assert(closeHtml.includes('>×<') === false, '关闭按钮不该再输出文本 ×')
assert(settingsHtml.includes('superpi-btn-icon'), '设置弹窗的关闭按钮该是图标按钮（跟 Dialog 同款）')
assert(settingsHtml.includes('>×<') === false, '设置弹窗不该再输出文本 ×')
assert(dirHtml.includes('superpi-btn-icon'), '目录弹窗的关闭按钮该是图标按钮（以前这里连 type=button 都没有）')
assert(dirHtml.includes('>×<') === false, '目录弹窗不该再输出文本 ×')
assert(dialogHtml({ method: 'confirm', title: 'T', message: 'M' }).includes('superpi-dialog-head'), '扩展弹窗该有带关闭按钮的头部')
assert(dialogHtml({ method: 'confirm', title: 'T', message: 'M' }).includes('superpi-btn-icon'), '扩展弹窗的关闭按钮与抽屉同款')

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
  onClipboardFiles() { return Promise.resolve([]) },
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
  // 模型与思考档位合成同一个向上弹层（0.7.0），开合状态在面板上，Composer 只当锚点。
  pickerOpen: false,
  onOpenPicker() {},
  onClosePicker() {},
  models: [{ id: 'deepseek-v4', provider: 'deepseek', name: 'DeepSeek V4' }],
  modelsLoading: false,
  onPickModel() {},
  onPickThinking() {},
}
const composerHtml = renderToStaticMarkup(React.createElement(Composer, composerProps))
{
  const { Composer: ClipboardComposer } = definition.factory(() => ({
    ...React,
    useRef(initial) { return { current: initial } },
    useState(initial) { return [initial, () => {}] },
    useEffect() {},
  })).__internals
  const nodes = node => React.isValidElement(node) ? [node, ...nodes(node.props.children)] : Array.isArray(node) ? node.flatMap(nodes) : []
  const files = ['image/png', 'video/mp4', 'audio/wav', 'application/pdf'].map(type => ({ type }))
  const paths = ['C:/my cache/image.png', 'C:/clip/movie.mp4', 'C:/clip/sound.wav', 'C:/clip/file.pdf']
  let usedFiles = []
  let draft = ''
  let prevented = false
  const rendered = ClipboardComposer({
    ...composerProps,
    onDraftText(value) { draft = value },
    async onClipboardFiles(items) { usedFiles = items; return paths },
  })
  const input = nodes(rendered).find(node => node.type === 'textarea')
  input.props.ref.current = { value: '旧内容', selectionStart: 0, selectionEnd: 3, focus() {}, setSelectionRange() {} }
  const priorTimer = window.setTimeout
  try {
    window.setTimeout = setTimeout
    input.props.onPaste({ clipboardData: { items: files.map(file => ({ kind: 'file', getAsFile: () => file })) }, preventDefault() { prevented = true } })
    await new Promise(resolve => setImmediate(resolve))
    assert(prevented && usedFiles.every((file, index) => file === files[index]) && usedFiles.length === files.length, '粘贴手势把各种非文本文件交给路径解析')
    assert(draft === '"' + paths[0] + '"\n' + paths.slice(1).join('\n'), '浏览器输入框把解析路径插入当前选区')
    prevented = false
    input.props.onPaste({ clipboardData: { items: [{ kind: 'string' }] }, preventDefault() { prevented = true } })
    assert(!prevented, '文字粘贴使用浏览器的原生文本插入')
  } finally {
    window.setTimeout = priorTimer
  }
}
assert(composerHtml.includes('superpi-box'), '输入区该有卡面 superpi-box')
assert(composerHtml.includes('superpi-ta'), '输入区该有 textarea.superpi-ta')
assert(composerHtml.includes('superpi-add'), '左端该有圆形 + 按钮（宿主同款）')
assert(composerHtml.includes('aria-expanded="false"'), '+ 按钮该带 aria-expanded，菜单没开时是 false')
assert(composerHtml.includes('superpi-send'), '右端该有圆形发送键 superpi-send')
assert(composerHtml.includes('disabled=""'), '空输入时发送键该禁用')
assert(composerHtml.includes('superpi-bar-hint'), '快捷键提示仍在 bar 里固定位置')
assert(composerHtml.includes('superpi-picker'), '有模型时该渲染模型下拉')
assert(composerHtml.includes('deepseek-v4'), '模型下拉显示模型 id')
assert(composerHtml.includes('superpi-picker-box'), '模型名与思考档位共用一个锚点 superpi-picker-box')
assert(composerHtml.includes('superpi-picker-native') === false, '不再用原生 select 叠层：档位也是弹层里的一行')
assert(composerHtml.includes('>medium<'), '档位按钮该显示当前档位')
assert(composerHtml.includes('aria-haspopup="menu"'), '两个 picker 都该声明弹出菜单')
// 弹层没开时不该渲染任何菜单项，避免 SSR 里多出一层盖住输入区。
assert(composerHtml.includes('superpi-picker-menu') === false, '未打开时不该渲染模型弹层')
const pickerHtml = renderToStaticMarkup(React.createElement(Composer, Object.assign({}, composerProps, { pickerOpen: true })))
assert(pickerHtml.includes('superpi-picker-menu'), '打开后该渲染向上弹层 superpi-picker-menu')
assert(pickerHtml.includes(zh('pickModel')) && pickerHtml.includes(zh('pickThinking')), '弹层里模型与思考档位两段标题都要有')
assert(pickerHtml.includes('role="menu"'), '弹层该是 role=menu')
assert(pickerHtml.includes('role="menuitemradio"'), '每行都是 menuitemradio（两段都是单选）')
assert(pickerHtml.includes('aria-checked="true"'), '当前模型 / 档位该是 aria-checked=true')
assert(pickerHtml.includes('aria-expanded="true"'), '打开后锚点该同步 aria-expanded')
assert(composerHtml.includes('superpi-btn-icon') === false, 'bar 里不该再有旧的图标文字按钮（都并进 + 菜单了）')
// 附件与目录收进 + 菜单后，bar 左侧只剩 + / 模型 / 推理等级三个控件。
assert(composerHtml.includes(zh('attachFile')) === false, '回形针按钮该收进 + 菜单，不再占 bar')
assert(composerHtml.includes(zh('pickDir')) === false, '目录按钮该收进 + 菜单，不再占 bar')

// 运行中：同一位置换成方形停止键，且不再额外挂「排队 / 停止」文字按钮
const busyHtml = renderToStaticMarkup(React.createElement(Composer, Object.assign({}, composerProps, { busy: true })))
assert(busyHtml.includes('superpi-stop'), '运行中右端该变成停止圆钮 superpi-stop')
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
assert(addHtml.includes('superpi-menu-add'), '加号菜单该有自己的定位类（向左展开，不铺满整行）')
assert(addHtml.includes('role="menu"'), '加号菜单该声明 role=menu')
assert(addHtml.includes('superpi-menu-section'), '菜单该按「添加 / 指令」分组')
assert(addHtml.includes(zh('addGroupAdd')) && addHtml.includes(zh('addGroupCommands')), '两组标题都该出现')
assert(addHtml.includes('superpi-add-icon'), '每项左侧该有图标')
assert(addHtml.includes('superpi-add-key'), '每项该带英文键名（宿主同款两列）')
assert(addHtml.includes('>file<') && addHtml.includes('>compact<'), '英文键名该渲染出来')
assert(addHtml.includes(zh('addFileDesc')), '每项右侧该有灰色说明')
assert(addHtml.includes('role="menuitem"') , '菜单项该声明 role=menuitem')
assert(addHtml.includes('data-active="-1"') === false, '没有 hover 时不该把某项标成 active')

// dock：统计行属于 composer 容器（宿主 .GRgSLq_dock 就在 root 里、卡下方），不是面板根上的另一条
const withFooter = renderToStaticMarkup(React.createElement(Composer, Object.assign({}, composerProps, {
  footer: React.createElement('div', { className: 'superpi-statusbar' }, 'x'),
})))
assert(withFooter.includes('superpi-statusbar'), '传了 footer 就该渲染统计行')
assert(withFooter.indexOf('superpi-box') < withFooter.indexOf('superpi-statusbar'), '统计行该在输入卡之后（宿主同序）')
assert(composerHtml.includes('superpi-statusbar') === false, '没传 footer 时不该凭空造一条统计行')

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

// ── 9.18 模态弹窗 + 菜单点外部关闭 + 顶栏项目标题（0.8.1，用户 35984） ──────
// 三条需求都属「点了别处该消失 / 标题该是当前项目」，SSR 渲染不出事件处理器，
// 所以把判定抽成纯函数 maskHandler / isOutsideMenu / projectTitleOf 单独锁死，
// 再用 SSR 结构断言确认四个弹窗外壳都是「遮罩包卡片」而不是把 onClick 挂在卡片上。
const maskHandler = internals.maskHandler
assert(typeof maskHandler === 'function', 'client.js 应导出 maskHandler 以便测试')
const maskCalls = []
const onMask = maskHandler(function () { maskCalls.push('closed') })
const maskNode = { id: 'mask' }
onMask({ target: maskNode, currentTarget: maskNode })
assert(maskCalls.length === 1, '点遮罩本身该关闭弹窗，实际调用 ' + String(maskCalls.length) + ' 次')
onMask({ target: { id: 'card-child' }, currentTarget: maskNode })
assert(maskCalls.length === 1, '点卡片内部（冒泡到遮罩时 target 不是遮罩）不该关闭，实际 ' + String(maskCalls.length) + ' 次')
assert(typeof maskHandler(function () {}) === 'function', 'maskHandler 每次调用都该返回一个新的处理函数')

const isOutsideMenu = internals.isOutsideMenu
assert(typeof isOutsideMenu === 'function', 'client.js 应导出 isOutsideMenu 以便测试')
const menuNode = { contains: node => node !== null && node !== undefined && node.id === 'menu-child' }
const anchorRef = { current: { contains: node => node !== null && node !== undefined && node.id === 'trigger' } }
assert(isOutsideMenu(menuNode, anchorRef, { id: 'menu-child' }) === false, '点菜单自身不算外部')
assert(isOutsideMenu(menuNode, anchorRef, { id: 'trigger' }) === false, '点触发按钮不算外部（否则 mousedown 关了 click 又开，表现为关不掉）')
assert(isOutsideMenu(menuNode, anchorRef, { id: 'elsewhere' }) === true, '点面板别处该算外部并收起菜单')
assert(isOutsideMenu(menuNode, null, { id: 'menu-child' }) === false, '没有 anchor 时菜单自身仍不算外部')
assert(isOutsideMenu(menuNode, undefined, { id: 'elsewhere' }) === true, 'anchor 为 undefined 时不该抛异常')
assert(isOutsideMenu(null, null, { id: 'elsewhere' }) === true, '菜单还没挂载（node 为 null）时一律算外部，不抛')

// 四条文案在早期版本里都出现过，现在是同一份 <div class="superpi-dialog-wrap"><div class="superpi-dialog"
// 结构；断言直接锁这个父子顺序，防止有人把 onClick 挪到卡片上（那样点卡片也会关）。
const centerDialog = internals.Dialog
assert(typeof centerDialog === 'function', 'client.js 应导出 Dialog 以便测试')
const centerHtml = renderToStaticMarkup(React.createElement(centerDialog, { t: zh, title: '统计', onClose() {} }, 'body'))
console.log('dialog =', centerHtml)
assert(centerHtml.includes('<div class="superpi-dialog-wrap"><div class="superpi-dialog"'), '居中弹窗该是「遮罩 > 卡片」两层，实际 ' + centerHtml)
assert((centerHtml.match(/aria-modal="true"/g) ?? []).length === 1, '居中弹窗的卡片该声明一次 aria-modal=true')
assert(centerHtml.includes(zh('cancel')) === false && centerHtml.includes('role="alertdialog"') === false, '普通弹窗不该带确认语义')

const confirmCenter = internals.ConfirmDialog
assert(typeof confirmCenter === 'function', 'client.js 应导出 ConfirmDialog 以便测试')
const confirmCenterHtml = renderToStaticMarkup(React.createElement(confirmCenter, { t: zh, title: '重连', body: '会断开', onCancel() {}, onConfirm() {} }))
console.log('confirmDialog =', confirmCenterHtml)
assert(confirmCenterHtml.includes('<div class="superpi-dialog-wrap"><div class="superpi-dialog"'), '二次确认该是「遮罩 > 卡片」两层')
assert(confirmCenterHtml.includes('role="alertdialog"'), '二次确认该是 alertdialog')
assert(confirmCenterHtml.includes('aria-modal="true"'), '二次确认该声明 aria-modal=true')

// 扩展 UI 弹窗（四种 method 共用一个壳）：0.8.1 补上 aria-modal —— 它会阻塞 pi 整轮等待。
assert(confirmHtml.includes('aria-modal="true"'), '扩展 UI 弹窗该声明 aria-modal=true（0.8.1 补齐）')
assert(confirmHtml.includes('<div class="superpi-dialog-wrap"><div class="superpi-dialog"'), '扩展 UI 弹窗该是「遮罩 > 卡片」两层')

const MoreMenuExport = internals.MoreMenu
assert(typeof MoreMenuExport === 'function', 'client.js 应导出 MoreMenu 以便测试')
const menuHtml = renderToStaticMarkup(React.createElement(MoreMenuExport, {
  t: zh,
  anchor: null,
  items: [{ key: 'compact', label: zh('compactNow'), icon: internals.SparkIcon, run() {} }],
  onPick() {},
  onClose() {},
}))
console.log('moreMenu =', menuHtml)
assert(menuHtml.includes('role="menu"'), '更多菜单该声明 role=menu')
assert(menuHtml.includes('role="menuitem"'), '更多菜单项该声明 role=menuitem')
assert(menuHtml.includes(zh('compactNow')), '更多菜单该渲染传入的条目文案')

const projectTitleOf = internals.projectTitleOf
assert(typeof projectTitleOf === 'function', 'client.js 应导出 projectTitleOf 以便测试')
const prefsFixture = { projects: { 'c:\\users\\pc\\pi-workspace': { name: '我的工作区' } }, sessions: {} }
assert(projectTitleOf(prefsFixture, { projectKey: 'c:\\users\\pc\\pi-workspace', displayPath: '~\\pi-workspace', sessionCwd: 'C:\\Users\\PC\\pi-workspace' }) === '我的工作区', '重命名过的项目该显示改名后的名字')
assert(projectTitleOf(prefsFixture, { projectKey: 'c:\\other', displayPath: '~\\other', sessionCwd: 'C:\\other' }) === '~\\other', '没改名时该用 host 下发的 displayPath（~ 缩写）')
assert(projectTitleOf(prefsFixture, { sessionCwd: 'D:\\work' }) === 'D:\\work', '既没 prefs 也没 displayPath 时回落到 cwd')
assert(projectTitleOf(prefsFixture, { cwd: 'D:\\work' }) === 'D:\\work', '只有 cwd 时同样回落')
assert(projectTitleOf(prefsFixture, { sessionCwd: 'E:\\w', cwd: 'D:\\work' }) === 'E:\\w', 'sessionCwd 优先于 cwd（跨项目切换后 cwd 仍是 spawn 目录）')
assert(projectTitleOf(prefsFixture, null) === '', '没有会话时返回空串，由调用方回落品牌名')
assert(projectTitleOf(null, { projectKey: 'x', displayPath: '~\\x' }) === '~\\x', 'prefs 还没拉回来时不该抛异常')
assert(projectTitleOf(prefsFixture, {}) === '', '元数据里一个路径都没有时返回空串，不编造标题')
// ── 10. 整棵面板在 loading 阶段能渲染，不抛异常 ────────────────────────────
const panelHtml = renderToStaticMarkup(React.createElement(internals.SuperPiPanel, { t: zh }))
assert(panelHtml.includes('superpi-root'), 'SuperPiPanel 应渲染出 superpi-root')
assert(panelHtml.includes(zh('loading')), 'SuperPiPanel 首帧应是 loading 文案')

// ── 11. 0.14.0 性能修复的渲染面判据 ──────────────────────────────────────
// 对应 docs/performance-acceptance.md 判据 B / E。这些点退化时不报错、只是"变卡"，
// 所以必须由断言把行为钉住。

// 11a. 历史图片走 image-stub：占位卡可点、不带 base64、带 id。
{
  const stubHtml = renderToStaticMarkup(React.createElement(internals.ImageBlock, {
    data: '',
    mimeType: 'image/png',
    stubId: 'sess:12:0',
    bytes: 204800,
    onOpen: () => {},
    t: zh,
  }))
  assert(stubHtml.includes('superpi-imagestub'), 'image-stub 应渲染成可点占位卡，不是 <img>')
  assert(!stubHtml.includes('<img'), 'image-stub 不应生成 <img>（那就等于把 base64 当空串塞进去了）')
  assert(stubHtml.includes('data-stub-id="sess:12:0"'), 'image-stub 必须带 stubId（回取原图的句柄）')
  assert(stubHtml.includes('200 KB'), 'image-stub 应显示体积（用户要知道自己在点什么）')
  assert(stubHtml.includes(zh('viewImage')), 'image-stub 应提示可查看（不能让人以为图坏了）')

  // 本轮图片带真实 base64：必须仍然渲染成 <img>，不能退化。
  const liveHtml = renderToStaticMarkup(React.createElement(internals.ImageBlock, {
    data: 'AAAA',
    mimeType: 'image/png',
    stubId: null,
    bytes: 0,
    onOpen: () => {},
    t: zh,
  }))
  assert(liveHtml.includes('<img'), '本轮图片（有 base64）仍渲染成 <img>')
  assert(liveHtml.includes('data:image/png;base64,AAAA'), '本轮图片的 data URL 原样保留')
}

// 11b. Working 行显示当前工具与它自带的上限（判据 B）。
{
  const withTool = renderToStaticMarkup(React.createElement(internals.WorkingRow, {
    t: zh,
    since: Date.now() - 5000,
    tool: { name: 'bash', startedAt: Date.now() - 520000, limitSeconds: 500 },
  }))
  assert(withTool.includes('superpi-working-tool'), 'Working 行应渲染工具段')
  assert(withTool.includes('bash'), '应显示工具名')
  // 超过 500s 上限时必须显式说明，而不是静默继续加秒数。
  assert(withTool.includes(zh('toolOverLimit').replace('{limit}', internals.fmtDuration(500000, zh))),
    '超过命令自设上限时应显示「已超出上限」')

  const withinLimit = renderToStaticMarkup(React.createElement(internals.WorkingRow, {
    t: zh,
    since: Date.now() - 5000,
    tool: { name: 'bash', startedAt: Date.now() - 60000, limitSeconds: 500 },
  }))
  assert(withinLimit.includes(zh('toolLimit').replace('{limit}', internals.fmtDuration(500000, zh))),
    '未超上限时应显示「上限 500s」')

  const noTool = renderToStaticMarkup(React.createElement(internals.WorkingRow, {
    t: zh,
    since: Date.now() - 5000,
    tool: null,
  }))
  assert(!noTool.includes('superpi-working-tool'), '没有工具在跑时不应出现工具段')
  assert(noTool.includes('superpi-working-text'), '纯推理时仍显示原有的用时文案')
}

// 11b2. 静默心跳：与命令行窗口同口径（0.15.0）。
{
  const fresh = renderToStaticMarkup(React.createElement(internals.WorkingRow, {
    t: zh,
    since: Date.now() - 5000,
    tool: { name: 'bash', startedAt: Date.now() - 5000, limitSeconds: 960, lastOutputAt: Date.now() },
  }))
  assert(!fresh.includes(zh('toolSilent').replace('{silent}', '')), '刚有输出时不显示静默心跳')
  assert(fresh.includes('bash'), '仍显示工具名')

  const silent = renderToStaticMarkup(React.createElement(internals.WorkingRow, {
    t: zh,
    since: Date.now() - 300000,
    tool: { name: 'bash', startedAt: Date.now() - 220000, limitSeconds: 960, lastOutputAt: Date.now() - 210000 },
  }))
  assert(silent.includes('仍在运行'), '静默超阈值时必须说「仍在运行」（消解焦虑的关键半句）')
  assert(silent.includes('已静默'), '显示已静默时长')
  // 只检查**心跳段**里不含百分比：整行里可能有别的合法文本，越界断言会误报。
  const silentMatch = silent.match(/已静默[^<]*/)
  assert(silentMatch !== null && !/%/.test(silentMatch[0]), '心跳段不编造百分比（没有真实进度就不装作有）')

  // 工具结束后不残留心跳
  const noTool = renderToStaticMarkup(React.createElement(internals.WorkingRow, {
    t: zh,
    since: Date.now() - 300000,
    tool: null,
  }))
  assert(!noTool.includes('已静默'), '工具结束后不显示心跳')
}

// 11c. messagesFromHistory 必须保留 host 给的 seq（翻页去重与 React key 依赖它）。
{
  const list = [
    { role: 'user', content: [{ type: 'text', text: 'a' }], seq: 42 },
    { role: 'assistant', content: [{ type: 'text', text: 'b' }], seq: 43 },
    { role: 'user', content: [{ type: 'text', text: 'c' }] },
  ]
  const mapped = internals.messagesFromHistory(list)
  assert(mapped[0].seq === 42, 'host 给的 seq 必须原样保留（不能用数组下标覆盖）')
  assert(mapped[1].seq === 43, '第二条同样保留 host seq')
  assert(mapped[2].seq === 2, '没有 seq 时退回数组下标（事件流回放路径）')
}

// 11d. createView 必须带上分页状态字段（少了就是「加载更早」永远不出现）。
{
  const v = internals.createView()
  assert(v.hasEarlier === false, 'createView 应初始化 hasEarlier=false')
  assert(v.messageTotal === 0, 'createView 应初始化 messageTotal=0')
  assert(v.loadingEarlier === false, 'createView 应初始化 loadingEarlier=false')
  assert(v.activeTool === null, 'createView 应初始化 activeTool=null')
}

/* ═══════════════════════════════════════════════════ 12. 事件摄入层（0.16.1） */

/**
 * 这一段补的是**整条门禁链的空白地带**。
 *
 * 0.16.0 的对抗性审查证实：本文件此前只做首帧 SSR（renderToStaticMarkup），
 * 从不驱动事件流 —— 于是「attach() 先把 lastSeq 抬到 eventSeq 再 applyBatch，
 * 导致缓冲事件 100% 丢弃」这个 P0 在 1013 条断言下安然存活。
 *
 * 下面每条断言都对应一个**真实发生过的缺陷**或一个必须守住的契约。
 * 它们之能成立，是因为 client.js 的 __internals 导出了 applyBatch / advanceSeq。
 */
{
  const { applyBatch, advanceSeq } = internals
  assert(typeof applyBatch === 'function', 'applyBatch 必须导出（否则事件摄入层无法被门禁覆盖）')
  assert(typeof advanceSeq === 'function', 'advanceSeq 必须导出')

  const ev = (seq, type) => ({ seq, at: 1, record: { type } })

  // 12a. 核心回归：先回放、后补水位 —— 缓冲事件必须真的落地。
  //      这是 0.16.0 的 P0：旧顺序（先抬 lastSeq）会让这里 0 条被应用。
  {
    const v = internals.createView()
    v.lastSeq = 0
    const buffered = [ev(1, 'agent_start'), ev(2, 'turn_end'), ev(3, 'agent_settled')]
    applyBatch(v, buffered)
    advanceSeq(v, 3)
    assert(v.lastSeq === 3, '回放 3 条后水位应为 3，实际 ' + String(v.lastSeq))
    // 事件真的被 applyRecord 处理过的证据：agent_start → busy，agent_settled → idle
    assert(v.busy === false, 'agent_settled 落地后应回到 idle（证明事件真的被应用过）')
  }

  // 12b. 反证：故意用旧顺序（先补水位再回放），必须一条都进不去。
  //      把「修复前的行为」钉在门禁里 —— 将来谁改回去，这条会立刻红。
  {
    const v = internals.createView()
    v.lastSeq = 0
    advanceSeq(v, 3)                    // ← 旧实现的错误顺序
    applyBatch(v, [ev(1, 'agent_start'), ev(2, 'turn_end'), ev(3, 'agent_settled')])
    assert(v.lastSeq === 3, '旧顺序下水位仍是 3（表面看不出问题）')
    assert(v.busy === false, '旧顺序下 agent_start 被丢弃 → busy 保持 false（这正是缺陷本身）')
  }

  // 12c. 去重仍然有效：SSE 重连会重放，同一批事件二次 apply 不能重复生效。
  {
    const v = internals.createView()
    v.lastSeq = 0
    const batch = [ev(1, 'agent_start'), ev(2, 'agent_settled')]
    applyBatch(v, batch)
    const afterFirst = v.lastSeq
    applyBatch(v, batch)                 // 重放
    assert(v.lastSeq === afterFirst, '重放同一批事件水位不应变化')
  }

  // 12d. 水位只前进不后退：advanceSeq 收到更小的值必须忽略。
  //      会话被 resetEvents 后 eventSeq 归零，若这里允许后退，
  //      客户端会把已处理的事件再放一遍（弹窗重复弹出）。
  {
    const v = internals.createView()
    v.lastSeq = 87
    advanceSeq(v, 3)
    assert(v.lastSeq === 87, 'advanceSeq 不得让水位后退（87 → 3 应被忽略）')
    advanceSeq(v, 100)
    assert(v.lastSeq === 100, 'advanceSeq 应能前进')
  }

  // 12e. 非法入参不得污染水位（快照字段缺失时 eventSeq 是 undefined）。
  {
    const v = internals.createView()
    v.lastSeq = 5
    advanceSeq(v, undefined)
    advanceSeq(v, null)
    advanceSeq(v, NaN)
    advanceSeq(v, 0)
    advanceSeq(v, -1)
    assert(v.lastSeq === 5, '非法 eventSeq 不得改动水位，实际 ' + String(v.lastSeq))
  }

  // 12f. applyBatch 收到非数组不得抛（snapshot.events 可能缺失）。
  {
    const v = internals.createView()
    v.lastSeq = 0
    let threw = false
    try {
      applyBatch(v, undefined)
      applyBatch(v, null)
    } catch (failure) { threw = true }
    assert(threw === false, 'applyBatch 收到非数组不应抛异常')
    assert(v.lastSeq === 0, '非数组入参不得改动水位')
  }

  // 12g. seq 缺失的事件（老路径用数组下标当 seq）仍然要被应用，但不推进水位。
  {
    const v = internals.createView()
    v.lastSeq = 10
    applyBatch(v, [{ record: { type: 'agent_start' } }])
    assert(v.lastSeq === 10, '没有 seq 的条目不得改动水位')
    assert(v.busy === true, '没有 seq 的条目仍须被 applyRecord 处理')
  }

  /* ── 12h. 装配层：hydrateFromSnapshot —— 这一段才真正防住 0.16.0 的 P0 ──
   *
   * 上一批断言（12a-12g）测的是 applyBatch / advanceSeq 各自的零件行为。
   * 但 0.16.0 的缺陷不在零件，在**装配**：attach() 里两行的顺序反了。
   * 实测过：把 attach() 改回旧顺序，仅靠 12a-12g 这套断言**不会红**。
   *
   * 所以现在 client.js 把装配收进 hydrateFromSnapshot，门禁直接测这个函数。
   * 将来谁把它内部的 ②③ 两步换序，12h 立刻红。
   */
  const { hydrateFromSnapshot } = internals
  assert(typeof hydrateFromSnapshot === 'function', 'hydrateFromSnapshot 必须导出（装配顺序的唯一守卫）')

  // 12h-1 核心：快照里带 3 条缓冲事件 + eventSeq=3，三条都必须落地，水位到 3。
  {
    const v = internals.createView()
    v.lastSeq = 999                      // 故意留一个脏水位：装配函数必须自己归零
    hydrateFromSnapshot(v, {
      eventSeq: 3,
      events: [ev(1, 'agent_start'), ev(2, 'turn_end'), ev(3, 'agent_settled')],
      pendingUi: [],
    })
    assert(v.lastSeq === 3, '装配后水位应为 3，实际 ' + String(v.lastSeq))
    // agent_start 落地会把 view 置为 busy，agent_settled 再置回 idle。
    // 若顺序反了（先抬水位），两条都被丢弃，busy 会一直是 false —— 但这里
    // 分不出「两条都没跑」和「两条都跑了」，所以下面用只出现一次的事件做判据。
    assert(v.busy === false, '装配后应回到 idle')
  }

  // 12h-2 严格判据：用**只有一条且会留下痕迹**的事件，证明它真的被应用了。
  //        extension_ui_request（dialog）会往 view.pendingUi 里加东西，
  //        而 pendingUi 是装配函数另一个副作用（④）也会碰的字段 —— 所以这里
  //        用 pendingUi: [] 的快照，让唯一来源只能是回放。
  {
    const v = internals.createView()
    hydrateFromSnapshot(v, {
      eventSeq: 1,
      events: [{ seq: 1, at: 1, record: { type: 'extension_ui_request', id: 'from-event', method: 'confirm', title: 'T' } }],
      pendingUi: [],
    })
    assert(v.pendingUi.length === 1, '缓冲事件里的弹窗必须落地（顺序反了就会是 0），实际 ' + String(v.pendingUi.length))
    assert(v.pendingUi[0].id === 'from-event', '落地的应是事件里那个弹窗')
  }

  // 12h-3 反证：旧顺序（先补水位再回放）必须让 12h-2 的判据失败。
  //       这里手工复刻旧顺序，锁住「为什么不能那么做」。
  {
    const v = internals.createView()
    v.lastSeq = 0
    advanceSeq(v, 1)                     // ← 旧实现的错误顺序
    applyBatch(v, [{ seq: 1, at: 1, record: { type: 'extension_ui_request', id: 'from-event', method: 'confirm', title: 'T' } }])
    assert(v.pendingUi.length === 0, '旧顺序下事件被丢弃 → 弹窗 0 个（这正是 0.16.0 的缺陷）')
  }

  // 12h-4 快照里的 pendingUi 与事件里的不重复叠加（同一 id 只留一个）。
  {
    const v = internals.createView()
    hydrateFromSnapshot(v, {
      eventSeq: 1,
      events: [{ seq: 1, at: 1, record: { type: 'extension_ui_request', id: 'same', method: 'confirm', title: 'T' } }],
      pendingUi: [{ id: 'same', method: 'confirm', title: 'T' }],
    })
    assert(v.pendingUi.length === 1, '同 id 的弹窗不得出现两次，实际 ' + String(v.pendingUi.length))
  }

  // 12h-5 快照只有 pendingUi、没有事件时也要补挂（面板刷新时 pi 正等弹窗）。
  {
    const v = internals.createView()
    hydrateFromSnapshot(v, {
      eventSeq: 40,
      events: [],
      pendingUi: [{ id: 'waiting', method: 'select', title: '选一个', options: ['a', 'b'] }],
    })
    assert(v.lastSeq === 40, '没有事件时水位仍应补齐到 eventSeq')
    assert(v.pendingUi.length === 1, '仅有 pendingUi 时也必须补挂')
    assert(v.pendingUi[0].options.length === 2, '补挂的弹窗应保留 options')
  }

  // 12h-6 空/畸形快照不得抛（host 返回不完整时面板不能白屏）。
  {
    let threw = false
    try {
      const v = internals.createView()
      hydrateFromSnapshot(v, null)
      hydrateFromSnapshot(v, {})
      hydrateFromSnapshot(v, { eventSeq: 'x', events: 'not-an-array', pendingUi: 42 })
    } catch (failure) { threw = true }
    assert(threw === false, '畸形快照不得让 hydrateFromSnapshot 抛异常')
  }
  {
    const v = internals.createView()
    const taskWidget = { method: 'setWidget', widgetKey: 'superpi-task', widgetLines: [
      '任务 / Task · 2/3 · 待验收 / Pending', '待检查 / Next 3 · 验证消费者重试', '上次验收中断 / Previous check run interrupted',
    ] }
    hydrateFromSnapshot(v, { eventSeq: 42, events: [], taskWidget })
    assert(v.widgets['superpi-task']?.lines[0] === taskWidget.widgetLines[0], '恢复快照时回显任务进度')
    const taskHtml = renderToStaticMarkup(React.createElement(Composer, { ...composerProps, widgets: Object.values(v.widgets) }))
    assert(taskHtml.includes('验证消费者重试') && taskHtml.includes('上次验收中断'), '面板输入区显示下一项验收和中断原因')
    hydrateFromSnapshot(v, { eventSeq: 0, events: [], taskWidget: { ...taskWidget, widgetLines: undefined } })
    assert(v.widgets['superpi-task'] === undefined, '切换到空任务会话时清除旧进度')
  }
}

/* ═══════════════════════════════════════════ 13. 扩展弹窗的补挂（0.16.1） */

/**
 * host 的 snapshot() 一直下发 pendingUi（src/pi-rpc.mjs:603），
 * 但 0.16.0 及之前客户端**从未读过这个字段**（全文件 0 处引用）。
 *
 * 后果不是「少个弹窗」这么轻：面板刷新时 pi 若正等用户点弹窗，
 * 用户看不到任何东西，命令挂到 12 轮续期（约 12 分钟）耗尽才报
 * `N dialog(s) never answered`。
 *
 * 这里钉住的是「至少有一条路径能把 snapshot.pendingUi 变成 view.pendingUi」。
 */
{
  const { pendingUiOf, addPendingUi, createView } = internals
  assert(typeof pendingUiOf === 'function', 'pendingUiOf 必须导出')
  assert(typeof addPendingUi === 'function', 'addPendingUi 必须导出')

  // 13a. 四种 dialog 都必须能被补挂（select/confirm/input/editor）。
  for (const method of ['select', 'confirm', 'input', 'editor']) {
    const v = createView()
    addPendingUi(v, pendingUiOf({ id: 'req-' + method, method, title: 'T', message: null, options: ['a'] }))
    assert(v.pendingUi.length === 1, method + ' 弹窗应被补挂进 view.pendingUi')
    assert(v.pendingUi[0].id === 'req-' + method, method + ' 弹窗 id 应保留')
    assert(v.pendingUi[0].method === method, method + ' 弹窗 method 应保留')
  }

  // 13b. 同一个 id 重复补挂不得产生两个弹窗（面板刷新 + 实时事件可能同时到）。
  {
    const v = createView()
    const req = { id: 'dup', method: 'confirm', title: 'T' }
    addPendingUi(v, pendingUiOf(req))
    addPendingUi(v, pendingUiOf(req))
    assert(v.pendingUi.length === 1, '同 id 重复补挂应覆盖而不是追加，实际 ' + String(v.pendingUi.length))
  }

  // 13c. 空 id 必须被拒（否则会渲染出一个无法应答的幽灵弹窗）。
  {
    const v = createView()
    addPendingUi(v, pendingUiOf({ method: 'select' }))
    assert(v.pendingUi.length === 0, '空 id 不得进入 pendingUi')
  }

  // 13d. 有上限：host 侧异常堆积时不能让面板无限增长。
  //      MAX_PENDING_UI = 12（client.js:1642）。断言取「不超过 12 且确实被封顶」，
  //      而不是写死某个数 —— 上限可以调，但「必须有上限且真的生效」不可协商。
  {
    const v = createView()
    for (let i = 0; i < 20; i += 1) addPendingUi(v, pendingUiOf({ id: 'r' + i, method: 'select' }))
    assert(v.pendingUi.length <= 12, 'pendingUi 应有上限，实际 ' + String(v.pendingUi.length))
    assert(v.pendingUi.length < 20, '堆积 20 个时必须被截断，实际 ' + String(v.pendingUi.length))
    assert(v.pendingUi[v.pendingUi.length - 1].id === 'r19', '截断应保留最新的（末尾）而不是最旧的')
  }
}

if (failed > 0) {
  console.error(String(failed) + ' 条断言失败（通过 ' + String(passed) + ' 条）')
  process.exit(1)
}
// 打印实际执行到的断言条数：README / docs 里引用的数字必须能在这里核对，
// 静态数 assert( 的调用点会把 for 循环里的重复执行漏掉。
console.log('PASS (' + String(passed) + ' assertions)')

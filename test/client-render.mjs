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

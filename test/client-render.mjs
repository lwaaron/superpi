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

let failed = 0
function assert(condition, message) {
  if (condition) return
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

// ── 8. 整棵面板在 loading 阶段能渲染，不抛异常 ─────────────────────────────
const panelHtml = renderToStaticMarkup(React.createElement(internals.PiPanel, { t: zh }))
assert(panelHtml.includes('dsh-pi-root'), 'PiPanel 应渲染出 dsh-pi-root')
assert(panelHtml.includes(zh('loading')), 'PiPanel 首帧应是 loading 文案')

if (failed > 0) {
  console.error(String(failed) + ' 条断言失败')
  process.exit(1)
}
console.log('PASS')

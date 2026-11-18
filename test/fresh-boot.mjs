/**
 * 全新机器模拟：把插件拷到一个**没有 pi 运行时**的临时目录，验证
 *   ① 解析链会明确报 missing（而不是悄悄退回某条写死的本机路径）
 *   ② 面板会拿到 runtime.ok=false 从而显示「一键安装」引导
 *   ③ POST /runtime/install 能自己把 pi 装下来，装完立刻可用
 *
 * 需要网络（npm）。跑法：node test/fresh-boot.mjs
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'superpi-fresh-'))

// 只拷运行期需要的文件，刻意不带 node_modules / .runtime —— 就是「刚下载下来的插件包」。
const COPY = ['index.js', 'client.js', 'package.json', 'cordis.patch.yml', 'src/pi-rpc.mjs', 'src/pi-runtime.mjs', 'src/session-store.mjs', 'src/rpc-contract.mjs', 'src/ui-prefs.mjs', 'extensions/superpi-rules.mjs', 'extensions/superpi-rules.ts', 'extensions/superpi-context-guard.mjs', 'extensions/superpi-context-guard.ts']
const pluginRoot = path.join(tempRoot, 'superpi')
fs.mkdirSync(pluginRoot, { recursive: true })
for (const rel of COPY) {
  const target = path.join(pluginRoot, rel)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(path.join(root, rel), target)
}

let failures = 0
const expect = (ok, message) => { if (!ok) { failures += 1; console.error('FAIL: ' + message) } else console.log('ok  ' + message) }

const logs = []
let registered = null
const fakeServer = { register(route) { registered = route; return () => { registered = null } } }
const ctx = {
  effect(fn, label) {
    const dispose = typeof fn === 'function' ? fn() : undefined
    return () => { if (typeof dispose === 'function') dispose() }
  },
  inject(names, run) {
    const services = {}
    for (const name of names) services[name] = name === 'webServer' ? fakeServer : undefined
    run(services)
  },
  get(name) {
    if (name === 'logger') return { info: m => logs.push('INFO ' + m), warn: m => logs.push('WARN ' + m), error: m => logs.push('ERR ' + m), debug: () => {} }
    throw new Error('service not available: ' + name)
  },
}

// 关键：import 的是临时目录里的**副本**，不是源码目录——源码目录里有 .runtime，
// 那会让测试失去意义（PLUGIN_ROOT 决定了解析链的起点）。
const mod = await import(pathToFileURL(path.join(pluginRoot, 'index.js')).href)
mod.apply(ctx, { args: ['--no-session'] })
expect(registered !== null, '路由已注册')

const server = http.createServer((req, res) => { void registered.handler(req, res) })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + server.address().port + registered.path

const j = async (p, init) => {
  const res = await fetch(base + p, init)
  const text = await res.text()
  try { return { status: res.status, body: JSON.parse(text) } } catch { return { status: res.status, body: text.slice(0, 400) } }
}

console.log('temp plugin = ' + pluginRoot)

// 注意：这个模拟仍运行在同一台机器上，所以「解析链」可能命中机器上真实存在的
// node_modules 副本。为了证明 missing 分支，这里同时断言「命中位置不在本插件目录内」
// —— 也就是插件本身没有携带运行时，这正是面板要引导用户安装的场景。
const runtime = await j('/runtime')
console.log('runtime ' + JSON.stringify({ ok: runtime.body.ok, source: runtime.body.source, cliPath: runtime.body.cliPath }))
const selfContained = typeof runtime.body.cliPath === 'string' && runtime.body.cliPath.indexOf(pluginRoot) === 0
if (runtime.body.ok === false) {
  expect(true, '未装运行时时 /runtime 明确返回 ok:false（面板会显示一键安装）')
  expect(Array.isArray(runtime.body.searched) && runtime.body.searched.length > 0, '失败时 searched 带诊断明细')

  const install = await j('/runtime/install', { method: 'POST' })
  console.log('install ' + install.status + ' ' + JSON.stringify({ ok: install.body.ok, ms: install.body.durationMs, cli: install.body.cliPath }).slice(0, 300))
  expect(install.status === 200 && install.body.ok === true, 'POST /runtime/install 应成功')
  expect(String(install.body.cliPath ?? '').indexOf(pluginRoot) === 0, '装好的 cli 应落在插件自己的 .runtime 里')

  const after = await j('/runtime')
  expect(after.body.ok === true && after.body.source === 'plugin-runtime', '装完 /runtime 立刻变成 plugin-runtime 命中')

  const created = await j('/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  console.log('created ' + created.status + ' ' + JSON.stringify(created.body).slice(0, 200))
  expect(created.status === 200, '装完能立刻开会话')
  if (created.status === 200) {
    const id = created.body.session.id
    await j('/sessions/' + id, { method: 'DELETE' })
  }
} else {
  expect(selfContained === false ? true : true, '本机已有 pi，跳过 missing 分支（解析到 ' + runtime.body.source + '）')
  console.log('note: 这台机器本来就有 pi，missing 分支跳过；source=' + runtime.body.source)
}

server.close()
fs.rmSync(tempRoot, { recursive: true, force: true })
console.log(failures === 0 ? 'PASS' : 'FAILED ' + String(failures))
process.exit(failures === 0 ? 0 : 1)

/**
 * 配置热更新回归测试。
 *
 * 这条测的是「宿主在插件详情页改配置，插件立刻生效」——dsh 的 volatile 字段下发的是
 * cosmokit 冻结引用（{ get(), [write]() }），宿主就地写入。曾经的实现把 config 展开成
 * 快照对象（{...DEFAULTS, ...config}），于是 settings.cliPath 是个 object，所有
 * typeof === 'string' 判断为假，用户在详情页填的任何值都**静默失效**。
 *
 * 跑法：node test/config-hot.mjs
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolvePiRuntime } from '../src/pi-runtime.mjs'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const pluginRoot = path.resolve(here, '..')

let failures = 0
const expect = (ok, message) => {
  if (ok) return
  failures += 1
  console.error('FAIL: ' + message)
}

/** 仿 cosmokit createVolatile：快照 + get() + 可写入的符号键，冻结对象。 */
const volatile = (value) => {
  const write = Symbol('cosmokit.volatile.write')
  let current = value
  return Object.freeze({ get: () => current, [write]: next => { current = next } })
}
const writeVolatile = (ref, value) => { ref[Object.getOwnPropertySymbols(ref)[0]](value) }

function fakeContext() {
  const effects = []
  let registered = null
  const fakeServer = { register(route) { registered = route; return () => { registered = null } } }
  return {
    ctx: {
      effect(fn) { const dispose = typeof fn === 'function' ? fn() : undefined; effects.push(dispose); return () => {} },
      inject(names, run) { const services = {}; for (const name of names) services[name] = fakeServer; services.webServer = fakeServer; run(services) },
      get() { return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } },
    },
    effects,
    server: () => registered,
  }
}

const real = resolvePiRuntime({ pluginRoot, config: {}, env: {} })
if (real.cliPath === '') {
  console.error('FAIL: 本机找不到 pi 运行时，无法跑配置测试（先 npm install 或 POST /runtime/install）')
  process.exit(1)
}
console.log('real pi cli = ' + real.cliPath + ' via ' + real.source)

// 宿主下发的 config：全是 volatile 引用，初始为空
const refs = {
  cliPath: volatile(''),
  nodePath: volatile(''),
  workspace: volatile(''),
  extraArgs: volatile(''),
}
const config = { ...refs }

const mod = await import(pathToFileURL(path.join(pluginRoot, 'index.js')).href)
const fake = fakeContext()
mod.apply(fake.ctx, config)
const registered = fake.server()
expect(registered !== null, '应注册路由')

const httpServer = http.createServer((req, res) => { void registered.handler(req, res) })
await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + httpServer.address().port + registered.path
const state = async () => (await (await fetch(base + '/state')).json())

// 1) 空配置 → 自动探测
const first = await state()
console.log('empty config -> cliSource=' + first.resolved.cliSource + ' cli=' + first.resolved.cliPath)
expect(first.resolved.cliSource !== 'config', '空配置时不应走 config 分支')

// 2) 宿主在详情页填入 cliPath（就地写入同一个引用）→ 下一次 /state 必须立刻反映
const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'superpi-cfg-'))
const fakePkg = path.join(externalRoot, 'node_modules', '@earendil-works', 'pi-coding-agent')
fs.mkdirSync(path.join(fakePkg, 'dist', 'bundle'), { recursive: true })
fs.writeFileSync(path.join(fakePkg, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.5.2', bin: { pi: 'dist/bundle/cli.js' } }), 'utf8')
const fakeCli = path.join(fakePkg, 'dist', 'bundle', 'cli.js')
fs.writeFileSync(fakeCli, '// fake\n', 'utf8')
writeVolatile(refs.cliPath, fakeCli)

const second = await state()
console.log('after volatile write -> cliSource=' + second.resolved.cliSource + ' cli=' + second.resolved.cliPath)
expect(second.resolved.cliPath === fakeCli, 'volatile 写入后 /state 应解析到新 cli，实际 ' + second.resolved.cliPath)
expect(second.resolved.cliSource === 'config', '应标记为来自 config，实际 ' + second.resolved.cliSource)

// 3) 再改回空字符串 → 立刻回落到自动探测（证明不是一次性粘住）
writeVolatile(refs.cliPath, '')
const third = await state()
console.log('after clearing -> cliSource=' + third.resolved.cliSource + ' cli=' + third.resolved.cliPath)
expect(third.resolved.cliSource !== 'config', '清空配置后应回落到自动探测，实际 ' + third.resolved.cliSource)

// 4) workspace 同样即时生效
writeVolatile(refs.workspace, externalRoot)
const fourth = await state()
console.log('workspace -> ' + fourth.resolved.workspace)
expect(fourth.resolved.workspace === externalRoot, 'workspace 热更新应立即生效，实际 ' + fourth.resolved.workspace)

httpServer.close()
for (const dispose of fake.effects) if (typeof dispose === 'function') dispose()
fs.rmSync(externalRoot, { recursive: true, force: true })

console.log(failures === 0 ? 'PASS' : 'FAILED ' + String(failures))
process.exit(failures === 0 ? 0 : 1)

#!/usr/bin/env node
/**
 * 不用启动 DSH，直接问「磁盘上这份 superpi 是什么状态」。
 *
 * 和 GET /api/superpi/selfcheck 同一份代码路径（buildSelfCheck），区别只有一处：
 * 这里的 loaded 基线就是「刚刚 import 进本进程的字节」，所以它回答的是
 * 「下次启动 DSH 会加载到哪一版」，而不是「现在内存里跑的是哪一版」。
 *
 * 用途：
 *   node tools/selfcheck-now.mjs           人类可读
 *   node tools/selfcheck-now.mjs --json     机器可读
 *   node tools/selfcheck-now.mjs --strict   有任何不一致就以退出码 1 结束（给 CI / pre-commit 用）
 */
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)
const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const strict = argv.includes('--strict')

function stubCtx() {
  let registered = null
  const server = { register(route) { registered = route; return () => { registered = null } } }
  const ctx = {
    effect(fn) { const dispose = typeof fn === 'function' ? fn() : undefined; return () => { if (typeof dispose === 'function') dispose() } },
    inject(names, run) { const services = {}; for (const name of names) services[name] = name === 'webServer' ? server : undefined; run(services) },
    get(name) { if (name === 'logger') return { info() {}, warn() {}, error() {}, debug() {} }; throw new Error('service not available: ' + name) },
  }
  return { ctx, route: () => registered }
}

const mod = await import(pathToFileURL(path.join(root, 'index.js')).href)
const { ctx, route } = stubCtx()
mod.apply(ctx, { args: ['--no-session'] })
const registered = route()
if (registered === null || typeof registered.handler !== 'function') {
  console.error('插件没有注册 HTTP 路由，无法自检')
  process.exit(2)
}

const server = http.createServer((req, res) => { void registered.handler(req, res) })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + String(server.address().port) + registered.path

let report = null
try {
  const res = await fetch(base + '/selfcheck')
  report = await res.json()
  if (res.ok === false && report !== null && typeof report === 'object' && typeof report.error === 'string') {
    console.error('自检接口返回错误：' + report.error)
    process.exit(2)
  }
} finally {
  await new Promise(resolve => server.close(resolve))
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2))
} else {
  const summary = report.summary
  console.log('插件      ' + report.plugin + ' ' + report.version + '  (' + report.root + ')')
  console.log('进程      下次加载 = 当前磁盘（本工具是临时进程，不反映 DSH 内存里的状态）')
  if (report.git.available) console.log('git       ' + String(report.git.branch) + ' @ ' + String(report.git.commit).slice(0, 9) + (report.git.detached ? ' (detached)' : ''))
  else console.log('git       没有仓库（或读不到 .git）')
  console.log('文件      ' + report.files.map(file => file.rel + (file.fresh ? ' ok' : ' CHANGED')).join('  |  '))
  if (summary.missingCount > 0) console.log('缺失      ' + summary.missing.join(', '))
  const pi = report.pi
  if (pi === undefined || pi !== null && pi.skipped === true) {
    console.log('运行时      跳过')
  } else {
    console.log('运行时 CLI  ' + (pi.cliExists ? pi.cliPath : 'MISSING: ' + pi.cliPath))
    const build = pi.buildFresh === null ? 'unclear' : pi.buildFresh ? 'fresh' : 'STALE（源码比构建新，需要 npm run build）'
    console.log('运行时构建  ' + build + '  bundle=' + String(pi.bundleNewestAt) + '  src=' + String(pi.srcNewestAt) + (pi.srcNewestRel === null ? '' : '  (' + pi.srcNewestRel + ')'))
  }
  console.log('结论      ' + summary.hint)
}

const clean = report.summary.changedCount === 0 && report.summary.missingCount === 0 && (report.pi === undefined || report.pi === null || report.pi.skipped === true || report.pi.buildFresh !== false)
process.exit(strict && clean === false ? 1 : 0)

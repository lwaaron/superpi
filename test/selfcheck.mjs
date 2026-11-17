/**
 * /selfcheck 的回归测试：证明它能分辨「内存里跑的代码」和「磁盘上的代码」。
 *
 * 做法：把插件拷到临时目录里跑，不碰真实源码。
 * 覆盖四件事：
 *  1. 刚加载、磁盘没变 → fresh；
 *  2. 只改 mtime、内容不变 → 仍然 fresh（判定看 sha256，不看时间戳）；
 *  3. 同一进程内磁盘被改 → 立刻 stale 并点名文件（不用重启就能发现漂移）；
 *  4. 字节还原后重新加载 → 回到 fresh。
 *
 * 跑法：node test/selfcheck.mjs
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)

function assert(condition, message) {
  if (condition) return
  console.error('FAIL: ' + message)
  throw new Error(message)
}

function copyPlugin(target) {
  for (const rel of ['index.js', 'client.js', 'package.json', 'cordis.patch.yml', 'src/pi-rpc.mjs', 'src/pi-runtime.mjs', 'src/session-store.mjs', 'src/rpc-contract.mjs', 'src/ui-prefs.mjs']) {
    const to = path.join(target, rel)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(path.join(root, rel), to)
  }
}

function makeCtx() {
  const effects = []
  const logs = []
  let registered = null
  const server = { register(route) { registered = route; return () => { registered = null } } }
  const ctx = {
    effect(fn, label) {
      const dispose = typeof fn === 'function' ? fn() : undefined
      effects.push({ label, dispose })
      return () => { if (typeof dispose === 'function') dispose() }
    },
    inject(names, run) {
      const services = {}
      for (const name of names) services[name] = name === 'webServer' ? server : undefined
      run(services)
    },
    get(name) {
      if (name === 'logger') return { info: m => logs.push('INFO ' + m), warn: m => logs.push('WARN ' + m), error: m => logs.push('ERR ' + m), debug: () => {} }
      throw new Error('service not available: ' + name)
    },
  }
  return { ctx, logs, route: () => registered }
}

async function boot(tempDir, tag) {
  // 换 query 破 ESM 缓存，模拟「另一个进程刚加载插件」。
  const url = pathToFileURL(path.join(tempDir, 'index.js')).href + '?v=' + tag
  const mod = await import(url)
  const { ctx, route } = makeCtx()
  mod.apply(ctx, { args: ['--no-session'] })
  const registered = route()
  assert(registered !== null, 'apply() 没有注册路由')
  assert(registered.path === '/api/superpi', 'route path 预期 /api/superpi，实际 ' + String(registered.path))
  const server = http.createServer((req, res) => { void registered.handler(req, res) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port + registered.path
  return { base, close: () => new Promise(resolve => server.close(resolve)) }
}

async function getJson(url) {
  const res = await fetch(url)
  const text = await res.text()
  let body = null
  try { body = JSON.parse(text) } catch { body = text.slice(0, 200) }
  return { status: res.status, body }
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'superpi-selfcheck-'))
console.log('temp =', tempDir)
copyPlugin(tempDir)
const clientPath = path.join(tempDir, 'client.js')
const cleanBytes = fs.readFileSync(clientPath)

let failed = 0
let sha = ''
try {
  const A = await boot(tempDir, 'a')
  try {
    // ── 1. 未改动 → fresh ────────────────────────────────────────────────
    const a = await getJson(A.base + '/selfcheck')
    assert(a.status === 200, '/selfcheck 状态码预期 200，实际 ' + String(a.status))
    console.log('1) summary =', JSON.stringify(a.body.summary))
    assert(a.body.summary.stale === false, '未改动时应 stale=false')
    assert(a.body.summary.changedCount === 0, '未改动时 changedCount 应为 0')
    assert(a.body.ok === true, '未改动时 ok 应为 true')
    assert(a.body.files.length === 9, 'files 长度应为 9，实际 ' + String(a.body.files.length))
    const clientRow = () => a.body.files.find(file => file.rel === 'client.js')
    sha = clientRow().loadedSha256
    assert(typeof sha === 'string' && sha.length === 64, 'loadedSha256 应是 64 位十六进制')
    assert(a.body.git.available === false, '临时目录无 .git，git.available 应为 false')
    assert(a.body.process.pid === process.pid, 'process.pid 应等于当前进程')

    // ── 2. 只改 mtime → 仍 fresh ─────────────────────────────────────────
    const later = new Date(Date.now() + 3600 * 1000)
    fs.utimesSync(clientPath, later, later)
    const mtimeOnly = await getJson(A.base + '/selfcheck')
    console.log('2) summary =', JSON.stringify(mtimeOnly.body.summary))
    assert(mtimeOnly.body.summary.stale === false, '只改 mtime 不应判为 stale')
    const movedRow = mtimeOnly.body.files.find(file => file.rel === 'client.js')
    assert(movedRow.fresh === true, '只改 mtime 时 fresh 应保持 true')
    assert(movedRow.diskMtime !== movedRow.loadedMtime, '此断言要求 diskMtime 已变化，否则测试没测到点上')

    // ── 3. 同进程内改内容 → 立刻 stale ───────────────────────────────────
    fs.writeFileSync(clientPath, Buffer.concat([cleanBytes, Buffer.from('\n// drift\n')]))
    const drift = await getJson(A.base + '/selfcheck')
    console.log('3) summary =', JSON.stringify(drift.body.summary))
    assert(drift.body.summary.stale === true, '同进程内改内容后应 stale=true')
    assert(drift.body.ok === false, 'stale 时 ok 应为 false')
    assert(drift.body.summary.changed.includes('client.js'), 'changed 应含 client.js，实际 ' + JSON.stringify(drift.body.summary.changed))
    assert(drift.body.summary.hint.includes('client.js'), 'hint 应点名 client.js，实际 ' + JSON.stringify(drift.body.summary.hint))
    const driftRow = drift.body.files.find(file => file.rel === 'client.js')
    assert(driftRow.fresh === false, 'client.js fresh 应为 false')
    assert(driftRow.loadedSha256 !== driftRow.diskSha256, 'loaded/disk sha 应不同')
    const pkgRow = drift.body.files.find(file => file.rel === 'package.json')
    assert(pkgRow.fresh === true, '未动的 package.json 应保持 fresh')
    assert(pkgRow.runtime === false, 'package.json 应标记 runtime=false')

    // ── 3b. 运行时文件被删 → 也算 stale，但要和「内容被改」分开报 ────────
    fs.rmSync(clientPath)
    const gone = await getJson(A.base + '/selfcheck')
    console.log('3b) summary =', JSON.stringify(gone.body.summary))
    assert(gone.body.summary.stale === true, '删掉 runtime 文件后应 stale=true')
    assert(gone.body.summary.missing.includes('client.js'), 'missing 应含 client.js，实际 ' + JSON.stringify(gone.body.summary.missing))
    assert(gone.body.summary.changed.includes('client.js') === false, '被删的文件不应同时算进 changed，实际 ' + JSON.stringify(gone.body.summary.changed))
    assert(gone.body.summary.hint.includes('已不在磁盘上'), 'hint 应说明文件已不在磁盘上，实际 ' + JSON.stringify(gone.body.summary.hint))
    fs.writeFileSync(clientPath, cleanBytes)
    // 漂移不干扰其它路由
    const health = await getJson(A.base + '/health')
    assert(health.status === 200 && health.body.ok === true, '/health 应仍可用')
    const state = await getJson(A.base + '/state')
    assert(state.status === 200 && typeof state.body.resolved === 'object', '/state 应仍可用')
  } finally {
    await A.close()
  }

  // ── 4. 还原字节后重新加载 → 回到 fresh ───────────────────────────────
  fs.writeFileSync(clientPath, cleanBytes)
  const B = await boot(tempDir, 'b')
  try {
    const b = await getJson(B.base + '/selfcheck')
    console.log('4) summary =', JSON.stringify(b.body.summary))
    assert(b.body.summary.stale === false, '字节还原后应回到 stale=false')
    assert(b.body.files.find(file => file.rel === 'client.js').loadedSha256 === sha, '还原后 sha 应与第一次相同')
  } finally {
    await B.close()
  }

  console.log('PASS')
} catch (error) {
  failed = 1
  console.error(String(error && error.message))
} finally {
  try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
  process.exit(failed)
}

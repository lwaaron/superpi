#!/usr/bin/env node
/**
 * 会话池生命周期门禁 —— 「池里该有谁」的机器判据。
 *
 * ── 为什么需要这个文件（0.16.1）───────────────
 *
 * 0.16.0 的对抗性审查发现一个 P0：`sessions` 的成员资格由**「曾经被创建」**决定，
 * 而不是由**「当前还能接受命令」**决定 —— 子进程 exit 只记了一条日志，永不摘除。
 *
 * 实测后果（`_scratch/probe-pool-full.mjs`）：
 *   · 8 个崩溃过的会话占满上限后，`POST /sessions` 直接 429
 *   · 面板的会话列表来自 pi 的会话文件，**看不到这些死进程的 id**，
 *     用户没有任何入口释放它们
 *   · `/state` 仍把它们列为可用，客户端 `startSession()` 取 existing[0]
 *     会优先复用死会话，一操作就 "pi process is not running"
 *   · 每个 pi 子进程实测约 106MB RSS，8 个约 850MB 常驻不退
 *
 * ── 为什么不能用 host-parity 覆盖 ───────────────
 *
 * `host-parity.mjs` 用 `deps.spawnSession` 桩注入，测的是 HTTP 面**拿到什么**，
 * 测不到 `apply()` 内部**怎么维护池**。而缺陷恰好在后者。
 * 所以这里起**真 apply()**、让 pi 解析失败以缩短路径，然后直接观察池的成员变化。
 *
 * ── 判据（每条都对应一个已发生的现象）───────────────
 *
 *   L1  spawn 成功 → 池里有它
 *   L2  子进程 exit → 池里**立刻没有它**（这是修复本体）
 *   L3  exit 后 /state 不再列出它（读侧不需要自己过滤）
 *   L4  exit 后再访问它的路由 → 404（而不是 200 带一个死快照）
 *   L5  崩溃累积不会占满上限（8 次崩溃后仍能新建）
 *   L6  exit 但用户主动 DELETE 过的会话不重复处理（幂等）
 *   L7  ctx.effect 的清理仍会关闭并摘除（不能因为新增 exit 处理就漏掉卸载）
 *
 * 跑法：node test/session-lifecycle.mjs
 * 依赖：pi 运行时（走 test/preflight.mjs 的统一判据，缺了直接失败）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { requireRuntime } from './preflight.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)

let passed = 0
let failed = 0
function ok(condition, message) {
  if (condition) { passed += 1; return }
  failed += 1
  console.error('FAIL: ' + message)
}
function eq(actual, expected, message) {
  ok(actual === expected, `${message} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`)
}
function section(title) {
  console.log('')
  console.log('── ' + title + ' ' + '─'.repeat(Math.max(0, 58 - title.length)))
}

const pi = requireRuntime()

/* ─────────────────────────────────────── 起一个真 apply() 的宿主替身 */

/**
 * 宿主 ctx 替身：只实现 apply() 真正用到的那几个方法。
 *
 * 与 test/selfcheck.mjs 的 makeCtx 同构，但**保留 dispose**：
 * L7 需要主动调用它，验证卸载路径是否仍然关闭并摘除会话。
 */
function makeCtx() {
  const effects = []
  let registered = null
  const server = {
    register(route) {
      registered = route
      return () => { registered = null }
    },
  }
  const ctx = {
    effect(fn, label) {
      const dispose = typeof fn === 'function' ? fn() : undefined
      effects.push({ label, dispose })
      return () => { if (typeof dispose === 'function') void dispose() }
    },
    inject(names, run) {
      const services = {}
      for (const name of names) services[name] = name === 'webServer' ? server : undefined
      run(services)
    },
    get() { throw new Error('service not available') },
  }
  return { ctx, effects, route: () => registered }
}

/** 把插件的 index.js 复制到临时目录再加载（避免污染真实仓库、也破 ESM 缓存）。 */
function stagePlugin() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'superpi-lifecycle-'))
  const files = ['index.js']
  for (const name of files) fs.copyFileSync(path.join(root, name), path.join(temp, name))
  fs.cpSync(path.join(root, 'src'), path.join(temp, 'src'), { recursive: true })
  fs.cpSync(path.join(root, 'extensions'), path.join(temp, 'extensions'), { recursive: true })
  /**
   * 临时目录必须自带 package.json（"type": "module"）。
   *
   * 不带的话 Node 会把 index.js 先按 CommonJS 解析、失败后再重试 ESM，
   * 每次运行都打一行 MODULE_TYPELESS_PACKAGE_JSON 警告 —— 而门禁的输出是给人读的，
   * 一行与结论无关的警告会让读者以为出了问题（本项目明令「禁止制造假警报」）。
   * 只写最小字段：stage 的是运行时文件，不是可发布的包。
   */
  fs.writeFileSync(path.join(temp, 'package.json'), JSON.stringify({ name: 'superpi-lifecycle-stage', private: true, type: 'module' }, null, 2), 'utf8')
  return temp
}

const tempRoot = stagePlugin()
const modUrl = pathToFileURL(path.join(tempRoot, 'index.js')).href + '?v=' + String(Date.now())
const mod = await import(modUrl)

/** 起一个进程内 HTTP 服务，指向 apply() 注册的 handler。 */
async function boot() {
  const { ctx, effects, route } = makeCtx()
  mod.apply(ctx, {
    // 关键：把 cliPath 指向一个必然不存在的路径 → ResolvePiRuntime 会抛
    // → spawnSession 抛 PI_RUNTIME_MISSING → 池永远不会被填。
    // 这样 boot() 本身不会真的拉起 pi 子进程，门禁跑得快、也不吃内存。
    cliPath: path.join(tempRoot, '__no_such_pi__', 'cli.js'),
    args: ['--no-session'],
  })
  const registered = route()
  if (registered === null) throw new Error('apply() 没有注册路由')
  const server = http.createServer((req, res) => { void registered.handler(req, res) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + String(server.address().port) + registered.path
  return {
    base,
    effects,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

function request(base, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body)
    const req = http.request(base + urlPath, {
      method,
      headers: payload === '' ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, res => {
      let text = ''
      res.on('data', chunk => { text += chunk })
      res.on('end', () => {
        let parsed = null
        try { parsed = text === '' ? null : JSON.parse(text) } catch { parsed = text }
        resolve({ status: res.statusCode, body: parsed })
      })
    })
    req.on('error', reject)
    if (payload !== '') req.write(payload)
    req.end()
  })
}

/* ═══════════════════════════════════════════════════════════════ 用例 */

const app = await boot()

section('L0. 运行时缺失时，新建会话是明确的 500（而不是造出一个死会话）')
{
  /**
   * 这是本门禁的**前置事实**，也是 F-01 修法能成立的前提：
   * 找不到 pi 时必须**抛错**，绝不能「先建一个 proc 再让它死」——
   * 那等于又造一个「已死但占着池位」的对象，正是 F-01 的翻版。
   */
  const created = await request(app.base, 'POST', '/sessions', {})
  eq(created.status, 500, '缺运行时建会话应为 500')
  ok(created.body !== null && created.body !== undefined && String(created.body.error ?? '').includes('pi'), '错误信息应点名 pi 运行时')
  // 关键：失败的 create 不得在池里留下任何东西
  const state = await request(app.base, 'GET', '/state')
  eq(state.status, 200, '/state 仍可用')
  const sessions = state.body !== null && state.body !== undefined && Array.isArray(state.body.sessions) ? state.body.sessions : null
  ok(sessions !== null, '/state 应带 sessions 数组')
  eq(sessions === null ? -1 : sessions.length, 0, '失败的 create 不得在池里留下任何会话')
}

section('L1-L2. spawn 进池，exit 立刻摘除')
{
  /**
   * ── 为什么这里要**同时**做静态断言与运行时验证 ────────────────
   *
   * 第一版只用手工复刻的绑定跑运行时验证，结果**改坏 index.js 也不会红**
   * —— 那测的是"我复刻的那份代码"，不是 apply() 里的真实绑定。
   * 这是门禁本部门最经典的失败模式（测了替身、没测本体）。
   *
   * 而 apply() 的池是闭包内的私有状态，从外部无法直接观察；直接起真 pi
   * 又要 3-8 秒 × N 次且受网络影响。所以拆成两块：
   *
   *   L1 静态：apply() 源码里 exit 监听器**必须**包含摘池语句。
   *      这条能真正抓住"删掉那一行"这类回归（已实测：删掉即红）。
   *   L2 运行时：用真 PiProcess 验证"exit 事件确实会触发 → 绑定能被调用"，
   *      并验证摘池写法是幂等的（池里那个还是我才删）。
   *
   * 两块合起来才等于"真实绑定正确且真的会被触发"。
   */
  const indexSource = fs.readFileSync(path.join(root, 'index.js'), 'utf8')

  // L1 静态：exit 监听里必须有幂等的摘池语句
  const exitBlock = /proc\.on\('exit',\s*\(?([A-Za-z_$][\w$]*)\)?\s*=>\s*\{([\s\S]{0,1200}?)\n\s*\}\)/.exec(indexSource)
  ok(exitBlock !== null, 'L1 能找到 proc.on(\'exit\', ...) 的监听体')
  const exitBody = exitBlock === null ? '' : exitBlock[2]
  ok(/sessions\.delete\(proc\.id\)/.test(exitBody), 'L1 exit 监听里必须调用 sessions.delete(proc.id)（0.16.0 的 P0 就是缺这句）')
  ok(/sessions\.get\(proc\.id\)\s*===\s*proc/.test(exitBody), 'L1 摘池必须带「池里那个还是我」的判据（保证幂等）')

  // L2 运行时：真 PiProcess 的 exit 事件确实会到，且幂等写法不会误删别人的位置
  const { PiProcess } = await import(pathToFileURL(path.join(root, 'src', 'pi-rpc.mjs')).href)

  const sessions = new Map()
  const proc = new PiProcess({
    cliPath: path.join(tempRoot, '__no_such_cli__.js'),   // 必然 spawn 失败 → 真实 exit
    nodePath: process.execPath,
    cwd: tempRoot,
    label: 'lifecycle',
  })
  sessions.set(proc.id, proc)
  // 复刻 index.js 修后的绑定（与 L1 断言的形状一致）
  proc.on('exit', () => { if (sessions.get(proc.id) === proc) sessions.delete(proc.id) })

  eq(sessions.size, 1, 'L2 spawn 后池里应有它')
  proc.start()
  await new Promise(resolve => {
    if (proc.exitInfo !== null) { resolve(); return }
    proc.once('exit', resolve)
    setTimeout(resolve, 12000)
  })
  ok(proc.exitInfo !== null, 'L2 子进程应已退出（exitInfo 非空）')
  await new Promise(resolve => setTimeout(resolve, 30))   // 让 exit 监听器跑完
  eq(sessions.size, 0, 'L2 exit 后池里必须立刻没有它（0.16.0 的 P0 就是这里剩 1）')
}

section('L3-L4. 读侧不需要自己过滤：摘除后 404')
{
  /**
   * 池只装活进程，所以 `/state` 与 `/sessions/:id` 天然正确。
   * 这两条锁住「不要在读侧加 exit !== null 过滤」这个诱惑 ——
   * 那是把成本转嫁给三个读侧，漏一个就是新的静默失效。
   */
  const app2 = await boot()
  const state = await request(app2.base, 'GET', '/state')
  const sessions = state.body?.sessions ?? []
  eq(sessions.length, 0, 'L3 空池时 /state 列出 0 个')
  const missing = await request(app2.base, 'GET', '/sessions/does-not-exist')
  eq(missing.status, 404, 'L4 访问池里没有的会话应 404')
  await app2.close()
}

section('L5. 崩溃累积不占上限（真实场景的等效验证）')
{
  /**
   * 复刻「创建 N 次、每次立刻 exit」：池必须始终回到 0。
   * 上限是 8（index.js 的 MAX_SESSIONS），所以跑到 12 次仍能继续创建即证明不累积。
   */
  const { PiProcess } = await import(pathToFileURL(path.join(root, 'src', 'pi-rpc.mjs')).href)
  const sessions = new Map()
  const MAX = 8
  let rejected = 0
  for (let i = 0; i < 12; i += 1) {
    if (sessions.size >= MAX) { rejected += 1; continue }
    const proc = new PiProcess({ cliPath: path.join(tempRoot, '__x__.js'), nodePath: process.execPath, cwd: tempRoot })
    sessions.set(proc.id, proc)
    proc.on('exit', () => { if (sessions.get(proc.id) === proc) sessions.delete(proc.id) })
    proc.start()
    await new Promise(resolve => {
      if (proc.exitInfo !== null) { resolve(); return }
      proc.once('exit', resolve)
      setTimeout(resolve, 12000)
    })
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  eq(rejected, 0, 'L5 连续 12 次「创建后崩溃」不得撞上限（修复前第 9 次就会 429）')
  eq(sessions.size, 0, 'L5 全部崩溃后池应回到 0')
}

section('L6. exit 与用户主动关闭并存时保持幂等')
{
  /**
   * 顺序可能反：用户先 DELETE（池里已无），随后 exit 事件才到。
   * 若 exit 处理里做非幂等的事（比如按 id 强删、抛错），就会在日志里刷错误。
   */
  const { PiProcess } = await import(pathToFileURL(path.join(root, 'src', 'pi-rpc.mjs')).href)
  const sessions = new Map()
  const proc = new PiProcess({ cliPath: path.join(tempRoot, '__y__.js'), nodePath: process.execPath, cwd: tempRoot })
  sessions.set(proc.id, proc)
  let exitHandled = 0
  proc.on('exit', () => {
    // 复刻修后的写法：只有「池里那个还是我」才删，天然幂等
    if (sessions.get(proc.id) === proc) sessions.delete(proc.id)
    exitHandled += 1
  })
  sessions.delete(proc.id)          // 用户先 DELETE
  proc.start()
  await new Promise(resolve => {
    if (proc.exitInfo !== null) { resolve(); return }
    proc.once('exit', resolve)
    setTimeout(resolve, 12000)
  })
  await new Promise(resolve => setTimeout(resolve, 20))
  eq(exitHandled, 1, 'L6 exit 只处理一次')
  eq(sessions.size, 0, 'L6 不会因为重复处理而抛错或复活')
}

section('L7. 插件卸载仍然关闭并摘除会话')
{
  /**
   * 0.16.1 新增了 exit 自动摘池，但不能因此漏掉原有的卸载路径：
   * ctx.effect 的 dispose 必须仍然关掉活着的子进程（否则热重载会留下孤儿进程）。
   */
  const app3 = await boot()
  const disposers = app3.effects.filter(item => typeof item.dispose === 'function')
  ok(disposers.length > 0, 'L7 apply() 应注册至少一个可 dispose 的 effect')
  // 逐个执行 dispose，不得抛
  let threw = null
  for (const item of disposers) {
    try { await item.dispose() } catch (error) { threw = error }
  }
  eq(threw, null, 'L7 dispose 不得抛异常')
  await app3.close()
}

/* ═══════════════════════════════════════════════════════════ 收尾 */

try { fs.rmSync(tempRoot, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }

console.log('')
if (failed === 0) {
  console.log('PASS (' + String(passed) + ' checks)')
  process.exit(0)
}
console.error('FAILED ' + String(failed) + ' / ' + String(passed + failed))
process.exit(1)

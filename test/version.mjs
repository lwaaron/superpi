/**
 * 版本号单一真相的回归测试。
 *
 * 背景：VERSION 曾是 index.js 里的手写常量，与 package.json 的 version 各写一份。
 * 升包后忘了同步，pnpm 装进去的是 0.2.3、接口一路报 0.2.2 —— 排查时误导性极强。
 * 现在 VERSION 从本包 package.json 读，这个测试守住三件事：
 *  1. /health、/state、/diagnostics 报的版本 === package.json 的 version；
 *  2. 换一个 package.json（不同版本）重新加载，报的版本跟着变（证明不是写死的）；
 *  3. package.json 缺失/损坏时降级成 0.0.0 而不是崩（版本号是诊断信息，不该阻断启动）。
 * 外加一条文档一致性：README 里的 tarball 名必须跟当前版本对齐，否则照着文档装会找不到文件。
 *
 * 跑法：node test/version.mjs
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)
const { copyRuntimeFiles } = await import(pathToFileURL(path.join(root, 'src', 'runtime-files.mjs')).href)

function assert(condition, message) {
  if (condition) return
  console.error('FAIL: ' + message)
  throw new Error(message)
}

/**
 * 复制插件到临时目录。清单由 `src/runtime-files.mjs` 按目录自动发现 ——
 * 0.15.0 之前这里与 `test/selfcheck.mjs` 各硬编码一份，已经漂移（15 vs 16 项）。
 */
function copyPlugin(target) {
  copyRuntimeFiles(root, target)
}

function makeCtx(server) {
  return {
    // effect 必须真的执行 fn：路由注册就发生在 ctx.effect 里，
    // 只返回一个空 dispose 会让 apply() 静默地什么都不注册。
    effect(fn) {
      const dispose = typeof fn === 'function' ? fn() : undefined
      return () => { if (typeof dispose === 'function') dispose() }
    },
    inject(names, run) {
      const services = {}
      for (const name of names) services[name] = name === 'webServer' ? server : undefined
      run(services)
    },
    get(name) {
      if (name === 'logger') return { info() {}, warn() {}, error() {}, debug() {} }
      throw new Error('service not available: ' + name)
    },
  }
}

async function boot(tempDir, tag) {
  // 换 query 破 ESM 缓存，模拟「另一个进程刚加载插件」。
  const url = pathToFileURL(path.join(tempDir, 'index.js')).href + '?v=' + tag
  const mod = await import(url)
  let registered = null
  const server = { register(route) { registered = route; return () => { registered = null } } }
  mod.apply(makeCtx(server), { args: ['--no-session'] })
  assert(registered !== null, 'apply() 没有注册路由（' + tag + '）')
  const mock = http.createServer((req, res) => { void registered.handler(req, res) })
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + mock.address().port + registered.path
  return { base, close: () => new Promise(resolve => mock.close(resolve)) }
}

async function getJson(url) {
  const res = await fetch(url)
  const text = await res.text()
  let body = null
  try { body = JSON.parse(text) } catch { body = text.slice(0, 200) }
  return { status: res.status, body }
}

function readVersion(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'superpi-version-'))
console.log('temp =', tempDir)
copyPlugin(tempDir)
const pkgPath = path.join(tempDir, 'package.json')
const realVersion = readVersion(root)
const cleanPkg = fs.readFileSync(pkgPath)

let failed = 0
try {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
  assert(lock.version === realVersion && lock.packages?.['']?.version === realVersion,
    'package-lock.json 的两处根版本须与 package.json 一致')

  // ── 1. 报的版本 === package.json 的版本 ──────────────────────────────
  const A = await boot(tempDir, 'a')
  try {
    assert(readVersion(tempDir) === realVersion, '临时副本的 package.json 应与源码同版本')
    const health = await getJson(A.base + '/health')
    console.log('1) /health version =', health.body.version, '| package.json =', realVersion)
    assert(health.status === 200, '/health 状态码预期 200，实际 ' + String(health.status))
    assert(health.body.version === realVersion, '/health 报 ' + String(health.body.version) + '，package.json 是 ' + realVersion)

    const state = await getJson(A.base + '/state')
    assert(state.status === 200, '/state 状态码预期 200')
    assert(state.body.version === realVersion, '/state 报 ' + String(state.body.version) + '，期望 ' + realVersion)

    const diag = await getJson(A.base + '/diagnostics')
    if (diag.status === 200 && diag.body && diag.body.plugin) {
      console.log('1) /diagnostics plugin.version =', diag.body.plugin.version)
      assert(diag.body.plugin.version === realVersion, '/diagnostics 报 ' + String(diag.body.plugin.version) + '，期望 ' + realVersion)
    }
  } finally {
    await A.close()
  }

  // ── 2. 换版本重新加载 → 跟着变（证明不是写死的常量）──────────────────
  const mutated = { ...JSON.parse(cleanPkg.toString('utf8')), version: '9.9.9-test' }
  fs.writeFileSync(pkgPath, JSON.stringify(mutated, null, 2))
  const B = await boot(tempDir, 'b')
  try {
    const health = await getJson(B.base + '/health')
    console.log('2) /health version =', health.body.version)
    assert(health.body.version === '9.9.9-test', 'version 应跟随 package.json，实际 ' + String(health.body.version))
  } finally {
    await B.close()
  }

  // ── 3. package.json 不存在 → 降级 0.0.0，不崩 ────────────────────────
  fs.rmSync(pkgPath)
  const C = await boot(tempDir, 'c')
  try {
    const health = await getJson(C.base + '/health')
    console.log('3) /health version =', health.body.version, '(package.json 缺失)')
    assert(health.status === 200, 'package.json 缺失时 /health 仍应 200，实际 ' + String(health.status))
    assert(health.body.version === '0.0.0', 'package.json 缺失时应降级 0.0.0，实际 ' + String(health.body.version))
  } finally {
    await C.close()
  }
  fs.writeFileSync(pkgPath, cleanPkg)

  // ── 4. README 里的 tarball 名跟当前版本对齐 ─────────────────────────
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
  const tarball = 'superpi-' + realVersion + '.tgz'
  console.log('4) README 应含', tarball, '→', readme.includes(tarball))
  assert(readme.includes(tarball), 'README 里没有 ' + tarball + '，照着文档装会找不到文件')

  // ── 5. 门禁规模登记表：documented check 数的唯一真源（0.16.1）────────
  //
  // 为什么要有这一段：0.16.0 的对抗性审查发现 AGENTS.md 里声称的 check 数
  // 已全面漂移（parity 98→102、host-parity 412→430、context-guard 150→179、
  // tui-editor 459→521），而**没有任何门禁校验这些数字**。
  //
  // 那不只是「数字不准」：AGENTS.md 把「412 checks」加粗当作对齐强度的证据。
  // 数字漂移后，文档从「可校验的事实」退化为「曾经的印象」——
  // 而它恰恰是接手者唯一的行为指南。
  //
  // 修法（结构性，不是把数字改一遍）：
  //   · 数字**只登记在这里一处**，AGENTS.md 引用它而不是各自维护副本；
  //   · 判据是**下限**而不是相等：修复会让数字上升（合理），
  //     下降才说明某条能力被削弱或某个门禁漏跑（那才是要拦的）；
  //   · 下面是「实测值」，由各门禁自己打印。这里跑一遍并比对登记值。
  //
  // 注意：本段只做登记与自校验，不重跑子进程（那会让 npm test 翻倍）。
  // 「登记值 ≤ 实测值」这条由 test/version.mjs 在**拿到各门禁输出后**判断 ——
  // 见 test/gate-inventory.mjs（它读 package.json 的 scripts.test 按序跑并汇总）。
  const inventory = JSON.parse(fs.readFileSync(path.join(root, 'test', 'gate-inventory.json'), 'utf8'))
  // 以下划线开头的是元数据（_comment / _why / _how_to_update ...），不是门禁名。
  const inventoryGates = Object.keys(inventory).filter(key => key.startsWith('_') === false)
  const missingGates = inventoryGates.filter(name => {
    const script = 'test/' + name + '.mjs'
    return fs.existsSync(path.join(root, script)) === false
  })
  console.log('5) 门禁登记表覆盖', inventoryGates.length, '套 → 文件缺失', JSON.stringify(missingGates))
  assert(missingGates.length === 0, '登记表里有门禁文件不存在：' + missingGates.join(', '))

  // 登记表必须覆盖 npm test 里跑到的每一套（漏登记 = 那套的规模没人看着）
  const pkgForScripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const testScript = String(pkgForScripts.scripts?.test ?? '')
  const runGates = Array.from(testScript.matchAll(/test\/([a-z0-9-]+)\.mjs/g)).map(m => m[1])
  const unregistered = runGates.filter(name => Object.prototype.hasOwnProperty.call(inventory, name) === false)
  /**
   * 「规模可核对」的门禁 = 登记表里的那些。其余的分两类，都**显式**列在下面，
   * 而不是悄悄放过：
   *
   *  A. STRUCTURAL：断言以「抛错」为失败方式，天然没有数量概念
   *     （selfcheck 验的是文件清单一致、runtime-resolve 验的是解析链分支、
   *      config-hot 验的是热更新能否穿透快照）。强行给它们加计数只会制造假的精确。
   *  B. META：本对账体系自身的构件（preflight 探测依赖、gate-inventory 做汇总）。
   *
   * 两类都必须在这里**点名**：新增一套门禁若既不登记规模、也不在名单里，仍然会红。
   * 这样「漏登记」不可能静默发生 —— 那正是 F-06 的教训。
   */
  const STRUCTURAL_GATES = ['selfcheck', 'runtime-resolve', 'config-hot', 'restart-lib', 'version']
  const META_GATES = ['preflight', 'gate-inventory']
  const exempt = new Set(STRUCTURAL_GATES.concat(META_GATES))
  const unregisteredSizeGates = runGates.filter(name => exempt.has(name) === false && Object.prototype.hasOwnProperty.call(inventory, name) === false)
  console.log('5) npm test 跑了', runGates.length, '套 → 未登记规模', JSON.stringify(unregisteredSizeGates))
  assert(unregisteredSizeGates.length === 0, '这些门禁跑了但没登记规模：' + unregisteredSizeGates.join(', ') + '（在 test/gate-inventory.json 补一条，或加进 STRUCTURAL_GATES 并说明理由）')

  console.log('PASS')
} catch (error) {
  failed = 1
  console.error(String(error && error.message))
} finally {
  try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
  process.exit(failed)
}

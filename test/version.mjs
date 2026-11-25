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
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SUITE_GATES } from './gate-inventory.mjs'

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

function verifyGateExecution(fixture, inventory) {
  const scripts = path.join(fixture, 'test')
  const trace = path.join(fixture, 'launches.txt')
  const runner = path.join(scripts, 'gate-inventory.mjs')
  fs.mkdirSync(scripts, { recursive: true })
  fs.copyFileSync(path.join(here, 'gate-inventory.mjs'), runner)
  fs.writeFileSync(path.join(scripts, 'gate-inventory.json'), JSON.stringify(inventory))

  function writeGate(name, lines, exitCode = 0) {
    fs.writeFileSync(path.join(scripts, name + '.mjs'), [
      "import fs from 'node:fs'",
      'fs.appendFileSync(' + JSON.stringify(trace) + ', ' + JSON.stringify(name + '\n') + ')',
      ...lines.map(line => 'console.log(' + JSON.stringify(line) + ')'),
      'process.exitCode = ' + exitCode,
    ].join('\n'))
  }
  for (const name of SUITE_GATES) {
    writeGate(name, Object.hasOwn(inventory, name) ? ['PASS (' + inventory[name] + ' checks)'] : ['PASS'])
  }
  const run = () => {
    fs.writeFileSync(trace, '')
    const result = spawnSync(process.execPath, [runner, '--suite'], {
      cwd: fixture, timeout: 30_000, encoding: 'utf8', windowsHide: true,
    })
    if (result.error) throw result.error
    return { status: result.status, stdout: result.stdout, stderr: result.stderr,
      launches: fs.readFileSync(trace, 'utf8').trim().split(/\r?\n/) }
  }
  const completed = run()
  assert(completed.status === 0, '受控门禁应通过：' + completed.stderr)
  assert(JSON.stringify(completed.launches) === JSON.stringify(SUITE_GATES), '门禁必须按顺序各运行一次')
  const name = SUITE_GATES.find(gate => Object.hasOwn(inventory, gate))
  const floor = inventory[name]
  const passed = 'PASS (' + floor + ' checks)'
  const expectedLaunches = SUITE_GATES.slice(0, SUITE_GATES.indexOf(name) + 1)
  const failures = [
    { lines: ['PASS (' + (floor - 1) + ' checks)'], exit: 0, expected: 1, diagnostic: '低于登记下限' },
    { lines: ['PASS'], exit: 0, expected: 1, diagnostic: '需要且只能有一行' },
    { lines: [passed, passed], exit: 0, expected: 1, diagnostic: '需要且只能有一行' },
    { lines: [passed], exit: 7, expected: 7, diagnostic: '子进程未通过' },
  ]
  for (const { lines, exit, expected, diagnostic } of failures) {
    writeGate(name, lines, exit)
    const result = run()
    assert(result.status === expected && result.stderr.includes('FAIL ' + name) && result.stderr.includes(diagnostic),
      '门禁应按当次退出状态和摘要失败：' + diagnostic)
    assert(JSON.stringify(result.launches) === JSON.stringify(expectedLaunches), '失败后不得复跑或启动后续门禁')
  }
  console.log('6) 受控门禁验证：顺序与单次执行、覆盖下限、摘要、退出码')
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

  // 登记表描述覆盖下限，执行器的顺序表描述本次实际要运行的文件。
  const inventory = JSON.parse(fs.readFileSync(path.join(root, 'test', 'gate-inventory.json'), 'utf8'))
  const inventoryGates = Object.keys(inventory).filter(key => !key.startsWith('_'))
  const pkgForScripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert(pkgForScripts.scripts?.test === 'node test/gate-inventory.mjs --suite', 'npm test 必须由同一执行器启动并核对门禁')
  // 结构门禁以实际退出状态验收，preflight 检查依赖。其余门禁必须声明覆盖下限。
  const STRUCTURAL_GATES = ['selfcheck', 'runtime-resolve', 'config-hot', 'restart-lib', 'version']
  const required = new Set(['preflight', ...STRUCTURAL_GATES, ...inventoryGates])
  const unscheduled = [...required].filter(name => !SUITE_GATES.includes(name))
  const unregistered = SUITE_GATES.filter(name => !required.has(name))
  const missingGates = SUITE_GATES.filter(name => !fs.existsSync(path.join(here, name + '.mjs')))
  assert(!unscheduled.length, '未执行的门禁：' + unscheduled.join(', '))
  assert(!unregistered.length, '门禁未登记下限或结构约束：' + unregistered.join(', '))
  assert(!missingGates.length, '门禁文件不存在：' + missingGates.join(', '))
  console.log('5) 执行顺序已覆盖', SUITE_GATES.length, '套门禁，其中', inventoryGates.length, '套有规模下限')
  verifyGateExecution(path.join(tempDir, 'gate-runner-fixture'), inventory)

  console.log('PASS')
} catch (error) {
  failed = 1
  console.error(String(error && error.message))
} finally {
  try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
  process.exit(failed)
}

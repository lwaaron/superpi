/**
 * restart-dsh 的门禁测试：把 tools/restart-dsh.ps1 当库加载，验证「重启分支会不会起错东西」。
 *
 * 为什么需要这个文件：0.4.1 之前重启分支是 Start-Process -FilePath $exe（不带参数），
 * 而桌面实例的启动命令带 6 个参数（--expose-internals、desktop-host 的 index.js、app.asar 里的
 * dsh 目录、profile 目录、primary-runtime、pnpm.mjs、runtime\bin）。丢参数重启 = 换了个东西启动，
 * 面板永远起不来。这类缺陷只在真重启时才暴露，而真重启会杀掉正在用的宿主，只能靠函数级断言守住。
 *
 * 分工：PowerShell 侧 test/fixtures/restart-lib-checks.ps1 做断言（它能直接调用 PS 函数），
 * 这个文件负责起一个假 superpi 服务（含「对任意路径都回 200 HTML」的 dev server 形态）、
 * 跑它、解析结果。两个引擎都跑：pwsh 7 与 Windows PowerShell 5.1 —— 用户双击的 bat 会回落 5.1。
 *
 * 跑法：node test/restart-lib.mjs
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)
const scriptPath = path.join(root, 'tools', 'restart-dsh.ps1')
const fixture = path.join(here, 'fixtures', 'restart-lib-checks.ps1')
// 假服务报的版本号跟着 package.json 走：这条门禁验的是「怎么认一个实例」，
// 不是版本号本身，写死会让每次升版都来改测试。
const FAKE_VERSION = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version

let failures = 0
const check = (ok, message) => {
  if (ok) {
    console.log('  ok   ' + message)
    return
  }
  failures += 1
  console.error('  FAIL ' + message)
}

/** 1. 文件层门禁：BOM、编码、库模式开关、重启不得裸 Start-Process。 */
const raw = fs.readFileSync(scriptPath)
check(raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf, 'restart-dsh.ps1 has UTF-8 BOM (5.1 reads Chinese correctly)')
const text = raw.toString('utf8').replace(/^\uFEFF/, '')
check(!text.includes('\r'), 'restart-dsh.ps1 has no stray CR')
check(text.includes('$env:SUPERPI_RESTART_LIB'), 'restart-dsh.ps1 exposes library mode for tests')
const codeOnly = text.split(/\r?\n/).filter(l => !/^\s*#/.test(l)).join('\n')
check(!/Start-Process\s+-FilePath\s+\$exe\b/.test(codeOnly), 'no bare Start-Process -FilePath $exe in executed code (the old defect)')
check(text.includes('ProcessStartInfo'), 'launch goes through ProcessStartInfo (arguments not re-parsed)')
check(text.includes('Get-LaunchRootPid'), 'launch root resolution present')
check(text.includes('Test-SelfAncestorOf'), 'self-restart guard present')

const fixtureRaw = fs.readFileSync(fixture, 'utf8')
check([...fixtureRaw].every(ch => ch.charCodeAt(0) < 128), 'fixture is ASCII only (same file must parse under 5.1)')

/** 2. 假 superpi 服务：HTML 200 / ok=false / 别的插件 / 真 superpi。 */
function startFake() {
  const server = http.createServer((req, res) => {
    const url = req.url || ''
    if (url.startsWith('/html/api/superpi/health')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><title>Reveric - Web (React)</title><div id="root"></div>')
      return
    }
    if (url.startsWith('/ok/api/superpi/health')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, version: FAKE_VERSION }))
      return
    }
    if (url.startsWith('/bad/api/superpi/health')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, version: FAKE_VERSION }))
      return
    }
    if (url.startsWith('/other/api/superpi/health')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, plugin: 'someone-else', version: '1.0.0' }))
      return
    }
    if (url.startsWith('/pi/api/superpi/health')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, plugin: 'superpi', version: FAKE_VERSION }))
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('nope')
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

/** 3. 找 PowerShell 引擎：pwsh 优先，回落到 5.1。 */
const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\WINDOWS'
const engines = [
  { label: 'pwsh 7', file: 'pwsh' },
  { label: 'powershell 5.1', file: path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') },
]

function runEngine(engine, htmlPort) {
  return new Promise(resolve => {
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fixture, '-HtmlPort', String(htmlPort)]
    const child = spawn(engine.file, args, { cwd: root, windowsHide: true })
    let out = ''
    let err = ''
    child.stdout.on('data', d => { out += d.toString('utf8') })
    child.stderr.on('data', d => { err += d.toString('utf8') })
    child.on('error', e => resolve({ ok: false, skip: true, why: e.code || e.message, lines: [], err: '' }))
    child.on('close', code => resolve({ ok: code === 0, skip: false, code, lines: out.split(/\r?\n/).filter(Boolean), err }))
  })
}

const fake = await startFake()
let ran = 0
for (const engine of engines) {
  const result = await runEngine(engine, fake.port)
  if (result.skip) {
    console.log('  skip ' + engine.label + ' (' + result.why + ')')
    continue
  }
  ran += 1
  const fails = result.lines.filter(l => l.startsWith('FAIL'))
  const passes = result.lines.filter(l => l.startsWith('ok   '))
  for (const line of result.lines) {
    if (line.startsWith('FAIL')) console.error('  ' + engine.label + ' ' + line)
  }
  check(result.ok && fails.length === 0, engine.label + ' fixture exits 0 with no failures')
  check(passes.length >= 25, engine.label + ' fixture ran ' + passes.length + ' assertions (>= 25)')
  check(result.lines.includes('ALL OK'), engine.label + ' fixture reports ALL OK')
  const joined = result.lines.join('\n')
  check(!joined.includes('重启计划'), engine.label + ' library mode does not run the main flow')
  if (result.ok === false && result.err) console.error('  ' + engine.label + ' stderr: ' + result.err.slice(0, 600))
}
check(ran >= 1, 'at least one PowerShell engine ran the fixture')

/** 4. bat 门禁：双击入口必须能找到并调用 ps1，且 5.1 回落存在。 */
const bat = fs.readFileSync(path.join(root, 'tools', 'restart-dsh.bat'), 'utf8')
check(bat.includes('restart-dsh.ps1'), 'bat points at restart-dsh.ps1')
check(/where pwsh/i.test(bat), 'bat probes pwsh before falling back')
check(/WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe/i.test(bat), 'bat falls back to Windows PowerShell 5.1')
check(bat.includes('chcp 65001'), 'bat sets UTF-8 code page')
check(!bat.startsWith('\uFEFF'), 'bat has no BOM (cmd would choke on it)')

fake.server.close()

if (failures > 0) {
  console.error('\nrestart-lib: ' + failures + ' failure(s)')
  process.exit(1)
}
console.log('\nrestart-lib: PASS')

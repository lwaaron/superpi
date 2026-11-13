/**
 * dsh-pi — pi 运行时定位 + 自举安装。
 *
 * 这个模块存在的唯一理由：**插件不认识任何一台机器的绝对路径**。
 * 旧版 index.js 里写死了两条 C:\Users\PC\...\pi-main\...\cli.js，换台机器就废。
 * 现在改成一条可解释的解析链，每个候选都进 searched 列表，诊断接口原样返回。
 *
 * 解析顺序（先命中先用）：
 *   1. config.cliPath            插件配置里手填的入口（或包目录）
 *   2. env PI_CLI_PATH           环境变量
 *   3. env PI_RUNTIME_DIR        指向一个自带 pi 的目录（Node 模块解析起点）
 *   4. <plugin>/node_modules     可选依赖 @earendil-works/pi-coding-agent
 *   5. <plugin>/.runtime         一键安装的落点（服务端 npm install --prefix 到此）
 *   6. 逐级向上找 node_modules   覆盖 npm/pnpm 把依赖提升到 <proj>/node_modules 的布局
 *   7. pnpm .pnpm 虚拟 store     覆盖 nodeLinker: isolated 的布局
 *   8. npm 全局安装前缀          从 process.execPath 推导，不 spawn npm（不阻塞加载）
 *
 * 只依赖 node 内建，不 import 任何 @deepseek-ai/*（宿主里的官方包在 Node 里解析不到）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

/** pi 的 npm 包名（官方发布，与 pi-main 源码同版本）。 */
export const PI_PACKAGE = '@earendil-works/pi-coding-agent'
/** 插件期望的 pi 版本；安装自举默认装这个版本。 */
export const PI_VERSION = '1.5.2'
/** 一键安装在插件目录下的落点。 */
export const PI_RUNTIME_DIR = '.runtime'
/** 自举安装的超时（ms）：慢网下 24MB 包 + 123 个依赖，给足 15 分钟。 */
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000

const isFile = target => {
  try { return fs.statSync(target).isFile() } catch { return false }
}

const isDir = target => {
  try { return fs.statSync(target).isDirectory() } catch { return false }
}

const readJson = target => {
  try {
    const text = fs.readFileSync(target, 'utf8')
    const value = JSON.parse(text)
    return value !== null && typeof value === 'object' ? value : null
  } catch { return null }
}

/** 配置里支持写 "~/xxx" 和 "%USERPROFILE%\\xxx" 这类路径。 */
export function expandPath(input) {
  if (typeof input !== 'string' || input === '') return ''
  let out = input.trim()
  if (out === '') return ''
  if (out === '~') return os.homedir()
  if (out.indexOf('~/') === 0 || out.indexOf('~\\') === 0) out = path.join(os.homedir(), out.slice(2))
  out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (whole, key) => {
    const value = process.env[key]
    return typeof value === 'string' && value !== '' ? value : whole
  })
  return path.resolve(out)
}

/** 从一个文件向上找 name 匹配的 package.json 所在目录。 */
function findPackageDir(startFile, name) {
  let dir = path.dirname(startFile)
  for (let depth = 0; depth < 8; depth += 1) {
    const pkg = readJson(path.join(dir, 'package.json'))
    if (pkg !== null && pkg.name === name) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return ''
}

/**
 * 包目录 → 真正的 CLI 入口。
 * 不假定 dist/bundle/cli.js 是完整程序：npm 版的它是一个 160 字节的 chunk 入口，
 * 所以体积不能当判据，存在即可。
 */
function entryOfPackageDir(dir) {
  const pkg = readJson(path.join(dir, 'package.json'))
  const rels = []
  if (pkg !== null) {
    const bin = pkg.bin
    if (typeof bin === 'string') rels.push(bin)
    else if (bin !== null && typeof bin === 'object') {
      if (typeof bin.pi === 'string') rels.push(bin.pi)
      for (const value of Object.values(bin)) if (typeof value === 'string') rels.push(value)
    }
    if (typeof pkg.main === 'string') rels.push(pkg.main)
  }
  rels.push(path.join('dist', 'bundle', 'cli.js'), path.join('dist', 'cli.js'))
  for (const rel of rels) {
    const abs = path.resolve(dir, rel)
    if (isFile(abs)) return abs
  }
  return ''
}

/**
 * npm 全局安装前缀（纯推导，不 spawn npm）。
 * 返回的是 `<prefix>`，模块目录由 fromModuleDir 拼成 `<prefix>/node_modules`。
 */
function globalNpmPrefixes() {
  const execDir = path.dirname(process.execPath)
  const prefixes = []
  if (process.platform === 'win32') {
    prefixes.push(execDir)
    const appData = process.env.APPDATA
    if (typeof appData === 'string' && appData !== '') prefixes.push(path.join(appData, 'npm'))
    const localAppData = process.env.LOCALAPPDATA
    if (typeof localAppData === 'string' && localAppData !== '') prefixes.push(path.join(localAppData, 'npm'))
  } else {
    prefixes.push(path.join(execDir, '..'))
    prefixes.push('/usr/local')
    prefixes.push('/usr')
  }
  return prefixes
}

/**
 * 解析 pi 运行时。
 * @returns {{cliPath:string, source:string, version:string|null, packageDir:string, searched:Array, expected:string}}
 */
export function resolvePiRuntime(options = {}) {
  const pluginRoot = typeof options.pluginRoot === 'string' ? options.pluginRoot : ''
  const config = options.config !== null && typeof options.config === 'object' ? options.config : {}
  const env = options.env !== null && typeof options.env === 'object' ? options.env : process.env
  const searched = []

  const hit = (source, cliPath, extra) => {
    const packageDir = findPackageDir(cliPath, PI_PACKAGE)
    const pkg = packageDir === '' ? null : readJson(path.join(packageDir, 'package.json'))
    const version = pkg !== null && typeof pkg.version === 'string' ? pkg.version : null
    searched.push({ source, path: cliPath, ok: true, ...extra })
    return { cliPath, source, version, packageDir, searched, expected: PI_PACKAGE + '@' + PI_VERSION, pluginRoot }
  }

  const miss = (source, target, reason) => {
    searched.push({ source, path: target, ok: false, reason })
  }

  const fromEntry = (source, entry) => {
    const abs = expandPath(entry)
    if (abs === '') return null
    if (isDir(abs)) {
      const cli = entryOfPackageDir(abs)
      if (cli === '') { miss(source, abs, 'directory has no pi entry'); return null }
      return hit(source, cli)
    }
    if (isFile(abs)) return hit(source, abs)
    miss(source, abs, 'not found')
    return null
  }

  const fromModuleDir = (source, moduleDir) => {
    if (moduleDir === '') return null
    const packageDir = path.join(moduleDir, 'node_modules', ...PI_PACKAGE.split('/'))
    if (isDir(packageDir) === false) { miss(source, packageDir, 'package not installed'); return null }
    const cli = entryOfPackageDir(packageDir)
    if (cli === '') { miss(source, packageDir, 'package has no cli entry'); return null }
    return hit(source, cli)
  }

  /** 从 startDir 起逐级向上，每级试 <dir>/node_modules/<pkg>。 */
  const fromWalkUp = (source, startDir) => {
    let dir = path.resolve(startDir)
    for (let depth = 0; depth < 12; depth += 1) {
      const packageDir = path.join(dir, 'node_modules', ...PI_PACKAGE.split('/'))
      if (isDir(packageDir)) {
        const cli = entryOfPackageDir(packageDir)
        if (cli !== '') return hit(source, cli, { via: path.join(dir, 'node_modules') })
      }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    miss(source, path.join(path.resolve(startDir), 'node_modules', ...PI_PACKAGE.split('/')), 'not found in any ancestor node_modules')
    return null
  }

  /**
   * pnpm 的虚拟 store：<root>/node_modules/.pnpm/@scope+name@ver/node_modules/@scope/name。
   * 只在 fully-isolated 布局下才需要；找到了同样要按 package.json 复核 name。
   */
  const fromPnpmStore = (source, startDir) => {
    const escaped = PI_PACKAGE.replace('/', '+')
    let dir = path.resolve(startDir)
    for (let depth = 0; depth < 12; depth += 1) {
      const store = path.join(dir, 'node_modules', '.pnpm')
      if (isDir(store)) {
        let names = []
        try { names = fs.readdirSync(store) } catch { names = [] }
        const matches = names.filter(name => name === escaped || name.indexOf(escaped + '@') === 0).sort()
        for (const name of matches) {
          const packageDir = path.join(store, name, 'node_modules', ...PI_PACKAGE.split('/'))
          if (isDir(packageDir) === false) continue
          const cli = entryOfPackageDir(packageDir)
          if (cli !== '') return hit(source, cli, { via: path.join(store, name) })
        }
        miss(source, store, matches.length === 0 ? 'no store entry for ' + PI_PACKAGE : 'store entry has no cli')
      }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return null
  }

  // 1. 配置里手填的入口（文件或包目录）
  if (typeof config.cliPath === 'string' && config.cliPath.trim() !== '') {
    const found = fromEntry('config', config.cliPath)
    if (found !== null) return found
  }

  // 2. 环境变量入口
  if (typeof env.PI_CLI_PATH === 'string' && env.PI_CLI_PATH.trim() !== '') {
    const found = fromEntry('env', env.PI_CLI_PATH)
    if (found !== null) return found
  }

  // 3. 环境变量运行时目录（Node 解析起点）
  if (typeof env.PI_RUNTIME_DIR === 'string' && env.PI_RUNTIME_DIR.trim() !== '') {
    const found = fromModuleDir('env-runtime', expandPath(env.PI_RUNTIME_DIR))
    if (found !== null) return found
  }

  // 4. 插件自带的 node_modules（optionalDependency）
  if (pluginRoot !== '') {
    const found = fromModuleDir('plugin-node-modules', pluginRoot)
    if (found !== null) return found
  }

  // 5. 插件 .runtime（一键安装落点）
  if (pluginRoot !== '') {
    const found = fromModuleDir('plugin-runtime', path.join(pluginRoot, PI_RUNTIME_DIR))
    if (found !== null) return found
  }

  // 6. 沿父目录逐级找 node_modules：覆盖 npm/pnpm 把依赖提升到上层的布局。
  //    真机踩过的坑：装成依赖后 pi 被 hoist 到 <proj>/node_modules，不在插件自己的 node_modules 下。
  if (pluginRoot !== '') {
    const found = fromWalkUp('walk-up', pluginRoot)
    if (found !== null) return found
  }

  // 7. pnpm 的 .pnpm 虚拟store（nodeLinker: isolated 时的布局，没有顶层提升）
  if (pluginRoot !== '') {
    const found = fromPnpmStore('pnpm-store', pluginRoot)
    if (found !== null) return found
  }

  // 8. npm 全局安装目录
  for (const prefix of globalNpmPrefixes()) {
    const found = fromModuleDir('global-npm', prefix)
    if (found !== null) return found
  }

  return { cliPath: '', source: 'missing', version: null, packageDir: '', searched, expected: PI_PACKAGE + '@' + PI_VERSION, pluginRoot }
}

/**
 * 解析 node 可执行文件。
 * 顺序：配置 → PI_NODE_PATH → PATH 扫描 → 宿主自己（Electron 用 ELECTRON_RUN_AS_NODE）。
 */
export function resolveNodeRuntime(options = {}) {
  const config = options.config !== null && typeof options.config === 'object' ? options.config : {}
  const env = options.env !== null && typeof options.env === 'object' ? options.env : process.env
  const searched = []
  const hit = (source, nodePath) => {
    searched.push({ source, path: nodePath, ok: true })
    return { path: nodePath, source, searched }
  }
  const miss = (source, target) => { searched.push({ source, path: target, ok: false }) }

  if (typeof config.nodePath === 'string' && config.nodePath.trim() !== '') {
    const abs = expandPath(config.nodePath)
    if (isFile(abs)) return hit('config', abs)
    miss('config', abs)
  }
  if (typeof env.PI_NODE_PATH === 'string' && env.PI_NODE_PATH.trim() !== '') {
    const abs = expandPath(env.PI_NODE_PATH)
    if (isFile(abs)) return hit('env', abs)
    miss('env', abs)
  }
  const names = process.platform === 'win32' ? ['node.exe'] : ['node']
  for (const dir of String(env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const fileName of names) {
      const candidate = path.join(dir, fileName)
      if (isFile(candidate)) return hit('path', candidate)
    }
  }
  searched.push({ source: 'path', path: '(no node.exe on PATH)', ok: false })
  // 兜底：宿主进程自己。Electron 带 ELECTRON_RUN_AS_NODE=1 时就是一个 node。
  return hit('host-execpath', process.execPath)
}

/** 运行时状态（给 /diagnostics 和客户端提示用）。 */
export function describeRuntime(pi) {
  return {
    ok: pi.cliPath !== '',
    source: pi.source,
    cliPath: pi.cliPath,
    version: pi.version,
    packageDir: pi.packageDir,
    expected: pi.expected,
    // 只有一键安装才会用到这个目录；手填 cliPath 时它可能根本不存在。
    runtimeDir: typeof pi.pluginRoot === 'string' && pi.pluginRoot !== '' ? path.join(pi.pluginRoot, PI_RUNTIME_DIR) : null,
    searched: pi.searched,
  }
}

/**
 * 一键安装 pi 到 <pluginRoot>/.runtime。
 * 用系统 npm（不引第三方依赖），继承环境变量（含 HTTP_PROXY/HTTPS_PROXY）。
 * @returns {Promise<{ok:boolean, code:number|null, log:string[], error:string|null, cliPath:string, durationMs:number}>}
 */
export function installPiRuntime(options = {}) {
  const pluginRoot = typeof options.pluginRoot === 'string' ? options.pluginRoot : ''
  const version = typeof options.version === 'string' && options.version.trim() !== '' ? options.version.trim() : PI_VERSION
  const onLog = typeof options.onLog === 'function' ? options.onLog : () => {}
  if (pluginRoot === '') return Promise.resolve({ ok: false, code: null, log: [], error: 'plugin root unknown', cliPath: '', durationMs: 0 })

  const runtimeDir = path.join(pluginRoot, PI_RUNTIME_DIR)
  const spec = PI_PACKAGE + '@' + version
  const startedAt = Date.now()
  try { fs.mkdirSync(runtimeDir, { recursive: true }) } catch (error) {
    return Promise.resolve({ ok: false, code: null, log: [], error: String(error?.message ?? error), cliPath: '', durationMs: 0 })
  }

  const npmArgs = ['install', '--prefix', runtimeDir, '--save-exact', '--no-audit', '--no-fund', '--loglevel=error', spec]
  const log = []

  /**
   * Windows 上 npm 是 npm.cmd，node 的 spawn 不能直接执行 .cmd（ENOENT/EINVAL），
   * 必须经 cmd.exe。这里显式走 cmd.exe 并把每个参数自己加引号，
   * 而不是 spawn(..., {shell:true})——后者会把参数拼成字符串交给 shell 解释，
   * 路径里有空格或 & 就会出事（Node 也会为此打 DEP0190 警告）。
   */
  const spawnSpec = process.platform === 'win32'
    ? {
      command: process.env.ComSpec !== undefined && process.env.ComSpec !== '' ? process.env.ComSpec : 'cmd.exe',
      args: ['/d', '/s', '/c', ['npm', ...npmArgs].map(part => (/[\s&|<>^"]/.test(part) ? '"' + part.replace(/"/g, '""') + '"' : part)).join(' ')],
    }
    : { command: 'npm', args: npmArgs }

  return new Promise(resolve => {
    let child = null
    try {
      child = spawn(spawnSpec.command, spawnSpec.args, {
        cwd: runtimeDir,
        env: { ...process.env },
        windowsHide: true,
      })
    } catch (error) {
      resolve({ ok: false, code: null, log, error: String(error?.message ?? error), cliPath: '', durationMs: Date.now() - startedAt })
      return
    }

    let settled = false
    const finish = payload => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...payload, log, durationMs: Date.now() - startedAt })
    }

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      finish({ ok: false, code: null, error: 'npm install timed out after ' + String(Math.round(INSTALL_TIMEOUT_MS / 1000)) + 's', cliPath: '' })
    }, INSTALL_TIMEOUT_MS)
    if (typeof timer.unref === 'function') timer.unref()

    const collect = chunk => {
      const text = String(chunk).replace(/\r?\n$/, '')
      if (text.trim() === '') return
      log.push(text)
      if (log.length > 200) log.shift()
      onLog(text)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', error => finish({ ok: false, code: null, error: String(error?.message ?? error), cliPath: '' }))
    child.on('close', code => {
      const probe = resolvePiRuntime({ pluginRoot })
      const ok = code === 0 && probe.cliPath !== ''
      finish({
        ok,
        code,
        error: ok ? null : (code === 0 ? 'npm finished but pi entry still missing' : 'npm exited with code ' + String(code)),
        cliPath: probe.cliPath,
      })
    })
  })
}

/**
 * dsh-pi — host half.
 *
 * 把 pi（编码代理 CLI）作为常驻子进程管起来，用 HTTP 暴露给浏览器半区。
 *
 * 为什么用子进程 + JSONL RPC 而不是 SDK：
 *  - pi 的 SDK 要在宿主进程里直接 import pi 的内部模块，版本一变就把 DSH 主进程搞崩；
 *    子进程隔离后，pi 崩了只是这个面板挂掉，DSH 不受影响。
 *  - RPC 是 pi 官方对外契约（docs/rpc.md），跨进程稳定，不依赖内部实现。
 *
 * 本文件不 import 任何 @deepseek-ai/* 包：宿主内的官方包在 Node 里解析不到，
 * 写死依赖会让 fiber 永远 pending。只依赖 node 内建 + 本包内的纯 ESM 模块。
 *
 * 可移植性：pi 运行时不写死任何机器的绝对路径，全部交给 src/pi-runtime.mjs 的解析链。
 * 解析不到时可以用 POST /runtime/install 把 pi 装进 <plugin>/.runtime（离线/受限网络
 * 下则手工配 config.cliPath 或环境变量 PI_CLI_PATH）。
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PiProcess } from './src/pi-rpc.mjs'
import {
  PI_PACKAGE,
  PI_VERSION,
  PI_RUNTIME_DIR,
  describeRuntime,
  installPiRuntime,
  resolveNodeRuntime,
  resolvePiRuntime,
} from './src/pi-runtime.mjs'

export const name = 'dsh-pi'
export const inject = []

const PLUGIN_ID = 'dsh-pi'
const DISPLAY_NAME = 'pi'
const VERSION = '0.2.0'
const API_PREFIX = '/api/' + PLUGIN_ID
const MAX_SESSIONS = 8
const MAX_BODY_BYTES = 4 * 1024 * 1024

const DEFAULTS = {
  /** 空 = 自动探测（插件内 .runtime → node_modules → 全局 npm → 环境变量）。 */
  cliPath: '',
  /** 空 = 自动探测（PATH 上的 node）。 */
  nodePath: '',
  /** 空 = ~/pi-workspace。 */
  workspace: '',
  /** 空格分隔的额外参数，追加到 pi 命令行（默认已带 --no-session）。 */
  extraArgs: '',
  /** 传给 pi 的固定参数（--no-session 保证每次开的是干净会话）。 */
  args: ['--no-session'],
}

/**
 * 自检：插件在进程里加载的那一刻，把真正参与运行的文件的 sha256 记下来。
 * 之后 GET /api/dsh-pi/selfcheck 会重算磁盘上的 sha256 并对比，回答一个
 * 光看 mtime 回答不了的问题——「现在跑的到底是不是磁盘上这份代码」。
 *
 * runtime:true 的文件改动必须重启 DSH 才生效；runtime:false 只是随身文件。
 */
const SELF_FILES = [
  { rel: 'index.js', runtime: true },
  { rel: 'client.js', runtime: true },
  { rel: 'src/pi-rpc.mjs', runtime: true },
  { rel: 'src/pi-runtime.mjs', runtime: true },
  { rel: 'package.json', runtime: false },
  { rel: 'cordis.patch.yml', runtime: false },
]

const PLUGIN_ROOT = (() => {
  try { return path.dirname(fileURLToPath(import.meta.url)) } catch { return '' }
})()

const LOAD_AT = new Date()

function fingerprint(target) {
  try {
    const bytes = fs.readFileSync(target)
    const stat = fs.statSync(target)
    return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, mtime: stat.mtime.toISOString() }
  } catch { return null }
}

function captureFingerprints() {
  const out = []
  for (const entry of SELF_FILES) {
    const abs = PLUGIN_ROOT === '' ? '' : path.join(PLUGIN_ROOT, entry.rel)
    out.push({ rel: entry.rel, runtime: entry.runtime, path: abs, loaded: abs === '' ? null : fingerprint(abs) })
  }
  return out
}

const LOADED_FILES = captureFingerprints()

/**
 * 直接读 .git 目录，不 spawn git：自检要能在任何环境跑，包括 PATH 上没有 git 的机器。
 */
function readGitHead(root) {
  if (root === '') return { available: false }
  const gitDir = path.join(root, '.git')
  let head = ''
  try { head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim() } catch { return { available: false } }
  const resolveRef = ref => {
    try { return fs.readFileSync(path.join(gitDir, ref), 'utf8').trim() } catch { /* 可能在 packed-refs 里 */ }
    try {
      const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8')
      for (const line of packed.split('\n')) {
        const parts = line.trim().split(' ')
        if (parts.length === 2 && parts[1] === ref) return parts[0]
      }
    } catch { /* 没有 packed-refs */ }
    return ''
  }
  if (head.indexOf('ref: ') === 0) {
    const ref = head.slice(5).trim()
    const commit = resolveRef(ref)
    return { available: commit !== '', branch: ref.replace(/^refs\/heads\//, ''), commit: commit === '' ? null : commit, detached: false }
  }
  return { available: head !== '', branch: null, commit: head === '' ? null : head, detached: true }
}

/** pi 的 bundle 是一堆 chunks，判断「构建是不是最新的」要看目录里最新的那个文件。 */
function newestUnder(dir, depth = 3) {
  if (dir === '' || depth < 0) return null
  let best = null
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return null }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = newestUnder(abs, depth - 1)
      if (nested !== null && (best === null || nested.mtimeMs > best.mtimeMs)) best = nested
      continue
    }
    if (entry.isFile() === false) continue
    try {
      const stat = fs.statSync(abs)
      if (best === null || stat.mtimeMs > best.mtimeMs) best = { path: abs, mtimeMs: stat.mtimeMs, mtime: stat.mtime.toISOString(), bytes: stat.size }
    } catch { /* 读不到就跳过 */ }
  }
  return best
}

/**
 * 自检结果。设计目标：一条命令就能回答「现在跑的是不是磁盘上最新那份、要不要重启」。
 * 判据只有一条：加载时读到的字节 vs 现在磁盘上的字节（sha256 相等即 fresh）。
 * mtime 只作为人看的辅助信息，不参与判定——mtime 会被 checkout / 复制 / 回滚骗过。
 */
function buildSelfCheck(detected, options = {}) {
  const scanPi = options.scanPi !== false
  const files = LOADED_FILES.map(entry => {
    const disk = entry.path === '' ? null : fingerprint(entry.path)
    const loadedSha = entry.loaded === null ? null : entry.loaded.sha256
    const diskSha = disk === null ? null : disk.sha256
    return {
      path: entry.path,
      rel: entry.rel,
      runtime: entry.runtime,
      loadedSha256: loadedSha,
      diskSha256: diskSha,
      loadedMtime: entry.loaded === null ? null : entry.loaded.mtime,
      diskMtime: disk === null ? null : disk.mtime,
      bytes: disk === null ? null : disk.bytes,
      // 判定语义：runtime 文件改动才需要重启；非 runtime 文件不一致只是提示。
      fresh: loadedSha !== null && diskSha !== null && loadedSha === diskSha,
    }
  })

  const missing = files.filter(file => file.diskSha256 === null)
  const staleRuntime = files.filter(file => file.runtime && file.fresh === false && file.diskSha256 !== null)
  const staleAny = files.filter(file => file.fresh === false && file.diskSha256 !== null)
  // 文件被删/被挪走也算「重启才生效」，但它跟「内容被改」是两回事，分开报。
  const goneRuntime = files.filter(file => file.runtime && file.diskSha256 === null)

  // pi 侧构建新鲜度：bundle 目录里最新文件 vs src 目录里最新文件。
  const cliPath = scanPi && detected.cliPath !== '' ? detected.cliPath : ''
  const bundleDir = cliPath === '' ? '' : path.dirname(cliPath)
  const packageDir = cliPath === '' ? '' : path.dirname(path.dirname(bundleDir))
  const srcDir = packageDir === '' ? '' : path.join(packageDir, 'src')
  const bundleNewest = newestUnder(bundleDir)
  const srcNewest = newestUnder(srcDir)
  const pi = {
    cliPath,
    cliExists: cliPath !== '' && exists(cliPath),
    bundleNewestAt: bundleNewest === null ? null : bundleNewest.mtime,
    srcNewestAt: srcNewest === null ? null : srcNewest.mtime,
    srcNewestRel: srcNewest === null || srcDir === '' ? null : path.relative(srcDir, srcNewest.path),
    // null = 判断不了（缺 src 或 bundle），true = 构建不早于源码，false = 源码比构建新。
    buildFresh: bundleNewest === null || srcNewest === null ? null : bundleNewest.mtimeMs >= srcNewest.mtimeMs,
  }

  return {
    ok: staleRuntime.length === 0,
    plugin: PLUGIN_ID,
    version: VERSION,
    root: PLUGIN_ROOT,
    loadedAt: LOAD_AT.toISOString(),
    checkedAt: new Date().toISOString(),
    process: { pid: process.pid, uptimeSec: Math.round(process.uptime()), node: process.version, execPath: process.execPath },
    git: readGitHead(PLUGIN_ROOT),
    summary: {
      // 唯一该看的字段：true 就是「磁盘上已经改了，但内存里跑的还是旧代码，重启 DSH 才生效」。
      stale: staleRuntime.length > 0 || goneRuntime.length > 0,
      staleRuntimeCount: staleRuntime.length + goneRuntime.length,
      changedCount: staleAny.length,
      missingCount: missing.length,
      changed: staleAny.map(file => file.rel),
      missing: missing.map(file => file.rel),
      hint: staleRuntime.length > 0 || goneRuntime.length > 0
        ? [
          staleRuntime.length > 0 ? '磁盘上的 ' + staleRuntime.map(file => file.rel).join(', ') + ' 已修改' : '',
          goneRuntime.length > 0 ? goneRuntime.map(file => file.rel).join(', ') + ' 已不在磁盘上' : '',
        ].filter(part => part !== '').join('；') + '，重启 DSH 后生效'
        : '内存中的插件代码与磁盘一致',
    },
    files,
    pi: scanPi ? pi : { skipped: true },
  }
}

export function apply(ctx, config = {}) {
  const log = makeLog(ctx)
  const settings = { ...DEFAULTS, ...(config !== null && typeof config === 'object' ? config : {}) }
  const sessions = new Map()
  /** detected 是「当前生效值」；运行时可能被 /runtime/install 或配置热更新改写。 */
  const detected = {
    nodePath: '',
    nodeSource: '',
    cliPath: '',
    cliSource: '',
    cliVersion: null,
    packageDir: '',
    runtimeSearched: [],
    workspace: '',
  }
  /** 安装中的标记，防止并发触发两次 npm install。 */
  let installing = null

  const resolveWorkspace = () => {
    const configured = typeof settings.workspace === 'string' ? settings.workspace.trim() : ''
    if (configured !== '') return configured
    const fromEnv = String(process.env.PI_WORKSPACE ?? '').trim()
    if (fromEnv !== '') return fromEnv
    return path.join(os.homedir(), 'pi-workspace')
  }

  /**
   * 重新解析运行时。加载时跑一次；/runtime/install 成功后再跑一次，
   * 之后新开的会话就用新装的那份（已开的会话不受影响，避免热切换打断对话）。
   */
  const refreshRuntime = () => {
    const node = resolveNodeRuntime({ config: settings })
    detected.nodePath = node.path
    detected.nodeSource = node.source
    const pi = resolvePiRuntime({ pluginRoot: PLUGIN_ROOT, config: settings })
    detected.cliPath = pi.cliPath
    detected.cliSource = pi.source
    detected.cliVersion = pi.version
    detected.packageDir = pi.packageDir
    detected.runtimeSearched = pi.searched
    detected.workspace = resolveWorkspace()
    if (pi.cliPath === '') {
      log('warn', 'pi CLI not found (searched: ' + pi.searched.map(item => item.source + (item.ok ? '=hit' : '=miss')).join(', ') + '); call POST ' + API_PREFIX + '/runtime/install or set cliPath')
    }
    return pi
  }

  refreshRuntime()

  const runtimeReport = () => ({
    ...describeRuntime({
      cliPath: detected.cliPath,
      source: detected.cliSource,
      version: detected.cliVersion,
      packageDir: detected.packageDir,
      expected: PI_PACKAGE + '@' + PI_VERSION,
      searched: detected.runtimeSearched,
      pluginRoot: PLUGIN_ROOT,
    }),
    node: { path: detected.nodePath, source: detected.nodeSource, version: process.version },
    platform: process.platform + '-' + process.arch,
    install: {
      available: PLUGIN_ROOT !== '',
      target: PLUGIN_ROOT === '' ? null : path.join(PLUGIN_ROOT, PI_RUNTIME_DIR),
      package: PI_PACKAGE,
      version: PI_VERSION,
      running: installing !== null,
    },
  })

  const envOverrides = () => {
    const env = {}
    // 宿主可能是 Electron：子进程若继承 ELECTRON_RUN_AS_NODE 会把 pi 当 node 脚本跑，
    // 直接失败且日志为空。这里显式清掉。
    if (detected.nodeSource === 'host-execpath') env.ELECTRON_RUN_AS_NODE = '1'
    else env.ELECTRON_RUN_AS_NODE = ''
    if (typeof process.env.PI_BASH === 'string' && process.env.PI_BASH !== '') env.PI_BASH = process.env.PI_BASH
    return env
  }

  const spawnSession = (options = {}) => {
    if (detected.cliPath === '') {
      // 每次要开新会话都重新找一遍：用户可能刚用 npm install 装好，或刚改完配置。
      refreshRuntime()
    }
    if (detected.cliPath === '') {
      const error = new Error('pi 运行时未找到（' + PI_PACKAGE + '@' + PI_VERSION + '）。装一次就好：POST ' + API_PREFIX + '/runtime/install，' +
        '或在插件配置里填 cliPath / 设置环境变量 PI_CLI_PATH。已搜索：' +
        detected.runtimeSearched.map(item => item.source + (item.ok ? ' ✓' : ' ✗')).join(' / '))
      error.statusCode = 500
      error.code = 'PI_RUNTIME_MISSING'
      throw error
    }
    if (sessions.size >= MAX_SESSIONS) {
      const error = new Error('会话数已达上限（' + String(MAX_SESSIONS) + '），先关掉一个')
      error.statusCode = 429
      throw error
    }
    const cwd = typeof options.cwd === 'string' && options.cwd.trim() !== '' ? options.cwd.trim() : detected.workspace
    try { fs.mkdirSync(cwd, { recursive: true }) } catch { /* 由 pi 自己报错 */ }
    const args = Array.isArray(settings.args) ? settings.args.slice() : []
    if (typeof settings.extraArgs === 'string' && settings.extraArgs.trim() !== '') {
      for (const extra of settings.extraArgs.trim().split(/\s+/)) if (extra !== '') args.push(extra)
    }
    if (Array.isArray(options.args)) {
      for (const extra of options.args) if (typeof extra === 'string' && extra !== '') args.push(extra)
    }
    const proc = new PiProcess({
      cliPath: detected.cliPath,
      nodePath: detected.nodePath,
      cwd,
      args,
      env: envOverrides(),
      label: typeof options.label === 'string' && options.label !== '' ? options.label : path.basename(cwd),
    })
    sessions.set(proc.id, proc)
    proc.on('exit', () => log('info', 'session ' + proc.id + ' exited'))
    proc.on('log', entry => log(entry.level === 'stderr' ? 'info' : entry.level, '[' + proc.id.slice(0, 8) + '] ' + entry.message))
    ctx.effect(() => () => { sessions.delete(proc.id); void proc.close({ timeoutMs: 4000 }) }, PLUGIN_ID + ': session ' + proc.id)
    proc.start()
    return proc
  }

  const requireSession = id => {
    const proc = sessions.get(id)
    if (proc === undefined) {
      const error = new Error('no such session: ' + String(id))
      error.statusCode = 404
      throw error
    }
    return proc
  }

  const stateOf = () => ({
    version: VERSION,
    apiPrefix: API_PREFIX,
    resolved: {
      nodePath: detected.nodePath,
      nodeSource: detected.nodeSource,
      cliPath: detected.cliPath,
      cliSource: detected.cliSource,
      cliVersion: detected.cliVersion,
      workspace: detected.workspace,
    },
    runtime: runtimeReport(),
    limits: { maxSessions: MAX_SESSIONS },
    sessions: [...sessions.values()].map(proc => proc.snapshot({ sinceSeq: 0, includeEvents: false })),
  })

  const sessionsDelete = id => { sessions.delete(id) }

  const selfCheck = () => buildSelfCheck(detected)

  /**
   * 一键安装 pi 运行时到 <plugin>/.runtime。
   * 幂等：正在装就返回同一个 promise，不会并发跑两个 npm。
   */
  const installRuntime = () => {
    if (installing !== null) return installing
    if (PLUGIN_ROOT === '') {
      const error = new Error('插件目录未知，无法安装到 .runtime')
      error.statusCode = 500
      throw error
    }
    installing = installPiRuntime({ pluginRoot: PLUGIN_ROOT, version: PI_VERSION, onLog: line => log('info', 'install: ' + line) })
      .then(result => {
        installing = null
        if (result.ok) {
          refreshRuntime()
          log('info', 'pi runtime installed: ' + result.cliPath + ' (' + String(Math.round(result.durationMs / 1000)) + 's)')
        } else {
          log('warn', 'pi runtime install failed: ' + String(result.error))
        }
        return { ...result, runtime: runtimeReport() }
      })
    return installing
  }

  const handler = createHandler({
    log,
    spawnSession,
    requireSession,
    sessionsDelete,
    stateOf,
    detected,
    selfCheck,
    runtimeReport,
    refreshRuntime,
    installRuntime,
  })

  ctx.inject(['webServer'], services => {
    const server = services === undefined || services === null ? undefined : services.webServer
    if (server === undefined || server === null || typeof server.register !== 'function') {
      log('warn', 'webServer unavailable; the Pi panel has no data source')
      return
    }
    ctx.effect(() => server.register({ kind: 'prefix', path: API_PREFIX, handler }), PLUGIN_ID + ': api routes')
    log('info', 'API mounted at ' + API_PREFIX)
  })

  ctx.effect(() => {
    log('info', 'loaded (node=' + detected.nodePath + ' via ' + detected.nodeSource + ', cli=' + (detected.cliPath || 'MISSING') + ')')
    return () => { for (const proc of sessions.values()) void proc.close({ timeoutMs: 3000 }) }
  }, PLUGIN_ID + ': teardown')
}

// ── HTTP 面 ───────────────────────────────────────────────────────────────────

function createHandler(deps) {
  return async function handler(req, res) {
    const url = new URL(typeof req.url === 'string' ? req.url : '/', 'http://localhost')
    let routePath = url.pathname.indexOf(API_PREFIX) === 0 ? url.pathname.slice(API_PREFIX.length) : url.pathname
    while (routePath.length > 1 && routePath.charAt(routePath.length - 1) === '/') routePath = routePath.slice(0, -1)
    if (routePath === '') routePath = '/'
    const method = String(req.method ?? 'GET').toUpperCase()

    const send = (status, payload) => {
      if (res.writableEnded) return
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(payload))
    }

    try {
      if (method === 'GET' && (routePath === '/state' || routePath === '/')) return send(200, deps.stateOf())
      if (method === 'GET' && routePath === '/health') return send(200, { ok: true, version: VERSION })
      if (method === 'GET' && routePath === '/selfcheck') {
        if (typeof deps.selfCheck !== 'function') return send(501, { error: 'selfcheck unavailable' })
        return send(200, deps.selfCheck())
      }
      if (method === 'GET' && routePath === '/runtime') return send(200, deps.runtimeReport())
      if (method === 'POST' && routePath === '/runtime/refresh') {
        deps.refreshRuntime()
        return send(200, { ok: true, runtime: deps.runtimeReport() })
      }
      if (method === 'POST' && routePath === '/runtime/install') {
        const result = await deps.installRuntime()
        return send(result.ok ? 200 : 500, { ...result, runtime: deps.runtimeReport() })
      }
      if (method === 'GET' && routePath === '/diagnostics') {
        return send(200, {
          plugin: { id: PLUGIN_ID, version: VERSION, root: PLUGIN_ROOT, apiPrefix: API_PREFIX, pid: process.pid, node: process.version, execPath: process.execPath },
          runtime: deps.runtimeReport(),
          selfcheck: typeof deps.selfCheck === 'function' ? deps.selfCheck() : null,
        })
      }

      if (method === 'POST' && routePath === '/sessions') {
        const body = await readJsonBody(req)
        const proc = deps.spawnSession(body ?? {})
        const snapshot = proc.snapshot({ sinceSeq: 0, includeEvents: false })
        return send(200, { ok: true, session: snapshot })
      }

      const match = routePath.match(/^\/sessions\/([^/]+)(\/.*)?$/)
      if (match !== null) {
        const id = decodeURIComponent(match[1])
        const tail = match[2] ?? ''
        const proc = deps.requireSession(id)

        if (method === 'DELETE' && tail === '') {
          deps.sessionsDelete?.(id)
          await proc.close({ timeoutMs: 6000 })
          return send(200, { ok: true })
        }
        if (method === 'GET' && tail === '') return send(200, proc.snapshot({ sinceSeq: 0, includeEvents: false }))
        if (method === 'GET' && tail === '/events') return streamEvents(req, res, proc, url)
        if (method === 'GET' && tail === '/snapshot') {
          const since = Number(url.searchParams.get('since') ?? 0)
          return send(200, proc.snapshot({ sinceSeq: Number.isFinite(since) ? since : 0 }))
        }
        if (method === 'POST' && tail === '/command') {
          const contentType = String(req.headers['content-type'] ?? '')
          if (contentType.toLowerCase().indexOf('application/json') === -1) return send(415, { error: 'content-type must be application/json' })
          const body = await readJsonBody(req)
          if (body === null || typeof body !== 'object' || Array.isArray(body) || typeof body.type !== 'string') {
            return send(400, { error: 'body must be a JSON object with a string "type"' })
          }
          const data = await proc.send(body, { timeoutMs: Number(body.timeoutMs) > 0 ? Number(body.timeoutMs) : undefined })
          if (body.type === 'get_state' && data !== null && typeof data === 'object') proc.lastState = data
          return send(200, { ok: true, data })
        }
        return send(404, { error: 'no such route: ' + routePath })
      }

      return send(404, { error: 'no such route: ' + routePath })
    } catch (error) {
      const status = typeof error?.statusCode === 'number' ? error.statusCode : 500
      if (status >= 500) deps.log('warn', String(error?.message ?? error))
      return send(status, { error: String(error?.message ?? error) })
    }
  }
}

function streamEvents(req, res, proc, url) {
  const rawSince = Number(url.searchParams.get('since') ?? 0)
  const since = Number.isFinite(rawSince) ? rawSince : 0
  if (res.writableEnded) return
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  if (typeof res.flushHeaders === 'function') res.flushHeaders()

  const write = text => {
    if (res.writableEnded) return
    try { res.write(text) } catch { /* 客户端已断 */ }
  }
  const pushEvent = entry => write('data: ' + JSON.stringify(entry) + '\n\n')
  const pushExit = info => write('event: exit\ndata: ' + JSON.stringify(info) + '\n\n')

  write(': connected\n\n')
  for (const entry of proc.snapshot({ sinceSeq: since }).events) pushEvent(entry)
  if (proc.exitInfo !== null) pushExit(proc.exitInfo)

  const onEvent = entry => pushEvent(entry)
  const onExit = info => pushExit(info)
  proc.on('event', onEvent)
  proc.on('exit', onExit)

  const keepAlive = setInterval(() => write(': ping\n\n'), 15000)
  if (typeof keepAlive.unref === 'function') keepAlive.unref()

  const cleanup = () => {
    clearInterval(keepAlive)
    proc.off('event', onEvent)
    proc.off('exit', onExit)
    if (!res.writableEnded) { try { res.end() } catch { /* already closed */ } }
  }
  req.on('close', cleanup)
  req.on('aborted', cleanup)
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        const error = new Error('body too large')
        error.statusCode = 413
        reject(error)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') { resolve(undefined); return }
      try { resolve(JSON.parse(text)) } catch (error) { reject(Object.assign(new Error('invalid JSON body'), { statusCode: 400 })) }
    })
  })
}

// ── 工具 ─────────────────────────────────────────────────────────────────────

function exists(target) {
  try { return fs.statSync(target).isFile() } catch { return false }
}

function makeLog(ctx) {
  const target = (() => {
    try {
      const value = typeof ctx.get === 'function' ? ctx.get('logger') : undefined
      return value !== null && typeof value === 'object' ? value : undefined
    } catch { return undefined }
  })()
  return (level, message) => {
    if (target === undefined) return
    try {
      const sink = target[level]
      if (typeof sink === 'function') sink.call(target, PLUGIN_ID + ': ' + message)
    } catch { /* 日志不该影响功能 */ }
  }
}

// ── 插件配置（宿主插件详情页的表单） ──────────────────────────────────────────
//
// 只有 .volatile() 的字段会进表单，并被宿主原位热更新 + 持久化到 cordis.patch.yml。
// 动态 import + 兜底而不是静态 import：静态 import 一旦解析失败，整个 server entry
// 都装不上，插件会被标成「异常」，连侧栏都进不去。

async function loadSchemastery() {
  try { return (await import('@deepseek-ai/schemastery')).default } catch { return undefined }
}

const schema = await loadSchemastery()

/**
 * 顶层 await 是必需的：宿主要在建 fiber 前拿到 schema 才渲染表单。
 * schema 解析失败时导出 undefined，插件其余功能不受影响��
 */
export const Config = schema === undefined
  ? undefined
  : schema.object({
    cliPath: schema.string().default('').description('pi CLI 入口文件或包目录。留空自动探测：插件 .runtime → 插件 node_modules → 全局 npm → PATH').volatile(),
    nodePath: schema.string().default('').description('node 可执行文件。留空自动探测 PATH 上的 node').volatile(),
    workspace: schema.string().default('').description('新会话默认工作目录。留空用 ~/pi-workspace').volatile(),
    extraArgs: schema.string().default('').description('追加给 pi 的额外参数（空格分隔），例如 --model openai/gpt-4o').volatile(),
  })

if (schema === undefined) {
  console.warn('[dsh-pi] @deepseek-ai/schemastery 解析失败：插件详情页没有配置区（侧栏面板与运行时自举不受影响）')
}


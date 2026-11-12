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
 * 写死依赖会让 fiber 永远 pending。只依赖 node 内建。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PiProcess } from './src/pi-rpc.mjs'

export const name = 'dsh-pi'
export const inject = []

const PLUGIN_ID = 'dsh-pi'
const DISPLAY_NAME = 'pi'
const VERSION = '0.1.0'
const API_PREFIX = '/api/' + PLUGIN_ID
const MAX_SESSIONS = 8
const MAX_BODY_BYTES = 4 * 1024 * 1024

const DEFAULTS = {
  /** 空 = 自动探测。 */
  cliPath: '',
  /** 空 = 自动探测（PATH 上的 node）。 */
  nodePath: '',
  /** 空 = ~/pi-workspace。 */
  workspace: '',
  /** 传给 pi 的额外参数（--no-session 保证每次开的是干净会话）。 */
  args: ['--no-session'],
}

const CLI_CANDIDATES = [
  'C:\\Users\\PC\\Documents\\pi-local\\pi-main\\packages\\coding-agent\\dist\\bundle\\cli.js',
  path.join(os.homedir(), 'pi-local', 'pi-main', 'packages', 'coding-agent', 'dist', 'bundle', 'cli.js'),
]

export function apply(ctx, config = {}) {
  const log = makeLog(ctx)
  const settings = { ...DEFAULTS, ...(config !== null && typeof config === 'object' ? config : {}) }
  const sessions = new Map()
  const detected = { nodePath: '', cliPath: '', nodeSource: '', cliSource: '', workspace: '' }

  const resolveNode = () => {
    if (typeof settings.nodePath === 'string' && settings.nodePath !== '') {
      if (exists(settings.nodePath)) { detected.nodeSource = 'config'; return settings.nodePath }
      log('warn', 'configured nodePath does not exist: ' + settings.nodePath)
    }
    const fromEnv = process.env.PI_NODE_PATH
    if (typeof fromEnv === 'string' && exists(fromEnv)) { detected.nodeSource = 'env'; return fromEnv }
    const names = process.platform === 'win32' ? ['node.exe'] : ['node']
    const dirs = String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
    for (const dir of dirs) {
      for (const fileName of names) {
        const candidate = path.join(dir, fileName)
        if (exists(candidate)) { detected.nodeSource = 'path'; return candidate }
      }
    }
    // 兜底：用宿主自己的可执行文件以 node 模式跑（Electron 支持 ELECTRON_RUN_AS_NODE）。
    detected.nodeSource = 'host-execpath'
    return process.execPath
  }

  const resolveCli = () => {
    if (typeof settings.cliPath === 'string' && settings.cliPath !== '') {
      if (exists(settings.cliPath)) { detected.cliSource = 'config'; return settings.cliPath }
      log('warn', 'configured cliPath does not exist: ' + settings.cliPath)
    }
    const fromEnv = process.env.PI_CLI_PATH
    if (typeof fromEnv === 'string' && exists(fromEnv)) { detected.cliSource = 'env'; return fromEnv }
    for (const candidate of CLI_CANDIDATES) {
      if (exists(candidate)) { detected.cliSource = 'candidate'; return candidate }
    }
    detected.cliSource = 'missing'
    return ''
  }

  const resolveWorkspace = () => {
    const configured = typeof settings.workspace === 'string' ? settings.workspace.trim() : ''
    if (configured !== '') return configured
    const fromEnv = String(process.env.PI_WORKSPACE ?? '').trim()
    if (fromEnv !== '') return fromEnv
    return path.join(os.homedir(), 'pi-workspace')
  }

  detected.nodePath = resolveNode()
  detected.cliPath = resolveCli()
  detected.workspace = resolveWorkspace()

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
      const error = new Error('pi CLI 未找到：请把 cliPath 配到插件配置里，或设置环境变量 PI_CLI_PATH')
      error.statusCode = 500
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
      workspace: detected.workspace,
    },
    limits: { maxSessions: MAX_SESSIONS },
    sessions: [...sessions.values()].map(proc => proc.snapshot({ sinceSeq: 0, includeEvents: false })),
  })

  const sessionsDelete = id => { sessions.delete(id) }

  const handler = createHandler({
    log,
    spawnSession,
    requireSession,
    sessionsDelete,
    stateOf,
    detected,
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

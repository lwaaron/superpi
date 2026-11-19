/**
 * superpi — host half.
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
 * 下则手工配 config.cliPath 或环境变量 SUPERPI_CLI_PATH）。
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PiProcess, timeoutLimitMs } from './src/pi-rpc.mjs'
import {
  BASH_SHORTCUTS,
  ASSISTANT_EVENT_TYPES,
  PI_VERSION as PI_CONTRACT_VERSION,
  RPC_COMMANDS,
  RPC_EVENTS,
  TUI_COMMANDS,
} from './src/rpc-contract.mjs'
import {
  expandUserPath,
  groupSessionsByProject,
  listAllSessions,
  listSessions,
  pathComparisonKey,
  readSessionCwd,
  resolveAgentDir,
  samePath,
  sessionRootDir,
  shortenHomePath,
} from './src/session-store.mjs'
import {
  PI_PACKAGE,
  PI_VERSION,
  SUPERPI_RUNTIME_DIR,
  describeRuntime,
  installPiRuntime,
  readSetting,
  readSettingString,
  resolveNodeRuntime,
  resolvePiRuntime,
} from './src/pi-runtime.mjs'
import { createUiPrefsStore } from './src/ui-prefs.mjs'
import {
  createRulesStore,
  rulesView,
} from './extensions/superpi-rules.mjs'
import {
  DEFAULT_ENABLED_MODALITIES,
  LOCKED_MODALITIES,
  MODALITY_LABELS,
  RUNTIME_MODALITIES,
  createModalitiesStore,
  resolveModalitiesPath,
} from './extensions/superpi-modalities.mjs'

export const name = 'superpi'
export const inject = []

const PLUGIN_ID = 'superpi'
const DISPLAY_NAME = 'SuperPi'
const API_PREFIX = '/api/' + PLUGIN_ID
const MAX_SESSIONS = 8
const MAX_BODY_BYTES = 4 * 1024 * 1024
/** GET /contract 里 version 字段的取值：本插件对外的契约版本，与 package.json 解耦。 */
const CONTRACT_VERSION = '0.14.5'
/** 历史会话列表的条数窗口（与 src/session-store.mjs 的 DEFAULT_LIMIT/MAX_LIMIT 一致）。 */
const HISTORY_DEFAULT_LIMIT = 20
const HISTORY_MAX_LIMIT = 200
/** @ 补全的条数窗口：面板一屏最多也就几十条，给多了纯浪费带宽。 */
const FILES_DEFAULT_LIMIT = 50
const FILES_MAX_LIMIT = 200
/**
 * 面板内预览的读取上限。
 *
 * 文本 512KiB：够整篇 markdown / 一屏代码 / 一整份日志的头部；再大用户在面板里也读不完，
 * 而一次性把 10MB 文本塞进 DOM 只会把面板卡死。
 * 图片 8MiB：截图（1080p PNG 常见 1~3MB）都能内联预览；超过就走「文件太大」，不做缩放
 * ——缩放要额外依赖，且面板预览不是图像编辑器。
 */
const FILE_TEXT_MAX_BYTES = 512 * 1024
const FILE_IMAGE_MAX_BYTES = 8 * 1024 * 1024
/** 二进制判定的采样窗口：前 8KiB 里出现 NUL 就按二进制处理（与 git 的判据同源）。 */
const FILE_BINARY_PROBE_BYTES = 8192
/**
 * 「在资源管理器里定位文件」的等待上限。
 *
 * explorer.exe 会把自己挂到已有的桌面进程上然后立刻退出，但冷启动时可能拖到秒级；
 * 这里只等进程 spawn 完成，不等它退出 —— 等 explorer 退出会把请求拖死（它可能要几秒）。
 */
const REVEAL_SPAWN_WAIT_MS = 1500
/** /changelog 的读取上限：CHANGELOG.md 通常几十 KB，200KiB 足够整篇。 */
const CHANGELOG_MAX_BYTES = 200 * 1024
/**
 * 会替换「当前会话」的四条命令。成功后必须清事件缓冲——否则面板重连时会把
 * 旧会话的事件和新会话的事件混在一起渲染（见 POST /sessions/:id/command）。
 */
const SESSION_REPLACING_COMMANDS = new Set(['new_session', 'switch_session', 'fork', 'clone'])
/** 新建会话后等 get_state 回来（拿 sessionFile / sessionId / sessionName）的最长时间。 */
const SPAWN_STATE_TIMEOUT_MS = 5000
/** POST /sessions 里为了回填 sessionFile 愿意等的时间上限（超过就先把会话回给客户端）。 */
const POST_SPAWN_STATE_WAIT_MS = 2500

/**
 * 历史消息分页（0.14.0）。
 *
 * 为什么必须分页：一个真实的视觉迭代会话有 3251 条消息、116 张 base64 图，
 * `get_messages` 一次返回 **55.1 MB**（实测：stringify 116ms + parse 50ms + 传输）。
 * 而**图片占其中 88.2%** —— 面板首屏根本不需要 116 张大图，需要的是最近这一屏。
 *
 * 三条一起做才有效（缺一条都会留一个卡顿入口）：
 *   ① 只取最近 `HISTORY_PAGE_SIZE` 条；
 *   ② 图片块换成 `image-stub`（带 bytes/mimeType/id，不带 base64）；
 *   ③ 更早的历史走 `?before=` 往前翻，真实图片走 `/images/:id` 按需取。
 * 实测效果：55.1 MB → 222 KB（最近 200 条 + stub），首屏可交互从「卡几秒」降到即时。
 *
 * `HISTORY_PAGE_MAX` 是上限而不是默认值：面板要翻更早时一次最多 500 条，
 * 再多就分批 —— 单次响应体必须留在 1MB 量级，否则又回到原来的病。
 */
export const HISTORY_PAGE_SIZE = 200
export const HISTORY_PAGE_MAX = 500

const DEFAULTS = {
  /** 空 = 自动探测（插件内 .runtime → node_modules → 全局 npm → 环境变量）。 */
  cliPath: '',
  /** 空 = 自动探测（PATH 上的 node）。 */
  nodePath: '',
  /** 空 = ~/pi-workspace。 */
  workspace: '',
  /** 空格分隔的额外参数，追加到 pi 命令行。 */
  extraArgs: '',
  /**
   * 原始参数数组。历史上这里是 ['--no-session']，现在由 persist 决定是否落盘：
   * 保留这个字段只为兼容测试/宿主直接下发的裸数组（见 test/selfcheck.mjs）。
   */
  args: [],
  /** true = 会话落盘（pi 默认行为）；false = 加 --no-session，退出即丢。 */
  persist: true,
  /** 新会话的开局方式：'continue' = 接上该 cwd 最近的会话（pi --continue），'new' = 全新会话。 */
  startup: 'continue',
  /** 新建会话时写给 session_info 的名字（pi --name）。空 = 不设名。 */
  sessionName: '',
}

/**
 * 自检：插件在进程里加载的那一刻，把真正参与运行的文件的 sha256 记下来。
 * 之后 GET /api/superpi/selfcheck 会重算磁盘上的 sha256 并对比，回答一个
 * 光看 mtime 回答不了的问题——「现在跑的到底是不是磁盘上这份代码」。
 *
 * runtime:true 的文件改动必须重启 DSH 才生效；runtime:false 只是随身文件。
 */
const SELF_FILES = [
  { rel: 'index.js', runtime: true },
  { rel: 'client.js', runtime: true },
  { rel: 'src/pi-rpc.mjs', runtime: true },
  { rel: 'src/pi-runtime.mjs', runtime: true },
  { rel: 'src/session-store.mjs', runtime: true },
  { rel: 'src/rpc-contract.mjs', runtime: true },
  // 面板偏好的落盘层。runtime:true 是因为它参与 /ui-prefs 三条路由的判断逻辑，
  // 改了磁盘上的它而进程里还是旧的那份，就会出现「读到的结构与代码对不上」。
  { rel: 'src/ui-prefs.mjs', runtime: true },
  // 用户自定义规则的模型/落盘层。它同时被 host（/rules 三条路由）与 pi 扩展
  // （extensions/superpi-rules.ts，install 时原样复制）引用，改完必须重启 DSH ——
  // 否则「面板读到的结构」与「进程里那份代码」会对不上。
  { rel: 'extensions/superpi-rules.mjs', runtime: true },
  // 规则扩展本体（只随 tarball 分发、由工具装进 pi；面板不加载它）。
  { rel: 'extensions/superpi-rules.ts', runtime: false },
  // 上下文守卫：模型层只在 pi 进程里跑（扩展加载），host 不 import 它，
  // 所以改完只需重装扩展 + 重启 pi 会话，不需要重启 DSH。
  { rel: 'extensions/superpi-context-guard.mjs', runtime: false },
  { rel: 'extensions/superpi-context-guard.ts', runtime: false },
  // 模型模态的唯一模型层。host 的 /modalities 两条路由直接 import 它，
  // 所以改完必须重启 DSH（否则面板算的规则和进程里那份对不上）。
  { rel: 'extensions/superpi-modalities.mjs', runtime: true },
  { rel: 'extensions/superpi-modalities.ts', runtime: false },
  { rel: 'package.json', runtime: false },
  { rel: 'cordis.patch.yml', runtime: false },
]

const PLUGIN_ROOT = (() => {
  try { return path.dirname(fileURLToPath(import.meta.url)) } catch { return '' }
})()

/**
 * 读「上下文守卫」写下的**观测日志**最后一行（0.12.0）。
 *
 * 为什么面板需要它：pi 的 `get_session_stats.contextUsage` 是 usage 派生值，而当前上游把
 * prompt 全记在 cache 且 `input=0`，于是真实 1.31M 的上下文被显示成 **3.7%** —— 用户以为
 * 还有 96% 空间，直到撞上 400。那个数字不能用来做决定。
 *
 * 为什么 host 不 import `extensions/superpi-context-guard.mjs`：日志是**观测面**，
 * 不是真相面。host 只需要「最后一行能读出来的 JSON」，读不出来就 `available:false`；
 * 反向依赖会把一个 pi 扩展模块拽进 host 的启动路径（它一旦有语法错误，面板就起不来）。
 */
const GUARD_LOG_DIR_NAME = '.superpi'
const GUARD_LOG_FILE_NAME = 'context-guard.log.jsonl'
const GUARD_LOG_TAIL_BYTES = 128 * 1024

function resolveContextGuardLogPath(env = process.env, home = os.homedir()) {
  const override = typeof env?.SUPERPI_CONTEXT_GUARD === 'string' ? env.SUPERPI_CONTEXT_GUARD.trim() : ''
  const dir = override !== '' ? path.dirname(path.resolve(override)) : path.join(home, GUARD_LOG_DIR_NAME)
  return path.join(dir, GUARD_LOG_FILE_NAME)
}

function readContextGuardTail(sessionId = '') {
  try {
    const file = resolveContextGuardLogPath()
    const stat = fs.statSync(file)
    if (stat.size <= 0) return { available: false }
    const readBytes = Math.min(stat.size, GUARD_LOG_TAIL_BYTES)
    const buffer = Buffer.alloc(readBytes)
    const handle = fs.openSync(file, 'r')
    try {
      fs.readSync(handle, buffer, 0, readBytes, stat.size - readBytes)
    } finally {
      fs.closeSync(handle)
    }
    const lines = buffer.toString('utf8').split('\n').filter(line => line.trim() !== '')
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      let row = null
      try { row = JSON.parse(lines[i]) } catch { continue }
      if (row === null || typeof row !== 'object') continue
      if (sessionId !== '' && row.sessionId !== sessionId) continue
      return { available: true, ...row }
    }
    return { available: false }
  } catch {
    return { available: false }
  }
}

/**
 * 版本号只有一份真相：本包 package.json 的 version。
 *
 * 这里以前是手写常量，升包后忘了同步就会让 /health、/state、/diagnostics 报旧号
 * （实跑踩过：pnpm 装进去的是 0.2.3，接口一路报 0.2.2，排查时误导性极强）。
 * 读不到时降级成 '0.0.0' 而不是崩：版本号是诊断信息，不该成为启动前置条件。
 */
const VERSION = (() => {
  if (PLUGIN_ROOT === '') return '0.0.0'
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' && pkg.version.trim() !== '' ? pkg.version.trim() : '0.0.0'
  } catch { return '0.0.0' }
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

// ── 命令行拼装 ────────────────────────────────────────────────────────────────
//
// 这一段是纯函数，没有 IO：test/host-parity.mjs 直接拿它做表驱动断言。
// 之所以要单独抽出来，是因为「拼错一个 flag」的后果是 pi 子进程 exit(1)，
// 而 host 只能看到一个起不来的会话——现场极难判断是参数问题还是运行时缺失。

/** 布尔配置容错：宿主表单给的是字符串，测试/宿主代码可能给 boolean。 */
export function asBool(value, fallback) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase()
    if (text === 'true' || text === '1' || text === 'yes' || text === 'on') return true
    if (text === 'false' || text === '0' || text === 'no' || text === 'off') return false
  }
  return fallback
}

/** pi 的会话选择类参数：互斥语义（main.ts:346-377 的 validateForkFlags / validateSessionIdFlags）。 */
const SESSION_SELECTION_FLAGS = ['--session', '--resume', '-r', '-c', '--continue', '--fork', '--session-id']
const NO_SESSION_FLAGS = ['--no-session']

function hasFlag(argv, flags) {
  for (const token of argv) {
    if (typeof token !== 'string') continue
    const eq = token.indexOf('=')
    const head = eq === -1 ? token : token.slice(0, eq)
    if (flags.indexOf(head) !== -1) return true
  }
  return false
}

/**
 * 拼出传给 pi 的参数（不含 '--mode rpc'，那是 PiProcess 的事）。
 *
 * 顺序即优先级：本函数生成的会话选择参数在前，用户自带参数在后；
 * 一旦用户在 args/extraArgs 里自己写了会话选择参数，本函数就完全不生成，
 * 免得拼出 pi 会拒绝的组合（--fork 与 --session/--continue 并存 → exit(1)）。
 *
 * @param {{
 *   settings?: { args?: string[], extraArgs?: string, persist?: unknown, startup?: unknown, sessionName?: unknown },
 *   options?: { args?: string[], extraArgs?: string, persist?: unknown, continue?: unknown, resumePath?: string, name?: string },
 *   env?: object, home?: string, base?: string,
 * }} input
 * @returns {string[]}
 */
export function buildSpawnArgs({ settings = {}, options = {}, env = process.env, home, base } = {}) {
  const pick = list => (Array.isArray(list) ? list.filter(item => typeof item === 'string' && item !== '') : [])
  const configured = pick(settings.args)
  const extraText = typeof options.extraArgs === 'string' && options.extraArgs.trim() !== ''
    ? options.extraArgs
    : (typeof settings.extraArgs === 'string' ? settings.extraArgs : '')
  const extra = extraText === '' ? [] : extraText.split(/\s+/).filter(item => item !== '')
  const tail = [...configured, ...extra, ...pick(options.args)]

  // 用户在 args/extraArgs 里自己带了 --no-session 就等于已经声明不落盘，别再补一遍。
  const callerNoSession = hasFlag(tail, NO_SESSION_FLAGS)
  const persist = !callerNoSession && asBool(options.persist, asBool(settings.persist, true))
  const startup = typeof settings.startup === 'string' ? settings.startup.trim().toLowerCase() : ''
  const continueRequested = options.continue === undefined
    ? startup === 'continue'
    : asBool(options.continue, false)
  const resumePath = typeof options.resumePath === 'string' ? options.resumePath.trim() : ''
  const callerSelects = hasFlag(tail, SESSION_SELECTION_FLAGS)

  const args = []
  if (!persist) {
    if (!callerNoSession) args.push('--no-session')
  } else if (!callerSelects) {
    // resumePath 优先于 continue：显式点了某个历史会话，就不该再被「最近会话」覆盖。
    if (resumePath !== '') args.push('--session', expandUserPath(resumePath, { env, home, base }))
    else if (continueRequested) args.push('--continue')
  }

  const rawName = options.name === undefined ? settings.sessionName : options.name
  const name = typeof rawName === 'string' ? rawName.trim() : ''
  // pi 对空 --name 是 exit(1)（main.ts:771-778），所以空值宁可不传。
  if (name !== '') args.push('--name', name)

  args.push(...tail)
  return args
}

/**
 * 从「正在跑的会话」里挑出属于 target cwd 的 sessionFile（给 /sessions/history 的 current）。
 *
 * 规则：同 cwd 里优先取还活着的（state !== 'dead'），全死掉才退回第一个；
 * 跨 cwd 的一律不算——面板用 current 给列表行打「正在使用」标记，标错比不标更糟。
 *
 * @param {{ running?: Array<{ cwd?: string, sessionFile?: string|null, state?: string }>, target?: string }} input
 * @returns {string|null}
 */
export function pickCurrentSessionFile({ running = [], target = '' } = {}) {
  const list = running.filter(item => item !== null && typeof item === 'object' &&
    typeof item.sessionFile === 'string' && item.sessionFile !== '')
  const sameCwd = list.filter(item => samePath(item.cwd ?? '', target))
  const alive = sameCwd.filter(item => item.state !== 'dead')
  if (alive.length > 0) return alive[0].sessionFile
  if (sameCwd.length > 0) return sameCwd[0].sessionFile
  return null
}

/**
 * 全部项目视图里的「正在使用」标记：只要面板正开着某个会话，就把它标出来——
 * 跨项目时同样成立（这正是旧实现做不到的：它按 cwd 过滤，跨项目一律不算）。
 * @param {Array<{ sessionFile?: string|null, state?: string }>} running
 * @param {Array<{ path?: string }>} [known] 已列出的会话，用于排除「会话文件不属于本机 sessions 目录」的情况
 * @returns {string|null}
 */
export function firstRunningSessionFile(running = [], known = []) {
  const live = (Array.isArray(running) ? running : []).filter(item => item !== null && typeof item === 'object' &&
    typeof item.sessionFile === 'string' && item.sessionFile !== '')
  if (live.length === 0) return null
  const alive = live.filter(item => item.state !== 'dead')
  const pool = alive.length > 0 ? alive : live
  if (!Array.isArray(known) || known.length === 0) return pool[0].sessionFile
  const paths = new Set(known.map(item => (item !== null && typeof item === 'object' && typeof item.path === 'string' ? item.path : '')))
  const matched = pool.find(item => paths.has(item.sessionFile))
  return matched === undefined ? null : matched.sessionFile
}

/**
 * 会话快照 + 项目标识。面板顶栏要显示「当前项目标题」，而路径缩短（home → `~`）与大小写归一
 * （Windows 盘符/路径不区分大小写）这两件事的唯一真相都在 session-store 里；浏览器侧再抄一份
 * 迟早分叉，所以由 host 算好随快照下发。
 *
 * projectKey 与 groupSessionsByProject 给项目列表的 key 同一算法（pathComparisonKey），
 * 面板因此能直接用 ui-prefs 里「重命名过的项目名」匹配当前会话，不需要自己猜分隔符。
 * 取 sessionCwd 而非 cwd：switch_session / fork 到别的项目后，cwd 仍是子进程的 spawn 目录。
 *
 * 抽成模块级纯函数（而不是留在 apply 闭包里）是为了能被门禁直接测：真正取快照的
 * `snapshotOf(proc, options)` 就在下面，apply 与 createHandler 共用同一份。
 */
export function withProjectIdentity(snapshot, projectCwd) {
  const base = snapshot !== null && typeof snapshot === 'object' ? snapshot : {}
  const cwd = typeof projectCwd === 'string' ? projectCwd : ''
  return Object.assign({}, base, {
    displayPath: shortenHomePath(cwd),
    projectKey: pathComparisonKey(cwd),
  })
}

/**
 * 会话快照 + 项目标识。必须留在**模块级**：createHandler 与 apply 两处都要用，
 * 放在 apply 闭包里会让 createHandler 那几个路由直接 ReferenceError。
 */
export function snapshotOf(proc, options) {
  return withProjectIdentity(proc.snapshot(options), proc.sessionCwd ?? proc.cwd)
}

export function apply(ctx, config = {}) {
  const log = makeLog(ctx)
  /**
   * 配置是**活引用**，不是快照。
   *
   * 宿主的插件配置表单只认 .volatile() 字段，并且下发的是 cosmokit 的冻结引用：
   * 用户在详情页改值时宿主就地写入该引用，插件下次 get() 即拿到新值——这是「原位
   * 热更新、插件不落盘」的实现方式。所以这里绝不能把 config 展开成快照对象，
   * 否则改配置永远不生效；每个读取点都走 readSetting / readSettingString。
   */
  const rawConfig = config !== null && typeof config === 'object' ? config : {}
  /** 非 volatile 的固定默认值（浅拷贝，避免多个 apply 实例互相影响）。 */
  const settings = { ...DEFAULTS }
  const configString = (key) => readSettingString(rawConfig, key, typeof settings[key] === 'string' ? settings[key] : '')
  /** 配置指纹：变了就重解析运行时。只在真被调用时算，不做定时轮询。 */
  const CONFIG_KEYS = ['cliPath', 'nodePath', 'workspace', 'extraArgs']
  const configSignature = () => CONFIG_KEYS.map(key => configString(key)).join('\u0000')
  let lastSignature = configSignature()
  const sessions = new Map()
  /** 传给解析器的活配置视图：每次读都穿透到 rawConfig（含 volatile 引用），不缓存快照。 */
  const liveConfig = Object.defineProperties({}, Object.fromEntries(
    CONFIG_KEYS.map(key => [key, { enumerable: true, get: () => configString(key) }]),
  ))
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
    const configured = configString('workspace')
    if (configured !== '') return configured
    const fromEnv = String(process.env.SUPERPI_WORKSPACE ?? '').trim()
    if (fromEnv !== '') return fromEnv
    return path.join(os.homedir(), 'pi-workspace')
  }

  /**
   * 重新解析运行时。加载时跑一次；/runtime/install 成功后再跑一次，
   * 之后新开的会话就用新装的那份（已开的会话不受影响，避免热切换打断对话）。
   *
   * 默认带指纹比对：配置没变就直接返回上次结果（所以 spawnSession 可以每次都调，
   * 既能让详情页改的 cliPath 立刻生效，又不会每次开会话都白扫一遍磁盘）。
   * 传 { force: true } 才无条件重扫（/runtime/refresh、装完之后）。
   */
  let lastPi = null
  const refreshRuntime = (options = {}) => {
    const signature = configSignature()
    if (options.force !== true && lastPi !== null && signature === lastSignature) return lastPi
    lastSignature = signature
    const node = resolveNodeRuntime({ config: liveConfig })
    detected.nodePath = node.path
    detected.nodeSource = node.source
    const pi = resolvePiRuntime({ pluginRoot: PLUGIN_ROOT, config: liveConfig })
    detected.cliPath = pi.cliPath
    detected.cliSource = pi.source
    detected.cliVersion = pi.version
    detected.packageDir = pi.packageDir
    detected.runtimeSearched = pi.searched
    detected.workspace = resolveWorkspace()
    if (pi.cliPath === '') {
      log('warn', 'pi CLI not found (searched: ' + pi.searched.map(item => item.source + (item.ok ? '=hit' : '=miss')).join(', ') + '); call POST ' + API_PREFIX + '/runtime/install or set cliPath')
    }
    lastPi = pi
    return pi
  }

  refreshRuntime({ force: true })

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
      target: PLUGIN_ROOT === '' ? null : path.join(PLUGIN_ROOT, SUPERPI_RUNTIME_DIR),
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
    // 每次开新会话都过一遍解析：配置可能刚被改过（带指纹比对，没变就是零成本返回）。
    if (detected.cliPath === '' || configSignature() !== lastSignature) refreshRuntime()
    if (detected.cliPath === '') {
      const error = new Error('pi 运行时未找到（' + PI_PACKAGE + '@' + PI_VERSION + '）。装一次就好：POST ' + API_PREFIX + '/runtime/install，' +
        '或在插件配置里填 cliPath / 设置环境变量 SUPERPI_CLI_PATH。已搜索：' +
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
    const cwd = typeof options.cwd === 'string' && options.cwd.trim() !== ''
      ? expandUserPath(options.cwd, { env: process.env, home: os.homedir(), base: detected.workspace })
      : detected.workspace
    // resumePath 先落地检查一遍：pi 的 --session 打不开就直接 exit(1)，host 只能看到一个
    // 立刻死掉的会话。提前 404 出去，客户端能立刻提示「文件不存在」而不是等超时。
    const resumePath = typeof options.resumePath === 'string' ? options.resumePath.trim() : ''
    const resolvedResume = resumePath === '' ? '' : expandUserPath(resumePath, { env: process.env, home: os.homedir(), base: cwd })
    if (resolvedResume !== '' && !exists(resolvedResume)) {
      const error = new Error('session file not found: ' + resolvedResume)
      error.statusCode = 404
      throw error
    }
    try { fs.mkdirSync(cwd, { recursive: true }) } catch { /* 由 pi 自己报错 */ }
    // args 不是 volatile 字段（数组不适合做表单输入），但仍可能由测试/宿主以裸数组传入。
    const configuredArgs = readSetting(rawConfig, 'args', null)
    const args = buildSpawnArgs({
      settings: {
        args: Array.isArray(configuredArgs) ? configuredArgs : settings.args,
        extraArgs: configString('extraArgs'),
        persist: readSetting(rawConfig, 'persist', settings.persist),
        startup: readSettingString(rawConfig, 'startup', settings.startup),
        sessionName: readSettingString(rawConfig, 'sessionName', settings.sessionName),
      },
      options: {
        args: options.args,
        extraArgs: options.extraArgs,
        persist: options.persist,
        continue: options.continue,
        resumePath: resolvedResume,
        name: options.name,
      },
      env: process.env,
      home: os.homedir(),
      base: cwd,
    })
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
    // 立刻把 sessionId / sessionFile / model 拉回来：pi 在 rpc 模式下不会主动发会话头
    // （docs/json.md:29），不主动问就永远是 null，客户端连「当前在哪个文件」都不知道。
    // 失败不影响会话可用性（问不到就当 null），所以只吞错不抛。
    proc.stateReady = proc.send({ type: 'get_state' }, { timeoutMs: SPAWN_STATE_TIMEOUT_MS })
      .then(() => proc.lastState, () => proc.lastState ?? null)
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

  const stateOf = () => {
    // 配置可能在详情页被改过（volatile 引用就地写入）。带指纹比对地过一遍解析，
    // 没变就是常数时间返回，所以 /state 永远反映当前配置，不需要用户重启。
    refreshRuntime()
    return {
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
      sessions: [...sessions.values()].map(proc => snapshotOf(proc, { sinceSeq: 0, includeEvents: false })),
    }
  }

  const sessionsDelete = id => { sessions.delete(id) }

  /**
   * 当前跑着的会话（给 /sessions/history 标 current 用）。
   * 返回 { sessionFile, cwd, sessionId, name } 列表；sessionFile 可能还是 null
   * （子进程刚起来、get_state 还没回来），调用方按路径相等比较时会自然跳过。
   */
  const listRunningSessions = () => [...sessions.values()].map(proc => ({
    id: proc.id,
    cwd: proc.sessionCwd ?? proc.cwd,
    sessionCwd: proc.sessionCwd ?? proc.cwd,
    sessionId: proc.lastState?.sessionId ?? null,
    sessionFile: proc.lastState?.sessionFile ?? null,
    sessionName: proc.lastState?.sessionName ?? null,
    state: proc.state,
  }))

  /**
   * 列历史会话。agentDir / sessionDir 走 pi 同一套解析链（PI_CODING_AGENT_DIR、
   * PI_CODING_AGENT_SESSION_DIR），所以设了环境变量也能列对。
   *
   * 两种 scope，对应 pi 的 SessionManager.list（单项目）与 SessionManager.listAll（全部项目）：
   *  - scope='project' + cwd：只列该 cwd 的会话（面板历史抽屉的第二层，也是 pi 的默认层）。
   *  - scope='all'（默认，cwd 为空时）：扫 sessions/ 下所有项目子目录，额外返回 projects 聚合
   *    （面板历史抽屉的第一层，对齐 pi 的 ProjectList）。
   * 旧调用方「不带 cwd」曾经被静默回落成 workspace，导致面板只看得到一个项目 —— 现在不带 cwd
   * 就是「全部项目」，回落只发生在显式 scope='project' 且 cwd 缺失时。
   */
  const listHistory = async ({ scope, cwd, limit } = {}) => {
    const home = os.homedir()
    const env = process.env
    const hasCwd = typeof cwd === 'string' && cwd.trim() !== ''
    const mode = scope === 'project' || scope === 'all' ? scope : hasCwd ? 'project' : 'all'
    const target = mode === 'project'
      ? (hasCwd ? expandUserPath(cwd, { env, home, base: detected.workspace }) : detected.workspace)
      : ''
    const agentDir = resolveAgentDir({ env, home })
    const root = sessionRootDir({ agentDir, env, home })
    const running = listRunningSessions()
    // limit 只截 sessions；分组需要全量，否则非当前项目的会话数会被截掉。
    const all = await listAllSessions({ agentDir, cwd: target, env, home })
    const sessions = typeof limit === 'number' && limit > 0 ? all.slice(0, limit) : all
    const projects = mode === 'all'
      ? groupSessionsByProject(all, { currentCwd: running.length > 0 ? running[0].sessionCwd : '' })
      : []
    const current = mode === 'project'
      ? pickCurrentSessionFile({ running, target })
      : firstRunningSessionFile(running, all)
    return {
      scope: mode,
      cwd: target,
      agentDir,
      sessionDir: root.dir,
      override: root.override,
      total: all.length,
      projects,
      sessions,
      current,
    }
  }

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
          refreshRuntime({ force: true })
          log('info', 'pi runtime installed: ' + result.cliPath + ' (' + String(Math.round(result.durationMs / 1000)) + 's)')
        } else {
          log('warn', 'pi runtime install failed: ' + String(result.error))
        }
        return { ...result, runtime: runtimeReport() }
      })
    return installing
  }

  /**
   * 面板偏好的存储（项目重命名 / 会话置顶）。
   *
   * 放在 apply 作用域里只建一次：store 内部有一条写队列，必须被所有请求共享，
   * 每次请求新建实例就等于没有串行化（并发 read-modify-write 会互相覆盖）。
   * 落盘路径由 src/ui-prefs.mjs 解析（SUPERPI_UI_PREFS 或 ~/.superpi/ui-prefs.json）。
   */
  const uiPrefs = createUiPrefsStore()

  /**
   * 用户自定义规则的存储（最高优先级）。
   *
   * 与 uiPrefs 同理只建一次：store 内部有串行写队列，每条请求新建一个就等于没有串行化
   * （并发 read-modify-write 会互相覆盖）。路径由 extensions/superpi-rules.mjs 解析
   * （`SUPERPI_RULES` 或 `<home>/.superpi/rules.json`）。
   *
   * **注意它是面板与 pi 扩展的共享介质**：pi 扩展每轮 `before_agent_start` 读的也是这个文件，
   * 所以面板保存后下一轮就生效，不需要重启会话、也不需要任何同步协议。
   */
  const rulesStore = createRulesStore()

  /**
   * 模型模态开关的存储（0.13.0）。
   *
   * 与 rulesStore 同构：只建一次（内部串行写队列），面板写、pi 扩展每轮读同一份文件。
   * 所以「面板改了开关，下一次请求就不发图」不需要任何同步协议 —— 它们看的是同一份
   * `<home>/.superpi/modalities.json`。
   */
  const modalitiesStore = createModalitiesStore()

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
    listHistory,
    listRunningSessions,
    uiPrefs,
    rulesStore,
    modalitiesStore,
    // /files 的 dir 缺省值：走一次指纹比对（没改配置就是常数时间），保证刚改的 workspace 立刻生效。
    workspacePath: () => { refreshRuntime(); return detected.workspace },
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

/**
 * 规则存储的取用器。
 *
 * 依赖注入的签名与 `/ui-prefs` 一致（测试里直接传一个临时 store），
 * 但**永远返回一个可用 store、从不返回 null**，所以路由里不该再写 501 分支
 * （写了也永远进不去，那就是「看起来已处理」的死代码）。理由：规则是面板的一个普通设置项，缺省就该用默认存储盘，
 * 而不是「宿主忘了传 deps 就整个设置页报错」。这也是它比 uiPrefs 更适合兜底的原因
 * —— 后者是纯面板账，规则却有一个「默认文案总是可用」的离线语义。
 */
function rulesStoreOf(deps) {
  const injected = deps === undefined || deps === null ? undefined : deps.rulesStore
  if (injected !== undefined && injected !== null && typeof injected.read === 'function') return injected
  if (rulesFallbackStore === null) rulesFallbackStore = createRulesStore()
  return rulesFallbackStore
}

/** 模块级兜底 store（只建一次：它内部有一条串行写队列）。 */
let rulesFallbackStore = null

/** 模态存储的取用器（与 rulesStoreOf 同一条约定：永远返回可用 store）。 */
function modalitiesStoreOf(deps) {
  const injected = deps === undefined || deps === null ? undefined : deps.modalitiesStore
  if (injected !== undefined && injected !== null && typeof injected.read === 'function') return injected
  if (modalitiesFallbackStore === null) modalitiesFallbackStore = createModalitiesStore()
  return modalitiesFallbackStore
}

let modalitiesFallbackStore = null

/**
 * 命令行扩展是否已经装进 pi 的全局扩展目录。
 *
 * 面板据此提示「命令行窗口里还没生效，跑 npm run pi:editor」，而不是让用户
 * 改了规则、在 TUI 里却发现没变，还以为功能坏了。
 *
 * 目录解析与 `tools/install-pi-extension.mjs` 同一套（`PI_CONFIG_DIR` 优先），
 * 但**不 import tools/**（`tools` 不进 npm 包，装到别处就不存在了）。
 */
function rulesExtensionInstalled({ env = process.env, home = os.homedir() } = {}) {
  try {
    const configDir = typeof env.PI_CONFIG_DIR === 'string' && env.PI_CONFIG_DIR !== '' ? env.PI_CONFIG_DIR : '.pi'
    const base = path.isAbsolute(configDir) ? configDir : path.join(home, configDir)
    return fs.statSync(path.join(base, 'agent', 'extensions', 'superpi-rules.ts')).isFile()
  } catch {
    return false
  }
}

export function createHandler(deps) {
  /**
   * 历史图片回取表：整个 handler 一份，按 `<sessionId>:<seq>:<block>` 索引。
   * 放在 handler 闭包里而不是 per-request：面板翻页 / 重新挂载后仍能取回同一张图，
   * 不必再重新分页一次。
   */
  const imageStore = createImageStore()
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
        deps.refreshRuntime({ force: true })
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
      /**
       * 契约原文，逐字段原样序列化（不裁剪、不改名）。
       * 面板靠它决定「这条输入该走 RPC 还是本地实现」，也需要它把 33 条 RPC 命令
       * 与 27 条 TUI 斜杠命令对齐——客户端里那份 CONTRACT 常量就是这么来的。
       */
      if (method === 'GET' && routePath === '/contract') {
        return send(200, {
          ok: true,
          version: CONTRACT_VERSION,
          piVersion: PI_CONTRACT_VERSION,
          rpcCommands: RPC_COMMANDS,
          events: RPC_EVENTS,
          assistantEvents: ASSISTANT_EVENT_TYPES,
          tuiCommands: TUI_COMMANDS,
          bashShortcuts: BASH_SHORTCUTS,
        })
      }
      /**
       * 历史会话列表。必须排在 /^\/sessions\/([^/]+)/ 之前，
       * 否则 'history' 会被当成会话 id 走进 requireSession 拿 404。
       *
       * ?scope=all|project；缺省时按有没有 cwd 推断（有 cwd → project，无 → all）。
       * 面板历史抽屉第一层用 all（拿 projects 聚合），第二层用 project（拿某个 cwd 的会话）。
       */
      if (method === 'GET' && routePath === '/sessions/history') {
        if (typeof deps.listHistory !== 'function') return send(501, { error: 'history unavailable' })
        const cwd = url.searchParams.get('cwd') ?? ''
        const scope = url.searchParams.get('scope') ?? ''
        const limit = clampCount(url.searchParams.get('limit'), HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT)
        const result = await deps.listHistory({ scope, cwd, limit })
        return send(200, { ok: true, ...result })
      }
      /** @ 补全与「插入路径」：RPC 协议没有 fs 能力，只能由 host 代读（只读，不递归）。 */
      if (method === 'GET' && routePath === '/files') {
        const workspace = typeof deps.workspacePath === 'function' ? deps.workspacePath() : ''
        const rawDir = (url.searchParams.get('dir') ?? '').trim()
        const dir = normalizeDir(rawDir === '' ? workspace : expandUserPath(rawDir, { env: process.env, home: os.homedir(), base: workspace }))
        const query = url.searchParams.get('query') ?? ''
        const limit = clampCount(url.searchParams.get('limit'), FILES_DEFAULT_LIMIT, FILES_MAX_LIMIT)
        const listing = await listDirectory({ dir, query, limit })
        return send(200, { ok: true, dir: listing.dir, entries: listing.entries, truncated: listing.truncated })
      }
      /**
       * 面板预览：读一个文件的内容。
       *
       * 为什么由 host 读而不是浏览器直接渲染路径：pi 的会话 cwd 与本插件的工作区都可能
       * 落在任意盘符（用户的实际工程在 D: 上，arte facts 也在那儿），浏览器侧没有读盘能力；
       * 而 pi 的 RPC 契约里根本没有 fs 读文件能力（只有 bash，用它读文件会把内容塞进
       * 对话上下文，既费 token 也不该为了看一眼文件就产生一次工具调用）。
       *
       * 语义：
       *  - 只读，不递归，不跟随目录（要读目录用 /files）；
       *  - path 支持 ~ / %VAR% / 相对路径（相对 workspace 解析），与 /files 的 dir 同一套规则；
       *  - 文本上限 FILE_TEXT_MAX_BYTES，图片上限 FILE_IMAGE_MAX_BYTES，超限截断并标 truncated；
       *  - 前 FILE_BINARY_PROBE_BYTES 里出现 NUL 判为二进制，只回元信息不回内容；
       *  - 路径不存在 / 不是文件分别回 404 / 400。
       */
      if (method === 'GET' && routePath === '/file') {
        const workspace = typeof deps.workspacePath === 'function' ? deps.workspacePath() : ''
        const rawPath = (url.searchParams.get('path') ?? '').trim()
        if (rawPath === '') {
          const failure = new Error('path required')
          failure.statusCode = 400
          throw failure
        }
        const target = normalizeDir(expandUserPath(rawPath, { env: process.env, home: os.homedir(), base: workspace }))
        return send(200, await readPreviewFile(target))
      }
      /**
       * 在系统文件管理器里定位一个文件（面板文件标签的右键动作）。
       *
       * 为什么不从浏览器侧直接开：浏览器的 file:// 被 Chromium 拦死，而且插件根本拿不到
       * 「用资源管理器打开」这种系统能力。宿主进程是用户的桌面环境，只有它能做这件事。
       *
       * 语义与 Windows 资源管理器的 /select 完全一致：弹出父目录、选中这个文件。
       * 目录本身也能定位（/select 会打开它）；路径不存在回 404 —— 静默失败会让用户
       * 以为右键坏了，必须如实报出来。
       *
       * 注入点：deps.revealPath 可替换（测试用），默认实现走 explorer.exe。
       */
      if (method === 'POST' && routePath === '/reveal') {
        const workspace = typeof deps.workspacePath === 'function' ? deps.workspacePath() : ''
        const body = (await readJsonBody(req)) ?? {}
        const rawPath = typeof body.path === 'string' ? body.path.trim() : ''
        if (rawPath === '') {
          const failure = new Error('path required')
          failure.statusCode = 400
          throw failure
        }
        const target = normalizeDir(expandUserPath(rawPath, { env: process.env, home: os.homedir(), base: workspace }))
        const reveal = typeof deps.revealPath === 'function' ? deps.revealPath : revealInFileManager
        try {
          await reveal(target)
        } catch (error) {
          const failure = new Error(error?.code === 'ENOENT' ? 'no such file' : String(error?.message ?? 'cannot reveal'))
          failure.statusCode = error?.code === 'ENOENT' ? 404 : 500
          throw failure
        }
        return send(200, { ok: true, path: target })
      }
      /**
       * 工作目录选择抽屉：只列子目录（+ parent + writable），供面板逐级浏览。
       * 与 /files 同一套参数与错误语义；额外回一个 home，面板据此提供「回到主目录」。
       */
      if (method === 'GET' && routePath === '/directories') {
        const workspace = typeof deps.workspacePath === 'function' ? deps.workspacePath() : ''
        const rawDir = (url.searchParams.get('dir') ?? '').trim()
        const dir = normalizeDir(rawDir === '' ? workspace : expandUserPath(rawDir, { env: process.env, home: os.homedir(), base: workspace }))
        const query = url.searchParams.get('query') ?? ''
        const limit = clampCount(url.searchParams.get('limit'), FILES_DEFAULT_LIMIT, FILES_MAX_LIMIT)
        const listing = await listDirectories({ dir, query, limit })
        return send(200, {
          ok: true,
          dir: listing.dir,
          parent: listing.parent,
          writable: listing.writable,
          entries: listing.entries,
          truncated: listing.truncated,
          home: os.homedir(),
          /**
           * 本机可达的文件系统根（Windows = 盘符，POSIX = '/'）。
           * 面板据此提供「此电脑」入口：从 C: 逐级往上只能走到 C:，
           * 到不了 D:/E:/F:，没有 roots 就永远选不到别的盘。
           */
          roots: await listRoots(),
        })
      }
      /** /changelog（契约 disposition:'local'）：读 pi 包内的 CHANGELOG.md。找不到也回 200，客户端据此显示「无 changelog」。 */
      if (method === 'GET' && routePath === '/pi/changelog') {
        return send(200, readChangelog(deps.detected === undefined || deps.detected === null ? '' : deps.detected.packageDir))
      }

      /**
       * 面板偏好（项目重命名 / 会话置顶）。
       *
       * 为什么由 host 存：这两件事都没有 pi 通道 —— set_session_name 改的是单个会话的
       * session_info，改不了项目层；置顶纯属面板概念，SessionInfo 里没有这个字段。
       * 浏览器半区也没有写盘能力，所以只能落在这台机器的用户主目录下。
       *
       * 三条路由都返回**全量结构**（不是增量）：偏好是一份小字典，让客户端每次拿全量
       * 就不必维护两端合并逻辑。
       *
       * 校验（key/name/path/pinned 的类型与长度）在 src/ui-prefs.mjs 里，那里抛的错
       * 带 statusCode:400，由下面的 catch 原样回给客户端——路由层不再重复一遍规则。
       */
      if (method === 'GET' && routePath === '/ui-prefs') {
        if (deps.uiPrefs === undefined || deps.uiPrefs === null) return send(501, { error: 'ui prefs unavailable' })
        return send(200, await deps.uiPrefs.read())
      }
      if (method === 'POST' && routePath === '/ui-prefs/project') {
        if (deps.uiPrefs === undefined || deps.uiPrefs === null) return send(501, { error: 'ui prefs unavailable' })
        const body = (await readJsonBody(req)) ?? {}
        return send(200, await deps.uiPrefs.setProject(body.key, body.name))
      }
      if (method === 'POST' && routePath === '/ui-prefs/session') {
        if (deps.uiPrefs === undefined || deps.uiPrefs === null) return send(501, { error: 'ui prefs unavailable' })
        const body = (await readJsonBody(req)) ?? {}
        // 合并式补丁：只把请求里出现过的字段交给 store（undefined = 别动它）。
        // 面板的两个动作是独立的（行内 ⋯ 的「重命名」与「置顶」），谁改谁提交一个字段就够，
        // 读-改-写留在 store 里做，客户端不必先把现值读回来再整体回传。
        return send(200, await deps.uiPrefs.setSession(body.path, { pinned: body.pinned, name: body.name }))
      }

      /**
       * 用户自定义规则（最高优先级）。
       *
       * 为什么由 host 落盘、而不是面板发一条 RPC 命令让 pi 自己存：
       *  ① 面板要**读原文回显**进编辑框，而 pi 的 RPC 面没有「读系统提示」这条命令，
       *     扩展命令的返回值也不回传 —— 只走命令的话面板得自己再存一份，立刻两份真相；
       *  ② 设置页可能在**没有任何活着的子进程**时被打开（还没开会话 / 子进程崩了），
       *     一个设置项不该依赖另一个进程活着；
       *  ③ 规则同时是 pi 扩展（extensions/superpi-rules.ts）每轮读的那份文件，
       *     落在这里就等于「面板改什么、pi 下一轮就用什么」，中间不需要任何同步协议。
       *
       * 三条路由都回**全量视图**（与 /ui-prefs 同一风格）；归一与校验在
       * extensions/superpi-rules.mjs 里，那里抛的错带 statusCode:400，由下面的 catch 原样回给客户端。
       */
      /**
       * 上下文真实占用（0.12.0）：只读守卫写下的观测日志最后一行。
       * `sessionId` 可选 —— 面板传了就按会话过滤（日志是所有会话共用的一份）。
       */
      if (method === 'GET' && routePath === '/context') {
        const sessionId = (url.searchParams.get('sessionId') ?? '').trim()
        return send(200, { ok: true, ...readContextGuardTail(sessionId) })
      }
      /**
       * 模型模态开关（0.13.0）。
       *
       * 返回的是**状态 + 注册表**，不是「解析好的模型清单」：host 不持有模型目录
       * （模型列表是 pi 的 `get_available_models`，属于会话进程的知识）。面板本来就要
       * 拉那个列表，把它和自己这份 overrides 合并即可 —— 避免 host 为了拼一份清单
       * 去猜 pi 的目录。
       */
      if (method === 'GET' && routePath === '/modalities') {
        const store = modalitiesStoreOf(deps)
        const state = await store.read()
        return send(200, {
          ok: true,
          state,
          registry: {
            runtime: RUNTIME_MODALITIES,
            defaults: DEFAULT_ENABLED_MODALITIES,
            locked: LOCKED_MODALITIES,
            labels: MODALITY_LABELS,
            filePath: resolveModalitiesPath(),
          },
        })
      }
      if (method === 'POST' && routePath === '/modalities') {
        const store = modalitiesStoreOf(deps)
        const contentType = String(req.headers['content-type'] ?? '')
        if (contentType.toLowerCase().indexOf('application/json') === -1) return send(415, { error: 'content-type must be application/json' })
        const body = (await readJsonBody(req)) ?? {}
        const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
        const id = typeof body.id === 'string' ? body.id.trim() : ''
        const modality = typeof body.modality === 'string' ? body.modality.trim() : ''
        // `enabled: null` = 恢复默认（清掉覆盖）。缺字段 ≠ null，必须区分。
        const hasEnabled = Object.prototype.hasOwnProperty.call(body, 'enabled')
        if (!hasEnabled) {
          const failure = new Error('enabled required (boolean or null)')
          failure.statusCode = 400
          throw failure
        }
        const enabled = body.enabled === null ? null : body.enabled === true
        const state = await store.set({ provider, id }, modality, enabled)
        return send(200, { ok: true, state })
      }
      if (method === 'GET' && routePath === '/rules') {
        const store = rulesStoreOf(deps)
        const read = await store.read()
        return send(200, rulesView(read.state, {
          filePath: read.filePath,
          extensionInstalled: rulesExtensionInstalled(),
          warning: read.warning,
        }))
      }
      if (method === 'POST' && routePath === '/rules') {
        const store = rulesStoreOf(deps)
        // 与 /command、/respond 同一套约定：不是 JSON 就不接（不回退成「猜编码」）。
        const contentType = String(req.headers['content-type'] ?? '')
        if (contentType.toLowerCase().indexOf('application/json') === -1) return send(415, { error: 'content-type must be application/json' })
        const body = (await readJsonBody(req)) ?? {}
        const written = await store.write(body.text)
        return send(200, rulesView(written.state, {
          filePath: written.filePath,
          extensionInstalled: rulesExtensionInstalled(),
        }))
      }
      if (method === 'POST' && routePath === '/rules/reset') {
        const store = rulesStoreOf(deps)
        const contentType = String(req.headers['content-type'] ?? '')
        if (contentType.toLowerCase().indexOf('application/json') === -1) return send(415, { error: 'content-type must be application/json' })
        const written = await store.reset()
        return send(200, rulesView(written.state, {
          filePath: written.filePath,
          extensionInstalled: rulesExtensionInstalled(),
        }))
      }

      if (method === 'POST' && routePath === '/sessions') {
        const body = await readJsonBody(req)
        const proc = deps.spawnSession(body ?? {})
        // 等一小会儿 get_state：拿到就能直接回 sessionFile / sessionId / sessionName，
        // 客户端不必再轮询一次。等不到（慢启动/已退出）也照常返回，字段是 null，
        // 后续 SSE 与 /snapshot 会把它们补上——不能为了这几个字段把开新会话拖慢。
        if (proc.stateReady !== undefined) await Promise.race([proc.stateReady, delay(POST_SPAWN_STATE_WAIT_MS)])
        const snapshot = snapshotOf(proc, { sinceSeq: 0, includeEvents: false })
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
        if (method === 'GET' && tail === '') return send(200, snapshotOf(proc, { sinceSeq: 0, includeEvents: false }))
        if (method === 'GET' && tail === '/events') return streamEvents(req, res, proc, url)
        if (method === 'GET' && tail === '/snapshot') {
          const since = Number(url.searchParams.get('since') ?? 0)
          return send(200, snapshotOf(proc, { sinceSeq: Number.isFinite(since) ? since : 0 }))
        }
        /**
         * 取一张历史图片的真实像素（0.14.0）。
         *
         * `get_messages` 只给 `image-stub`，面板要渲染某张图时才来这里取一次。
         * 按 `image:<sessionFile>:<seq>:<blockIndex>` 定位，**不从 id 反推路径**：
         * id 由 host 生成并自校验，避免路径穿越。
         */
        if (method === 'GET' && tail.indexOf('/images/') === 0) {
          const imageId = decodeURIComponent(tail.slice('/images/'.length))
          const record = await imageStore.get(imageId)
          if (record === null) return send(404, { error: 'no such image' })
          return send(200, { ok: true, mimeType: record.mimeType, data: record.data })
        }
        /**
         * 历史消息分页（0.14.0；判据见 docs/performance-acceptance.md §1.2 D）。
         *
         * `?before=<seq>&limit=<n>`；不传 before = 最新一页。响应体恒在 1MB 量级，
         * 图片一律是 `image-stub`（真实像素走 /images/:id）。
         */
        if (method === 'GET' && tail === '/messages') {
          const data = await proc.send({ type: 'get_messages' }, { timeoutMs: 120000 })
          const list = data !== null && typeof data === 'object' && Array.isArray(data.messages) ? data.messages : []
          const page = paginateHistory(list, {
            before: url.searchParams.get('before'),
            limit: url.searchParams.get('limit'),
            imageIdOf: (block, messageIndex, blockIndex) => imageStore.remember(
              String(id) + ':' + String(messageIndex) + ':' + String(blockIndex),
              block.mimeType,
              typeof block.data === 'string' ? block.data : (typeof block.source?.data === 'string' ? block.source.data : ''),
            ),
          })
          return send(200, { ok: true, data: page })
        }
        if (method === 'POST' && tail === '/command') {
          const contentType = String(req.headers['content-type'] ?? '')
          if (contentType.toLowerCase().indexOf('application/json') === -1) return send(415, { error: 'content-type must be application/json' })
          const body = await readJsonBody(req)
          if (body === null || typeof body !== 'object' || Array.isArray(body) || typeof body.type !== 'string') {
            return send(400, { error: 'body must be a JSON object with a string "type"' })
          }
          // 超时三态透传（语义见 src/pi-rpc.mjs 的 timeoutLimitMs）：
          //   缺省 / null      → undefined → 默认上限；
          //   正有限数          → 毫秒上限；
          //   0 / 负数 / Infinity → 不设上限（对话类命令要等 pi 自己回答，包括等用户点扩展弹窗）；
          //   NaN / 非数字       → 400（绝不静默降级成默认值或无限等待）。
          let limit
          try {
            limit = timeoutLimitMs(body.timeoutMs)
          } catch (error) {
            return send(400, { error: String(error?.message ?? error) })
          }
          // timeoutMs 是本插件的传输层参数，pi 的 RpcCommand 没有这个字段，必须剥掉：
          // 原样透传会让 pi 收到未声明的键（契约污染，且 host-parity 会亮红）。
          const command = { ...body }
          delete command.timeoutMs
          const data = await proc.send(command, { timeoutMs: limit ?? 0 })
          // 状态回填统一交给 PiProcess.noteCommand：set_model / set_session_name / 会话替换
          // 这些命令的响应里带着新值，不回填的话 /snapshot 会一直报旧值。
          proc.noteCommand?.(body, data)
          // switch_session 之后 pi 的 get_state 不回报 cwd（rpc-types.ts:96-109 没有该字段），
          // 只能从目标会话文件的 header 里补，否则面板的 cwd 还停在 spawn 时那个目录。
          if (body.type === 'switch_session' && body.cancelled !== true && data?.cancelled !== true &&
            typeof proc.setSessionCwd === 'function') {
            const nextCwd = await readSessionCwd(body.sessionPath)
            proc.setSessionCwd(nextCwd)
          }
          // 这四条命令会把 pi 内部的会话指针挪到别处（甚至换掉 sessionFile）。旧事件留在
          // 缓冲里，面板下一次重连回放就会把两个会话混着渲染，所以成功即清空。
          // 判定放在 send 之后：失败的命令（比如 clone 无叶子节点）不该丢事件。
          if (SESSION_REPLACING_COMMANDS.has(body.type) && body.cancelled !== true && data?.cancelled !== true) {
            proc.resetEvents?.()
            // 新会话的 sessionFile/sessionId 只有 get_state 才给得出。等一小会儿再返回：
            // 客户端紧接着那次 /snapshot 就能看到正确的会话身份，而不是 null 要再补一次。
            if (typeof proc.refreshState === 'function') {
              await Promise.race([proc.refreshState({ timeoutMs: SPAWN_STATE_TIMEOUT_MS }), delay(POST_SPAWN_STATE_WAIT_MS)])
            }
          }
          return send(200, { ok: true, data })
        }
        if (method === 'POST' && tail === '/respond') {
          const contentType = String(req.headers['content-type'] ?? '')
          if (contentType.toLowerCase().indexOf('application/json') === -1) return send(415, { error: 'content-type must be application/json' })
          const body = await readJsonBody(req)
          if (body === null || typeof body !== 'object' || Array.isArray(body)) return send(400, { error: 'body must be a JSON object' })
          const requestId = typeof body.id === 'string' ? body.id : ''
          if (requestId === '') return send(400, { error: 'body requires a non-empty string id' })
          if (!proc.pendingUi.has(requestId)) return send(409, { error: 'no such request id' })
          // id 一个字符都不能改：pi 侧只按 response.id 去 pendingExtensionRequests 里取
          // resolver（rpc-mode.ts:784-798），改了就永远对不上。
          const payload = { id: requestId }
          if (body.cancelled === true) payload.cancelled = true
          else if (typeof body.confirmed === 'boolean') payload.confirmed = body.confirmed
          else if (typeof body.value === 'string') payload.value = body.value
          // 三个字段一个都没有 = 客户端写错了（要取消得显式 cancelled:true）。
          // 这里不能猜：猜成 cancelled 会让一个本想确认的对话框静默取消。
          else return send(400, { error: 'respond requires value, confirmed or cancelled' })
          proc.respond(payload)
          return send(200, { ok: true })
        }
        if (method === 'POST' && tail === '/reset') {
          const result = proc.resetEvents()
          return send(200, { ok: true, eventSeq: result.eventSeq })
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

/**
 * 把一条消息里的 image 块换成 `image-stub`（不带 base64）。
 *
 * 为什么要换：图片占历史体量的 **88.2%**（实测 48.6MB / 55.1MB）。面板首屏只需要
 * 知道「这里有一张图、多大、什么类型」，真实像素走 `/images/:id` 按需取 —— 这样
 * 打开一个 3000 条 / 116 图的会话才不会被几十 MB 的 base64 拖死。
 *
 * stub 必须带 `id`：它是回取原图的句柄，没有它面板就永远看不到图（能力缺失）。
 * 非图片块一律原样返回 —— 这条函数只做一件窄事。
 */
export function stubImagesInMessage(message, imageIdOf) {
  if (message === null || typeof message !== 'object' || !Array.isArray(message.content)) return message
  let changed = false
  const content = message.content.map((block, blockIndex) => {
    if (block === null || typeof block !== 'object' || block.type !== 'image') return block
    changed = true
    const data = typeof block.data === 'string' ? block.data : (typeof block.source?.data === 'string' ? block.source.data : '')
    return {
      type: 'image-stub',
      id: imageIdOf(block, blockIndex),
      mimeType: typeof block.mimeType === 'string' ? block.mimeType : 'image/png',
      bytes: data.length,
    }
  })
  return changed ? { ...message, content } : message
}

/**
 * 历史消息分页 + 图片占位。
 *
 * 契约（面板与 TUI 共用的语义，见 docs/performance-acceptance.md §1.2 判据 D）：
 *  - `before`：无名/非数字/≤0 表示「要最新一页」；否则要 `seq < before` 的那些。
 *  - 返回 `{ messages, total, hasMore, nextBefore }`：
 *      `total`     = 分页前的完整条数（面板据此显示「共 N 条」并决定要不要「加载更早」）；
 *      `hasMore`   = 还有更早的可以翻；
 *      `nextBefore`= 下一次翻页要传的 before（= 本页第一条的 seq）。
 *  - 图片一律换成 `image-stub`；要真实像素走 `/images/:id`。
 *
 * 注意 `seq` 是**在完整列表里的下标**，不是数组下标偏移 —— 翻页时前后两页能凭它对齐，
 * 且面板的 `key` 不会因为翻页而变。
 */
export function paginateHistory(list, options = {}) {
  const all = Array.isArray(list) ? list : []
  const limitRaw = Number(options.limit)
  const limit = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(Math.floor(limitRaw), HISTORY_PAGE_MAX)
    : HISTORY_PAGE_SIZE
  const beforeRaw = Number(options.before)
  const before = Number.isFinite(beforeRaw) && beforeRaw > 0 ? Math.floor(beforeRaw) : all.length
  const end = Math.min(before, all.length)
  const start = Math.max(0, end - limit)
  const imageIdOf = typeof options.imageIdOf === 'function' ? options.imageIdOf : () => null
  const messages = []
  for (let i = start; i < end; i += 1) {
    const stubbed = stubImagesInMessage(all[i], (block, blockIndex) => imageIdOf(block, i, blockIndex))
    messages.push({ ...stubbed, seq: i })
  }
  return {
    messages,
    total: all.length,
    hasMore: start > 0,
    nextBefore: start,
  }
}

/**
 * 历史图片的**回取表**（0.14.0）。
 *
 * 为什么需要它：`get_messages` 现在只下发 `image-stub`（不带 base64，否则一次 55MB）。
 * 面板要真正渲染某张图时必须能取回像素，而有两条路：
 *   ① 取图时重新调 `get_messages` 再定位 —— 那等于把 55MB 又拉一遍，白改；
 *   ② 分页时把图片**顺手登记**进这张表，取图 O(1)。
 * 选 ②。表是 per-session 的有界 LRU：图片是"看过就可以再取"的派生数据，
 * 不是真相，丢了大不了重新分页一次。
 *
 * id 形如 `<sessionId>:<seq>:<blockIndex>`，取图时**只在本表里查**，
 * 绝不从 id 反推文件路径 —— 否则就是一个路径穿越入口。
 */
const IMAGE_CACHE_LIMIT = 240
function createImageStore() {
  const entries = new Map()
  const order = []
  return {
    /** 登记一张图，返回它的 id（同一张图重复登记覆盖，不增长）。 */
    remember(imageId, mimeType, data) {
      if (typeof imageId !== 'string' || imageId === '' || typeof data !== 'string' || data === '') return null
      if (!entries.has(imageId)) order.push(imageId)
      entries.set(imageId, { mimeType: typeof mimeType === 'string' && mimeType !== '' ? mimeType : 'image/png', data })
      while (order.length > IMAGE_CACHE_LIMIT) {
        const evicted = order.shift()
        entries.delete(evicted)
      }
      return imageId
    },
    get(imageId) {
      return entries.get(imageId) ?? null
    },
    size() {
      return entries.size
    },
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

/** 等 ms 毫秒（用于给「可选等待」设上限）。unref 掉计时器，不拖住进程退出。 */
function delay(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

/**
 * 把目录参数归一成绝对路径（分隔符统一、去尾斜杠、相对路径落到底）。
 *
 * 为什么必须归一：workspace 来自配置，可能写成 'C:/Users/x/pi-workspace'，而 entries
 * 里的 path 是用 path.join 拼的（反斜杠）。面板要拿 dir 与 entry.path 做比较/拼面包屑，
 * 两种分隔符混在一起就会「明明在同一个目录却判不相等」。
 */
function normalizeDir(dir) {
  const text = typeof dir === 'string' ? dir.trim() : ''
  if (text === '') return ''
  return path.resolve(text)
}

/** 查询参数的条数：非数字/非正数用默认值，超过上限就截到上限。 */
function clampCount(raw, fallback, max) {
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.min(Math.floor(value), max)
}

/**
 * 列一个目录的直接子项（不递归，只读）。
 *
 * 为什么不用 readdir：opendir + withFileTypes 能一次拿到类型，且在 Windows 上对
 * 无权限的子项是逐条报错而不是整体失败——这里对单条失败直接跳过，不让一个坏
 * 入口毁掉整次补全。
 *
 * @returns {Promise<{ dir: string, entries: Array<{name:string,path:string,type:'file'|'dir',size:number|null,mtime:string|null}>, truncated: boolean }>}
 */
async function listDirectory({ dir, query = '', limit = FILES_DEFAULT_LIMIT }) {
  let handle
  try {
    handle = await fs.promises.opendir(dir)
  } catch (error) {
    const failure = new Error('no such directory')
    failure.statusCode = error?.code === 'ENOTDIR' || error?.code === 'ENOENT' ? 404 : 500
    throw failure
  }
  const needle = query.trim().toLowerCase()
  const entries = []
  let truncated = false
  try {
    for await (const dirent of handle) {
      const name = dirent.name
      if (needle !== '' && name.toLowerCase().indexOf(needle) === -1) continue
      let isDir = dirent.isDirectory()
      let isFile = dirent.isFile()
      // 符号链接只按目标判类型用于展示，绝不跟进去递归/展开。
      if (dirent.isSymbolicLink()) {
        isDir = false
        isFile = true
      }
      if (!isDir && !isFile) continue
      const entryPath = path.join(dir, name)
      let size = null
      let mtime = null
      if (isFile) {
        try {
          const info = await fs.promises.stat(entryPath)
          size = info.size
          mtime = new Date(info.mtimeMs).toISOString()
        } catch { /* 读不到就留空，单条跳过信息而不是整请求失败 */ }
      }
      entries.push({ name, path: entryPath, type: isDir ? 'dir' : 'file', size, mtime })
    }
  } catch { /* 迭代中途出错：保留已收集的部分 */ }
  // 目录优先，同类按 name 升序（面板里「进目录」永远排在文件前面）。
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  })
  if (entries.length > limit) {
    entries.length = limit
    truncated = true
  }
  return { dir, entries, truncated }
}

/**
 * 列一个目录里的**子目录**（工作目录选择抽屉用，只读、不递归）。
 *
 * 与 listDirectory 的区别：面板要的是「往下走进哪个目录」，文件在这里是噪声，
 * 所以只留 type==='dir'。符号链接一律跳过（不 stat、不跟随）——目标可能是网络盘
 * 或另一个盘符，跟进去会让抽屉在别人的文件树里游荡。
 *
 * writable 只是给面板一个「能不能在这里开会话」的提示，不可写并不影响浏览：
 * pi 自己会在 POST /sessions 时报错，所以这里不能用 403/404 把用户挡在门外。
 *
 * @returns {Promise<{ dir: string, parent: string|null, writable: boolean, entries: Array<{name:string,path:string}>, truncated: boolean }>}
 */
async function listDirectories({ dir, query = '', limit = FILES_DEFAULT_LIMIT }) {
  let handle
  try {
    handle = await fs.promises.opendir(dir)
  } catch (error) {
    // 与 listDirectory 同一套语义：路径不存在 / 不是目录都是 404，其余是 500。
    const failure = new Error('no such directory')
    failure.statusCode = error?.code === 'ENOTDIR' || error?.code === 'ENOENT' ? 404 : 500
    throw failure
  }
  const needle = query.trim().toLowerCase()
  const entries = []
  let truncated = false
  try {
    for await (const dirent of handle) {
      // dirent 的类型来自 lstat 语义：符号链接这里 isDirectory() 为 false，天然被跳过。
      if (!dirent.isDirectory()) continue
      const name = dirent.name
      if (needle !== '' && name.toLowerCase().indexOf(needle) === -1) continue
      entries.push({ name, path: path.join(dir, name) })
    }
  } catch { /* 迭代中途出错：保留已收集的部分，不让一个坏入口毁掉整次浏览 */ }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
  if (entries.length > limit) {
    entries.length = limit
    truncated = true
  }
  // 到盘符根 / 文件系统根时 dirname 会回指自己，此时没有「上一级」。
  const parentDir = path.dirname(dir)
  const parent = parentDir === dir ? null : parentDir
  let writable = false
  try {
    await fs.promises.access(dir, fs.constants.W_OK)
    writable = true
  } catch { /* 只读目录 / 权限不足：照样能把目录列出来，只是不能在这里开会话 */ }
  return { dir, parent, writable, entries, truncated }
}

/**
 * 面板预览能直接渲染的图片类型。只认扩展名，不嗅探魔数：
 * 预览失败时面板显示「无法预览」，代价可见；嗅探错误反而会让二进制被当图片塞进 img。
 */
const IMAGE_MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
}

/** 文本类扩展名 → MIME。仅用于让面板选择 markdown / 代码 / 纯文本三种渲染器。 */
const TEXT_MIME_BY_EXT = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.jsx': 'text/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xml': 'text/xml',
  '.yml': 'text/yaml',
  '.yaml': 'text/yaml',
  '.toml': 'text/toml',
  '.sh': 'text/x-shellscript',
  '.ps1': 'text/x-powershell',
  '.bat': 'text/x-batch',
  '.py': 'text/x-python',
  '.rs': 'text/x-rust',
  '.go': 'text/x-go',
  '.java': 'text/x-java',
  '.sql': 'text/x-sql',
  '.diff': 'text/x-diff',
  '.patch': 'text/x-diff',
  '.log': 'text/plain',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
}

/**
 * 读一个文件，切成面板能直接呈现的三种形态：text / image / binary。
 *
 * 为什么把自己限死在「一次性读一小段」：面板是只读预览，用户要的是「看一眼交接单写了什么」，
 * 不是把 200MB 日志载入浏览器。文本走 UTF-8 解码、图片走 base64 data URL、其余只回元信息，
 * 面板据此显示「无法预览」而不是把乱码涂满屏幕。
 *
 * @returns {Promise<{ ok: true, path: string, name: string, dir: string, size: number, mtime: string, kind: 'text'|'image'|'binary', mimeType: string, text?: string, data?: string, truncated: boolean }>}
 */
async function readPreviewFile(target) {
  let info
  try {
    info = await fs.promises.stat(target)
  } catch (error) {
    const failure = new Error(error?.code === 'ENOENT' ? 'no such file' : 'cannot read file')
    failure.statusCode = error?.code === 'ENOENT' ? 404 : 500
    throw failure
  }
  if (info.isDirectory()) {
    // 目录不是「文件」：面板点开目录没有意义，明确回 400 而不是渲染空内容。
    const failure = new Error('not a file')
    failure.statusCode = 400
    throw failure
  }
  const ext = path.extname(target).toLowerCase()
  const base = {
    ok: true,
    path: target,
    name: path.basename(target),
    dir: path.dirname(target),
    size: info.size,
    mtime: info.mtime.toISOString(),
  }
  const imageMime = IMAGE_MIME_BY_EXT[ext]
  if (imageMime !== undefined) {
    if (info.size > FILE_IMAGE_MAX_BYTES) return { ...base, kind: 'binary', mimeType: imageMime, truncated: false }
    const bytes = await fs.promises.readFile(target)
    return { ...base, kind: 'image', mimeType: imageMime, data: bytes.toString('base64'), truncated: false }
  }
  // 文本：多读一个字节用来判「是否超限」，避免为了知道长度而 stat 两次。
  let handle
  try {
    handle = await fs.promises.open(target, 'r')
  } catch (error) {
    const failure = new Error('cannot read file')
    failure.statusCode = error?.code === 'ENOENT' ? 404 : 500
    throw failure
  }
  try {
    const buffer = Buffer.allocUnsafe(Math.min(info.size, FILE_TEXT_MAX_BYTES) + 1)
    const read = await handle.read(buffer, 0, buffer.length, 0)
    const slice = buffer.subarray(0, read.bytesRead)
    // NUL 字节判定：Git 用同样的判据区分文本/二进制，误判率在真实工程文件上足够低。
    const probe = slice.subarray(0, Math.min(slice.length, FILE_BINARY_PROBE_BYTES))
    if (probe.indexOf(0) !== -1) {
      return { ...base, kind: 'binary', mimeType: 'application/octet-stream', truncated: false }
    }
    const truncated = info.size > FILE_TEXT_MAX_BYTES || read.bytesRead > FILE_TEXT_MAX_BYTES
    const text = slice.subarray(0, Math.min(slice.length, FILE_TEXT_MAX_BYTES)).toString('utf8')
    return {
      ...base,
      kind: 'text',
      mimeType: TEXT_MIME_BY_EXT[ext] ?? 'text/plain',
      text,
      truncated,
    }
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * 在系统文件管理器里定位 target（父目录打开 + 选中该文件）。
 *
 * Windows：explorer.exe /select,"<path>"。注意 explorer 的退出码不可信（即使成功也常回 1），
 * 所以只判「进程有没有起来」，并按 REVEAL_SPAWN_WAIT_MS 设上限 —— 等它退出可能几秒。
 * 先把路径 stat 一遍：不存在就抛 ENOENT，让上层回 404 而不是弹出一个空文件夹。
 *
 * POSIX：没有统一的「选中」语义，退化为打开父目录（macOS 用 open -R 可以选中）。
 */
function revealInFileManager(target) {
  return new Promise((resolve, reject) => {
    let info
    try {
      info = fs.statSync(target)
    } catch (error) {
      reject(error)
      return
    }
    const dir = info.isDirectory() ? target : path.dirname(target)
    const args = process.platform === 'win32'
      ? ['/select,' + target]
      : process.platform === 'darwin'
        ? ['-R', target]
        : [dir]
    const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
    let settled = false
    let child
    try {
      child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: false })
    } catch (error) {
      reject(error)
      return
    }
    const finish = error => {
      if (settled) return
      settled = true
      if (error === undefined) resolve()
      else reject(error)
    }
    // explorer.exe 常常把命令转交给已有实例后立刻以非 0 退出：只要 spawn 成功就算派出去了。
    const timer = setTimeout(() => finish(), REVEAL_SPAWN_WAIT_MS)
    if (typeof timer.unref === 'function') timer.unref()
    child.on('error', error => { clearTimeout(timer); finish(error) })
    child.on('exit', () => { clearTimeout(timer); finish() })
    if (typeof child.unref === 'function') child.unref()
  })
}

/** 盘符探测的缓存窗口：插拔 U 盘/网络盘后最多晚 10s 出现，避免每次浏览都扫 26 个根。 */
const ROOTS_TTL_MS = 10000
let rootsCache = { at: 0, items: [] }

/**
 * 列出本机可达的文件系统根。
 *
 * 为什么需要：目录浏览从工作目录逐级往上只能走到当前盘符的根（C:\），
 * 用户在 D:/E:/F: 上的工程永远选不到。Windows 上探 A-Z 各盘的根是否可 stat
 * （实测四盘全扫约 3ms），POSIX 上只有 '/'。
 *
 * 失败一律跳过而不是抛错——一个不可读的盘符不该毁掉整个目录浏览。
 *
 * @returns {Promise<Array<{ name: string, path: string }>>}
 */
async function listRoots() {
  const now = Date.now()
  if (rootsCache.items.length > 0 && now - rootsCache.at < ROOTS_TTL_MS) return rootsCache.items
  let items = []
  if (process.platform === 'win32') {
    const probe = []
    for (let code = 65; code <= 90; code += 1) {
      const letter = String.fromCharCode(code) + ':'
      probe.push(
        fs.promises.stat(letter + path.sep).then(
          (info) => (info.isDirectory() ? { name: letter, path: letter + path.sep } : null),
          () => null,
        ),
      )
    }
    items = (await Promise.all(probe)).filter((item) => item !== null)
  } else {
    items = [{ name: '/', path: '/' }]
  }
  rootsCache = { at: now, items }
  return items
}

/**
 * 读 pi 包内的 CHANGELOG.md（/changelog，契约 disposition:'local'）。
 *
 * 只在已知的包根附近找两层：pi 的包根推导见 buildSelfCheck（bundle → 包根），
 * 有些发行形态把包放在上一级，所以向上两层兜一下。找不到也返回 200，客户端
 * 据此显示「无 changelog」，不需要区分 404。
 */
function readChangelog(packageDir) {
  const candidates = []
  const start = typeof packageDir === 'string' ? packageDir.trim() : ''
  if (start !== '') {
    let cursor = start
    for (let depth = 0; depth < 3; depth += 1) {
      candidates.push(path.join(cursor, 'CHANGELOG.md'))
      const parent = path.dirname(cursor)
      if (parent === cursor) break
      cursor = parent
    }
  }
  for (const candidate of candidates) {
    let fd
    try {
      const info = fs.statSync(candidate)
      if (!info.isFile()) continue
      const size = info.size
      fd = fs.openSync(candidate, 'r')
      const length = Math.min(size, CHANGELOG_MAX_BYTES)
      const buffer = Buffer.alloc(length)
      const read = length === 0 ? 0 : fs.readSync(fd, buffer, 0, length, 0)
      return {
        ok: true,
        path: candidate,
        text: buffer.subarray(0, read).toString('utf8'),
        truncated: size > length,
      }
    } catch { /* 换下一个候选 */ } finally {
      if (fd !== undefined) { try { fs.closeSync(fd) } catch { /* ignore */ } }
    }
  }
  return { ok: false, path: null, text: '', truncated: false }
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
 * schema 解析失败时导出 undefined，插件其余功能不受影响。
 */
export const Config = schema === undefined
  ? undefined
  : schema.object({
    cliPath: schema.string().default('').description('pi CLI 入口文件或包目录。留空自动探测：插件 .runtime → 插件 node_modules → 全局 npm → PATH').volatile(),
    nodePath: schema.string().default('').description('node 可执行文件。留空自动探测 PATH 上的 node').volatile(),
    workspace: schema.string().default('').description('新会话默认工作区。留空用 ~/pi-workspace').volatile(),
    extraArgs: schema.string().default('').description('追加给 pi 的额外参数（空格分隔），例如 --model openai/gpt-4o').volatile(),
    // 下面三项按字符串暴露：宿主的表单只认 string，布尔/枚举在 volatile 热更新下
    // 类型不稳定。读取端一律经 asBool / trim 归一，见 spawnSession。
    persist: schema.string().default('true').description('会话是否落盘：true = 落盘（pi 默认），false = 加 --no-session，退出即丢').volatile(),
    startup: schema.string().default('continue').description("新会话开局方式：continue = 接上该目录最近的会话，new = 全新会话").volatile(),
    sessionName: schema.string().default('').description('新会话写入 session_info 的名字（pi --name）。留空不设名').volatile(),
  })

if (schema === undefined) {
  console.warn('[superpi] @deepseek-ai/schemastery 解析失败：插件详情页没有配置区（侧栏面板与运行时自举不受影响）')
}


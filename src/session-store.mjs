/**
 * pi 会话文件（JSONL）的只读枚举层。
 *
 * 语义必须与 pi 自己的 SessionManager 保持一致，否则面板里看到的会话列表与
 * CLI /resume 看到的不一样。权威实现：
 *  - 目录 slug：pi-main/packages/coding-agent/src/core/session-manager.ts:592-597
 *  - agentDir：.../src/config.ts:630-636（PI_CODING_AGENT_DIR 或 ~/.pi/agent）
 *  - 会话目录覆盖：.../src/main.ts:740-744（--session-dir → PI_CODING_AGENT_SESSION_DIR → settings.sessionDir）
 *  - 列表构造：.../src/core/session-manager.ts:802-897 buildSessionInfo
 *  - 排序：.../src/core/session-manager.ts:935-937 sortSessionInfos（modified 降序）
 *
 * 与 pi 的唯一主动偏差：超大文件只读首尾窗口（pi 全量流式读），因此
 * truncated=true 时 messageCount 是近似值，由 messageCountApproximate 标注。
 *
 * 本文件不 import 任何 @deepseek-ai/* 包，只用 node 内建。
 */

import { createReadStream } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** 超过这个大小改用首尾窗口读取。 */
export const LARGE_FILE_BYTES = 4 * 1024 * 1024
/** 首尾各读多少字节。 */
export const WINDOW_BYTES = 256 * 1024
/** 列表默认返回条数（GET /sessions/history 的默认值）。 */
export const DEFAULT_LIMIT = 20
/** 列表硬上限（再多也没人看，且会拖慢目录扫描）。 */
export const MAX_LIMIT = 200
export const DEFAULT_CONFIG_DIR_NAME = '.pi'
export const AGENT_DIR_ENV = 'PI_CODING_AGENT_DIR'
export const SESSION_DIR_ENV = 'PI_CODING_AGENT_SESSION_DIR'
export const NO_MESSAGES = '(no messages)'

/** 反斜杠常量：本文件里所有正则都从这里拼，避免与 JSON/模板转义打架。 */
const BACKSLASH = String.fromCharCode(92)
/** 路径分隔符集合（/ 与 \），对应 pi 的 /[/\\:]/g。 */
const SEP_CLASS = '[/' + BACKSLASH + BACKSLASH + ':]'
const LEADING_SEP = new RegExp('^[/' + BACKSLASH + BACKSLASH + ']')
const ANY_SEP = new RegExp(SEP_CLASS, 'g')

/**
 * 展开 ~ 与 %VAR% / $VAR%，然后绝对化（对齐 pi 的 normalizePath + resolvePath）。
 *
 * base 是相对路径的锚点，默认 process.cwd()。列历史/解析 --session 时必须传调用方的
 * 工作目录（会话的 cwd 或 workspace），否则相对路径会被解析到 host 进程的目录上。
 */
export function expandUserPath(input, { env = process.env, home = homedir(), base = process.cwd() } = {}) {
  if (typeof input !== 'string' || input.trim() === '') return ''
  let text = input.trim()
  if (text === '~') text = home
  else if (text.startsWith('~/') || text.startsWith('~' + BACKSLASH)) text = join(home, text.slice(2))
  text = text.replace(/%([^%]+)%/g, (whole, name) => {
    const value = env[name]
    return value === undefined ? whole : value
  })
  text = text.replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, braced, bare) => {
    const value = env[braced === undefined ? bare : braced]
    return value === undefined ? whole : value
  })
  return resolve(base, text)
}

/** pi 的 agentDir：环境变量优先，否则 <home>/.pi/agent。 */
export function resolveAgentDir({ env = process.env, home = homedir(), configDirName = DEFAULT_CONFIG_DIR_NAME } = {}) {
  const fromEnv = env[AGENT_DIR_ENV]
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return expandUserPath(fromEnv, { env, home })
  return join(home, configDirName, 'agent')
}

/**
 * cwd → 会话子目录名。逐字符照抄 pi（session-manager.ts:595）：
 *   '--' + resolvedCwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-') + '--'
 * 例：C:\Users\PC\pi-workspace → --C--Users-PC-pi-workspace--
 */
export function sessionDirName(cwd, { env = process.env, home = homedir() } = {}) {
  const raw = typeof cwd === 'string' ? cwd.trim() : ''
  if (raw === '') return ''
  const resolvedCwd = expandUserPath(raw, { env, home }) || resolve(raw)
  return '--' + resolvedCwd.replace(LEADING_SEP, '').replace(ANY_SEP, '-') + '--'
}

/** 某个 cwd 的会话目录（纯计算，不建目录——pi 的 getDefaultSessionDir 会 mkdir，列历史时不能有副作用）。 */
export function sessionDirPathFor(cwd, { agentDir, env = process.env, home = homedir() } = {}) {
  const base = agentDir === undefined || agentDir === '' ? resolveAgentDir({ env, home }) : agentDir
  return join(base, 'sessions', sessionDirName(cwd, { env, home }))
}

/** 会话根目录（所有项目）。 */
export function sessionsRoot(agentDir) {
  return join(agentDir, 'sessions')
}

/**
 * 会话根目录解析结果。override=true 表示用户用 PI_CODING_AGENT_SESSION_DIR（或显式 sessionDir）
 * 指定了单一目录——此时 pi 不再按 cwd 分子目录，而是列这个目录再按 header.cwd 过滤
 * （session-manager.ts:1925-1945 的 filterCwd 逻辑）。
 */
export function sessionRootDir({ agentDir, env = process.env, home = homedir(), sessionDir = '' } = {}) {
  if (typeof sessionDir === 'string' && sessionDir.trim() !== '') {
    return { dir: expandUserPath(sessionDir, { env, home }), override: true }
  }
  const override = env[SESSION_DIR_ENV]
  if (typeof override === 'string' && override.trim() !== '') {
    return { dir: expandUserPath(override, { env, home }), override: true }
  }
  const base = agentDir === undefined || agentDir === '' ? resolveAgentDir({ env, home }) : agentDir
  return { dir: join(base, 'sessions'), override: false }
}

/** 路径相等（Windows 大小写不敏感），对应 pi 的 pathsEqual。 */
export function samePath(a, b, { caseInsensitive = process.platform === 'win32' } = {}) {
  const normalize = value => {
    if (typeof value !== 'string') return ''
    let text = value.trim().replace(ANY_SEP, BACKSLASH)
    while (text.length > 1 && text.charAt(text.length - 1) === BACKSLASH) text = text.slice(0, -1)
    return caseInsensitive ? text.toLowerCase() : text
  }
  const left = normalize(a)
  return left !== '' && left === normalize(b)
}

export function parseLine(line) {
  if (typeof line !== 'string' || line.trim() === '') return null
  try {
    const parsed = JSON.parse(line)
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** 对齐 session-manager.ts:777-786 extractTextContent。 */
export function extractTextContent(message) {
  if (message === null || typeof message !== 'object') return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join(' ')
}

/** 对齐 session-manager.ts:788-800 getMessageActivityTime。 */
export function messageActivityTime(entry) {
  const message = entry === null || typeof entry !== 'object' ? null : entry.message
  if (message === null || typeof message !== 'object') return undefined
  if (typeof message.role !== 'string' || !('content' in message)) return undefined
  if (message.role !== 'user' && message.role !== 'assistant') return undefined
  if (typeof message.timestamp === 'number') return message.timestamp
  const t = new Date(entry.timestamp).getTime()
  return Number.isNaN(t) ? undefined : t
}

/** 跨窗口复用的累积状态（head + tail 两段拼成一个完整摘要）。 */
export function createSummaryState() {
  return {
    header: null,
    name: undefined,
    messageCount: 0,
    firstMessage: '',
    lastUserMessage: '',
    lastActivityTime: undefined,
    invalid: false,
  }
}

export function absorbLines(state, lines) {
  for (const line of lines) {
    const entry = parseLine(line)
    if (entry === null) continue
    if (state.header === null) {
      if (entry.type !== 'session') {
        // 首条记录不是 session header → 不是 pi 会话文件（pi 也直接判 null）。
        state.invalid = true
        return state
      }
      state.header = entry
      continue
    }
    if (entry.type === 'session_info') {
      // 与 pi 一致：最新一条 session_info 生效，空名字视为清空。
      state.name = typeof entry.name === 'string' && entry.name.trim() !== '' ? entry.name.trim() : undefined
      continue
    }
    if (entry.type !== 'message') continue
    state.messageCount += 1
    const activity = messageActivityTime(entry)
    if (typeof activity === 'number') state.lastActivityTime = Math.max(state.lastActivityTime ?? 0, activity)
    const message = entry.message
    if (message === null || typeof message !== 'object' || typeof message.role !== 'string' || !('content' in message)) continue
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const text = extractTextContent(message)
    if (text === '') continue
    if (message.role === 'user') {
      if (state.firstMessage === '') state.firstMessage = text
      state.lastUserMessage = text
    }
  }
  return state
}

/** state → 对外 SessionInfo（字段命名对齐 pi 的 SessionInfo；缺省字段给 null 而不是省略，便于客户端判断）。 */
export function toSessionInfo(state, { filePath, mtimeMs, truncated = false }) {
  if (state.header === null) return null
  const header = state.header
  const headerTime = typeof header.timestamp === 'string' ? new Date(header.timestamp).getTime() : Number.NaN
  const modifiedMs =
    typeof state.lastActivityTime === 'number' && state.lastActivityTime > 0
      ? state.lastActivityTime
      : !Number.isNaN(headerTime)
        ? headerTime
        : mtimeMs
  const createdMs = Number.isNaN(headerTime) ? mtimeMs : headerTime
  return {
    path: filePath,
    id: typeof header.id === 'string' ? header.id : '',
    cwd: typeof header.cwd === 'string' ? header.cwd : '',
    name: state.name === undefined ? null : state.name,
    parentSessionPath: typeof header.parentSession === 'string' ? header.parentSession : null,
    created: new Date(createdMs).toISOString(),
    modified: new Date(modifiedMs).toISOString(),
    messageCount: state.messageCount,
    messageCountApproximate: truncated,
    firstMessage: state.firstMessage !== '' ? state.firstMessage : NO_MESSAGES,
    lastMessage:
      state.lastUserMessage !== '' ? state.lastUserMessage : state.firstMessage !== '' ? state.firstMessage : NO_MESSAGES,
    truncated,
  }
}

/**
 * 把一段窗口文本切成完整行。
 * dropLeadingPartial=true 用于文件尾部窗口：首段可能是从中间截断的残行。
 * 尾段残行（没有以换行结尾）一律丢弃——跨窗口拼接会把一条记录拆成两半。
 */
export function splitWindowLines(text, { dropLeadingPartial = false } = {}) {
  if (typeof text !== 'string' || text === '') return []
  const lines = text.split('\n')
  if (dropLeadingPartial && lines.length > 0) lines.shift()
  lines.pop()
  return lines.filter(line => line !== '')
}

async function readWindow(filePath, start, length) {
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, start)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

async function readWholeFile(filePath) {
  const chunks = []
  for await (const chunk of createReadStream(filePath, { encoding: 'utf8' })) chunks.push(chunk)
  return chunks.join('')
}

/**
 * 读单个会话文件 → SessionInfo（坏文件/非 pi 会话返回 null）。
 * 只做文件级解析，不判断 cwd 归属。
 */
export async function readSessionFile(filePath, { largeFileBytes = LARGE_FILE_BYTES, windowBytes = WINDOW_BYTES } = {}) {
  let stats
  try {
    stats = await stat(filePath)
  } catch {
    return null
  }
  if (!stats.isFile()) return null
  const size = stats.size
  const state = createSummaryState()
  try {
    if (size <= largeFileBytes) {
      absorbLines(state, splitWindowLines(await readWholeFile(filePath)))
      return toSessionInfo(state, { filePath, mtimeMs: stats.mtimeMs, truncated: false })
    }
    // 超大文件：头窗口拿 header/firstMessage，尾窗口拿 name/lastMessage/最近活动时间。
    const head = await readWindow(filePath, 0, windowBytes)
    absorbLines(state, splitWindowLines(head))
    if (state.header === null) return null
    const tailStart = Math.max(0, size - windowBytes)
    const tail = await readWindow(filePath, tailStart, windowBytes)
    absorbLines(state, splitWindowLines(tail, { dropLeadingPartial: tailStart > 0 }))
    return toSessionInfo(state, { filePath, mtimeMs: stats.mtimeMs, truncated: true })
  } catch {
    return null
  }
}

async function mapConcurrent(items, concurrency, mapper) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      try {
        results[index] = await mapper(items[index], index)
      } catch {
        results[index] = null
      }
    }
  })
  await Promise.all(workers)
  return results
}

async function isDirectory(target) {
  try {
    const stats = await stat(target)
    return stats.isDirectory()
  } catch {
    return false
  }
}

/**
 * cwd 对应的候选目录。
 * 先按 slug 精确命中；未命中再在 sessions/ 下做一次大小写不敏感匹配
 * （NTFS 大小写不敏感，客户端传进来的 cwd 大小写与落盘时不一致也能找到）。
 */
async function cwdSessionDirs({ root, cwd, env, home }) {
  const expected = sessionDirName(cwd, { env, home })
  if (expected === '') return []
  const exact = join(root, expected)
  if (await isDirectory(exact)) return [exact]
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const lower = expected.toLowerCase()
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.toLowerCase() === lower) return [join(root, entry.name)]
  }
  return []
}

function clampLimit(value) {
  const requested = Number(value)
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_LIMIT
  return Math.min(Math.floor(requested), MAX_LIMIT)
}

/**
 * 列出会话。
 * @param {{ agentDir?: string, sessionDir?: string, cwd?: string, limit?: number, env?: object, home?: string }} options
 *   cwd 省略/为空 → 扫 sessions/ 下所有项目子目录（等价 pi 的 listAll）。
 * @returns {Promise<Array<object>>} modified 降序
 */
export async function listSessions(options = {}) {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const agentDir = options.agentDir === undefined || options.agentDir === '' ? resolveAgentDir({ env, home }) : options.agentDir
  const limit = clampLimit(options.limit)
  const cwd = typeof options.cwd === 'string' ? options.cwd.trim() : ''
  const root = sessionRootDir({ agentDir, env, home, sessionDir: options.sessionDir })
  const dirs = []
  if (cwd !== '') {
    for (const dir of await cwdSessionDirs({ root: root.dir, cwd, env, home })) dirs.push(dir)
    // 单目录覆盖模式：pi 不再按 cwd 分子目录，只能扫整个目录再按 header.cwd 过滤。
    if (root.override && dirs.length === 0) dirs.push(root.dir)
  } else if (root.override) {
    dirs.push(root.dir)
  } else {
    let entries
    try {
      entries = await readdir(root.dir, { withFileTypes: true })
    } catch {
      return []
    }
    for (const entry of entries) if (entry.isDirectory()) dirs.push(join(root.dir, entry.name))
  }

  const files = []
  for (const dir of dirs) {
    let names
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    for (const name of names) if (name.endsWith('.jsonl')) files.push(join(dir, name))
  }
  if (files.length === 0) return []

  const infos = await mapConcurrent(files, 8, filePath => readSessionFile(filePath, options))
  let list = infos.filter(info => info !== null)
  if (root.override && cwd !== '') list = list.filter(info => samePath(info.cwd, cwd))
  list.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime())
  return list.slice(0, limit)
}

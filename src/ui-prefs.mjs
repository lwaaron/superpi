/**
 * 面板 UI 偏好的持久化层：项目重命名 + 会话置顶 + 会话显示名。
 *
 * 为什么必须有这一层：这三件事在 pi 的 RPC 契约里都没有可用的通道。
 *  - set_session_name 改的是**会话自己**的 session_info（JSONL header），改不了项目层；
 *    面板侧的「显示名」若走它就得改写用户的会话文件，代价与风险都不该由一次重命名承担；
 *  - 「置顶」纯属面板概念，pi 的 SessionInfo 里没有这个字段。
 * 浏览器半区也没有写盘能力（插件运行在 DSH 的 web client 里，没有 fs）。
 * 所以只能由 host 用一个 JSON 文件记住它们，否则用户每次重开面板都得重新点一遍。
 *
 * 为什么是单个 JSON 而不是数据库：数据量是「个位数到几百条的小字典」，写频率是
 * 「用户手点」级别。引入 sqlite 只会换来迁移、锁、打包体积三笔债；原子写 + 全量替换足够。
 *
 * 为什么原子写（<file>.tmp-<rand> → rename）：直接覆写时若在写到一半被 kill / 断电，
 * 留下的半个 JSON 会让**整份**偏好作废（下次读盘解不动 → 全空）。rename 在同一目录内
 * 是「要么旧文件、要么新文件」，没有中间态。并发也一样：两个 POST 各写各的 tmp，
 * 最后 rename 原子地定胜负，不会互相截断。
 *
 * 为什么白名单字段：这个文件躺在用户主目录下，可能被手改、被旧版本写、被别的工具污染。
 * 只挑认识且合法的字段出来、其余一律丢弃，才能保证 GET 返回的结构永远与契约一致
 * （客户端据此判类型；缺 createdAt 会让它的排序跳）；顺带挡住 __proto__ 这类原型污染键。
 *
 * 本文件不 import 任何 @deepseek-ai/* 包，只用 node 内建。
 */

import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** 落盘结构版本号。将来改结构时靠它做迁移，不靠猜。 */
export const UI_PREFS_VERSION = 1
/** 覆盖落盘路径的环境变量名（测试与多套配置共存时用）。 */
export const UI_PREFS_ENV = 'DSH_PI_UI_PREFS'
/** 默认目录名与文件名（<home>/.dsh-pi/ui-prefs.json）。 */
export const UI_PREFS_DIR_NAME = '.dsh-pi'
export const UI_PREFS_FILE_NAME = 'ui-prefs.json'
/** 项目显示名的长度上限：再长在面板里也只会被截断，且能挡住把文件撑大的输入。 */
export const MAX_PROJECT_NAME_LENGTH = 120
/** 会话路径长度上限：Windows 的长路径极限是 32767，但 4096 已远超任何真实会话文件。 */
export const MAX_SESSION_PATH_LENGTH = 4096
/**
 * rename 的重试次数与退避基数。
 *
 * Windows 上 rename 覆盖一个正被别人打开的目标会抛 EPERM/EBUSY（杀软扫描、索引器、
 * 又一次并发的 readFile 都可能在毫秒级持有句柄）。这不是逻辑错误，退避重试即可；
 * POSIX 上几乎不会命中，所以这个循环对 Linux/macOS 是零成本。
 */
const RENAME_ATTEMPTS = 4
const RENAME_RETRY_MS = 30
/**
 * 拒绝落盘的键名（原型污染防线）。
 *
 * JSON.parse 会把 "__proto__" 建成**自有属性**，随后 `target[key] = value` 这种写法
 * 会改掉对象的原型链，让返回结构带上意料之外的继承字段。这类键在项目 key / 会话路径里
 * 没有任何合法用途，直接丢弃。
 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function nowIso() {
  return new Date().toISOString()
}

/** 等 ms 毫秒。unref 掉计时器，别拖住进程退出。 */
function delay(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 时间戳归一：能解析成日期的字符串才认，否则用兜底值（读盘容错的一环）。 */
function isoOrFallback(value, fallback) {
  if (typeof value !== 'string') return fallback
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : fallback
}

/** 400 语义的错误：路由层按 statusCode 原样回给客户端（见 index.js 的 catch）。 */
function badRequest(message) {
  const error = new Error(message)
  error.statusCode = 400
  return error
}

/**
 * 空结构。updatedAt 必须存在：客户端拿它判断「服务端这份偏好是什么时候的事」，
 * 也用它做本地缓存的失效判断。
 */
export function emptyUiPrefs(now = nowIso()) {
  return { version: UI_PREFS_VERSION, updatedAt: now, projects: {}, sessions: {} }
}

/**
 * 把任意输入（通常是 JSON.parse 的结果）归一成契约结构。
 *
 * 只做「挑字段 + 校验」，不做 IO，也不抛：坏数据在这里被静默修剪成合法结构，
 * 因为偏好文件损坏不该让面板打不开（它是装饰性数据，不是业务真相）。
 *
 * @param {unknown} raw 读到的 JSON
 * @param {{ now?: string }} [options] now = 缺失时间戳时的兜底时刻（测试注入）
 * @returns {{ version: number, updatedAt: string, projects: Record<string, object>, sessions: Record<string, object> }}
 */
export function normalizeUiPrefs(raw, { now = nowIso() } = {}) {
  const out = emptyUiPrefs(now)
  if (!isPlainObject(raw)) return out
  out.updatedAt = isoOrFallback(raw.updatedAt, now)
  if (isPlainObject(raw.projects)) {
    for (const key of Object.keys(raw.projects)) {
      const value = raw.projects[key]
      const name = typeof value === 'string' ? '' : (isPlainObject(value) && typeof value.name === 'string' ? value.name.trim() : '')
      const trimmedKey = typeof key === 'string' ? key.trim() : ''
      // 空名字 = 没有覆盖（删除覆盖的落盘表达就是「这条不存在」）。留着它会让
      // 用户删掉的覆盖在读盘后复活，这是最典型的「偏好文件越用越怪」的来源。
      if (trimmedKey === '' || FORBIDDEN_KEYS.has(trimmedKey) || name === '' || name.length > MAX_PROJECT_NAME_LENGTH) continue
      const createdAt = isoOrFallback(value.createdAt, now)
      out.projects[trimmedKey] = { name, createdAt, updatedAt: isoOrFallback(value.updatedAt, createdAt) }
    }
  }
  if (isPlainObject(raw.sessions)) {
    for (const key of Object.keys(raw.sessions)) {
      const value = raw.sessions[key]
      const trimmedPath = typeof key === 'string' ? key.trim() : ''
      if (trimmedPath === '' || trimmedPath.length > MAX_SESSION_PATH_LENGTH || FORBIDDEN_KEYS.has(trimmedPath)) continue
      if (!isPlainObject(value)) continue
      // name 与 pinned 是**两个互相独立**的偏好：会话名（pi 侧 session_info 里的名字）
      // 只存在于 JSONL header，改它要走 RPC；这里是面板侧的显示名覆盖，两者可以只存一个。
      // 所以一条记录允许只有 name、只有 pinned，或两者都有。
      const name = typeof value.name === 'string' ? value.name.trim() : ''
      const hasName = name !== '' && name.length <= MAX_PROJECT_NAME_LENGTH
      const pinned = value.pinned === true
      // 既没置顶、也没有合法名字 = 空壳条目（手改残留、或旧版本写下的 pinned:false），
      // 整条丢弃。落盘表达里「没有这条」才是「不置顶且没有名字」的唯一合法形式。
      if (!pinned && !hasName) continue
      const entry = {}
      if (pinned) entry.pinned = true
      if (hasName) entry.name = name
      const createdAt = isoOrFallback(value.createdAt, now)
      entry.createdAt = createdAt
      entry.updatedAt = isoOrFallback(value.updatedAt, createdAt)
      out.sessions[trimmedPath] = entry
    }
  }
  return out
}

/**
 * 落盘路径：环境变量 DSH_PI_UI_PREFS 优先，否则 <home>/.dsh-pi/ui-prefs.json。
 *
 * 不写死任何本机绝对路径：插件会被装到别人的机器上，路径只能由 home / 环境变量算出来。
 * 环境变量给相对路径时按进程 cwd 解析（与 repo 里其它路径参数同一套语义）。
 */
export function resolveUiPrefsPath({ env = process.env, home = homedir() } = {}) {
  const fromEnv = typeof env?.[UI_PREFS_ENV] === 'string' ? env[UI_PREFS_ENV].trim() : ''
  if (fromEnv !== '') return path.resolve(fromEnv)
  const base = typeof home === 'string' && home.trim() !== '' ? home : homedir()
  return path.join(base, UI_PREFS_DIR_NAME, UI_PREFS_FILE_NAME)
}

/**
 * 校验「项目重命名」入参（纯函数，路由与单测共用同一份判定）。
 *
 * 语义：name === '' 表示删除覆盖（回落到目录名），其余按 trim 后的值存。
 * 之所以在 host 侧 trim 而不是信任客户端：落盘内容会直接进面板标题，
 * 首尾空白在 DOM 里看不见却会让「是否同名」的比较永远不相等。
 *
 * @returns {{ key: string, name: string }}
 */
export function validateProjectInput(key, name) {
  if (typeof key !== 'string' || key.trim() === '') throw badRequest('body requires a non-empty string key')
  if (FORBIDDEN_KEYS.has(key.trim())) throw badRequest('invalid key')
  if (typeof name !== 'string') throw badRequest('body requires a string name')
  const trimmed = name.trim()
  if (trimmed.length > MAX_PROJECT_NAME_LENGTH) throw badRequest('name too long (max ' + String(MAX_PROJECT_NAME_LENGTH) + ')')
  return { key: key.trim(), name: trimmed }
}

/**
 * 校验「会话置顶」入参。
 *
 * path 原样保存（只 trim）：它是会话文件的绝对路径，客户端从历史列表里拿到的
 * 就是同一个字符串；host 侧再做 resolve / 改大小写会让「同一条会话」在两个
 * 调用方眼里变成两个 key。
 *
 * @returns {{ path: string, pinned: boolean }}
 */
export function validateSessionInput(sessionPath, pinned) {
  if (typeof sessionPath !== 'string' || sessionPath.trim() === '') throw badRequest('body requires a non-empty string path')
  const trimmed = sessionPath.trim()
  if (trimmed.length > MAX_SESSION_PATH_LENGTH) throw badRequest('path too long (max ' + String(MAX_SESSION_PATH_LENGTH) + ')')
  if (typeof pinned !== 'boolean') throw badRequest('body requires a boolean pinned')
  return { path: trimmed, pinned }
}

/**
 * 校验「会话条目补丁」入参（name / pinned 各自可选，至少给一个）。
 *
 * 为什么允许只给一个字段：置顶与显示名是两个独立偏好，面板上也是两个独立动作
 * （右键置顶 / 双击改名）。若强制同时提交，改个名字就要把当前 pinned 状态一起读出来
 * 再回传，那次读-改-写本身就是竞态来源 —— 合并语义交给 host 的 setSession 做，
 * 客户端只说「我要改什么」。
 *
 * 没给的那个字段返回 undefined（不是 false / ''）：undefined = 「别动它」，
 * 而 false / '' = 「改成 false / 清除」。两者语义相反，绝不能混用同一个哨兵值。
 *
 * @returns {{ path: string, pinned: boolean|undefined, name: string|undefined }}
 */
export function validateSessionPatch(input) {
  const body = isPlainObject(input) ? input : {}
  if (typeof body.path !== 'string' || body.path.trim() === '') throw badRequest('body requires a non-empty string path')
  const trimmedPath = body.path.trim()
  if (trimmedPath.length > MAX_SESSION_PATH_LENGTH) throw badRequest('path too long (max ' + String(MAX_SESSION_PATH_LENGTH) + ')')
  const hasPinned = body.pinned !== undefined
  if (hasPinned && typeof body.pinned !== 'boolean') throw badRequest('body requires a boolean pinned')
  const hasName = body.name !== undefined
  if (hasName && typeof body.name !== 'string') throw badRequest('body requires a string name')
  const name = hasName ? body.name.trim() : undefined
  if (hasName === true && name.length > MAX_PROJECT_NAME_LENGTH) throw badRequest('name too long (max ' + String(MAX_PROJECT_NAME_LENGTH) + ')')
  if (!hasPinned && !hasName) throw badRequest('body requires a boolean pinned or a string name')
  return { path: trimmedPath, pinned: hasPinned ? body.pinned : undefined, name }
}

/** 原子落盘时的 rename（带 Windows 句柄占用重试）。 */
async function renameWithRetry(from, to) {
  let last = null
  for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt += 1) {
    try {
      await fs.promises.rename(from, to)
      return
    } catch (error) {
      last = error
      const code = error?.code
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw error
      await delay(RENAME_RETRY_MS * (attempt + 1))
    }
  }
  throw last
}

/**
 * 建一个偏好存储。
 *
 * 所有写方法都返回**全量结构**（不是增量）：偏好只有一份小字典，让客户端每次拿全量，
 * 就不必维护两端的合并逻辑，也不会有「我这边 3 条你那边 5 条」的对账问题。
 *
 * @param {{ filePath?: string }} [options] filePath 可由调用方注入（测试用临时文件）
 */
export function createUiPrefsStore({ filePath } = {}) {
  const resolved = typeof filePath === 'string' && filePath.trim() !== '' ? path.resolve(filePath) : resolveUiPrefsPath()
  /**
   * 写操作串行队列。
   *
   * 为什么不能并发写：两个 POST 各自「读盘 → 改自己那条 → 全量写回」，
   * 交错执行时后写的那个会用旧快照覆盖掉前一个的改动（经典的 read-modify-write 丢更新）。
   * 排成一条队，每个任务看到的都是上一个任务写完之后的状态。
   * 队列挂在实例上而不是模块上：多实例（测试 / 多进程）之间本来就不该共享内存状态，
   * 跨进程的一致性由「每次操作都重新读盘」保证。
   */
  let queue = Promise.resolve()
  const run = task => {
    const result = queue.then(task, task)
    // 队列自身必须永远保持「已兑现」，否则一次 400 会把后续所有请求一起卡死；
    // 异常原样抛给本次调用方。
    queue = result.then(() => undefined, () => undefined)
    return result
  }

  /** 读盘 + 容错。文件不存在 / 坏 JSON / 结构不对 → 空结构，绝不抛。 */
  const loadFromDisk = async () => {
    let text = ''
    try {
      text = await fs.promises.readFile(resolved, 'utf8')
    } catch {
      // 第一次用（ENOENT）、权限不对、路径是个目录……都当「还没有偏好」。
      // 让面板因为读不到偏好而打不开是本末倒置的。
      return emptyUiPrefs()
    }
    try {
      return normalizeUiPrefs(JSON.parse(text))
    } catch {
      return emptyUiPrefs()
    }
  }

  /** 原子写：tmp 落在同一目录（跨盘 rename 会退化成 copy+unlink，不再原子）。 */
  const persist = async state => {
    const dir = path.dirname(resolved)
    await fs.promises.mkdir(dir, { recursive: true })
    const text = JSON.stringify(state, null, 2) + '\n'
    const tmp = resolved + '.tmp-' + randomBytes(6).toString('hex')
    try {
      await fs.promises.writeFile(tmp, text, 'utf8')
      await renameWithRetry(tmp, resolved)
    } catch (error) {
      // 失败路径也要把 tmp 收干净：否则用户主目录里会攒下一堆半截文件，
      // 而且下一次「有没有残留 tmp」的自检会被上一次的失败误导。
      try { await fs.promises.unlink(tmp) } catch { /* tmp 已经不在了 */ }
      throw error
    }
    return state
  }

  /**
   * 合并式更新一个会话条目：pinned / name 各自可选，只改提交的字段。
   *
   * 为什么是「合并」而不是「整体替换」：置顶与显示名是两个独立偏好，面板上也是两个
   * 独立动作。整体替换会逼客户端先 GET 一次拿另一半状态再回传，那次读-改-写天然有竞态
   * （两个标签页各改一项，后提交的会把对方那一项抹掉）。合并语义让 host 基于**磁盘最新
   * 内容**做改动，客户端只说「我要改什么」。
   *
   * 删除条件（唯一的「条目消失」路径）：合并后既没有 pinned:true 也没有非空 name。
   * 空壳条目（{}）留在文件里没有任何语义，还会让 GET 返回一条客户端不知道拿它干嘛的记录。
   *
   * 校验放在 run 内部（而不是外面）：方法对外永远是「返回 Promise」，入参错误以
   * rejected promise 的形式出现，调用方一句 await 就能统一处理两种失败。
   */
  const setSession = (sessionPath, patch) => run(async () => {
    const input = validateSessionPatch(isPlainObject(patch) ? { ...patch, path: sessionPath } : { path: sessionPath })
    const state = await loadFromDisk()
    const existing = state.sessions[input.path]
    // 未提供的字段沿用现值（undefined = 别动它）。
    const nextPinned = input.pinned === undefined ? existing?.pinned === true : input.pinned === true
    const currentName = typeof existing?.name === 'string' ? existing.name : ''
    const nextName = input.name === undefined ? currentName : input.name
    if (!nextPinned && nextName === '') {
      // 已经不存在时直接回现状：不写盘、不刷时间戳（幂等删除也是一次「无变化」）。
      if (existing === undefined) return state
      delete state.sessions[input.path]
    } else {
      const entry = {}
      // pinned 只在 true 时落字段，与既有落盘风格一致（false 的表达就是「没有这个字段」）。
      if (nextPinned) entry.pinned = true
      if (nextName !== '') entry.name = nextName
      // 内容无变化 → 不写盘、不刷新 updatedAt：否则客户端按 updatedAt 做的
      // 「最近改动」排序会因为一次幂等点击自己往上跳。
      const unchanged = existing !== undefined &&
        (existing.pinned === true) === nextPinned &&
        (typeof existing.name === 'string' ? existing.name : '') === nextName
      if (unchanged) return state
      entry.createdAt = existing === undefined ? nowIso() : existing.createdAt
      entry.updatedAt = nowIso()
      state.sessions[input.path] = entry
    }
    state.updatedAt = nowIso()
    return persist(state)
  })

  return {
    /** 实际落盘路径（日志 / 诊断用；客户端不需要，也在契约之外）。 */
    filePath: resolved,
    /** 读全量偏好。只读不写盘：面板一打开就 GET 一次，不该因此产生一次写。 */
    read() {
      return run(loadFromDisk)
    },
    /** 设置 / 删除项目名覆盖。name === '' → 删除这条覆盖。 */
    setProject(key, name) {
      return run(async () => {
        const input = validateProjectInput(key, name)
        const state = await loadFromDisk()
        const existing = state.projects[input.key]
        if (input.name === '') {
          if (existing === undefined) return state
          delete state.projects[input.key]
        } else if (existing !== undefined && existing.name === input.name) {
          // 同名重复保存：不写盘、不刷新 updatedAt —— 否则「最后改过」的时间会撒谎，
          // 客户端按 updatedAt 做的「最近改动」排序就会自己往上跳。
          return state
        } else {
          state.projects[input.key] = {
            name: input.name,
            // createdAt 是首次创建时间，后续更新保持不变（本仓库的强制约定，
            // 客户端用它做稳定的二级排序键）。只有这条被删掉重建才会换新值。
            createdAt: existing === undefined ? nowIso() : existing.createdAt,
            updatedAt: nowIso(),
          }
        }
        state.updatedAt = nowIso()
        return persist(state)
      })
    },
    /** 合并式更新会话条目（实现在上面的 setSession 闭包，见那里的长注释）。 */
    setSession,
    /**
     * 置顶 / 取消置顶一个会话文件（既有导出，保持行为不变）。
     *
     * 现在只是 setSession 的薄包装：置顶与改名的合并规则只能有一份实现，
     * 否则「只改 pinned 时会不会顺手清掉 name」这类问题会在两处各答一次、迟早答岔。
     * 校验仍走 validateSessionInput（pinned 必填的旧签名），错误文案与 0.7.0 完全一致。
     */
    setSessionPinned(sessionPath, pinned) {
      // 校验也包在 promise 里：本方法的对外契约是「永远返回 Promise」（入参错误以
      // rejected promise 出现），同步 throw 会让只写了 .catch() 的调用方接不住。
      return Promise.resolve().then(() => {
        const input = validateSessionInput(sessionPath, pinned)
        return setSession(input.path, { pinned: input.pinned })
      })
    },
  }
}

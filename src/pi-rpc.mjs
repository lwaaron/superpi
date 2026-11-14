/**
 * pi RPC 子进程管理器（host half 的核心）。
 *
 * 设计约束（来自 pi-main/packages/coding-agent/docs/rpc.md）：
 *  - 严格 JSONL 帧：stdout 只能按 \n 切分。**不要用 readline**，它会额外在
 *    U+2028 / U+2029 处断行，而这两个字符在 JSON 字符串里合法。
 *  - stdout 只放协议记录；诊断日志走 stderr。stderr 绝不能当协议解析。
 *  - prompt 的 success 只表示「已接受/入队」，不代表跑完；结束要等 agent_settled。
 *  - 命令用 id 相关响应；命令处理是异步的，不能按响应顺序配对。
 *  - 关闭：关 stdin 请求有序退出，给时间再 kill。
 *  - extension_ui_response 是**唯一**不允许改写 id 的出口：pi 侧用
 *    map.get(id) 匹配待决请求，id 一变请求就永远挂着（rpc-mode.ts:789-791）。
 *
 * 本文件不 import 任何 @deepseek-ai/* 包，只用 node 内建。
 */

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'

/**
 * 命令等待上限的默认值。
 *
 * 语义（宿主侧唯一口径，index.js 的 /command 透传的就是它）：
 *  - 正的有限数 = 毫秒上限；
 *  - 0 / 负数 / Infinity = 不设上限（调用方显式要求「等到 pi 自己回答」）；
 *  - 其他（NaN）由 index.js 拒掉，绝不静默降级成无上限。
 *
 * 与扩展弹窗的关系见 armTimer()：弹窗开着时命令超时必须让位，否则会出现
 * 「pi command timed out: prompt」红条与仍在等待的对话框同时存在（0.3.0 之前的真实缺陷）。
 */
const DEFAULT_TIMEOUT_MS = 60_000

/**
 * 把外部传入的超时值归一成「timer 的毫秒上限」：
 *  - 正的有限数 → 原值；
 *  - 0 / 负数 / Infinity → null（不设上限，调用方显式要求等到 pi 自己回答）；
 *  - undefined / null → DEFAULT_TIMEOUT_MS；
 *  - NaN 或非数字 → 抛 TypeError（绝不静默降级成无上限，那是把缺陷藏起来）。
 *
 * index.js 的 /command 路由与 send() 共用这一个口径，避免两处各写一遍 parse。
 */
export function timeoutLimitMs(value) {
  if (value === undefined || value === null) return DEFAULT_TIMEOUT_MS
  if (typeof value === 'number') {
    if (Number.isNaN(value)) throw new TypeError('timeoutMs must not be NaN')
    if (!Number.isFinite(value) || value <= 0) return null
    return value
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return DEFAULT_TIMEOUT_MS
    const parsed = Number(trimmed)
    if (Number.isNaN(parsed)) throw new TypeError('timeoutMs must be a number, got "' + value + '"')
    return timeoutLimitMs(parsed)
  }
  throw new TypeError('timeoutMs must be a number')
}

/** 事件环形缓冲：条数 + 字节双上限（只按条数会在巨型事件下吃掉几百 MB）。 */
const DEFAULT_MAX_EVENTS = 20_000
const DEFAULT_MAX_EVENT_BYTES = 16 * 1024 * 1024
const MAX_STDERR_LINES = 200
/**
 * 命令超时因「弹窗还开着」而续期的最大次数。
 *
 * 续期是为了让扩展弹窗有机会被点（见 armTimer）；但面板被关掉、客户端崩掉时
 * 弹窗永远不会被应答，无上限续期就等于把这条命令连同它的 pending 表项永久泄漏。
 * 12 次配合默认 60s 上限 = 至少 12 分钟的真实等待窗口，足够人点完任何对话框。
 */
const MAX_TIMEOUT_DEFERRALS = 12
/** 需要客户端应答的扩展 UI 方法；其余（notify/setStatus/...）是 fire-and-forget。 */
const DIALOG_METHODS = new Set(['select', 'confirm', 'input', 'editor'])
/**
 * 会把 pi 内部会话指针挪走的命令：执行后旧的 sessionFile/sessionId/sessionName 全部失效。
 * 与 index.js 里 SESSION_REPLACING_COMMANDS 保持一致（那边决定是否清事件缓冲）。
 */
const SESSION_REPLACING_EVENTS = new Set(['new_session', 'switch_session', 'fork', 'clone'])

/** 只按 LF 切帧，容忍 CRLF；空行丢弃。 */
class LineSplitter {
  constructor(onLine) {
    this.buffer = Buffer.alloc(0)
    this.onLine = onLine
    this.dropped = 0
  }

  push(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    let newline = -1
    for (;;) {
      newline = this.buffer.indexOf(0x0a)
      if (newline === -1) break
      let line = this.buffer.subarray(0, newline)
      this.buffer = this.buffer.subarray(newline + 1)
      if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1)
      if (line.length === 0) continue
      this.onLine(line.toString('utf8'), line.length)
    }
  }

  flush() {
    if (this.buffer.length === 0) return
    const tail = this.buffer.toString('utf8')
    this.buffer = Buffer.alloc(0)
    if (tail.trim() !== '') this.onLine(tail, Buffer.byteLength(tail))
  }
}

export class PiProcess extends EventEmitter {
  /**
   * @param {{
   *   cliPath: string, nodePath: string, cwd: string, args?: string[],
   *   env?: Record<string,string>, label?: string,
   *   maxEvents?: number, maxEventBytes?: number,
   * }} options
   */
  constructor(options) {
    super()
    this.id = randomUUID()
    this.label = options.label ?? 'pi'
    this.cwd = options.cwd
    this.cliPath = options.cliPath
    this.nodePath = options.nodePath
    this.args = options.args ?? []
    this.env = options.env ?? {}
    this.state = 'starting' // starting | ready | busy | dead
    this.createdAt = Date.now()
    this.pending = new Map()
    this.events = []
    /** 与 events 等长的字节数，用于 O(1) 维护字节预算。 */
    this.eventSizes = []
    this.eventBytes = 0
    this.droppedEvents = 0
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS
    this.maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES
    this.eventSeq = 0
    this.stderrLines = []
    this.exitInfo = null
    this.lastState = null
    /**
     * 会话自己的 cwd，与进程 cwd（this.cwd）分开记。
     *
     * pi 的每条会话都在 header 里带 cwd，switch_session 之后会话的 cwd 可能和 spawn 时
     * 那个目录不同；而 get_state 不回报 cwd（rpc-types.ts:96-109 没有该字段），
     * 所以由 host 从会话文件 header 读出来写这里。null = 还没校正过，读 cwd 时回落到进程 cwd。
     */
    this.sessionCwd = null
    /** 待应答的扩展 UI 请求：id -> { id, method, title?, message?, options?, placeholder?, prefill?, seq, receivedAt } */
    this.pendingUi = new Map()
    this.proc = null
    this.splitter = null
    this.closePromise = null
  }

  get pid() {
    return this.proc === null ? null : this.proc.pid
  }

  /**
   * 校正会话 cwd（switch_session 之后由 host 调用）。
   * 传空串表示「不知道」——回落到进程 cwd，绝不把 cwd 清成空，否则 UI 里目录会消失。
   */
  setSessionCwd(nextCwd) {
    const text = typeof nextCwd === 'string' && nextCwd.trim() !== '' ? nextCwd.trim() : ''
    this.sessionCwd = text === '' ? null : text
    return this.sessionCwd
  }

  start() {
    const argv = [this.cliPath, '--mode', 'rpc', ...this.args]
    const child = spawn(this.nodePath, argv, {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.proc = child

    this.splitter = new LineSplitter((line, byteLength) => this.receive(line, byteLength))
    child.stdout.on('data', chunk => this.splitter.push(chunk))
    child.stderr.on('data', chunk => this.receiveStderr(chunk.toString('utf8')))
    child.on('error', error => this.fail('spawn', error))
    child.on('exit', (code, signal) => this.handleExit(code, signal))
    child.stdin.on('error', error => this.emitLog('warn', 'stdin error: ' + error.message))

    this.state = 'ready'
    this.emitLog('info', 'spawned pid=' + String(child.pid) + ' cwd=' + this.cwd)
    return this
  }

  emitLog(level, message) {
    this.emit('log', { level, message, at: Date.now() })
  }

  receiveStderr(text) {
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trimEnd()
      if (line === '') continue
      this.stderrLines.push(line)
      if (this.stderrLines.length > MAX_STDERR_LINES) this.stderrLines.shift()
      this.emitLog('stderr', line)
    }
  }

  receive(rawLine, byteLength) {
    let record
    try {
      record = JSON.parse(rawLine)
    } catch {
      // 不是协议记录：当诊断信息留着，绝不半途丢弃整条流。
      this.receiveStderr('[non-json stdout] ' + rawLine.slice(0, 400))
      return
    }
    if (record === null || typeof record !== 'object') return

    if (record.type === 'response') {
      this.resolveResponse(record)
      return
    }
    this.pushEvent(record, typeof byteLength === 'number' ? byteLength : undefined)
  }

  resolveResponse(record) {
    // get_state 是唯一能反映 pi 真实会话身份的命令：所有调用方都需要它，
    // 所以在这里统一回写，避免每个路由各写一遍（漏写就会出现 sessionFile=null）。
    if (record.command === 'get_state' && record.success !== false && record.data !== null && typeof record.data === 'object') {
      this.lastState = record.data
    }
    const key = typeof record.id === 'string' ? record.id : undefined
    const waiter = key === undefined ? this.takeByCommand(record.command) : this.pending.get(key)
    if (waiter === undefined) {
      this.emitLog('warn', 'unmatched response for command ' + String(record.command))
      return
    }
    if (key !== undefined) this.pending.delete(key)
    this.clearWaiterTimer(waiter)
    if (record.success === false) {
      waiter.reject(Object.assign(new Error(String(record.error ?? 'pi command failed')), {
        command: record.command, record,
      }))
      return
    }
    waiter.resolve(record.data)
  }

  takeByCommand(command) {
    for (const [key, waiter] of this.pending) {
      if (waiter.command === command) {
        this.pending.delete(key)
        return waiter
      }
    }
    return undefined
  }

  pushEvent(record, sizeHint) {
    this.eventSeq += 1
    const entry = { seq: this.eventSeq, at: Date.now(), record }
    const size = typeof sizeHint === 'number' && sizeHint > 0 ? sizeHint : Buffer.byteLength(JSON.stringify(record))
    this.events.push(entry)
    this.eventSizes.push(size)
    this.eventBytes += size
    this.trackUi(record, entry.seq)
    this.trackState(record)
    this.trimEvents()
    if (record.type === 'agent_start') this.state = 'busy'
    if (record.type === 'agent_settled') {
      this.state = 'ready'
      // 轮次已结束：不可能还有待应答的弹窗（pi 侧超时会自行 resolve 默认值），
      // 继续留着只会让重连的客户端弹出已经失效的对话框。
      if (this.pendingUi.size > 0) {
        this.emitLog('warn', 'dropping ' + String(this.pendingUi.size) + ' stale extension_ui_request(s) on agent_settled')
        this.pendingUi.clear()
      }
    }
    this.emit('event', entry)
  }

  /** 条数/字节双上限，从头部丢弃并累加 droppedEvents。 */
  trimEvents() {
    while (this.events.length > 1 && (this.events.length > this.maxEvents || this.eventBytes > this.maxEventBytes)) {
      this.events.shift()
      this.eventBytes -= this.eventSizes.shift() ?? 0
      this.droppedEvents += 1
    }
    if (this.eventBytes < 0) this.eventBytes = 0
  }

  /** 记录需要客户端应答的扩展 UI 请求，供重连客户端补弹窗。 */
  trackUi(record, seq) {
    if (record.type !== 'extension_ui_request') return
    if (typeof record.method !== 'string' || !DIALOG_METHODS.has(record.method)) return
    if (typeof record.id !== 'string' || record.id === '') return
    this.pendingUi.set(record.id, {
      id: record.id,
      method: record.method,
      title: record.title ?? null,
      message: record.message ?? null,
      options: Array.isArray(record.options) ? record.options : null,
      placeholder: record.placeholder ?? null,
      prefill: record.prefill ?? null,
      // 扩展自己声明的超时（rpc-mode.ts:119-124 只有 opts.timeout 为真值时才 setTimeout，
      // 到点由 pi 侧 resolve 默认值并继续跑）。面板据此对齐倒计时，才不会出现
      // 「面板还在倒计时 5 分钟，pi 早已按默认值继续」的错位。
      timeout: typeof record.timeout === 'number' && Number.isFinite(record.timeout) && record.timeout > 0 ? record.timeout : null,
      seq,
      receivedAt: Date.now(),
    })
    this.emitLog('info', 'extension_ui_request ' + record.method + ' id=' + record.id)
  }

  /**
   * 用事件回填 lastState。
   *
   * snapshot() 的身份/状态字段全部读 lastState，而 lastState 只在 get_state 的响应里
   * 整体替换。有些状态变化并不会让谁去问一次 get_state（比如扩展自己调了
   * setSessionName，或 /think 改了等级），只处理「事件里带着完整新值」的那几种，
   * 事件没给值的字段一律不动——宁可旧值也不要写半截。
   */
  trackState(record) {
    if (this.lastState === null) return
    if (record.type === 'session_info_changed') {
      this.lastState.sessionName = typeof record.name === 'string' && record.name !== '' ? record.name : null
      return
    }
    if (record.type === 'thinking_level_changed' && typeof record.level === 'string' && record.level !== '') {
      this.lastState.thinkingLevel = record.level
    }
  }

  /**
   * 用命令的响应回填 lastState。
   *
   * set_model / set_session_name / set_thinking_level 这类命令改完状态只回一个 data，
   * 不会附带 get_state；不回填的话 /snapshot 会一直报旧值（刚切完模型仍是旧模型，
   * 刚设完名字仍是 null），重连的客户端就照着旧值渲染。
   *
   * 会话被整体替换的四条命令（new_session / switch_session / fork / clone）拿不到新身份，
   * 一律置 null 表示「未知」，由调用方随后补一次 get_state 填上——宁可空也不要留着
   * 上一个会话的 sessionFile。
   */
  noteCommand(command, data) {
    const type = command !== null && typeof command === 'object' && typeof command.type === 'string' ? command.type : ''
    if (type === '') return
    if (type === 'get_state') {
      if (data !== null && typeof data === 'object') this.lastState = data
      return
    }
    const next = { ...(this.lastState ?? {}) }
    if (type === 'set_model') {
      if (data !== null && typeof data === 'object') next.model = data
    } else if (type === 'cycle_model') {
      if (data !== null && typeof data === 'object' && data.model !== undefined) next.model = data.model
      if (data !== null && typeof data === 'object' && typeof data.thinkingLevel === 'string') next.thinkingLevel = data.thinkingLevel
    } else if (type === 'set_thinking_level') {
      if (typeof command.level === 'string' && command.level !== '') next.thinkingLevel = command.level
    } else if (type === 'cycle_thinking_level') {
      if (data !== null && typeof data === 'object' && typeof data.level === 'string') next.thinkingLevel = data.level
    } else if (type === 'set_session_name') {
      const name = typeof command.name === 'string' ? command.name.trim() : ''
      if (name !== '') next.sessionName = name
    } else if (type === 'set_auto_compaction') {
      if (typeof command.enabled === 'boolean') next.autoCompactionEnabled = command.enabled
    } else if (SESSION_REPLACING_EVENTS.has(type)) {
      next.sessionFile = null
      next.sessionId = null
      next.sessionName = null
    } else {
      return
    }
    this.lastState = next
  }

  /**
   * 主动问一次 get_state 并写回 lastState。
   *
   * 用在「会话刚被整体替换」之后：那四条命令只回 {cancelled}，新会话的 sessionFile
   * 只能靠 get_state 拿。拿不到就保留旧值（调用方通常再兜一层超时），不抛。
   */
  async refreshState({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (this.state === 'dead') return this.lastState
    try {
      const data = await this.send({ type: 'get_state' }, { timeoutMs })
      this.noteCommand({ type: 'get_state' }, data)
    } catch { /* 超时/进程已退出：保留旧值，由后续事件或下一次 refresh 补 */ }
    return this.lastState
  }

  send(command, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (this.state === 'dead') return Promise.reject(new Error('pi process is not running'))
    if (command !== null && typeof command === 'object' && command.type === 'extension_ui_response') {
      // 走 send() 会被重新分配 id，pi 侧永远匹配不上；强制改道。
      this.respond(command)
      return Promise.resolve({ ok: true, via: 'respond' })
    }
    // 归一化放在 Promise 之外：非法入参应当同步抛出，而不是变成一个 rejected Promise。
    const limitMs = timeoutLimitMs(timeoutMs)
    const payload = { ...command }
    const id = typeof payload.id === 'string' ? payload.id : 'req-' + randomUUID()
    payload.id = id
    return new Promise((resolve, reject) => {
      // 只有真正的上限才起 timer。limitMs === null 表示「不设上限」，
      // 典型场景是 prompt 触发的扩展命令要等用户点完弹窗——此时先超时会让
      // 命令的 rejected 与仍然挂着的对话框并存（弹窗永远等不到答复也不会消失）。
      const waiter = { id, resolve, reject, timer: null, command: String(command.type ?? ''), limitMs, deferrals: 0 }
      if (limitMs !== null) waiter.timer = this.armTimer(waiter, 0)
      this.pending.set(id, waiter)
      const line = JSON.stringify(payload) + '\n'
      try {
        this.proc.stdin.write(line)
      } catch (error) {
        this.clearWaiterTimer(waiter)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  /**
   * 给一个待决命令挂超时计时器。
   *
   * 关键语义：**弹窗开着时超时必须让位**。命令卡住有两种完全不同的原因——
   *   ① pi 侧死了/卡死 → 该超时、该报错；
   *   ② pi 在等用户点扩展弹窗（extension_ui_request 已下发，pendingUi 非空）→ 命令
   *      是在 await 那个 dialog promise，用户不点它永远不会回答。此时若命令先超时，
   *      面板会同时显示「pi command timed out: prompt」红条和一个仍在倒计时的对话框，
   *      之后用户的点选被 pi 当成没人要的 id 丢弃（0.3.0 之前的真实缺陷）。
   * 所以计时器到点时先看 pendingUi：非空就原地续期，等弹窗被应答（或 agent_settled
   * 清空 pendingUi）后自然恢复正常的超时判断。
   */
  armTimer(waiter, deferrals = 0) {
    const limitMs = waiter.limitMs
    const timer = setTimeout(() => {
      if (this.pendingUi.size > 0 && deferrals < MAX_TIMEOUT_DEFERRALS) {
        waiter.deferrals = deferrals + 1
        this.emitLog('info', 'command ' + String(waiter.command) + ' waits for ' + String(this.pendingUi.size) + ' pending dialog(s), timeout deferred #' + String(waiter.deferrals))
        waiter.timer = this.armTimer(waiter, waiter.deferrals)
        return
      }
      this.pending.delete(waiter.id)
      // 续期次数用尽仍卡着：说明弹窗一直没人应答（面板关了、客户端崩了）。
      // 这时报「没人应答弹窗」比报「命令超时」更能指出现场。
      waiter.reject(new Error(this.pendingUi.size > 0
        ? 'pi command timed out: ' + String(waiter.command) + ' (' + String(this.pendingUi.size) + ' dialog(s) never answered)'
        : 'pi command timed out: ' + String(waiter.command)))
    }, limitMs)
    if (typeof timer.unref === 'function') timer.unref()
    return timer
  }

  clearWaiterTimer(waiter) {
    if (waiter.timer !== null && waiter.timer !== undefined) {
      clearTimeout(waiter.timer)
      waiter.timer = null
    }
  }

  /**
   * 应答扩展 UI 请求：写一行 {type:'extension_ui_response', ...}，**id 原样透传**。
   * 不登记 pending、不设超时——pi 侧本来就只是从 map 里取 resolver。
   * @returns {{ ok: true, id: string, payload: object }}
   */
  respond(response) {
    if (response === null || typeof response !== 'object') throw new TypeError('extension_ui_response must be an object')
    const id = typeof response.id === 'string' ? response.id : ''
    if (id === '') throw new TypeError('extension_ui_response requires a non-empty string id')
    if (this.state === 'dead') throw new Error('pi process is not running')
    if (this.proc === null || this.proc.stdin === null || this.proc.stdin.destroyed === true) {
      throw new Error('pi process stdin is not available')
    }
    const payload = { ...response, type: 'extension_ui_response', id }
    delete payload.seq
    if (!this.writeLine(payload)) throw new Error('failed to write to pi stdin')
    this.pendingUi.delete(id)
    this.restartPendingTimers()
    return { ok: true, id, payload }
  }

  /**
   * 有人答了一个弹窗 → 所有待决命令重开一轮超时窗口。
   *
   * 为什么必须这么做：命令的超时计时器只看「此刻有没有弹窗挂着」。用户在第 59 秒
   * 点掉最后一个弹窗，pi 还要跑扩展剩下的逻辑；此刻 pendingUi 刚被删空，计时器
   * 一响就会立刻 reject —— 明明有人应答，面板却报超时。用户的点击是活着的证据，
   * 应当换来一整轮新窗口（而不是继承上一轮已经被烧掉的流逝时间）。
   *
   * 只重置确实挂了 timer 的命令；limitMs === null 的命令本来就没有 timer。
   */
  restartPendingTimers() {
    for (const waiter of this.pending.values()) {
      if (waiter.timer === null || waiter.timer === undefined) continue
      this.clearWaiterTimer(waiter)
      waiter.deferrals = 0
      waiter.timer = this.armTimer(waiter, 0)
    }
  }

  writeLine(payload) {
    try {
      this.proc.stdin.write(JSON.stringify(payload) + '\n')
      return true
    } catch (error) {
      this.emitLog('warn', 'stdin write failed: ' + String(error?.message ?? error))
      return false
    }
  }

  fail(stage, error) {
    this.emitLog('error', stage + ' failure: ' + String(error?.message ?? error))
    this.handleExit(null, null)
  }

  handleExit(code, signal) {
    if (this.exitInfo !== null) return
    this.splitter?.flush()
    this.exitInfo = { code, signal, at: Date.now() }
    this.state = 'dead'
    this.pendingUi.clear()
    for (const [, waiter] of this.pending) {
      this.clearWaiterTimer(waiter)
      waiter.reject(new Error('pi process exited before the command answered'))
    }
    this.pending.clear()
    this.emit('exit', this.exitInfo)
  }

  /**
   * 清空事件缓冲并把 eventSeq 归零（会话被替换后，旧事件会和新会话的事件混在一起）。
   *
   * 刻意**不清** pendingUi、**不改** state：
   *  - pendingUi 属于「还没结束的对话框」，重置事件流不代表用户已应答；
   *  - state 由 agent_start / agent_settled 驱动，重置缓冲不影响子进程真实状态。
   */
  resetEvents() {
    this.events = []
    this.eventSizes = []
    this.eventBytes = 0
    this.droppedEvents = 0
    this.eventSeq = 0
    return { ok: true, eventSeq: this.eventSeq }
  }

  snapshot({ sinceSeq = 0, includeEvents = true } = {}) {
    return {
      id: this.id,
      label: this.label,
      // cwd 是进程目录（spawn 时定死）；sessionCwd 是当前会话文件的 cwd，跨项目切换后会变。
      cwd: this.cwd,
      sessionCwd: this.sessionCwd ?? this.cwd,
      pid: this.pid,
      state: this.state,
      createdAt: this.createdAt,
      eventSeq: this.eventSeq,
      droppedEvents: this.droppedEvents,
      model: this.lastState?.model ?? null,
      thinkingLevel: this.lastState?.thinkingLevel ?? null,
      sessionId: this.lastState?.sessionId ?? null,
      sessionName: this.lastState?.sessionName ?? null,
      sessionFile: this.lastState?.sessionFile ?? null,
      pendingUi: [...this.pendingUi.values()],
      exit: this.exitInfo,
      stderr: this.stderrLines.slice(-20),
      events: includeEvents ? this.events.filter(entry => entry.seq > sinceSeq) : [],
    }
  }

  /** 有序关闭：先关 stdin，等 pi 自己收尾，超时才 kill。 */
  async close({ timeoutMs = 8000 } = {}) {
    if (this.closePromise !== null) return this.closePromise
    const child = this.proc
    if (child === null || this.exitInfo !== null) {
      this.closePromise = Promise.resolve()
      return this.closePromise
    }
    this.closePromise = new Promise(resolve => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
        finish()
      }, timeoutMs)
      child.once('exit', finish)
      try { child.stdin.end() } catch { /* already closed */ }
    })
    return this.closePromise
  }
}

export function createProcess(options) {
  return new PiProcess(options).start()
}

export const EVENT_LIMITS = { maxEvents: DEFAULT_MAX_EVENTS, maxEventBytes: DEFAULT_MAX_EVENT_BYTES }
export { DIALOG_METHODS, SESSION_REPLACING_EVENTS }

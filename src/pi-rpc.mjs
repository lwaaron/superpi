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
 *
 * 本文件不 import 任何 @deepseek-ai/* 包，只用 node 内建。
 */

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_EVENTS = 3000
const MAX_STDERR_LINES = 200

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
      this.onLine(line.toString('utf8'))
    }
  }

  flush() {
    if (this.buffer.length === 0) return
    const tail = this.buffer.toString('utf8')
    this.buffer = Buffer.alloc(0)
    if (tail.trim() !== '') this.onLine(tail)
  }
}

export class PiProcess extends EventEmitter {
  /**
   * @param {{ cliPath: string, nodePath: string, cwd: string, args?: string[], env?: Record<string,string>, label?: string }} options
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
    this.eventSeq = 0
    this.stderrLines = []
    this.exitInfo = null
    this.lastState = null
    this.proc = null
    this.splitter = null
    this.closePromise = null
  }

  get pid() {
    return this.proc === null ? null : this.proc.pid
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

    this.splitter = new LineSplitter(line => this.receive(line))
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

  receive(rawLine) {
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
    this.pushEvent(record)
  }

  resolveResponse(record) {
    const key = typeof record.id === 'string' ? record.id : undefined
    const waiter = key === undefined ? this.takeByCommand(record.command) : this.pending.get(key)
    if (waiter === undefined) {
      this.emitLog('warn', 'unmatched response for command ' + String(record.command))
      return
    }
    if (key !== undefined) this.pending.delete(key)
    clearTimeout(waiter.timer)
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

  pushEvent(record) {
    this.eventSeq += 1
    const entry = { seq: this.eventSeq, at: Date.now(), record }
    this.events.push(entry)
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS)
    if (record.type === 'agent_start') this.state = 'busy'
    if (record.type === 'agent_settled') this.state = 'ready'
    this.emit('event', entry)
  }

  send(command, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (this.state === 'dead') return Promise.reject(new Error('pi process is not running'))
    const payload = { ...command }
    const id = typeof payload.id === 'string' ? payload.id : 'req-' + randomUUID()
    payload.id = id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('pi command timed out: ' + String(command.type)))
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      this.pending.set(id, { resolve, reject, timer, command: String(command.type ?? '') })
      const line = JSON.stringify(payload) + '\n'
      try {
        this.proc.stdin.write(line)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
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
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('pi process exited before the command answered'))
    }
    this.pending.clear()
    this.emit('exit', this.exitInfo)
  }

  snapshot({ sinceSeq = 0, includeEvents = true } = {}) {
    return {
      id: this.id,
      label: this.label,
      cwd: this.cwd,
      pid: this.pid,
      state: this.state,
      createdAt: this.createdAt,
      eventSeq: this.eventSeq,
      model: this.lastState?.model ?? null,
      thinkingLevel: this.lastState?.thinkingLevel ?? null,
      sessionId: this.lastState?.sessionId ?? null,
      sessionName: this.lastState?.sessionName ?? null,
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

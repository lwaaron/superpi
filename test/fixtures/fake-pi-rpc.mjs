#!/usr/bin/env node
/**
 * 假 pi RPC 子进程 —— 只为超时语义而生的协议替身。
 *
 * 真 pi 在两种场景下无法在测试里重现：
 *   ① 命令永不回答（进程卡死 / 模型 hang 住）；
 *   ② 命令在等用户点扩展弹窗（prompt 命中扩展命令时 pi 会 await 整个 dialog 生命周期）。
 * 这两种场景正是 0.3.0 之前「红条与对话框并存」的成因，必须进自动化门禁，否则下次
 * 改超时逻辑只能靠人肉复现。真 pi 停在那里等 5 分钟是不可接受的，所以用替身。
 *
 * 用法（PiProcess 会把 cliPath 当第一个参数）：
 *   spawn(node, [fake-pi-rpc.mjs, '--mode', 'rpc'])
 * 行为由环境变量选择：
 *   FAKE_PI_MODE=dialog  prompt 先发 extension_ui_request（select），收到应答后才回答命令
 *   FAKE_PI_MODE=silent  prompt 永不回答
 *   默认模式             所有命令立即回答
 *
 * 只实现测试用到的那几个命令，其余一律 success:true —— 它是替身，不是模拟器。
 */
import readline from 'node:readline'

const mode = process.env.FAKE_PI_MODE ?? 'normal'

const out = record => {
  process.stdout.write(JSON.stringify(record) + '\n')
}

const respond = (id, command, data) => {
  out({ type: 'response', id, command, success: true, data })
}

const state = {
  model: { id: 'fake-model', provider: 'fake', contextWindow: 1000, maxTokens: 100 },
  thinkingLevel: 'high',
  isStreaming: false,
  isCompacting: false,
  steeringMode: 'one-at-a-time',
  followUpMode: 'one-at-a-time',
  sessionFile: null,
  sessionId: 'fake-session',
  sessionName: null,
  autoCompactionEnabled: true,
  messageCount: 0,
  pendingMessageCount: 0,
}

/** 命令 id → { command }，等弹窗应答后才回答。 */
const waiting = new Map()

const line = readline.createInterface({ input: process.stdin })
line.on('line', raw => {
  const text = raw.trim()
  if (text === '') return
  let record
  try {
    record = JSON.parse(text)
  } catch {
    return
  }
  if (record === null || typeof record !== 'object') return
  const id = typeof record.id === 'string' ? record.id : ''

  if (record.type === 'extension_ui_response') {
    const pending = waiting.get(record.id)
    if (pending !== undefined) {
      waiting.delete(record.id)
      // 弹窗答完，命令才算完成 —— 与真 pi 的时序一致（rpc-mode.ts:768-824）。
      respond(pending.commandId, pending.command, { disposition: 'handled' })
    }
    return
  }

  if (record.type === 'get_state') {
    respond(id, 'get_state', state)
    return
  }

  if (record.type === 'prompt' && mode === 'dialog') {
    // 先下发弹窗，命令挂起等应答。弹窗 id 前置固定前缀，测试里据此断言。
    waiting.set('dlg-1', { commandId: id, command: 'prompt' })
    out({ type: 'extension_ui_request', id: 'dlg-1', method: 'select', title: 'fake pick', options: ['a', 'b'] })
    return
  }

  if (record.type === 'prompt' && mode === 'silent') return

  respond(id, String(record.type), { ok: true })
})

// stdin 关闭 = 宿主主动收工，直接退出（模拟正常退出的子进程）。
line.on('close', () => process.exit(0))

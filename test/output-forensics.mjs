#!/usr/bin/env node
/**
 * 输出完整性取证（0.18.0）—— `docs/output-integrity.md` 里每个数字的来源。
 *
 * 与门禁的区别：门禁断言"代码对不对"，本文件**只统计真实会话**，不改任何文件、
 * 不联网、不起 pi。它回答的是"我们把修法建立在什么事实上"。
 *
 * 为什么要进仓库而不是留在 `_scratch/`：`_scratch/` 是 gitignore 的，
 * 而文档引用了这些数字（20 个会话 / 5450 条记录 / 7 次带坏字节的 write 全部落盘）。
 * 数字不能只在某个人的临时目录里可复算 —— 那是"文档里的数字"当证据（§5.0 禁止项）。
 *
 * 跑法：node test/output-forensics.mjs [--since 2026-11-19] [--until 2026-11-24] [--json]
 *
 * 输出四段：
 *   ① 收尾形态：assistant 条数、stopReason 分布、`stop` 无工具调用的条数、
 *      其中"后面紧跟用户手打继续"的条数（= 用户要手动推一下的成本）；
 *   ② 坏字节位置：text / thinking / toolCall 参数 / toolResult 各命中多少条；
 *   ③ 坏字节有没有落盘：按工具统计「带坏字节的调用」的成功/失败；
 *   ④ 单例集中度：坏字节来自几个会话文件（防止把单例当规律，§5.0 强制动作）。
 *
 * 没有会话数据时明确说"没有样本，什么也没证明"，不冒充通过。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scanTextBytes } from '../extensions/superpi-text-bytes.mjs'

const args = process.argv.slice(2)
function argValue(name, fallback) {
  const at = args.indexOf(name)
  return at >= 0 && at + 1 < args.length ? args[at + 1] : fallback
}
const since = parseWhen(argValue('--since', '2026-11-01'), 'T00:00:00Z')
const until = parseWhen(argValue('--until', '2099-01-01'), 'T23:59:59Z')
const asJson = args.includes('--json')

/**
 * 支持「只给日期」与「给到分钟」两种写法。
 *
 * 为什么需要分钟级：0.18.0 的修法本身会产生新的会话（验证写入闸时让真模型写了一次
 * 含 U+FFFD 的文件）。要复算**修法之前**的基线，时间窗必须能停在验证会话之前 ——
 * 只给日期的话，就会把"修法之后的样本"混进"修法之前的证据"里。
 */
function parseWhen(value, timeOfDay) {
  const text = String(value ?? '')
  if (text.endsWith('Z') === true) return Date.parse(text)
  if (text.includes('T') === true) return Date.parse(/T\d{2}:\d{2}$/.test(text) ? text + ':00Z' : text + 'Z')
  return Date.parse(text + timeOfDay)
}

const root = path.resolve(argValue('--sessions', path.join(os.homedir(), '.pi', 'agent', 'sessions')))
const files = []
if (fs.existsSync(root)) {
  for (const dir of fs.readdirSync(root)) {
    const abs = path.join(root, dir)
    let stat = null
    try { stat = fs.statSync(abs) } catch { continue }
    if (stat.isDirectory() !== true) continue
    for (const name of fs.readdirSync(abs)) {
      if (name.endsWith('.jsonl') !== true) continue
      const file = path.join(abs, name)
      const info = fs.statSync(file)
      if (info.mtimeMs < since || info.mtimeMs > until) continue
      files.push(file)
    }
  }
}

const NUDGE = /^(继续|继续吧|接着|continue|go on|keep going|往下)/i
const stats = {
  files: files.length,
  records: 0,
  assistant: 0,
  byStop: {},
  stopNoTool: 0,
  stopNoToolShort: 0,
  nudged: 0,
  corrupt: { text: 0, thinking: 0, toolCallArgs: 0, toolResult: 0 },
  landed: {}, // tool → { ok, err, none }
  corruptFiles: new Set(),
}

for (const file of files) {
  const entries = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try { entries.push(JSON.parse(line)) } catch { /* 坏行跳过 */ }
  }
  stats.records += entries.length

  for (let i = 0; i < entries.length; i += 1) {
    const message = entries[i]?.message
    if (message === null || typeof message !== 'object') continue

    if (message.role === 'toolResult') {
      const text = channelText(message.content)
      if (scanTextBytes(text).clean !== true) {
        stats.corrupt.toolResult += 1
        stats.corruptFiles.add(path.basename(file))
      }
      continue
    }
    if (message.role !== 'assistant') continue

    stats.assistant += 1
    const stop = typeof message.stopReason === 'string' ? message.stopReason : '(none)'
    stats.byStop[stop] = (stats.byStop[stop] ?? 0) + 1

    const blocks = Array.isArray(message.content) ? message.content : []
    const text = blocks.filter(block => block?.type === 'text').map(block => block.text).join('')
    const thinking = blocks.filter(block => block?.type === 'thinking').map(block => block.thinking).join('')
    if (scanTextBytes(text).clean !== true) { stats.corrupt.text += 1; stats.corruptFiles.add(path.basename(file)) }
    if (scanTextBytes(thinking).clean !== true) { stats.corrupt.thinking += 1; stats.corruptFiles.add(path.basename(file)) }

    let toolCallDirty = false
    for (const block of blocks) {
      if (block?.type !== 'toolCall') continue
      const input = block.arguments ?? block.input ?? {}
      const payload = typeof input.content === 'string' ? input.content : (typeof input.command === 'string' ? input.command : '')
      const scan = scanTextBytes(payload)
      if (scan.clean === true) continue
      toolCallDirty = true
      stats.corruptFiles.add(path.basename(file))
      // 并行调用按 toolCallId 对账。工具成功仅代表其报告成功。
      let result = null
      for (let j = i + 1; j < entries.length; j += 1) {
        const next = entries[j]?.message
        if (next?.role === 'assistant') break
        if (next?.role === 'toolResult' && block.id && next.toolCallId === block.id) { result = next; break }
      }
      const tool = String(block.name ?? '?')
      stats.landed[tool] = stats.landed[tool] ?? { ok: 0, err: 0, none: 0 }
      if (result === null) stats.landed[tool].none += 1
      else if (result.isError === true) stats.landed[tool].err += 1
      else stats.landed[tool].ok += 1
    }
    if (toolCallDirty) stats.corrupt.toolCallArgs += 1

    if (stop === 'stop' && blocks.some(block => block?.type === 'toolCall') !== true) {
      stats.stopNoTool += 1
      const trimmed = text.trim()
      if (trimmed.length > 0 && trimmed.length < 240) stats.stopNoToolShort += 1
      for (let j = i + 1; j < entries.length; j += 1) {
        const next = entries[j]?.message
        if (next?.role === 'assistant') break
        if (next?.role === 'user') {
          const said = channelText(next.content)
          if (NUDGE.test(said.trim()) === true) stats.nudged += 1
          break
        }
      }
    }
  }
}

function channelText(content) {
  if (Array.isArray(content) !== true) return ''
  return content.filter(block => block?.type === 'text').map(block => block.text).join('')
}

const report = { ...stats, corruptFiles: stats.corruptFiles.size }
if (asJson === true) {
  console.log(JSON.stringify(report, null, 2))
  process.exit(0)
}

console.log('样本：' + String(stats.files) + ' 个会话文件 / ' + String(stats.records) + ' 条记录 / ' + String(stats.assistant) + ' 条 assistant')
if (stats.files === 0) {
  console.log('')
  console.log('没有样本 —— 本次什么也没证明（不要把它当成"零故障"）。')
  console.log('用 --since/--until 指定时间窗，例如 --since 2026-11-19 --until 2026-11-24')
  process.exit(0)
}
console.log('')
console.log('① 收尾形态')
console.log('   stopReason：' + Object.keys(stats.byStop).map(key => key + '=' + String(stats.byStop[key])).join(' '))
console.log('   stop 且无 toolCall：' + String(stats.stopNoTool) + ' 条，其中正文 <240 字符：' + String(stats.stopNoToolShort) + ' 条')
console.log('   之后紧跟用户手打「继续」：' + String(stats.nudged) + ' 条 ← 用户要手动推一下的真实成本')
console.log('')
console.log('② 坏字节位置（按消息条数）')
console.log('   text=' + String(stats.corrupt.text) + ' thinking=' + String(stats.corrupt.thinking) +
  ' toolCallArgs=' + String(stats.corrupt.toolCallArgs) + ' toolResult=' + String(stats.corrupt.toolResult))
console.log('')
console.log('③ 带坏字节的工具调用落地结果')
for (const tool of Object.keys(stats.landed)) {
  const row = stats.landed[tool]
  console.log('   ' + tool.padEnd(6) + ' 成功=' + String(row.ok) + ' 失败=' + String(row.err) + ' 未执行=' + String(row.none))
}
console.log('')
console.log('④ 集中度：坏字节来自 ' + String(report.corruptFiles) + ' 个会话文件（§5.0：先看集中度，再谈规律）')

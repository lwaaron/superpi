#!/usr/bin/env node
/**
 * Real-model end-to-end probe: ask the real model to `write` a file whose content
 * contains a literal U+FFFD, and assert the write gate blocks it.
 *
 * NOTE ON LANGUAGE: the comments here are ASCII on purpose. This file's Chinese
 * prose was corrupted by U+FFFD three times in a row while being authored, and the
 * write gate blocked each attempt (see docs/output-integrity.md). Short Chinese
 * strings are kept only where the user actually reads them (the failure messages).
 *
 * ── Why this is a separate file and NOT part of `npm test` ─────────────────
 *
 * It needs one real LLM call (the user's configured model and third-party endpoint),
 * while `npm test` is contractually offline (`test/reliability.mjs` drives a loopback
 * SSE stand-in, never an account). Putting a networked check in there has only two
 * outcomes: it goes red often enough that people ignore it, or it gets turned into
 * SKIP -- and SKIP is worse, because "unverified" then reads as "verified".
 * So its entry point is `npm run test:integrity-e2e`, triggered explicitly.
 *
 * ── What it proves that the offline gates cannot ───────────────────────────
 *
 *   · `test/text-integrity.mjs` proves pi's runner honours our `{block:true}` return;
 *   · this file proves that bytes emitted by the REAL model are blocked inside a REAL
 *     pi subprocess and that nothing lands on disk.
 *
 * Replace any link in that chain with a stand-in and the evidence degrades to
 * "our code agrees with our own stand-in".
 *
 * ── Four criteria (missing any one = "no evidence") ────────────────────────
 *
 *   1. The model really did issue `write` aimed at the target WITH U+FFFD in `content`
 *      -- otherwise "blocked = 1" could be a vacuous pass caused by something else.
 *   2. That call's tool result says the write was intercepted, and the reason carries
 *      both "file was not written" and "do not resend verbatim" -- a reason the model
 *      cannot act on only makes it resend the same corrupt bytes (AGENTS.md §5.0).
 *   3. The target file does not exist afterwards.
 *   4. If it does exist, its content must not contain the bad byte either.
 *
 * ── Exit codes (three outcomes, never conflated) ───────────────────────────
 *
 *   0 = blocked, nothing bad on disk
 *   1 = NOT blocked (file created and/or contains the bad byte) -- a product defect
 *   2 = no evidence this round (the model happened not to emit the bad byte) -- rerun;
 *       this is explicitly not a pass
 *
 * Run: npm run test:integrity-e2e   (same as node test/integrity-e2e.mjs)
 */
import fs from 'node:fs'
import path from 'node:path'

import { PiProcess } from '../src/pi-rpc.mjs'
import { rpcExtensionArgs, runtimeSessionOptions } from '../src/runtime-extensions.mjs'
import { requireRuntime } from './preflight.mjs'

/** The bad byte itself. Never written literally (that would trip the gate on this file). */
const BAD = String.fromCharCode(0xfffd)
const SETTLE_MS = 180_000
const target = path.join(process.cwd(), '_scratch', 'integrity-e2e.txt')

let checks = 0
const failures = []
function ok(condition, message) {
  checks += 1
  if (condition) return true
  failures.push(message)
  console.error('  x ' + message)
  return false
}

function report(code) {
  if (failures.length === 0) {
    console.log('PASS (' + checks + ' checks)')
    process.exit(code)
  }
  console.error('FAIL (' + failures.length + ' failed of ' + checks + ')')
  process.exit(code === 2 ? 2 : 1)
}

function normalize(p) {
  return path.resolve(p).replace(/\\/g, '/').toLowerCase()
}

// A previous failing run may have left the corrupt file behind (that is what we hunt),
// so clear it first -- otherwise this round's criteria would be meaningless.
fs.mkdirSync(path.dirname(target), { recursive: true })
fs.rmSync(target, { force: true })

const pi = requireRuntime()
// Load the extensions the SAME way the host does (`index.js`: rpcExtensionArgs).
// Why it matters: pi also discovers whatever is already installed in <agentDir>/extensions,
// so without this the probe would exercise THAT copy and happily go green while the repo
// copy is broken (measured: the log kept stamping the old version while the repo said 0.38.1).
const sessionConfig = runtimeSessionOptions({ packageDir: process.cwd() })
const extensionArgs = rpcExtensionArgs(process.cwd(), sessionConfig.agentDir)
console.log('agentDir =', sessionConfig.agentDir, '| explicit extensions =', extensionArgs.length / 2)
const proc = new PiProcess({
  cliPath: pi.cliPath,
  nodePath: process.execPath,
  cwd: process.cwd(),
  args: extensionArgs,
  label: 'integrity-e2e',
})
const events = []
proc.on('event', entry => events.push(entry.record))
proc.start()

let settled = false
let exitCode = 0
try {
  await proc.send({ type: 'get_state' }, { timeoutMs: 30_000 })

  const prompt = [
    '只做一件事，不要解释：用 write 工具把下面这段内容原样写入文件',
    '_scratch/integrity-e2e.txt',
    '内容必须严格是这 5 个字符：A、替换符（U+FFFD，也就是界面上那个菱形问号）、B、换行、END。',
    '注意：替换符要写成它本身这个字符，不要写成转义形式（不要写 \\uFFFD 五个字符）。',
  ].join(' ')
  await proc.send({ type: 'prompt', message: prompt }, { timeoutMs: SETTLE_MS })

  const started = Date.now()
  while (Date.now() - started < SETTLE_MS) {
    await new Promise(resolve => setTimeout(resolve, 500))
    if (events.some(record => record.type === 'agent_settled')) { settled = true; break }
  }
  console.log('agent_settled =', settled)

  // 1. The model really attempted the write with the bad byte (guards against vacuity).
  const messages = events.filter(record => record.type === 'message_end' && record.message !== null && typeof record.message === 'object')
  const writeCalls = []
  for (const record of messages) {
    if (record.message.role !== 'assistant' || !Array.isArray(record.message.content)) continue
    for (const block of record.message.content) {
      if (block?.type !== 'toolCall' || block?.name !== 'write') continue
      const args = block.arguments ?? {}
      const content = typeof args.content === 'string' ? args.content : ''
      writeCalls.push({
        path: typeof args.path === 'string' ? args.path : '',
        badBytes: [...content].filter(ch => ch.codePointAt(0) === BAD.codePointAt(0)).length,
        hitsTarget: typeof args.path === 'string' && normalize(args.path) === normalize(target),
      })
    }
  }
  const aimed = writeCalls.filter(call => call.hitsTarget)
  const badWrites = aimed.filter(call => call.badBytes > 0)
  console.log('write calls aimed at target =', aimed.length, '| with the bad byte in content =', badWrites.length)
  ok(badWrites.length > 0, '本轮没形成证据：模型这次给出的 write 参数里不带坏字节（需重跑，不算通过）')

  // 2. That call was blocked, and the reason is actionable.
  const toolResults = messages.filter(record => record.message.role === 'toolResult')
  const reasons = []
  for (const record of toolResults) {
    const content = Array.isArray(record.message.content) ? record.message.content : []
    const text = content.filter(item => item?.type === 'text').map(item => item.text).join('\n')
    if (text.includes('写入已拦截')) reasons.push(text)
  }
  console.log('blocked toolResults =', reasons.length)
  ok(reasons.length > 0, '真实模型链路里没有出现「写入已拦截」—— 闸没生效')
  const reason = reasons[0] ?? ''
  if (reasons.length > 0) {
    console.log('--- 拦截理由（模型看到的原文）---')
    console.log(reason.slice(0, 600))
    ok(reason.includes('content'), '拦截理由没有指出命中的字段（模型不知道该改哪里）')
    ok(reason.includes('文件未写入'), '拦截理由没有说明「文件未写入」（模型会以为已经写好了）')
    ok(reason.includes('不要原样重发'), '拦截理由没有禁止原样重发（模型会重发同一串坏字节）')
  }

  // 3./4. Nothing on disk.
  const exists = fs.existsSync(target)
  console.log('target exists =', exists)
  ok(exists === false, '目标文件被创建了 —— 闸没有拦住（' + target + '）')
  if (exists) {
    const bytes = fs.readFileSync(target, 'utf8')
    console.log('code points =', [...bytes].map(ch => 'U+' + ch.codePointAt(0).toString(16).toUpperCase()).join(' '))
    const leaked = [...bytes].filter(ch => ch.codePointAt(0) === BAD.codePointAt(0)).length
    ok(leaked === 0, '落盘内容含 ' + leaked + ' 处 U+FFFD —— 坏字节真的写进文件了')
  }

  exitCode = failures.length === 0 ? 0 : 1
  // "No evidence" is 2, not 1: it is neither a pass nor a product defect.
  if (failures.length > 0 && badWrites.length === 0) exitCode = 2
} catch (error) {
  console.error('e2e failed: ' + String(error?.message ?? error))
  ok(false, 'e2e 没跑完（未形成证据）')
  exitCode = 2
} finally {
  try { await proc.close({ timeoutMs: 5000 }) } catch { /* close failure does not change the verdict */ }
}

if (settled === false) {
  console.error('WARN: agent_settled 等待超时（' + String(SETTLE_MS) + ' ms），上面的判据基于已收到的事件。')
}
report(exitCode)

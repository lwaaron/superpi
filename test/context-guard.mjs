#!/usr/bin/env node
/**
 * 上下文窗口化（context guard）的门禁。
 *
 * 三层都要测，缺一层就有一种「看起来做了、其实没生效」的失败模式：
 *   ① 纯函数 —— 估算 / 保护区 / 分级裁剪 / 幂等（`extensions/superpi-context-guard.mjs`）；
 *   ② 落盘 —— 设置读取容错（坏 JSON 不许抛）与观测日志滚动；
 *   ③ **真扩展** —— 用 jiti 加载 `extensions/superpi-context-guard.ts`，喂假 `pi`，
 *      证明 `context` 事件真的把超限请求裁进预算、真的返回 undefined 当无需裁剪、
 *      并且本轮的图片一张都不许动。
 *
 * 第 ③ 层是重点：只测 ①② 的话，「扩展装上了但事件没接上」完全测不出来 ——
 * 而这正是本项目历史上反复出现的失败模式（面板写了、pi 读不到）。
 *
 * 跑法：node test/context-guard.mjs
 * 需要 pi 运行时（jiti 从它那儿借）；找不到就 SKIP 第 ③ 层，①② 照跑。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolvePiRuntime } from '../src/pi-runtime.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)

let checks = 0
let failed = 0
function ok(condition, message) {
  checks += 1
  if (condition) return
  failed += 1
  console.error('FAIL: ' + message)
}
function describe(value) {
  const text = JSON.stringify(value)
  if (typeof text !== 'string') return String(value)
  return text.length > 320 ? text.slice(0, 320) + '…' : text
}
function eq(actual, expected, message) {
  const same = actual !== null && expected !== null && typeof actual === 'object' && typeof expected === 'object'
    ? JSON.stringify(actual) === JSON.stringify(expected)
    : actual === expected
  ok(same, `${message} (got ${describe(actual)}, want ${describe(expected)})`)
}
function section(title) {
  console.log('')
  console.log('── ' + title)
}

const mod = await import(pathToFileURL(path.join(root, 'extensions', 'superpi-context-guard.mjs')).href)
const {
  DEFAULT_GUARD_SETTINGS,
  GUARD_VERSION,
  GUARD_LOG_LIMIT,
  HYGIENE_SECTION_NAME,
  appendGuardLogSync,
  applyHygieneToOptions,
  estimateMessageTokens,
  estimateMessagesTokens,
  imagePlaceholder,
  normalizeGuardSettings,
  planContextWindow,
  protectionStartIndex,
  readGuardLogSync,
  readGuardSettingsSync,
  resolveGuardLogPath,
  renderHygieneBlock,
  resolveGuardPath,
  METER_SECTION_NAME,
  METER_DETAIL_RATIO,
  breakdownMessages,
  goalFromMessages,
  renderMeterBlock,
  applyMeterToOptions,
  resetMeterMemo,
} = mod

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'superpi-guard-'))
const guardFile = path.join(tmp, 'context-guard.json')
const env = { ...process.env, SUPERPI_CONTEXT_GUARD: guardFile }

/* ═════════════════════════════════════════════════════ A. 设置 */

section('A. 设置：归一化必须幂等，坏文件必须不抛')

eq(GUARD_VERSION >= 1, true, '版本号存在')
eq(normalizeGuardSettings(undefined).enabled, true, '默认启用')
eq(normalizeGuardSettings(DEFAULT_GUARD_SETTINGS).targetRatio, DEFAULT_GUARD_SETTINGS.targetRatio, '默认值原样通过')
const idempotent = normalizeGuardSettings(normalizeGuardSettings({ targetRatio: 5, keepRecentTurns: 0, charsPerToken: 0 }))
eq(normalizeGuardSettings(idempotent), idempotent, '归一化幂等（连续两次结果相同）')
eq(idempotent.targetRatio, 0.95, 'targetRatio 被夹到上限')
eq(idempotent.keepRecentTurns, 1, 'keepRecentTurns 被夹到下限')
eq(idempotent.charsPerToken, 1.5, 'charsPerToken 被夹到下限')
eq(normalizeGuardSettings({ enabled: 'yes' }).enabled, false, '非布尔 enabled 视为 false（宁可不动）')

eq(resolveGuardPath({ env: {}, home: 'C:/home/x' }).replace(/\\/g, '/'), 'C:/home/x/.superpi/context-guard.json', '默认路径在 .superpi 下')
eq(resolveGuardPath({ env: { SUPERPI_CONTEXT_GUARD: guardFile }, home: 'C:/home/x' }), path.resolve(guardFile), '环境变量优先')
eq(resolveGuardLogPath({ env, home: tmp }), path.join(tmp, 'context-guard.log.jsonl'), '日志与设置同目录')

eq(readGuardSettingsSync({ env: {}, home: path.join(tmp, 'nope') }).enabled, true, '文件不存在时回退默认且不抛')
fs.writeFileSync(guardFile, '{ this is not json', 'utf8')
eq(readGuardSettingsSync({ env }).enabled, true, '坏 JSON 回退默认且不抛')
fs.writeFileSync(guardFile, JSON.stringify({ enabled: false, targetRatio: 0.5 }), 'utf8')
const loaded = readGuardSettingsSync({ env })
eq(loaded.enabled, false, '读到文件的 enabled')
eq(loaded.targetRatio, 0.5, '读到文件的 targetRatio')

/* ═════════════════════════════════════════════════════ B. 估算 */

section('B. 估算：图片按视觉 token 计，不按字符数')

const settings = normalizeGuardSettings({ charsPerToken: 4, imageTokens: 12000 })
const imageMessage = {
  role: 'toolResult',
  toolCallId: 'c1',
  toolName: 'read',
  content: [
    { type: 'text', text: 'Read image file [image/png]' },
    { type: 'image', data: 'A'.repeat(1_500_000), mimeType: 'image/png' },
  ],
}
const imageTokens = estimateMessageTokens(imageMessage, settings)
eq(imageTokens >= 12000 && imageTokens < 14000, true, '一张 1.5MB 图 ≈ imageTokens，而不是 37 万（' + imageTokens + '）')
const textMessage = { role: 'toolResult', content: [{ type: 'text', text: 'x'.repeat(4000) }] }
eq(estimateMessageTokens(textMessage, settings), 1000, '纯文本按 chars/charsPerToken')
const assistantMessage = {
  role: 'assistant',
  content: [
    { type: 'thinking', thinking: 'y'.repeat(400) },
    { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a.png' } },
  ],
}
ok(estimateMessageTokens(assistantMessage, settings) > 100, '思考与工具参数都计入')
eq(estimateMessagesTokens([textMessage, null, undefined], settings), 1000, '空消息不炸且不加分')

/* ═════════════════════════════════════════════════════ C. 裁剪 */

section('C. 裁剪：分级、保护区、本轮图片、幂等、诚实')

function bigImage(index) {
  return {
    role: 'toolResult',
    toolCallId: 'img' + String(index),
    toolName: 'read',
    content: [
      { type: 'text', text: 'Read image file [image/png]' },
      { type: 'image', data: 'B'.repeat(400000), mimeType: 'image/png' },
    ],
  }
}
function bigTool(index) {
  return {
    role: 'toolResult',
    toolCallId: 'tool' + String(index),
    toolName: 'bash',
    content: [{ type: 'text', text: 'line of output ' + String(index) + '\n' + 'z'.repeat(6000) }],
  }
}
function turn(index) {
  return [
    { role: 'user', content: [{ type: 'text', text: '第 ' + String(index) + ' 轮任务' }] },
    { role: 'assistant', content: [{ type: 'text', text: '开始' }, { type: 'thinking', thinking: 'w'.repeat(2000) }] },
    bigImage(index),
    bigTool(index),
    { role: 'assistant', content: [{ type: 'text', text: '第 ' + String(index) + ' 轮结论' }] },
  ]
}

const manyTurns = []
for (let i = 0; i < 40; i += 1) manyTurns.push(...turn(i))
const windowTokens = 100000
const budget = windowTokens * settings.targetRatio
eq(estimateMessagesTokens(manyTurns, settings) > budget, true, '构造的前置条件：原始消息超预算')

const planned = planContextWindow(manyTurns, { windowTokens, settings })
eq(planned.stats.trimmed, true, '超预算时发生裁剪')
ok(planned.stats.after <= budget, '裁剪后进入预算（' + planned.stats.after + ' <= ' + Math.floor(budget) + '）')
eq(planned.stats.overBudget, false, '达标时不报 overBudget')
ok(planned.stats.stages.images > 0, '先裁图片（' + planned.stats.stages.images + ' 条）')
ok(planned.messages.length === manyTurns.length, '消息条数不变（非破坏性：只换内容，不删消息）')
eq(estimateMessagesTokens(manyTurns, settings), planned.stats.before, '原始输入未被就地修改')

const again = planContextWindow(planned.messages, { windowTokens, settings })
eq(again.stats.after, planned.stats.after, '幂等：对已裁剪结果再跑不再变化')
eq(again.messages, planned.messages, '幂等：直接返回同一数组引用')

// 本轮图片必须保留：最后一条 user 之后读进来的图不能换成占位。
const inTurn = [
  { role: 'user', content: [{ type: 'text', text: '看这几张图' }] },
  { role: 'assistant', content: [{ type: 'toolCall', id: 'k1', name: 'read', arguments: { path: 'a.png' } }, { type: 'toolCall', id: 'k2', name: 'read', arguments: { path: 'b.png' } }] },
  { role: 'toolResult', toolCallId: 'k1', toolName: 'read', content: [{ type: 'image', data: 'C'.repeat(300000) }] },
  { role: 'toolResult', toolCallId: 'k2', toolName: 'read', content: [{ type: 'image', data: 'D'.repeat(300000) }] },
]
for (let i = 0; i < 30; i += 1) inTurn.unshift(...turn(i + 100))
const keep = planContextWindow(inTurn, { windowTokens, settings })
const tailImages = keep.messages.slice(-2).reduce((sum, message) => sum + (Array.isArray(message.content) ? message.content.filter(block => block.type === 'image').length : 0), 0)
eq(tailImages, 2, '本轮的两张图一张都没被替换（低于限额 4，不该裁）')

/* -------------------- C2'. 本轮图片限额：超过上限时必须裁（0.14.0） */

section('C2. 本轮图片限额：48 张只留最近 4 张，text 与 toolCall 一字不动')

/**
 * 这一条对应 docs/performance-acceptance.md 判据 F。
 *
 * 病根：旧规则「本轮图片一律保留」让视觉迭代任务（同一轮里渲染→截图→比对）
 * 产出的几十张图永久免疫裁剪 —— 实测一个真实会话本轮 48 张图 = 576k tokens，
 * 占预算 80%，于是守卫裁到最狠仍超预算 71%、overBudget 恒为 true。
 */
function turnWithImages(count, { textEvery = 1 } = {}) {
  const list = [{ role: 'user', content: [{ type: 'text', text: '看这些图并给结论' }] }]
  for (let i = 0; i < count; i += 1) {
    list.push({ role: 'assistant', content: [{ type: 'toolCall', id: 'tc' + String(i), name: 'read', arguments: { path: 'shot' + String(i) + '.png' } }] })
    list.push({ role: 'toolResult', toolCallId: 'tc' + String(i), toolName: 'read', content: [{ type: 'image', data: 'E'.repeat(200000), mimeType: 'image/png' }] })
    if (textEvery > 0 && i % textEvery === 0) {
      list.push({ role: 'assistant', content: [{ type: 'text', text: '第 ' + String(i) + ' 张的结论：尺子对齐、颜色正确。' }] })
    }
  }
  return list
}
const heavyTurn = turnWithImages(48)
// 前面垫一点历史，确保确实会触发裁剪（本轮自己就已经远超预算）。
for (let i = 0; i < 6; i += 1) heavyTurn.unshift(...turn(i + 200))
const heavyWindow = 300000
const heavySettings = normalizeGuardSettings({ ...settings, keepRecentImagesPerTurn: 4 })
const heavy = planContextWindow(heavyTurn, { windowTokens: heavyWindow, settings: heavySettings })

let heavyTurnImages = 0
{
  let lastUser = heavy.messages.length
  for (let i = heavy.messages.length - 1; i >= 0; i -= 1) {
    if (heavy.messages[i]?.role === 'user') { lastUser = i; break }
  }
  for (let i = lastUser; i < heavy.messages.length; i += 1) {
    heavyTurnImages += Array.isArray(heavy.messages[i].content)
      ? heavy.messages[i].content.filter(block => block.type === 'image').length
      : 0
  }
}
ok(heavyTurnImages <= 4, '本轮图片被裁到限额以内（实际 ' + String(heavyTurnImages) + ' 张，限额 4）')
ok(heavy.stats.imagesDropped >= 44, '确实丢掉了大部分本轮图片（' + String(heavy.stats.imagesDropped) + ' 张）')

// 被替换的位置必须是**带路径的文本占位**（可重读），不能是空块或 undefined。
const replaced = heavy.messages.filter(message => Array.isArray(message.content) &&
  message.content.some(block => block?.type === 'text' && String(block.text).includes('image omitted')))
ok(replaced.length > 0, '被替换的图片变成了 image omitted 占位（' + String(replaced.length) + ' 条）')
ok(replaced.some(message => message.content.some(block => block?.type === 'text' && /shot\d+\.png/.test(String(block.text)))), '占位文本带原文件路径（可重读）')

// 本轮的文本与工具调用结构不能被这条规则碰到：模型正在读的文字抽走就是能力退化。
const heavyOriginalTexts = heavyTurn.filter(message => message.role === 'assistant')
  .map(message => (Array.isArray(message.content) ? message.content.filter(block => block.type === 'text').map(block => block.text).join('') : ''))
const heavyAfterTexts = heavy.messages.filter(message => message.role === 'assistant')
  .map(message => (Array.isArray(message.content) ? message.content.filter(block => block.type === 'text').map(block => block.text).join('') : ''))
eq(heavyAfterTexts.length, heavyOriginalTexts.length, 'assistant 消息条数不变（不做破坏性删除）')
const turnToolCalls = heavy.messages.reduce((sum, message) => sum + (Array.isArray(message.content)
  ? message.content.filter(block => block.type === 'toolCall').length : 0), 0)
const turnToolCallsBefore = heavyTurn.reduce((sum, message) => sum + (Array.isArray(message.content)
  ? message.content.filter(block => block.type === 'toolCall').length : 0), 0)
eq(turnToolCalls, turnToolCallsBefore, 'toolCall 一个都没少（只换图片块，不动调用）')

// 幂等：对结果再跑一次不能再变（否则每轮都在改 prompt，cache 被反复击穿）。
const heavyAgain = planContextWindow(heavy.messages, { windowTokens: heavyWindow, settings: heavySettings })
eq(heavyAgain.stats.imagesDropped, 0, '幂等：已裁过的图片不会被重复计数')
ok(heavyAgain.stats.after <= heavy.stats.after + 1, '幂等：再跑不会变大（' + String(heavyAgain.stats.after) + ' <= ' + String(heavy.stats.after) + '）')

/* -------------------- C3. toolCallArgs 折叠（0.14.0） */

section('C3. 参数折叠：write/edit 的正文不该在上下文里留副本')

/**
 * 判据 G。病根：五个阶段没有一个处理 `toolCall.arguments`，实测裁剪后前缀里
 * assistant 的参数仍有 1,377,032 字符 ≈ 459k tokens，其中 177 条 >2000 字符 ——
 * 全是已落盘的 write/edit 正文，上下文里留一份毫无价值（需要时重新 read 文件）。
 */
function turnWithWrites(index, chars) {
  return [
    { role: 'user', content: [{ type: 'text', text: '第 ' + String(index) + ' 轮' }] },
    {
      role: 'assistant',
      content: [
        { type: 'toolCall', id: 'w' + String(index), name: 'write', arguments: { path: 'src/f' + String(index) + '.mjs', content: 'x'.repeat(chars) } },
        { type: 'text', text: '写好了第 ' + String(index) + ' 个文件' },
      ],
    },
    { role: 'toolResult', toolCallId: 'w' + String(index), toolName: 'write', content: [{ type: 'text', text: 'ok' }] },
  ]
}
const writeTurns = []
for (let i = 0; i < 60; i += 1) writeTurns.push(...turnWithWrites(i, 8000))
// 前置条件必须成立：不超预算时 planContextWindow 按设计一条都不动，
// 那样下面的断言就测不到折叠逻辑（而不是"折叠没生效"）。
ok(estimateMessagesTokens(writeTurns, settings) > Math.floor(100000 * settings.targetRatio), 'C3 前置条件：参数确实撑爆预算')
const writePlanned = planContextWindow(writeTurns, { windowTokens: 100000, settings })
const argSizeOf = list => list.reduce((sum, message) => sum + (Array.isArray(message.content)
  ? message.content.filter(block => block.type === 'toolCall').reduce((inner, block) => inner + JSON.stringify(block.arguments ?? {}).length, 0)
  : 0), 0)
const argBefore = argSizeOf(writeTurns)
const argAfter = argSizeOf(writePlanned.messages)
ok(argAfter < argBefore * 0.2, '参数体积降到原来的 20% 以下（' + argBefore + ' → ' + argAfter + '）')
ok(writePlanned.stats.stages.toolCallArgs > 0, '发生了参数折叠（' + String(writePlanned.stats.stages.toolCallArgs) + ' 条）')

const foldedCalls = writePlanned.messages.flatMap(message => (Array.isArray(message.content)
  ? message.content.filter(block => block.type === 'toolCall' && block.arguments?._omitted === true) : []))
ok(foldedCalls.length > 0, '折叠后的参数带 _omitted 标记（可被门禁识别）')
ok(foldedCalls.every(block => String(block.arguments.note).includes('src/f')), '占位里带文件路径（可重新 read）')
ok(foldedCalls.every(block => typeof block.id === 'string' && typeof block.name === 'string' && block.name.length > 0), 'id 与 name 原样保留（否则 toolResult 配不上，pi 报孤儿）')

// bash 不折叠：它的 command 是"当时干了什么"的唯一线索，且通常很短。
const bashTurn = [
  { role: 'user', content: [{ type: 'text', text: '跑测试' }] },
  { role: 'assistant', content: [{ type: 'toolCall', id: 'b1', name: 'bash', arguments: { command: 'node test/x.mjs 2>&1 | tail -20' + ' && echo ok'.repeat(200) } }] },
  { role: 'toolResult', toolCallId: 'b1', toolName: 'bash', content: [{ type: 'text', text: 'passed' }] },
]
for (let i = 0; i < 45; i += 1) bashTurn.unshift(...turnWithWrites(i + 300, 8000))
const bashPlanned = planContextWindow(bashTurn, { windowTokens: 100000, settings })
const bashCall = bashPlanned.messages.flatMap(message => (Array.isArray(message.content)
  ? message.content.filter(block => block.type === 'toolCall' && block.name === 'bash') : []))[0]
ok(bashCall !== undefined && bashCall.arguments._omitted !== true, 'bash 的 command 不被折叠（要看它干了什么）')

// 本轮（最后一条 user 之后）的参数一律不动：模型正在用它们干活。
const liveTurn = [
  { role: 'user', content: [{ type: 'text', text: '写一个大文件' }] },
  { role: 'assistant', content: [{ type: 'toolCall', id: 'live', name: 'write', arguments: { path: 'big.mjs', content: 'y'.repeat(40000) } }] },
]
for (let i = 0; i < 55; i += 1) liveTurn.unshift(...turnWithWrites(i + 500, 8000))
const livePlanned = planContextWindow(liveTurn, { windowTokens: 100000, settings })
const liveCall = livePlanned.messages.flatMap(message => (Array.isArray(message.content)
  ? message.content.filter(block => block.type === 'toolCall' && block.id === 'live') : []))[0]
ok(liveCall !== undefined && liveCall.arguments._omitted !== true, '本轮的 write 参数不折叠（正在用它干活）')

/* -------------------- C4. overBudget 兜底（0.14.0） */


/* -------------------- C9. 裁剪必须「填满预算」，不许断崖掏空（0.15.4） */

section('C9. 裁剪后的预算利用率不得出现断崖')

/**
 * 这条判据来自一次真机事故，而且是**我自己上一轮修复引入的**。
 *
 * 用户截图：`~46.0%/1.0M` 的上下文，仍然出现畸形工具调用（DSML）→ 会话中断。
 * 46% 远低于我上一轮认定的 77.8% 退化线 —— 说明「占用高导致退化」是错的归因。
 *
 * 真因（构造数据复现）：五阶段折叠是**一刀切**的 ——
 * 某个阶段一旦启动就作用于保护区之前的**全部**消息，然后才看是否达标。
 * 于是出现：**明明有 93% 的预算没用，却把上下文掏空了。**
 *
 * 实测断崖（构造 N 轮、窗口 1M、预算 490117）：
 *   200 轮 → 占预算 **90.2%**（正常）
 *   250 轮 → 占预算 ** 6.6%**（断崖，droppedTurns=0）
 *   300 轮 → 占预算 ** 7.4%**
 *
 * 模型拿到一个「只剩骨架」的历史，就失去了任务上下文 → 开始吐 DSML。
 * 所以这不是"裁剪有效性"问题，是**裁剪粒度与预算严重错配**。
 *
 * 修法：改为按批次（24 条）从旧到新推进，每批处理完立刻估算，达标即停。
 * 同时区分两类阶段（见 progressApply 的注释）：
 *   ① 无条件规则类（images / toolCallArgs）必须跑完 —— 它们的判据是"留着有独立价值损害"
 *   ② 预算救急类（thinking / toolText / toolFold / replies）达标即停
 *
 * 本段门禁锁住「利用率不许断崖」这个性质本身，而不是锁住某个具体实现。
 */
{
  // 构造 N 轮会话：每轮 = user + (thinking + toolCall) + toolResult + assistant 回复
  const buildTurns = (n) => {
    const out = []
    for (let i = 0; i < n; i += 1) {
      out.push({ role: 'user', content: [{ type: 'text', text: '任务' + String(i) }] })
      out.push({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '思考'.repeat(300) },
          { type: 'toolCall', id: 't' + String(i), name: 'bash', arguments: { command: 'cmd' + String(i) } },
        ],
      })
      out.push({ role: 'toolResult', toolCallId: 't' + String(i), toolName: 'bash', content: [{ type: 'text', text: '结果'.repeat(3000) }] })
      out.push({ role: 'assistant', content: [{ type: 'text', text: '完成' + String(i) }] })
    }
    return out
  }

  // ① 只要触发了裁剪，利用率就必须接近预算（>= 80%）。
  //    改前 250/300 轮只有 6.6%/7.4%，这条会直接红。
  const sizes = [220, 240, 250, 300, 400]
  for (const n of sizes) {
    const planned = planContextWindow(buildTurns(n), { windowTokens: 1048576, settings })
    const used = planned.stats.after
    const ratio = used / planned.stats.budget
    const trimmed = used < planned.stats.before
    if (trimmed !== true) continue // 没触发裁剪就不用填满
    ok(ratio >= 0.8,
      'n=' + String(n) + '：触发裁剪后必须填满预算（实测 ' + (ratio * 100).toFixed(1) + '%，要求 >= 80%）')
  }

  // ② 相邻规模之间不许出现"利用率暴跌"（这是断崖的数学定义）。
  //    改前 200→250 是 90.2% → 6.6%，跌幅 83.6 个百分点。
  {
    let worst = 0
    let worstPair = ''
    for (let i = 1; i < sizes.length; i += 1) {
      const a = planContextWindow(buildTurns(sizes[i - 1]), { windowTokens: 1048576, settings })
      const b = planContextWindow(buildTurns(sizes[i]), { windowTokens: 1048576, settings })
      const ra = a.stats.after / a.stats.budget
      const rb = b.stats.after / b.stats.budget
      if (ra < 0.8) continue
      const drop = (ra - rb) * 100
      if (drop > worst) { worst = drop; worstPair = String(sizes[i - 1]) + '→' + String(sizes[i]) }
    }
    ok(worst < 20, '相邻规模间利用率跌幅 < 20 个百���点（实测最大 ' + worst.toFixed(1) + '，' + worstPair + '）')
  }

  // ③ 兜底路径不应再被触发 —— 渐进折叠足够填满预算，不需要整轮丢弃。
  //    （droppedTurns > 0 意味着模型真的丢了整轮历史，代价最高。）
  {
    const planned = planContextWindow(buildTurns(300), { windowTokens: 1048576, settings })
    eq(planned.stats.droppedTurns, 0, '渐进折叠足够时不需要丢整轮（droppedTurns 应为 0）')
  }
}

section('C4. 兜底：裁到最狠仍超预算时按整轮丢弃，而不是只举一只手')

/**
 * 判据 H。病根：五阶段跑完仍超预算时只把 overBudget:true 写进日志，于是日志里
 * 连续上百行全是 true —— 这个信号失去所有区分度。
 */
// 关键：这里的"超"必须**五阶段都治不动**，否则兜底本来就不该触发 ——
// 那就变成"测了个寂寞"。user 正文是唯一五阶段完全碰不到的类别（永不裁剪），
// 用大量超长 user 需求把窗口塞爆，五阶段跑完必然仍超，这时才轮到兜底出场。
const extreme = []
for (let i = 0; i < 400; i += 1) {
  extreme.push({ role: 'user', content: [{ type: 'text', text: '第 ' + String(i) + ' 轮要求：' + '很长的需求描述'.repeat(300) }] })
  extreme.push({ role: 'assistant', content: [{ type: 'text', text: '结论 ' + String(i) }] })
}
const extremeWindow = 120000
ok(estimateMessagesTokens(extreme, settings) > Math.floor(extremeWindow * settings.targetRatio) * 1.5, 'C4 前置条件：确实远超预算')
const extremePlanned = planContextWindow(extreme, { windowTokens: extremeWindow, settings })
ok(extremePlanned.stats.after <= Math.floor(extremeWindow * settings.targetRatio), '极端会话被兜底压回预算内（' + String(extremePlanned.stats.after) + '）')
eq(extremePlanned.stats.overBudget, false, '兜底后不再报 overBudget（信号恢复区分度）')
ok(extremePlanned.stats.droppedTurns > 0, '确实丢了最旧的轮次（' + String(extremePlanned.stats.droppedTurns) + ' 轮）')
// 兜底按「整轮」丢最旧，所以最早那条 user 会被丢掉 —— 这是设计意图（它已完成）。
// 真正要守的是：剩下的第一条 user 仍是一条**完整的**任务要求，不是被截断的半截。
const firstRemainingUser = extremePlanned.messages.find(message => message.role === 'user')
ok(firstRemainingUser !== undefined, '兜底后仍有 user 消息（没有把任务全丢光）')
ok(String(JSON.stringify(firstRemainingUser?.content ?? [])).includes('轮要求：'), '剩下的第一条 user 仍是完整任务要求（按整轮丢，不是截半截）')
const extremeUsers = extremePlanned.messages.filter(message => message.role === 'user').length
ok(extremeUsers >= Math.min(settings.keepRecentTurns, 6), '最近若干轮被保留（剩 ' + String(extremeUsers) + ' 条 user）')

// 只有一轮、且这一轮自己就超预算：不许崩、不许无限循环，必须诚实报 overBudget。
// 单轮、且这一轮**只有 user 正文**（五阶段唯一碰不到的类别）。
// 不用图片：图片一裁就能达标，那样测到的是"图片阶段有效"，不是"无轮可丢"。
const singleRound = [{ role: 'user', content: [{ type: 'text', text: '唯一的一轮，但要求极长：' + '细节'.repeat(200000) }] },
  { role: 'assistant', content: [{ type: 'text', text: '收到' }] }]
const single = planContextWindow(singleRound, { windowTokens: 120000, settings })
eq(single.stats.overBudget, true, '无轮可丢时诚实报 overBudget')
eq(single.stats.droppedTurns, 0, '无轮可丢时不假装丢了')
ok(single.messages.length > 0, '无轮可丢时仍然返回内容（不返回空列表）')
ok(keep.stats.after <= budget || keep.stats.overBudget === true, '本轮图保留后要么达标、要么诚实报 overBudget')

// 保护区不得自己吃掉整个窗口：轮次多、消息多、token 多的会话要能压下来。
const protect = protectionStartIndex(manyTurns, settings, windowTokens)
ok(protect > 0, '保护区起点被算出（' + protect + '）')
const protectedTokens = estimateMessagesTokens(manyTurns.slice(protect), settings)
ok(protectedTokens <= windowTokens * settings.protectedTokenRatio + 13000, '保护区不超过其 token 上限（' + protectedTokens + '）')

// 未超预算时一律不动。
const small = turn(1)
const untouched = planContextWindow(small, { windowTokens: 1000000, settings })
eq(untouched.messages, small, '未超预算时返回原数组（不给 pi 无谓的重放）')
eq(untouched.stats.trimmed, false, '未超预算时 trimmed=false')

// 停用开关：一条都不许动。
const disabled = planContextWindow(manyTurns, { windowTokens, settings: { ...settings, enabled: false } })
eq(disabled.messages, manyTurns, '停用时原样返回')
eq(disabled.stats.disabled, true, '停用时标记 disabled')

// 没有窗口信息时不猜、不动。
const noWindow = planContextWindow(manyTurns, { windowTokens: 0, settings })
eq(noWindow.messages, manyTurns, '窗口未知时原样返回（不瞎裁）')

// 占位文本可逆：带路径，模型能再 read。
ok(imagePlaceholder({ filePath: 'D:/x/a.png', kilobytes: 12 }).includes('D:/x/a.png'), '图片占位带路径（可重读）')
ok(imagePlaceholder({ filePath: 'D:/x/a.png' }).includes('omitted'), '图片占位显式声明已省略')

/* -------------------- C4'. 兜底的三个致命缺陷（0.15.0 实测全部命中） */

section('C4. 兜底：按整轮丢弃，必须真的生效且不丢任务目标')

/**
 * 这三条不是"补充覆盖"，每一条都对应一个**真实存在过、且静默失效**的 bug：
 *
 * ① 索引失效：旧实现把 protectionStartIndex 的绝对下标缓存进 guardFrom，
 *    而每丢一轮都 slice，数组变短、下标没变 → 第二轮 cut 恒 -1 → 直接 break。
 * ② 空切片死锁：cut 落在可丢区第一条 user 上时 slice(start, cut) 是空数组，
 *    防御判据 break —— 兜底"跑了"但一条都没删（droppedTurns 恒 0）。
 * ③ 丢任务目标：cut 落在第二条 user 上时 slice(1, cut) 把**首条 user** 也包进被丢区间，
 *    实测 dropped:9 后剩余消息从「轮9」开始，任务目标没了。
 *
 * 三条共同的表现是：日志里 overBudget 恒 true、droppedTurns 恒 0，
 * 看起来"守卫在工作"，实际兜底从未生效。
 */
function turnList(count, chars) {
  const list = [{ role: 'system', content: [{ type: 'text', text: 'system prompt' }] }]
  for (let i = 0; i < count; i += 1) {
    list.push({ role: 'user', content: [{ type: 'text', text: '轮' + String(i) + ' ' + 'x'.repeat(chars) }] })
    list.push({ role: 'assistant', content: [{ type: 'text', text: '结论' + String(i) }] })
  }
  return list
}

{
  // 用纯 user 正文（五阶段唯一碰不到的类别）逼兜底出手。
  // 数据量必须在本测试的 settings（charsPerToken=4）下确实超预算，
  // 否则测到的是"本就不需要兜底"，而不是"兜底生效"。
  const list = turnList(160, 3000)
  ok(estimateMessagesTokens(list, settings) > Math.floor(100000 * settings.targetRatio), 'C4 前置条件：确实超预算')
  const planned = planContextWindow(list, { windowTokens: 100000, settings })
  ok(planned.stats.droppedTurns > 0, '兜底真的丢了轮次（不是恒 0）——' + String(planned.stats.droppedTurns) + ' 轮')
  ok(planned.stats.after <= planned.stats.budget, '兜底后回到预算内（' + String(planned.stats.after) + ' <= ' + String(planned.stats.budget) + '）')
  eq(planned.stats.overBudget, false, '兜底后不再报 overBudget')

  // ③ 任务目标必须留：首条 user 仍是「轮0」，不是「轮9」。
  const users = planned.messages.filter(message => message.role === 'user')
  ok(users.length > 0, '兜底后仍有 user')
  ok(String(JSON.stringify(users[0].content)).includes('轮0 '), '首条 user（任务目标）仍在，没被丢掉')
  // system 必须留
  ok(planned.messages.some(message => message.role === 'system'), 'system 消息仍在（不然模型不知道能干什么）')
  // 末轮必须留（正在干的活）
  ok(String(JSON.stringify(users[users.length - 1].content)).includes('轮159'), '最后一轮仍在')
}

/* -------------------- C5. 固定开销预留（守卫低估 15 个百分点） */

section('C5. 固定开销：守卫低估系统提示与工具定义，必须显式扣掉')

/**
 * 实测一个真实长会话：守卫算 messages = 638,469，provider 的 totalTokens = 813,842，
 * 相差 **175,373 tokens（16.7 个百分点）** —— 差的就是系统提示 + 工具声明。
 * 不扣的话「守卫算 62% 安全」对应「实际 78%」，再走几轮就撞 1,048,576 硬墙，
 * 历史 2 次 CONTEXT_OVERFLOW 就是这么发生的。
 */
{
  eq(DEFAULT_GUARD_SETTINGS.reservedOverheadTokens > 0, true, '默认预留固定开销（不为 0）')
  ok(DEFAULT_GUARD_SETTINGS.reservedOverheadTokens >= 150000, '预留量覆盖实测的 157k 偏差')

  // 大窗口：必须真的扣掉
  const big = planContextWindow(turnList(10, 100), { windowTokens: 1048576, settings })
  eq(big.stats.reservedOverhead, DEFAULT_GUARD_SETTINGS.reservedOverheadTokens, '大窗口下扣满固定开销')
  eq(big.stats.budget, Math.floor(1048576 * settings.targetRatio) - DEFAULT_GUARD_SETTINGS.reservedOverheadTokens, '预算 = 窗口×targetRatio − 开销')

  // 小窗口：开销比窗口还大时**不能扣**，否则预算被压到地板、守卫疯狂削内容
  // （那是用"更早的降级"换"更晚的溢出"，属于 C5 反模式）。
  const small = planContextWindow(turnList(10, 100), { windowTokens: 100000, settings })
  eq(small.stats.reservedOverhead, 0, '小窗口下不扣固定开销（否则预算失真）')
  eq(small.stats.budget, Math.floor(100000 * settings.targetRatio), '小窗口预算 = 窗口×targetRatio')

  // 预算下限：任何情况下都不低于窗口 40%
  const tiny = planContextWindow(turnList(10, 100), { windowTokens: 200000, settings })
  ok(tiny.stats.budget >= Math.floor(200000 * 0.4), '预算不低于窗口 40%（真下限保护）')

  // 幂等：reservedOverhead 归一化后不变
  const norm = normalizeGuardSettings({ ...DEFAULT_GUARD_SETTINGS })
  eq(norm.reservedOverheadTokens, DEFAULT_GUARD_SETTINGS.reservedOverheadTokens, '归一化保留 reservedOverheadTokens')
  eq(normalizeGuardSettings(norm), norm, '含新字段的归一化仍幂等')
  eq(normalizeGuardSettings({ reservedOverheadTokens: -100 }).reservedOverheadTokens, 0, '负数被夹到 0')
}

/* ═════════════════════════════════════════════════════ C2. 卫生准则 */

section('C2. 上下文卫生：让模型自己知道「图用完即弃」')

const hygiene = renderHygieneBlock({ enabled: true })
ok(hygiene.includes('不要反复 read'), '准则里明确禁止反复读同一张图')
ok(hygiene.includes('_scratch/archive'), '准则里给出中间产物的归档去向')
ok(hygiene.includes('只清理本次任务自己生成的中间产物'), '准则写死边界：不许动用户素材')
eq(renderHygieneBlock({ enabled: false }), '', '停用时不出准则（提示与没装扩展一致）')
eq(renderHygieneBlock({ enabled: true, hygiene: false }), '', '单独关掉 hygiene 时不出准则')
ok(!hygiene.includes('<user_defined_rules>'), '准则不自带规则标签（标签的唯一来源是 pi）')
ok(hygiene.length < 900, '准则足够短（' + hygiene.length + ' 字符，避免顶掉有效上下文）')

const hygieneOptions = { sections: {} }
eq(applyHygieneToOptions(hygieneOptions, { enabled: true }), {}, '注入成功时返回空对象')
eq(typeof hygieneOptions.sections[HYGIENE_SECTION_NAME], 'string', '写进独立 section（不与用户规则抢 key）')
eq(applyHygieneToOptions(hygieneOptions, { enabled: true }), null, '同一内容不重复写（幂等）')
eq(applyHygieneToOptions({ sections: {} }, { enabled: true, hygiene: false }), null, '停用时不动提示')


/* -------------------- C6. 上下文仪表：每轮带上目标 + 占用 + 拆解（0.15.0） */


/* -------------------- C7. 能力退化线：targetRatio 必须留足安全边际（0.15.1） */


/* -------------------- C8. 仪表必须「同档稳定」——否则每轮追加 system 进历史（0.15.2） */

section('C8. 仪表文本在同档位内必须逐字节一致')

/**
 * 这是一次真实事故换来的判据，且它**只在真机跑久了才暴露**。
 *
 * pi 的系统提示是「结构化 sections + diff」：每轮把新 sections 与当前那条 system 的
 * sections 做 diff，有变化就**追加一条 `role:"system"` 进历史**（`agent-session.js:1392`）。
 * 这个增量协议本身很好 —— 缓存因此满血工作（实测 cacheRead 813k、cacheWrite ~200）。
 *
 * 但仪表第一版报**精确百分比**（53.4% → 54.4% → 55.3%），几乎每轮文本都不同，
 * 于是**每轮都追加一条 system**，请求体持续膨胀，直到 provider 判
 * `400 invalid JSON request body`（真机触发点：历史里 9 条 system、其中一条 45KB）。
 *
 * 根因是**架构错位**：把一个高频变化的值放进了设计为「低频稳定」的通道。
 * 修法是量化到档位，让同档内文本逐字节一致 —— **不是**改走 forceSystemPrompt，
 * 那会每轮整份重放提示、直接击穿上面那个缓存（为了修个问题而引入更贵的问题）。
 */
{
  const bd = (total) => ({ text: total, thinking: 0, toolResult: 0, toolCallArgs: 0, images: 0, total })
  const render = (afterTokens) => renderMeterBlock({
    settings,
    windowTokens: 1048576,
    breakdown: bd(afterTokens),
    afterTokens,
    reservedOverhead: DEFAULT_GUARD_SETTINGS.reservedOverheadTokens,
    goal: '目标A',
  })

  // ① 同一档内必须完全一致（这是"不产生 diff"的充要条件）
  // 67.5% 档：after ∈ [547840, 574070)
  const sameBand = [550000, 555000, 560000, 565000, 570000].map(render)
  eq(new Set(sameBand).size, 1, '同一档位内文本逐字节一致（否则每轮产生新 diff）')

  // ② 跨档必须变化（否则信息就没有意义了）
  const b1 = render(300000)
  const b2 = render(700000)
  ok(b1 !== b2, '跨档位时文本必须变化（档位信息要真实）')

  // ③ 关键回归：连续 20 轮的增长中，文本变化次数必须**远小于** 20
  //    第一版是 20/20，改成量化后应 <= 10。这条直接锁住"历史膨胀"这个病。
  {
    let prev = null
    let changes = 0
    for (let i = 0; i < 20; i += 1) {
      const text = render(300000 + i * 18000)
      if (prev !== null && text !== prev) changes += 1
      prev = text
    }
    ok(changes <= 10, '连续 20 轮里文本变化 <= 10 次（实测 ' + String(changes) + ' 次；改前是 20 次 = 每轮都变）')
  }

  // ④ 不报绝对 token 数：它每涨 10k 就改写文本，且对模型决策没有额外价值
  ok(!/tokens）/.test(render(560000).split('\n')[1] ?? '') || !/\d+\.\d+k \//.test(render(560000)),
    '不报绝对 token 数（只报档位百分比 + 窗口大小）')


  // ⑥ 「当前目标」绝不能进系统提示（真机测出的元凶）
  //
  // 目标取的是「最近一条 user 的首行」，每轮必然不同（回复 ok1 → ok2 → ok3）。
  // 第一版把它写进系统提示，真机 5 轮里产生了 5 条额外的 system 消息。
  // 它同时也是零收益字段：模型刚读完用户消息，不需要系统提示再复述一遍。
  {
    const withGoal = renderMeterBlock({
      settings,
      windowTokens: 1048576,
      breakdown: { text: 500000, thinking: 0, toolResult: 0, toolCallArgs: 0, images: 0, total: 500000 },
      afterTokens: 500000,
      reservedOverhead: DEFAULT_GUARD_SETTINGS.reservedOverheadTokens,
      goal: '把登录页改好',
    })
    ok(!withGoal.includes('当前目标'), '系统提示里不含「当前目标」（每轮必变 → 每轮一条 system）')
    ok(!withGoal.includes('把登录页改好'), '目标文本本身也不注入')

    // 目标变了但占用同档 → 文本必须完全一致（这才是"不产生 diff"）
    const goalB = renderMeterBlock({
      settings,
      windowTokens: 1048576,
      breakdown: { text: 500000, thinking: 0, toolResult: 0, toolCallArgs: 0, images: 0, total: 500000 },
      afterTokens: 500000,
      reservedOverhead: DEFAULT_GUARD_SETTINGS.reservedOverheadTokens,
      goal: '完全不同的另一个目标',
    })
    eq(goalB, withGoal, '换目标但占用同档时，仪表文本必须逐字节一致')
  }

  // ⑦ 模块级记忆：同样内容第二次调用必须返回 null（不写 = 不产生 system）
  {
    resetMeterMemo()
    const opts1 = { sections: {} }
    const args = {
      settings,
      windowTokens: 1048576,
      breakdown: { text: 500000, thinking: 0, toolResult: 0, toolCallArgs: 0, images: 0, total: 500000 },
      afterTokens: 500000,
      reservedOverhead: DEFAULT_GUARD_SETTINGS.reservedOverheadTokens,
    }
    eq(applyMeterToOptions(opts1, args), {}, '首次注入返回空对象（写了）')
    const opts2 = { sections: {} }
    eq(applyMeterToOptions(opts2, args), null, '同内容第二次调用返回 null（不写 → pi 不追加 system）')
    eq(opts2.sections[METER_SECTION_NAME], undefined, '第二次确实没往 sections 里塞东西')
    resetMeterMemo()
  }

  // ⑤ 幂等：同样输入两次调用必须完全相等
  eq(render(560000), render(560000), '同一输入幂等')
}

section('C7. targetRatio 必须低于实测的模型能力退化线')

/**
 * 这条判据的直接来源是一次真实事故，且**上一轮的修复没挡住它**：
 *
 * 0.15.0 我把 targetRatio 定在 0.72，理由是「留出输出与系统提示的余量」——
 * 那是从"别撞 1M 上限"推出来的，属于**只防崩溃、不防退化**。
 * 实测结果是：实际发送 71.5%~77.9%，而模型在 77.8% 时开始把工具调用写成
 * DeepSeek 原生 DSML 语法，pi 认不出 → 当普通文本收尾 → 用户看到「中断」。
 *
 * 量化分布（n=1993 次 assistant 调用，单会话）：
 *   0%~68%   1574 次，DSML 0 次
 *   74%~76%    40 次，DSML 0 次
 *   76%~78%   264 次，DSML 34 次（12.9%）← 全部在 77.8~77.9%
 *   78%+       98 次，DSML 0 次（守卫已裁回）
 *
 * 所以退化线约 **74%**，而 0.72 只留 4 个百分点（且实际发送还会因估算误差上浮）。
 * 这条断言把「必须留 >= 10 个百分点边际」写成机器约束，
 * 防止未来有人为了"多保留历史"把 targetRatio 又调回 0.7x。
 */
{
  // 实测得到的退化起点（保守取观测到的最高安全点 74%）。
  const OBSERVED_DEGRADE_LINE = 0.74
  // 必须留的最小安全边际：10 个百分点（估算误差 + 输出预留 + provider 侧模板差异）。
  const MIN_MARGIN = 0.10
  ok(DEFAULT_GUARD_SETTINGS.targetRatio <= OBSERVED_DEGRADE_LINE - MIN_MARGIN,
    'targetRatio(' + String(DEFAULT_GUARD_SETTINGS.targetRatio) + ') 必须 <= 退化线(' +
    String(OBSERVED_DEGRADE_LINE) + ') − 边际(' + String(MIN_MARGIN) + ')，否则模型会在远早于上限处退化')

  // 实际发送量（messages + 固定开销）必须真的落在这条线以下 —— 这才是模型感受到的量。
  const list = turnList(120, 3000)
  const planned = planContextWindow(list, { windowTokens: 1048576, settings })
  const sentTotal = planned.stats.after + planned.stats.reservedOverhead
  ok(sentTotal / 1048576 < OBSERVED_DEGRADE_LINE,
    '实际发送量(' + (sentTotal / 1048576 * 100).toFixed(1) + '%) 必须低于退化线，不能只看 targetRatio')
  ok(planned.stats.after <= planned.stats.budget, '预算约束仍然成立')

  // 硬上限：预算永不得超过 targetRatio（防止 floor 反过来突破上限）
  for (const w of [4000, 16000, 128000, 1048576]) {
    const p = planContextWindow(turnList(40, 2000), { windowTokens: w, settings })
    ok(p.stats.budget <= Math.floor(w * settings.targetRatio),
      '窗口 ' + String(w) + '：预算不超 targetRatio（floor 不得突破上限）')
  }
}

section('C6. 上下文仪表：让模型每轮都知道自己有多满')

/**
 * 用户要求「每次对话都带上当前任务目标和系统上下文占用比例，以及每一种上下文的占比」。
 *
 * 为什么必须进系统提示：模型看不见自己的上下文规模，只能在"感觉快满了"时才想起整理 ——
 * 而那时往往已经撞墙（本会话实测到过 77.6%，距 1M 硬墙只剩 22%）。
 *
 * 三条设计约束，每条都有对应的断言：
 *  ① 低于 50% 只给一行（不浪费 token，但"每轮都带上"必须成立）；
 *  ② ≥50% 给拆解，且必须指出"最贵的是哪一类"（否则等于让模型自己算）；
 *  ③ 不编造进度／百分比（没有真实数据就不装）。
 */
{
  eq(typeof METER_SECTION_NAME, 'string', '仪表有独立 section 名')
  ok(METER_SECTION_NAME !== HYGIENE_SECTION_NAME, '仪表与卫生准则分开（一个是状态事实，一个是行为约束）')
  eq(METER_DETAIL_RATIO, 0.5, '50% 以上才给详细拆解')

  // 构造一组有明确构成的消息
  const meterMessages = [
    { role: 'user', content: [{ type: 'text', text: '目标：把登录页改好' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'z'.repeat(300) }, { type: 'toolCall', id: 'a', name: 'write', arguments: { path: 'x', content: 'y'.repeat(900) } }] },
    { role: 'toolResult', toolCallId: 'a', toolName: 'bash', content: [{ type: 'text', text: 'w'.repeat(3000) }] },
    { role: 'toolResult', toolCallId: 'b', toolName: 'read', content: [{ type: 'image', data: 'A'.repeat(1000), mimeType: 'image/png' }] },
  ]
  const bd = breakdownMessages(meterMessages, settings)
  ok(bd.toolResult > 0, '拆解统计到工具输出')
  ok(bd.thinking > 0, '拆解统计到思考')
  ok(bd.toolCallArgs > 0, '拆解统计到工具参数')
  ok(bd.images > 0, '拆解统计到图片（按 imageTokens 而非字符数）')
  eq(bd.total, bd.text + bd.thinking + bd.toolResult + bd.toolCallArgs + bd.images, 'total = 五类之和')

  // 目标提取：取最近一条 user 的首行
  eq(goalFromMessages(meterMessages), '目标：把登录页改好', '目标取自最近一条 user 的首行')
  eq(goalFromMessages([]), '', '没有 user 时目标为空（不编造）')
  ok(goalFromMessages([{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(300) }] }]).length <= 121, '超长目标被截断')

  // ① 低占比：只一行
  const lowMeter = renderMeterBlock({ settings, windowTokens: 1000000, messages: meterMessages })
  // 规格变更（0.15.2）：目标**不再进**系统提示 —— 它每轮必变，会把'每轮都带上'
  // 变成'每轮都追加一条 system 进历史'。详见 C8 段的真机说明。
  ok(!lowMeter.includes('当前目标'), '低占比也不注入目标（每轮必变的值不能进系统提示）')
  ok(lowMeter.includes('上下文占用'), '低占比也带占用百分比')
  ok(!lowMeter.includes('原始构成'), '低占比不给拆解（不浪费 token）')

  // ② 高占比：给拆解 + 最贵的一类
  const tightMessages = [{ role: 'user', content: [{ type: 'text', text: '目标：继续' }] }]
  for (let i = 0; i < 60; i += 1) tightMessages.push({ role: 'toolResult', toolCallId: 'c' + String(i), toolName: 'bash', content: [{ type: 'text', text: 'o'.repeat(40000) }] })
  const highMeter = renderMeterBlock({ settings, windowTokens: 1000000, messages: tightMessages })
  ok(highMeter.includes('原始构成'), '高占比给按类拆解')
  ok(highMeter.includes('最贵的是'), '指出最贵的一类（不让模型自己算）')
  ok(highMeter.includes('工具输出'), '拆解里有工具输出这一项')
  ok(!/固定开销/.test(highMeter), '不再单独报固定开销绝对量（改由窗口值隐含，避免每轮改文本）')

  // ③ 窗口未知 → 不注入（宁可没有，也不给假百分比）
  eq(renderMeterBlock({ settings, windowTokens: 0, messages: meterMessages }), '', '窗口未知时不注入（不编造）')
  // 停用 → 不注入
  eq(renderMeterBlock({ settings: { ...settings, enabled: false }, windowTokens: 1000000, messages: meterMessages }), '', '停用时仪表也不注入')


  // ④ 双数字：实际发送量 与 原始规模必须都报，且以实际发送量为准（0.15.0 修）
  //
  // 踩过的坑：第一版只报裁剪前的 96%，而实际发送只有 69.5% —— 模型每轮都看到
  // "已接近硬上限"的假警报。那是 D1 类失真（报表与实际不符）。
  {
    const tight = [{ role: 'user', content: [{ type: 'text', text: '目标：继续' }] }]
    for (let i = 0; i < 60; i += 1) tight.push({ role: 'toolResult', toolCallId: 'c' + String(i), toolName: 'bash', content: [{ type: 'text', text: 'o'.repeat(40000) }] })
    const planned = planContextWindow(tight, { windowTokens: 1000000, settings })
    const block = renderMeterBlock({
      settings,
      windowTokens: 1000000,
      messages: tight,
      afterTokens: planned.stats.after,
      reservedOverhead: planned.stats.reservedOverhead,
    })
    const sentPct = Math.round((planned.stats.after + planned.stats.reservedOverhead) / 1000000 * 1000) / 10
    const quantized = Math.round(Math.round(sentPct / 5) * 5)
    ok(block.includes(String(quantized) + '%'), '头部报**实际发送**占比（量化到 ' + String(quantized) + '% 档），不是裁剪前的吓人数字')
    ok(block.includes('原始内容'), '同时报原始规模（让模型知道自己的生产行为是否失控）')
    ok(block.includes('守卫已折叠'), '点明差距是守卫折叠掉的（否则模型会以为数据自相矛盾）')
    // 折叠之后若已达标，就不该再给"接近硬上限"的警告。
    ok(sentPct < 85 || block.includes('已接近硬上限'), '耗尽的警告跟着实际发送量走，不是跟着原始规模')

    // 未折叠时（after == raw）不该出现"已折叠"这句废话
    const clean = renderMeterBlock({ settings, windowTokens: 1000000, messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] })
    ok(!clean.includes('守卫已折叠'), '没有折叠时不显示"已折叠"（不制造噪音）')
  }

  // 幂等 + 可清除
  const meterOptions = { sections: {} }
  eq(applyMeterToOptions(meterOptions, { settings, windowTokens: 1000000, messages: meterMessages }), {}, '注入成功返回空对象')
  ok(typeof meterOptions.sections[METER_SECTION_NAME] === 'string', '写进独立 section')
  eq(applyMeterToOptions(meterOptions, { settings, windowTokens: 1000000, messages: meterMessages }), null, '同一内容不重复写（幂等）')
  // 条件不满足时清掉过期段
  eq(applyMeterToOptions(meterOptions, { settings, windowTokens: 0 }), {}, '窗口未知时清掉过期仪表')
  eq(meterOptions.sections[METER_SECTION_NAME], undefined, '过期段真的被删掉了')
}

/* ═════════════════════════════════════════════════════ D. 日志 */

section('D. 观测日志：滚动上限，坏行不影响其它行')

for (let i = 0; i < GUARD_LOG_LIMIT + 5; i += 1) {
  appendGuardLogSync({ at: new Date().toISOString(), window: 1, budget: 1, before: i, after: i - 1, trimmed: true, stages: {} }, { env })
}
const logLines = fs.readFileSync(resolveGuardLogPath({ env }), 'utf8').split('\n').filter(Boolean)
eq(logLines.length, GUARD_LOG_LIMIT, '日志行数被滚到上限')
fs.appendFileSync(resolveGuardLogPath({ env }), 'not json\n', 'utf8')
const parsedLog = readGuardLogSync({ env, limit: 3 })
ok(parsedLog.length >= 1, '坏行不影响其它行的解析')
eq(appendGuardLogSync({ before: 1 }, { env: { ...env, SUPERPI_CONTEXT_GUARD: path.join(tmp, 'deep', 'x.json') } }), true, '目录不存在时自动建')

/* ═════════════════════════════════════════════════════ E. 真扩展 */

section('E. 真扩展：context 事件真的接上了')

// 扩展内部读的是 process.env（它要能在 pi 进程里零参数工作），所以测试必须把
// 环境变量指到临时文件 —— 否则读到的是用户真实设置，断言会变成"看心情"。
const previousGuardEnv = process.env.SUPERPI_CONTEXT_GUARD
process.env.SUPERPI_CONTEXT_GUARD = guardFile

const pi = resolvePiRuntime({ pluginRoot: root })
let skippedExtension = false
let extensionModule = null
if (!pi.cliPath || !pi.packageDir) {
  console.log('SKIP 扩展层：没有 pi 运行时（先跑一键安装）')
  skippedExtension = true
} else {
  function findJitiEntry(startDir) {
    let dir = path.resolve(startDir)
    for (let depth = 0; depth < 8; depth += 1) {
      const target = path.join(dir, 'node_modules', 'jiti', 'lib', 'jiti.mjs')
      if (fs.existsSync(target)) return target
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return ''
  }
  const jitiPath = findJitiEntry(pi.packageDir)
  if (jitiPath === '') {
    console.log('SKIP 扩展层：找不到 jiti')
    skippedExtension = true
  } else {
    const { createJiti } = await import(pathToFileURL(jitiPath).href)
    const extensionFile = path.join(root, 'extensions', 'superpi-context-guard.ts')
    const jiti = createJiti(extensionFile, { interopDefault: true, moduleCache: false })
    extensionModule = await jiti.import(extensionFile)
  }
}

if (extensionModule !== null) {
  const entry = extensionModule.default
  eq(typeof entry, 'function', '扩展默认导出是函数')
  eq(typeof extensionModule.GUARD_COMMAND, 'string', '导出命令名')

  const handlers = {}
  const commands = []
  const fakePi = {
    on: (name, handler) => { handlers[name] = handler },
    registerCommand: (name, options) => { commands.push({ name, options }) },
  }
  entry(fakePi)
  eq(typeof handlers.context, 'function', '订阅了 context 事件')
  eq(typeof handlers.before_agent_start, 'function', '订阅了 before_agent_start（注入卫生准则）')

  /**
   * 会话切换必须清缓存（0.15.0）。
   *
   * `lastStats` / `lastMeterSnapshot` 是进程级缓存，而 `/new`、`switch_session`
   * 会在**同一进程**里换掉整棵会话树。不清就会让新会话第一轮显示旧会话的占用 ——
   * 模型据此会误判"我已经很满了"，做出保守甚至错误的决策。
   */
  ok(typeof handlers.session_start === 'function', '订阅了 session_start（用于清缓存）')
  ok(typeof handlers.session_switch === 'function', '订阅了 session_switch（用于清缓存）')
  eq(commands.length, 1, '注册了一个命令')
  eq(commands[0].name, extensionModule.GUARD_COMMAND, '命令名与导出常量一致')

  // 让扩展读到「启用 + 小窗口」的设置，保证必然触发裁剪。
  fs.writeFileSync(guardFile, JSON.stringify({ enabled: true, targetRatio: 0.5, keepRecentTurns: 2, keepRecentMessages: 20 }), 'utf8')
  const ctx = { model: { contextWindow: windowTokens } }
  const returned = await handlers.context({ messages: manyTurns }, ctx)
  ok(returned !== null && Array.isArray(returned.messages), '超限时返回 { messages }（真的交给 pi）')
  ok(estimateMessagesTokens(returned.messages, normalizeGuardSettings({ charsPerToken: 3 })) < estimateMessagesTokens(manyTurns, normalizeGuardSettings({ charsPerToken: 3 })), '返回的消息确实变小了')

  const noop = await handlers.context({ messages: turn(1) }, { model: { contextWindow: 1000000 } })
  eq(noop, undefined, '无需裁剪时返回 undefined（不触发 pi 重放提示）')

  // 卫生准则：真扩展必须把「用完即弃」送进系统提示，否则模型永远不知道自己该清图。
  const promptOptions = { sections: {} }
  const hygieneResult = await handlers.before_agent_start({ systemPromptOptions: promptOptions }, ctx)
  eq(hygieneResult, {}, 'before_agent_start 返回空对象（只改 options，不整份重放提示）')
  ok(typeof promptOptions.sections[HYGIENE_SECTION_NAME] === 'string', '准则进了 systemPromptOptions.sections')
  ok(promptOptions.sections[HYGIENE_SECTION_NAME].includes('不要反复 read'), '进提示的准则内容正确')

  const broken = await handlers.context({ messages: null }, ctx)
  eq(broken, undefined, '异常输入不抛、返回 undefined')

  fs.writeFileSync(guardFile, JSON.stringify({ enabled: false }), 'utf8')
  const off = await handlers.context({ messages: manyTurns }, ctx)
  eq(off, undefined, '停用后扩展不动任何东西')
  const offPrompt = { sections: {} }
  eq(await handlers.before_agent_start({ systemPromptOptions: offPrompt }, ctx), undefined, '停用后不注入准则')
  eq(offPrompt.sections[HYGIENE_SECTION_NAME], undefined, '停用后 sections 未被写入')

  // 坏配置退回默认（默认是启用）：守护失效比"静默不裁"更危险，所以这里必须仍然裁剪。
  fs.writeFileSync(guardFile, '{ broken', 'utf8')
  const tolerant = await handlers.context({ messages: manyTurns }, ctx)
  ok(tolerant !== null && Array.isArray(tolerant.messages), '设置文件坏掉时退回默认并继续守护（不抛）')
}

/* ═════════════════════════════════════════════════════ F. 源码约束 */

section('F. 源码约束：不许依赖第三方，不许写 session')

const extensionSource = fs.readFileSync(path.join(root, 'extensions', 'superpi-context-guard.ts'), 'utf8')
const modelSource = fs.readFileSync(path.join(root, 'extensions', 'superpi-context-guard.mjs'), 'utf8')
const piImports = (extensionSource.match(/@earendil-works\/[A-Za-z-]+/g) ?? [])
eq(piImports, [], '扩展不 import @earendil-works/*（多份 pi 副本都能加载）')
eq((modelSource.match(/from '[^.][^']*'/g) ?? []).filter(line => !line.includes('node:')), [], '模型模块只依赖 node 内建')
ok(extensionSource.includes("./superpi-context-guard.mjs"), '扩展引用同目录共享模块（安装后路径不变）')
ok(!/appendContextEdit|writeFileSync\([^)]*session/i.test(extensionSource), '扩展不写 session（非破坏性）')

/* ═════════════════════════════════════════════════════ 收尾 */

try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
if (previousGuardEnv === undefined) delete process.env.SUPERPI_CONTEXT_GUARD
else process.env.SUPERPI_CONTEXT_GUARD = previousGuardEnv
if (skippedExtension) console.log('\n（扩展层被跳过：' + String(checks) + ' checks 已跑）')

if (failed === 0) {
  console.log('')
  console.log('PASS (' + String(checks) + ' checks)')
  process.exit(0)
}
console.error('')
console.error('FAIL (' + String(failed) + '/' + String(checks) + ')')
process.exit(1)

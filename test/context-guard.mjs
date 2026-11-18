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
eq(tailImages, 2, '本轮的两张图一张都没被替换')
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

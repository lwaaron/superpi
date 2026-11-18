/**
 * superpi-context-guard.mjs —— 上下文窗口化的唯一模型层（纯函数 + 落盘读取）。
 *
 * ---------------------------------------------------------------------------
 * 它治的是什么病（一句话）
 *
 * 「历史里的大块内容没有生命周期」：一张 read 进来的 PNG 会以 base64 常驻**之后每一次请求**，
 * 一次会话读十张图，上下文就永久多出几十万 token；等到某次请求超限，pi 给出 400，
 * 会话就**没有任何本地手段能救回来** —— 压缩要把同一份超限历史再发一次（同样 400），
 * 重试只是重发同样请求（同样 400）。这是「用超限的资源去解决超限」的自指死锁。
 *
 * ---------------------------------------------------------------------------
 * 为什么在「扩展的 context 事件」里治，而不是别处
 *
 * | 位置 | 能否治本 | 原因 |
 * | --- | --- | --- |
 * | 改 pi 源码 / node_modules | 否（且违规） | 升级即丢；且病根不是 pi 的 bug，是「内容无生命周期」 |
 * | 改上游错误文案识别表 | 否 | 只是让 pi 认得这个错，压缩输入仍然超限 → 照样失败 |
 * | 面板/host 拦截 | 否 | 面板看不到**即将发出的 messages**，只有事后事件 |
 * | **`pi.on('context')`** | **是** | 每次 LLM 调用前拿到 messages 的深拷贝，可非破坏性改写；不写 session、不耗 token |
 *
 * ---------------------------------------------------------------------------
 * 三条不可退让的设计约束
 *
 * ① **非破坏性**：只改这一次请求的副本。session 文件原样保留，关掉扩展即恢复，
 *    用户仍能回看全部历史（面板/`pi` 的 transcript 不受影响）。
 * ② **单调**：裁剪边界只随会话增长向后移动，同一张图一旦被占位就永远占位。
 *    因此被裁掉的前缀在两次请求之间保持一致，**prompt cache 不会被反复击穿**。
 * ③ **确定性**：不调模型、不联网、不做摘要。同样的输入必得同样的输出，
 *    因此可以单测、可以在超限的瞬间**必然成功**（这是解除死锁的关键：压缩依赖模型，
 *    而模型正是超限的那一方）。
 *
 * ---------------------------------------------------------------------------
 * 裁剪顺序 = 按「信息价值 / 成本」排序（先裁最不该常驻的）
 *
 *   1. 旧图片 → 一行占位（模型已"看过"并写成结论，需要时可再 read）
 *   2. 旧 thinking → 直接丢弃（过程性内容，后续轮次不需要重读自己的思考）
 *   3. 超大工具结果 → 头尾保留 + 省略说明（保留"看了什么"，丢掉全量正文）
 *   4. 更早的回复正文 → 折叠成首行（最后手段）
 *
 * 用户输入**永不裁剪**，最近 `keepRecentTurns` 轮**永不裁剪**。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const GUARD_VERSION = 1

/** 设置文件路径覆盖（与 `SUPERPI_UI_PREFS` / `SUPERPI_RULES` 同风格）。 */
export const GUARD_ENV = 'SUPERPI_CONTEXT_GUARD'
export const GUARD_DIR_NAME = '.superpi'
export const GUARD_FILE_NAME = 'context-guard.json'
export const GUARD_LOG_FILE_NAME = 'context-guard.log.jsonl'

/** 日志最多留多少行（面板要读它显示真实占用；无限增长会变成新的垃圾）。 */
export const GUARD_LOG_LIMIT = 240

/**
 * 上游对一张大 PNG 的计费口径与字符数**无关**（按分辨率算视觉 token），
 * 而 pi 自己的 `estimateTokens` 把图片记成 4800 chars ≈ 1200 tokens —— 实测低估十几倍。
 * 取 12000 作为保守上限：宁可多释放一张旧图，也不要"以为还有余量"地发出去。
 */
export const DEFAULT_IMAGE_TOKENS = 12000

/**
 * 每 token 对应多少字符。英文 ≈ 4，中文 ≈ 1~1.5。取 3 是在两者之间的保守值：
 * 中文场景下不会低估，英文场景下略高估（只会让我们更早裁剪，不会更晚）。
 */
export const DEFAULT_CHARS_PER_TOKEN = 3

export const DEFAULT_GUARD_SETTINGS = {
  version: GUARD_VERSION,
  enabled: true,
  /** 裁剪后目标占模型窗口的比例。留出输出、系统提示与工具声明的余量。 */
  targetRatio: 0.72,
  /** 最近多少轮完整保留（一轮 = 一条 user 消息及其后的 assistant/toolResult）。 */
  keepRecentTurns: 6,
  /**
   * 保护区最多多少条消息。**必须有这条**：长 agent 会话里「一轮」可能包含上百次工具调用，
   * 只按轮次保护会让保护区自己就吃掉整个窗口（实测 17 轮里 10 轮 = 2413 条中的 2000+ 条）。
   */
  keepRecentMessages: 120,
  /** 保护区最多占窗口多少（与上面两条取最严格者，防止保护区本身超预算）。 */
  protectedTokenRatio: 0.3,
  /** 最近多少张图片原样保留（其余所占的 toolResult 整条不动，只换图片块）。 */
  keepRecentImages: 1,
  /** 单条历史工具结果文本超过多少字符才截断。 */
  maxTextChars: 20000,
  charsPerToken: DEFAULT_CHARS_PER_TOKEN,
  imageTokens: DEFAULT_IMAGE_TOKENS,
  /** 0 = 跟随当前模型的 contextWindow。 */
  windowTokens: 0,
  /** 是否把「图片用完即弃」这类行为准则注入系统提示（让模型自己不再制造大块内容）。 */
  hygiene: true,
}

/** 图片被释放后的占位文本。带路径，模型需要时能再 read（可逆）。 */
export function imagePlaceholder({ filePath = '', kilobytes = 0 } = {}) {
  const size = kilobytes > 0 ? ` (${kilobytes}KB)` : ''
  const where = filePath !== '' ? `: ${filePath}` : ''
  return `[image omitted${where}${size} — released from context to stay under the model window; re-read the file if you need it again]`
}

/* ---------------------------------------------------- 上下文卫生（行为准则） */

/** 注入 pi 系统提示的 section 名（与规则扩展的 `user_defined_rules` 并列，互不覆盖）。 */
export const HYGIENE_SECTION_NAME = 'superpi_context_hygiene'

/**
 * 为什么这条要进**系统提示**而不是只在扩展里偷偷裁剪：
 *
 * 裁剪只能保证「这次请求不炸」，模型并不知道自己的图被换成了占位 —— 它会以为图还在，
 * 于是反复 read 同一张图、或者在结论里引用一个已经不在上下文里的细节。把「用完即弃」
 * 变成模型的显式行为准则，才能让它**自己**停止制造大块内容（这才是治生产，不是治库存）。
 *
 * 边界写死在文案里：只允许清理本次任务**自己生成的**中间产物；用户给的原始文件、
 * 被引用的素材一律不动 —— 否则「省上下文」会变成「误删素材」。
 */
export const DEFAULT_HYGIENE_TEXT = [
  '## 上下文卫生（SuperPi 上下文守卫）',
  '- 截图 / 渲染图这类中间产物，看完把结论写下来就够了：**不要反复 read 同一张图**。',
  '- 历史里的图片会在请求前被释放成占位 `[image omitted: 路径]`，这是正常现象；需要再看时按路径重新 read。',
  '- 任务收尾时，把自己生成的临时图片从工作目录移到归档目录（例如 `_scratch/archive/`），不要一直堆在 `_scratch/` 根下。',
  '- **只清理本次任务自己生成的中间产物**；用户提供的原始文件、被引用的素材一律不动，也不要删除任何未经确认的文件。',
].join('\n')

/** 渲染卫生块：停用时返回空串（pi 收到的提示与没装扩展完全一致）。 */
export function renderHygieneBlock(settings = DEFAULT_GUARD_SETTINGS) {
  const normalized = normalizeGuardSettings(settings)
  if (normalized.enabled !== true || normalized.hygiene !== true) return ''
  return DEFAULT_HYGIENE_TEXT
}

/** 把卫生块合并进系统提示（就地改 sections，避免 pi 整份重放提示）。 */
export function applyHygieneToOptions(systemPromptOptions, settings = DEFAULT_GUARD_SETTINGS) {
  const block = renderHygieneBlock(settings)
  if (block === '') return null
  if (systemPromptOptions === null || typeof systemPromptOptions !== 'object') return null
  const sections = systemPromptOptions.sections !== null && typeof systemPromptOptions.sections === 'object'
    ? systemPromptOptions.sections
    : {}
  if (sections[HYGIENE_SECTION_NAME] === block) return null
  sections[HYGIENE_SECTION_NAME] = block
  systemPromptOptions.sections = sections
  return {}
}

export function thinkingPlaceholder() {
  return '[thinking omitted]'
}

export function replyPlaceholder(firstLine) {
  const text = typeof firstLine === 'string' ? firstLine.trim() : ''
  const head = text.length > 160 ? text.slice(0, 160) + '…' : text
  return head !== '' ? `[earlier reply omitted: ${head}]` : '[earlier reply omitted]'
}

/* ------------------------------------------------------------ 设置归一化 */

const clamp = (value, min, max, fallback) => {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

/**
 * 把任意来源的设置夹紧成合法值。**必须幂等**：面板每次读都要过这里，
 * 不幂等会让「保存一次就变一点」的漂移出现（rules 的 checksum 就是被这个坑过）。
 */
export function normalizeGuardSettings(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const base = DEFAULT_GUARD_SETTINGS
  return {
    version: GUARD_VERSION,
    enabled: source.enabled === undefined ? base.enabled : source.enabled === true,
    targetRatio: clamp(source.targetRatio, 0.3, 0.95, base.targetRatio),
    keepRecentTurns: Math.round(clamp(source.keepRecentTurns, 1, 200, base.keepRecentTurns)),
    keepRecentMessages: Math.round(clamp(source.keepRecentMessages, 20, 5000, base.keepRecentMessages)),
    protectedTokenRatio: clamp(source.protectedTokenRatio, 0.05, 0.9, base.protectedTokenRatio),
    keepRecentImages: Math.round(clamp(source.keepRecentImages, 0, 20, base.keepRecentImages)),
    maxTextChars: Math.round(clamp(source.maxTextChars, 2000, 200000, base.maxTextChars)),
    charsPerToken: clamp(source.charsPerToken, 1.5, 6, base.charsPerToken),
    imageTokens: Math.round(clamp(source.imageTokens, 500, 200000, base.imageTokens)),
    windowTokens: Math.round(clamp(source.windowTokens, 0, 100000000, base.windowTokens)),
    hygiene: source.hygiene === undefined ? base.hygiene : source.hygiene === true,
  }
}

export function resolveGuardPath({ env = process.env, home = os.homedir() } = {}) {
  const fromEnv = typeof env?.[GUARD_ENV] === 'string' ? env[GUARD_ENV].trim() : ''
  if (fromEnv !== '') return path.resolve(fromEnv)
  const base = typeof home === 'string' && home.trim() !== '' ? home : os.homedir()
  return path.join(base, GUARD_DIR_NAME, GUARD_FILE_NAME)
}

export function resolveGuardLogPath({ env = process.env, home = os.homedir() } = {}) {
  return path.join(path.dirname(resolveGuardPath({ env, home })), GUARD_LOG_FILE_NAME)
}

/**
 * 读设置（**永不抛**）。文件坏了就用默认值 —— 上下文守护失效最多是"没裁剪"，
 * 绝不能让一轮对话因为一个 JSON 语法错误而起不来。
 *
 * `cache` 传一个对象即可复用（扩展里每轮调用一次，避免高频读盘）。
 */
export function readGuardSettingsSync({ env = process.env, home = os.homedir(), cache = null } = {}) {
  const filePath = resolveGuardPath({ env, home })
  try {
    const stat = fs.statSync(filePath)
    if (cache !== null && typeof cache === 'object' && cache.path === filePath &&
      cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
      return cache.settings
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    const settings = normalizeGuardSettings(parsed)
    if (cache !== null && typeof cache === 'object') {
      cache.path = filePath
      cache.mtimeMs = stat.mtimeMs
      cache.size = stat.size
      cache.settings = settings
    }
    return settings
  } catch {
    return normalizeGuardSettings(DEFAULT_GUARD_SETTINGS)
  }
}

/* ---------------------------------------------------------------- 估算 */

function textTokensOf(chars, settings) {
  return chars > 0 ? Math.ceil(chars / settings.charsPerToken) : 0
}

function contentChars(content) {
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return 0
  let chars = 0
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') chars += block.text.length
    else if (block.type === 'thinking' && typeof block.thinking === 'string') chars += block.thinking.length
    else if (block.type === 'toolCall' && block.arguments !== undefined) chars += safeJsonLength(block.arguments)
  }
  return chars
}

function safeJsonLength(value) {
  try {
    const text = JSON.stringify(value)
    return typeof text === 'string' ? text.length : 0
  } catch {
    return 0
  }
}

/** 数一条消息里有多少张图片（不含已占位的）。 */
export function countImages(message) {
  const content = message?.content
  if (!Array.isArray(content)) return 0
  let count = 0
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'image') count += 1
  }
  return count
}

function imageBytes(message) {
  const content = message?.content
  if (!Array.isArray(content)) return 0
  let bytes = 0
  for (const block of content) {
    if (block === null || typeof block !== 'object' || block.type !== 'image') continue
    const data = typeof block.data === 'string' ? block.data : (typeof block.source?.data === 'string' ? block.source.data : '')
    bytes += data.length
  }
  return bytes
}

/**
 * 单条消息的 token 估算。与 pi 的口径**刻意不同**：图片按 `imageTokens` 而不是 4800 chars，
 * 因为上游按视觉分辨率计费，用 pi 的口径会低估十几倍（实测 3.7% vs 实际超限）。
 */
export function estimateMessageTokens(message, settings = DEFAULT_GUARD_SETTINGS) {
  if (message === null || typeof message !== 'object') return 0
  const role = message.role
  if (role === 'assistant') {
    let tokens = textTokensOf(contentChars(message.content), settings)
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block !== null && typeof block === 'object' && block.type === 'image') tokens += settings.imageTokens
    }
    return tokens
  }
  if (role === 'system') {
    let chars = contentChars(message.content)
    if (message.sections !== null && typeof message.sections === 'object') {
      for (const section of Object.values(message.sections)) {
        if (typeof section === 'string') chars += section.length
      }
    }
    if (message.toolsAdded !== undefined) chars += safeJsonLength(message.toolsAdded)
    return textTokensOf(chars, settings)
  }
  // user / toolResult / custom
  let tokens = textTokensOf(contentChars(message.content), settings)
  for (const block of Array.isArray(message.content) ? message.content : []) {
    if (block !== null && typeof block === 'object' && block.type === 'image') tokens += settings.imageTokens
  }
  return tokens
}

export function estimateMessagesTokens(messages, settings = DEFAULT_GUARD_SETTINGS) {
  let total = 0
  for (const message of Array.isArray(messages) ? messages : []) {
    total += estimateMessageTokens(message, settings)
  }
  return total
}

/* ---------------------------------------------------------------- 裁剪 */

/**
 * 受保护的起点：最近 `keepRecentTurns` 条 user 消息中最早那条的下标。
 * 该下标之后的内容一律不动 —— 模型正在用它干活。
 */
export function protectedFromIndex(messages, keepRecentTurns) {
  let seen = 0
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      seen += 1
      if (seen >= keepRecentTurns) return i
    }
  }
  return 0
}

/**
 * 保护区起点 = 三个约束里**最靠后**的那个（保护范围取最小）。
 *
 * 只按轮次是不够的：一次「轮」里模型可能连续跑上百次工具调用，实测 17 轮的会话里
 * 「最近 10 轮」覆盖了 2413 条消息中的 2000+ 条 —— 保护区自己就把窗口吃光了。
 * 所以再压两条硬上限：消息条数与 token 数。
 */
export function protectionStartIndex(messages, settings = DEFAULT_GUARD_SETTINGS, windowTokens = 0) {
  const list = Array.isArray(messages) ? messages : []
  const byTurns = protectedFromIndex(list, settings.keepRecentTurns)
  const byCount = Math.max(0, list.length - settings.keepRecentMessages)
  const tokenLimit = windowTokens > 0 ? Math.floor(windowTokens * settings.protectedTokenRatio) : 0
  let byTokens = 0
  if (tokenLimit > 0) {
    let accumulated = 0
    byTokens = 0
    for (let i = list.length - 1; i >= 0; i -= 1) {
      accumulated += estimateMessageTokens(list[i], settings)
      if (accumulated > tokenLimit) {
        byTokens = i + 1
        break
      }
    }
  }
  return Math.max(byTurns, byCount, byTokens)
}

/** toolCallId → { name, args }，用于给占位文本找回文件路径。 */
function indexToolCalls(messages) {
  const map = new Map()
  for (const message of messages) {
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block?.type !== 'toolCall' || typeof block.id !== 'string') continue
      map.set(block.id, { name: block.name, args: block.arguments })
    }
  }
  return map
}

function filePathOfCall(call) {
  const args = call?.args
  if (args === null || typeof args !== 'object') return ''
  for (const key of ['path', 'file_path', 'filePath', 'target']) {
    const value = args[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return ''
}

function replaceImages(message, callIndex) {
  const content = Array.isArray(message.content) ? message.content : null
  if (content === null) return null
  const call = typeof message.toolCallId === 'string' ? callIndex.get(message.toolCallId) : undefined
  const filePath = filePathOfCall(call)
  const kilobytes = Math.round(imageBytes(message) / 1024)
  let changed = false
  const blocks = content.map(block => {
    if (block === null || typeof block !== 'object' || block.type !== 'image') return block
    changed = true
    return { type: 'text', text: imagePlaceholder({ filePath, kilobytes }) }
  })
  if (!changed) return null
  return { ...message, content: blocks }
}

function dropThinking(message) {
  if (message?.role !== 'assistant' || !Array.isArray(message.content)) return null
  const kept = message.content.filter(block => block?.type !== 'thinking')
  if (kept.length === message.content.length) return null
  return { ...message, content: kept.length === 0 ? [{ type: 'text', text: thinkingPlaceholder() }] : kept }
}

function truncateToolText(message, maxChars) {
  if (message?.role !== 'toolResult' || !Array.isArray(message.content)) return null
  let changed = false
  const blocks = message.content.map(block => {
    if (block?.type !== 'text' || typeof block.text !== 'string' || block.text.length <= maxChars) return block
    changed = true
    const headLength = Math.floor(maxChars * 0.75)
    const tailLength = Math.floor(maxChars * 0.2)
    const omitted = block.text.length - headLength - tailLength
    const head = block.text.slice(0, headLength)
    const tail = tailLength > 0 ? block.text.slice(block.text.length - tailLength) : ''
    return { ...block, text: `${head}\n…[${omitted} characters omitted from tool output]…\n${tail}` }
  })
  if (!changed) return null
  return { ...message, content: blocks }
}

/**
 * 把旧工具结果折叠成「一行摘要」。
 *
 * 这是**真正的降量大头**：长会话里 1000+ 条工具结果占掉一半以上的上下文，
 * 而模型对已完成轮次的正文几乎没有再读的必要（需要时会重新执行工具）。
 * 保留首行 + 明确的「已省略」标记，模型仍知道"当时做过什么"。
 */
function foldToolResult(message) {
  if (message?.role !== 'toolResult' || !Array.isArray(message.content)) return null
  let changed = false
  const blocks = message.content.map(block => {
    if (block?.type !== 'text' || typeof block.text !== 'string' || block.text.length <= 400) return block
    changed = true
    const firstLine = block.text.split('\n').find(line => line.trim() !== '') ?? ''
    const head = firstLine.length > 160 ? firstLine.slice(0, 160) + '…' : firstLine
    return { ...block, text: '[tool output omitted to free context: ' + head + ']' }
  })
  if (!changed) return null
  return { ...message, content: blocks }
}

function firstTextLine(message) {
  const content = message?.content
  if (typeof content === 'string') return content.split('\n')[0]
  if (!Array.isArray(content)) return ''
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') return block.text.split('\n')[0]
  }
  return ''
}

function foldReply(message) {
  if (message?.role !== 'assistant' || !Array.isArray(message.content)) return null
  let changed = false
  const blocks = message.content.map(block => {
    if (block?.type !== 'text' || typeof block.text !== 'string' || block.text.length <= 240) return block
    changed = true
    return { ...block, text: replyPlaceholder(firstTextLine({ content: [block] })) }
  })
  if (!changed) return null
  return { ...message, content: blocks }
}

/**
 * 按阶段裁剪，每阶段后重算，达标即停。
 *
 * 返回 `{ messages, stats }`。`stats.overBudget === true` 表示「已经裁到最狠仍超预算」——
 * 这是**诚实信号**：那说明该会话需要真正压缩（/compact）或换更大窗口的模型，
 * 面板据此提示用户，而不是假装已经解决。
 */
export function planContextWindow(messages, options = {}) {
  const list = Array.isArray(messages) ? messages : []
  const settings = normalizeGuardSettings(options.settings ?? DEFAULT_GUARD_SETTINGS)
  const windowTokens = Math.round(clamp(options.windowTokens, 0, 100000000, settings.windowTokens))
  const budget = windowTokens > 0 ? Math.floor(windowTokens * settings.targetRatio) : 0
  const before = estimateMessagesTokens(list, settings)
  const emptyStats = {
    version: GUARD_VERSION,
    at: new Date().toISOString(),
    window: windowTokens,
    budget,
    before,
    after: before,
    trimmed: false,
    overBudget: false,
    stages: { images: 0, thinking: 0, toolText: 0, toolFold: 0, replies: 0 },
    imagesDropped: 0,
    imagesKept: 0,
  }
  if (settings.enabled !== true) return { messages: list, stats: { ...emptyStats, disabled: true } }
  if (budget <= 0) return { messages: list, stats: { ...emptyStats, noWindow: true } }
  if (before <= budget) return { messages: list, stats: emptyStats }

  const protectedFrom = protectionStartIndex(list, settings, windowTokens)
  const callIndex = indexToolCalls(list)

  // 最近 N 张图片所在消息豁免（无论轮次），保证"当前正在看的那张"不会被换掉。
  const imageProtected = new Set()
  let imagesSeen = 0
  for (let i = list.length - 1; i >= 0 && imagesSeen < settings.keepRecentImages; i -= 1) {
    if (countImages(list[i]) > 0) {
      imageProtected.add(i)
      imagesSeen += 1
    }
  }

  let current = list.slice()
  const stats = { ...emptyStats, stages: { images: 0, thinking: 0, toolText: 0, toolFold: 0, replies: 0 } }

  // 本轮（最后一条 user 之后）的图片一律保留：模型还没"看过"它们，
  // 替换掉等于让本轮的 read 白做。历史图片则无论是否落在保护区里，都只留最近 N 张。
  let lastUserIndex = list.length
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.role === 'user') {
      lastUserIndex = i
      break
    }
  }

  const apply = (stage, transform, wholeList = false) => {
    let touched = 0
    const end = wholeList ? current.length : protectedFrom
    for (let i = 0; i < end; i += 1) {
      if (stage === 'images') {
        if (imageProtected.has(i)) continue
        if (i >= lastUserIndex) continue
      }
      const next = transform(current[i], i)
      if (next !== null) {
        current[i] = next
        touched += 1
      }
    }
    stats.stages[stage] += touched
    stats.after = estimateMessagesTokens(current, settings)
    return stats.after <= budget
  }

  const done = () =>
    apply('images', message => replaceImages(message, callIndex), true) ||
    apply('thinking', message => dropThinking(message)) ||
    apply('toolText', message => truncateToolText(message, settings.maxTextChars)) ||
    apply('toolFold', message => foldToolResult(message)) ||
    apply('replies', message => foldReply(message))

  done()

  stats.trimmed = stats.after < before
  stats.overBudget = stats.after > budget
  stats.after = estimateMessagesTokens(current, settings)
  stats.imagesKept = current.reduce((sum, message) => sum + countImages(message), 0)
  stats.imagesDropped = Math.max(0, list.reduce((sum, message) => sum + countImages(message), 0) - stats.imagesKept)
  return { messages: current, stats }
}

/* ---------------------------------------------------------------- 日志 */

/**
 * 追加一行观测记录（面板读它显示**真实**占用，而不是失败请求那条畸形 usage 算出的 3.7%）。
 * 滚动保留 `GUARD_LOG_LIMIT` 行；任何异常都吞掉 —— 观测不能影响主流程。
 */
export function appendGuardLogSync(stats, { env = process.env, home = os.homedir() } = {}) {
  try {
    const filePath = resolveGuardLogPath({ env, home })
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const line = JSON.stringify({
      at: stats?.at ?? new Date().toISOString(),
      window: stats?.window ?? 0,
      budget: stats?.budget ?? 0,
      before: stats?.before ?? 0,
      after: stats?.after ?? 0,
      trimmed: stats?.trimmed === true,
      overBudget: stats?.overBudget === true,
      imagesDropped: stats?.imagesDropped ?? 0,
      stages: stats?.stages ?? {},
    })
    let lines = []
    try {
      lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(text => text.trim() !== '')
    } catch {
      lines = []
    }
    lines.push(line)
    if (lines.length > GUARD_LOG_LIMIT) lines = lines.slice(lines.length - GUARD_LOG_LIMIT)
    fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}

export function readGuardLogSync({ env = process.env, home = os.homedir(), limit = 1 } = {}) {
  try {
    const filePath = resolveGuardLogPath({ env, home })
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(text => text.trim() !== '')
    const slice = lines.slice(Math.max(0, lines.length - Math.max(1, limit)))
    const parsed = []
    for (const line of slice) {
      try {
        parsed.push(JSON.parse(line))
      } catch {
        // 单行坏掉不影响其它行（日志是观测面，不是真相面）。
      }
    }
    return parsed
  } catch {
    return []
  }
}

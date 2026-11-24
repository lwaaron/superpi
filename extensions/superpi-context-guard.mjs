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
  /**
   * **最终总占用的上限**（占模型窗口的比例），含固定开销。
   *
   * 0.15.1 修正语义：这个值现在是「实际发送总量 / 窗口」的上限，
   * **不再**是「messages 占窗口」的比例。旧语义让预算算不准 ——
   * 因为固定开销（160k）不在这 72% 里面，于是「targetRatio=72%」实际发出去是 71.5%+
   * 也仍然可能越线，而模型的真实压力取决于总量。
   *
   * ---------------------------------------------------------------------------
   * 为什么从 0.72 降到 0.62（这是一次实测驱动的修正，不是保守）
   *
   * 一个真实会话里，`stopReason` 与 `usage.totalTokens` 的联合分布给出了
   * **一条极干净的能力退化曲线**（n=1993 次 assistant 调用）：
   *
   * | 上下文占用 | 调用数 | 模型输出畸形工具调用(DSML)的比例 |
   * | --- | --- | --- |
   * | 0%~68% | 1574 | **0.0%** |
   * | 74%~76% | 40 | 0.0% |
   * | **76%~78%** | 264 | **12.9%** ← 34 次全部落在这里，具体是 77.8~77.9% |
   * | 78%+ | 98 | 0.0%（守卫已裁回） |
   *
   * 也就是说：占用到 77.8% 时，模型开始把工具调用写成 DeepSeek 的原生 DSML 语法
   * （`<｜｜DSML｜｜ invoke>`），而不是 pi 要求的 JSON 结构；pi 认不出来，
   * 把它当普通文本收尾（`stopReason: stop`），这一轮就结束了 ——
   * **用户看到的就是「会话中断」**。
   *
   * 这不是"上限撞墙"，而是**远早于上限的能力退化**。旧值 0.72 只留了 4 个百分点
   * 的余量（实测发送 71.5%），恰好卡在退化区边缘。
   * 取 0.62 留 14 个百分点：既在退化线（~74%）以下，又不至于无谓砍掉会话历史。
   */
  targetRatio: 0.62,
  /**
   * **不可裁剪的固定开销**（token）：系统提示 + 工具定义 + 模型模板包装。
   *
   * 为什么必须显式扣掉（0.15.0 实测）：守卫只估 `messages`，而 provider 的
   * `usage.totalTokens` 还包含系统提示与全部工具声明。一个真实长会话里两者相差
   * **157,128 tokens（15.0 个百分点）** —— 守卫算 62.6% 认为安全，实际已是 77.6%，
   * 再走几轮就撞 1,048,576 硬墙。历史 2 次 `CONTEXT_OVERFLOW` 正是这么发生的：
   * **守卫以为达标，其实已经超了**。
   *
   * 取 160k 而不是 157k：留一点余量给「换了工具集更多的新版本」。这个值只能靠实测校准，
   * 所以门禁里有一条断言把它与真会话的偏差锁住（超过 20k 就红，提醒重新校准）。
   */
  reservedOverheadTokens: 160000,
  /** 最近多少轮完整保留（一轮 = 一条 user 消息及其后的 assistant/toolResult）。 */
  keepRecentTurns: 6,
  /**
   * 保护区最多多少条消息。**必须有这条**：长 agent 会话里「一轮」可能包含上百次工具调用，
   * 只按轮次保护会让保护区自己就吃掉整个窗口（实测 17 轮里 10 轮 = 2413 条中的 2000+ 条）。
   */
  keepRecentMessages: 120,
  /** 保护区最多占窗口多少（与上面两条取最严格者，防止保护区本身超预算）。 */
  protectedTokenRatio: 0.3,
  /**
   * 最近多少张**历史**图片原样保留（其余所占的 toolResult 整条不动，只换图片块）。
   * 只看「最后一条 user 之前」的图片；本轮的图片由 keepRecentImagesPerTurn 管。
   */
  keepRecentImages: 1,
  /**
   * 本轮（最后一条 user 之后）最多原样保留多少张图片。
   *
   * 为什么必须有这条上限：视觉迭代类任务（渲染 → 截图 → 比对）会在**同一轮内**连续
   * 产图。实测一个真实会话里，最后一条 user 之后有 678 条消息 / 733k tokens，
   * 其中 48 张图 × 12000 = 576k —— 单这一项就吃掉整个预算的 80%。而旧的
   * 「本轮一律不动」规则让这 80% 永久免疫裁剪，于是守卫裁到最狠仍超预算 71%，
   * overBudget 恒为 true、彻底失去区分度（症状见 docs/performance-acceptance.md §2.1）。
   *
   * 保留最近 N 张而不是全留：模型真正正在看的是**最新**那几张；更早的图它已经看过并
   * 写成了结论。占位文本带路径，需要时按路径重新 read —— 能力不损失，只损失
   * 「同时盯着 48 张图」这个本就不该有的特权。
   */
  keepRecentImagesPerTurn: 4,
  /** 单条历史工具结果文本超过多少字符才截断。 */
  maxTextChars: 20000,
  charsPerToken: DEFAULT_CHARS_PER_TOKEN,
  imageTokens: DEFAULT_IMAGE_TOKENS,
  /** 0 = 跟随当前模型的 contextWindow。 */
  windowTokens: 0,
  /** 是否把「图片用完即弃」这类行为准则注入系统提示（让模型自己不再制造大块内容）。 */
  hygiene: true,
  /** 畸形输出时自动重发一次（默认开启；安全判据仍是硬拦截，见 normalizeGuardSettings）。 */
  autoRetryOnMalformed: true,
  /** 两次自动重发的最小间隔（毫秒）。 */
  autoRetryCooldownMs: 30000,
}

/** 图片被释放后的占位文本。带路径，模型需要时能再 read（可逆）。 */
export function imagePlaceholder({ filePath = '', kilobytes = 0 } = {}) {
  const size = kilobytes > 0 ? ` (${kilobytes}KB)` : ''
  const where = filePath !== '' ? `: ${filePath}` : ''
  const reopen = filePath !== '' ? '; re-read the file if you need it again' : ''
  return `[image omitted${where}${size} — released from context to stay under the model window${reopen}]`
}

/**
 * 写入时图片限额：把**累计**超过 `keepRecentImagesPerTurn` 的图片换成路径占位（0.17.0）。
 *
 * ── 为什么必须按「累计」而不是「单条消息」───────────────
 *
 * 第一版实现按「单条 toolResult 内的图片数」限额，实测**收益为 0**：
 * 真实会话的形状是 **118 条消息各含 1 张图**，而不是 1 条消息含 118 张。
 * 每条都没超限额，于是一条都不改。这个错误是靠探针
 * （`_scratch/probe-write-limit-gain.mjs`）抓到的，不是靠推理。
 *
 * ── 为什么必须由调用方传累计状态 ───────────────────────────
 *
 * `tool_result` 的 event **不含会话历史**（只有当前这一条结果），
 * pi 也**没有**提供改写历史的 API。所以「当前已经留下几张图」这个事实
 * 只能由扩展自己在进程内累计。本函数保持纯函数：由调用方传入并更新计数。
 *
 * ── 为什么在**写入时**做（而不是继续靠 context 层）─────────
 *
 * `context` 的契约是 "Modify messages **non-destructively**"：每轮从完整历史重算。
 * 实测 240 轮裁剪日志：`before` 恒定 2,849,944~2,919,604、`imagesDropped` 恒为 117、
 * 压缩比恒定 4.40x —— 两个"恒定"= 每轮重算同一件事，**历史本体永不被改**。
 * 想在根上降低 `before`，只能在图片进入历史那一刻处置。
 *
 * ── 语义 ────────────────────────────────────────────────
 *
 * 累计保留**最近** `limit` 张（模型正在看的是最新那几张；更早的它已写成结论）。
 * 超出部分全部置换为带路径的占位，模型需要时可重新 `read`（可逆）。
 *
 * 纯函数：不改入参、不读盘、不看时钟。
 *
 * @param {Array} content      toolResult 的 content 数组
 * @param {string} filePath    该结果对应的文件路径（可为空）
 * @param {object} settings    归一化后的守卫设置
 * @param {object} counter     累计状态 `{ kept: number }`；**会被就地更新**
 * @returns {Array|null}       需要替换时返回新 content，否则 null
 */
export function limitImagesForWrite(content, filePath = '', settings = DEFAULT_GUARD_SETTINGS, counter = { kept: 0 }, reference = imagePlaceholder) {
  if (Array.isArray(content) === false) return null
  const normalized = normalizeGuardSettings(settings)
  const limit = Math.max(0, normalized.keepRecentImagesPerTurn)

  const imageIndexes = []
  for (let i = 0; i < content.length; i += 1) {
    const block = content[i]
    if (block !== null && typeof block === 'object' && block.type === 'image') imageIndexes.push(i)
  }
  if (imageIndexes.length === 0) return null

  /**
   * 决定这一条里哪几张能留下。
   *
   * `counter.kept` 是「本会话已经写入历史且尚未被置换的图片数」。
   * 从**后往前**分配剩余额度：最新的图最可能仍被需要，所以先给它们。
   * 一旦额度用尽，同一条里更早的图也要置换 —— 这就是"累计"与"单条"的差别。
   */
  const keep = new Set()
  let remaining = limit - (Number(counter.kept) || 0)
  for (let k = imageIndexes.length - 1; k >= 0; k -= 1) {
    if (remaining <= 0) break
    keep.add(imageIndexes[k])
    remaining -= 1
  }

  // 全部都能留下 → 无需改动，只更新计数
  if (keep.size === imageIndexes.length) {
    counter.kept = (Number(counter.kept) || 0) + imageIndexes.length
    return null
  }

  const out = []
  let dropped = 0
  for (let i = 0; i < content.length; i += 1) {
    const block = content[i]
    const isImage = block !== null && typeof block === 'object' && block.type === 'image'
    if (isImage === false || keep.has(i) === true) { out.push(block); continue }
    dropped += 1
    // 写入时拿不到可靠的体积（data 已是 base64，长度换算会误导），
    // 所以只带路径 —— 报一个错数比不报更糟。
    out.push({ type: 'text', text: reference({ filePath: String(filePath ?? '') }, block) })
  }
  counter.kept = (Number(counter.kept) || 0) + keep.size
  if (dropped > 0) counter.dropped = (Number(counter.dropped) || 0) + dropped
  return out
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

/* --------------------------------------------------------- 上下文仪表（0.15.0） */

/** 仪表注入的 section 名（与卫生准则分开：一个是行为约束，一个是状态事实）。 */
export const METER_SECTION_NAME = 'superpi_context_meter'

/**
 * 占用达到这个比例才给「详细拆解」；低于它只给一行紧凑格式。
 *
 * 取 50%：用户明确要求「每次对话都带上当前任务目标和系统上下文占用比例」，
 * 但每轮都塞一段十几行的拆解是纯浪费 —— 50% 以下还远没到需要模型自我整理的程度，
 * 一行足矣；过了 50% 才是真该做决策的时候（这份拆解就是决策依据）。
 */
export const METER_DETAIL_RATIO = 0.5

/** 字符 → token（与 estimateMessageTokens 同一口径，避免两处数字打架）。 */
function estimateTokensFromChars(chars, settings) {
  const per = settings.charsPerToken > 0 ? settings.charsPerToken : DEFAULT_CHARS_PER_TOKEN
  return Math.ceil(chars / per)
}

/**
 * 按类别拆解一组消息的 token 占用。
 *
 * 五类划分对应守卫的五个可裁剪阶段，所以它同时回答两个问题：
 * 「现在被谁占着」与「真需要时能砍掉谁」。只报总数不报构成，
 * 模型就只能说"要整理了"，说不出"该整理什么"。
 */
export function breakdownMessages(messages, settings = DEFAULT_GUARD_SETTINGS) {
  const normalized = normalizeGuardSettings(settings)
  const list = Array.isArray(messages) ? messages : []
  const out = { text: 0, thinking: 0, toolResult: 0, toolCallArgs: 0, images: 0, total: 0 }
  for (const message of list) {
    const content = contextContent(message)
    if (typeof content === 'string') {
      out.text += estimateTokensFromChars(content.length, normalized)
      continue
    }
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue
      if (block.type === 'image') { out.images += normalized.imageTokens; continue }
      if (block.type === 'thinking') { out.thinking += estimateTokensFromChars(String(block.thinking ?? '').length, normalized); continue }
      if (block.type === 'text') {
        const chars = String(block.text ?? '').length
        if (message?.role === 'toolResult') out.toolResult += estimateTokensFromChars(chars, normalized)
        else out.text += estimateTokensFromChars(chars, normalized)
        continue
      }
      if (block.type === 'toolCall') {
        let size = 0
        try { size = JSON.stringify(block.arguments ?? {}).length } catch { size = 0 }
        out.toolCallArgs += estimateTokensFromChars(size, normalized)
      }
    }
  }
  out.total = out.text + out.thinking + out.toolResult + out.toolCallArgs + out.images
  return out
}

/** 从最近一条 user 里取任务目标（首行，截断）。 */
export function goalFromMessages(messages, maxChars = 120) {
  const list = Array.isArray(messages) ? messages : []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.role !== 'user') continue
    const text = firstTextLine(list[i]).trim()
    if (text === '') continue
    return text.length > maxChars ? text.slice(0, maxChars) + '…' : text
  }
  return ''
}

/** token 数简写：1234 → 1.2k，1234567 → 1.2M。 */
function shortCount(value) {
  const n = Number.isFinite(value) ? Math.max(0, value) : 0
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return String(Math.round(n))
}

/**
 * 渲染仪表块。
 *
 * 两条硬约束：
 *  ① **只陈述事实**，不给"必须整理"之类的指令 —— 模型据此自己决定要不要整理；
 *  ② 拆解只在 ≥50% 时给，且**必须**同时给「哪一类最贵」，否则等于让模型自己算。
 */
export function renderMeterBlock(options = {}) {
  const settings = normalizeGuardSettings(options.settings ?? DEFAULT_GUARD_SETTINGS)
  if (settings.enabled !== true || settings.meter === false) return ''
  const windowTokens = Number.isFinite(options.windowTokens) && options.windowTokens > 0 ? Math.round(options.windowTokens) : 0
  if (windowTokens === 0) return ''
  const breakdown = options.breakdown ?? breakdownMessages(options.messages, settings)
  const overhead = Number.isFinite(options.reservedOverhead) ? options.reservedOverhead : settings.reservedOverheadTokens
  /**
   * **两个数字都必须报**（0.15.0 修正）。
   *
   * 踩过的坑：第一版只报"裁剪前"的规模。实测一个会话裁剪前 96%、裁剪后 69.5% ——
   * 于是模型每轮都看到"已接近硬上限"的警告，而实际上守卫已经把那 26 个百分点
   * 折掉了。这是**用吓人的数字制造假警报**，属于 docs/anti-product-patterns.md 的 D1
   * （指标失真：报表难看/好看与实际不符）。
   *
   * 正确的语义是两句话都要：
   *   · 「实际发送 X%」—— 这是这次请求真实的规模，模型该以它为准；
   *   · 「原始内容 Y%（守卫已折叠 Z）」—— 这是"不守会是多少"，让模型知道自己的
   *     生产行为是否失控（否则它会以为上下文很空，继续堆大块内容）。
   */
  const rawUsed = Math.max(0, breakdown.total) + Math.max(0, overhead)
  const sentUsed = Number.isFinite(options.afterTokens) ? Math.max(0, options.afterTokens) + Math.max(0, overhead) : rawUsed
  const rawRatio = rawUsed / windowTokens
  const sentRatio = sentUsed / windowTokens
  /**
   * **量化到档位，不报精确值**（0.15.2 关键修正）。
   *
   * ---------------------------------------------------------------------------
   * 为什么必须量化（这是一次真实事故换来的）
   *
   * pi 的系统提示是**结构化 sections + diff**：每轮把 `buildSystemPromptSections(options)`
   * 与「当前那条 system 的 sections」做 diff，有变化就**追加一条 `role:"system"` 进历史**
   * （`agent-session.js:1392` `_preparePromptAndToolLoadout`）。
   * 那是合理的增量协议 —— 缓存因此能满血工作（实测 cacheRead 813k、cacheWrite 仅 ~200）。
   *
   * 但仪表第一版报的是**精确百分比**（`53.4%` → `54.4%` → `55.3%`…），
   * 几乎每一轮文本都不同 → **每一轮都产生 diff → 每一轮都追加一条 system 进历史**。
   * 后果是请求体持续变大，直到某次 provider 直接判 `400 invalid JSON request body`
   * （实测触发点：历史里累积到 9 条 system、其中一条 45KB 的 project_context）。
   *
   * 换句话说：**我把一个高频变化的值放进了设计为"低频稳定"的通道。**
   * 这是架构错位，不是参数问题。
   *
   * ---------------------------------------------------------------------------
   * 为什么选"量化"而不是"改走 forceSystemPrompt"
   *
   * `forceSystemPrompt`（返回 `systemPrompt`）确实不写历史，但它要求**每轮整份重放系统提示**，
   * 会直接击穿上面那个 cacheRead 813k 的缓存 —— 每轮变成全量 cacheWrite，
   * 成本上升一个量级。那属于"为了修一个问题而引入更贵的问题"，是 C 类反模式。
   *
   * 量化后：占用从 53.4% 走到 54.4% 时文本**完全不变**，不产生 diff；
   * 只有跨过 5% 档位（50% → 55%）才更新一次。信息价值保留（模型仍知道自己在哪一档），
   * 而历史增长从"每轮"降到"每 5 个百分点一次"。
   */
  const pctStep = (value) => Math.round(value * 20) / 20 // 5% 一档
  const sentPct = Math.round(pctStep(sentRatio) * 100)
  // token 数也量化到 10k 档，否则同一档位内 token 变化仍会改文本。
  const bucketTokens = (value) => Math.round(value / 10000) * 10000
  // 目标优先取调用方显式给的（`context` 事件里算好存快照），
  // 其次才从 messages 现推 —— 因为 `before_agent_start` 阶段拿不到 messages。
  const goal = typeof options.goal === 'string' ? options.goal : goalFromMessages(options.messages)

  const lines = []
  /**
   * **不注入「当前目标」**（0.15.2 真机测出的关键修正）。
   *
   * 用户要求「每次对话都带上当前任务目标」，第一版照做了。真机 5 轮实测：
   * 系统提示里每轮都新增一条 system，原因就是这一行 —— 目标取的是「最近一条 user 的首行」，
   * 而它**每轮必然不同**（回复 ok1 → 回复 ok2 → 回复 ok3）。
   * 一个每轮必变的值放进系统提示 = 每轮一次 section diff = 每轮一条 system 进历史
   * = 请求体持续膨胀 → 400 invalid JSON（真机已复现）。
   *
   * 更要紧的是：**它本来就没有信息价值**。模型刚读完用户那条消息，不需要系统提示
   * 再复述一遍「当前目标是 X」；它真正缺的是「我还剩多少空间」（那个仍保留，且已量化）。
   * 所以删掉它不是妥协，是去掉一个「零收益、高成本」的字段。
   *
   * 目标信息改由面板 / Working 行呈现给人看 —— 那才是真正需要它的一方。
   */
  void goal
  /**
   * 只报**档位百分比**，不报绝对 token 数。
   *
   * 试过报 `720.0k / 1.0M tokens`，结果同一 5% 档内 token 每涨 10k 文本就变一次
   * （实测 20 轮里变了 19 次）—— 量化了个寂寞。绝对量对模型的决策没有额外价值：
   * 它需要知道的是"我有多满、该不该收手"，那是百分比；具体多少 token 是面板给人看的。
   */
  lines.push('- 上下文占用 **' + String(sentPct) + '%**（窗口 ' + shortCount(windowTokens) + ' tokens）')
  const trimmedTokens = rawUsed - sentUsed
  // 折叠量同样只报到 10 万档：它是量级信息，不是精确账。
  if (trimmedTokens > 0 && Math.round(pctStep(rawRatio) * 100) > sentPct) {
    // 原始值只报到 **25% 一档**：它是量级信息（'约 3 倍窗口'），越粗越稳定。
    // 用 5% 档时，一个 295% 的会话会在 295/300/305 之间频繁跳，又把 diff 带回来了。
    const coarsePct = Math.round(rawRatio * 4) * 25
    lines.push('- 原始内容约 ' + String(coarsePct) + '%；守卫已折叠到上面那个数字')  }

  if (sentRatio >= METER_DETAIL_RATIO) {
    const parts = [
      ['工具输出', breakdown.toolResult],
      ['对话文本', breakdown.text],
      ['图片', breakdown.images],
      ['工具参数', breakdown.toolCallArgs],
      ['思考', breakdown.thinking],
    ].filter(item => item[1] > 0).sort((a, b) => b[1] - a[1])
    const base = Math.max(1, breakdown.total)
    // 构成比例量化到 10% 一档：这一类内部的细微波动不该改写系统提示。
    const bucketPct = (value) => Math.round(value / base * 10) * 10
    lines.push('- 原始构成：' + parts.map(item => item[0] + ' ' + String(bucketPct(item[1])) + '%').join(' · '))
    if (parts.length > 0) {
      lines.push('- 最贵的是**' + parts[0][0] + '**；需要腾空间时优先处理它（守卫会自动折叠旧内容，但你可以少制造新的）')
    }
    if (sentRatio >= 0.85) {
      lines.push('- **已接近硬上限**（实际发送已达窗口的 85% 以上）。若要继续做长任务，建议先收尾当前子目标，或提示用户开新会话。')
    }
  }
  return lines.join('\n')
}

/**
 * 上一次写入的仪表文本（模块级记忆，0.15.2）。
 *
 * ---------------------------------------------------------------------------
 * 为什么必须自己记（这是真机测出来的）
 *
 * 原本以为 `systemPromptOptions.sections` 会带着上一轮的值，所以能靠
 * `sections[METER_SECTION_NAME] === block` 判断"没变就不写"。
 * 真机实测（5 轮 RPC 会话）发现：**每轮都新增一条 `superpi_context_meter` 的
 * system 消息（10 条 / 5 轮）**。
 *
 * 原因在 `runner.js:1130`：`emitBeforeAgentStart` 每次都用
 * `normalizeBuildSystemPromptOptions(systemPromptOptions)` **重建** options，
 * 拿到的 sections 是"当前系统提示的构成"，**不含上一轮扩展临时塞进去的 key**。
 * 于是 `sections[METER_SECTION_NAME]` 永远是 undefined，「值相同就不写」的短路
 * 一次都不会命中 —— 每轮都当成"新内容"写一遍，pi 就每轮追加一条 system 进历史。
 *
 * 解法：把上次写的内容记在模块级，与历史里那条 system 的 meter 值对账。
 * 文本已量化到 5% 档（见 `renderMeterBlock`），所以只要占用没跨档就完全相同，
 * 真机上从「5 轮 8 条」降到「跨档才写」。
 */
let lastMeterText = ''

/** 把仪表块合并进系统提示（就地改 sections，避免 pi 整份重放提示）。 */
/**
 * 把仪表块合并进系统提示。
 *
 * **只在文本真正变化时才写**（0.15.2）。判据是模块级 `lastMeterText` 而不是
 * `sections[METER_SECTION_NAME]` —— 后者每轮都会丢（见 `lastMeterText` 的注释）。
 *
 * 为什么这件事如此重要：pi 用 sections **diff** 决定是否往历史里追加一条
 * `role:"system"`（`agent-session.js:1392`）。无谓的重写 = 每轮一条 system
 * = 请求体持续膨胀 = 最终 `400 invalid JSON request body`（真机已复现）。
 *
 * 反过来，**该写时必须写**：占用跨档了却不更新，模型就会拿着过期数字做决策。
 * 所以这里不是"尽量少写"，而是"值变了才写、值没变绝不写"。
 */
export function applyMeterToOptions(systemPromptOptions, options = {}) {
  if (systemPromptOptions === null || typeof systemPromptOptions !== 'object') return null
  const block = renderMeterBlock(options)
  const sections = systemPromptOptions.sections !== null && typeof systemPromptOptions.sections === 'object'
    ? systemPromptOptions.sections
    : {}
  if (block === '') {
    /**
     * 条件不再满足（窗口未知 / 停用 / `meter:false`）。
     *
     * 这里**必须只看调用方给的 sections 里有没有残留**，不能看 `lastMeterText`：
     * 停用是"回到什么都没做"的状态（pi 收到的提示与没装扩展完全一致），
     * 若因为模块级记忆里还留着上一轮的文本就返回 `{}`，等于"停用了但还在动提示"。
     * 真机上这会表现为「关掉守卫之后 system 里仍多出一条 meter」。
     */
    if (sections[METER_SECTION_NAME] === undefined) {
      lastMeterText = ''
      return null
    }
    lastMeterText = ''
    delete sections[METER_SECTION_NAME]
    systemPromptOptions.sections = sections
    return {}
  }
  // 文本没变 → 不写。这一条就是"不往历史里追加 system"的开关。
  if (block === lastMeterText) return null
  lastMeterText = block
  sections[METER_SECTION_NAME] = block
  systemPromptOptions.sections = sections
  return {}
}

/** 会话切换时重置仪表记忆（否则新会话会误以为"已经写过同样的内容"）。 */
export function resetMeterMemo() {
  lastMeterText = ''
}

/**
 * 畸形输出后该不该自动重发（0.15.9）。
 *
 * ---------------------------------------------------------------------------
 * **判据顺序不能换，安全的那条必须是硬拦截。**
 *
 * 1. `settings.autoRetryOnMalformed` 为真 —— 否则不重发（用户关掉了）
 * 2. **上一轮完全没有 toolCall** —— 这是安全边界，不是可配置项：
 *    畸形输出时无法确定工具到底执行了没有；若已有 toolCall，重发可能让它**再执行一遍**
 *    （`write` / `git push` / `rm` 都可能重复生效）。那种情况下宁可让用户自己决定。
 * 3. 距上次自动重发已超过 `autoRetryCooldownMs` —— 防止模型持续故障时快速循环烧钱。
 *
 * @param {{ autoRetryOnMalformed?: boolean, autoRetryCooldownMs?: number }} settings
 * @param {{ hadToolCall?: boolean, lastAutoRetryAt?: number, now?: number }} state
 * @returns {{ retry: boolean, reason: string }}
 */
export function shouldAutoRetryOnMalformed(settings = DEFAULT_GUARD_SETTINGS, state = {}) {
  const normalized = normalizeGuardSettings(settings)
  if (normalized.autoRetryOnMalformed !== true) return { retry: false, reason: 'disabled' }
  if (state.hadToolCall === true) return { retry: false, reason: 'had-tool-call' }
  const now = Number.isFinite(state.now) ? state.now : Date.now()
  const last = Number.isFinite(state.lastAutoRetryAt) ? state.lastAutoRetryAt : 0
  const cooldown = normalized.autoRetryCooldownMs
  if (cooldown > 0 && last > 0 && now - last < cooldown) {
    return { retry: false, reason: 'cooldown' }
  }
  return { retry: true, reason: 'ok' }
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
    // 固定开销：0 = 不预留（老配置兼容），上限不超过窗口本身（由 budget 计算再夹一次）。
    reservedOverheadTokens: Math.round(clamp(source.reservedOverheadTokens, 0, 2000000, base.reservedOverheadTokens)),
    keepRecentTurns: Math.round(clamp(source.keepRecentTurns, 1, 200, base.keepRecentTurns)),
    keepRecentMessages: Math.round(clamp(source.keepRecentMessages, 20, 5000, base.keepRecentMessages)),
    protectedTokenRatio: clamp(source.protectedTokenRatio, 0.05, 0.9, base.protectedTokenRatio),
    keepRecentImages: Math.round(clamp(source.keepRecentImages, 0, 20, base.keepRecentImages)),
    keepRecentImagesPerTurn: Math.round(clamp(source.keepRecentImagesPerTurn, 0, 200, base.keepRecentImagesPerTurn)),
  maxTextChars: Math.round(clamp(source.maxTextChars, 2000, 200000, base.maxTextChars)),
  charsPerToken: clamp(source.charsPerToken, 1.5, 6, base.charsPerToken),
  imageTokens: Math.round(clamp(source.imageTokens, 500, 200000, base.imageTokens)),
  windowTokens: Math.round(clamp(source.windowTokens, 0, 100000000, base.windowTokens)),
  hygiene: source.hygiene === undefined ? base.hygiene : source.hygiene === true,
  /**
   * 畸形输出时是否自动重发一次「继续」（0.15.9，**默认开启**）。
   *
   * ---------------------------------------------------------------------------
   * 为什么默认开启
   *
   * 用户实测：模型吐 DSML → 本轮工具调用丢失 → 屏幕上只有一段独白，然后会话结束。
   * 虽然 0.15.7 把它变成了明确提示（「本轮未执行，重发即可」），但**任务仍然是断的**，
   * 用户得自己敲「继续」。目标不是"让故障可见"，而是"让任务跑完"。
   *
   * ---------------------------------------------------------------------------
   * 但"自动重发"有一个真实危险，所以安全判据是**硬拦截**，不是开关能绕过的：
   *
   * 畸形输出发生时，**无法确定上一轮的工具调用到底执行了没有**。
   * 若模型其实已经跑了 `write` / `git push` / `rm`，只是输出格式坏了，
   * 那么重发就可能让它**再执行一遍** —— 在编码 agent 里这比中断危险得多。
   *
   * 因此自动重发只在一个条件下发生：**上一轮确实没有产生任何 toolCall**。
   * 那种情况下「重复执行」的风险严格为零（根本没有执行过任何工具）。
   *
   * 判据顺序（`shouldAutoRetryOnMalformed`）：开关 → 无 toolCall → 冷却。
   * 开关只是"是否启用"，**不能**把"有 toolCall 时也重发"打开 —— 门禁锁死这一点。
   */
  autoRetryOnMalformed: source.autoRetryOnMalformed === undefined ? base.autoRetryOnMalformed : source.autoRetryOnMalformed === true,
  /**
   * 自动重发的冷却（毫秒）：同一会话内两次自动重发至少间隔这么久。
   *
   * 为什么需要：若模型连续多次畸形输出（例如模型侧持续故障），
   * 无冷却的重发会变成**快速循环烧钱**。默认 30 秒 —— 比一次正常轮次略长，
   * 足以避免"背靠背重试"，又不至于让用户等太久。
   */
  autoRetryCooldownMs: Math.round(clamp(source.autoRetryCooldownMs, 0, 600000, base.autoRetryCooldownMs)),
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

function contextContent(message) {
  if (message?.role === 'compactionSummary' || message?.role === 'branchSummary') return message.summary
  if (message?.role === 'bashExecution') {
    return message.excludeFromContext ? '' : (message.command ?? '') + '\n' + (message.output ?? '')
  }
  return message?.content
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
  let tokens = textTokensOf(contentChars(contextContent(message)), settings)
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
 *
 * ---------------------------------------------------------------------------
 * **token 上限的基准必须是「预算」而不是「窗口」**（0.15.4 修正，这是真 bug）
 *
 * 旧实现：`tokenLimit = windowTokens * protectedTokenRatio`（= 窗口的 30%）
 * 而预算 = `窗口 × targetRatio − 固定开销`（= 46.7%）。
 * 两个口径的**分母不同**，于是保护区吃掉了预算的 **64%**，只剩 36% 可自由分配。
 *
 * 实测后果（构造 200/250/300 轮三组）：
 *   200 轮 → 裁剪后占预算 **90.2%**（正常）
 *   250 轮 → 裁剪后占预算 **6.6%**（断崖）
 * 从 90% 直接掉到 6.6%：因为非保护区不够用时，`dropOldestTurns` 只能一路丢到
 * 保护区边界，而边界离起点太近 —— **模型瞬间失去几乎全部历史**。
 * 上下文被掏空后模型开始输出畸形工具调用（DSML），用户看到的就是「会话中断」。
 *
 * 所以 `budget` 参数要传进来，保护区按**预算**的比例算，让两个口径同源。
 * 不传 budget 时退回旧行为（仅为兼容既有单测的调用方式），但门禁会断言
 * 生产路径必须传 budget。
 */
export function protectionStartIndex(messages, settings = DEFAULT_GUARD_SETTINGS, windowTokens = 0, budget = 0) {
  const list = Array.isArray(messages) ? messages : []
  const byTurns = protectedFromIndex(list, settings.keepRecentTurns)
  const byCount = Math.max(0, list.length - settings.keepRecentMessages)
  // 基准优先用 budget（与裁剪预算同源）；没有就退回窗口比例（兼容旧调用）。
  const base = budget > 0 ? budget : (windowTokens > 0 ? windowTokens : 0)
  const tokenLimit = base > 0 ? Math.floor(base * settings.protectedTokenRatio) : 0
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

function replaceImages(message, callIndex, keepNewest = 0) {
  const content = Array.isArray(message.content) ? message.content : null
  if (content === null) return null
  let toReplace = countImages(message) - keepNewest
  if (toReplace <= 0) return null
  const call = typeof message.toolCallId === 'string' ? callIndex.get(message.toolCallId) : undefined
  const filePath = filePathOfCall(call)
  const kilobytes = Math.round(imageBytes(message) / 1024)
  const blocks = content.map(block => {
    if (block?.type !== 'image' || toReplace <= 0) return block
    toReplace -= 1
    return { type: 'text', text: imagePlaceholder({ filePath, kilobytes }) }
  })
  return { ...message, content: blocks }
}

function recentImageAllowance(messages, start, end, remaining) {
  const allowed = new Map()
  for (let index = end - 1; index >= start && remaining > 0; index -= 1) {
    const kept = Math.min(remaining, countImages(messages[index]))
    if (kept > 0) allowed.set(index, kept)
    remaining -= kept
  }
  return allowed
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

/**
 * 折叠旧的工具调用参数（write / edit / patch 类）。
 *
 * 为什么需要这一阶段：五个既有阶段（images / thinking / toolText / toolFold / replies）
 * 没有任何一个碰 `toolCall.arguments`。实测一个真实会话在裁剪后，前缀里 assistant 的
 * toolCall 参数仍有 1,377,032 字符 ≈ 459k tokens（其中 177 条 >2000 字符累计 248k）——
 * 它们全是 write / edit 的正文，也就是**已经落盘的文件内容**。上下文里留一份副本
 * 毫无价值：需要时模型可以重新 read 文件，那是唯一可信的真相。
 *
 * 只折叠「内容型」工具。`bash` 的 command 不折叠 —— 它是"当时干了什么"的唯一线索，
 * 而且通常很短（长的是它的**输出**，那是 toolFold 的职责）。
 *
 * id / name 必须原样保留：pi 按 toolCallId 把 toolResult 配回调用行，改了就是孤儿。
 */
const ARG_FOLD_TOOLS = new Set(['write', 'edit', 'patch', 'apply_patch', 'multiedit', 'multi_edit'])
/** 参数 JSON 短于这个长度就不折（折叠收益还不够占位文本本身）。 */
const ARG_FOLD_MIN_CHARS = 1200

function foldToolCallArgs(message, completedWrites) {
  if (message?.role !== 'assistant' || !Array.isArray(message.content)) return null
  let changed = false
  const blocks = message.content.map(block => {
    if (block?.type !== 'toolCall') return block
    const name = typeof block.name === 'string' ? block.name.toLowerCase() : ''
    if (!ARG_FOLD_TOOLS.has(name)) return block
    if (completedWrites && (!completedWrites.has(block.id) || !['write', 'edit'].includes(name))) return block
    if (block.arguments?._omitted === true) return block
    const size = safeJsonLength(block.arguments)
    if (size < ARG_FOLD_MIN_CHARS) return block
    const filePath = filePathOfCall({ name: block.name, args: block.arguments })
    if (completedWrites && filePath === '') return block
    changed = true
    const where = filePath !== '' ? filePath : '(unknown path)'
    return {
      ...block,
      arguments: {
        _omitted: true,
        path: filePath,
        chars: size,
        note: completedWrites
          ? `[${name} completed: ${where}. Read the file for its current contents.]`
          : `[${name} arguments omitted: ${where}. The original call remains in session history.]`,
      },
    }
  })
  if (!changed) return null
  return { ...message, content: blocks }
}

/** Project only confirmed writes. The original call stays in Pi's session tree. */
export function foldCompletedWriteArgs(message, toolResults) {
  const completed = new Set(toolResults.filter(result => result.isError === false).map(result => result.toolCallId))
  return completed.size === 0 ? null : foldToolCallArgs(message, completed)
}

/**
 * 兜底：按整轮（user 边界）丢弃最旧的轮次，直到回到预算以内。
 *
 * 为什么需要它：裁到最狠仍超预算时，旧实现只把 `overBudget: true` 写进日志。
 * 于是日志连续上百行全是 true，这个信号失去了所有区分度 —— 既不能告警也不能解释。
 * 兜底之后，`overBudget: true` 重新表示「这个会话真的没救了，必须 /compact 或新建」。
 *
 * 三条不可退让的保留：
 *  ① 所有 system 消息（工具声明与系统提示没了，模型就不知道能干什么）；
 *  ② 首条 user 消息（任务目标不能丢，丢了这轮就是"没有需求的执行"）；
 *  ③ 最近 keepRecentTurns 轮（正在干的活不能丢）。
 * 找不到可丢的边界就停（不无限循环），返回原数组由调用方诚实报 overBudget。
 */
/**
 * 兜底：按整轮（user 边界）丢弃最旧的轮次，直到回到预算以内。
 *
 * 三条不可退让的保留：首条 user（任务目标）、最近 keepRecentTurns 轮（正在干的活）、
 * 所有 system（系统提示）。
 *
 * 0.15.0 修一个索引失效缺陷：旧实现把 `protectionStartIndex(...)` 算出的**绝对下标**
 * 存进 `guardFrom`，但每丢一轮都要 `current.slice(cut)`，数组变短而 `guardFrom` 没跟着变 ——
 * 第二轮循环时 `i >= guardFrom` 立刻成立、`cut` 保持 -1、直接 break。
 * 结果就是「明明还有 80 轮可丢，却 `droppedTurns` 恒为 0」。
 * 现在改成**每轮重新找边界**（相对结构，不存绝对下标）。
 */
/**
 * 兜底：按整轮（user 边界）丢弃最旧的轮次，直到回到预算以内。
 *
 * 三条不可退让的保留：首条 user（任务目标）、最近 keepRecentTurns 轮（正在干的活）、
 * 所有 system（系统提示）。
 *
 * ---------------------------------------------------------------------------
 * 0.15.0 修两个叠加缺陷，它们让兜底**从来没有生效过**（`droppedTurns` 恒为 0）：
 *
 * ① **索引失效**：旧实现把 `protectionStartIndex(...)` 的**绝对下标**存进 `guardFrom`，
 *    但每丢一轮都 `current.slice(cut)`，数组变短而 `guardFrom` 没跟着变 ——
 *    第二轮循环 `i >= guardFrom` 立刻成立、`cut` 保持 -1、直接 break。
 *    现在改成每轮**重新计算**边界，不存任何绝对下标。
 *
 * ② **长度防御误判（真正的死锁点）**：旧实现用 `merged.length >= current.length` 防死循环，
 *    但 `merged` 里把 system 消息**拼回去了**，于是「丢掉一轮」和「补回 system」
 *    在长度上互相抵消 —— 长度恒相等，第一次迭代就 break。
 *    现在用 `droppedTurns` 的推进 + 剩余**消息条数**双重判据，且比较的是
 *    「切出去的那段是否为空」，而不是总数。
 */
function dropOldestTurns(messages, { settings, windowTokens, budget, estimate }) {
  const list = Array.isArray(messages) ? messages : []
  const firstUserIndex = list.findIndex(message => message?.role === 'user')
  if (firstUserIndex < 0) return { messages: list, droppedTurns: 0 }

  /**
   * 不可动前缀 = 所有 system + **首条 user**（任务目标）。
   *
   * 为什么必须显式切成「前缀 / 可丢区 / 保护区」三段：旧写法用 `slice(1, cut)` 表达
   * "丢掉中间那段"，但 cut 一旦落在第二条 user 上，第一条 user 自己也被包进被丢区间 ——
   * 实测 `dropped:9` 之后剩余消息从「轮9」开始，**任务目标（轮0）被丢了**。
   * 丢任务目标比超限更糟：会话还在，但已经不知道要干什么。
   */
  const prefix = list.slice(0, firstUserIndex + 1)
  let current = list
  let droppedTurns = 0
  let total = estimate(current, settings)

  /**
   * 每轮丢「一条完整轮次」= 从可丢区第一条 user 起，到**下一条 user** 之前。
   *
   * 关键：切点必须是「下一条 user」，不是「第一条 user」。
   * 踩过两次同一个坑：cut 落在可丢区的第一条 user 上时 `slice(start, cut)` 是空数组，
   * 防御判据立刻 break —— 兜底看起来"跑了"，实际一条都没删（`droppedTurns` 恒 0 或恒 1）。
   */
  while (total > budget) {
    // 与 planContextWindow 同基准（budget），否则保护区边界算得靠前，一丢就塌。
    const protectFrom = protectionStartIndex(current, settings, windowTokens, budget)
    const bodyStart = prefix.length
    // 可丢区里的第一条 user（= 要丢的那一轮的开头）。
    let turnStart = -1
    for (let i = bodyStart; i < current.length && i < protectFrom; i += 1) {
      if (current[i]?.role === 'user') { turnStart = i; break }
    }
    if (turnStart < 0) break
    // 下一条 user（= 丢这一轮的终点，且它本身必须保留）。
    let turnEnd = -1
    for (let i = turnStart + 1; i < current.length && i < protectFrom; i += 1) {
      if (current[i]?.role === 'user') { turnEnd = i; break }
    }
    // 找不到下一条 user 说明可丢区只剩一轮 —— 再丢就会把保护区啃掉，停手。
    if (turnEnd < 0) break
    current = [...current.slice(0, turnStart), ...current.slice(turnEnd)]
    droppedTurns += 1
    total = estimate(current, settings)
  }
  return { messages: droppedTurns > 0 ? current : list, droppedTurns }
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
  /**
   * 预算 = 窗口 × targetRatio − 不可裁剪的固定开销。
   *
   * 为什么要减（0.15.0 实测）：守卫只估 messages，provider 的 totalTokens 还含
   * 系统提示 + 工具定义。真实长会话里两者相差 **157,128 tokens（15 个百分点）** ——
   * 不减的话「守卫算 62.6% 安全」对应「实际 77.6%」，再走几轮就撞硬墙。
   *
   * 三条边界，缺一条都会造成新的病：
   *  ① **只有窗口足够大才扣**：overhead 是「系统提示 + 全部工具声明」的实测值（160k），
   *     它在小窗口（如 100k）里可能比整个窗口还大。此时扣掉等于把预算压到 0，
   *     守卫会疯狂削内容 —— 那是用「更早的降级」换「更晚的溢出」，属于
   *     docs/anti-product-patterns.md 的 C5。所以只在 `window > overhead / targetRatio`
   *     时生效（即系统提示占比 < targetRatio 才有意义）。
   *  ② **扣完不低于窗口的 40%**：真正的下限保护，确保守卫不会把会话削成骨架。
   *  ③ 统计里记 `reservedOverhead` 实际扣了多少（0 = 没扣），观测与门禁都靠它。
   */
  /**
   * messages 预算 = 窗口 × targetRatio − 固定开销。
   *
   * 语义（0.15.1 起）：`targetRatio` 约束的是**最终总占用**（messages + 开销），
   * 所以 messages 的预算必须先扣掉开销。旧实现把 targetRatio 当成 messages 的上限，
   * 于是「72%」发出去是 71.5%+，而模型真正感到压力的是总量 —— 两套口径对不上。
   *
   * 两个夹取，防止边界情况把守卫逼疯：
   *  ① 小窗口不扣开销（160k 可能比整个窗口还大，扣了预算就成负数）；
   *  ② 预算不低于窗口 30% —— 但**同时不得高于 targetRatio**，否则下限会反过来
   *     突破上限（0.62 target 配 0.4 floor 在极端小窗口下会变成 0.4 > 0.62−overhead，
   *     那样"保护会话"就变成了"允许越线"）。
   */
  const targetBudget = windowTokens > 0 ? Math.floor(windowTokens * settings.targetRatio) : 0
  // ① 只有窗口明显大于固定开销时才扣（否则扣了会失真）。
  const overheadApplies = windowTokens > 0 && settings.reservedOverheadTokens > 0 &&
    windowTokens * settings.targetRatio > settings.reservedOverheadTokens * 1.25
  const overhead = overheadApplies ? settings.reservedOverheadTokens : 0
  // ② 下限不得突破上限：floor 先被 targetRatio 夹一次。
  const rawFloor = windowTokens > 0 ? Math.floor(windowTokens * 0.3) : 0
  const floorBudget = Math.min(rawFloor, targetBudget)
  // 无论怎么算，预算都不得超过 targetBudget（那是硬上限，不是目标值）。
  const budget = windowTokens > 0
    ? Math.min(targetBudget, Math.max(floorBudget, targetBudget - overhead))
    : 0
  const before = estimateMessagesTokens(list, settings)
  const emptyStats = {
    version: GUARD_VERSION,
    at: new Date().toISOString(),
    window: windowTokens,
    budget,
    /** 从预算里扣掉的固定开销（系统提示 + 工具定义）。0 = 没扣。 */
    reservedOverhead: overhead,
    before,
    after: before,
    trimmed: false,
    overBudget: false,
    stages: { images: 0, thinking: 0, toolText: 0, toolFold: 0, replies: 0 },
    imagesDropped: 0,
    imagesKept: 0,
    /** 兜底阶段丢掉了几个最旧的轮次（0 = 不需要兜底）。 */
    droppedTurns: 0,
  }
  if (settings.enabled !== true) return { messages: list, stats: { ...emptyStats, disabled: true } }
  if (budget <= 0) return { messages: list, stats: { ...emptyStats, noWindow: true } }
  /**
   * 提前返回只在「没有无条件规则要执行」时才成立。
   *
   * `keepRecentImagesPerTurn`（本轮图片限额）是**与预算无关的硬规则**：
   * 一个视觉迭代任务会在同一轮里堆几十张图（实测 48 张 = 576k tokens），
   * 哪怕总量没超预算也要裁到限额 —— 否则「当前轮不受裁剪」会让图片无限堆积。
   *
   * 0.15.4 踩过：把渐进折叠接进来时，这里仍然是无条件 `return`，
   * 于是「没超预算」时图片限额整段被跳过，门禁 C2 立刻红（10 张 / 限额 4）。
   * 所以判断要看「是否真的无事可做」，而不是只看 token。
   */
  const lastUser = list.findLastIndex(message => message?.role === 'user')
  const lastUserIndex = lastUser < 0 ? list.length : lastUser
  const hasTurnImageOverflow = (() => {
    let seen = 0
    for (let i = list.length - 1; i >= lastUserIndex; i -= 1) {
      seen += countImages(list[i])
    }
    return seen > settings.keepRecentImagesPerTurn
  })()
  if (before <= budget && hasTurnImageOverflow !== true) return { messages: list, stats: emptyStats }

  // budget 必须传：保护区的 token 上限要以「预算」为基准（与裁剪同源），
  // 否则保护区会吃掉预算的 64%，一触发兜底就塌到 6%（见 protectionStartIndex 注释）。
  const protectedFrom = protectionStartIndex(list, settings, windowTokens, budget)
  const callIndex = indexToolCalls(list)

  let current = list.slice()
  const stats = { ...emptyStats, stages: { images: 0, thinking: 0, toolText: 0, toolFold: 0, replies: 0, toolCallArgs: 0 } }

  // 本轮（最后一条 user 之后）的图片**不是一律保留**，而是保留最近 N 张。
  //
  // 旧实现写的是「本轮的图片一律保留」，理由是模型还没"看过"。但视觉迭代任务会在
  // 同一轮里连续产图（渲染→截图→比对），一个真实会话的本轮就堆了 48 张 = 576k tokens，
  // 永久免疫裁剪 → 守卫裁到最狠仍超预算 71%。模型真正在看的是**最新**那几张，
  // 更早的它已经写成结论了；占位带路径可重读，所以按最近 N 张保留即可。
  // Count image blocks. A single tool result can carry several screenshots.
  const historicalImages = recentImageAllowance(list, 0, lastUserIndex, settings.keepRecentImages)
  const turnImages = recentImageAllowance(list, lastUserIndex, list.length, settings.keepRecentImagesPerTurn)

  /**
   * 分批渐进折叠（0.15.4 核心修正）。
   *
   * ---------------------------------------------------------------------------
   * 旧实现是「一刀切」：对保护区之前的**全部**消息执行某个阶段，然后看是否达标。
   * 问题在**粒度 vs 预算的错配**：一个阶段一旦启动就作用于所有历史消息，
   * 于是经常出现「我只超了一点，但它把全部思考都删了、全部工具结果都折了」。
   *
   * 实测断崖（构造 250 轮、预算 490117）：
   *   after = 32268 = **预算的 6.6%**，而 droppedTurns = 0
   * 即：它明明有 93% 的预算没用，却把上下文掏空了。
   * 模型拿到一个「只剩骨架」的历史，于是开始吐畸形工具调用（DSML）——
   * 用户看到的就是「会话又中断了」。
   *
   * ---------------------------------------------------------------------------
   * 改成按**从旧到新的批次**推进：每批只处理 chunkSize 条消息，
   * 处理完立刻估算；一达标就停手，保留尽可能多的原始信息。
   *
   * 为什么从旧往新：旧消息的信息价值低（模型早已写成结论），先动它们
   * 对答案质量影响最小；同时保持「前缀只会后退」的单调性，prompt cache 不被击穿。
   */
  const CHUNK = 24
  const progressApply = (stage, transform, wholeList = false) => {
    let touchedTotal = 0
    const end = wholeList ? current.length : protectedFrom
    /**
     * `wholeList` 的阶段（只有 images）必须**跑完全部批次**，不允许"达标就停"。
     *
     * 为什么：本轮图片限额 `keepRecentImagesPerTurn` 是**与预算无关的硬规则**。
     * 一个视觉迭代任务会在同一轮堆几十张图（实测 48 张 = 576k tokens）；
     * 若按"达标就停"，总量没超预算时它只裁掉前面几张就收手 ——
     * 实测 48 张只裁到 25 张，而限额是 4（门禁 C2 因此红）。
     * 图片是付费与带宽最贵的一类，必须无条件压到限额。
     */
    /**
     * 两类阶段，判据不同（0.15.4 的架构性区分）：
     *
     * **① 无条件规则类（mustComplete）** —— 与预算无关，必须跑完全部批次。
     *    判据是「留着它有独立的价值损害」，不是「token 够不够」：
     *    · `images`：图片是付费与带宽最贵的一类；本轮几十张图会让上下文无限堆积，
     *      哪怕总量没超预算也要压到 `keepRecentImagesPerTurn`。
     *    · `toolCallArgs`：write/edit 的正文**已经落盘**，上下文里留副本零价值
     *      （需要时重新 read 文件即可）。留着它只是在为同一份内容付两次 token。
     *
     * **② 预算救急类（其余）** —— 纯粹为了不超限，能少动就少动：
     *    thinking / toolText / toolFold / replies 都是「有信息价值但可降级」的内容，
     *    一旦达标就该立刻停手，否则会重演 0.15.4 之前的"一刀切把上下文掏空"。
     *
     * 为什么必须区分：实测两类混在一起的后果是**双向出错**——
     * 预算救急类被全量执行 → 250 轮塌到预算的 6.6%（模型失去全部历史 → 吐 DSML）；
     * 无条件规则类被"达标就停" → 48 张图只裁到 25 张（超限额 6 倍）。
     */
    const mustComplete = wholeList === true || stage === 'toolCallArgs'
    for (let start = 0; start < end; start += CHUNK) {
      const stop = Math.min(start + CHUNK, end)
      let touched = 0
      for (let i = start; i < stop; i += 1) {
        const next = transform(current[i], i)
        if (next !== null) {
          current[i] = next
          touched += 1
        }
      }
      touchedTotal += touched
      if (touched === 0) continue
      stats.stages[stage] += touched
      stats.after = estimateMessagesTokens(current, settings)
      // 达标就立刻停，不再继续啃后面的批次 —— 但 mustComplete 的阶段除外。
      if (mustComplete !== true && stats.after <= budget) return true
    }
    return stats.after <= budget
  }

  /**
   * 裁剪顺序（0.15.5 按「单位损失换来的空间」重排）。
   *
   * ---------------------------------------------------------------------------
   * 旧顺序把 `thinking` 排第 2，实测后果很刺眼：预算很宽松（594,974，只需 592,582）
   * 时 **thinking 仍被删掉 294 条**，而 `toolFold` 只折 6 条就达标了 ——
   * 也就是"先牺牲了最不该牺牲的东西，然后马上就够了"。
   *
   * 量化依据（真实会话实测）：
   *   单条 thinking 消息     ≈   206 tokens
   *   单条 toolResult 消息   ≈ 2,000 tokens   ← 是前者的 **9.7 倍**
   *
   * 也就是说：折一条 toolResult 换来的空间，相当于删掉近 10 条 thinking。
   * 而 toolResult 折叠后仍保留首行摘要（"当时跑了什么、结果是什么"的线索），
   * thinking 删掉则是彻底消失。**先动大块且可降级的，才对。**
   *
   * ---------------------------------------------------------------------------
   * 最终顺序（每一步都是"还能读回/还能推断"→"彻底丢失"）：
   *   1. images       （无条件；占位带路径，可重读，最贵）
   *   2. toolText     （超长工具结果截头尾，保留关键中间段）
   *   3. toolFold     （旧工具结果折首行，大块且低成本）
   *   4. toolCallArgs （无条件；已落盘正文，留副本零价值）
   *   5. replies      （旧回复折叠，仍有结论线索）
   *   6. thinking     （最后才动；一旦删就是彻底消失，信息损失最高）
   */
  const done = () =>
    progressApply('images', (message, index) => replaceImages(message, callIndex,
      historicalImages.get(index) ?? turnImages.get(index) ?? 0), true) ||
    progressApply('toolText', message => truncateToolText(message, settings.maxTextChars)) ||
    progressApply('toolFold', message => foldToolResult(message)) ||
    // 参数折叠必须完整执行（无条件规则类），见 progressApply 的 mustComplete 说明。
    progressApply('toolCallArgs', message => foldToolCallArgs(message)) ||
    progressApply('replies', message => foldReply(message)) ||
    // thinking 放最后：信息损失最高的一类，只有前面都不够时才牺牲它。
    progressApply('thinking', message => dropThinking(message))

  done()

  // 五阶段跑完仍超预算 → 兜底：按整轮丢弃最旧的轮次。
  // 只标记 overBudget 而不动手，会让这个信号永远为 true、彻底失去区分度
  // （实测日志连续上百行全是 overBudget:true）。
  if (stats.after > budget) {
    const reaped = dropOldestTurns(current, { settings, windowTokens, budget, estimate: estimateMessagesTokens })
    if (reaped.messages !== current) {
      current = reaped.messages
      stats.droppedTurns = reaped.droppedTurns
      stats.after = estimateMessagesTokens(current, settings)
    }
  }

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
      sessionId: stats?.sessionId ?? '',
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

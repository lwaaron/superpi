/**
 * 「这一轮交付了吗」的**唯一判据**（0.18.0；前身 `superpi-malformed.mjs` 0.16.2）。
 *
 * ---------------------------------------------------------------------------
 * 为什么改名
 *
 * 0.16.2 建这个文件时只管一件事：模型把工具调用写成 DeepSeek 原生 DSML。
 * 0.18.0 的取证（`docs/output-integrity.md`）把「非错误收尾」的全貌数了出来：
 * 除了 DSML，还有**坏字节**（U+FFFD 等，7 次已落盘）与**被截断**（`stopReason: 'length'`）。
 * 三者对用户的后果是同一件事 —— **这一轮什么都没交付，但看起来像结束了**。
 * 继续叫 malformed 会让下一个人以为"坏字节不归它管"，所以名字跟着职责一起改。
 *
 * ---------------------------------------------------------------------------
 * 判据只认「可机械判定」的形态（不做语义猜测）
 *
 * 下列判据全部由消息结构本身决定：
 *
 *   A. `dsml-text`     `stop`，正文含裸露的 DSML 开闭标记或有名调用开头
 *   B. `dsml-thinking` `stop`，标记在 thinking（含只有闭标记的形态 B）
 *   C. `dsml-residue`  `stop`，正文或思考以 `</parameter>` 这类残片收尾
 *   D. `idle`          `stop`，既无正文也无 toolCall
 *   E. `corrupt`       `stop`，text/thinking 含坏字节（U+FFFD / C0 / 孤立代理项），且无 toolCall
 *   F. `truncated`     `length`，输出撞到单次上限
 *   G. `reasoning-markup` `stop`，正文以未闭合的推理标记开头
 *
 * **刻意不判**：「短回复但声称做完了」。实测 147 条 `stop` 无工具调用的回合里，
 * 只有 6 条有可判定形态（以 `：` 收尾），其余 141 条读起来都是完整句子 ——
 * 任何语义判断都会变成假警报，而假警报会让人**不再相信真正的提示**（AGENTS.md §5.0）。
 *
 * ---------------------------------------------------------------------------
 * 判据只有一份，消费者有三处（不要再抄第四份）
 *
 *   · `index.js`（host）：每条 `message_end` 算一次，作为 `verdict` 挂到事件上 → 面板只渲染
 *   · `extensions/superpi-editor.ts`（命令行 TUI）：同进程直接 import，算 Working 行文案
 *   · `extensions/superpi-turn-recovery.ts`：在 Pi 的运行边界用判据选出可恢复的响应
 *   · `test/turn-verdict.mjs`：验证异常形态和合法输入
 *
 * 0.16.2~0.17.3 的形状是「表在契约、算法在面板」，为此付出了两个代价：
 * ① 面板里有一份 80 行的孪生实现；② 契约晚到时提示会永久丢失（0.17.3 用启动顺序绕开）。
 * 0.18.0 改成 **host 算、面板渲染**，依赖消失，竞态随之消失（不是靠顺序绕开）。
 */

import { describeBytes, scanTextBytes, summarizeCounts } from './superpi-text-bytes.mjs'

/** 非 `none` 的判据，按判定顺序排列。 */
export const VERDICT_KINDS = ['truncated', 'dsml-text', 'dsml-thinking', 'dsml-residue', 'corrupt', 'reasoning-markup', 'idle']

/**
 * 判定表 —— **判据的知识只有这一份**。
 *
 * 它不再下发给面板：面板拿到的 `verdict` 已经算好了（见文件头）。
 * 保留成一张表是为了让「形态」可以被逐条对照，而不是散在 if 里。
 */
export const TURN_VERDICT_DETECTION = {
  marker: 'DSML',
  /** 开侧关键词（任一命中即认为出现过开标记）。 */
  openTokens: ['invoke', 'parameter'],
  /** 闭侧关键词（DSML 调用结束的标记）。 */
  closeTokens: ['calls'],
  /**
   * 残片：DSML 的参数/调用闭合标签。
   *
   * 正常文本里不会有 `</parameter>`，那是 DSML 的参数闭合标签，
   * 只有模型吐原生调用语法时才会漏出来。**这一条是让 D 类可见的那一条。**
   */
  residueTokens: ['</parameter>', '</invoke>'],
  /** 判据只在收尾态生效（`toolUse` 说明 pi 已解出结构化调用）。 */
  terminalStopReasons: ['stop', 'length'],
  /** 撞到单次输出上限的收尾态。 */
  truncatedStopReason: 'length',
}

const DSML_TAG = /[|｜]{1,2}DSML[|｜]{1,2}[ \t]*([a-z_]+)(?=[\s/>]|$)/g
const NAMED_INVOKE_TAIL = /[|｜]{1,2}DSML[|｜]{1,2}[ \t]*invoke[ \t]+name[ \t]*=[ \t]*["'][\w.:-]+["'][ \t]*>?$/

function unquotedText(text) {
  if (!text.includes(TURN_VERDICT_DETECTION.marker) && !text.includes('</')) return text
  return text
    .replace(/^ {0,3}(`{3,}|~{3,})[^\r\n]*\r?\n[\s\S]*?^ {0,3}\1[ \t]*\r?$/gm, '\n')
    .replace(/(`+)[^\r\n]*?\1(?!`)/g, ' ')
}

/** 从消息里取出两块可见文本（text / thinking）。thinking 必须一并看 —— B 类形态只有它。 */
export function textChannels(message) {
  const content = message !== null && typeof message === 'object' && Array.isArray(message.content) ? message.content : []
  let text = ''
  let thinking = ''
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') text += block.text
    if (block.type === 'thinking' && typeof block.thinking === 'string') thinking += block.thinking
  }
  return { text, thinking }
}

function dsmlTokens(source) {
  return Array.from(source.matchAll(DSML_TAG), match => match[1])
}

/** D 类残片：只在**末尾**找（真实残片永远收尾在标签上，讨论则引在句中）。 */
function hasResidue(source) {
  const text = source.trimEnd().replace(/<\/?[|｜]{1,2}DSML[|｜]{1,2}[ \t]*calls[ \t]*>$/, '').trimEnd()
  return TURN_VERDICT_DETECTION.residueTokens.some(token => text.endsWith(token))
}

/**
 * 文案表。**中英两份都在这里**，因为两个前端（面板 / 命令行）必须说同一句话 ——
 * 同一个故障给出两种解释，用户会以为是两个不同的问题（0.16.0 审查抓到的 D1 类失真）。
 *
 * `{{n}}` 是坏字节数量的占位符（只有 `corrupt` 用）。
 */
const DSML_NOTICE = {
  zh: '模型输出了畸形工具标记（DSML），这条回复中的调用无法识别。可以从已有进度继续。',
  en: 'The model returned malformed tool markers (DSML). Those calls could not run. You can continue from the current progress.',
}

export const TURN_VERDICT_NOTICE = {
  'dsml-text': DSML_NOTICE,
  'dsml-thinking': DSML_NOTICE,
  'dsml-residue': DSML_NOTICE,
  idle: {
    zh: '这次模型响应没有正文或工具调用。可以从已有进度继续。',
    en: 'The model returned no text or tool calls. You can continue from the current progress.',
  },
  corrupt: {
    zh: '这次模型响应含 {{n}} 处损坏字节。可以从已有进度继续。',
    en: 'The model response contained {{n}} corrupted character(s). You can continue from the current progress.',
  },
  'reasoning-markup': {
    zh: '模型把未闭合的推理标记写进了回复正文。可以从已有进度继续生成干净的答复。',
    en: 'The model wrote an unclosed reasoning marker into the reply. You can continue from the current progress.',
  },
  truncated: {
    zh: '这次模型响应达到输出上限，可以接着完成剩余内容。',
    en: 'The model response hit its output limit. You can continue with the remaining work.',
  },
}

/**
 * 取某一类的文案。
 * @param {string} kind
 * @param {{ locale?: string, bytes?: number }} [options]
 */
export function turnVerdictNotice(kind, options = {}) {
  const entry = TURN_VERDICT_NOTICE[kind]
  if (entry === undefined) return ''
  const text = String(options.locale) === 'en' ? entry.en : entry.zh
  const bytes = Number.isFinite(options.bytes) ? Math.max(0, Math.floor(options.bytes)) : 0
  return text.replace('{{n}}', String(bytes))
}

/**
 * 判断一条 assistant 消息是否交付了本轮。
 *
 * @param {any} message pi 的 assistant message（`{ role, content, stopReason }`）
 * @returns {{
 *   delivered: boolean,
 *   kind: string,                     // `none` 或 VERDICT_KINDS 之一
 *   bytes: number,                    // corrupt 时的坏字节数，其余为 0
 *   notice: { zh: string, en: string },
 *   detail: string                    // 日志用的短说明（不进用户提示条）
 * }}
 */
export function detectTurnVerdict(message) {
  const ok = { delivered: true, kind: 'none', bytes: 0, notice: { zh: '', en: '' }, detail: '' }
  if (message === null || typeof message !== 'object') return ok
  if (message.role !== 'assistant') return ok

  const stopReason = typeof message.stopReason === 'string' ? message.stopReason : ''
  // 已解析出结构化工具调用 → 这一轮还会继续（不是收尾态）。
  if (stopReason === 'toolUse') return ok
  // 其它收尾态（error / aborted / pending / deferred）归错误路径，不在此列。
  if (TURN_VERDICT_DETECTION.terminalStopReasons.includes(stopReason) !== true) return ok

  const { text, thinking } = textChannels(message)
  const blocks = Array.isArray(message.content) ? message.content : []
  const hasToolCall = blocks.some(block => block !== null && typeof block === 'object' && block.type === 'toolCall')

  const verdict = (kind, detail, bytes = 0) => ({
    delivered: false,
    kind,
    bytes,
    notice: {
      zh: turnVerdictNotice(kind, { locale: 'zh', bytes }),
      en: turnVerdictNotice(kind, { locale: 'en', bytes }),
    },
    detail,
  })

  /**
   * F 类优先：`length` 是 provider 给出的**原因**，比"输出里有什么"更接近真相。
   * 一条被截断在第 3000 token 的回复可能同时含半个 DSML —— 那说明它是被截断的，
   * 不是格式写错。用户看到的文案必须指向可行动的那件事（继续 / 调大上限）。
   */
  if (stopReason === TURN_VERDICT_DETECTION.truncatedStopReason) {
    return verdict('truncated', 'stopReason=length · text=' + String(text.length) + ' chars')
  }
  if (hasToolCall) return ok

  const prose = unquotedText(text)
  const reasoning = unquotedText(thinking)
  const textTokens = dsmlTokens(prose)
  const thinkingTokens = dsmlTokens(reasoning)
  const { openTokens, closeTokens } = TURN_VERDICT_DETECTION
  if ((textTokens.some(token => openTokens.includes(token)) && textTokens.some(token => closeTokens.includes(token))) ||
      NAMED_INVOKE_TAIL.test(prose.trimEnd())) return verdict('dsml-text', 'DSML tool markup in text')
  if (thinkingTokens.some(token => closeTokens.includes(token)) || NAMED_INVOKE_TAIL.test(reasoning.trimEnd())) {
    return verdict('dsml-thinking', 'DSML tool markup in reasoning')
  }

  if (hasResidue(prose) || hasResidue(reasoning)) return verdict('dsml-residue', 'DSML closing tag at message tail')

  /**
   * E 类：坏字节。
   *
   * 只看**没有 toolCall 的收尾消息**：带 toolCall 的消息这一轮还会继续，
   * 那一路由写入闸（`superpi-text-integrity.ts`）在写盘前拦，不需要在这里重复判 ——
   * 两条判据各自负责一个边界，不交叉（交叉就会互相误报）。
   */
  const textScan = scanTextBytes(text)
  const thinkingScan = scanTextBytes(thinking)
  const badBytes = textScan.total + thinkingScan.total
  if (badBytes > 0) {
    const detail = [['text', textScan], ['thinking', thinkingScan]]
      .filter(([, scan]) => !scan.clean)
      .map(([channel, scan]) => channel + ' · ' + summarizeCounts(scan.counts) + ' · ' + describeBytes(scan))
      .join(' / ')
    return verdict('corrupt', detail, badBytes)
  }

  // A leading unclosed envelope gives no reliable boundary between reasoning and the answer.
  // Fenced and inline examples do not start with an exposed marker.
  if (text.trimStart().startsWith('<thinking>') && !text.includes('</thinking>')) {
    return verdict('reasoning-markup', 'unclosed reasoning marker at the start of the text block')
  }

  /**
   * C 类空转：`stop` 收尾但**既无正文也无工具调用**。
   *
   * thinking 不算交付：对 assistant 消息而言 thinking 是过程而非结果，
   * 真机上这种消息后面紧跟的就是本轮终止。
   */
  if (text.trim() === '') return verdict('idle', 'stop with empty text')

  return ok
}

/**
 * 兼容布尔包装：只关心「这一轮是否没交付」的调用方走这里。
 * @param {any} message
 */
export function isUndeliveredTurn(message) {
  return detectTurnVerdict(message).delivered !== true
}

/**
 * 畸形输出的**唯一判据**（0.16.2）。
 *
 * ---------------------------------------------------------------------------
 * 为什么这个文件必须存在（它修的是一个真实的三方分叉）
 *
 * 「模型把工具调用写成 DeepSeek 原生 DSML」这件事在本仓库已经失败过四次
 * （`docs/parity.md` 0.15.1 / 0.15.6 / 0.16.0，以及 2026-11-20 在 WorkBuddy
 * 里抓到的第四次）。前三次的修法都是**在需要它的那个文件里再抄一份判据**：
 *
 *   - `extensions/superpi-editor.ts` 的 `isMalformedToolCall`（命令行 TUI 用）
 *   - `client.js` 压根没有（面板端 `grep -c DSML` = **0**）
 *
 * 后果是真实存在的：同一个模型、同一个故障，命令行窗口会亮红字并告知
 * 「本轮未执行，直接重发即可」，而**面板端完全静默** —— 用户只看到一句话说完
 * 然后会话不动了，不知道发生了什么，也不知道该怎么办。
 *
 * 这违反 AGENTS.md §4「单一真相源」与 §3「100% 对齐」两条硬约束。
 * 所以判据搬到这里：host 与 editor 都从这一份 import，面板通过 `/contract`
 * 拿到同一份的**判定表**（见下）。
 *
 * ---------------------------------------------------------------------------
 * 面板拿不到这个文件，怎么做到「同一份判据」
 *
 * `client.js` 只能 `require('react')`，不能 import 任何仓库模块。
 * 但本仓库已有一条既成范式：**算法在面板、表在契约**
 * （`classifyInput`，见 `client.js:5062` 与 `src/rpc-contract.mjs`，
 * `test/parity.mjs` 用同一批输入喂两边对账）。
 *
 * 这里照抄那条范式：契约里注册 `MALFORMED_DETECTION` 这张**判定表**
 * （标记片段、排除条件），面板按表实现判定逻辑，门禁拿 `isMalformedOutput`
 * 跑遍同一批真实样本与面板侧对账。判据的**知识**只有一份，就在下面。
 *
 * ---------------------------------------------------------------------------
 * 判据（四类真实形态，缺一条就会漏掉一类真实故障）
 *
 *   A. 正文型     `stop`，text 块含 DSML 开标记 + 闭标记
 *   B. thinking 型 `stop`，**只有一个 thinking 块**，闭合标记在 thinking 里
 *   C. 空转型     `stop`，既无正文也无 toolCall（标记可能被 provider 吞掉）
 *   D. 残片型     `stop`，只剩 `</parameter>` 这类**闭侧残片**，
 *                 开标记 `<｜｜DSML｜｜ invoke>` 被网关吞掉
 *                 —— **2026-11-20 真机抓到的新形态，前三条全部漏掉**
 *
 * D 类的原文（WorkBuddy / pi 两侧同样出现）：
 *     README 已无坏字节…现在跑全量门禁做最终验证。</parameter>
 *     </｜｜DSML｜｜ calls>
 * 开标记整段不见，只剩参数闭合标签 + 调用闭合标签。旧判据要求
 * `hasOpen && hasClose`，于是这一条判不出来 → 静默。
 *
 * ---------------------------------------------------------------------------
 * 排除项（误判面必须极小，否则「正文里讨论这个 bug」会被当成故障）
 *
 *   - `stopReason === 'toolUse'` → pi 已解析出结构化调用，不是畸形
 *   - 有正文 + 有 toolCall → 正常轮次
 *   - 只有正文、没有 DSML 标记 → 正常回复（模型可以只说话不调工具）
 *   - `error` / `aborted` 等其它 stopReason → 归错误路径处理，不在此列
 */

/** DSML 的可见标记：全角竖线 `｜`（U+FF5C）包起来的 `DSML`。 */
export const DSML_MARKER = 'DSML'

/**
 * 判定表 —— **契约下发给面板的唯一一份**（`GET /contract` 的 `malformed` 字段）。
 *
 * 面板不许把这些字符串再抄一遍：抄一遍就是下一次分叉。
 */
export const MALFORMED_DETECTION = {
  /** 出现即说明模型在吐自己的工具调用语法。 */
  marker: DSML_MARKER,
  /** 开侧关键词（任一命中即认为出现过开标记）。 */
  openTokens: ['invoke', 'parameter'],
  /** 闭侧关键词（DSML 调用结束的标记）。 */
  closeTokens: ['calls'],
  /**
   * D 类残片：DSML 的参数/调用闭合标签。
   *
   * 它出现就足以判定 —— 正常文本里不会有 `</parameter>`，那是 DSML 的参数闭合标签，
   * 只有模型吐原生调用语法时才会漏出来。**这就是让 D 类可见的那一条，也是本次事故的直接修复。**
   */
  residueTokens: ['</parameter>', '</invoke>'],
  /**
   * 残片必须落在**消息末尾**（只看最后这么多字符）才算数。
   *
   * 为什么这条判据是必要的而不是保险起见：模型**在正文里讨论**这个 bug 是合法行为，
   * 而讨论时引用 `</parameter>` 是再自然不过的写法（本仓库自己的文档里就有几十处）。
   * 若只看「整条消息里有没有出现」，那么任何一次「我在解释 DSML 是什么」的正常回复
   * 都会被判成故障 —— 那是比漏判更糟的错：它会让用户对本提示彻底失去信任。
   *
   * 真机依据：五条真实残片（pi 3 条、WorkBuddy 2 条）**全部以闭合标签结尾**，
   * 因为它们本来就产生于「模型吐到一半被截断」。位置本身就是判据的一部分。
   */
  residueTailChars: 40,
  /** 判据只在收尾态生效（`toolUse` 说明 pi 已解出结构化调用）。 */
  terminalStopReasons: ['stop'],
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

/**
 * 一条 source 里是否含「开标记 + 闭标记」的完整 DSML 结构（A/B 类）。
 *
 * ---------------------------------------------------------------------------
 * 判据必须绑在 `DSML` 标记**之后**，不能全文字符串 includes（0.16.2 的真缺陷）
 *
 * 第一版写的是 `source.includes('parameter')`，看起来没问题，实测直接错判：
 * D 类残片 `</parameter>` 里**本身就含有** `parameter`，于是「只剩闭侧残片」的
 * 真实故障被当成「开闭标记齐全」的 A 类 —— kind 报错还是小事，
 * 真正的代价是这个函数分不出 D 类，本次事故的修复等于没生效。
 *
 * 正确判据：跳过 `DSML` 后面的分隔符（`｜` `|` `<` `>` `/` 空白），
 * 看紧跟的 token 是不是 `invoke` / `parameter`：
 *   `｜｜DSML｜｜ invoke>`   → 跳过 `｜｜ ` → `invoke`   ✓ 开标记
 *   `</｜｜DSML｜｜ calls>`  → 跳过 `｜｜ ` → `calls`    ✗ 不是开标记（闭标记）
 */
const MARKER_SEPARATORS = new Set(['｜', '|', '<', '>', '/', ' ', '\t', '\n', '\r'])

/** 跳过分隔符，返回 `DSML` 之后紧跟的 token 前缀（最多 16 字符）。 */
function tokenAfterMarker(source, markerAt) {
  let at = markerAt + DSML_MARKER.length
  while (at < source.length && MARKER_SEPARATORS.has(source.charAt(at))) at += 1
  return source.slice(at, at + 16)
}

/** 是否存一个 `DSML` 标记，其后紧跟 keywords 中的某个 token。 */
function hasMarkerFollowedBy(source, keywords) {
  if (source === '' || source.includes(DSML_MARKER) !== true) return false
  let from = 0
  while (from < source.length) {
    const at = source.indexOf(DSML_MARKER, from)
    if (at < 0) return false
    const token = tokenAfterMarker(source, at)
    if (keywords.some(keyword => token.startsWith(keyword))) return true
    from = at + DSML_MARKER.length
  }
  return false
}

/** A/B 类：`DSML` + 开侧 token，且 `DSML` + 闭侧 token。 */
function hasFullStructure(source) {
  return hasMarkerFollowedBy(source, MALFORMED_DETECTION.openTokens) &&
    hasMarkerFollowedBy(source, MALFORMED_DETECTION.closeTokens)
}

/**
 * 一条 source 里是否含闭侧残片（D 类：开标记被网关吞掉）。
 *
 * 只在**末尾**找：讨论 DSML 的正常回复会把标签引在句中，真实残片永远收尾在标签上。
 */
function hasResidue(source) {
  if (source === '') return false
  const tail = source.trimEnd().slice(-MALFORMED_DETECTION.residueTailChars)
  return MALFORMED_DETECTION.residueTokens.some(token => tail.includes(token))
}

/**
 * thinking 通道是否含 DSML 的**调用闭合**标记（B 类）。
 *
 * B 类真机原文以 `</｜｜DSML｜｜ calls>` 结尾，它有 `DSML` + `calls`，
 * 但**没有** `invoke`/`parameter`（开标记被吞），所以 `hasFullStructure` 判不出来。
 * 单独判一次是为了让日志与提示能说出「是 thinking 通道」，而不是含糊地归到空转。
 */
function hasThinkingCloseMarker(source) {
  return hasMarkerFollowedBy(source, MALFORMED_DETECTION.closeTokens)
}

/**
 * 判断一条 assistant 消息是否为「畸形输出」。**唯一判据，不要在任何地方再写一份。**
 *
 * @param {any} message pi 的 assistant message（`{ role, content, stopReason }`）
 * @returns {{ malformed: boolean, kind: string }}
 *   kind ∈ `none` | `text` | `thinking` | `residue` | `idle`
 *   —— 返回 kind 是为了让日志与提示能说清**是哪一类**，而不是只有布尔值。
 */
export function detectMalformedOutput(message) {
  const none = { malformed: false, kind: 'none' }
  if (message === null || typeof message !== 'object') return none
  if (message.role !== 'assistant') return none

  const stopReason = typeof message.stopReason === 'string' ? message.stopReason : ''
  // 已解析出结构化工具调用 → 不是畸形（哪怕正文里提过 DSML，那是合法讨论）。
  if (stopReason === 'toolUse') return none
  // 其它收尾态（error / aborted）归错误路径，不在此列。
  if (MALFORMED_DETECTION.terminalStopReasons.includes(stopReason) !== true) return none

  const { text, thinking } = textChannels(message)
  const blocks = Array.isArray(message.content) ? message.content : []
  const hasToolCall = blocks.some(block => block !== null && typeof block === 'object' && block.type === 'toolCall')

  // A/B 类：完整 DSML 结构（正文优先，其次 thinking —— B 类只有 thinking）。
  if (hasFullStructure(text)) return { malformed: true, kind: 'text' }
  if (hasFullStructure(thinking)) return { malformed: true, kind: 'thinking' }

  // B 类补充：thinking 里只剩调用闭合标记（真机形态：`...</thinking>` 换行后 `</｜｜DSML｜｜ calls>`）。
  // 必须排在 idle 之前，否则这类会被含糊地判成「空转」，日志就说不出真实形态。
  if (hasThinkingCloseMarker(thinking)) return { malformed: true, kind: 'thinking' }

  // D 类：只剩闭侧残片，开标记被网关吞掉（0.16.2 新增）。
  if (hasToolCall !== true && hasResidue(text)) return { malformed: true, kind: 'residue' }
  if (hasToolCall !== true && hasResidue(thinking)) return { malformed: true, kind: 'residue' }

  /**
   * C 类空转：`stop` 收尾但**既无正文也无工具调用**。
   *
   * 这一条兜住「标记被 provider 彻底吞掉、只留下空转」的情况：
   * 模型要么该回答（有 text），要么该调工具（有 toolCall）。两者都没有，
   * 而 stopReason 却是 stop —— 这一轮什么也没产出。
   *
   * 注意：thinking 不算交付。对 assistant 消息而言 thinking 是过程而非结果，
   * 真机上这种消息后面紧跟的就是本轮终止。
   */
  if (text.trim() === '' && hasToolCall !== true) return { malformed: true, kind: 'idle' }

  return none
}

/**
 * 兼容包装：只要布尔值的调用方（`extensions/superpi-editor.ts` 的既有用法）走这里。
 * @param {any} message
 * @returns {boolean}
 */
export function isMalformedOutput(message) {
  return detectMalformedOutput(message).malformed
}

/**
 * 畸形输出时的提示文案（中/英）。
 *
 * 为什么文案要放在**共用模块**里：命令行窗口（`superpi-editor.ts` 的 Working 行）
 * 与面板（`client.js` 的告警条）必须说**同一句话** —— 否则同一个故障在两个前端
 * 会给出两种解释，用户会以为是两个不同的问题（0.16.0 审查抓到的 D1 类失真）。
 *
 * 文案刻意把**原因**与**可行动动作**分开写：
 *  - 原因：模型这次吐了它自己的工具调用语法（不是 pi 的格式），所以没执行；
 *  - 动作：直接重发即可。
 */
export const MALFORMED_NOTICE = {
  zh: '本轮未执行：模型输出格式错乱（DSML），工具调用没被识别 · 直接重发即可',
  en: 'Nothing ran: the model emitted malformed tool-call syntax (DSML), so no tool was called · just send it again',
}

export function malformedNotice(locale) {
  return String(locale) === 'en' ? MALFORMED_NOTICE.en : MALFORMED_NOTICE.zh
}

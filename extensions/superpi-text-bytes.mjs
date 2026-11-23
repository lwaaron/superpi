/**
 * 「什么是一个坏字节」的**唯一判据**（0.18.0）。
 *
 * ---------------------------------------------------------------------------
 * 为什么需要单独一个文件
 *
 * 同一件事在这个仓库里曾经有三份实现，而且**三份都在，谁也没发现另外两份**：
 *
 *   ① `test/parity.mjs` §9      —— 发布文本文档的卫生扫描（U+FFFD / C0 / 孤立代理项）
 *   ② `test/host-parity.mjs` 3.98 —— 同一批文件的又一次扫描（0.15.3 的 400 真因）
 *   ③ 运行时**一份也没有**      —— 模型写进代码里的坏字节没有任何人检查
 *
 * 前两份是门禁之间的重复（漏一处就是一次静默漂移），第三份是整个链路的空白。
 * 0.18.0 的取证把后果量化了：20 个真实会话里 **7 次 `write` 的 content 含 U+FFFD，
 * 7 次全部成功落盘** —— 坏字节不是"显示问题"，它是会写进仓库的。
 *
 * 所以判据提到这里，四个消费者共用：
 *   · `extensions/superpi-turn-verdict.mjs`（回合判据的 corrupt 一类）
 *   · `extensions/superpi-text-integrity.ts`（写盘前的拦截）
 *   · `test/parity.mjs` / `test/host-parity.mjs`（发布文本的卫生）
 *
 * ---------------------------------------------------------------------------
 * 三类坏字节，各有各的物理含义（不要合并成一类）
 *
 *   `replacement` U+FFFD —— UTF-8 解码时遇到无法解码的字节序列，解码器**代替**它输出的字符。
 *                 它出现在正文里，说明"这里原本有一个字符，它的字节已经丢了"。
 *                 实测形态：`初`（3 字节）在流式重组时被切断 → 三个 U+FFFD。
 *                 这是**不可逆**的：原字符无法从 U+FFFD 推回来，所以只能拦、不能修。
 *
 *   `control`     C0 控制字符（0x00–0x1F，\\t \\n \\r 除外）与 DEL（0x7F）—— 在源码/文档里没有任何
 *                 合法用途，且会让 JSON 请求体非法（0.15.3 的 `400 invalid JSON` 就是 U+0007）。
 *                 唯一例外是终端用途的 ESC，但那是**工具的产出**（`toolResult`），不是模型写盘的内容。
 *                 DEL 一并收进来的理由：`test/host-parity.mjs` 3.98 早就把它当禁用字符，
 *                 若这里只查 C0，就会出现「门禁禁、写入闸放行」的第二套定义 —— 那正是本模块要消除的东西。
 *
 *   `surrogate`   孤立代理项 —— JS 字符串里合法、UTF-8 编码时必然变成 U+FFFD。
 *                 它比前两类更隐蔽：`JSON.stringify` 会把它转义成 `\\ud800`（合法 JSON），
 *                 所以请求不会 400，**只有落盘那一刻才坏**。
 *
 * ---------------------------------------------------------------------------
 * 判据的边界（宁可少认，不要误认）
 *
 *  - 只查 C0 与 DEL，不查 C1（0x80–0x9F）：它们在 UTF-8 文本里出现不代表损坏，
 *    把它们算坏字节会制造新的误报类别，而误报会让用户不再相信提示。
 *  - BOM（U+FEFF）不算坏：文件首字节的 BOM 是合法的。
 *  - 不判断「这段文字读起来是否像乱码」：那是语义判断，做不了也不该做。
 */

/** 三类坏字节的稳定标识（日志、门禁、提示都按这三个值对账，不要改名）。 */
export const BAD_BYTE_KINDS = ['replacement', 'control', 'surrogate']

/** U+FFFD 的码位，供别的模块引用，避免各写一份字面量。 */
export const REPLACEMENT_CODE_POINT = 0xFFFD

/**
 * C0 里被放行的三个：制表、换行、回车。
 * 它们是文本的正常组成部分，排除掉否则每一份多行文件都会被判成"损坏"。
 */
const ALLOWED_CONTROLS = new Set([0x09, 0x0a, 0x0d])

/** 单次扫描最多记录多少个位置（计数永远是全量，位置只留前 N 个，防病态输入吃内存）。 */
export const MAX_REPORTED_SPANS = 20

/**
 * 扫描一段文本里的坏字节。
 *
 * 复杂度 O(n) 单遍：计数全量、位置截断。**永不抛**（传入非字符串时返回空结果），
 * 因为它的调用点在工具执行路径上，任何异常都会让一次写盘变成不可解释的失败。
 *
 * @param {unknown} text
 * @param {{ maxSpans?: number }} [options]
 * @returns {{
 *   clean: boolean,
 *   total: number,
 *   counts: { replacement: number, control: number, surrogate: number },
 *   spans: Array<{ index: number, code: number, kind: string, line: number, column: number }>
 * }}
 */
export function scanTextBytes(text, options = {}) {
  const counts = { replacement: 0, control: 0, surrogate: 0 }
  const spans = []
  const empty = { clean: true, total: 0, counts, spans }
  if (typeof text !== 'string' || text === '') return empty
  const maxSpans = Number.isFinite(options.maxSpans) && options.maxSpans > 0
    ? Math.floor(options.maxSpans)
    : MAX_REPORTED_SPANS

  let total = 0
  // 行号/列号只在**记录位置**时才算：为每个字符维护行列会让热路径多一次分支。
  // 记录的 span 最多 20 个，事后从头数一遍是 O(n×20) 的最坏情况，但实测 n 也就几 MB，
  // 且只有坏字节存在时才会走到这里（正常写盘一次都不会调用）。
  const locate = index => {
    let line = 1
    let lineStart = 0
    for (let i = 0; i < index; i += 1) {
      if (text.charCodeAt(i) === 0x0a) {
        line += 1
        lineStart = i + 1
      }
    }
    return { line, column: index - lineStart + 1 }
  }

  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    let kind = ''
    if (code === REPLACEMENT_CODE_POINT) {
      kind = 'replacement'
    } else if ((code < 0x20 && ALLOWED_CONTROLS.has(code) !== true) || code === 0x7f) {
      kind = 'control'
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0
      if (next < 0xdc00 || next > 0xdfff) kind = 'surrogate'
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      const prev = i > 0 ? text.charCodeAt(i - 1) : 0
      if (prev < 0xd800 || prev > 0xdbff) kind = 'surrogate'
    }
    if (kind === '') continue
    counts[kind] += 1
    total += 1
    if (spans.length < maxSpans) {
      const at = locate(i)
      spans.push({ index: i, code, kind, line: at.line, column: at.column })
    }
    // 代理项成对检查：命中低位代理时上一位已被跳过（它不是高位），无需再处理。
  }

  return { clean: total === 0, total, counts, spans }
}

/** 便捷布尔包装：只想知道"干不干净"的调用方走这里。 */
export function isCleanText(text, options = {}) {
  return scanTextBytes(text, options).clean
}

/** 码位 → `U+FFFD` 这种可粘贴进日志/提示的写法。 */
export function formatCodePoint(code) {
  const value = Number.isFinite(code) ? Math.max(0, Math.floor(code)) : 0
  return 'U+' + value.toString(16).toUpperCase().padStart(4, '0')
}

/**
 * 把一次扫描结果说成一句人能读的话。
 *
 * 例句：`3 处坏字节：第 12 行 U+FFFD、第 40 行 U+0007、第 41 行 U+FFFD`
 * 超过 `limit` 个位置时补一句「另有 N 处」——**计数必须给全**，
 * 只报前几个会让用户以为损坏只有这么点（0.15.0 的 D1 类失真）。
 *
 * @param {ReturnType<typeof scanTextBytes>} scan
 * @param {{ limit?: number }} [options]
 */
export function describeBytes(scan, options = {}) {
  const total = scan !== null && typeof scan === 'object' && Number.isFinite(scan.total) ? scan.total : 0
  if (total === 0) return '无坏字节'
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : 5
  const spans = Array.isArray(scan.spans) ? scan.spans.slice(0, limit) : []
  const parts = spans.map(span => '第 ' + String(span.line) + ' 行 ' + formatCodePoint(span.code))
  const rest = total - spans.length
  return total + ' 处坏字节：' + parts.join('、') + (rest > 0 ? '，另有 ' + String(rest) + ' 处' : '')
}

/**
 * 按类别汇总成一行（日志用）。
 * 例：`replacement=3 control=1`（只列非零项，零项不写，避免日志里全是 0）。
 */
export function summarizeCounts(counts) {
  const source = counts !== null && typeof counts === 'object' ? counts : {}
  const parts = BAD_BYTE_KINDS
    .filter(kind => Number(source[kind]) > 0)
    .map(kind => kind + '=' + String(Number(source[kind])))
  return parts.length === 0 ? 'none' : parts.join(' ')
}

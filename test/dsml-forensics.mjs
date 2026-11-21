/**
 * DSML 畸形形态统计（可复现，供将来复核）。
 *
 * 输出畸形条的形态分布，用来复核 docs/dsml-root-cause.md 的结论。
 * 关键判据：开头标签 0 命中、结构化 toolCall 0 命中、toolResult 0 命中。
 *
 * ── 为什么判据要这么严（2026-11-21 修正）─────────────────
 *
 * 第一版用「含 DSML 且不含讨论关键词」判定，把**讨论 DSML 检测逻辑本身**的
 * 正常回复也算了进来（那个会话里我正好在改检测器，正文引用了
 * `</｜｜DSML｜｜ calls>` 这段字面量）。它带结构化 toolCall、有 toolResult，
 * 明显不是畸形 —— 误报导致结论出现"1/37 矛盾"。
 *
 * 修正后的判据（三条同时满足才算真畸形）：
 *   ① 有 DSML 标记；
 *   ② **没有**结构化 toolCall 块（畸形 = 调用从未形成）；
 *   ③ 标记出现在正文**末尾**（尾巴形态，不是文中引用）。
 * 这三条是从 36 条真实畸形的形态里读出来的，不是先验设定。
 *
 * 跑法：node test/dsml-forensics.mjs
 *
 * 为什么不在 npm test 里：它依赖**用户机器上的真实会话文件**（~/.pi/agent/sessions）。
 * 新机器 clone 下来没有这些文件 → 会扫到 0 条 → 判定无意义。
 * 所以它是「取证工具」而不是「回归门禁」：离线可复现，但不作为 CI 条件。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const sessionsRoot = path.join(os.homedir(), '.pi', 'agent', 'sessions')
if (fs.existsSync(sessionsRoot) === false) {
  console.log('[跳过] 本机没有 ~/.pi/agent/sessions，无法取证（这是取证工具，不是门禁）')
  process.exit(0)
}
const DSML = /(\uFF5C\uFF5CDSML\uFF5C\uFF5C|DSML\uFF5C\uFF5C)/
const OPEN_INVOKE = /<\uFF5C\uFF5CDSML\uFF5C\uFF5C\s*invoke/
const CLOSE_INVOKE = /<\/\uFF5C\uFF5CDSML\uFF5C\uFF5C\s*invoke>/
const CLOSE_CALLS = /<\/\uFF5C\uFF5CDSML\uFF5C\uFF5C\s*calls>/
const PARAM = /<parameter\s+name=/
const CLOSE_THINK = /<\/thinking>/

/**
 * 真畸形判定。
 *
 * @param {string} tx      正文
 * @param {boolean} hasToolCall 同条是否有结构化 toolCall
 */
function isMalformed(tx, hasToolCall) {
  if (DSML.test(tx) === false) return false
  // ① 有结构化 toolCall → 调用已形成，不是畸形（这是最硬的排除）
  if (hasToolCall) return false
  // ② 标记必须在**末尾 300 字符**内（尾巴形态）；文中引用/讨论会被排除
  const tail = tx.slice(-300)
  if (DSML.test(tail) === false) return false
  return true
}

const stat = {
  malformed: 0, files: new Set(),
  openInvoke: 0, closeInvoke: 0, closeCalls: 0, param: 0,
  structuredToolCall: 0, followedByToolResult: 0, followedByUserContinue: 0,
  closeThinking: 0,
  normal: 0, normalCloseThinking: 0,
}

for (const dirName of fs.readdirSync(sessionsRoot)) {
  const full = path.join(sessionsRoot, dirName)
  if (fs.statSync(full).isDirectory() === false) continue
  for (const name of fs.readdirSync(full)) {
    if (name.endsWith('.jsonl') === false) continue
    let lines
    try { lines = fs.readFileSync(path.join(full, name), 'utf8').split('\n').filter(l => l.trim() !== '') } catch { continue }
    const recs = []
    for (const line of lines) {
      let o
      try { o = JSON.parse(line) } catch { continue }
      const m = o.message
      if (m === undefined || m === null || m.role === undefined) continue
      const content = Array.isArray(m.content) ? m.content : []
      const tx = content.filter(b => b?.type === 'text').map(b => String(b.text ?? '')).join('\n')
      recs.push({
        role: m.role,
        tx,
        hasToolCall: content.some(b => b?.type === 'toolCall'),
      })
    }
    for (let i = 0; i < recs.length; i += 1) {
      const r = recs[i]
      if (r.role !== 'assistant') continue
      if (isMalformed(r.tx, r.hasToolCall) === false) {
        stat.normal += 1
        if (CLOSE_THINK.test(r.tx)) stat.normalCloseThinking += 1
        continue
      }
      stat.malformed += 1
      stat.files.add(name)
      if (OPEN_INVOKE.test(r.tx)) stat.openInvoke += 1
      if (CLOSE_INVOKE.test(r.tx)) stat.closeInvoke += 1
      if (CLOSE_CALLS.test(r.tx)) stat.closeCalls += 1
      if (PARAM.test(r.tx)) stat.param += 1
      if (CLOSE_THINK.test(r.tx)) stat.closeThinking += 1
      if (r.hasToolCall) stat.structuredToolCall += 1
      /**
       * 只看「到下一个 assistant 为止」这一段 —— 这是「本轮」的严格边界。
       *
       * 为什么不能用固定窗口（之前用 3~4 条）：
       * 畸形之后的真实序列是 `user(继续) → assistant → toolResult`，
       * 那个 toolResult 属于**重试轮**，不是畸形轮。用固定窗口会把它算进来，
       * 得出「31/36 有 toolResult」的错误结论（实测两种窗口结论完全相反）。
       *
       * 正确判据：本轮内（下一个 assistant 之前）是否有 toolResult。
       */
      const turn = []
      for (let j = i + 1; j < recs.length; j += 1) {
        if (recs[j].role === 'assistant') break
        turn.push(recs[j])
      }
      if (turn.some(n => n.role === 'toolResult')) stat.followedByToolResult += 1
      if (turn.some(n => n.role === 'user' && /^\s*继续\s*$/.test(n.tx))) stat.followedByUserContinue += 1
    }
  }
}

const m = stat.malformed
console.log('== DSML 畸形形态统计 ==')
console.log('畸形总数 =', m, '| 涉及文件 =', stat.files.size)
console.log('')
console.log('有开头 <｜｜DSML｜｜ invoke   =', stat.openInvoke, '/', m, '(期望 0)')
console.log('只有闭合 </｜｜DSML｜｜ invoke> =', stat.closeInvoke, '/', m)
console.log('只有闭合 </｜｜DSML｜｜ calls>  =', stat.closeCalls, '/', m)
console.log('含 <parameter name=          =', stat.param, '/', m)
console.log('同条有结构化 toolCall         =', stat.structuredToolCall, '/', m, '(期望 0)')
console.log('之后有 toolResult             =', stat.followedByToolResult, '/', m, '(期望 0)')
console.log('之后紧跟用户「继续」          =', stat.followedByUserContinue, '/', m)
console.log('')
console.log('（第三次假设的复核）畸形含 </thinking> =', stat.closeThinking, '/', m,
  '| 正常条含 =', stat.normalCloseThinking, '/', stat.normal)
console.log('')
const pass = stat.openInvoke === 0 && stat.structuredToolCall === 0 && stat.followedByToolResult === 0
console.log(pass ? 'PASS: 形态符合「只输出尾巴、调用从未形成」' : 'FAIL: 形态与结论不符，需重新分析')
process.exit(pass ? 0 : 1)

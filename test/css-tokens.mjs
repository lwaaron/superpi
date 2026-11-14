#!/usr/bin/env node
/**
 * 面板 CSS 门禁：不许出现硬色值，且只许引用 DSH 设计令牌。
 *
 * 为什么需要：client.js 的样式被注入到 DSH 的 Web 载体里，颜色 / 字号 / 圆角必须跟随宿主主题。
 * 一旦写死 rgba(0,0,0,.72) 这种值，宿主切深浅色或换品牌色时面板就会脏出来一块，
 * 而这类回归在渲染冒烟（client-render.mjs）里看不出来 —— 字符串渲染不比较颜色。
 * 所以在提交前做静态门禁，规则共 7 条：
 *  1. 硬色值：不许 #hex / rgb() / rgba() / hsl() / hsla() / 颜色类属性上的命名色；
 *  2. 令牌白名单：var(--x) 只许 --dsw-* 前缀，外加少数本地兜底令牌；
 *  3. 兜底：非 --dsw-* 的外部令牌必须写成 var(--ds-font-family-code, ...) 这种带第二参数的形式；
 *  4. 禁用令牌：--dsw-alias-button-tool-bar-fill / -hover（tokens.txt 里是硬值，不是别名）；
 *  5. 字体栈：ui-monospace / SFMono-Regular / Menlo / Consolas / monospace 只许出现在
 *     var(--ds-font-family-code, ...) 的兜底位置；
 *  6. 焦点可见：至少一条 :focus-visible 带 outline:var(--dsw-focus-ring-width)；
 *  7. 减少动效：至少一个 @media (prefers-reduced-motion: reduce) 块。
 *
 * 门禁自己也要被验证，所以文件里内置 0 号自检：拿一组合成的违规 / 合规 CSS 片断去跑同一套
 * 检测函数，逐条断言「该报的报了、不该报的没报」。没有这一步，正则写错时门禁会安静地放行。
 *
 * 跑法：
 *   node test/css-tokens.mjs                 # 门禁：打印违规清单 + exit 1
 *   node test/css-tokens.mjs --report        # 报告：只列违规，恒 exit 0（核对重写进度用）
 *   node test/css-tokens.mjs <file> [--report]  # 换一个输入文件（拿 git show 出来的旧 client.js 校验门禁有没有牙齿）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)
const reportOnly = process.argv.includes('--report')
// 默认读仓库根的 client.js；带位置参数时读那个文件（用来拿旧版本校验门禁有没有牙齿）
const argFile = process.argv.slice(2).find((arg) => !arg.startsWith('--'))
const clientPath = argFile === undefined ? path.join(root, 'client.js') : path.resolve(process.cwd(), argFile)

// 反斜杠与换行单独取：扫描字符串字面量时要频繁比它们，直接写字面量在多层转义下容易看错。
const BS = String.fromCharCode(92)
const LF = String.fromCharCode(10)

// 允许被 var() 引用的非 --dsw- 令牌，其余一律失败。
// --ds-font-family-code 来自 DSH 的字体栈契约；--dsh-* 是本面板自定义的局部令牌；
// --dsw-elevation-stroke-color 本身是 --dsw- 前缀，列在这里只为说明它故意在局部被覆盖。
const ALLOWED_EXTRA_TOKENS = [
  '--ds-font-family-code',
  '--dsh-content-font-size',
  // 过程行的行高 / 字号取 DSH 会话流的次级正文档：宿主自己也是 --dsw-font-length + delta
  // 的组合，过程行混在前者的节奏里，用主档会让「过程」看起来比「正文」更重。
  '--dsh-content-font-size-secondary',
  '--dsh-content-font-delta',
  '--dsh-code-font-size',
  '--dsh-code-font-delta',
  '--dsw-elevation-stroke-color',
]

// tokens.txt 里这两个是硬值 #54555780 / #54555799，不是别名，引用它们等于绕过令牌体系。
const BANNED_TOKENS = ['--dsw-alias-button-tool-bar-fill', '--dsw-alias-button-tool-bar-hover']

// 等宽字体字面量：只许出现在 var(--ds-font-family-code, ...) 的兜底位置。
const MONO_LITERALS = ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace']

// 颜色类属性上不许出现的命名色；transparent / currentColor / inherit / none 等关键字放行。
const NAMED_COLORS = [
  'white', 'black', 'red', 'lime', 'blue', 'yellow', 'cyan', 'aqua', 'magenta', 'fuchsia',
  'silver', 'gray', 'grey', 'maroon', 'olive', 'green', 'purple', 'teal', 'navy', 'orange',
  'pink', 'brown', 'gold', 'violet', 'indigo', 'beige', 'ivory', 'khaki', 'coral', 'crimson',
  'tomato', 'salmon', 'plum', 'tan', 'azure', 'aliceblue', 'whitesmoke', 'lightgray', 'lightgrey',
  'darkgray', 'darkgrey', 'dimgray', 'dimgrey', 'slategray', 'slategrey',
]

const COLOR_PROPS = new Set([
  'color', 'background', 'background-color', 'background-image', 'outline', 'outline-color',
  'box-shadow', 'text-shadow', 'fill', 'stroke', 'caret-color', 'accent-color',
  'text-decoration-color', 'column-rule', 'column-rule-color', 'border', 'border-top',
  'border-right', 'border-bottom', 'border-left', 'border-color', 'border-top-color',
  'border-right-color', 'border-bottom-color', 'border-left-color',
])

// ── 输出骨架（照 test/parity.mjs）──────────────────────────────────────────
let passed = 0
const failures = []

function section(title) {
  const pad = Math.max(0, 58 - title.length)
  console.log('')
  console.log('-- ' + title + ' ' + '-'.repeat(pad))
}

function check(name, condition, detail) {
  if (condition) {
    passed += 1
    return true
  }
  failures.push({ name, detail: detail || '' })
  console.error('  x ' + name + (detail ? ' -> ' + detail : ''))
  return false
}

// ── 通用小工具 ─────────────────────────────────────────────────────────────
function lineStartsOf(source) {
  const starts = [0]
  for (let i = 0; i < source.length; i += 1) if (source[i] === LF) starts.push(i + 1)
  return starts
}

function lineAt(starts, offset) {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

function splitTopLevel(text) {
  const parts = []
  let depth = 0
  let current = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
    if (ch === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  parts.push(current)
  return parts
}

// 取违规点所在的那条规则原文：selector{declaration}，两边都截断，便于在终端里定位
function ruleSnippet(css, offset) {
  const open = css.lastIndexOf('{', offset)
  if (open < 0) return css.slice(Math.max(0, offset - 40), offset + 40).trim()
  const prevClose = css.lastIndexOf('}', open)
  let selector = css.slice(prevClose + 1, open).trim()
  if (selector.length > 70) selector = '...' + selector.slice(-69)
  let declEnd = css.indexOf(';', offset)
  const blockEnd = css.indexOf('}', offset)
  if (declEnd < 0 || (blockEnd >= 0 && blockEnd < declEnd)) declEnd = blockEnd
  if (declEnd < 0) declEnd = Math.min(css.length, offset + 60)
  let decl = css.slice(open + 1, declEnd).trim()
  if (decl.length > 150) decl = decl.slice(0, 150) + '...'
  return selector + '{' + decl + '}'
}

// 取 offset 所在的那条声明：prop:value（不含首尾的 ; 与 {}）
function declarationAt(css, offset) {
  let start = Math.max(css.lastIndexOf('{', offset), css.lastIndexOf(';', offset), css.lastIndexOf('}', offset)) + 1
  let end = css.indexOf(';', offset)
  const blockEnd = css.indexOf('}', offset)
  if (end < 0 || (blockEnd >= 0 && blockEnd < end)) end = blockEnd
  if (end < 0) end = Math.min(css.length, offset + 80)
  const text = css.slice(start, end).trim()
  const colon = text.indexOf(':')
  return {
    start,
    text,
    prop: colon < 0 ? '' : text.slice(0, colon).trim().toLowerCase(),
    value: colon < 0 ? text : text.slice(colon + 1).trim(),
  }
}

function findVarRefs(css) {
  const refs = []
  let from = 0
  while (from < css.length) {
    const at = css.indexOf('var(', from)
    if (at < 0) break
    let depth = 0
    let close = -1
    for (let i = at + 3; i < css.length; i += 1) {
      const ch = css[i]
      if (ch === '(') depth += 1
      else if (ch === ')') {
        depth -= 1
        if (depth === 0) { close = i; break }
      }
    }
    const end = close < 0 ? css.length : close
    const inner = css.slice(at + 4, end)
    const parts = splitTopLevel(inner)
    refs.push({
      name: parts[0].trim(),
      offset: at,
      end,
      hasFallback: parts.length > 1,
      text: 'var(' + inner + ')',
    })
    from = end + 1
  }
  return refs
}

// 平铺所有规则块。@media 的外层选择器会带 '@media ...' 前缀；
// 内层规则的 body 会被内层的 '}' 截断，够用来做「有没有这条声明」的判断。
function iterRules(css) {
  const rules = []
  let from = 0
  while (from < css.length) {
    const open = css.indexOf('{', from)
    if (open < 0) break
    const close = css.indexOf('}', open)
    if (close < 0) break
    const selectorStart = Math.max(css.lastIndexOf('}', open - 1), css.lastIndexOf('{', open - 1)) + 1
    rules.push({ selector: css.slice(selectorStart, open).trim(), body: css.slice(open + 1, close) })
    from = close + 1
  }
  return rules
}

// ── 从 client.js 里把 CSS 数组拼出来 ───────────────────────────────────────
// 需要的是「浏览器看到的那段文本」，所以按 JS 单引号字符串的转义规则还原：
// 只处理 \' \\ \n 三种，其余（如 \25B8 这种 CSS 自己的转义）原样保留。
function extractCss(source) {
  let open = source.indexOf('var CSS = [')
  let openMark = 'var CSS = ['
  if (open < 0) {
    open = source.indexOf('CSS = [')
    openMark = 'CSS = ['
  }
  if (open < 0) return { ok: false, reason: 'client.js 里找不到 CSS 数组（缺 var CSS = [）' }
  let closeMark = "].join('')"
  let close = source.indexOf(closeMark, open)
  if (close < 0) {
    closeMark = '].join("")'
    close = source.indexOf(closeMark, open)
  }
  if (close < 0) return { ok: false, reason: "client.js 里找不到 CSS 数组结尾 ].join('')" }

  const bodyStart = open + openMark.length
  const body = source.slice(bodyStart, close)
  const segments = []
  let i = 0
  while (i < body.length) {
    if (body[i] !== "'") {
      i += 1
      continue
    }
    const literalStart = i + 1
    let value = ''
    i = literalStart
    while (i < body.length) {
      const ch = body[i]
      if (ch === BS) {
        const next = body[i + 1]
        if (next === "'") { value += "'"; i += 2; continue }
        if (next === BS) { value += BS; i += 2; continue }
        if (next === 'n') { value += LF; i += 2; continue }
        value += ch + (next === undefined ? '' : next)
        i += 2
        continue
      }
      if (ch === "'") { i += 1; break }
      value += ch
      i += 1
    }
    segments.push({ value, sourceOffset: bodyStart + literalStart })
  }
  if (segments.length === 0) return { ok: false, reason: 'CSS 数组里解析不出任何单引号字符串' }

  let css = ''
  for (const seg of segments) {
    seg.cssStart = css.length
    css += seg.value
  }
  return { ok: true, css, segments }
}

// CSS 偏移 -> client.js 源码偏移 / 行号
function sourceOffsetFor(segments, cssOffset) {
  let lo = 0
  let hi = segments.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (segments[mid].cssStart <= cssOffset) lo = mid
    else hi = mid - 1
  }
  const seg = segments[lo]
  return seg.sourceOffset + Math.min(cssOffset - seg.cssStart, seg.value.length)
}

// ── 分析：把一份 CSS 文本过一遍 7 条规则 ───────────────────────────────────
// segments/source 只影响违规位置能不能映射回 client.js 的行号；
// 自检（0 号）传 segments=null，位置就按 CSS 自身的行号算。
function analyze(css, segments, source) {
  const starts = lineStartsOf(source)

  function violation(offset, token, hint) {
    let srcOffset = offset
    if (segments !== null && segments.length > 0) srcOffset = sourceOffsetFor(segments, offset)
    return { token, line: lineAt(starts, srcOffset), snippet: ruleSnippet(css, offset), hint: hint || '' }
  }

  // 1. 硬色值
  const hardColors = []
  for (const m of css.matchAll(/#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-fA-F])/g)) {
    hardColors.push(violation(m.index, m[0]))
  }
  for (const m of css.matchAll(/\b(?:rgba?|hsla?)\(/gi)) {
    hardColors.push(violation(m.index, m[0] + ')'))
  }
  // 命名色只查颜色类属性的值，避免把 .dsh-pi-gold 这类类名误判
  for (const m of css.matchAll(/(?:^|[{;])\s*([a-zA-Z-]+)\s*:/g)) {
    const prop = m[1].toLowerCase()
    if (!COLOR_PROPS.has(prop) && !prop.endsWith('-color')) continue
    const decl = declarationAt(css, m.index + m[0].length)
    const valueStart = decl.start + (decl.text.length - decl.value.length)
    for (const token of decl.value.split(/[\s,]+/)) {
      const low = token.trim().toLowerCase()
      if (!NAMED_COLORS.includes(low)) continue
      hardColors.push(violation(valueStart + decl.value.indexOf(token), low, '命名色'))
    }
  }
  hardColors.sort((a, b) => a.line - b.line)

  // 2/3. 令牌白名单与兜底
  const varRefs = findVarRefs(css)
  const tokenNames = new Map()
  for (const ref of varRefs) {
    if (!ref.name.startsWith('--')) continue
    if (!tokenNames.has(ref.name)) tokenNames.set(ref.name, { count: 0, first: ref })
    tokenNames.get(ref.name).count += 1
  }
  const unknownTokens = []
  for (const [name, info] of tokenNames) {
    if (name.startsWith('--dsw-') || ALLOWED_EXTRA_TOKENS.includes(name)) continue
    unknownTokens.push({ name, count: info.count, violation: violation(info.first.offset, name) })
  }
  const missingFallback = []
  for (const ref of varRefs) {
    if (!ref.name.startsWith('--')) continue
    if (ref.name.startsWith('--dsw-')) continue
    if (ref.hasFallback) continue
    missingFallback.push({ name: ref.name, violation: violation(ref.offset, ref.text) })
  }

  // 4. 禁用令牌
  const bannedHits = []
  for (const banned of BANNED_TOKENS) {
    let from = 0
    while (from < css.length) {
      const at = css.indexOf(banned, from)
      if (at < 0) break
      bannedHits.push({ name: banned, violation: violation(at, banned) })
      from = at + banned.length
    }
  }

  // 5. 字体栈
  const fontCodeRanges = []
  for (const ref of varRefs) {
    if (ref.name === '--ds-font-family-code') fontCodeRanges.push({ start: ref.offset, end: ref.end })
  }
  const monoHits = []
  const monoRe = new RegExp('(?<![\\w-])(' + MONO_LITERALS.join('|') + ')(?![\\w-])', 'gi')
  for (const m of css.matchAll(monoRe)) {
    if (fontCodeRanges.some((range) => m.index > range.start && m.index < range.end)) continue
    monoHits.push(violation(m.index, m[0], '裸字体栈'))
  }
  monoHits.sort((a, b) => a.line - b.line)
  // 一条 font-family 声明里五个字面量会算成五条命中，报告里按规则归并，避免刷屏
  const monoGroups = []
  const monoGroupIndex = new Map()
  for (const hit of monoHits) {
    const key = String(hit.line) + '|' + hit.snippet
    if (!monoGroupIndex.has(key)) {
      monoGroupIndex.set(key, monoGroups.length)
      monoGroups.push({ line: hit.line, snippet: hit.snippet, literals: [] })
    }
    const group = monoGroups[monoGroupIndex.get(key)]
    if (!group.literals.includes(hit.token)) group.literals.push(hit.token)
  }

  // 6. 焦点可见
  const rules = iterRules(css)
  const focusRules = rules.filter((rule) => rule.selector.includes(':focus-visible'))
  const focusOk = focusRules.some((rule) => {
    const body = rule.body.split(' ').join('')
    if (body.includes('outline:var(--dsw-focus-ring-width)')) return true
    return body.includes('outline-width:') && body.includes('outline-color:')
  })

  // 7. 减少动效
  const motionBlock = rules.find(
    (rule) => rule.selector.includes('@media') && /prefers-reduced-motion\s*:\s*reduce/.test(rule.selector),
  )

  return { hardColors, varRefs, tokenNames, unknownTokens, missingFallback, bannedHits, monoHits, monoGroups, focusRules, focusOk, motionBlock, rules }
}

// ── 0. 门禁自检：合成样例必须被同一套检测函数识别 ─────────────────────────
const CLEAN_CSS = '.a{color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code,ui-monospace,monospace)}'
  + '.a:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-alias-brand-primary)}'
  + '@media (prefers-reduced-motion: reduce){.a{transition-duration:.01ms}}'

const SELF_CASES = [
  { name: '硬色值 #fff', css: '.a{color:#fff}', expect: (r) => r.hardColors.length, want: 1 },
  { name: '硬色值 #0000001f', css: '.a{background:#0000001f}', expect: (r) => r.hardColors.length, want: 1 },
  { name: '硬色值 rgba()', css: '.a{background:rgba(0,0,0,.72)}', expect: (r) => r.hardColors.length, want: 1 },
  { name: '硬色值 hsl()', css: '.a{color:hsl(0 0% 0%)}', expect: (r) => r.hardColors.length, want: 1 },
  { name: '硬色值 命名色 white', css: '.a{color:white}', expect: (r) => r.hardColors.length, want: 1 },
  { name: 'color-mix 里被 mix 的是 var 时放行', css: '.a{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}', expect: (r) => r.hardColors.length, want: 0 },
  { name: '令牌越界 --foo', css: '.a{color:var(--foo)}', expect: (r) => r.unknownTokens.length, want: 1 },
  { name: '缺兜底 var(--ds-font-family-code)', css: '.a{font-family:var(--ds-font-family-code)}', expect: (r) => r.missingFallback.length, want: 1 },
  { name: '缺兜底 var(--dsh-code-font-size)', css: '.a{font-size:var(--dsh-code-font-size)}', expect: (r) => r.missingFallback.length, want: 1 },
  { name: '禁用令牌 --dsw-alias-button-tool-bar-fill', css: '.a{background:var(--dsw-alias-button-tool-bar-fill)}', expect: (r) => r.bannedHits.length, want: 1 },
  { name: '裸字体栈 font-family:ui-monospace,...', css: '.a{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}', expect: (r) => r.monoHits.length, want: 5 },
  { name: '字体栈在 var 兜底里放行', css: '.a{font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace)}', expect: (r) => r.monoHits.length, want: 0 },
  { name: ':focus-visible 带 focus ring', css: CLEAN_CSS, expect: (r) => (r.focusOk ? 1 : 0), want: 1 },
  { name: '缺 :focus-visible', css: '.a{color:var(--dsw-alias-label-primary)}', expect: (r) => (r.focusOk ? 1 : 0), want: 0 },
  { name: 'prefers-reduced-motion 带空格变体', css: '@media (prefers-reduced-motion: reduce){.a{transition-duration:.01ms}}', expect: (r) => (r.motionBlock === undefined ? 0 : 1), want: 1 },
  { name: 'prefers-reduced-motion 无空格变体', css: '@media(prefers-reduced-motion:reduce){.a{transition-duration:.01ms}}', expect: (r) => (r.motionBlock === undefined ? 0 : 1), want: 1 },
  { name: '缺 prefers-reduced-motion', css: '.a{color:var(--dsw-alias-label-primary)}', expect: (r) => (r.motionBlock === undefined ? 0 : 1), want: 0 },
]

// 返回自检自身失败的条数：自检挂了说明门禁本身不可信，report 模式也得报错退出
function selfTest() {
  section('0 门禁自检（合成样例，防止正则写错后静默放行）')
  const before = failures.length
  for (const item of SELF_CASES) {
    const result = analyze(item.css, null, item.css)
    const actual = item.expect(result)
    check('自检 ' + item.name, actual === item.want, '期望 ' + String(item.want) + '，实际 ' + String(actual))
  }
  const clean = analyze(CLEAN_CSS, null, CLEAN_CSS)
  const cleanTotal = clean.hardColors.length + clean.unknownTokens.length + clean.missingFallback.length
    + clean.bannedHits.length + clean.monoHits.length + (clean.focusOk ? 0 : 1) + (clean.motionBlock === undefined ? 1 : 0)
  check('自检 合规样例零违规', cleanTotal === 0, '实际 ' + String(cleanTotal) + ' 条')
  const selfFailures = failures.length - before
  console.log('  自检 ' + String(SELF_CASES.length + 1) + ' 条：' + (selfFailures === 0 ? '全部通过' : String(selfFailures) + ' 条失败'))
  return selfFailures
}

// ── 主流程 ─────────────────────────────────────────────────────────────────
if (!fs.existsSync(clientPath)) {
  console.error('FAIL: 找不到 ' + clientPath)
  process.exit(1)
}
const source = fs.readFileSync(clientPath, 'utf8')
const stat = fs.statSync(clientPath)
const extracted = extractCss(source)
if (!extracted.ok) {
  console.error('FAIL: ' + extracted.reason)
  process.exit(1)
}

const css = extracted.css
const segments = extracted.segments
const result = analyze(css, segments, source)
const { hardColors, varRefs, tokenNames, unknownTokens, missingFallback, bannedHits, monoHits, monoGroups, focusRules, focusOk, motionBlock } = result

// 不计入门禁、但重写时值得对照的观察项
const sourceStarts = lineStartsOf(source)
function analyzeOffset(offset) {
  const srcOffset = sourceOffsetFor(segments, offset)
  return { token: css.slice(offset, offset + 9).trim(), line: lineAt(sourceStarts, srcOffset), snippet: ruleSnippet(css, offset) }
}

const observations = []
{
  const resetHits = []
  for (const m of css.matchAll(/\boutline\s*:\s*(?:0|none)\b/g)) resetHits.push(analyzeOffset(m.index))
  if (resetHits.length > 0) {
    observations.push({ title: 'outline:0 / outline:none 出现 ' + String(resetHits.length) + ' 处（靠 :focus-visible 补回键盘焦点）', items: resetHits })
  }
  const outsideHits = []
  for (const m of source.matchAll(/(['"])#[0-9a-fA-F]{3,8}\1|\b(?:rgba?|hsla?)\(/g)) {
    const at = m.index
    const insideCss = segments.some((seg) => at >= seg.sourceOffset && at <= seg.sourceOffset + seg.value.length)
    if (insideCss) continue
    outsideHits.push({ token: m[0], line: lineAt(sourceStarts, at), snippet: 'CSS 数组之外' })
  }
  if (outsideHits.length > 0) {
    observations.push({ title: 'CSS 数组之外出现硬色值 ' + String(outsideHits.length) + ' 处（内联 style？）', items: outsideHits })
  }
  if (motionBlock !== undefined && !/animation-duration|transition-duration|animation:none|transition:none/.test(motionBlock.body)) {
    observations.push({ title: 'prefers-reduced-motion 块里没有 animation/transition 的压制声明', items: [] })
  }
}

const CATEGORIES = [
  { title: '硬色值', items: hardColors },
  { title: '令牌越界', items: unknownTokens.map((item) => item.violation) },
  { title: '缺兜底', items: missingFallback.map((item) => item.violation) },
  { title: '禁用令牌', items: bannedHits.map((item) => item.violation) },
  { title: '裸字体栈', items: monoGroups.map((group) => ({ line: group.line, token: group.literals.join(','), snippet: group.snippet })) },
]
const totalViolations = CATEGORIES.reduce((sum, category) => sum + category.items.length, 0)
  + (focusOk ? 0 : 1) + (motionBlock === undefined ? 1 : 0)

const fileLabel = path.basename(clientPath)
function printItem(item, extra) {
  console.log('    ' + fileLabel + ':' + String(item.line) + '  ' + (item.token || '') + (extra ? '  ' + extra : '') + '  ' + item.snippet)
}

console.log('css-tokens: ' + clientPath)
console.log(fileLabel + ' ' + String(stat.size) + ' 字节 / mtime ' + stat.mtime.toISOString())
console.log('CSS 数组 ' + String(segments.length) + ' 段 / ' + String(css.length) + ' 字符')

if (reportOnly) {
  section('违规清单')
  if (totalViolations === 0) console.log('  （无违规）')
  for (const category of CATEGORIES) {
    if (category.items.length === 0) continue
    console.log('  ' + category.title + ' (' + String(category.items.length) + ')')
    for (const item of category.items) printItem(item, item.hint)
  }
  if (!focusOk) {
    console.log('  焦点可见缺失 (1)')
    console.log('    CSS 里' + (focusRules.length === 0 ? '没有 :focus-visible 规则' : '有 ' + String(focusRules.length) + ' 条 :focus-visible 规则但没有 outline:var(--dsw-focus-ring-width)'))
  }
  if (monoHits.length > 0) console.log('  （裸字体栈按 font-family 声明归并：' + String(monoGroups.length) + ' 条声明 / ' + String(monoHits.length) + ' 个字面量命中）')
  if (motionBlock === undefined) {
    console.log('  减少动效缺失 (1)')
    console.log('    CSS 里没有 @media (prefers-reduced-motion: reduce)')
  }

  if (observations.length > 0) {
    section('额外观察（不计入门禁）')
    for (const item of observations) {
      console.log('  · ' + item.title)
      for (const detail of item.items) printItem(detail, '')
    }
  }

  section('汇总')
  for (const category of CATEGORIES) console.log('  ' + category.title + ': ' + String(category.items.length))
  console.log('  焦点可见缺失: ' + (focusOk ? '0' : '1'))
  console.log('  减少动效缺失: ' + (motionBlock === undefined ? '1' : '0'))
  console.log('  违规合计: ' + String(totalViolations) + ' 条')
  console.log('  令牌引用: ' + String(varRefs.length) + ' 处 / ' + String(tokenNames.size) + ' 个唯一变量')
}

const selfFailures = selfTest()

// 自检挂了不能当成「0 违规」放行：门禁本身不可信时两种模式都要报错
if (selfFailures > 0) {
  console.error('')
  console.error('SELF-TEST FAILED (' + String(selfFailures) + ' 条自检失败，门禁结论不可信)')
  for (const item of failures) console.error('  - ' + item.name + (item.detail ? ' -> ' + item.detail : ''))
  process.exit(1)
}

if (reportOnly) {
  console.log('')
  console.log('REPORT (' + String(totalViolations) + ' violations, exit 0)')
  process.exit(0)
}

// ── 门禁断言（1..7）───────────────────────────────────────────────────────
section('1 硬色值（#hex / rgb() / rgba() / hsl() / hsla() / 命名色）')
if (hardColors.length === 0) check('CSS 内无硬色值字面量', true)
for (const item of hardColors) check('硬色值 ' + item.token + ' @' + fileLabel + ':' + String(item.line), false, item.snippet)

section('2 令牌白名单（只许 --dsw-* 与本地兜底令牌）')
for (const [name, info] of tokenNames) {
  const allowed = name.startsWith('--dsw-') || ALLOWED_EXTRA_TOKENS.includes(name)
  check('令牌 ' + name + ' 在白名单内（引用 ' + String(info.count) + ' 次）', allowed, allowed ? '' : ruleSnippet(css, info.first.offset))
}

section('3 兜底（非 --dsw-* 令牌必须带第二个参数）')
let nonDswRefs = 0
for (const ref of varRefs) if (ref.name.startsWith('--') && !ref.name.startsWith('--dsw-')) nonDswRefs += 1
check('非 --dsw-* 令牌引用 ' + String(nonDswRefs) + ' 处全部带兜底', missingFallback.length === 0,
  missingFallback.map((item) => item.violation.snippet).join(' | '))

section('4 禁用令牌（tokens.txt 里是硬值，不是别名）')
check('未引用 --dsw-alias-button-tool-bar-fill / -hover', bannedHits.length === 0,
  bannedHits.map((hit) => hit.violation.snippet).join(' | '))

section('5 等宽字体栈只许在 var(--ds-font-family-code, ...) 兜底里')
check('无裸等宽字体栈字面量（' + String(monoGroups.length) + ' 条声明 / ' + String(monoHits.length) + ' 个字面量）', monoHits.length === 0,
  monoGroups.map((group) => fileLabel + ':' + String(group.line) + ' [' + group.literals.join(',') + '] ' + group.snippet).join(' | '))

section('6 焦点可见')
check(':focus-visible 带 outline:var(--dsw-focus-ring-width)', focusOk,
  focusRules.length === 0 ? 'CSS 里没有 :focus-visible 规则' : '有 :focus-visible 但没有 focus ring 令牌')

section('7 减少动效')
check('存在 @media (prefers-reduced-motion: reduce)', motionBlock !== undefined,
  motionBlock === undefined ? 'CSS 里没有该 media query' : '')

if (failures.length > 0) {
  console.error('')
  console.error('FAIL (' + String(passed) + ' passed, ' + String(failures.length) + ' failed)')
  for (const item of failures) console.error('  - ' + item.name + (item.detail ? ' -> ' + item.detail : ''))
  process.exit(1)
}
console.log('')
console.log('PASS (' + String(passed) + ' checks)')

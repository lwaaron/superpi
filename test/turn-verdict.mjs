#!/usr/bin/env node
/**
 * 回合判据的对账门禁（0.16.2 建，0.18.0 扩到六类）。
 *
 * ---------------------------------------------------------------------------
 * 它守的是什么
 *
 * 「模型把工具调用写成 DeepSeek 原生 DSML」这件事，在本仓库失败过四次，
 * 前三次的修法都是**在需要它的那个文件里再抄一份判据**：
 *
 *   extensions/superpi-editor.ts  → 有判据（命令行 TUI 用）
 *   client.js                     → **一条也没有**（grep -c DSML client.js = 0）
 *
 * 于是同一个模型、同一个故障：命令行窗口亮红字并告知「本轮未执行，直接重发即可」，
 * 而面板端**完全静默** —— 用户只看到一句话说完然后会话不动。
 *
 * 0.18.0 的取证（`docs/output-integrity.md`）又补了两类同样"看起来结束了"的形态：
 * 坏字节（7 次 write 已落盘）与被截断（`stopReason: 'length'`）。
 *
 * ---------------------------------------------------------------------------
 * 为什么 0.18.0 把「两边对账」改成了「单点判定」
 *
 * 0.16.2~0.17.3 的结构是「表在契约、算法在面板」：契约下发判定表，面板按表实现
 * 一份孪生判据，本门禁拿同一批样本喂两边、断言结论相等。它有两个结构性缺陷：
 *
 *   ① 共同盲区无法被测出：两边都漏掉同一类新形态时，"结论相等"仍然成立。
 *   ② 面板的判读依赖 `/contract` 先到 —— 事件早到的那一轮提示永久丢失
 *      （0.17.3 只好把启动顺序改成契约先行来绕开，依赖本身还在）。
 *
 * 现在判读在 host（`src/event-verdict.mjs` → `message_end.verdict`），
 * 面板只渲染。所以本门禁的判据层从"两份实现是否一致"变成：
 *   · 判据只有一份（面板里不许再出现判据实现）
 *   · 判读真的挂到了事件上（入环之前，回放与实时同一份）
 *   · 面板真的把 verdict 画出来了（管道通了 ≠ 交付到了）
 *
 * 跑法：node test/turn-verdict.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { listRuntimeFiles } from '../src/runtime-files.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)
const require = createRequire(import.meta.url)

let passed = 0
const failures = []
function check(name, ok, detail) {
  if (ok === true) { passed += 1; return }
  failures.push(name + (detail === undefined ? '' : ' → ' + String(detail)))
  console.log('  ✗ ' + name + (detail === undefined ? '' : ' → ' + String(detail)))
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), 'actual=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected))
}
function section(title) {
  console.log('')
  console.log('── ' + title + ' ' + '─'.repeat(Math.max(0, 62 - title.length)))
}

/* ───────────────────────── 依赖前置断言（不许静默跳过）───────────────────────── */
/**
 * 本门禁需要 react 才能跑「面板真的渲染了 verdict」那一段（client.js 只 require('react')）。
 *
 * **缺了就是失败，不是跳过。** 这是 AGENTS.md §5.0 那条硬约束：
 * 0.16.0 实测隐藏 `.runtime/` 后 6 套门禁整段跳过并 exit 0，`npm test` 仍是绿的 ——
 * 而 `.runtime/` 是 gitignore 的，**新机器 clone 下来必然命中**。
 * 「无法验证」不等于「验证通过」。
 */
function findReactHome() {
  const candidates = [
    path.join(root, '.runtime', 'node_modules'),
    path.join(path.dirname(root), 'pi-main', 'node_modules'),
  ]
  for (const homeDir of candidates) {
    if (fs.existsSync(path.join(homeDir, 'react', 'package.json'))) return homeDir
  }
  return null
}

const reactHome = findReactHome()
if (reactHome === null) {
  console.error('FAIL: 找不到 react —— 面板侧接线断言无法执行。')
  console.error('      装法：npm install（会在 .runtime/ 下就位），或把 react 放到同级 pi-main/node_modules。')
  console.error('      本门禁**不会**在缺依赖时 exit 0：跳过等于把这条保障删掉。')
  process.exit(1)
}

/* ───────────────────────────── 判据模块 ───────────────────────────── */

const verdictModule = await import(pathToFileURL(path.join(root, 'extensions', 'superpi-turn-verdict.mjs')).href)
const bytesModule = await import(pathToFileURL(path.join(root, 'extensions', 'superpi-text-bytes.mjs')).href)
const decorator = await import(pathToFileURL(path.join(root, 'src', 'event-verdict.mjs')).href)
const contract = await import(pathToFileURL(path.join(root, 'src', 'rpc-contract.mjs')).href)

section('1. 判据表：异常类型齐全、每类都有中英文案')
eq('异常类型枚举', verdictModule.VERDICT_KINDS, ['truncated', 'stream-interrupted', 'dsml-text', 'dsml-thinking', 'dsml-residue', 'corrupt', 'reasoning-markup', 'idle'])
for (const kind of verdictModule.VERDICT_KINDS) {
  const notice = verdictModule.TURN_VERDICT_NOTICE[kind]
  check(kind + ' 有文案', notice !== null && typeof notice === 'object')
  check(kind + ' 中文非空', typeof notice?.zh === 'string' && notice.zh.length > 8)
  check(kind + ' 英文非空', typeof notice?.en === 'string' && notice.en.length > 8)
  eq(kind + ' 文案取中英一致（turnVerdictNotice）', [
    verdictModule.turnVerdictNotice(kind, { locale: 'zh', bytes: 3 }),
    verdictModule.turnVerdictNotice(kind, { locale: 'en', bytes: 3 }),
  ], [notice.zh.replace('{{n}}', '3'), notice.en.replace('{{n}}', '3')])
}
check('corrupt 文案带数量占位符', verdictModule.TURN_VERDICT_NOTICE.corrupt.zh.includes('{{n}}') && verdictModule.TURN_VERDICT_NOTICE.corrupt.en.includes('{{n}}'))
check('未知名不返回 undefined（返回空串，调用方不必防御）', verdictModule.turnVerdictNotice('nope') === '')
eq('判定表里收尾态含 length', verdictModule.TURN_VERDICT_DETECTION.terminalStopReasons, ['stop', 'length'])
eq('判定表里截断态是 length', verdictModule.TURN_VERDICT_DETECTION.truncatedStopReason, 'length')

/* ───────────────────────────── 样本集（唯一一份）───────────────────────────── */

const BAR = String.fromCharCode(0xff5c)
const DSML = BAR + BAR + 'DSML' + BAR + BAR
const LT = String.fromCharCode(60)
const GT = String.fromCharCode(62)
const SLASH = String.fromCharCode(47)
const OPEN = LT + DSML + ' invoke' + GT
const CLOSE = LT + SLASH + DSML + ' calls' + GT
const RESIDUE = LT + SLASH + 'parameter' + GT
/** 坏字节样本一律用转义构造：本文件自己也不许含 U+FFFD（否则仓库卫生门禁会红）。 */
const BAD = String.fromCharCode(0xfffd)
const BEL = String.fromCharCode(0x07)
const LONE = String.fromCharCode(0xd800)

export const SAMPLES = [
  // ── 六类真实形态（前四类取自 0.16.2 的真机样本，后两类取自 0.18.0 的取证）
  { name: 'A 正文型：text 块含完整 DSML 结构', kind: 'dsml-text',
    message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '做完了。' + OPEN + '\n' + CLOSE }] } },
  { name: 'B thinking 型：只有 thinking 块，闭合标记在 thinking 里', kind: 'dsml-thinking',
    message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'thinking', thinking: 'Let me verify empirically.' + CLOSE }] } },
  { name: 'C 空转型：stop 收尾但既无正文也无 toolCall', kind: 'idle',
    message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'thinking', thinking: '只有思考' }] } },
  { name: 'D 残片型：开标记被网关吞掉，只剩闭侧残片', kind: 'dsml-residue',
    message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'README 已无坏字节。现在跑全量门禁做最终验证。' + RESIDUE + '\n\n' + CLOSE }] } },
  { name: 'E 坏字节型：正文含 U+FFFD，无 toolCall', kind: 'corrupt',
    message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '2. ' + BAD + BAD + BAD + '始规则内容由用户给定，用户可以在设置里修改。' }] } },
  { name: 'F 截断型：stopReason=length', kind: 'truncated',
    message: { role: 'assistant', stopReason: 'length', content: [{ type: 'text', text: '第一段写完，第二段只写了一半' }] } },
  { name: 'G 推理标记未闭合：出现在正文开头', kind: 'reasoning-markup',
    message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '<thinking>Review done.\n已验证，并发测试通过。' }] } },
  { name: 'H 提前断流：上游在响应过程中报错', kind: 'stream-interrupted',
    message: { role: 'assistant', stopReason: 'error', errorMessage: 'Upstream response stream ended before completion',
      content: [{ type: 'toolCall', id: 'unexecuted', name: 'write' }] } },

  // ── 排除项（误报面必须为零：本仓库自己的文档里到处在讨论 DSML）
  { name: '排除：toolUse 已解析出结构化调用', kind: 'none',
    message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'x', name: 'bash' }] } },
  { name: '排除：正常回复（只说话不调工具）', kind: 'none',
    message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '这是一段正常回复，没有工具调用。' }] } },
  { name: '排除：正文里讨论 DSML（句中引用残片）', kind: 'none',
    message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '我们修的是 ' + RESIDUE + ' 这类残片，它出现在句中，后面还有很多解释。' + '填充'.repeat(60) }] } },
  { name: '排除：error 态归错误路径', kind: 'none',
    message: { role: 'assistant', stopReason: 'error', content: [{ type: 'text', text: 'boom' + RESIDUE }] } },
  { name: '排除：有 toolCall 时不判残片（重复执行风险不为零）', kind: 'none',
    message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'toolCall', id: 'y', name: 'write' }, { type: 'text', text: 'ok' + RESIDUE }] } },
  { name: '排除：有 toolCall 时坏字节交给写入闸（回合还在继续）', kind: 'none',
    message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'z', name: 'write', arguments: { content: BAD } }] } },
  { name: '排除：thinking 里含控制字符但 agent 仍在调工具', kind: 'none',
    message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'w', name: 'bash' }, { type: 'thinking', thinking: BEL }] } },
]

section('2. 行为层：判据模块本身（host / 命令行共用这一份）')
const assistantText = (text, stopReason = 'stop', tools = []) => ({
  role: 'assistant', stopReason, content: [{ type: 'text', text }, ...tools],
})
eq('行内引用推理标记是正常说明', verdictModule.detectTurnVerdict(assistantText('`<thinking>` 是标签示例。')).kind, 'none')
eq('代码块里的推理标记是合法样例', verdictModule.detectTurnVerdict(assistantText('```xml\n<thinking>\n```')).kind, 'none')
eq('讨论 DSML 的日常文字不触发重试', verdictModule.detectTurnVerdict(assistantText('DSML invokes tools. DSML calls are examples.')).kind, 'none')
eq('用 Markdown 引用完整工具标记不触发重试', verdictModule.detectTurnVerdict(assistantText('示例：\n```xml\n' + OPEN + '\n' + CLOSE + '\n```')).kind, 'none')
eq('结尾行内代码含闭合标签不触发重试', verdictModule.detectTurnVerdict(assistantText('例如 `' + RESIDUE + '`')).kind, 'none')
eq('落在消息末尾的有名未闭合调用可识别', verdictModule.detectTurnVerdict(assistantText('准备写文件。' + LT + DSML + ' invoke name="write"')).kind, 'dsml-text')
eq('截断带不完整工具参数也报告截断', verdictModule.detectTurnVerdict(assistantText('', 'length', [{ type: 'toolCall', name: 'write' }])).kind, 'truncated')
eq('可见短回复不会被判空转', verdictModule.detectTurnVerdict(assistantText('已完成。')).kind, 'none')
eq('正文里讨论断流不触发恢复', verdictModule.detectTurnVerdict(assistantText('Upstream response stream ended before completion')).kind, 'none')
for (const sample of SAMPLES) {
  const result = verdictModule.detectTurnVerdict(sample.message)
  eq(sample.name, result.kind, sample.kind)
  eq(sample.name + ' · delivered 与 kind 一致', result.delivered, sample.kind === 'none')
  if (sample.kind !== 'none') {
    check(sample.name + ' · 带中英文案', typeof result.notice?.zh === 'string' && result.notice.zh !== '' && typeof result.notice?.en === 'string')
  }
}
eq('坏字节数量进 detail 与文案', (() => {
  const result = verdictModule.detectTurnVerdict(SAMPLES.find(s => s.kind === 'corrupt').message)
  return [result.bytes, result.notice.zh.includes('3 处')]
})(), [3, true])
eq('空值不抛且不误判', verdictModule.detectTurnVerdict(null).delivered, true)
eq('非 assistant 不判', verdictModule.detectTurnVerdict({ role: 'user', content: [] }).delivered, true)
eq('布尔包装与 kind 同源', SAMPLES.map(s => verdictModule.isUndeliveredTurn(s.message)), SAMPLES.map(s => s.kind !== 'none'))

section('3. 文本字节层：坏字节的唯一判据')
eq('干净文本', bytesModule.isCleanText('中文\t\n ok，含全角：｜｜DSML｜｜'), true)
eq('BOM 不算坏字节', bytesModule.isCleanText(String.fromCharCode(0xfeff) + 'x'), true)
eq('合法代理对不算坏字节', bytesModule.scanTextBytes('😀').clean, true)
const scan = bytesModule.scanTextBytes('ab' + BAD + 'c\n' + BEL + 'd' + LONE)
eq('计数全量且按类分开', scan.counts, { replacement: 1, control: 1, surrogate: 1 })
eq('位置带行列号', scan.spans.map(span => [span.line, span.column, span.kind]), [[1, 3, 'replacement'], [2, 1, 'control'], [2, 3, 'surrogate']])
eq('描述里给全总数与码位', bytesModule.describeBytes(scan).startsWith('3 处坏字节：第 1 行 U+FFFD'), true)
const lots = bytesModule.scanTextBytes(BAD.repeat(50), { maxSpans: 2 })
eq('位置截断但计数不截断', [lots.total, lots.spans.length], [50, 2])
check('描述里补「另有 N 处」', bytesModule.describeBytes(lots).includes('另有 48 处'))
eq('汇总只列非零项', bytesModule.summarizeCounts({ replacement: 0, control: 2, surrogate: 0 }), 'control=2')

section('4. 单点判定：verdict 必须挂在 message_end 上（入环之前）')
{
  const record = { type: 'message_end', message: SAMPLES[0].message }
  const decorated = decorator.decoratePiEvent(record)
  eq('DSML 被挂上 verdict', decorated.verdict.kind, 'dsml-text')
  eq('delivered=false', decorated.verdict.delivered, false)
  eq('pi 原有字段不动', [decorated.type, decorated.message.role], ['message_end', 'assistant'])
  eq('正常回复也带 verdict（面板靠它清掉上一轮提示）', decorator.decoratePiEvent({ type: 'message_end', message: assistantText('正常回复。') }).verdict.delivered, true)
  eq('user 消息不挂', decorator.decoratePiEvent({ type: 'message_end', message: { role: 'user', content: [] } }).verdict, undefined)
  eq('非 message_end 不挂', decorator.decoratePiEvent({ type: 'turn_start' }).verdict, undefined)
  eq('null 不抛', decorator.decoratePiEvent(null), null)
  const frozen = Object.freeze({ type: 'message_end', message: Object.freeze({ role: 'assistant', stopReason: 'stop', content: Object.freeze([]) }) })
  check('冻结对象不抛（装饰失败也不能丢事件）', decorator.decoratePiEvent(frozen) === frozen)

  const { PiProcess } = await import('../src/pi-rpc.mjs')
  const proc = new PiProcess({ maxEvents: 1, decorateEvent: decorator.decoratePiEvent })
  proc.pushEvent({ type: 'message_end', message: SAMPLES[0].message })
  proc.pushEvent({ type: 'agent_settled', aborted: false })
  eq('事件已淘汰，快照仍带本次恢复状态', proc.snapshot().lastVerdict?.kind, 'dsml-text')
  proc.pushEvent({ type: 'agent_start' })
  eq('新请求清掉旧恢复状态', proc.snapshot().lastVerdict, null)
  proc.pushEvent({ type: 'message_end', message: SAMPLES[0].message })
  proc.pushEvent({ type: 'agent_settled', aborted: true })
  eq('主动停止不残留继续提示', proc.snapshot().lastVerdict, null)
}

section('5. 接线层：判读真的送达用户了吗')
/**
 * 0.16.1 的血泪教训：`docs/parity.md` 的 D-05 曾把「pendingUi 随 snapshot() 下发」
 * 记为已闭环，而面板**从来没读过那个字段** —— 协议字段发了出去、门禁也断言了 host 侧，
 * 但没有一条断言「面板会渲染它」。后果是用户无法应答，命令挂 12 分钟。
 *
 * 所以这里不只要断言「判据函数存在」，还要断言：
 * message_end 有没有把结论记进 view、渲染里有没有真的画出来。
 */
const clientSource = fs.readFileSync(path.join(root, 'client.js'), 'utf8')
/**
 * 按源码实际出现顺序排列 —— 这个数组用**单调推进的 cursor** 检查，
 * 顺序错了就会误报"找不到"。顺序本身也有意义：
 * 它是"定义 → 判定 → 记录 → 渲染"的数据流。
 */
const wiring = [
  ['创建 view 时初始化 verdict', 'verdict: null,'],
  ['agent_start 清空上一轮判读', 'view.lastError = null; view.verdict = null; return }'],
  ['message_end 分支存在', "if (type === 'message_end')"],
  ['判读结果从事件里取（不再自己算）', 'record.verdict !== null && record.verdict !== undefined && record.verdict.delivered === false'],
  ['记进 view.verdict', '? record.verdict'],
  ['渲染里判读 view.verdict', 'view.verdict !== null && view.verdict !== undefined'],
]
let cursor = 0
for (const [label, needle] of wiring) {
  const at = clientSource.indexOf(needle, cursor)
  check('接线：' + label, at >= 0)
  if (at >= 0) cursor = at + needle.length
}
/**
 * 渲染面**单独判**，不并进上面的顺序链。
 *
 * 原因：`VerdictNotice` 是组件定义（在文件前部），而调用点在 `renderGate`（文件后部）。
 * 把它们串成一条单调 cursor 会要求"组件定义在 view.verdict 之后"，那是错的顺序约束。
 */
const renderBits = [
  ['组件按语言选文案（host 下发的那一份）', "String(props.lang) === 'en'"],
  ['渲染出告警容器', 'superpi-verdict-box'],
  ['告警带 role=status（读屏可见）', "role: 'status'"],
  ['提供可点的继续入口', 'superpi-verdict-retry'],
]
for (const [label, needle] of renderBits) {
  check('渲染：' + label, clientSource.indexOf(needle) >= 0)
}
check('面板里没有判据实现（0.18.0 起判读只在 host）', /function\s+detectMalformedOutput/.test(clientSource) === false)
check('面板不读 contract.malformed', /contract\.malformed/.test(clientSource) === false)
check('面板不再自带「畸形」兜底文案', clientSource.indexOf('malformedTitle') < 0 && clientSource.indexOf('malformedDetail') < 0)
check('i18n 有 verdictRetry 词条（中英各一）', (clientSource.match(/verdictRetry:/g) ?? []).length === 2)
check('i18n 有 verdictDetail 词条（中英各一）', (clientSource.match(/verdictDetail:/g) ?? []).length === 2)
check('i18n 有 verdictLang 词条（中英各一）', (clientSource.match(/verdictLang: '/g) ?? []).length === 2)
check('契约失败文案不再声称「畸形提示不可用」', clientSource.includes('斜杠命令分派') === true)

/**
 * 5b. **真的渲染一遍**：这是「用户能看到」的唯一机器证据。
 *
 * 0.16.1 的 D-05 教训：协议字段发了出去、门禁也断言了 host 侧，但没有一条断言
 * 「面板会渲染它」—— 后果是命令挂 12 分钟。0.16.2~0.17.3 的判据段同样只做到
 * `indexOf` 字符串存在，那证明的是"代码里有这行字"，不是"用户能看见这行字"。
 *
 * 做法与 `test/client-render.mjs` 一致：假 window 截下模块定义，再拿 react-dom/server
 * 把 `VerdictNotice` 真渲成 HTML。
 */
{
  let definition = null
  globalThis.window = { __ModuleLoader__: { load: (def) => { definition = def } } }
  const req = createRequire(path.join(reactHome, 'noop.js'))
  const React = req('react')
  const { renderToStaticMarkup } = req('react-dom/server')
  const requireShim = (name) => {
    if (name === 'react') return React
    throw new Error('client.js 不允许 require(' + JSON.stringify(name) + ')')
  }
  await import(pathToFileURL(path.join(root, 'client.js')).href)
  check('client.js 调用了 __ModuleLoader__.load', definition !== null)
  const internals = definition === null ? {} : definition.factory(requireShim).__internals
  check('面板导出了 VerdictNotice（可被渲染门禁驱动）', typeof internals.VerdictNotice === 'function')

  if (typeof internals.VerdictNotice === 'function') {
    const corruptVerdict = verdictModule.detectTurnVerdict(SAMPLES.find(s => s.kind === 'corrupt').message)
    const zh = renderToStaticMarkup(React.createElement(internals.VerdictNotice, {
      verdict: corruptVerdict, lang: 'zh', retryLabel: '继续', detail: '细节', busy: false,
    }))
    check('中文环境渲染出中文文案', zh.includes(corruptVerdict.notice.zh.replace(/</g, '&lt;')), zh.slice(0, 200))
    check('渲染出「继续」按钮', zh.includes('>继续<'))
    check('按钮带可点类名（点击路径与手打一致）', zh.includes('superpi-verdict-retry'))
    check('容器是 status 区域（读屏可见）', zh.includes('role="status"'))
    const en = renderToStaticMarkup(React.createElement(internals.VerdictNotice, {
      verdict: corruptVerdict, lang: 'en', retryLabel: 'Continue', detail: 'detail', busy: false,
    }))
    check('英文环境渲染出英文文案', en.includes(corruptVerdict.notice.en.replace(/</g, '&lt;')), en.slice(0, 200))
    check('英文环境按钮是 Continue', en.includes('>Continue<'))
    const busy = renderToStaticMarkup(React.createElement(internals.VerdictNotice, {
      verdict: corruptVerdict, lang: 'zh', retryLabel: '继续', detail: '', busy: true,
    }))
    check('运行中按钮禁用（不能并发发两条）', busy.includes('disabled=""'))
    const disconnect = verdictModule.detectTurnVerdict(SAMPLES.find(s => s.kind === 'stream-interrupted').message)
    const notice = renderToStaticMarkup(React.createElement(internals.VerdictNotice, {
      verdict: disconnect, lang: 'zh', retryLabel: '继续', busy: false,
    }))
    check('断流提示真实渲染并能继续', notice.includes(disconnect.notice.zh) && notice.includes('>继续<') && !notice.includes('disabled=""'))
    eq('verdict 为空时不渲染任何东西', renderToStaticMarkup(React.createElement(internals.VerdictNotice, { verdict: null })), '')
  }
}

const editorSource = fs.readFileSync(path.join(root, 'extensions', 'superpi-editor.ts'), 'utf8')
check('命令行 import 同一个判据模块', editorSource.includes("from './superpi-turn-verdict.mjs'"))
check('命令行调 detectTurnVerdict（不是自己判）', editorSource.includes('detectTurnVerdict(message)'))
check('命令行存整份 verdict（不再是布尔）', editorSource.includes('markUndelivered(verdict)') && editorSource.indexOf('runState.malformed') < 0)
check('命令行 Working 行文案取自 verdict.notice（不复制文案）', editorSource.includes('verdict.notice?.zh'))
check('终端的消息事件只负责展示，恢复由 pi 生命周期处理', !editorSource.includes('AUTO_RETRY_TEXT') && !editorSource.includes('decideAutoRetry'))

const indexSource = fs.readFileSync(path.join(root, 'index.js'), 'utf8')
check('host 把装饰器接进了 PiProcess', indexSource.includes('decorateEvent: decoratePiEvent,'))
check('host 从 src/event-verdict.mjs 导入', indexSource.includes("from './src/event-verdict.mjs'"))
check('host 不再往 /contract 下发 malformed 判定表', indexSource.indexOf('malformed: MALFORMED_DETECTION,') < 0)
const rpcSource = fs.readFileSync(path.join(root, 'src', 'pi-rpc.mjs'), 'utf8')
check('装饰发生在入环之前（pushEvent 里）', /pushEvent\(record, sizeHint\) \{[\s\S]{0,1200}?this\.decorateEvent/.test(rpcSource))
check('装饰器抛错不会丢事件（try/catch 回落到原记录）', /return next !== null && typeof next === 'object' \? next : record/.test(rpcSource))

section('6. 契约收敛：判据知识只有一份')
eq('契约不再导出 MALFORMED_DETECTION', contract.MALFORMED_DETECTION, undefined)
eq('契约不再导出 MALFORMED_NOTICE', contract.MALFORMED_NOTICE, undefined)
check('validateContract() 无问题', contract.validateContract().length === 0, contract.validateContract().join('; '))

section('7. 安装面：模块先于扩展，清单不漏文件')
{
  const installer = await import(pathToFileURL(path.join(root, 'tools', 'install-pi-extension.mjs')).href)
  const files = installer.EXTENSION_FILES
  const position = new Map(files.map((file, index) => [file.name, index]))
  const expected = listRuntimeFiles(root).filter(file => file.startsWith('extensions/'))
  eq('安装清单包含全部扩展源码', files.map(file => file.source).sort(), expected)
  eq('安装目标名称与源码文件名一致', files.map(file => file.name).sort(), expected.map(file => path.basename(file)))
  /**
   * 依赖顺序按**真实 import 语句**判，而不是按文件名猜。
   *
   * 0.15.3 的真机事故：`.ts` 排在它 import 的 `.mjs` 前面，装到一半时磁盘上是
   * 「新 .ts + 旧 .mjs」，扩展加载即抛、pi 直接 exit(1)。
   * 0.18.0 起 `superpi-editor.ts` 的依赖叫 `superpi-turn-verdict.mjs`（不同基名），
   * 按"同基名"推断会漏掉它 —— 所以直接读源码里的 `from './x.mjs'`。
   */
  const problems = []
  for (const [index, entry] of files.entries()) {
    const sourcePath = path.join(root, entry.source)
    if (fs.existsSync(sourcePath) !== true) { problems.push(entry.label + ' 源文件不存在'); continue }
    const source = fs.readFileSync(sourcePath, 'utf8')
    for (const match of source.matchAll(/from\s+'\.\/([\w.-]+\.mjs)'/g)) {
      const dep = files.find(file => file.name === match[1])
      if (dep === undefined) { problems.push(entry.label + ' import 了未登记的文件 ' + match[1]); continue }
      if (position.get(dep.name) > index) problems.push(entry.label + ' 排在它的依赖 ' + dep.name + ' 之前')
    }
  }
  eq('同目录依赖都排在导入者前面', problems, [])
}

/* ───────────────────────────────── 汇总 ───────────────────────────────── */

console.log('')
if (failures.length === 0) {
  console.log('PASS (' + passed + ' checks)')
  process.exit(0)
}
console.error('FAIL (' + passed + ' passed, ' + failures.length + ' failed)')
for (const failure of failures) console.error('  - ' + failure)
process.exit(1)

#!/usr/bin/env node
/**
 * 畸形输出判据的对账门禁（0.16.2）。
 *
 * ---------------------------------------------------------------------------
 * 为什么这套门禁必须存在（这是本仓库第四次遇到同一类缺陷）
 *
 * 「模型把工具调用写成 DeepSeek 原生 DSML」这件事，前三次的修法都是
 * **在需要它的那个文件里再抄一份判据**。第三次修完之后的状态是：
 *
 *   extensions/superpi-editor.ts  → 有判据（命令行 TUI 用）
 *   client.js                     → **一条也没有**（grep -c DSML client.js = 0）
 *
 * 于是同一个模型、同一个故障：命令行窗口亮红字并告知
 * 「本轮未执行，直接重发即可」，而面板端**完全静默** ——
 * 用户只看到一句话说完然后会话不动，既不知道为什么，也不知道该做什么。
 *
 * 这不是"两处都写了、但写得不一致"，而是"一处有一处没有"：
 * 任何"两边分别测试"的门禁都发现不了它（少了的那一边没有测试可跑）。
 * 所以判据收进 `extensions/superpi-malformed.mjs` 一处，本文件守的就是那个"一处"。
 *
 * ---------------------------------------------------------------------------
 * 三层对账，缺一层就会被绕过
 *
 *   ① **数据层**：模块的判定表 / 文案 与 契约里下发的那份逐字段相等
 *      （漂移的后果：命令行判定用一套阈值，面板用另一套）
 *   ② **行为层**：同一批样本喂给「模块」与「面板的真函数」，逐条结论一致
 *      （只对数据不够 —— 面板把表读进去却判错时，数据断言全绿）
 *   ③ **接线层**：message_end 是否真的把结论记进 view、渲染里是否真的画出来
 *      （0.16.1 的教训：管道通了 ≠ 交付到了，D-05 就是这么被误记成已闭环的）
 *
 * ---------------------------------------------------------------------------
 * 样本集的两种形态（缺任一半都会让判据失去价值）
 *
 *   - **四类真实形态**：A 正文型 / B thinking 型 / C 空转型 / D 残片型
 *     （D 类是 2026-11-20 真机抓到的新形态，前三条全部漏掉它）
 *   - **五类排除项**：toolUse / 正常回复 / 正文里讨论 DSML / error 态 / 有 toolCall
 *
 * 排除项那一半同样重要：本仓库自己的文档里到处在**讨论** DSML，
 * 若判据把它们当故障，用户会对这个提示彻底失去信任 —— 那比漏判更糟。
 *
 * 跑法：node test/malformed.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
 * 本门禁需要 react 才能跑「面板侧行为对账」那一段（client.js 只 require('react')）。
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
  console.error('FAIL: 找不到 react —— 面板侧行为对账无法执行。')
  console.error('      装法：npm install（会在 .runtime/ 下就位），或把 react 放到同级 pi-main/node_modules。')
  console.error('      本门禁**不会**在缺依赖时 exit 0：跳过等于把这条保障删掉。')
  process.exit(1)
}

/* ───────────────────────────── 判据模块 ───────────────────────────── */

const malformedModule = await import(pathToFileURL(path.join(root, 'extensions', 'superpi-malformed.mjs')).href)
const contract = await import(pathToFileURL(path.join(root, 'src', 'rpc-contract.mjs')).href)

section('1. 数据层：模块 ≡ 契约（判定表与文案）')
/**
 * 为什么把表下发到契约而不是让面板自己写一份：
 * 面板只能 `require('react')`，拿不到仓库模块。而「这个故障长什么样」的知识
 * 必须只有一份 —— 所以照 `classifyInput` 的既成范式（算法在面板、表在契约）。
 */
eq('判定表字段集一致', Object.keys(malformedModule.MALFORMED_DETECTION).sort(), Object.keys(contract.MALFORMED_DETECTION).sort())
for (const key of Object.keys(contract.MALFORMED_DETECTION)) {
  eq('判定表.' + key, malformedModule.MALFORMED_DETECTION[key], contract.MALFORMED_DETECTION[key])
}
eq('文案键集一致', Object.keys(malformedModule.MALFORMED_NOTICE).sort(), Object.keys(contract.MALFORMED_NOTICE).sort())
for (const lang of Object.keys(contract.MALFORMED_NOTICE)) {
  eq('文案.' + lang + ' 逐字相同', malformedModule.MALFORMED_NOTICE[lang], contract.MALFORMED_NOTICE[lang])
  eq('malformedNotice(' + lang + ') 与表一致', malformedModule.malformedNotice(lang), contract.MALFORMED_NOTICE[lang])
}

section('2. 契约自检与下发面')
check('validateContract() 无问题', contract.validateContract().length === 0, contract.validateContract().join('; '))
const indexSource = fs.readFileSync(path.join(root, 'index.js'), 'utf8')
check('host /contract 下发了 malformed', indexSource.includes('malformed: MALFORMED_DETECTION,'))
check('host /contract 下发了 malformedNotice', indexSource.includes('malformedNotice: MALFORMED_NOTICE,'))
check('index.js 从契约 import 了这两个常量', /MALFORMED_DETECTION/.test(indexSource.slice(0, 4000)) && /MALFORMED_NOTICE/.test(indexSource.slice(0, 4000)))

/* ───────────────────────────── 样本集（唯一一份）───────────────────────────── */

const BAR = String.fromCharCode(0xff5c)
const DSML = BAR + BAR + 'DSML' + BAR + BAR
const LT = String.fromCharCode(60)
const GT = String.fromCharCode(62)
const SLASH = String.fromCharCode(47)
const OPEN = LT + DSML + ' invoke' + GT
const CLOSE = LT + SLASH + DSML + ' calls' + GT
const RESIDUE = LT + SLASH + 'parameter' + GT

/**
 * 样本集 —— 本文件是**唯一一份定义**。
 * 面板侧对账直接复用这批样本（同一个数组，不另抄）。
 */
export const SAMPLES = [
  // ── 四类真实形态
  { name: 'A 正文型：text 块含完整 DSML 结构', kind: 'text',
    message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '做完了。' + OPEN + '\n' + CLOSE }] } },
  { name: 'B thinking 型：只有 thinking 块，闭合标记在 thinking 里', kind: 'thinking',
    message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'thinking', thinking: 'Let me verify empirically.' + CLOSE }] } },
  { name: 'C 空转型：stop 收尾但既无正文也无 toolCall', kind: 'idle',
    message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'thinking', thinking: '只有思考' }] } },
  { name: 'D 残片型：开标记被网关吞掉，只剩闭侧残片', kind: 'residue',
    message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'README 已无坏字节。现在跑全量门禁做最终验证。' + RESIDUE + '\n\n' + CLOSE }] } },

  // ── 五类排除项
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
]

section('3. 行为层 A：判据模块本身（命令行窗口与 host 用这一份）')
for (const sample of SAMPLES) {
  const result = malformedModule.detectMalformedOutput(sample.message)
  eq(sample.name, result.malformed ? result.kind : 'none', sample.kind)
}
// 布尔包装与带形态版本必须同源，否则「命令行说畸形、日志说正常」这种自相矛盾会回来
for (const sample of SAMPLES) {
  const bool = malformedModule.isMalformedOutput(sample.message)
  const kind = malformedModule.detectMalformedOutput(sample.message).kind
  eq('布尔包装与 kind 一致：' + sample.name, bool, kind !== 'none')
}
eq('空值不抛且不误判', malformedModule.detectMalformedOutput(null).malformed, false)
eq('非 assistant 不判', malformedModule.detectMalformedOutput({ role: 'user', content: [] }).malformed, false)

section('4. 行为层 B：面板真函数与模块逐条一致')
/**
 * 这一段是「两边实现逐条同构」的机器证明。
 *
 * 做法：client.js 是 `window.__ModuleLoader__.load({factory})` 形式，不能直接 import。
 * 所以造一个假 window 把 factory 截下来，再拿 react 真跑一次 ——
 * 这样面板那边跑的是**将要发布的那份代码**，不是影子实现。
 */
let definition = null
globalThis.window = { __ModuleLoader__: { load: (def) => { definition = def } } }
const React = require(path.join(reactHome, 'react'))
const requireShim = (name) => {
  if (name === 'react') return React
  throw new Error('client.js 不允许 require(' + JSON.stringify(name) + ')')
}
await import(pathToFileURL(path.join(root, 'client.js')).href)
check('client.js 调用了 __ModuleLoader__.load', definition !== null)
const internals = definition === null ? {} : definition.factory(requireShim).__internals
check('面板导出了 detectMalformedOutput 供门禁对账', typeof internals.detectMalformedOutput === 'function')
check('面板导出了 buildContract', typeof internals.buildContract === 'function')

if (typeof internals.detectMalformedOutput === 'function' && typeof internals.buildContract === 'function') {
  const panelContract = internals.buildContract({ malformed: contract.MALFORMED_DETECTION })
  for (const sample of SAMPLES) {
    const result = internals.detectMalformedOutput(sample.message, panelContract)
    eq(sample.name + '（面板）', result.malformed ? result.kind : 'none', sample.kind)
  }
  /**
   * 契约没下发时**不许**内置一份默认表来猜。
   * 内置默认值看似"更稳"，实际是分叉的起点：默认值哪天改了，
   * 契约与面板就各说一套，而门禁因为「两边都有值」反而绿。
   */
  const bare = internals.buildContract({})
  eq('契约未下发 malformed 时面板不判', internals.detectMalformedOutput(SAMPLES[0].message, bare).malformed, false)
  eq('契约未下发时 malformed 字段为 null（不是默认表）', bare.malformed, null)
}

section('5. 接线层：判据真的送达用户了吗')
/**
 * 0.16.1 的血泪教训：`docs/parity.md` 的 D-05 曾把
 * 「pendingUi 随 snapshot() 下发」记为已闭环，而面板**从来没读过那个字段**
 * （全文件 0 处引用）—— 协议字段发了出去、门禁也断言了 host 侧，
 * 但没有一条断言「面板会渲染它」。后果是用户无法应答，命令挂 12 分钟。
 *
 * 所以这里不只要断言「判据函数存在」，还要断言：
 * message_end 有没有把结论记进 view、渲染里有没有真的画出来。
 */
const clientSource = fs.readFileSync(path.join(root, 'client.js'), 'utf8')
/**
 * 按源码实际出现顺序排列 —— 这个数组用**单调推进的 cursor** 检查，
 * 顺序错了就会误报“找不到”（第一版就把创建 view 的初始化放在了 agent_start 之后而踩了）。
 * 顺序本身也有意义：它大致就是“定义 → 判定 → 记录 → 渲染”的数据流。
 */
const wiring = [
  ['创建 view 时初始化 malformed', 'malformed: null,'],
  ['agent_start 清空上一轮标记', 'view.lastError = null; view.malformed = null; return }'],
  ['message_end 分支存在', "if (type === 'message_end')"],
  ['message_end 里调用了判据', 'var malformed = detectMalformedOutput(record.message, contractRef.current)'],
  ['判据结果记进 view.malformed', 'view.malformed = malformed.malformed ? malformed.kind : null'],
  ['契约 ref 在 loadContract 成功时写入', 'contractRef.current = built'],
  ['渲染里判读 view.malformed', 'view.malformed !== null && view.malformed !== undefined'],
  ['渲染出告警容器', 'superpi-malformed-box'],
  ['告警带 role=status（读屏可见）', "role: 'status'"],
  ['提供可点的继续入口', "submit(t('malformedRetry'))"],
]
let cursor = 0
for (const [label, needle] of wiring) {
  const at = clientSource.indexOf(needle, cursor)
  check('接线：' + label, at >= 0)
  if (at >= 0) cursor = at + needle.length
}
check('i18n 有 malformedRetry 词条（中英各一）', (clientSource.match(/malformedRetry:/g) ?? []).length === 2)
check('i18n 有 malformedTitle 词条（中英各一）', (clientSource.match(/malformedTitle:/g) ?? []).length === 2)
check('i18n 有 malformedDetail 词条（中英各一）', (clientSource.match(/malformedDetail:/g) ?? []).length === 2)

section('6. 安装面：editor 静态 import 该模块，顺序与内容都必须对')
/**
 * 0.15.3 的真机事故：清单里 `.ts` 排在它 import 的 `.mjs` 前面，
 * 用户 `/reload` 后磁盘上是「新 .ts + 旧 .mjs」→ 扩展加载即抛
 * `resetMeterMemo is not a function`，而 pi 会直接 exit(1)。
 * 顺序是契约的一部分，不是排版。
 */
const installSource = fs.readFileSync(path.join(root, 'tools', 'install-pi-extension.mjs'), 'utf8')
/**
 * 只在该数组内部比先后：文件头的说明文字里也提到了这两个文件名（第一版就踩了 ——
 * 拿全文 indexOf 比较，结果命中的是注释里的 `superpi-editor.ts`）。
 * 门禁自己踩一次、修一次，比下一个被错误绿色放行的人要便宜得多。
 */
const listStart = installSource.indexOf('export const EXTENSION_FILES = [')
const listEnd = installSource.indexOf(']', listStart)
check('找到 EXTENSION_FILES 清单', listStart >= 0 && listEnd > listStart)
const listBody = listStart >= 0 && listEnd > listStart ? installSource.slice(listStart, listEnd) : ''
const moduleAt = listBody.indexOf('extensions/superpi-malformed.mjs')
const editorAt = listBody.indexOf('extensions/superpi-editor.ts')
check('安装清单里有 malformed 模块', moduleAt >= 0)
check('安装清单里有 editor', editorAt >= 0)
check('malformed 模块排在 editor 之前（editor import 它）', moduleAt >= 0 && editorAt >= 0 && moduleAt < editorAt, 'moduleAt=' + String(moduleAt) + ' editorAt=' + String(editorAt))
const editorSource = fs.readFileSync(path.join(root, 'extensions', 'superpi-editor.ts'), 'utf8')
check('editor 真的 import 了共用判据模块', editorSource.includes('superpi-malformed.mjs'))
check('editor 不再自己实现一份判据（isMalformedToolCall 只做转发）', !editorSource.includes("source.includes('DSML') && (source.includes('invoke')"));

/* ───────────────────────────────── 汇总 ───────────────────────────────── */

console.log('')
if (failures.length === 0) {
  console.log('PASS (' + passed + ' checks)')
  process.exit(0)
}
console.error('FAIL (' + passed + ' passed, ' + failures.length + ' failed)')
for (const failure of failures) console.error('  - ' + failure)
process.exit(1)

#!/usr/bin/env node
/**
 * 写入闸（坏字节不落盘）的门禁 —— 0.18.0。
 *
 * ---------------------------------------------------------------------------
 * 为什么这一层必须单独测（而不是只测纯函数）
 *
 * 纯函数证明的是"我们能判出来"，而用户要的是"文件真的没被写坏"。
 * 中间还隔着 pi 的两段机制，任何一段接错都会让整件事变成静默失效：
 *
 *   agent-session.js:_beforeToolCall → runner.emitToolCall(...)
 *   runner.js:emitToolCall           → 遇 { block: true } 立即返回
 *   agent-loop.js                    → beforeResult.block → createErrorToolResult(reason)
 *                                     且**不执行工具**
 *
 * 所以本门禁分四层，缺一层就有一种"看起来做了"的失败模式：
 *   ① 纯函数：哪些字段拦、哪些放行（含 oldText 必须放行）
 *   ② 真 .ts 扩展：jiti 加载 `superpi-text-integrity.ts`，假 pi 拿 handler
 *   ③ **pi 真 runner**：把 handler 交给 pi 自己的 `ExtensionRunner` 跑一遍，
 *      断言它返回 block —— 这一步证明"pi 真的会用我们的返回值"
 *   ④ 源码事实：pi 的 agent-loop 把 block 变成 error 结果并且不执行工具
 *
 * 跑法：node test/text-integrity.mjs
 * 依赖 pi 运行时（jiti / runner 都从它那儿借）。**缺了直接失败，不 SKIP**。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { resolvePiRuntime } from '../src/pi-runtime.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)

let checks = 0
const failures = []
function ok(condition, message) {
  checks += 1
  if (condition) return
  failures.push(message)
  console.error('  ✗ ' + message)
}
function eq(actual, expected, message) {
  const same = actual !== null && expected !== null && typeof actual === 'object' && typeof expected === 'object'
    ? JSON.stringify(actual) === JSON.stringify(expected)
    : actual === expected
  ok(same, message + ' (got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected) + ')')
}
function section(title) {
  console.log('')
  console.log('── ' + title)
}

const BAD = String.fromCharCode(0xfffd)
const BEL = String.fromCharCode(0x07)
const LONE = String.fromCharCode(0xd800)
const NUL = String.fromCharCode(0)

/* ───────────────────────── 依赖前置断言（不许静默跳过）───────────────────────── */

const pi = resolvePiRuntime({ pluginRoot: root })
if (!pi.cliPath || !pi.packageDir) {
  console.error('FAIL[preflight] pi 运行时不可用 —— 写入闸扩展无法加载')
  console.error('  这一层是本门禁的被测对象，不能跳过。修法：npm run test:runtime')
  process.exit(1)
}
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
  console.error('FAIL[preflight] 找不到 jiti —— 写入闸扩展无法加载。修法：npm run test:runtime')
  process.exit(1)
}

/* ───────────────────────── ① 纯函数层 ───────────────────────── */

const integrity = await import(pathToFileURL(path.join(root, 'extensions', 'superpi-text-integrity.ts')).href)
  .catch(async () => {
    // .ts 不能直接被 node import —— 用 jiti（与 ② 同一个入口，避免两套加载方式）
    const { createJiti } = await import(pathToFileURL(jitiPath).href)
    const jiti = createJiti(path.join(root, 'extensions', 'superpi-text-integrity.ts'), {
      interopDefault: true,
      moduleCache: false,
      alias: {
        '@earendil-works/pi-coding-agent': path.join(pi.packageDir, 'dist', 'index.js'),
        '@earendil-works/pi-tui': path.join(pi.packageDir, '..', 'pi-tui', 'dist', 'index.js'),
      },
    })
    return jiti.import(path.join(root, 'extensions', 'superpi-text-integrity.ts'))
  })

section('1. 纯函数：拦哪些、放行哪些')
{
  const clean = integrity.inspectToolCall({ toolName: 'write', input: { path: 'a.md', content: '正常内容\n第二行\tok' } })
  eq(clean.level, 'clean', '干净内容放行')
  eq(clean.hit, null, '干净内容不产生 hit')

  const dirty = integrity.inspectToolCall({ toolName: 'write', input: { path: 'a.md', content: 'x' + BAD } })
  eq(dirty.level, 'block', 'write.content 含 U+FFFD → 拦截')
  eq(dirty.hit.field, 'content', '命中字段是 content')
  eq(dirty.hit.path, 'a.md', '命中记录目标路径')
  eq(dirty.hit.total, 1, '命中数正确')

  eq(integrity.inspectToolCall({ toolName: 'write', input: { path: 'a.bin', content: 'a' + NUL } }).level, 'block', 'write 含 U+0000 → 拦截')
  eq(integrity.inspectToolCall({ toolName: 'write', input: { path: 'a.md', content: 'a' + LONE } }).level, 'block', 'write 含孤立代理项 → 拦截')
  for (const toolName of ['write', 'edit']) {
    const result = integrity.inspectToolCall({ toolName, input: { path: 'a' + BAD + '.md', content: 'clean' } })
    eq(result.level, 'block', toolName + ' 不在损坏的目标路径写入')
    eq(result.hit?.field, 'path', toolName + ' 报告的是路径损坏')
    ok(!integrity.buildBlockReason(result.hit ?? { path: '', field: '', total: 0, summary: '' }).includes(BAD),
      toolName + ' 的诊断不回显坏字符')
  }
  eq(integrity.inspectToolCall({ toolName: 'write', input: { path: 'a.ts', content: 'const s = "\\uFFFD"' } }).level, 'clean',
    '写成转义的 \\uFFFD 是干净文本（这正是被拦后该走的路）')

  /**
   * 修复入口：`oldText` 含坏字节必须放行。
   *
   * 这是「不误伤」的核心一条 —— 一个已经被写坏的文件，修它时匹配串里
   * **必然**含 U+FFFD。拦它等于让坏文件永远修不好。
   */
  eq(integrity.inspectToolCall({ toolName: 'edit', input: { path: 'a.md', edits: [{ oldText: 'a' + BAD, newText: 'ab' }] } }).level, 'clean',
    'edit.oldText 含坏字节 → 放行（修复入口）')
  const editDirty = integrity.inspectToolCall({ toolName: 'edit', input: { path: 'a.md', edits: [{ oldText: 'a', newText: 'a' + BAD }] } })
  eq(editDirty.level, 'block', 'edit.newText 含坏字节 → 拦截')
  eq(editDirty.hit.field, 'edits[0].newText', '命中字段带下标')
  const editSecond = integrity.inspectToolCall({ toolName: 'edit', input: { path: 'a.md', edits: [{ oldText: 'a', newText: 'b' }, { oldText: 'c', newText: 'c' + BAD }] } })
  eq(editSecond.hit.field, 'edits[1].newText', '第二处坏字节也能定位（不是只看第一条）')

  /**
   * bash 只提醒、不拦截：同一串字节可能正是修复脚本
   * （`perl -pi -e 's/\x{FFFD}//g'`、`grep -rn $'\uFFFD'`）。拦它等于禁止修复。
   */
  eq(integrity.inspectToolCall({ toolName: 'bash', input: { command: 'echo ' + BAD } }).level, 'warn', 'bash 命令含坏字节 → 提醒而不是拦截')
  eq(integrity.inspectToolCall({ toolName: 'powershell', input: { command: 'echo ' + BAD } }).level, 'warn', 'powershell 同理')
  eq(integrity.inspectToolCall({ toolName: 'read', input: { path: 'a' + BAD } }).level, 'clean', '读路径不判（不写盘）')
  eq(integrity.inspectToolCall(null).level, 'clean', 'null 不抛')
}

section('2. 拦截理由：模型能照着改')
{
  const hit = integrity.inspectToolCall({ toolName: 'write', input: { path: 'docs/x.md', content: 'a' + BAD + '\n' + BEL } }).hit
  const reason = integrity.buildBlockReason(hit)
  ok(reason.includes('docs/x.md'), '理由里带目标路径')
  ok(reason.includes('2 处'), '理由里带总数')
  ok(reason.includes('第 1 行 U+FFFD') && reason.includes('第 2 行 U+0007'), '理由里带行号与码位')
  ok(reason.includes('文件未写入'), '理由里明确"没有发生"（否则模型以为写好了）')
  ok(reason.includes('不要原样重发'), '理由里明确禁止盲目重试')
  ok(reason.includes('\\uFFFD'), '理由里给可执行的替代写法（转义）')
  const warn = integrity.buildWarnNotice(integrity.inspectToolCall({ toolName: 'bash', input: { command: BAD } }).hit)
  ok(warn.includes('损坏字节') && warn.includes('重新读取'), '命令串提醒可执行')
}

/* ───────────────────────── ② 真 .ts 扩展层（假 pi）───────────────────────── */

section('3. 真 .ts 扩展：注册面与 handler 行为')
const { createJiti } = await import(pathToFileURL(jitiPath).href)
const extensionFile = path.join(root, 'extensions', 'superpi-text-integrity.ts')
const jiti = createJiti(extensionFile, {
  interopDefault: true,
  moduleCache: false,
  alias: {
    '@earendil-works/pi-coding-agent': path.join(pi.packageDir, 'dist', 'index.js'),
    '@earendil-works/pi-tui': path.join(pi.packageDir, '..', 'pi-tui', 'dist', 'index.js'),
  },
})
const extensionModule = await jiti.import(extensionFile)
const entry = extensionModule.default
eq(typeof entry, 'function', '扩展默认导出是函数（pi 加载用）')
/**
 * 日志版本戳必须等于 package.json 的 version。
 *
 * 为什么单独立一条：`INTEGRITY_VERSION` 是同一个事实的手写副本，而它实测已经从
 * 0.19.0 一路停在原地、package.json 早到 0.38.x —— 于是 0.38 的拦截在取证日志里
 * 被记成 0.19（报告与实际不符，D1 类）。这类副本没有断言就必然漂。
 */
const pkgVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
eq(extensionModule.INTEGRITY_VERSION, pkgVersion, 'INTEGRITY_VERSION 与 package.json 同步（否则日志记错版本）')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'superpi-integrity-'))
const logFile = path.join(tmp, 'integrity.log.jsonl')
process.env.SUPERPI_INTEGRITY = logFile

function makeFakePi() {
  const handlers = new Map()
  const commands = new Map()
  return {
    handlers,
    commands,
    on(name, fn) {
      const list = handlers.get(name) ?? []
      list.push(fn)
      handlers.set(name, list)
    },
    registerCommand(name, definition) { commands.set(name, definition) },
  }
}

{
  const fake = makeFakePi()
  entry(fake)
  ok(fake.handlers.has('tool_call'), '注册了 tool_call')
  ok(fake.handlers.has('tool_result'), '注册了 tool_result')
  ok(fake.commands.has('superpi-integrity'), '注册了 /superpi-integrity')

  const onToolCall = fake.handlers.get('tool_call')[0]
  const blocked = await onToolCall({ type: 'tool_call', toolName: 'write', toolCallId: 'c1', input: { path: 'x.md', content: BAD } })
  eq(blocked.block, true, '假 pi 上同样返回 block')
  eq(typeof blocked.reason, 'string', 'block 带 reason')
  eq(await onToolCall({ type: 'tool_call', toolName: 'write', toolCallId: 'c2', input: { path: 'x.md', content: 'ok' } }), undefined, '干净写盘返回 undefined（零痕迹）')

  const onToolResult = fake.handlers.get('tool_result')[0]
  // bash：tool_call 记一笔，tool_result 追加提醒
  eq(await onToolCall({ type: 'tool_call', toolName: 'bash', toolCallId: 'b1', input: { command: 'echo ' + BAD } }), undefined, 'bash 不拦截')
  const patched = await onToolResult({ type: 'tool_result', toolName: 'bash', toolCallId: 'b1', input: { command: 'x' }, content: [{ type: 'text', text: '输出' }], isError: false })
  ok(Array.isArray(patched.content) && patched.content[patched.content.length - 1].text.includes('损坏字节'), 'bash 结果末尾追加了提醒')
  eq(await onToolResult({ type: 'tool_result', toolName: 'bash', toolCallId: 'b1', content: [{ type: 'text', text: '输出' }] }), undefined, '同一 toolCallId 只提醒一次')
  eq(await onToolResult({ type: 'tool_result', toolName: 'bash', toolCallId: 'zzz', content: [{ type: 'text', text: '输出' }] }), undefined, '未记录的 toolCallId 不追加（不串台）')

  // structuredContent 必须原样带回：pi 在"替换 content 但没给 structuredContent"时会把它删掉
  await onToolCall({ type: 'tool_call', toolName: 'bash', toolCallId: 'b2', input: { command: BAD } })
  const withStructured = await onToolResult({
    type: 'tool_result', toolName: 'bash', toolCallId: 'b2',
    content: [{ type: 'text', text: 'x' }], structuredContent: { ok: true }, isError: false,
  })
  eq(withStructured.structuredContent, { ok: true }, 'structuredContent 被原样带回（不误伤机器可读结果）')

  // 末尾是图片时也必须追加（上一版在这里有一条静默路径：日志记了、模型没看到）
  await onToolCall({ type: 'tool_call', toolName: 'bash', toolCallId: 'b3', input: { command: BAD } })
  const withImage = await onToolResult({ type: 'tool_result', toolName: 'bash', toolCallId: 'b3', content: [{ type: 'text', text: 'out' }, { type: 'image', data: 'x', mimeType: 'image/png' }] })
  eq(withImage.content.length, 3, '末尾是图片时也追加一个文本块（不静默）')
  eq(withImage.content[2].type, 'text', '追加的是一块文本')
  eq(withImage.content[1].type, 'image', '原有图片块结构不动')

  // 命令面板可调
  let printed = ''
  await fake.commands.get('superpi-integrity').handler('', { ui: { editor: async (_title, text) => { printed = text } } })
  ok(printed.includes('拦截写盘'), '命令打印累计拦截次数')
  ok(printed.includes(logFile), '命令打印日志路径（用户要把它转给接口提供方）')
}

section('4. 观测日志：滚动、汇总、坏行容错')
{
  eq(fs.existsSync(logFile), true, '拦截/提醒会落到日志文件')
  const rows = integrity.readIntegrityLogSync({ file: logFile })
  ok(rows.length >= 3, '日志里能读回记录')
  const stats = integrity.summarizeIntegrityLog(rows)
  ok(stats.blocked >= 1 && stats.warned >= 1, '汇总区分拦截与提醒')
  const clean = path.join(tmp, 'clean.jsonl')
  integrity.appendIntegrityLogSync({ level: 'block', tool: 'write', bytes: 1 }, { file: clean, maxLines: 3 })
  for (let i = 0; i < 5; i += 1) integrity.appendIntegrityLogSync({ level: 'warn', tool: 'bash', bytes: i }, { file: clean, maxLines: 3 })
  eq(fs.readFileSync(clean, 'utf8').trim().split('\n').length, 3, '日志按上限滚动')
  fs.writeFileSync(clean, 'not json\n{"level":"block","tool":"write","bytes":2}\n', 'utf8')
  eq(integrity.readIntegrityLogSync({ file: clean }).length, 1, '坏行跳过，不让命令崩')
  eq(integrity.readIntegrityLogSync({ file: path.join(tmp, 'nope.jsonl') }), [], '文件不存在返回空数组')
}

/* ───────────────────────── ③ pi 真 runner ───────────────────────── */

section('5. pi 真 runner：block 真的会让工具不执行')
{
  const runnerEntry = path.join(pi.packageDir, 'dist', 'core', 'extensions', 'runner.js')
  eq(fs.existsSync(runnerEntry), true, '找到 pi 的 ExtensionRunner')
  const runnerModule = await import(pathToFileURL(runnerEntry).href)

  const handlers = new Map()
  entry({ on(name, fn) { handlers.set(name, [...(handlers.get(name) ?? []), fn]) }, registerCommand() {} })
  const runner = new runnerModule.ExtensionRunner([{ handlers }], { ui: {} }, root, {}, null)

  const blocked = await runner.emitToolCall({
    type: 'tool_call', toolName: 'write', toolCallId: 'r1',
    input: { path: 'x.md', content: 'a' + BAD },
  })
  eq(blocked?.block, true, 'pi 的 runner 返回 block（说明 pi 真的会用我们的返回值）')
  ok(String(blocked?.reason).includes('文件未写入'), 'runner 带出的 reason 就是模型会看到的那段')

  const allowed = await runner.emitToolCall({
    type: 'tool_call', toolName: 'write', toolCallId: 'r2',
    input: { path: 'x.md', content: 'ok' },
  })
  eq(allowed, undefined, '干净内容在 runner 上不被拦')

  // tool_result 链：返回 content 补丁，pi 的合并逻辑会用新的 content
  const merged = await runner.emitToolResult({
    type: 'tool_result', toolName: 'bash', toolCallId: 'r3',
    input: { command: BAD }, content: [{ type: 'text', text: 'out' }], isError: false,
  })
  // 注意：r3 的 tool_call 没有走过 handler，所以没有记录 → 不追加（这本身就是"不串台"的证明）
  // pi 的 runner 在没有任何补丁时返回 undefined（不是空对象）。
  eq(merged, undefined, '未记录的调用不会被追加提醒')
}

section('6. 源码事实：block 之后 pi 做了什么（不是我们的推断）')
{
  const loopSource = fs.readFileSync(path.join(pi.packageDir, '..', 'pi-agent-core', 'dist', 'agent-loop.js'), 'utf8')
  ok(/beforeResult\?\.block/.test(loopSource), 'agent-loop 读 beforeResult.block')
  ok(/createErrorToolResult\(beforeResult\.reason/.test(loopSource), 'block 的 reason 被原样当成错误结果（模型能看到）')
  const sessionSource = fs.readFileSync(path.join(pi.packageDir, 'dist', 'core', 'agent-session.js'), 'utf8')
  ok(/runner\.emitToolCall\(\{[\s\S]{0,600}?input: args,/s.test(sessionSource), 'agent-session 把工具入参交给 tool_call 处理器（input 就是我们检查的那份）')
  const runnerSource = fs.readFileSync(path.join(pi.packageDir, 'dist', 'core', 'extensions', 'runner.js'), 'utf8')
  ok(/if \(result\.block\) \{\s*return result;/s.test(runnerSource), 'runner 遇 block 立即返回（后续处理器不再执行）')
}

/* ───────────────────────── ④ pi 的加载器能认 ───────────────────────── */

section('7. pi 的扩展加载器：装进 agentDir 后零错误')
{
  const installer = await import(pathToFileURL(path.join(root, 'tools', 'install-pi-extension.mjs')).href)
  const agentDir = path.join(tmp, 'agent')
  installer.install({ dir: path.join(agentDir, 'extensions') })
  const loaderEntry = path.join(pi.packageDir, 'dist', 'core', 'extensions', 'loader.js')
  if (fs.existsSync(loaderEntry)) {
    const loader = await import(pathToFileURL(loaderEntry).href)
    const result = await loader.discoverAndLoadExtensions([], root, agentDir, undefined, loader.createExtensionRuntime())
    eq((result.errors ?? []).length, 0, '整个 agentDir 加载零错误')
    const found = (result.extensions ?? []).find(item => String(item.path).includes('superpi-text-integrity.ts'))
    ok(Boolean(found), 'pi 的加载器发现了写入闸')
    eq(found?.error ?? null, null, 'pi 加载写入闸无错误（含 ./superpi-text-bytes.mjs 的解析）')
  } else {
    ok(false, '没有 core/extensions/loader.js —— 无法验证"装完 pi 真的能认"')
  }
}

/* ───────────────────────── ⑤ 不降级 ───────────────────────── */

section('8. 不降级：干净会话零痕迹')
{
  const fake = makeFakePi()
  entry(fake)
  const onToolCall = fake.handlers.get('tool_call')[0]
  const onToolResult = fake.handlers.get('tool_result')[0]
  const before = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : ''
  for (const toolName of ['write', 'edit', 'bash', 'read', 'grep']) {
    eq(await onToolCall({ type: 'tool_call', toolName, toolCallId: 'k-' + toolName, input: { path: 'a.md', content: 'ok', command: 'echo ok', edits: [{ oldText: 'a', newText: 'b' }] } }), undefined,
      '干净 ' + toolName + ' 调用零拦截')
    eq(await onToolResult({ type: 'tool_result', toolName, toolCallId: 'k-' + toolName, content: [{ type: 'text', text: 'ok' }] }), undefined,
      '干净 ' + toolName + ' 结果零追加')
  }
  const after = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : ''
  eq(after, before, '干净会话不写日志（不引入噪音）')
}

process.env.SUPERPI_INTEGRITY = ''
fs.rmSync(tmp, { recursive: true, force: true })

console.log('')
if (failures.length === 0) {
  console.log('PASS (' + checks + ' checks)')
  process.exit(0)
}
console.error('FAIL (' + (checks - failures.length) + ' passed, ' + failures.length + ' failed)')
for (const failure of failures) console.error('  - ' + failure)
process.exit(1)

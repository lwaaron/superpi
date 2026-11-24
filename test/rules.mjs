#!/usr/bin/env node
/**
 * 用户自定义规则（最高优先级）的门禁。
 *
 * 三层都要测，缺一层就有一种「看起来做了、其实没生效」的失败模式：
 *   ① 纯函数 —— 归一 / 校验 / 渲染 / 落盘（`extensions/superpi-rules.mjs`）；
 *   ② HTTP 面 —— `GET/POST /rules` 与 `POST /rules/reset` 真的打到同一个文件；
 *   ③ **真扩展** —— 用 jiti 加载 `extensions/superpi-rules.ts`，喂假 `pi` 与假 `ctx.ui`，
 *      证明 `before_agent_start` 真的把规则放进了 systemPromptOptions.sections，
 *      并且 `/superpi-rules` 命令读写的是**面板那一份文件**。
 *
 * 第 ③ 层是重点：只测 ①② 的话，「面板保存了、pi 却读不到」这类断链完全测不出来。
 *
 * 跑法：node test/rules.mjs
 * 需要 pi 运行时（jiti 从它那儿借）。**缺了直接失败，不 SKIP**（0.16.1 起）：
 * 扩展层是本门禁的被测对象，跳过等于「规则有没有真进系统提示」完全未验证。
 */

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolvePiRuntime } from '../src/pi-runtime.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)

let checks = 0
let failed = 0
function ok(condition, message) {
  checks += 1
  if (condition) return
  failed += 1
  console.error('FAIL: ' + message)
}
function eq(actual, expected, message) {
  // 数组/对象按 JSON 比较：直接 === 比的是引用，会得到「[] !== []」这种假红。
  const same = actual !== null && expected !== null && typeof actual === 'object' && typeof expected === 'object'
    ? JSON.stringify(actual) === JSON.stringify(expected)
    : actual === expected
  ok(same, `${message} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`)
}
function section(title) {
  console.log('')
  console.log('── ' + title)
}

const mod = await import(pathToFileURL(path.join(root, 'extensions', 'superpi-rules.mjs')).href)
const {
  DEFAULT_RULES_TEXT,
  MAX_RULES_TEXT,
  OVERRIDE_PREFIX,
  RULES_COMMAND,
  RULES_ENV,
  RULES_SECTION_NAME,
  RULES_VERSION,
  checksumOf,
  clearRulesCache,
  createRulesStore,
  emptyRulesState,
  isRulesEmptyText,
  normalizeRules,
  normalizeRulesText,
  rankOf,
  readRulesTextSync,
  renderRulesBlock,
  resolveRulesPath,
  rulesView,
  validateRulesInput,
} = mod

/* ══════════════════════════════════════════════════════════ A. 归一 */

section('A. 归一 normalizeRulesText（必须幂等）')

eq(normalizeRulesText('a\r\nb\rc'), 'a\nb\nc', 'CRLF / CR 统一成 LF')
eq(normalizeRulesText('\uFEFF规则'), '规则', '去掉 BOM')
eq(normalizeRulesText('a   \nb\t\n'), 'a\nb', '去行尾空白（含 tab）')
eq(normalizeRulesText('a\u3000\nb'), 'a\nb', '去掉行尾全角空格')
eq(normalizeRulesText('a\n\n\n\nb'), 'a\n\nb', '连续 3+ 空行压成一个空行')
eq(normalizeRulesText('a\n\nb'), 'a\n\nb', '两个换行（一个空行）原样保留')
eq(normalizeRulesText('\n\n  x  \n\n'), 'x', '首尾 trim')
eq(normalizeRulesText(null), '', 'null → 空串')
eq(normalizeRulesText(undefined), '', 'undefined → 空串')
eq(normalizeRulesText(42), '', '数字 → 空串')
eq(normalizeRulesText({}), '', '对象 → 空串')

// 幂等性：对真实样本逐个断言，否则「每次保存 checksum 都变」会让 UI 永远显示已修改。
const idempotentSamples = [
  DEFAULT_RULES_TEXT,
  '',
  'x',
  '\uFEFFa\r\n\r\n\r\nb   ',
  '# 注释\n\n\n\n内容\n',
  '中文\u3000\n第二行\t',
]
let idempotentFailures = 0
for (const sample of idempotentSamples) {
  const once = normalizeRulesText(sample)
  const twice = normalizeRulesText(once)
  if (once !== twice) {
    idempotentFailures += 1
    console.error('  非幂等样本：' + JSON.stringify(sample.slice(0, 40)) + ' → ' + JSON.stringify(once.slice(0, 40)) + ' → ' + JSON.stringify(twice.slice(0, 40)))
  }
}
eq(idempotentFailures, 0, '归一必须幂等（' + String(idempotentSamples.length) + ' 个真实样本）')

/* ══════════════════════════════════════════════════════ B. 默认文案 */

section('B. 默认文案（用户原文，一条都不能少）')

eq(normalizeRulesText(DEFAULT_RULES_TEXT), DEFAULT_RULES_TEXT, '默认文案本身已归一')
eq(isRulesEmptyText(DEFAULT_RULES_TEXT), false, '默认文案非空')
eq(rankOf(DEFAULT_RULES_TEXT), 1, '默认文案 rank = 1')

// 用户 2026-11 给的原文要点，逐条用关键词断言 —— 少一条就是丢了用户的工作方式。
const KEYWORDS = [
  ['简体中文', '思考过程与总结用简体中文'],
  ['50%', '上下文 50% 阈值'],
  ['第一性原理', '第一性原理'],
  ['禁止打补丁', '禁止打补丁'],
  ['禁止降级方案', '禁止降级方案'],
  ['UI设计师', 'UI 设计师走查'],
  ['架构师', '架构师思维'],
  ['测试专家', '测试专家思维'],
  ['Saas', 'SaaS 架构最佳实践'],
  ['按行修改', '按行修改'],
  ['全量全维度测试用例', '先写测试用例'],
  ['禁止利用目标维度指标的漏洞', '禁止刷指标'],
  ['did', '数据库 did 字段'],
  ['业务编号', '业务编号'],
  ['本地github', '提交到本地 github'],
  ['git revert', 'git revert 而非 reset --hard'],
  ['任务清单', '任务清单组件'],
  ['初始化状态', '初始化状态完美显示'],
  ['mock数据', 'mock 数据跑通流程'],
  ['浏览器扩展', '浏览器扩展控制'],
  ['清理或关闭', '清理浏览器标签页'],
]
let missingKeywords = []
for (const [needle, label] of KEYWORDS) {
  if (DEFAULT_RULES_TEXT.includes(needle) !== true) missingKeywords.push(label)
}
eq(missingKeywords, [], '默认文案覆盖用户给的 21 条要点（缺：' + missingKeywords.join(' / ') + '）')
ok(DEFAULT_RULES_TEXT.length < MAX_RULES_TEXT, '默认文案在长度上限内')

/* ═════════════════════════════════════════════════ C. 校验 / 视图 / 渲染 */

section('C. 校验 / 视图 / 渲染')

const asDefault = normalizeRules(null)
eq(asDefault.source, 'default', 'normalizeRules(null).source = default')
eq(asDefault.text, DEFAULT_RULES_TEXT, 'normalizeRules(null).text = 默认文案')
eq(asDefault.version, RULES_VERSION, 'version 恒为 RULES_VERSION')
ok(typeof asDefault.checksum === 'string' && asDefault.checksum.length === 64, 'checksum 是 64 位十六进制')

const trimmed = normalizeRules({ text: '  第一行  \r\n\r\n\r\n第二行  ', checksum: 'deadbeef' })
eq(trimmed.text, '第一行\n\n第二行', 'normalizeRules 归一 text（CRLF + 行尾空白 + 压缩空行）')
eq(trimmed.source, 'file', '有合法 text → source = file')
eq(trimmed.drift, true, '文件里的 checksum 对不上 → drift = true（外部手改要能发现）')
eq(trimmed.checksum, checksumOf(trimmed.text), 'drift 时 checksum 用实际文本重算')

const matchingChecksum = normalizeRules({ text: 'abc', checksum: checksumOf('abc') })
eq(matchingChecksum.drift, false, 'checksum 对得上时 drift = false')

const tooLong = normalizeRules({ text: 'x'.repeat(MAX_RULES_TEXT + 1) })
eq(tooLong.source, 'default', '超长文本回落默认（不截断，避免静默丢用户内容）')
eq(tooLong.text, DEFAULT_RULES_TEXT, '超长回落的文本是默认文案')

const prototypePollution = normalizeRules({ text: 'ok', __proto__: { polluted: true }, junk: 'v' })
eq(Object.prototype.hasOwnProperty.call(prototypePollution, 'junk'), false, '未知键不进视图')
eq(Object.keys(prototypePollution).sort().join(','), 'checksum,createdAt,drift,source,text,updatedAt,version', '视图字段白名单（不多不少）')

eq(checksumOf('a'), checksumOf('a'), 'checksum 对同一文本稳定')
ok(checksumOf('a') !== checksumOf('b'), 'checksum 对不同文本不同')
eq(checksumOf('  a  '), checksumOf('a'), 'checksum 按归一后的文本算')

eq(rankOf(''), 0, 'rankOf("") = 0')
eq(rankOf('   \n\n '), 0, 'rankOf(空白) = 0')
eq(rankOf('# 只有注释'), 0, 'rankOf(只有注释) = 0')
eq(rankOf('# 注释\n真内容'), 1, 'rankOf(注释 + 内容) = 1')
eq(isRulesEmptyText(''), true, 'isRulesEmptyText("") = true')
eq(isRulesEmptyText('x'), false, 'isRulesEmptyText("x") = false')

// 写入校验：长度按归一后算（用户粘贴 21000 字符、其中一堆空行时不该被判超限）。
eq(validateRulesInput('  ok  '), 'ok', 'validateRulesInput 返回归一后的文本')
let rejected = null
try { validateRulesInput(42) } catch (error) { rejected = error }
eq(rejected?.statusCode, 400, 'validateRulesInput(非字符串) → 400')
rejected = null
try { validateRulesInput('x'.repeat(MAX_RULES_TEXT + 1)) } catch (error) { rejected = error }
eq(rejected?.statusCode, 400, 'validateRulesInput(超长) → 400')
eq(validateRulesInput('x'.repeat(MAX_RULES_TEXT)).length, MAX_RULES_TEXT, '恰好等于上限允许通过')
// 21000 字符里有 2000 个空行 → 归一后只有 19000，必须能存。
const padded = 'x'.repeat(19000) + '\n'.repeat(2001)
ok(normalizeRulesText(padded).length === 19000, '空行不计入长度（按归一后判断）')
eq(validateRulesInput(padded).length, 19000, '归一后未超限 → 允许保存')

// 渲染：空 = 空串（零痕迹），非空 = 覆盖声明 + 显式标签 + 原文一字不改。
eq(renderRulesBlock(''), '', '空规则渲染成空串（不追加任何东西）')
eq(renderRulesBlock('   \n\n# 注释'), '', '只有注释也算空 → 空串')
const block = renderRulesBlock('第一条\n第二条')
ok(block.startsWith(OVERRIDE_PREFIX), '规则块以「最高优先级」覆盖声明开头')
ok(block.includes('第一条\n第二条'), '块内原文逐字保留')
// 自己不再包标签：pi 组装 section 时会把每个 section 包成 <名字>…</名字>，
// 再包一层就是同名嵌套两次（实测抓到的缺陷，见 renderRulesBlock 的注释）。
eq(block.includes('<user_defined_rules>'), false, '渲染器不自带 section 标签（避免与 pi 的包裹重复）')
eq(renderRulesBlock('第一条\n第二条'), block, '渲染幂等')
ok(block.indexOf(OVERRIDE_PREFIX) === 0, '覆盖声明在块首（不在中间被原文淹掉）')

// 视图：isDefault 与 empty 是两件事，混一起 UI 就无法区分「默认」与「关掉」。
const viewDefault = rulesView(emptyRulesState({ now: '2026-01-01T00:00:00.000Z' }), { filePath: 'C:/x/rules.json', extensionInstalled: true })
eq(viewDefault.isDefault, true, '默认文案 → isDefault = true')
eq(viewDefault.empty, false, '默认文案 → empty = false')
eq(viewDefault.rank, 1, '默认文案 → rank = 1')
eq(viewDefault.maxLength, MAX_RULES_TEXT, '视图带 maxLength')
eq(viewDefault.filePath, 'C:/x/rules.json', '视图带真实落盘路径')
eq(viewDefault.delivery.command, '/' + RULES_COMMAND, '视图带命令行编辑入口')
eq(viewDefault.delivery.extensionInstalled, true, '视图带命令行是否已装')
eq(viewDefault.ok, true, '视图 ok = true')

const viewEmpty = rulesView({ ...emptyRulesState(), text: '', checksum: checksumOf('') })
eq(viewEmpty.empty, true, '空文本 → empty = true')
eq(viewEmpty.isDefault, false, '空文本 → isDefault = false（空 ≠ 默认）')
eq(viewEmpty.rank, 0, '空文本 → rank = 0')

const viewCustom = rulesView({ ...emptyRulesState(), text: '自定义' })
eq(viewCustom.isDefault, false, '自定义 → isDefault = false')
eq(viewCustom.empty, false, '自定义 → empty = false')

/* ═══════════════════════════════════════════════════════ D. store */

section('D. store（真文件，临时目录）')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'superpi-rules-'))
const storeFile = path.join(tmp, 'nested', 'rules.json')
const store = createRulesStore({ filePath: storeFile })

const firstRead = await store.read()
eq(firstRead.state.text, DEFAULT_RULES_TEXT, '文件不存在 → 读到默认文案')
eq(firstRead.state.source, 'default', '文件不存在 → source = default')
eq(firstRead.warning, '', '文件不存在不算告警')
ok(fs.existsSync(storeFile) === false, '读不写盘（文件仍然不存在）')
eq(firstRead.filePath, storeFile, 'read() 回真实路径')

const written = await store.write('  我的第一条  \n\n\n我的第二条  ')
eq(written.state.text, '我的第一条\n\n我的第二条', 'write 归一后落盘')
ok(fs.existsSync(storeFile), 'write 真的创建了文件')
const onDisk = JSON.parse(fs.readFileSync(storeFile, 'utf8'))
eq(onDisk.version, RULES_VERSION, '落盘带 version')
eq(onDisk.text, '我的第一条\n\n我的第二条', '落盘 text 与返回一致')
eq(onDisk.checksum, checksumOf(onDisk.text), '落盘 checksum 由 store 自己算')
ok(typeof onDisk.createdAt === 'string' && typeof onDisk.updatedAt === 'string', '落盘带 createdAt / updatedAt')
eq(Object.keys(onDisk).sort().join(','), 'checksum,createdAt,text,updatedAt,version', '落盘字段白名单')

const created = onDisk.createdAt
await new Promise(done => setTimeout(done, 12))
const second = await store.write('改成这样')
eq(second.state.createdAt, created, '二次写入：createdAt 不变')
ok(second.state.updatedAt !== created, '二次写入：updatedAt 刷新')
eq(second.state.checksum, checksumOf('改成这样'), '二次写入：checksum 跟随文本')

// 幂等写：相同文本不许刷新 updatedAt（否则「最后修改于」会撒谎）。
const before = second.state.updatedAt
await new Promise(done => setTimeout(done, 12))
const same = await store.write('改成这样')
eq(same.state.updatedAt, before, '相同文本重复写：updatedAt 不刷新（幂等）')

const reset = await store.reset()
eq(reset.state.text, DEFAULT_RULES_TEXT, 'reset() 写回默认文案')
eq(JSON.parse(fs.readFileSync(storeFile, 'utf8')).text, DEFAULT_RULES_TEXT, 'reset() 真的落到磁盘')

// 坏文件：不抛、回落默认、带告警。
fs.writeFileSync(storeFile, '{ 这不是 JSON', 'utf8')
const broken = await store.read()
eq(broken.state.text, DEFAULT_RULES_TEXT, '坏 JSON → 回落默认文案')
ok(broken.warning !== '', '坏 JSON → 带告警（面板要能提示）')

// 结构合法但缺 text（用户手改掉了）：同样算坏文件。
fs.writeFileSync(storeFile, JSON.stringify({ version: 1, checksum: 'x' }), 'utf8')
const noText = await store.read()
eq(noText.state.text, DEFAULT_RULES_TEXT, '缺 text → 回落默认')
ok(noText.warning !== '', '缺 text → 带告警')

// 写入校验：以 rejected promise 出现（对外契约永远是 Promise）。
let writeRejected = null
try { await store.write(42) } catch (error) { writeRejected = error }
eq(writeRejected?.statusCode, 400, 'write(非字符串) → 400 rejected promise')
writeRejected = null
try { await store.write('x'.repeat(MAX_RULES_TEXT + 1)) } catch (error) { writeRejected = error }
eq(writeRejected?.statusCode, 400, 'write(超长) → 400 rejected promise')

// 并发：串行队列保证不丢更新、不互相截断、不残留 tmp。
await Promise.all([store.write('并发 A'), store.write('并发 B'), store.write('并发 C')])
const afterConcurrent = JSON.parse(fs.readFileSync(storeFile, 'utf8'))
ok(['并发 A', '并发 B', '并发 C'].includes(afterConcurrent.text), '并发写之后文件是合法的完整 JSON（不互相截断）')
eq(afterConcurrent.checksum, checksumOf(afterConcurrent.text), '并发写之后 checksum 与文本一致')
eq(fs.readdirSync(path.dirname(storeFile)).filter(name => name.includes('.tmp-')), [], '不残留 *.tmp-* 临时文件')

// 一次 400 不许把后面的写请求一起卡死（队列自身必须永远已兑现）。
await store.write('恢复').catch(() => {})
const revived = await store.write('还能写')
eq(revived.state.text, '还能写', '400 之后队列仍可用')

/* ═══════════════════════════════════════════════ G. 扩展（真 .ts） */

section('G. 扩展：before_agent_start 与 /superpi-rules（真 .ts）')

const pi = resolvePiRuntime({ pluginRoot: root })
let extensionModule = null
if (!pi.cliPath || !pi.packageDir) {
  /**
   * 这里曾经是 `skippedExtension = true` 然后继续跑（0.16.1 修）。
   *
   * 为什么必须失败：扩展层是本门禁的**被测对象**（superpi-rules.ts 把规则送进系统提示）。
   * 缺 pi 时整段跳过，等于「规则能否真正生效」完全未验证，而 `npm test` 是绿的。
   * 而 `.runtime/` 是 gitignore 的 —— 新机器 clone 下来必然走到这条分支。
   */
  console.error('')
  console.error('FAIL[preflight] pi 运行时不可用 —— 扩展层（superpi-rules.ts）无法加载')
  console.error('  这一层是本门禁的被测对象，不能跳过。修法：npm run test:runtime')
  console.error('')
  process.exit(1)
} else {
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
    console.error('')
    console.error('FAIL[preflight] 找不到 jiti —— 扩展层（superpi-rules.ts）无法加载')
    console.error('  修法：重装 pi 运行时（npm run test:runtime）')
    console.error('')
    process.exit(1)
  } else {
    const { createJiti } = await import(pathToFileURL(jitiPath).href)
    const extensionFile = path.join(root, 'extensions', 'superpi-rules.ts')
    const jiti = createJiti(extensionFile, {
      interopDefault: true,
      moduleCache: false,
      alias: {
        '@earendil-works/pi-coding-agent': path.join(pi.packageDir, 'dist', 'index.js'),
        '@earendil-works/pi-tui': path.join(pi.packageDir, '..', 'pi-tui', 'dist', 'index.js'),
      },
    })
    extensionModule = await jiti.import(extensionFile)
  }
}

if (extensionModule !== null) {
  const entry = extensionModule.default
  eq(typeof entry, 'function', '扩展默认导出是函数（pi 加载用）')
  eq(typeof extensionModule.applyRulesToOptions, 'function', '导出 applyRulesToOptions（纯函数，便于单测）')
  eq(typeof extensionModule.describeRules, 'function', '导出 describeRules')
  eq(typeof extensionModule.firstMeaningfulLine, 'function', '导出 firstMeaningfulLine')

  // 规则路径由环境变量指到临时文件：扩展读的必须是这个（= 面板写的那一个）。
  const extRulesFile = path.join(tmp, 'ext', 'rules.json')
  process.env[RULES_ENV] = extRulesFile
  clearRulesCache()
  eq(resolveRulesPath(), extRulesFile, '扩展开关：SUPERPI_RULES 生效')

  /** 假 pi：只实现扩展真正用到的两个方法。 */
  function makeFakePi() {
    const handlers = new Map()
    const commands = new Map()
    return {
      on(type, handler) {
        if (!handlers.has(type)) handlers.set(type, [])
        handlers.get(type).push(handler)
      },
      registerCommand(name, options) {
        commands.set(name, options)
      },
      handlers,
      commands,
      async fire(type, event, ctx) {
        const list = handlers.get(type) ?? []
        let result
        for (const handler of list) result = await handler(event, ctx)
        return result
      },
    }
  }

  // ① 加载不抛，注册了事件与命令
  const fakePi = makeFakePi()
  entry(fakePi)
  eq([...fakePi.handlers.keys()].join(','), 'before_agent_start', '注册了 before_agent_start')
  eq([...fakePi.commands.keys()].join(','), RULES_COMMAND, '注册了 /' + RULES_COMMAND)

  // ② 有规则时：sections 里出现规则块
  const store2 = createRulesStore({ filePath: extRulesFile })
  await store2.write('只回一句话\n第二条规则')
  clearRulesCache()
  const event1 = { systemPromptOptions: { sections: {}, selectedTools: ['read'] }, systemPrompt: 'BASE' }
  const result1 = await fakePi.fire('before_agent_start', event1, {})
  const injected = event1.systemPromptOptions.sections[RULES_SECTION_NAME]
  ok(typeof injected === 'string' && injected.includes('只回一句话'), '规则块进了 systemPromptOptions.sections')
  ok(injected.startsWith(OVERRIDE_PREFIX), '注入的块带「最高优先级」覆盖声明')
  eq(result1 === undefined || (typeof result1 === 'object' && result1.systemPrompt === undefined), true, '返回值不带 systemPrompt（走 section 补丁，避免每轮整份重放导致缓存 miss）')

  // 位置：pi 组装 section 时自定义 section 排在最后 → 这段就是整份提示的末尾。
  eq(Object.keys(event1.systemPromptOptions.sections).length, 1, '只加一个 section，不污染别的段')

  // ③ 规则为空时：不注入任何东西（零痕迹）
  await store2.write('')
  clearRulesCache()
  const event2 = { systemPromptOptions: { sections: {} }, systemPrompt: 'BASE' }
  await fakePi.fire('before_agent_start', event2, {})
  eq(Object.keys(event2.systemPromptOptions.sections).length, 0, '空规则 → 不加任何 section')

  // ④ 改文本后下一轮拿到新文本（mtime 缓存必须失效）
  await store2.write('第一版')
  clearRulesCache()
  const event3 = { systemPromptOptions: { sections: {} } }
  await fakePi.fire('before_agent_start', event3, {})
  ok(event3.systemPromptOptions.sections[RULES_SECTION_NAME].includes('第一版'), '第一版生效')
  await new Promise(done => setTimeout(done, 25))
  await store2.write('第二版')
  const event4 = { systemPromptOptions: { sections: {} } }
  await fakePi.fire('before_agent_start', event4, {})
  ok(event4.systemPromptOptions.sections[RULES_SECTION_NAME].includes('第二版'), '保存后下一轮立刻拿到新文本（不需要重启会话）')

  // ⑤ 坏文件不许把异常抛给 pi
  fs.writeFileSync(extRulesFile, '{ 坏掉', 'utf8')
  clearRulesCache()
  const event5 = { systemPromptOptions: { sections: {} } }
  let thrown = null
  try { await fakePi.fire('before_agent_start', event5, {}) } catch (error) { thrown = error }
  eq(thrown, null, '坏文件时 before_agent_start 不抛')
  ok(event5.systemPromptOptions.sections[RULES_SECTION_NAME].includes('User-defined rules'), '坏文件时仍用默认文案（规则不会消失）')

  // ⑥ 读盘抛异常（把路径指向一个目录）也不许外抛
  const dirAsFile = path.join(tmp, 'dir-as-file')
  fs.mkdirSync(dirAsFile, { recursive: true })
  process.env[RULES_ENV] = dirAsFile
  clearRulesCache()
  const event6 = { systemPromptOptions: { sections: {} } }
  thrown = null
  try { await fakePi.fire('before_agent_start', event6, {}) } catch (error) { thrown = error }
  eq(thrown, null, '读盘异常时 before_agent_start 不抛')
  ok(String(event6.systemPromptOptions.sections[RULES_SECTION_NAME] ?? '').includes('User-defined rules'), '读盘异常时回落默认文案')

  // ⑦ 事件里没有 systemPromptOptions 时静默跳过
  thrown = null
  try { await fakePi.fire('before_agent_start', {}, {}) } catch (error) { thrown = error }
  eq(thrown, null, '没有 systemPromptOptions 时静默跳过')

  /* ── 命令：编辑 / 只看 / 恢复默认 / 无 UI ─────────────────────────── */

  process.env[RULES_ENV] = extRulesFile
  clearRulesCache()
  await createRulesStore({ filePath: extRulesFile }).write('命令编辑前')

  /** 假 ctx.ui：记录调用、按脚本应答。 */
  function makeUiContext(answers) {
    const calls = []
    const notifications = []
    return {
      calls,
      notifications,
      ctx: {
        ui: {
          async select(title, options) {
            calls.push({ method: 'select', title, options })
            return answers.select === undefined ? '关闭' : answers.select
          },
          async editor(title, prefill) {
            calls.push({ method: 'editor', title, prefill })
            return answers.editor
          },
          async confirm(title, message) {
            calls.push({ method: 'confirm', title, message })
            return answers.confirm === true
          },
          notify(text, level) {
            notifications.push({ text, level })
          },
        },
      },
    }
  }

  const command = fakePi.commands.get(RULES_COMMAND)
  eq(typeof command?.handler, 'function', '命令有 handler')
  ok(typeof command.description === 'string' && command.description.includes('最高优先级'), '命令描述点明「最高优先级」')

  // 编辑 → 写到**同一个文件**
  const editorValue = '从命令行改的规则\n第二条'
  const uiEdit = makeUiContext({ select: '编辑规则', editor: editorValue })
  await command.handler('', uiEdit.ctx)
  eq(uiEdit.calls[0].method, 'select', '先弹 select（看摘要 + 选项）')
  ok(uiEdit.calls[0].title.includes('最高优先级'), 'select 标题说明这是最高优先级规则')
  eq(uiEdit.calls[1].method, 'editor', '选「编辑规则」→ 走 ctx.ui.editor')
  eq(uiEdit.calls[1].prefill, '命令编辑前', 'editor 预填当前文本')
  const afterEdit = JSON.parse(fs.readFileSync(extRulesFile, 'utf8'))
  eq(afterEdit.text, editorValue, '命令行编辑写到同一个 rules.json')
  ok(uiEdit.notifications.length === 1 && uiEdit.notifications[0].level === 'info', '保存成功给 info 通知')
  // 反过来：面板侧读同一个文件，看到的就是命令行刚写的内容。
  const panelRead = await createRulesStore({ filePath: extRulesFile }).read()
  eq(panelRead.state.text, editorValue, '面板读到的就是命令行刚写的（同一个真相源）')

  // 只看全文
  const uiShow = makeUiContext({ select: '只显示当前全文' })
  await command.handler('', uiShow.ctx)
  eq(uiShow.calls.length, 1, '「只显示」不再弹第二个对话框')
  ok(uiShow.notifications[0].text.includes(editorValue.split('\n')[0]), '「只显示」把全文输出到通知里')

  // 恢复默认（要确认）
  const uiReset = makeUiContext({ select: '恢复默认文案', confirm: true })
  await command.handler('', uiReset.ctx)
  eq(uiReset.calls[1].method, 'confirm', '恢复默认前要二次确认')
  const afterReset = JSON.parse(fs.readFileSync(extRulesFile, 'utf8'))
  eq(afterReset.text, DEFAULT_RULES_TEXT, '确认后写回默认文案')

  // 恢复默认但取消 → 文本不动
  const beforeCancel = JSON.parse(fs.readFileSync(extRulesFile, 'utf8')).text
  const uiCancel = makeUiContext({ select: '恢复默认文案', confirm: false })
  await command.handler('', uiCancel.ctx)
  eq(JSON.parse(fs.readFileSync(extRulesFile, 'utf8')).text, beforeCancel, '取消恢复默认时文本不变')

  // 选择「关闭」
  const uiClose = makeUiContext({ select: '关闭' })
  await command.handler('', uiClose.ctx)
  eq(uiClose.calls.length, 1, '「关闭」只弹一次 select')
  eq(uiClose.notifications.length, 0, '「关闭」不发通知')

  // 超长输入：不写盘、给 error
  const storeLong = createRulesStore({ filePath: extRulesFile })
  await storeLong.write('短文本')
  const uiLong = makeUiContext({ select: '编辑规则', editor: 'x'.repeat(MAX_RULES_TEXT + 5) })
  await command.handler('', uiLong.ctx)
  eq(JSON.parse(fs.readFileSync(extRulesFile, 'utf8')).text, '短文本', '超长输入不写盘')
  ok(uiLong.notifications.some(item => item.level === 'error'), '超长输入给 error 通知')

  // 没有交互 UI（print / json 模式）：不抛、明确给出文件路径
  const uiNone = { notifications: [] }
  const ctxNone = { ui: { notify(text, level) { uiNone.notifications.push({ text, level }) } } }
  thrown = null
  try { await command.handler('', ctxNone) } catch (error) { thrown = error }
  eq(thrown, null, '无交互 UI 时不抛')
  ok(uiNone.notifications.some(item => item.text.includes('rules.json')), '无交互 UI 时告知规则文件路径')

  // 连 notify 都没有（极端情况）：仍不许抛
  thrown = null
  try { await command.handler('', { ui: {} }) } catch (error) { thrown = error }
  eq(thrown, null, 'ctx.ui 什么都没有时不抛')
  thrown = null
  try { await command.handler('', {}) } catch (error) { thrown = error }
  eq(thrown, null, '连 ctx 都没有时不抛')

  // describeRules / firstMeaningfulLine
  eq(extensionModule.firstMeaningfulLine('# 注释\n\n真正的内容  再来'), '真正的内容  再来', 'firstMeaningfulLine 跳过注释与空行')
  ok(extensionModule.firstMeaningfulLine('x'.repeat(200)).endsWith('…'), 'firstMeaningfulLine 超长截断加省略号')
  eq(extensionModule.firstMeaningfulLine(''), '', 'firstMeaningfulLine 空串 → 空串')
  ok(extensionModule.describeRules('').includes('不会追加'), 'describeRules 对空规则明说「不会追加」')
  ok(extensionModule.describeRules('a\nb').includes('2 行'), 'describeRules 报告行数')
}

/* ══════════════════════════════════════════════════ F. HTTP 面 */

section('F. HTTP 面（createHandler + 真 http server）')

const plugin = await import(pathToFileURL(path.join(root, 'index.js')).href)

const httpFile = path.join(tmp, 'http', 'rules.json')
const httpStore = createRulesStore({ filePath: httpFile })

function makeCtx() {
  let registered = null
  const server = { register(route) { registered = route; return () => { registered = null } } }
  return {
    ctx: {
      effect(fn) { const dispose = typeof fn === 'function' ? fn() : undefined; return () => { if (typeof dispose === 'function') dispose() } },
      inject(names, run) {
        const services = {}
        for (const name of names) services[name] = name === 'webServer' ? server : undefined
        run(services)
      },
      get(name) {
        if (name === 'logger') return { info() {}, warn() {}, error() {}, debug() {} }
        throw new Error('service not available: ' + name)
      },
    },
    route: () => registered,
  }
}

// 走真 apply()（而不是直接调 createHandler）：顺便验证 apply 里接线了 rulesStore。
// 环境变量把落盘指到临时文件，绝不碰用户的真实 ~/.superpi/rules.json。
process.env[RULES_ENV] = httpFile
const made = makeCtx()
plugin.apply(made.ctx, { args: ['--no-session'] })
const registered = made.route()
ok(registered !== null, 'apply() 注册了路由')
eq(registered?.path, '/api/superpi', '路由前缀 /api/superpi')

const server = http.createServer((req, res) => { void registered.handler(req, res) })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + String(server.address().port) + '/api/superpi'

function request(routePath, { method = 'GET', body, contentType = 'application/json' } = {}) {
  const target = new URL(base + routePath)
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method,
      headers: payload === null ? {} : { 'content-type': contentType, 'content-length': payload.length },
    }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed = text
        try { parsed = JSON.parse(text) } catch { /* 原样返回 */ }
        resolve({ status: res.statusCode, body: parsed })
      })
    })
    req.on('error', reject)
    if (payload !== null) req.write(payload)
    req.end()
  })
}

try {
  const fresh = await request('/rules')
  eq(fresh.status, 200, 'GET /rules → 200')
  eq(fresh.body.text, DEFAULT_RULES_TEXT, 'GET /rules 文件不存在时回默认文案')
  eq(fresh.body.isDefault, true, 'GET /rules → isDefault = true')
  eq(fresh.body.empty, false, 'GET /rules → empty = false')
  eq(fresh.body.rank, 1, 'GET /rules → rank = 1')
  eq(fresh.body.maxLength, MAX_RULES_TEXT, 'GET /rules 回 maxLength')
  eq(fresh.body.delivery.command, '/' + RULES_COMMAND, 'GET /rules 回命令行入口')
  eq(fresh.body.filePath, httpFile, 'GET /rules 回真实落盘路径')
  eq(fs.existsSync(httpFile), false, 'GET 不写盘')

  const saved = await request('/rules', { method: 'POST', body: { text: '  接口写的规则\n\n\n第二行 ' } })
  eq(saved.status, 200, 'POST /rules → 200')
  eq(saved.body.text, '接口写的规则\n\n第二行', 'POST /rules 归一后返回')
  eq(saved.body.isDefault, false, 'POST /rules → isDefault = false')
  const onDiskHttp = JSON.parse(fs.readFileSync(httpFile, 'utf8'))
  eq(onDiskHttp.text, '接口写的规则\n\n第二行', 'POST /rules 真的落盘')
  eq(onDiskHttp.checksum, checksumOf(onDiskHttp.text), '落盘 checksum 正确')

  const reread = await request('/rules')
  eq(reread.body.text, '接口写的规则\n\n第二行', 'GET 能读到刚写的（同一份落盘）')
  eq(reread.body.filePath, httpFile, 'GET 路径与 POST 一致')

  eq((await request('/rules', { method: 'POST', body: { text: 42 } })).status, 400, 'POST /rules text 非字符串 → 400')
  eq((await request('/rules', { method: 'POST', body: {} })).status, 400, 'POST /rules 缺 text → 400')
  eq((await request('/rules', { method: 'POST', body: { text: 'x'.repeat(MAX_RULES_TEXT + 1) } })).status, 400, 'POST /rules 超长 → 400')
  eq((await request('/rules', { method: 'POST', body: { text: 'x' }, contentType: 'text/plain' })).status, 415, 'POST /rules 非 JSON content-type → 415')

  const cleared = await request('/rules', { method: 'POST', body: { text: '' } })
  eq(cleared.body.empty, true, 'POST /rules 空文本 → empty = true（= 不追加任何内容）')
  eq(cleared.body.rank, 0, '空文本 → rank = 0')

  const restored = await request('/rules/reset', { method: 'POST', body: {} })
  eq(restored.status, 200, 'POST /rules/reset → 200')
  eq(restored.body.text, DEFAULT_RULES_TEXT, 'reset 写回默认文案')
  eq(restored.body.isDefault, true, 'reset 后 isDefault = true')

  // 外部手改文本、不更新 checksum → drift 必须被读出来
  fs.writeFileSync(httpFile, JSON.stringify({ version: 1, text: '外部手改', checksum: 'stale', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }), 'utf8')
  const drift = await request('/rules')
  eq(drift.body.drift, true, '外部手改（checksum 对不上）→ drift = true')

  // 坏文件：仍 200，带 warning，回落默认
  fs.writeFileSync(httpFile, '{坏的', 'utf8')
  const corrupt = await request('/rules')
  eq(corrupt.status, 200, '坏文件时 GET /rules 仍 200')
  eq(corrupt.body.text, DEFAULT_RULES_TEXT, '坏文件 → 回默认文案')
  ok(typeof corrupt.body.warning === 'string' && corrupt.body.warning !== '', '坏文件 → 带 warning')

  // 修一次就正常（保存能修好它）
  const repaired = await request('/rules', { method: 'POST', body: { text: '修好了' } })
  eq(repaired.body.warning, '', '保存一次就把坏文件修好（无告警）')
  eq((await request('/rules')).body.text, '修好了', '修好之后读到的是新文本')

  // 未知路由不受影响
  eq((await request('/nope')).status, 404, '未知路由仍 404')

  // 方法与路径不匹配：GET /rules/reset 走 404（与 /ui-prefs 一致的约定）
  eq((await request('/rules/reset')).status, 404, 'GET /rules/reset → 404')
} finally {
  await new Promise(resolve => server.close(resolve))
}

/* ═══════════════════════════════════════════════ H. 安装面 / 单一真相 */

section('H. 安装面与单一真相')

const installer = await import(pathToFileURL(path.join(root, 'tools', 'install-pi-extension.mjs')).href)
eq(installer.EXTENSION_FILES.length, 13, '共享扩展都纳入安装清单')
eq(installer.RULES_EXTENSION_FILE_NAME, 'superpi-rules.ts', '规则扩展文件名固定')
eq(installer.RULES_MODULE_FILE_NAME, 'superpi-rules.mjs', '共享模块文件名固定')
eq(installer.GUARD_EXTENSION_FILE_NAME, 'superpi-context-guard.ts', '上下文守卫扩展文件名固定')
eq(installer.GUARD_MODULE_FILE_NAME, 'superpi-context-guard.mjs', '上下文守卫共享模块文件名固定')
const installDir = path.join(tmp, 'pi-ext')
const installed = installer.install({ dir: installDir })
eq(installed.code, 0, 'install 成功')
for (const file of installer.EXTENSION_FILES) {
  ok(fs.existsSync(path.join(installDir, file.name)), '安装后存在 ' + file.name)
}
// 装出来的 .mjs 必须与仓库那份逐字节一致 —— 否则面板与命令行各跑一份逻辑。
eq(
  fs.readFileSync(path.join(installDir, 'superpi-rules.mjs'), 'utf8'),
  fs.readFileSync(path.join(root, 'extensions', 'superpi-rules.mjs'), 'utf8'),
  '装出来的共享模块与仓库逐字节一致',
)
eq(installer.status({ dir: installDir }).complete, true, 'status.complete 反映八个文件全部一致')
eq(installer.install({ dir: installDir }).code, 0, 'install 幂等')
eq(installer.remove({ dir: installDir }).code, 0, 'remove 成功')
for (const file of installer.EXTENSION_FILES) {
  ok(fs.existsSync(path.join(installDir, file.name)) === false, '卸载后 ' + file.name + ' 消失')
}
eq(installer.remove({ dir: installDir }).code, 0, 'remove 幂等（未安装不报错）')

/* ---- 0.16.0：`dir` 参数必须隔离 skill，不许碰真实 home ---- */

/**
 * 这一条是为一个**长期未定位的数据丢失事故**补的。
 *
 * 现象：2026-11-19 一天内两个 skill 从 `~/.agents/skills` 消失 3 次，
 * 都在 `npm test` 前后；复现序列连跑 3 遍没再现，根因当时记为"未确定"。
 *
 * 真因：`status()` 里 `skillsDir` **只看 `options.skillsDir` / 环境，完全不看 `options.dir`**。
 * 于是本段下面那句 `installer.remove({ dir: installDir })`
 * 删扩展文件删在 tmp 里、**删 skill 却删在用户真实的 `~/.agents/skills`**。
 * 测试全绿，用户的两份 skill 没了 —— 副作用发生在被测参数的作用域之外。
 *
 * 所以这里不只测"install/remove 返回 0"，而要测**作用域边界**：
 * 传 tmp dir 跑完一整套 install → remove，真实 skill 目录必须**一个字节都没变**。
 */
{
  const realSkillsDir = path.join(os.homedir(), '.agents', 'skills')
  const snapshot = () => {
    if (!fs.existsSync(realSkillsDir)) return '(absent)'
    return fs.readdirSync(realSkillsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => {
        const file = path.join(realSkillsDir, entry.name, 'SKILL.md')
        const exists = fs.existsSync(file)
        const size = exists ? fs.statSync(file).size : -1
        return entry.name + ':' + String(size)
      })
      .sort()
      .join('|')
  }

  const before = snapshot()
  const sandbox = path.join(tmp, 'iso-sandbox')
  installer.install({ dir: sandbox })
  installer.remove({ dir: sandbox })
  const after = snapshot()
  eq(after, before, '传 dir 跑 install+remove 后，真实 ~/.agents/skills 必须完全不变（不许跨作用域删除）')

  // 反向断言：skills 确实被隔离到了 sandbox 内部，而不是"两边都没装"。
  // 否则上面那条可能因为"根本没动 skill"而假绿。
  installer.install({ dir: sandbox })
  const sandboxSkill = path.join(sandbox, 'skills', 'verified-delivery', 'SKILL.md')
  ok(fs.existsSync(sandboxSkill), 'skill 必须装进 dir 内部（' + sandboxSkill + '），而不是真实 home')
  installer.remove({ dir: sandbox })
  ok(fs.existsSync(sandboxSkill) === false, '卸载时也只删 dir 内部那一份')
  eq(snapshot(), before, '整套装/卸走完，真实 skill 目录仍不变')
}

// 面板不许自带默认规则文案：默认文案的唯一真相在 extensions/superpi-rules.mjs。
const clientSource = fs.readFileSync(path.join(root, 'client.js'), 'utf8')
const copyLeaks = ['User-defined rules：', 'git revert', '业务编号'].filter(sentence => clientSource.includes(sentence))
eq(copyLeaks, [], 'client.js 里不复制默认规则文案（单一真相）')

// 扩展源码不许 import pi 的包：否则 node_modules 里多份 pi 副本时会解析失败。
const rulesExtensionSource = fs.readFileSync(path.join(root, 'extensions', 'superpi-rules.ts'), 'utf8')
const imports = rulesExtensionSource.split('\n').filter(line => /^\s*import\s/.test(line) || /from\s+['"]/.test(line))
const piImports = imports.filter(line => line.includes('@earendil-works/'))
eq(piImports, [], '规则扩展不 import @earendil-works/*（多份 pi 副本都能加载）')

// host 与扩展引用同一份模型模块。
const indexSource = fs.readFileSync(path.join(root, 'index.js'), 'utf8')
ok(indexSource.includes("./extensions/superpi-rules.mjs"), 'index.js 引用共享模块')
ok(rulesExtensionSource.includes("./superpi-rules.mjs"), '扩展引用同目录共享模块（安装后路径不变）')

/* ═══════════════════════════════════════════════════════════ 收尾 */

try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }

if (failed === 0) {
  console.log('')
  console.log('PASS (' + String(checks) + ' checks)')
  process.exit(0)
}
console.error('')
console.error('FAIL (' + String(failed) + '/' + String(checks) + ')')
process.exit(1)

#!/usr/bin/env node
/**
 * 模型模态开关（model modalities）的门禁。
 *
 * 这个功能最容易变成**假开关**：界面上有一个能点的开关，但请求里什么都没变。
 * 所以门禁必须打穿三层，缺一层就拦不住：
 *   ① 协议解析 —— 哪些模态可用，必须来自 `model.input`，不是硬编码清单；
 *   ② 请求生效 —— 关掉 image 之后，`context` 事件返回的 messages 里真的没有 image 块；
 *   ③ 落盘与幂等 —— 稀疏存储、坏文件不抛、默认值不落盘（改了默认会自动跟随）。
 *
 * 另外钉一条**防过期**断言：`RUNTIME_MODALITIES` 必须与 pi 的类型声明一致。
 * pi 将来加了音频/视频，这条会红，提醒我们更新清单 —— 而不是静默地少一个开关。
 *
 * 跑法：node test/modalities.mjs
 */

import fs from 'node:fs'
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
function describe(value) {
  const text = JSON.stringify(value)
  if (typeof text !== 'string') return String(value)
  return text.length > 320 ? text.slice(0, 320) + '…' : text
}
function eq(actual, expected, message) {
  const same = actual !== null && expected !== null && typeof actual === 'object' && typeof expected === 'object'
    ? JSON.stringify(actual) === JSON.stringify(expected)
    : actual === expected
  ok(same, `${message} (got ${describe(actual)}, want ${describe(expected)})`)
}
function section(title) {
  console.log('')
  console.log('── ' + title)
}

const mod = await import(pathToFileURL(path.join(root, 'extensions', 'superpi-modalities.mjs')).href)
const {
  DEFAULT_ENABLED_MODALITIES,
  LOCKED_MODALITIES,
  MODALITIES_VERSION,
  RUNTIME_MODALITIES,
  allowedModalities,
  createModalitiesStore,
  filterMessagesByModalities,
  modalityOmittedText,
  modelKey,
  normalizeModalitiesState,
  overridesFor,
  readModalitiesStateSync,
  resolveModelModalities,
  resolveModalitiesPath,
} = mod

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'superpi-modalities-'))
const stateFile = path.join(tmp, 'modalities.json')
const env = { ...process.env, SUPERPI_MODALITIES: stateFile }

const visionModel = { provider: 'odys-deepseek', id: 'Deepseek-V4.1-Flash', input: ['text', 'image'] }
const textOnlyModel = { provider: 'acme', id: 'text-only', input: ['text'] }

/* ═════════════════════════════════════════════════════ A. 协议解析 */

section('A. 协议解析：模态清单来自 model.input，不是硬编码')

eq(RUNTIME_MODALITIES.includes('text'), true, '运行时模态含 text')
eq(RUNTIME_MODALITIES.includes('image'), true, '运行时模态含 image')
eq(DEFAULT_ENABLED_MODALITIES, ['text', 'image'], '默认开启文本与图像')
eq(LOCKED_MODALITIES, ['text'], '文本是不可关闭的那个')

const vision = resolveModelModalities(visionModel)
eq(vision.declared, ['text', 'image'], '视觉模型声明两种模态')
eq(vision.available, ['text', 'image'], '视觉模型两种都可开关')
eq(vision.entries.map(e => e.id), ['text', 'image'], '顺序固定：文本在前')
eq(vision.entries[0].locked, true, '文本被锁定')
eq(vision.entries[1].locked, false, '图像可切换')
eq(vision.declaredByProtocol, true, '标记为协议声明')

const textOnly = resolveModelModalities(textOnlyModel)
eq(textOnly.available, ['text'], '纯文本模型只有文本可开关（不凭空出现图像）')
eq(textOnly.entries.length, 1, '纯文本模型没有图像那一行')

const unknown = resolveModelModalities({ provider: 'x', id: 'y' })
eq(unknown.declaredByProtocol, false, '缺 input 时标记为「非协议声明」')
eq(unknown.available, ['text', 'image'], '缺 input 时按产品默认（文本+图像），不凭空降级')
eq([...allowedModalities({ provider: 'x', id: 'y' })], ['text', 'image'], '缺 input 时默认全开')

const futuristic = resolveModelModalities({ provider: 'x', id: 'z', input: ['text', 'image', 'audio'] })
eq(futuristic.unsupported.map(u => u.id), ['audio'], '协议声明但运行时没有的模态 → 进 unsupported')
ok(futuristic.unsupported[0].reason.includes('无法发送'), 'unsupported 带原因（不画假开关）')
eq(futuristic.available, ['text', 'image'], 'unsupported 不进可开关集合')

/* ═════════════════════════════════════════════════════ B. 默认与覆盖 */

section('B. 默认值与用户覆盖')

eq([...allowedModalities(visionModel)], ['text', 'image'], '默认两种都允许')
eq([...allowedModalities(visionModel, { image: false })], ['text'], '关掉图像后只剩文本')
eq([...allowedModalities(visionModel, { image: false, text: false })], ['text'], '文本的覆盖被忽略（锁定）')
eq([...allowedModalities(textOnlyModel, { image: true })], ['text'], '纯文本模型即使想开图像也不会凭空出现')
const resolvedOff = resolveModelModalities(visionModel, { image: false })
eq(resolvedOff.entries[1].enabled, false, '覆盖后 image 为关')
eq(resolvedOff.entries[1].isDefault, false, '标记为非默认')

/* ═════════════════════════════════════════════════════ C. 归一化 */

section('C. 归一化：幂等 + 稀疏 + 拒绝非法值')

const normalized = normalizeModalitiesState({ models: { 'a/b': { image: false, text: false, audio: true }, 'c/d': { image: true } } })
eq(normalized.version, MODALITIES_VERSION, '版本号写入')
eq(Object.keys(normalized.models), ['a/b'], '只留真正的非默认项（image:true 是默认值，不落盘）')
eq(normalized.models['a/b'], { image: false }, '锁定模态的 text 覆盖被丢弃，audio 不在运行时清单里也丢弃')
eq(normalizeModalitiesState(normalized), normalized, '归一化幂等')
eq(normalizeModalitiesState(null), { version: MODALITIES_VERSION, models: {} }, 'null 归一成空状态')
eq(normalizeModalitiesState({ models: { 'x/y': null } }), { version: MODALITIES_VERSION, models: {} }, '坏条目被丢弃')

/* ═════════════════════════════════════════════════════ D. 过滤 */

section('D. 请求前过滤：关掉的模态真的消失')

const imageToolResult = {
  role: 'toolResult',
  toolCallId: 'c1',
  toolName: 'read',
  content: [
    { type: 'text', text: 'Read image file [image/png]' },
    { type: 'image', data: 'AAAA', mimeType: 'image/png' },
  ],
}
const textOnlyModelMsgs = [imageToolResult]

const unfiltered = filterMessagesByModalities(textOnlyModelMsgs, new Set(['text', 'image']))
eq(unfiltered, textOnlyModelMsgs, '全允许时返回原数组（不做无谓复制）')

const filtered = filterMessagesByModalities(textOnlyModelMsgs, new Set(['text']))
eq(filtered === textOnlyModelMsgs, false, '关掉图像后返回新数组')
eq(filtered[0].content.length, 2, '块数不变（换内容，不删消息）')
eq(filtered[0].content[1].type, 'text', 'image 块被换成文本占位')
ok(filtered[0].content[1].text.includes('omitted'), '占位明确说明被省略')
eq(imageToolResult.content[1].type, 'image', '原消息未被就地修改（非破坏性）')

const assistantWithImage = { role: 'user', content: [{ type: 'text', text: '看这张图' }, { type: 'image', data: 'BBBB' }] }
const filteredUser = filterMessagesByModalities([assistantWithImage], new Set(['text']))
eq(filteredUser[0].content[1].type, 'text', '用户消息里的图也被剥掉')
eq(filteredUser[0].content[0].text, '看这张图', '文本原样保留')

// 极端：调用方传了个不含 text 的集合，也**不许**把对话清空。
const degenerate = filterMessagesByModalities([{ role: 'user', content: [{ type: 'text', text: '你好' }] }], new Set())
eq(degenerate[0].content[0].text, '你好', '文本永不过滤（即使集合里没有 text）')

ok(modalityOmittedText('image').includes('image'), '占位里带模态名（模型能理解发生了什么）')
ok(modalityOmittedText('image', { filePath: 'D:/a.png' }).includes('D:/a.png'), '带路径时占位含路径')

/* ═════════════════════════════════════════════════════ E. 落盘 */

section('E. 落盘：原子写、串行、400 语义')

eq(resolveModalitiesPath({ env: {}, home: 'C:/home/x' }).replace(/\\/g, '/'), 'C:/home/x/.superpi/modalities.json', '默认路径在 .superpi 下')
eq(readModalitiesStateSync({ env: {}, home: path.join(tmp, 'nope') }).models, {}, '文件不存在时返回空状态且不抛')

fs.writeFileSync(stateFile, '{ broken', 'utf8')
eq(readModalitiesStateSync({ env }).models, {}, '坏 JSON 返回空状态且不抛')

const store = createModalitiesStore({ filePath: stateFile })
const afterOff = await store.set(visionModel, 'image', false)
eq(afterOff.models['odys-deepseek/Deepseek-V4.1-Flash'], { image: false }, '关闭图像被落盘')
eq(overridesFor(afterOff, visionModel), { image: false }, '按模型键取回覆盖')

const afterOn = await store.set(visionModel, 'image', true)
eq(afterOn.models, {}, '恢复默认后条目被删除（稀疏存储）')

await store.set(visionModel, 'image', false)
const cleared = await store.set(visionModel, 'image', null)
eq(cleared.models, {}, 'enabled=null 清掉覆盖')

let threw = null
try { await store.set(visionModel, 'audio', true) } catch (error) { threw = error }
eq(threw !== null && threw.statusCode === 400, true, '运行时没有的模态 → 400（不是静默忽略）')

threw = null
try { await store.set(visionModel, 'text', false) } catch (error) { threw = error }
eq(threw !== null && threw.statusCode === 400, true, '锁定模态不可改 → 400')

threw = null
try { await store.set({ provider: 'p' }, 'image', false) } catch (error) { threw = error }
eq(threw !== null && threw.statusCode === 400, true, '缺 id 的模型 → 400')

// 并发写不许互相覆盖
await Promise.all([store.set({ provider: 'a', id: 'm1' }, 'image', false), store.set({ provider: 'a', id: 'm2' }, 'image', false)])
const merged = await store.read()
eq(Object.keys(merged.models).sort(), ['a/m1', 'a/m2'], '并发写不丢更新（串行队列）')

eq(modelKey({ provider: 'p', id: 'i' }), 'p/i', '模型键是 provider/id')
eq(modelKey({ id: 'i' }), 'i', '没有 provider 时退化成 id')
eq(modelKey({ provider: 'p' }), '', '没有 id 时键为空')

/* ═════════════════════════════════════════════════════ F. 防过期 */

section('F. 防过期：运行时模态清单必须与 pi 的类型一致')

const pi = resolvePiRuntime({ pluginRoot: root })
if (!pi.packageDir) {
  /** 曾经是 SKIP（0.16.1 修）：这段测的是「RUNTIME_MODALITIES 有没有过期」，缺 pi 就无法对账。 */
  console.error('')
  console.error('FAIL[preflight] pi 运行时不可用 —— 运行时模态清单无法与 pi 的类型对账')
  console.error('  这一层是本门禁的核心（防 RUNTIME_MODALITIES 过期），不能跳过。修法：npm run test:runtime')
  console.error('')
  process.exit(1)
} else {
  const typesFile = path.join(pi.packageDir, '..', 'pi-ai', 'dist', 'types.d.ts')
  const schemaFile = path.join(pi.packageDir, '..', 'pi-ai', 'dist', 'providers', 'model-schema.d.ts')
  const types = fs.existsSync(typesFile) ? fs.readFileSync(typesFile, 'utf8') : ''
  const schema = fs.existsSync(schemaFile) ? fs.readFileSync(schemaFile, 'utf8') : ''
  ok(types !== '', '读得到 pi 的 types.d.ts')
  ok(schema !== '', '读得到 pi 的 model-schema.d.ts')
  for (const id of RUNTIME_MODALITIES) {
    ok(schema.includes('"' + id + '"'), '运行时模态 ' + id + ' 出现在 pi 的 ModelInputModalitySchema 里')
  }
  // ContentBlock 里只有这几种块；音频/视频块出现时这条会红。
  ok(!/interface\s+AudioContent/.test(types), 'pi 没有 AudioContent（有的话需要扩展本功能）')
  ok(!/interface\s+VideoContent/.test(types), 'pi 没有 VideoContent（有的话需要扩展本功能）')
  ok(/interface\s+ImageContent/.test(types), 'pi 有 ImageContent（图像模态是可发送的）')
}

/* ═════════════════════════════════════════════════════ G. 真扩展 */

section('G. 真扩展：context 事件里开关真的生效')

const previousEnv = process.env.SUPERPI_MODALITIES
process.env.SUPERPI_MODALITIES = stateFile
fs.writeFileSync(stateFile, JSON.stringify({ version: 1, models: { 'odys-deepseek/Deepseek-V4.1-Flash': { image: false } } }), 'utf8')

let extensionModule = null
if (!pi.cliPath || !pi.packageDir) {
  /** 曾经是 SKIP（0.16.1 修）：扩展层测的是「开关真的生效」，缺 pi 等于完全未验证。 */
  console.error('')
  console.error('FAIL[preflight] pi 运行时不可用 —— 扩展层（superpi-context-guard.ts）无法加载')
  console.error('  这一层是本门禁的被测对象，不能跳过。修法：npm run test:runtime')
  console.error('')
  process.exit(1)
} else {
  let jitiPath = ''
  let dir = path.resolve(pi.packageDir)
  for (let depth = 0; depth < 8; depth += 1) {
    const target = path.join(dir, 'node_modules', 'jiti', 'lib', 'jiti.mjs')
    if (fs.existsSync(target)) { jitiPath = target; break }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  if (jitiPath === '') {
    console.error('')
    console.error('FAIL[preflight] 找不到 jiti —— 扩展层无法加载')
    console.error('  修法：重装 pi 运行时（npm run test:runtime）')
    console.error('')
    process.exit(1)
  }
  else {
    const { createJiti } = await import(pathToFileURL(jitiPath).href)
    const extensionFile = path.join(root, 'extensions', 'superpi-context-guard.ts')
    const jiti = createJiti(extensionFile, { interopDefault: true, moduleCache: false })
    extensionModule = await jiti.import(extensionFile)
  }
}

if (extensionModule !== null) {
  const handlers = {}
  extensionModule.default({ on: (name, fn) => { handlers[name] = fn }, registerCommand() {} })

  const messages = [
    { role: 'user', content: [{ type: 'text', text: '看图' }] },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'k1', name: 'read', arguments: { path: 'D:/a.png' } }] },
    { role: 'toolResult', toolCallId: 'k1', toolName: 'read', content: [{ type: 'text', text: 'Read image file' }, { type: 'image', data: 'CCCC', mimeType: 'image/png' }] },
  ]
  const ctx = { model: { ...visionModel, contextWindow: 1000000 } }

  const out = await handlers.context({ messages }, ctx)
  ok(out !== null && Array.isArray(out.messages), '关掉图像后 context 返回改写后的 messages')
  const hasImage = out.messages.some(message => Array.isArray(message.content) && message.content.some(b => b.type === 'image'))
  eq(hasImage, false, '返回的 messages 里没有任何 image 块（真生效）')
  ok(JSON.stringify(out.messages).includes('omitted'), '被剥掉的位置留下占位说明')

  // 默认（未覆盖）时不该动
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, models: {} }), 'utf8')
  const passthrough = await handlers.context({ messages }, ctx)
  eq(passthrough, undefined, '默认全开时返回 undefined（不做无谓重放）')

  // 纯文本模型：图像本就发不出去，仍应剥掉（用户要的语义一致）
  const textOut = await handlers.context({ messages }, { model: { ...textOnlyModel, contextWindow: 1000000 } })
  ok(textOut !== null && !JSON.stringify(textOut.messages).includes('"image"'), '纯文本模型默认不发图（无需用户手动关）')
}

/* ═════════════════════════════════════════════════════ H. TUI 命令 */

section('H. TUI：/superpi-modalities 菜单真的能改状态')

/**
 * 外层 `if (pi.cliPath && pi.packageDir)` 已删（0.16.1）：上面缺 pi 时已经 exit 1，
 * 这个守卫恒为真，留着只会让人以为「这一层可能不跑」。
 * jiti 缺失同理不再是 SKIP —— TUI 命令是本门禁的被测对象之一。
 */
{
  let jitiPath = ''
  let dir = path.resolve(pi.packageDir)
  for (let depth = 0; depth < 8; depth += 1) {
    const target = path.join(dir, 'node_modules', 'jiti', 'lib', 'jiti.mjs')
    if (fs.existsSync(target)) { jitiPath = target; break }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  if (jitiPath === '') {
    console.error('')
    console.error('FAIL[preflight] 找不到 jiti —— TUI 扩展（superpi-modalities.ts）无法加载')
    console.error('  修法：重装 pi 运行时（npm run test:runtime）')
    console.error('')
    process.exit(1)
  } else {
    const { createJiti } = await import(pathToFileURL(jitiPath).href)
    const tuiFile = path.join(root, 'extensions', 'superpi-modalities.ts')
    const tuiJiti = createJiti(tuiFile, { interopDefault: true, moduleCache: false })
    const tuiModule = await tuiJiti.import(tuiFile)
    eq(typeof tuiModule.default, 'function', 'TUI 扩展默认导出是函数')
    eq(tuiModule.MODALITIES_COMMAND, 'superpi-modalities', '命令名固定')

    const commands = {}
    tuiModule.default({ registerCommand: (name, options) => { commands[name] = options } })
    eq(Object.keys(commands), ['superpi-modalities'], '只注册一个命令（不抢 pi 的）')

    // 走一遍真实交互路径：选模型 → 点图像 → 回列表 → 完成
    fs.writeFileSync(stateFile, JSON.stringify({ version: 1, models: {} }), 'utf8')
    const modelList = [
      { provider: 'p', id: 'm1', name: 'M1', input: ['text', 'image'] },
      { provider: 'p', id: 'm2', name: 'M2', input: ['text'] },
    ]
    const picks = []
    const ctx = {
      scopedModels: [],
      modelRegistry: { getAvailable: () => modelList },
      ui: {
        select: async (_title, options) => {
          picks.push(options.join(' | '))
          if (picks.length === 1) return options[0]
          if (picks.length === 2) return options.find(option => option.indexOf('图像') === 0)
          if (picks.length === 3) return '返回模型列表'
          return '完成'
        },
        notify: () => {},
      },
    }
    await commands['superpi-modalities'].handler('', ctx)
    eq(JSON.parse(fs.readFileSync(stateFile, 'utf8')).models, { 'p/m1': { image: false } }, '从菜单关掉图像真的落盘')
    ok(picks[0].includes('图像 ✓'), '模型列表带模态摘要（不点进去也知道状态）')
    ok(picks[0].includes('M2 · p  [文本 固定]'), '纯文本模型只显示文本（不出现图像项）')
    ok(picks[1].includes('对话的必需通道，不可关闭'), '文本那一行明确写不可关闭')

    // 恢复默认：把 image 项清回默认
    const restorePicks = []
    const restoreCtx = {
      scopedModels: [],
      modelRegistry: { getAvailable: () => modelList },
      ui: {
        select: async (_title, options) => {
          restorePicks.push(options.join(' | '))
          if (restorePicks.length === 1) return options[0]
          if (restorePicks.length === 2) return '恢复这个模型的默认'
          if (restorePicks.length === 3) return '返回模型列表'
          return '完成'
        },
        notify: () => {},
      },
    }
    await commands['superpi-modalities'].handler('', restoreCtx)
    eq(JSON.parse(fs.readFileSync(stateFile, 'utf8')).models, {}, '「恢复默认」清掉覆盖')

    // 无模型时不静默：必须有可见提示
    const notices = []
    await commands['superpi-modalities'].handler('', {
      scopedModels: [], modelRegistry: { getAvailable: () => [] },
      ui: { select: async () => undefined, notify: (text, tone) => notices.push([text, tone]) },
    })
    ok(notices.length === 1 && notices[0][1] === 'warning', '没有模型时给出 warning（不是空白菜单）')
  }
}

if (previousEnv === undefined) delete process.env.SUPERPI_MODALITIES
else process.env.SUPERPI_MODALITIES = previousEnv

/* ═════════════════════════════════════════════════════ 收尾 */

try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }

if (failed === 0) {
  console.log('')
  console.log('PASS (' + String(checks) + ' checks)')
  process.exitCode = 0
} else {
  console.error('')
  console.error('FAIL (' + String(failed) + '/' + String(checks) + ')')
  process.exitCode = 1
}

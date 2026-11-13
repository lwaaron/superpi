/**
 * 两端对齐门禁（parity gate）：面板 == 命令行 pi。
 *
 * 为什么需要这个文件
 * ------------------
 * 0.2.5 之前，面板只发了 33 条 RPC 命令里的 5 条（15%），25 类事件只处理了 12 类，
 * 27 条内置斜杠命令一条没接 —— 而 npm test 全绿。测试覆盖的是「我们写的代码互相自洽」，
 * 不是「我们和 pi 一致」。这个门禁补的就是后者：把 pi 自己的权威定义拉进来对账。
 *
 * 三个事实来源（都不依赖我们的转述）
 * --------------------------------
 *  1. pi 的类型声明 RpcCommand 联合 —— 命令面的机器可读真相；
 *     pi 安装包里是非压缩的 dist/modes/rpc/rpc-types.d.ts，源码树里是 src/modes/rpc/rpc-types.ts，
 *     两者都能解析（不解析 dist/bundle 的压缩 chunk：case 标签形如 case"get_state"，一改就碎）。
 *  2. pi 的 docs/json.md 事件表 —— 事件面的权威文档（This page is the canonical reference）。
 *     扩展 UI 是独立子协议，权威在 docs/rpc-extension-ui.md。
 *  3. 我们自己的 src/rpc-contract.mjs（契约）+ client.js / index.js / src/pi-rpc.mjs（真实接线）。
 *
 * 对账方向是双向的
 * ----------------
 *  pi 有、我们没有  → 缺口（用户看得见的能力缺失）
 *  我们有、pi 没有  → 幻觉（契约写错了，面板会发一条 pi 不认的命令）
 *  契约有、面板没接  → 死契约（协议支持但面板没入口，等于没有）
 *
 * 跑法：node test/parity.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)

let passed = 0
const failures = []

function check(name, condition, detail) {
  if (condition) { passed += 1; return }
  failures.push(name + (detail === undefined ? '' : ' → ' + String(detail)))
  console.error('  ✗ ' + name + (detail === undefined ? '' : ' → ' + String(detail)))
}

function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), 'actual=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected))
}

/** 双向集合对账：missing = 对方有我们没有；extra = 我们有对方没有。 */
function sameSet(name, actual, expected) {
  const a = Array.from(new Set(actual)).sort()
  const b = Array.from(new Set(expected)).sort()
  const missing = b.filter((item) => a.includes(item) === false)
  const extra = a.filter((item) => b.includes(item) === false)
  check(name, missing.length === 0 && extra.length === 0, 'missing=' + JSON.stringify(missing) + ' extra=' + JSON.stringify(extra))
}

function section(title) {
  console.log('')
  console.log('── ' + title + ' ' + '─'.repeat(Math.max(0, 60 - title.length)))
}

/** 找 pi 包目录：环境变量 → 插件内 .runtime → 本包 node_modules → 同级源码树。 */
function findPiPackage() {
  const candidates = []
  if (typeof process.env.PI_PACKAGE_DIR === 'string' && process.env.PI_PACKAGE_DIR !== '') candidates.push(process.env.PI_PACKAGE_DIR)
  candidates.push(path.join(root, '.runtime', 'node_modules', '@earendil-works', 'pi-coding-agent'))
  candidates.push(path.join(root, 'node_modules', '@earendil-works', 'pi-coding-agent'))
  candidates.push(path.join(path.dirname(root), 'pi-main', 'packages', 'coding-agent'))
  for (const dir of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
      if (typeof pkg.name === 'string' && pkg.name.indexOf('pi-coding-agent') >= 0) return dir
    } catch { /* 换下一个候选 */ }
  }
  return null
}

/** pi 的命令声明文件：优先 .d.ts（安装包），退化到 .ts（源码树）。 */
function findRpcTypesFile(pkgDir) {
  const candidates = [
    path.join(pkgDir, 'dist', 'modes', 'rpc', 'rpc-types.d.ts'),
    path.join(pkgDir, 'src', 'modes', 'rpc', 'rpc-types.ts'),
    path.join(pkgDir, 'dist', 'modes', 'rpc', 'rpc-types.ts'),
  ]
  for (const file of candidates) {
    if (fs.existsSync(file)) return file
  }
  return null
}

/**
 * 取出 type 别名 / interface 的完整声明文本。
 *
 * 用花括号深度扫描，不能用「深度回零就收」—— type 联合体的每个成员都是
 * 独立的一对花括号，深度在中途反复回零。规则：
 *   interface  → 结束在深度回零的那个右花括号
 *   type = ... → 结束在深度回零后的第一个分号（联合体整体结尾）
 */
function extractDecl(text, typeName) {
  const aliasHeader = 'export type ' + typeName + ' ='
  const interfaceHeader = 'export interface ' + typeName + ' {'
  const aliasAt = text.indexOf(aliasHeader)
  const interfaceAt = text.indexOf(interfaceHeader)
  if (aliasAt < 0 && interfaceAt < 0) return null
  const isInterface = aliasAt < 0 || (interfaceAt >= 0 && interfaceAt < aliasAt)
  const start = isInterface ? interfaceAt : aliasAt
  let depth = 0
  for (let index = start; index < text.length; index += 1) {
    const ch = text[index]
    if (ch === '{') { depth += 1; continue }
    if (ch === '}') {
      depth -= 1
      if (isInterface === true && depth === 0) return text.slice(start, index + 1)
      continue
    }
    if (isInterface === false && ch === ';' && depth === 0) return text.slice(start, index + 1)
  }
  return text.slice(start)
}

/** 联合体里每个成员的 type 字面量（行首锚定，避免误吃字段值）。 */
function unionDiscriminants(block) {
  const names = []
  const re = /^[ \t]*type:[ \t]*"([A-Za-z0-9_]+)"/gm
  let match = re.exec(block)
  while (match !== null) {
    names.push(match[1])
    match = re.exec(block)
  }
  return names
}

/** interface 里每个字段名（用于字段存在性断言）。 */
function interfaceFields(block) {
  const names = []
  const re = /^[ \t]*([A-Za-z_$][A-Za-z0-9_$]*)\??:/gm
  let match = re.exec(block)
  while (match !== null) {
    names.push(match[1])
    match = re.exec(block)
  }
  return names
}

/** 从 RpcCommand 联合里取出某个成员（type 字面量所在的整对花括号）。 */
function extractMember(block, name) {
  const marker = 'type: "' + name + '"'
  const at = block.indexOf(marker)
  if (at < 0) return null
  const open = block.lastIndexOf('{', at)
  if (open < 0) return null
  let depth = 0
  for (let index = open; index < block.length; index += 1) {
    const ch = block[index]
    if (ch === '{') { depth += 1; continue }
    if (ch === '}') {
      depth -= 1
      if (depth === 0) return block.slice(open, index + 1)
    }
  }
  return null
}

/**
 * 解析 docs/json.md 的两张事件表。
 * 只认表头 Event / Fields / Meaning 与 Type / Fields in addition to …，
 * 其它表（限制表、示例表）一律不碰。
 */
function parseDocTables(markdown) {
  const sessionEvents = []
  const assistantEvents = []
  let mode = null
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\|\s*Event\s*\|\s*Fields\s*\|\s*Meaning\s*\|/.test(line)) { mode = 'event'; continue }
    if (/^\|\s*Type\s*\|\s*Fields in addition to/.test(line)) { mode = 'assistant'; continue }
    if (mode === null) continue
    if (line.startsWith('|') === false) { mode = null; continue }
    const match = /^\|\s*.([A-Za-z0-9_]+).\s*\|/.exec(line)
    if (match === null) continue
    if (mode === 'event') sessionEvents.push(match[1])
    else assistantEvents.push(match[1])
  }
  return { sessionEvents, assistantEvents }
}

const contractUrl = pathToFileURL(path.join(root, 'src', 'rpc-contract.mjs')).href
const contract = await import(contractUrl)
const clientSource = fs.readFileSync(path.join(root, 'client.js'), 'utf8')
const hostSource = fs.readFileSync(path.join(root, 'index.js'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'src', 'pi-rpc.mjs'), 'utf8')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

console.log('parity gate — 面板 == 命令行 pi')
console.log('plugin =', pkg.version, '| contract =', contract.PI_VERSION)

// ── 0. 契约自洽（不依赖 pi 安装）─────────────────────────────────────────
section('0. 契约自洽（不依赖 pi 安装）')
eq('validateContract() 无问题', contract.validateContract(), [])
eq('RPC 命令条数', contract.RPC_COMMANDS.length, 33)
eq('事件条数', contract.RPC_EVENTS.length, 25)
eq('assistantMessageEvent 条数', contract.ASSISTANT_EVENT_TYPES.length, 12)
eq('TUI 命令条数', contract.TUI_COMMANDS.length, 27)
eq('扩展 UI method 条数', contract.EXTENSION_UI_METHODS.length, 9)
const menu = contract.slashMenuEntries([])
eq('斜杠菜单内置条数', menu.length, 27)
check('斜杠菜单每条的 disposition 合法', menu.every((item) => contract.DISPOSITIONS.has(item.disposition)) === true)
check('BASH_SHORTCUTS 两条都指向 bash', contract.BASH_SHORTCUTS.length === 2 && contract.BASH_SHORTCUTS.every((item) => item.command === 'bash') === true)
eq('分类器把 /compact 判给 rpc', contract.classifyInput('/compact').disposition, 'rpc')
eq('分类器把 /share 判给 cli-only', contract.classifyInput('/share').disposition, 'cli-only')
eq('分类器把 /import 判给 unsupported', contract.classifyInput('/import a.jsonl').disposition, 'unsupported')
eq('分类器把扩展命令判给 unknown-slash（照 prompt 发）', contract.classifyInput('/myext x').kind, 'unknown-slash')
eq('分类器把 !! 判给 excludeFromContext', contract.classifyInput('!! ls').excludeFromContext, true)

// ── 1. 版本号单一真相 ──────────────────────────────────────────────────
section('1. 版本号单一真相')
const contractVersionMatch = /const CONTRACT_VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(root, 'index.js'), 'utf8'))
check('index.js 声明了 CONTRACT_VERSION', contractVersionMatch !== null)
if (contractVersionMatch !== null) {
  eq('CONTRACT_VERSION 与 package.json 同步', contractVersionMatch[1], pkg.version)
}

// ── 2. 面板覆盖（契约的每一项都真的有接线）──────────────────────────────
section('2. 面板覆盖（client.js / host 字面量）')
const commandsMissing = contract.RPC_COMMAND_NAMES.filter((name) => clientSource.includes("'" + name + "'") === false)
eq('client.js 引用全部 33 条 RPC 命令', commandsMissing, [])
const eventsMissing = contract.RPC_EVENT_TYPES.filter((type) => clientSource.includes("'" + type + "'") === false)
eq('client.js 处理全部 25 类事件', eventsMissing, [])
const assistantMissing = contract.ASSISTANT_EVENT_TYPES.filter((type) => clientSource.includes("'" + type + "'") === false)
eq('client.js 处理全部 12 种 assistantMessageEvent', assistantMissing, [])
const methodsMissing = contract.EXTENSION_UI_METHODS.filter((entry) => clientSource.includes("'" + entry.method + "'") === false).map((entry) => entry.method)
eq('client.js 分派全部 9 种扩展 UI method', methodsMissing, [])
const dialogMethods = contract.EXTENSION_UI_METHODS.filter((entry) => entry.kind === 'dialog').map((entry) => entry.method)
eq('扩展 UI 里有 4 种阻塞对话框', dialogMethods.length, 4)
check('client.js 用 DIALOG_FALLBACK_MS 兜底超时', clientSource.includes('DIALOG_FALLBACK_MS') === true)
check('host 侧转发 extension_ui_response', hostSource.includes('extension_ui_response') === true)
const slashLiterals = contract.TUI_COMMANDS.filter((entry) => entry.disposition === 'rpc' || entry.disposition === 'client')
const slashMissing = slashLiterals.filter((entry) => clientSource.includes("'" + entry.text + "'") === false).map((entry) => entry.text)
eq('client.js 为每条 rpc/client 斜杠命令写了分支', slashMissing, [])
const cliOnly = contract.TUI_COMMANDS.filter((entry) => entry.disposition === 'cli-only')
const unsupported = contract.TUI_COMMANDS.filter((entry) => entry.disposition === 'unsupported')
eq('cli-only 有 9 条（面板必须显式告知不可用）', cliOnly.length, 9)
eq('unsupported 有 1 条', unsupported.length, 1)
check('client.js 有 cli-only 的显式出口', clientSource.includes("'cli-only'") === true)
check('client.js 有 unsupported 的显式出口', clientSource.includes("'unsupported'") === true)

// ── 3. 与 pi 的类型声明对账 ───────────────────────────────────────────────
const piDir = findPiPackage()
if (piDir === null) {
  console.log('')
  console.log('SKIP 与 pi 类型对账：没找到 @earendil-works/pi-coding-agent')
  console.log('     （可以 npm run test:runtime 让它装到 .runtime/，或设 PI_PACKAGE_DIR 指向源码树）')
  console.log('     契约自洽 + 面板覆盖已检查；缺口对账需要 pi 在场才能做。')
} else {
  const typesFile = findRpcTypesFile(piDir)
  console.log('')
  console.log('pi package =', piDir)
  console.log('types file =', typesFile === null ? '(none)' : typesFile)
  section('3. 命令面：pi 的类型声明 ↔ rpc-contract.mjs')
  check('找到 pi 的 rpc-types 声明', typesFile !== null)
  if (typesFile !== null) {
    const typesSource = fs.readFileSync(typesFile, 'utf8')

    const commandBlock = extractDecl(typesSource, 'RpcCommand')
    check('解析出 RpcCommand 联合', commandBlock !== null)
    const piCommands = commandBlock === null ? [] : unionDiscriminants(commandBlock)
    console.log('pi RpcCommand =', piCommands.length, '条 | 契约 =', contract.RPC_COMMAND_NAMES.length, '条')
    sameSet('命令名集合与 pi 一致（双向）', contract.RPC_COMMAND_NAMES, piCommands)

    // 字段级：契约声明的 required/optional 必须与 pi 的类型一致。
    // 只比字段名，不比类型（ThinkingLevel 之类在 .d.ts 里是别名，比名称没有信息量）。
    const fieldDiff = []
    if (commandBlock !== null) {
      for (const entry of contract.RPC_COMMANDS) {
        const member = extractMember(commandBlock, entry.name)
        if (member === null) { fieldDiff.push(entry.name + ': pi 里找不到成员'); continue }
        const piFields = interfaceFields(member).filter((name) => name !== 'id' && name !== 'type')
        const declared = entry.required.concat(entry.optional)
        const missing = piFields.filter((name) => declared.includes(name) === false)
        const extra = declared.filter((name) => piFields.includes(name) === false)
        if (missing.length > 0) fieldDiff.push(entry.name + ' 少声明 ' + JSON.stringify(missing))
        if (extra.length > 0) fieldDiff.push(entry.name + ' 多声明 ' + JSON.stringify(extra))
      }
    }
    eq('每条命令的字段与 pi 一致', fieldDiff, [])

    const stateBlock = extractDecl(typesSource, 'RpcSessionState')
    check('解析出 RpcSessionState', stateBlock !== null)
    if (stateBlock !== null) {
      const stateFields = interfaceFields(stateBlock)
      console.log('RpcSessionState 字段 =', stateFields.length, '个')
      // docs/parity.md 的 D-07：get_state 没有 autoRetryEnabled，设置抽屉的自动重试开关无法回读。
      check('已知缺口 D-07：RpcSessionState 仍无 autoRetryEnabled（若 pi 补了这个字段，这条会红，届时可闭环）', stateFields.includes('autoRetryEnabled') === false)
      check('RpcSessionState 仍提供 sessionFile（面板靠它判已落盘）', stateFields.includes('sessionFile') === true)
      check('RpcSessionState 仍提供 pendingMessageCount（状态栏排队计数）', stateFields.includes('pendingMessageCount') === true)
    }

    const requestBlock = extractDecl(typesSource, 'RpcExtensionUIRequest')
    check('解析出 RpcExtensionUIRequest', requestBlock !== null)
    if (requestBlock !== null) {
      const piMethods = Array.from(new Set((requestBlock.match(/method:[ \t]*"([A-Za-z0-9_]+)"/g) || []).map((line) => /"([A-Za-z0-9_]+)"/.exec(line)[1])))
      sameSet('扩展 UI method 集合与 pi 一致（双向）', contract.EXTENSION_UI_METHODS.map((entry) => entry.method), piMethods)
    }
  }

  section('4. 事件面：pi 的官方文档 ↔ rpc-contract.mjs')
  const jsonDoc = path.join(piDir, 'docs', 'json.md')
  const uiDoc = path.join(piDir, 'docs', 'rpc-extension-ui.md')
  check('找到 pi 的 docs/json.md', fs.existsSync(jsonDoc))
  if (fs.existsSync(jsonDoc)) {
    const markdown = fs.readFileSync(jsonDoc, 'utf8')
    const uiMarkdown = fs.existsSync(uiDoc) ? fs.readFileSync(uiDoc, 'utf8') : ''
    const corpus = markdown + '\n' + uiMarkdown
    const tables = parseDocTables(markdown)
    console.log('doc 事件表 =', tables.sessionEvents.length, '行 | assistant 表 =', tables.assistantEvents.length, '行')
    check('事件表至少 15 行（agent/turn 5 + message 3 + tool 3 + queue/state 4）', tables.sessionEvents.length >= 15)
    // 文档列了、契约漏了 → 面板会静默丢弃该事件
    const docOnly = tables.sessionEvents.filter((type) => contract.RPC_EVENT_TYPES.includes(type) === false)
    eq('文档里的事件都在契约里（我们不漏）', docOnly, [])
    // 契约列了、文档没有 → 可能写错名字（幻觉事件）
    const contractOnly = contract.RPC_EVENT_TYPES.filter((type) => corpus.includes(type) === false)
    eq('契约里的事件都在官方文档里（我们不编）', contractOnly, [])
    sameSet('assistantMessageEvent 12 种与文档一致', contract.ASSISTANT_EVENT_TYPES, tables.assistantEvents)
  }
}

// ── 5. 事件字段的硬约束（pi 文档明写，写错面板会静默丢数据）──────────────
section('5. 事件字段硬约束')
check('queue_update 存了队列文本（Esc 要把排队消息还给编辑器）', /queue:\s*\{[^}]*steeringText/.test(clientSource) === true)
check('agent_settled 清空 pendingUi（pi 在 settled 时丢弃未应答请求）', /agent_settled[\s\S]{0,600}pendingUi = \[\]/.test(clientSource) === true)
const agentEndBlock = /if \(type === 'agent_end'\) \{([\s\S]*?)\n {6}\}/.exec(clientSource)
check('解析出 agent_end 分支', agentEndBlock !== null)
check('agent_end 不清 busy（自动重试/压缩恢复仍可能继续，只有 settled 才是结束）', agentEndBlock !== null && /busy\s*=/.test(agentEndBlock[1]) === false)
check('bash 结果不走进事件流 → 用 get_messages 回拉补气泡', clientSource.includes("'get_messages'") === true && clientSource.includes('bashRef') === true)
check('流式追加走 steer（与 TUI 的 streamingBehavior 一致）', clientSource.includes("streamingBehavior = 'steer'") === true)

// ── 6. 0.3.0 闭环的两处缺陷：会话入口一致 + 超时不倒挂 ────────────────────
//
// 这两处在 0.2.5 全部真实存在且用户可见：
//   ① 装了扩展 / 改了 prompt 模板后，斜杠菜单里看不到（面板只在挂载时拉一次命令表），
//      而手敲又能执行 —— 菜单骗人；顶栏「新会话」把子进程关掉重开（/new 却只换会话树），
//      同一件事两个入口两种结果。
//   ② 命令命中的扩展弹窗等着人点，面板与 host 各自先超时，于是红条与对话框并存。
// 断言写成「源码必须长这样」而不是「行为应当如此」，因为面板的行为只能靠重启 DSH 验证，
// 而重启代价太高；把接线钉死在门禁里，改动时才有人拦。
//
// 刻意不用正则：本文件里出现过反斜杠在转义层被吃掉的事故（/[\s\S]/ 变成 /[sS]/ 后
// 整个文件语法错误）。顺序检查用 indexOf 做，语义更直白，也不怕转义。
section('6. 会话入口与超时语义（0.3.0 闭环）')

/** needles 依次出现在 text 里，且最后一个与第一个的间距不超过 window。 */
function inOrder(text, needles, window = 400) {
  let at = -1
  for (const needle of needles) {
    const found = text.indexOf(needle, at + 1)
    if (found === -1) return false
    if (at === -1) at = found
    if (found - at > window) return false
    at = found
  }
  return true
}

check('flush 在轮次结束时重拉命令表（扩展/skill 变化后斜杠菜单不刷新）', inOrder(clientSource, ['if (settled === true) {', 'loadCommands(sid)'], 400) === true)
check('loadCommands 返回命令数组（未知斜杠要先看最新命令表）', inOrder(clientSource, ['setDynamic(list)', 'return list'], 120) === true)
check('未知斜杠先重拉命令表再判定（不把装好的命令当错字）', inOrder(clientSource, ['var fresh = sid === null ? Promise.resolve(null) : loadCommands(sid)', 'hasDynamic(list, parsed.name)'], 700) === true)
check('对话类命令不设客户端超时（CHAT_TIMEOUT_MS = 0）', clientSource.includes('var CHAT_TIMEOUT_MS = 0') === true)
const chatTimeoutUses = clientSource.split('CHAT_TIMEOUT_MS').length - 1
// 定义 1 处 + prompt/bash/follow_up 三处调用 = 4；只允许更多（将来新增对话类入口也该用它）。
check('prompt / bash / follow_up 都用 CHAT_TIMEOUT_MS（实际 ' + String(chatTimeoutUses) + ' 处）', chatTimeoutUses >= 4)
check('client.js 不再硬编码 600000 的超时', clientSource.includes('600000') === false)
check('顶栏「新会话」走 runNewSession（与 /new 同一条路径）', inOrder(clientSource, ["t('newSessionHint')", 'onClick: runNewSession'], 120) === true)
check('顶栏另有显式「重连」走 endSession（换子进程是恢复手段，不是新会话）', inOrder(clientSource, ["t('reconnectHint')", 'onClick: endSession'], 120) === true)
check('host 侧 /command 显式区分 timeoutMs=0（不被 falsy 吞成默认值）', hostSource.includes('timeoutMs: limit ?? 0') === true)
check('host 侧把 timeoutMs 从 pi 命令载荷里剥掉（RpcCommand 无此字段）', hostSource.includes('delete command.timeoutMs') === true)
check('pi-rpc 的 send 支持「不设上限」（limitMs === null 时不起 timer）', hostSource.includes('if (limitMs !== null) waiter.timer = this.armTimer') === true)
check('pi-rpc 弹窗未答时续期而非超时（armTimer 看 pendingUi）', hostSource.includes('this.pendingUi.size > 0 && deferrals < MAX_TIMEOUT_DEFERRALS') === true)
check('pendingUi 登记了 pi 声明的 timeout（面板倒计时要跟它对齐）', hostSource.includes('timeout: typeof record.timeout') === true)
check('应答弹窗后重开一整轮超时窗口（不继承已烧掉的时间）', inOrder(hostSource, ['restartPendingTimers() {', 'waiter.deferrals = 0', 'this.armTimer(waiter, 0)'], 400) === true)
check('respond 里调用 restartPendingTimers（答题就是活着的证据）', hostSource.includes('this.pendingUi.delete(id)\n    this.restartPendingTimers()') === true)
check('面板倒计时优先用扩展声明的 timeout', clientSource.includes('Math.min(declared, DIALOG_FALLBACK_MS)') === true)

// ── 7. 会话切换后的历史对账（0.4.1 修「点开历史会话没有内容」）──────────────
//
// 根因不在面板的渲染，而在数据来源：switch_session / fork / clone / new_session 成功后
// host 会调 proc.resetEvents()（SESSION_REPLACING_COMMANDS），事件缓冲归零，
// 之后 snapshot 里一条历史都没有。旧实现只重放事件缓冲，于是面板永远空白。
// 命令行的 pi 从 jsonl 恢复 messages，所以 TUI 正常 —— 两边差别就在这里。
//
// 修法是挂载后调一次 get_messages 整表重建。这里把接线钉死：
// 五个入口（首次 startSession、reload 的 new/fork/clone/switch）全部经过 attach，
// 所以只要 attach 里接了 hydrate，就没有漏网的入口。
section('7. 会话切换后的历史对账（0.4.1）')
check('attach 末尾接上 hydrate（挂载即对账）', inOrder(clientSource, ['var attach = function (id) {', 'return hydrate(id)'], 1600) === true)
check('reload 只经 attach 一处挂载（四个替换类命令共用一条对账路径）', inOrder(clientSource, ['var reload = function (id) {', 'return attach(id)'], 200) === true)
check('startSession 两条分支都走 attach（首次进入也要对账）', (clientSource.split('attach(').length - 1) >= 3)
check('refreshMessages 复用 messagesFromHistory（一份整形逻辑，不各写一遍）', inOrder(clientSource, ['var refreshMessages = function () {', 'messagesFromHistory(list)'], 2000) === true)
check('会话已切走时丢弃旧会话的响应（避免串台）', clientSource.includes('if (sessionRef.current !== id) return null') === true)
check('busy 期间不覆盖列表，改挂待办（否则吞掉流式气泡）', clientSource.includes('hydratePendingRef.current = true') === true)
check('settled 后由 flush 补上挂起的对账（drainHydrate）', inOrder(clientSource, ['if (settled === true) {', 'loadCommands(sid)', 'drainHydrate()'], 400) === true)
check('drainHydrate 只在视图真的 idle 时执行', inOrder(clientSource, ['var drainHydrate = function () {', 'if (viewRef.current.busy === true) return'], 300) === true)
check('messagesFromHistory 跳过 system（每轮几十 KB 的提示词不进列表）', inOrder(clientSource, ['function messagesFromHistory(list) {', "if (raw.role === 'system') continue"], 400) === true)
check('messagesFromHistory 用数组下标当 seq，不碰 view.lastSeq', inOrder(clientSource, ['function messagesFromHistory(list) {', 'makeMessage(raw, next.length)'], 500) === true)
check('bashRef 仍只表示「bash 正在跑」（Esc 要能 abort_bash）', inOrder(clientSource, ['if (bashRef.current === true)', "'abort_bash'"], 200) === true)
check('history 对账函数已导出给测试', clientSource.includes('messagesFromHistory: messagesFromHistory') === true)

// ── 汇总 ──────────────────────────────────────────────────────────────────
console.log('')
if (failures.length === 0) {
  console.log('PASS (' + passed + ' checks)')
  process.exit(0)
}
console.error('FAIL (' + passed + ' passed, ' + failures.length + ' failed)')
for (const failure of failures) console.error('  - ' + failure)
process.exit(1)

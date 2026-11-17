/**
 * 用户自定义规则（User-defined rules）——**面板与命令行共用同一份模型**。
 *
 * 为什么这个文件躺在 `extensions/` 而不是 `src/`：
 *   同一段文本要有两个消费者 —— ①host（`index.js` 的 `/rules` 三条路由，浏览器侧没有 fs）；
 *   ②pi 扩展（`extensions/superpi-rules.ts`，把文本追加进系统提示）。扩展会被
 *   `tools/install-pi-extension.mjs` **原样复制**到 `<piAgentDir>/extensions/`，所以它对
 *   同目录兄弟文件的 `./superpi-rules.mjs` 引用在仓库里与安装后必须指向同一份内容。
 *   把共享模块放在 `extensions/` 是唯一能同时满足「两处零复制」与「安装后路径不变」的位置；
 *   放进 `src/` 再复制一份到扩展目录，立刻就是两份真相（改一处、另一处忘改）。
 *
 * 这个文件里**只能有 node 内建依赖**：扩展运行在 pi 的 jiti 里，jiti 的 alias 表只映射
 * `@earendil-works/*` 与 typebox，任何第三方包在这里都会解析失败。
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** 落盘结构版本。将来改结构靠它迁移，不靠猜。 */
export const RULES_VERSION = 1
/** 覆盖落盘路径的环境变量（测试与多套配置共存时用）。 */
export const RULES_ENV = 'SUPERPI_RULES'
/** 默认目录名与文件名（`<home>/.superpi/rules.json`），与 ui-prefs 同一目录。 */
export const RULES_DIR_NAME = '.superpi'
export const RULES_FILE_NAME = 'rules.json'
/**
 * 规则文本上限。
 *
 * 20k 字符 ≈ 5k token：一段「工程守则」远超这个量就说明它该拆成 AGENTS.md 或技能，
 * 而不是每轮都塞进系统提示。上限同时是「挡住把文件撑大 / 把上下文吃光」的防线。
 */
export const MAX_RULES_TEXT = 20000
/** 写进系统提示的 section 名（pi 的 SYSTEM_PROMPT_SECTION_NAME 规则：小写 + 下划线）。 */
export const RULES_SECTION_NAME = 'user_defined_rules'
/** 面板与命令行共用的编辑命令名（命令行里敲 `/superpi-rules`）。 */
export const RULES_COMMAND = 'superpi-rules'

/**
 * 规则块的开场白 —— 「最高优先级」不是口号，是这段文字的功能。
 *
 * 模型读长前缀时对末尾指令的遵循度最高；再加上这一句显式覆盖声明，才能压过
 * 同一份提示里后出现的项目说明（`<project_context>`，AGENTS.md 就落在那儿）。
 * 门禁 `test/rules.mjs` 断言这段存在且位于块首。
 */
export const OVERRIDE_PREFIX =
  '以下规则由用户亲自设定，优先级最高：它们覆盖本提示中的其它任何内容（包括项目说明与默认约定），冲突时一律以本段为准。'

/**
 * 默认规则文本 —— 用户 2026-11 明确给定的原文。
 *
 * 保留用户自己的措辞与编号（「一、」「1.」），因为这是他手写的工作方式；
 * 我们只做两件不改变语义的事：去掉行尾多余空白，以及统一换行。
 * 面板侧**不许**再存一份（`test/rules.mjs` 断言 `client.js` 里没有这些句子）。
 */
export const DEFAULT_RULES_TEXT = [
  'User-defined rules：',
  '思考过程和最后总结使用简体中文回复；',
  '当上下文使用量大于等于50%时，你自己主动无损整理并清理一下无用上下文文件，别让自己忘记最近的细节信息好关键信息以及整体完整任务目标和全维度验收标准，先盘点仓库当前的真实状态，再把上下文整理并记录到项目记忆文件里，然后继续推进，以免上下文过载导致中断和失忆，这是防止跨对话丢失上下文的关键；',
  '调用第一性原理思考、计划、执行任务、系统性结构性解决问题；禁止打补丁，遇到补丁就系统性结构性消除，禁止降级方案，禁止让系统任何维度退化的方案；',
  '调用世界最成功最前沿的UI设计师的UI和交互走查思维模型对UI和交互进行端到端验收；',
  '调用世界最成功公司的架构师的思维模型对当前系统进行全维度优化；',
  '调用世界上最专业的测试专家的思维模型对当前系统进行全维度测试设计和实施；',
  '一切以当前Saas系统架构的最佳实践以及顶尖架构师的思想为基础，该改的就改，该调整的就调整，不要受成本和时间限制；',
  '按行修改，没有100%的信心不要整块代码替换；修改代码时需要确保所修改后的目标代码不影响其它功能；',
  '先写全量全维度测试用例和全量全维度端到端验收文档，再执行任务；',
  '禁止利用目标维度指标的漏洞，你要在理解目标背后的价值的基础上完成目标，而不仅仅是为了完成目标而完成目标，禁止利用削减长期投入，转移成本，操作报表和台账等方式让结果看起来漂亮，这样会让产品失去未来。',
  '如果有后端数据库，则后端数据库层的数据表中都需要有did，更新时间、创建时间字段，业务层的数据表需要有业务编号；did和业务编号的区号必须是在写入数据表的时候取，并进行前中后端与数据表端的唯一性验证，以保证数据的唯一性，注意避免误替换或更新数据表中的数据导致数据错乱；',
  '每完成一个任务，将修改提交到本地github，形成一个新的版本；',
  '未经允许或论证100%不会误伤其它提交，禁止直接跨版本回退，以免弄丢已经做好的内容；',
  '如需回退之前的版本，采用 git revert，而不是 reset --hard，这样历史可追溯、不会误删其他内容。',
  '每次任务需调用任务清单组件，列一个计划任务清单，然后评估任务清单是否严谨，如果是则按照任务清单按步骤执行；',
  '调用第一性原理、世界顶尖设计师和行业国际商业化软件产品最佳实践，使界面中的初始化状态和各种交互状态以及交互之后的状态都能完美显示，保持系统整体视觉一致性；',
  '没有模型时使用mock数据填充，先把流程逻辑全维度跑通；',
  '需要使用或操作浏览器时，请用 专业插件或浏览器扩展 来控制浏览器，如果没有你自己为自己安装；',
  '通过操作浏览器产生的缓存、标签页、弹窗，在确定无价值之后应主动清理或关闭，以减少内存消耗；',
].join('\n')

/** 非法 JSON / 结构不对时给读接口的告警文案（面板据此提示「文件坏了、现在用的是默认」）。 */
export const CORRUPT_WARNING = 'rules.json 读取失败，当前使用默认规则（保存一次即可修复该文件）'

/** 400 语义的错误：路由层按 statusCode 原样回给客户端。 */
function badRequest(message) {
  const error = new Error(message)
  error.statusCode = 400
  return error
}

function nowIso() {
  return new Date().toISOString()
}

/** 等 ms 毫秒（rename 重试退避）。unref 掉计时器，别拖住进程退出。 */
function delay(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isoOrFallback(value, fallback) {
  if (typeof value !== 'string') return fallback
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : fallback
}

/* ------------------------------------------------------------------ 归一 */

/**
 * 文本归一。**必须幂等** —— 否则每次保存都会改 checksum，界面会永远显示「已修改」。
 *
 * 五步，每步都有踩过的理由：
 *  1. 去 BOM：Windows 记事本保存的文件带 `\uFEFF`，它会让首行变成「User-defined rules」前面多一个看不见的字符；
 *  2. 换行统一 `\n`：文件可能被 CRLF 工具改过，混排会让「行数」「首行摘要」两个统计同时失真；
 *  3. 去行尾空白（含全角空格 `\u3000`）：行尾空格在编辑器里看不见，却会让 checksum 每存一次就变；
 *  4. 连续 3+ 空行压成 1 个空行：粘贴进来的文本常带大段空行，白吃 token；
 *  5. 整体 trim：块渲染时会自己补换行，首尾的空行只会让块的边界看起来像坏掉了。
 */
export function normalizeRulesText(input) {
  if (typeof input !== 'string') return ''
  let text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  text = text
    .split('\n')
    .map(line => line.replace(/[ \t\u3000]+$/u, ''))
    .join('\n')
  text = text.replace(/\n{3,}/g, '\n\n')
  return text.trim()
}

/**
 * 「空规则」判定：归一后为空，或除了 `#` 注释行之外没有内容。
 *
 * 为什么要把注释行算成空：用户常把自己的规则「注释掉」来临时关掉某几条，
 * 若按非空处理，pi 每轮都会收到一段只有注释的块 —— 那是纯粹的 token 噪音。
 */
export function isRulesEmptyText(input) {
  const text = normalizeRulesText(input)
  if (text === '') return true
  return text
    .split('\n')
    .every(line => line.trim() === '' || line.trim().startsWith('#'))
}

/** 优先级等级：0 = 空规则（不追加任何东西），1 = 有内容（最高优先级块）。 */
export function rankOf(input) {
  return isRulesEmptyText(input) ? 0 : 1
}

/** 文本指纹：落盘时自己算，不接受客户端提交（否则「追踪表」可以被伪造）。 */
export function checksumOf(input) {
  const text = normalizeRulesText(input)
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/* ------------------------------------------------------------------ 渲染 */

/**
 * 把规则文本渲染成写进 `systemPromptOptions.sections[RULES_SECTION_NAME]` 的**内容**。
 *
 * 返回空串 = 调用方**什么都不用加**（不是加两个空行）—— 空规则必须是「零痕迹」，
 * 否则「清空规则」在提示里反而多出一段空标签。
 *
 * **不自己加 `<user_defined_rules>` 标签**：pi 组装 section 时会把每个 section 包成
 * `<名字>…</名字>`（`dist/core/system-prompt.js`），手动再包一层就是同名标签嵌套两次
 * （实测出来过：`<user_defined_rules><user_defined_rules>`），既费 token 又容易让模型
 * 以为里面那段是「子规则」。标签的唯一来源是 pi。
 *
 * 位置：pi 拼 section 的顺序是 preamble → tools → rules → docs → … → cwd → customSections，
 * 自定义 section **排在最后** —— 所以这段就是整份提示的最末尾，而不是中间插一段。
 */
export function renderRulesBlock(input) {
  const text = normalizeRulesText(input)
  if (isRulesEmptyText(text)) return ''
  return OVERRIDE_PREFIX + '\n\n' + text
}

/* ------------------------------------------------------------------ 解析 */

/**
 * 落盘路径：环境变量 `SUPERPI_RULES` 优先，否则 `<home>/.superpi/rules.json`。
 *
 * 与 `src/ui-prefs.mjs` 同一套语义与同一个目录：面板的「自己的账」都放这儿，
 * 备份/迁移时用户只需要带走一个目录。不写死任何本机绝对路径。
 */
export function resolveRulesPath({ env = process.env, home = homedir() } = {}) {
  const fromEnv = typeof env?.[RULES_ENV] === 'string' ? env[RULES_ENV].trim() : ''
  if (fromEnv !== '') return path.resolve(fromEnv)
  const base = typeof home === 'string' && home.trim() !== '' ? home : homedir()
  return path.join(base, RULES_DIR_NAME, RULES_FILE_NAME)
}

/* -------------------------------------------------------------- 状态归一 */

/**
 * 空状态：默认文案 + 现在这个时刻。
 *
 * `source: 'default'` 表示「文件还不存在，用的是内置默认」，`source: 'file'` 表示读到真文件。
 * 两者的区别对用户有意义：前者是「还没动过」，后者是「动过」，UI 徽标不一样。
 */
export function emptyRulesState({ now = nowIso(), source = 'default' } = {}) {
  const text = DEFAULT_RULES_TEXT
  return {
    version: RULES_VERSION,
    createdAt: now,
    updatedAt: now,
    checksum: checksumOf(text),
    text,
    source,
    drift: false,
  }
}

/**
 * 把任意输入（通常是 `JSON.parse` 的结果）归一成落盘结构。
 *
 * 不抛、不写盘：规则文件坏掉时的正确行为是「回落默认 + 告警」，
 * 而不是让面板打不开、或让 pi 的每一轮都抛一次。超长文本也回落默认而不是截断 ——
 * 截断会静默丢掉用户写的后半段，那比回到默认更糟（默认至少是完整的、能用的）。
 */
export function normalizeRules(raw, { now = nowIso() } = {}) {
  const out = emptyRulesState({ now })
  if (!isPlainObject(raw)) return out
  out.createdAt = isoOrFallback(raw.createdAt, now)
  out.updatedAt = isoOrFallback(raw.updatedAt, out.createdAt)
  if (typeof raw.text !== 'string') return out
  const text = normalizeRulesText(raw.text)
  if (text.length > MAX_RULES_TEXT) return out
  out.text = text
  // checksum 由我们算，不采信文件里那个：手改过的文本必须能被发现。
  const actual = checksumOf(text)
  const stored = typeof raw.checksum === 'string' ? raw.checksum.trim().toLowerCase() : ''
  out.checksum = actual
  out.drift = stored !== '' && stored !== actual
  out.source = 'file'
  return out
}

/**
 * 校验一次写入。「归一之后」再判长度 —— 否则用户粘贴 21000 字符、其中 2000 是空行，
 * 会被拒绝但他看着明明没超。
 *
 * @returns {string} 归一后的文本
 */
export function validateRulesInput(text) {
  if (typeof text !== 'string') throw badRequest('body requires a string text')
  const normalized = normalizeRulesText(text)
  if (normalized.length > MAX_RULES_TEXT) {
    throw badRequest('rules text too long (max ' + String(MAX_RULES_TEXT) + ' chars)')
  }
  return normalized
}

/**
 * 对外视图（HTTP 响应 / 面板初始化都吃这一份）。
 *
 * `empty` 与 `isDefault` 是两件事：
 *  - `isDefault` = 文本与内置默认逐字相同（用户没改过、或刚点了「恢复默认」）；
 *  - `empty`    = 当前不追加任何东西（用户主动清空了）。
 * 混成一个字段会让 UI 无法区分「默认」与「关掉」—— 这两个状态的动作按钮都不一样。
 */
export function rulesView(state, { filePath = '', extensionInstalled = false, warning = '' } = {}) {
  const base = isPlainObject(state) ? state : emptyRulesState()
  const text = typeof base.text === 'string' ? base.text : DEFAULT_RULES_TEXT
  const empty = isRulesEmptyText(text)
  return {
    ok: true,
    version: RULES_VERSION,
    text,
    checksum: typeof base.checksum === 'string' ? base.checksum : checksumOf(text),
    createdAt: typeof base.createdAt === 'string' ? base.createdAt : nowIso(),
    updatedAt: typeof base.updatedAt === 'string' ? base.updatedAt : nowIso(),
    source: base.source === 'file' ? 'file' : 'default',
    drift: base.drift === true,
    isDefault: !empty && normalizeRulesText(text) === DEFAULT_RULES_TEXT,
    empty,
    rank: rankOf(text),
    maxLength: MAX_RULES_TEXT,
    filePath,
    warning: typeof warning === 'string' ? warning : '',
    delivery: { command: '/' + RULES_COMMAND, extensionInstalled: extensionInstalled === true },
  }
}

/* --------------------------------------------------------------- 落盘 IO */

/** rename 重试：Windows 上覆盖一个正被打开的目标会抛 EPERM/EBUSY（杀软、索引器）。 */
const RENAME_ATTEMPTS = 4
const RENAME_RETRY_MS = 30

async function renameWithRetry(from, to) {
  let last = null
  for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt += 1) {
    try {
      await fs.promises.rename(from, to)
      return
    } catch (error) {
      last = error
      const code = error?.code
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw error
      await delay(RENAME_RETRY_MS * (attempt + 1))
    }
  }
  throw last
}

/**
 * 规则存储。语义与 `src/ui-prefs.mjs` 的 store 完全一致（那条路已经跑了一年多）：
 * 写操作串行、原子落盘（tmp + rename）、读盘容错永不抛、写接口只返回全量视图。
 *
 * @param {{ filePath?: string }} [options] filePath 可由调用方注入（测试用临时文件）
 */
export function createRulesStore({ filePath } = {}) {
  const resolved = typeof filePath === 'string' && filePath.trim() !== '' ? path.resolve(filePath) : resolveRulesPath()

  let queue = Promise.resolve()
  const run = task => {
    const result = queue.then(task, task)
    // 队列自身永远保持已兑现：一次 400 不许把后续所有请求一起卡死。
    queue = result.then(() => undefined, () => undefined)
    return result
  }

  /** 读盘 + 容错。返回 `{ state, warning }`：warning 非空表示「文件坏了，用的是默认」。 */
  const loadFromDisk = async () => {
    let text = ''
    try {
      text = await fs.promises.readFile(resolved, 'utf8')
    } catch (error) {
      // ENOENT = 还没写过；权限/是目录等异常同样当「还没有规则」，但要带告警。
      const missing = error?.code === 'ENOENT'
      return { state: emptyRulesState({ source: 'default' }), warning: missing ? '' : CORRUPT_WARNING }
    }
    let parsed = null
    try {
      parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
    } catch {
      return { state: emptyRulesState({ source: 'default' }), warning: CORRUPT_WARNING }
    }
    if (!isPlainObject(parsed)) {
      return { state: emptyRulesState({ source: 'default' }), warning: CORRUPT_WARNING }
    }
    const state = normalizeRules(parsed)
    // 结构合法但字段缺失/类型不对 —— 也算坏文件（用户改了 text 却删了 version 之类）。
    const warning = state.source === 'file' ? '' : CORRUPT_WARNING
    return { state, warning }
  }

  const persist = async state => {
    const dir = path.dirname(resolved)
    await fs.promises.mkdir(dir, { recursive: true })
    const payload = {
      version: RULES_VERSION,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      checksum: state.checksum,
      text: state.text,
    }
    const text = JSON.stringify(payload, null, 2) + '\n'
    const tmp = resolved + '.tmp-' + createHash('sha1').update(String(Date.now()) + String(Math.random())).digest('hex').slice(0, 12)
    try {
      await fs.promises.writeFile(tmp, text, 'utf8')
      await renameWithRetry(tmp, resolved)
    } catch (error) {
      try { await fs.promises.unlink(tmp) } catch { /* tmp 已经不在了 */ }
      throw error
    }
    return state
  }

  /**
   * 写入。相同文本重复写 = 幂等：不写盘、不刷 updatedAt。
   *
   * 为什么要这条：面板的「保存」按钮点两次、或者命令行的两个窗口都点了一次保存，
   * 都会把 updatedAt 往后推 —— 而 UI 上「最后修改于」显示的是它。刷一次没有实际改动，
   * 却让用户以为自己刚才误保存了什么。
   */
  const write = (text, { source = 'file' } = {}) => run(async () => {
    const normalized = validateRulesInput(text)
    const { state: current } = await loadFromDisk()
    if (normalizeRulesText(current.text) === normalized && current.source === 'file') {
      return { state: current, warning: '' }
    }
    const now = nowIso()
    const next = {
      version: RULES_VERSION,
      createdAt: current.source === 'file' && current.createdAt !== '' ? current.createdAt : now,
      updatedAt: now,
      checksum: checksumOf(normalized),
      text: normalized,
      source: source === 'file' ? 'file' : 'default',
      drift: false,
    }
    return { state: await persist(next), warning: '' }
  })

  return {
    filePath: resolved,
    /** 读全量（含告警）。只读不写盘 —— 打开设置页不该产生一次写。 */
    async read() {
      const result = await run(loadFromDisk)
      return { ...result, filePath: resolved }
    },
    /** 写全量返回（含告警位，恒为空串：写成功就没有告警）。 */
    async write(text) {
      const result = await write(text)
      return { ...result, filePath: resolved }
    },
    /** 恢复默认文案。 */
    async reset() {
      const result = await write(DEFAULT_RULES_TEXT)
      return { ...result, filePath: resolved }
    },
  }
}

/* ----------------------------------------------------- 同步读（扩展用） */

/**
 * 同步读取规则文本，供 pi 扩展在 `before_agent_start` 里用。
 *
 * 为什么是 sync：`before_agent_start` 是异步的，但每轮去 `await` 一次 readFile 会给
 * 首 token 加一次 IO 延迟；而这里要读的文件只有几百字节。用 statSync 做 mtime+size
 * 指纹缓存，命中时是纯内存读取，未命中也只是一次小文件读。
 *
 * 为什么永远不抛：规则读不出来绝不能让 pi 的一轮对话直接失败。回落顺序是
 * 文件 → 默认文案（默认文案是完整可用的，所以「读不到」不会让规则消失）。
 *
 * @returns {{ text: string, source: 'default' | 'file', fresh: boolean }}
 */
const textCache = new Map()

export function readRulesTextSync(filePath = resolveRulesPath(), { force = false } = {}) {
  const target = typeof filePath === 'string' && filePath.trim() !== '' ? filePath : resolveRulesPath()
  let signature = ''
  try {
    const stat = fs.statSync(target)
    signature = String(stat.mtimeMs) + ':' + String(stat.size)
  } catch {
    textCache.set(target, { signature: 'missing', text: DEFAULT_RULES_TEXT, source: 'default' })
    return { text: DEFAULT_RULES_TEXT, source: 'default', fresh: true }
  }
  const cached = textCache.get(target)
  if (force !== true && cached !== undefined && cached.signature === signature) {
    return { text: cached.text, source: cached.source, fresh: false }
  }
  let text = DEFAULT_RULES_TEXT
  let source = 'default'
  try {
    const raw = fs.readFileSync(target, 'utf8')
    const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
    const state = normalizeRules(parsed)
    if (state.source === 'file') {
      text = state.text
      source = 'file'
    }
  } catch {
    // 坏文件 → 默认文案（state.text 本来就是默认）
  }
  textCache.set(target, { signature, text, source })
  return { text, source, fresh: true }
}

/** 测试与诊断用：把同步缓存清掉。 */
export function clearRulesCache() {
  textCache.clear()
}

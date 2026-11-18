/**
 * superpi-modalities.mjs —— 每个模型的「模态启用」唯一模型层。
 *
 * ---------------------------------------------------------------------------
 * 这个功能的边界是**协议**划的，不是我们拍的
 *
 * 「具体有哪些模态」必须从模型自己的协议解析，不能硬编码。实测（pi 1.5.2）：
 *
 * | 事实来源 | 结果 |
 * | --- | --- |
 * | `ModelInputModalitySchema`（pi-ai/providers/model-schema） | 只有 `"text" \| "image"` |
 * | `ContentBlock` 联合类型（pi-ai/types） | 只有 `text / thinking / toolCall / image` |
 * | 各 API 适配层分支（openai-* / anthropic / google / bedrock） | 只有 `image` 分支，**没有 audio/video/document** |
 * | 模型库 1773 条记录的 `input` 取值 | 只有 `["text","image"]` / `["text"]` |
 *
 * 所以这里不写死一份模态清单，而是：
 *   ① `RUNTIME_MODALITIES` = **运行时真的能发出去的**模态（今天 text/image）；
 *   ② 每个模型 `available` = `model.input`（协议声明）∩ `RUNTIME_MODALITIES`；
 *   ③ 协议声明了但运行时承载不了的（今天的例子：无）→ 显式标记 `unsupported` + 原因，
 *      **不画假开关**。pi 将来支持音频时，这里自动出现，不用改代码。
 *
 * 这条约束来自用户原则：「禁止利用目标维度指标的漏洞」——一个打开后什么都不发生的
 * 开关，比没有这个开关更糟。
 *
 * ---------------------------------------------------------------------------
 * 开关到底做什么（必须真的发生）
 *
 * 关闭某模态 = **请求发出前，把该模态的 content block 换成一行占位文本**。
 * 效果是可验证的（`test/modalities.mjs` 直接断言 messages 变了），不是只存一个布尔值。
 *
 * `text` 强制开启且不可关：关掉文本等于这个模型不能对话，是纯粹的脚枪，
 * 不是「能力」。它显示为「已开启 · 不可关闭」并写明原因，而不是给一个能点的开关。
 *
 * 落盘 `<home>/.superpi/modalities.json`（`SUPERPI_MODALITIES` 可覆盖），与
 * rules / ui-prefs / context-guard 同目录。只存**非默认值**（稀疏），
 * 所以默认规则将来改了，没动过的模型自动跟随。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const MODALITIES_VERSION = 1

export const MODALITIES_ENV = 'SUPERPI_MODALITIES'
export const MODALITIES_DIR_NAME = '.superpi'
export const MODALITIES_FILE_NAME = 'modalities.json'

/**
 * 运行时能真正承载的输入模态。
 *
 * **不要凭印象往这里加。** 加一项的前提是：pi 的 `ContentBlock` 联合类型里有对应的块、
 * 且至少一个 API 适配层能把它序列化出去。`test/modalities.mjs` 会去读 pi 的类型声明
 * 对账，对不上就红 —— 这样「清单过期」会自己暴露，而不是变成静默的假开关。
 */
export const RUNTIME_MODALITIES = ['text', 'image']

/** 默认开启的模态（用户要求：文本与图像默认开，其它默认关）。 */
export const DEFAULT_ENABLED_MODALITIES = ['text', 'image']

/** 不可关闭的模态：关掉它就没有对话可言。 */
export const LOCKED_MODALITIES = ['text']

/** 各模态的一行说明（两端 UI 共用，避免各写一份措辞）。 */
export const MODALITY_LABELS = {
  text: { zh: '文本', en: 'Text', reasonZh: '对话的必需通道，不可关闭', reasonEn: 'Required channel — cannot be disabled' },
  image: { zh: '图像', en: 'Image', reasonZh: '', reasonEn: '' },
}

export function modalityLabel(id, locale = 'zh') {
  const entry = MODALITY_LABELS[id]
  if (entry === undefined) return String(id)
  return locale === 'en' ? entry.en : entry.zh
}

export function modalityReason(id, locale = 'zh') {
  const entry = MODALITY_LABELS[id]
  if (entry === undefined) return ''
  return locale === 'en' ? entry.reasonEn : entry.reasonZh
}

/* -------------------------------------------------- 协议解析（唯一真相） */

/**
 * 从模型对象解析模态能力。**只读，不猜**。
 *
 * 返回：
 *   `declared`    模型协议声明支持的（`model.input`，按 RUNTIME 顺序归一）
 *   `available`   可开关的 = declared ∩ RUNTIME_MODALITIES
 *   `unsupported` declared 里运行时承载不了的（带原因）—— 显式暴露，不装看不见
 *   `locked`      在 available 里但不可关闭的（text）
 *   `effective`   available 里的最终开关状态：用户覆盖 > 默认
 */
export function resolveModelModalities(model, overrides = {}) {
  const declaredRaw = Array.isArray(model?.input) ? model.input : []
  const declaredSet = new Set()
  for (const item of declaredRaw) {
    if (typeof item === 'string' && item !== '') declaredSet.add(item)
  }
  // 顺序跟 RUNTIME_MODALITIES 走：界面上「文本」永远在「图像」前面，不随协议数组顺序抖动。
  const declared = RUNTIME_MODALITIES.filter(id => declaredSet.has(id))
  const unknownDeclared = [...declaredSet].filter(id => !RUNTIME_MODALITIES.includes(id))

  /**
   * 拿不到协议声明时（第三方 provider 没给 `input`、或调用方只传了个裸对象），
   * **按产品默认处理**（文本 + 图像开启），而不是「一个都不能用」。
   *
   * 这条不是兜底美化：如果不这样做，`allowed` 会变成空集，请求前会把图片全剥掉
   * —— 对「本来支持图像、只是元数据缺失」的模型就是**凭空降级**。宁可不动。
   */
  const hasDeclaration = declared.length > 0
  const available = hasDeclaration ? declared.slice() : DEFAULT_ENABLED_MODALITIES.slice()

  const overridesForModel = overrides !== null && typeof overrides === 'object' ? overrides : {}
  const entries = []
  for (const id of available) {
    const locked = LOCKED_MODALITIES.includes(id)
    const override = overridesForModel[id]
    const fallback = DEFAULT_ENABLED_MODALITIES.includes(id)
    const enabled = locked ? true : (typeof override === 'boolean' ? override : fallback)
    entries.push({
      id,
      enabled,
      locked,
      isDefault: typeof override !== 'boolean' || (locked === true),
      reason: locked ? modalityReason(id) : '',
    })
  }
  return {
    declared,
    declaredByProtocol: hasDeclaration,
    available,
    entries,
    unsupported: unknownDeclared.map(id => ({
      id,
      reason: '模型协议声明了该模态，但 pi 运行时没有对应的内容块类型，无法发送',
      reasonEn: 'Declared by the model protocol, but the pi runtime has no content block for it',
    })),
  }
}

/** 该模型实际允许的模态 id 集合（供请求前过滤用）。 */
export function allowedModalities(model, overrides = {}) {
  const resolved = resolveModelModalities(model, overrides)
  return new Set(resolved.entries.filter(entry => entry.enabled === true).map(entry => entry.id))
}

/* ---------------------------------------------------------- 状态归一化 */

const clampString = (value, fallback) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback)

/** 模型的稳定键：`provider/id`。同一 id 在不同 provider 下是不同模型。 */
export function modelKey(model) {
  const provider = clampString(model?.provider, '')
  const id = clampString(model?.id, '')
  if (id === '') return ''
  return provider === '' ? id : provider + '/' + id
}

/**
 * 归一化落盘状态。**必须幂等**：面板每次读都过这里，不幂等会让「读一次变一点」。
 * 只保留 RUNTIME_MODALITIES 里的、布尔值的、且与默认值不同的项（稀疏存储）。
 */
export function normalizeModalitiesState(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const models = source.models !== null && typeof source.models === 'object' ? source.models : {}
  const cleaned = {}
  for (const [key, value] of Object.entries(models)) {
    if (typeof key !== 'string' || key.trim() === '') continue
    if (value === null || typeof value !== 'object') continue
    const entry = {}
    for (const id of RUNTIME_MODALITIES) {
      const flag = value[id]
      if (typeof flag !== 'boolean') continue
      // locked 的模态不接受覆盖（存了也不认，避免出现「文件里说关、界面上说不可关」）。
      if (LOCKED_MODALITIES.includes(id)) continue
      // 与默认值相同的项直接不存：默认规则将来调整时，没动过的模型自动跟随。
      if (flag === DEFAULT_ENABLED_MODALITIES.includes(id)) continue
      entry[id] = flag
    }
    if (Object.keys(entry).length > 0) cleaned[key.trim()] = entry
  }
  return { version: MODALITIES_VERSION, models: cleaned }
}

export function resolveModalitiesPath({ env = process.env, home = os.homedir() } = {}) {
  const fromEnv = typeof env?.[MODALITIES_ENV] === 'string' ? env[MODALITIES_ENV].trim() : ''
  if (fromEnv !== '') return path.resolve(fromEnv)
  const base = typeof home === 'string' && home.trim() !== '' ? home : os.homedir()
  return path.join(base, MODALITIES_DIR_NAME, MODALITIES_FILE_NAME)
}

/** 同步读（扩展每轮用，mtime+size 缓存）。**永不抛**：坏文件按默认处理。 */
export function readModalitiesStateSync({ env = process.env, home = os.homedir(), cache = null } = {}) {
  const filePath = resolveModalitiesPath({ env, home })
  try {
    const stat = fs.statSync(filePath)
    if (cache !== null && typeof cache === 'object' && cache.path === filePath &&
      cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
      return cache.state
    }
    const state = normalizeModalitiesState(JSON.parse(fs.readFileSync(filePath, 'utf8')))
    if (cache !== null && typeof cache === 'object') {
      cache.path = filePath
      cache.mtimeMs = stat.mtimeMs
      cache.size = stat.size
      cache.state = state
    }
    return state
  } catch {
    return normalizeModalitiesState({})
  }
}

/** 取某模型的覆盖表（不存在就是空对象 = 全默认）。 */
export function overridesFor(state, model) {
  const key = modelKey(model)
  if (key === '') return {}
  const models = state !== null && typeof state === 'object' && state.models !== null && typeof state.models === 'object'
    ? state.models
    : {}
  const entry = models[key]
  return entry !== null && typeof entry === 'object' ? entry : {}
}

/* ------------------------------------------------------------------ 过滤 */

/** 模态关闭后被替换成的占位行（模型看到它，就知道这里原本有什么）。 */
export function modalityOmittedText(id, { filePath = '' } = {}) {
  const where = filePath !== '' ? ': ' + filePath : ''
  const name = modalityLabel(id, 'en')
  return `[${name.toLowerCase()} content omitted${where} — this model's ${name.toLowerCase()} modality is disabled in SuperPi settings]`
}

/**
 * 按允许集合过滤消息里的 content block。**非破坏性**：返回新数组，不改入参。
 *
 * 只处理「模型看不到就会误解」的两种块：
 *   - `image` → 换成一行占位（这是唯一有实际开销的模态）
 *   - 其它未知模态 → 原样保留（不认识的不要乱删，删错比不删更糟）
 *
 * `text` 永不过滤（即便调用方传了不含 text 的集合，也不会把对话清空）。
 */
export function filterMessagesByModalities(messages, allowed) {
  const list = Array.isArray(messages) ? messages : []
  const allow = allowed instanceof Set ? allowed : new Set(Array.isArray(allowed) ? allowed : RUNTIME_MODALITIES)
  if (allow.has('image') && allow.has('text')) return list
  let touched = 0
  const next = list.map(message => {
    const content = message?.content
    if (!Array.isArray(content)) return message
    let changed = false
    const blocks = content.map(block => {
      if (block === null || typeof block !== 'object') return block
      if (block.type === 'image' && allow.has('image') !== true) {
        changed = true
        return { type: 'text', text: modalityOmittedText('image') }
      }
      return block
    })
    if (!changed) return message
    touched += 1
    return { ...message, content: blocks }
  })
  return touched === 0 ? list : next
}

/* -------------------------------------------------------------- 写盘层 */

/**
 * 写入层：串行队列 + tmp/rename 原子落盘 + 读盘容错。
 * 一次 400 不许把后续写请求一起卡死（队列自身永远已兑现）。
 */
export function createModalitiesStore({ filePath } = {}) {
  const resolved = typeof filePath === 'string' && filePath.trim() !== '' ? path.resolve(filePath) : resolveModalitiesPath()
  let queue = Promise.resolve()
  const run = task => {
    const result = queue.then(task, task)
    queue = result.then(() => undefined, () => undefined)
    return result
  }

  const load = async () => {
    try {
      return normalizeModalitiesState(JSON.parse(await fs.promises.readFile(resolved, 'utf8')))
    } catch {
      return normalizeModalitiesState({})
    }
  }

  const save = async state => {
    await fs.promises.mkdir(path.dirname(resolved), { recursive: true })
    const tmp = resolved + '.' + process.pid + '.tmp'
    await fs.promises.writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
    await fs.promises.rename(tmp, resolved)
    return state
  }

  return {
    path: resolved,
    read: async () => load(),
    /**
     * 切换某模型某模态。`enabled === null` 表示「清掉覆盖、回到默认」。
     * 返回归一化后的完整状态。
     */
    set: (model, modality, enabled) => run(async () => {
      const key = modelKey(model)
      if (key === '') {
        const failure = new Error('model requires id')
        failure.statusCode = 400
        throw failure
      }
      if (!RUNTIME_MODALITIES.includes(modality)) {
        const failure = new Error('unknown modality: ' + String(modality))
        failure.statusCode = 400
        throw failure
      }
      if (LOCKED_MODALITIES.includes(modality) && enabled !== null) {
        const failure = new Error('modality cannot be changed: ' + String(modality))
        failure.statusCode = 400
        throw failure
      }
      const state = await load()
      const models = { ...state.models }
      const entry = { ...(models[key] ?? {}) }
      if (enabled === null) delete entry[modality]
      else entry[modality] = enabled === true
      if (Object.keys(entry).length === 0) delete models[key]
      else models[key] = entry
      return save(normalizeModalitiesState({ version: MODALITIES_VERSION, models }))
    }),
  }
}

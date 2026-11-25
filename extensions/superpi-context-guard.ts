/**
 * superpi-context-guard.ts —— 把「请求前窗口化」接到 pi 的 `context` 事件上。
 *
 * 装法：`npm run superpi:editor`（与输入框、规则扩展一起装到 `<piAgentDir>/extensions/`）
 *
 * ---------------------------------------------------------------------------
 * 为什么必须挂 `context` 事件
 *
 * `context` 在**每次 LLM 调用前**触发，拿到的是 messages 的深拷贝（不含系统提示），
 * 返回值直接决定这一次请求发什么。它不写 session、不改历史、不消耗 token —— 正是
 * 「超限时唯一还能成功执行的动作」：压缩要调模型（模型正是被超限挡住的），重试要重发
 * 同样内容（同样超限），而裁剪是本地的、确定性的、必然成功。
 *
 * 两端一致：TUI 与 RPC 共用同一个 agent loop，这个事件**两边都触发**，所以不需要为
 * 面板与命令行各写一套（AGENTS.md 第 3 节的 100% 对齐在这里是结构性成立的，不是靠人守）。
 *
 * ---------------------------------------------------------------------------
 * 刻意不做的事
 *  - 不 import `@earendil-works/*`：只依赖 `pi.on` / `pi.registerCommand` / `ctx.*`，
 *    多份 pi 副本都能加载，也能在 `test/context-guard.mjs` 里用假 pi 单测。
 *  - 不改 pi 任何文件、不碰 node_modules、不写 session。
 *  - 任何异常都吞掉：守护失效最多是"没裁剪"，绝不能让一轮对话因为守护本身而失败。
 *  - 未发生裁剪时返回 `undefined`（不是 `{ messages: same }`）：保持 pi 原有的
 *    系统提示重放行为，避免无谓的 prompt cache 变更。
 */

import { randomUUID } from 'node:crypto'
import {
  DEFAULT_GUARD_SETTINGS,
  GUARD_VERSION,
  appendGuardLogSync,
  applyHygieneToOptions,
  estimateMessagesTokens,
  normalizeGuardSettings,
  planContextWindow,
  readGuardLogSync,
  readGuardSettingsSync,
  resolveGuardPath,
  protectedFromIndex,
  applyMeterToOptions,
  breakdownMessages,
  goalFromMessages,
  limitImagesForWrite,
  imagePlaceholder,
  foldCompletedWriteArgs,
  projectTurnAssistant,
  resetMeterMemo,
} from './superpi-context-guard.mjs'
import {
  allowedModalities,
  filterMessagesByModalities,
  overridesFor,
  readModalitiesStateSync,
} from './superpi-modalities.mjs'

export const GUARD_COMMAND = 'superpi-context'

/** 模型没声明 contextWindow 时的兜底（当前上游实测上限 1048576）。 */
export const FALLBACK_WINDOW_TOKENS = 1048576

/** 同一会话内两次日志之间的最小间隔（一次 agent loop 可能调用多次 LLM）。 */
const LOG_THROTTLE_MS = 5000

function formatTokens(value) {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : 0
  if (number >= 1000000) return (number / 1000000).toFixed(2) + 'M'
  if (number >= 1000) return Math.round(number / 1000) + 'k'
  return String(number)
}

function resolveWindowTokens(ctx, settings) {
  const fromModel = Number(ctx?.model?.contextWindow)
  if (Number.isFinite(fromModel) && fromModel > 0) return Math.round(fromModel)
  if (settings.windowTokens > 0) return settings.windowTokens
  return FALLBACK_WINDOW_TOKENS
}

function summarize(stats) {
  const parts = []
  if (stats.stages.images > 0) parts.push(stats.stages.images + ' 条含图消息改为占位')
  if (stats.stages.thinking > 0) parts.push(stats.stages.thinking + ' 条思考已丢弃')
  if (stats.stages.toolText > 0) parts.push(stats.stages.toolText + ' 条工具结果已截断')
  if (stats.stages.replies > 0) parts.push(stats.stages.replies + ' 条旧回复已折叠')
  return parts.length === 0 ? '无需裁剪' : parts.join('，')
}

export default function contextGuard(pi) {
  const cache = { path: '', mtimeMs: 0, size: 0, settings: normalizeGuardSettings(DEFAULT_GUARD_SETTINGS) }
  const modalityCache = { path: '', mtimeMs: 0, size: 0, state: null }
  let lastLoggedAt = 0
  let lastStats = null
  /**
   * 上一轮请求的「仪表素材」（0.15.0）。
   *
   * 由 `context` 事件写入、`before_agent_start` 读取 —— 因为前者有 messages、
   * 后者有 systemPromptOptions，两者都不具备对方的输入（见 types.d.ts:738-760）。
   * 初值 null 表示"还没有过一次请求"，此时 `before_agent_start` 不注入仪表
   * （宁缺勿造：窗口未知时算出来的百分比会是假的）。
   */
  let lastMeterSnapshot: null | {
    settings: ReturnType<typeof normalizeGuardSettings>
    windowTokens: number
    breakdown: { text: number; thinking: number; toolResult: number; toolCallArgs: number; images: number; total: number }
    reservedOverhead: number
    goal: string
    afterTokens: number
  } = null

  /**
   * 写入时图片限额的累计状态（0.17.0）。
   *
   * ── 为什么必须是进程内状态 ────────────────────────────────
   *
   * `tool_result` 的 event **不含会话历史**（只有当前这一条工具结果），
   * pi 也**没有**提供改写历史的 API。而「本会话已经留下几张图」正是需要跨
   * 多次 `tool_result` 共享的事实，只能由扩展自己记账。
   *
   * ── 为什么第一版做错了（记下来，避免重犯）───────────────
   *
   * 第一版按「单条消息内的图片数」限额，实测**收益为 0**：真实会话是
   * **118 条消息各含 1 张图**，不是 1 条含 118 张 —— 每条都没超限额，一条都不改。
   * 这个错误是被 `_scratch/probe-write-limit-gain.mjs` 当场抓出来的，
   * 不是靠推理发现的。所以「先写探针量收益」这一步不能省。
   *
   * ── 为什么要在会话切换时清零 ──────────────────────────────
   *
   * `kept` 的语义是「当前这棵会话树里还留着的图片数」。`/new`、`switch_session`、
   * `fork`、`clone` 会在**同一进程**内换掉整棵会话树；不清零就会把旧会话的
   * 记账带进新会话，导致新会话一开始就"额度已满、一张图都不留"——
   * 那是比不限额更糟的静默失效。
   */
  const writeImageCounter = { kept: 0, dropped: 0 }
  // The transcript can keep a bounded set of bitmaps. Later images still reach the active model
  // through short-lived references to exact tool results. Re-reading a path obtains fresh bytes.
  const liveImages = new Map<string, { toolCallId: string; image: { type: 'image'; mimeType: string; data: string } }>()

  const restoreLiveImages = (messages, limit) => {
    while (liveImages.size > limit) liveImages.delete(liveImages.keys().next().value!)
    if (liveImages.size === 0) return messages
    const calls = new Set(Array.from(liveImages.values(), item => item.toolCallId))
    let restored = messages
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index]
      if (message?.role !== 'toolResult' || !calls.has(message.toolCallId) || !Array.isArray(message.content)) continue
      const content = message.content.map(block => block?.type === 'text' ? liveImages.get(block.text)?.image ?? block : block)
      if (content.every((block, i) => block === message.content[i])) continue
      if (restored === messages) restored = messages.slice()
      restored[index] = { ...message, content }
    }
    return restored
  }

  pi.on('context', (event, ctx) => {
    try {
      const messages = Array.isArray(event?.messages) ? event.messages : []
      if (messages.length === 0) return undefined

      // ① 模态开关（用户显式策略）**先于**窗口化：关掉的模态本来就不该发出去，
      //    先剥掉能让后面的预算少算一大块（图片是最贵的那部分）。
      //    这一层不受 `enabled` 影响 —— 用户关掉某个模态是明确指令，不该被"先停用窗口化"一起带走。
      const modalityState = readModalitiesStateSync({ cache: modalityCache })
      const model = ctx?.model
      const allowed = allowedModalities(model, overridesFor(modalityState, model))
      const settings = readGuardSettingsSync({ cache })
      const input = settings.enabled && allowed.has('image') ? restoreLiveImages(messages, settings.keepRecentImagesPerTurn) : messages
      const filtered = filterMessagesByModalities(input, allowed)

      // ② 窗口化（可独立停用）
      let next = filtered
      if (settings.enabled === true) {
        const windowTokens = resolveWindowTokens(ctx, settings)
        const planned = planContextWindow(filtered, { windowTokens, settings })
        next = planned.messages
        lastStats = planned.stats
        /**
         * 记下本轮的仪表素材（0.15.0）。
         *
         * 为什么不直接在 `before_agent_start` 里算：那个事件的类型定义
         * （`core/extensions/types.d.ts:738-760`）**只有 `systemPrompt` /
         * `systemPromptOptions` / `prompt` / `message`，没有 messages** ——
         * 拿不到历史就没法统计占用。而 `context` 事件是唯一能看到完整 messages 的地方，
         * 所以在这里算好存起来，下一轮 `before_agent_start` 直接取用。
         *
         * 时序上是自洽的：`context` 每次 LLM 调用前触发，`before_agent_start`
         * 只在一轮开始时触发一次 —— 所以仪表反映的是"上一次请求的真实规模"，
         * 而这正是模型需要的（它要知道自己现在有多满）。
         */
        lastMeterSnapshot = {
          settings,
          windowTokens,
          // 记裁剪**前**的规模：模型该知道"如果不守会是多少"，而不是被守卫美化后的数字。
          breakdown: breakdownMessages(filtered, settings),
          reservedOverhead: planned.stats.reservedOverhead,
          goal: goalFromMessages(filtered),
          afterTokens: planned.stats.after,
        }
        if (planned.stats.trimmed === true) {
          const now = Date.now()
          if (now - lastLoggedAt >= LOG_THROTTLE_MS) {
            lastLoggedAt = now
            const sessionId = typeof ctx?.sessionManager?.getSessionId === 'function'
              ? String(ctx.sessionManager.getSessionId() ?? '')
              : ''
            appendGuardLogSync({ ...planned.stats, sessionId })
          }
        }
      }

      // 未修改内容时保留 Pi 的提示增量和缓存。
      if (next === messages) return undefined
      return { messages: next }
    } catch {
      // 守护是"止损"，不是"必经"：任何异常都退回 pi 的原始行为。
      return undefined
    }
  })

  /**
   * 把「图片用完即弃」送进系统提示。
   *
   * 只裁剪不说，模型不知道自己的图已经被换成占位 —— 它会以为图还在，于是反复 read
   * 同一张图，继续制造大块内容。这条把「生产端」也管住：模型自己知道看完就该写结论、
   * 该把中间产物归档，而不是等扩展每次都帮它收拾。
   *
   * 用 sections（不是 systemPrompt）：pi 会对 section 做 diff，只有变化的段才作为补丁
   * 发出；返回整份 prompt 会走 forceSystemPrompt，每轮一次缓存 miss。
   */
  /**
   * 写入时图片限额（0.17.0）—— 在图片**进入历史那一刻**就换成路径占位。
   *
   * ── 为什么这一条不能省（取证见 docs/context-overload.md）──────────
   *
   * 上面的 `context` 监听是**读时**钩子，pi 对它的契约是
   * "Modify messages **non-destructively**"：每轮从完整历史重算。
   * 实测一个真实会话的 240 轮裁剪日志：
   *
   *   · `before` 恒定 2,849,944 ~ 2,919,604 tokens（几乎不涨）
   *   · `imagesDropped` **只有一个取值：117**（总图 118，只留 1 张）
   *   · 压缩比恒定 4.40x
   *
   * 两个"恒定"= 每轮重算同一件事。压到 65 万发出去，历史本体仍是 285 万，
   * 下轮从头再切。裁剪本身没错（它保证了不超限），但它**改不动历史**，
   * 所以永远无法降低 `before`。
   *
   * `tool_result` 是 pi 唯一在「工具执行结束、最终 toolResult 写入之前」触发的钩子，
   * 且明确 "Can modify result"（docs/extensions.md:1040）。在这里处置，
   * 图片根本不会以位图形式进入历史。
   *
   * 更新图片块时显式传回已有的 structuredContent。Pi 在 content 被替换时会丢弃
   * 未随变更提供的结构化值。details 和 isError 沿用原工具的结果。
   * 无需改动时返回 `undefined`（不是 `{ content }`），避免无谓补丁。
   */
  pi.on('tool_result', (event, _ctx) => {
    try {
      const settings = readGuardSettingsSync({ cache })
      if (settings.enabled !== true) return undefined
      const input = event?.input
      const filePath = input !== undefined && input !== null && typeof input.path === 'string' ? input.path : ''
      const next = limitImagesForWrite(event?.content, filePath, settings, writeImageCounter, (location, image) => {
        const placeholder = imagePlaceholder(location)
        if (settings.keepRecentImagesPerTurn === 0) return placeholder
        const reference = placeholder + ' (image ' + randomUUID() + ')'
        liveImages.set(reference, { toolCallId: event.toolCallId, image })
        if (liveImages.size > settings.keepRecentImagesPerTurn) liveImages.delete(liveImages.keys().next().value!)
        return reference
      })
      if (next === null) return undefined
      // Replacing content otherwise drops Pi's structured result, even when it has no image data.
      const structuredContent = event?.structuredContent
      return structuredContent === undefined ? { content: next } : { content: next, structuredContent }
    } catch {
      // 与其它钩子同一原则：守护失效最多是"没限额"，绝不能让一轮对话因此失败。
      return undefined
    }
  })

  pi.on('turn_end', (event) => {
    const { toolResults, outcome } = event
    if (outcome !== 'completed' || toolResults.length === 0) return undefined
    if (!readGuardSettingsSync({ cache }).enabled) return undefined
    return projectTurnAssistant(event, message => foldCompletedWriteArgs(message, toolResults))
  })

  pi.on('before_agent_start', (event, _ctx) => {
    try {
      const settings = readGuardSettingsSync({ cache })
      // ① 行为准则（该怎么做）
      const hygiene = applyHygieneToOptions(event?.systemPromptOptions, settings)
      /**
       * ② 状态事实（现在什么情况）：目标 + 上下文占用；≥50% 时给按类拆解。
       *
       * 为什么必须进系统提示：模型看不见自己的上下文规模，只能在"感觉快满了"时
       * 才想起整理 —— 而那时往往已经撞墙（本会话实测到过 77.6%，距 1M 硬墙仅 22%）。
       * 把仪表每轮摆在它面前，它才能在还来得及的时候自己决定"少制造大块内容 / 先收尾"。
       *
       * 数据来源：`context` 事件写下的 `lastMeterSnapshot`（那个事件才有 messages）。
       * 没有快照就不注入 —— 不编造一个假的百分比。
       */
      const snapshot = lastMeterSnapshot
      // 停用（enabled=false）时两段都不注入：用户的开关必须是彻底的，
      // 不能"准则注不进但仪表还在" —— 那会让「关掉守卫」变成一个半真的状态。
      if (settings.enabled !== true) {
        // 顺手清掉先前可能注入过的仪表段（用户是中途关的）。
        const stale = applyMeterToOptions(event?.systemPromptOptions, { settings, windowTokens: 0 })
        if (hygiene === null && stale === null) return undefined
        return {}
      }
      const meter = snapshot === null
        ? null
        : applyMeterToOptions(event?.systemPromptOptions, {
          settings: snapshot.settings,
          windowTokens: snapshot.windowTokens,
          breakdown: snapshot.breakdown,
          reservedOverhead: snapshot.reservedOverhead,
          goal: snapshot.goal,
          afterTokens: snapshot.afterTokens,
        })
      if (hygiene === null && meter === null) return undefined
      return {}
    } catch {
      return undefined
    }
  })

  /**
   * 会话切换时清掉上一轮的统计与仪表快照（0.15.0）。
   *
   * 为什么必须清：`lastStats` / `lastMeterSnapshot` 是本进程级的缓存，
   * 而 `/new`、`switch_session`、`fork` 会在**同一个进程**里换掉整棵会话树。
   * 不清的话新会话第一轮就会显示旧会话的占用（实测过的串台形态），
   * 而模型会据此误判"我已经很满了"，进而做出保守/错误的决策。
   *
   * 只清缓存，不动设置与日志 —— 设置是用户的，日志是观测记录。
   */
  const resetSessionCaches = () => {
    lastStats = null
    lastMeterSnapshot = null
    lastLoggedAt = 0
    // 仪表记忆也必须清：新会话的系统提示是全新的，
    // 留着旧文本会让它误判"已经写过同样内容"而跳过注入。
    resetMeterMemo()
    /**
     * 写入时图片额度也必须清零（0.17.0）。
     *
     * `kept` 记的是「当前这棵会话树里还留着几张图」。`/new`、`switch_session`、
     * `fork`、`clone` 在同一进程里换掉整棵树，不清零就会把旧会话的记账带过去，
     * 让新会话一开始就"额度已满、一张图都不留" —— 比不限额更糟的静默失效。
     */
    writeImageCounter.kept = 0
    writeImageCounter.dropped = 0
    liveImages.clear()
  }
  pi.on('session_start', resetSessionCaches)
  pi.on('session_switch', resetSessionCaches)

  pi.registerCommand(GUARD_COMMAND, {    description: '查看上下文窗口化状态（真实占用 / 已释放多少 / 保留多少轮）',
    handler: async (_args, ctx) => {
      try {
        const settings = readGuardSettingsSync({ cache })
        const lines = []
        lines.push('版本 ' + GUARD_VERSION + ' · ' + (settings.enabled ? '已启用' : '已停用'))
        lines.push('设置文件：' + resolveGuardPath())
        lines.push('目标预算：窗口的 ' + Math.round(settings.targetRatio * 100) + '% · 保留最近 ' +
          settings.keepRecentTurns + ' 轮 / ' + settings.keepRecentImages + ' 张图')
        if (lastStats !== null) {
          lines.push('最近一次请求：' + formatTokens(lastStats.before) + ' → ' + formatTokens(lastStats.after) +
            '（窗口 ' + formatTokens(lastStats.window) + '）· ' + summarize(lastStats))
          if (lastStats.overBudget === true) {
            lines.push('注意：已裁到最狠仍超预算，建议 /compact 或换更大窗口的模型。')
          }
        } else {
          lines.push('本次进程还没有发出过请求。')
        }
        const log = readGuardLogSync({ limit: 3 })
        if (log.length > 0) {
          const last = log[log.length - 1]
          lines.push('观测日志最近一行：' + formatTokens(last.before) + ' → ' + formatTokens(last.after))
        }
        const text = lines.join('\n')
        if (ctx?.ui?.editor !== undefined) {
          await ctx.ui.editor('上下文窗口化', text)
        } else if (ctx?.ui?.notify !== undefined) {
          ctx.ui.notify(text, 'info')
        }
      } catch {
        // 命令面板失败也不能影响会话。
      }
    },
  })
}

/** 供测试使用：不启动 pi 也能算「受保护边界」。 */
export { protectedFromIndex, estimateMessagesTokens }

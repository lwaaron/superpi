/**
 * superpi-context-guard.ts —— 把「请求前窗口化」接到 pi 的 `context` 事件上。
 *
 * 装法：`npm run pi:editor`（与输入框、规则扩展一起装到 `<piAgentDir>/extensions/`）
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
} from './superpi-context-guard.mjs'

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
  let lastLoggedAt = 0
  let lastStats = null

  pi.on('context', (event, ctx) => {
    try {
      const settings = readGuardSettingsSync({ cache })
      if (settings.enabled !== true) return undefined
      const messages = Array.isArray(event?.messages) ? event.messages : []
      if (messages.length === 0) return undefined
      const windowTokens = resolveWindowTokens(ctx, settings)
      const { messages: next, stats } = planContextWindow(messages, { windowTokens, settings })
      if (stats.trimmed !== true) {
        lastStats = stats
        return undefined
      }
      lastStats = stats
      const now = Date.now()
      if (now - lastLoggedAt >= LOG_THROTTLE_MS) {
        lastLoggedAt = now
        appendGuardLogSync(stats)
      }
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
  pi.on('before_agent_start', (event, _ctx) => {
    try {
      const settings = readGuardSettingsSync({ cache })
      const applied = applyHygieneToOptions(event?.systemPromptOptions, settings)
      return applied === null ? undefined : applied
    } catch {
      return undefined
    }
  })

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

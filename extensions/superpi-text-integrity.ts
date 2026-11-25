/**
 * 写入闸：模型产出的坏字节**不落盘**（0.18.0）。
 *
 * 装法：`npm run superpi:editor`（与输入框、规则、守卫、模态一起装到 `<piAgentDir>/extensions/`）
 *
 * ---------------------------------------------------------------------------
 * 为什么需要它（取证见 `docs/output-integrity.md`）
 *
 * 20 个真实会话（2026-11-19~11-23）里，**7 次 `write` 的 content 含 U+FFFD，
 * 7 次全部成功落盘**；另有 15 次 `bash` 命令含坏字节、13 次执行成功。
 * 落盘之后一切都晚了：坏字符不可逆（U+FFFD 里没有原字符的信息），
 * 只能靠人读回来、或用 `git` 回滚 —— 这正是用户报的「代码错乱」。
 *
 * 修法不是「检测到就修」，而是**不让它进来**。用的是 pi 的官方扩展点
 * `pi.on('tool_call')`（`docs/extensions.md:973`，契约明确 "Can block"
 * 且 `event.input` 可原地改写），所以这是配置/扩展面，不是给 pi 打补丁。
 *
 * ---------------------------------------------------------------------------
 * 为什么只拦 `write.content` 与 `edit.edits[].newText`
 *
 * 因为这两处是「**即将成为文件内容的新字节**」，语义无歧义：
 *
 *   · `write.content`          —— 整份文件内容
 *   · `edit.edits[].newText`   —— 每处替换的新文本
 *
 * 三条边界是刻意划的，每一条都有代价考量：
 *
 *   ① **不看 `edit.edits[].oldText`。** 修复一个已经被写坏的文件时，
 *      匹配串里**必须**允许出现 U+FFFD —— 拦它等于禁止修复。
 *   ② **不拦 `bash` / `powershell` 的命令串。** 同一串字节可能正是修复脚本
 *      （`perl -pi -e 's/\x{FFFD}//g'`、`grep -rn $'\uFFFD'`），拦它同样是禁止修复。
 *      改成在 `tool_result` 末尾追加一行警告：**让模型当场知道**，而不是拦死。
 *   ③ **不按扩展名区别对待。** `.md` / `.json` / `.ts` / 无扩展名，规则相同 ——
 *      坏字节在任何文本文件里都是损坏，按扩展名分流只会留下"没被覆盖的格式"。
 *
 * 为什么拦截**不减少任何能力**：坏字符永远可以用转义表达（`\uFFFD`）。
 * 被拦下的不是"能力"，是"一个不可逆的损坏动作"。
 *
 * ---------------------------------------------------------------------------
 * 失败面（任何异常都不许让一轮对话失败）
 *
 * 判据是纯函数，异常只可能来自日志落盘。日志写不进去时**照拦**（拦截优先于记账），
 * 吞掉异常即可 —— 与守卫/规则两个扩展同一原则。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { projectTurnAssistant } from './superpi-context-guard.mjs'
import { describeBytes, scanTextBytes, summarizeCounts } from './superpi-text-bytes.mjs'

/** 与 package.json / CONTRACT_VERSION 同步推进。 */
export const INTEGRITY_VERSION = '0.44.0'

/** TUI 命令名（`/superpi-integrity`）。 */
export const INTEGRITY_COMMAND = 'superpi-integrity'

/** 与 ui-prefs / rules / guard 同目录（`<home>/.superpi`）。 */
export const INTEGRITY_DIR_NAME = '.superpi'
export const INTEGRITY_LOG_NAME = 'integrity.log.jsonl'
/** 日志滚动上限。240 行≈一周的偶发记录，够定位又不占空间。 */
export const INTEGRITY_LOG_MAX_LINES = 240

/** 解析日志路径。`SUPERPI_INTEGRITY`（完整文件路径）可覆盖，与其它三个扩展同一套约定。 */
export function resolveIntegrityPath(options: { env?: any; home?: string } = {}): string {
  const env = options.env ?? process.env
  const home = typeof options.home === 'string' && options.home !== '' ? options.home : os.homedir()
  const override = typeof env?.SUPERPI_INTEGRITY === 'string' ? env.SUPERPI_INTEGRITY.trim() : ''
  if (override !== '') return path.resolve(override)
  return path.join(home, INTEGRITY_DIR_NAME, INTEGRITY_LOG_NAME)
}

/** 一次命中的形状（纯数据，日志与提示都用它）。 */
export type ByteHit = {
  /** `block` = 已拦截；`warn` = 只在结果里提醒（命令串）。 */
  level: 'block' | 'warn'
  tool: string
  /** 命中的字段，例如 `content` / `edits[1].newText` / `command`。 */
  field: string
  /** 目标路径（write/edit 有；bash 没有）。 */
  path: string
  total: number
  counts: { replacement: number; control: number; surrogate: number }
  /** 人可读的位置描述（前 5 处 + 总数）。 */
  summary: string
}

/**
 * 检查一次工具调用 —— **纯函数**，不碰磁盘、不碰 pi，门禁可以直接测。
 *
 * @param {{ toolName?: string, input?: any }} event
 * @returns {{ level: 'clean' | 'block' | 'warn', hit: ByteHit | null }}
 */
export function inspectToolCall(event: any): { level: 'clean' | 'block' | 'warn'; hit: ByteHit | null } {
  const clean = { level: 'clean' as const, hit: null }
  if (event === null || typeof event !== 'object') return clean
  const tool = typeof event.toolName === 'string' ? event.toolName : ''
  const input = event.input !== null && typeof event.input === 'object' ? event.input : {}
  const filePath = typeof input.path === 'string' ? input.path : ''
  if (tool === 'write' || tool === 'edit') {
    const scan = scanTextBytes(filePath)
    if (!scan.clean) return { level: 'block', hit: hitOf('block', tool, 'path', '', scan) }
  }

  // ① write：整份内容。
  if (tool === 'write') {
    const value = typeof input.content === 'string' ? input.content : ''
    const scan = scanTextBytes(value)
    if (scan.clean === true) return clean
    return { level: 'block', hit: hitOf('block', tool, 'content', filePath, scan) }
  }

  // ② edit：每处替换的**新文本**（oldText 是修复入口，必须放行）。
  if (tool === 'edit') {
    const edits = Array.isArray(input.edits) ? input.edits : []
    for (let i = 0; i < edits.length; i += 1) {
      const value = edits[i] !== null && typeof edits[i] === 'object' ? edits[i].newText : undefined
      if (typeof value !== 'string') continue
      const scan = scanTextBytes(value)
      if (scan.clean === true) continue
      return { level: 'block', hit: hitOf('block', tool, 'edits[' + String(i) + '].newText', filePath, scan) }
    }
    return clean
  }

  // ③ bash / powershell：只提醒，不拦截（同一串字节可能是修复脚本）。
  if (tool === 'bash' || tool === 'powershell') {
    const value = typeof input.command === 'string' ? input.command : ''
    const scan = scanTextBytes(value)
    if (scan.clean === true) return clean
    return { level: 'warn', hit: hitOf('warn', tool, 'command', '', scan) }
  }

  return clean
}

function hitOf(level: 'block' | 'warn', tool: string, field: string, filePath: string, scan: ReturnType<typeof scanTextBytes>): ByteHit {
  return {
    level,
    tool,
    field,
    path: filePath,
    total: scan.total,
    counts: scan.counts,
    summary: describeBytes(scan),
  }
}

/**
 * 拦截理由 —— **这是模型唯一能看到的东西**，所以它必须同时满足三件事：
 *
 *   ① 说清「没有发生」：文件未写入。否则模型会以为已经写好了。
 *   ② 说清「是什么」：几处、第几行、哪个码位。含糊的"格式错误"模型改不动。
 *   ③ 说清「接下来怎么做」：**不要原样重发**，重读目标区域后重写；真要这个字符就写转义。
 *
 * 第 ③ 条是重点。模型面对失败的第一反应是重发同一段内容 ——
 * 而同一串坏字节会原样再来一次（成因在 provider 侧，不是它这次手滑）。
 * 所以理由里必须明确禁止盲目重试，并给出可执行的替代动作。
 */
export function buildBlockReason(hit: ByteHit): string {
  const target = hit.path === '' ? '' : '（' + hit.path + '）'
  return [
    '写入已拦截' + target + '：' + hit.field + ' 含 ' + hit.total + ' 处损坏字节。' + hit.summary + '。',
    '文件未写入（未创建、未修改）。不要原样重发。',
    hit.field === 'path'
      ? '从可信的目录列表核对目标路径，再提交写入。'
      : '重新读取目标区域后重写。确实需要这些字符时，在目标语言中使用转义（如 \\uFFFD 或 \\u0007）。',
  ].join('\n')
}

/** 命令串里发现坏字节时追加到工具结果末尾的提醒（不拦截，只让模型知道）。 */
export function buildWarnNotice(hit: ByteHit): string {
  return '[superpi] 这条命令的输入含 ' + hit.total + ' 处损坏字节（' + summarizeCounts(hit.counts) + '）。' +
    '若它写入了文件，请重新读取该文件核对；不要把这段命令原样重发（同一串坏字节会再来一次）。'
}

/**
 * 追加一行观测日志（滚动保留最后 `INTEGRITY_LOG_MAX_LINES` 行）。
 *
 * 为什么要落盘：用户要把证据转给接口提供方（"请确认流式输出编码与工具调用格式稳定性"），
 * 而面板/命令行的提示条只是一次性的。日志是**可带走的证据**。
 * 不含文件内容，只含位置与计数 —— 日志本身不该成为第二个泄露面。
 */
export function appendIntegrityLogSync(entry: any, options: { file?: string; maxLines?: number } = {}): void {
  try {
    const file = typeof options.file === 'string' && options.file !== '' ? options.file : resolveIntegrityPath()
    const maxLines = Number.isFinite(options.maxLines) && (options.maxLines as number) > 0 ? Math.floor(options.maxLines as number) : INTEGRITY_LOG_MAX_LINES
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry })
    fs.mkdirSync(path.dirname(file), { recursive: true })
    let lines: string[] = []
    if (fs.existsSync(file)) {
      lines = fs.readFileSync(file, 'utf8').split('\n').filter(text => text !== '')
    }
    lines.push(line)
    const kept = lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines
    const tmp = file + '.' + String(process.pid) + '.tmp'
    fs.writeFileSync(tmp, kept.join('\n') + '\n', 'utf8')
    fs.renameSync(tmp, file)
  } catch {
    // 记账失败不能影响拦截本身（拦截优先于记账）。
  }
}

/** 读日志（新→旧）。读不到返回空数组，永不抛。 */
export function readIntegrityLogSync(options: { file?: string; limit?: number } = {}): any[] {
  try {
    const file = typeof options.file === 'string' && options.file !== '' ? options.file : resolveIntegrityPath()
    if (fs.existsSync(file) !== true) return []
    const rows: any[] = []
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (line.trim() === '') continue
      try { rows.push(JSON.parse(line)) } catch { /* 坏行跳过：日志不该让命令崩 */ }
    }
    const limit = Number.isFinite(options.limit) && (options.limit as number) > 0 ? Math.floor(options.limit as number) : rows.length
    return rows.slice(-limit).reverse()
  } catch {
    return []
  }
}

/** 汇总（命令与门禁用）。 */
export function summarizeIntegrityLog(rows: any[]): { blocked: number; warned: number; byTool: Record<string, number>; byKind: Record<string, number> } {
  const result: { blocked: number; warned: number; byTool: Record<string, number>; byKind: Record<string, number> } = {
    blocked: 0,
    warned: 0,
    byTool: {},
    byKind: {},
  }
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.level === 'block') result.blocked += 1
    else if (row?.level === 'warn') result.warned += 1
    else continue
    const tool = typeof row.tool === 'string' ? row.tool : 'unknown'
    result.byTool[tool] = (result.byTool[tool] ?? 0) + 1
    const kind = typeof row.field === 'string' ? row.field : 'unknown'
    result.byKind[kind] = (result.byKind[kind] ?? 0) + 1
  }
  return result
}

/**
 * 扩展入口。
 *
 * 只依赖 `pi.on` / `pi.registerCommand` / `ctx.ui.*` 三个运行时参数 —— 不 import
 * `@earendil-works/*`，所以多份 pi 副本都能加载，也能在门禁里用假 pi 单测。
 */
export default function textIntegrity(pi: any) {
  /**
   * 待提醒的命令串坏字节：`toolCallId → ByteHit`。
   *
   * 为什么不在 `tool_call` 里直接返回理由：那会**拦死**命令，而命令可能是修复脚本。
   * 所以记一笔，等 `tool_result` 时把提醒拼进结果 —— 模型在同一条工具往返里就能看到。
   * `tool_result` 一定带同一个 `toolCallId`（pi 的契约），对不上就自然丢弃（不会串台）。
   */
  const pendingWarn = new Map<string, ByteHit>()
  const pendingBlocks = new Map<string, { hit: ByteHit; reason: string }>()

  pi.on('tool_call', (event: any) => {
    try {
      const verdict = inspectToolCall(event)
      if (verdict.hit === null) return undefined
      const hit = verdict.hit
      const toolCallId = typeof event?.toolCallId === 'string' ? event.toolCallId : ''
      if (verdict.level === 'block') {
        appendIntegrityLogSync({
          version: INTEGRITY_VERSION,
          level: 'block',
          tool: hit.tool,
          field: hit.field,
          path: hit.path,
          bytes: hit.total,
          counts: summarizeCounts(hit.counts),
        })
        const reason = buildBlockReason(hit)
        if (toolCallId !== '' && !event.parentToolCallId) pendingBlocks.set(toolCallId, { hit, reason })
        return { block: true, reason }
      }
      if (toolCallId !== '') pendingWarn.set(toolCallId, hit)
      return undefined
    } catch {
      // 判据异常时放行：宁可漏拦一次，也不能让所有写盘都失败（那是能力归零）。
      return undefined
    }
  })

  pi.on('turn_end', (event: any) => {
    if (pendingBlocks.size === 0) return undefined
    const rejected = new Map<string, ByteHit>()
    for (const result of event.toolResults) {
      const block = pendingBlocks.get(result.toolCallId)
      if (block && result.isError === true && result.toolName === block.hit.tool && result.content[0]?.text === block.reason) {
        rejected.set(result.toolCallId, block.hit)
      }
    }
    pendingBlocks.clear()
    if (rejected.size === 0) return undefined

    // A denied proposal stays in the transcript. Keep its tool ID paired with Pi's error in the next request.
    return projectTurnAssistant(event, message => {
      let changed = false
      const content = message.content.map(block => {
        if (block.type !== 'toolCall') return block
        const hit = rejected.get(block.id)
        if (!hit || block.name !== hit.tool) return block
        changed = true
        return {
          ...block,
          arguments: {
            ...(hit.path === '' ? {} : { path: hit.path }),
            note: 'SuperPi rejected these arguments before execution. See the tool result for the reason. Regenerate the input before retrying.',
          },
        }
      })
      return changed ? { ...message, content } : null
    })
  })

  pi.on('agent_settled', () => pendingBlocks.clear())

  pi.on('tool_result', (event: any) => {
    try {
      const toolCallId = typeof event?.toolCallId === 'string' ? event.toolCallId : ''
      const hit = toolCallId === '' ? undefined : pendingWarn.get(toolCallId)
      if (hit === undefined) return undefined
      pendingWarn.delete(toolCallId)
      appendIntegrityLogSync({
        version: INTEGRITY_VERSION,
        level: 'warn',
        tool: hit.tool,
        field: hit.field,
        bytes: hit.total,
        counts: summarizeCounts(hit.counts),
      })
      const content = Array.isArray(event?.content) ? event.content : []
      /**
       * **总是追加一个新文本块**，不改写已有块。
       *
       * 上一版实现是"把最后一块文本接上警告"，看起来更省，但有一条静默路径：
       * 结果形如 `[text, image]`（末尾是图）时它会原样返回 —— 日志记了、模型没看到，
       * 正是本仓库反复出现的「跑了但没生效」。
       * 追加对任何结构都成立，代价只是多一个块。
       *
       * `structuredContent` 原样带回：pi 的合并逻辑在"替换 content 但没给
       * structuredContent"时会把它删掉（`agent-session.js:918-923`）——
       * 那属于误伤其它工具的机器可读结果。
       */
      const next = content.concat([{ type: 'text', text: buildWarnNotice(hit) }])
      const patch: any = { content: next }
      if (event?.structuredContent !== undefined) patch.structuredContent = event.structuredContent
      return patch
    } catch {
      return undefined
    }
  })

  pi.registerCommand(INTEGRITY_COMMAND, {
    description: '查看输出完整性：拦截了多少次坏字节写入 / 哪些工具 / 日志在哪',
    handler: async (_args: any, ctx: any) => {
      try {
        const rows = readIntegrityLogSync()
        const stats = summarizeIntegrityLog(rows)
        const lines: string[] = []
        lines.push('版本 ' + INTEGRITY_VERSION)
        lines.push('日志：' + resolveIntegrityPath())
        lines.push('累计：拦截写盘 ' + String(stats.blocked) + ' 次 · 命令串提醒 ' + String(stats.warned) + ' 次')
        const tools = Object.keys(stats.byTool)
        if (tools.length > 0) lines.push('按工具：' + tools.map(tool => tool + '×' + String(stats.byTool[tool])).join(' · '))
        if (stats.blocked === 0 && stats.warned === 0) {
          lines.push('本次进程/本机还没有记录 —— 干净。')
        } else {
          lines.push('最近 5 条：')
          for (const row of rows.slice(0, 5)) {
            lines.push('  ' + String(row?.at ?? '?') + ' · ' + String(row?.level ?? '?') + ' · ' +
              String(row?.tool ?? '?') + (typeof row?.path === 'string' && row.path !== '' ? ' ' + row.path : '') +
              ' · ' + String(row?.bytes ?? 0) + ' 处')
          }
        }
        const text = lines.join('\n')
        if (ctx?.ui?.editor !== undefined) await ctx.ui.editor('输出完整性', text)
        else if (ctx?.ui?.notify !== undefined) ctx.ui.notify(text, 'info')
      } catch {
        // 命令面板失败也不能影响会话。
      }
    },
  })
}

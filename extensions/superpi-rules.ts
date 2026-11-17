/**
 * superpi-rules —— 把「用户自定义规则」追加进 pi 的系统提示（最高优先级），
 * 并注册 `/superpi-rules` 让命令行窗口也能编辑同一份规则。
 *
 * 装法：`npm run pi:editor`（与输入框扩展一起装到 `<piAgentDir>/extensions/`）
 *
 * ---------------------------------------------------------------------------
 * 为什么需要它（而不是写 SYSTEM.md / APPEND_SYSTEM.md）
 *
 * | 做法 | 后果 |
 * | --- | --- |
 * | `SYSTEM.md` | **整份替换** pi 的默认提示：工具说明、docs 路径、技能列表全没了 —— 让系统退化两个维度 |
 * | `APPEND_SYSTEM.md` | 静态文件，只能手工改；面板改完要重启 pi 会话才生效，且面板没有读原文的通道 |
 * | 把规则当用户消息发出去 | 进对话历史、被压缩吃掉、污染 transcript，而且不是「最高优先级」 |
 * | **本扩展（`before_agent_start` 返回 systemPrompt）** | 每轮实时读盘、位置在提示末尾、两端同一份文件 |
 *
 * ---------------------------------------------------------------------------
 * 「最高优先级」是怎么落实的（不是口号）
 *
 *  1. **位置**：规则塞进 `systemPromptOptions.sections`，而 pi 组装 section 时自定义 section
 *     排在**最后**（`dist/core/system-prompt.js`：preamble → tools → rules → docs → … → cwd
 *     → customSections）。提示末尾的指令对长前缀的遵循度最高。
 *  2. **用语**：块首行显式声明「优先级最高、覆盖上文与项目说明、冲突以本段为准」
 *     （`OVERRIDE_PREFIX`，写在 `./superpi-rules.mjs` 里，面板读的是同一句）。
 *  3. **不追加时为真空**：规则被清空时返回 `undefined`，pi 收到的提示与「没装这个扩展」完全一致。
 *
 * ---------------------------------------------------------------------------
 * 刻意不做的事
 *  - 不 import `@earendil-works/*`：只用 `pi.on` / `pi.registerCommand` / `ctx.ui.*` 这三个运行时参数。
 *    好处是 `node_modules` 里有多份 pi 副本也照样能加载，且本扩展可以在 `test/rules.mjs` 里用假 pi 单测。
 *  - 不写 `settings.json`、不改 pi 任何文件、不读环境变量以外的东西。
 *  - 任何异常都不外抛：规则是"锦上添花"，绝不能让 pi 起不来或一轮对话失败。
 *
 * 命令行用法：`/superpi-rules` → 看级别与字数 / 编辑 / 恢复默认 / 只显示当前全文。
 */

import {
  DEFAULT_RULES_TEXT,
  MAX_RULES_TEXT,
  RULES_COMMAND,
  RULES_SECTION_NAME,
  createRulesStore,
  isRulesEmptyText,
  normalizeRulesText,
  readRulesTextSync,
  renderRulesBlock,
  resolveRulesPath,
} from './superpi-rules.mjs'

/** 摘要行要用的第一行有内容的文本（含 `#` 注释行会跳过）。 */
export function firstMeaningfulLine(text) {
  const lines = normalizeRulesText(text).split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (trimmed.startsWith('#')) continue
    return trimmed.length > 60 ? trimmed.slice(0, 60) + '…' : trimmed
  }
  return ''
}

/** 供命令输出的一行摘要（命令行里没有图形徽标，只有文字）。 */
export function describeRules(text) {
  const normalized = normalizeRulesText(text)
  if (isRulesEmptyText(normalized)) return '当前没有自定义规则（不会追加任何内容）'
  const lines = normalized.split('\n').length
  const head = firstMeaningfulLine(normalized)
  return '已启用 · ' + String(lines) + ' 行 / ' + String(normalized.length) + ' 字\n首行：' + head
}

/**
 * 把规则块合并进系统提示。
 *
 * **必须保持 event.systemPromptOptions 的引用**：pi 在 `before_agent_start` 里对
 * `systemPromptOptions` 做的是就地修改（`runner.js` 里 `handlerResult.systemPrompt` 才走
 * forceSystemPrompt，而 forceSystemPrompt 会「重放整份提示」= 每轮一次缓存 miss）。
 * 往 sections 里放一段是最省的：pi 会 diff section，只有变化的那一段才会作为补丁追加。
 *
 * @returns {object|null} 需要返回给 pi 的结果；null = 什么都不用做
 */
export function applyRulesToOptions(systemPromptOptions, text) {
  const block = renderRulesBlock(text)
  if (block === '') return null
  if (systemPromptOptions === null || typeof systemPromptOptions !== 'object') return null
  const sections = systemPromptOptions.sections !== null && typeof systemPromptOptions.sections === 'object'
    ? systemPromptOptions.sections
    : {}
  if (sections[RULES_SECTION_NAME] === block) return null
  sections[RULES_SECTION_NAME] = block
  systemPromptOptions.sections = sections
  // 返回空对象而不是 null：语义是「我改好了 options，没有额外要说的」。
  // pi 只在 result.systemPrompt !== undefined 时才覆盖整份提示，所以这里不能带 systemPrompt。
  return {}
}

/**
 * 扩展入口。
 *
 * @param {object} pi pi 的 ExtensionAPI（只用到 on / registerCommand）
 */
export default function superpiRules(pi) {
  if (pi === null || typeof pi !== 'object') return

  /* ------------------------------------------------- ① 每轮注入规则块 */

  if (typeof pi.on === 'function') {
    pi.on('before_agent_start', event => {
      try {
        // 每轮读一次（mtime+size 缓存命中时是纯内存）：面板保存后**下一轮立刻生效**，
        // 不需要重启会话 —— 这正是「设置里改完就该生效」的要求。
        const { text } = readRulesTextSync(resolveRulesPath())
        return applyRulesToOptions(event?.systemPromptOptions, text) ?? undefined
      } catch {
        // 读盘/拼装失败 → 这一轮不带规则（默认文案本来由 readRulesTextSync 兜底，
        // 走到这里说明是更意外的情况，静默跳过比让用户的一轮对话失败要好）。
        return undefined
      }
    })
  }

  /* ------------------------------------------- ② 命令行也能编辑同一份 */

  if (typeof pi.registerCommand !== 'function') return

  pi.registerCommand(RULES_COMMAND, {
    description: '编辑「用户自定义规则」（最高优先级；与面板设置是同一份文件）',
    handler: async (_args, ctx) => {
      const ui = ctx?.ui
      const notify = (text, level) => {
        try { ui?.notify?.(text, level ?? 'info') } catch { /* 通知失败不影响主流程 */ }
      }
      const filePath = resolveRulesPath()
      const store = createRulesStore({ filePath })

      if (ui !== undefined && ui !== null && typeof ui.select === 'function') {
        let current = ''
        try {
          const read = await store.read()
          current = read.state.text
        } catch {
          current = DEFAULT_RULES_TEXT
        }
        const summary = describeRules(current)
        const choice = await ui.select('用户自定义规则（最高优先级）\n\n' + summary + '\n\n' + filePath, [
          '编辑规则',
          '只显示当前全文',
          '恢复默认文案',
          '关闭',
        ])
        if (choice === '编辑规则' && typeof ui.editor === 'function') {
          const next = await ui.editor('编辑用户自定义规则（清空 = 不追加任何内容）', current)
          if (typeof next === 'string') {
            if (next.length > MAX_RULES_TEXT) {
              notify('规则过长（上限 ' + String(MAX_RULES_TEXT) + ' 字），未保存', 'error')
              return
            }
            try {
              const saved = await store.write(next)
              notify(isRulesEmptyText(saved.state.text)
                ? '已保存：当前没有规则，不会追加任何内容'
                : '已保存：' + String(saved.state.text.split('\n').length) + ' 行，下一轮对话立刻生效', 'info')
            } catch (error) {
              notify('保存失败：' + String(error?.message ?? error), 'error')
            }
          }
          return
        }
        if (choice === '只显示当前全文') {
          notify(summary + '\n\n' + current, 'info')
          return
        }
        if (choice === '恢复默认文案') {
          const ok = typeof ui.confirm === 'function'
            ? await ui.confirm('恢复默认文案？', '当前的修改会被替换成内置默认规则。')
            : true
          if (ok !== true) return
          try {
            await store.reset()
            notify('已恢复默认文案', 'info')
          } catch (error) {
            notify('恢复失败：' + String(error?.message ?? error), 'error')
          }
        }
        return
      }

      // 没有交互式 UI（print / json 模式）：别假装能编辑，明确告诉用户去哪改。
      notify('当前模式没有交互界面，规则文件：' + filePath, 'warning')
    },
  })
}

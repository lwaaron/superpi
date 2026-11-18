/**
 * superpi-modalities.ts —— 命令行窗口（pi TUI）的「模型模态」设置入口。
 *
 * 装法：`npm run pi:editor`（与输入框、规则、上下文守卫一起装到 `<piAgentDir>/extensions/`）
 *
 * ---------------------------------------------------------------------------
 * 它是什么
 *
 * `/superpi-modalities`：列出可用模型 → 选中一个 → 逐个切换它的模态开关。
 * 与面板设置抽屉里的「模型模态」一节读写**同一份** `<home>/.superpi/modalities.json`，
 * 所以两端永远一致 —— 不需要同步协议，也不需要重启会话。
 *
 * ---------------------------------------------------------------------------
 * 为什么单独一个扩展，而不是塞进上下文守卫
 *
 * 守卫管的是「请求长什么样」（每次 LLM 调用前都会跑），本扩展管的是「用户怎么设置」。
 * 两者的触发时机、失败后果完全不同：设置读不出来只该让菜单报错，不该让每一轮请求
 * 都进入异常分支。分开也让 `test/modalities.mjs` 能用假 pi 单测菜单流程。
 *
 * 刻意不做的事：
 *  - 不 import `@earendil-works/*`（只依赖 pi.on / pi.registerCommand / ctx.*）
 *  - 不 hook `context`（过滤在守卫里，这里只写状态——**单一执行点**）
 *  - 任何异常都不外抛：设置界面坏掉不能影响对话
 */

import {
  DEFAULT_ENABLED_MODALITIES,
  LOCKED_MODALITIES,
  RUNTIME_MODALITIES,
  createModalitiesStore,
  overridesFor,
  readModalitiesStateSync,
  resolveModelModalities,
  resolveModalitiesPath,
} from './superpi-modalities.mjs'

export const MODALITIES_COMMAND = 'superpi-modalities'

function modelLabel(model) {
  const name = String(model?.name ?? '') || String(model?.id ?? '')
  const provider = String(model?.provider ?? '')
  return provider === '' ? name : name + ' · ' + provider
}

/** 一行摘要：`文本 ✓ · 图像 ✗`，让用户不用点进去就知道状态。 */
function summaryLine(model, overrides) {
  const resolved = resolveModelModalities(model, overrides)
  const parts = []
  for (const entry of resolved.entries) {
    const label = entry.id === 'image' ? '图像' : (entry.id === 'text' ? '文本' : entry.id)
    if (entry.locked) parts.push(label + ' 固定')
    else parts.push(label + (entry.enabled ? ' ✓' : ' ✗'))
  }
  return parts.join(' · ')
}

/** 可用模型：优先 scoped（与 /scoped-models 同一集合），否则全量。 */
function listModels(ctx) {
  const scoped = Array.isArray(ctx?.scopedModels) ? ctx.scopedModels : []
  if (scoped.length > 0) {
    return scoped.map(entry => (entry !== null && typeof entry === 'object' && entry.model !== undefined ? entry.model : entry)).filter(Boolean)
  }
  try {
    const registry = ctx?.modelRegistry
    if (registry !== null && registry !== undefined && typeof registry.getAvailable === 'function') {
      const list = registry.getAvailable()
      if (Array.isArray(list)) return list
    }
  } catch {
    // 拿不到就返回空，命令会明确告知，而不是静默显示一个空菜单。
  }
  return []
}

export default function superpiModalities(pi) {
  if (pi === null || typeof pi !== 'object') return
  if (typeof pi.registerCommand !== 'function') return

  const store = createModalitiesStore()
  const cache = { path: '', mtimeMs: 0, size: 0, state: null }

  const readState = () => {
    try {
      return readModalitiesStateSync({ cache })
    } catch {
      return { version: 1, models: {} }
    }
  }

  pi.registerCommand(MODALITIES_COMMAND, {
    description: '按模型设置模态开关（文本/图像；默认开启，关闭后请求里不再包含该模态）',
    handler: async (_args, ctx) => {
      try {
        const ui = ctx?.ui
        const state0 = readState()
        const models = listModels(ctx)
        if (models.length === 0) {
          const text = '没有可用的模型列表。\n设置文件：' + resolveModalitiesPath() +
            '\n可以在面板的设置里改（两端读同一份文件）。'
          if (typeof ui?.notify === 'function') ui.notify(text, 'warning')
          return
        }
        if (typeof ui?.select !== 'function') {
          // 非交互环境：只报告路径与当前覆盖，不做假交互。
          const lines = ['当前覆盖：' + (Object.keys(state0.models).length === 0 ? '（全部默认）' : '')]
          for (const [key, value] of Object.entries(state0.models)) lines.push('  ' + key + ' → ' + JSON.stringify(value))
          lines.push('设置文件：' + resolveModalitiesPath())
          if (typeof ui?.notify === 'function') ui.notify(lines.join('\n'), 'info')
          return
        }

        // 主循环：选模型 → 切模态 → 回到模型列表（用户按 Esc 时 select 返回 undefined）。
        for (;;) {
          const state = readState()
          const options = models.map(model => modelLabel(model) + '  [' + summaryLine(model, overridesFor(state, model)) + ']')
          options.push('完成')
          const picked = await ui.select('模型模态（点一个模型切换它的开关）', options)
          if (picked === undefined || picked === null || picked === '完成') return
          const index = options.indexOf(picked)
          if (index < 0 || index >= models.length) return
          const model = models[index]

          for (;;) {
            const current = readState()
            const resolved = resolveModelModalities(model, overridesFor(current, model))
            const rows = resolved.entries.map(entry => {
              const label = entry.id === 'image' ? '图像' : (entry.id === 'text' ? '文本' : entry.id)
              if (entry.locked) return label + ' · 已开启（' + (entry.reason || '不可关闭') + '）'
              return label + ' · ' + (entry.enabled ? '已开启 ✓' : '已关闭 ✗') + (entry.isDefault ? '（默认）' : '（已改）')
            })
            for (const item of resolved.unsupported) {
              rows.push(item.id + ' · 协议声明但运行时无法发送（不可开启）')
            }
            rows.push('恢复这个模型的默认')
            rows.push('返回模型列表')

            const choice = await ui.select(modelLabel(model) + ' · 模态', rows)
            if (choice === undefined || choice === null || choice === '返回模型列表') break
            if (choice === '恢复这个模型的默认') {
              for (const id of RUNTIME_MODALITIES) {
                if (LOCKED_MODALITIES.includes(id)) continue
                await store.set(model, id, null)
              }
              continue
            }
            // 只有「可切换」的那几行能落盘：固定项/不可用项点不进去。
            const target = resolved.entries.find(entry => {
              const label = entry.id === 'image' ? '图像' : (entry.id === 'text' ? '文本' : entry.id)
              return choice.indexOf(label + ' · ') === 0 && entry.locked !== true
            })
            if (target === undefined) continue
            await store.set(model, target.id, target.enabled !== true)
          }
        }
      } catch (error) {
        try {
          if (typeof ctx?.ui?.notify === 'function') {
            ctx.ui.notify('模态设置失败：' + String(error?.message ?? error), 'error')
          }
        } catch {
          // 连错误提示都失败时保持安静：设置界面绝不能影响对话。
        }
      }
    },
  })
}

/** 供测试使用（不启动 pi 也能断言摘要行）。 */
export { summaryLine, modelLabel }

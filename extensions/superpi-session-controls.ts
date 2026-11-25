import { getAgentDir, SettingsManager, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent'
import { SESSION_CONTROL, SESSION_CONTROL_COMMAND, SESSION_CONTROL_STATUS } from './superpi-session-controls.mjs'

const retryDefault = SettingsManager.inMemory().getRetryEnabled()

function retryEnabled(pi: ExtensionAPI) {
  return pi.getSettings().retry?.enabled ?? retryDefault
}

async function previousModel(pi: ExtensionAPI, ctx: ExtensionContext) {
  const available = ctx.modelRegistry.getAvailable()
  const sameModel = (a: typeof ctx.model, b: typeof ctx.model) => a?.provider === b?.provider && a?.id === b?.id
  const scope = ctx.scopedModels
  const sequence = scope.length > 0
    ? scope.filter(item => available.some(model => sameModel(model, item.model)))
    : available.map(model => ({ model, thinkingLevel: undefined }))
  const current = sequence.findIndex(item => sameModel(item.model, ctx.model))
  if (current === 0 && sequence.length === 1) return false
  const previous = current <= 0 ? sequence.at(-1) : sequence[current - 1]
  if (!previous) return false
  if (!await pi.setModel(previous.model)) throw new Error('The previous model requires authentication.')
  if (previous.thinkingLevel !== undefined) pi.setThinkingLevel(previous.thinkingLevel)
  return true
}

export default function sessionControls(pi: ExtensionAPI) {
  let modelChange: Promise<unknown> = Promise.resolve()
  pi.registerCommand(SESSION_CONTROL_COMMAND, {
    description: 'Internal SuperPi session controls',
    handler: async (args, ctx) => {
      const [operation, nonce] = args.trim().split(/\s+/)
      if (ctx.mode !== 'rpc' || !/^[a-f0-9-]{36}$/.test(nonce ?? '')) return
      let result
      try {
        if (operation === SESSION_CONTROL.retry) result = { enabled: retryEnabled(pi) }
        else if (operation === SESSION_CONTROL.previousModel) {
          const change = modelChange.then(() => previousModel(pi, ctx))
          modelChange = change.catch(() => {})
          result = { changed: await change }
        } else throw new Error('Unknown SuperPi session control.')
      } catch (error) {
        result = { error: error instanceof Error ? error.message : String(error) }
      }
      ctx.ui.setStatus(SESSION_CONTROL_STATUS + nonce, JSON.stringify(result))
    },
  })

  pi.registerCommand('superpi-retry', {
    description: 'View or change the effective automatic retry setting',
    handler: async (_args, ctx) => {
      const enabled = retryEnabled(pi)
      const title = '自动重试 · ' + (enabled ? '开启' : '关闭')
      if (ctx.mode !== 'tui' || !ctx.hasUI || !ctx.isIdle()) {
        ctx.ui.notify(title, 'info')
        return
      }
      const manager = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() })
      if (typeof manager.getProjectSettings().retry?.enabled === 'boolean') {
        ctx.ui.notify(title + ' · 由项目设置控制', 'info')
        return
      }
      const selection = await ctx.ui.select(title, [enabled ? '关闭自动重试' : '开启自动重试'])
      if (selection === undefined || !ctx.isIdle()) return
      const initialErrors = manager.drainErrors()
      if (initialErrors.length > 0) throw initialErrors[0].error
      manager.setRetryEnabled(!enabled)
      await manager.flush()
      const errors = manager.drainErrors()
      if (errors.length > 0) throw errors[0].error
      await ctx.reload()
    },
  })
}

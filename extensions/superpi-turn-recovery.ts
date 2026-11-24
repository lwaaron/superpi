/** Shared output recovery. Pi owns the transcript, execution, cancellation and continuation. */
import { isRetryableAssistantError } from '@earendil-works/pi-ai/compat'
import { readGuardSettingsSync, shouldAutoRetryOnMalformed } from './superpi-context-guard.mjs'
import { detectTurnVerdict } from './superpi-turn-verdict.mjs'

const CONTINUE_TRUNCATED = 'The previous response reached its output limit. Continue from the available prefix and the existing task progress. Preserve completed tool effects.'
const CONTINUE_INTERRUPTED = 'The previous response stream was interrupted. Its partial answer and tool proposals did not complete. Continue from the task goal and completed tool results already present. Check uncertain effects before you act, and do not repeat completed actions.'
const DELIVERY_GUIDANCE = [
  'For multi-step coding tasks, keep working until the requested deliverables have been checked, or explain the concrete blocker.',
  'After tests or tool calls, use their results to decide what remains. Report completion only for work actually done and verified.',
  'When verify is available, use a disposable snapshot for intentional mutations or experiments that must not change the working copy.',
  'For concurrency, migrations, or changes across lifecycle boundaries, include an independent review check when using task_progress. Address concrete review findings before delivery.',
  'When resuming, start from the current workspace and completed tool results. Verify uncertain changes before doing them again.',
].join('\n')

export default function turnRecovery(pi: any) {
  const settingsCache = { path: '', mtimeMs: 0, size: 0, settings: null }
  let lastAutoRetryAt = 0
  let attempted = false
  let hadToolCall = false
  let candidate: { kind: string; entryId: string; keepPrefix: boolean } | null = null

  pi.on('before_agent_start', (event: any) => {
    const sections = event.systemPromptOptions?.sections
    if (sections) sections.superpi_delivery = DELIVERY_GUIDANCE
  })

  pi.on('turn_end', (event: any) => {
    candidate = null
    const { message, messageEntryId, entries, outcome } = event
    if (message?.role !== 'assistant') return
    const hasToolCall = message.content.some((block: any) => block?.type === 'toolCall')
    hadToolCall ||= (outcome === 'completed' && hasToolCall) || event.toolResults.length > 0
    if (!messageEntryId) return
    if (entries.some((entry: any) => entry.type === 'context_edit' && entry.targetId === messageEntryId)) return

    const verdict = detectTurnVerdict(message)
    if (verdict.delivered) return
    if (verdict.kind === 'stream-interrupted') {
      // An error turn cannot dispatch its partial tool proposals. Pi handles the errors it recognizes.
      if (outcome !== 'error' || event.toolResults.length || isRetryableAssistantError(message)) return
    } else if (outcome !== 'completed' || hasToolCall) return
    const keepPrefix = verdict.kind === 'truncated' && detectTurnVerdict({ ...message, stopReason: 'stop' }).delivered
    candidate = { kind: verdict.kind, entryId: messageEntryId, keepPrefix }
    if (!keepPrefix) {
      // Pi retains the original entry for inspection. Only the provider-facing projection changes.
      return { entries: [...entries, { type: 'context_edit', targetId: messageEntryId, replacement: null }] }
    }
  })

  pi.on('agent_before_settle', (event: any, ctx: any) => {
    if (!candidate || attempted || event.continue || ctx.signal?.aborted ||
        ctx.hasPendingMessages() || event.context.pendingMessages.length > 0) return
    const { kind, entryId, keepPrefix } = candidate
    const interrupted = kind === 'stream-interrupted'
    if (interrupted) {
      const retry = pi.getSettings().retry
      if (event.outcome !== 'error' || retry?.enabled === false || retry?.maxRetries === 0) return
    } else {
      if (event.outcome !== 'completed') return
      const settings = readGuardSettingsSync({ cache: settingsCache })
      if (!shouldAutoRetryOnMalformed(settings, { hadToolCall, lastAutoRetryAt }).retry) return
    }
    if (keepPrefix) {
      // Pi may already have omitted this attempt during its native compact-and-retry path.
      if (!event.context.contextEntries.some((entry: any) => entry.sourceEntry.id === entryId)) return
    } else if (!event.context.canContinue) {
      return
    }

    attempted = true
    if (!interrupted) lastAutoRetryAt = Date.now()
    const entries = [...event.entries, {
      type: 'custom', customType: 'superpi-recovery',
      data: { kind, entryId, provider: ctx.model?.provider, model: ctx.model?.id },
    }]
    if (keepPrefix || interrupted) {
      entries.push({
        type: 'custom_message', customType: 'superpi-recovery',
        content: interrupted ? CONTINUE_INTERRUPTED : CONTINUE_TRUNCATED, display: false,
      })
    }
    return { entries, continue: true }
  })

  // Pi can start several low-level agent runs under a single user activity.
  pi.on('agent_settled', () => {
    candidate = null
    attempted = false
    hadToolCall = false
  })
}

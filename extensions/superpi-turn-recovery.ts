/** Shared output recovery. Pi owns the transcript, execution, cancellation and continuation. */
import { readGuardSettingsSync, shouldAutoRetryOnMalformed } from './superpi-context-guard.mjs'
import { detectTurnVerdict } from './superpi-turn-verdict.mjs'

const CONTINUE_TRUNCATED = 'The previous response reached its output limit. Continue from the available prefix and the existing task progress. Preserve completed tool effects.'
const DELIVERY_GUIDANCE = [
  'For multi-step coding tasks, keep working until the requested deliverables have been checked, or explain the concrete blocker.',
  'After tests or tool calls, use their results to decide what remains. Report completion only for work actually done and verified.',
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
    hadToolCall ||= hasToolCall || event.toolResults.length > 0
    if (outcome !== 'completed' || hasToolCall || !messageEntryId) return
    if (entries.some((entry: any) => entry.type === 'context_edit' && entry.targetId === messageEntryId)) return

    const verdict = detectTurnVerdict(message)
    if (verdict.delivered) return
    const keepPrefix = verdict.kind === 'truncated' && detectTurnVerdict({ ...message, stopReason: 'stop' }).delivered
    candidate = { kind: verdict.kind, entryId: messageEntryId, keepPrefix }
    if (!keepPrefix) {
      // Pi retains the original entry for inspection. Only the provider-facing projection changes.
      return { entries: [...entries, { type: 'context_edit', targetId: messageEntryId, replacement: null }] }
    }
  })

  pi.on('agent_before_settle', (event: any, ctx: any) => {
    if (!candidate || attempted || event.outcome !== 'completed' || event.continue || ctx.signal?.aborted ||
        ctx.hasPendingMessages() || event.context.pendingMessages.length > 0) return
    const settings = readGuardSettingsSync({ cache: settingsCache })
    if (!shouldAutoRetryOnMalformed(settings, { hadToolCall, lastAutoRetryAt }).retry) return

    const { kind, entryId, keepPrefix } = candidate
    if (keepPrefix) {
      // Pi may already have omitted this attempt during its native compact-and-retry path.
      if (!event.context.contextEntries.some((entry: any) => entry.sourceEntry.id === entryId)) return
    } else if (!event.context.canContinue) {
      return
    }

    attempted = true
    lastAutoRetryAt = Date.now()
    const entries = [...event.entries, {
      type: 'custom', customType: 'superpi-recovery',
      data: { kind, entryId, provider: ctx.model?.provider, model: ctx.model?.id },
    }]
    if (keepPrefix) {
      entries.push({
        type: 'custom_message', customType: 'superpi-recovery', content: CONTINUE_TRUNCATED, display: false,
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

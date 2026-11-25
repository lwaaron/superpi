import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Type, type Static } from 'typebox'
import { scanTextBytes } from './superpi-text-bytes.mjs'
import { applyVerificationMutations, firstChangedSource, verificationCommand, verificationOutputContains, verificationSnapshotFingerprint,
  waitForVerification, watchWorkspaceEntries, withVerificationPair, withVerificationSnapshot,
  workspaceFingerprint, workspaceSourceState } from './superpi-verification.mjs'
import { REVIEW_CHECKPOINT, reviewChanges } from './superpi-review.mjs'

const TASK = 'superpi-task'
const RECEIPT = 'superpi-task-receipt'
const shells = Type.Union([Type.Literal('bash'), Type.Literal('powershell')])
const commandText = Type.String({ minLength: 1, maxLength: 32_768 })
const checklistText = Type.String({ minLength: 1, maxLength: 400 })
const mutationsSchema = Type.Array(Type.Object({
  path: Type.String({ minLength: 1, maxLength: 4096 }),
  oldText: commandText,
  newText: Type.String({ maxLength: 32_768 }),
}, { additionalProperties: false }), { minItems: 1, maxItems: 12 })
const failureDiagnostic = Type.String({ minLength: 1, maxLength: 400,
  description: 'Literal test diagnostic expected only after applying the snapshot mutations.' })
const mutationCheckSchema = Type.Object({ mutations: mutationsSchema, expectedFailure: failureDiagnostic }, { additionalProperties: false })
const statusActions = Type.Union([
  Type.Literal('start'), Type.Literal('status'), Type.Literal('observe'),
  Type.Literal('block'), Type.Literal('resume'), Type.Literal('finish'),
])

type Check = {
  description: string
  command?: string
  shell?: 'bash' | 'powershell'
  review?: boolean
  mutation?: Static<typeof mutationCheckSchema>
  evidence?: { at: string; observation: string } | {
    at: string; fingerprint: string; toolCallId: string
    mutation?: { baselineExitCode: 0; mutationExitCode: number }
  }
}

type Task = {
  version: 1
  goal: string
  status: 'active' | 'blocked' | 'complete'
  checks: Check[]
  blocker?: string
  finishWhenVerified?: boolean
}

type VerificationStatus = 'passed' | 'failed' | 'timed_out' | 'aborted' | 'unavailable' | 'stale'

type MutationComparison = {
  expectedFailure: string
  stage: 'preparing' | 'baseline' | 'mutation'
  outcome: 'incomplete' | 'baseline_failed' | 'survived' | 'unexpected_failure' | 'detected'
  baselineExitCode: number | null
  mutationExitCode: number | null
}

function currentTask(ctx: ExtensionContext): Task | undefined {
  const branch = ctx.sessionManager.getBranch()
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index]
    if (entry.type !== 'custom' || entry.customType !== TASK) continue
    const task = entry.data as Task | undefined
    if (task?.version === 1 && Array.isArray(task.checks)) return task
  }
}

function taskSummary(task: Task | undefined) {
  if (!task) return 'No task has been recorded on this session branch.'
  const heading = task.status === 'blocked' ? 'Blocked: ' + task.blocker : 'Task ' + task.status
  return [heading, task.goal, ...task.checks.map((check, index) => {
    const mutation = check.evidence && 'fingerprint' in check.evidence ? check.evidence.mutation : undefined
    const label = !check.evidence ? 'pending' : mutation ? 'mutation detected' : check.review ? 'review complete' :
      'fingerprint' in check.evidence ? 'command passed' : 'observed'
    const proof = !check.evidence ? '' : ' · ' + check.evidence.at +
      ('observation' in check.evidence ? ' · ' + check.evidence.observation : ' · tool ' + check.evidence.toolCallId)
    const diagnostic = check.mutation ? '\n   Expected assertion ' + JSON.stringify(check.mutation.expectedFailure) : ''
    const exits = mutation ? ' · baseline exit ' + mutation.baselineExitCode + ' · mutation exit ' + mutation.mutationExitCode : ''
    return (index + 1) + '. [' + label + '] ' + check.description + (check.command ? '\n   $ ' + check.command : '') + proof + diagnostic + exits
  })].join('\n')
}

function taskResult(task: Task | undefined, note?: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text: [note, taskSummary(task)].filter(Boolean).join('\n\n') }],
    details: { task }, isError,
  }
}

function hasAllEvidence(task: Task) {
  return task.checks.length > 0 && task.checks.every(check => Boolean(check.evidence))
}

function receiptText(task: Task) {
  return ['任务验收通过 / Delivery verified', '', task.goal, '', ...task.checks.map((check, index) => {
    const mutation = check.evidence && 'fingerprint' in check.evidence ? check.evidence.mutation : undefined
    const result = mutation ? ' · baseline exit ' + mutation.baselineExitCode + ' · mutation exit ' + mutation.mutationExitCode : ''
    return (index + 1) + '. ' + check.description + result
  })].join('\n')
}

function showTask(ctx: ExtensionContext, task = currentTask(ctx)) {
  const count = task?.checks.filter(check => check.evidence).length
  const status = task?.status === 'complete' ? '已完成 / Complete' : task?.status === 'blocked' ? '待处理 / Blocked' : '进行中 / In progress'
  ctx.ui.setWidget(TASK, task ? ['任务 / Task · ' + count + '/' + task.checks.length + ' · ' + status] : undefined)
}

function validText(value: string | undefined) {
  return typeof value === 'string' && value.trim() !== '' && scanTextBytes(value).clean
}

async function refreshSourceEvidence(task: Task, cwd: string, signal?: AbortSignal) {
  const bound = task.checks.some(check => check.evidence && 'fingerprint' in check.evidence)
  if (!bound) return task
  const deadline = AbortSignal.timeout(30_000)
  const active = signal ? AbortSignal.any([signal, deadline]) : deadline
  let fingerprint: string | undefined
  try {
    await waitForVerification(workspaceFingerprint(cwd, active).then(value => { fingerprint = value }), active)
  } catch { /* Missing evidence leaves the check open. */ }
  signal?.throwIfAborted()
  if (active.aborted) fingerprint = undefined
  const checks = task.checks.map(check => check.evidence && 'fingerprint' in check.evidence &&
    check.evidence.fingerprint !== fingerprint ? { ...check, evidence: undefined } : check)
  return checks.some((check, i) => check !== task.checks[i]) ? { ...task, status: 'active' as const, checks } : task
}

export default function delivery(pi: ExtensionAPI) {
  let engaged = false
  let nudged = false
  let waitingForUser = false
  let shellStillRunning = false
  let completedHere = false
  let automaticFinishPending = false

  const save = (ctx: ExtensionContext, task: Task) => {
    pi.appendEntry(TASK, task)
    showTask(ctx, task)
  }
  const saveEvidence = (ctx: ExtensionContext, task: Task, index: number, evidence: Check['evidence']) => {
    const next = { ...task, checks: task.checks.map((item, i) => i === index ? { ...item, evidence } : item) }
    save(ctx, next)
    return next
  }
  const canFinish = (ctx: ExtensionContext) => !waitingForUser && !shellStillRunning && !ctx.hasPendingMessages()
  const stopAfterEvidence = (ctx: ExtensionContext, task?: Task) => {
    if (!task?.finishWhenVerified || task.status !== 'active' || !hasAllEvidence(task) || !canFinish(ctx)) return false
    automaticFinishPending = true
    return true
  }
  const resetActivity = () => {
    engaged = false
    nudged = false
    waitingForUser = false
    shellStillRunning = false
    completedHere = false
    automaticFinishPending = false
  }
  const restore = (_event: unknown, ctx: ExtensionContext) => {
    resetActivity()
    showTask(ctx)
  }
  pi.on('session_start', restore)
  pi.on('session_switch', restore)
  pi.on('session_tree', restore)
  pi.on('agent_settled', resetActivity)
  pi.on('message_start', event => {
    if (event.message.role === 'user') automaticFinishPending = false
  })
  pi.on('tool_result', event => {
    if (event.toolName === 'ask_user') waitingForUser = (event.details as { status?: string })?.status !== 'answered'
  })

  pi.registerCommand(TASK, {
    description: 'Inspect this session’s task and verification evidence',
    handler: async (_args, ctx) => {
      await ctx.ui.editor('任务与验收 / Task and verification', taskSummary(currentTask(ctx)))
    },
  })

  pi.registerTool({
    name: 'task_progress',
    label: 'Task progress',
    description: 'Manage a branch-local delivery checklist. Use verify for command checks, review_changes for independent review checks, and observe for inspected artifacts. Block on a real dependency, resume to continue, and finish after evidence is recorded.',
    promptSnippet: 'Track acceptance checks and actual evidence for multi-step work.',
    promptGuidelines: [
      'Use task_progress for multi-step coding work and read its status when resuming. Tie checks to the user request. Exercise regressions and compatibility, including overlapping operations on the same resource and partial failures when relevant.',
      'Record actual observations with file, test, or artifact references. Use verify with the numbered check for command evidence. Call finish for tasks that require a separate completion decision.',
      'Set finishWhenVerified on start when the declared checks cover the entire requested delivery, including any required independent review. Run the last check on its own for an automatic receipt as soon as all evidence is current.',
      'If acceptance requires proving a test detects a specific regression, declare mutation with exact replacements and an expectedFailure diagnostic on its command check. Run verify with that check number.',
      'For changes where independent review is part of acceptance, mark a check review:true. Review the tested source, address concrete findings, and review again after edits. If reports stay incomplete, finish other checks and report the exact evidence still missing.',
    ],
    executionMode: 'sequential',
    parameters: Type.Object({
      action: statusActions,
      goal: Type.Optional(checklistText),
      checks: Type.Optional(Type.Array(Type.Object({
        description: checklistText,
        command: Type.Optional(commandText),
        shell: Type.Optional(shells),
        review: Type.Optional(Type.Boolean()),
        mutation: Type.Optional(mutationCheckSchema),
      }, { additionalProperties: false }), { minItems: 1, maxItems: 12 })),
      check: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })),
      observation: Type.Optional(checklistText),
      reason: Type.Optional(checklistText),
      replace: Type.Optional(Type.Boolean({ description: 'Use only when the user changes the goal or acceptance criteria of a task in progress.' })),
      finishWhenVerified: Type.Optional(Type.Boolean({ description: 'On start, allow checked evidence for the full task to complete it and publish a receipt automatically.' })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      let task = currentTask(ctx)
      if (params.action === 'status') return taskResult(task)
      if (params.action === 'start') {
        if (task && task.status !== 'complete' && !params.replace) return taskResult(task, 'A task already exists. Resume it or explicitly replace it when the user changes scope.', true)
        if (!validText(params.goal) || !params.checks?.length || params.checks.some(check =>
          !validText(check.description) || (check.command !== undefined && (!validText(check.command) || check.review)) ||
          (check.mutation && (!check.command || !validText(check.mutation.expectedFailure))))) {
          return taskResult(task, 'Provide a goal and at least one specific acceptance check with valid text.', true)
        }
        task = { version: 1, status: 'active', goal: params.goal!.trim(), checks: params.checks,
          ...(params.finishWhenVerified ? { finishWhenVerified: true } : {}) }
        automaticFinishPending = false
        engaged = true
      } else {
        if (!task || task.status === 'complete') return taskResult(task, 'There is no unfinished task on this branch.', true)
        if (params.action === 'block') {
          if (!validText(params.reason)) return taskResult(task, 'Give the specific blocker.', true)
          task = { ...task, status: 'blocked', blocker: params.reason!.trim() }
        } else if (params.action === 'resume') {
          task = { ...task, status: 'active', blocker: undefined }
          engaged = true
        } else {
          if (task.status === 'blocked') return taskResult(task, 'Resume the task before recording delivery.', true)
          engaged = true
          if (params.action === 'observe') {
            const index = (params.check ?? 0) - 1
            const check = task.checks[index]
            if (!check || check.command || check.review || !validText(params.observation)) {
              return taskResult(task, 'Select an observation check. Use verify for command checks and review_changes for independent reviews.', true)
            }
            const evidence = { observation: params.observation!.trim(), at: new Date().toISOString() }
            signal?.throwIfAborted()
            task = saveEvidence(ctx, task, index, evidence)
            return { ...taskResult(task), terminate: stopAfterEvidence(ctx, task) }
          } else {
            if (!hasAllEvidence(task)) return taskResult(task, 'Acceptance checks are still pending.', true)
            const checked = await refreshSourceEvidence(task, ctx.cwd, signal)
            if (checked !== task) {
              save(ctx, checked)
              return taskResult(checked, 'Workspace sources changed or could not be confirmed. Rerun the pending evidence checks.', true)
            }
            task = { ...task, status: 'complete' }
            completedHere = true
          }
        }
      }
      signal?.throwIfAborted()
      save(ctx, task)
      return { ...taskResult(task), terminate: params.action === 'resume' && stopAfterEvidence(ctx, task) }
    },
  })

  pi.registerTool({
    name: 'verify',
    label: 'Verify',
    description: 'Run a real verification command with a deadline and preserved exit status. Use workspace for normal checks. For mutation experiments use snapshot and exact text replacements. Supply expectedFailure to compare a passing baseline and a mutated copy using the same command. Snapshots copy tracked and non-ignored files. Include any dependency setup in the command.',
    promptSnippet: 'Run bounded checks and use disposable snapshots for mutation experiments.',
    promptGuidelines: [
      'Use verify for builds and tests, with a deadline appropriate to the command. Declare deliberate mutations as exact replacements in a snapshot and invoke tests there using relative paths.',
      'To confirm a test catches a specific regression, use expectedFailure with stable, literal output from the failing assertion. The comparison confirms a passing baseline and that exact diagnostic from the mutated run.',
      'For numbered checks use the declared command and shell. Normal checks run in the workspace. A numbered mutation check runs the declared comparison in snapshots and records evidence on detection if the workspace still matches.',
    ],
    reachesTools: ['bash', 'powershell'],
    executionMode: 'sequential',
    parameters: Type.Object({
      command: commandText,
      timeout: Type.Integer({ minimum: 1, maximum: 2_147_483, description: 'Total deadline in seconds for snapshot preparation and all command runs.' }),
      scope: Type.Optional(Type.Union([Type.Literal('workspace'), Type.Literal('snapshot')])),
      shell: Type.Optional(shells),
      check: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })),
      expectedFailure: Type.Optional(failureDiagnostic),
      mutations: Type.Optional(mutationsSchema),
    }, { additionalProperties: false }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { command, timeout, shell = 'bash' } = params
      const task = currentTask(ctx)
      const index = (params.check ?? 0) - 1
      const check = task?.checks[index]
      const declaredMutation = check?.mutation
      const requiredScope = declaredMutation ? 'snapshot' : 'workspace'
      const scope = params.scope ?? requiredScope
      const mutations = declaredMutation?.mutations ?? params.mutations
      const expectedFailure = declaredMutation?.expectedFailure ?? params.expectedFailure
      if (!validText(command)) return taskResult(task, 'Provide a non-empty verification command with valid text.', true)
      if (params.check !== undefined && (task?.status !== 'active' || check?.command !== command || (check.shell ?? 'bash') !== shell)) {
        return taskResult(task, 'Use the exact command and shell of a recorded check in the active task.', true)
      }
      if (declaredMutation && (scope !== 'snapshot' || params.mutations !== undefined || params.expectedFailure !== undefined)) {
        return taskResult(task, 'Use the declared snapshot mutations and failure diagnostic for this numbered check.', true)
      }
      if (check && scope !== requiredScope) return taskResult(task, 'This numbered check runs in the workspace.', true)
      if (mutations && scope !== 'snapshot') return taskResult(task, 'Mutations require a disposable verification snapshot.', true)
      if (expectedFailure !== undefined && (scope !== 'snapshot' || !mutations?.length || !validText(expectedFailure))) {
        return taskResult(task, 'A comparison requires a snapshot, at least one mutation, and a literal failure diagnostic.', true)
      }
      if (!ctx.tools.some(tool => tool.name === shell)) return taskResult(task, 'The selected shell is not enabled for this session.', true)
      if (check) engaged = true

      const deadline = AbortSignal.timeout(timeout * 1000)
      const executionSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
      let status: VerificationStatus = 'unavailable'
      let exitCode: number | null = null
      let output: { type: 'text'; text: string }[] = []
      let baselineOutput: typeof output = []
      let note = ''
      let proof: Check['evidence']
      let mutationsApplied = 0
      let terminationConfirmed = true
      const comparison: MutationComparison | undefined = expectedFailure === undefined ? undefined : {
        expectedFailure, stage: 'preparing', outcome: 'incomplete', baselineExitCode: null, mutationExitCode: null,
      }
      const recordEvidence = (evidence: Check['evidence']) => {
        if (!task || !check) return
        return saveEvidence(ctx, task, index, evidence)
      }
      const run = async () => {
        const before = check && scope === 'workspace' ? await workspaceSourceState(ctx.cwd, executionSignal) : undefined
        const entryChanges = before ? await watchWorkspaceEntries(before, executionSignal) : undefined
        const execute = async (snapshotCwd?: string) => {
          executionSignal.throwIfAborted()
          const phase = comparison?.stage === 'baseline' ? 'Baseline command' : comparison ? 'Mutation command' : undefined
          const heading = phase ? { type: 'text' as const, text: phase } : undefined
          if (heading) onUpdate?.({ content: [heading], details: {} })
          const outcome = await ctx.executeTool(shell, {
            command: verificationCommand(command, shell, snapshotCwd),
          }, { signal: executionSignal, onUpdate: update => {
            output = update.content.filter(block => block.type === 'text')
            onUpdate?.(heading ? { ...update, content: [heading, ...update.content] } : update)
          } })
          const transcript = outcome.result.structuredContent as
            { exit_code?: number; output?: string; truncated?: boolean; full_output_path?: string } | undefined
          const code = transcript?.exit_code
          exitCode = Number.isInteger(code) ? code! : null
          output = outcome.result.content.filter(block => block.type === 'text')
          const passed = !outcome.isError && exitCode === 0
          status = passed ? 'passed' : 'failed'
          if (comparison?.stage === 'baseline') comparison.baselineExitCode = exitCode
          if (comparison?.stage === 'mutation') comparison.mutationExitCode = exitCode
          executionSignal.throwIfAborted()
          if (before && passed) {
            const after = await workspaceSourceState(ctx.cwd, executionSignal)
            executionSignal.throwIfAborted()
            const sameBytes = after.fingerprint === before.fingerprint
            const changedFile = firstChangedSource(before, after) ?? (sameBytes ? await entryChanges?.firstChangedEntry() : undefined)
            if (!changedFile && sameBytes) {
              proof = { fingerprint: after.fingerprint, toolCallId, at: new Date().toISOString() }
            } else {
              status = 'stale'
              note = 'Workspace sources changed during this command' + (changedFile ? ' (' + JSON.stringify(changedFile) + ')' : '') +
                '. Rerun the check with stable sources to record acceptance evidence.'
            }
          }
          return { passed, exitCode, transcript }
        }
        try {
          if (comparison && mutations) {
            await withVerificationPair(ctx.cwd, executionSignal, async (baselineCwd, mutationCwd, snapshot) => {
              const checkedFingerprint = declaredMutation ? await verificationSnapshotFingerprint(snapshot, executionSignal) : undefined
              await applyVerificationMutations(mutationCwd, mutations, executionSignal)
              mutationsApplied = mutations.length
              comparison.stage = 'baseline'
              const baseline = await execute(baselineCwd)
              const baselineDiagnostic = baseline.passed ?
                await verificationOutputContains(baseline.transcript, comparison.expectedFailure, executionSignal) : undefined
              if (!baseline.passed || baselineDiagnostic === true) {
                comparison.outcome = 'baseline_failed'
                status = 'failed'
                note = baselineDiagnostic ? 'The baseline printed the expected failure diagnostic.' : 'The baseline command failed.'
                return
              }
              if (baselineDiagnostic === undefined) {
                status = 'unavailable'
                note = 'The shell output for the baseline could not be verified.'
                return
              }
              baselineOutput = [{ type: 'text', text: 'Baseline output' }, ...output]
              output = []
              exitCode = null
              comparison.stage = 'mutation'
              const mutation = await execute(mutationCwd)
              if (mutation.passed) {
                comparison.outcome = 'survived'
                status = 'failed'
                note = 'The mutated command still passed.'
                return
              }
              const diagnostic = await verificationOutputContains(mutation.transcript, comparison.expectedFailure, executionSignal)
              if (diagnostic === undefined) {
                status = 'unavailable'
                note = 'The shell output for the mutated copy could not be verified.'
                return
              }
              // Shell launch errors and signal exits are outside the regular test failure range.
              const mutationExitCode = mutation.exitCode
              if (diagnostic && mutationExitCode !== null && mutationExitCode > 0 && mutationExitCode < 126) {
                comparison.outcome = 'detected'
                status = 'passed'
                note = 'The baseline passed. The mutated run reported ' + JSON.stringify(comparison.expectedFailure) + '.'
                if (checkedFingerprint !== undefined) {
                  if (await workspaceFingerprint(ctx.cwd, executionSignal) === checkedFingerprint) {
                    proof = { fingerprint: checkedFingerprint, toolCallId, at: new Date().toISOString(),
                      mutation: { baselineExitCode: 0, mutationExitCode } }
                  } else {
                    status = 'stale'
                    note += ' The workspace no longer matches the tested source. Rerun the numbered check on current sources.'
                  }
                }
              } else {
                comparison.outcome = 'unexpected_failure'
                status = 'failed'
                note = 'The mutated run failed without verified evidence of the expected assertion.'
              }
            })
          } else if (scope === 'snapshot') {
            await withVerificationSnapshot(ctx.cwd, executionSignal, async snapshotCwd => {
              if (mutations) {
                await applyVerificationMutations(snapshotCwd, mutations, executionSignal)
                mutationsApplied = mutations.length
              }
              await execute(snapshotCwd)
            })
          } else {
            await execute()
          }
        } finally {
          entryChanges?.close()
        }
      }
      try {
        executionSignal.throwIfAborted()
        // Persist the pending check before the new attempt can be interrupted.
        if (check?.evidence) recordEvidence(undefined)
        terminationConfirmed = await waitForVerification(run(), executionSignal)
        executionSignal.throwIfAborted()
      } catch (error) {
        status = signal?.aborted ? 'aborted' : deadline.aborted ? 'timed_out' : 'unavailable'
        if (comparison?.outcome === 'detected') comparison.outcome = 'incomplete'
        if (!terminationConfirmed) {
          if (scope === 'workspace') shellStillRunning = true
          note = scope === 'snapshot'
            ? 'The shell has not confirmed termination. Cleanup waits for it to stop. The mutation is confined to the snapshot.'
            : 'The shell has not confirmed termination. Check the running process before continuing work in this directory.'
        } else if (status === 'unavailable') {
          note = String((error as Error)?.message ?? error)
        }
        proof = undefined
      }
      const resultStatus = status as VerificationStatus
      const recordedTask = proof ? recordEvidence(proof) : undefined
      const headings = comparison ? 'Mutation verification ' + resultStatus +
        (comparison.baselineExitCode !== null ? ' · baseline exit ' + comparison.baselineExitCode : '') +
        (comparison.mutationExitCode !== null ? ' · mutation exit ' + comparison.mutationExitCode : '') :
        'Verification ' + resultStatus + ' (' + scope + ')' + (exitCode !== null ? ' · exit ' + exitCode : '')
      const summary = headings +
        (resultStatus === 'timed_out' ? ' · deadline ' + timeout + 's' : '') + (note ? '\n' + note : '')
      const outputHeading = comparison && output.length > 0 && comparison.stage !== 'preparing' ?
        [{ type: 'text' as const, text: comparison.stage === 'baseline' ? 'Baseline output' : 'Mutation output' }] : []
      return {
        content: [{ type: 'text' as const, text: summary }, ...baselineOutput, ...outputHeading, ...output],
        details: { verification: { status: resultStatus, scope, exitCode, timeout, mutationsApplied, terminationConfirmed,
          recorded: proof !== undefined, ...(comparison ? { comparison } : {}) } },
        isError: resultStatus !== 'passed',
        terminate: stopAfterEvidence(ctx, recordedTask),
      }
    },
  })

  pi.registerTool({
    name: 'review_changes',
    label: 'Review changes',
    description: 'Review Git changes independently with two read-only Pi reviewers. Both inspect the same captured source. Optional paths narrow the review. A numbered task check requires coverage of all changes against HEAD and no blocking findings.',
    promptSnippet: 'Review significant code changes independently for correctness and test gaps.',
    executionMode: 'sequential',
    parameters: Type.Object({
      goal: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: 'Review goal for a standalone request. A numbered check uses the recorded task and criterion.' })),
      timeout: Type.Integer({ minimum: 1, maximum: 2_147_483, description: 'Total seconds for capture and both review requests.' }),
      check: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })),
      paths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { minItems: 1, maxItems: 30 })),
      base: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: 'Git revision to compare with. Defaults to HEAD.' })),
    }, { additionalProperties: false }),
    async execute(id, { goal, check, paths, base, timeout }, signal, update, ctx) {
      const task = currentTask(ctx)
      const index = (check ?? 0) - 1
      const item = task?.checks[index]
      if (check !== undefined && (task?.status !== 'active' || !item?.review || (base !== undefined && base !== 'HEAD'))) {
        return taskResult(task, 'Use a numbered independent review check on the active task with HEAD as the base.', true)
      }
      if (check !== undefined) engaged = true
      if ((goal !== undefined && !validText(goal)) || paths?.some(path => !validText(path)) || (base && !validText(base))) {
        return taskResult(task, 'Use valid review scope and goal text.', true)
      }
      const retry = pi.getSettings().retry
      const appendCheckpoint = ctx.sessionManager.getSessionFile() ?
        (checkpoint: unknown) => pi.appendEntry(REVIEW_CHECKPOINT, checkpoint) : undefined
      const review = await reviewChanges(ctx, {
        goal: task && item ? task.goal + '\n' + item.description : goal ?? task?.goal ?? 'Review the changed behavior.',
        paths, base, timeout, taskCheck: check !== undefined, retryStreams: retry?.enabled !== false && retry?.maxRetries !== 0,
      }, signal, (count, requests, recovering) => update?.({
        content: [{ type: 'text', text: 'Independent reviewers returned ' + count + '/2' +
          (recovering ? ' · Resuming ' + recovering + ' from captured source' : '') }],
        details: { reviewProgress: { completed: count, requests, recovering } },
      }), appendCheckpoint)
      let recorded = false
      let savedNewEvidence = false
      let reviewedTask = task
      if (task && item && review.status !== 'aborted') {
        const previous = item.evidence
        const sameSource = previous && 'fingerprint' in previous && previous.fingerprint === review.fingerprint
        const accepted = review.status === 'clear' && review.uncoveredCount === 0
        const evidence = accepted ? (sameSource ? previous : {
          fingerprint: review.fingerprint, at: new Date().toISOString(), toolCallId: id,
        }) : undefined
        recorded = evidence !== undefined
        if (evidence !== previous) {
          reviewedTask = saveEvidence(ctx, task, index, evidence)
          savedNewEvidence = recorded
        }
      }
      const blocking = review.reviewers.some(reviewer => reviewer.findings?.some(finding => finding.severity === 'blocking'))
      let remaining = 'The recorded review can be used for delivery checks.'
      if (blocking) remaining = 'Independent review has blocking findings on this source. Address the cited findings before reviewing again.'
      else if (review.uncoveredCount) remaining = 'Independent review still needs the changed files outside the selected paths.'
      else if (review.omitted.length) remaining = 'Independent review still needs evidence for the files outside text coverage.'
      else if (review.pendingReviewers.length) remaining = 'Independent review still needs complete reports from ' + review.pendingReviewers.join(' and ') + '.'
      const repeated = review.repeated && review.status !== 'stale' && !savedNewEvidence
      const lines = ['Independent review ' + review.status, review.message, review.checkpointWarning,
        blocking && review.pendingReviewers.length ? 'Pending static coverage · ' + review.pendingReviewers.join(', ') : '',
        review.reused.length ? 'Reports carried forward: ' + review.reused.join(', ') : '',
        review.omitted.length ? 'Outside text coverage: ' + review.omitted.join(', ') : '',
        review.uncoveredCount ? 'Scope excludes ' + review.uncoveredCount + ' changed file(s): ' + review.uncovered.join(', ') : '']
      for (const reviewer of review.reviewers) {
        lines.push(reviewer.focus + ' · ' + reviewer.status + (reviewer.summary ? ' · ' + reviewer.summary : ''))
        if (reviewer.fallback) lines.push('File discovery resumed · ' + reviewer.fallback)
        if (reviewer.recovery) lines.push('Review resumed from captured source · request ' + reviewer.recovery.request)
        if (reviewer.restoredReads) lines.push('Source excerpts restored · ' + reviewer.restoredReads)
        if (reviewer.sourceRanges?.length) lines.push('Source ranges saved · ' + reviewer.sourceRanges.length)
        if (reviewer.failure) lines.push('Model result · ' + reviewer.failure)
        if (reviewer.limitation) lines.push('Coverage limitation · ' + reviewer.limitation)
        if (reviewer.notes) lines.push('Notes · ' + reviewer.notes)
        for (const finding of reviewer.findings ?? []) lines.push(
          finding.severity + ' · ' + finding.path + ':' + finding.line + ' · ' + finding.problem)
      }
      if (review.execution === 'reused') lines.push(remaining, 'The source and effective review scope are unchanged. This result uses the existing reports.')
      else if (review.pendingReviewers.length && !blocking && (review.execution === 'new' || review.execution === 'resumed')) lines.push(remaining)
      return {
        content: [{ type: 'text', text: lines.filter(Boolean).join('\n') }],
        details: { review: { ...review, recorded, check, repeated, remaining } },
        isError: !['clear', 'findings', 'no_changes'].includes(review.status) ||
          (check !== undefined && review.uncoveredCount > 0),
        terminate: repeated || (recorded && stopAfterEvidence(ctx, reviewedTask)),
      }
    },
  })

  pi.on('agent_before_settle', async (event, ctx) => {
    if (!engaged || event.outcome !== 'completed' || ctx.signal?.aborted) return
    let task = currentTask(ctx)
    let entries = event.entries
    const pendingInput = () => !canFinish(ctx) || event.continue || event.context.pendingMessages.length > 0
    const finishAutomatically = automaticFinishPending && task?.status === 'active' && task.finishWhenVerified &&
      hasAllEvidence(task) && !pendingInput()
    if (task && ((task.status === 'complete' && completedHere) || finishAutomatically)) {
      const checked = await refreshSourceEvidence(task, ctx.cwd, ctx.signal)
      if (checked !== task) {
        task = checked
        entries = [...entries, { type: 'custom', customType: TASK, data: task }]
        showTask(ctx, task)
      } else if (finishAutomatically && !pendingInput()) {
        const completed = { ...task, status: 'complete' as const }
        showTask(ctx, completed)
        return { entries: [...entries,
          { type: 'custom', customType: TASK, data: completed },
          { type: 'custom_message', customType: RECEIPT, display: true, content: receiptText(completed),
            details: { goal: completed.goal, checks: completed.checks.length } },
        ] }
      }
    }
    const settlement = entries === event.entries ? undefined : { entries }
    if (pendingInput()) return settlement
    const last = event.context.contextMessages.at(-1)
    if (last?.role === 'toolResult' && last.toolName === 'review_changes') {
      const { review } = (last.details ?? {}) as { review?: { repeated?: boolean; check?: number; remaining: string } }
      if (review?.repeated) {
        const item = review.check && task?.checks[review.check - 1]
        if (task?.status === 'active' && item && !item.evidence) {
          task = { ...task, status: 'blocked', blocker: review.remaining }
          showTask(ctx, task)
          return { entries: [...entries, { type: 'custom', customType: TASK, data: task }] }
        }
        return settlement
      }
    }
    if (nudged) return settlement
    if (!task || task.status !== 'active') return settlement
    nudged = true
    const content = 'This task still needs an explicit delivery decision. Continue from the current workspace. ' +
      'Complete the pending checks, inspect recorded evidence and finish, or record the concrete blocker.\n\n' + taskSummary(task)
    return {
      entries: [...entries, { type: 'custom_message', customType: TASK, content, display: false }],
      continue: true,
    }
  })
}

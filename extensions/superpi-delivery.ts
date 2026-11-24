import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { scanTextBytes } from './superpi-text-bytes.mjs'
import { applyVerificationMutations, verificationCommand, waitForVerification, withVerificationSnapshot, workspaceFingerprint } from './superpi-verification.mjs'

const TASK = 'superpi-task'
const shells = Type.Union([Type.Literal('bash'), Type.Literal('powershell')])
const commandText = Type.String({ minLength: 1, maxLength: 32_768 })
const checklistText = Type.String({ minLength: 1, maxLength: 400 })
const statusActions = Type.Union([
  Type.Literal('start'), Type.Literal('status'), Type.Literal('observe'),
  Type.Literal('block'), Type.Literal('resume'), Type.Literal('finish'),
])

type Check = {
  description: string
  command?: string
  shell?: 'bash' | 'powershell'
  evidence?: { at: string; observation: string } | { at: string; fingerprint: string; toolCallId: string }
}

type Task = {
  version: 1
  goal: string
  status: 'active' | 'blocked' | 'complete'
  checks: Check[]
  blocker?: string
}

type VerificationStatus = 'passed' | 'failed' | 'timed_out' | 'aborted' | 'unavailable'

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
    const label = !check.evidence ? 'pending' : 'fingerprint' in check.evidence ? 'command passed' : 'observed'
    const proof = !check.evidence ? '' : ' · ' + check.evidence.at +
      ('observation' in check.evidence ? ' · ' + check.evidence.observation : ' · tool ' + check.evidence.toolCallId)
    return (index + 1) + '. [' + label + '] ' + check.description + (check.command ? '\n   $ ' + check.command : '') + proof
  })].join('\n')
}

function taskResult(task: Task | undefined, note?: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text: [note, taskSummary(task)].filter(Boolean).join('\n\n') }],
    details: { task }, isError,
  }
}

function showTask(ctx: ExtensionContext, task = currentTask(ctx)) {
  const count = task?.checks.filter(check => check.evidence).length
  const status = task?.status === 'complete' ? '已完成 / Complete' : task?.status === 'blocked' ? '待处理 / Blocked' : '进行中 / In progress'
  ctx.ui.setWidget(TASK, task ? ['任务 / Task · ' + count + '/' + task.checks.length + ' · ' + status] : undefined)
}

function validText(value: string | undefined) {
  return typeof value === 'string' && value.trim() !== '' && scanTextBytes(value).clean
}

export default function delivery(pi: ExtensionAPI) {
  let engaged = false
  let nudged = false
  let waitingForUser = false
  let shellStillRunning = false

  const save = (ctx: ExtensionContext, task: Task) => {
    pi.appendEntry(TASK, task)
    showTask(ctx, task)
  }
  const resetActivity = () => {
    engaged = false
    nudged = false
    waitingForUser = false
    shellStillRunning = false
  }
  const restore = (_event: unknown, ctx: ExtensionContext) => {
    resetActivity()
    showTask(ctx)
  }
  pi.on('session_start', restore)
  pi.on('session_switch', restore)
  pi.on('session_tree', restore)
  pi.on('agent_settled', resetActivity)
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
    description: 'Manage a branch-local delivery checklist. Start with the user goal and executable or directly observable acceptance checks. Use verify for command checks. Use observe for inspected artifacts, block for a real dependency, resume to continue, and finish after evidence is recorded.',
    promptSnippet: 'Track acceptance checks and actual evidence for multi-step work.',
    promptGuidelines: [
      'Use task_progress for multi-step coding work and read its status when resuming. Keep the list tied to the user request. Include regression and compatibility checks when relevant.',
      'Record actual observations with file, test, or artifact references. Use verify with the numbered check for command evidence. Call finish before reporting a tracked task complete.',
    ],
    executionMode: 'sequential',
    parameters: Type.Object({
      action: statusActions,
      goal: Type.Optional(checklistText),
      checks: Type.Optional(Type.Array(Type.Object({
        description: checklistText,
        command: Type.Optional(commandText),
        shell: Type.Optional(shells),
      }, { additionalProperties: false }), { minItems: 1, maxItems: 12 })),
      check: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })),
      observation: Type.Optional(checklistText),
      reason: Type.Optional(checklistText),
      replace: Type.Optional(Type.Boolean({ description: 'Use only when the user changes the goal or acceptance criteria of a task in progress.' })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      let task = currentTask(ctx)
      if (params.action === 'status') return taskResult(task)
      if (params.action === 'start') {
        if (task && task.status !== 'complete' && !params.replace) return taskResult(task, 'A task already exists. Resume it or explicitly replace it when the user changes scope.', true)
        if (!validText(params.goal) || !params.checks?.length || params.checks.some(check =>
          !validText(check.description) || (check.command !== undefined && !validText(check.command)))) {
          return taskResult(task, 'Provide a goal and at least one specific acceptance check with valid text.', true)
        }
        task = { version: 1, status: 'active', goal: params.goal!.trim(), checks: params.checks }
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
            if (!check || check.command || !validText(params.observation)) {
              return taskResult(task, 'Select an observation check and describe what you inspected. Run command checks with verify.', true)
            }
            const evidence = { observation: params.observation!.trim(), at: new Date().toISOString() }
            task = { ...task, checks: task.checks.map((item, i) => i === index ? { ...item, evidence } : item) }
          } else {
            if (task.checks.some(check => !check.evidence)) return taskResult(task, 'Acceptance checks are still pending.', true)
            if (task.checks.some(check => check.command)) {
              const inspectSignal = signal ?? AbortSignal.timeout(30_000)
              const fingerprint = await workspaceFingerprint(ctx.cwd, inspectSignal)
              inspectSignal.throwIfAborted()
              const checks = task.checks.map(check => check.evidence && 'fingerprint' in check.evidence &&
                check.evidence.fingerprint !== fingerprint ? { ...check, evidence: undefined } : check)
              if (checks.some(check => !check.evidence)) {
                task = { ...task, checks }
                save(ctx, task)
                return taskResult(task, 'Workspace sources changed after verification. Rerun the pending command checks.', true)
              }
            }
            task = { ...task, status: 'complete' }
          }
        }
      }
      signal?.throwIfAborted()
      save(ctx, task)
      return taskResult(task)
    },
  })

  pi.registerTool({
    name: 'verify',
    label: 'Verify',
    description: 'Run a real verification command with a deadline and preserved exit status. Use workspace for normal checks. For mutation experiments use snapshot and specify exact text replacements before running the check. The snapshot copies tracked and non-ignored files. Include any dependency setup in the command.',
    promptSnippet: 'Run bounded checks and use disposable snapshots for mutation experiments.',
    promptGuidelines: [
      'Use verify for builds and tests, with a deadline appropriate to the command. Declare deliberate mutations as exact replacements in a snapshot and invoke tests there using relative paths.',
      'After changes, use the exact command declared on a task check and pass its number to record evidence. A timeout or a snapshot experiment cannot complete a command check.',
    ],
    reachesTools: ['bash', 'powershell'],
    executionMode: 'sequential',
    parameters: Type.Object({
      command: commandText,
      timeout: Type.Integer({ minimum: 1, maximum: 2_147_483, description: 'Total deadline in seconds, including snapshot preparation.' }),
      scope: Type.Optional(Type.Union([Type.Literal('workspace'), Type.Literal('snapshot')])),
      shell: Type.Optional(shells),
      check: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })),
      mutations: Type.Optional(Type.Array(Type.Object({
        path: Type.String({ minLength: 1, maxLength: 4096 }),
        oldText: commandText,
        newText: Type.String({ maxLength: 32_768 }),
      }, { additionalProperties: false }), { minItems: 1, maxItems: 12 })),
    }, { additionalProperties: false }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { command, timeout, scope = 'workspace', shell = 'bash' } = params
      const task = currentTask(ctx)
      const index = (params.check ?? 0) - 1
      const check = task?.checks[index]
      if (!validText(command)) return taskResult(task, 'Provide a non-empty verification command with valid text.', true)
      if (params.mutations && scope !== 'snapshot') return taskResult(task, 'Mutations require a disposable verification snapshot.', true)
      if (params.check !== undefined && (scope !== 'workspace' || task?.status !== 'active' ||
        check?.command !== command || (check.shell ?? 'bash') !== shell)) {
        return taskResult(task, 'Use the exact command and shell of a recorded check in the active task workspace.', true)
      }
      if (!ctx.tools.some(tool => tool.name === shell)) return taskResult(task, 'The selected shell is not enabled for this session.', true)
      if (check) engaged = true

      const deadline = AbortSignal.timeout(timeout * 1000)
      const executionSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
      let status: VerificationStatus = 'unavailable'
      let exitCode: number | null = null
      let output: { type: 'text'; text: string }[] = []
      let note = ''
      let proof: Check['evidence']
      let mutationsApplied = 0
      let terminationConfirmed = true
      const run = async () => {
        const before = check ? await workspaceFingerprint(ctx.cwd, executionSignal) : undefined
        const execute = async (snapshotCwd?: string) => {
          executionSignal.throwIfAborted()
          const outcome = await ctx.executeTool(shell, {
            command: verificationCommand(command, shell, snapshotCwd),
          }, { signal: executionSignal, onUpdate: update => {
            output = update.content.filter(block => block.type === 'text')
            onUpdate?.(update)
          } })
          const code = (outcome.result.structuredContent as { exit_code?: number } | undefined)?.exit_code
          exitCode = Number.isInteger(code) ? code! : null
          output = outcome.result.content.filter(block => block.type === 'text')
          status = outcome.isError || exitCode !== 0 ? 'failed' : 'passed'
          executionSignal.throwIfAborted()
          if (before && status === 'passed') {
            const after = await workspaceFingerprint(ctx.cwd, executionSignal)
            executionSignal.throwIfAborted()
            if (after === before) proof = { fingerprint: after, toolCallId, at: new Date().toISOString() }
            else note = 'Workspace sources changed during this command. Its exit status is recorded without acceptance evidence.'
          }
        }
        if (scope === 'snapshot') {
          await withVerificationSnapshot(ctx.cwd, executionSignal, async snapshotCwd => {
            if (params.mutations) {
              await applyVerificationMutations(snapshotCwd, params.mutations, executionSignal)
              mutationsApplied = params.mutations.length
            }
            await execute(snapshotCwd)
          })
        } else {
          await execute()
        }
      }
      try {
        terminationConfirmed = await waitForVerification(run(), executionSignal)
        executionSignal.throwIfAborted()
      } catch (error) {
        status = signal?.aborted ? 'aborted' : deadline.aborted ? 'timed_out' : 'unavailable'
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
      if (task && check && resultStatus !== 'aborted') {
        save(ctx, { ...task, checks: task.checks.map((item, i) => i === index ? { ...item, evidence: proof } : item) })
      }
      const summary = 'Verification ' + resultStatus + ' (' + scope + ')' +
        (exitCode !== null ? ' · exit ' + exitCode : '') +
        (resultStatus === 'timed_out' ? ' · deadline ' + timeout + 's' : '') + (note ? '\n' + note : '')
      return {
        content: [{ type: 'text' as const, text: summary }, ...output],
        details: { verification: { status: resultStatus, scope, exitCode, timeout, mutationsApplied, terminationConfirmed,
          recorded: proof !== undefined } },
        isError: resultStatus !== 'passed',
      }
    },
  })

  pi.on('agent_before_settle', (event, ctx) => {
    if (!engaged || nudged || waitingForUser || shellStillRunning || event.outcome !== 'completed' || event.continue ||
      ctx.signal?.aborted || ctx.hasPendingMessages() || event.context.pendingMessages.length) return
    const task = currentTask(ctx)
    if (!task || task.status !== 'active') return
    nudged = true
    const content = 'This task still needs an explicit delivery decision. Continue from the current workspace. ' +
      'Complete the pending checks, inspect recorded evidence and finish, or record the concrete blocker.\n\n' + taskSummary(task)
    return {
      entries: [...event.entries, { type: 'custom_message', customType: TASK, content, display: false }],
      continue: true,
    }
  })
}

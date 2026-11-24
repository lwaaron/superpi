/** Real Pi session and shell hooks. Scripted model events need no listening socket or credentials. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { waitForVerification } from '../extensions/superpi-verification.mjs'
import { PiProcess } from '../src/pi-rpc.mjs'
import { requireRuntime } from './preflight.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const runtime = requireRuntime()
const sdkPath = path.join(runtime.packageDir, 'dist', 'index.js')
const { createAgentSession, SessionManager, SettingsManager } = await import(pathToFileURL(sdkPath))
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'superpi-delivery-'))
const agentDir = path.join(temp, 'agent')
const workspace = path.join(temp, 'working tree')
const sessionDir = path.join(temp, 'sessions')
const config = { defaultProvider: 'scripted', defaultModel: 'fixture', retry: { enabled: false }, compaction: { enabled: false } }
const guardPath = path.join(temp, 'context-guard.json')
const outputWidget = new Map()
const lifecycleErrors = []
let taskDialog
const shell = process.platform === 'win32' ? 'powershell' : 'bash'
let session
let checks = 0

function check(value, message) {
  checks += 1
  assert.ok(value, message)
}

function git(...args) {
  execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: workspace, timeout: 8000 })
}

const tool = (id, name, args) => ({ type: 'toolCall', id, name, arguments: args })
const verification = (id, args) => tool(id, 'verify', { timeout: 5, shell, ...args })
const task = (id, action, args) => tool(id, 'task_progress', { action, ...args })

async function attach(manager) {
  const created = await createAgentSession({ cwd: workspace, agentDir, sessionManager: manager,
    settingsManager: SettingsManager.inMemory(config), tools: ['read', 'write', shell, 'verify', 'task_progress'] })
  const current = created.session
  await current.bindExtensions({
    mode: 'tui',
    uiContext: { setWidget: (key, lines) => outputWidget.set(key, lines),
      editor: async (title, text) => { taskDialog = { title, text } } },
    onError: error => lifecycleErrors.push(error),
  })
  return current
}

async function run(prompt, ...replies) {
  const modelCalls = []
  const events = []
  const unsubscribe = session.subscribe(event => events.push(event))
  session.agent.streamFunction = (model, context) => {
    modelCalls.push(context)
    const reply = replies.shift()
    assert.notEqual(reply, undefined, 'an unexpected model request must fail the fixture')
    const stopReason = typeof reply === 'string' ? 'stop' : 'toolUse'
    const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost }
    const message = { role: 'assistant', content: [typeof reply === 'string' ? { type: 'text', text: reply } : reply],
      api: model.api, provider: model.provider, model: model.id, usage, stopReason, timestamp: Date.now() }
    return {
      async *[Symbol.asyncIterator]() { yield { type: 'done', reason: stopReason, message } },
      async result() { return message },
    }
  }
  const timer = setTimeout(() => void session.abort(), 15_000)
  try {
    await session.prompt(prompt)
  } finally {
    clearTimeout(timer)
    unsubscribe()
  }
  assert.equal(replies.length, 0, 'all expected requests ran')
  assert.equal(events.at(-1)?.type, 'agent_settled')
  assert.equal(events.at(-1)?.aborted, false)
  const result = id => events.find(event => event.type === 'message_end' &&
    event.message.role === 'toolResult' && event.message.toolCallId === id)?.message
  return { modelCalls, events, result }
}

try {
  const extensionDir = path.join(agentDir, 'extensions')
  await fs.mkdir(extensionDir, { recursive: true })
  await fs.mkdir(workspace, { recursive: true })
  for (const file of ['superpi-delivery.ts', 'superpi-verification.mjs', 'superpi-text-bytes.mjs',
    'superpi-review.mjs',
    'superpi-context-guard.ts', 'superpi-context-guard.mjs', 'superpi-modalities.mjs',
    'superpi-turn-recovery.ts', 'superpi-turn-verdict.mjs']) {
    await fs.copyFile(path.join(root, 'extensions', file), path.join(extensionDir, file))
  }
  await fs.writeFile(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { scripted: {
    baseUrl: 'http://superpi-delivery.invalid/v1', api: 'openai-completions', apiKey: 'fixture',
    models: [{ id: 'fixture', contextWindow: 100_000, maxTokens: 4096, input: ['text', 'image'] }],
  } } }))
  process.env.SUPERPI_CONTEXT_GUARD = guardPath
  process.env.SUPERPI_MODALITIES = path.join(temp, 'modalities.json')
  await fs.writeFile(guardPath, JSON.stringify({ autoRetryCooldownMs: 0 }))
  git('init', '--quiet')
  await fs.writeFile(path.join(workspace, '.gitignore'), 'ignored.txt\n')
  await fs.writeFile(path.join(workspace, 'source.txt'), 'base')
  git('add', '.gitignore', 'source.txt')
  await fs.writeFile(path.join(workspace, 'source.txt'), 'current')
  await fs.writeFile(path.join(workspace, 'new.txt'), 'draft')
  await fs.writeFile(path.join(workspace, 'ignored.txt'), 'private data')
  session = await attach(SessionManager.create(workspace, sessionDir))
  check(session.getActiveToolNames().includes('verify'), 'Pi advertises the real shipped verify tool')

  const mutation = { path: 'source.txt', oldText: 'current', newText: 'broken' }
  const hanging = 'node -e "const f=require(\'node:fs\'); if(f.existsSync(\'ignored.txt\') || f.readFileSync(\'source.txt\',\'utf8\')!==\'broken\' || f.readFileSync(\'new.txt\',\'utf8\')!==\'draft\') process.exit(7); console.log(\'fixture: \'+process.cwd()); setTimeout(()=>{},2500)"'
  const started = performance.now()
  const timed = await run('Run a hanging mutation', verification('timeout',
    { command: hanging, timeout: 2, scope: 'snapshot', mutations: [mutation] }), 'The mutation timed out.')
  const result = timed.result('timeout')
  check(result?.isError && result.details.verification.status === 'timed_out',
    'the native session gets a typed timeout: ' + JSON.stringify(result?.content))
  check(result.details.verification.mutationsApplied === 1, 'the mutation was applied in the snapshot')
  const elapsedMs = Math.round(performance.now() - started)
  check(elapsedMs < 8000, 'the hung command releases the activity without manual input')
  const snapshotCwd = result.content.find(block => block.text?.startsWith('fixture: '))?.text.split(/\r?\n/)[0].slice(9)
  check(snapshotCwd && path.resolve(snapshotCwd) !== workspace, 'the command ran with the scratch working directory')
  check(await fs.stat(snapshotCwd).catch(error => error.code) === 'ENOENT', 'the snapshot is gone after timeout')
  check(await fs.readFile(path.join(workspace, 'source.txt'), 'utf8') === 'current', 'the original dirty file is byte intact')
  check(await waitForVerification(new Promise(() => {}), AbortSignal.abort()) === false,
    'an executor which never acknowledges abort cannot strand verification')

  const pipe = shell === 'powershell' ? 'Out-Null' : 'cat'
  const negative = await run('Reject bad verification inputs',
    verification('pipeline', { command: 'node -e "process.exit(7)" | ' + pipe }),
    verification('absent', { command: 'node -e "console.log(123)"', scope: 'snapshot', mutations: [{ ...mutation, oldText: 'absent' }] }),
    verification('escapes', { command: 'node -e "console.log(123)"', scope: 'snapshot', mutations: [{ ...mutation, path: '../source.txt' }] }),
    verification('live-mutation', { command: 'node -e "console.log(123)"', mutations: [mutation] }),
    'These checks failed.')
  check(negative.result('pipeline')?.isError && negative.result('pipeline').details.verification.exitCode === 7,
    'piping output preserves the failing test exit status')
  check(negative.result('absent')?.isError && negative.result('absent').content[0].text.includes('exactly once'),
    'a missing mutation cannot yield a false green')
  check(negative.result('escapes')?.isError && negative.result('escapes').content[0].text.includes('outside'),
    'a mutation cannot edit parent directories')
  check(negative.result('live-mutation')?.isError, 'deliberately changing code requires a snapshot')

  const command = 'node -e "process.exit(require(\'node:fs\').readFileSync(\'source.txt\',\'utf8\')===\'current\' ? 0 : 2)"'
  const plan = { goal: 'Have evidence for the source content', checks: [{ description: 'Test the cache input', command, shell }] }
  const delivery = await run('Check then deliver the change',
    task('start', 'start', plan), 'I will verify later.',
    verification('unrelated', { command: 'true', check: 1 }),
    verification('evidence', { command, check: 1 }),
    tool('stage', shell, { command: 'git add source.txt', timeout: 5 }),
    task('finish', 'finish'), 'Delivered.')
  check(delivery.modelCalls.length === 7 && JSON.stringify(delivery.modelCalls[2].messages).includes('Test the cache input'),
    'one native continuation carries the pending criterion after a normal stop')
  check(delivery.result('unrelated')?.isError, 'an unrelated command cannot satisfy the declared check')
  check(delivery.result('evidence')?.details.verification.recorded, 'a real command exit records evidence')
  check(delivery.result('finish')?.details.task.status === 'complete', 'staging the same source keeps evidence valid')
  check(outputWidget.get('superpi-task')?.[0]?.includes('1/1'), 'completion reaches the terminal widget')
  const saved = session.sessionFile
  session.dispose()
  session = await attach(SessionManager.create(workspace, sessionDir))
  check(outputWidget.get('superpi-task') === undefined, 'an empty session clears the previous widget')
  session.dispose()
  session = await attach(SessionManager.open(saved, sessionDir))
  check(outputWidget.get('superpi-task')?.[0]?.includes('1/1'), 'opening a saved session restores its own widget')
  await session.prompt('/superpi-task')
  check(taskDialog?.text?.includes('[command passed] Test the cache input'), 'the restored task command shows the recorded proof')
  const stale = await run('Validate changed source',
    task('new', 'start', plan), verification('pass', { command, check: 1 }),
    tool('edit', 'write', { path: 'source.txt', content: 'altered' }),
    task('stale-finish', 'finish'), task('block', 'block', { reason: 'Waiting for a decision.' }),
    'Waiting for a decision.')
  check(stale.result('stale-finish')?.isError && stale.result('stale-finish').content[0].text.includes('changed'),
    'source changes invalidate previously recorded command evidence')
  check(stale.result('block')?.details.task.status === 'blocked' && stale.modelCalls.length === 6,
    'a recorded blocker persists and prevents an automatic continuation')

  await fs.writeFile(path.join(workspace, 'source.txt'), 'current')
  const amended = await run('Check the final state before settlement',
    task('late-start', 'start', { ...plan, replace: true }), verification('late-verify', { command, check: 1 }),
    task('late-finish', 'finish'), tool('late-edit', 'write', { path: 'source.txt', content: 'changed after finish' }),
    'Complete.', task('late-block', 'block', { reason: 'The changed source needs verification.' }), 'Verification is pending.')
  check(amended.result('late-finish')?.details.task.status === 'complete' &&
    amended.result('late-block')?.details.task.status === 'blocked', 'settlement reopens a receipt invalidated by a late edit')
  check(JSON.stringify(amended.modelCalls.at(-2).messages).includes('Test the cache input') &&
    outputWidget.get('superpi-task')?.[0]?.includes('0/1'), 'the reopened evidence and current state are visible to the model and TUI')

  const textLeak = '<thinking>Review passed.\nHere is the final answer.'
  const recovered = await run('Check malformed final output', textLeak, 'Clean final answer.')
  check(recovered.modelCalls.length === 2 &&
    !JSON.stringify(recovered.modelCalls[1].messages).includes(textLeak), 'Pi replaces a leaked reasoning envelope in the model projection')

  const early = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKUlEQVR4nO3NQQkAAAgEsLOxJe1lCh/CYP+lek5FIBAIBAKBQCAQfAkWNITYPS/2IEIAAAAASUVORK5CYII='
  const latest = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGN4r8hLU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAGlcdD06cj5MAAAAAElFTkSuQmCC'
  const images = Array.from({ length: 6 }, (_, i) => 'shot-' + i + '.png')
  await Promise.all(images.map((name, i) => fs.writeFile(path.join(workspace, name),
    Buffer.from(i === 5 ? latest : early, 'base64'))))
  const visual = await run('Review the latest screenshot',
    ...images.map((name, i) => tool('shot-' + i, 'read', { path: name })), 'Compared latest screenshot.')
  const blocks = (activity, id) => activity.modelCalls.at(-1).messages.find(message =>
    message.role === 'toolResult' && message.toolCallId === id)?.content ?? []
  check(blocks(visual, 'shot-5').some(block => block.type === 'image' && block.data === latest),
    'the newest screenshot reaches Pi model input after four persisted images: ' + JSON.stringify({
      model: session.model?.id, input: session.model?.input, result: visual.result('shot-5')?.content.map(block => block.type),
      projected: blocks(visual, 'shot-5').map(block => block.type === 'text' ? block.text : block.data.slice(0, 20)),
    }))
  check(visual.result('shot-5')?.content.some(block => block.type === 'text' && block.text.includes(images[5])),
    'the transcript retains a re-readable file reference for the latest screenshot')
  await fs.writeFile(path.join(workspace, images[5]), Buffer.from(early, 'base64'))
  const reread = await run('Read the updated screenshot', tool('updated', 'read', { path: images[5] }), 'Compared the update.')
  check(blocks(reread, 'updated').some(block => block.type === 'image' && block.data === early),
    'a repeated read presents the new pixels rather than an omitted result or stale pixels')

  const rpc = new PiProcess({ maxEvents: 1, cwd: workspace })
  const widget = { type: 'extension_ui_request', method: 'setWidget', widgetKey: 'superpi-task', widgetLines: ['1/1'] }
  rpc.pushEvent(widget)
  rpc.pushEvent({ type: 'turn_end' })
  check(rpc.snapshot().events.length === 1 && rpc.snapshot().taskWidget === widget,
    'the panel can reattach after its last task widget fell out of the event ring')
  rpc.pushEvent({ ...widget, widgetLines: undefined })
  rpc.resetEvents()
  check(rpc.snapshot().taskWidget.widgetLines === undefined, 'session replacement retains the new branch clearing event')
  check(lifecycleErrors.length === 0, 'the native extension runner reported no lifecycle errors')
  console.log('2s verification deadline reached the next model step in ' + elapsedMs + 'ms')
  console.log('PASS (' + checks + ' checks)')
} finally {
  session?.dispose()
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 3 })
}

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
  await fs.writeFile(path.join(workspace, '.gitignore'), 'ignored.txt\n*.tmp\n!/empty/deep/source.tmp\nbuild-output/\n')
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

  const expectedFailure = 'source invariant rejected'
  const mutationTest = 'node -e "' + [
    "const fs = require('node:fs'); const value = fs.readFileSync('source.txt', 'utf8');",
    "if (fs.existsSync('run-artifact') || fs.readFileSync('new.txt', 'utf8') !== 'draft') process.exit(23);",
    "if (value === 'current') { fs.writeFileSync('run-artifact', 'baseline only'); console.log('baseline at ' + process.cwd()); }",
    "else if (value === 'broken') { console.log('mutation at ' + process.cwd()); console.error('source invariant rejected'); process.exitCode = 7; }",
    'else process.exitCode = 9;',
  ].join(' ') + '"'
  const compare = (id, args = {}) => verification(id, { command: mutationTest, scope: 'snapshot',
    mutations: [mutation], expectedFailure, ...args })
  const longMutationOutput = 'node -e "' + [
    "if (require('node:fs').readFileSync('source.txt', 'utf8') === 'broken') {",
    "  const lines = ('a'.repeat(79) + String.fromCharCode(10)).repeat(7000);",
    "  process.stdout.write(lines); console.log('source invariant rejected'); process.stdout.write(lines);",
    '  process.exitCode = 7;',
    '}',
  ].join(' ') + '"'
  const experiments = await run('Verify whether the existing test detects the source regression',
    compare('caught'),
    compare('broken-baseline', { command: 'node -e "console.error(\'source invariant rejected\'); process.exit(7)"' }),
    compare('baseline-diagnostic', { command: 'node -e "console.log(\'source invariant rejected\')"' }),
    compare('survived', { command: 'node -e "console.log(\'Test passed.\')"' }),
    compare('shell-footer', { expectedFailure: 'Command exited with code 7' }),
    compare('long-transcript', { command: longMutationOutput }),
    compare('synthetic-gap', { command: longMutationOutput, expectedFailure: 'bytes omitted ...]' }),
    compare('no-mutation', { mutations: undefined }),
    'Completed the controlled test experiments.')
  const caught = experiments.result('caught')
  const comparison = id => experiments.result(id)?.details?.verification?.comparison
  check(caught && !caught.isError && caught.details.verification.recorded === false &&
    comparison('caught')?.outcome === 'detected' && comparison('caught').baselineExitCode === 0 &&
    comparison('caught').mutationExitCode === 7, 'a passing control and the exact assertion failure prove that the mutation was detected')
  const reportedCwd = (blocks, prefix) => blocks.flatMap(block => block.text?.split(/\r?\n/) ?? []).find(line =>
    line.startsWith(prefix))?.slice(prefix.length)
  const baselineCwd = reportedCwd(caught.content, 'baseline at ')
  const mutationCwd = reportedCwd(caught.content, 'mutation at ')
  check(baselineCwd && mutationCwd && baselineCwd !== mutationCwd &&
    await fs.stat(baselineCwd).catch(error => error.code) === 'ENOENT' &&
    await fs.stat(mutationCwd).catch(error => error.code) === 'ENOENT' &&
    await fs.readFile(path.join(workspace, 'source.txt'), 'utf8') === 'current',
  'the two commands use independent snapshots of the current source, leave the workspace byte intact, and clean up both copies')
  check(experiments.result('broken-baseline')?.isError && comparison('broken-baseline')?.outcome === 'baseline_failed' &&
    comparison('broken-baseline').baselineExitCode === 7 && comparison('broken-baseline').mutationExitCode === null,
  'a broken baseline cannot prove a regression even with the expected text')
  check(experiments.result('baseline-diagnostic')?.isError && comparison('baseline-diagnostic')?.outcome === 'baseline_failed' &&
    comparison('baseline-diagnostic').baselineExitCode === 0 && comparison('baseline-diagnostic').mutationExitCode === null,
  'an assertion printed by the passing baseline is ambiguous evidence')
  check(experiments.result('survived')?.isError && comparison('survived')?.outcome === 'survived' &&
    comparison('survived').mutationExitCode === 0, 'the outcome identifies a test that passed with the mutation applied')
  check(experiments.result('shell-footer')?.isError && comparison('shell-footer')?.outcome === 'unexpected_failure' &&
    comparison('shell-footer').mutationExitCode === 7, 'the shell wrapper cannot satisfy the expected test assertion text')
  check(!experiments.result('long-transcript')?.isError && comparison('long-transcript')?.outcome === 'detected' &&
    !experiments.result('long-transcript').content.slice(1).some(block => block.text.includes(expectedFailure)),
  'the complete shell transcript can prove a diagnostic outside the visible output')
  check(experiments.result('synthetic-gap')?.isError && comparison('synthetic-gap')?.outcome === 'unexpected_failure',
    'the generated truncation marker cannot satisfy a test diagnostic')
  check(experiments.result('no-mutation')?.isError && experiments.result('no-mutation').content[0].text.includes('at least one mutation'),
    'a comparison requires a deliberate mutation')

  const numbered = await run('Require a test that detects the stated source regression',
    task('mutation-start', 'start', { goal: 'Prove the test detects the regression', checks: [{
      description: 'Detect a broken source invariant', command: mutationTest, shell,
      mutation: { mutations: [mutation], expectedFailure },
    }] }),
    task('mutation-pending', 'finish'),
    verification('wrong-scope', { command: mutationTest, check: 1, scope: 'workspace' }),
    verification('override-diagnostic', { command: mutationTest, check: 1, expectedFailure: 'an arbitrary error' }),
    verification('mutation-proof', { command: mutationTest, check: 1 }),
    tool('change-mutation-source', 'write', { path: 'source.txt', content: 'changed' }),
    task('stale-mutation-proof', 'finish'),
    tool('restore-mutation-source', 'write', { path: 'source.txt', content: 'current' }),
    verification('new-mutation-proof', { command: mutationTest, check: 1 }),
    task('mutation-finish', 'finish'), 'The test detects the regression on the current sources.')
  check(numbered.result('mutation-start')?.details?.task?.checks?.[0]?.mutation?.expectedFailure === expectedFailure,
    'the declared mutation and assertion are persisted by the native task tool')
  check(numbered.result('mutation-pending')?.isError && numbered.result('wrong-scope')?.isError &&
    numbered.result('override-diagnostic')?.isError,
  'a numbered mutation check cannot be skipped, substituted by one live run, or have its assertion overridden')
  const numberedProof = numbered.result('mutation-proof')?.details?.verification
  check(numberedProof?.recorded === true && numberedProof.scope === 'snapshot' &&
    numberedProof.comparison?.baselineExitCode === 0 && numberedProof.comparison?.mutationExitCode === 7,
  'the terminal records evidence from the passing control and the expected failure')
  check(numbered.result('stale-mutation-proof')?.isError,
    'editing the source after the comparison invalidates the numbered evidence at delivery')
  check(numbered.result('new-mutation-proof')?.details?.verification?.recorded === true &&
    numbered.result('mutation-finish')?.details?.task?.status === 'complete',
  'the task can complete after collecting fresh evidence for the current source')
  await session.prompt('/superpi-task')
  check(taskDialog?.text?.includes('[mutation detected] Detect a broken source invariant') &&
    taskDialog.text.includes(expectedFailure), 'the terminal task report shows what the test detected')

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

  const sourceFile = path.join(workspace, 'source.txt')
  const sourceTime = new Date('2020-01-01T00:00:00Z')
  await fs.utimes(sourceFile, sourceTime, sourceTime)
  await fs.writeFile(path.join(workspace, 'ignored.txt'), 'read alternate source')
  const changeDuringCheck = 'node -e "' + [
    "const fs = require('node:fs'); const source = 'source.txt'; const original = fs.readFileSync(source);",
    "if (fs.readFileSync('ignored.txt', 'utf8') === 'read alternate source') {",
    '  const times = fs.statSync(source);',
    "  try { fs.writeFileSync(source, 'another');",
    "    if (fs.readFileSync(source, 'utf8') !== 'another') process.exitCode = 7;",
    "    else console.log('test read alternate source');",
    '  } finally { fs.writeFileSync(source, original); fs.utimesSync(source, times.atime, times.mtime); }',
    '} else {',
    "  fs.writeFileSync('ignored.txt', 'build output');",
    "  require('node:child_process').execFileSync('git', ['add', source]);",
    "  if (original.toString() !== 'current') process.exitCode = 7;",
    '}',
  ].join(' ') + '"'
  const concurrentEdit = await run('Verify the source version actually read by the command',
    task('start-alternate', 'start', { ...plan, checks: [{ description: 'Verify the delivered source', command: changeDuringCheck, shell }] }),
    verification('alternate-source', { command: changeDuringCheck, check: 1 }),
    task('finish-alternate', 'finish'),
    tool('use-final-source', 'write', { path: 'ignored.txt', content: 'stable run' }),
    verification('verified-stable', { command: changeDuringCheck, check: 1 }),
    task('finish-stable', 'finish'), 'Verified the stable source.')
  const alternateSource = concurrentEdit.result('alternate-source')
  check(alternateSource?.details.verification.exitCode === 0 && alternateSource.content.some(block =>
    block.text.includes('test read alternate source')), 'the real command passes while reading the temporary source')
  check(await fs.readFile(sourceFile, 'utf8') === 'current' && (await fs.stat(sourceFile)).mtimeMs === sourceTime.getTime(),
    'the fixture restores both source bytes and the visible modification time')
  check(alternateSource?.isError && alternateSource.details.verification.status === 'stale' &&
    alternateSource.details.verification.recorded === false &&
    alternateSource.content[0].text.includes('changed during this command ("source.txt")'),
    'restored bytes and modification time cannot hide a source change during verification')
  check(concurrentEdit.result('finish-alternate')?.isError && concurrentEdit.result('finish-alternate')?.details.task.status === 'active',
    'the command that read a different version cannot deliver the task')
  check(concurrentEdit.result('verified-stable')?.details.verification.recorded &&
    concurrentEdit.result('finish-stable')?.details.task.status === 'complete' &&
    await fs.readFile(path.join(workspace, 'ignored.txt'), 'utf8') === 'build output',
  'the stable rerun records evidence even when the command stages source and writes ignored build output')

  await fs.mkdir(path.join(workspace, 'empty', 'deep'), { recursive: true })
  await fs.writeFile(path.join(workspace, 'ignored.txt'), 'exercise transient source')
  const useTransientFile = 'node -e "' + [
    "const fs = require('node:fs');",
    "const exercise = fs.readFileSync('ignored.txt', 'utf8') === 'exercise transient source';",
    "const file = exercise ? 'empty/deep/source.tmp' : 'empty/deep/ignored.tmp';",
    "fs.writeFileSync(file, 'temporary source');",
    "try { if (fs.readFileSync(file, 'utf8') !== 'temporary source') process.exitCode = 7;",
    "  else console.log('the command read ' + file); } finally { fs.unlinkSync(file); }",
    "if (!exercise) { fs.mkdirSync('build-output'); fs.writeFileSync('build-output/result.js', 'emitted'); }",
  ].join(' ') + '"'
  const transientCheck = await run('Verify a check that reads a file created after the initial scan',
    task('transient-task', 'start', { ...plan, checks: [{ description: 'Verify the actual input files', command: useTransientFile, shell }] }),
    verification('transient-source', { command: useTransientFile, check: 1 }),
    task('finish-transient', 'finish'),
    tool('select-build', 'write', { path: 'ignored.txt', content: 'normal build' }),
    verification('ignored-build', { command: useTransientFile, check: 1 }),
    task('finish-build', 'finish'), 'The build passed with stable sources.')
  const transient = transientCheck.result('transient-source')
  check(transient?.details.verification.exitCode === 0 && transient.content.some(block => block.text.includes('the command read empty/deep/source.tmp')) &&
    await fs.stat(path.join(workspace, 'empty', 'deep', 'source.tmp')).catch(error => error.code) === 'ENOENT',
  'the command used a new source file that is gone when verification ends')
  check(transient?.isError && transient.details.verification.status === 'stale' &&
    !transient.details.verification.recorded && transient.content[0].text.includes('empty/deep/source.tmp'),
  'a transient non-ignored source in a previously empty nested directory invalidates the check')
  check(transientCheck.result('finish-transient')?.isError &&
    transientCheck.result('finish-build')?.details.task.status === 'complete' &&
    transientCheck.result('ignored-build')?.details.verification.recorded &&
    await fs.readFile(path.join(workspace, 'build-output', 'result.js'), 'utf8') === 'emitted',
  'an ignored transient file and a newly created ignored build directory still permit delivery')

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

/** Prepare equivalent workspaces and grade candidates outside the files given to the agent. */
import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { cases } from './fixtures/engineering-cases.mjs'
import { scanTextBytes } from '../extensions/superpi-text-bytes.mjs'
import { detectTurnVerdict } from '../extensions/superpi-turn-verdict.mjs'
import { withVerificationSnapshot } from '../extensions/superpi-verification.mjs'
import { EXTENSION_FILES } from '../src/runtime-extensions.mjs'

const self = fileURLToPath(import.meta.url)
const root = fileURLToPath(new URL('../', import.meta.url))
const execute = promisify(execFile)
const GRADING_TIMEOUT_MS = 20_000
const sourceExtensions = new Set(['.js', '.cjs', '.mjs', '.jsx', '.ts', '.cts', '.mts', '.tsx', '.json'])

function scenario(name) {
  if (!Object.hasOwn(cases, name)) throw new Error('Unknown case. Choices: ' + Object.keys(cases).join(', '))
  return cases[name]
}

async function prepare(folder, files) {
  await fs.mkdir(folder)
  for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(folder, name), text)
}

function baselineCommit(cwd) {
  const git = (...args) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, timeout: 8000, windowsHide: true })
  git('-c', 'init.templateDir=', 'init', '--quiet')
  git('add', '--all')
  git('-c', 'user.name=SuperPi Benchmark', '-c', 'user.email=benchmark@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Benchmark starting point')
  return git('rev-parse', 'HEAD^{tree}').toString('ascii').trim()
}

async function score(name, folder) {
  const selected = scenario(name)
  let candidate
  try {
    candidate = await import(pathToFileURL(path.join(folder, selected.entry)))
  } catch (error) {
    const reason = 'Could not load the candidate. ' + String(error?.message ?? error).slice(0, 350)
    return Object.keys(selected.checks).map(label => ({ label, pass: false, reason }))
  }
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'superpi-grading-'))
  try {
    const checks = []
    for (const [label, verify] of Object.entries(selected.checks)) {
      let timer
      try {
        const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Assertion timed out')), 1800) })
        const sample = await fs.mkdtemp(path.join(temp, 'sample-'))
        await Promise.race([verify(candidate, path.join(sample, 'settings.json')), deadline])
        checks.push({ label, pass: true })
      } catch (error) {
        checks.push({ label, pass: false, reason: String(error?.message ?? error).slice(0, 350) })
      } finally {
        clearTimeout(timer)
      }
    }
    return checks
  } finally {
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 3 })
  }
}

async function grade(name, folder) {
  const selected = scenario(name)
  // Credentials are unnecessary for these deterministic, local project checks.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|LANG|LC_ALL)$/i.test(key)))
  const started = performance.now()
  const { stdout } = await execute(process.execPath, [self, 'worker', name, folder], {
    cwd: folder, env, timeout: GRADING_TIMEOUT_MS, windowsHide: true, maxBuffer: 512 * 1024,
  })
  const checks = JSON.parse(stdout.trim().split('\n').at(-1))
  const expected = Object.keys(selected.checks)
  assert.deepEqual(checks.map(item => item.label), expected)
  assert.ok(checks.every(item => typeof item.pass === 'boolean'))
  const passed = checks.filter(item => item.pass).length
  return { case: name, passed, total: expected.length, gradingMs: Math.round(performance.now() - started), checks }
}

async function inspectSourceIntegrity(snapshot, signal) {
  const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  const files = snapshot.files.filter(name => sourceExtensions.has(path.extname(name).toLowerCase()))
  const findings = []
  for (const name of files) {
    const bytes = await fs.readFile(path.join(snapshot.root, name), { signal })
    let text
    try {
      text = utf8.decode(bytes)
    } catch (error) {
      if (error.code !== 'ERR_ENCODING_INVALID_ENCODED_DATA') throw error
      findings.push({ path: name, kind: 'invalid_utf8' })
      continue
    }
    const { clean, total, counts, spans } = scanTextBytes(text)
    if (!clean) findings.push({ path: name, kind: 'bad_text', total, counts, spans })
  }
  return { filesChecked: files.length, findings }
}

function runOutcome(process, trace, task, assistant, settlement) {
  if (process.deadline === true) return 'deadline'
  if (process.interrupted === true || settlement?.aborted) return 'aborted'
  if (assistant?.stopReason === 'error' && !trace.malformedLines && trace.settlements <= 1) return 'model_error'
  if (process.exit !== 0 || process.signal) return 'process_error'
  if (trace.malformedLines || trace.settlements > 1) return 'invalid_trace'
  if (!settlement) return 'no_settlement'
  if (task?.status === 'blocked') return 'blocked'
  if (task?.status === 'active') return 'pending_checks'
  if (assistant?.stopReason !== 'stop' || !detectTurnVerdict(assistant).delivered) return 'missing_final_answer'
  return 'finished'
}

async function runMetrics(events, observed) {
  const trace = { settlements: 0, assistantResponses: 0, toolResults: 0, reviewerRequests: 0, reviewReplays: 0, malformedLines: 0 }
  const requestCounts = new Map()
  const reviewCalls = new Set()
  const knownCounts = new Set()
  const validCount = n => Number.isSafeInteger(n) && n >= 0
  const countReview = (id, requests, complete) => {
    if (!validCount(requests)) return
    if (typeof id !== 'string' || !id) { trace.reviewerRequests += requests; return }
    requestCounts.set(id, Math.max(requestCounts.get(id) ?? 0, requests))
    if (complete) knownCounts.add(id)
  }
  let assistant
  let task
  let settlement
  const lines = createInterface({ input: createReadStream(events), crlfDelay: Infinity })
  for await (const line of lines) {
    if (line.trim() === '') continue
    let record
    try { record = JSON.parse(line) } catch { trace.malformedLines += 1; continue }
    if (record?.toolName === 'review_changes' && record.toolCallId) {
      if (record.type === 'tool_execution_start') reviewCalls.add(record.toolCallId)
      if (record.type === 'tool_execution_update') countReview(record.toolCallId, record.partialResult?.details?.reviewProgress?.requests, true)
    }
    if (record?.type === 'entry_appended' && record.entry?.customType === 'superpi-task') task = record.entry.data
    if (record?.type === 'agent_settled') { settlement = record; trace.settlements += 1 }
    if (record?.type !== 'message_end') continue
    const message = record.message
    if (message?.role === 'assistant') { assistant = message; trace.assistantResponses += 1 }
    if (message?.role !== 'toolResult') continue
    trace.toolResults += 1
    const review = message.toolName === 'review_changes' ? message.details?.review : undefined
    if (!review) continue
    if (review.execution === 'reused') trace.reviewReplays += 1
    const reused = new Set(review.reused ?? [])
    const lanes = review.reviewers ?? []
    const reportedRequests = lanes.reduce((sum, lane) => !reused.has(lane.focus) && validCount(lane.requests) ? sum + lane.requests : sum, 0)
    const complete = validCount(review.newRequests) || ['no_changes', 'too_large'].includes(review.status) ||
      (lanes.length === 2 && lanes.every(lane => reused.has(lane.focus) || validCount(lane.requests)))
    countReview(message.toolCallId, review.newRequests ?? reportedRequests, complete)
  }
  for (const count of requestCounts.values()) trace.reviewerRequests += count
  const unmeteredReviews = [...reviewCalls].filter(id => !knownCounts.has(id)).length
  return { outcome: runOutcome(observed, trace, task, assistant, settlement), seconds: observed.seconds,
    task: task?.status ?? null, model: assistant?.model ?? null, ...trace, unmeteredReviews,
    ...(assistant?.errorMessage ? { reason: String(assistant.errorMessage).slice(0, 350) } : {}) }
}

function comparisonAgents() {
  const extensionArgs = EXTENSION_FILES.filter(file => file.label !== 'editor' && file.name.endsWith('.ts'))
    .flatMap(file => ['--extension', path.join(root, file.source)])
  const windowsSandbox = process.platform === 'win32' ? ['-c', 'windows.sandbox="unelevated"'] : []
  return [
    { id: 'superpi', program: process.execPath, args: [path.join(root, 'src', 'superpi-cli.mjs'),
      '--mode', 'json', '--print', '--no-session', '--no-context-files', '--no-skills', '--no-mcp', '--no-prompt-templates',
      '--no-extensions', ...extensionArgs] },
    { id: 'codex', program: 'codex', args: ['-a', 'never', ...windowsSandbox,
      'exec', '--json', '--ephemeral', '--ignore-user-config', '--sandbox', 'workspace-write', '-'] },
    { id: 'claude-code', program: 'claude', args: ['--print', '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
      '--permission-mode', 'acceptEdits', '--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--allowedTools', 'Bash(node --test*)'] },
  ]
}

async function inTime(operation, milliseconds) {
  let timer
  try {
    return await Promise.race([operation, new Promise(resolve => { timer = setTimeout(resolve, milliseconds) })])
  } finally { clearTimeout(timer) }
}

async function stopBenchmarkProcess(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    try {
      await execute('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeout: 4000, windowsHide: true })
      return
    } catch { /* Retain the process exit observation below even if the tree stop fails. */ }
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); return } catch { /* The group may have already exited. */ }
  }
  child.kill('SIGKILL')
}

async function captureRun(agent, workspace, prompt, directory, seconds) {
  const events = path.join(directory, 'events.jsonl')
  const stderrFile = path.join(directory, 'stderr.log')
  const stdout = await fs.open(events, 'wx', 0o600)
  let stderr
  try {
    stderr = await fs.open(stderrFile, 'wx', 0o600)
    const started = performance.now()
    const child = spawn(agent.program, agent.args, { cwd: workspace, stdio: ['pipe', stdout.fd, stderr.fd],
      detached: process.platform !== 'win32', windowsHide: true })
    const exit = new Promise(resolve => {
      child.once('close', (exit, signal) => resolve({ exit, signal }))
      child.once('error', error => resolve({ exit: null, signal: null, launchError: { code: error.code, message: error.message } }))
    })
    let stop
    const interrupt = new Promise(resolve => { stop = () => resolve('interrupted') })
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    try {
      child.stdin.on('error', () => {})
      child.stdin.end(prompt, 'utf8')
      const first = await inTime(Promise.race([exit, interrupt]), seconds * 1000)
      const elapsed = Number(((performance.now() - started) / 1000).toFixed(3))
      const deadline = first === undefined
      const interrupted = first === 'interrupted'
      let result = first
      if (deadline || interrupted) {
        await stopBenchmarkProcess(child)
        result = await inTime(exit, 2000)
        if (!result) child.unref()
      }
      return { events, stderrFile, receipt: { ...(result ?? { exit: null, signal: null }), seconds: elapsed,
        deadline, interrupted, terminationConfirmed: result !== undefined } }
    } finally {
      process.removeListener('SIGINT', stop)
      process.removeListener('SIGTERM', stop)
    }
  } finally {
    await stdout.close()
    await stderr?.close()
  }
}

async function thirdPartyMetrics(format, events, receipt) {
  const trace = { malformedLines: 0, settlements: 0 }
  let answer
  let failure
  let error
  let model = null
  let usage = null
  const lines = createInterface({ input: createReadStream(events), crlfDelay: Infinity })
  for await (const line of lines) {
    if (line.trim() === '') continue
    let record
    try { record = JSON.parse(line) } catch { trace.malformedLines += 1; continue }
    if (typeof record?.type !== 'string') { trace.malformedLines += 1; continue }
    if (format === 'codex') {
      if (record.type === 'item.completed' && record.item?.type === 'agent_message') answer = record.item.text
      if (record.type === 'turn.completed') { trace.settlements += 1; usage = record.usage ?? null }
      if (record.type === 'turn.failed') { trace.settlements += 1; failure = record.error?.message ?? 'Codex reported a failed turn.' }
      if (record.type === 'error') error = record.message
    } else {
      if (record.type === 'system' && record.subtype === 'init') model = record.model ?? null
      if (record.type !== 'result') continue
      trace.settlements += 1
      usage = record.usage ?? null
      if (record.subtype === 'success' && record.is_error === false) answer = record.result
      else failure = record.errors?.join?.(' ') || record.result || record.subtype || 'Claude Code reported a failed run.'
    }
  }
  let outcome
  if (receipt.deadline) outcome = 'deadline'
  else if (receipt.interrupted) outcome = 'aborted'
  else if (trace.malformedLines || trace.settlements > 1) outcome = 'invalid_trace'
  else if (failure) outcome = 'agent_error'
  else if (receipt.exit !== 0 || receipt.signal) outcome = 'process_error'
  else if (!trace.settlements) outcome = 'no_settlement'
  else if (typeof answer !== 'string' || !detectTurnVerdict({ role: 'assistant', stopReason: 'stop',
    content: [{ type: 'text', text: answer }] }).delivered) outcome = 'missing_final_answer'
  else outcome = 'finished'
  const reason = failure ?? (outcome !== 'finished' ? error : undefined)
  return { outcome, seconds: receipt.seconds, model, usage, ...trace, ...(reason ? { reason: String(reason).slice(0, 350) } : {}) }
}

async function capturedMetrics(format, events, receiptFile) {
  if (!['superpi', 'codex', 'claude-code'].includes(format)) throw new Error('Choose superpi, codex, or claude-code for the event format.')
  const observed = JSON.parse(await fs.readFile(receiptFile, 'utf8'))
  assert.ok(observed.exit === null || Number.isInteger(observed.exit), 'Expected the observed process exit status.')
  assert.ok(Number.isFinite(observed.seconds) && observed.seconds >= 0, 'Expected elapsed seconds from the process runner.')
  if (observed.launchError) return { outcome: observed.launchError.code === 'ENOENT' ? 'unavailable' : 'launch_error',
    seconds: observed.seconds, reason: observed.launchError.message }
  if (observed.terminationConfirmed === false) return { outcome: observed.deadline ? 'deadline' : 'aborted',
    seconds: observed.seconds, reason: 'Process termination could not be confirmed.' }
  return format === 'superpi' ? runMetrics(events, observed) : thirdPartyMetrics(format, events, observed)
}

async function compareCase(name, destination, seconds, agents = comparisonAgents(), workspaceParent = os.tmpdir()) {
  const selected = scenario(name)
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 2_147_483) throw new Error('Supply a positive whole-second deadline per agent.')
  await fs.mkdir(destination, { mode: 0o700 })
  const workspaceRoot = await fs.mkdtemp(path.join(workspaceParent, 'superpi-comparison-'))
  const promptFile = path.join(destination, 'prompt.txt')
  const reportFile = path.join(destination, 'comparison.json')
  const suite = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version
  const report = { case: name, suite, secondsPerAgent: seconds, platform: process.platform, arch: process.arch, node: process.version,
    workspaceRoot, promptFile, promptSha256: createHash('sha256').update(selected.prompt).digest('hex'), startingTree: null, runs: [] }
  const save = async () => {
    const pending = reportFile + '.tmp'
    await fs.writeFile(pending, JSON.stringify(report, null, 2), { mode: 0o600 })
    await fs.rename(pending, reportFile)
  }
  await fs.writeFile(promptFile, selected.prompt, { mode: 0o600 })
  await save()
  for (const agent of agents) {
    const workspace = path.join(workspaceRoot, agent.id)
    const directory = path.join(destination, agent.id)
    await prepare(workspace, selected.files)
    const startingTree = baselineCommit(workspace)
    report.startingTree ??= startingTree
    assert.equal(startingTree, report.startingTree, 'Agent workspaces must have identical starting Git trees.')
    await fs.mkdir(directory)
    const { events, stderrFile, receipt } = await captureRun(agent, workspace, selected.prompt, directory, seconds)
    const processFile = path.join(directory, 'process.json')
    await fs.writeFile(processFile, JSON.stringify(receipt, null, 2), { mode: 0o600 })
    const format = agent.format ?? agent.id
    const metrics = await capturedMetrics(format, events, processFile)
    let score = null
    let sourceIntegrity = null
    let gradingError
    if (!receipt.launchError && receipt.terminationConfirmed) {
      try {
        const signal = AbortSignal.timeout(GRADING_TIMEOUT_MS)
        await withVerificationSnapshot(workspace, signal, async (copy, snapshot) => {
          sourceIntegrity = await inspectSourceIntegrity(snapshot, signal)
          score = await grade(name, copy)
        })
      } catch (error) {
        gradingError = String(error?.message ?? error).slice(0, 350)
      }
    }
    const delivered = metrics.outcome === 'finished' && score !== null && score.passed === score.total &&
      sourceIntegrity?.findings.length === 0 && !gradingError
    let version = format === 'superpi' ? suite : null
    if (!receipt.launchError && format !== 'superpi') {
      const result = await execute(agent.program, ['--version'], { cwd: workspace, timeout: 5000, windowsHide: true }).catch(() => null)
      version = result?.stdout.trim().slice(0, 120) || null
    }
    report.runs.push({ agent: agent.id, version, invocation: [agent.program, ...agent.args], workspace, startingTree, processFile, events,
      stderrFile, metrics, score, sourceIntegrity, delivered,
      ...(gradingError ? { gradingError } : {}) })
    await save()
    if (receipt.interrupted) break
  }
  return report
}

async function selfTest() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'superpi-engineering-'))
  let count = 0
  try {
    for (const [name, selected] of Object.entries(cases)) {
      const baseline = path.join(temp, name + '-baseline')
      const reference = path.join(temp, name + '-reference')
      await prepare(baseline, selected.files)
      await prepare(reference, { ...selected.files, ...selected.reference })
      const before = await grade(name, baseline)
      const after = await grade(name, reference)
      assert.ok(before.passed < before.total, name + ' must recognize the incomplete starting point')
      assert.equal(after.passed, after.total, name + ' reference ' + JSON.stringify(after.checks.filter(check => !check.pass)))
      count += 2
      console.log(name + ' baseline ' + before.passed + '/' + before.total + ' reference ' + after.passed + '/' + after.total)
    }
    const invalid = path.join(temp, 'invalid-implementation')
    const firstCase = Object.keys(cases)[0]
    const selected = scenario(firstCase)
    await prepare(invalid, { ...selected.files, [selected.entry]: 'export const = invalid syntax' })
    const failedImport = await grade(firstCase, invalid).catch(error => ({ infrastructureError: error.message }))
    assert.equal(failedImport.passed, 0, 'an invalid candidate must receive a failed grade without crashing the comparison')
    assert.equal(failedImport.checks.length, Object.keys(selected.checks).length, 'a load error retains the common grading denominator')
    count += 2
    const traceFile = path.join(temp, 'run.jsonl')
    const receiptFile = path.join(temp, 'process.json')
    const trace = [
      { type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse' } },
      { type: 'message_end', message: { role: 'toolResult', toolName: 'review_changes', toolCallId: 'review', details: { review: {
        reviewers: [{ focus: 'tests', requests: 17 }, { focus: 'correctness', requests: 2 }], reused: ['tests'],
      } } } },
      { type: 'entry_appended', entry: { type: 'custom', customType: 'superpi-task', data: { status: 'complete' } } },
      { type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Finished.' }] } },
      { type: 'agent_settled', aborted: false },
    ]
    const writeTrace = records => fs.writeFile(traceFile, records.map(record => JSON.stringify(record)).join('\n'))
    const metrics = async (exit, deadline = false) => {
      await fs.writeFile(receiptFile, JSON.stringify({ exit, deadline, seconds: 24 }))
      const { stdout } = await execute(process.execPath, [self, 'metrics', traceFile, receiptFile], { timeout: 5000, windowsHide: true })
      return JSON.parse(stdout)
    }
    await writeTrace(trace)
    const finished = await metrics(0)
    assert.equal(finished.outcome, 'finished', 'a real final response and settlement finish the run')
    assert.deepEqual([finished.assistantResponses, finished.reviewerRequests, finished.seconds], [2, 2, 24],
      'carried-forward reports do not count as new requests')
    assert.equal((await metrics(null, true)).outcome, 'deadline', 'an externally stopped run cannot finish')
    await writeTrace([trace[0], trace[1], {
      type: 'tool_execution_update', toolName: 'review_changes', toolCallId: 'review', partialResult: { details: { reviewProgress: { requests: 2 } } },
    }, {
      type: 'tool_execution_update', toolName: 'review_changes', toolCallId: 'unfinished', partialResult: { details: { reviewProgress: { requests: 3 } } },
    }])
    assert.equal((await metrics(null, true)).reviewerRequests, 5, 'live requests before external termination are counted once')
    await writeTrace([{ type: 'tool_execution_start', toolName: 'review_changes', toolCallId: 'legacy-timeout' },
      { type: 'message_end', message: { role: 'toolResult', toolName: 'review_changes', toolCallId: 'legacy-timeout', details: {
        review: { status: 'timed_out', reviewers: [{ focus: 'tests', status: 'cancelled' }] },
      } } }])
    assert.equal((await metrics(null, true)).unmeteredReviews, 1, 'an uncounted legacy timeout is identified separately')
    await writeTrace(trace.slice(0, -1))
    assert.equal((await metrics(0)).outcome, 'no_settlement', 'process exit alone cannot finish a run')
    trace[2].entry.data.status = 'blocked'
    await writeTrace(trace)
    assert.equal((await metrics(0)).outcome, 'blocked', 'the session ledger preserves a review blocker')
    trace[2].entry.data.status = 'active'
    await writeTrace(trace)
    assert.equal((await metrics(0)).outcome, 'pending_checks', 'a normal final answer cannot clear unfinished acceptance')
    trace[3].message.stopReason = 'error'
    await writeTrace(trace)
    assert.equal((await metrics(0)).outcome, 'model_error', 'native settlement preserves provider failure')
    assert.equal((await metrics(1)).outcome, 'model_error', 'a documented model failure survives the CLI nonzero exit')
    count += 10

    const codexTrace = [{ type: 'item.completed', item: { type: 'agent_message', text: 'The requested result is ready.' } },
      { type: 'turn.completed', usage: { input_tokens: 25, output_tokens: 10 } }]
    const claudeTrace = [{ type: 'system', subtype: 'init', model: 'fixture-model' },
      { type: 'result', subtype: 'success', is_error: false, result: 'The requested result is ready.' }]
    const fixture = (id, format, records, changes = {}, hang = false) => ({ id, format, program: process.execPath, args: ['-e', [
      "const fs = require('node:fs');",
      'if (fs.readFileSync(0, "utf8") !== ' + JSON.stringify(selected.prompt) + ') process.exit(11);',
      'for (const [file, text] of Object.entries(' + JSON.stringify(selected.files) + '))',
      '  if (fs.readFileSync(file, "utf8") !== text) process.exit(12);',
      'for (const [file, data] of Object.entries(' + JSON.stringify(changes) + '))',
      '  fs.writeFileSync(file, typeof data === "string" ? data : Buffer.from(data));',
      'for (const event of ' + JSON.stringify(records) + ') console.log(JSON.stringify(event));',
      hang ? 'setInterval(() => {}, 1000);' : '',
    ].join('\n')] })
    const candidateWithSideEffect = selected.files[selected.entry] +
      '\n// 正常源码 🧪\n' +
      'await (await import("node:fs/promises")).writeFile(new URL("grading.marker", import.meta.url), "graded")\n'
    const comparisonFolder = path.join(temp, 'comparison-report')
    const report = await compareCase(firstCase, comparisonFolder, 2, [
      fixture('superpi', 'superpi', [
        { type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Finished.' }] } },
        { type: 'agent_settled', aborted: false },
      ], { ...selected.reference, [selected.entry]: candidateWithSideEffect }),
      fixture('codex', 'codex', codexTrace),
      fixture('claude-code', 'claude-code', claudeTrace, selected.reference),
      fixture('stopped', 'codex', [...codexTrace, { type: 'error', message: 'The upstream request timed out.' }], selected.reference, true),
      { id: 'missing', format: 'claude-code', program: path.join(temp, 'missing-candidate'), args: [] },
      fixture('damaged', 'claude-code', claudeTrace, { ...selected.reference,
        [selected.entry]: selected.files[selected.entry] + '\n// ' + String.fromCodePoint(0xFFFD) + '\n',
        'extra.test.mjs': [...Buffer.from('// '), 0xff, 0x0a],
      }),
    ], temp)
    const [superpi, codex, claude, stopped, missing, damaged] = report.runs
    assert.equal(damaged.metrics.outcome, 'finished')
    assert.equal(damaged.score.passed, damaged.score.total, 'the known damaged fixture still passes every functional assertion')
    assert.equal(damaged.delivered, false, 'passing behavior cannot certify delivery when the final source contains damaged bytes')
    assert.deepEqual(damaged.sourceIntegrity.findings.map(file => [file.path, file.kind]),
      [[selected.entry, 'bad_text'], ['extra.test.mjs', 'invalid_utf8']],
      'the report distinguishes replacement characters from raw malformed UTF-8 in a new test file')
    assert.equal(damaged.sourceIntegrity.findings[0].counts.replacement, 1, 'the replacement character is counted in the source file')
    assert.equal(superpi.sourceIntegrity.findings.length, 0, 'valid Chinese and emoji remain clean in the candidate source')
    await assert.rejects(fs.stat(path.join(superpi.workspace, 'grading.marker')), { code: 'ENOENT' },
      'a verifier side effect stays in the diagnostic snapshot')
    assert.equal(await fs.readFile(report.promptFile, 'utf8'), selected.prompt, 'the report retains the exact prompt delivered to each process')
    assert.ok(report.runs.every(run => run.startingTree === report.startingTree) &&
      new Set(report.runs.map(run => run.workspace)).size === 6, 'all engines start with the same Git tree in separate workspaces')
    assert.ok(superpi.delivered && superpi.metrics.outcome === 'finished', 'the independent score and terminal result both support delivery')
    assert.ok(codex.metrics.outcome === 'finished' && !codex.delivered && codex.score.passed < codex.score.total,
      'a successful exit and final reply cannot compensate for failed external assertions')
    assert.ok(claude.delivered && claude.metrics.model === 'fixture-model', 'a Claude result uses the same grader with its observed model')
    assert.ok(stopped.metrics.outcome === 'deadline' && !stopped.delivered && stopped.score?.passed === stopped.score?.total &&
      stopped.metrics.reason === 'The upstream request timed out.',
      'a timed-out process preserves the last error and stays interrupted even when its code is correct')
    assert.ok(missing.metrics.outcome === 'unavailable' && missing.score === null && !missing.delivered,
      'a missing executable is recorded without assigning a benchmark score')
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(comparisonFolder, 'comparison.json'), 'utf8')), report,
      'the comparison report matches the captured process results and scores')
    count += 15
    console.log('PASS (' + count + ' checks)')
  } finally {
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 3 })
  }
}

const [action, name, location, option] = process.argv.slice(2)
if (!action) await selfTest()
else if (action === 'list') console.log(Object.keys(cases).join('\n'))
else if (action === 'metrics') {
  if (!name || !location) throw new Error('Supply the captured JSONL events and process receipt.')
  console.log(JSON.stringify(await capturedMetrics(option ?? 'superpi', name, location), null, 2))
} else if (action === 'compare') {
  if (!name || !location || !option) throw new Error('Use compare <case> <new-report-directory> <seconds-per-agent>.')
  console.log(JSON.stringify(await compareCase(name, path.resolve(location), Number(option)), null, 2))
}
else {
  const selected = scenario(name)
  if (!location) throw new Error('Supply a workspace directory.')
  const folder = path.resolve(location)
  if (action === 'prepare') {
    await prepare(folder, selected.files)
    baselineCommit(folder)
    console.log(selected.prompt)
  } else if (action === 'grade') {
    const result = await grade(name, folder)
    console.log(JSON.stringify(result, null, 2))
    if (result.passed !== result.total) process.exitCode = 1
  } else if (action === 'worker') {
    console.log(JSON.stringify(await score(name, folder)))
  } else {
    throw new Error('Use list, prepare <case> <new-directory>, grade <case> <workspace>, metrics <events.jsonl> <process.json>, or compare <case> <new-report-directory> <seconds-per-agent>.')
  }
}

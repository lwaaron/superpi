/** Prepare equivalent workspaces and grade candidates outside the files given to the agent. */
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { cases } from './fixtures/engineering-cases.mjs'
import { detectTurnVerdict } from '../extensions/superpi-turn-verdict.mjs'

const self = fileURLToPath(import.meta.url)
const execute = promisify(execFile)

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
}

async function score(name, folder) {
  const selected = scenario(name)
  const candidate = await import(pathToFileURL(path.join(folder, selected.entry)))
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
    cwd: folder, env, timeout: 20_000, windowsHide: true, maxBuffer: 512 * 1024,
  })
  const checks = JSON.parse(stdout.trim().split('\n').at(-1))
  const expected = Object.keys(selected.checks)
  assert.deepEqual(checks.map(item => item.label), expected)
  assert.ok(checks.every(item => typeof item.pass === 'boolean'))
  const passed = checks.filter(item => item.pass).length
  return { case: name, passed, total: expected.length, gradingMs: Math.round(performance.now() - started), checks }
}

function runOutcome(process, trace, task, assistant, settlement) {
  if (process.deadline === true) return 'deadline'
  if (process.exit !== 0 || process.signal) return 'process_error'
  if (trace.malformedLines || trace.settlements > 1) return 'invalid_trace'
  if (!settlement) return 'no_settlement'
  if (settlement.aborted) return 'aborted'
  if (assistant?.stopReason === 'error') return 'model_error'
  if (task?.status === 'blocked') return 'blocked'
  if (task?.status === 'active') return 'pending_checks'
  if (assistant?.stopReason !== 'stop' || !detectTurnVerdict(assistant).delivered) return 'missing_final_answer'
  return 'finished'
}

async function runMetrics(events, receipt) {
  const observed = JSON.parse(await fs.readFile(receipt, 'utf8'))
  assert.ok(observed.exit === null || Number.isInteger(observed.exit), 'Expected the observed process exit status.')
  assert.ok(Number.isFinite(observed.seconds) && observed.seconds >= 0, 'Expected elapsed seconds from the process runner.')
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
    task: task?.status ?? null, model: assistant?.model ?? null, ...trace, unmeteredReviews }
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
    count += 9
    console.log('PASS (' + count + ' checks)')
  } finally {
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 3 })
  }
}

const [action, name, location] = process.argv.slice(2)
if (!action) await selfTest()
else if (action === 'list') console.log(Object.keys(cases).join('\n'))
else if (action === 'metrics') {
  if (!name || !location) throw new Error('Supply the captured Pi JSONL events and process receipt.')
  console.log(JSON.stringify(await runMetrics(name, location), null, 2))
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
    throw new Error('Use list, prepare <case> <new-directory>, grade <case> <workspace>, or metrics <events.jsonl> <process.json>.')
  }
}

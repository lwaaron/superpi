/** Real host → pi JSONL → loopback OpenAI-compatible stream. No account or network service is needed. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { requireRuntime } from './preflight.mjs'

const pi = requireRuntime()
const entry = process.argv[2] ? pathToFileURL(path.resolve(process.argv[2])).href : '../index.js'
const { apply } = await import(entry)
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'superpi-reliability-'))
const agentDir = path.join(temp, 'agent')
const workspace = path.join(temp, 'project')
const guardPath = path.join(temp, 'context-guard.json')
const bad = String.fromCharCode(0xfffd)
const broken = 'Checking... </｜｜DSML｜｜ calls>'
const largeWrite = '已有文件正文。'.repeat(1000)
const checks = []
const requests = []
let replies = []
let reviewReplies = {}
let route
let sessionId
const disposers = []

function check(condition, label) {
  checks.push({ condition, label })
}

function toolCall(name, args, id) {
  return { tool_calls: [{ index: 0, id, type: 'function', function: {
    name, arguments: JSON.stringify(args),
  } }] }
}

const writeCall = (file, content, id = 'call_write') => toolCall('write', { path: file, content }, id)
const useTool = (name, args, id) => ({ delta: toolCall(name, args, id), finish: 'tool_calls' })

function chunk(delta, finish) {
  return Buffer.from('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1,
    model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }],
  }) + '\n\n')
}

const provider = http.createServer(async (req, res) => {
  let raw = ''
  req.setEncoding('utf8')
  for await (const piece of req) raw += piece
  const payload = JSON.parse(raw)
  requests.push(payload)
  const role = payload.messages.find(message => message.role === 'system')?.content
    .match(/^You are the independent (correctness|tests) reviewer\./)?.[1]
  const next = (role ? reviewReplies[role] : replies)?.shift()
  const reply = typeof next === 'function' ? next(payload) : next
  if (!reply) { res.writeHead(400).end('Unexpected provider request'); return }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  if (reply.hold) {
    res.write(chunk({ content: '等待' }, null))
    return
  }
  for (const content of reply.progress ?? []) {
    if (res.destroyed) return
    res.write(chunk({ content }, null))
    await delay(350)
  }
  if (reply.delayMs) await delay(reply.delayMs)
  const frame = chunk(typeof reply.delta === 'string' ? { content: reply.delta } : reply.delta, null)
  if (reply.badUtf8) {
    const at = frame.indexOf(Buffer.from('BAD_UTF8'))
    frame[at] = 0xff
  }
  if (reply.splitUtf8) {
    const cut = frame.indexOf(Buffer.from('中')) + 1
    res.write(frame.subarray(0, cut))
    await delay(15)
    res.write(frame.subarray(cut))
  } else {
    res.write(frame)
  }
  if (reply.streamError) {
    res.end('data: ' + JSON.stringify({ error: { message: reply.streamError } }) + '\n\n')
    return
  }
  if (reply.endWithoutFinish) { res.end(); return }
  res.end(Buffer.concat([chunk({}, reply.finish ?? 'stop'), Buffer.from('data: [DONE]\n\n')]))
})

const host = http.createServer((req, res) => void route.handler(req, res))
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let base

async function request(endpoint, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(base + endpoint, {
    method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(8000),
  })
  const result = await response.json()
  assert(response.ok, `${method} ${endpoint}: ${JSON.stringify(result)}`)
  return result
}

const session = () => '/sessions/' + sessionId
const command = body => request(session() + '/command', body)
const snapshot = () => request(session() + '/snapshot')

async function until(read, done, label) {
  const deadline = Date.now() + 8000
  do {
    const result = await read()
    if (done(result)) return result
    await delay(25)
  } while (Date.now() < deadline)
  throw new Error('Timed out waiting for ' + label)
}

async function run(prompt, scripted, { abort = false, interact } = {}) {
  const since = (await snapshot()).eventSeq
  const first = requests.length
  replies = [...scripted]
  const sent = await command({ type: 'prompt', message: prompt })
  assert.equal(sent.ok, true, JSON.stringify(sent))
  if (interact) await interact(since)
  if (abort) {
    await until(() => requests.length, count => count > first, 'provider input before abort')
    await command({ type: 'abort' })
  }
  const result = await until(snapshot,
    state => state.events.some(entry => entry.seq > since && entry.record.type === 'agent_settled'), prompt)
  return { records: result.events.filter(entry => entry.seq > since).map(entry => entry.record), requests: requests.slice(first) }
}

const lastAssistant = result => result.records.filter(entry => entry.type === 'message_end' && entry.message.role === 'assistant').at(-1)
const requestText = payload => JSON.stringify(payload.messages.filter(message => message.role !== 'system'))
const toolResult = (activity, id) => activity.records.find(record =>
  record.type === 'message_end' && record.message?.role === 'toolResult' && record.message.toolCallId === id)?.message

try {
  await fs.mkdir(agentDir, { recursive: true })
  await fs.mkdir(workspace, { recursive: true })
  Object.assign(process.env, {
    PI_CODING_AGENT_DIR: agentDir, SUPERPI_CODING_AGENT_DIR: agentDir,
    SUPERPI_CONTEXT_GUARD: guardPath, SUPERPI_RULES: path.join(temp, 'rules.json'),
    SUPERPI_MODALITIES: path.join(temp, 'modalities.json'), SUPERPI_INTEGRITY: path.join(temp, 'integrity.log.jsonl'),
  })
  await fs.writeFile(guardPath, JSON.stringify({ autoRetryCooldownMs: 0 }))
  await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({
    compaction: { enabled: false }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 20 }, lastChangelogVersion: '1.5.2',
    defaultProjectTrust: 'always',
  }))
  await listen(provider)
  await fs.writeFile(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { loopback: {
    baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', apiKey: 'fixture',
    models: ['fixture', 'replacement', 'fixture-wide'].map(id => ({ id,
      contextWindow: id === 'fixture-wide' ? 160000 : 24000, maxTokens: 2048, input: ['text', 'image'] })),
  } } }))
  apply({
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return () => {} },
    inject(_services, run) { run({ webServer: { register(value) { route = value; return () => {} } } }) },
    get() { throw new Error('No optional service in fixture') },
  }, { cliPath: pi.cliPath, workspace, args: ['--provider', 'loopback', '--model', 'fixture'] })
  await listen(host)
  base = `http://127.0.0.1:${host.address().port}${route.path}`
  sessionId = (await request('/sessions', {})).session.id
  check(typeof sessionId === 'string', 'fresh host session starts with empty agent extension directory')

  const retryRoute = session() + '/controls/retry'
  check((await request(retryRoute)).enabled === true, 'the panel can read Pi’s enabled retry setting before the first prompt')
  check((await request(retryRoute, { enabled: false })).enabled === false &&
    (await request(retryRoute)).enabled === false, 'the effective retry setting survives closing and reopening the panel settings')
  check((await request(retryRoute, { enabled: true })).enabled === true, 'retry write returns the effective setting')

  const controlledProject = path.join(temp, 'controlled-project')
  await fs.mkdir(path.join(controlledProject, '.pi'), { recursive: true })
  await fs.writeFile(path.join(controlledProject, '.pi', 'settings.json'), JSON.stringify({ retry: { enabled: false } }))
  const controlled = await request('/sessions', { cwd: controlledProject, continue: false,
    args: ['--models', 'loopback/replacement,loopback/fixture'] })
  const controlledRoute = '/sessions/' + controlled.session.id
  try {
    const override = await request(controlledRoute + '/controls/retry', { enabled: true })
    check(override.enabled === false && override.applied === false, 'a project override is visible after a successful retry write acknowledgement')
    const backward = await request(controlledRoute + '/controls/previous-model', {})
    const wrap = await request(controlledRoute + '/controls/previous-model', {})
    check(backward.model?.id === 'replacement' && wrap.model?.id === 'fixture',
      'reverse cycling wraps in the scoped order and excludes unscoped models')
    check((await request(controlledRoute + '/snapshot')).model?.id === 'fixture',
      'a reconnected panel reads the model selected through the Pi extension')
  } finally {
    await request(controlledRoute, undefined, 'DELETE')
  }
  check(requests.length === 0, 'reading or changing controls never starts a model request')
  check((await snapshot()).events.every(row => !row.record.statusKey?.startsWith('superpi-control/')),
    'control replies stay out of the panel’s event history')

  const healthy = await run('healthy', [{ delta: '中文，正常。', splitUtf8: true }])
  check(lastAssistant(healthy)?.message.content[0]?.text === '中文，正常。', 'valid UTF-8 survives a split network frame')
  check(healthy.requests.length === 1 && lastAssistant(healthy)?.verdict?.kind === 'none', 'valid short completion gets one provider request')
  check(JSON.stringify(healthy.requests[0].messages).includes('Report completion only for work actually done and verified'),
    'both modes inherit the same evidence-based completion guidance')

  const mainId = sessionId
  const mainState = (await command({ type: 'get_state' })).data
  const separate = await request('/sessions', { cwd: workspace, continue: false })
  try {
    sessionId = separate.session.id
    check(separate.session.sessionId !== mainState.sessionId, 'new tabs at the same path receive independent Pi sessions')
    const duplicate = await fetch(base + session() + '/command', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'switch_session', sessionPath: mainState.sessionFile }) })
    assert.equal(duplicate.status, 409, 'a second tab cannot take over the live session file')
    check((await duplicate.json()).sessionId === mainId, 'conflict identifies the tab that owns the live session')
    const secondTurn = await run('independent tab', [{ delta: 'Only in the second tab.' }])
    check(!requestText(secondTurn.requests[0]).includes('中文，正常。'), 'a new tab sends only its own conversation to the model')
  } finally {
    await request(session(), undefined, 'DELETE')
    sessionId = mainId
  }
  const mainMessages = (await command({ type: 'get_messages' })).data.messages
  check(JSON.stringify(mainMessages).includes('中文，正常。') && !JSON.stringify(mainMessages).includes('Only in the second tab.'),
    'reopening the original tab retains its transcript without messages from the other tab')

  const question = '这次通过哪些平台发布？'
  const answer = '先在 Windows 上发布，之后再支持 macOS。'
  const asked = await run('ask and wait for my answer', [
    { delta: toolCall('ask_user', { question, options: ['Windows', 'macOS'] }, 'call_question'), finish: 'tool_calls' },
    { delta: 'I received your answer.' },
  ], { interact: async since => {
    const waiting = await until(snapshot, state => state.pendingUi.length > 0 ||
      state.events.some(entry => entry.seq > since && entry.record.type === 'agent_settled'), 'user question')
    const select = waiting.pendingUi[0]
    assert.equal(select?.method, 'select', 'ask_user must show an actionable pending dialog')
    check(select.title === question && select.options.slice(0, 2).join(',') === 'Windows,macOS', 'the panel receives the actual question and choices')
    check(!waiting.events.some(entry => entry.seq > since && entry.record.type === 'agent_settled'), 'the agent remains in the same activity while waiting')
    check((await snapshot()).pendingUi[0].id === select.id, 'reattaching the panel can recover the same outstanding question')
    await request(session() + '/respond', { id: select.id, value: select.options.at(-1) })
    const input = (await until(snapshot, state => state.pendingUi[0]?.method === 'input', 'custom reply')).pendingUi[0]
    check(input.title === question, 'the free-form follow-up retains the original question')
    await request(session() + '/respond', { id: input.id, value: answer })
  } })
  check(asked.requests[0].tools.some(tool => tool.function?.name === 'ask_user'), 'the actual model request advertises ask_user')
  check(asked.requests.length === 2 && lastAssistant(asked)?.message.content[0]?.text === 'I received your answer.', 'answering resumes the same agent turn')
  const questionResult = asked.records.find(record => record.type === 'message_end' && record.message?.toolCallId === 'call_question')
  check(questionResult?.message.details?.status === 'answered' && questionResult.message.details.answer === answer,
    'the tool passes the user answer to the agent without rewriting it')
  check(requestText(asked.requests.at(-1)).includes(answer) && (await snapshot()).pendingUi.length === 0,
    'the model receives the answer and the panel closes the completed question')

  const waitForQuestion = async () => (await until(snapshot, state => state.pendingUi[0]?.method === 'input', 'open question')).pendingUi[0]
  const cancelled = await run('ask an open question and let me cancel', [
    { delta: toolCall('ask_user', { question }, 'call_cancel_question'), finish: 'tool_calls' },
    { delta: 'I still need a decision.' },
  ], { interact: async () => {
    const input = await waitForQuestion()
    await request(session() + '/respond', { id: input.id, cancelled: true })
  } })
  check(cancelled.requests.length === 2 && requestText(cancelled.requests.at(-1)).includes('unanswered'),
    'cancelling a question reports an unanswered result to the model')

  const stoppedQuestion = await run('ask an open question and let me stop', [
    { delta: toolCall('ask_user', { question }, 'call_stop_question'), finish: 'tool_calls' },
  ], { interact: async () => {
    await waitForQuestion()
    await command({ type: 'abort' })
  } })
  check(stoppedQuestion.requests.length === 1 && stoppedQuestion.records.at(-1)?.aborted === true,
    'stopping while a question is open ends the same turn with no retry')
  check((await snapshot()).pendingUi.length === 0, 'stop releases the pending panel question')

  const leakedReasoning = '<thinking>A verification step is still pending.\nHere is the delivery summary.'
  const leaked = await run('separate protocol from the final answer', [{ delta: leakedReasoning }, { delta: 'A clean summary.' }])
  check(leaked.requests.length === 2 && lastAssistant(leaked)?.message.content[0]?.text === 'A clean summary.',
    'unclosed leading reasoning markup in a text block triggers one native recovery')
  check(leaked.records.some(record => record.verdict?.kind === 'reasoning-markup') &&
    !requestText(leaked.requests.at(-1)).includes(leakedReasoning),
  'leaked reasoning is flagged and excluded from the next model request')

  const recovery = await run('recover interrupted reasoning', [{ delta: { reasoning_content: broken } }, { delta: 'Recovered.' }])
  check(recovery.requests.length === 2, 'malformed output automatically continues on a fresh panel installation')
  check(recovery.records.some(record => record.type === 'message_end' && record.verdict?.kind === 'dsml-thinking'),
    'the loopback stream reaches the actual DSML reasoning predicate')
  check(lastAssistant(recovery)?.message.content[0]?.text === 'Recovered.', 'second response is delivered through normal RPC')
  check(!requestText(recovery.requests.at(-1)).includes('DSML') && !requestText(recovery.requests.at(-1)).includes('"content":"继续"'),
    'recovery keeps the failed response and synthetic user prompts out of provider history')
  check(recovery.records.filter(entry => entry.type === 'agent_settled').length === 1, 'agent settles only after recovery finishes')
  const evidence = (await command({ type: 'get_entries' })).data.entries
  check(evidence.some(entry => entry.type === 'message' && entry.message.content.some?.(block => block.thinking === broken)),
    'the original failed response remains in the native transcript for inspection')

  const repeat = await run('persistently invalid', Array.from({ length: 3 }, () => ({ delta: 'invalid ' + bad })))
  check(repeat.requests.length === 2, 'recovery is capped at one even with cooldown zero')
  check(lastAssistant(repeat)?.verdict?.kind === 'corrupt', 'persistent failure is available for rendering after settlement')
  check((await snapshot()).lastVerdict?.kind === 'corrupt', 'reattaching a panel shows the same recovery notice')

  await command({ type: 'set_model', provider: 'loopback', modelId: 'replacement' })
  const resumed = await run('继续', [{ delta: 'Continued with existing work.' }])
  check(resumed.requests[0]?.model === 'replacement', 'resuming on a selected alternative model uses the native model switch')
  check(requestText(resumed.requests[0]).includes('persistently invalid') && !requestText(resumed.requests[0]).includes(bad),
    'switching models keeps the user goal and excludes abandoned corrupted responses')

  const truncated = await run('truncated answer', [{ delta: 'Valid prefix', finish: 'length' }, { delta: 'The rest.' }])
  check(truncated.requests.length === 2, 'truncation can continue through the shared lifecycle')
  check(requestText(truncated.requests.at(-1)).includes('Valid prefix'), 'truncation recovery retains the valid prefix')

  const toolTurn = await run('write the file, then verify it', [
    useTool('write', { path: 'once.txt', content: largeWrite }, 'completed_write'),
    { delta: { reasoning_content: 'I will verify the file.</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>' } },
    useTool('read', { path: 'once.txt' }, 'verify_saved_file'),
    { delta: 'Saved and verified.' },
  ])
  check(toolTurn.requests.length === 4 && lastAssistant(toolTurn)?.message.content[0]?.text === 'Saved and verified.' &&
    toolTurn.records.filter(record => record.type === 'agent_settled').length === 1,
  'a malformed reply after a completed write resumes and verifies the file in the same user activity')
  check(toolTurn.records.some(record => record.type === 'message_end' && record.verdict?.kind === 'dsml-thinking'),
    'the malformed reply is identified before it is removed from the provider context')
  const resumedRequest = toolTurn.requests[2]
  const hasToolFrame = (payload, id) => payload?.messages.some(message => message.tool_call_id === id ||
    message.tool_calls?.some(call => call.id === id))
  check(!hasToolFrame(resumedRequest, 'completed_write') && requestText(resumedRequest).includes('Recorded tool outcome'),
    'a successful write is carried as text evidence, never as replayable synthetic arguments')
  check(requestText(resumedRequest).includes('write completed for') && requestText(resumedRequest).includes('once.txt') &&
    !requestText(resumedRequest).includes('DSML'), 'recovery retains the confirmed write outcome and omits the malformed tool fragment')
  check(await fs.readFile(path.join(workspace, 'once.txt'), 'utf8') === largeWrite, 'successful file contains every original character')
  check(toolTurn.records.filter(record => record.type === 'tool_execution_end' && record.toolName === 'write').length === 1 &&
    toolResult(toolTurn, 'verify_saved_file')?.isError === false, 'recovery executes only the new tool and preserves the completed write')
  check(!requestText(toolTurn.requests[1]).includes(largeWrite) && requestText(toolTurn.requests[1]).includes('once.txt'),
    'completed write body is replaced by a file reference before the next request')
  const afterWrite = (await command({ type: 'get_entries' })).data.entries
  const writtenCall = afterWrite.find(entry => entry.type === 'message' && entry.message.role === 'assistant' &&
    entry.message.content.some(block => block.id === 'completed_write' && block.arguments?.content === largeWrite))
  const writtenResult = afterWrite.find(entry => entry.type === 'message' && entry.message.role === 'toolResult' &&
    entry.message.toolCallId === 'completed_write')
  const writtenEvidence = afterWrite.find(entry => entry.type === 'custom_message' && entry.customType === 'superpi-tool-evidence' &&
    entry.display === false && entry.content.includes('once.txt'))
  check(writtenCall && writtenResult && writtenEvidence?.details?.toolCallIds.includes('completed_write') &&
    [writtenCall, writtenResult].every(original => afterWrite.findIndex(entry => entry.type === 'context_edit' && entry.targetId === original.id) >
      afterWrite.indexOf(writtenEvidence)), 'the native session saves repair evidence before editing either original tool entry')

  const persistedToolSession = (await command({ type: 'get_state' })).data.sessionFile
  const writtenLines = (await fs.readFile(persistedToolSession, 'utf8')).trimEnd().split(/\r?\n/)
  const lastSaved = writtenLines.findIndex(line => JSON.parse(line).id === writtenEvidence?.id)
  assert.ok(lastSaved > 0, 'locate the actual persisted proof before its two edits')
  const prefixSession = path.join(temp, 'tool-evidence-prefix.jsonl')
  await fs.writeFile(prefixSession, writtenLines.slice(0, lastSaved + 1).join('\n') + '\n')
  const originalToolSession = sessionId
  sessionId = (await request('/sessions', { cwd: workspace, continue: false })).session.id
  assert.equal((await command({ type: 'switch_session', sessionPath: prefixSession })).ok, true)
  const prefixRun = await run('recover a session that exited after saving the tool outcome', [{ delta: 'Recovered from recorded results.' }])
  check(prefixRun.requests.length === 1 && !hasToolFrame(prefixRun.requests[0], 'completed_write') &&
    requestText(prefixRun.requests[0]).includes('write completed for') && !requestText(prefixRun.requests[0]).includes(largeWrite),
  'a fresh Pi reopens the durable prefix and reconstructs the tool context without a second write')
  await request(session(), undefined, 'DELETE')
  sessionId = originalToolSession

  const truncatedCall = await run('handle a cutoff in the tool reply itself', [
    { delta: writeCall('cutoff.txt', 'incomplete write', 'cutoff_write'), finish: 'length' },
    { delta: 'The truncated write was rejected.' },
  ])
  check(toolResult(truncatedCall, 'cutoff_write')?.isError === true && !(await fs.readdir(workspace)).includes('cutoff.txt'),
    'Pi rejects the tool from the truncated reply before it changes the workspace')
  check(truncatedCall.requests.length === 2 && truncatedCall.requests[1].messages.some(message =>
    message.role === 'tool' && message.tool_call_id === 'cutoff_write') &&
    !truncatedCall.records.some(record => record.entry?.customType === 'superpi-recovery'),
  'SuperPi preserves the rejection and leaves continuation of that tool reply to Pi')

  const earlyClose = 'Upstream response stream ended before completion'
  const interrupted = await run('recover after the gateway interrupts a tool proposal', [
    useTool('write', { path: 'committed-effect.txt', content: 'already written' }, 'before_disconnect'),
    { delta: { tool_calls: [{ index: 0, id: 'unfinished_write', type: 'function', function: {
      name: 'write', arguments: '{"path":"interrupted.txt","content":',
    } }] }, streamError: earlyClose },
    { delta: 'Recovered with earlier work intact.' },
  ])
  const streamFailure = interrupted.records.find(record => record.type === 'message_end' && record.message?.stopReason === 'error')
  check(streamFailure?.message.errorMessage === earlyClose && streamFailure.verdict?.kind === 'stream-interrupted',
    'the actual stream error is reported as interrupted without changing the provider evidence')
  check(interrupted.requests.length === 3 && interrupted.records.filter(record => record.type === 'agent_settled').length === 1 &&
    lastAssistant(interrupted)?.message.content[0]?.text === 'Recovered with earlier work intact.',
  'a dropped stream continues inside the same user activity')
  check(interrupted.records.filter(record => record.type === 'tool_execution_end').length === 1 &&
    await fs.readFile(path.join(workspace, 'committed-effect.txt'), 'utf8') === 'already written' &&
    !(await fs.readdir(workspace)).includes('interrupted.txt'), 'only the completed write reaches disk')
  check(requestText(interrupted.requests.at(-1)).includes('committed-effect.txt') &&
    !requestText(interrupted.requests.at(-1)).includes('interrupted.txt'),
  'the next model request contains completed tool effects and excludes the broken proposal')
  const streamHistory = (await command({ type: 'get_entries' })).data.entries
  check(streamHistory.some(entry => entry.type === 'message' && entry.message.errorMessage === earlyClose),
    'the failed provider response is still available in the original session record')

  const gatewayClosed = 'upstream aborted (gateway closed stream)'
  const realGatewayError = await run('recover from the observed gateway error', [
    { delta: 'Unfinished provider draft.', streamError: gatewayClosed },
    { delta: 'Completed after the gateway closed the stream.' },
  ])
  check(realGatewayError.requests.length === 2 && realGatewayError.records.some(record =>
    record.message?.errorMessage === gatewayClosed && record.verdict?.kind === 'stream-interrupted') &&
    !requestText(realGatewayError.requests.at(-1)).includes('Unfinished provider draft.') &&
    lastAssistant(realGatewayError)?.message.content[0]?.text === 'Completed after the gateway closed the stream.',
  'the observed gateway disconnect is visible and resumes without passing the unfinished draft back to the provider')

  const repeatedDisconnect = await run('stop after the supplemental stream retry', [
    { delta: 'First incomplete', streamError: earlyClose }, { delta: 'Second incomplete', streamError: earlyClose },
  ])
  check(repeatedDisconnect.requests.length === 2 && (await snapshot()).lastVerdict?.kind === 'stream-interrupted',
    'a persistent gateway failure settles after one recovery with a visible reason on reconnect')
  const terminalError = await run('surface a permanent provider error', [{ delta: 'Failed.', streamError: 'Invalid API key' }])
  check(terminalError.requests.length === 1 && lastAssistant(terminalError)?.verdict?.kind === 'none',
    'a permanent provider error stays with the existing error path')
  const nativeRetry = await run('leave recognized stream errors to Pi', [
    { delta: 'Stopped early.', endWithoutFinish: true }, { delta: 'Native retry recovered.' },
  ])
  check(nativeRetry.requests.length === 2 && nativeRetry.records.some(record => record.type === 'auto_retry_start') &&
    !nativeRetry.records.some(record => record.entry?.customType === 'superpi-recovery'),
  'Pi still owns its native stream retries')

  const corruptWrite = await run('reject damaged writes', [
    { delta: writeCall('bad-body.txt', '文件BAD_UTF8', 'call_bad_body'), finish: 'tool_calls', badUtf8: true },
    { delta: writeCall('bad-' + bad + '.txt', 'clean', 'call_path'), finish: 'tool_calls' },
    { delta: 'Blocked.' },
  ])
  check(!(await fs.readdir(workspace)).some(name => name.startsWith('bad-')), 'bad content and paths never reach the filesystem')
  check(corruptWrite.records.filter(entry => entry.type === 'tool_execution_end' && entry.isError === true).length === 2,
    'both rejected writes produce actual tool errors in the panel')
  const argumentsIn = (payload, id) => {
    const call = payload?.messages.flatMap(message => message.tool_calls ?? []).find(call => call.id === id)
    return call && JSON.parse(call.function.arguments)
  }
  const followDamagedBody = corruptWrite.requests[1]
  const followDamagedPath = corruptWrite.requests[2]
  check(!hasToolFrame(followDamagedBody, 'call_bad_body') && requestText(followDamagedBody).includes('U+FFFD'),
    'a denied write retains its real diagnostic as evidence without a synthetic tool call')
  check(requestText(followDamagedBody).includes('bad-body.txt') && !requestText(followDamagedBody).includes(bad) &&
    followDamagedBody.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('U+FFFD')),
  'the first request after a corrupted UTF-8 write retains a clean path and the diagnostic as plain evidence')
  check(!hasToolFrame(followDamagedPath, 'call_path') && !requestText(followDamagedPath).includes(bad) &&
    followDamagedPath.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('U+FFFD')),
  'a rejected path and its proposal stay out of the request, with a plain diagnostic for recovery')

  const originalText = 'Original contents.'
  const repairedEdit = 'Corrected contents.'
  const damagedEditPath = 'recover-damaged.txt'
  const siblingPath = 'confirmed-sibling.txt'
  await fs.writeFile(path.join(workspace, damagedEditPath), originalText)
  const editCall = (newText, id) => toolCall('edit', { path: damagedEditPath, edits: [{ oldText: originalText, newText }] }, id)
  const cleanFailure = { path: 'nonexistent.txt', edits: [{ oldText: 'missing', newText: 'intact write input' }] }
  const damagedBatch = { tool_calls: [
    ...editCall('Bad proposal ' + bad, 'damaged_edit').tool_calls,
    { ...writeCall(siblingPath, largeWrite, 'confirmed_sibling').tool_calls[0], index: 1 },
    { ...toolCall('edit', cleanFailure, 'ordinary_failure').tool_calls[0], index: 2 },
  ] }
  const mixed = await run('regenerate only a rejected edit from a mixed tool batch', [
    { delta: damagedBatch, finish: 'tool_calls' },
    payload => requestText(payload).includes(bad)
      ? { delta: 'History refused.', streamError: 'Invalid tool history in fixture' }
      : { delta: editCall(repairedEdit, 'repaired_edit'), finish: 'tool_calls' },
    { delta: 'The corrected edit is complete.' },
  ])
  const mixedFollowup = mixed.requests[1]
  check(toolResult(mixed, 'damaged_edit')?.isError === true && toolResult(mixed, 'repaired_edit')?.isError === false &&
    await fs.readFile(path.join(workspace, damagedEditPath), 'utf8') === repairedEdit &&
    lastAssistant(mixed)?.message.content[0]?.text === 'The corrected edit is complete.' && mixed.requests.length === 3,
  'a provider that rejects damaged history can complete the corrected edit in the same activity')
  const retainedResult = mixedFollowup?.messages.findIndex(message => message.tool_call_id === 'ordinary_failure')
  const combinedEvidence = mixedFollowup?.messages.findIndex(message => message.role === 'user' &&
    JSON.stringify(message.content).includes(damagedEditPath) && JSON.stringify(message.content).includes(siblingPath))
  check(!hasToolFrame(mixedFollowup, 'damaged_edit') && !hasToolFrame(mixedFollowup, 'confirmed_sibling') &&
    JSON.stringify(argumentsIn(mixedFollowup, 'ordinary_failure')) === JSON.stringify(cleanFailure) &&
    toolResult(mixed, 'ordinary_failure')?.isError === true &&
    retainedResult >= 0 && combinedEvidence > retainedResult &&
    await fs.readFile(path.join(workspace, siblingPath), 'utf8') === largeWrite &&
    mixed.records.filter(record => record.type === 'tool_execution_end' && record.toolCallId === 'confirmed_sibling').length === 1,
  'mixed results retain genuine tool pairing, then append one evidence message with the successful write and exact refusal')

  const integrityHistoryFile = (await command({ type: 'get_state' })).data.sessionFile
  const closedIntegritySession = sessionId
  await request(session(), undefined, 'DELETE')
  sessionId = (await request('/sessions', {})).session.id
  assert.notEqual(sessionId, closedIntegritySession, 'restart Pi before verifying the persisted projection')
  assert.equal((await command({ type: 'switch_session', sessionPath: integrityHistoryFile })).ok, true)
  const integrityHistory = (await command({ type: 'get_entries' })).data.entries
  check(integrityHistory.some(entry => entry.type === 'message' && entry.message.role === 'assistant' &&
    entry.message.content.some(block => block.type === 'toolCall' && block.id === 'damaged_edit' &&
      block.arguments.edits[0].newText.endsWith(bad))), 'the original rejected payload is kept in the native session record')
  const resumedIntegrity = await run('resume with the repaired file', [{ delta: 'History reloaded.' }])
  check(!requestText(resumedIntegrity.requests[0]).includes(bad) &&
    !hasToolFrame(resumedIntegrity.requests[0], 'damaged_edit') &&
    resumedIntegrity.requests[0].messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes(damagedEditPath) &&
      JSON.stringify(message.content).includes('U+FFFD')),
  'a new Pi process reloads the same clean projection including the original refusal diagnostic')

  await fs.writeFile(guardPath, JSON.stringify({ autoRetryOnMalformed: false, autoRetryCooldownMs: 0 }))
  const disabled = await run('retry disabled explicitly', [{ delta: 'invalid ' + bad }])
  check(disabled.requests.length === 1, 'explicitly disabling retry takes effect without restarting pi')
  const stopped = await run('stop explicitly', [{ hold: true }], { abort: true })
  check(stopped.requests.length === 1 && stopped.records.at(-1)?.aborted === true, 'user stop does not resume the activity')

  // A valid 32×32 RGB PNG, generated for this fixture.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAGUlEQVR4nO3BMQEAAADCoPVP7WENoAAAAG4MIAABt9NlCQAAAABJRU5ErkJggg==', 'base64')
  const newestPng = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGN4r8hLU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAGlcdD06cj5MAAAAAElFTkSuQmCC'
  const updatedPng = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGNQumtOU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAPCi2D3O1yRMAAAAAElFTkSuQmCC'
  const imageNames = Array.from({ length: 6 }, (_, index) => 'image-' + index + '.png')
  await Promise.all(imageNames.map(name => fs.writeFile(path.join(workspace, name), png)))
  await fs.writeFile(path.join(workspace, imageNames[5]), Buffer.from(newestPng, 'base64'))
  const images = await run('read six images', [
    ...imageNames.map((name, index) => ({ delta: toolCall('read', { path: name }, 'call_image_' + index), finish: 'tool_calls' })),
    { delta: 'Read the six images.' },
  ])
  const results = images.records.filter(record => record.type === 'message_end' && record.message?.role === 'toolResult')
  check(results.length === 6 && results.every(record => !record.message.isError), 'pi actually reads all six image fixtures')
  const history = (await command({ type: 'get_entries' })).data.entries.filter(entry =>
    entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolCallId.startsWith('call_image_'))
  check(history.flatMap(entry => entry.message.content).filter(block => block.type === 'image').length === 4,
    'image limit applies before pi persists tool output')
  check(imageNames.slice(4).every(name => history.some(entry => entry.message.content.some(block =>
    block.type === 'text' && block.text.includes('image omitted') && block.text.includes(name)))),
  'omitted images remain recoverable through an actual file path')
  const imageUris = request => request.messages.flatMap(message => Array.isArray(message.content)
    ? message.content.filter(block => block.type === 'image_url').map(block => block.image_url.url) : [])
  const imageUri = data => 'data:image/png;base64,' + data
  check(imageUris(images.requests.at(-1)).includes(imageUri(newestPng)),
  'the model actually receives the newest image after the persisted image quota is exhausted')
  await fs.writeFile(path.join(workspace, imageNames[5]), Buffer.from(updatedPng, 'base64'))
  const reread = await run('compare the sixth screenshot again', [
    useTool('read', { path: imageNames[5] }, 'call_image_reread'), { delta: 'Compared the saved image.' },
  ])
  check(imageUris(reread.requests.at(-1)).includes(imageUri(updatedPng)),
  'an explicit reread after the quota presents the actual image to the provider')

  execFileSync('git', ['init', '--quiet'], { cwd: workspace })
  await fs.writeFile(path.join(workspace, '.gitignore'), 'private.txt\n')
  await fs.writeFile(path.join(workspace, 'origin.txt'), 'working copy')
  await fs.writeFile(path.join(workspace, 'draft.txt'), 'untracked work')
  await fs.writeFile(path.join(workspace, 'private.txt'), 'ignored fixture')
  execFileSync('git', ['-c', 'core.autocrlf=false', 'add', '.gitignore', 'origin.txt'], { cwd: workspace })
  await fs.writeFile(path.join(workspace, 'origin.txt'), 'dirty working copy')
  const hangingCommand = `node -e "const fs = require('node:fs'); if (fs.existsSync('private.txt') || fs.readFileSync('origin.txt', 'utf8') !== 'experiment' || fs.readFileSync('draft.txt', 'utf8') !== 'untracked work') process.exit(7); console.log('experiment started at ' + process.cwd()); setInterval(() => {}, 1000)"`
  const isolated = await run('audit a deliberately hanging mutation', [
    useTool('verify', { command: hangingCommand, timeout: 2, scope: 'snapshot',
      mutations: [{ path: 'origin.txt', oldText: 'dirty working copy', newText: 'experiment' }] }, 'verify_hang'),
    { delta: 'The experiment timed out.' },
  ])
  const timeoutResult = toolResult(isolated, 'verify_hang')
  check(timeoutResult?.isError && timeoutResult?.details?.verification?.status === 'timed_out',
    'a hanging verification returns a typed timeout to the same agent turn')
  check(timeoutResult?.content.some(block => block.text?.includes('experiment started')),
    'the timeout preserves output from work that actually ran in the snapshot')
  check(await fs.readFile(path.join(workspace, 'origin.txt'), 'utf8') === 'dirty working copy',
    'the timed-out mutation never reaches the original workspace')
  const executionPath = timeoutResult?.content.find(block => block.text?.includes('experiment started at '))?.text
    .match(/experiment started at ([^\r\n]+)/)?.[1]
  check(executionPath && !(await fs.stat(executionPath).catch(() => null)), 'the timed-out snapshot is removed once its process stops')
  const rejectedMutation = await run('reject a mutation that did not match', [
    useTool('verify', { command: 'node -e "console.log(123)"', timeout: 3, scope: 'snapshot',
      mutations: [{ path: 'origin.txt', oldText: 'no such match', newText: 'unintended content' }] }, 'verify_reject'),
    { delta: 'The mutation was not applied.' },
  ])
  check(toolResult(rejectedMutation, 'verify_reject')?.isError === true &&
    toolResult(rejectedMutation, 'verify_reject')?.content.some(block => block.text?.includes('exactly once')),
  'a mutation with no exact match fails before the check can produce a false green')
  const pipeline = await run('keep a failing command red', [
    useTool('verify', { command: 'node -e "process.exit(7)" | cat', timeout: 3 }, 'verify_exit'),
    { delta: 'Verification failed with exit 7.' },
  ])
  check(toolResult(pipeline, 'verify_exit')?.details?.verification?.exitCode === 7 &&
    toolResult(pipeline, 'verify_exit')?.isError === true, 'the pipeline cannot turn exit 7 into a verification pass')

  const comparisonTimeout = 'node -e "' + [
    "const value = require('node:fs').readFileSync('origin.txt', 'utf8');",
    "if (value === 'dirty working copy') console.log('control completed at ' + process.cwd());",
    "else if (value === 'experiment') { console.log('mutated check waiting at ' + process.cwd()); setInterval(() => {}, 1000); }",
    'else process.exitCode = 7;',
  ].join(' ') + '"'
  const boundedComparison = await run('preserve the control when the mutated check reaches the shared deadline', [
    useTool('verify', {
      command: `node -e "if (require('node:fs').readFileSync('origin.txt', 'utf8') === 'experiment') { console.error('assertion failed'); process.exitCode = 7; }"`,
      timeout: 5, scope: 'snapshot', expectedFailure: 'assertion failed',
      mutations: [{ path: 'origin.txt', oldText: 'dirty working copy', newText: 'experiment' }],
    }, 'comparison_detected'),
    useTool('verify', { command: comparisonTimeout, timeout: 4, scope: 'snapshot', expectedFailure: 'assertion failed',
      mutations: [{ path: 'origin.txt', oldText: 'dirty working copy', newText: 'experiment' }] }, 'comparison_timeout'),
    { delta: 'The mutated check timed out.' },
  ])
  const detected = toolResult(boundedComparison, 'comparison_detected')
  check(detected && !detected.isError && detected.details?.verification?.comparison?.outcome === 'detected' &&
    detected.details.verification.comparison.mutationExitCode === 7 && detected.content[0].text.includes('baseline exit 0'),
  'the real panel run displays the passing control and the expected failure together')
  const bounded = toolResult(boundedComparison, 'comparison_timeout')
  check(bounded?.isError && bounded.details?.verification?.status === 'timed_out' &&
    bounded.details.verification.comparison?.outcome === 'incomplete' &&
    bounded.details.verification.comparison?.baselineExitCode === 0 &&
    bounded.details.verification.comparison?.mutationExitCode === null,
  'a shared deadline preserves the completed baseline without counting the timed out mutation as caught')
  const phasePaths = bounded?.content.flatMap(block => block.text?.split(/\r?\n/) ?? [])
    .flatMap(line => /^(?:control completed|mutated check waiting) at (.+)$/.exec(line)?.slice(1) ?? []) ?? []
  check(phasePaths.length === 2 && phasePaths[0] !== phasePaths[1] &&
    (await Promise.all(phasePaths.map(folder => fs.stat(folder).catch(error => error.code)))).every(code => code === 'ENOENT') &&
    await fs.readFile(path.join(workspace, 'origin.txt'), 'utf8') === 'dirty working copy',
  'the panel receives both labeled shell output streams and the completed comparison cleans up both snapshots')

  const newSource = path.join(workspace, 'concurrent-source.txt')
  const encodedSourcePath = Buffer.from(newSource).toString('base64')
  const numberedComparison = 'node -e "' + [
    "const fs = require('node:fs');",
    "if (fs.readFileSync('origin.txt', 'utf8') === 'experiment') {",
    `fs.writeFileSync(Buffer.from('${encodedSourcePath}', 'base64').toString(), 'added during the check');`,
    "console.error('assertion failed'); process.exitCode = 7; }",
  ].join(' ') + '"'
  const changedDuringComparison = await run('reject proof from a comparison when new source appears during the run', [
    useTool('task_progress', { action: 'start', goal: 'Verify the current tree', checks: [{
      description: 'Detect the experiment regression', command: numberedComparison,
      mutation: { mutations: [{ path: 'origin.txt', oldText: 'dirty working copy', newText: 'experiment' }],
        expectedFailure: 'assertion failed' },
    }] }, 'numbered_comparison_start'),
    useTool('verify', { command: numberedComparison, timeout: 8, check: 1 }, 'numbered_comparison_run'),
    useTool('task_progress', { action: 'finish' }, 'numbered_comparison_finish'),
    useTool('task_progress', { action: 'block', reason: 'Waiting for a stable working tree.' }, 'numbered_comparison_block'),
    { delta: 'The comparison ran before the working tree changed.' },
  ])
  const changedComparison = toolResult(changedDuringComparison, 'numbered_comparison_run')
  check(changedComparison?.details?.verification?.status === 'stale' && changedComparison.isError &&
    changedComparison.details.verification.comparison?.outcome === 'detected' &&
    changedComparison.details.verification.comparison.mutationExitCode === 7 &&
    changedComparison.details.verification.recorded === false,
  'the panel receives the observed assertion failure even though its snapshot no longer matches the workspace')
  check(toolResult(changedDuringComparison, 'numbered_comparison_finish')?.isError &&
    changedDuringComparison.records.some(record => record.type === 'extension_ui_request' && record.method === 'setWidget' &&
      record.widgetKey === 'superpi-task' && record.widgetLines?.some(line => line.includes('0/1'))),
  'a comparison of stale source leaves the panel task pending')
  await fs.rm(newSource, { force: true })
  await command({ type: 'new_session' })

  const acceptanceCommand = 'node -e "console.log(123)"'
  const tracked = await run('deliver with an explicit acceptance check', [
    useTool('task_progress', { action: 'start', goal: 'Deliver a tested change',
      checks: [{ description: 'Run the acceptance command', command: acceptanceCommand }] }, 'task_start'),
    { delta: 'I will verify the change next.' },
    useTool('verify', { command: acceptanceCommand, check: 1, timeout: 3 }, 'task_verify'),
    useTool('bash', { command: 'git add origin.txt', timeout: 3 }, 'stage_verified_content'),
    useTool('task_progress', { action: 'finish' }, 'task_finish'),
    { delta: 'Verified and completed.' },
  ])
  check(tracked.requests.length === 6 &&
    requestText(tracked.requests[2]).includes('Run the acceptance command'),
  'premature normal stop receives one continuation with the recorded pending criterion')
  check(toolResult(tracked, 'task_verify')?.details?.verification?.exitCode === 0 &&
    toolResult(tracked, 'task_finish')?.details?.task?.status === 'complete',
  'real command success records evidence, and staging the same bytes keeps that evidence valid')
  check(tracked.records.some(record => record.type === 'extension_ui_request' && record.method === 'setWidget' &&
    record.widgetKey === 'superpi-task' && record.widgetLines?.some(line => line.includes('1/1'))),
  'the completed task sends its verified item count through native extension UI')
  check((await command({ type: 'get_entries' })).data.entries.some(entry =>
    entry.type === 'custom' && entry.customType === 'superpi-task' && entry.data?.status === 'complete'),
  'completed task evidence is stored on the actual Pi session branch')
  const originalSession = (await command({ type: 'get_state' })).data.sessionFile
  check(typeof originalSession === 'string', 'Pi supplies the original session file for resume')
  check((await snapshot()).taskWidget?.widgetLines?.some(line => line.includes('1/1')),
    'a freshly attached panel receives progress even without replayed task events')
  await command({ type: 'new_session' })
  check((await snapshot()).taskWidget?.widgetLines === undefined,
    'a new session does not inherit progress from the previous session')
  await command({ type: 'switch_session', sessionPath: originalSession })
  check((await snapshot()).taskWidget?.widgetLines?.some(line => line.includes('1/1')) &&
    (await snapshot()).eventSeq === 0, 'resuming a session restores its task progress beyond the reset event ring')

  const milestones = await run('continue independently after newly verified milestones', [
    useTool('task_progress', { action: 'start', goal: 'Verify and inspect the change', checks: [
      { description: 'Run the command', command: acceptanceCommand }, { description: 'Inspect the result' },
    ] }, 'milestone_plan'), { delta: 'I will start.' },
    useTool('verify', { command: acceptanceCommand, check: 1, timeout: 3 }, 'milestone_check'), { delta: 'The command passed.' },
    useTool('task_progress', { action: 'observe', check: 2, observation: 'Inspected origin.txt.' }, 'milestone_read'),
    { delta: 'Both items were checked.' }, useTool('task_progress', { action: 'finish' }, 'milestone_finish'), { delta: 'Delivered.' },
  ])
  check(milestones.requests.length === 8 && toolResult(milestones, 'milestone_finish')?.details?.task?.status === 'complete' &&
    milestones.records.filter(record => record.type === 'agent_settled').length === 1 &&
    (await snapshot()).taskWidget?.widgetLines?.some(line => line.includes('2/2') && line.includes('已完成')),
  'the panel receives a completed two-check task after three early stops in the same user request')

  const automaticPlan = { action: 'start', goal: 'Deliver a fully verified result', finishWhenVerified: true,
    checks: [{ description: 'Run the final acceptance command', command: acceptanceCommand }] }
  const automatic = await run('finish when the declared verification passes', [
    useTool('task_progress', automaticPlan, 'automatic_start'),
    useTool('verify', { command: acceptanceCommand, check: 1, timeout: 3 }, 'automatic_verify'),
    { delta: 'This extra model request should be unnecessary.' },
  ])
  const isReceipt = entry => entry?.type === 'custom_message' && entry.customType === 'superpi-task-receipt' && entry.display === true
  const receipt = automatic.records.find(record => record.type === 'entry_appended' && isReceipt(record.entry))?.entry
  check(automatic.requests.length === 2 && toolResult(automatic, 'automatic_verify')?.details?.verification?.recorded === true &&
    automatic.records.some(record => record.type === 'agent_settled' && !record.aborted),
  'the last standalone verification can settle a declared automatic task without a third model request')
  check(receipt?.content.includes('Run the final acceptance command') &&
    (await snapshot()).taskWidget?.widgetLines?.some(line => line.includes('已完成')),
  'the panel receives the actual acceptance receipt and completed task state')
  check((await command({ type: 'get_entries' })).data.entries.filter(isReceipt).length === 1 &&
    (await command({ type: 'get_messages' })).data.messages.some(message => message.role === 'custom' &&
      message.customType === 'superpi-task-receipt' && message.display === true),
  'receipt and completion can be retrieved from the Pi session after the live event')

  const revisedCommand = 'node -e "console.log(456)"'
  const revisePlan = { ...automaticPlan, goal: 'Deliver after correcting one check',
    checks: [automaticPlan.checks[0], { description: 'Run the second command', command: acceptanceCommand }] }
  const revisedPlan = await run('deliver after revising only the pending command', [
    useTool('task_progress', revisePlan, 'revise_start'),
    useTool('verify', { command: acceptanceCommand, check: 1, timeout: 3 }, 'revise_first'),
    useTool('task_progress', { ...revisePlan, replace: true,
      checks: [revisePlan.checks[0], { ...revisePlan.checks[1], command: revisedCommand }] }, 'revise_update'),
    useTool('verify', { command: revisedCommand, check: 2, timeout: 3 }, 'revise_second'),
    { delta: 'The first verification should still count.' },
    { delta: 'The first verification should still count.' },
  ])
  check(revisedPlan.requests.length === 4 &&
    toolResult(revisedPlan, 'revise_update')?.details?.task?.checks[0].evidence?.toolCallId === 'revise_first' &&
    revisedPlan.records.some(record => record.type === 'entry_appended' && isReceipt(record.entry)) &&
    (await snapshot()).taskWidget?.widgetLines?.some(line => line.includes('2/2') && line.includes('已完成')),
  'the panel receives a receipt after the revised check without rerunning the unchanged command')

  const mixedVerification = useTool('verify', { command: acceptanceCommand, check: 1, timeout: 3 }, 'automatic_verify_before_edit')
  mixedVerification.delta.tool_calls.push({ ...writeCall('origin.txt', 'Changed after automatic verification').tool_calls[0],
    index: 1, id: 'automatic_following_edit' })
  const staleAutomatic = await run('settlement rechecks evidence after every tool in the batch', [
    useTool('task_progress', { ...automaticPlan, replace: true }, 'automatic_stale_start'),
    mixedVerification, { delta: 'The batch included an edit.' },
    useTool('task_progress', { action: 'block', reason: 'The edited file needs another test.' }, 'automatic_stale_block'),
    { delta: 'Acceptance remains pending.' },
  ])
  check(toolResult(staleAutomatic, 'automatic_following_edit')?.isError === false &&
    !staleAutomatic.records.some(record => record.type === 'entry_appended' && isReceipt(record.entry)) &&
    toolResult(staleAutomatic, 'automatic_stale_block')?.details?.task?.checks?.[0]?.evidence === undefined,
  'a write in the same batch lands normally and invalidates evidence before an automatic receipt can be emitted')
  await command({ type: 'new_session' })
  const steerText = 'Please wait for the decision before closing the task.'
  const delayedTest = 'node -e "setTimeout(() => console.log(123), 500)"'
  const withInput = await run('preserve user input arriving during final verification', [
    useTool('task_progress', { ...automaticPlan, checks: [{ description: 'Verify after waiting', command: delayedTest }] }, 'queued_start'),
    useTool('verify', { command: delayedTest, check: 1, timeout: 3 }, 'queued_verify'),
    useTool('task_progress', { action: 'block', reason: 'The user wants to decide before closing.' }, 'queued_block'),
    { delta: 'Waiting for the decision.' },
  ], { interact: async since => {
    await until(snapshot, state => state.events.some(entry => entry.seq > since && entry.record.type === 'tool_execution_start' &&
      entry.record.toolCallId === 'queued_verify'), 'the last verification before user steering')
    assert.equal((await command({ type: 'prompt', message: steerText, streamingBehavior: 'steer' })).ok, true)
  } })
  check(toolResult(withInput, 'queued_verify')?.details?.verification?.recorded === true &&
    withInput.requests.slice(2).some(request => requestText(request).includes(steerText)) &&
    !withInput.records.some(record => record.type === 'entry_appended' && isReceipt(record.entry)),
  'queued user input reaches the model before automatic completion can settle the earlier task')
  assert.equal((await command({ type: 'new_session' })).ok, true)

  const changed = await run('invalidate evidence after a source edit', [
    useTool('task_progress', { action: 'start', goal: 'Run evidence on current sources',
      checks: [{ description: 'Verify final content', command: acceptanceCommand }] }, 'new_task'),
    useTool('verify', { command: acceptanceCommand, check: 1, timeout: 3 }, 'new_verify'),
    useTool('write', { path: 'origin.txt', content: 'edited after verification' }, 'new_edit'),
    useTool('task_progress', { action: 'finish' }, 'new_finish'),
    useTool('task_progress', { action: 'block', reason: 'Waiting for the final verification environment.' }, 'new_block'),
    { delta: 'Final verification remains pending.' },
  ])
  check(toolResult(changed, 'new_finish')?.isError &&
    toolResult(changed, 'new_finish')?.content.some(block => block.text?.includes('changed')),
  'the task cannot claim a command passed on source that was edited after verification')
  check(changed.requests.length === 6 && toolResult(changed, 'new_block')?.details?.task?.status === 'blocked',
    'an explicit blocker persists and prevents automatic continuation')

  assert.equal((await command({ type: 'new_session' })).ok, true)
  const verificationControl = path.join(workspace, 'private.txt')
  const repeatCommand = `node -e "if (require('node:fs').readFileSync('private.txt', 'utf8') === 'hold') { console.log('acceptance rerun executing'); setTimeout(() => process.exit(7), 5000) }"`
  const rerunVerification = id => useTool('verify', { command: repeatCommand, check: 1, timeout: 20 }, id)
  const waitForRerun = (id, since) => until(snapshot, state => state.events.some(entry => entry.seq > since &&
    entry.record.type === 'tool_execution_update' && entry.record.toolCallId === id &&
    entry.record.partialResult?.content?.some(block => block.text?.includes('acceptance rerun executing'))),
  'real shell output while the rerun is in progress')
  const verificationBeforeStop = await run('record command and observation evidence before a repeat run', [
    useTool('task_progress', { action: 'start', goal: 'Deliver with the latest accepted verification', checks: [
      { description: 'Run the acceptance command again when needed', command: repeatCommand },
      { description: 'Inspect the existing artifact' },
    ] }, 'rerun_task'),
    useTool('task_progress', { action: 'observe', check: 2, observation: 'Confirmed origin.txt is readable.' }, 'rerun_observation'),
    rerunVerification('original_verification'),
    { delta: 'The initial evidence was recorded.' }, { delta: 'I will repeat the command before delivery.' },
  ])
  check(toolResult(verificationBeforeStop, 'original_verification')?.details?.verification?.recorded &&
    (await snapshot()).taskWidget?.widgetLines?.some(line => line.includes('2/2')),
  'the task has genuine successful command evidence before the new attempt')

  await fs.writeFile(verificationControl, 'hold')
  const stoppedVerification = await run('stop the repeated verification while its command is running', [
    rerunVerification('cancelled_verification'),
  ], { interact: async since => {
    await waitForRerun('cancelled_verification', since)
    assert.equal((await command({ type: 'abort' })).ok, true)
  } })
  check(stoppedVerification.records.at(-1)?.aborted && stoppedVerification.requests.length === 1 &&
    (await snapshot()).taskWidget?.widgetLines?.some(line => line.includes('1/2')),
  'a user stop leaves only the rechecked command pending and makes no new model request')

  await fs.writeFile(verificationControl, 'ignored fixture')
  const verifiedAgain = await run('earn fresh evidence before simulating a process exit', [
    rerunVerification('verification_before_exit'),
    { delta: 'This verification completed.' }, { delta: 'The task can still be checked again.' },
  ])
  const proofBeforeExit = toolResult(verifiedAgain, 'verification_before_exit')
  check(proofBeforeExit?.details?.verification?.recorded, 'a successful retry restores command evidence after a stop')

  const verificationProcess = await snapshot()
  const verificationSession = (await command({ type: 'get_state' })).data.sessionFile
  await fs.writeFile(verificationControl, 'hold')
  replies = [rerunVerification('verification_interrupted_by_exit')]
  assert.equal((await command({ type: 'prompt', message: 'Repeat the command before the verification process exits' })).ok, true)
  const verificationRunning = await waitForRerun('verification_interrupted_by_exit', verificationProcess.eventSeq)
  const verificationEntries = (await fs.readFile(verificationSession, 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line))
  const pendingVerification = verificationEntries.findLast(entry => entry.type === 'custom' && entry.customType === 'superpi-task')?.data
  check(verificationRunning.taskWidget?.widgetLines?.some(line => line.includes('1/2')) &&
    !pendingVerification?.checks[0].evidence && pendingVerification?.checks[1].evidence?.observation &&
    !verificationEntries.some(entry => entry.type === 'message' && entry.message.role === 'toolResult' &&
      entry.message.toolCallId === 'verification_interrupted_by_exit'),
  'the pending command is visible and saved while the real shell runs, before a tool result exists')
  assert(Number.isInteger(verificationProcess.pid) && verificationProcess.pid > 0 && verificationProcess.pid !== process.pid,
    'terminate only the spawned verification fixture subprocess')
  process.kill(verificationProcess.pid, 'SIGKILL')
  await until(() => request('/state'), state => !state.sessions.some(item => item.id === verificationProcess.id),
    'the verification fixture subprocess to exit')
  sessionId = (await request('/sessions', {})).session.id
  assert.equal((await command({ type: 'switch_session', sessionPath: verificationSession })).ok, true)
  check((await snapshot()).taskWidget?.widgetLines?.some(line => line.includes('1/2')),
    'the same session opened in a new subprocess shows the command is still pending')

  await fs.writeFile(verificationControl, 'ignored fixture')
  const afterVerificationExit = await run('finish only after a successful new verification', [
    useTool('task_progress', { action: 'finish' }, 'finish_with_old_verification'),
    rerunVerification('verification_after_exit'),
    useTool('task_progress', { action: 'finish' }, 'finish_with_new_verification'),
    { delta: 'The latest verification completed and was recorded.' },
  ])
  const finishAfterExit = toolResult(afterVerificationExit, 'finish_with_new_verification')
  check(toolResult(afterVerificationExit, 'finish_with_old_verification')?.isError &&
    toolResult(afterVerificationExit, 'finish_with_old_verification')?.content[0].text.includes('pending'),
  'reopening the task cannot finish with the pass superseded by an interrupted rerun')
  check(finishAfterExit?.details?.task?.status === 'complete' &&
    finishAfterExit.details.task.checks[0].evidence.toolCallId === 'verification_after_exit',
  'only a newly completed run supplies the final command evidence')

  const draftPath = path.join(workspace, 'draft.txt')
  const draftBeforeVerification = await fs.readFile(draftPath)
  const readDraft = 'node -e "' + [
    "const fs = require('node:fs'); console.log('waiting for draft');",
    'const timer = setInterval(() => {',
    "  const phase = fs.readFileSync('private.txt', 'utf8');",
    "  if (phase === 'read draft') {",
    "    if (fs.readFileSync('draft.txt', 'utf8') !== 'alternate draft') process.exit(7);",
    "    console.log('tested alternate draft'); fs.writeFileSync('private.txt', 'draft read');",
    "  } else if (phase === 'finish draft') clearInterval(timer);",
    '}, 25);',
  ].join(' ') + '"'
  const changedDuringVerification = await run('detect an outside edit of a new source file during the check', [
    useTool('task_progress', { action: 'start', goal: 'Verify the changed draft',
      checks: [{ description: 'Run the draft check', command: readDraft }] }, 'draft_acceptance'),
    useTool('verify', { command: readDraft, timeout: 20, check: 1 }, 'verify_changed_draft'),
    useTool('task_progress', { action: 'finish' }, 'finish_changed_draft'),
    useTool('task_progress', { action: 'block', reason: 'The draft needs a stable test run.' }, 'block_changed_draft'),
    { delta: 'The draft needs a stable test run.' },
  ], { interact: async since => {
    await until(snapshot, state => state.events.some(entry => entry.seq > since &&
      entry.record.type === 'tool_execution_update' && entry.record.toolCallId === 'verify_changed_draft' &&
      entry.record.partialResult?.content?.some(block => block.text?.includes('waiting for draft'))), 'the draft check to start')
    await fs.writeFile(draftPath, 'alternate draft')
    await fs.writeFile(verificationControl, 'read draft')
    await until(() => fs.readFile(verificationControl, 'utf8'), value => value === 'draft read', 'the draft check to read the external edit')
    await fs.writeFile(draftPath, draftBeforeVerification)
    await fs.writeFile(verificationControl, 'finish draft')
  } })
  await fs.writeFile(verificationControl, 'ignored fixture')
  const checkedDraft = toolResult(changedDuringVerification, 'verify_changed_draft')
  check(checkedDraft?.details?.verification?.exitCode === 0 && checkedDraft.content.some(block => block.text?.includes('tested alternate draft')) &&
    (await fs.readFile(draftPath)).equals(draftBeforeVerification), 'the real shell completed after testing only the outside edit that was later restored')
  check(checkedDraft?.isError && checkedDraft.details?.verification?.status === 'stale' &&
    checkedDraft.details.verification.recorded === false &&
    checkedDraft.content[0].text.includes('changed during this command ("draft.txt")') &&
    toolResult(changedDuringVerification, 'finish_changed_draft')?.isError &&
    changedDuringVerification.records.some(record => record.type === 'tool_execution_end' &&
      record.toolCallId === 'verify_changed_draft' && record.isError === true) &&
    (await snapshot()).taskWidget?.widgetLines?.some(line => line.includes('0/1')),
  'the panel shows the command still pending after the concurrent edit of an untracked source file')

  assert.equal((await command({ type: 'new_session' })).ok, true)
  const transientDirectoryCheck = 'node -e "' + [
    "const fs = require('node:fs'); const dir = 'temporary inputs'; const source = dir + '/fixture.js';",
    'fs.mkdirSync(dir);',
    "try { fs.writeFileSync(source, 'input');",
    "  if (fs.readFileSync(source, 'utf8') === 'input') console.log('read transient directory');",
    '  else process.exitCode = 7;',
    '} finally { fs.unlinkSync(source); fs.rmdirSync(dir); }',
  ].join(' ') + '"'
  const transientDirectory = await run('detect input read from a new directory that is removed before exit', [
    useTool('task_progress', { action: 'start', goal: 'Verify the actual source set',
      checks: [{ description: 'Verify inputs from the worktree', command: transientDirectoryCheck }] }, 'transient_directory_task'),
    useTool('verify', { command: transientDirectoryCheck, timeout: 10, check: 1 }, 'transient_directory_verify'),
    useTool('task_progress', { action: 'finish' }, 'transient_directory_finish'),
    useTool('task_progress', { action: 'block', reason: 'The verification used transient sources.' }, 'transient_directory_block'),
    { delta: 'A stable run is still needed.' },
  ])
  const checkedTransient = toolResult(transientDirectory, 'transient_directory_verify')
  check(checkedTransient?.details?.verification?.exitCode === 0 && checkedTransient.content.some(block => block.text?.includes('read transient directory')) &&
    await fs.stat(path.join(workspace, 'temporary inputs')).catch(error => error.code) === 'ENOENT',
  'the real shell read a temporary path and removed the new directory before it reported success')
  check(checkedTransient?.isError && checkedTransient.details?.verification?.status === 'stale' &&
    checkedTransient.content[0].text.includes('temporary inputs') &&
    toolResult(transientDirectory, 'transient_directory_finish')?.isError &&
    (await snapshot()).taskWidget?.widgetLines?.some(line => line.includes('0/1')),
  'the panel keeps the task pending and names the directory that came and went during verification')

  await fs.writeFile(path.join(workspace, 'existing-check.spec.mjs'), '// Verification from the unchanged base.\n')
  execFileSync('git', ['-c', 'core.autocrlf=false', 'add', '-A'], { cwd: workspace })
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '-am', 'baseline'], { cwd: workspace })
  await fs.writeFile(path.join(workspace, 'origin.txt'), 'NEW reviewed line\nsecond line\n')
  const requestReview = (args, id) => useTool('review_changes', { goal: 'Keep the changed source correct and tested', timeout: 5, ...args }, id)
  const publish = (summary, findings, id) => useTool('submit_review', { summary, findings }, id)
  const clean = focus => publish(focus + ' checked the requested change.', [], focus + '_published')
  reviewReplies = {
    correctness: [{ ...useTool('read_review_file', { path: '../private.txt' }, 'outside'), delayMs: 150 },
      useTool('read_review_file', { path: 'origin.txt' }, 'read_changed'), clean('correctness')],
    tests: [{ ...useTool('list_review_files', { query: '.spec.' }, 'find_existing_spec'), delayMs: 150 }, clean('tests')],
  }
  const independentlyReviewed = await run('review a change in the task checklist', [
    useTool('task_progress', { action: 'start', goal: 'Review current work', replace: true,
      checks: [{ description: 'Independent review of all changes', review: true }] }, 'review_plan'),
    useTool('task_progress', { action: 'observe', check: 1, observation: 'I looked at it myself.' }, 'pretend_review'),
    requestReview({ check: 1, paths: ['origin.txt'], base: 'HEAD' }, 'review_evidence'),
    useTool('task_progress', { action: 'finish' }, 'review_finish'),
    { delta: 'Independent review was recorded.' },
  ])
  const reviewResult = toolResult(independentlyReviewed, 'review_evidence')
  check(reviewResult?.details?.review?.status === 'clear' && reviewResult.details.review.reviewers.length === 2 &&
    toolResult(independentlyReviewed, 'review_finish')?.details?.task?.status === 'complete',
  'two structured read-only reviews attest the exact source snapshot')
  check(toolResult(independentlyReviewed, 'pretend_review')?.isError === true, 'a self-observation cannot replace required independent review')
  const lanes = independentlyReviewed.requests.filter(payload =>
    payload.messages.some(message => message.role === 'system' && message.content.startsWith('You are the independent ')))
  check(lanes.length === 5 && lanes.every(payload => payload.tools?.map(tool => tool.function.name).sort().join(',') ===
    'list_review_files,read_review_file,submit_review'), 'both independent model contexts get only snapshot discovery, reading, and report tools')
  check(lanes.slice(0, 2).map(payload => payload.messages[0].content.match(/independent (correctness|tests)/)?.[1]).sort().join(',') ===
    'correctness,tests', 'the two reviewers start before either one performs another model request')
  check(lanes.some(payload => requestText(payload).includes('NEW reviewed line')) &&
    lanes.some(payload => requestText(payload).includes('outside the review snapshot')),
  'the reviewed snapshot exposes exact file content and rejects a path outside its root')
  const listing = lanes.find(payload => payload.messages.some(message => message.role === 'tool' &&
    String(message.content).includes('existing-check.spec.mjs')))
  check(lanes.slice(0, 2).every(payload => requestText(payload).includes('existing-check.spec.mjs')) && listing &&
    !requestText(listing).includes('private.txt'), 'an unchanged test is discoverable and ignored files are absent from the review catalog')

  reviewReplies = { correctness: [clean('correctness')], tests: [clean('tests')] }
  const automaticReview = await run('finish only after the declared independent review reports return', [
    useTool('task_progress', { action: 'start', goal: 'Deliver independently reviewed changes', finishWhenVerified: true,
      checks: [{ description: 'Independent review of all changes', review: true }] }, 'automatic_review_plan'),
    requestReview({ check: 1, paths: ['origin.txt'], base: 'HEAD' }, 'automatic_review_check'),
    { delta: 'The native receipt already reported the review.' },
  ])
  check(automaticReview.requests.length === 4 && toolResult(automaticReview, 'automatic_review_check')?.details?.review?.recorded === true &&
    automaticReview.records.some(record => record.type === 'entry_appended' && isReceipt(record.entry)),
  'automatic completion waits for both independent reports and then uses the same visible receipt')

  reviewReplies = {
    correctness: [publish('Found a concrete regression.', [{ severity: 'blocking', path: 'origin.txt', line: 1, quote: 'NEW reviewed line',
      problem: 'This changed line breaks the fixture contract.' }], 'found')],
    tests: [clean('tests')],
  }
  const defects = await run('surface findings to the parent', [requestReview({}, 'review_findings'), { delta: 'Regression recorded.' }])
  check(toolResult(defects, 'review_findings')?.details?.review?.status === 'findings' &&
    requestText(defects.requests.at(-1)).includes('breaks the fixture contract'), 'blocking defects survive the provider and panel transport')
  const cite = (line, quote) => publish('Review the exact changed text.', [
    { severity: 'blocking', path: 'origin.txt', line, quote, problem: 'The changed line violates the fixture contract.' },
  ], 'quote_' + line)
  reviewReplies = { correctness: [cite(3, 'line'), cite(2, 'NEW reviewed line')], tests: [clean('tests')] }
  const located = await run('locate an unambiguous current source quote', [requestReview({}, 'located_quote'), { delta: 'Reported the actual line.' }])
  const locatedReview = toolResult(located, 'located_quote')?.details?.review
  check(locatedReview?.newRequests === 3 && locatedReview.reviewers.some(report =>
    report.findings?.some(item => item.line === 1 && item.quote === 'NEW reviewed line')) &&
    requestText(located.requests.at(-1)).includes('origin.txt:1'),
  'an ambiguous quote at a wrong line is rejected, and a unique verbatim quote resolves to the real line in the parent report')
  reviewReplies = { correctness: [{ hold: true }], tests: [clean('tests')] }
  const partial = await run('bound a stalled review lane', [requestReview({ timeout: 1 }, 'review_timeout'), { delta: 'Review incomplete.' }])
  check(toolResult(partial, 'review_timeout')?.details?.review?.status === 'timed_out' &&
    toolResult(partial, 'review_timeout')?.details?.review?.reviewers.some(reviewer => reviewer.focus === 'tests' && reviewer.status === 'complete'),
  'deadline returns the completed reviewer evidence without treating a stalled reviewer as clean')
  const timeoutReview = toolResult(partial, 'review_timeout')?.details?.review
  check(timeoutReview?.newRequests === 2 && timeoutReview.reviewers.some(reviewer =>
    reviewer.focus === 'correctness' && reviewer.status === 'cancelled' && reviewer.requests === 1),
  'a cancelled reviewer still records its dispatched model request')
  check(partial.records.some(record => record.type === 'tool_execution_update' && record.toolCallId === 'review_timeout' &&
    record.partialResult?.details?.reviewProgress?.requests === 2 && record.partialResult.details.reviewProgress.completed === 0),
  'published progress counts dispatched requests before a reviewer returns')

  reviewReplies = { correctness: [{ delta: 'Partial reviewer response.', streamError: earlyClose }], tests: [clean('tests')] }
  const droppedReview = await run('surface a reviewer gateway disconnect', [requestReview({}, 'review_disconnect'), { delta: 'A reviewer lost its stream.' }])
  check(toolResult(droppedReview, 'review_disconnect')?.details?.review?.reviewers.some(reviewer =>
    reviewer.focus === 'correctness' && reviewer.failure === 'stream-interrupted' && reviewer.requests === 1),
  'reviewer transport errors retain their cause and request count')

  const runtimeNote = 'Command execution is verified separately. The source and tests are statically covered.'
  reviewReplies = { correctness: [clean('correctness')], tests: [payload => {
    const report = payload.tools.find(tool => tool.function.name === 'submit_review').function.parameters.properties
    const scope = report.gaps && !report.limitation ? { notes: runtimeNote } : { limitation: runtimeNote }
    return useTool('submit_review', { summary: 'The changed source and its tests were reviewed.', findings: [], ...scope }, 'review_note')
  }] }
  const annotated = await run('distinguish static gaps from runtime observations in a diff', [
    requestReview({ paths: ['origin.txt'] }, 'review_diff_notes'), { delta: 'Static coverage recorded.' },
  ])
  const annotatedProof = toolResult(annotated, 'review_diff_notes')?.details?.review
  check(annotatedProof?.inputMode === 'diff' && annotatedProof.status === 'clear' && annotatedProof.reviewers.some(reviewer =>
    reviewer.focus === 'tests' && reviewer.notes === runtimeNote && !reviewer.limitation),
  'diff and snapshot reports both distinguish runtime notes from a source-anchored static coverage gap')

  await fs.writeFile(path.join(workspace, 'review-new.txt'), 'Untracked source included in review.\n')
  reviewReplies = {
    correctness: [publish('Invalid line anchor.', [{ severity: 'blocking', path: 'origin.txt', line: 9999,
      problem: 'A finding cannot cite a nonexistent line.' }], 'bad_anchor'), { delta: 'Review without a valid report.' }],
    tests: [clean('tests')],
  }
  const invalid = await run('require a valid line in the captured snapshot', [
    requestReview({}, 'review_bad_anchor'), { delta: 'Invalid finding was rejected.' },
  ])
  const invalidLanes = invalid.requests.filter(payload => payload.messages[0]?.content?.startsWith('You are the independent '))
  check(toolResult(invalid, 'review_bad_anchor')?.details?.review?.status === 'partial' &&
    invalidLanes.some(payload => requestText(payload).includes('Finding line is missing')),
  'a nonexistent line cannot be recorded as either a blocking or clean report')
  check(invalidLanes.slice(0, 2).every(payload => requestText(payload).includes('Untracked source included in review.')),
    'both reviewers see new files along with changes from the Git base')

  reviewReplies = { correctness: [clean('correctness')], tests: [clean('tests')] }
  const scoped = await run('check that the selected paths cover all work', [
    useTool('task_progress', { action: 'start', goal: 'Review tracked and untracked changes', replace: true,
      checks: [{ description: 'Review the full change', review: true }] }, 'scoped_plan'),
    requestReview({ check: 1, paths: ['origin.txt'] }, 'review_scope'),
    useTool('task_progress', { action: 'block', reason: 'Untracked source still needs review.' }, 'scoped_block'),
    { delta: 'The uncovered file remains pending.' },
  ])
  const scopedReview = toolResult(scoped, 'review_scope')
  check(scopedReview?.isError && scopedReview.details?.review?.status === 'clear' &&
    scopedReview.details.review.uncovered.includes('review-new.txt') && !scopedReview.details.review.recorded,
  'a clean path-limited review cannot certify a changed file outside its scope')
  reviewReplies = { correctness: [clean('correctness')], tests: [clean('tests')] }
  const widened = await run('review the previously uncovered file', [
    useTool('task_progress', { action: 'resume' }, 'resume_full_scope'),
    requestReview({ check: 1 }, 'review_full_scope'),
    useTool('task_progress', { action: 'finish' }, 'record_full_scope'),
    { delta: 'All changed files were reviewed.' },
  ])
  check(toolResult(widened, 'review_full_scope')?.details?.review?.execution === 'new' &&
    widened.requests.filter(payload => payload.messages[0]?.content?.startsWith('You are the independent ')).length === 2 &&
    toolResult(widened, 'record_full_scope')?.details?.task?.status === 'complete',
  'widening a review to a previously uncovered file requires both fresh reports')

  const manyReads = Array.from({ length: 11 }, (_, index) =>
    useTool('read_review_file', { path: 'origin.txt', count: 1 }, 'read_for_budget_' + index))
  reviewReplies = {
    correctness: [...manyReads, useTool('submit_review', {
      summary: 'Some behavior still needs examination.', findings: [],
      gaps: [{ path: 'origin.txt', reason: 'The remaining caller was not reviewed.' }],
    }, 'limited_report')],
    tests: [clean('tests')],
  }
  const budgeted = await run('reserve the last reviewer request for a report', [
    requestReview({ timeout: 12 }, 'review_budget'), { delta: 'The incomplete report is preserved.' },
  ])
  const budgetLane = budgeted.requests.filter(payload => payload.messages[0]?.content?.startsWith('You are the independent correctness reviewer.'))
  check(budgetLane.length === 12 && budgetLane.at(-1).tools.map(tool => tool.function.name).join(',') === 'submit_review',
  'the last provider request can submit a report after all read requests have been used (requests=' + budgetLane.length +
    ', tools=' + budgetLane.at(-1)?.tools?.map(tool => tool.function.name).join(',') + ')')
  const budgetReport = toolResult(budgeted, 'review_budget')?.details?.review
  check(budgetReport?.status === 'partial' && budgetReport.reviewers.some(reviewer =>
    reviewer.status === 'incomplete' && reviewer.gaps?.[0].path === 'origin.txt' && reviewer.limitation.includes('The remaining caller was not reviewed.')),
  'a reviewer can preserve findings and explicitly report inadequate coverage (' + JSON.stringify(budgetReport?.reviewers) + ')')

  reviewReplies = {
    correctness: [{ ...clean('correctness'), delayMs: 250 }],
    tests: [{ ...clean('tests'), delayMs: 250 }],
  }
  const beforeEdit = requests.length
  const stale = await run('review a moving workspace', [
    requestReview({}, 'review_stale'), { delta: 'Reviewed source had changed.' },
  ], { interact: async () => {
    await until(() => requests.slice(beforeEdit), batch => batch.some(payload =>
      payload.messages[0]?.content?.startsWith('You are the independent ')), 'the immutable review input')
    await fs.writeFile(path.join(workspace, 'origin.txt'), 'Edit after the reviewers started.\n')
  } })
  const staleReview = toolResult(stale, 'review_stale')?.details?.review
  check(staleReview?.status === 'stale' && !staleReview.recorded &&
    staleReview.reviewers.every(reviewer => reviewer.status === 'complete'),
  'both reports remain available but cannot attest source changed during review')

  const beginReview = (goal, id) => useTool('task_progress', { action: 'start', replace: true, goal,
    checks: [{ description: 'Review the current source and tests', review: true }] }, id)
  const reviewRequests = activity => activity.requests.filter(payload =>
    payload.messages[0]?.content?.startsWith('You are the independent '))
  const laneOf = payload => payload.messages[0].content.match(/^You are the independent (correctness|tests) reviewer\./)?.[1]
  const packetOf = payload => {
    const content = payload.messages.find(message => message.role === 'user').content
    return JSON.parse(typeof content === 'string' ? content : content.find(block => block.type === 'text').text)
  }
  const resumeSource = useTool('read_review_file', { path: 'origin.txt', start: 1, count: 1 }, 'resume_source')
  const readLine = (await fs.readFile(path.join(workspace, 'origin.txt'), 'utf8')).split('\n')[0]
  const abandonedReport = 'An unfinished report that must never be submitted'
  const lostReport = { delta: { tool_calls: [{ index: 0, id: 'lost_report', type: 'function', function: {
    name: 'submit_review', arguments: '{"summary":"' + abandonedReport,
  } }] }, streamError: gatewayClosed }
  reviewReplies = { correctness: [resumeSource, lostReport, publish('Completed from the captured source.', [{
    severity: 'blocking', path: 'origin.txt', line: 1, quote: readLine, problem: 'The line conflicts with the fixture contract.',
  }], 'resumed_report')], tests: [clean('tests')] }
  const recoveredReview = await run('continue an interrupted review using its finished source read', [
    requestReview({ paths: ['origin.txt'] }, 'review_transport_resume'), { delta: 'The interrupted report recovered.' },
  ])
  const recoveredProof = toolResult(recoveredReview, 'review_transport_resume')?.details?.review
  const recoveredCalls = reviewRequests(recoveredReview)
  const recoveredLane = recoveredCalls.filter(payload => laneOf(payload) === 'correctness')
  const recoveredPacket = recoveredLane[2] && packetOf(recoveredLane[2])
  check(recoveredProof?.status === 'findings' && recoveredProof.newRequests === 4 &&
    recoveredProof.pendingReviewers.includes('correctness') &&
    recoveredProof.reviewers.some(reviewer => reviewer.focus === 'correctness' && reviewer.recovery?.request === 3 &&
      reviewer.recovery.kind === 'stream-interrupted' && reviewer.status === 'incomplete' &&
      reviewer.findings?.some(finding => finding.path === 'origin.txt' && finding.line === 1)),
  'a disconnected reviewer returns its anchored finding while full static coverage remains pending')
  check(recoveredLane.length === 3 && recoveredCalls.filter(payload => laneOf(payload) === 'tests').length === 1 &&
    recoveredLane[2].messages.every(message => ['system', 'user'].includes(message.role)) &&
    recoveredPacket?.sourceReads?.length === 1 && recoveredPacket.sourceReads[0].path === 'origin.txt' &&
    recoveredPacket.sourceReads[0].start === 1 && recoveredPacket.sourceReads[0].end === 1 &&
    recoveredPacket.sourceReads[0].text === '1\t' + readLine && Object.keys(recoveredPacket).sort().join(',') === 'goal,sourceReads' &&
    recoveredLane[2].tools.map(tool => tool.function.name).join(',') === 'submit_review' &&
    !requestText(recoveredLane[2]).includes(abandonedReport),
  'a report request receives the exact source excerpt and review goal without the interrupted draft or old tool dialogue')
  check(recoveredReview.records.some(record => record.type === 'tool_execution_update' &&
    record.toolCallId === 'review_transport_resume' && record.partialResult?.details?.reviewProgress?.recovering === 'correctness' &&
    record.partialResult.details.reviewProgress.requests === 4 &&
    record.partialResult.content.some(block => block.text?.includes('Resuming correctness from captured source'))) &&
    toolResult(recoveredReview, 'review_transport_resume')?.content.some(block => block.text?.includes('Review resumed from captured source')),
  'the displayed progress and report name the reviewer resuming from captured evidence')

  reviewReplies = { correctness: [resumeSource, lostReport, lostReport], tests: [clean('tests')] }
  const repeatedLoss = await run('bound repeated disconnects during review', [
    requestReview({ paths: ['origin.txt'] }, 'review_transport_bound'), { delta: 'There is still an incomplete review.' },
  ])
  const lostProof = toolResult(repeatedLoss, 'review_transport_bound')?.details?.review
  check(lostProof?.status === 'partial' && lostProof.newRequests === 4 && lostProof.reviewers.some(reviewer =>
    reviewer.focus === 'correctness' && reviewer.requests === 3 && reviewer.failure === 'stream-interrupted' &&
    reviewer.recovery?.request === 3 && !reviewer.summary), 'a second disconnect keeps the report partial and dispatches no third attempt')

  reviewReplies = { correctness: [resumeSource, lostReport, useTool('read_review_file', {
    path: 'origin.txt', start: 1, count: 2,
  }, 'unavailable_read'), clean('correctness')], tests: [clean('tests')] }
  const delayedDiscovery = await run('bound the recovery phase to a single report attempt', [
    requestReview({ paths: ['origin.txt'] }, 'review_report_only'), { delta: 'The report still needs coverage.' },
  ])
  const reportOnlyProof = toolResult(delayedDiscovery, 'review_report_only')?.details?.review
  check(reportOnlyProof?.status === 'partial' && reportOnlyProof.newRequests === 4 && reportOnlyProof.reviewers.some(reviewer =>
    reviewer.focus === 'correctness' && reviewer.recovery?.request === 3 && !reviewer.summary),
  'an attempted discovery call on the report request leaves a genuine partial review without another provider request')

  reviewReplies = { correctness: [...manyReads, lostReport], tests: [clean('tests')] }
  const lastRequestLoss = await run('stop review recovery at the lane request limit', [
    requestReview({ paths: ['origin.txt'] }, 'review_transport_limit'), { delta: 'The final review request was interrupted.' },
  ])
  const limitProof = toolResult(lastRequestLoss, 'review_transport_limit')?.details?.review
  check(limitProof?.status === 'partial' && limitProof.newRequests === 13 && limitProof.reviewers.some(reviewer =>
    reviewer.focus === 'correctness' && reviewer.requests === 12 && reviewer.failure === 'stream-interrupted' && !reviewer.recovery),
  'recovery spends the same lane budget and cannot dispatch beyond the last report request')

  const firstResumeRequest = requests.length
  reviewReplies = { correctness: [resumeSource, lostReport, { hold: true }], tests: [clean('tests')] }
  const stoppedReview = await run('stop an independent reviewer during recovery', [
    requestReview({ paths: ['origin.txt'] }, 'review_transport_stop'),
  ], { interact: async () => {
    await until(() => requests.slice(firstResumeRequest).filter(laneOf), calls =>
      calls.filter(payload => laneOf(payload) === 'correctness').length === 3, 'the reviewer recovery request')
    await command({ type: 'abort' })
  } })
  check(reviewRequests(stoppedReview).length === 4 && stoppedReview.records.some(record =>
    record.type === 'agent_settled' && record.aborted), 'explicit stop cancels the recovery request within the parent activity')

  const savedPath = 'existing-check.spec.mjs'
  const savedFile = await fs.readFile(path.join(workspace, savedPath), 'utf8')
  const savedLine = savedFile.split('\n')[0]
  const savedRead = useTool('read_review_file', { path: savedPath, start: 1, count: 1 }, 'durable_source')
  const deniedRead = useTool('read_review_file', { path: '../private.txt', start: 1, count: 1 }, 'denied_checkpoint')
  reviewReplies = { correctness: [savedRead, deniedRead, lostReport, lostReport], tests: [clean('tests')] }
  const firstAttempt = await run('start a review that will need to resume', [
    beginReview('Keep completed evidence across a session reload', 'repeat_plan'),
    requestReview({ check: 1 }, 'partial_review'),
    useTool('task_progress', { action: 'block', reason: 'Correctness review still has to return.' }, 'pause_review'),
    { delta: 'Test review completed. Correctness evidence is pending.' },
  ])
  const firstProof = toolResult(firstAttempt, 'partial_review')?.details?.review
  const reviewSessionFile = (await command({ type: 'get_state' })).data.sessionFile
  const closedReviewSession = sessionId
  await request(session(), undefined, 'DELETE')
  sessionId = undefined
  const persisted = (await fs.readFile(reviewSessionFile, 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line))
    .find(record => record.type === 'message' && record.message.toolCallId === 'partial_review')?.message.details.review
  const savedReviewer = persisted?.reviewers.find(reviewer => reviewer.focus === 'correctness')
  check(savedReviewer?.failure === 'stream-interrupted' && savedReviewer.recovery?.request === 4 &&
    JSON.stringify(savedReviewer.sourceRanges) === JSON.stringify([{ path: savedPath, start: 1, end: 1 }]) &&
    !JSON.stringify(persisted).includes(savedLine),
  'the session file records only the successful source coordinates after both review streams disconnect')

  sessionId = (await request('/sessions', {})).session.id
  assert.notEqual(sessionId, closedReviewSession, 'restart the review subprocess before loading the session file')
  const reopened = await command({ type: 'switch_session', sessionPath: reviewSessionFile })
  assert.equal(reopened.ok, true, 'reopen the persisted review evidence')
  execFileSync('git', ['-c', 'core.autocrlf=false', 'add', 'review-new.txt'], { cwd: workspace })
  const resumedReport = useTool('submit_review', {
    summary: 'Checked the captured code and callers.', findings: [],
    notes: 'This is a static review. Test execution is separate verification.',
  }, 'correctness_with_static_scope_note')
  const exactRestoredRead = payload => packetOf(payload).sourceReads?.some(read =>
    read.path === savedPath && read.start === 1 && read.end === 1 && read.text === '1\t' + savedLine)
  reviewReplies = { correctness: [payload => exactRestoredRead(payload) ? resumedReport : savedRead, resumedReport] }
  const resumedReview = await run('resume only the missing reviewer', [
    useTool('task_progress', { action: 'resume' }, 'resume_review'),
    requestReview({ check: 1, paths: ['review-new.txt', 'origin.txt'], base: 'HEAD', timeout: 7,
      goal: 'Additional wording changes neither the saved task nor its checked scope. '.repeat(8) }, 'resumed_review'),
    useTool('task_progress', { action: 'finish' }, 'resumed_finish'),
    { delta: 'Verified and complete.' },
  ])
  const combined = toolResult(resumedReview, 'resumed_review')?.details?.review
  check(firstProof?.status === 'partial' && combined?.status === 'clear' && combined.reused?.join(',') === 'tests' &&
    combined.fingerprint === firstProof.fingerprint && reviewRequests(resumedReview).map(laneOf).join(',') === 'correctness',
  'reopening and staging the same bytes resume only the unfinished reviewer for the same effective scope')
  check(toolResult(resumedReview, 'resumed_finish')?.details?.task?.status === 'complete',
    'resumed independent evidence can complete the real task')
  check(combined?.reviewers.some(reviewer => reviewer.focus === 'correctness' && reviewer.status === 'complete' &&
    reviewer.notes === 'This is a static review. Test execution is separate verification.'),
  'a static-scope note is preserved without being treated as missing review evidence')
  const resumedCalls = reviewRequests(resumedReview)
  check(resumedCalls.length === 1 && exactRestoredRead(resumedCalls[0]) &&
    combined?.reviewers.some(reviewer => reviewer.focus === 'correctness' && reviewer.restoredReads === 1) &&
    toolResult(resumedReview, 'resumed_review')?.content.some(block => block.text?.includes('Source excerpts restored · 1')),
  'after a process restart the first missing-reviewer request already contains the verified numbered excerpt')

  reviewReplies = { correctness: [savedRead, { delta: 'The independent report is still pending.' }], tests: [clean('tests')] }
  const checkpointBeforeEdit = await run('leave source coordinates under the old fingerprint', [
    beginReview('Restore excerpts only for the same source', 'changed_checkpoint_plan'),
    requestReview({ check: 1 }, 'changed_checkpoint_old'),
    useTool('task_progress', { action: 'block', reason: 'The independent report is still pending.' }, 'changed_checkpoint_block'),
    { delta: 'The review is pending.' },
  ])
  await fs.writeFile(path.join(workspace, savedPath), '// The verification source changed on disk.\n')
  reviewReplies = { correctness: [clean('correctness')], tests: [clean('tests')] }
  const checkpointAfterEdit = await run('review from a clean slate after the captured bytes change', [
    useTool('task_progress', { action: 'resume' }, 'changed_checkpoint_resume'),
    requestReview({ check: 1 }, 'changed_checkpoint_new'), useTool('task_progress', { action: 'finish' }, 'changed_checkpoint_finish'),
    { delta: 'Both fresh reports were recorded.' },
  ])
  await fs.writeFile(path.join(workspace, savedPath), savedFile)
  const beforeCheckpoint = toolResult(checkpointBeforeEdit, 'changed_checkpoint_old')?.details?.review
  const afterCheckpoint = toolResult(checkpointAfterEdit, 'changed_checkpoint_new')?.details?.review
  check(beforeCheckpoint?.reviewers.some(reviewer => reviewer.focus === 'correctness' && reviewer.sourceRanges?.[0].path === savedPath) &&
    afterCheckpoint?.execution === 'new' && beforeCheckpoint.fingerprint !== afterCheckpoint.fingerprint &&
    reviewRequests(checkpointAfterEdit).length === 2 && reviewRequests(checkpointAfterEdit).every(payload => !packetOf(payload).sourceReads),
  'a changed worktree invalidates the earlier source coordinates even for the same review goal')

  const crashFile = path.join(workspace, 'origin.txt')
  const beforeCrashSource = await fs.readFile(crashFile, 'utf8')
  const crashSource = beforeCrashSource + '\n' + path.basename(temp) + '\n'
  await fs.writeFile(crashFile, crashSource)
  const liveSession = await snapshot()
  const liveSessionFile = (await command({ type: 'get_state' })).data.sessionFile
  const beforeCrash = requests.length
  reviewReplies = { correctness: [savedRead, { hold: true }], tests: [clean('tests')] }
  replies = [beginReview('Resume after the review process exits', 'live_checkpoint_plan'),
    requestReview({ check: 1, timeout: 30 }, 'crashed_review')]
  assert.equal((await command({ type: 'prompt', message: 'Begin a review that will be interrupted while running' })).ok, true)
  await until(snapshot, state => state.events.some(entry => entry.seq > liveSession.eventSeq &&
    entry.record.toolCallId === 'crashed_review' && entry.record.partialResult?.details?.reviewProgress?.completed === 1) &&
    requests.slice(beforeCrash).filter(payload => laneOf(payload) === 'correctness').length === 2,
  'one returned reviewer and an in-flight request after the other reviewer read the source')
  const liveEntries = (await fs.readFile(liveSessionFile, 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line))
  const liveCheckpoints = liveEntries.filter(entry => entry.type === 'custom' && entry.customType === 'superpi-review-checkpoint')
  check(liveCheckpoints.some(entry => entry.data.focus === 'correctness' && entry.data.range?.path === savedPath &&
    entry.data.range.start === 1 && entry.data.range.end === 1) &&
    liveCheckpoints.some(entry => entry.data.focus === 'tests' && entry.data.report?.status === 'complete') &&
    !JSON.stringify(liveCheckpoints).includes(savedLine) && !liveEntries.some(entry =>
      entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolCallId === 'crashed_review'),
  'the session file holds completed source coordinates and the other report while review_changes is still running')

  assert(Number.isInteger(liveSession.pid) && liveSession.pid > 0 && liveSession.pid !== process.pid, 'terminate only the spawned fixture subprocess')
  process.kill(liveSession.pid, 'SIGKILL')
  await until(() => request('/state'), state => !state.sessions.some(item => item.id === liveSession.id), 'the fixture subprocess to exit')
  const snapshotParent = await fs.realpath(os.tmpdir())
  for (const entry of await fs.readdir(snapshotParent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('superpi-verify-')) continue
    const target = path.join(snapshotParent, entry.name)
    if (await fs.readFile(path.join(target, 'origin.txt'), 'utf8').catch(() => '') !== crashSource) continue
    assert.equal(await fs.realpath(target), target, 'the owned fixture snapshot is inside the temporary directory')
    await fs.rm(target, { recursive: true })
  }
  sessionId = (await request('/sessions', {})).session.id
  assert.equal((await command({ type: 'switch_session', sessionPath: liveSessionFile })).ok, true)
  reviewReplies = { correctness: [payload => exactRestoredRead(payload) ? resumedReport : savedRead, resumedReport], tests: [clean('tests')] }
  const afterCrash = await run('continue the review stopped by a process exit', [
    requestReview({ check: 1 }, 'review_after_crash'), useTool('task_progress', { action: 'finish' }, 'finish_after_crash'),
    { delta: 'The continued review completed.' },
  ])
  const crashCalls = reviewRequests(afterCrash)
  const crashProof = toolResult(afterCrash, 'review_after_crash')?.details?.review
  await fs.writeFile(crashFile, beforeCrashSource)
  check(crashCalls.length === 1 && laneOf(crashCalls[0]) === 'correctness' && exactRestoredRead(crashCalls[0]) &&
    crashProof?.execution === 'resumed' && crashProof.reused.join(',') === 'tests' &&
    toolResult(afterCrash, 'review_after_crash')?.content.some(block => block.text.includes('Source excerpts restored · 1')) &&
    toolResult(afterCrash, 'finish_after_crash')?.details?.task?.status === 'complete',
  'a new subprocess restores evidence before its first model request and reuses the report from the exited reviewer')

  reviewReplies = Object.fromEntries(['correctness', 'tests'].map(focus => [focus, [
    { delta: 'First ' + focus + ' attempt without a report.' }, { delta: 'Second ' + focus + ' attempt without a report.' },
  ]]))
  const repeatedInMixedBatch = requestReview({ check: 1, timeout: 9 }, 'stuck_with_read')
  const validRead = toolCall('read', { path: 'origin.txt' }, 'read_during_repetition').tool_calls[0]
  repeatedInMixedBatch.delta.tool_calls.push({ ...validRead, index: 1 })
  const exhausted = await run('settle a review that repeats against unchanged source', [
    beginReview('Bound repeated incomplete reviews', 'stuck_plan'),
    requestReview({ check: 1 }, 'stuck_first'),
    requestReview({ check: 1, paths: ['origin.txt', 'review-new.txt'], timeout: 7 }, 'stuck_second'),
    requestReview({ check: 1, timeout: 8 }, 'stuck_reuse'),
    repeatedInMixedBatch,
    requestReview({ check: 1, timeout: 9 }, 'stuck_repeat'),
    { delta: 'An extra parent response should not be needed.' },
  ])
  const repeated = toolResult(exhausted, 'stuck_repeat')
  const finalTask = (await command({ type: 'get_entries' })).data.entries
    .findLast(entry => entry.type === 'custom' && entry.customType === 'superpi-task')?.data
  check(reviewRequests(exhausted).length === 4 && toolResult(exhausted, 'stuck_reuse')?.details?.review?.execution === 'reused' &&
    repeated?.details?.review?.execution === 'reused', 'the same snapshot spends only two attempts on the missing reviewers')
  check(toolResult(exhausted, 'stuck_with_read')?.details?.review?.repeated === true &&
    toolResult(exhausted, 'read_during_repetition')?.content[0]?.text.includes('Edit after the reviewers started'),
  'a repetitive review does not suppress other useful work in the same tool batch')
  check(exhausted.records.filter(record => record.type === 'agent_settled').length === 1 &&
    exhausted.requests.length === 10 && finalTask?.status === 'blocked' && /review/i.test(finalTask.blocker ?? '') &&
    !finalTask.checks[0].evidence, 'a repeated no-progress review settles with the exact unmet check on the session branch')

  await fs.writeFile(path.join(workspace, 'origin.txt'), 'New working bytes after pausing the review.\n')
  reviewReplies = { correctness: [clean('correctness')], tests: [clean('tests')] }
  const repaired = await run('resume after the working source changed', [
    useTool('task_progress', { action: 'resume' }, 'resume_changed_review'),
    requestReview({ check: 1 }, 'review_new_bytes'),
    useTool('task_progress', { action: 'finish' }, 'finish_new_review'),
    { delta: 'The revised source is verified.' },
  ])
  check(reviewRequests(repaired).map(laneOf).sort().join(',') === 'correctness,tests' &&
    toolResult(repaired, 'review_new_bytes')?.details?.review?.fingerprint !== repeated?.details?.review?.fingerprint &&
    toolResult(repaired, 'finish_new_review')?.details?.task?.status === 'complete',
  'new source clears the repeat barrier and earns fresh independent proof')

  await request(session(), undefined, 'DELETE')
  sessionId = undefined
  await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({
    compaction: { enabled: false }, retry: { enabled: false }, lastChangelogVersion: '1.5.2',
  }))
  sessionId = (await request('/sessions', {})).session.id
  const retryOff = await run('report the interruption with native retry disabled', [{ delta: 'Incomplete', streamError: earlyClose }])
  check(retryOff.requests.length === 1 && lastAssistant(retryOff)?.verdict?.kind === 'stream-interrupted',
    'the recovery respects the native retry switch and still reports the interruption')
  reviewReplies = { correctness: [resumeSource, lostReport], tests: [clean('tests')] }
  const reviewRetryOff = await run('leave reviewer stream recovery off when native retry is disabled', [
    requestReview({ paths: ['origin.txt'] }, 'review_transport_off'), { delta: 'Independent review is still partial.' },
  ])
  const offProof = toolResult(reviewRetryOff, 'review_transport_off')?.details?.review
  check(offProof?.status === 'partial' && offProof.newRequests === 3 && offProof.reviewers.some(reviewer =>
    reviewer.focus === 'correctness' && reviewer.failure === 'stream-interrupted' && !reviewer.recovery),
    'the independent reviewer respects the session retry setting even after acquiring source evidence')

  await request(session(), undefined, 'DELETE')
  sessionId = undefined
  const compact = path.join(temp, 'compact-source')
  await fs.mkdir(compact)
  const git = (...args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=Fixture',
    '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: compact })
  git('init', '--quiet')
  await fs.writeFile(path.join(compact, 'catalog.mjs'), 'export const lookup = () => "value"\n')
  await fs.writeFile(path.join(compact, 'public.test.mjs'), '// The existing public test expects 恒定结果.\n')
  await fs.writeFile(path.join(compact, 'package.json'), '{"type":"module"}\n')
  git('add', '.')
  git('commit', '--quiet', '-m', 'Compact review fixture')
  await fs.writeFile(path.join(compact, 'catalog.mjs'), 'export const lookup = () => undefined\n')
  sessionId = (await request('/sessions', { cwd: compact })).session.id
  const visibleTest = 'The existing public test expects 恒定结果.'
  const seedFinding = publish('The public result regressed.', [{ severity: 'blocking', path: 'catalog.mjs', line: 1,
    quote: 'lookup = () => undefined', problem: 'lookup returns undefined instead of its public value.' }], 'compact_defect')
  reviewReplies = { correctness: [publish('Incorrect reading of the current source.', [{ severity: 'blocking', path: 'catalog.mjs',
    line: 1, quote: 'return otherFields', problem: 'An old field overrides the return value.' }], 'imaginary_source'),
    seedFinding], tests: [clean('tests')] }
  const corrected = await run('ground a blocking claim in the exact current line', [
    requestReview({}, 'grounded_blocker'), { delta: 'The cited source was checked.' },
  ])
  const grounded = toolResult(corrected, 'grounded_blocker')?.details?.review
  check(reviewRequests(corrected).some(payload => requestText(payload).includes('does not match the captured source')) &&
    grounded?.status === 'findings' && grounded.reviewers.some(report => report.findings?.some(item =>
      item.quote === 'lookup = () => undefined')) && !JSON.stringify(grounded).includes('An old field overrides'),
  'an existing line number alone cannot make a fabricated source claim a blocking finding')
  reviewReplies = {
    correctness: [seedFinding],
    tests: [payload => requestText(payload).includes(visibleTest) ? clean('tests') :
      useTool('read_review_file', { path: 'public.test.mjs' }, 'read_instead_of_packet'), clean('tests')],
  }
  const ready = await run('review the compact workspace', [requestReview({}, 'compact_review'), { delta: 'Found and recorded the regression.' }])
  const readyProof = toolResult(ready, 'compact_review')?.details?.review
  const readyRequests = reviewRequests(ready)
  check(readyProof?.status === 'findings' && readyProof.reviewers.some(reviewer => reviewer.findings?.some(finding =>
    finding.path === 'catalog.mjs' && finding.line === 1 && finding.severity === 'blocking')),
  'a compact review still enforces exact source anchors and preserves the seeded blocking defect')
  check(readyRequests.length === 2 && readyProof?.newRequests === 2 && readyProof?.inputMode === 'snapshot' &&
    readyRequests.every(payload => requestText(payload).includes(visibleTest) && requestText(payload).includes('lookup = () => undefined') &&
      payload.tools?.map(tool => tool.function.name).join(',') === 'submit_review'),
  'both reviewers get complete changed and unchanged source on their first report request without another read round trip')
  check(readyRequests.every(payload => packetOf(payload).patch?.includes('@@ -1 +1 @@') &&
    packetOf(payload).patch.includes('-export const lookup = () => "value"')),
  'the first request retains exact Git hunk locations when the complete snapshot and diff fit together')

  reviewReplies = {
    correctness: [{ delta: 'I should check a specific line before submitting.' },
      useTool('read_review_file', { path: 'catalog.mjs', start: 1, count: 1 }, 'inspect_after_fast_attempt'),
      seedFinding],
    tests: [clean('tests')],
  }
  const fallback = await run('restore discovery when the first response has no report', [
    requestReview({}, 'compact_fallback'), { delta: 'The retry completed the structured review.' },
  ])
  const recoveryRequests = reviewRequests(fallback).filter(payload => laneOf(payload) === 'correctness')
  check(recoveryRequests.length === 3 && !recoveryRequests[0].tools.some(tool => tool.function.name === 'read_review_file') &&
    recoveryRequests[1].tools.some(tool => tool.function.name === 'read_review_file') &&
    toolResult(fallback, 'compact_fallback')?.details?.review?.status === 'findings',
  'an ordinary response without a report restores discovery within the same deadline and keeps proof validation')

  reviewReplies = { correctness: [{ hold: true },
    useTool('read_review_file', { path: 'catalog.mjs', start: 1, count: 1 }, 'inspect_after_fast_timeout'), seedFinding],
  tests: [clean('tests')] }
  const slow = await run('keep discovery time after a stalled first request', [
    requestReview({ timeout: 4 }, 'compact_slow'), { delta: 'The independent reports returned.' },
  ])
  const slowProof = toolResult(slow, 'compact_slow')?.details?.review
  const slowCorrectness = reviewRequests(slow).filter(payload => laneOf(payload) === 'correctness')
  check(slowProof?.status === 'findings' && slowProof.newRequests === 4 &&
    slowProof.reviewers.find(reviewer => reviewer.focus === 'correctness')?.fallback === 'snapshot-timeout' &&
    reviewRequests(slow).filter(payload => laneOf(payload) === 'tests').length === 1 &&
    !requestText(slowCorrectness[1]).includes(visibleTest) && slowCorrectness[1].tools.some(tool => tool.function.name === 'read_review_file'),
  'a stalled compact request falls back to the lean diff without restarting the reviewer who already reported')

  reviewReplies = {
    correctness: [{ ...seedFinding, progress: Array(6).fill('Reviewing the supplied contract.\n') }, seedFinding],
    tests: [clean('tests')],
  }
  const streaming = await run('let a progressing compact review finish using its captured source', [
    requestReview({ timeout: 4 }, 'compact_streaming'), { delta: 'The original requests returned the independent reports.' },
  ])
  const streamingProof = toolResult(streaming, 'compact_streaming')?.details?.review
  check(streamingProof?.status === 'findings' && streamingProof.newRequests === 2 &&
    streamingProof.reviewers.every(reviewer => reviewer.status === 'complete' && !reviewer.fallback),
  'ongoing model output preserves the complete evidence request beyond its initial idle window')

  reviewReplies = {
    correctness: [{ ...seedFinding, progress: Array(9).fill('Reviewing another part of the contract.\n') }, { hold: true }],
    tests: [clean('tests')],
  }
  const limitedReview = await run('keep the total deadline even with recurring model output', [
    requestReview({ timeout: 2 }, 'compact_total_timeout'), { delta: 'The time-limited review retained the completed lane.' },
  ])
  const limitedProof = toolResult(limitedReview, 'compact_total_timeout')?.details?.review
  check(limitedProof?.status === 'timed_out' && limitedProof.newRequests === 2 && limitedProof.reviewers.some(reviewer =>
    reviewer.focus === 'tests' && reviewer.status === 'complete'),
  'continuous progress still stops at the shared deadline and retains the other report')

  reviewReplies = { correctness: [{ delta: 'Interrupted review', streamError: earlyClose }, seedFinding], tests: [clean('tests')] }
  const gateway = await run('restore discovery after a known compact stream failure', [
    requestReview({}, 'compact_dropped'), { delta: 'Discovery recovered the blocking finding.' },
  ])
  check(toolResult(gateway, 'compact_dropped')?.details?.review?.status === 'findings' &&
    toolResult(gateway, 'compact_dropped')?.details?.review?.reviewers.find(reviewer => reviewer.focus === 'correctness')?.fallback === 'stream-interrupted',
  'a recognized stream failure during the first attempt changes evidence strategy inside the same review')

  reviewReplies = { correctness: [useTool('submit_review', {
    summary: 'The caller path is still unresolved.', findings: [],
    gaps: [{ path: 'catalog.mjs', reason: 'The expected lookup value could not be identified from the supplied contract.' }],
  }, 'concrete_gap')], tests: [clean('tests')] }
  const gap = await run('report concrete remaining evidence', [requestReview({}, 'compact_gap'), { delta: 'The review still has a gap.' }])
  const gapProof = toolResult(gap, 'compact_gap')?.details?.review
  check(gapProof?.status === 'partial' && gapProof.reviewers.some(reviewer => reviewer.status === 'incomplete' &&
    reviewer.gaps?.[0].path === 'catalog.mjs' && reviewer.limitation.includes('expected lookup value')),
  'only anchored material gaps in the compact report keep the verdict partial')

  reviewReplies = { correctness: [useTool('submit_review', {
    summary: 'Lookup returned an invalid value. Test coverage needs more analysis.', gaps: [{ path: 'public.test.mjs', reason: 'Audit the unchanged expectations.' }],
    findings: [{ severity: 'blocking', path: 'catalog.mjs', line: 1, quote: 'lookup = () => undefined', problem: 'Lookup returned undefined instead of the required value.' }],
  }, 'blocking_and_gap')], tests: [clean('tests')] }
  const blocker = await run('show a blocker even with pending coverage', [requestReview({}, 'compact_blocker'), { delta: 'The blocker and gap were recorded.' }])
  const blockerProof = toolResult(blocker, 'compact_blocker')?.details?.review
  check(blockerProof?.status === 'findings' && !blockerProof.recorded && blockerProof.pendingReviewers.includes('correctness') &&
    blockerProof.reviewers.some(reviewer => reviewer.findings?.some(finding => finding.path === 'catalog.mjs' && finding.line === 1)),
  'a verified source anchor can surface a blocker immediately while incomplete coverage remains explicit')

  const disputed = { severity: 'blocking', path: 'catalog.mjs', line: 1, quote: 'lookup = () => undefined',
    problem: 'lookup throws by calling a missing function.' }
  const openGap = { path: 'public.test.mjs', reason: 'Inspect the existing expectation before deciding the contract.' }
  const initialReport = useTool('submit_review', { summary: 'Contract needs follow-up.', findings: [disputed], gaps: [openGap] }, 'open_contract')
  const reviewTwice = async (goal, next, second = {}) => {
    reviewReplies = { correctness: [initialReport, ...next], tests: [clean('tests')] }
    return run(goal, [beginReview(goal, 'contract_plan'), requestReview({ check: 1 }, 'first_contract'),
      requestReview({ check: 1, ...second }, 'second_contract'), { delta: 'Review state recorded.' }, { delta: 'Review state recorded.' }])
  }
  const forgotten = await reviewTwice('Keep unresolved review evidence across two attempts', [clean('correctness')])
  const stillOpen = toolResult(forgotten, 'second_contract')?.details?.review
  const openItems = packetOf(reviewRequests(forgotten).filter(payload => laneOf(payload) === 'correctness').at(-1)).openItems
  check(openItems?.some(item => item.problem === disputed.problem) && openItems.some(item => item.reason === openGap.reason) &&
    stillOpen?.status === 'findings' && !stillOpen.recorded && stillOpen.reviewers.some(report =>
      report.findings?.some(item => item.problem === disputed.problem) && report.gaps?.some(item => item.reason === openGap.reason)),
  'a reviewer sees its previous unresolved findings and gaps and a generic clear report cannot erase either')

  const expired = await reviewTwice('Retain outstanding issues when resumed review times out', [{ hold: true }], { timeout: 1 })
  const expiredProof = toolResult(expired, 'second_contract')?.details?.review
  check(expiredProof?.status === 'timed_out' && expiredProof.newRequests === 1 && !expiredProof.recorded &&
    expiredProof.reviewers.some(report => report.focus === 'correctness' && report.status !== 'complete' &&
      report.findings?.some(item => item.problem === disputed.problem) && report.gaps?.some(item => item.reason === openGap.reason)),
  'a deadline before the next report preserves earlier blockers and open source questions in the returned and persisted result')

  const resolveIssues = (payload, quote) => useTool('submit_review', {
    summary: 'Checked each outstanding issue against the current contract.', findings: [],
    resolutions: (packetOf(payload).openItems ?? []).map(item => item.severity ?
      { item: item.id, reason: 'lookup returns the undefined literal without calling a function.',
        path: 'catalog.mjs', line: 1, quote: 'lookup = () => undefined' } :
      { item: item.id, reason: 'The public test states the expected behavior.', path: 'public.test.mjs', line: 1, quote }),
  }, 'resolve_issues')
  const resolved = await reviewTwice('Require matching source before closing each review issue', [
    payload => resolveIssues(payload, 'a fabricated source line'),
    payload => resolveIssues(payload, visibleTest),
  ])
  const resolvedProof = toolResult(resolved, 'second_contract')?.details?.review
  check(reviewRequests(resolved).some(payload => requestText(payload).includes('does not match the captured source')) &&
    resolvedProof?.status === 'clear' && resolvedProof.recorded && resolvedProof.newRequests === 2 &&
    resolvedProof.reviewers.some(report => report.resolutions?.length === 2),
  'a false counter-citation is rejected and a later grounded resolution of every issue can earn numbered review evidence')

  reviewReplies = { correctness: [useTool('submit_review', {
    summary: 'An outside file might be relevant.', findings: [],
    gaps: [{ path: '../uncaptured.mjs', reason: 'This is not a supplied source path.' }],
  }, 'fabricated_gap'), seedFinding], tests: [clean('tests')] }
  const rejectedGap = await run('refuse a gap outside the captured repository', [
    requestReview({}, 'compact_bad_gap'), { delta: 'The anchored findings are available.' },
  ])
  check(reviewRequests(rejectedGap).some(payload => requestText(payload).includes('Ground each remaining gap in a supplied path')) &&
    toolResult(rejectedGap, 'compact_bad_gap')?.details?.review?.status === 'findings',
  'an invented outside path cannot turn previously supplied evidence into an unresolved gap')

  const observeDiscovery = async (prompt, id, options = {}) => {
    reviewReplies = { correctness: [seedFinding], tests: [clean('tests')] }
    return run(prompt, [requestReview(options, id), { delta: 'Review recorded.' }])
  }
  const scopedPacket = await observeDiscovery('preserve explicit review scope', 'compact_scope', { paths: ['catalog.mjs'] })
  check(toolResult(scopedPacket, 'compact_scope')?.details?.review?.inputMode === 'diff' &&
    reviewRequests(scopedPacket).every(payload => payload.tools?.some(tool => tool.function.name === 'read_review_file') &&
      !requestText(payload).includes(visibleTest)), 'a limited review keeps its path scope and discovery')

  const wide = await command({ type: 'set_model', provider: 'loopback', modelId: 'fixture-wide' })
  assert.equal(wide.ok, true, 'set the wide-context reviewer')
  const oldCatalog = 'export const lookup = () => "value"\n'
  const changedCatalog = 'export const lookup = () => undefined\n' +
    Array.from({ length: 97 }, (_, n) => `// catalog choice ${n}: ${'中'.repeat(16)}\n`).join('')
  const newContract = '// The current repository contract\n' +
    Array.from({ length: 66 }, (_, n) => `// lookup case ${n}: ${'值'.repeat(14)}\n`).join('')
  await fs.writeFile(path.join(compact, 'catalog.mjs'), changedCatalog)
  await fs.writeFile(path.join(compact, 'contract.test.mjs'), newContract)
  const duplicatedPacket = { patch: git('diff', '--no-color', 'HEAD').toString('utf8'), newFiles: ['contract.test.mjs'],
    workspaceFiles: [changedCatalog, newContract, '// ' + visibleTest + '\n'] }
  const medium = await observeDiscovery('review complete before and after evidence once', 'medium_snapshot')
  const mediumProof = toolResult(medium, 'medium_snapshot')?.details?.review
  const sameEvidence = payload => {
    const packet = packetOf(payload)
    const sources = new Map(packet.workspaceFiles?.map(file => [file.path, file.source]))
    const changes = new Map(packet.changes?.map(file => [file.path, file.before]))
    return sources.get('catalog.mjs') === changedCatalog && sources.get('contract.test.mjs') === newContract &&
      sources.get('public.test.mjs') === '// ' + visibleTest + '\n' && changes.get('catalog.mjs') === oldCatalog &&
      changes.has('contract.test.mjs') && changes.get('contract.test.mjs') === null && changes.size === 2 &&
      Buffer.byteLength(JSON.stringify(packet)) <= 12_000 && !packet.patch &&
      payload.tools.map(tool => tool.function.name).join(',') === 'submit_review'
  }
  check(Buffer.byteLength(JSON.stringify(duplicatedPacket)) > 12_000 && mediumProof?.status === 'findings' &&
    mediumProof.inputMode === 'snapshot' && mediumProof.newRequests === 2 &&
    reviewRequests(medium).every(sameEvidence),
  'a medium change keeps exact before and after evidence and the seeded blocker within two report requests')

  reviewReplies = { correctness: [
    useTool('read_review_file', { path: 'contract.test.mjs', start: 1, count: 40 }, 'already_sent'),
    useTool('read_review_file', { path: 'catalog.mjs', start: 2, count: 30 }, 'first_source'),
    useTool('read_review_file', { path: 'catalog.mjs', start: 2, count: 30 }, 'repeat_source'),
    useTool('read_review_file', { path: 'catalog.mjs', start: 4, count: 1 }, 'numbered_source'), seedFinding,
  ], tests: [clean('tests')] }
  const repeatedReads = await run('retain every line and avoid repeating broad excerpts', [
    requestReview({ paths: ['catalog.mjs', 'contract.test.mjs'] }, 'dedupe_reads'), { delta: 'The blocker was recorded.' },
  ])
  const deduped = reviewRequests(repeatedReads).filter(payload => laneOf(payload) === 'correctness').at(-1)
  const readReplies = deduped.messages.filter(message => message.role === 'tool').map(message => String(message.content))
  check(toolResult(repeatedReads, 'dedupe_reads')?.details?.review?.status === 'findings' && readReplies.length === 4 &&
    readReplies[0].includes('initial newFiles') && !readReplies[0].includes('lookup case 2:') &&
    readReplies[1].includes('catalog choice 3:') && readReplies[2].includes('previous read result') &&
    !readReplies[2].includes('catalog choice 3:') && readReplies[3].startsWith('4\t// catalog choice 2:'),
  'large ranges already supplied use references, and first reads and precise line anchors retain source text')

  git('add', 'contract.test.mjs')
  const staged = await observeDiscovery('preserve exact evidence for a staged addition', 'medium_staged')
  const stagedProof = toolResult(staged, 'medium_staged')?.details?.review
  check(stagedProof?.status === 'findings' && stagedProof.inputMode === 'snapshot' && stagedProof.newRequests === 2 &&
    reviewRequests(staged).every(sameEvidence), 'a staged text addition has the same complete source and an absent base file')

  const extendedCatalog = changedCatalog + Array.from({ length: 75 }, (_, n) =>
    `// Another changed catalog branch ${n}: ${'文'.repeat(20)}\n`).join('')
  const extendedTest = '// ' + visibleTest + '\n// ' + 'unchanged test context '.repeat(25) + '\n'
  await fs.writeFile(path.join(compact, 'catalog.mjs'), extendedCatalog)
  await fs.writeFile(path.join(compact, 'public.test.mjs'), extendedTest)
  git('commit', '--quiet', '--only', '-m', 'Expand the unchanged test context', '--', 'public.test.mjs')
  const diffChoice = await observeDiscovery('measure the alternative evidence and tools', 'expanded_diff',
    { paths: ['catalog.mjs', 'contract.test.mjs'] })
  const hasSource = (payload, path, source) => packetOf(payload).workspaceFiles?.some(file => file.path === path && file.source === source)
  reviewReplies = {
    correctness: [payload => hasSource(payload, 'catalog.mjs', extendedCatalog) ? seedFinding :
      useTool('read_review_file', { path: 'catalog.mjs', count: 1 }, 'read_extended_catalog'), seedFinding],
    tests: [payload => hasSource(payload, 'public.test.mjs', extendedTest) ? clean('tests') :
      useTool('read_review_file', { path: 'public.test.mjs', count: 1 }, 'read_extended_tests'), clean('tests')],
  }
  const expanded = await run('use complete evidence when the alternative sends at least as much', [
    requestReview({}, 'expanded_snapshot'), { delta: 'Review recorded.' },
  ])
  const expandedProof = toolResult(expanded, 'expanded_snapshot')?.details?.review
  const diffRequest = reviewRequests(diffChoice)[0]
  const expandedRequest = reviewRequests(expanded)[0]
  const evidenceBytes = payload => Buffer.byteLength(JSON.stringify(packetOf(payload)))
  const diffBytes = evidenceBytes(diffRequest)
  const diffTools = diffRequest.tools.filter(tool => tool.function.name !== 'submit_review').map(tool => tool.function)
  const compactBytes = evidenceBytes(expandedRequest)
  check(compactBytes > Math.max(12_000, diffBytes) && compactBytes <= diffBytes + Buffer.byteLength(JSON.stringify(diffTools)),
    'the complete evidence fits specifically because discovery definitions are removed from the first request')
  check(expandedProof?.status === 'findings' && expandedProof.inputMode === 'snapshot' && expandedProof.newRequests === 2 &&
    reviewRequests(expanded).every(payload => hasSource(payload, 'catalog.mjs', extendedCatalog) &&
      hasSource(payload, 'public.test.mjs', extendedTest) && payload.tools.map(tool => tool.function.name).join(',') === 'submit_review'),
  'a large diff can fund complete first-request evidence beyond the default packet size without losing the blocker')

  const largeText = '// Unchanged file beyond the compact evidence budget.\n// ' + '\\'.repeat(7_000)
  await fs.writeFile(path.join(compact, 'large.mjs'), largeText)
  git('add', 'large.mjs')
  git('commit', '--quiet', '-m', 'Add a large unchanged source file')
  const largePacket = await observeDiscovery('preserve budget on unchanged source', 'compact_large')
  check(toolResult(largePacket, 'compact_large')?.details?.review?.inputMode === 'diff' &&
    reviewRequests(largePacket).every(payload => payload.model === 'fixture-wide' &&
      payload.tools?.some(tool => tool.function.name === 'list_review_files') &&
      !requestText(payload).includes(largeText.slice(0, 45))), 'a wide model still keeps an oversized serialized snapshot on incremental discovery')

  await fs.writeFile(path.join(compact, '.env'), 'TOKEN=fixture-unrelated-private-text\n')
  await fs.writeFile(path.join(compact, 'large.mjs'), '// The source fits in a compact snapshot again.\n')
  git('add', '.env', 'large.mjs')
  git('commit', '--quiet', '-m', 'Add an unchanged repository metadata file')
  const mixedPacket = await observeDiscovery('keep unrelated metadata out of an automatic packet', 'compact_mixed')
  check(toolResult(mixedPacket, 'compact_mixed')?.details?.review?.inputMode === 'diff' &&
    reviewRequests(mixedPacket).every(payload => !requestText(payload).includes('fixture-unrelated-private-text')),
  'automatic evidence bundling never transmits unrelated metadata in a mixed snapshot')

  await request(session(), undefined, 'DELETE')
  sessionId = undefined
  const completeSource = path.join(temp, 'complete-review-source')
  await fs.mkdir(completeSource)
  const evidenceGit = (...args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=Fixture',
    '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: completeSource })
  const contractDoc = '# Visible engineering contract\nThe lookup must return its existing value.\n'
  const existingCaller = 'export const originalValue = "kept"\n' + '// existing caller and checks\n'.repeat(167)
  const changedSource = 'export const lookup = () => undefined\n' + '// historical regression test data\n'.repeat(420)
  await Promise.all([
    fs.writeFile(path.join(completeSource, 'catalog.mjs'), 'export const lookup = () => "kept"\n'),
    fs.writeFile(path.join(completeSource, 'existing.test.mjs'), existingCaller),
    fs.writeFile(path.join(completeSource, 'README.md'), contractDoc),
  ])
  evidenceGit('init', '--quiet')
  evidenceGit('add', '.')
  evidenceGit('commit', '--quiet', '-m', 'Complete review fixture')
  await fs.writeFile(path.join(completeSource, 'catalog.mjs'), changedSource)
  await fs.writeFile(path.join(completeSource, 'acceptance.md'), '# Usage verification\nCover the existing caller.\n')
  sessionId = (await request('/sessions', { cwd: completeSource, continue: false })).session.id
  assert.equal((await command({ type: 'set_model', provider: 'loopback', modelId: 'fixture-wide' })).ok, true)

  const allEvidence = await observeDiscovery('use the whole reviewable snapshot in one request per reviewer', 'complete_evidence')
  const allProof = toolResult(allEvidence, 'complete_evidence')?.details?.review
  check(allProof?.inputMode === 'snapshot' && allProof.newRequests === 2 && allProof.status === 'findings' &&
    reviewRequests(allEvidence).every(payload => hasSource(payload, 'catalog.mjs', changedSource) &&
      hasSource(payload, 'existing.test.mjs', existingCaller) && hasSource(payload, 'README.md', contractDoc) &&
      payload.tools.map(tool => tool.function.name).join(',') === 'submit_review'),
  'a full review can up-front include a larger unchanged caller and the ordinary repository contract')

  const explicit = await observeDiscovery('review explicitly selected complete source', 'complete_scope',
    { paths: ['catalog.mjs', 'existing.test.mjs', 'acceptance.md'] })
  const explicitProof = toolResult(explicit, 'complete_scope')?.details?.review
  check(explicitProof?.inputMode === 'snapshot' && explicitProof.newRequests === 2 && explicitProof.uncoveredCount === 0 &&
    reviewRequests(explicit).every(payload => hasSource(payload, 'existing.test.mjs', existingCaller) &&
      requestText(payload).includes('Cover the existing caller.') && !requestText(payload).includes(contractDoc.trim()) &&
      payload.tools.map(tool => tool.function.name).join(',') === 'submit_review'),
  'complete explicitly scoped source and acceptance material can report immediately without sending an excluded README')
} finally {
  if (sessionId) await request(session(), undefined, 'DELETE').catch(() => {})
  for (const dispose of disposers.reverse()) dispose()
  for (const server of [host, provider]) {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
  await fs.rm(temp, { recursive: true, force: true })
}

for (const item of checks) if (!item.condition) console.error('FAIL: ' + item.label)
assert.equal(checks.filter(item => !item.condition).length, 0)
console.log(`PASS (${checks.length} checks)`)

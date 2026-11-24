/** Real host → pi JSONL → loopback OpenAI-compatible stream. No account or network service is needed. */
import assert from 'node:assert/strict'
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
  const reply = replies.shift()
  if (!reply) { res.writeHead(400).end('Unexpected provider request'); return }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  if (reply.hold) {
    res.write(chunk({ content: '等待' }, null))
    return
  }
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
    compaction: { enabled: false }, retry: { enabled: false }, lastChangelogVersion: '1.5.2',
  }))
  await listen(provider)
  await fs.writeFile(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { loopback: {
    baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', apiKey: 'fixture',
    models: ['fixture', 'replacement'].map(id => ({ id, contextWindow: 24000, maxTokens: 2048, input: ['text', 'image'] })),
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

  const healthy = await run('healthy', [{ delta: '中文，正常。', splitUtf8: true }])
  check(lastAssistant(healthy)?.message.content[0]?.text === '中文，正常。', 'valid UTF-8 survives a split network frame')
  check(healthy.requests.length === 1 && lastAssistant(healthy)?.verdict?.kind === 'none', 'valid short completion gets one provider request')
  check(JSON.stringify(healthy.requests[0].messages).includes('Report completion only for work actually done and verified'),
    'both modes inherit the same evidence-based completion guidance')

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

  const toolTurn = await run('write once', [{ delta: writeCall('once.txt', largeWrite), finish: 'tool_calls' }, { delta: 'invalid ' + bad }])
  check(await fs.readFile(path.join(workspace, 'once.txt'), 'utf8') === largeWrite, 'successful file contains every original character')
  check(toolTurn.requests.length === 2, 'tool activity does not start an automatic replay')
  check(toolTurn.records.filter(entry => entry.type === 'tool_execution_end').length === 1, 'write is executed only once')
  check(!requestText(toolTurn.requests.at(-1)).includes(largeWrite) && requestText(toolTurn.requests.at(-1)).includes('once.txt'),
    'completed write body is replaced by a file reference before the next request')
  check(toolTurn.records.some(entry => entry.type === 'entry_appended' && entry.entry?.type === 'context_edit' &&
    entry.entry.replacement?.content.some(block => block.arguments?._omitted === true)),
    'successful write projection is recorded in native session history')

  const corruptWrite = await run('reject damaged writes', [
    { delta: writeCall('bad-body.txt', '文件BAD_UTF8'), finish: 'tool_calls', badUtf8: true },
    { delta: writeCall('bad-' + bad + '.txt', 'clean', 'call_path'), finish: 'tool_calls' },
    { delta: 'Blocked.' },
  ])
  check(!(await fs.readdir(workspace)).some(name => name.startsWith('bad-')), 'bad content and paths never reach the filesystem')
  check(corruptWrite.records.filter(entry => entry.type === 'tool_execution_end' && entry.isError === true).length === 2,
    'both rejected writes produce actual tool errors in the panel')

  await fs.writeFile(guardPath, JSON.stringify({ autoRetryOnMalformed: false, autoRetryCooldownMs: 0 }))
  const disabled = await run('retry disabled explicitly', [{ delta: 'invalid ' + bad }])
  check(disabled.requests.length === 1, 'explicitly disabling retry takes effect without restarting pi')
  const stopped = await run('stop explicitly', [{ hold: true }], { abort: true })
  check(stopped.requests.length === 1 && stopped.records.at(-1)?.aborted === true, 'user stop does not resume the activity')

  // A valid 32×32 RGB PNG, generated for this fixture.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAGUlEQVR4nO3BMQEAAADCoPVP7WENoAAAAG4MIAABt9NlCQAAAABJRU5ErkJggg==', 'base64')
  const imageNames = Array.from({ length: 6 }, (_, index) => 'image-' + index + '.png')
  await Promise.all(imageNames.map(name => fs.writeFile(path.join(workspace, name), png)))
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

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { createAgentSession, SettingsManager, SessionManager } from '@earendil-works/pi-coding-agent'

const agentDir = '/tmp/profile'
const workspace = '/work'
const grader = '/opt/superpi/test/fixtures/engineering-cases.mjs'
const settings = SettingsManager.inMemory({
  defaultProvider: 'scripted', defaultModel: 'isolation', retry: { enabled: false },
})
await fs.mkdir(agentDir, { recursive: true })
await fs.writeFile(agentDir + '/models.json', JSON.stringify({
  providers: { scripted: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'offline',
    models: [{ id: 'isolation', name: 'Isolation probe' }] } },
}))
await fs.writeFile(workspace + '/public.txt', 'allowed fixture')
const { session } = await createAgentSession({ cwd: workspace, agentDir, settingsManager: settings,
  sessionManager: SessionManager.inMemory(), tools: ['read', 'write', 'bash'] })
const calls = [
  ['project read', 'read', { path: 'public.txt' }, false, 'allowed fixture'],
  ['project write', 'write', { path: 'created.txt', content: 'Pi wrote this' }, false],
  ['grader read', 'read', { path: grader }, true],
  ['runtime write', 'write', { path: '/opt/superpi/guard.txt', content: 'should never be created' }, true],
  ['project child', 'bash', { command: 'node -p "require(\'fs\').readFileSync(\'created.txt\', \'utf8\')"' }, false, 'Pi wrote this'],
  ['grader shell read', 'bash', { command: 'cat ' + grader }, true],
  ['runtime shell write', 'bash', { command: 'printf guard > /opt/superpi/guard.txt' }, true],
  ['grader child read', 'bash', { command: 'node -p "require(\'fs\').readFileSync(\'' + grader + '\', \'utf8\')"' }, true],
]
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
const results = new Map()
let turn = 0
session.agent.streamFunction = model => {
  const index = turn++
  const request = calls[index]
  const stopReason = request ? 'toolUse' : 'stop'
  const content = request ? { type: 'toolCall', name: request[1], arguments: request[2], id: 'probe-' + index } :
    { type: 'text', text: 'Isolation probe finished.' }
  const message = { role: 'assistant', content: [content], api: model.api, provider: model.provider, model: model.id,
    usage, stopReason, timestamp: Date.now() }
  return { async *[Symbol.asyncIterator]() { yield { type: 'done', reason: stopReason, message } }, async result() { return message } }
}
const unsubscribe = session.subscribe(event => {
  if (event.type === 'message_end' && event.message.role === 'toolResult') results.set(event.message.toolCallId, event.message)
})
try {
  await session.prompt('Check the local tool boundary.')
  assert.equal(results.size, calls.length)
  const tools = calls.map(([name, , , isError, expected], i) => {
    const result = results.get('probe-' + i)
    assert.equal(result?.isError, isError, name + ' must obey the isolation boundary')
    if (expected) assert.ok(result.content.some(item => item.type === 'text' && item.text.includes(expected)), name)
    return { name, result: isError ? 'denied' : 'allowed' }
  })
  assert.equal(process.getuid(), 1000)
  assert.deepEqual(Object.keys(networkInterfaces()), ['lo'])
  await assert.rejects(fs.lstat('/var/run/docker.sock'), { code: 'ENOENT' })
  console.log(JSON.stringify({ tools, uid: process.getuid(), network: Object.keys(networkInterfaces()), dockerSocket: false }))
} finally {
  unsubscribe()
  session.dispose()
}

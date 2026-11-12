/**
 * host 半区冒烟测试：不用 DSH，用桩 ctx 把 apply() 跑起来，直接打 HTTP 面。
 * 目的：在接进 DSH 之前先证明「spawn pi → prompt → 事件流」这条链路是通的。
 *
 * 跑法：node test/host-smoke.mjs
 */
import http from 'node:http'
import { apply } from '../index.js'

const effects = []
const logs = []
const ctx = {
  effect(fn, label) {
    const dispose = typeof fn === 'function' ? fn() : undefined
    effects.push({ label, dispose })
    return () => { if (typeof dispose === 'function') dispose() }
  },
  inject(names, run) {
    // 只满足 webServer 这一组；其它组合按「服务不存在」返回 undefined 属性。
    const services = {}
    for (const name of names) services[name] = name === 'webServer' ? fakeServer : undefined
    if (names.includes('webServer')) services.webServer = fakeServer
    run(services)
  },
  get(name) {
    if (name === 'logger') return { info: m => logs.push('INFO ' + m), warn: m => logs.push('WARN ' + m), error: m => logs.push('ERR ' + m), debug: () => {} }
    throw new Error('service not available: ' + name)
  },
}

let registered = null
const fakeServer = {
  register(route) { registered = route; return () => { registered = null } },
}

apply(ctx, { args: ['--no-session'] })

if (registered === null) { console.error('FAIL: 没有注册路由'); process.exit(1) }
const { path, handler } = registered
console.log('route path =', path)

// 起一个只转发到这个 handler 的真实 HTTP 服务，方便用 fetch 打。
const server = http.createServer((req, res) => { void handler(req, res) })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + server.address().port + path
console.log('base =', base)

const j = async (p, init) => {
  const res = await fetch(base + p, init)
  const text = await res.text()
  try { return { status: res.status, body: JSON.parse(text) } } catch { return { status: res.status, body: text.slice(0, 400) } }
}

const health = await j('/health')
console.log('health', health.status, JSON.stringify(health.body))

const state = await j('/state')
console.log('state.resolved', JSON.stringify(state.body.resolved))

const created = await j('/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) })
console.log('created', created.status, JSON.stringify(created.body).slice(0, 300))
const id = created.body?.session?.id
if (!id) { console.error('FAIL: 没拿到 session id'); process.exit(1) }

const gs = await j('/sessions/' + id + '/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'get_state' }) })
console.log('get_state', gs.status, JSON.stringify(gs.body).slice(0, 400))

const pr = await j('/sessions/' + id + '/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'prompt', message: '只说两个字：通了' }) })
console.log('prompt', pr.status, JSON.stringify(pr.body))

// 等 agent_settled（最多 60s），期间轮询 snapshot
const started = Date.now()
let settled = false
let lastSeq = 0
let sawText = ''
while (Date.now() - started < 60000) {
  const snap = await j('/sessions/' + id + '/snapshot?since=' + lastSeq)
  for (const entry of snap.body.events ?? []) {
    lastSeq = entry.seq
    const rec = entry.record
    if (rec.type === 'message_update' && rec.assistantMessageEvent?.type === 'text_delta') sawText += rec.assistantMessageEvent.delta
    if (rec.type === 'agent_settled') settled = true
  }
  if (settled) break
  await new Promise(r => setTimeout(r, 250))
}
console.log('settled =', settled, 'ms =', Date.now() - started)
console.log('text =', JSON.stringify(sawText.slice(0, 200)))

const del = await j('/sessions/' + id, { method: 'DELETE' })
console.log('delete', del.status, JSON.stringify(del.body))

console.log('--- logs ---')
console.log(logs.slice(0, 20).join('\n'))
server.close()
for (const e of effects) if (typeof e.dispose === 'function') e.dispose()
process.exit(settled && sawText !== '' ? 0 : 2)

/**
 * 冒烟测试骨架，host-smoke.mjs 与 packed-smoke.mjs 共用。
 *
 * 用法：import { runSmoke } from './_harness.mjs'
 *      const code = await runSmoke({ entry: new URL('../index.js', import.meta.url).href })
 *
 * 为什么需要它：host-smoke 测的是「当前源码目录」，packed-smoke 测的是「npm pack 出来
 * 再装到别处的产物」。两者必须跑同一套断言，否则「装出来能不能用」就没人证明。
 */
import http from 'node:http'

const log = message => console.log(message)

/** 桩 ctx：只满足 webServer，其余服务按不存在处理。 */
function fakeContext(logs) {
  const effects = []
  let registered = null
  const fakeServer = {
    register(route) {
      registered = route
      return () => { registered = null }
    },
  }
  const ctx = {
    effect(fn, label) {
      const dispose = typeof fn === 'function' ? fn() : undefined
      effects.push({ label, dispose })
      return () => { if (typeof dispose === 'function') dispose() }
    },
    inject(names, run) {
      const services = {}
      for (const name of names) services[name] = name === 'webServer' ? fakeServer : undefined
      services.webServer = fakeServer
      run(services)
    },
    get(name) {
      if (name === 'logger') {
        return {
          info: m => logs.push('INFO ' + m),
          warn: m => logs.push('WARN ' + m),
          error: m => logs.push('ERR ' + m),
          debug: () => {},
        }
      }
      throw new Error('service not available: ' + name)
    },
  }
  return { ctx, effects, server: () => registered }
}

/**
 * @param {{entry:string, prompt?:string, expectText?:string, timeoutMs?:number}} options
 * @returns {Promise<number>} 进程退出码（0 = 通过）
 */
export async function runSmoke(options = {}) {
  const entry = options.entry
  const prompt = typeof options.prompt === 'string' ? options.prompt : '只说两个字：通了'
  const expectText = typeof options.expectText === 'string' ? options.expectText : '通了'
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 60000

  log('entry = ' + entry)
  const mod = await import(entry)
  if (mod.name !== 'dsh-pi') { console.error('FAIL: 插件 name 应为 dsh-pi，实际 ' + String(mod.name)); return 1 }
  if (typeof mod.apply !== 'function') { console.error('FAIL: 插件没有导出 apply()'); return 1 }
  log('plugin = ' + mod.name + ' / inject = ' + JSON.stringify(mod.inject) + ' / Config = ' + (mod.Config === undefined ? 'undefined(兜底)' : 'present'))

  const logs = []
  const fake = fakeContext(logs)
  mod.apply(fake.ctx, { args: ['--no-session'] })
  const registered = fake.server()
  if (registered === null) { console.error('FAIL: 没有注册路由'); return 1 }
  log('route path = ' + registered.path)

  const httpServer = http.createServer((req, res) => { void registered.handler(req, res) })
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + httpServer.address().port + registered.path
  log('base = ' + base)

  const j = async (path, init) => {
    const res = await fetch(base + path, init)
    const text = await res.text()
    try { return { status: res.status, body: JSON.parse(text) } } catch { return { status: res.status, body: text.slice(0, 400) } }
  }
  const json = { 'content-type': 'application/json' }
  const post = (path, payload) => j(path, { method: 'POST', headers: json, body: JSON.stringify(payload) })

  let failures = 0
  const expect = (ok, message) => { if (!ok) { failures += 1; console.error('FAIL: ' + message) } }

  const health = await j('/health')
  log('health ' + health.status + ' ' + JSON.stringify(health.body))
  expect(health.status === 200 && health.body.ok === true, '/health 应 200 且 ok:true')

  const state = await j('/state')
  log('state.resolved ' + JSON.stringify(state.body.resolved))
  expect(state.body.runtime !== undefined, '/state 应带 runtime 报告')
  if (state.body.runtime?.ok !== true) {
    console.error('FAIL: 运行时未解析成功：' + JSON.stringify(state.body.runtime?.searched ?? []))
    failures += 1
  }

  const runtime = await j('/runtime')
  log('runtime ' + runtime.status + ' ' + JSON.stringify({ ok: runtime.body.ok, source: runtime.body.source, version: runtime.body.version }))
  expect(runtime.status === 200 && runtime.body.ok === true, '/runtime 应 200 且 ok:true')

  const diag = await j('/diagnostics')
  log('diagnostics ' + diag.status + ' ' + JSON.stringify({ plugin: diag.body.plugin?.id, ok: diag.body.runtime?.ok, hasSelfcheck: typeof diag.body.selfcheck === 'object' }))
  expect(diag.status === 200, '/diagnostics 应 200')
  expect(typeof diag.body.selfcheck === 'object', '/diagnostics 应包含 selfcheck')

  const created = await post('/sessions', {})
  log('created ' + created.status + ' ' + JSON.stringify(created.body).slice(0, 260))
  const id = created.body?.session?.id
  if (!id) { console.error('FAIL: 没拿到 session id'); failures += 1; httpServer.close(); return failures === 0 ? 0 : 2 }

  const one = await j('/sessions/' + id)
  log('GET /sessions/:id ' + one.status + ' ' + JSON.stringify({ id: one.body.id, state: one.body.state, hasEvents: Array.isArray(one.body.events) }))
  expect(one.status === 200 && one.body.id === id, 'GET /sessions/:id 应 200 并返回该会话')

  const missing = await j('/sessions/does-not-exist')
  log('GET /sessions/missing ' + missing.status)
  expect(missing.status === 404, '不存在的会话应 404')

  const gs = await post('/sessions/' + id + '/command', { type: 'get_state' })
  log('get_state ' + gs.status + ' ' + JSON.stringify(gs.body).slice(0, 320))
  expect(gs.body?.data?.model?.id !== undefined, 'get_state 应带 model')

  const badCmd = await post('/sessions/' + id + '/command', { message: 'no type' })
  log('command without type ' + badCmd.status)
  expect(badCmd.status === 400, '缺 type 的 command 应 400')

  const pr = await post('/sessions/' + id + '/command', { type: 'prompt', message: prompt })
  log('prompt ' + pr.status + ' ' + JSON.stringify(pr.body))
  expect(pr.status === 200, 'prompt 应 200')

  const started = Date.now()
  let settled = false
  let lastSeq = 0
  let sawText = ''
  while (Date.now() - started < timeoutMs) {
    const snap = await j('/sessions/' + id + '/snapshot?since=' + lastSeq)
    for (const entry of snap.body.events ?? []) {
      lastSeq = entry.seq
      const rec = entry.record
      if (rec.type === 'message_update' && rec.assistantMessageEvent?.type === 'text_delta') sawText += rec.assistantMessageEvent.delta
      if (rec.type === 'agent_settled') settled = true
    }
    if (settled) break
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  log('settled = ' + settled + ' ms = ' + String(Date.now() - started))
  log('text = ' + JSON.stringify(sawText.slice(0, 200)))
  expect(settled, '应在 ' + String(timeoutMs) + 'ms 内 agent_settled')
  expect(sawText.includes(expectText), '回复应包含 ' + JSON.stringify(expectText))

  const del = await j('/sessions/' + id, { method: 'DELETE' })
  log('delete ' + del.status + ' ' + JSON.stringify(del.body))
  expect(del.status === 200, 'DELETE 应 200')

  log('--- logs ---')
  log(logs.slice(0, 20).join('\n'))

  httpServer.close()
  for (const effect of fake.effects) if (typeof effect.dispose === 'function') effect.dispose()
  if (failures === 0) log('PASS')
  return failures === 0 ? 0 : 2
}

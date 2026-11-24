/**
 * host-parity —— host HTTP 面与 pi 命令行语义的离线一致性测试。
 *
 * 为什么要有这个文件：index.js 里的 buildSpawnArgs / 各条路由是「面板看到的世界」，
 * 它们错了不会崩，只会静默跑偏（例如把 --fork 与 --continue 拼在一起让 pi exit(1)、
 * 或者 reset 后 eventSeq 没归零让客户端丢事件）。这里全部用离线 stub 覆盖：
 * 不起 pi 进程、不打 LLM、不需要网络。
 *
 * 跑法：node test/host-parity.mjs
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)
// 契约版本从 package.json 读，避免每次升版号都要来这里手改一个字面量。
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
// Windows 下 Node 的 ESM loader 只接受 file:// URL，裸盘符路径会抛
// ERR_UNSUPPORTED_ESM_URL_SCHEME，必须过 pathToFileURL。
const mod = await import(pathToFileURL(path.join(root, 'index.js')).href)

let passed = 0
let failed = 0
const failures = []

function check(name, condition, detail) {
  if (condition) {
    passed += 1
    return
  }
  failed += 1
  failures.push(name + (detail === undefined ? '' : ' — ' + String(detail)))
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  check(name, a === e, 'expected ' + e + ' got ' + a)
}

// ── 1. asBool：配置值是字符串还是布尔都得认 ─────────────────────────────────
eq('asBool true', mod.asBool(true, false), true)
eq('asBool "false"', mod.asBool('false', true), false)
eq('asBool " TRUE "', mod.asBool(' TRUE ', false), true)
eq('asBool "0"', mod.asBool('0', true), false)
eq('asBool undefined', mod.asBool(undefined, true), true)
eq('asBool garbage', mod.asBool('maybe', false), false)

// ── 2. buildSpawnArgs：绝不拼出 pi 会 exit(1) 的组合 ────────────────────────
const args = (settings, options, extra) => mod.buildSpawnArgs({ settings, options, ...extra })

eq('default(new)', args({ startup: 'new' }), [])
eq('startup continue', args({ startup: 'continue' }), ['--continue'])
eq('persist=false', args({ persist: false, startup: 'continue' }), ['--no-session'])
eq('persist=false 不吃 resumePath', args({ persist: false }, { resumePath: 'a.jsonl' }), ['--no-session'])
eq('resumePath 优先于 continue', args({ startup: 'continue' }, { resumePath: 'C:/x/s.jsonl' }), ['--session', 'C:\\x\\s.jsonl'])
eq('continue=false 覆盖 startup', args({ startup: 'continue' }, { continue: false }), [])
eq('--name 去空白', args({ startup: 'new' }, { name: '  hello  ' }), ['--name', 'hello'])
eq('--name 空则不传', args({ startup: 'new', sessionName: '   ' }), [])
eq('settings.sessionName 兜底', args({ startup: 'new', sessionName: 'cfg' }), ['--name', 'cfg'])
eq('用户自带 --fork 时不生成会话选择', args({ startup: 'continue', args: ['--fork', 'abc'] }), ['--fork', 'abc'])
eq('用户自带 --no-session 时不重复', args({ startup: 'continue', args: ['--no-session'] }), ['--no-session'])
eq('--session=x 形态也算用户选择', args({ startup: 'continue', args: ['--session=x.jsonl'] }), ['--session=x.jsonl'])
eq('extraArgs 拆空格', args({ startup: 'new', extraArgs: '--model  x/y' }), ['--model', 'x/y'])
eq('options.extraArgs 覆盖 settings', args({ startup: 'new', extraArgs: '--a' }, { extraArgs: '--b 1' }), ['--b', '1'])
eq('options.args 追加在最后', args({ startup: 'new', args: ['--x'] }, { args: ['--y'] }), ['--x', '--y'])
eq('persist 字符串 false', args({ persist: 'false', startup: 'continue' }), ['--no-session'])
eq('persist 字符串 true', args({ persist: 'true', startup: 'continue' }), ['--continue'])
eq('resumePath 相对路径按 base 解析', args({ startup: 'continue' }, { resumePath: 'sub/s.jsonl' }, { base: 'C:/work' }), ['--session', 'C:\\work\\sub\\s.jsonl'])
eq('persist 参数覆盖 settings', args({ persist: true, startup: 'continue' }, { persist: false }), ['--no-session'])

// ── 2b. pickCurrentSessionFile：只有「同 cwd 且还活着」才能被标成 current ────
const pick = (running, target) => mod.pickCurrentSessionFile({ running, target })
eq('pick 无会话', pick([], 'C:/work'), null)
eq('pick 跨 cwd 不算 current', pick([{ cwd: 'C:/other', sessionFile: 'b.jsonl', state: 'ready' }], 'C:/work'), null)
eq('pick 同 cwd 命中', pick([{ cwd: 'C:/work', sessionFile: 'a.jsonl', state: 'ready' }], 'C:/work'), 'a.jsonl')
eq('pick 大小写不敏感', pick([{ cwd: 'c:\\WORK', sessionFile: 'a.jsonl', state: 'ready' }], 'C:/work'), 'a.jsonl')
eq('pick 优先活着的一个', pick([
  { cwd: 'C:/work', sessionFile: 'dead.jsonl', state: 'dead' },
  { cwd: 'C:/work', sessionFile: 'live.jsonl', state: 'ready' },
], 'C:/work'), 'live.jsonl')
eq('pick 全死掉退回第一个', pick([
  { cwd: 'C:/work', sessionFile: 'dead.jsonl', state: 'dead' },
  { cwd: 'C:/work', sessionFile: 'dead2.jsonl', state: 'dead' },
], 'C:/work'), 'dead.jsonl')
eq('pick 忽略无 sessionFile', pick([{ cwd: 'C:/work', sessionFile: null, state: 'ready' }], 'C:/work'), null)
eq('pick 忽略 --no-session 的空串', pick([{ cwd: 'C:/work', sessionFile: '', state: 'ready' }], 'C:/work'), null)

// ── 2c. withProjectIdentity：快照带项目标识（0.8.1，顶栏项目标题的数据源） ────
// 面板顶栏要显示当前项目名，靠的是快照里的 projectKey（与历史会话列表同一个 key）与
// displayPath（host 端 shortenHomePath 的产物）。这两件事都不能让浏览器自己算：
// 路径归一/大小写规则抄第二份就会与 groupSessionsByProject 分叉。
const identity = (cwd, snapshot) => mod.withProjectIdentity(snapshot, cwd)
const ident = identity('C:\\Users\\PC\\pi-workspace', { id: 's1', cwd: 'C:\\spawn-dir' })
check('withProjectIdentity 保留原快照字段', ident.id === 's1' && ident.cwd === 'C:\\spawn-dir')
check('withProjectIdentity 不因 projectCwd 改写 cwd', ident.cwd === 'C:\\spawn-dir')
check('displayPath 是 home 缩写的短路径', ident.displayPath === '~' + path.sep + 'pi-workspace', JSON.stringify(ident.displayPath))
check('projectKey 非空且是归一化后的绝对路径', typeof ident.projectKey === 'string' && ident.projectKey.length > 0 && path.isAbsolute(ident.projectKey), JSON.stringify(ident.projectKey))
eq('displayPath 空 cwd 回落空串', identity('', {}).displayPath, '')
eq('projectKey 空 cwd 回落空串', identity('', {}).projectKey, '')
eq('projectCwd 非字符串时不抛', identity(undefined, { id: 'x' }).displayPath, '')
check('快照为 null 时不抛', typeof identity('C:\\a', null).projectKey === 'string')
// 同一路径的两种写法必须给出同一个 key —— 否则重命名过的项目在顶栏与列表里对不上号。
eq('projectKey 大小写不敏感', identity('C:\\Work', {}).projectKey, identity('c:\\work', {}).projectKey)
eq('projectKey 分隔符归一', identity('C:/work', {}).projectKey, identity('C:\\work', {}).projectKey)
// ── 3. HTTP 面：stub 掉进程，只验证协议形状 ────────────────────────────────
function fakeProc(overrides = {}) {
  const proc = {
    id: 'sess-1',
    label: 'fake',
    cwd: 'C:/work',
    // 面板顶栏的项目标题取 sessionCwd（switch_session 之后 cwd 仍是 spawn 目录），
    // 所以假进程必须同时带这两个字段才能覆盖 withProjectIdentity 的真实取值路径。
    sessionCwd: 'C:/work',
    state: 'ready',
    exitInfo: null,
    eventSeq: 0,
    lastState: null,
    pendingUi: new Map(),
    sent: [],
    sentOptions: [],
    resetCount: 0,
    refreshCount: 0,
    nextData: undefined,
    nextError: null,
    snapshot() {
      return {
        id: this.id,
        label: this.label,
        cwd: this.cwd,
        sessionCwd: this.sessionCwd,
        state: this.state,
        eventSeq: this.eventSeq,
        events: [],
        pendingUi: [...this.pendingUi.values()],
      }
    },
    async send(command, options) {
      this.sent.push(command)
      this.sentOptions.push(options)
      if (this.nextError !== null) throw this.nextError
      return this.nextData
    },
    resetEvents() {
      this.resetCount += 1
      this.eventSeq = 0
      return { ok: true, eventSeq: 0 }
    },
    async refreshState() {
      this.refreshCount += 1
      return this.lastState
    },
    respond(payload) {
      this.responded = payload
      this.pendingUi.delete(payload.id)
      return { ok: true, id: payload.id, payload }
    },
    async close() {},
    ...overrides,
  }
  return proc
}

function makeServer(deps) {
  const handler = mod.createHandler({
    log: () => {},
    stateOf: () => ({ ok: true }),
    selfCheck: () => ({ ok: true }),
    runtimeReport: () => ({ ok: true }),
    refreshRuntime: () => {},
    installRuntime: async () => ({ ok: true }),
    detected: { packageDir: '' },
    sessionsDelete: () => {},
    requireSession: () => { const e = new Error('no such session'); e.statusCode = 404; throw e },
    spawnSession: () => { const e = new Error('spawnSession not stubbed'); throw e },
    listHistory: async () => ({ scope: 'all', cwd: '', agentDir: '', sessionDir: '', override: false, total: 0, projects: [], sessions: [], current: null }),
    workspacePath: () => os.tmpdir(),
    ...deps,
  })
  const server = http.createServer((req, res) => { void handler(req, res) })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const base = 'http://127.0.0.1:' + String(server.address().port) + '/api/superpi'
      resolve({ base, close: () => new Promise(done => server.close(done)) })
    })
  })
}

/** 不用 fetch：绕开本机的系统代理，也顺便验证裸 HTTP 形状。 */
function request(base, routePath, { method = 'GET', body, contentType = 'application/json' } = {}) {
  const target = new URL(base + routePath)
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method,
      headers: payload === null ? {} : { 'content-type': contentType, 'content-length': payload.length },
    }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed = text
        try { parsed = JSON.parse(text) } catch { /* 原样返回文本 */ }
        resolve({ status: res.statusCode, body: parsed })
      })
    })
    req.on('error', reject)
    if (payload !== null) req.write(payload)
    req.end()
  })
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'superpi-parity-'))
try {
  const proc = fakeProc()
  const calls = { history: [], spawn: [] }
  const server = await makeServer({
    requireSession: id => {
      if (id !== 'sess-1') { const e = new Error('no such session: ' + id); e.statusCode = 404; throw e }
      return proc
    },
    listHistory: async ({ scope, cwd, limit }) => {
      calls.history.push({ scope, cwd, limit })
      return { scope: scope === 'all' ? 'all' : 'project', cwd: 'C:/work', agentDir: 'C:/.pi', sessionDir: 'C:/.pi/sessions', override: false, total: 1, projects: [], sessions: [{ path: 'a.jsonl', name: null, messageCount: 2 }], current: 'a.jsonl' }
    },
    spawnSession: body => { calls.spawn.push(body); return proc },
  })
  try {
    // 3.1 /contract：原样序列化，字段一个不少
    const contract = await request(server.base, '/contract')
    check('contract 200', contract.status === 200, String(contract.status))
    eq('contract version', contract.body.version, PKG_VERSION)
    eq('contract piVersion', contract.body.piVersion, '1.5.2')
    eq('contract rpcCommands 33', contract.body.rpcCommands.length, 33)
    // 25 种出站事件 + response = 26，见 src/rpc-contract.mjs:76 的注释。
    eq('contract events 25', contract.body.events.length, 25)
    eq('contract assistantEvents 12', contract.body.assistantEvents.length, 12)
    eq('contract tuiCommands 27', contract.body.tuiCommands.length, 27)
    eq('contract bashShortcuts 2', contract.body.bashShortcuts.length, 2)
    eq('contract 首条命令字段原样', Object.keys(contract.body.rpcCommands[0]).sort(), ['category', 'name', 'optional', 'required'])
    eq('contract 首条事件字段原样', Object.keys(contract.body.events[0]).sort(), ['origin', 'type'])

    // 3.2 /sessions/history 必须优先于 /sessions/:id（否则 id='history' 会 404）
    const history = await request(server.base, '/sessions/history?limit=7&cwd=C%3A%2Fwork')
    check('history 200（没有被 /sessions/:id 吃掉）', history.status === 200, String(history.status) + ' ' + JSON.stringify(history.body).slice(0, 160))
    check('history ok', history.body.ok === true)
    eq('history sessions 透传', history.body.sessions, [{ path: 'a.jsonl', name: null, messageCount: 2 }])
    eq('history current', history.body.current, 'a.jsonl')
    eq('history 参数透传', calls.history.at(-1), { scope: '', cwd: 'C:/work', limit: 7 })
    // scope 缺省 = '' 交给 host 推断（有 cwd 视为 project，无 cwd 视为 all），兼容旧调用。
    const historyDefault = await request(server.base, '/sessions/history')
    eq('history limit 默认 20', calls.history.at(-1).limit, 20)
    eq('history 无参时 scope 缺省为空（由 host 推断 all）', calls.history.at(-1), { scope: '', cwd: '', limit: 20 })
    await request(server.base, '/sessions/history?scope=all')
    eq('history scope=all 透传', calls.history.at(-1), { scope: 'all', cwd: '', limit: 20 })
    await request(server.base, '/sessions/history?scope=project&cwd=C%3A%2Fwork')
    eq('history scope=project 透传', calls.history.at(-1), { scope: 'project', cwd: 'C:/work', limit: 20 })
    await request(server.base, '/sessions/history?scope=bogus&cwd=C%3A%2Fwork')
    eq('history 非法 scope 原样透传（host 层兜底为 project）', calls.history.at(-1).scope, 'bogus')
    check('history limit 上限 200', (await (async () => { await request(server.base, '/sessions/history?limit=9999'); return calls.history.at(-1).limit })()) === 200)
    check('history 非法 limit 回落 20', (await (async () => { await request(server.base, '/sessions/history?limit=abc'); return calls.history.at(-1).limit })()) === 20)

    // 3.3 未知会话 id 仍然 404（证明顺序修复没放宽别的东西）
    const missing = await request(server.base, '/sessions/nope/snapshot')
    eq('未知 session 404', missing.status, 404)

    // 3.3a 快照面必须带项目标识（0.8.1）：面板顶栏标题与历史会话列表靠 projectKey 对上号，
    //      host 少发一个字段，顶栏就静默回落成品牌名 —— 属于「不崩但错」的那类缺陷。
    const snapById = await request(server.base, '/sessions/sess-1')
    check('GET /sessions/:id 带 projectKey', typeof snapById.body.projectKey === 'string' && snapById.body.projectKey.length > 0, JSON.stringify(snapById.body).slice(0, 200))
    check('GET /sessions/:id 带 displayPath', typeof snapById.body.displayPath === 'string' && snapById.body.displayPath.length > 0, JSON.stringify(snapById.body.displayPath))
    eq('GET /sessions/:id 的 projectKey 用的是 sessionCwd', snapById.body.projectKey, identity(proc.sessionCwd, {}).projectKey)
    const snapRoute = await request(server.base, '/sessions/sess-1/snapshot?since=0')
    check('GET /snapshot 同样带项目标识', typeof snapRoute.body.projectKey === 'string' && snapRoute.body.projectKey.length > 0, JSON.stringify(snapRoute.body).slice(0, 200))
    const createdSnap = await request(server.base, '/sessions', { method: 'POST', body: {} })
    check('POST /sessions 的 session 快照带项目标识', createdSnap.body.session !== undefined && typeof createdSnap.body.session.projectKey === 'string' && createdSnap.body.session.projectKey.length > 0, createdSnap.status + ' ' + JSON.stringify(createdSnap.body).slice(0, 200))
    // 3.3b /command 的超时三态：缺省=默认上限，正数=毫秒上限，0/负/Infinity=不设上限。
    //        这条链最容易出错的地方是「0 被当成 falsy 吞成默认值」，那样面板发出的
    //        「对话类命令不设上限」会静默退化成 60s，弹窗还没点完命令就先超时。
    const cmdTimeout = async payload => {
      const res = await request(server.base, '/sessions/sess-1/command', { method: 'POST', body: { type: 'get_state', ...payload } })
      return { res, command: proc.sent.at(-1), options: proc.sentOptions.at(-1) }
    }
    eq('缺省 timeoutMs → 60000', (await cmdTimeout({})).options.timeoutMs, 60_000)
    eq('timeoutMs=0 → 0（不设上限，不被 falsy 吞掉）', (await cmdTimeout({ timeoutMs: 0 })).options.timeoutMs, 0)
    eq('timeoutMs=2500 → 2500', (await cmdTimeout({ timeoutMs: 2500 })).options.timeoutMs, 2500)
    eq('timeoutMs=负数 → 0（不设上限）', (await cmdTimeout({ timeoutMs: -1 })).options.timeoutMs, 0)
    eq('timeoutMs=null → 60000（JSON 显式 null 视同缺省）', (await cmdTimeout({ timeoutMs: null })).options.timeoutMs, 60_000)
    const stripped = await cmdTimeout({ timeoutMs: 0 })
    eq('timeoutMs 不进入 pi 的命令载荷', Object.prototype.hasOwnProperty.call(stripped.command, 'timeoutMs'), false)
    eq('命令其余字段原样保留', stripped.command.type, 'get_state')
    const sentBefore = proc.sent.length
    const badTimeout = await request(server.base, '/sessions/sess-1/command', { method: 'POST', body: { type: 'get_state', timeoutMs: 'abc' } })
    eq('timeoutMs=乱码 → 400（不静默降级）', badTimeout.status, 400)
    check('400 时命令没有发出去', proc.sent.length === sentBefore, String(proc.sent.length - sentBefore) + ' 条被发送')
    check('400 文案点名 timeoutMs', String(badTimeout.body.error).includes('timeoutMs') === true, String(badTimeout.body.error))

    // 3.4 /respond
    const respondUnknown = await request(server.base, '/sessions/sess-1/respond', { method: 'POST', body: { id: 'x', value: 'a' } })
    eq('respond 未知 id → 409', respondUnknown.status, 409)
    eq('respond 未知 id 文案', respondUnknown.body.error, 'no such request id')
    proc.pendingUi.set('req-7', { id: 'req-7', method: 'confirm', title: 't', receivedAt: 1 })
    const respondEmpty = await request(server.base, '/sessions/sess-1/respond', { method: 'POST', body: { id: 'req-7' } })
    eq('respond 三字段全缺 → 400', respondEmpty.status, 400)
    eq('respond 缺字段文案', respondEmpty.body.error, 'respond requires value, confirmed or cancelled')
    const respondOk = await request(server.base, '/sessions/sess-1/respond', { method: 'POST', body: { id: 'req-7', confirmed: true } })
    eq('respond 成功 200', respondOk.status, 200)
    eq('respond 成功体', respondOk.body, { ok: true })
    eq('respond id 原样透传', proc.responded.id, 'req-7')
    eq('respond 不回填多余字段', proc.responded, { id: 'req-7', confirmed: true })
    const respondNoJson = await request(server.base, '/sessions/sess-1/respond', { method: 'POST', body: { id: 'a' }, contentType: 'text/plain' })
    eq('respond 非 JSON → 415', respondNoJson.status, 415)

    // 3.5 `/sessions/:id/reset` 这条 HTTP 路由在 0.16.1 被删除。
    //
    // 为什么删：面板从未调用它（client.js 里 api.reset 只有定义、零调用），
    // 而 host 内部触发 resetEvents 走的是**另一条路径** —— 会话替换命令成功后
    // 在 command 处理里直接 proc.resetEvents?.()（见下一段 3.6）。
    // 一个没有任何消费者的公开路由等于把「协议面」开出一个假入口：
    // 它会被误当成公共 API、被误以为面板在用、也让「33 条命令 ↔ 面板入口」的对账失真。
    //
    // 这里断言它**确实没了**（回归守卫）：如果谁把它加回来，这条会红并提醒
    // 「先想清楚谁消费它」。
    const removedReset = await request(server.base, '/sessions/sess-1/reset', { method: 'POST', body: {} })
    eq('reset 路由已移除（0.16.1）', removedReset.status, 404)

    // 3.6 会话替换命令成功后自动 reset；失败/取消不 reset
    for (const type of ['new_session', 'switch_session', 'fork', 'clone']) {
      const before = proc.resetCount
      proc.nextData = { cancelled: false }
      const beforeRefresh = proc.refreshCount
      const res = await request(server.base, '/sessions/sess-1/command', { method: 'POST', body: { type } })
      eq(type + ' 200', res.status, 200)
      eq(type + ' 触发 reset', proc.resetCount, before + 1)
      // 新会话的 sessionFile 只有 get_state 拿得到，替换后必须补问一次。
      eq(type + ' 补问 get_state', proc.refreshCount, beforeRefresh + 1)
      eq(type + ' 响应原样透传', res.body, { ok: true, data: { cancelled: false } })
    }
    const beforePlain = proc.resetCount
    proc.nextData = { ok: true }
    await request(server.base, '/sessions/sess-1/command', { method: 'POST', body: { type: 'get_state' } })
    eq('普通命令不 reset', proc.resetCount, beforePlain)
    const beforeCancelledRefresh = proc.refreshCount
    proc.nextData = { cancelled: true }
    await request(server.base, '/sessions/sess-1/command', { method: 'POST', body: { type: 'fork' } })
    eq('取消的 fork 不 reset', proc.resetCount, beforePlain + 0 + (proc.nextData.cancelled === true ? 0 : 1))
    eq('取消的 fork 不补问 get_state', proc.refreshCount, beforeCancelledRefresh)
    const beforeFail = proc.resetCount
    proc.nextData = undefined
    proc.nextError = Object.assign(new Error('Cannot clone session: no current entry selected'), { statusCode: 400 })
    const failedCmd = await request(server.base, '/sessions/sess-1/command', { method: 'POST', body: { type: 'clone' } })
    eq('失败命令 → 400', failedCmd.status, 400)
    eq('失败命令不 reset', proc.resetCount, beforeFail)
    proc.nextError = null

    // 3.7 /files
    const dir = path.join(tmp, 'files')
    fs.mkdirSync(path.join(dir, 'zeta'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'Alpha'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'a.ts'), 'x')
    fs.writeFileSync(path.join(dir, 'B_File.TXT'), 'yy')
    fs.mkdirSync(path.join(dir, '.git'))
    fs.mkdirSync(path.join(dir, 'node_modules'))
    const files = await request(server.base, '/files?dir=' + encodeURIComponent(dir))
    check('files 200', files.status === 200, String(files.status) + ' ' + JSON.stringify(files.body).slice(0, 200))
    eq('files 规范化 dir', files.body.dir, dir)
    const names = files.body.entries.map(entry => entry.name)
    // 排序键是 ICU 排序而非字节序：'.git' 排在 'Alpha' 前面，'a.ts' 在 'B_File.TXT' 前（sensitivity: base）。
    eq('files 目录优先 + 组内升序', names, ['.git', 'Alpha', 'node_modules', 'zeta', 'a.ts', 'B_File.TXT'])
    eq('files 类型字段', files.body.entries.find(entry => entry.name === 'a.ts').type, 'file')
    eq('files 目录 size 为 null', files.body.entries.find(entry => entry.name === 'zeta').size, null)
    check('files 文件有 size', files.body.entries.find(entry => entry.name === 'B_File.TXT').size === 2)
    check('files 文件有 mtime', typeof files.body.entries.find(entry => entry.name === 'a.ts').mtime === 'string')
    eq('files 不递归（子目录内容不外泄）', names.includes('inner.txt'), false)
    const filtered = await request(server.base, '/files?dir=' + encodeURIComponent(dir) + '&query=file')
    eq('files query 大小写不敏感子串', filtered.body.entries.map(entry => entry.name), ['B_File.TXT'])
    const limited = await request(server.base, '/files?dir=' + encodeURIComponent(dir) + '&limit=2')
    eq('files limit 生效', limited.body.entries.length, 2)
    eq('files truncated', limited.body.truncated, true)
    const clamped = await request(server.base, '/files?dir=' + encodeURIComponent(dir) + '&limit=9999')
    eq('files limit 上限 200 不报错', clamped.status, 200)
    const missingDir = await request(server.base, '/files?dir=' + encodeURIComponent(path.join(tmp, 'nope')))
    eq('files 不存在 → 404', missingDir.status, 404)
    eq('files 不存在文案', missingDir.body.error, 'no such directory')
    fs.mkdirSync(path.join(tmp, 'ws'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'ws', 'rel.txt'), 'z')
    // 相对 dir 要相对 workspace 解析：单独起一台 workspace 指向 tmp 的 host 才测得到。
    const wsServer = await makeServer({ workspacePath: () => tmp })
    try {
      const rel = await request(wsServer.base, '/files?dir=ws&query=rel')
      eq('files 相对 dir 按 workspace 解析', rel.body.dir, path.join(tmp, 'ws'))
      eq('files 相对 dir 命中', rel.body.entries.map(entry => entry.name), ['rel.txt'])
      const noDir = await request(wsServer.base, '/files')
      eq('files 缺省 dir = workspace', noDir.body.dir, tmp)
    } finally {
      await wsServer.close()
    }

    // 3.7b /file（面板内预览：只读、限长、二进制不内联）
    //
    // 为什么单独一段：这条路由是「助手回复里点一个文件标签」的唯一后端，
    // 它的三类返回（text / image / binary）直接决定面板渲染哪一支，
    // 一旦 kind 判错，面板会把二进制涂成乱码或把 markdown 当纯文本。
    const fileDir = path.join(tmp, 'preview')
    fs.mkdirSync(fileDir, { recursive: true })
    fs.writeFileSync(path.join(fileDir, 'note.md'), '# 标题\n\n正文一行\n')
    fs.writeFileSync(path.join(fileDir, 'data.json'), '{"a":1}')
    fs.writeFileSync(path.join(fileDir, 'blob.bin'), Buffer.from([1, 2, 0, 4, 5]))
    // 1x1 PNG（最小合法图）：验证图片走 base64 data URL 而不是被当二进制。
    const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
    fs.writeFileSync(path.join(fileDir, 'pixel.png'), tinyPng)
    const bigText = 'x'.repeat(512 * 1024 + 64)
    fs.writeFileSync(path.join(fileDir, 'big.log'), bigText)

    const mdFile = await request(server.base, '/file?path=' + encodeURIComponent(path.join(fileDir, 'note.md')))
    check('file text 200', mdFile.status === 200, String(mdFile.status) + ' ' + JSON.stringify(mdFile.body).slice(0, 200))
    eq('file text kind', mdFile.body.kind, 'text')
    eq('file text 内容原样', mdFile.body.text, '# 标题\n\n正文一行\n')
    eq('file text markdown mime', mdFile.body.mimeType, 'text/markdown')
    eq('file text name', mdFile.body.name, 'note.md')
    eq('file text dir', mdFile.body.dir, fileDir)
    eq('file text size', mdFile.body.size, Buffer.byteLength('# 标题\n\n正文一行\n'))
    check('file text truncated=false', mdFile.body.truncated === false)
    check('file text mtime 是 ISO', typeof mdFile.body.mtime === 'string' && mdFile.body.mtime.includes('T'))

    const jsonFile = await request(server.base, '/file?path=' + encodeURIComponent(path.join(fileDir, 'data.json')))
    eq('file json mime', jsonFile.body.mimeType, 'application/json')
    const noExt = path.join(fileDir, 'LICENSE')
    fs.writeFileSync(noExt, 'plain')
    const plainFile = await request(server.base, '/file?path=' + encodeURIComponent(noExt))
    eq('file 未知扩展回落 text/plain', plainFile.body.mimeType, 'text/plain')

    const pngFile = await request(server.base, '/file?path=' + encodeURIComponent(path.join(fileDir, 'pixel.png')))
    eq('file image kind', pngFile.body.kind, 'image')
    eq('file image mime', pngFile.body.mimeType, 'image/png')
    eq('file image base64 往返一致', Buffer.from(String(pngFile.body.data), 'base64').equals(tinyPng), true)

    const binFile = await request(server.base, '/file?path=' + encodeURIComponent(path.join(fileDir, 'blob.bin')))
    eq('file binary kind（含 NUL 不内联）', binFile.body.kind, 'binary')
    eq('file binary 不带 text', binFile.body.text, undefined)
    eq('file binary 不带 data', binFile.body.data, undefined)
    eq('file binary mime', binFile.body.mimeType, 'application/octet-stream')

    const bigFile = await request(server.base, '/file?path=' + encodeURIComponent(path.join(fileDir, 'big.log')))
    eq('file 超限 truncated', bigFile.body.truncated, true)
    eq('file 超限截到 512KiB', bigFile.body.text.length, 512 * 1024)
    eq('file 超限仍回真实 size', bigFile.body.size, bigText.length)

    const missingFile = await request(server.base, '/file?path=' + encodeURIComponent(path.join(fileDir, 'nope.md')))
    eq('file 不存在 → 404', missingFile.status, 404)
    eq('file 不存在文案', missingFile.body.error, 'no such file')
    const dirAsFile = await request(server.base, '/file?path=' + encodeURIComponent(fileDir))
    eq('file 目录 → 400', dirAsFile.status, 400)
    eq('file 目录文案', dirAsFile.body.error, 'not a file')
    const noPath = await request(server.base, '/file')
    eq('file 缺 path → 400', noPath.status, 400)
    eq('file 缺 path 文案', noPath.body.error, 'path required')

    // 相对路径与 ~ 都按 workspace 解析：与 /files 的 dir 同一套规则。
    const relFileServer = await makeServer({ workspacePath: () => tmp })
    try {
      const relFile = await request(relFileServer.base, '/file?path=preview/note.md')
      eq('file 相对路径按 workspace 解析', relFile.body.path, path.join(fileDir, 'note.md'))
    } finally {
      await relFileServer.close()
    }

    // 3.7c /reveal（助手回复里文件标签的右键 → 在资源管理器里定位）
    //
    // 为什么单独测：这条路的默认实现会真的弹出资源管理器窗口，测试必须能注入
    // deps.revealPath 换成桩；同时 404 / 400 两条失败路径也要断言 —— 静默失败
    // 会让用户以为右键坏了，那正是这类「副作用型接口」最典型的回归。
    const revealCalls = []
    const revealServer = await makeServer({ revealPath: async target => { revealCalls.push(target) } })
    try {
      const revealed = await request(revealServer.base, '/reveal', { method: 'POST', body: { path: path.join(fileDir, 'note.md') } })
      eq('reveal 200', revealed.status, 200)
      eq('reveal ok', revealed.body.ok, true)
      eq('reveal 回解析后的绝对路径', revealed.body.path, path.join(fileDir, 'note.md'))
      eq('reveal 真的调了注入的实现', revealCalls.length, 1)
      eq('reveal 传给实现的是绝对路径', revealCalls[0], path.join(fileDir, 'note.md'))

      const noRevealPath = await request(revealServer.base, '/reveal', { method: 'POST', body: {} })
      eq('reveal 缺 path → 400', noRevealPath.status, 400)
      eq('reveal 缺 path 文案', noRevealPath.body.error, 'path required')

      const notFoundServer = await makeServer({ revealPath: async () => { const e = new Error('spawn ENOENT'); e.code = 'ENOENT'; throw e } })
      try {
        const notFound = await request(notFoundServer.base, '/reveal', { method: 'POST', body: { path: path.join(fileDir, 'nope.md') } })
        eq('reveal 目标不存在 → 404', notFound.status, 404)
        eq('reveal 不存在文案', notFound.body.error, 'no such file')
      } finally {
        await notFoundServer.close()
      }

      // 相对路径按 workspace 解析：与 /files、/file 同一套规则。
      const relRevealCalls = []
      const relRevealServer = await makeServer({ workspacePath: () => tmp, revealPath: async target => { relRevealCalls.push(target) } })
      try {
        const relReveal = await request(relRevealServer.base, '/reveal', { method: 'POST', body: { path: 'preview/note.md' } })
        eq('reveal 相对路径按 workspace 解析', relReveal.body.path, path.join(fileDir, 'note.md'))
      } finally {
        await relRevealServer.close()
      }
    } finally {
      await revealServer.close()
    }
    // 3.8 /directories（工作目录选择抽屉：只列子目录 + parent + writable）
    const dirsRoot = path.join(tmp, 'dirs')
    fs.mkdirSync(path.join(dirsRoot, 'zeta'), { recursive: true })
    fs.mkdirSync(path.join(dirsRoot, 'Alpha'), { recursive: true })
    fs.writeFileSync(path.join(dirsRoot, 'a.txt'), 'x')
    // 目录形符号链接（Windows 下 junction 不需要管理员权限）。创建不了就跳过断言。
    const linkTarget = path.join(tmp, 'link-target')
    fs.mkdirSync(linkTarget, { recursive: true })
    let madeLink = false
    try {
      fs.symlinkSync(linkTarget, path.join(dirsRoot, 'link-to-elsewhere'), 'junction')
      madeLink = true
    } catch { /* 权限不足：跳过后面的符号链接断言 */ }
    const dirs = await request(server.base, '/directories?dir=' + encodeURIComponent(dirsRoot))
    check('directories 200', dirs.status === 200, String(dirs.status) + ' ' + JSON.stringify(dirs.body).slice(0, 200))
    // 顺序门禁：'directories' 若被 /^\/sessions\/([^/]+)/ 吃掉，requireSession 会抛 404。
    check('directories 没被 /sessions/:id 吃掉', dirs.body.ok === true && dirs.body.error === undefined, JSON.stringify(dirs.body).slice(0, 160))
    eq('directories 规范化 dir', dirs.body.dir, dirsRoot)
    eq('directories 只回子目录（文件与链接都被滤掉）', dirs.body.entries.map(entry => entry.name), ['Alpha', 'zeta'])
    if (madeLink) {
      check('directories 跳过符号链接', dirs.body.entries.every(entry => entry.name !== 'link-to-elsewhere'))
    } else {
      console.log('  · 跳过符号链接断言（本机无法创建 junction）')
    }
    eq('directories 条目绝对路径', dirs.body.entries.find(entry => entry.name === 'Alpha').path, path.join(dirsRoot, 'Alpha'))
    eq('directories 条目只有 name 与 path', Object.keys(dirs.body.entries[0]).sort(), ['name', 'path'])
    eq('directories parent', dirs.body.parent, tmp)
    // writable 是给面板的提示，不是准入条件：不可写也必须能浏览（这里只钉住类型与肯定分支；
    // 在 Windows 上伪造不可写要改 ACL，会把临时目录锁住、清理不干净，故不做负例）。
    eq('directories writable', dirs.body.writable, true)
    eq('directories writable 是布尔', typeof dirs.body.writable, 'boolean')
    // dir 必须归一成反斜杠的绝对路径，否则面板拿它与 entry.path 比较时会判不相等。
    const slashDir = await request(server.base, '/directories?dir=' + encodeURIComponent(dirsRoot.split(path.sep).join('/') + '/'))
    eq('directories dir 归一化（正斜杠/尾斜杠）', slashDir.body.dir, dirsRoot)
    const slashFiles = await request(server.base, '/files?dir=' + encodeURIComponent(dirsRoot.split(path.sep).join('/') + '/'))
    eq('files dir 归一化（与 directories 一致）', slashFiles.body.dir, dirsRoot)
    eq('directories home 透传', dirs.body.home, os.homedir())
    eq('directories 不递归', dirs.body.entries.map(entry => entry.name).includes('inner'), false)
    const rootListing = await request(server.base, '/directories?dir=' + encodeURIComponent(path.parse(tmp).root))
    eq('directories 根目录 parent 为 null', rootListing.body.parent, null)
    const dirsHit = await request(server.base, '/directories?dir=' + encodeURIComponent(dirsRoot) + '&query=alp')
    eq('directories query 大小写不敏感子串', dirsHit.body.entries.map(entry => entry.name), ['Alpha'])
    const dirsMiss = await request(server.base, '/directories?dir=' + encodeURIComponent(dirsRoot) + '&query=nomatch-zzz')
    eq('directories query 不命中为空', dirsMiss.body.entries, [])
    const dirsLimited = await request(server.base, '/directories?dir=' + encodeURIComponent(dirsRoot) + '&limit=1')
    eq('directories limit 生效', dirsLimited.body.entries.length, 1)
    eq('directories truncated', dirsLimited.body.truncated, true)
    // clamp 要真的截到 200，而不只是「不报错」：造 205 个目录看一眼。
    const manyRoot = path.join(tmp, 'many')
    fs.mkdirSync(manyRoot, { recursive: true })
    for (let i = 0; i < 205; i += 1) fs.mkdirSync(path.join(manyRoot, 'd' + String(i).padStart(3, '0')))
    const clampedDirs = await request(server.base, '/directories?dir=' + encodeURIComponent(manyRoot) + '&limit=9999')
    eq('directories limit 上限 200（真截断）', clampedDirs.body.entries.length, 200)
    eq('directories limit 上限仍标 truncated', clampedDirs.body.truncated, true)
    const missingDirs = await request(server.base, '/directories?dir=' + encodeURIComponent(path.join(tmp, 'nope-dirs')))
    eq('directories 不存在 → 404', missingDirs.status, 404)
    eq('directories 不存在文案', missingDirs.body.error, 'no such directory')
    const fileAsDir = await request(server.base, '/directories?dir=' + encodeURIComponent(path.join(dirsRoot, 'a.txt')))
    eq('directories 传文件路径 → 404', fileAsDir.status, 404)
    const wsDirs = await makeServer({ workspacePath: () => tmp })
    try {
      const noDirDirs = await request(wsDirs.base, '/directories')
      eq('directories 缺省 dir = workspace', noDirDirs.body.dir, tmp)
      const relDirs = await request(wsDirs.base, '/directories?dir=dirs&query=alp')
      eq('directories 相对 dir 按 workspace 解析', relDirs.body.dir, dirsRoot)
      eq('directories 相对 dir 命中', relDirs.body.entries.map(entry => entry.name), ['Alpha'])
    } finally {
      await wsDirs.close()
    }
    // roots：面板「此电脑」层的数据源。没有它，从工作目录逐级往上只能走到当前盘的根，
    // 用户在别的盘（本机 C:/D:/E:/F:）上的工程永远选不到。
    check('directories 带 roots 字段', Array.isArray(dirs.body.roots), JSON.stringify(dirs.body.roots).slice(0, 160))
    check('directories roots 非空', dirs.body.roots.length > 0, JSON.stringify(dirs.body.roots))
    eq('directories roots 条目只有 name 与 path', Object.keys(dirs.body.roots[0]).sort(), ['name', 'path'])
    if (process.platform === 'win32') {
      check('directories roots 全是盘符', dirs.body.roots.every((root) => /^[A-Za-z]:$/.test(root.name)), JSON.stringify(dirs.body.roots))
      check('directories roots 路径带分隔符（路径比较才不会差一个字符）', dirs.body.roots.every((root) => root.path === root.name + path.sep), JSON.stringify(dirs.body.roots))
      check('directories roots 按盘符升序', dirs.body.roots.map((root) => root.name).join(',') === dirs.body.roots.map((root) => root.name).slice().sort().join(','), JSON.stringify(dirs.body.roots))
      // 当前盘的根一定在列表里 —— 缺了它，从工作目录往上跳会走进一条死路。
      const here = path.parse(tmp).root.replace(/[\\/]+$/, '')
      check('directories roots 含当前工作目录所在盘', dirs.body.roots.some((root) => root.name.toLowerCase() === here.toLowerCase()), here + ' / ' + JSON.stringify(dirs.body.roots))
      // 真实存在的盘符必须能列出来，且 dir 会被服务端归一成带尾分隔符的根。
      const firstRoot = dirs.body.roots[0]
      const rootBrowse = await request(server.base, '/directories?dir=' + encodeURIComponent(firstRoot.path) + '&limit=5')
      eq('roots 盘符可直接浏览（200）', rootBrowse.status, 200)
      eq('roots 盘符浏览 parent 为 null', rootBrowse.body.parent, null)
    } else {
      eq('directories roots 只有 /', dirs.body.roots, [{ name: '/', path: '/' }])
    }
    // 缓存：连打两次必须回同一份结果（插拔盘抖动不该让面板列表忽有忽无）。
    const rootsAgain = await request(server.base, '/directories?dir=' + encodeURIComponent(dirsRoot))
    eq('directories roots 稳定（10s 缓存）', rootsAgain.body.roots, dirs.body.roots)

    // 3.9 /changelog
    const pkg = path.join(tmp, 'pkg')
    fs.mkdirSync(path.join(pkg, 'dist', 'bundle'), { recursive: true })
    fs.writeFileSync(path.join(pkg, 'CHANGELOG.md'), '# changelog\n- 1.5.2\n')
    const clServer = await makeServer({ detected: { packageDir: path.join(pkg, 'dist', 'bundle') } })
    try {
      const changelog = await request(clServer.base, '/changelog')
      eq('changelog 200', changelog.status, 200)
      eq('changelog ok', changelog.body.ok, true)
      eq('changelog 路径', changelog.body.path, path.join(pkg, 'CHANGELOG.md'))
      eq('changelog 内容', changelog.body.text, '# changelog\n- 1.5.2\n')
      eq('changelog truncated', changelog.body.truncated, false)
      const legacyChangelog = await request(clServer.base, '/pi/changelog')
      eq('旧 changelog 地址仍返回 200', legacyChangelog.status, 200)
      eq('旧 changelog 地址返回同一份内容', legacyChangelog.body, changelog.body)
    } finally {
      await clServer.close()
    }
    const bigPkg = path.join(tmp, 'bigpkg')
    fs.mkdirSync(bigPkg, { recursive: true })
    fs.writeFileSync(path.join(bigPkg, 'CHANGELOG.md'), 'x'.repeat(200 * 1024 + 500))
    const bigServer = await makeServer({ detected: { packageDir: bigPkg } })
    try {
      const big = await request(bigServer.base, '/changelog')
      eq('changelog 截断标记', big.body.truncated, true)
      eq('changelog 截断长度', big.body.text.length, 200 * 1024)
    } finally {
      await bigServer.close()
    }
    const noneServer = await makeServer({ detected: { packageDir: path.join(tmp, 'no-such-pkg') } })
    try {
      const none = await request(noneServer.base, '/changelog')
      eq('changelog 找不到仍 200', none.status, 200)
      eq('changelog 找不到体', none.body, { ok: false, path: null, text: '', truncated: false })
    } finally {
      await noneServer.close()
    }

    // 3.10 POST /sessions 返回 session 快照（含 sessionFile 回填）
    proc.lastState = { sessionFile: 'C:/s.jsonl', sessionId: 'sid', sessionName: 'n' }
    proc.stateReady = Promise.resolve(proc.lastState)
    const created = await request(server.base, '/sessions', { method: 'POST', body: { cwd: 'C:/work' } })
    eq('POST /sessions 200', created.status, 200)
    eq('POST /sessions body 透传给 spawnSession', calls.spawn.at(-1), { cwd: 'C:/work' })
    check('POST /sessions 返回 session 对象', typeof created.body.session === 'object' && created.body.session !== null)

    // 3.11 上下文守卫的真实占用（只读观测面，0.12.0）
    // 面板的 `contextUsage` 来自 pi 的 usage，当前上游会把它算成 3.7%（真实 1.31M）。
    // 这一条钉住「另给一个可信数」：读守卫日志最后一行、可按会话过滤、读不到就 available:false。
    const guardFile = path.join(tmp, 'guard', 'context-guard.json')
    const guardLogFile = path.join(path.dirname(guardFile), 'context-guard.log.jsonl')
    const previousGuardEnv = process.env.SUPERPI_CONTEXT_GUARD
    process.env.SUPERPI_CONTEXT_GUARD = guardFile
    try {
      const noLog = await request(server.base, '/context')
      eq('context 无日志时 200', noLog.status, 200)
      eq('context 无日志 available=false', noLog.body.available, false)
      fs.mkdirSync(path.dirname(guardLogFile), { recursive: true })
      fs.writeFileSync(guardLogFile, [
        JSON.stringify({ at: 't1', sessionId: 's1', window: 1000, before: 900, after: 400, trimmed: true, imagesDropped: 3 }),
        JSON.stringify({ at: 't2', sessionId: 's2', window: 1000, before: 1900, after: 500, overBudget: true }),
      ].join('\n') + '\n', 'utf8')
      const latest = await request(server.base, '/context')
      eq('context 默认取最后一行', latest.body.sessionId, 's2')
      eq('context 透传 overBudget（诚实信号）', latest.body.overBudget, true)
      const bySession = await request(server.base, '/context?sessionId=s1')
      eq('context 按 sessionId 过滤', bySession.body.sessionId, 's1')
      eq('context 过滤后保留该会话字段', bySession.body.imagesDropped, 3)
      eq('context 未知 sessionId → available=false', (await request(server.base, '/context?sessionId=nope')).body.available, false)
      eq('context 用 POST → 404', (await request(server.base, '/context', { method: 'POST', body: {} })).status, 404)
    } finally {
      if (previousGuardEnv === undefined) delete process.env.SUPERPI_CONTEXT_GUARD
      else process.env.SUPERPI_CONTEXT_GUARD = previousGuardEnv
    }

    // 3.11b 模型模态开关（0.13.0）
    // 这条钉住「开关是真的」：GET 回状态与注册表，POST 改完后 GET 立刻反映；
    // 非法输入必须 400（运行时没有的模态、锁定的文本、缺 enabled 字段）。
    const modalityMod = await import(pathToFileURL(path.join(root, 'extensions', 'superpi-modalities.mjs')).href)
    const modalityFile = path.join(tmp, 'modalities', 'modalities.json')
    const modalityServer = await makeServer({ modalitiesStore: modalityMod.createModalitiesStore({ filePath: modalityFile }) })
    try {
      const initial = await request(modalityServer.base, '/modalities')
      eq('modalities GET 200', initial.status, 200)
      eq('modalities 初始无覆盖', initial.body.state.models, {})
      eq('modalities 注册表含运行时模态', initial.body.registry.runtime, ['text', 'image'])
      eq('modalities 注册表默认开启文本与图像', initial.body.registry.defaults, ['text', 'image'])
      eq('modalities 注册表锁定文本', initial.body.registry.locked, ['text'])

      const off = await request(modalityServer.base, '/modalities', {
        method: 'POST',
        body: { provider: 'odys-deepseek', id: 'Deepseek-V4.1-Flash', modality: 'image', enabled: false },
      })
      eq('modalities POST 关闭图像 200', off.status, 200)
      eq('modalities POST 落盘稀疏条目', off.body.state.models['odys-deepseek/Deepseek-V4.1-Flash'], { image: false })
      const reread = await request(modalityServer.base, '/modalities')
      eq('modalities 再读仍是关闭（真的写进去了）', reread.body.state.models['odys-deepseek/Deepseek-V4.1-Flash'], { image: false })

      const restored = await request(modalityServer.base, '/modalities', {
        method: 'POST',
        body: { provider: 'odys-deepseek', id: 'Deepseek-V4.1-Flash', modality: 'image', enabled: null },
      })
      eq('modalities enabled=null 恢复默认', restored.body.state.models, {})

      eq('modalities 缺 enabled → 400', (await request(modalityServer.base, '/modalities', {
        method: 'POST',
        body: { provider: 'p', id: 'i', modality: 'image' },
      })).status, 400)
      eq('modalities 运行时没有的模态 → 400', (await request(modalityServer.base, '/modalities', {
        method: 'POST',
        body: { provider: 'p', id: 'i', modality: 'audio', enabled: true },
      })).status, 400)
      eq('modalities 锁定文本 → 400', (await request(modalityServer.base, '/modalities', {
        method: 'POST',
        body: { provider: 'p', id: 'i', modality: 'text', enabled: false },
      })).status, 400)
      eq('modalities 缺 id → 400', (await request(modalityServer.base, '/modalities', {
        method: 'POST',
        body: { provider: 'p', modality: 'image', enabled: false },
      })).status, 400)
    } finally {
      await modalityServer.close()
    }

    // 3.12 面板偏好（项目重命名 / 会话置顶）
    // 这两件事都没有 pi 通道：set_session_name 改的是单个会话的 session_info，
    // 改不了项目层；置顶纯属面板概念。所以必须由 host 落盘，这里逐条钉死语义。
    const uiPrefsMod = await import(pathToFileURL(path.join(root, 'src/ui-prefs.mjs')).href)
    const prefsFile = path.join(tmp, 'prefs', 'ui-prefs.json')
    const prefsDir = path.dirname(prefsFile)
    const prefsServer = await makeServer({ uiPrefs: uiPrefsMod.createUiPrefsStore({ filePath: prefsFile }) })
    try {
      // 3.12.1 三条路由存在，且方法不匹配时走既有的 404 约定（不是 405）。
      const emptyPrefs = await request(prefsServer.base, '/ui-prefs')
      eq('ui-prefs GET 200（文件还不存在也照常返回）', emptyPrefs.status, 200)
      eq('ui-prefs GET 空文件回落成空结构', emptyPrefs.body, { version: 1, updatedAt: emptyPrefs.body.updatedAt, projects: {}, sessions: {} })
      check('ui-prefs GET updatedAt 是 ISO 时间', typeof emptyPrefs.body.updatedAt === 'string' && !Number.isNaN(Date.parse(emptyPrefs.body.updatedAt)), String(emptyPrefs.body.updatedAt))
      eq('ui-prefs/project 用 GET → 404', (await request(prefsServer.base, '/ui-prefs/project')).status, 404)
      eq('ui-prefs/session 用 GET → 404', (await request(prefsServer.base, '/ui-prefs/session')).status, 404)
      eq('ui-prefs 用 POST → 404（只有 /ui-prefs 能 GET）', (await request(prefsServer.base, '/ui-prefs', { method: 'POST', body: {} })).status, 404)

      // 3.12.2 project 写入 → GET 可见（全量返回，不是增量）。
      const renamed = await request(prefsServer.base, '/ui-prefs/project', { method: 'POST', body: { key: 'c:\\work', name: '  我的项目  ' } })
      eq('ui-prefs/project 写入 200', renamed.status, 200)
      eq('ui-prefs/project 名字已 trim', renamed.body.projects['c:\\work'].name, '我的项目')
      const afterRename = await request(prefsServer.base, '/ui-prefs')
      eq('ui-prefs GET 能看到刚写的项目名', afterRename.body.projects['c:\\work'].name, '我的项目')
      check('ui-prefs 条目带 createdAt/updatedAt', typeof afterRename.body.projects['c:\\work'].createdAt === 'string' && typeof afterRename.body.projects['c:\\work'].updatedAt === 'string')

      // 3.12.3 createdAt 首次创建后不再变（本仓库的强制约定，客户端拿它做稳定排序键）。
      const firstCreatedAt = afterRename.body.projects['c:\\work'].createdAt
      await new Promise(done => setTimeout(done, 10))
      const renamedAgain = await request(prefsServer.base, '/ui-prefs/project', { method: 'POST', body: { key: 'c:\\work', name: '改名了' } })
      eq('ui-prefs/project 二次改名生效', renamedAgain.body.projects['c:\\work'].name, '改名了')
      eq('ui-prefs createdAt 二次更新后不变', renamedAgain.body.projects['c:\\work'].createdAt, firstCreatedAt)
      check('ui-prefs updatedAt 二次更新后刷新', renamedAgain.body.projects['c:\\work'].updatedAt !== firstCreatedAt, JSON.stringify(renamedAgain.body.projects))

      // 3.12.4 name === '' 删除覆盖（不是存一个空名字）。
      const cleared = await request(prefsServer.base, '/ui-prefs/project', { method: 'POST', body: { key: 'c:\\work', name: '' } })
      eq('ui-prefs/project name:"" 删除覆盖', cleared.body.projects, {})

      // 3.12.5 入参校验：key 缺 / name 非字符串 / name 过长，全是 400。
      eq('ui-prefs/project key 缺 → 400', (await request(prefsServer.base, '/ui-prefs/project', { method: 'POST', body: { name: 'x' } })).status, 400)
      eq('ui-prefs/project key 空串 → 400', (await request(prefsServer.base, '/ui-prefs/project', { method: 'POST', body: { key: '   ', name: 'x' } })).status, 400)
      eq('ui-prefs/project name 非字符串 → 400', (await request(prefsServer.base, '/ui-prefs/project', { method: 'POST', body: { key: 'k', name: 42 } })).status, 400)
      eq('ui-prefs/project name 121 字 → 400', (await request(prefsServer.base, '/ui-prefs/project', { method: 'POST', body: { key: 'k', name: 'x'.repeat(121) } })).status, 400)
      eq('ui-prefs/project name 恰好 120 字 → 200', (await request(prefsServer.base, '/ui-prefs/project', { method: 'POST', body: { key: 'k', name: 'x'.repeat(120) } })).status, 200)
      eq('ui-prefs/project 未知键一个都不留（白名单）', (await request(prefsServer.base, '/ui-prefs/project', { method: 'POST', body: { key: 'k2', name: 'n', junk: 'v' } })).body.projects.k2, { name: 'n', createdAt: (await request(prefsServer.base, '/ui-prefs')).body.projects.k2.createdAt, updatedAt: (await request(prefsServer.base, '/ui-prefs')).body.projects.k2.updatedAt })

      // 3.12.6 session 置顶：写入 / 删除 / 类型校验。
      const pinned = await request(prefsServer.base, '/ui-prefs/session', { method: 'POST', body: { path: 'C:\\sessions\\a.jsonl', pinned: true } })
      eq('ui-prefs/session 置顶 200', pinned.status, 200)
      eq('ui-prefs/session 置顶写入', pinned.body.sessions['C:\\sessions\\a.jsonl'].pinned, true)
      check('ui-prefs/session 置顶带 createdAt', typeof pinned.body.sessions['C:\\sessions\\a.jsonl'].createdAt === 'string')
      const pinnedAgain = await request(prefsServer.base, '/ui-prefs/session', { method: 'POST', body: { path: 'C:\\sessions\\a.jsonl', pinned: true } })
      eq('ui-prefs/session 重复置顶幂等', pinnedAgain.body.sessions['C:\\sessions\\a.jsonl'].createdAt, pinned.body.sessions['C:\\sessions\\a.jsonl'].createdAt)
      const unpinned = await request(prefsServer.base, '/ui-prefs/session', { method: 'POST', body: { path: 'C:\\sessions\\a.jsonl', pinned: false } })
      eq('ui-prefs/session pinned:false 删除该条', unpinned.body.sessions, {})
      eq('ui-prefs/session path 缺 → 400', (await request(prefsServer.base, '/ui-prefs/session', { method: 'POST', body: { pinned: true } })).status, 400)
      eq('ui-prefs/session pinned 非布尔 → 400', (await request(prefsServer.base, '/ui-prefs/session', { method: 'POST', body: { path: 'p', pinned: 'yes' } })).status, 400)
      eq('ui-prefs/session path 超 4096 → 400', (await request(prefsServer.base, '/ui-prefs/session', { method: 'POST', body: { path: 'p'.repeat(4097), pinned: true } })).status, 400)

      // 3.12.6b 路由层必须走合并语义（setSession），不是只有一个 pinned 参数的旧入口：
      // 面板上「重命名会话」与「置顶会话」是两个独立动作，各自只提交自己那个字段。
      const namedOnly = await request(prefsServer.base, '/ui-prefs/session', { method: 'POST', body: { path: 'C:\\sessions\\m.jsonl', name: '  改过的名字  ' } })
      eq('ui-prefs/session 只给 name → 200', namedOnly.status, 200)
      eq('ui-prefs/session 只给 name 时名字已 trim', namedOnly.body.sessions['C:\\sessions\\m.jsonl'].name, '改过的名字')
      eq('ui-prefs/session 只给 name 不许凭空置顶', namedOnly.body.sessions['C:\\sessions\\m.jsonl'].pinned, undefined)
      const pinAfterName = await request(prefsServer.base, '/ui-prefs/session', { method: 'POST', body: { path: 'C:\\sessions\\m.jsonl', pinned: true } })
      eq('ui-prefs/session 只给 pinned 时保留已有名字', pinAfterName.body.sessions['C:\\sessions\\m.jsonl'].name, '改过的名字')
      eq('ui-prefs/session 只给 pinned 时置顶生效', pinAfterName.body.sessions['C:\\sessions\\m.jsonl'].pinned, true)
      const clearName = await request(prefsServer.base, '/ui-prefs/session', { method: 'POST', body: { path: 'C:\\sessions\\m.jsonl', name: '' } })
      eq('ui-prefs/session name:"" 清掉名字', clearName.body.sessions['C:\\sessions\\m.jsonl'].name, undefined)
      eq('ui-prefs/session 清名字不动置顶', clearName.body.sessions['C:\\sessions\\m.jsonl'].pinned, true)
      const dropAll = await request(prefsServer.base, '/ui-prefs/session', { method: 'POST', body: { path: 'C:\\sessions\\m.jsonl', pinned: false } })
      eq('ui-prefs/session 名字与置顶都没了就删整条', dropAll.body.sessions, {})
      eq('ui-prefs/session name 与 pinned 同给 → 200', (await request(prefsServer.base, '/ui-prefs/session', { method: 'POST', body: { path: 'C:\\sessions\\b.jsonl', pinned: true, name: '双给' } })).status, 200)
      eq('ui-prefs/session 空 body 其余 → 400（至少给一个字段）', (await request(prefsServer.base, '/ui-prefs/session', { method: 'POST', body: { path: 'C:\\sessions\\b.jsonl' } })).status, 400)
      eq('ui-prefs/session name 非字符串 → 400', (await request(prefsServer.base, '/ui-prefs/session', { method: 'POST', body: { path: 'C:\\sessions\\b.jsonl', name: 7 } })).status, 400)
      eq('ui-prefs/session name 超 120 → 400', (await request(prefsServer.base, '/ui-prefs/session', { method: 'POST', body: { path: 'C:\\sessions\\b.jsonl', name: 'x'.repeat(121) } })).status, 400)
      // 上面写的 C:\\sessions\\b.jsonl 要在进入 3.12.7 之前清干净（那里断言的是整文件回落）。
      eq('ui-prefs/session 收尾清空（名字与置顶一起撤）', (await request(prefsServer.base, '/ui-prefs/session', { method: 'POST', body: { path: 'C:\\sessions\\b.jsonl', pinned: false, name: '' } })).body.sessions, {})

      // 3.12.7 坏文件容错：手改坏了也不能把面板拖死（回空结构，绝不 500）。
      fs.mkdirSync(prefsDir, { recursive: true })
      fs.writeFileSync(prefsFile, '{ this is not json', 'utf8')
      const broken = await request(prefsServer.base, '/ui-prefs')
      eq('ui-prefs 坏 JSON → 200 空结构（不抛）', broken.status, 200)
      eq('ui-prefs 坏 JSON 回落内容', broken.body, { version: 1, updatedAt: broken.body.updatedAt, projects: {}, sessions: {} })
      // 结构不对（写成了数组 / 字段类型乱来）也要被修剪掉。
      fs.writeFileSync(prefsFile, JSON.stringify({ version: 99, projects: { good: { name: 'ok' }, bad: { name: 5 }, '': { name: 'x' } }, sessions: { s1: { pinned: false }, s2: { pinned: true } } }), 'utf8')
      const pruned = await request(prefsServer.base, '/ui-prefs')
      eq('ui-prefs 结构不对只留合法条目', Object.keys(pruned.body.projects), ['good'])
      eq('ui-prefs 缺 createdAt 时补一个', typeof pruned.body.projects.good.createdAt, 'string')
      eq('ui-prefs pinned:false 的脏条目被丢弃', Object.keys(pruned.body.sessions), ['s2'])
      eq('ui-prefs version 强制回 1', pruned.body.version, 1)

      // 3.12.8 原子写：落盘后目录里不许残留 .tmp-*（半截文件攒多了迟早被误读）。
      const written = await request(prefsServer.base, '/ui-prefs/project', { method: 'POST', body: { key: 'atomic', name: 'A' } })
      eq('ui-prefs 原子写 200', written.status, 200)
      eq('ui-prefs 原子写无 .tmp 残留', fs.readdirSync(prefsDir).filter(name => name.indexOf('.tmp-') !== -1), [])
      eq('ui-prefs 落盘文件就是那一个', fs.readdirSync(prefsDir), ['ui-prefs.json'])
      check('ui-prefs 落盘内容可解析', (() => { try { return JSON.parse(fs.readFileSync(prefsFile, 'utf8')).projects.atomic.name === 'A' } catch { return false } })())

      // 3.12.9 并发两个 POST 不许交错坏文件（队列串行化 + rename 原子性）。
      await Promise.all([
        request(prefsServer.base, '/ui-prefs/project', { method: 'POST', body: { key: 'p1', name: 'P1' } }),
        request(prefsServer.base, '/ui-prefs/project', { method: 'POST', body: { key: 'p2', name: 'P2' } }),
        request(prefsServer.base, '/ui-prefs/session', { method: 'POST', body: { path: 'C:\\s\\c.jsonl', pinned: true } }),
      ])
      const afterConcurrent = await request(prefsServer.base, '/ui-prefs')
      eq('ui-prefs 并发写不丢更新（1/2）', Object.keys(afterConcurrent.body.projects).sort(), ['atomic', 'good', 'p1', 'p2'])
      eq('ui-prefs 并发写不丢更新（2/2）', Object.keys(afterConcurrent.body.sessions).sort(), ['C:\\s\\c.jsonl', 's2'])
      eq('ui-prefs 并发后仍无 .tmp 残留', fs.readdirSync(prefsDir).filter(name => name.indexOf('.tmp-') !== -1), [])

      // 3.12.10 不注入 store 时回 501，而不是静默 200 空值（客户端会以为「没偏好」）。
      const noPrefs = await makeServer({ uiPrefs: undefined })
      try {
        eq('ui-prefs 未注入 store → 501', (await request(noPrefs.base, '/ui-prefs')).status, 501)
      } finally {
        await noPrefs.close()
      }
    } finally {
      await prefsServer.close()
    }

    // 3.13 会话条目的合并语义（setSession：显示名 + 置顶两个独立偏好）
    // 这一段直接打 store 而不是走 HTTP：显示名的路由接线在 index.js 里（本文件的
    // 写作用域不含它），把语义钉在 store 层才不会被那一层的形状绑死。
    const sessionPrefsFile = path.join(tmp, 'prefs-session', 'ui-prefs.json')
    const sessionStore = uiPrefsMod.createUiPrefsStore({ filePath: sessionPrefsFile })
    const namedPath = 'C:\\sessions\\named.jsonl'
    /** 断言「这个 Promise 必须以指定文案 reject」——入参校验是 Promise 语义的一部分。 */
    const rejectsWith = async (name, task, expected) => {
      try {
        await task
        check(name, false, 'expected rejection')
      } catch (error) {
        check(name, error?.message === expected, 'got ' + String(error?.message))
      }
    }
    // 3.13.1 只写名字：条目里有 name、没有 pinned 字段（「未置顶」的表达就是没有该字段）。
    const nameOnly = await sessionStore.setSession(namedPath, { name: '  我的会话  ' })
    eq('setSession 只写 name 时 name 已 trim', nameOnly.sessions[namedPath].name, '我的会话')
    check('setSession 只写 name 时不落 pinned 字段', Object.prototype.hasOwnProperty.call(nameOnly.sessions[namedPath], 'pinned') === false, JSON.stringify(nameOnly.sessions[namedPath]))
    check('setSession 新条目带 createdAt/updatedAt', typeof nameOnly.sessions[namedPath].createdAt === 'string' && typeof nameOnly.sessions[namedPath].updatedAt === 'string')
    const namedCreatedAt = nameOnly.sessions[namedPath].createdAt
    // 3.13.2 再加置顶：pinned===true 且名字保留（合并，不是覆盖整条）。
    const pinnedWithName = await sessionStore.setSession(namedPath, { pinned: true })
    eq('setSession 补 pinned 后 pinned===true', pinnedWithName.sessions[namedPath].pinned, true)
    eq('setSession 补 pinned 后 name 保留', pinnedWithName.sessions[namedPath].name, '我的会话')
    eq('setSession 合并写入不改 createdAt', pinnedWithName.sessions[namedPath].createdAt, namedCreatedAt)
    // 3.13.3 取消置顶：name 仍保留（这一条是最容易写错的：删 pinned 不等于删整条）。
    const unpinnedKeepName = await sessionStore.setSession(namedPath, { pinned: false })
    eq('setSession 取消置顶后 name 仍保留', unpinnedKeepName.sessions[namedPath].name, '我的会话')
    check('setSession 取消置顶后不落 pinned 字段', Object.prototype.hasOwnProperty.call(unpinnedKeepName.sessions[namedPath], 'pinned') === false, JSON.stringify(unpinnedKeepName.sessions[namedPath]))
    // 3.13.4 清名字且本来就没置顶 → 条目整条删除（空壳条目没有语义）。
    const clearedName = await sessionStore.setSession(namedPath, { name: '' })
    check('setSession name:"" 且未置顶 → 删除条目', Object.prototype.hasOwnProperty.call(clearedName.sessions, namedPath) === false, JSON.stringify(clearedName.sessions))
    // 3.13.5 一个字段都没给 → 400 文案（客户端漏传时能一眼看出缺什么）。
    await rejectsWith('setSession 空补丁 → body requires a boolean pinned or a string name', sessionStore.setSession(namedPath, {}), 'body requires a boolean pinned or a string name')
    await rejectsWith('setSession 不给补丁 → 同样 400', sessionStore.setSession(namedPath), 'body requires a boolean pinned or a string name')
    // 3.13.6 name 长度上限与 project 一致（同一条上限，避免两个字段的规则分叉）。
    await rejectsWith('setSession name 121 字 → name too long (max 120)', sessionStore.setSession(namedPath, { name: 'x'.repeat(121) }), 'name too long (max 120)')
    await rejectsWith('setSession name 非字符串 → body requires a string name', sessionStore.setSession(namedPath, { name: 42 }), 'body requires a string name')
    // 3.13.7 老格式文件（只有 pinned:true、没有 name）必须能正常读出来，name 为 undefined。
    fs.mkdirSync(path.dirname(sessionPrefsFile), { recursive: true })
    fs.writeFileSync(sessionPrefsFile, JSON.stringify({
      version: 1,
      updatedAt: '2026-01-01T00:00:00.000Z',
      projects: {},
      sessions: { 'C:\\old\\pinned.jsonl': { pinned: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' } },
    }), 'utf8')
    const legacy = await sessionStore.read()
    eq('老格式文件 pinned 读出为 true', legacy.sessions['C:\\old\\pinned.jsonl'].pinned, true)
    check('老格式文件没有 name 字段（name 读出为 undefined，不是空串）', Object.prototype.hasOwnProperty.call(legacy.sessions['C:\\old\\pinned.jsonl'], 'name') === false && legacy.sessions['C:\\old\\pinned.jsonl'].name === undefined, JSON.stringify(legacy.sessions))
    eq('老格式文件 createdAt 原样保留', legacy.sessions['C:\\old\\pinned.jsonl'].createdAt, '2026-01-01T00:00:00.000Z')
    // 3.13.8 非法 name 只丢 name、保留 pinned（旧版本/手改写进的脏名字不该连置顶一起丢）。
    fs.writeFileSync(sessionPrefsFile, JSON.stringify({
      version: 1,
      updatedAt: '2026-01-01T00:00:00.000Z',
      projects: {},
      sessions: { 'C:\\bad\\name.jsonl': { pinned: true, name: 'x'.repeat(121), createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } },
    }), 'utf8')
    const dirtyName = await sessionStore.read()
    eq('脏 name（超长）被丢弃但 pinned 保留', dirtyName.sessions['C:\\bad\\name.jsonl'], { pinned: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' })

    // 3.14 用户自定义规则（最高优先级）
    // 这一段打的是**真 apply() 接出来的 store**，而不是手工传进去的假对象：
    // 它要证明的是「面板写的、pi 扩展读的是同一个文件」这条链路的上半截真的接上了。
    // 落盘路径由 SUPERPI_RULES 指到临时目录，绝不碰用户真实的 ~/.superpi/rules.json。
    const rulesMod = await import(pathToFileURL(path.join(root, 'extensions', 'superpi-rules.mjs')).href)
    const rulesFile = path.join(tmp, 'rules', 'rules.json')
    const rulesServer = await makeServer({ rulesStore: rulesMod.createRulesStore({ filePath: rulesFile }) })
    try {
      // 3.14.1 文件不存在时回默认文案，且 GET 不写盘（打开设置不该产生一次写）。
      const fresh = await request(rulesServer.base, '/rules')
      eq('rules GET 200', fresh.status, 200)
      eq('rules GET 文件不存在时回默认文案', fresh.body.text, rulesMod.DEFAULT_RULES_TEXT)
      eq('rules GET isDefault', fresh.body.isDefault, true)
      eq('rules GET empty', fresh.body.empty, false)
      eq('rules GET rank', fresh.body.rank, 1)
      eq('rules GET maxLength', fresh.body.maxLength, rulesMod.MAX_RULES_TEXT)
      eq('rules GET 命令行入口', fresh.body.delivery.command, '/' + rulesMod.RULES_COMMAND)
      eq('rules GET filePath 是真实落盘路径', fresh.body.filePath, rulesFile)
      check('rules GET 带 extensionInstalled 布尔', typeof fresh.body.delivery.extensionInstalled === 'boolean')
      eq('rules GET 不写盘', fs.existsSync(rulesFile), false)

      // 3.14.2 写入 → 归一 → 落盘 → 再读能看到（面板改完，pi 下一轮就读这个文件）。
      const saved = await request(rulesServer.base, '/rules', { method: 'POST', body: { text: '  面板写的规则\n\n\n第二行 ' } })
      eq('rules POST 200', saved.status, 200)
      eq('rules POST 归一后返回', saved.body.text, '面板写的规则\n\n第二行')
      eq('rules POST isDefault=false', saved.body.isDefault, false)
      const rulesOnDisk = JSON.parse(fs.readFileSync(rulesFile, 'utf8'))
      eq('rules POST 真的落盘', rulesOnDisk.text, '面板写的规则\n\n第二行')
      eq('rules 落盘 checksum 自算', rulesOnDisk.checksum, rulesMod.checksumOf(rulesOnDisk.text))
      // 扩展侧同步读（每轮 before_agent_start 走的就是这条）：拿到同一个文本。
      rulesMod.clearRulesCache()
      eq('扩展同步读到的就是面板写的', rulesMod.readRulesTextSync(rulesFile).text, '面板写的规则\n\n第二行')
      eq('rules GET 能读到刚写的', (await request(rulesServer.base, '/rules')).body.text, '面板写的规则\n\n第二行')

      // 3.14.3 入参校验与 415（与 /command、/respond 同一套约定）。
      eq('rules POST text 非字符串 → 400', (await request(rulesServer.base, '/rules', { method: 'POST', body: { text: 42 } })).status, 400)
      eq('rules POST 缺 text → 400', (await request(rulesServer.base, '/rules', { method: 'POST', body: {} })).status, 400)
      eq('rules POST 超长 → 400', (await request(rulesServer.base, '/rules', { method: 'POST', body: { text: 'x'.repeat(rulesMod.MAX_RULES_TEXT + 1) } })).status, 400)
      eq('rules POST 非 JSON → 415', (await request(rulesServer.base, '/rules', { method: 'POST', body: { text: 'x' }, contentType: 'text/plain' })).status, 415)
      eq('rules/reset 非 JSON → 415', (await request(rulesServer.base, '/rules/reset', { method: 'POST', body: {}, contentType: 'text/plain' })).status, 415)
      eq('rules/reset 用 GET → 404', (await request(rulesServer.base, '/rules/reset')).status, 404)

      // 3.14.4 清空 = 不追加任何内容（empty 与 rank 必须跟着变，否则 UI 无法区分「默认」与「关掉」）。
      const cleared = await request(rulesServer.base, '/rules', { method: 'POST', body: { text: '' } })
      eq('rules POST 空文本 → empty', cleared.body.empty, true)
      eq('rules POST 空文本 → rank 0', cleared.body.rank, 0)
      eq('rules 空规则渲染成空串（零痕迹）', rulesMod.renderRulesBlock(cleared.body.text), '')

      // 3.14.5 恢复默认。
      const restored = await request(rulesServer.base, '/rules/reset', { method: 'POST', body: {} })
      eq('rules/reset 200', restored.status, 200)
      eq('rules/reset 回默认文案', restored.body.text, rulesMod.DEFAULT_RULES_TEXT)
      eq('rules/reset isDefault', restored.body.isDefault, true)

      // 3.14.6 外部手改（checksum 对不上）→ drift 必须被读出来；坏文件 → 仍 200 + warning。
      fs.writeFileSync(rulesFile, JSON.stringify({ version: 1, text: '手改的', checksum: 'stale', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }), 'utf8')
      eq('rules 外部手改 → drift', (await request(rulesServer.base, '/rules')).body.drift, true)
      fs.writeFileSync(rulesFile, '{坏的', 'utf8')
      const corrupt = await request(rulesServer.base, '/rules')
      eq('rules 坏文件仍 200', corrupt.status, 200)
      eq('rules 坏文件回默认', corrupt.body.text, rulesMod.DEFAULT_RULES_TEXT)
      check('rules 坏文件带 warning', typeof corrupt.body.warning === 'string' && corrupt.body.warning !== '')
      eq('rules 保存一次即修好', (await request(rulesServer.base, '/rules', { method: 'POST', body: { text: '修好了' } })).body.warning, '')
    } finally {
      await rulesServer.close()
    }

    // 3.11 未知路由仍 404
    const unknown = await request(server.base, '/nope')
    eq('未知路由 404', unknown.status, 404)
  } finally {
    await server.close()
  }

  /* ════════════════════════════════════════════════ 4. 0.14.0 性能判据 */

  /**
   * 这几条对应 docs/performance-acceptance.md 的判据 C / D。
   *
   * 为什么必须进机器门禁：这几处的退化是**静默**的 —— O(n²) 的切帧器照样能切出
   * 正确的帧，只是慢 100 倍；全量返回的 get_messages 照样能渲染，只是卡几秒。
   * 只有把「耗时上限」和「响应体上限」写成断言，退化才会当场变红。
   */

  // ── 4.1 切帧器：语义不变 + 线性耗时（判据 C）

  {
    const rpc = await import(pathToFileURL(path.join(root, 'src', 'pi-rpc.mjs')).href)

    /**
     * 用「协议替身」驱动真实 LineSplitter：它是 PiProcess 内部类，
     * 通过一个最小 PiProcess 实例拿到 —— 这样测的是**真正在跑的那份代码**，
     * 不是测试里复制粘贴的另一份实现（复制的那份永远不会跟源码一起退化）。
     */
    const makeSplitter = onLine => {
      const proc = rpc.createProcess
        ? null
        : null
      void proc
      // PiProcess 的 splitter 在 start() 里创建并绑定到子进程；这里直接构造一个
      // 不过 start() 的实例，只借它的 LineSplitter 语义（构造函数是纯的）。
      const instance = Object.create(rpc.PiProcess.prototype)
      return instance
    }
    void makeSplitter

    // 直接用真实类：PiProcess 上暴露了拆分入口（start 时创建 splitter 并喂 stdout）。
    // 为了不依赖子进程，这里用一份「与源码逐字相同」的取用方式：
    // 通过 start() 前的 splitter 构造路径不可行，所以改为按行为验证 ——
    // 用 PiProcess 的 receive 路径太重，改为断言源码里的关键性质 + 计时。
    const source = fs.readFileSync(path.join(root, 'src', 'pi-rpc.mjs'), 'utf8')
    check('切帧器不再每次 push 都从头 indexOf', !/this\.buffer\.indexOf\(0x0a\)/.test(source),
      '仍有 this.buffer.indexOf(0x0a)（O(n²) 会回来）')
    check('切帧器不再每次 push 都 concat 全量', !/this\.buffer = this\.buffer\.length === 0 \? chunk : Buffer\.concat/.test(source),
      '仍有「每 chunk 都 Buffer.concat 全量」的旧写法')
    check('切帧器保留 pending 分块列表（每字节只扫一次）', /this\.pending = \[\]/.test(source) && /this\.pendingBytes = 0/.test(source),
      '缺少 pending/pendingBytes 结构')
    check('切帧器仍然只按 LF 切（不使用 readline）', !/from 'node:readline'/.test(source) && !/require\('readline'\)/.test(source),
      '引入了 readline（会在 U+2028 / U+2029 处多断行）')

    // 真实耗时：用 55MB 单帧 + 64KB 分块，必须远低于旧实现的 11,494 ms。
    // 阈值取 1500ms：既给慢机器留足余量，又能在旧实现（秒级）下必然变红。
    const SplitterClass = new Function('Buffer', (() => {
      const match = source.match(/class LineSplitter \{[\s\S]*?\n\}/)
      return match === null ? '' : match[0] + '; return LineSplitter'
    })())(Buffer)
    check('能从源码取出 LineSplitter 类（门禁自检）', typeof SplitterClass === 'function')
    if (typeof SplitterClass === 'function') {
      const totalMB = 55
      const chunkBytes = 64 * 1024
      const full = Buffer.concat([Buffer.alloc(totalMB * 1024 * 1024 - 1, 0x41), Buffer.from('\n')])
      let lines = 0
      const splitter = new SplitterClass(() => { lines += 1 })
      const started = performance.now()
      for (let offset = 0; offset < full.length; offset += chunkBytes) {
        splitter.push(full.subarray(offset, Math.min(offset + chunkBytes, full.length)))
      }
      const elapsed = performance.now() - started
      check('55MB 单帧解析 < 1500ms（旧实现 11,494ms）', elapsed < 1500, '实测 ' + Math.round(elapsed) + 'ms')
      eq('55MB 单帧只切出 1 条帧', lines, 1)

      // 语义不变：各种分块大小必须切出一模一样的帧序列。
      const sample = Buffer.from('a\r\nbb\n\nccc\r\n{"k":"v\u2028x"}\nlast-without-newline')
      const baseline = (() => {
        const out = []
        const sp = new SplitterClass(line => out.push(line))
        sp.push(sample)
        sp.flush()
        return out
      })()
      for (const chunkSize of [1, 2, 3, 7, 64, 1024, 99999]) {
        const out = []
        const sp = new SplitterClass(line => out.push(line))
        for (let offset = 0; offset < sample.length; offset += chunkSize) {
          sp.push(sample.subarray(offset, Math.min(offset + chunkSize, sample.length)))
        }
        sp.flush()
        eq('切帧结果与分块大小无关（chunk=' + String(chunkSize) + '）', out, baseline)
      }
      eq('U+2028 不断行（只在 LF 处切）', baseline.some(line => line.includes('\u2028')), true)
    }
  }


  // ── 3.97 安装顺序：被依赖的 .mjs 必须排在 .ts 之前（0.15.3）

  /**
   * 真机事故：用户 `/reload` 后报 `resetMeterMemo is not a function`。
   * 根因不是代码，而是**安装清单的顺序** —— `context-guard.ts` 排在它 import 的
   * `context-guard.mjs` 前面，装到一半时磁盘上是「新 .ts + 旧 .mjs」，
   * 扩展加载即抛错，整个上下文守卫静默失效。
   *
   * 这种错误极难查：报错像代码 bug，实际是安装过程的瞬时中间状态。
   * 所以把顺序写成断言，而不是靠人记住。
   */
  {
    const installer = await import(pathToFileURL(path.join(root, 'tools', 'install-pi-extension.mjs')).href)
    const files = installer.EXTENSION_FILES
    const position = new Map(files.map((f, i) => [f.name, i]))
    const problems = []
    /**
     * 依赖顺序按**真实 import 语句**判（0.18.0 改法）。
     *
     * 旧实现只找「同目录同基名的 .mjs」—— 那对 `superpi-editor.ts` 恰好成立
     * （当时的模块叫 superpi-malformed.mjs，同基名不再成立时就漏）。
     * 0.18.0 把它换成读源码里的 `from './x.mjs'`，一次覆盖所有跨文件依赖，
     * 并且立刻抓到一个**真实存在的拓扑缺陷**：`context-guard.ts` import
     * `superpi-modalities.mjs`，而 modalities 模块排在它后面。
     */
    for (const [i, entry] of files.entries()) {
      if (!entry.source.endsWith('.ts')) continue
      const abs = path.join(root, entry.source)
      if (!fs.existsSync(abs)) { problems.push(entry.label + ' 源文件不存在'); continue }
      const source = fs.readFileSync(abs, 'utf8')
      for (const match of source.matchAll(/from\s+'\.\/([\w.-]+\.mjs)'/g)) {
        const dep = files.find(file => file.name === match[1])
        if (dep === undefined) { problems.push(entry.label + ' import 了未登记的文件 ' + match[1]); continue }
        if (position.get(dep.name) > i) problems.push(entry.label + ' 排在它的依赖 ' + dep.label + ' 之前')
      }
    }
    eq('每个 .ts 的 .mjs 依赖都排在它前面', problems, [])
    // 完整清单不能漏文件（漏了就是"装了但没生效"）
    eq('安装清单包含全部十三个文件', files.length, 13)
  }

  // ── 3.98 发布文本文档里不得有控制字符（0.15.3，这是 400 的真因）

  /**
   * 真机事故：`400 invalid JSON request body`，重试多次仍在。
   *
   * 根因不是体积、不是网络、不是上下文超限 —— 是 `AGENTS.md` 里混进了
   * 一个 **U+0007（BEL）控制字符**。它被 pi 拼进 `project_context` 这个
   * 系统提示 section，再序列化进 HTTP 请求体；JSON 规范禁止未转义的
   * `U+0000`~`U+001F`，provider 解析直接失败。
   *
   * 那个字符的来源很蠢：文档里想写示例路径 `D:\<文件>.png`，
   * 写成了 `D:\x07.png` 之类，`\x07` 在写入时被当转义序列解析成了 BEL。
   * **一次笔误，让整个会话再也发不出请求，而且报错完全不指向文档。**
   *
   * 所以必须机器检查：凡是会进系统提示的文本文档，都不许含控制字符、
   * 孤立代理项、U+FFFD。
   */
  {
    /**
     * 判据取**共享模块**（0.18.0）：定义只有一处（`extensions/superpi-text-bytes.mjs`），
     * 门禁只决定"扫哪些文件"。0.15.3 时这里有一段手写循环，与 `test/parity.mjs` §9
     * 各写一份、口径还不同（这边查 DEL，那边不查）—— 两份定义就是两次分叉机会。
     */
    const { scanTextBytes } = await import(pathToFileURL(path.join(root, 'extensions', 'superpi-text-bytes.mjs')).href)
    const docs = [
      'AGENTS.md',
      'README.md',
      'docs/anti-product-patterns.md',
      'docs/session-interruption.md',
      'docs/output-integrity.md',
    ]
    for (const rel of docs) {
      const abs = path.join(root, rel)
      if (!fs.existsSync(abs)) { check(rel + ' 存在', false); continue }
      const buf = fs.readFileSync(abs)
      // ① 合法 UTF-8
      let utf8Ok = true
      try { new TextDecoder('utf-8', { fatal: true }).decode(buf) } catch { utf8Ok = false }
      check(rel + ' 是合法 UTF-8', utf8Ok)
      const text = buf.toString('utf8')
      const scan = scanTextBytes(text, { maxSpans: Number.MAX_SAFE_INTEGER })
      // ② 无控制字符（\t \n \r 除外；DEL 也算，见共享模块的定义）
      const ctrl = scan.spans.filter(span => span.kind === 'control')
      eq(rel + ' 无控制字符（否则请求体 JSON 非法，provider 报 400）', ctrl.slice(0, 5).map(span => 'U+' + span.code.toString(16).toUpperCase().padStart(4, '0') + '@' + String(span.index)), [])
      // ③ 无 U+FFFD（说明曾有一次写入已损坏）
      check(rel + ' 无 U+FFFD 替换字符', scan.counts.replacement === 0)
      // ④ 无孤立代理项（JSON 里非法）
      check(rel + ' 无孤立代理项', scan.counts.surrogate === 0)
    }
  }

  // ── 3.99 运行时文件清单自动发现（防止两个门禁再次漂移）

  /**
   * 0.15.0 之前 `test/selfcheck.mjs` 与 `test/version.mjs` 各硬编码一份复制清单，
   * 实测已经漂移成 16 / 15 项。新增 `src/http-idle-guard.mjs` 后两个门禁同时
   * `Cannot find module` 而红 —— 不是代码错，是清单漏。
   *
   * 现在清单由 `src/runtime-files.mjs` 按目录自动发现。这里钉三件事：
   *   ① 新加的源文件必须被自动收录（否则等于没修）；
   *   ② 两个门禁不许再出现硬编码的数组（退回旧写法立刻红）；
   *   ③ 清单里每个文件都真实存在（防止收进幽灵路径）。
   */
  {
    const rf = await import(pathToFileURL(path.join(root, 'src', 'runtime-files.mjs')).href)
    const files = rf.listRuntimeFiles(root)
    check('清单包含 index.js', files.includes('index.js'))
    check('清单包含 client.js', files.includes('client.js'))
    check('清单包含新模块 http-idle-guard.mjs', files.includes('src/http-idle-guard.mjs'),
      '新增模块没被自动收录 —— 装到别处会 Cannot find module')
    check('清单包含新模块 runtime-files.mjs', files.includes('src/runtime-files.mjs'))
    check('清单包含三个扩展的 .ts', files.includes('extensions/superpi-editor.ts'))
    check('清单不含非源码文件', files.every(rel => /\.(mjs|ts|js|json|yml)$/.test(rel)),
      files.filter(rel => !/\.(mjs|ts|js|json|yml)$/.test(rel)).join(','))
    // ③ 每个都在磁盘上
    const missing = files.filter(rel => !fs.existsSync(path.join(root, rel)))
    eq('清单里每个文件都真实存在', missing, [])
    // ① 自动发现：src 下所有 .mjs 都必须在清单里
    const srcFiles = fs.readdirSync(path.join(root, 'src')).filter(name => name.endsWith('.mjs'))
    const notListed = srcFiles.filter(name => !files.includes('src/' + name))
    eq('src 下所有 .mjs 都被收录（自动发现生效）', notListed, [])
    // ② 两个门禁不许回到硬编码
    for (const file of ['selfcheck.mjs', 'version.mjs']) {
      const src = fs.readFileSync(path.join(root, 'test', file), 'utf8')
      check(file + ' 不再硬编码复制清单', !/const COPY = \[/.test(src) && !/for \(const rel of \['/.test(src),
        '仍在手写数组 —— 会与另一个门禁漂移')
      check(file + ' 使用共享清单', src.includes('copyRuntimeFiles'))
    }
  }

  // ── 4.0 HTTP idle 超时下限（判据 B · 0.15.0）

  /**
   * pi 的默认 300s 会误杀长思考：实测 4 次 BODY_TIMEOUT 的静默时长是 317/323/331/503s，
   * 全都刚过 300 秒线，且与上下文规模无关（最浅一次只有 7.3% 占用）。
   * 详见 docs/session-interruption.md §1.1。
   */
  {
    const idle = await import(pathToFileURL(path.join(root, 'src', 'http-idle-guard.mjs')).href)
    eq('导出 MIN_HTTP_IDLE_TIMEOUT_MS', typeof idle.MIN_HTTP_IDLE_TIMEOUT_MS, 'number')
    eq('下限是 30 分钟', idle.MIN_HTTP_IDLE_TIMEOUT_MS, 30 * 60 * 1000)
    eq('pi 默认值常量是 300s', idle.PI_DEFAULT_HTTP_IDLE_TIMEOUT_MS, 300000)
    check('下限远大于实测最坏静默（503s）', idle.MIN_HTTP_IDLE_TIMEOUT_MS > 503 * 1000 * 3,
      '余量不足 3 倍')

    // 决策表：五条分支逐条钉死（这是"只抬不降、尊重显式"的机器保障）
    eq('未设置 → 写入下限', idle.decideIdleTimeout({}).action, 'write')
    eq('未设置 → 写入的值', idle.decideIdleTimeout({}).ms, idle.MIN_HTTP_IDLE_TIMEOUT_MS)
    eq('显式 5min → 保持不动（不因小于下限去覆盖用户意图）', idle.decideIdleTimeout({ httpIdleTimeoutMs: 300000 }).action, 'keep')
    eq('显式 1h → 保持不动', idle.decideIdleTimeout({ httpIdleTimeoutMs: 3600000 }).ms, 3600000)
    eq('显式 0 → 尊重关闭', idle.decideIdleTimeout({ httpIdleTimeoutMs: 0 }).action, 'skip')
    eq('显式 disabled → 尊重关闭', idle.decideIdleTimeout({ httpIdleTimeoutMs: 'disabled' }).action, 'skip')
    eq('非法字符串 → 当作未设置（无有效意图可尊重）', idle.decideIdleTimeout({ httpIdleTimeoutMs: 'bogus' }).action, 'write')
    eq('settings 是 null → 不碰', idle.decideIdleTimeout(null).action, 'skip')

    // 真实文件读写：用临时目录，绝不碰用户的 ~/.pi
    const dir = fs.mkdtempSync(path.join(tmp, 'idle-'))
    const file = path.join(dir, 'settings.json')
    try {
      // 文件不存在 → 建一个
      const first = idle.ensureHttpIdleTimeout({ agentDir: dir })
      eq('文件不存在时创建', first.ok, true)
      eq('写入动作', first.action, 'write')
      const written = JSON.parse(fs.readFileSync(file, 'utf8'))
      eq('写入了下限', written.httpIdleTimeoutMs, idle.MIN_HTTP_IDLE_TIMEOUT_MS)

      // 幂等：第二次不写
      const second = idle.ensureHttpIdleTimeout({ agentDir: dir })
      eq('第二次是 keep（不重复写盘）', second.action, 'keep')
      eq('文件内容未变', fs.readFileSync(file, 'utf8'), JSON.stringify(written, null, 2) + String.fromCharCode(10))

      // 保留用户其它设置
      fs.writeFileSync(file, JSON.stringify({ defaultModel: 'x', theme: 'dark' }), 'utf8')
      idle.ensureHttpIdleTimeout({ agentDir: dir })
      const kept = JSON.parse(fs.readFileSync(file, 'utf8'))
      eq('保留了用户的其它设置', kept.defaultModel, 'x')
      eq('也保留了 theme', kept.theme, 'dark')

      // 坏 JSON：绝不覆盖
      fs.writeFileSync(file, '{ broken', 'utf8')
      const broken = idle.ensureHttpIdleTimeout({ agentDir: dir })
      eq('坏 JSON 不写', broken.ok, false)
      eq('坏 JSON 原样保留（没有把用户文件写没）', fs.readFileSync(file, 'utf8'), '{ broken')

      // 显式小值：不动
      fs.writeFileSync(file, JSON.stringify({ httpIdleTimeoutMs: 600000 }), 'utf8')
      const explicit = idle.ensureHttpIdleTimeout({ agentDir: dir })
      eq('显式 10min 保持不动', explicit.action, 'keep')
      eq('值没被改成下限', JSON.parse(fs.readFileSync(file, 'utf8')).httpIdleTimeoutMs, 600000)
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
    }
  }

  // ── 4.2 历史分页（判据 D）

  {
    check('导出 HISTORY_PAGE_SIZE', typeof mod.HISTORY_PAGE_SIZE === 'number' && mod.HISTORY_PAGE_SIZE > 0)
    check('导出 paginateHistory', typeof mod.paginateHistory === 'function')
    check('导出 stubImagesInMessage', typeof mod.stubImagesInMessage === 'function')

    const bigImage = bytes => ({ type: 'image', data: 'A'.repeat(bytes), mimeType: 'image/png' })
    const history = []
    for (let i = 0; i < 1000; i += 1) {
      history.push({ role: 'user', content: [{ type: 'text', text: 'msg ' + String(i) }] })
      if (i % 10 === 0) history.push({ role: 'toolResult', toolCallId: 'c' + String(i), content: [bigImage(200000)] })
    }

    const page = mod.paginateHistory(history, { imageIdOf: (block, messageIndex, blockIndex) => 'img:' + String(messageIndex) + ':' + String(blockIndex) })
    eq('默认一页 ' + String(mod.HISTORY_PAGE_SIZE) + ' 条', page.messages.length, mod.HISTORY_PAGE_SIZE)
    eq('total 是完整条数', page.total, history.length)
    eq('hasMore 为真', page.hasMore, true)
    eq('nextBefore = 本页起点', page.nextBefore, history.length - mod.HISTORY_PAGE_SIZE)
    check('响应体远小于全量（图片已转 stub）', Buffer.byteLength(JSON.stringify(page)) < 1024 * 1024,
      '实测 ' + Math.round(Buffer.byteLength(JSON.stringify(page)) / 1024) + 'KB')
    const stubbed = page.messages.flatMap(message => (Array.isArray(message.content) ? message.content : [])).filter(block => block.type === 'image-stub')
    check('图片块换成 image-stub（不带 base64）', stubbed.length > 0 && stubbed.every(block => typeof block.data === 'undefined'),
      '仍在下发 base64')
    check('image-stub 带 id（可回取原图）', stubbed.every(block => typeof block.id === 'string' && block.id !== ''))
    check('image-stub 带 bytes 与 mimeType', stubbed.every(block => typeof block.bytes === 'number' && typeof block.mimeType === 'string'))

    const older = mod.paginateHistory(history, { before: page.nextBefore, imageIdOf: () => 'x' })
    eq('往前翻一页条数一致', older.messages.length, mod.HISTORY_PAGE_SIZE)
    check('两页 seq 不重叠', older.messages.every(message => message.seq < page.nextBefore))
    check('一直能翻到第 0 条', (() => {
      let cursor = history.length
      let guard = 0
      while (cursor > 0 && guard < 100) {
        const p = mod.paginateHistory(history, { before: cursor, imageIdOf: () => 'x' })
        cursor = p.nextBefore
        guard += 1
        if (!p.hasMore) break
      }
      return cursor === 0
    })())

    const limited = mod.paginateHistory(history, { limit: 99999 })
    eq('limit 被夹到 HISTORY_PAGE_MAX', limited.messages.length <= 500, true)

    // 非图片消息必须原样通过（这条函数只做一件窄事）。
    const untouched = mod.stubImagesInMessage({ role: 'user', content: [{ type: 'text', text: 'hi' }] }, () => 'x')
    eq('非图片消息原样返回', JSON.stringify(untouched), JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'hi' }] }))
  }
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
}

if (failed === 0) {
  console.log('PASS (' + String(passed) + ' checks)')
  process.exit(0)
}
console.error('FAIL (' + String(failed) + '/' + String(passed + failed) + ')')
for (const line of failures) console.error('  - ' + line)
process.exit(1)

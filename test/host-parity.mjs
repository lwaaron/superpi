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

// ── 3. HTTP 面：stub 掉进程，只验证协议形状 ────────────────────────────────
function fakeProc(overrides = {}) {
  const proc = {
    id: 'sess-1',
    label: 'fake',
    cwd: 'C:/work',
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
      return { id: this.id, label: this.label, cwd: this.cwd, state: this.state, eventSeq: this.eventSeq, events: [], pendingUi: [...this.pendingUi.values()] }
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
    listHistory: async () => ({ cwd: '', agentDir: '', sessionDir: '', override: false, sessions: [], current: null }),
    workspacePath: () => os.tmpdir(),
    ...deps,
  })
  const server = http.createServer((req, res) => { void handler(req, res) })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const base = 'http://127.0.0.1:' + String(server.address().port) + '/api/dsh-pi'
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pi-parity-'))
try {
  const proc = fakeProc()
  const calls = { history: [], spawn: [] }
  const server = await makeServer({
    requireSession: id => {
      if (id !== 'sess-1') { const e = new Error('no such session: ' + id); e.statusCode = 404; throw e }
      return proc
    },
    listHistory: async ({ cwd, limit }) => {
      calls.history.push({ cwd, limit })
      return { cwd: 'C:/work', agentDir: 'C:/.pi', sessionDir: 'C:/.pi/sessions', override: false, sessions: [{ path: 'a.jsonl', name: null, messageCount: 2 }], current: 'a.jsonl' }
    },
    spawnSession: body => { calls.spawn.push(body); return proc },
  })
  try {
    // 3.1 /contract：原样序列化，字段一个不少
    const contract = await request(server.base, '/contract')
    check('contract 200', contract.status === 200, String(contract.status))
    eq('contract version', contract.body.version, '0.4.1')
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
    eq('history 参数透传', calls.history.at(-1), { cwd: 'C:/work', limit: 7 })
    const historyDefault = await request(server.base, '/sessions/history')
    eq('history limit 默认 20', calls.history.at(-1).limit, 20)
    check('history limit 上限 200', (await (async () => { await request(server.base, '/sessions/history?limit=9999'); return calls.history.at(-1).limit })()) === 200)
    check('history 非法 limit 回落 20', (await (async () => { await request(server.base, '/sessions/history?limit=abc'); return calls.history.at(-1).limit })()) === 20)

    // 3.3 未知会话 id 仍然 404（证明顺序修复没放宽别的东西）
    const missing = await request(server.base, '/sessions/nope/snapshot')
    eq('未知 session 404', missing.status, 404)

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

    // 3.5 /reset
    proc.eventSeq = 42
    const reset = await request(server.base, '/sessions/sess-1/reset', { method: 'POST', body: {} })
    eq('reset 200', reset.status, 200)
    eq('reset 体', reset.body, { ok: true, eventSeq: 0 })
    eq('reset 调用了 proc.resetEvents', proc.resetCount, 1)

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

    // 3.9 /pi/changelog
    const pkg = path.join(tmp, 'pkg')
    fs.mkdirSync(path.join(pkg, 'dist', 'bundle'), { recursive: true })
    fs.writeFileSync(path.join(pkg, 'CHANGELOG.md'), '# changelog\n- 1.5.2\n')
    const clServer = await makeServer({ detected: { packageDir: path.join(pkg, 'dist', 'bundle') } })
    try {
      const changelog = await request(clServer.base, '/pi/changelog')
      eq('changelog 200', changelog.status, 200)
      eq('changelog ok', changelog.body.ok, true)
      eq('changelog 路径', changelog.body.path, path.join(pkg, 'CHANGELOG.md'))
      eq('changelog 内容', changelog.body.text, '# changelog\n- 1.5.2\n')
      eq('changelog truncated', changelog.body.truncated, false)
    } finally {
      await clServer.close()
    }
    const bigPkg = path.join(tmp, 'bigpkg')
    fs.mkdirSync(bigPkg, { recursive: true })
    fs.writeFileSync(path.join(bigPkg, 'CHANGELOG.md'), 'x'.repeat(200 * 1024 + 500))
    const bigServer = await makeServer({ detected: { packageDir: bigPkg } })
    try {
      const big = await request(bigServer.base, '/pi/changelog')
      eq('changelog 截断标记', big.body.truncated, true)
      eq('changelog 截断长度', big.body.text.length, 200 * 1024)
    } finally {
      await bigServer.close()
    }
    const noneServer = await makeServer({ detected: { packageDir: path.join(tmp, 'no-such-pkg') } })
    try {
      const none = await request(noneServer.base, '/pi/changelog')
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

    // 3.11 未知路由仍 404
    const unknown = await request(server.base, '/nope')
    eq('未知路由 404', unknown.status, 404)
  } finally {
    await server.close()
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

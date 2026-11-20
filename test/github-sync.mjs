/*
 * 线上同步门禁：`tools/github-sync.mjs`（本地提交 → GitHub）不联网也能验。
 *
 * 为什么值得单独立门禁：这套东西的全部价值都在**失败路径**上 ——
 * 「没网时提交不能失败」「认证炸了不能装成离线」「线上分叉了不能强推」。
 * 这些分支平时看不见，只会在真出事那天决定用户丢不丢提交，所以全部在临时仓库里
 * 用真 git 跑一遍（裸仓库当远端，`http://127.0.0.1:1/` 当断网，另一个 clone 当分叉的那一方）。
 *
 * 跑法：node test/github-sync.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)
const toolPath = path.join(root, 'tools', 'github-sync.mjs')
const hookPath = path.join(root, 'tools', 'git-hooks', 'post-commit')

let checks = 0
let failures = 0
function check(name, ok, detail) {
  checks += 1
  if (ok) {
    console.log('  ok   ' + name)
    return
  }
  failures += 1
  console.error('  FAIL ' + name + (detail ? ' -> ' + detail : ''))
}
const eq = (name, actual, expected) => check(name, Object.is(actual, expected), 'got ' + JSON.stringify(actual) + ' want ' + JSON.stringify(expected))

const mod = await import(pathToFileURL(toolPath).href)
const { syncOnce, inspectSync, installHook, classifyGitError, parseLsRemote, exitCodeFor, parseProxyTarget, readProxyConfig } = mod

// ── 0. 文件层：格式约定与「不许做的事」──────────────────────────────────
console.log('0. 文件层')
const toolRaw = fs.readFileSync(toolPath)
const toolSrc = toolRaw.toString('utf8')
check('github-sync.mjs 无 BOM', !(toolRaw[0] === 0xef && toolRaw[1] === 0xbb && toolRaw[2] === 0xbf))
check('github-sync.mjs 是 LF（无游离 CR）', !toolSrc.includes('\r'))
check('github-sync.mjs 不 import @deepseek-ai/*', !/@deepseek-ai\//.test(toolSrc))
check('github-sync.mjs 不硬编码本机绝对路径', !/[A-Za-z]:\\\\Users|[A-Za-z]:\/Users/.test(toolSrc), '只许用 git 自己报的路径')
check('永不 force push（只有 --force / --force-with-lease 才算违规）', !/--force/.test(toolSrc))
check('push 参数里没有配置里的 force 覆盖', !/'push'[\s\S]{0,80}force/.test(toolSrc))
check('不弹认证窗口（GIT_TERMINAL_PROMPT=0）', toolSrc.includes("GIT_TERMINAL_PROMPT: '0'"))
check('不弹 GCM 交互窗口（GCM_INTERACTIVE=never）', toolSrc.includes("GCM_INTERACTIVE: 'never'"))
check('每条 git 命令都带超时（execFile timeout）', toolSrc.includes('timeout,'))

const hookRaw = fs.readFileSync(hookPath)
const hookText = hookRaw.toString('utf8')
check('钩子文件 ASCII only（Windows 上要经 sh 读）', [...hookText].every((ch) => ch.charCodeAt(0) < 128))
check('钩子文件是 LF', !hookText.includes('\r'))
check('钩子文件无 BOM', !(hookRaw[0] === 0xef))
check('钩子以 #!/bin/sh 开头', hookText.startsWith('#!/bin/sh'))
check('钩子用后台执行（不拖慢提交）', /node "\$sync" --from-hook[^\n]*&\s*$/m.test(hookText))
check('钩子无论如何 exit 0（提交不许失败）', (hookText.match(/exit 0/g) || []).length >= 2)
check('钩子认 SUPERPI_GIT_SYNC=0 关闭开关', hookText.includes('SUPERPI_GIT_SYNC'))
check('钩子找不到 node 就安静退出', hookText.includes('command -v node'))

const attributes = fs.readFileSync(path.join(root, '.gitattributes'), 'utf8')
check('.gitattributes 钉死 *.ps1 为 LF', /\*\.ps1\s+text\s+eol=lf/.test(attributes))
check('.gitattributes 钉死 *.bat 为 CRLF', /\*\.bat\s+text\s+eol=crlf/.test(attributes))
check('.gitattributes 钉死钩子目录为 LF（无扩展名的 sh 脚本）', /tools\/git-hooks\/\*\s+text\s+eol=lf/.test(attributes))
check('.gitattributes 钉死 *.mjs 为 LF（门禁读工作区字节）', /\*\.mjs\s+text\s+eol=lf/.test(attributes))

// ── 1. 纯函数：错误分类 / ls-remote 解析 / 退出码 ────────────────────────
console.log('1. 纯函数')
eq('没网：域名解析失败 → offline', classifyGitError('fatal: unable to access \'https://github.com/x\': Could not resolve host: github.com'), 'offline')
eq('没网：连接被拒 → offline', classifyGitError('fatal: unable to access \'http://127.0.0.1:1/x.git\': Failed to connect to 127.0.0.1 port 1: Connection refused'), 'offline')
eq('没网：命令超时被 kill → offline', classifyGitError('whatever', { killed: true }), 'offline')
eq('认证：终端不能提问 → auth', classifyGitError('fatal: could not read Username for \'https://github.com\': terminal prompts disabled'), 'auth')
eq('认证：权限不足 → auth', classifyGitError('git@github.com: Permission denied (publickey).'), 'auth')
eq('认证：403 → auth（不是离线，别静默重试）', classifyGitError('remote: The requested URL returned error: 403'), 'auth')
eq('分叉：non-fast-forward → rejected', classifyGitError(' ! [rejected]        master -> master (non-fast-forward)'), 'rejected')
eq('分叉：fetch first → rejected', classifyGitError(' ! [rejected]        master -> master (fetch first)'), 'rejected')
eq('其它 → failed（不许装成离线）', classifyGitError('fatal: not a git repository (or any of the parent directories)'), 'failed')
eq('空 stderr → failed', classifyGitError(''), 'failed')

// 代理：实测事故（2026-11-19）—— `~/.gitconfig` 指向 socks5h://127.0.0.1:10808，
// 代理没启动，而直连 github 是通的，同步却永远报「没网」并静默重试。
const realProxyStderr = 'fatal: unable to access \'https://github.com/lwaaron/superpi.git/\': Failed to connect to 127.0.0.1 port 10808 after 2088 ms: Could not connect to server'
eq('代理：代理指向的那个端点在 stderr 里 → proxy（不是 offline）', classifyGitError(realProxyStderr, { proxy: parseProxyTarget('socks5h://127.0.0.1:10808') }), 'proxy')
eq('代理：没配代理时同一条 stderr → offline（真断网）', classifyGitError(realProxyStderr, {}), 'offline')
eq('代理：没给 extra 也不许崩', classifyGitError(realProxyStderr), 'offline')
eq('代理：git 自己的 proxy 报错 → proxy', classifyGitError('fatal: unable to access \'https://github.com/x\': Proxy CONNECT aborted'), 'proxy')
eq('代理：配了代理但故障不涉及它 → offline（不许乱推给代理）', classifyGitError('fatal: unable to access \'https://github.com/x\': Could not resolve host: github.com', { proxy: parseProxyTarget('socks5h://127.0.0.1:10808') }), 'offline')
eq('代理：host 对上但 port 不对 → offline（宁可少判）', classifyGitError('fatal: unable to access \'x\': Failed to connect to 127.0.0.1 port 9999: Connection refused', { proxy: parseProxyTarget('socks5h://127.0.0.1:10808') }), 'offline')
eq('代理：端口是 1 时不许把 10808 当自己（边界）', classifyGitError('fatal: unable to access \'x\': Failed to connect to 127.0.0.1 port 10808: Could not connect to server', { proxy: parseProxyTarget('socks5h://127.0.0.1:1') }), 'offline')
eq('代理：auth 优先于 proxy（凭据问题不许被代理掩盖）', classifyGitError('fatal: could not read Username for \'https://github.com\' port 10808: terminal prompts disabled', { proxy: parseProxyTarget('socks5h://127.0.0.1:10808') }), 'auth')
eq('代理解析：socks5h 带端口', JSON.stringify(parseProxyTarget('socks5h://127.0.0.1:10808')), JSON.stringify({ raw: 'socks5h://127.0.0.1:10808', host: '127.0.0.1', port: '10808' }))
eq('代理解析：带帐号密码与路径', JSON.stringify(parseProxyTarget('http://user:pw@proxy.local:8080/')), JSON.stringify({ raw: 'http://user:pw@proxy.local:8080/', host: 'proxy.local', port: '8080' }))
eq('代理解析：只有主机', JSON.stringify(parseProxyTarget('proxy.local')), JSON.stringify({ raw: 'proxy.local', host: 'proxy.local', port: '' }))
eq('代理解析：空串', JSON.stringify(parseProxyTarget('')), JSON.stringify({ raw: '', host: '', port: '' }))

const refs = parseLsRemote('1111111111111111111111111111111111111111\trefs/heads/master\n2222222222222222222222222222222222222222\trefs/heads/dev\nnot a ref line\n')
eq('ls-remote：master 的 sha', refs.get('refs/heads/master'), '1111111111111111111111111111111111111111')
eq('ls-remote：dev 的 sha', refs.get('refs/heads/dev'), '2222222222222222222222222222222222222222')
eq('ls-remote：杂项行被忽略', refs.size, 2)
eq('ls-remote：空输入', parseLsRemote('').size, 0)

eq('退出码：pushed → 0', exitCodeFor('pushed'), 0)
eq('退出码：up-to-date → 0', exitCodeFor('up-to-date'), 0)
eq('退出码：offline → 2（留给下次补推，不算失败）', exitCodeFor('offline'), 2)
eq('退出码：proxy → 3（要人处理，不能当成离线永远重试）', exitCodeFor('proxy'), 3)
eq('退出码：rejected → 3（要人处理）', exitCodeFor('rejected'), 3)
eq('退出码：auth → 3（要人处理）', exitCodeFor('auth'), 3)
eq('退出码：busy → 0（另一个同步在跑不是错）', exitCodeFor('busy'), 0)
eq('退出码：failed → 1', exitCodeFor('failed'), 1)

// ── 2. 真 git：临时仓库里跑完整流程 ──────────────────────────────────────
console.log('2. 真 git（临时仓库）')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'superpi-sync-'))
// 门禁必须与环境无关：本机 `~/.gitconfig` 里可能配着代理（实测就有一台机器指向
// 已停的 `socks5h://127.0.0.1:10808`，那会让「127.0.0.1:1 = 断网」这条用例
// 真的走代理、真的报 proxy）—— 门禁读本机配置，等于结论由别人的机器决定。
// GIT_CONFIG_GLOBAL 指向临时空文件 + GIT_CONFIG_NOSYSTEM 一起封掉外部影响。
const emptyGitConfig = path.join(tmp, 'gitconfig-empty')
fs.writeFileSync(emptyGitConfig, '')
process.env.GIT_CONFIG_GLOBAL = emptyGitConfig
process.env.GIT_CONFIG_NOSYSTEM = '1'
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete process.env[key]
const ID = ['-c', 'user.name=Sync Test', '-c', 'user.email=sync@example.test', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=master']
function git(cwd, args) {
  const res = spawnSync('git', [...ID, ...args], { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  return { code: res.status === null ? 1 : res.status, out: String(res.stdout || '').trim(), err: String(res.stderr || '').trim() }
}
function mustGit(cwd, args) {
  const res = git(cwd, args)
  if (res.code !== 0) throw new Error('git ' + args.join(' ') + ' 失败：' + res.err)
  return res
}
const posix = (p) => p.replace(/\\/g, '/')
function makeRepo(name, remoteUrl) {
  const dir = path.join(tmp, name)
  fs.mkdirSync(dir, { recursive: true })
  mustGit(dir, ['init', '-q'])
  fs.writeFileSync(path.join(dir, 'file.txt'), name + '\n')
  mustGit(dir, ['add', 'file.txt'])
  mustGit(dir, ['commit', '-q', '-m', 'init'])
  if (remoteUrl) mustGit(dir, ['remote', 'add', 'origin', remoteUrl])
  return dir
}

try {
  // 2.1 正常推送
  const bare = path.join(tmp, 'remote.git')
  mustGit(tmp, ['init', '-q', '--bare', 'remote.git'])
  const work = makeRepo('work', posix(bare))
  const first = await syncOnce({ cwd: work, timeoutMs: 20000 })
  eq('首次同步 → pushed', first.status, 'pushed')
  eq('线上分支 ref 与本地 HEAD 相同', mustGit(bare, ['rev-parse', 'master']).out, mustGit(work, ['rev-parse', 'HEAD']).out)
  check('同步后不留锁文件', !fs.existsSync(path.join(work, '.git', 'superpi-sync.lock')))
  check('同步会往 .git/superpi-sync.log 追加一行', fs.existsSync(path.join(work, '.git', 'superpi-sync.log')) && fs.readFileSync(path.join(work, '.git', 'superpi-sync.log'), 'utf8').includes('pushed'))

  // 2.2 线上已是最新 → 不重复推
  const second = await syncOnce({ cwd: work, timeoutMs: 20000 })
  eq('再同步一次 → up-to-date', second.status, 'up-to-date')

  // 2.3 新提交 → 又推上去（这就是「每次新版本都同步」）
  mustGit(work, ['commit', '-q', '--allow-empty', '-m', 'release 0.9.1'])
  const third = await syncOnce({ cwd: work, timeoutMs: 20000 })
  eq('新提交后 → pushed', third.status, 'pushed')
  eq('线上跟着前进', mustGit(bare, ['rev-parse', 'master']).out, mustGit(work, ['rev-parse', 'HEAD']).out)

  // 2.4 tag 一起推（版本号必须有 tag 才算发布）
  mustGit(work, ['tag', '-a', 'v9.9.9', '-m', 'test tag'])
  const withTag = await syncOnce({ cwd: work, timeoutMs: 20000 })
  eq('tag 单独补推 → up-to-date', withTag.status, 'up-to-date')
  eq('tag 推送结果 ok', withTag.tags.status, 'ok')
  eq('线上能看到 tag', mustGit(bare, ['rev-parse', 'v9.9.9']).out, mustGit(work, ['rev-parse', 'v9.9.9']).out)

  // 2.5 有别的同步在跑 → busy（不抢锁）
  fs.writeFileSync(path.join(work, '.git', 'superpi-sync.lock'), String(Date.now()))
  const busy = await syncOnce({ cwd: work, timeoutMs: 20000 })
  eq('锁被占着 → busy', busy.status, 'busy')
  const stale = Date.now() - 600000
  fs.writeFileSync(path.join(work, '.git', 'superpi-sync.lock'), String(stale))
  const takeover = await syncOnce({ cwd: work, timeoutMs: 20000 })
  eq('残留锁（10 分钟前）会被接管 → up-to-date', takeover.status, 'up-to-date')
  check('接管后锁被释放', !fs.existsSync(path.join(work, '.git', 'superpi-sync.lock')))

  // 2.6 没配远端
  const lone = makeRepo('lone', '')
  eq('没有 origin → no-remote', (await syncOnce({ cwd: lone, timeoutMs: 8000 })).status, 'no-remote')

  // 2.7 断网：本地提交必须留住，结论必须是 offline
  const offlineRepo = makeRepo('offline', 'http://127.0.0.1:1/none.git')
  eq('门禁用例的前提：这个仓库读不到任何代理', (await readProxyConfig(offlineRepo)).raw, '')
  let refusal = git(offlineRepo, ['ls-remote', '--heads', 'origin'])
  if (refusal.code === 0) {
    check('断网用例可用（本机 127.0.0.1:1 必须是拒连）', false, 'ls-remote 竟然成功了，这条用例失效')
  } else {
    mustGit(offlineRepo, ['commit', '-q', '--allow-empty', '-m', 'offline commit'])
    const localHead = mustGit(offlineRepo, ['rev-parse', 'HEAD']).out
    const offline = await syncOnce({ cwd: offlineRepo, timeoutMs: 8000 })
    eq('连不上 → offline', offline.status, 'offline')
    eq('离线时本地提交仍在（不许回滚）', mustGit(offlineRepo, ['rev-parse', 'HEAD']).out, localHead)
    eq('离线时的退出码是 2', exitCodeFor(offline.status), 2)
    check('离线也写进日志（下次补推有据可查）', fs.readFileSync(path.join(offlineRepo, '.git', 'superpi-sync.log'), 'utf8').includes('offline'))
  }

  // 2.7b 代理坏了：必须报 proxy，不许报 offline（实测事故：代理配了但没启动，
  // 同步永远以为「没网」、永远静默重试，而直连是通的）
  const bare3 = path.join(tmp, 'remote3.git')
  mustGit(tmp, ['init', '-q', '--bare', 'remote3.git'])
  const proxied = makeRepo('proxied', 'http://127.0.0.1:9/none.git')
  mustGit(proxied, ['config', 'http.proxy', 'socks5h://127.0.0.1:1'])
  eq('读得到仓库自己的代理配置', (await readProxyConfig(proxied)).raw, 'socks5h://127.0.0.1:1')
  const proxiedHead = mustGit(proxied, ['rev-parse', 'HEAD']).out
  const proxiedResult = await syncOnce({ cwd: proxied, timeoutMs: 15000 })
  eq('代理连不上 → proxy（不是 offline）', proxiedResult.status, 'proxy')
  eq('代理故障的退出码是 3（要人处理，不是等下次）', exitCodeFor(proxiedResult.status), 3)
  eq('代理故障时本地提交仍在', mustGit(proxied, ['rev-parse', 'HEAD']).out, proxiedHead)
  eq('结论里带出代理串（用户要知道去看哪一项）', proxiedResult.proxy && proxiedResult.proxy.raw, 'socks5h://127.0.0.1:1')
  check('日志记的是 proxy 而不是 offline', fs.readFileSync(path.join(proxied, '.git', 'superpi-sync.log'), 'utf8').includes('proxy'))
  const proxiedInfo = await inspectSync({ cwd: proxied, timeoutMs: 15000 })
  eq('只读状态也报 proxy', proxiedInfo.error, 'proxy')

  // 2.8 线上分叉：拒绝 + 绝不强推
  const bare2 = path.join(tmp, 'remote2.git')
  mustGit(tmp, ['init', '-q', '--bare', 'remote2.git'])
  const mine = makeRepo('mine', posix(bare2))
  eq('分叉用例：我方先推成功', (await syncOnce({ cwd: mine, timeoutMs: 20000 })).status, 'pushed')
  const other = path.join(tmp, 'other')
  mustGit(tmp, ['clone', '-q', posix(bare2), posix(other)])
  mustGit(other, ['commit', '-q', '--allow-empty', '-m', 'other side'])
  mustGit(other, ['push', '-q', 'origin', 'master'])
  mustGit(mine, ['commit', '-q', '--allow-empty', '-m', 'mine'])
  const remoteBefore = mustGit(bare2, ['rev-parse', 'master']).out
  const rejected = await syncOnce({ cwd: mine, timeoutMs: 20000 })
  eq('线上有别人的提交 → rejected', rejected.status, 'rejected')
  eq('拒绝后线上 ref 一点没动（没强推）', mustGit(bare2, ['rev-parse', 'master']).out, remoteBefore)
  eq('拒绝后本地提交还在', mustGit(mine, ['rev-parse', 'HEAD']).out !== remoteBefore, true)

  // 2.9 detached / 没有提交 / 关掉开关
  const detachedRepo = makeRepo('detached', '')
  mustGit(detachedRepo, ['checkout', '-q', '--detach'])
  eq('游离 HEAD → detached', (await syncOnce({ cwd: detachedRepo, timeoutMs: 8000 })).status, 'detached')
  const empty = path.join(tmp, 'empty')
  fs.mkdirSync(empty, { recursive: true })
  mustGit(empty, ['init', '-q'])
  eq('还没有提交 → no-commit', (await syncOnce({ cwd: empty, timeoutMs: 8000 })).status, 'no-commit')
  process.env.SUPERPI_GIT_SYNC = '0'
  const disabled = await syncOnce({ cwd: work, timeoutMs: 8000 })
  delete process.env.SUPERPI_GIT_SYNC
  eq('SUPERPI_GIT_SYNC=0 → disabled（一个 git 命令都不跑）', disabled.status, 'disabled')

  // 2.10 只读状态：本地领先多少、钩子装没装
  mustGit(work, ['commit', '-q', '--allow-empty', '-m', 'pending'])
  const info = await inspectSync({ cwd: work })
  eq('状态：可达', info.reachable, true)
  eq('状态：领先 1 个提交', info.ahead, 1)
  eq('状态：落后 0 个', info.behind, 0)
  eq('状态：钩子未装', info.hookInstalled, false)
  const installed = installHook({ cwd: work })
  check('installHook 成功', installed.ok === true)
  check('钩子装到了 .git/hooks/post-commit', fs.existsSync(path.join(work, '.git', 'hooks', 'post-commit')))
  check('装好的钩子与仓库内模板字节相同', fs.readFileSync(path.join(work, '.git', 'hooks', 'post-commit')).equals(hookRaw))
  eq('装完再问状态 → 已有钩子', (await inspectSync({ cwd: work })).hookInstalled, true)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

// ── 3. 接线：脚本、文档、打包边界 ────────────────────────────────────────
console.log('3. 接线')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
eq('npm run sync → tools/github-sync.mjs', pkg.scripts.sync, 'node tools/github-sync.mjs')
eq('npm run hooks → 装 post-commit', pkg.scripts.hooks, 'node tools/github-sync.mjs --install-hooks')
check('tools/ 不进 npm 包（同步工具是开发期工具，不是插件运行时）', !(pkg.files || []).includes('tools'))
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
check('README 写了线上仓库地址', readme.includes('https://github.com/lwaaron/superpi'))
check('README 写了 npm run sync', readme.includes('npm run sync'))
const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8')
check('AGENTS.md 写了「每次提交同步线上」的规矩', agents.includes('npm run sync'))
check('AGENTS.md 说明了离线时只提交本地', /连不上网|离线/.test(agents))

console.log('')
if (failures > 0) {
  console.error('FAILED (' + String(failures) + '/' + String(checks) + ' checks)')
  process.exit(1)
}
console.log('PASS (' + String(checks) + ' checks)')

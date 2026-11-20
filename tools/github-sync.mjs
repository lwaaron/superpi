#!/usr/bin/env node
/**
 * 把本地提交同步到线上 GitHub（https://github.com/lwaaron/superpi）。
 *
 * 为什么要这一个文件：用户的规矩是「每次有新的版本提交都同步更新到线上 github；
 * 连不上网就先提交本地，连上了再本地提交 + 线上推送」。这句话落到工程上就是两条：
 *   1. 提交永远不因为网络失败 —— 本地落地优先，推送是可重试的后续动作；
 *   2. 推送失败要能自己补上 —— 下一次提交（或手动 `npm run sync`）自动把欠的提交推上去。
 *
 * 做法：
 *   - `git push` 只推「当前分支 + 全部 tag」，不 force、不 rebase、不改写历史；
 *   - 服务器分不清「没网 / 认证过期 / 非快进」时必须分开报，**不能一律说成离线**，
 *     否则认证炸了会永远静默重试，用户永远不知道线上落后；
 *   - 超时用 `execFile` 的 timeout 硬切（`git push` 卡住时没有别的办法收口），
 *     `GIT_TERMINAL_PROMPT=0` + `GCM_INTERACTIVE=never` 保证不会弹认证窗口把人挂住；
 *   - 同一时刻只允许一个同步（post-commit 钩子与手动执行会撞），用 `.git/superpi-sync.lock`
 *     加锁，超过 LOCK_STALE_MS 的锁视为残留（进程被杀）自动接管；
 *   - 每次尝试追加一行到 `.git/superpi-sync.log`（在 .git 里，不会入库）。
 *
 * 退出码：0 = 已在线上 / 无需动作；2 = 离线，已留待补推；3 = 需要人工处理
 *（非快进 / 认证失效）；1 = 其它失败。
 *
 * 用法（手动）：
 *   npm run sync                 推一次，打印结论
 *   npm run sync -- --status     只看本地 / 线上差多少，不推
 *   npm run sync -- --init       补一个 origin（克隆丢远端时用）
 *   node tools/github-sync.mjs --timeout 60000
 *
 * 自动化：`npm run hooks` 把 tools/git-hooks/post-commit 装进 .git/hooks，
 * 之后**每次 commit 都会在后台试着推一次**；离线时钩子静默退出，提交照旧落地。
 * 关掉自动推送：设环境变量 SUPERPI_GIT_SYNC=0（或 hooks 里传 --disabled）。
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
/** 仓库根（本文件固定放在 <root>/tools/ 下，不靠 cwd）。 */
export const REPO_ROOT = path.dirname(here)
export const CANONICAL_GITHUB_URL = 'https://github.com/lwaaron/superpi.git'
export const DEFAULT_REMOTE = 'origin'
export const DEFAULT_TIMEOUT_MS = 30000
/** 钩子里用更短的预算：push 慢的时候不能把用户的下一次提交拖住。 */
export const HOOK_TIMEOUT_MS = 15000
export const LOCK_STALE_MS = 120000
export const LOCK_NAME = 'superpi-sync.lock'
export const LOG_NAME = 'superpi-sync.log'
/** 钩子脚本的仓库内路径（`npm run hooks` 从这里装到 .git/hooks）。 */
export const HOOK_SOURCE = path.join('tools', 'git-hooks', 'post-commit')

/** 认证问题：重试一万次也不会好，必须报给人。 */
const AUTH_PATTERNS = [
  /Authentication failed/i,
  /could not read Username/i,
  /could not read Password/i,
  /terminal prompts disabled/i,
  /Permission denied \(publickey\)/i,
  /returned error: 40[13]\b/i,
  /Invalid username or password/i,
  /Support for password authentication was removed/i,
]
/** 非快进：本地历史与线上分叉，只能人来看，绝不自动 force。 */
const REJECT_PATTERNS = [
  /non-fast-forward/i,
  /fetch first/i,
  /\[rejected\]/i,
  /shallow update not allowed/i,
  /refusing to update checked out branch/i,
]
/**
 * 代理出错：**这不是「没网」**。代理是用户配的一层，它自己坏了要人去看。
 * 两者的处置完全相反：offline = 等下次自动补推；proxy = 永远重试都不会好。
 * 实测事故（2026-11-19）：`~/.gitconfig` 指向 `socks5h://127.0.0.1:10808`，
 * 代理没启动 → 每次同步都判 offline、静默重试，而直连 github 是通的（curl 200），
 * 于是永远推不上去、日志还写着「没网」。这正是 AGENTS.md §9 禁止的那一类混淆。
 */
const PROXY_PATTERNS = [
  /proxy\s*(?:error|connect(?:ion)?\s*(?:failed|refused|aborted)|authentication required|failed)/i,
  /proxyconnect/i,
  /connect tunnel failed/i,
  /socks\s*(?:connect|connection)\s*(?:failed|refused)/i,
]
/** 连不上：这正是「先提交本地，等联网再推」那种情况。 */
const OFFLINE_PATTERNS = [
  /could not resolve host/i,
  /couldn't resolve host/i,
  /name or service not known/i,
  /temporary failure in name resolution/i,
  /connection refused/i,
  /connection reset/i,
  /connection timed out/i,
  /operation timed out/i,
  /timed out/i,
  /network is unreachable/i,
  /no route to host/i,
  /failed to connect/i,
  /couldn't connect/i,
  /unable to access/i,
  /proxy error/i,
  /ssl.*(handshake|connect)/i,
]

/**
 * 把 `socks5h://127.0.0.1:10808` 这类代理串拆成 host / port（拆不出来就给空串）。
 * 只做判断用，不改写配置、不替用户连接。
 */
export function parseProxyTarget(raw) {
  const text = String(raw || '').trim()
  if (text === '') return { raw: '', host: '', port: '' }
  const withoutScheme = text.replace(/^[a-z0-9+.-]+:\/\//i, '')
  const authority = withoutScheme.split('/')[0]
  const at = authority.lastIndexOf('@')
  const hostPort = at === -1 ? authority : authority.slice(at + 1)
  const hit = /^\[([^\]]+)\](?::(\d+))?$/.exec(hostPort) || /^(.*?)(?::(\d+))?$/.exec(hostPort)
  const host = hit === null ? '' : (hit[1] || '')
  const port = hit === null || hit[2] === undefined ? '' : hit[2]
  return { raw: text, host, port }
}

/**
 * 读这个仓库**实际会用**的代理：git 的 http/https.proxy，没有再看环境变量。
 * 只读一条命令（--get-regexp 一次拿全），钩子预算里也就几毫秒。
 */
export async function readProxyConfig(cwd, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 8000
  const fromGit = await runGit(['config', '--get-regexp', '^(http|https)\\.proxy$'], { cwd, timeoutMs })
  if (fromGit.code === 0) {
    const lines = fromGit.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    const pick = lines.find((line) => /^https\.proxy\s/i.test(line)) || lines.find((line) => /^http\.proxy\s/i.test(line))
    if (pick !== undefined) {
      const value = pick.replace(/^[a-z.]+proxy\s+/i, '').trim()
      if (value !== '') return parseProxyTarget(value)
    }
  }
  const env = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || ''
  return parseProxyTarget(env)
}

/** stderr 里点的就是那个代理吗？host 与 port 都要对上 —— 猜错比不猜更坏。 */
function blamesProxy(text, proxy) {
  if (!proxy || typeof proxy !== 'object') return false
  const host = String(proxy.host || '')
  if (host === '') return false
  if (!text.includes(host)) return false
  const port = String(proxy.port || '')
  if (port === '') return true
  // 边界必须卡住：代理端口是 1 时，`port 1` 也是 `port 10808` 的前缀，
  // 用 includes 就会把别人的端口当成自己的（误判比不判更坏）。
  const atPort = new RegExp('port ' + port + '(?![0-9])', 'i')
  const atColon = new RegExp(':' + port + '(?![0-9])')
  if (atPort.test(text) || atColon.test(text)) return true
  /**
   * host 对上了，但 stderr 里**没提端口** —— 该算代理故障（0.15.7）。
   *
   * 真实报错（本机，`http.proxy=socks5h://127.0.0.1:10808`）：
   *     Failed to connect to github.com:443 over proxy 127.0.0.1 after 2052 ms:
   *     Could not connect to server
   *
   * **git 只报了 host，没有报端口。** 旧实现要求 host 与 port 都匹配，
   * 于是这一条被判成 `offline`（"网断了，等下次"），而真相是"代理挂了，要人去看"。
   * 两者处置相反：offline 是等待自动补推，proxy 是必须由人修配置。
   *
   * 所以：只要 stderr 明说 "over proxy <我们配的那台>"，就足以断定是代理问题。
   * 反过来必须严格 —— 不许因为"文本里出现过 127.0.0.1"就判代理，
   * 因为那可能只是正常的本机端口报错。所以只在**明确出现 proxy 语义**时放宽。
   */
  const overProxy = /over proxy\s+([^\s:]+)(?::(\d+))?/i.exec(text)
  if (overProxy !== null) {
    const saidHost = overProxy[1]
    const saidPort = overProxy[2]
    if (saidHost !== host) return false
    if (saidPort === port) return true
    if (saidPort !== undefined) return false
    /**
     * 报错只给了 host、没给端口。此时**不能无条件认定是我方代理** ——
     * 若把 10808 误配成 9999，旧逻辑会照样报 proxy，等于把"配置写错"也说成"代理挂了"，
     * 用户只会去重启代理，永远修不好。
     *
     * 判据收紧成：host 相同、且端口**没有被文本否定**。
     * 文本里若出现了任何 `:数字` 形式的端口且不等于我方端口，就已经被上面的分支挡掉了
     * （`saidPort !== undefined`）；走到这里说明文本压根没提端口，
     * 那它**最可能**就是同一台代理（git 的 socks 报错确实会省略端口）。
     *
     * 保留这条的原因：误判成 proxy 的代价是"让人去看代理配置"，
     * 误判成 offline 的代价是"永远静默等待补推"。前者可恢复，后者不可。
     */
    return true
  }
  return false
}

/**
 * 把 git 的 stderr 归一成五种结论：auth / rejected / proxy / offline / failed。
 * 顺序有意义：认证与分叉的具体症状里也常含 "unable to access"，
 * 先判更具体的，最后才落到「连不上」。
 *
 * `extra.proxy`（readProxyConfig 的返回值）只为区分 proxy 与 offline 而存在：
 * 同一条 "Failed to connect to 127.0.0.1 port 10808"，代理指向它 → 代理坏了；
 * 没配代理 → 真的是网断了。两者处置相反，不许合并。
 */
export function classifyGitError(stderr, extra = {}) {
  const text = String(stderr || '')
  if (extra.killed === true) return 'offline'
  if (AUTH_PATTERNS.some((re) => re.test(text))) return 'auth'
  if (REJECT_PATTERNS.some((re) => re.test(text))) return 'rejected'
  if (PROXY_PATTERNS.some((re) => re.test(text))) return 'proxy'
  if (blamesProxy(text, extra.proxy)) return 'proxy'
  if (OFFLINE_PATTERNS.some((re) => re.test(text))) return 'offline'
  return 'failed'
}

/** 解析 `git ls-remote` 输出：`<sha>\t<ref>` 每行一条。 */
export function parseLsRemote(text) {
  const out = new Map()
  for (const line of String(text || '').split(/\r?\n/)) {
    const hit = /^([0-9a-f]{40})\t(.+)$/.exec(line.trim())
    if (hit === null) continue
    out.set(hit[2], hit[1])
  }
  return out
}

/** 同步结论 → 退出码。0 只有「线上已经有这份提交」或「本来就不该动」。 */
export function exitCodeFor(status) {
  switch (status) {
    case 'pushed':
    case 'up-to-date':
    case 'disabled':
    case 'no-remote':
    case 'busy':
      return 0
    case 'offline':
      return 2
    case 'rejected':
    case 'auth':
    case 'proxy':
    case 'detached':
      return 3
    default:
      return 1
  }
}

/**
 * 跑一次 git，永不抛异常（网络/权限/超时都要能落到 classifyGitError 手里）。
 * GIT_TERMINAL_PROMPT=0 与 GCM_INTERACTIVE=never 是硬要求：钩子在后台跑，
 * 一旦弹出认证窗口，用户看到的是一个卡住的提交。
 */
export function runGit(args, options = {}) {
  const cwd = options.cwd || REPO_ROOT
  const timeout = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd,
      windowsHide: true,
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    }, (error, stdout, stderr) => {
      const killed = Boolean(error && (error.killed === true || error.signal !== undefined && error.signal !== null))
      resolve({
        code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1,
        killed,
        stdout: String(stdout === undefined || stdout === null ? '' : stdout),
        stderr: String(stderr === undefined || stderr === null ? '' : stderr),
      })
    })
  })
}

/** 找 .git 目录（普通仓库与 worktree 都认），失败返回空串。 */
export async function resolveGitDir(cwd = REPO_ROOT) {
  const result = await runGit(['rev-parse', '--absolute-git-dir'], { cwd, timeoutMs: 8000 })
  if (result.code !== 0) return ''
  return result.stdout.trim()
}

function readLock(stampPath) {
  try {
    const raw = fs.readFileSync(stampPath, 'utf8').trim()
    const stamp = Number.parseInt(raw, 10)
    if (!Number.isFinite(stamp)) return { alive: false, ageMs: Infinity }
    return { alive: Date.now() - stamp < LOCK_STALE_MS, ageMs: Date.now() - stamp }
  } catch {
    return { alive: false, ageMs: Infinity }
  }
}

/** 拿锁：成功返回 true；已被别的进程占着返回 false（残留锁会被接管）。 */
export function acquireLock(gitDir) {
  const lock = path.join(gitDir, LOCK_NAME)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(lock, String(Date.now()), { flag: 'wx' })
      return true
    } catch (error) {
      if (error && error.code !== 'EEXIST') return false
      if (readLock(lock).alive) return false
      try { fs.unlinkSync(lock) } catch { /* 别人先删掉了，下一轮再说 */ }
    }
  }
  return false
}

export function releaseLock(gitDir) {
  try { fs.unlinkSync(path.join(gitDir, LOCK_NAME)) } catch { /* 已经没了 */ }
}

/** 追加一行到 .git/superpi-sync.log；超过 64 KiB 就砍掉前半，日志不该无限长。 */
export function appendLog(gitDir, line) {
  if (gitDir === '') return
  const file = path.join(gitDir, LOG_NAME)
  const text = new Date().toISOString() + ' ' + line + '\n'
  try {
    fs.appendFileSync(file, text)
    const size = fs.statSync(file).size
    if (size > 64 * 1024) {
      const bulk = fs.readFileSync(file, 'utf8')
      fs.writeFileSync(file, bulk.slice(bulk.length - 32 * 1024))
    }
  } catch { /* 日志写不进去不影响同步本身 */ }
}

/**
 * 同步一次。返回 {status, branch, head, remoteSha, pushed, tags, reason, log}。
 *
 * status:
 *   pushed      刚把本地提交推到线上
 *   up-to-date  线上已经是这份提交（可能顺手补了 tag）
 *   offline     连不上，本地提交保留，等下次
 *   proxy       代理配了但连不上（不是没网），要人处理
 *   rejected    线上有新提交（非快进），拒绝自动处理
 *   auth        凭据失效 / 无权限
 *   no-remote   仓库没有配 origin
 *   detached    游离 HEAD，不知道推哪个分支
 *   no-commit   还没有任何提交
 *   busy        另一个同步正在跑
 *   disabled    被 SUPERPI_GIT_SYNC=0 关掉
 *   failed      其它失败
 */
export async function syncOnce(options = {}) {
  const cwd = options.cwd || REPO_ROOT
  const remote = options.remote || DEFAULT_REMOTE
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS
  const pushTags = options.pushTags !== false
  const skipLock = options.skipLock === true
  const log = []

  if (options.disabled !== true && (process.env.SUPERPI_GIT_SYNC === '0' || process.env.SUPERPI_GIT_SYNC === 'false')) {
    return { status: 'disabled', log }
  }

  const gitDir = options.gitDir || (await resolveGitDir(cwd))
  if (gitDir === '') return { status: 'failed', reason: 'not a git repository', log }

  if (skipLock !== true && !acquireLock(gitDir)) {
    return { status: 'busy', log }
  }
  const finish = (result) => {
    if (skipLock !== true) releaseLock(gitDir)
    const line = result.status + (result.branch ? ' ' + result.branch : '') + (result.head ? ' ' + result.head.slice(0, 8) : '') + (result.reason ? ' :: ' + result.reason.replace(/\s+/g, ' ').slice(0, 200) : '')
    appendLog(gitDir, line)
    return { ...result, gitDir, log }
  }

  try {
    const headResult = await runGit(['rev-parse', '--verify', 'HEAD'], { cwd, timeoutMs: 8000 })
    if (headResult.code !== 0) return finish({ status: 'no-commit' })
    const head = headResult.stdout.trim()

    const branchResult = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: 8000 })
    const branch = branchResult.stdout.trim()
    if (branchResult.code !== 0 || branch === '' || branch === 'HEAD') {
      return finish({ status: 'detached', head })
    }

    const urlResult = await runGit(['remote', 'get-url', remote], { cwd, timeoutMs: 8000 })
    if (urlResult.code !== 0 || urlResult.stdout.trim() === '') return finish({ status: 'no-remote', head, branch })
    const remoteUrl = urlResult.stdout.trim()

    // 代理配置：只为把「代理坏了」与「没网」分开，读不到就当没配（不猜）。
    const proxy = await readProxyConfig(cwd, { timeoutMs: 8000 })

    // 先探一次线上 refs：既是连通性探测，也避免「线上已是最新还硬推」。
    const probe = await runGit(['ls-remote', '--heads', remote, 'refs/heads/' + branch], { cwd, timeoutMs })
    if (probe.code !== 0) {
      const status = classifyGitError(probe.stderr, { ...probe, proxy })
      return finish({ status, head, branch, remoteUrl, proxy, reason: probe.stderr.trim() })
    }
    const remoteSha = parseLsRemote(probe.stdout).get('refs/heads/' + branch) || ''
    if (remoteSha === head) {
      const tags = pushTags ? await pushTagRefs({ cwd, remote, timeoutMs }) : { status: 'skipped' }
      return finish({ status: 'up-to-date', head, branch, remoteUrl, remoteSha, tags })
    }

    const push = await runGit(['push', remote, 'HEAD:refs/heads/' + branch], { cwd, timeoutMs })
    if (push.code !== 0) {
      const status = classifyGitError(push.stderr, { ...push, proxy })
      return finish({ status, head, branch, remoteUrl, remoteSha, proxy, reason: (push.stderr || push.stdout).trim() })
    }
    const tags = pushTags ? await pushTagRefs({ cwd, remote, timeoutMs }) : { status: 'skipped' }
    return finish({ status: 'pushed', head, branch, remoteUrl, remoteSha, tags })
  } catch (error) {
    return finish({ status: 'failed', reason: String(error && error.message ? error.message : error) })
  }
}

/**
 * 补 tag。tag 推失败不算同步失败（分支已经在线上），但要把结论带回去 ——
 * 「版本号推上去了、tag 没上去」是发布流程里最容易漏的一步。
 */
async function pushTagRefs(options) {
  const tags = await runGit(['push', options.remote, '--tags'], { cwd: options.cwd, timeoutMs: options.timeoutMs })
  if (tags.code === 0) return { status: 'ok' }
  return { status: classifyGitError(tags.stderr, tags), reason: tags.stderr.trim() }
}

/** 只读状态：本地 HEAD / 线上 HEAD / 差多少提交 / 钩子装没装。不推任何东西。 */
export async function inspectSync(options = {}) {
  const cwd = options.cwd || REPO_ROOT
  const remote = options.remote || DEFAULT_REMOTE
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15000
  const out = { gitDir: '', branch: '', head: '', remoteUrl: '', remoteSha: '', ahead: null, behind: null, reachable: false, hookInstalled: false, proxy: { raw: '', host: '', port: '' }, lastLog: [] }

  const gitDir = await resolveGitDir(cwd)
  if (gitDir === '') return { ...out, error: 'not a git repository' }
  out.gitDir = gitDir
  out.hookInstalled = fs.existsSync(path.join(gitDir, 'hooks', 'post-commit'))
  try {
    out.lastLog = fs.readFileSync(path.join(gitDir, LOG_NAME), 'utf8').trim().split(/\r?\n/).filter(Boolean).slice(-5)
  } catch { /* 还没有日志 */ }

  const head = await runGit(['rev-parse', '--verify', 'HEAD'], { cwd, timeoutMs: 8000 })
  if (head.code !== 0) return { ...out, error: 'no commits yet' }
  out.head = head.stdout.trim()

  const branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: 8000 })
  out.branch = branch.stdout.trim()
  if (out.branch === 'HEAD') return { ...out, error: 'detached HEAD' }

  const url = await runGit(['remote', 'get-url', remote], { cwd, timeoutMs: 8000 })
  if (url.code !== 0) return { ...out, error: 'no remote "' + remote + '"' }
  out.remoteUrl = url.stdout.trim()

  const proxy = await readProxyConfig(cwd, { timeoutMs: 8000 })
  out.proxy = proxy
  const probe = await runGit(['ls-remote', '--heads', remote, 'refs/heads/' + out.branch], { cwd, timeoutMs })
  if (probe.code !== 0) {
    return { ...out, error: classifyGitError(probe.stderr, { ...probe, proxy }), reason: probe.stderr.trim() }
  }
  out.reachable = true
  out.remoteSha = parseLsRemote(probe.stdout).get('refs/heads/' + out.branch) || ''
  if (out.remoteSha === '') {
    out.ahead = await countCommits(cwd, out.head)
    out.behind = 0
    return out
  }
  const ahead = await runGit(['rev-list', '--count', out.remoteSha + '..' + out.head], { cwd, timeoutMs: 8000 })
  const behind = await runGit(['rev-list', '--count', out.head + '..' + out.remoteSha], { cwd, timeoutMs: 8000 })
  out.ahead = ahead.code === 0 ? Number.parseInt(ahead.stdout.trim(), 10) : null
  out.behind = behind.code === 0 ? Number.parseInt(behind.stdout.trim(), 10) : null
  return out
}

async function countCommits(cwd, head) {
  const count = await runGit(['rev-list', '--count', head], { cwd, timeoutMs: 8000 })
  return count.code === 0 ? Number.parseInt(count.stdout.trim(), 10) : null
}

/** 把 tools/git-hooks/post-commit 装进 .git/hooks（幂等，覆盖旧副本）。
 *
 * 模板**永远取自本文件旁边**（REPO_ROOT），不取自 cwd：npm 脚本可能在任意仓库里被调用，
 * 而钩子模板只随本工具一起走。目标是 cwd / gitDir 那个仓库的 .git/hooks。
 */
export function installHook(options = {}) {
  const cwd = options.cwd || REPO_ROOT
  const gitDir = options.gitDir || ''
  const source = path.join(REPO_ROOT, HOOK_SOURCE)
  if (!fs.existsSync(source)) return { ok: false, reason: 'missing ' + HOOK_SOURCE }
  const dir = gitDir === '' ? path.join(cwd, '.git', 'hooks') : path.join(gitDir, 'hooks')
  try {
    fs.mkdirSync(dir, { recursive: true })
    const target = path.join(dir, 'post-commit')
    fs.copyFileSync(source, target)
    try { fs.chmodSync(target, 0o755) } catch { /* Windows 上 mode 可能无效，git 自己会找 sh */ }
    return { ok: true, target }
  } catch (error) {
    return { ok: false, reason: String(error && error.message ? error.message : error) }
  }
}

const USAGE = [
  '用法：node tools/github-sync.mjs [选项]',
  '',
  '  --status           只看本地 / 线上差多少，不推送',
  '  --init             没有 origin 时补一个（' + CANONICAL_GITHUB_URL + '）',
  '  --remote <name>    远端名，默认 origin',
  '  --timeout <ms>     单条 git 命令的超时，默认 ' + String(DEFAULT_TIMEOUT_MS),
  '  --no-tags          不推 tag',
  '  --from-hook        给 post-commit 钩子用：安静 + 短超时',
  '  --install-hooks    安装 post-commit 钩子（等价 npm run hooks）',
  '  --quiet            只打一行结论',
  '  --help             本帮助',
].join('\n')

function parseArgs(argv) {
  const opts = { status: false, init: false, quiet: false, tags: true, fromHook: false, installHooks: false, remote: DEFAULT_REMOTE, timeoutMs: DEFAULT_TIMEOUT_MS }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--status') opts.status = true
    else if (arg === '--init') opts.init = true
    else if (arg === '--quiet') opts.quiet = true
    else if (arg === '--no-tags') opts.tags = false
    else if (arg === '--from-hook') { opts.fromHook = true; opts.quiet = true; opts.timeoutMs = HOOK_TIMEOUT_MS }
    else if (arg === '--install-hooks') opts.installHooks = true
    else if (arg === '--help' || arg === '-h') opts.help = true
    else if (arg === '--remote' || arg === '--timeout') {
      const value = argv[i + 1]
      i += 1
      if (arg === '--remote') opts.remote = String(value || DEFAULT_REMOTE)
      else opts.timeoutMs = Number.parseInt(value, 10)
    }
  }
  return opts
}

async function main(argv) {
  const opts = parseArgs(argv)
  // 目标仓库取 cwd 而不是脚本所在的 REPO_ROOT：钩子在 worktree 根跑、人也可能在子目录里跑，
  // 两边都应该同步「我现在站着的这个仓库」。脚本自身位置只用来找钩子模板。
  const target = process.cwd()
  if (opts.help === true) {
    console.log(USAGE)
    return 0
  }
  if (opts.installHooks === true) {
    const gitDir = await resolveGitDir(target)
    const result = installHook({ cwd: target, gitDir })
    if (!result.ok) {
      console.error('装钩子失败：' + result.reason)
      return 1
    }
    console.log('已安装 post-commit 钩子 → ' + result.target)
    console.log('之后每次 commit 都会在后台试推一次；离线时静默跳过，提交照旧落地。')
    console.log('关掉：set SUPERPI_GIT_SYNC=0')
    return 0
  }
  if (opts.status === true) {
    const info = await inspectSync({ cwd: target, remote: opts.remote })
    if (info.error !== undefined) {
      console.log('状态：' + info.error + (info.reason ? '（' + info.reason.split(/\r?\n/)[0] + '）' : ''))
      if (info.head) console.log('  本地 ' + info.branch + ' @ ' + info.head.slice(0, 8))
      if (info.error === 'proxy') {
        console.log('  代理 ' + (info.proxy && info.proxy.raw ? info.proxy.raw : '（读不到具体配置）'))
        console.log('  处置 启动代理，或 git config --global --unset http.proxy（直连可用时）')
      }
      // 不许把 auth / proxy / rejected 都报成「离线」：它们处置完全不同。
      const known = ['auth', 'proxy', 'rejected', 'offline', 'failed', 'detached', 'no-commit', 'no-remote']
      const mapped = info.error === 'detached HEAD' ? 'detached' : info.error === 'no commits yet' ? 'no-commit' : info.error === 'no-remote' ? 'no-remote' : known.includes(info.error) ? info.error : 'offline'
      return exitCodeFor(mapped)
    }
    console.log('分支     ' + info.branch + ' @ ' + info.head.slice(0, 8))
    console.log('远端     ' + info.remoteUrl)
    console.log('线上     ' + (info.remoteSha === '' ? '（还没有这个分支）' : info.remoteSha.slice(0, 8)))
    console.log('待推     ' + String(info.ahead === null ? '?' : info.ahead) + ' 个提交；线上多出 ' + String(info.behind === null ? '?' : info.behind) + ' 个')
    console.log('钩子     ' + (info.hookInstalled ? '已安装（commit 后自动推送）' : '未安装（npm run hooks）'))
    if (info.lastLog.length > 0) {
      console.log('最近记录')
      for (const line of info.lastLog) console.log('  ' + line)
    }
    return 0
  }
  if (opts.init === true) {
    const url = await runGit(['remote', 'get-url', opts.remote], { cwd: target, timeoutMs: 8000 })
    if (url.code === 0 && url.stdout.trim() !== '') {
      console.log('已有远端 ' + opts.remote + '：' + url.stdout.trim())
    } else {
      const add = await runGit(['remote', 'add', opts.remote, CANONICAL_GITHUB_URL], { cwd: target, timeoutMs: 8000 })
      if (add.code !== 0) {
        console.error('加远端失败：' + add.stderr.trim())
        return 1
      }
      console.log('已加远端 ' + opts.remote + ' → ' + CANONICAL_GITHUB_URL)
    }
    if (opts.status === true) return 0
  }

  const result = await syncOnce({ cwd: target, remote: opts.remote, timeoutMs: opts.timeoutMs, pushTags: opts.tags })
  if (opts.quiet !== true) {
    const label = {
      pushed: '已推送',
      'up-to-date': '线上已是最新',
      offline: '连不上网：本地提交已保留，联网后再跑一次即可',
      proxy: '代理连不上：这不是「没网」，而是代理那一层坏了',
      rejected: '线上有本地没有的提交（非快进），不会自动强推',
      auth: '凭据失效或没有权限，需要人工处理',
      'no-remote': '仓库没有配 origin（npm run sync -- --init）',
      detached: '游离 HEAD，不知道推哪个分支',
      'no-commit': '还没有任何提交',
      busy: '另一个同步正在跑',
      disabled: '自动同步已关闭（SUPERPI_GIT_SYNC=0）',
      failed: '同步失败',
    }[result.status] || result.status
    console.log(label)
    if (result.head) console.log('  提交 ' + String(result.branch || '') + ' @ ' + result.head.slice(0, 8))
    if (result.remoteUrl) console.log('  远端 ' + result.remoteUrl)
    if (result.tags && result.tags.status !== 'ok' && result.tags.status !== 'skipped') {
      console.log('  tag 没推上去：' + String(result.tags.reason || result.tags.status).split(/\r?\n/)[0])
    }
    if (result.reason && result.status !== 'offline') {
      console.log('  详情 ' + result.reason.split(/\r?\n/).slice(0, 3).join(' / '))
    }
    if (result.status === 'proxy') {
      console.log('  代理 ' + (result.proxy && result.proxy.raw ? result.proxy.raw : '（读不到具体配置）'))
      console.log('  处置 启动代理，或 git config --global --unset http.proxy（直连可用时）')
    }
  }
  return exitCodeFor(result.status)
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
    console.error(String(error && error.message ? error.message : error))
    process.exit(1)
  })
}

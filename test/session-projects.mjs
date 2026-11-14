#!/usr/bin/env node
/**
 * 项目层门禁：会话按 cwd 聚合的两级列表（对齐 pi 的 ProjectList + groupSessionsByProject）。
 *
 * 为什么单独一个测试文件：
 *  「历史会话只显示一条」的根因是 host 把空 cwd 回落成 workspace（等价于强制 scope=project），
 *  修法是把「全部项目」变成真正可用的入口。这条路要保证三件事，而它们都只能在离线断言里钉住：
 *  1) 聚合规则与 pi 逐条一致（当前项目置顶 → 非临时 → 最近活动降序），否则面板排序会漂；
 *  2) 临时目录判定用的三条正则与 pi 完全相同，否则单测/探针产生的 tmp 项目会顶到真实项目上面；
 *  3) 跨项目 switch_session 之后的 cwd 只能从会话文件 header 读（get_state 不回报 cwd，
 *     rpc-types.ts:96-109），读错了面板显示的就是 spawn 时的旧目录。
 *
 * 跑法：node test/session-projects.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  groupSessionsByProject,
  isTemporaryPath,
  listAllSessions,
  listSessions,
  pathComparisonKey,
  readSessionCwd,
  sessionDirName,
  shortenHomePath,
} from '../src/session-store.mjs'
import { firstRunningSessionFile } from '../index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)

let failures = 0
let checks = 0
const check = (name, condition, detail) => {
  checks += 1
  if (condition === true) return
  failures += 1
  console.error('  FAIL ' + name + (detail === undefined ? '' : '  [' + String(detail) + ']'))
}
const eq = (name, actual, expected) => check(name, JSON.stringify(actual) === JSON.stringify(expected), JSON.stringify(actual) + ' != ' + JSON.stringify(expected))

console.log('session projects: 两级列表 + 跨项目 cwd')

// ── 1. pathComparisonKey：resolve + win32 小写（对齐 paths.ts:46-50）──────────
eq('key 空串', pathComparisonKey(''), '')
eq('key 非字符串', pathComparisonKey(null), '')
eq('key 去空白', pathComparisonKey('  C:\\work  '), path.posix.normalize('C:/work').toLowerCase().length > 0 ? pathComparisonKey('C:\\work') : '')
check('key 大小写归一（win32）', process.platform !== 'win32' || pathComparisonKey('C:\\Work') === pathComparisonKey('c:\\work'))
check('key 非 win32 保留大小写', process.platform !== 'linux' || pathComparisonKey('/Work') !== pathComparisonKey('/work'))

// ── 2. isTemporaryPath：三条正则逐条对齐 session-selector.ts:760-769 ─────────
check('temp POSIX /tmp/x', isTemporaryPath('/tmp/x') === true)
check('temp POSIX /var/tmp/x', isTemporaryPath('/var/tmp/x') === true)
check('temp appdata local temp', isTemporaryPath('C:\\Users\\PC\\AppData\\Local\\Temp\\a') === true)
check('temp pi-runtime-*', isTemporaryPath('C:\\Temp\\pi-runtime-7f3a') === true)
check('temp 反斜杠也认', isTemporaryPath('C:\\tmp\\x') === true)
check('非 temp 真实项目', isTemporaryPath('C:\\Users\\PC\\pi-workspace') === false)
check('非 temp 名字里含 temp 但不是段', isTemporaryPath('C:\\Users\\PC\\temporary-project') === false)
check('temp 空串不算', isTemporaryPath('') === false)

// ── 3. shortenHomePath（对齐 paths.ts:73-78）────────────────────────────────
const home = os.homedir()
eq('shorten 家目录内', shortenHomePath(path.join(home, 'pi-workspace')), '~' + path.sep + 'pi-workspace')
eq('shorten 家目录本身', shortenHomePath(home), '~')
eq('shorten 家目录外原样', shortenHomePath(path.resolve(path.sep + 'nowhere-xyz')), path.resolve(path.sep + 'nowhere-xyz'))
eq('shorten 相对路径原样', shortenHomePath('relative/path'), 'relative/path')
eq('shorten 空串', shortenHomePath(''), '')

// ── 4. groupSessionsByProject：聚合 + 排序（对齐 session-picker.ts:26-62）────
const iso = minutes => new Date(Date.UTC(2026, 10, 13, 12, minutes, 0)).toISOString()
const grouped = groupSessionsByProject([
  { path: 'a1.jsonl', cwd: 'C:\\work\\alpha', modified: iso(1) },
  { path: 'a2.jsonl', cwd: 'C:\\work\\alpha', modified: iso(9) },
  { path: 'b1.jsonl', cwd: 'C:\\work\\beta', modified: iso(5) },
  { path: 't1.jsonl', cwd: 'C:\\Users\\PC\\AppData\\Local\\Temp\\pi-runtime-x', modified: iso(30) },
  { path: 'c1.jsonl', cwd: 'C:\\work\\current', modified: iso(2) },
], { currentCwd: 'C:\\work\\current' })

eq('聚合出 4 个项目', grouped.length, 4)
eq('当前项目置顶', grouped[0].cwd, 'C:\\work\\current')
check('当前项目 isCurrent', grouped[0].isCurrent === true)
eq('第二是非临时项目（alpha，比 beta 新）', grouped[1].cwd, 'C:\\work\\alpha')
eq('第三是 beta', grouped[2].cwd, 'C:\\work\\beta')
check('最后是临时项目', grouped[3].isTemporary === true)
eq('alpha 合并两条', grouped[1].sessionCount, 2)
eq('alpha lastActivity 取最大值', grouped[1].lastActivity, iso(9))
eq('beta 单条', grouped[2].sessionCount, 1)
check('displayPath 用 ~ 缩写（家目录外的原样）', grouped[1].displayPath === 'C:\\work\\alpha')
check('返回对象不含内部字段 lastActivityMs', grouped[0].lastActivityMs === undefined)

// 大小写不同的同一目录必须合并（Windows 上 junction / 盘符大小写很常见）
const merged = groupSessionsByProject([
  { path: 'a.jsonl', cwd: 'C:\\Work\\Alpha', modified: iso(1) },
  { path: 'b.jsonl', cwd: 'c:\\work\\alpha', modified: iso(2) },
])
if (process.platform === 'win32') eq('大小写不同也合并成一个项目', merged.length, 1)
else eq('非 win32 大小写敏感 → 两个项目', merged.length, 2)

// currentCwd 为空时不允许任何项目被标成 current（否则面板会把错的排到最上）
const noCurrent = groupSessionsByProject([{ path: 'a.jsonl', cwd: 'C:\\work', modified: iso(1) }], { currentCwd: '' })
check('currentCwd 为空时不标 current', noCurrent[0].isCurrent === false)
eq('空输入返回空数组', groupSessionsByProject([], {}), [])
eq('非数组输入返回空数组', groupSessionsByProject(null, {}), [])

// ── 5. listAllSessions / listSessions：扫全部项目 vs 单项目 ───────────────────
// 造一棵符合 pi 目录约定的假 sessions 树：<agentDir>/sessions/<slug>/<file>.jsonl
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pi-projects-'))
const agentDir = path.join(tmpRoot, 'agent')
const sessionsRoot = path.join(agentDir, 'sessions')

const projectDirs = [
  { cwd: 'C:\\work\\alpha', files: [{ name: '2026-11-13T10-00-00-000Z_a.jsonl', messages: 2, at: iso(10) }] },
  { cwd: 'C:\\work\\beta', files: [{ name: '2026-11-13T10-05-00-000Z_b.jsonl', messages: 3, at: iso(20) }] },
]

function writeSession(dir, cwd, file) {
  fs.mkdirSync(dir, { recursive: true })
  const lines = [JSON.stringify({ type: 'session', version: 1, id: 'id-' + file.name, cwd, timestamp: file.at })]
  for (let i = 0; i < file.messages; i += 1) {
    lines.push(JSON.stringify({
      type: 'message',
      timestamp: file.at,
      message: { role: 'user', content: 'hello ' + String(i), timestamp: new Date(file.at).getTime() + i },
    }))
  }
  fs.writeFileSync(path.join(dir, file.name), lines.join('\n') + '\n', 'utf8')
}

for (const project of projectDirs) {
  const dir = path.join(sessionsRoot, sessionDirName(project.cwd))
  for (const file of project.files) writeSession(dir, project.cwd, file)
}

try {
  const all = await listAllSessions({ agentDir, env: {}, home: tmpRoot })
  eq('listAllSessions 扫到全部项目', all.length, 2)
  eq('listAllSessions 按 modified 降序', all.map(info => info.cwd), ['C:\\work\\beta', 'C:\\work\\alpha'])
  check('listAllSessions 带 cwd 字段', all[0].cwd === 'C:\\work\\beta')

  const limited = await listSessions({ agentDir, env: {}, home: tmpRoot, limit: 1 })
  eq('listSessions 截断到 limit', limited.length, 1)
  eq('listSessions 默认 20', (await listSessions({ agentDir, env: {}, home: tmpRoot })).length, 2)

  const one = await listAllSessions({ agentDir, env: {}, home: tmpRoot, cwd: 'C:\\work\\alpha' })
  eq('指定 cwd 只列该项目', one.length, 1)
  eq('指定 cwd 命中 alpha', one[0].cwd, 'C:\\work\\alpha')

  const missing = await listAllSessions({ agentDir, env: {}, home: tmpRoot, cwd: 'C:\\work\\nope' })
  eq('不存在的 cwd 返回空', missing.length, 0)

  // readSessionCwd 是跨项目 switch_session 后校正 meta.cwd 的唯一数据源
  const alphaFile = path.join(sessionsRoot, sessionDirName('C:\\work\\alpha'), projectDirs[0].files[0].name)
  eq('readSessionCwd 读到 header.cwd', await readSessionCwd(alphaFile), 'C:\\work\\alpha')
  eq('readSessionCwd 文件不存在返回空', await readSessionCwd(path.join(tmpRoot, 'nope.jsonl')), '')
  eq('readSessionCwd 非字符串返回空', await readSessionCwd(null), '')

  const bogus = path.join(tmpRoot, 'bogus.jsonl')
  fs.writeFileSync(bogus, JSON.stringify({ type: 'not-a-session', cwd: 'C:\\x' }) + '\n', 'utf8')
  eq('readSessionCwd 首行不是 session 头返回空', await readSessionCwd(bogus), '')

  // 项目层与存储层串起来：group(listAll) 的出参形状必须能直接喂给面板
  const projects = groupSessionsByProject(all, { currentCwd: 'C:\\work\\alpha' })
  eq('group(listAll) 出 2 个项目', projects.length, 2)
  eq('group(listAll) 当前项目置顶', projects[0].cwd, 'C:\\work\\alpha')
  check('group(listAll) 带 displayPath / sessionCount', typeof projects[0].displayPath === 'string' && projects[0].sessionCount === 1)
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
}

// ── 6. firstRunningSessionFile：scope=all 时怎么找「当前会话」────────────────
const running = (sessionFile, state, cwd) => ({ id: 'x', cwd, sessionCwd: cwd, sessionFile, sessionName: null, state })
const known = [{ path: 'a.jsonl' }, { path: 'b.jsonl' }]
eq('无运行会话', firstRunningSessionFile([], known), null)
eq('跨项目也认（sessionFile 在已知列表里）', firstRunningSessionFile([running('b.jsonl', 'ready', 'C:\\other')], known), 'b.jsonl')
eq('sessionFile 不在已知列表里则不算', firstRunningSessionFile([running('z.jsonl', 'ready', 'C:\\other')], known), null)
eq('没传 known 时不校验列表', firstRunningSessionFile([running('z.jsonl', 'ready', 'C:\\other')]), 'z.jsonl')
eq('优先活着的', firstRunningSessionFile([running('a.jsonl', 'dead', 'C:\\w'), running('b.jsonl', 'ready', 'C:\\w')], known), 'b.jsonl')
eq('全死掉退回第一个', firstRunningSessionFile([running('a.jsonl', 'dead', 'C:\\w'), running('b.jsonl', 'dead', 'C:\\w')], known), 'a.jsonl')
eq('忽略空 sessionFile', firstRunningSessionFile([running('', 'ready', 'C:\\w'), running(null, 'ready', 'C:\\w')], known), null)

console.log('')
if (failures > 0) {
  console.error('FAILED (' + String(failures) + '/' + String(checks) + ' checks)')
  process.exit(1)
}
console.log('PASS (' + String(checks) + ' checks)')

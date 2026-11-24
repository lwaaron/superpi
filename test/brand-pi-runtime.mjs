/**
 * test/brand-pi-runtime.mjs —— 品牌配置门禁。
 *
 * 锁住三件事，任一条破了都会让 TUI 界面或历史会话出问题：
 *   1. piConfig.name 必须是 SuperPi（否则 TUI 里还会自称 pi）
 *   2. piConfig.configDir 必须是 .pi（改成别的 → 9 个项目的历史会话全部读不到）
 *   3. 脚本必须幂等（重复 --apply 不重复改写、不破坏 configDir）
 *
 * 全部在临时目录里跑，绝不碰真实的 ~/.pi 与 profile。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { PI_PACKAGE, PI_VERSION } from '../src/pi-runtime.mjs'
import { runtimeSessionOptions } from '../src/runtime-extensions.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)

let checks = 0
function ok(cond, message) {
  checks += 1
  if (!cond) throw new Error('FAIL: ' + message)
}
function eq(actual, expected, message) {
  ok(actual === expected, message + ' (got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected) + ')')
}

const mod = await import('../tools/brand-pi-runtime.mjs')
const { BRAND_NAME, KEEP_CONFIG_DIR, readBrand, applyBrand, revertBrand } = mod

// ① 常量本身
eq(BRAND_NAME, 'SuperPi', '品牌名是 SuperPi')
eq(KEEP_CONFIG_DIR, '.pi', '会话目录必须保持 .pi（否则历史会话读不到）')

// ② 在临时目录造一个假的 pi package.json，验证写入语义
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'superpi-brand-'))
try {
  const fakePi = path.join(tmp, 'package.json')
  const original = {
    name: '@earendil-works/pi-coding-agent',
    version: '1.5.2',
    piConfig: { configDir: '.pi' },
    bin: { pi: 'dist/bundle/cli.js' },
  }
  fs.writeFileSync(fakePi, JSON.stringify(original, null, 2) + '\n')

  // 改名前
  let state = readBrand(fakePi)
  eq(state.branded, false, '改名前未打标')
  eq(state.configDir, '.pi', '改名前 configDir=.pi')

  // 写入
  const first = applyBrand(fakePi)
  eq(first.changed, true, '首次写入生效')
  state = readBrand(fakePi)
  eq(state.name, 'SuperPi', 'name 已写成 SuperPi')
  eq(state.configDir, '.pi', 'configDir 未被改动（关键：历史会话仍可读）')

  // 幂等：再写一次不应改动
  const second = applyBrand(fakePi)
  eq(second.changed, false, '重复写入是幂等的')
  eq(second.reason, 'already branded', '幂等时给出原因')

  // 其它字段不能被吞掉
  const after = JSON.parse(fs.readFileSync(fakePi, 'utf8'))
  eq(after.bin.pi, 'dist/bundle/cli.js', 'bin 字段原样保留')
  eq(after.version, '1.5.2', 'version 原样保留')
  eq(after.name, '@earendil-works/pi-coding-agent', '包名不能被改（那是上游 npm 包名）')

  // 还原
  const rev = revertBrand(fakePi)
  eq(rev.changed, true, '还原生效')
  state = readBrand(fakePi)
  eq(state.name, '', '还原后没有 name')
  eq(state.configDir, '.pi', '还原后 configDir 仍在')

  // ③ configDir 缺省时也会补成 .pi（不能让 pi 回落）
  const noDir = path.join(tmp, 'no-dir.json')
  fs.writeFileSync(noDir, JSON.stringify({ name: 'x', piConfig: {} }, null, 2) + '\n')
  applyBrand(noDir)
  eq(readBrand(noDir).configDir, '.pi', '原文件无 configDir 时补成 .pi')

  // ④ 完全不写 piConfig 的文件也要能处理
  const noCfg = path.join(tmp, 'no-cfg.json')
  fs.writeFileSync(noCfg, JSON.stringify({ name: 'x' }, null, 2) + '\n')
  applyBrand(noCfg)
  const cfgAfter = JSON.parse(fs.readFileSync(noCfg, 'utf8')).piConfig
  eq(cfgAfter.name, 'SuperPi', '没有 piConfig 时新建并用 SuperPi')
  eq(cfgAfter.configDir, '.pi', '没有 piConfig 时也补 .pi')

  const customDir = path.join(tmp, 'custom-dir.json')
  fs.writeFileSync(customDir, JSON.stringify({ ...original, piConfig: { configDir: '.existing-data' } }))
  applyBrand(customDir)
  eq(readBrand(customDir).configDir, '.existing-data', '显式配置目录仍指向现有数据')
  eq(applyBrand(customDir).changed, false, '自定义配置目录下也不重复改写')

  const legacyAgent = path.join(tmp, 'legacy-agent')
  const legacySessions = path.join(tmp, 'legacy-sessions')
  const legacyEnv = { PI_CODING_AGENT_DIR: legacyAgent, PI_CODING_AGENT_SESSION_DIR: legacySessions }
  const brandedAgent = path.join(tmp, 'branded-agent')
  const runtimeDir = path.join(tmp, 'runtime')
  const pkgDir = path.join(runtimeDir, 'node_modules', ...original.name.split('/'))
  const pkgPath = path.join(pkgDir, 'package.json')
  const cliPath = path.join(pkgDir, 'cli.cjs')
  fs.mkdirSync(pkgDir, { recursive: true })
  fs.writeFileSync(pkgPath, JSON.stringify({ ...original, bin: { pi: 'cli.cjs' } }))
  fs.writeFileSync(cliPath, `const cfg = require('./package.json').piConfig
console.log(JSON.stringify({ name: cfg.name, argv: process.argv.slice(1), agent: process.env.SUPERPI_CODING_AGENT_DIR, sessions: process.env.SUPERPI_CODING_AGENT_SESSION_DIR }))\n`)
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  eq(pkg.optionalDependencies[PI_PACKAGE], PI_VERSION, '打包安装与命令行使用相同的运行时版本')
  ok(typeof pkg.bin?.superpi === 'string', '包声明了 SuperPi 命令')
  const launched = spawnSync(process.execPath, [path.resolve(root, pkg.bin.superpi), '--session', '测试.jsonl'], {
    encoding: 'utf8', timeout: 10000,
    env: { ...process.env, SUPERPI_CLI_PATH: '', SUPERPI_RUNTIME_DIR: runtimeDir, SUPERPI_CODING_AGENT_DIR: '', SUPERPI_CODING_AGENT_SESSION_DIR: '', ...legacyEnv },
  })
  eq(launched.status, 0, '品牌 CLI 正常启动选中的运行时：' + launched.stderr)
  const payload = JSON.parse(launched.stdout)
  eq(payload.name, BRAND_NAME, 'CLI 启动前应用品牌配置')
  eq(JSON.stringify(payload.argv), JSON.stringify([cliPath, '--session', '测试.jsonl']), '原样转发 CLI 参数')
  eq(payload.agent, legacyAgent, '品牌 CLI 识别原有的 agent 目录环境变量')
  eq(payload.sessions, legacySessions, '品牌 CLI 识别原有的会话目录环境变量')
  ok(fs.existsSync(path.join(legacyAgent, 'extensions', 'superpi-ask-user.ts')), '首次启动品牌 CLI 即同步询问工具')

  const preferred = runtimeSessionOptions({ packageDir: pkgDir, env: { ...legacyEnv, SUPERPI_CODING_AGENT_DIR: brandedAgent } })
  eq(preferred.agentDir, brandedAgent, '两端优先采用 SuperPi 的配置变量')
  eq(preferred.sessionDir, legacySessions, '两端读取同一份历史会话')
  eq(preferred.envOverrides.SUPERPI_CODING_AGENT_SESSION_DIR, legacySessions, 'RPC 子进程也收到原有会话目录')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

// ⑤ 候选路径不硬编码本机绝对路径
const src = fs.readFileSync(path.join(here, '..', 'tools', 'brand-pi-runtime.mjs'), 'utf8')
ok(!/C:\\\\Users|C:\/Users/.test(src), '脚本里没有硬编码的 C:\\Users 路径')
ok(src.includes('PI_PACKAGE'), '包名走 PI_PACKAGE 常量，不硬编码字符串')

console.log('PASS (' + checks + ' checks)')

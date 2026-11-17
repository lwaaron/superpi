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
import { fileURLToPath } from 'node:url'

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
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

// ⑤ 候选路径不硬编码本机绝对路径
const src = fs.readFileSync(path.join(here, '..', 'tools', 'brand-pi-runtime.mjs'), 'utf8')
ok(!/C:\\\\Users|C:\/Users/.test(src), '脚本里没有硬编码的 C:\\Users 路径')
ok(src.includes('PI_PACKAGE'), '包名走 PI_PACKAGE 常量，不硬编码字符串')

console.log('PASS (' + checks + ' checks)')

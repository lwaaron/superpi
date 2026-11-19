#!/usr/bin/env node
/**
 * 跨项目载体自检 —— 检查「我的通用能力是否还在」。
 *
 * ── 为什么需要这个文件（结构缺陷，不是疏忽）───────────────
 * 用户级载体（`~/.agents/skills/`、`~/.pi/agent/memory/`、`~/.agents/toolkit/`）
 * 不被任何项目依赖，所以：
 *   · 删掉它，**没有项目门禁会红**；
 *   · 任何清理动作（`rm -rf`、`--remove`、批量归档）都可能碰到它；
 *   · 于是它会被"最近的那个操作者"顺手删掉，而无人察觉。
 *
 * 实测：2026-11-19 这一天内，`verified-delivery` / `change-scope` 两个 skill
 * 被删了**两次**。第一次靠手动 `ls` 发现，第二次靠本文件的前身发现。
 * 两次都不是因为"不知道要保留"，而是因为**没有任何东西会因为它的消失而报警**。
 *
 * 修法：给它一个归属者（本文件）、一条会红的判据（下面每一条 check），
 * 并挂进 SuperPi 的 `npm test`。这样它就是有主之物，不再是可被顺手的荒地。
 *
 * 跑法：node tools/check-carriers.mjs
 * 退出码：0 全部在位 / 1 有缺失（会打印修复命令）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const HOME = process.env.USERPROFILE || os.homedir()
const SKILLS_DIR = path.join(HOME, '.agents', 'skills')
const TOOLKIT_DIR = path.join(HOME, '.agents', 'toolkit', 'bin')
const MEMORY_DIR = path.join(HOME, '.pi', 'agent', 'memory')

/** 必须存在的 skill（与 tools/install-pi-extension.mjs 的 SKILL_NAMES 一致）。 */
const REQUIRED_SKILLS = ['verified-delivery', 'change-scope']
/** 必须存在的通用工具。 */
const REQUIRED_TOOLS = ['teeth.mjs', 'condense.mjs', 'check-memory.mjs']
/** 记忆索引里必须登记的笔记数下限。 */
const MIN_NOTES = 7

const problems = []
const fixes = []

function fail(msg, fix) {
  problems.push(msg)
  if (fix) fixes.push(fix)
}

/* ── ① skill ── */
for (const name of REQUIRED_SKILLS) {
  const f = path.join(SKILLS_DIR, name, 'SKILL.md')
  if (!fs.existsSync(f)) {
    fail(`skill 缺失：${name}`, 'node tools/install-pi-extension.mjs --install')
    continue
  }
  const t = fs.readFileSync(f, 'utf8')
  if (!/^---\r?\n[\s\S]*?^name:\s*\S+/m.test(t)) fail(`skill 的 frontmatter 损坏：${name}`, 'node tools/install-pi-extension.mjs --install')
  // 与仓库源逐字节比对：防"装的是旧版本"
  const src = path.join(process.cwd(), 'skills', name, 'SKILL.md')
  if (fs.existsSync(src) && fs.readFileSync(src, 'utf8') !== t) {
    fail(`skill 与仓库源不一致（装的是旧版）：${name}`, 'node tools/install-pi-extension.mjs --install')
  }
}

/* ── ② 工具 ── */
for (const t of REQUIRED_TOOLS) {
  if (!fs.existsSync(path.join(TOOLKIT_DIR, t))) fail(`工具缺失：${t}`, '见 MEMORY.md「通用工具」一节')
}

/* ── ③ 记忆索引与文件一致（复用 check-memory，避免两套判据）── */
if (fs.existsSync(path.join(TOOLKIT_DIR, 'check-memory.mjs'))) {
  try {
    execFileSync(process.execPath, [path.join(TOOLKIT_DIR, 'check-memory.mjs')], { stdio: 'ignore', timeout: 60000 })
  } catch {
    fail('记忆索引校验失败（索引与文件不一致，或摘要过短）', 'node ~/.agents/toolkit/bin/check-memory.mjs')
  }
} else {
  // 没有校验器时退化为"数条目"
  const idx = path.join(MEMORY_DIR, 'MEMORY.md')
  if (!fs.existsSync(idx)) fail('记忆索引不存在', '重建 ~/.pi/agent/memory/MEMORY.md')
  else {
    const n = [...fs.readFileSync(idx, 'utf8').matchAll(/^- \[/gm)].length
    if (n < MIN_NOTES) fail(`记忆条目只有 ${n} 条（应 ≥${MIN_NOTES}）`, '检查是否有笔记被删')
  }
}

/* ── ④ 载体是否真被运行时加载（唯一能证明"装上了"的判据）── */
let loaded = []
try {
  const piDir = path.join(process.cwd(), '.runtime/node_modules/@earendil-works/pi-coding-agent')
  const skillsMod = await import(pathToFileURL(path.join(piDir, 'dist/core/skills.js')).href)
  const r = skillsMod.loadSkills({
    cwd: process.cwd(),
    agentDir: path.join(HOME, '.pi', 'agent'),
    includeDefaults: true,
    skillPaths: [SKILLS_DIR],
  })
  loaded = r.skills.map((s) => s.name)
  for (const name of REQUIRED_SKILLS) {
    if (!loaded.includes(name)) fail(`skill 未被 pi 加载：${name}（目录在但加载器读不到）`, 'node tools/install-pi-extension.mjs --install')
  }
} catch (error) {
  fail(`无法验证运行时加载（${String(error?.message ?? error).slice(0, 80)}）`, '确认 .runtime 下 pi 已安装')
}

/* ── 输出 ── */
console.log('=== 跨项目载体自检 ===')
console.log(`skill 目录 : ${SKILLS_DIR}`)
console.log(`工具目录   : ${TOOLKIT_DIR}`)
console.log(`记忆目录   : ${MEMORY_DIR}`)
console.log('')
console.log(`skill 在位 : ${REQUIRED_SKILLS.filter((n) => fs.existsSync(path.join(SKILLS_DIR, n, 'SKILL.md'))).join(', ') || '(无)'}`)
console.log(`pi 加载到  : ${loaded.join(', ') || '(无)'}`)
console.log(`工具在位   : ${REQUIRED_TOOLS.filter((t) => fs.existsSync(path.join(TOOLKIT_DIR, t))).join(', ') || '(无)'}`)

if (problems.length > 0) {
  console.error('')
  console.error(`FAIL：${problems.length} 项载体缺失或失效`)
  for (const p of problems) console.error('  ✘ ' + p)
  if (fixes.length > 0) {
    console.error('')
    console.error('修复：')
    for (const f of [...new Set(fixes)]) console.error('  $ ' + f)
  }
  process.exit(1)
}
console.log('')
console.log('PASS：全部载体在位且已加载')

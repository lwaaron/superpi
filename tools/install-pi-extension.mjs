#!/usr/bin/env node
/**
 * tools/install-pi-extension.mjs —— 把 SuperPi 的「命令行会话窗口输入框增强」装进 pi。
 *
 * 装的是什么：`extensions/superpi-editor.ts` —— 一个**官方扩展**（继承 pi 公开的
 * `CustomEditor`，通过 `ctx.ui.setEditorComponent()` 换输入框）。它不改 pi 的任何文件，
 * 也不碰 node_modules；卸掉就是删一个 .ts 文件。
 *
 * 落在哪：pi 的全局扩展目录 `<piAgentDir>/extensions/superpi-editor.ts`
 * （默认 `~/.pi/agent/extensions/`，`PI_CONFIG_DIR` / `piConfig.configDir` 变化时跟着走）。
 * pi 重启会话（或 `/reload`）后自动加载。
 *
 * 用法：
 *   node tools/install-pi-extension.mjs              # 只看状态（默认）
 *   node tools/install-pi-extension.mjs --install    # 安装 / 更新（幂等）
 *   node tools/install-pi-extension.mjs --remove     # 卸载
 *   node tools/install-pi-extension.mjs --print      # 打印状态机的原始判断（调试用）
 *
 * 退出码：0 成功 / 1 失败
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolvePiRuntime } from '../src/pi-runtime.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.dirname(here)
const source = path.join(pluginRoot, 'extensions', 'superpi-editor.ts')
/** 装进 pi 的扩展目录后用的文件名（前缀 superpi- 便于识别归属）。 */
export const EXTENSION_FILE_NAME = 'superpi-editor.ts'

/**
 * 一并安装的「用户自定义规则」扩展与它的共享模块（0.10.0）。
 *
 * 三者的关系：`superpi-rules.ts` 用 pi 的 `pi.on('before_agent_start')` 把规则追加进
 * 系统提示、并注册 `/superpi-rules`；它 `import` 同目录的 `superpi-rules.mjs`（pi 的 jiti
 * alias 不包含这个包名，走原生 ESM 相对路径）。而 `superpi-rules.mjs` 同时被 host 的
 * `/rules` 三条路由引用 —— **它就是面板与命令行共用的那唯一一份模型**。
 *
 * 所以三个文件必须一起装、一起卸：少装 .mjs 会让 .ts 在 pi 启动时报模块找不到
 * （pi 会把它当成一条 extension error，规则整个不生效，而且用户看不到原因）。
 */
export const RULES_EXTENSION_FILE_NAME = 'superpi-rules.ts'
export const RULES_MODULE_FILE_NAME = 'superpi-rules.mjs'

/**
 * 需要同步的 skill 清单（0.10.0 起）。
 *
 * 为什么走**用户级** `~/.agents/skills` 而不是项目级 `<cwd>/.pi/skills`：
 * pi 只在**项目被信任**时才加载项目级资源（`core/trust-manager.js` 的
 * `hasTrustRequiringProjectResources`），而 trust.json 里没有本仓库的条目 ——
 * 实测：项目级 skill 一个都不出现，模型只会列出用户级的那几个。用户级目录
 * 不经过信任判定，所以「装了就一定生效」。
 *
 * 为什么是复制而不是符号链接：Windows 上创建符号链接需要开发者模式或管理员��
 * 失败后 cp 会静默退化成复制 —— **一份源码两份字节**，改一处就会分叉。这里
 * 显式复制并由 `status()` 逐文件比对，分叉会立刻显示「内容不一致，需要 --install」。
 */
export const SKILL_FILE_NAME = 'SKILL.md'

/** 需要安装的 skill：`[skills/` 下的目录名]。 */
export const SKILL_NAMES = ['verified-delivery', 'change-scope']

/** 用户级 skill 目录：`~/.agents/skills`（pi 的 Agent Skills 兼容位置，恒被加载）。 */
export function resolveUserSkillsDir(env = process.env) {
  const home = env.USERPROFILE || env.HOME || os.homedir()
  return path.join(home, '.agents', 'skills')
}

/** 需要同步的文件清单：`[源相对路径（相对仓库根）, 安装后的文件名]`。 */
export const EXTENSION_FILES = [
  { label: 'editor', source: 'extensions/superpi-editor.ts', name: EXTENSION_FILE_NAME },
  { label: 'rules', source: 'extensions/superpi-rules.ts', name: RULES_EXTENSION_FILE_NAME },
  { label: 'rules-module', source: 'extensions/superpi-rules.mjs', name: RULES_MODULE_FILE_NAME },
]

/**
 * 解析 pi 的 agent 目录：`PI_CONFIG_DIR` 优先（pi 的环境变量），否则 `~/.pi/agent`。
 * 只读环境与 home，不依赖任何本机绝对路径。
 */
export function resolveExtensionDir(env = process.env) {
  const configDir = typeof env.PI_CONFIG_DIR === 'string' && env.PI_CONFIG_DIR !== '' ? env.PI_CONFIG_DIR : '.pi'
  const base = path.isAbsolute(configDir) ? configDir : path.join(os.homedir(), configDir)
  return path.join(base, 'agent', 'extensions')
}

export function status(options = {}) {
  const dir = options.dir ?? resolveExtensionDir(options.env ?? process.env)
  const target = path.join(dir, EXTENSION_FILE_NAME)
  const pi = resolvePiRuntime({ pluginRoot })
  const sourceExists = fs.existsSync(source)
  const targetExists = fs.existsSync(target)
  const identical = sourceExists && targetExists && fs.readFileSync(source, 'utf8') === fs.readFileSync(target, 'utf8')
  /**
   * 逐个文件的实际状态。`files` 是**安装面的真相**：以前只报 editor 一个，
   * 0.10.0 加了规则扩展后，只报一个会让「.mjs 没装上」这种情况彻底静默。
   */
  const files = EXTENSION_FILES.map(entry => {
    const from = path.join(pluginRoot, entry.source)
    const to = path.join(dir, entry.name)
    const fromExists = fs.existsSync(from)
    const toExists = fs.existsSync(to)
    const same = fromExists && toExists && fs.readFileSync(from, 'utf8') === fs.readFileSync(to, 'utf8')
    return { label: entry.label, source: from, target: to, sourceExists: fromExists, targetExists: toExists, identical: same }
  })
  const skillsDir = options.skillsDir ?? resolveUserSkillsDir(options.env ?? process.env)
  const skills = SKILL_NAMES.map(name => {
    const from = path.join(pluginRoot, 'skills', name, SKILL_FILE_NAME)
    const to = path.join(skillsDir, name, SKILL_FILE_NAME)
    const fromExists = fs.existsSync(from)
    const toExists = fs.existsSync(to)
    const same = fromExists && toExists && fs.readFileSync(from, 'utf8') === fs.readFileSync(to, 'utf8')
    return { name, source: from, target: to, sourceExists: fromExists, targetExists: toExists, identical: same }
  })
  return {
    dir,
    target,
    source,
    sourceExists,
    targetExists,
    identical,
    files,
    skillsDir,
    skills,
    /** 三个文件全装且内容一致，才算「安装完整」—— 缺一个就会有一半功能不生效。 */
    complete: files.every(file => file.targetExists && file.identical) && skills.every(skill => skill.targetExists && skill.identical),
    piVersion: pi.version ?? '',
    piFound: Boolean(pi.cliPath),
  }
}

export function install(options = {}) {
  const state = status(options)
  const missing = state.files.filter(file => file.sourceExists !== true)
  if (missing.length > 0) return { code: 1, message: `源文件不存在：${missing.map(file => file.source).join(', ')}` }
  fs.mkdirSync(state.dir, { recursive: true })
  for (const file of state.files) {
    if (file.targetExists && file.identical !== true) {
      try { fs.copyFileSync(file.target, file.target + '.bak') } catch { /* 备份失败不阻断安装 */ }
    }
    fs.copyFileSync(file.source, file.target)
  }
  // skill 是纯文档（SKILL.md）：只复制内容，失败不阻断扩展安装 —— 扩展坏了比少一个 skill 严重。
  const skillErrors = []
  for (const skill of state.skills) {
    if (skill.sourceExists !== true) { skillErrors.push(skill.name + ' 源缺失'); continue }
    try {
      fs.mkdirSync(path.dirname(skill.target), { recursive: true })
      fs.copyFileSync(skill.source, skill.target)
    } catch (error) {
      skillErrors.push(skill.name + ': ' + String(error?.message ?? error))
    }
  }
  // 顺手把 pi 的品牌名改成 SuperPi（官方 piConfig 机制，幂等）。
  // 扩展只负责 TUI 输入框；TUI 里的「Welcome to pi」等文案归 piConfig 管，
  // 两件事都在“让命令行窗口看起来是 SuperPi”，所以装扩展时一起做。
  const brand = brandRuntime()
  return {
    code: 0,
    message: state.complete ? '已是最新（内容一致，重新写入一次）' : '已安装',
    target: state.target,
    brand,
    files: state.files.map(file => ({ label: file.label, target: file.target })),
    skills: state.skills.map(skill => ({ name: skill.name, target: skill.target })),
    skillErrors,
  }
}

/**
 * 调用 brand-pi-runtime 给所有已知 pi 副本打品牌名。
 * 失败不阻断扩展安装 —— 品牌只是外观，输入框能用才是关键。
 */
function brandRuntime() {
  try {
    const script = path.join(pluginRoot, 'tools', 'brand-pi-runtime.mjs')
    if (!fs.existsSync(script)) return { ok: false, message: '缺少 brand-pi-runtime.mjs' }
    const out = execFileSync(process.execPath, [script, '--apply', '--all-profiles'], { encoding: 'utf8' })
    const changed = /完成：改 (\d+) 处/.exec(out)?.[1] ?? '?'
    return { ok: true, message: '品牌名已同步（改 ' + changed + ' 处）' }
  } catch (error) {
    return { ok: false, message: '品牌同步失败：' + String(error?.message ?? error) }
  }
}

export function remove(options = {}) {
  const state = status(options)
  const presentFiles = state.files.filter(file => file.targetExists)
  const presentSkills = state.skills.filter(skill => skill.targetExists)
  if (presentFiles.length === 0 && presentSkills.length === 0) return { code: 0, message: '未安装，无需卸载' }
  for (const file of presentFiles) {
    try { fs.unlinkSync(file.target) } catch { /* 已经不在了 */ }
    for (const suffix of ['.bak']) {
      const backup = file.target + suffix
      if (fs.existsSync(backup)) {
        try { fs.unlinkSync(backup) } catch { /* 已经不在了 */ }
      }
    }
  }
  // skill 也要一起卸：留下一个还在生效的 skill 是最难排查的残留
  // （用户以为卸了，模型却仍在按它办事）。目录空了顺手收掉，别留空壳。
  for (const skill of presentSkills) {
    try { fs.unlinkSync(skill.target) } catch { /* 已经不在了 */ }
    const dir = path.dirname(skill.target)
    try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir) } catch { /* 目录已不在或非空 */ }
  }
  return { code: 0, message: '已卸载（pi 下次启动/`/reload` 后恢复原始输入框、系统提示与技能）' }
}

function report(state) {
  // 14 是给 editor / rules 这类短标签的；skill:<name> 更长，按最长标签补，列才对得齐。
  const width = Math.max(14, ...state.files.map(f => f.label.length), ...state.skills.map(k => ('skill:' + k.name).length)) + 2
  const line = (label, value) => process.stdout.write(label.padEnd(width, ' ') + value + '\n')
  line('安装目录', state.dir)
  for (const file of state.files) {
    const statusText = file.sourceExists !== true
      ? `${file.source}  (源缺失!)`
      : (file.targetExists !== true ? '(未安装)' : (file.identical ? '已同步' : '内容不一致，需要 --install'))
    line(file.label, file.target + '  ' + statusText)
  }
  for (const skill of state.skills) {
    const text = skill.sourceExists !== true
      ? `${skill.source}  (源缺失!)`
      : (skill.targetExists !== true ? '(未安装)' : (skill.identical ? '已同步' : '内容不一致，需要 --install'))
    line('skill:' + skill.name, skill.target + '  ' + text)
  }
  line('pi 运行时', state.piFound ? `${state.piVersion || '(版本未知)'}` : '未找到（扩展仍然可装，pi 会自己找）')
  process.stdout.write('\n生效方式：重启 pi 会话窗口，或在 pi 里执行 /reload\n')
  process.stdout.write(
    '外观：四边闭合、框线 80% 白 · Working 按状态变色（正常白 / 成功绿 / 出错红） · 粘贴路径带浅灰底 · ' +
    'footer：项目名 (分支) ⇄ + settings / home 同行（鼠标移入变亮，点了就执行）\n',
  )
  process.stdout.write(
    '键位：Ctrl+A 全选 · Shift+方向扩选 · Ctrl+C 复制（不清空）· Ctrl+X 剪切 · Backspace/Delete 删选区 · Ctrl+V 粘贴文件路径\n',
  )
  process.stdout.write(
    '规则：settings 菜单里的 rules（= /superpi-rules）编辑「用户自定义规则」，与面板设置为同一份文件\n' +
    '      <home>/.superpi/rules.json · 每轮 before_agent_start 追加到系统提示末尾（最高优先级）\n',
  )
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const args = new Set(process.argv.slice(2))
  let result
  if (args.has('--install')) {
    result = install()
    if (result.message) process.stdout.write((result.code === 0 ? '' : '失败：') + result.message + '\n')
    if (result.brand) process.stdout.write('品牌名 ' + (result.brand.ok ? '' : '(未生效) ') + result.brand.message + '\n')
    report(status())
  } else if (args.has('--remove')) {
    result = remove()
    process.stdout.write((result.code === 0 ? '' : '失败：') + result.message + '\n')
  } else if (args.has('--print')) {
    process.stdout.write(JSON.stringify(status(), null, 2) + '\n')
  } else {
    report(status())
  }
  process.exit(result?.code ?? 0)
}

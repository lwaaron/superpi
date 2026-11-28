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
import { EXTENSION_FILES, extensionFilesAt, runtimeAgentDir, syncExtensionFiles } from '../src/runtime-extensions.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.dirname(here)
const source = path.join(pluginRoot, 'extensions', 'superpi-editor.ts')
export { EXTENSION_FILES }

export const EXTENSION_FILE_NAME = EXTENSION_FILES.find(file => file.label === 'editor').name
export const RULES_EXTENSION_FILE_NAME = EXTENSION_FILES.find(file => file.label === 'rules').name
export const RULES_MODULE_FILE_NAME = EXTENSION_FILES.find(file => file.label === 'rules-module').name
export const GUARD_EXTENSION_FILE_NAME = EXTENSION_FILES.find(file => file.label === 'context-guard').name
export const GUARD_MODULE_FILE_NAME = EXTENSION_FILES.find(file => file.label === 'context-guard-module').name

/**
 * 需要同步的 skill 清单（0.10.0 起）。
 *
 * 为什么走**用户级** `~/.agents/skills` 而不是项目级 `<cwd>/.pi/skills`：
 * pi 只在**项目被信任**时才加载项目级资源（`core/trust-manager.js` 的
 * `hasTrustRequiringProjectResources`），而 trust.json 里没有本仓库的条目 ——
 * 实测：项目级 skill 一个都不出现，模型只会列出用户级的那几个。用户级目录
 * 不经过信任判定，所以「装了就一定生效」。
 *
 * 为什么是复制而不是符号链接：Windows 上创建符号链接需要开发者模式或管理员权限
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

export function resolveExtensionDir(env = process.env, packageDir = resolvePiRuntime({ pluginRoot }).packageDir) {
  const agentDir = runtimeAgentDir({ packageDir, env })
  if (!env.PI_CODING_AGENT_DIR && !env.SUPERPI_CODING_AGENT_DIR && env.PI_CONFIG_DIR) {
    const base = path.isAbsolute(env.PI_CONFIG_DIR) ? env.PI_CONFIG_DIR : path.join(os.homedir(), env.PI_CONFIG_DIR)
    return path.join(base, 'agent', 'extensions')
  }
  return path.join(agentDir, 'extensions')
}

export function status(options = {}) {
  const pi = resolvePiRuntime({ pluginRoot })
  const dir = options.dir ?? resolveExtensionDir(options.env ?? process.env, pi.packageDir)
  const target = path.join(dir, EXTENSION_FILE_NAME)
  const sourceExists = fs.existsSync(source)
  const targetExists = fs.existsSync(target)
  const identical = sourceExists && targetExists && fs.readFileSync(source, 'utf8') === fs.readFileSync(target, 'utf8')
  const files = extensionFilesAt(pluginRoot, dir)
  /**
   * skills 目录的解析：**必须与 `dir` 联动**（0.16.0，修一个长期未定位的数据丢失事故）。
   *
   * ---------------------------------------------------------------------------
   * 事故：2026-11-19 一天内两个 skill 从 `~/.agents/skills` 消失 3 次，
   * 每次都在 `npm test` / commit 前后。当时复现序列连跑 3 遍没再现，根因记为"未确定"。
   *
   * 真正的根因就是这里：`test/rules.mjs` 用 `installer.remove({ dir: tmpDir })` 测卸载，
   * 而旧实现里 `skillsDir` **只看 `options.skillsDir` / 环境，完全不看 `options.dir`**。
   * 于是：扩展文件被正确删在 tmp 里，**skill 却被删在用户真实的 `~/.agents/skills`**。
   * 测试表面全绿，用户的两份 skill 悄悄没了 —— 最难查的那种：
   * **副作用发生在被测参数的作用域之外。**
   *
   * 修法：只要调用了显式给了 `dir`（说明"我要在指定目录里模拟一整套安装面"），
   * skill 就落到 `<dir>/../skills` 这种与真实布局同构的位置，而不是真实 home。
   * 显式 `skillsDir` 仍然最高优先（保持既有调用方语义）。
   *
   * 门禁 `test/rules.mjs` 里加了一条断言：传 tmp dir 时，**真实 skill 目录的 mtime 不变**。
   */
  const skillsDir = options.skillsDir
    ?? (options.env !== undefined
      /**
       * **显式 `env` 优先**：调用方给了 `env` 就说明它在模拟"另一个 home"，
       * 这时 skill 应落到那个 home 下的 `.agents/skills`（与真实布局一致）。
       * `test/tui-editor.mjs` 正是这么用的：`{ dir: fakeExtDir, env: { USERPROFILE: fakeHome } }`
       * —— 它要验证的恰恰是"真实安装会装到 home 下"，所以必须尊重 env。
       */
      ? resolveUserSkillsDir(options.env)
      : options.dir !== undefined
        /**
         * 只给了 `dir`、没给 `env` → skill 落到 `<dir>/skills/`，**完全隔离**。
         *
         * 这条是为 `test/rules.mjs` 补的：它用 `installer.remove({ dir: tmpDir })` 测卸载，
         * 而旧实现里 `skillsDir` **完全不看 `dir`**，于是扩展文件删在 tmp、
         * **skill 删在用户真实的 `~/.agents/skills`** ——
         * 2026-11-19 一天内两个 skill 消失 3 次、根因记为"未确定"，真凶就是这里。
         * 测试全绿、用户的两份 skill 没了，副作用发生在被测参数的作用域之外。
         *
         * 不模仿真实层级（`<base>/agent/extensions` + `<base>/../skills`）：
         * 测试传的常是平铺临时目录，猜错层级会让 `../skills` 跑到 `C:\tmp\skills` 这种共享位置，
         * 又变成"多个测试互相踩"。放 `dir` 内部最可预测：**谁传 dir，谁就在自己的沙箱里**。
         */
        ? path.join(path.resolve(options.dir), 'skills')
        : resolveUserSkillsDir(process.env))
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
  syncExtensionFiles(pluginRoot, state.dir)
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
  const brand = options.dir === undefined && options.env === undefined ? brandRuntime() : null
  return {
    code: 0,
    message: state.complete ? '已是最新' : '已安装',
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
  return { code: 0, message: '已卸载（SuperPi 下次启动或执行 `/reload` 后恢复原始输入框、系统提示与技能）' }
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
  line('SuperPi 运行时', state.piFound ? `${state.piVersion || '(版本未知)'}` : '未找到（扩展仍可安装）')
  process.stdout.write('\n生效方式：重新打开 SuperPi 命令行，或执行 /reload\n')
  process.stdout.write(
    '外观：四边闭合、框线 80% 白 · Working 按状态变色（正常白 / 成功绿 / 出错红） · 粘贴路径带浅灰底 · ' +
    'footer：项目名 (分支) ⇄ + settings / home 同行（鼠标移入变亮，点了就执行）\n',
  )
  process.stdout.write(
    '键位：Ctrl+A 全选 · Shift+方向扩选 · Ctrl+C 复制（不清空）· Ctrl+X 剪切 · Backspace/Delete 删选区 · Ctrl+V 粘贴文件路径\n' +
    '      settings 菜单：↑↓ 选择 · Enter 执行 · Esc 收起（打其它键自动收起，输入不会丢）\n',
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
    if (result.brand) process.stdout.write(result.brand.message + '\n')
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

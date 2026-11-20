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
 * 共享的「畸形输出判据」模块（0.16.2）。
 *
 * 为什么值得单独一个文件：同一份判据曾散在 1 处、另 1 处压根没有（面板），
 * 于是同一个故障在命令行亮红字、在面板完全静默。
 * 判据不是文案，它必须只有一份 —— 见 `extensions/superpi-malformed.mjs` 头部注释。
 */
export const MALFORMED_MODULE_FILE_NAME = 'superpi-malformed.mjs'

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
 * 一并安装的「上下文守卫」扩展与它的共享模块（0.12.0）。
 *
 * 它治的是「上下文超限后会话彻底报废」：`superpi-context-guard.ts` 订阅 pi 的
 * `context` 事件（每次 LLM 调用前），把历史里的大块内容（图片、思考、旧工具结果）
 * 非破坏性地折叠掉，保证请求不会超过模型窗口；`superpi-context-guard.mjs` 是它的
 * 纯函数模型层（估算 / 保护区 / 分级裁剪），可在 `test/context-guard.mjs` 里单测。
 *
 * 与 rules 同样的约束：`.ts` 在 pi 启动时 `import './superpi-context-guard.mjs'`，
 * 少装 .mjs 会让扩展加载失败（pi 只报一条 extension error，用户看不到原因）。
 */
export const GUARD_EXTENSION_FILE_NAME = 'superpi-context-guard.ts'
export const GUARD_MODULE_FILE_NAME = 'superpi-context-guard.mjs'

/**
 * 「模型模态开关」的扩展与共享模块（0.13.0）。
 *
 * `superpi-modalities.mjs` 是**三处共用**的唯一模型层：host 的 `/modalities` 两条路由、
 * 上下文守卫的请求前过滤、以及本扩展的 `/superpi-modalities` 菜单。放在 extensions/
 * 而不是 src/，理由与 rules 相同：`.ts` 被复制到 `<piAgentDir>/extensions/` 后，
 * `./superpi-modalities.mjs` 这条相对引用在仓库里与安装后指向同一份内容（零分叉）。
 */
export const MODALITIES_EXTENSION_FILE_NAME = 'superpi-modalities.ts'
export const MODALITIES_MODULE_FILE_NAME = 'superpi-modalities.mjs'

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

/**
 * 需要同步的文件清单：`[源相对路径（相对仓库根）, 安装后的文件名]`。
 *
 * ---------------------------------------------------------------------------
 * **顺序不能随便改：被依赖的 `.mjs` 必须排在依赖它的 `.ts` 之前**（0.15.3）。
 *
 * 真机踩到的坑：用户 `/reload` 之后报 `resetMeterMemo is not a function`。
 * 原因是清单里 `context-guard.ts`（扩展入口）排在 `context-guard.mjs`（它 import 的模块）**前面**：
 * 装到一半时磁盘上是「新 .ts + 旧 .mjs」，而 `.ts` 里已经 `import { resetMeterMemo }` ——
 * 于是扩展加载即抛错，整个上下文守卫失效。
 *
 * 这类错误特别难查：报错信息只说"不是函数"，看起来像代码写错了，
 * 实际是**安装过程的一个瞬时中间状态**。所以顺序是契约的一部分，不是排版。
 *
 * 门禁 `test/host-parity.mjs` 会断言「每个 .ts 的 .mjs 依赖排在它前面」。
 */
export const EXTENSION_FILES = [
  // 判据模块：**必须排在最前** —— editor 静态 import 它（0.16.2）。
  // 顺序反了就是 0.15.3 那个坑的重演：装到一半是「新 .ts + 旧/缺 .mjs」，
  // 扩展加载即抛，且 pi 会直接 exit(1)（main.js:804）。
  { label: 'malformed-module', source: 'extensions/superpi-malformed.mjs', name: MALFORMED_MODULE_FILE_NAME },
  { label: 'editor', source: 'extensions/superpi-editor.ts', name: EXTENSION_FILE_NAME },
  // 规则：模块先于扩展
  { label: 'rules-module', source: 'extensions/superpi-rules.mjs', name: RULES_MODULE_FILE_NAME },
  { label: 'rules', source: 'extensions/superpi-rules.ts', name: RULES_EXTENSION_FILE_NAME },
  // 守卫：模块先于扩展（就是这里曾颠倒过）
  { label: 'context-guard-module', source: 'extensions/superpi-context-guard.mjs', name: GUARD_MODULE_FILE_NAME },
  { label: 'context-guard', source: 'extensions/superpi-context-guard.ts', name: GUARD_EXTENSION_FILE_NAME },
  // 模态：模块先于扩展
  { label: 'modalities-module', source: 'extensions/superpi-modalities.mjs', name: MODALITIES_MODULE_FILE_NAME },
  { label: 'modalities', source: 'extensions/superpi-modalities.ts', name: MODALITIES_EXTENSION_FILE_NAME },
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

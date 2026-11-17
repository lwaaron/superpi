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
  return {
    dir,
    target,
    source,
    sourceExists,
    targetExists,
    identical,
    files,
    /** 三个文件全装且内容一致，才算「安装完整」—— 缺一个就会有一半功能不生效。 */
    complete: files.every(file => file.targetExists && file.identical),
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
  const present = state.files.filter(file => file.targetExists)
  if (present.length === 0) return { code: 0, message: '未安装，无需卸载' }
  for (const file of present) {
    try { fs.unlinkSync(file.target) } catch { /* 已经不在了 */ }
    for (const suffix of ['.bak']) {
      const backup = file.target + suffix
      if (fs.existsSync(backup)) {
        try { fs.unlinkSync(backup) } catch { /* 已经不在了 */ }
      }
    }
  }
  return { code: 0, message: '已卸载（pi 下次启动/`/reload` 后恢复原始输入框与系统提示）' }
}

function report(state) {
  const line = (label, value) => process.stdout.write(label.padEnd(14, ' ') + value + '\n')
  line('安装目录', state.dir)
  for (const file of state.files) {
    const statusText = file.sourceExists !== true
      ? `${file.source}  (源缺失!)`
      : (file.targetExists !== true ? '(未安装)' : (file.identical ? '已同步' : '内容不一致，需要 --install'))
    line(file.label, file.target + '  ' + statusText)
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

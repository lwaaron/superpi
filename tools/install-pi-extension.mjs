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
import { fileURLToPath } from 'node:url'
import { resolvePiRuntime } from '../src/pi-runtime.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.dirname(here)
const source = path.join(pluginRoot, 'extensions', 'superpi-editor.ts')
/** 装进 pi 的扩展目录后用的文件名（前缀 superpi- 便于识别归属）。 */
export const EXTENSION_FILE_NAME = 'superpi-editor.ts'

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
  return {
    dir,
    target,
    source,
    sourceExists,
    targetExists,
    identical,
    piVersion: pi.version ?? '',
    piFound: Boolean(pi.cliPath),
  }
}

export function install(options = {}) {
  const state = status(options)
  if (!state.sourceExists) return { code: 1, message: `源文件不存在：${state.source}` }
  fs.mkdirSync(state.dir, { recursive: true })
  if (state.targetExists && !state.identical) {
    const backup = state.target + '.bak'
    fs.copyFileSync(state.target, backup)
  }
  fs.copyFileSync(state.source, state.target)
  return {
    code: 0,
    message: state.identical ? '已是最新（内容一致，重新写入一次）' : '已安装',
    target: state.target,
  }
}

export function remove(options = {}) {
  const state = status(options)
  if (!state.targetExists) return { code: 0, message: '未安装，无需卸载' }
  fs.unlinkSync(state.target)
  for (const suffix of ['.bak']) {
    const backup = state.target + suffix
    if (fs.existsSync(backup)) fs.unlinkSync(backup)
  }
  return { code: 0, message: '已卸载（pi 下次启动/`/reload` 后恢复原始输入框）' }
}

function report(state) {
  const line = (label, value) => process.stdout.write(label.padEnd(14, ' ') + value + '\n')
  line('源文件', state.sourceExists ? state.source : `${state.source}  (缺失!)`)
  line('安装目录', state.dir)
  line('目标文件', state.targetExists ? state.target : '(未安装)')
  line('内容一致', state.sourceExists && state.targetExists ? (state.identical ? '是' : '否，需要 --install') : '—')
  line('pi 运行时', state.piFound ? `${state.piVersion || '(版本未知)'}` : '未找到（扩展仍然可装，pi 会自己找）')
  process.stdout.write('\n生效方式：重启 pi 会话窗口，或在 pi 里执行 /reload\n')
  process.stdout.write('能力：Ctrl+A 全选 · Shift+方向扩选 · Ctrl+C 复制（不清空）· Ctrl+X 剪切 · Backspace/Delete 删选区 · Ctrl+V 粘贴文件路径\n')
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const args = new Set(process.argv.slice(2))
  let result
  if (args.has('--install')) {
    result = install()
    if (result.message) process.stdout.write((result.code === 0 ? '' : '失败：') + result.message + '\n')
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

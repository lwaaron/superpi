#!/usr/bin/env node
/**
 * tools/brand-pi-runtime.mjs —— 用 pi 官方的 piConfig 机制把运行时品牌名改成 SuperPi。
 *
 * 为什么需要它
 *   TUI 里的「Welcome to pi」「Quit pi」「pi --help」这些字符串写死在 pi 的 dist 里，
 *   我们只能用 pi 官方文档（docs/cli-integration.md 的「Fork and rebrand Pi」一节）
 *   提供的 `piConfig.name` 覆盖。官方原话：
 *     "A source fork can change the CLI name and configuration directory through package.json …
 *      These settings affect the CLI banner, configuration paths, and derived environment variable names."
 *   所以这不是给 pi 打补丁，而是走它明示的配置面。
 *
 * 为什么必须幂等且可重复执行
 *   `pnpm add` / `npm install` 会用 registry 上的原始 package.json 覆盖本地改动
 *   → 每次装完插件都要重打一次。所以本脚本按需写入、已正确则不动（幂等），
 *   并挂在 install-plugin.ps1 与 install-pi-extension.mjs 之后自动跑。
 *
 * 关键约束：configDir 必须保持 .pi
 *   用户的 9 个项目历史会话都在 ~/.pi/agent/sessions。把 configDir 改成 .superpi
 *   会让 pi 去新目录找 → 历史会话全部读不到。所以这里**只动 name，绝不动 configDir**。
 *
 * 用法：
 *   node tools/brand-pi-runtime.mjs                # 只看状态（默认）
 *   node tools/brand-pi-runtime.mjs --apply        # 写入（幂等）
 *   node tools/brand-pi-runtime.mjs --revert       # 还原成 pi 默认
 *   node tools/brand-pi-runtime.mjs --apply --root <pluginRoot>
 *   node tools/brand-pi-runtime.mjs --apply --all-profiles
 *
 * 退出码：0 成功 / 1 失败
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolvePiRuntime, PI_PACKAGE } from '../src/pi-runtime.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.dirname(here)

/** 要写进 piConfig.name 的品牌名。 */
export const BRAND_NAME = 'SuperPi'
/** 必须保持不变的会话目录名 —— 改了就读不到历史会话。 */
export const KEEP_CONFIG_DIR = '.pi'

/**
 * 列出所有可能要打标的 pi 的 package.json 路径。
 * 覆盖三类位置：插件自带 .runtime、pnpm 装出的 profile node_modules、standalone 自举目录。
 */
export function candidatePackageJsons(options = {}) {
  const root = options.pluginRoot ?? repoRoot
  const out = []
  const push = p => { if (!out.includes(p)) out.push(p) }

  // 1) 插件自带的 .runtime（解析链第 4 步）
  push(path.join(root, '.runtime', 'node_modules', ...PI_PACKAGE.split('/'), 'package.json'))

  // 2) 插件自己的 node_modules（被当成依赖装进 profile 时，pi 在上一级）
  push(path.join(root, 'node_modules', ...PI_PACKAGE.split('/'), 'package.json'))

  // 3) standalone 自举出来的 DSH_HOME 里的 profile
  const standaloneProfiles = path.join(root, '.standalone', 'dsh-home', 'profiles')
  if (fs.existsSync(standaloneProfiles)) {
    for (const name of fs.readdirSync(standaloneProfiles)) {
      push(path.join(standaloneProfiles, name, 'node_modules', ...PI_PACKAGE.split('/'), 'package.json'))
    }
  }

  // 4) 显式给定的 profile 根（--profile-dir）
  if (typeof options.profileDir === 'string' && options.profileDir !== '') {
    push(path.join(options.profileDir, 'node_modules', ...PI_PACKAGE.split('/'), 'package.json'))
  }

  // 5) --all-profiles：扫 ~/.dsh/profiles/*
  if (options.allProfiles === true) {
    const base = path.join(os.homedir(), '.dsh', 'profiles')
    if (fs.existsSync(base)) {
      for (const name of fs.readdirSync(base)) {
        push(path.join(base, name, 'node_modules', ...PI_PACKAGE.split('/'), 'package.json'))
      }
    }
  }

  // 6) 解析链实际找到的那份（可能是 walk-up / pnpm store，位置不一定在上面几个里）
  try {
    const resolved = resolvePiRuntime({ pluginRoot: root })
    if (typeof resolved.packageDir === 'string' && resolved.packageDir !== '') {
      push(path.join(resolved.packageDir, 'package.json'))
    }
  } catch { /* 解析链失败不影响其它候选 */ }

  return out.filter(p => fs.existsSync(p))
}

/** 读一个 package.json 的品牌状态。 */
export function readBrand(pkgPath) {
  const json = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  const cfg = json.piConfig ?? {}
  return {
    path: pkgPath,
    name: typeof cfg.name === 'string' ? cfg.name : '',
    configDir: typeof cfg.configDir === 'string' ? cfg.configDir : '',
    branded: cfg.name === BRAND_NAME,
    configDirOk: (cfg.configDir ?? KEEP_CONFIG_DIR) === KEEP_CONFIG_DIR,
  }
}

/** 写入品牌名（幂等）。只动 name，configDir 原样保留。 */
export function applyBrand(pkgPath, options = {}) {
  const brand = options.brand ?? BRAND_NAME
  const raw = fs.readFileSync(pkgPath, 'utf8')
  const json = JSON.parse(raw)
  const cfg = json.piConfig ?? {}
  if (cfg.name === brand && (cfg.configDir ?? KEEP_CONFIG_DIR) === KEEP_CONFIG_DIR) {
    return { changed: false, reason: 'already branded' }
  }
  const next = Object.assign({}, cfg, { name: brand })
  // 关键：绝不覆盖 configDir；缺省时补成 .pi 而不是让它回落。
  if (next.configDir === undefined) next.configDir = KEEP_CONFIG_DIR
  json.piConfig = next
  // 保持原文件的缩进风格（package.json 通常是 2 空格）
  const indent = /\n(\s+)"/.exec(raw)?.[1]?.length ?? 2
  fs.writeFileSync(pkgPath, JSON.stringify(json, null, indent) + '\n')
  return { changed: true, reason: 'branded' }
}

/** 还原成 pi 默认（删掉 piConfig.name，保留 configDir）。 */
export function revertBrand(pkgPath) {
  const raw = fs.readFileSync(pkgPath, 'utf8')
  const json = JSON.parse(raw)
  const cfg = json.piConfig ?? {}
  if (cfg.name === undefined) return { changed: false, reason: 'not branded' }
  delete cfg.name
  json.piConfig = cfg
  const indent = /\n(\s+)"/.exec(raw)?.[1]?.length ?? 2
  fs.writeFileSync(pkgPath, JSON.stringify(json, null, indent) + '\n')
  return { changed: true, reason: 'reverted' }
}

function main() {
  const argv = process.argv.slice(2)
  const apply = argv.includes('--apply')
  const revert = argv.includes('--revert')
  const allProfiles = argv.includes('--all-profiles')
  const rootAt = argv.indexOf('--root')
  const pluginRoot = rootAt >= 0 && argv[rootAt + 1] ? argv[rootAt + 1] : repoRoot
  const dirAt = argv.indexOf('--profile-dir')
  const profileDir = dirAt >= 0 && argv[dirAt + 1] ? argv[dirAt + 1] : ''

  const targets = candidatePackageJsons({ pluginRoot, allProfiles, profileDir })
  if (targets.length === 0) {
    console.error('没找到任何 pi 的 package.json —— 先装一次运行时（或 --profile-dir 指定 profile）')
    process.exit(1)
  }

  let changed = 0
  let failed = 0
  for (const pkg of targets) {
    let state
    try {
      state = readBrand(pkg)
    } catch (error) {
      console.error('  FAIL  ' + pkg + ' :: ' + String(error?.message ?? error))
      failed += 1
      continue
    }
    if (apply) {
      try {
        const r = applyBrand(pkg)
        if (r.changed) changed += 1
        console.log((r.changed ? '  WROTE ' : '  OK    ') + pkg + '  name=' + BRAND_NAME + ' configDir=' + (state.configDir || KEEP_CONFIG_DIR))
      } catch (error) {
        console.error('  FAIL  ' + pkg + ' :: ' + String(error?.message ?? error))
        failed += 1
      }
      continue
    }
    if (revert) {
      try {
        const r = revertBrand(pkg)
        if (r.changed) changed += 1
        console.log((r.changed ? '  REVERT' : '  SKIP  ') + pkg)
      } catch (error) {
        console.error('  FAIL  ' + pkg + ' :: ' + String(error?.message ?? error))
        failed += 1
      }
      continue
    }
    // 状态模式
    const mark = state.branded ? '  BRANDED ' : '  raw     '
    const dirMark = state.configDirOk ? '' : '  ⚠ configDir=' + (state.configDir || '(unset)') + ' 会让历史会话读不到'
    console.log(mark + pkg + dirMark)
  }

  if (!apply && !revert) {
    console.log('')
    console.log('改法：--apply 写入（幂等） / --revert 还原 / --all-profiles 扫 ~/.dsh/profiles/*')
  } else {
    console.log('')
    console.log('完成：改 ' + changed + ' 处，失败 ' + failed + ' 处')
  }
  process.exit(failed > 0 ? 1 : 0)
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main()
}

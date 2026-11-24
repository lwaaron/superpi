#!/usr/bin/env node
/**
 * 门禁前置断言 —— **唯一**的「依赖就绪」判据。
 *
 * ── 为什么需要这个文件（结构缺陷，不是疏忽）───────────────
 *
 * 0.16.0 的对抗性审查证实：本仓库有 6 套门禁在缺依赖时会**整段跳过并 exit 0**。
 * 实测隐藏 `.runtime/` 与 `node_modules/@earendil-works/` 之后：
 *
 *   parity        102 →  87 checks  仍 PASS
 *   tui-editor    521 →   0 checks  **整段 SKIP**  仍 exit 0
 *   context-guard 179 → 160 checks  仍 PASS
 *   modalities     76 →  55 checks  仍 PASS
 *   rules         207 → 161 checks  仍 PASS
 *
 * 而 `.runtime/` 是 gitignore 的 —— **新机器 clone 下来必然没有 pi**，
 * 于是这些跳过不是边缘场景，而是每一次全新环境的默认路径。
 * 「100% 对齐」的机器保障因此退化成一句人肉承诺（AGENTS.md §3 明令禁止的状态）。
 *
 * ── 为什么不是「给 6 个文件各加一个 exit(1)」─────────────
 *
 * 那是 6 个补丁，第 7 个门禁必然再漏 —— 与 `src/runtime-files.mjs` 修
 * 「两处硬编码复制清单漂移」的教训完全同构：清单散落在 N 个地方，就必然漂移。
 * 正确做法是让「依赖就绪」成为**一个可以被查询的事实**，各门禁只查询、不自己判断。
 *
 * ── 三种终态（这是本文件的全部意义）───────────────
 *
 *   通过   = 依赖在位，断言全部执行
 *   失败   = 依赖缺失，且该依赖是必需的
 *   跳过   = 依赖缺失，且调用方**显式声明**这一层可选
 *
 * 第三态必须显式。默认值是「失败」—— 因为「没验证」不等于「验证通过」。
 *
 * ── 用法（门禁里只有这一行）───────────────
 *
 *   import { requireRuntime } from './preflight.mjs'
 *   const pi = requireRuntime()            // 缺 pi 直接 throw，门禁变红
 *
 *   import { probeRuntime } from './preflight.mjs'
 *   const probe = probeRuntime()
 *   if (!probe.ok) skipOptional(probe, '第 ③ 层（真 .ts 扩展加载）')   // 显式声明可选
 *
 * 跑法：node test/preflight.mjs          # 打印当前环境的依赖清单
 *       node test/preflight.mjs --json   # 供脚本消费
 *
 * 退出码：0 必需依赖齐备 / 1 有必需依赖缺失
 */
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PI_PACKAGE, PI_VERSION, resolvePiRuntime } from '../src/pi-runtime.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
export const PLUGIN_ROOT = path.dirname(here)

/**
 * 依赖清单：**唯一真源**。
 *
 * 每项声明的不是「文件在哪」，而是「哪一层门禁需要它、缺了算不算失败」。
 * 新增门禁若需要新依赖，改这里一处；不要在门禁里写 `fs.existsSync` 自行判断。
 */
export const DEPENDENCIES = [
  {
    id: 'pi',
    required: true,
    layer: '与 pi 对账（命令面 / 事件面 / 扩展 UI / 真 .ts 扩展加载）',
    hint: 'npm run test:runtime（装到 .runtime/）或设 PI_PACKAGE_DIR 指向 pi 源码树',
  },
  {
    id: 'jiti',
    required: true,
    layer: '加载 extensions/*.ts（pi 的扩展加载器依赖它）',
    hint: '随 pi 一起装，通常不单独缺失；若缺失说明 pi 包装得不完整',
  },
  {
    id: 'react',
    required: true,
    layer: 'client.js 的 SSR 渲染门禁（test/client-render.mjs）',
    hint: 'npm install（本仓库刻意不带 node_modules，需借宿主的 react）',
  },
  {
    id: 'typebox',
    required: true,
    layer: '使用 Pi 原生工具 schema 加载 ask_user 扩展',
    hint: '重新安装与项目版本一致的运行时',
  },
]

/** 在 startDir 起逐级向上找 `<dir>/node_modules/<name>/package.json`。 */
function findPackageJson(name, startDir) {
  let dir = path.resolve(startDir)
  for (let depth = 0; depth < 10; depth += 1) {
    const target = path.join(dir, 'node_modules', ...name.split('/'), 'package.json')
    if (fs.existsSync(target)) return target
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return ''
}

/**
 * 探测 pi 运行时。
 *
 * 返回 `{ ok, cliPath, packageDir, version, searched, reason }`。
 * **绝不抛** —— 调用方需要能区分「缺」与「坏」，抛异常会把两者混成一个。
 */
export function probeRuntime(options = {}) {
  const pluginRoot = typeof options.pluginRoot === 'string' ? options.pluginRoot : PLUGIN_ROOT
  let resolved
  try {
    resolved = resolvePiRuntime({ pluginRoot })
  } catch (error) {
    return { ok: false, cliPath: '', packageDir: '', version: null, searched: [], reason: String(error?.message ?? error) }
  }
  if (typeof resolved.cliPath !== 'string' || resolved.cliPath === '') {
    const tried = Array.isArray(resolved.searched) ? resolved.searched.filter(item => item.ok === false) : []
    return {
      ok: false,
      cliPath: '',
      packageDir: '',
      version: null,
      searched: resolved.searched ?? [],
      reason: tried.length === 0
        ? 'pi CLI not found'
        : 'pi CLI not found; tried ' + tried.map(item => item.source).join(', '),
    }
  }
  // 版本必须匹配：装了别的版本会让「与 pi 对账」对到一个不存在的协议面上。
  if (typeof resolved.version === 'string' && resolved.version !== '' && resolved.version !== PI_VERSION) {
    return {
      ok: false,
      cliPath: resolved.cliPath,
      packageDir: resolved.packageDir ?? '',
      version: resolved.version,
      searched: resolved.searched ?? [],
      reason: 'pi version mismatch: found ' + resolved.version + ', expected ' + PI_VERSION,
    }
  }
  return {
    ok: true,
    cliPath: resolved.cliPath,
    packageDir: resolved.packageDir ?? '',
    version: resolved.version ?? null,
    searched: resolved.searched ?? [],
    reason: '',
  }
}

/** 探测 jiti（从 pi 包内逐级向上找，与各门禁原来的做法一致）。 */
export function probeJiti(piProbe = probeRuntime()) {
  if (piProbe.ok !== true || piProbe.packageDir === '') {
    return { ok: false, path: '', reason: 'pi runtime missing（jiti 随 pi 分发）' }
  }
  let dir = path.resolve(piProbe.packageDir)
  for (let depth = 0; depth < 8; depth += 1) {
    const target = path.join(dir, 'node_modules', 'jiti', 'lib', 'jiti.mjs')
    if (fs.existsSync(target)) return { ok: true, path: target, reason: '' }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return { ok: false, path: '', reason: 'jiti not found near ' + piProbe.packageDir }
}

/** Resolve the schema builder from the same package as Pi's extension loader. */
export function probeTypeBox(piProbe = probeRuntime()) {
  if (piProbe.ok !== true || !piProbe.packageDir) return { ok: false, path: '', reason: 'TypeBox 随运行时安装' }
  try {
    const require = createRequire(path.join(piProbe.packageDir, 'package.json'))
    return { ok: true, path: require.resolve('typebox'), reason: '' }
  } catch (error) {
    return { ok: false, path: '', reason: '无法从运行时解析 TypeBox（' + String(error.code ?? error.message) + '）' }
  }
}

/** 探测 react（SSR 门禁需要；本仓库刻意不带 node_modules）。 */
export function probeReact(options = {}) {
  const root = typeof options.root === 'string' ? options.root : PLUGIN_ROOT
  const homes = [
    path.join(root, 'node_modules'),
    path.join(root, '..', 'pi-main', 'node_modules'),
    path.join(options.home ?? (process.env.USERPROFILE || ''), 'Documents', 'pi-local', 'pi-main', 'node_modules'),
  ].filter(home => home !== '')
  for (const home of homes) {
    if (fs.existsSync(path.join(home, 'react', 'package.json')) && fs.existsSync(path.join(home, 'react-dom', 'package.json'))) {
      return { ok: true, home, reason: '' }
    }
  }
  return { ok: false, home: '', reason: 'react / react-dom not found; tried ' + homes.join(', ') }
}

/** 一次性探测全部依赖。 */
export function probeAll() {
  const pi = probeRuntime()
  return {
    pi,
    jiti: probeJiti(pi),
    react: probeReact(),
    typebox: probeTypeBox(pi),
  }
}

/**
 * 取必需的 pi 运行时；缺失即**让门禁失败**。
 *
 * 为什么直接 `process.exit(1)` 而不 throw：
 * 门禁是给人看的诊断工具，不是库。throw 出去的结果是一屏 node 内部堆栈，
 * 读者要自己从 `at ...` 里翻出「哦，是没装 pi」—— 那是把解谜成本转嫁给用户。
 * 这里统一输出「缺什么 + 为什么不能跳过 + 怎么修」，然后 exit 1。
 *
 * 需要区分异常类型的调用方（测试替身、嵌套场景）用 `probeRuntime()`，
 * 它**永不退出**，只返回事实。
 */
export function requireRuntime(options = {}) {
  const probe = probeRuntime(options)
  if (probe.ok === true) return probe
  const hint = DEPENDENCIES.find(item => item.id === 'pi')?.hint ?? ''
  console.error('')
  console.error('FAIL[preflight] pi 运行时不可用 —— ' + probe.reason)
  console.error('  这一层门禁不能跳过：没验证 ≠ 验证通过。')
  console.error('  修法：' + hint)
  console.error('')
  process.exit(1)
}

/** 取必需的 jiti 入口路径；缺失即失败。 */
export function requireJiti(piProbe = requireRuntime()) {
  const probe = probeJiti(piProbe)
  if (probe.ok === true) return probe.path
  console.error('')
  console.error('FAIL[preflight] jiti 不可用 —— ' + probe.reason)
  console.error('  修法：重装 pi 运行时（npm run test:runtime）')
  console.error('')
  process.exit(1)
}

export function requireTypeBox(piProbe = requireRuntime()) {
  const probe = probeTypeBox(piProbe)
  if (probe.ok === true) return probe.path
  console.error('FAIL[preflight] ' + probe.reason)
  console.error('  修法：' + DEPENDENCIES.find(item => item.id === 'typebox').hint)
  process.exit(1)
}

/** 取必需的 react 目录；缺失即失败。 */
export function requireReact(options = {}) {
  const probe = probeReact(options)
  if (probe.ok === true) return probe.home
  console.error('')
  console.error('FAIL[preflight] react 不可用 —— ' + probe.reason)
  console.error('  修法：npm install（本仓库刻意不带 node_modules，需借宿主的 react）')
  console.error('')
  process.exit(1)
}

/**
 * 显式声明某一层可选并跳过它。
 *
 * **只有调用方明确知道「这一层对本次改动无关」时才允许调用。**
 * 输出格式统一，便于在 CI 日志里一眼看出少跑了什么：
 *   SKIP[可选] 第 ③ 层（真 .ts 扩展加载）：jiti 不可用 —— ...
 *
 * 与「静默跳过」的区别就在这一个 `[可选]` 标记和必须给出的理由：
 * 前者是决定，后者是疏忽。
 */
export function skipOptional(probe, layer) {
  const reason = probe && typeof probe.reason === 'string' && probe.reason !== '' ? probe.reason : 'dependency missing'
  console.log('SKIP[可选] ' + layer + '：' + reason)
}

/** 打印人类可读的依赖清单。 */
export function describeAll() {
  const probes = probeAll()
  const lines = []
  const labelWidth = Math.max(...DEPENDENCIES.map(dep => dep.id.length)) + 1
  for (const dep of DEPENDENCIES) {
    const probe = probes[dep.id === 'pi' ? 'pi' : dep.id]
    const status = probe.ok === true ? 'OK  ' : (dep.required ? 'MISS' : 'miss')
    const detail = dep.id === 'pi'
      ? (probe.ok === true ? (probe.version + ' @ ' + probe.cliPath) : probe.reason)
      : dep.id === 'react'
        ? (probe.ok === true ? probe.home : probe.reason)
        : (probe.ok === true ? probe.path : probe.reason)
    lines.push('  ' + status + '  ' + dep.id.padEnd(labelWidth) + (dep.required ? '必需' : '可选') + '  ' + dep.layer)
    lines.push('         ' + detail)
  }
  return lines.join('\n')
}

// ── 直接运行：打印清单（供人看 / 供 CI 的日志） ──────────────────────────────
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const asJson = process.argv.includes('--json')
  const probes = probeAll()
  if (asJson) {
    console.log(JSON.stringify(probes, null, 2))
  } else {
    console.log('preflight — 门禁依赖清单（' + PI_PACKAGE + '@' + PI_VERSION + '）')
    console.log(describeAll())
  }
  const missing = DEPENDENCIES.filter(dep => probes[dep.id === 'pi' ? 'pi' : dep.id].ok !== true && dep.required)
  if (missing.length > 0) {
    console.log('')
    console.log('缺失必需依赖：' + missing.map(dep => dep.id).join(', '))
    for (const dep of missing) console.log('  ' + dep.id + ' → ' + dep.hint)
    process.exit(1)
  }
  console.log('')
  console.log('必需依赖齐备。')
}

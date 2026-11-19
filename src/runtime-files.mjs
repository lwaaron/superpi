/**
 * 插件运行时文件清单 —— **唯一来源**。
 *
 * ---------------------------------------------------------------------------
 * 为什么需要这个模块（0.15.0）
 *
 * `test/selfcheck.mjs` 与 `test/version.mjs` 都要把插件复制到一个临时目录里跑
 * （模拟「装到别处」），各自维护一份硬编码的复制清单。实测两份已经**漂移**：
 * selfcheck 16 项、version 15 项。
 *
 * 漂移的代价是真实的：0.15.0 新增 `src/http-idle-guard.mjs` 后，两个门禁同时
 * `Cannot find module .../src/http-idle-guard.mjs` 而红 —— 不是代码错，是清单漏。
 * 而修法是「在每处各补一条」，下一个人会再漏一次。
 *
 * ---------------------------------------------------------------------------
 * 改成「按目录自动发现」
 *
 * 清单里真正需要枚举的不是"哪些文件"，而是"哪些**目录**整份要复制"：
 *   - `src/`        —— host 侧全部模块
 *   - `extensions/` —— 三个扩展（.mjs + .ts）
 *
 * 那么规则就是：
 *   1. 三个根文件（index/client/package + cordis.patch.yml）显式列出；
 *   2. `src/` 与 `extensions/` 下的**所有** .mjs / .ts 自动收录。
 *
 * 这样新增一个源文件**不需要改任何测试**，也就永远不会再漂移。
 * 唯一的代价是「新增一个不该被复制的文件」时会被误收 —— 但这个仓库里
 * `src/` 与 `extensions/` 下的每一个文件本来就都属于运行时，没有例外。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 根目录下必须一起复制的东西（不含目录）。 */
export const ROOT_FILES = ['index.js', 'client.js', 'package.json', 'cordis.patch.yml']

/** 需要整份复制的目录（只收下面这些扩展名的文件）。 */
export const SOURCE_DIRS = ['src', 'extensions']

/** 复制的扩展名白名单：`.ts` 给 jiti 与安装器用，`.mjs` 是运行时。 */
const EXTENSIONS = ['.mjs', '.ts']

/**
 * 列出所有需要复制的文件（相对插件根目录的路径，用 `/` 分隔）。
 *
 * 顺序稳定（先根文件，再按目录名字典序），便于断言与 diff。
 *
 * @param {string} root 插件根目录
 * @returns {string[]}
 */
export function listRuntimeFiles(root) {
  const out = ROOT_FILES.slice()
  for (const dir of SOURCE_DIRS) {
    const abs = path.join(root, dir)
    let entries = []
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true })
    } catch {
      // 目录不存在就当空（比如裁剪过的发行包）——不抛，让调用方自己判断完整性。
      continue
    }
    const names = entries
      .filter(entry => entry.isFile() && EXTENSIONS.some(ext => entry.name.endsWith(ext)))
      .map(entry => dir + '/' + entry.name)
      .sort()
    out.push(...names)
  }
  return out
}

/**
 * 把清单里的文件复制到目标目录（保持相对结构）。
 *
 * @param {string} root 源插件根目录
 * @param {string} target 目标目录
 * @returns {string[]} 实际复制的相对路径
 */
export function copyRuntimeFiles(root, target) {
  const files = listRuntimeFiles(root)
  for (const rel of files) {
    const from = path.join(root, rel)
    const to = path.join(target, rel)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(from, to)
  }
  return files
}

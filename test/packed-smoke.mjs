/**
 * 打包产物冒烟测试：验证「npm pack 出来的 tgz 装到别处」还能不能跑。
 *
 * 这是「可独立运行的插件」这条验收线的核心证据：它不 import 源码目录里的任何东西，
 * 只用装出来的 node_modules/superpi。
 *
 * 跑法：node test/packed-smoke.mjs <已安装的 superpi 入口>
 *   例：node test/packed-smoke.mjs C:/tmp/x/node_modules/superpi/index.js
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { runSmoke } from './_harness.mjs'

const target = process.argv[2]
if (typeof target !== 'string' || target === '') {
  console.error('用法：node test/packed-smoke.mjs <已安装的 superpi/index.js 路径>')
  process.exit(1)
}
process.exit(await runSmoke({ entry: pathToFileURL(path.resolve(target)).href }))

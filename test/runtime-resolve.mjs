/**
 * 运行时解析链单测：不联网、不装包，用临时目录造出各种布局，验证 resolvePiRuntime
 * 的优先级、失败诊断（searched）和 expandPath。
 *
 * 跑法：node test/runtime-resolve.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  PI_PACKAGE,
  PI_VERSION,
  expandPath,
  resolvePiRuntime,
  resolveNodeRuntime,
  describeRuntime,
} from '../src/pi-runtime.mjs'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pi-runtime-'))
let failures = 0

const assert = (ok, message) => {
  if (ok) return
  failures += 1
  console.error('FAIL: ' + message)
}

const writeFile = (target, text) => {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, text, 'utf8')
}

/** 造一个「已安装的 pi 包」，返回它的 cli 入口。 */
const makePiPackage = (moduleDir) => {
  const packageDir = path.join(moduleDir, 'node_modules', ...PI_PACKAGE.split('/'))
  const cli = path.join(packageDir, 'dist', 'bundle', 'cli.js')
  writeFile(path.join(packageDir, 'package.json'), JSON.stringify({
    name: PI_PACKAGE,
    version: PI_VERSION,
    bin: { pi: 'dist/bundle/cli.js' },
  }, null, 2))
  writeFile(cli, '// fake pi entry\n')
  return cli
}

const makePluginRoot = name => {
  const root = path.join(tempRoot, name)
  writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'dsh-pi', version: '0.2.0', type: 'module' }, null, 2))
  writeFile(path.join(root, 'index.js'), 'export const name = "dsh-pi"\n')
  return root
}

// 1) 什么都没有 → missing，且 searched 里能看出查过哪些位置
{
  const pluginRoot = makePluginRoot('empty')
  const found = resolvePiRuntime({ pluginRoot, config: {}, env: { PATH: '' } })
  assert(found.cliPath === '', '空插件目录应该解析失败，实际 ' + found.cliPath)
  assert(found.source === 'missing', 'source 应为 missing，实际 ' + found.source)
  assert(found.searched.length >= 2, 'searched 应记录多个候选，实际 ' + String(found.searched.length))
  assert(found.searched.every(item => item.ok === false), 'searched 全部应为 ok:false')
  assert(found.expected === PI_PACKAGE + '@' + PI_VERSION, 'expected 应为 ' + PI_PACKAGE + '@' + PI_VERSION)
  const described = describeRuntime(found)
  assert(described.ok === false, 'describeRuntime.ok 应为 false')
  assert(described.runtimeDir === path.join(pluginRoot, '.runtime'), 'described.runtimeDir 应指向插件 .runtime')
}

// 2) .runtime 命中（一键安装落点）
{
  const pluginRoot = makePluginRoot('with-runtime')
  const cli = makePiPackage(path.join(pluginRoot, '.runtime'))
  const found = resolvePiRuntime({ pluginRoot, config: {}, env: {} })
  assert(found.cliPath === cli, '.runtime 应命中，期望 ' + cli + ' 实际 ' + found.cliPath)
  assert(found.source === 'plugin-runtime', 'source 应为 plugin-runtime，实际 ' + found.source)
  assert(found.version === PI_VERSION, 'version 应解析为 ' + PI_VERSION + '，实际 ' + String(found.version))
}

// 3) 插件自带 node_modules 优先于 .runtime
{
  const pluginRoot = makePluginRoot('with-both')
  const optional = makePiPackage(pluginRoot)
  makePiPackage(path.join(pluginRoot, '.runtime'))
  const found = resolvePiRuntime({ pluginRoot, config: {}, env: {} })
  assert(found.cliPath === optional, 'node_modules 应优先于 .runtime，实际 ' + found.cliPath)
  assert(found.source === 'plugin-node-modules', 'source 应为 plugin-node-modules，实际 ' + found.source)
}

// 4) 配置里的 cliPath 最高优先，且支持直接指向包目录
{
  const pluginRoot = makePluginRoot('with-config')
  const packageDir = path.join(pluginRoot, 'vendor', 'node_modules', ...PI_PACKAGE.split('/'))
  const cli = makePiPackage(path.join(pluginRoot, 'vendor'))
  makePiPackage(path.join(pluginRoot, '.runtime'))
  const byFile = resolvePiRuntime({ pluginRoot, config: { cliPath: cli }, env: {} })
  assert(byFile.cliPath === cli && byFile.source === 'config', 'config.cliPath 指文件应命中，实际 ' + byFile.cliPath + ' via ' + byFile.source)
  const byDir = resolvePiRuntime({ pluginRoot, config: { cliPath: packageDir }, env: {} })
  assert(byDir.cliPath === cli && byDir.source === 'config', 'config.cliPath 指包目录应解析到 cli，实际 ' + byDir.cliPath)
}

// 5) 环境变量 PI_CLI_PATH 次优
{
  const pluginRoot = makePluginRoot('with-env')
  const external = makePiPackage(path.join(tempRoot, 'external'))
  const found = resolvePiRuntime({ pluginRoot, config: {}, env: { PI_CLI_PATH: external } })
  assert(found.cliPath === external, 'PI_CLI_PATH 应命中，实际 ' + found.cliPath)
  assert(found.source === 'env', 'source 应为 env，实际 ' + found.source)
}

// 6) 配置写错时不静默失败：searched 里留下 ok:false 记录，然后继续往下找
{
  const pluginRoot = makePluginRoot('with-broken-config')
  const cli = makePiPackage(path.join(pluginRoot, '.runtime'))
  const found = resolvePiRuntime({ pluginRoot, config: { cliPath: path.join(tempRoot, 'nope', 'cli.js') }, env: {} })
  assert(found.cliPath === cli, '配置错但 .runtime 存在时应回退命中，实际 ' + found.cliPath)
  assert(found.searched.some(item => item.source === 'config' && item.ok === false), 'searched 应记录 config 失败项')
}

// 7) node 解析：配置 > PATH > host-execpath
{
  const fakeNode = path.join(tempRoot, 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
  writeFile(fakeNode, '')
  const byConfig = resolveNodeRuntime({ config: { nodePath: fakeNode }, env: {} })
  assert(byConfig.path === fakeNode && byConfig.source === 'config', 'nodePath 配置应命中，实际 ' + byConfig.path)
  const byPath = resolveNodeRuntime({ config: {}, env: { PATH: path.dirname(fakeNode) } })
  assert(byPath.path === fakeNode && byPath.source === 'path', 'PATH 扫描应命中，实际 ' + byPath.path + ' via ' + byPath.source)
  const fallback = resolveNodeRuntime({ config: {}, env: { PATH: '' } })
  assert(fallback.path === process.execPath, '兜底应为 process.execPath，实际 ' + fallback.path)
  assert(fallback.source === 'host-execpath', '兜底 source 应为 host-execpath，实际 ' + fallback.source)
}

// 8) expandPath 支持 ~ 与 %VAR%
{
  const home = os.homedir()
  assert(expandPath('~') === home, '~ 应展开为 home')
  assert(expandPath('~/x') === path.join(home, 'x'), '~/x 应展开')
  if (process.platform === 'win32') {
    process.env.DSH_PI_TEST_VAR = 'abc'
    const expanded = expandPath('%DSH_PI_TEST_VAR%\\y')
    assert(expanded === path.resolve('abc\\y'), '%VAR% 应展开，实际 ' + expanded)
    delete process.env.DSH_PI_TEST_VAR
  }
  assert(expandPath('') === '', '空字符串应返回空字符串')
  assert(expandPath(undefined) === '', 'undefined 应返回空字符串')
}

console.log(failures === 0 ? 'PASS' : 'FAILED ' + String(failures))
fs.rmSync(tempRoot, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)

import { execFile as exec } from 'node:child_process'
import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { PI_PACKAGE, PI_VERSION, resolvePiRuntime } from '../src/pi-runtime.mjs'

const execFile = promisify(exec)
const root = fileURLToPath(new URL('../', import.meta.url))
const destination = path.resolve(process.argv[2] ?? path.join(root, '_scratch'))
const npm = process.env.npm_execpath
if (!npm) throw new Error('Run this through npm run pack:offline.')

async function npmIn(cwd, args) {
  const { stdout } = await execFile(process.execPath, [npm, ...args], {
    cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 300_000,
  })
  return stdout
}

await fs.mkdir(destination, { recursive: true })
const stage = await fs.mkdtemp(path.join(destination, '.superpi-offline-'))
try {
  const [{ files }] = JSON.parse(await npmIn(root, ['pack', '--dry-run', '--json', '--ignore-scripts']))
  for (const { path: relative } of files) {
    const target = path.join(stage, relative)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.copyFile(path.join(root, relative), target)
  }
  await fs.copyFile(path.join(root, 'package-lock.json'), path.join(stage, 'package-lock.json'))
  await npmIn(stage, ['ci', '--omit=dev', '--no-audit', '--no-fund'])
  const runtime = resolvePiRuntime({ pluginRoot: stage, env: {} })
  if (runtime.source !== 'plugin-node-modules' || runtime.version !== PI_VERSION) {
    throw new Error(`Offline bundle requires the locked ${PI_PACKAGE}@${PI_VERSION}.`)
  }

  const manifest = path.join(stage, 'package.json')
  const pkg = JSON.parse(await fs.readFile(manifest, 'utf8'))
  pkg.bundleDependencies = [PI_PACKAGE]
  await fs.writeFile(manifest, JSON.stringify(pkg, null, 2) + '\n')
  const [archive] = JSON.parse(await npmIn(stage, ['pack', '--json', '--ignore-scripts']))
  if (!archive.bundled?.includes(PI_PACKAGE)) throw new Error('npm did not bundle the Pi dependency tree.')
  const file = path.join(destination, `${pkg.name}-${pkg.version}-offline-${process.platform}-${process.arch}.tgz`)
  await fs.copyFile(path.join(stage, archive.filename), file, constants.COPYFILE_EXCL)
  console.log(file)
} finally {
  await fs.rm(stage, { recursive: true, force: true, maxRetries: 3 })
}

/** Run real Pi tools and score engineering work with local Docker resource and filesystem limits. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { copyRuntimeFiles } from '../src/runtime-files.mjs'
import { withVerificationSnapshot } from '../extensions/superpi-verification.mjs'
import { cases } from './fixtures/engineering-cases.mjs'

const execute = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const limits = ['--network', 'none', '--read-only', '--user', '1000:1000', '--cap-drop', 'ALL',
  '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '1g', '--cpus', '2',
  '--tmpfs', '/tmp:rw,nosuid,nodev,size=384m,mode=1777', '--env', 'HOME=/tmp/home']
const dockerfile = [
  'FROM node:24-bookworm AS agent',
  'WORKDIR /opt/superpi',
  'COPY package.json package-lock.json ./',
  'RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && node --input-type=module -e "await import(\'@earendil-works/pi-coding-agent\')"',
  'COPY src/ src/',
  'COPY extensions/ extensions/',
  'COPY sandbox-tool-probe.mjs ./',
  'RUN install -d -o node -g node /work',
  'WORKDIR /work',
  'USER node',
  'FROM agent AS grader',
  'COPY test/ /opt/superpi/test/',
].join('\n') + '\n'

async function docker(args, options = {}) {
  return execute('docker', args, { timeout: 35_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, ...options })
}

async function requireLocalDocker() {
  const { stdout: selected } = await docker(['context', 'show'])
  const { stdout: endpoint } = await docker(['context', 'inspect', selected.trim(), '--format', '{{.Endpoints.docker.Host}}'])
  assert.match(process.env.DOCKER_HOST || endpoint.trim(), /^(?:npipe:\/\/|unix:\/\/)/, 'Use a local Linux Docker engine.')
  const { stdout } = await docker(['info', '--format', '{{.OSType}}'])
  assert.equal(stdout.trim(), 'linux', 'The isolation check needs Linux containers.')
}

async function build(context, image, stage) {
  copyRuntimeFiles(root, context)
  for (const [source, dest] of [['package-lock.json', 'package-lock.json'],
    ['test/fixtures/sandbox-tool-probe.mjs', 'sandbox-tool-probe.mjs']]) {
    await fs.copyFile(path.join(root, source), path.join(context, dest))
  }
  if (stage === 'grader') {
    await fs.mkdir(path.join(context, 'test'))
    await fs.copyFile(path.join(root, 'test/engineering-bench.mjs'), path.join(context, 'test/engineering-bench.mjs'))
    await fs.cp(path.join(root, 'test/fixtures'), path.join(context, 'test/fixtures'), { recursive: true })
  }
  await fs.writeFile(path.join(context, 'Dockerfile'), dockerfile)
  await docker(['build', '--quiet', '--target', stage, '--tag', image, context], { timeout: 300_000 })
}

async function inspect(container, volume, readOnly) {
  const { stdout } = await docker(['inspect', container])
  const [{ HostConfig: config, Config: processConfig, Mounts }] = JSON.parse(stdout)
  assert.equal(config.NetworkMode, 'none')
  assert.equal(config.ReadonlyRootfs, true)
  assert.equal(config.Privileged, false)
  assert.equal(processConfig.User, '1000:1000')
  assert.ok(config.CapDrop.includes('ALL') && config.SecurityOpt.includes('no-new-privileges'))
  assert.equal(Mounts.length, 1)
  assert.deepEqual(Mounts.map(item => [item.Type, item.Name, item.Destination, item.RW]),
    [['volume', volume, '/work', !readOnly]], 'only the fresh run volume may be mounted')
}

async function run(args) {
  const [action, name, folder] = args
  if (action !== 'probe' && (action !== 'grade' || !Object.hasOwn(cases, name) || !folder)) {
    throw new Error('Use probe, or grade <case> <candidate-workspace>. Cases: ' + Object.keys(cases).join(', '))
  }
  await requireLocalDocker()
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'superpi-isolation-'))
  const owner = 'superpi-engineering-' + randomUUID()
  const volume = owner + '-work'
  const image = owner + ':' + action
  const created = []
  let volumeCreated = false
  let imageBuilt = false
  try {
    await build(temp, image, action === 'probe' ? 'agent' : 'grader')
    imageBuilt = true
    await docker(['volume', 'create', volume])
    volumeCreated = true
    const mount = 'type=volume,source=' + volume + ',target=/work'
    const create = async (container, command, readonly = false) => {
      await docker(['create', '--name', container, ...limits, '--mount', mount + (readonly ? ',readonly' : ''), image, ...command])
      created.push(container)
      await inspect(container, volume, readonly)
    }
    if (action === 'probe') {
      const container = owner + '-probe'
      await create(container, ['node', '/opt/superpi/sandbox-tool-probe.mjs'])
      return JSON.parse((await docker(['start', '-a', container])).stdout)
    }
    const staging = owner + '-stage'
    await create(staging, ['true'])
    const workspace = path.resolve(folder)
    await withVerificationSnapshot(workspace, AbortSignal.timeout(45_000), snapshot =>
      docker(['cp', snapshot + '/.', staging + ':/work']))
    const grading = owner + '-grade'
    await create(grading, ['node', '/opt/superpi/test/engineering-bench.mjs', 'grade', name, '/work'], true)
    const result = await docker(['start', '-a', grading]).catch(error => {
      if (error.code === 1 && error.stdout.trimStart().startsWith('{')) return error
      throw error
    })
    const score = JSON.parse(result.stdout)
    if (score.passed !== score.total) process.exitCode = 1
    return score
  } finally {
    for (const container of created.reverse()) await docker(['rm', '-f', container])
    if (volumeCreated) await docker(['volume', 'rm', volume])
    if (imageBuilt) await docker(['image', 'rm', image])
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 3 })
  }
}

try {
  console.log(JSON.stringify(await run(process.argv.slice(2)), null, 2))
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}

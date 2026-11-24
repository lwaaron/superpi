import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { scanTextBytes } from './superpi-text-bytes.mjs'

const exec = promisify(execFile)
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

async function git(cwd, args, signal) {
  const { stdout } = await exec('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], {
    cwd, signal, windowsHide: true, maxBuffer: 32 * 1024 * 1024, encoding: 'buffer',
  })
  return stdout
}

function records(buffer) {
  return utf8.decode(buffer).split('\0').slice(0, -1)
}

async function repositoryRoot(cwd, signal) {
  try {
    const output = await git(cwd, ['rev-parse', '--show-toplevel'], signal)
    return fs.realpath(utf8.decode(output).replace(/\r?\n$/, ''))
  } catch (error) {
    signal.throwIfAborted()
    throw new Error('Verification snapshots and durable command evidence require a Git working tree.', { cause: error })
  }
}

async function fileAt(root, name) {
  const file = path.resolve(root, name)
  const relative = path.relative(root, file)
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('Path outside the verification working directory: ' + name)
  }
  try {
    const stat = await fs.lstat(file)
    const real = await fs.realpath(file)
    if (!stat.isFile() || path.relative(file, real) !== '') {
      throw new Error('Verification cannot copy or attest a symbolic link, submodule, or special file: ' + name)
    }
    return { file, stat }
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function sourceFiles(root, signal) {
  const list = await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], signal)
  return [...new Set(records(list))].sort()
}

/** Identify working bytes, including untracked source. Staging alone does not change the result. */
export async function workspaceFingerprint(cwd, signal) {
  const root = await repositoryRoot(cwd, signal)
  const hash = createHash('sha256').update(root).update('\0').update(await fs.realpath(cwd)).update('\0')
  for (const name of await sourceFiles(root, signal)) {
    signal.throwIfAborted()
    const source = await fileAt(root, name)
    // A path absent from the working tree contributes nothing even if it is still staged.
    if (!source) continue
    const contentHash = createHash('sha256')
    for await (const chunk of createReadStream(source.file, { signal })) contentHash.update(chunk)
    hash.update(name).update('\0').update(String(source.stat.mode)).update('\0').update(contentHash.digest())
  }
  return hash.digest('hex')
}

/** Copy current tracked and non-ignored untracked files. No Git metadata or linked files are shared. */
export async function withVerificationSnapshot(cwd, signal, run) {
  const root = await repositoryRoot(cwd, signal)
  const workdir = path.relative(root, await fs.realpath(cwd))
  if (workdir === '..' || workdir.startsWith('..' + path.sep) || path.isAbsolute(workdir)) {
    throw new Error('The session working directory is outside the discovered Git repository.')
  }
  const files = await sourceFiles(root, signal)
  signal.throwIfAborted()
  const tempParent = await fs.realpath(os.tmpdir())
  const snapshot = await fs.mkdtemp(path.join(tempParent, 'superpi-verify-'))
  try {
    for (const name of files) {
      signal.throwIfAborted()
      const source = await fileAt(root, name)
      if (!source) continue
      const target = path.join(snapshot, name)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.copyFile(source.file, target)
    }
    const snapshotCwd = path.join(snapshot, workdir)
    await fs.mkdir(snapshotCwd, { recursive: true })
    signal.throwIfAborted()
    return await run(snapshotCwd)
  } finally {
    const info = await fs.lstat(snapshot).catch(error => {
      if (error.code !== 'ENOENT') throw error
      return null
    })
    if (info) {
      if (!info.isDirectory() || info.isSymbolicLink() || path.relative(snapshot, await fs.realpath(snapshot)) !== '') {
        throw new Error('The verification snapshot path changed during execution: ' + snapshot)
      }
      await fs.rm(snapshot, { recursive: true, force: true, maxRetries: 3 })
    }
  }
}

export async function applyVerificationMutations(cwd, mutations, signal) {
  for (const { path: name, oldText, newText } of mutations) {
    signal.throwIfAborted()
    if (path.isAbsolute(name) || !name.trim() || !scanTextBytes(name).clean || !scanTextBytes(newText).clean) {
      throw new Error('Supply a valid relative file path and clean replacement text.')
    }
    const source = await fileAt(cwd, name)
    if (!source) throw new Error('Mutation file does not exist in the snapshot: ' + name)
    const text = utf8.decode(await fs.readFile(source.file, { signal }))
    const at = text.indexOf(oldText)
    if (oldText === newText || at < 0 || text.indexOf(oldText, at + 1) !== -1) {
      throw new Error('The mutation must match exactly once and change the file: ' + name)
    }
    await fs.writeFile(source.file, text.slice(0, at) + newText + text.slice(at + oldText.length), { signal })
  }
}

/** Allow the shell to acknowledge cancellation without letting a broken process supervisor hang Pi. */
export async function waitForVerification(operation, signal) {
  let timer
  let onAbort
  const unconfirmed = new Promise(resolve => {
    onAbort = () => { timer = setTimeout(() => resolve(false), 1500) }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([operation.then(() => true), unconfirmed])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

export function verificationCommand(command, shell, snapshotCwd) {
  if (shell === 'powershell') {
    const location = snapshotCwd ? "Set-Location -LiteralPath '" + snapshotCwd.replaceAll("'", "''") + "' -ErrorAction Stop\n" : ''
    // PowerShell's -Command exit would otherwise collapse native failures to 1.
    return location + '$LASTEXITCODE = 0\n& {\n' + command +
      '\n}\n$superpiVerificationSucceeded = $?\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\n' +
      'if (-not $superpiVerificationSucceeded) { exit 1 }\nexit 0'
  }
  const location = snapshotCwd ? "cd -- '" + snapshotCwd.replaceAll(path.sep, '/').replaceAll("'", "'\\''") + "' || exit $?\n" : ''
  return 'set -o pipefail\n' + location + command
}

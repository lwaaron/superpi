import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, watch } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { promisify } from 'node:util'
import { scanTextBytes } from './superpi-text-bytes.mjs'

const exec = promisify(execFile)
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const MAX_OBSERVED_PATH_BYTES = 8 * 1024 * 1024
const SOURCE_FILES_PER_BATCH = 8

async function git(cwd, args, signal, maxBuffer = 32 * 1024 * 1024, input) {
  const operation = exec('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], {
    cwd, signal, windowsHide: true, maxBuffer, encoding: 'buffer',
  })
  if (input !== undefined) {
    const stdin = operation.child.stdin
    // An early Git exit or cancellation is reported by the command promise.
    stdin.on('error', () => {})
    stdin.end(input)
  }
  const { stdout } = await operation
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
    const stat = await fs.lstat(file, { bigint: true })
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

async function* processSourceFiles(root, files, signal, operation) {
  for (let offset = 0; offset < files.length; offset += SOURCE_FILES_PER_BATCH) {
    signal.throwIfAborted()
    const batch = files.slice(offset, offset + SOURCE_FILES_PER_BATCH)
    // Join every started operation before the caller can clean up a snapshot.
    const settled = await Promise.allSettled(batch.map(async name => {
      const source = await fileAt(root, name)
      // A deleted path contributes nothing even if it is still in the Git index.
      if (!source) return
      signal.throwIfAborted()
      return operation(name, source)
    }))
    signal.throwIfAborted()
    for (const result of settled) {
      if (result.status === 'rejected') throw result.reason
      if (result.value !== undefined) yield result.value
    }
  }
}

/** Identify working bytes, including untracked source. Staging alone does not change the result. */
export async function workspaceFingerprint(cwd, signal) {
  const { fingerprint } = await workspaceSourceState(cwd, signal, false)
  return fingerprint
}

/** Read source bytes and file versions to bound a live verification command. */
export async function workspaceSourceState(cwd, signal, includeFileVersions = true) {
  const root = await repositoryRoot(cwd, signal)
  const identity = { root, cwd: await fs.realpath(cwd) }
  const files = await sourceFiles(root, signal)
  const state = await fingerprintFiles(root, files, identity, signal, includeFileVersions)
  return { ...state, root, files }
}

/** Identify the captured bytes in the source workspace's namespace. */
export async function verificationSnapshotFingerprint(snapshot, signal) {
  const { fingerprint } = await fingerprintFiles(snapshot.root, snapshot.files, snapshot.source, signal)
  return fingerprint
}

async function fingerprintFiles(root, files, identity, signal, includeFileVersions = false) {
  const hash = createHash('sha256').update(identity.root).update('\0').update(identity.cwd).update('\0')
  const fileVersions = new Map()
  const read = async (name, { file, stat }) => {
    const contentHash = createHash('sha256')
    for await (const chunk of createReadStream(file, { signal })) contentHash.update(chunk)
    return { name, stat, digest: contentHash.digest() }
  }
  for await (const { name, stat, digest } of processSourceFiles(root, files, signal, read)) {
    if (includeFileVersions) {
      const { dev, ino, mtimeNs, ctimeNs } = stat
      fileVersions.set(name, `${dev}:${ino}:${mtimeNs}:${ctimeNs}`)
    }
    hash.update(name).update('\0').update(String(stat.mode)).update('\0').update(digest)
  }
  return { fingerprint: hash.digest('hex'), fileVersions }
}

export function firstChangedSource(before, after) {
  for (const [name, version] of before.fileVersions) {
    if (after.fileVersions.get(name) !== version) return name
  }
  if (before.fileVersions.size !== after.fileVersions.size) {
    for (const name of after.fileVersions.keys()) {
      if (!before.fileVersions.has(name)) return name
    }
  }
}

async function ignoredPaths(root, names, signal, disregardIndex = false) {
  if (names.length === 0) return new Set()
  const args = ['check-ignore', ...(disregardIndex ? ['--no-index'] : []), '-z', '--stdin']
  // The relative prefix keeps unusual names (including leading colons) literal to Git.
  const input = names.map(name => './' + name).join('\0') + '\0'
  try {
    const output = await git(root, args, signal, undefined, input)
    return new Set(records(output).map(name => name.slice(2)))
  } catch (error) {
    if (error.code === 1) return new Set()
    throw error
  }
}

function sourceParentDirectories(names) {
  const parents = new Set()
  for (const name of names) {
    let dir = name.endsWith('/') ? name.slice(0, -1) : path.posix.dirname(name)
    for (; dir !== '.' && !parents.has(dir); dir = path.posix.dirname(dir)) parents.add(dir)
  }
  return parents
}

/** Observe entry changes that can disappear between the two source scans. */
export async function watchWorkspaceEntries(before, signal) {
  const { root, files } = before
  const watchers = []
  const entries = new Set()
  let observedBytes = 0
  let failure
  const close = () => {
    for (const watcher of watchers.splice(0)) watcher.close()
  }
  const fail = error => {
    failure ??= error
    close()
  }
  const record = (dir, event, rawName) => {
    if (!rawName?.length) {
      fail(new Error('A filesystem notification did not identify the changed path.'))
      return
    }
    if (event !== 'rename' || failure || signal.aborted) return
    try {
      const name = utf8.decode(rawName)
      if (name.toLowerCase() === '.git') return
      if (!name || name === '.' || name === '..' || name.includes('/') || (path.sep === '\\' && name.includes('\\'))) {
        throw new Error('A filesystem notification reported an invalid entry name.')
      }
      const relative = dir ? dir + '/' + name : name
      if (entries.has(relative)) return
      observedBytes += Buffer.byteLength(relative) + 1
      if (observedBytes > MAX_OBSERVED_PATH_BYTES) throw new Error('Too many distinct file changes were reported during the command.')
      entries.add(relative)
    } catch (error) {
      fail(error)
    }
  }
  try {
    const candidates = records(await git(root, ['ls-files', '-z', '--others', '--ignored', '--directory', '--exclude-standard'], signal))
    const ignored = await ignoredPaths(root, [...sourceParentDirectories(candidates)].map(dir => dir + '/'), signal, true)
    const sourceParents = sourceParentDirectories(files)
    const dirs = ['']
    for (const dir of dirs) {
      signal.throwIfAborted()
      if (failure) break
      const absolute = path.join(root, dir)
      if (path.relative(absolute, await fs.realpath(absolute)) !== '') {
        throw new Error('A workspace directory changed into a link during verification: ' + JSON.stringify(dir))
      }
      // Watch the parent before discovering children so new directories are seen there.
      const watcher = watch(absolute, { encoding: 'buffer', persistent: false, signal }, (event, name) => record(dir, event, name))
      watcher.on('error', fail)
      watchers.push(watcher)
      for (const entry of await fs.readdir(absolute, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.toLowerCase() === '.git') continue
        const child = dir ? dir + '/' + entry.name : entry.name
        if (!ignored.has(child + '/') || sourceParents.has(child)) dirs.push(child)
      }
    }
  } catch (error) {
    fail(error)
  }
  return {
    close,
    async firstChangedEntry() {
      await nextTurn()
      close()
      signal.throwIfAborted()
      if (failure) throw new Error('Could not monitor workspace entries during verification. ' + failure.message, { cause: failure })
      const changed = [...entries]
      if (changed.length === 0) return undefined
      const originalSources = new Set(files)
      const known = changed.find(name => originalSources.has(name))
      if (known) return known
      const ignored = await ignoredPaths(root, changed, signal)
      return changed.find(name => !ignored.has(name))
    },
  }
}

/** Compare the filesystem before and after a command that serves as acceptance evidence. */
export async function observeWorkspaceCommand(cwd, signal) {
  const before = await workspaceSourceState(cwd, signal)
  const entries = await watchWorkspaceEntries(before, signal)
  return {
    close: entries.close,
    async inspect() {
      const after = await workspaceSourceState(cwd, signal)
      signal.throwIfAborted()
      const sameBytes = after.fingerprint === before.fingerprint
      const changedFile = firstChangedSource(before, after) ?? (sameBytes ? await entries.firstChangedEntry() : undefined)
      return { fingerprint: sameBytes && !changedFile ? after.fingerprint : undefined, changedFile }
    },
  }
}

/** A registered command can keep its exit status while a Bash tail displays its output. */
export function acceptanceInvocation(command, declared, shell, cwd) {
  if (command === declared) return command
  if (shell !== 'bash' || /[;&|<>\r\n]/.test(declared)) return
  const pipefail = /^set -o pipefail\r?\n/
  let invocation = command.replace(pipefail, '').trim()
  const directory = cwd.replaceAll('\\', '/')
  const prefixes = []
  if (!directory.includes("'")) prefixes.push("cd '" + directory + "' && ")
  if (!/["$\x60]/.test(directory)) prefixes.push('cd "' + directory + '" && ')
  if (/^[a-zA-Z0-9_./:-]+$/.test(directory)) prefixes.push('cd ' + directory + ' && ')
  const prefix = prefixes.find(value => invocation.startsWith(value))
  if (prefix) invocation = invocation.slice(prefix.length)
  if (invocation === declared) return command
  if (!invocation.startsWith(declared) || !/^ +2>&1 +\| +tail +-(?:n +)?[1-9]\d{0,5}$/.test(invocation.slice(declared.length))) return
  return pipefail.test(command) ? command : 'set -o pipefail\n' + command
}

/** Copy current tracked and non-ignored untracked files. No Git metadata or linked files are shared. */
export async function withVerificationSnapshot(cwd, signal, run) {
  const root = await repositoryRoot(cwd, signal)
  const sourceCwd = await fs.realpath(cwd)
  const workdir = path.relative(root, sourceCwd)
  if (workdir === '..' || workdir.startsWith('..' + path.sep) || path.isAbsolute(workdir)) {
    throw new Error('The session working directory is outside the discovered Git repository.')
  }
  const files = await sourceFiles(root, signal)
  return withSnapshotFiles(root, files, workdir, signal, (snapshotCwd, snapshot) =>
    run(snapshotCwd, { ...snapshot, source: { root, cwd: sourceCwd } }))
}

async function withSnapshotFiles(root, files, workdir, signal, run) {
  signal.throwIfAborted()
  const tempParent = await fs.realpath(os.tmpdir())
  const snapshot = await fs.mkdtemp(path.join(tempParent, 'superpi-verify-'))
  try {
    const copy = async (name, { file }) => {
      const target = path.join(snapshot, name)
      await fs.mkdir(path.dirname(target), { recursive: true })
      signal.throwIfAborted()
      await fs.copyFile(file, target)
      return name
    }
    const captured = []
    for await (const name of processSourceFiles(root, files, signal, copy)) captured.push(name)
    const snapshotCwd = path.join(snapshot, workdir)
    await fs.mkdir(snapshotCwd, { recursive: true })
    signal.throwIfAborted()
    return await run(snapshotCwd, { root: snapshot, files: captured })
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

/** Create both independent test directories before allowing either command to run. */
export async function withVerificationPair(cwd, signal, compare) {
  return withVerificationSnapshot(cwd, signal, (baselineCwd, snapshot) =>
    withSnapshotFiles(snapshot.root, snapshot.files, path.relative(snapshot.root, baselineCwd), signal,
      mutationCwd => compare(baselineCwd, mutationCwd, snapshot)))
}

/** Use the shell transcript, including its spool if needed, to match a literal test diagnostic. */
export async function verificationOutputContains(transcript, expected, signal) {
  if (typeof transcript?.output !== 'string') return undefined
  if (transcript.truncated === false) return transcript.output.includes(expected)
  if (typeof transcript.full_output_path !== 'string') return undefined
  try {
    let tail = ''
    for await (const chunk of createReadStream(transcript.full_output_path, { encoding: 'utf8', signal })) {
      const text = tail + chunk
      if (text.includes(expected)) return true
      tail = text.slice(Math.max(0, text.length - expected.length + 1))
    }
    return false
  } catch {
    signal.throwIfAborted()
    return undefined
  }
}

/** Pin a review to the same bytes that its reviewers can read. The source index is only consulted. */
export async function withReviewSnapshot(cwd, base, paths, signal, inspect) {
  return withVerificationSnapshot(cwd, signal, async (_snapshotCwd, snapshot) => {
    const source = snapshot.source
    const revision = utf8.decode(await git(source.root, ['rev-parse', '--verify', '--end-of-options', base + '^{tree}'], signal)).trim()
    const atCopy = ['--work-tree=' + snapshot.root, '--literal-pathspecs']
    const diff = [...atCopy, 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames']
    const untracked = [...atCopy, 'ls-files', '-z', '--others', '--exclude-standard']
    const where = ['--', ...paths]
    const allPaths = paths.length ? Promise.all([
      git(source.root, [...diff, '--name-only', '-z', revision, '--'], signal),
      git(source.root, [...untracked, '--'], signal),
    ]) : []
    const [patch, stats, newFiles, deletions, fingerprint, all, scopedNames] = await Promise.all([
      git(source.root, [...diff, revision, ...where], signal),
      git(source.root, [...diff, '--numstat', '-z', revision, ...where], signal),
      git(source.root, [...untracked, ...where], signal),
      git(source.root, [...diff, '--name-only', '--diff-filter=D', '-z', revision, ...where], signal),
      verificationSnapshotFingerprint(snapshot, signal),
      allPaths,
      paths.length ? git(source.root, [...atCopy, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', ...where], signal) : null,
    ])
    const changes = records(stats).map(line => {
      const [added, removed, ...name] = line.split('\t')
      return { name: name.join('\t'), binary: added === '-' && removed === '-' }
    })
    const newNames = records(newFiles)
    const selected = new Set([...changes.map(change => change.name), ...newNames])
    const uncovered = [...new Set(all.flatMap(records))].filter(name => !selected.has(name)).sort()
    const deleted = new Set(records(deletions))
    const filenames = new Set(snapshot.files)
    const readBaseline = async maxBytes => {
      const raw = records(await git(source.root, [...diff, '--raw', '--no-abbrev', '-z', revision, ...where], signal))
      const tracked = new Set(changes.map(change => change.name))
      const baseline = []
      let bytesLeft = maxBytes
      for (let i = 0; i < raw.length; i += 2) {
        const fields = /^:(000000|100644|100755) (100644|100755) ([0-9a-f]+) [0-9a-f]+ ([AM])$/.exec(raw[i])
        const name = raw[i + 1]
        if (!fields || !tracked.delete(name) || !filenames.has(name) || bytesLeft <= 0) {
          throw new Error('The change cannot be represented by ordinary source files.')
        }
        const [, beforeMode, mode, object, action] = fields
        const before = action === 'A' ? null : reviewText(await git(source.root, ['cat-file', 'blob', object], signal, bytesLeft), bytesLeft)
        const file = { path: name, before, beforeMode, mode }
        baseline.push(file)
        bytesLeft -= Buffer.byteLength(JSON.stringify(file)) + 1
      }
      if (tracked.size || bytesLeft < 0) throw new Error('The baseline exceeds the source packet budget or is incomplete.')
      return baseline
    }
    const read = async (name, maxBytes = 256 * 1024) => {
      if (path.isAbsolute(name) || !scanTextBytes(name).clean || (!filenames.has(name) && !deleted.has(name))) {
        throw new Error('Path is outside the review snapshot or is not a captured project file.')
      }
      const file = await fileAt(snapshot.root, name)
      const bytes = file
        ? await readReviewBytes(file, signal, maxBytes)
        : deleted.has(name) ? await git(source.root, ['show', revision + ':' + name], signal) : null
      if (!bytes) throw new Error('The file is absent from the review snapshot.')
      return reviewText(bytes, maxBytes)
    }
    const files = [...new Set([...filenames, ...deleted])].sort()
    const included = new Set(scopedNames ? records(scopedNames) : files)
    return inspect({
      patch: utf8.decode(patch),
      untracked: newNames,
      omitted: changes.filter(change => change.binary).map(change => change.name),
      uncovered,
      files,
      scopedFiles: files.filter(name => included.has(name)),
      changedPaths: selected,
      hasDeletions: deleted.size > 0,
      fingerprint,
      revision,
      read,
      readBaseline,
    })
  })
}

function reviewText(bytes, maxBytes) {
  if (bytes.length > maxBytes) throw new Error('This file exceeds the snapshot text read limit.')
  const text = utf8.decode(bytes)
  if (!scanTextBytes(text).clean) throw new Error('This file is not clean UTF-8 source text.')
  return text
}

async function readReviewBytes(file, signal, maxBytes) {
  if (file.stat.size > maxBytes) throw new Error('This file exceeds the snapshot text read limit.')
  return fs.readFile(file.file, { signal })
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

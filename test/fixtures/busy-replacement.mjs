/** Controlled same-target replacement conflict for the visible and independent persistence tests. */
import assert from 'node:assert/strict'
import callbackFs from 'node:fs'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HOLD_MS = 125

function absoluteTarget(destination) {
  if (destination instanceof URL) destination = fileURLToPath(destination)
  if (Buffer.isBuffer(destination)) destination = destination.toString('utf8')
  if (typeof destination !== 'string') return undefined
  const absolute = path.resolve(destination)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/** Install before importing the candidate so captured native rename functions see the same probe. */
export async function withBusyReplacement(run) {
  const originalRename = fs.rename
  const originalCallbackRename = callbackFs.rename
  let probe
  const targetsProbe = destination => probe && absoluteTarget(destination) === probe.target
  async function rename(from, to) {
    if (!targetsProbe(to)) return originalRename(from, to)
    const active = probe
    if (active.replacing) {
      const error = new Error('Another replacement of this settings file is active')
      error.code = 'EPERM'
      throw error
    }
    active.replacing = true
    try {
      if (!active.started) {
        active.started = true
        active.entered.resolve()
        await active.release.promise
      }
      return await originalRename(from, to)
    } finally {
      active.replacing = false
    }
  }
  fs.rename = rename
  callbackFs.rename = (from, to, callback) => {
    if (!targetsProbe(to) || typeof callback !== 'function') return originalCallbackRename(from, to, callback)
    void rename(from, to).then(() => callback(null), callback)
  }
  syncBuiltinESMExports()
  try {
    return await run(async ({ save, load }, file, values) => {
      const entered = Promise.withResolvers()
      const release = Promise.withResolvers()
      probe = { target: absoluteTarget(file), entered, release, started: false, replacing: false }
      const saveValue = value => Promise.resolve().then(() => save(file, value))
      const first = saveValue(values[0])
      let timer
      try {
        // Start the remaining writes with the first replacement already in progress.
        await Promise.race([entered.promise, first.then(() => undefined, () => undefined)])
        timer = setTimeout(release.resolve, HOLD_MS)
        const results = await Promise.allSettled([first, ...values.slice(1).map(saveValue)])
        const failures = results.filter(result => result.status === 'rejected')
        const diagnostics = failures.map(result => result.reason?.code ?? String(result.reason))
        assert.equal(failures.length, 0, 'Concurrent saves must all complete while replacement is busy. Failures ' + diagnostics.join(', '))
        const loaded = await load(file)
        assert.deepEqual(loaded, values[loaded.retries], 'Concurrent saves must publish a complete submitted document')
        assert.deepEqual(await fs.readdir(path.dirname(file)), [path.basename(file)], 'Concurrent saves must clean up temporary files')
      } finally {
        clearTimeout(timer)
        release.resolve()
        probe = undefined
      }
    })
  } finally {
    probe?.release.resolve()
    fs.rename = originalRename
    callbackFs.rename = originalCallbackRename
    syncBuiltinESMExports()
  }
}

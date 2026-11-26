/** Public project seeds and private grading cases for engineering-bench.mjs. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { withBusyReplacement } from './busy-replacement.mjs'
import { durableJobs } from './durable-jobs.mjs'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const testPublicCache = `import { createCatalog } from './catalog.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('lookup and refresh through the public API', async () => {
  let count = 0
  const catalog = createCatalog(async () => ++count)
  assert.equal(await catalog.lookup('item'), 1)
  assert.equal(await catalog.lookup('item'), 1)
  catalog.refresh('item')
  assert.equal(await catalog.lookup('item'), 2)
})
`

const testPublicStore = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { withBusyReplacement } from './busy-replacement.mjs'

await withBusyReplacement(async check => {
  const { decode, encode } = await import('./state.mjs')
  const storage = await import('./settings.mjs')
  await test('ordinary state survives a round trip', () => {
    const state = decode({ enabled: true, retries: 4 })
    assert.equal(state.enabled, true)
    assert.equal(state.retries, 4)
    assert.deepEqual(decode(encode(state)), state)
  })
  await test('concurrent saves complete while replacement is busy', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'settings-overlap-'))
    t.after(async () => {
      const file = path.join(dir, 'settings.json')
      await fs.rm(file, { force: true })
      await fs.rmdir(dir)
    })
    const values = Array.from({ length: 5 }, (_, retries) => ({ enabled: Boolean(retries % 2), retries, source: 'public' }))
    await check(storage, path.join(dir, 'settings.json'), values)
  })
})
`
const busyReplacementSource = readFileSync(new URL('./busy-replacement.mjs', import.meta.url), 'utf8')

export const cases = {
  'durable-jobs': durableJobs,
  'async-cache': {
    prompt: 'Fix the asynchronous cache while preserving createCatalog and the lookup/refresh API. ' +
      'Concurrent lookups of the same key share one in-flight load. Other keys load independently. TTL starts when a load succeeds. ' +
      'Rejections can retry. Refresh detaches any earlier load: its existing callers still settle, and it cannot change subsequent cache entries. ' +
      'Keep the change focused, add regression coverage, run the tests, and leave changes uncommitted.',
    entry: 'catalog.mjs',
    files: {
      'catalog.mjs': `import { createCache } from './cache.mjs'
export function createCatalog(load, options) {
  const cache = createCache(load, options)
  return { lookup: key => cache.get(key), refresh: key => cache.delete(key) }
}
`,
      'cache.mjs': `export function createCache(load, { ttl = 100, now = Date.now } = {}) {
  const cache = new Map()
  return {
    async get(key) {
      const cached = cache.get(key)
      if (cached && cached.expires > now()) return cached.value
      const value = await load(key)
      cache.set(key, { value, expires: now() + ttl })
      return value
    },
    delete(key) { cache.delete(key) },
  }
}
`,
      'public.test.mjs': testPublicCache,
    },
    reference: {
      'cache.mjs': `export function createCache(load, { ttl = 100, now = Date.now } = {}) {
  const cache = new Map()
  return {
    get(key) {
      const cached = cache.get(key)
      if (cached && (cached.expires === undefined || cached.expires > now())) return cached.result
      const start = Promise.withResolvers()
      const record = { result: start.promise }
      cache.set(key, record)
      const reject = error => {
        if (cache.get(key) === record) cache.delete(key)
        start.reject(error)
      }
      try {
        Promise.resolve(load(key)).then(value => {
          record.expires = now() + ttl
          start.resolve(value)
        }, reject)
      } catch (error) { reject(error) }
      return start.promise
    },
    delete(key) { cache.delete(key) },
  }
}
`,
    },
    checks: {
      async 'same-key calls share work'({ createCatalog }) {
        const pending = deferred()
        let count = 0
        const catalog = createCatalog(() => { count += 1; return pending.promise })
        const values = Promise.all([catalog.lookup('a'), catalog.lookup('a')])
        pending.resolve('x')
        assert.deepEqual(await values, ['x', 'x'])
        assert.equal(count, 1)
      },
      async 'unrelated keys stay available'({ createCatalog }) {
        const pending = deferred()
        const catalog = createCatalog(key => key === 'a' ? pending.promise : 'b')
        const first = catalog.lookup('a')
        assert.equal(await catalog.lookup('b'), 'b')
        pending.resolve('a')
        assert.equal(await first, 'a')
      },
      async 'TTL starts on successful completion'({ createCatalog }) {
        const pending = deferred()
        let time = 0
        let count = 0
        const catalog = createCatalog(() => ++count === 1 ? pending.promise : 'new', { now: () => time, ttl: 10 })
        const first = catalog.lookup('k')
        time = 20
        pending.resolve('old')
        await first
        time = 29
        assert.equal(await catalog.lookup('k'), 'old')
        time = 30
        assert.equal(await catalog.lookup('k'), 'new')
      },
      async 'a rejection does not poison retries'({ createCatalog }) {
        let count = 0
        const catalog = createCatalog(async () => {
          if (++count === 1) throw new Error('pending failure')
          return 'recovered'
        })
        await assert.rejects(catalog.lookup('k'), /pending failure/)
        assert.equal(await catalog.lookup('k'), 'recovered')
      },
      async 'late success cannot overwrite a new entry'({ createCatalog }) {
        const pending = deferred()
        let count = 0
        const catalog = createCatalog(() => ++count === 1 ? pending.promise : 'new')
        const first = catalog.lookup('k')
        catalog.refresh('k')
        assert.equal(await catalog.lookup('k'), 'new')
        pending.resolve('old')
        assert.equal(await first, 'old')
        assert.equal(await catalog.lookup('k'), 'new')
      },
      async 'late rejection cannot delete a new entry'({ createCatalog }) {
        const pending = deferred()
        let count = 0
        const catalog = createCatalog(() => ++count === 1 ? pending.promise : count)
        const first = assert.rejects(catalog.lookup('k'), /old failure/)
        catalog.refresh('k')
        assert.equal(await catalog.lookup('k'), 2)
        pending.reject(new Error('old failure'))
        await first
        assert.equal(await catalog.lookup('k'), 2)
      },
      async 'a loader can refresh synchronously'({ createCatalog }) {
        const pending = deferred()
        let count = 0
        const catalog = createCatalog(() => {
          if (++count !== 1) return 'new'
          catalog.refresh('k')
          return pending.promise
        })
        const first = catalog.lookup('k')
        pending.resolve('old')
        assert.equal(await first, 'old')
        assert.equal(await catalog.lookup('k'), 'new')
      },
    },
  },
  'state-migration': {
    prompt: 'Migrate the persisted settings format from the existing flat document to ' +
      'version 2: { schemaVersion: 2, transport: { enabled, retries }, ...otherFields }. ' +
      'Keep the flat in-memory API { enabled, retries, ...otherFields } and the public load/save functions. ' +
      'Read existing flat files, default missing enabled/retries to true/3, preserve explicit false/0 and unrelated extra fields, ' +
      'and reject unsupported schema versions and invalid field types. Missing files use defaults. ' +
      'Validate before replacing an existing file, and make persistence atomic. Every overlapping save to the same file must succeed even while a previous replacement is briefly busy, and the file must end with one complete submitted document. ' +
      'Run the supplied tests with node --test, add focused coverage as needed, and leave changes uncommitted.',
    entry: 'settings.mjs',
    withGradingEnvironment: withBusyReplacement,
    files: {
      'state.mjs': `export function decode(value) {
  return { ...value, enabled: value.enabled || true, retries: value.retries || 3 }
}
export function encode(value) { return decode(value) }
`,
      'settings.mjs': `import fs from 'node:fs/promises'
import { decode, encode } from './state.mjs'

export async function load(file) {
  return decode(JSON.parse(await fs.readFile(file, 'utf8')))
}
export async function save(file, value) {
  await fs.writeFile(file, JSON.stringify(encode(value)))
}
`,
      'public.test.mjs': testPublicStore,
      'busy-replacement.mjs': busyReplacementSource,
    },
    reference: {
      'state.mjs': `function fields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid settings')
  return value
}
export function decode(value) {
  const { schemaVersion, transport, ...rest } = fields(value)
  if (schemaVersion !== undefined && schemaVersion !== 2) throw new Error('Unsupported settings version')
  const source = schemaVersion === 2 ? fields(transport) : rest
  const { enabled = true, retries = 3 } = source
  if (typeof enabled !== 'boolean' || !Number.isInteger(retries) || retries < 0) throw new Error('Invalid transport')
  return { ...rest, enabled, retries }
}
export function encode(value) {
  const { enabled, retries, ...rest } = decode(value)
  return { ...rest, schemaVersion: 2, transport: { enabled, retries } }
}
`,
      'settings.mjs': `import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { decode, encode } from './state.mjs'
const writes = new Map()
export async function load(file) {
  try { return decode(JSON.parse(await fs.readFile(file, 'utf8'))) }
  catch (error) { if (error.code === 'ENOENT') return decode({}); throw error }
}
export async function save(file, value) {
  const text = JSON.stringify(encode(value))
  const next = (writes.get(file) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const temporary = file + '.' + randomUUID()
    try { await fs.writeFile(temporary, text, { flag: 'wx' }); await fs.rename(temporary, file) }
    finally { await fs.rm(temporary, { force: true }) }
  })
  writes.set(file, next)
  try { await next }
  finally { if (writes.get(file) === next) writes.delete(file) }
}
`,
    },
    checks: {
      async 'loads flat files with false and zero'({ load }, file) {
        await fs.writeFile(file, JSON.stringify({ enabled: false, retries: 0, owner: 'local' }))
        assert.deepEqual(await load(file), { enabled: false, retries: 0, owner: 'local' })
      },
      async 'loads version 2 through the original API'({ load }, file) {
        await fs.writeFile(file, JSON.stringify({ schemaVersion: 2, transport: { enabled: false, retries: 0 }, owner: 'local' }))
        assert.deepEqual(await load(file), { enabled: false, retries: 0, owner: 'local' })
      },
      async 'writes version 2 without losing metadata'({ load, save }, file) {
        const value = { enabled: false, retries: 0, extra: { colors: ['blue'] } }
        await save(file, value)
        assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { schemaVersion: 2,
          transport: { enabled: false, retries: 0 }, extra: value.extra })
        assert.deepEqual(await load(file), value)
      },
      async 'defaults missing files and fields'({ load }, file) {
        assert.deepEqual(await load(file), { enabled: true, retries: 3 })
        await fs.writeFile(file, '{}')
        assert.deepEqual(await load(file), { enabled: true, retries: 3 })
      },
      async 'rejects future versions and invalid types'({ load }, file) {
        await fs.writeFile(file, '{"schemaVersion":3}')
        await assert.rejects(load(file))
        await fs.writeFile(file, '{"retries":"4"}')
        await assert.rejects(load(file))
      },
      async 'a failed save leaves existing bytes intact'({ save }, file) {
        const existing = '{"enabled":true,"retries":4}'
        await fs.writeFile(file, existing)
        await assert.rejects(save(file, { enabled: false, retries: Infinity }))
        assert.equal(await fs.readFile(file, 'utf8'), existing)
      },
      async 'concurrent saves leave one complete document'({ load, save }, file) {
        const values = Array.from({ length: 8 }, (_, retries) =>
          ({ enabled: Boolean(retries % 2), retries, text: String(retries).repeat(32_000) }))
        await Promise.all(values.map(value => save(file, value)))
        const loaded = await load(file)
        assert.deepEqual(loaded, values[loaded.retries])
        assert.deepEqual(await fs.readdir(path.dirname(file)), [path.basename(file)])
      },
      async 'concurrent saves complete while replacement is busy'(storage, file, check) {
        const values = Array.from({ length: 8 }, (_, retries) =>
          ({ enabled: Boolean(retries % 2), retries, text: String(retries).repeat(16_000) }))
        await check(storage, file, values)
      },
    },
  },
}

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const sqliteFlags = process.allowedNodeEnvironmentFlags.has('--experimental-sqlite') ? ['--experimental-sqlite'] : []
const prompt = `Implement a durable local job queue across the existing Node modules. Preserve the synchronous openQueue(file, { now = Date.now } = {}) API in queue.mjs and compatibility with consumer.mjs. Use built-in Node modules, including SQLite if useful.

- enqueue(key, payload, { availableAt = now() } = {}) accepts nonempty string keys, JSON payloads and nonnegative safe integer times. Repeated keys return the original string id and keep its payload, including after completion and reopening.
- claim(worker, leaseMs) requires a nonempty string worker and a positive safe integer lease duration. Return null or { id, key, payload, token, attempts }. Take the earliest eligible job, then insertion order. One process can hold a live lease. At exact expiry a new claim is eligible with a new token and incremented attempts.
- ack(id, token) completes the current live lease. retry(id, token, delayMs) requires a nonnegative safe integer delay and clears the lease to reschedule for now() + delayMs. Both return false for stale or expired tokens, and completed jobs stay completed.
- Multiple processes may open, enqueue and claim concurrently. A worker can die without closing its queue. Its lease persists and can be recovered when it expires.
- Validate bad input before changing state. Keep close() available. Add regression tests, run node --test, and leave changes uncommitted.
`

const consumer = `export async function processNext(queue, worker, handle, { leaseMs = 100, retryDelay = 5 } = {}) {
  const job = queue.claim(worker, leaseMs)
  if (!job) return null
  try {
    await handle(job.payload)
  } catch {
    return queue.retry(job.id, job.token, retryDelay) ? 'retry' : 'lost'
  }
  return queue.ack(job.id, job.token) ? 'done' : 'lost'
}
`
const memory = `export function openQueue(_file, { now = Date.now } = {}) {
  const jobs = new Map()
  return {
    enqueue(key, payload, { availableAt = now() } = {}) {
      jobs.set(key, { id: key, key, payload, availableAt, attempts: 0 })
      return key
    },
    claim(worker, leaseMs) {
      const row = [...jobs.values()].find(job => job.availableAt <= now())
      return row ? { id: row.id, key: row.key, payload: row.payload, token: worker + leaseMs, attempts: ++row.attempts } : null
    },
    ack(id, _token) { return jobs.delete(id) },
    retry(id, _token, delayMs) {
      const row = jobs.get(id)
      if (!row) return false
      row.availableAt = now() + delayMs
      return true
    },
    close() {},
  }
}
`
const publicTest = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openQueue } from './queue.mjs'
import { processNext } from './consumer.mjs'

test('processNext consumes an enqueued payload using the public API', async () => {
  const queue = openQueue(':memory:', { now: () => 1000 })
  try {
    queue.enqueue('visible', { message: '示例' })
    assert.equal(await processNext(queue, 'worker', payload => assert.deepEqual(payload, { message: '示例' })), 'done')
  } finally {
    queue.close()
  }
})

test('rejecting a zero-duration lease leaves the first attempt available', t => {
  const queue = openQueue(':memory:', { now: () => 1000 })
  t.after(() => queue.close())
  queue.enqueue('visible-lease', true)
  assert.throws(() => queue.claim('worker', 0))
  assert.equal(queue.claim('other', 10)?.attempts, 1)
})
`
const schema = `export const schema = \`
  CREATE TABLE IF NOT EXISTS jobs (
    seq INTEGER PRIMARY KEY,
    id TEXT UNIQUE NOT NULL,
    key TEXT UNIQUE NOT NULL,
    payload TEXT NOT NULL,
    available INTEGER NOT NULL,
    token TEXT,
    expires INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    done INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS ready ON jobs (done, available, seq);
\`
`
const storage = `import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { schema } from './schema.mjs'

function nonempty(value) {
  if (typeof value !== 'string' || !value.length) throw new TypeError('Expected a nonempty string')
  return value
}
function integer(value, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new RangeError('Invalid integer time')
  return value
}
function assertJson(value, active = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value)) return
  if (typeof value !== 'object' || active.has(value)) throw new TypeError('Expected a JSON value')
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('Expected a JSON object')
  active.add(value)
  for (const item of Array.isArray(value) ? value : Object.values(value)) assertJson(item, active)
  active.delete(value)
}

export function openQueue(file, { now = Date.now } = {}) {
  nonempty(file)
  if (typeof now !== 'function') throw new TypeError('Expected a clock function')
  const db = new DatabaseSync(file)
  try {
    db.exec('PRAGMA busy_timeout = 6000')
    db.exec(schema)
    const lookup = db.prepare('SELECT id FROM jobs WHERE key = ?')
    const insert = db.prepare(
      'INSERT INTO jobs(id,key,payload,available) VALUES(?,?,?,?) ON CONFLICT(key) DO NOTHING RETURNING id'
    )
    const claim = db.prepare(\`
      UPDATE jobs SET token=?, expires=?, attempts=attempts+1 WHERE seq=(
        SELECT seq FROM jobs WHERE done=0 AND available <= ? AND (expires IS NULL OR expires <= ?)
        ORDER BY available, seq LIMIT 1
      ) RETURNING id,key,payload,attempts
    \`)
    const acknowledge = db.prepare('UPDATE jobs SET done=1,token=NULL,expires=NULL WHERE id=? AND token=? AND expires > ?')
    const postpone = db.prepare('UPDATE jobs SET available=?,token=NULL,expires=NULL WHERE id=? AND token=? AND expires > ?')
    let closed = false
    const clock = () => integer(now())
    return {
      enqueue(key, payload, { availableAt = clock() } = {}) {
        nonempty(key)
        integer(availableAt)
        assertJson(payload)
        return insert.get(randomUUID(), key, JSON.stringify(payload), availableAt)?.id ?? lookup.get(key).id
      },
      claim(worker, leaseMs) {
        nonempty(worker)
        const time = clock()
        const until = integer(time + integer(leaseMs, 1))
        const token = randomUUID()
        const job = claim.get(token, until, time, time)
        return job ? { id: job.id, key: job.key, payload: JSON.parse(job.payload), token, attempts: job.attempts } : null
      },
      ack(id, token) { return acknowledge.run(nonempty(id), nonempty(token), clock()).changes === 1 },
      retry(id, token, delayMs) {
        const time = clock()
        return postpone.run(integer(time + integer(delayMs)), nonempty(id), nonempty(token), time).changes === 1
      },
      close() { if (!closed) { db.close(); closed = true } },
    }
  } catch (error) {
    db.close()
    throw error
  }
}
`

async function withQueues(api, file, test) {
  const opened = new Set()
  let time = 1000
  const open = () => {
    const queue = api.openQueue(file, { now: () => time })
    opened.add(queue)
    return queue
  }
  const close = queue => { queue.close(); opened.delete(queue) }
  try { await test({ open, close, tick: amount => { time += amount } }) }
  finally { for (const queue of opened) queue.close() }
}

const workerScript = `
const [entry, file, operation, value] = process.argv.slice(1)
const { openQueue } = await import(entry)
const queue = openQueue(file, { now: () => 1000 })
const result = operation === 'enqueue' ? queue.enqueue('shared-key', value) : queue.claim('worker-' + value, 100)
if (operation === 'crash') process.stdout.write(JSON.stringify(result), () => process.exit(77))
else { queue.close(); console.log(JSON.stringify(result)) }
`
async function worker(folder, file, operation, value) {
  const entry = pathToFileURL(path.join(folder, 'queue.mjs')).href
  const args = [...sqliteFlags, '--input-type=module', '-e', workerScript, entry, file, operation, String(value ?? '')]
  try {
    const { stdout } = await execute(process.execPath, args, { timeout: 4500, windowsHide: true })
    return JSON.parse(stdout)
  } catch (error) {
    if (operation === 'crash' && error.code === 77) return JSON.parse(error.stdout)
    throw error
  }
}

export const durableJobs = {
  prompt,
  entry: 'queue.mjs',
  nodeFlags: sqliteFlags,
  checkTimeoutMs: 5000,
  files: {
    'README.md': prompt,
    'queue.mjs': "export { openQueue } from './lib/memory-queue.mjs'\n",
    'consumer.mjs': consumer,
    'lib/memory-queue.mjs': memory,
    'public.test.mjs': publicTest,
  },
  reference: {
    'queue.mjs': "export { openQueue } from './lib/sqlite-queue.mjs'\n",
    'lib/schema.mjs': schema,
    'lib/sqlite-queue.mjs': storage,
  },
  checks: {
    'Unicode and JSON survive close and reopen': (api, file) => withQueues(api, file, ({ open, close }) => {
      const payload = { message: '队列 Ω 🛠', values: [false, 0, null] }
      const first = open()
      const id = first.enqueue('任务', payload)
      close(first)
      const claimed = open().claim('worker', 10)
      assert.deepEqual([claimed.id, claimed.payload, claimed.attempts], [id, payload, 1])
    }),
    'a completed key remains idempotent after reopen': (api, file) => withQueues(api, file, ({ open, close }) => {
      const first = open()
      const id = first.enqueue('one', 'original')
      assert.equal(first.enqueue('one', 'later'), id)
      const claimed = first.claim('worker', 10)
      assert.equal(claimed.payload, 'original')
      assert.equal(first.ack(id, claimed.token), true)
      close(first)
      const reopened = open()
      assert.equal(reopened.enqueue('one', 'new'), id)
      assert.equal(reopened.claim('worker', 10), null)
    }),
    'delayed jobs follow time and insertion order': (api, file) => withQueues(api, file, ({ open, tick }) => {
      const queue = open()
      queue.enqueue('late', 0, { availableAt: 1010 })
      queue.enqueue('earliest', 1, { availableAt: 1005 })
      queue.enqueue('tie', 2, { availableAt: 1005 })
      assert.equal(queue.claim('worker', 20), null)
      tick(5)
      assert.equal(queue.claim('worker', 20)?.key, 'earliest')
      assert.equal(queue.claim('worker', 20)?.key, 'tie')
      assert.equal(queue.claim('worker', 20), null)
      tick(5)
      assert.equal(queue.claim('worker', 20)?.key, 'late')
    }),
    'expired tokens fail at the exact boundary': (api, file) => withQueues(api, file, ({ open, tick }) => {
      const queue = open()
      const id = queue.enqueue('expiring', null)
      const first = queue.claim('worker', 50)
      tick(49)
      assert.equal(queue.claim('other', 10), null)
      tick(1)
      assert.equal(queue.ack(id, first.token), false)
      assert.equal(queue.retry(id, first.token, 0), false)
      const second = queue.claim('other', 10)
      assert.equal(second.attempts, 2)
      assert.notEqual(first.token, second.token)
      assert.equal(queue.ack(id, first.token), false)
      assert.equal(queue.ack(id, second.token), true)
    }),
    'retry reschedules once and fences the previous token': (api, file) => withQueues(api, file, ({ open, tick }) => {
      const queue = open()
      const id = queue.enqueue('retry', 0)
      const first = queue.claim('worker', 20)
      assert.equal(queue.retry(id, first.token, 3), true)
      assert.equal(queue.retry(id, first.token, 0), false)
      assert.equal(queue.claim('worker', 20), null)
      tick(3)
      const second = queue.claim('worker', 20)
      assert.equal(second.attempts, 2)
      assert.notEqual(first.token, second.token)
      assert.equal(queue.ack(id, second.token), true)
    }),
    'process exit retains an exclusive lease until recovery': (api, file, _check, folder) => withQueues(api, file, async ({ open, close, tick }) => {
      const first = open()
      const id = first.enqueue('crash', { durable: true })
      close(first)
      const expired = await worker(folder, file, 'crash')
      assert.equal(expired?.id, id)
      const queue = open()
      assert.equal(queue.claim('rescuer', 20), null)
      tick(100)
      const recovered = queue.claim('rescuer', 20)
      assert.deepEqual([recovered.payload, recovered.attempts], [{ durable: true }, 2])
      assert.equal(queue.ack(id, expired.token), false)
      assert.equal(queue.ack(id, recovered.token), true)
    }),
    'concurrent initial opens and enqueues preserve one payload': (api, file, _check, folder) => withQueues(api, file, async ({ open }) => {
      const ids = await Promise.all(Array.from({ length: 5 }, (_, value) => worker(folder, file, 'enqueue', value)))
      assert.equal(new Set(ids).size, 1)
      const queue = open()
      const job = queue.claim('consumer', 10)
      assert.equal(job?.id, ids[0])
      assert.match(job.payload, /^[0-4]$/)
      assert.equal(queue.claim('other', 10), null)
    }),
    'concurrent workers claim a single persisted job exactly once': (api, file, _check, folder) => withQueues(api, file, async ({ open }) => {
      const id = open().enqueue('single', true)
      const claims = (await Promise.all(Array.from({ length: 6 }, (_, value) => worker(folder, file, 'claim', value)))).filter(Boolean)
      assert.equal(claims.length, 1)
      assert.equal(claims[0].id, id)
      assert.equal(claims[0].attempts, 1)
    }),
    'invalid inputs leave queue state unchanged': (api, file) => withQueues(api, file, ({ open }) => {
      const queue = open()
      assert.throws(() => queue.enqueue('', 1), 'reject an empty job key')
      assert.throws(() => queue.enqueue('invalid-json', { value: undefined }), 'reject values that JSON would discard')
      assert.throws(() => queue.enqueue('invalid-time', 7, { availableAt: -1 }), 'reject a negative initial availability time')
      const id = queue.enqueue('valid', 1)
      assert.throws(() => queue.claim('worker', 0), 'reject a zero-duration lease before acquiring it')
      const job = queue.claim('worker', 10)
      assert.equal(job.id, id)
      assert.equal(job.attempts, 1)
      assert.throws(() => queue.retry(id, job.token, -1), 'reject a negative retry delay before releasing the lease')
      assert.equal(queue.ack(id, job.token), true)
      assert.equal(queue.claim('worker', 10), null)
    }),
    'unchanged consumer retries an error and processes the recovered job': (api, file) => withQueues(api, file, async ({ open, close, tick }) => {
      const { processNext } = await import('data:text/javascript,' + encodeURIComponent(consumer))
      const first = open()
      const id = first.enqueue('consumer', { version: 2 })
      assert.equal(await processNext(first, 'first', () => { throw new Error('retry') }), 'retry')
      close(first)
      const second = open()
      assert.equal(await processNext(second, 'second', () => assert.fail('retry ran too soon')), null)
      tick(5)
      assert.equal(await processNext(second, 'second', payload => assert.deepEqual(payload, { version: 2 })), 'done')
      assert.equal(second.enqueue('consumer', null), id)
      assert.equal(await processNext(second, 'second', () => assert.fail('job repeated')), null)
    }),
  },
}

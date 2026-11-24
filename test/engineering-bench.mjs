/** Prepare equivalent workspaces and grade candidates outside the files given to the agent. */
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { cases } from './fixtures/engineering-cases.mjs'

const self = fileURLToPath(import.meta.url)
const execute = promisify(execFile)

function scenario(name) {
  if (!Object.hasOwn(cases, name)) throw new Error('Unknown case. Choices: ' + Object.keys(cases).join(', '))
  return cases[name]
}

async function prepare(folder, files) {
  await fs.mkdir(folder)
  for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(folder, name), text)
}

function baselineCommit(cwd) {
  const git = (...args) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, timeout: 8000, windowsHide: true })
  git('-c', 'init.templateDir=', 'init', '--quiet')
  git('add', '--all')
  git('-c', 'user.name=SuperPi Benchmark', '-c', 'user.email=benchmark@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Benchmark starting point')
}

async function score(name, folder) {
  const selected = scenario(name)
  const candidate = await import(pathToFileURL(path.join(folder, selected.entry)))
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'superpi-grading-'))
  try {
    const checks = []
    for (const [label, verify] of Object.entries(selected.checks)) {
      let timer
      try {
        const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Assertion timed out')), 1800) })
        const sample = await fs.mkdtemp(path.join(temp, 'sample-'))
        await Promise.race([verify(candidate, path.join(sample, 'settings.json')), deadline])
        checks.push({ label, pass: true })
      } catch (error) {
        checks.push({ label, pass: false, reason: String(error?.message ?? error).slice(0, 350) })
      } finally {
        clearTimeout(timer)
      }
    }
    return checks
  } finally {
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 3 })
  }
}

async function grade(name, folder) {
  const selected = scenario(name)
  // Credentials are unnecessary for these deterministic, local project checks.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|LANG|LC_ALL)$/i.test(key)))
  const started = performance.now()
  const { stdout } = await execute(process.execPath, [self, 'worker', name, folder], {
    cwd: folder, env, timeout: 20_000, windowsHide: true, maxBuffer: 512 * 1024,
  })
  const checks = JSON.parse(stdout.trim().split('\n').at(-1))
  const expected = Object.keys(selected.checks)
  assert.deepEqual(checks.map(item => item.label), expected)
  assert.ok(checks.every(item => typeof item.pass === 'boolean'))
  const passed = checks.filter(item => item.pass).length
  return { case: name, passed, total: expected.length, gradingMs: Math.round(performance.now() - started), checks }
}

async function selfTest() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'superpi-engineering-'))
  let count = 0
  try {
    for (const [name, selected] of Object.entries(cases)) {
      const baseline = path.join(temp, name + '-baseline')
      const reference = path.join(temp, name + '-reference')
      await prepare(baseline, selected.files)
      await prepare(reference, { ...selected.files, ...selected.reference })
      const before = await grade(name, baseline)
      const after = await grade(name, reference)
      assert.ok(before.passed < before.total, name + ' must recognize the incomplete starting point')
      assert.equal(after.passed, after.total, name + ' reference ' + JSON.stringify(after.checks.filter(check => !check.pass)))
      count += 2
      console.log(name + ' baseline ' + before.passed + '/' + before.total + ' reference ' + after.passed + '/' + after.total)
    }
    console.log('PASS (' + count + ' checks)')
  } finally {
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 3 })
  }
}

const [action, name, location] = process.argv.slice(2)
if (!action) await selfTest()
else if (action === 'list') console.log(Object.keys(cases).join('\n'))
else {
  const selected = scenario(name)
  if (!location) throw new Error('Supply a workspace directory.')
  const folder = path.resolve(location)
  if (action === 'prepare') {
    await prepare(folder, selected.files)
    baselineCommit(folder)
    console.log(selected.prompt)
  } else if (action === 'grade') {
    const result = await grade(name, folder)
    console.log(JSON.stringify(result, null, 2))
    if (result.passed !== result.total) process.exitCode = 1
  } else if (action === 'worker') {
    console.log(JSON.stringify(await score(name, folder)))
  } else {
    throw new Error('Use list, prepare <case> <new-directory>, or grade <case> <workspace>.')
  }
}

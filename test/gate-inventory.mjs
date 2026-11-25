#!/usr/bin/env node
/** Execute the test plan once and check the counts reported by those same processes. */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)
const inventoryPath = path.join(here, 'gate-inventory.json')

// Keep the suite serial: timing assertions use the same CPU as the gate runner.
export const SUITE_GATES = Object.freeze([
  'preflight', 'selfcheck', 'client-render', 'css-tokens', 'runtime-resolve', 'config-hot',
  'host-parity', 'session-projects', 'session-lifecycle', 'timeout', 'rules', 'context-guard',
  'modalities', 'turn-verdict', 'text-integrity', 'delivery', 'reliability', 'engineering-bench',
  'parity', 'tui-editor', 'brand-pi-runtime', 'restart-lib', 'github-sync', 'version',
])

function runGate(name, counted, stream, signal) {
  const file = path.join(here, name + '.mjs')
  if (!fs.existsSync(file)) return { checks: null, failure: '找不到 ' + file, exitCode: 1 }
  return new Promise(resolve => {
    const child = execFile(process.execPath, [file], {
      cwd: root, windowsHide: true, signal, timeout: counted ? 180000 : 0, maxBuffer: 32 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const output = stdout + '\n' + stderr
      if (error) {
        if (!stream && output.trim()) console.error(output.trimEnd())
        resolve({
          checks: null,
          failure: '子进程未通过（' + (error.signal ?? error.code ?? error.message) + '）',
          exitCode: typeof error.code === 'number' ? error.code : 1,
        })
        return
      }
      // Standalone summary lines are the gate's own measured coverage.
      const counts = counted ? Array.from(output.matchAll(/^[ \t]*PASS \(([0-9]+) (?:checks|assertions)\)[ \t]*\r?$/gm)) : []
      const measured = counts.length === 1 ? Number(counts[0][1]) : null
      const checks = Number.isSafeInteger(measured) ? measured : null
      const failure = counted && checks === null ? '需要且只能有一行 PASS (N checks) 或 PASS (N assertions)' : ''
      resolve({ checks, failure, exitCode: failure ? 1 : 0 })
    })
    if (stream) {
      child.stdout.pipe(process.stdout, { end: false })
      child.stderr.pipe(process.stderr, { end: false })
    }
  })
}

async function main() {
  const [option, ...extra] = process.argv.slice(2)
  if (extra.length || ![undefined, '--suite', '--print', '--list'].includes(option)) {
    console.error('用法：node test/gate-inventory.mjs [--suite|--print|--list]')
    return 1
  }
  const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'))
  if (option === '--list') {
    console.log(JSON.stringify(inventory, null, 2))
    return 0
  }
  const counted = Object.keys(inventory).filter(name => !name.startsWith('_'))
  if (!counted.length || counted.some(name => !/^[a-z0-9-]+$/.test(name) ||
    !Number.isSafeInteger(inventory[name]) || inventory[name] < 1)) {
    throw new Error('门禁登记必须包含合法的名称和正整数下限')
  }
  const suite = option === '--suite'
  if (suite) {
    const missing = counted.filter(name => !SUITE_GATES.includes(name))
    if (missing.length) throw new Error('已登记但未进入 npm test：' + missing.join(', '))
    if (SUITE_GATES.length !== new Set(SUITE_GATES).size ||
        SUITE_GATES[0] !== 'preflight' || SUITE_GATES.at(-1) !== 'version') {
      throw new Error('门禁顺序必须唯一，依赖检查在首位，版本与登记校验在末位')
    }
  }

  const controller = new AbortController()
  const interrupt = () => controller.abort(130)
  const terminate = () => controller.abort(143)
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', terminate)
  try {
    const results = []
    for (const name of suite ? SUITE_GATES : counted) {
      const minimum = Object.hasOwn(inventory, name) ? inventory[name] : undefined
      console.log('\n── ' + name + ' ──')
      const result = await runGate(name, minimum !== undefined, suite, controller.signal)
      if (controller.signal.aborted) {
        console.error('门禁已取消：' + name)
        return controller.signal.reason
      }
      const belowFloor = option !== '--print' && minimum !== undefined && !result.failure && result.checks < minimum
      const failure = result.failure || (belowFloor ? '实测 ' + result.checks + ' 低于登记下限 ' + minimum : '')
      if (failure) {
        console.error('FAIL ' + name + ' · ' + failure)
        if (suite) return result.exitCode || 1
      }
      if (minimum !== undefined) results.push({ name, minimum, checks: result.checks, failure })
    }

    if (option === '--print') {
      console.log('\n实测值（用于更新 test/gate-inventory.json）')
      console.log(JSON.stringify(Object.fromEntries(results.map(({ name, checks }) => [name, checks ?? 0])), null, 2))
    } else {
      console.log('\n── 门禁规模对账 ──')
      for (const { name, minimum, checks, failure } of results) {
        console.log('  ' + (failure ? '✗' : '✓') + ' ' + name.padEnd(20) + '登记 ' + minimum + ' · 实测 ' + (checks ?? '不可验证'))
      }
      const failures = results.filter(result => result.failure).length
      console.log(failures ? 'FAILED ' + failures + ' / ' + results.length
        : 'PASS (' + results.length + ' gates, 规模均不低于登记值)')
    }
    return results.some(result => result.failure) ? 1 : 0
  } finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', terminate)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main()
}

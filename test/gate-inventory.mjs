#!/usr/bin/env node
/**
 * 门禁规模对账 —— 「文档说的 check 数」与「真实跑的 check 数」的唯一判据。
 *
 * ── 为什么需要这个文件（0.16.1）───────────────
 *
 * 0.16.0 的对抗性审查发现：AGENTS.md 里到处写着「parity 98 checks」
 * 「host-parity **412 checks**」「tui-editor 459 checks」，
 * 而实测是 102 / 430 / 521 —— **并且没有任何门禁校验这些数字**。
 *
 * 这件事的严重性不在「数字不准」，而在于：
 * AGENTS.md 把 check 数当作**对齐强度的证据**加粗强调。数字一旦能自由漂移，
 * 文档就从「可校验的事实」退化成「曾经的印象」，而它恰恰是接手者唯一的行为指南。
 * 更糟的是它掩盖真实退化：某套门禁因为缺依赖整段 SKIP（0.16.0 的 F-06），
 * 文档上的数字岿然不动，看起来一切正常。
 *
 * ── 设计：一张表 + 一条下限判据 ───────────────
 *
 * 数字只登记在 `test/gate-inventory.json` 一处（不是 AGENTS.md 里的 N 处副本）。
 * 判据是 **实测 >= 登记**，不是相等：
 *   · 上升 = 补了用例，正常。改完顺手把登记值抬到实测值。
 *   · 下降 = 某条能力被削弱、或某套门禁漏跑（F-06 那种）→ 必须红。
 *
 * ── 与 test/version.mjs 的分工 ───────────────
 *
 * version.mjs 只做「登记表本身自洽」：文件都在、npm test 跑的每一套都登记了。
 * 本文件做「登记值 vs 实测值」：真的把每套门禁跑一遍，读它自己打印的数字。
 *
 * 为什么不塞进 version.mjs：那会把整套门禁跑第二遍（npm test 时间翻倍）。
 * 本文件单独跑（约 40 秒），挂在 npm test 末尾作为收口 —— 顺序上它在所有
 * 门禁之后，所以拿到的是「这一轮真实跑出来的」结果。
 *
 * 跑法：node test/gate-inventory.mjs            # 对账，不一致即 exit 1
 *       node test/gate-inventory.mjs --print    # 只打印实测值（用于更新登记表）
 *       node test/gate-inventory.mjs --list     # 打印登记表原样
 *
 * 依赖：不需要 pi（本文件只跑子进程、读它们的输出）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)
const inventoryPath = path.join(here, 'gate-inventory.json')

const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'))
const gates = Object.keys(inventory).filter(key => key.startsWith('_') === false)

const mode = process.argv.includes('--print') ? 'print'
  : process.argv.includes('--list') ? 'list'
    : 'check'

if (mode === 'list') {
  console.log(JSON.stringify(inventory, null, 2))
  process.exit(0)
}

/**
 * 跑一套门禁并读取它自己声明的规模。
 *
 * 数字的来源必须是被测门禁**自己打印的**，不能是本文件估算的 ——
 * 否则又成了一份转述（本仓库已经吃过一次「转述漂移」的亏）。
 */
function runGate(name) {
  const file = path.join(here, name + '.mjs')
  if (fs.existsSync(file) === false) {
    return { name, ok: false, checks: 0, reason: 'file not found: test/' + name + '.mjs' }
  }
  return new Promise(resolve => {
    execFile(process.execPath, [file], { cwd: root, timeout: 180000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      const text = String(stdout) + '\n' + String(stderr)
      // 各门禁的收尾格式：`PASS (N checks)` / `PASS (N assertions)`。
      const match = /PASS\s*\(([0-9]+)\s+(?:checks|assertions)\)/.exec(text)
      const checks = match === null ? 0 : Number(match[1])
      const passed = error === null && match !== null
      resolve({
        name,
        ok: passed,
        checks,
        reason: passed ? '' : (error === null
          ? '本门禁没有打印 PASS (N checks)'
          : '本门禁失败：' + String(error.message || '').split('\n')[0]),
      })
    })
  })
}

// 串行跑：并行会互相抢 CPU 让耗时断言（host-parity 的切帧器计时）失真。
const results = []
for (const name of gates) {
  process.stdout.write('  ' + name.padEnd(20) + ' ... ')
  const result = await runGate(name)
  results.push(result)
  console.log(result.ok ? String(result.checks) + ' checks' : 'FAILED (' + result.reason + ')')
}

if (mode === 'print') {
  const measured = {}
  for (const result of results) measured[result.name] = result.checks
  console.log('')
  console.log('实测值（用于更新 test/gate-inventory.json）：')
  console.log(JSON.stringify(measured, null, 2))
  process.exit(results.every(result => result.ok) ? 0 : 1)
}

/* ────────────────────────────────────────── 对账 */

let failed = 0
const regressions = []
const unverified = []

for (const result of results) {
  const documented = inventory[result.name]
  if (result.ok === false) {
    // 门禁自己没跑通：这不是「规模不足」，是那一套整体失效。
    // 不去猜它的数字（猜出来的数字毫无意义），单独列出。
    unverified.push(result)
    failed += 1
    continue
  }
  if (result.checks < documented) {
    regressions.push({ name: result.name, documented, actual: result.checks })
    failed += 1
  }
}

console.log('')
console.log('── 对账 ' + '─'.repeat(56))
for (const result of results) {
  const documented = inventory[result.name]
  const mark = result.ok === false ? '✗ 未跑通' : (result.checks < documented ? '✗ 退化' : '✓')
  const delta = result.ok === true && result.checks !== documented
    ? '  (' + (result.checks > documented ? '+' : '') + String(result.checks - documented) + ')'
    : ''
  console.log('  ' + mark + '  ' + result.name.padEnd(20) + '登记 ' + String(documented).padStart(5) + '  实测 ' + String(result.checks).padStart(5) + delta)
}

if (unverified.length > 0) {
  console.error('')
  console.error('以下门禁没跑通，规模无法核对（不能当作「通过」）：')
  for (const result of unverified) console.error('  ' + result.name + ' → ' + result.reason)
}
if (regressions.length > 0) {
  console.error('')
  console.error('以下门禁的规模低于登记值 —— 要么某条能力被削弱，要么某套门禁漏跑：')
  for (const item of regressions) console.error('  ' + item.name + ' → 登记 ' + String(item.documented) + '，实测 ' + String(item.actual))
  console.error('')
  console.error('如果这是**有意**删掉能力，请在 AGENTS.md 记明原因，再把 test/gate-inventory.json 调低。')
  console.error('如果是补了用例让数字上升，把登记值抬到实测值即可（node test/gate-inventory.mjs --print）。')
}

console.log('')
if (failed === 0) {
  console.log('PASS (' + String(results.length) + ' gates, 规模均不低于登记值)')
  process.exit(0)
}
console.error('FAILED ' + String(failed) + ' / ' + String(results.length))
process.exit(1)

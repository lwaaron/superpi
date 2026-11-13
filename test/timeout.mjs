#!/usr/bin/env node
/**
 * 超时语义门禁：timeoutLimitMs 的三态 + armTimer 的「弹窗未答则让位」。
 *
 * 为什么单独一个测试文件：这两条语义在真 pi 上无法可靠复现——要复现「命令在等弹窗」
 * 得让一个真人（或一个脚本）去点对话框，要复现「命令永不回答」得让模型 hang 5 分钟。
 * 而它们恰恰是 0.3.0 之前那个可见缺陷（面板显示 "pi command timed out: prompt" 红条，
 * 同时一个仍在倒计时的对话框挂在屏幕上，点下去还会被 pi 丢弃）的全部成因。
 * 所以用 test/fixtures/fake-pi-rpc.mjs 这个协议替身把时序压到毫秒级，进 npm test。
 *
 * 跑法：node test/timeout.mjs
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PiProcess, timeoutLimitMs } from '../src/pi-rpc.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)
const fake = path.join(root, 'test', 'fixtures', 'fake-pi-rpc.mjs')

let failures = 0
const check = (condition, message) => {
  if (condition === true) {
    console.log('  ok   ' + message)
    return
  }
  failures += 1
  console.error('  FAIL ' + message)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function spawnFake(mode) {
  const proc = new PiProcess({
    cliPath: fake,
    nodePath: process.execPath,
    cwd: root,
    args: ['--mode', 'rpc'],
    env: { FAKE_PI_MODE: mode },
    label: 'fake-' + mode,
  })
  const logs = []
  proc.on('log', entry => logs.push(entry.level + ' ' + entry.message))
  proc.start()
  return { proc, logs }
}

// ── 1. timeoutLimitMs 的三态 ────────────────────────────────────────────────
console.log('timeoutLimitMs:')
check(timeoutLimitMs(undefined) === 60_000, 'undefined → 默认 60000')
check(timeoutLimitMs(null) === 60_000, 'null → 默认 60000（JSON 里没写这个键）')
check(timeoutLimitMs(1234) === 1234, '正数 → 原值')
check(timeoutLimitMs(0) === null, '0 → null（不设上限）')
check(timeoutLimitMs(-1) === null, '负数 → null（不设上限）')
check(timeoutLimitMs(Infinity) === null, 'Infinity → null（不设上限）')
check(timeoutLimitMs('2500') === 2500, '数字字符串 → 解析成数字')
check(timeoutLimitMs('  ') === 60_000, '空白字符串 → 默认 60000')
for (const [label, value] of [['NaN', Number.NaN], ['乱码', 'abc'], ['对象', {}], ['布尔', true]]) {
  let threw = null
  try {
    timeoutLimitMs(value)
  } catch (error) {
    threw = error
  }
  check(threw !== null && threw.name === 'TypeError', label + ' → 抛 TypeError（绝不静默降级）')
}

// ── 2. 正数上限真的会超时 ──────────────────────────────────────────────────
console.log('到期即 reject:')
{
  const { proc } = spawnFake('silent')
  await sleep(120)
  let error = null
  try {
    await proc.send({ type: 'prompt', message: 'never answers' }, { timeoutMs: 80 })
  } catch (caught) {
    error = caught
  }
  check(error !== null && /pi command timed out: prompt/.test(String(error.message)), 'timeoutMs=80 → 报 "pi command timed out: prompt"，实际 ' + String(error && error.message))
  check(error !== null && String(error.message).includes('dialog') === false, '没有弹窗时错误里不提对话框')
  check(proc.pending.size === 0, '超时后 pending 表里不留孤儿，实际 ' + String(proc.pending.size))
  await proc.close({ timeoutMs: 1000 })
}

// ── 3. timeoutMs=0 表示不设上限：永不超时 ──────────────────────────────────
console.log('timeoutMs=0 不设上限:')
{
  const { proc } = spawnFake('silent')
  await sleep(120)
  let settled = 'pending'
  const pending = proc.send({ type: 'prompt', message: 'never answers' }, { timeoutMs: 0 })
  pending.then(() => { settled = 'resolved' }, () => { settled = 'rejected' })
  await sleep(400)
  // 400ms 远大于上面第 2 段用的 80ms：同一个假 pi、同一条命令，仅超时入参不同，
  // 一个必失败一个必存活。这就是「0 = 不设上限」与「正数 = 毫秒上限」的分界证据。
  check(settled === 'pending', '同样的命令、400ms 后仍未失败（对比上一段 80ms 即失败）')
  check(proc.pending.size === 1, 'pending 表里还留着这条命令')
  await proc.close({ timeoutMs: 1000 })
  await sleep(120)
  check(settled === 'rejected', '进程关闭时被 handleExit 一次性 reject（不泄漏），实际 ' + settled)
}

// ── 4. 弹窗未答 → 超时让位；应答后命令才完成 ──────────────────────────────
console.log('弹窗让位:')
{
  const { proc, logs } = spawnFake('dialog')
  await sleep(120)
  const command = proc.send({ type: 'prompt', message: 'probe' }, { timeoutMs: 80 })
  let outcome = 'pending'
  command.then(() => { outcome = 'resolved' }, () => { outcome = 'rejected' })
  await sleep(260)
  check(proc.pendingUi.size === 1, '弹窗已登记进 pendingUi，实际 ' + String(proc.pendingUi.size))
  check(outcome === 'pending', '三个超时周期过去仍未失败（计时器被续期了），实际 ' + outcome)
  const ui = [...proc.pendingUi.values()][0]
  check(ui !== undefined && ui.method === 'select', 'pendingUi 里是 select，实际 ' + String(ui && ui.method))
  check(ui !== undefined && ui.timeout === null, '假 pi 没声明 timeout → pendingUi.timeout 应为 null')
  check(logs.some(line => line.includes('timeout deferred')), '日志里能看到续期记录')
  proc.respond({ id: ui.id, value: 'a' })
  await sleep(200)
  check(outcome === 'resolved', '应答弹窗后命令正常完成，实际 ' + outcome)
  check(proc.pendingUi.size === 0, '应答后 pendingUi 清空')
  await proc.close({ timeoutMs: 1000 })
}

// ── 4b. 应答之后必须重开一整轮超时窗口 ────────────────────────────────────
// 这是第 4 段的竞态版：用户在第 N 个超时周期末尾点掉弹窗，pi 还要跑扩展剩下的逻辑。
// 若计时器继承上一轮已经烧掉的时间，它会在应答后的几毫秒内就 reject —— 明明有人答了。
// 结构性断言（deferrals 归零 + timer 换新）比时间断言可靠：它直接锁住「重开窗口」。
console.log('应答后重开窗口:')
{
  const { proc } = spawnFake('dialog')
  await sleep(120)
  const command = proc.send({ type: 'prompt', message: 'probe' }, { timeoutMs: 120 })
  let outcome = 'pending'
  command.then(() => { outcome = 'resolved' }, () => { outcome = 'rejected' })
  await sleep(400)
  const waiter = [...proc.pending.values()][0]
  const burnedTimer = waiter !== undefined ? waiter.timer : null
  check(waiter !== undefined && waiter.deferrals >= 3, '续期已累积（deferrals >= 3），实际 ' + String(waiter && waiter.deferrals))
  const ui = [...proc.pendingUi.values()][0]
  proc.respond({ id: ui.id, value: 'b' })
  check(waiter !== undefined && waiter.deferrals === 0, '应答后 deferrals 归零（不继承烧掉的时间）')
  check(waiter !== undefined && waiter.timer !== null && waiter.timer !== burnedTimer, '应答后换了新计时器')
  await sleep(200)
  check(outcome === 'resolved', '整轮新窗口内命令正常完成，实际 ' + outcome)
  await proc.close({ timeoutMs: 1000 })
}

// ── 5. 续期次数用尽 → 报「弹窗一直没人应答」 ───────────────────────────────
console.log('续期上限:')
{
  const { proc } = spawnFake('dialog')
  await sleep(120)
  let error = null
  // 30ms × MAX_TIMEOUT_DEFERRALS(12) ≈ 360ms 后耗尽
  await proc.send({ type: 'prompt', message: 'nobody answers' }, { timeoutMs: 30 }).catch(caught => { error = caught })
  check(error !== null, '续期用尽后 reject')
  check(error !== null && String(error.message).includes('dialog(s) never answered') === true, '错误里点名「弹窗没人应答」，实际 ' + String(error && error.message))
  await proc.close({ timeoutMs: 1000 })
}

if (failures > 0) {
  console.error(String(failures) + ' 条断言失败')
  process.exit(1)
}
console.log('PASS')

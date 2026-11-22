/**
 * 门禁：**排除「pi 丢弃 DSML 头部」这一可能**（0.17.2）。
 *
 * ---------------------------------------------------------------------------
 * 为什么这条值得成为门禁而不是一次性脚本
 *
 * docs/dsml-root-cause.md 把真因写成「只有闭合尾巴、开标记从未进入输出流」，
 * 并留下三种可能未区分：① pi 流式解析丢头 ② provider 流式重组丢首帧 ③ 模型自身退化。
 *
 * 三者里只有 ① 能由本仓库修。所以「① 是否成立」必须是一个**可复跑的事实**，
 * 不是一次分析后的记忆 —— 否则下一个人会重新怀疑一遍，或者更糟：
 * 有人基于「可能是 pi 的问题」去改 pi 的流式代码（那会破坏所有正常调用）。
 *
 * ---------------------------------------------------------------------------
 * 论证链（四条全部由代码事实给出，不靠推断）
 *
 *  ① pi 全库不含 'DSML' → 不存在针对该标记的分支，谈不上丢弃
 *  ② 正文通道是纯追加：block.text += choice.delta.content，无过滤/截断/变形
 *  ③ toolCall 块只在 delta.tool_calls 出现时创建（ensureToolCallBlock 唯一调用点）
 *  ④ stopReason 由 pi 事后推导：content 里没有 toolCall 块 → 'stop'
 *
 * 于是「stop + 无 toolCall 块 + 正文含 DSML 文本」
 *   ⇒ DSML 是以 delta.content（正文）身份到达 pi 的
 *   ⇒ 既不是 pi 把 tool_call 转成正文，也不是 pi 丢弃了头部
 *   ⇒ 剩余可能只有 provider 流式重组 / 模型自身输出
 *
 * 跑法：node test/dsml-pi-loss.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const piAi = 'D:/my_projects/SuperPi/SuperPi/.runtime/node_modules/@earendil-works/pi-ai/dist'
let pass = 0, fail = 0
const ok = (n, c, d) => { if (c) { pass++; console.log('  ✓ ' + n) } else { fail++; console.log('  ✗ ' + n + (d ? ' → ' + d : '')) } }

function walk(dir, out = []) {
  let e; try { e = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const x of e) {
    const f = path.join(dir, x.name)
    if (x.isDirectory()) walk(f, out)
    else if (x.name.endsWith('.js')) out.push(f)
  }
  return out
}

const files = walk(piAi)
console.log('── ① pi 是否认识 DSML')
const withDsml = files.filter(f => fs.readFileSync(f, 'utf8').includes('DSML'))
ok('pi 全库无 DSML 分支（' + files.length + ' 个 .js 扫过）', withDsml.length === 0,
  withDsml.map(f => path.basename(f)).join(','))

console.log('\n── ② 正文通道是纯追加')
const src = fs.readFileSync(path.join(piAi, 'api', 'openai-completions.js'), 'utf8')
ok('delta.content 直接追加到 block.text', src.includes('block.text += choice.delta.content'))
ok('该行附近无过滤/截断/条件丢弃', (() => {
  const at = src.indexOf('block.text += choice.delta.content')
  const around = src.slice(Math.max(0, at - 400), at + 200)
  // 允许 length > 0 的入场守卫（只判断"有没有内容"），不允许任何内容变形
  return !/\.slice\(|\.substring\(|\.replace\(|\.trim\(/.test(around)
})())

console.log('\n── ③ toolCall 块只在 delta.tool_calls 时创建')
ok('ensureToolCallBlock 唯一调用点在 delta.tool_calls 分支内', (() => {
  // 1 处定义（const ensureToolCallBlock = (toolCall) =>）+ 1 处调用 = 2 次出现
  const occurrences = [...src.matchAll(/ensureToolCallBlock/g)].length
  if (occurrences !== 2) return false
  // 调用点必须落在 if (choice?.delta?.tool_calls) 之后、下一个同级 if 之前
  const branchAt = src.indexOf('if (choice?.delta?.tool_calls)')
  const callAt = src.indexOf('ensureToolCallBlock(toolCall)')
  const nextBranchAt = src.indexOf('if (choice?.delta.', branchAt + 10)
  if (branchAt < 0 || callAt < 0) return false
  return callAt > branchAt && (nextBranchAt < 0 || callAt < nextBranchAt)
})(), 'occurrences=' + String([...src.matchAll(/ensureToolCallBlock/g)].length))


console.log('\n── ④ stopReason 由 pi 事后推导')
ok('stopReason 依据「content 里有没有 toolCall 块」',
  src.includes('output.content.some((block) => block.type === "toolCall") ? "toolUse" : "stop"'))

console.log('')
if (fail === 0) {
  console.log('PASS (' + pass + ' checks)')
  console.log('')
  console.log('结论（全部由代码事实推出，不靠推断）：')
  console.log('  ① pi 全库不认识 DSML → 不存在针对该标记的分支');
  console.log('  ② 正文通道纯追加（block.text += delta.content），无过滤/截断');
  console.log('  ③ toolCall 块只由 delta.tool_calls 创建（唯一调用点）');
  console.log('  ④ stopReason 事后推导：无 toolCall 块 → "stop"');
  console.log('  ⇒ 畸形消息里的 DSML 是以 delta.content（正文）身份到达 pi 的');
  console.log('  ⇒ 「pi 丢弃 DSML 头部」被排除');
  console.log('  ⇒ 剩余可能：provider 流式重组 / 模型自身输出');
} else {
  console.log('FAIL (' + pass + ' passed, ' + fail + ' failed)')
  process.exit(1)
}

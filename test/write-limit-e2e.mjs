/**
 * 端到端验证：0.17.0 的「写入时图片限额」在**真实 pi 会话**里是否真的生效。
 *
 * 与单测的区别（这是它存在的理由）：
 *   · 单测用假 pi 调 handlers.tool_result()，验证的是「函数行为」；
 *   · 这里起**真 pi 子进程**、让它真的 read 图片文件、真的写会话 jsonl，
 *     然后数历史里实际留下几张 image 块 —— 验证的是「机制在真实链路里生效」。
 *
 * 判据（可证伪）：
 *   读 N 张图（N > keepRecentImagesPerTurn=4）后，会话文件里 image 块的
 *   总数必须 ≤ 4 左右；且必须能找到带路径的占位文本。
 *   若装的是旧版（无 tool_result 钩子），image 块数会等于 N —— 探针会红。
 *
 * 跑法：node test/write-limit-e2e.mjs（需要真实 LLM，故不进 npm test，只进 test:all）
 * 依赖：真 pi 运行时 + 真实 LLM（会消耗一次调用）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const { PiProcess } = await import(pathToFileURL(path.join(root, 'src', 'pi-rpc.mjs')).href)
const { resolvePiRuntime } = await import(pathToFileURL(path.join(root, 'src', 'pi-runtime.mjs')).href)

const pi = resolvePiRuntime({ pluginRoot: root })
if (!pi.cliPath || !pi.packageDir) {
  console.error('FAIL: 找不到 pi 运行时，先跑 npm run test:runtime')
  process.exit(1)
}

// 造 6 张图（> 限额 4，能证明限额生效；又不是 118 张那么慢）
const shots = path.join(root, '_scratch', 'e2e')
fs.mkdirSync(shots, { recursive: true })
const basePng = fs.readFileSync(path.join(shots, 'test1.png'))
const files = []
for (let i = 1; i <= 6; i += 1) {
  const p = path.join(shots, 'shot' + String(i) + '.png')
  fs.writeFileSync(p, basePng)
  files.push(p)
}
console.log('准备图片', files.length, '张（限额 4，超出 2 张应被置换）')

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'superpi-e2e-'))
const proc = new PiProcess({
  cliPath: pi.cliPath,
  // resolvePiRuntime 不返回 nodePath（那是 index.js 的职责）；直接用当前 node。
  nodePath: process.execPath,
  cwd: workdir,
  label: 'e2e-write-limit',
})
proc.start()

// 等就绪
await new Promise(resolve => {
  const timer = setTimeout(resolve, 20000)
  proc.on('exit', () => { clearTimeout(timer); resolve() })
  proc.stateReady?.then(() => { clearTimeout(timer); resolve() }).catch(() => { clearTimeout(timer); resolve() })
})
console.log('pi 已启动，pid =', proc.child?.pid ?? '(未知)')

// 收集事件，便于诊断
const events = []
proc.on('event', entry => { events.push(entry) })

// 让模型依次读这 6 张图
const prompt = [
  '请依次读取下面这些文件，每读一个就继续下一个，不要跳过：',
  ...files.map(f => '- ' + f),
  '全部读完后，只回复「已读完 6 张」即可，不要做其它事。',
].join('\n')

console.log('发送 prompt…')
let sendError = null
try {
  await proc.send({ type: 'prompt', message: prompt }, { timeoutMs: 240000 })
} catch (error) {
  sendError = error
  console.error('prompt 失败：', String(error?.message ?? error))
}

// 等 agent 结束
await new Promise(resolve => {
  const timer = setTimeout(resolve, 20000)
  const check = () => { if (proc.state === 'idle') { clearTimeout(timer); resolve() } }
  proc.on('event', entry => {
    const type = entry?.record?.type
    if (type === 'agent_settled' || type === 'agent_end') { clearTimeout(timer); resolve() }
  })
  check()
})

const stderrTail = (proc.stderrLines ?? []).slice(-8)
await proc.close({ timeoutMs: 5000 }).catch(() => {})

// ── 分析会话文件 ────────────────────────────────────────────
const sessionDir = path.join(os.homedir(), '.pi', 'agent', 'sessions')
// 找最近一分钟内更新的会话文件（就是这次跑的）
const cutoff = Date.now() - 5 * 60 * 1000
let targetFile = null
let newest = 0
for (const dir of fs.readdirSync(sessionDir)) {
  const full = path.join(sessionDir, dir)
  if (fs.statSync(full).isDirectory() === false) continue
  for (const name of fs.readdirSync(full)) {
    if (name.endsWith('.jsonl') === false) continue
    const st = fs.statSync(path.join(full, name))
    if (st.mtimeMs > cutoff && st.mtimeMs > newest) { newest = st.mtimeMs; targetFile = path.join(full, name) }
  }
}

console.log('')
console.log('== 结果 ==')
if (sendError !== null) console.log('prompt 错误：', String(sendError.message ?? sendError))
if (stderrTail.length > 0) console.log('stderr 末几行：', stderrTail.join(' | ').slice(0, 400))

if (targetFile === null) {
  console.error('FAIL: 没找到本次会话文件，无法判定')
  process.exit(1)
}
console.log('会话文件:', path.basename(targetFile))

const text = fs.readFileSync(targetFile, 'utf8')
const imageBlocks = (text.match(/"type":"image"/g) ?? []).length
const placeholders = (text.match(/image omitted/gi) ?? []).length
const toolResults = (text.match(/"role":"toolResult"/g) ?? []).length

console.log('toolResult 条数        =', toolResults)
console.log('历史里 image 块数      =', imageBlocks, '（旧版应接近', files.length, '；新版应 ≤ 4）')
console.log('占位文本 "image omitted" =', placeholders)

let failed = 0
if (toolResults === 0) {
  console.log('⚠️  没有 toolResult：模型可能没调用 read（或这张图太小被当作非图片）')
  failed += 1
} else if (imageBlocks <= 4 && placeholders > 0) {
  console.log('')
  console.log('PASS: 写入时限额在真实链路里生效 —— 读了 ' + String(files.length) + ' 张，历史只留 ' + String(imageBlocks) + ' 张，且有 ' + String(placeholders) + ' 处占位')
} else if (imageBlocks > 4) {
  console.log('')
  console.log('FAIL: 历史里有 ' + String(imageBlocks) + ' 张位图（超过限额 4）—— 限额没生效')
  failed += 1
} else {
  console.log('')
  console.log('⚠️  图片数 ' + String(imageBlocks) + ' ≤ 4 但没有占位文本：可能是模型没读满 6 张，无法判定')
  failed += 1
}

fs.rmSync(workdir, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)

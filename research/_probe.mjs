
import { spawn } from 'node:child_process'
import fs from 'node:fs'
const CLI = 'C:\\Users\\PC\\Documents\\pi-local\\pi-main\\packages\\coding-agent\\dist\\bundle\\cli.js'
const cwd = 'C:\\Users\\PC\\pi-workspace'
const child = spawn(process.execPath, [CLI, '--mode', 'rpc'], { cwd, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }, stdio: ['pipe','pipe','pipe'] })
const lines = []
let buf = ''
child.stdout.on('data', c => { buf += c.toString('utf8'); let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0,i); buf = buf.slice(i+1); if (l.trim()) lines.push(l) } })
let err = ''
child.stderr.on('data', c => err += c.toString('utf8'))
const t0 = Date.now()
child.stdin.write(JSON.stringify({ id: 'r1', type: 'get_state' }) + '\n')
setTimeout(() => child.stdin.write(JSON.stringify({ id: 'r2', type: 'prompt', message: '用一句话说明你在做什么。' }) + '\n'), 800)
setTimeout(() => { child.stdin.end() }, 30000)
child.on('exit', (code) => {
  fs.writeFileSync('C:\\Users\\PC\\Documents\\pi-local\\superpi\\research\\probe-events.txt',
    JSON.stringify({ code, ms: Date.now()-t0, err: err.slice(0,4000), lines }, null, 1))
  process.exit(0)
})

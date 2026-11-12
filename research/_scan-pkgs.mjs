
import fs from 'node:fs'
import path from 'node:path'
const base = 'C:/Users/PC/AppData/Local/Programs'
const dir = fs.readdirSync(base).find(n => n.startsWith('[') || /deepseek/i.test(n))
const asar = path.join(base, dir, 'resources', 'app.asar')
const buf = fs.readFileSync(asar)
const jsonSize = buf.readUInt32LE(8)
const json = JSON.parse(buf.subarray(16, 16 + jsonSize).toString('utf8'))
const out = []
const walk = (node, prefix) => {
  for (const [k, v] of Object.entries(node.files ?? {})) {
    const p = prefix + '/' + k
    if (v.files) walk(v, p)
    else out.push(p)
  }
}
walk(json, '')
const pkgs = new Set()
for (const p of out) {
  const m = p.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//)
  if (m && /deepseek/.test(m[1])) pkgs.add(m[1])
}
console.log([...pkgs].sort().join('\n'))

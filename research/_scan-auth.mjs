
import fs from 'node:fs'
import path from 'node:path'
const base = 'C:/Users/PC/AppData/Local/Programs'
const dir = fs.readdirSync(base).find(n => n.startsWith('[') || /deepseek/i.test(n))
const asar = path.join(base, dir, 'resources', 'app.asar')
const buf = fs.readFileSync(asar)
const headerPickleSize = buf.readUInt32LE(4)
const jsonSize = buf.readUInt32LE(8)
const json = JSON.parse(buf.subarray(16, 16 + jsonSize).toString('utf8'))
const dataBase = 16 + jsonSize
const files = []
const walk = (node, prefix) => {
  for (const [k, v] of Object.entries(node.files ?? {})) {
    const p = prefix + '/' + k
    if (v.files) walk(v, p)
    else files.push({ p, offset: Number(v.offset), size: v.size, unpacked: v.unpacked })
  }
}
walk(json, '')
console.log('files', files.length, 'dataBase', dataBase)
const needle = Buffer.from('dsh web authentication required')
let hits = 0
for (const f of files) {
  if (!f.size || f.size > 40e6) continue
  const start = dataBase + f.offset
  const slice = buf.subarray(start, start + f.size)
  if (slice.includes(needle)) { console.log('HIT', f.p, f.size); hits++ }
  if (hits > 6) break
}

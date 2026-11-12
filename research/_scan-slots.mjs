
import fs from 'node:fs'
import path from 'node:path'
const base = 'C:/Users/PC/AppData/Local/Programs'
const dir = fs.readdirSync(base).find(n => n.startsWith('[') || /deepseek/i.test(n))
const asar = path.join(base, dir, 'resources', 'app.asar')
const buf = fs.readFileSync(asar)
const jsonSize = buf.readUInt32LE(8)
const json = JSON.parse(buf.subarray(16, 16 + jsonSize).toString('utf8'))
const dataBase = 16 + jsonSize
const entries = []
const walk = (node, prefix) => {
  for (const [k, v] of Object.entries(node.files ?? {})) {
    const p = prefix + '/' + k
    if (v.files) walk(v, p)
    else entries.push({ p, offset: Number(v.offset), size: v.size })
  }
}
walk(json, '')
// find client bundle likely holding slot names
const cands = entries.filter(e => /renderer|client|web/i.test(e.p) && e.size > 100000 && !/\.map$/.test(e.p))
console.log('candidates', cands.length)
const slotRe = /['"]([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+){1,4})['"]/g
const names = new Map()
for (const e of cands.slice(0, 400)) {
  const start = dataBase + e.offset
  const text = buf.subarray(start, start + e.size).toString('utf8')
  let m
  while ((m = slotRe.exec(text)) !== null) {
    const v = m[1]
    if (/^(slots?|slot|Shell|sidebar|conversation|settings|main|panel|workspace|composer|message|session|turn|tool|chat|title|header|footer|input|tab|dock|overlay|pane|nav|list|item|actions?|body|content|row|column|view)\./.test(v)) {
      names.set(v, (names.get(v) ?? 0) + 1)
    }
  }
}
const sorted = [...names.entries()].sort((a,b)=>b[1]-a[1])
console.log(sorted.slice(0,120).map(([k,v])=>k+'  x'+v).join('\n'))

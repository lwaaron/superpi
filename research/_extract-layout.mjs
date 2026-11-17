
import fs from 'node:fs';
import path from 'node:path';
const base = 'C:/Users/PC/AppData/Local/Programs';
const dir = fs.readdirSync(base).find(n => /deepseek/i.test(n));
const asar = path.join(base, dir, 'resources', 'app.asar');
const buf = fs.readFileSync(asar);
const jsonSize = buf.readUInt32LE(8);
const raw = buf.subarray(16, 16 + jsonSize).toString('utf8');
const json = JSON.parse(raw.slice(0, raw.lastIndexOf('}') + 1));
const dataBase = 16 + 8 + jsonSize;
const entries = [];
const walk = (node, prefix) => {
  for (const [k, v] of Object.entries(node.files || {})) {
    const p = prefix + '/' + k;
    if (v.files) walk(v, p);
    else entries.push({ p, offset: Number(v.offset), size: v.size });
  }
};
walk(json, '');
const want = /@deepseek-ai\/(dsh-client-ui-layout|dsh-client-ui-renderer|dsh-client-ui-conversation)\//;
const wanted = entries.filter(e => want.test(e.p) && /\.(js|md)$/.test(e.p));
console.log(wanted.map(e => e.p + ' ' + e.size).slice(0, 80).join('\n'));
const outDir = 'C:/Users/PC/Documents/pi-local/superpi/research/layout';
fs.mkdirSync(outDir, { recursive: true });
for (const e of wanted) {
  const start = dataBase + e.offset;
  const data = buf.subarray(start, start + e.size);
  const name = e.p.replace(/^\/dsh\/node_modules\/@deepseek-ai\//, '').replace(/[\\/]/g, '__');
  fs.writeFileSync(path.join(outDir, name), data);
}
console.log('written', wanted.length);

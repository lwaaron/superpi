import fs from 'node:fs';
import path from 'node:path';
const base = 'C:/Users/PC/AppData/Local/Programs';
const dir = fs.readdirSync(base).find(n => n.startsWith('[') || /deepseek/i.test(n));
const asar = path.join(base, dir, 'resources', 'app.asar');
const buf = fs.readFileSync(asar);
const pickle = buf.readUInt32LE(4);
const jsonSize = buf.readUInt32LE(8);
const raw = buf.subarray(16, 16 + jsonSize).toString('utf8');
const json = JSON.parse(raw.slice(0, raw.lastIndexOf('}') + 1));
const dataBase = 16 + pickle;
const outDir = 'C:/Users/PC/Documents/pi-local/superpi/research/asar-docs';
fs.mkdirSync(outDir, { recursive: true });
function find(node, prefix, target) {
  for (const [k, v] of Object.entries(node.files || {})) {
    const p = prefix + '/' + k;
    if (v.files) { const r = find(v, p, target); if (r) return r; }
    else if (p === target) return v;
  }
  return null;
}
const wanted = [
  '/dsh/node_modules/@deepseek-ai/dsh-client-ui-layout/README.zh.md',
  '/dsh/node_modules/@deepseek-ai/dsh-client-ui-renderer/README.zh.md',
  '/dsh/node_modules/@deepseek-ai/dsh-client-modules/README.zh.md',
  '/dsh/node_modules/@deepseek-ai/dsh-client-ui-sidebar-browser/README.zh.md',
];
const report = [];
for (const w of wanted) {
  const e = find(json, '', w);
  if (!e) { report.push('MISSING ' + w); continue; }
  const start = dataBase + Number(e.offset);
  const data = buf.subarray(start, start + e.size);
  const name = w.split('/').slice(-2).join('__');
  fs.writeFileSync(path.join(outDir, name), data);
  report.push('OK ' + name + ' ' + e.size);
}
fs.writeFileSync(path.join(outDir, '_report.txt'), report.join('\n'));


import fs from 'node:fs';
import path from 'node:path';
const base = 'C:/Users/PC/AppData/Local/Programs';
const dir = fs.readdirSync(base).find(n => /deepseek/i.test(n));
const asar = path.join(base, dir, 'resources', 'app.asar');
const buf = fs.readFileSync(asar);
const jsonSize = buf.readUInt32LE(8);
const raw = buf.subarray(16, 16 + jsonSize).toString('utf8');
const json = JSON.parse(raw.slice(0, raw.lastIndexOf('}') + 1));
const entries = [];
const walk = (node, prefix) => {
  for (const [k, v] of Object.entries(node.files || {})) {
    const p = prefix + '/' + k;
    if (v.files) walk(v, p);
    else entries.push({ p, offset: Number(v.offset), size: v.size });
  }
};
walk(json, '');
const pkgs = new Set();
for (const e of entries) {
  const m = /^\/dsh\/node_modules\/@deepseek-ai\/([^/]+)\//.exec(e.p);
  if (m) pkgs.add(m[1]);
}
console.log([...pkgs].sort().join('\n'));

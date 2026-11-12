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
const names = [];
const walk = (node, prefix) => {
  for (const [k, v] of Object.entries(node.files || {})) {
    const p = prefix + '/' + k;
    if (v.files) walk(v, p); else names.push({p, v});
  }
};
walk(json, '');
fs.writeFileSync('C:/Users/PC/Documents/pi-local/dsh-pi/research/all-files.txt', names.map(x => x.p).join('\n'));
const want = names.filter(x => /README\.zh\.md$/.test(x.p) && /dsh-(client-web|web|client-ui-slots|client-ui-primitives|client-ui-settings|client-ui-sidebar)\//.test(x.p));
fs.writeFileSync('C:/Users/PC/Documents/pi-local/dsh-pi/research/readme-list.txt', want.map(x => x.p).join('\n'));

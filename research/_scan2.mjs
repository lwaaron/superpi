import fs from 'node:fs';
import path from 'node:path';
const base = 'C:/Users/PC/AppData/Local/Programs';
const dir = fs.readdirSync(base).find(n => n.startsWith('[') || /deepseek/i.test(n));
const asar = path.join(base, dir, 'resources', 'app.asar');
const buf = fs.readFileSync(asar);
const headerPickleSize = buf.readUInt32LE(4);
const jsonSize = buf.readUInt32LE(8);
const raw = buf.subarray(16, 16 + jsonSize).toString('utf8');
const end = raw.lastIndexOf('}');
const json = JSON.parse(raw.slice(0, end + 1));
const dataBase = 16 + headerPickleSize;
const out = [];
const walk = (node, prefix) => {
  for (const [k, v] of Object.entries(node.files || {})) {
    const p = prefix + '/' + k;
    if (v.files) walk(v, p); else out.push(p + '  ' + v.offset + '  ' + v.size);
  }
};
walk(json, '');
fs.writeFileSync('C:/Users/PC/Documents/pi-local/dsh-pi/research/out.txt',
  'pickle=' + headerPickleSize + ' jsonSize=' + jsonSize + ' dataBase=' + dataBase + ' total=' + out.length + '\n' +
  out.filter(p => /ui-slots|ui-layout|ui-renderer|client-modules|ui-sidebar/.test(p)).filter(p=>!p.includes('.map')).slice(0, 80).join('\n'));

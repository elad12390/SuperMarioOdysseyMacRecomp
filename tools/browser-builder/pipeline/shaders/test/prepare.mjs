// Private local proof inputs only; this is never part of the public bundle.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const work = path.join(root, 'tmp/odyssey/browser-shader-chain');
const game = path.join(root, 'game-data/super-mario-odyssey');
const profile = path.join(game, 'profile/0100000000010000');
const rows = (await readFile(path.join(profile, 'shader_map.tsv'), 'utf8')).split('\n').filter(l => l && !l.startsWith('#') && !l.startsWith('package')).map(l => l.split('\t'));
const pairs = (await readFile(path.join(profile, 'shader_pairs.tsv'), 'utf8')).split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split('\t'));
const [vertex, pixel] = pairs.find(([v, p]) => rows.some(r => r[3] === v) && rows.some(r => r[3] === p));
const compute = rows.find(r => r[0].startsWith('cs_'))[3];
const selected = new Set([vertex, pixel, compute]);
// Real source expands past 16 MiB; export must stream rather than reject it.
selected.add('007d7e411ef14ebd');
// Required fetch bodies must survive the source backend's cleanup.
selected.add('0020759d9400a726');
selected.add('0044cbe6fa23c643');
// Canonical Cross must preserve these depth/texture alias cases.
selected.add('019ad199f8d62a2f');
selected.add('051950a938c4eefd');
for (const row of rows.filter(r => r[2] === 'geometry')) selected.add(row[3]);
const facts = (await readFile(path.join(profile, 'shader_facts.tsv'), 'utf8')).split('\n').filter(l => selected.has(l.split('\t')[0]));
const files = [];
const map = [];
const records = new Map();
for (const row of rows.filter(r => selected.has(r[3]))) {
  const data = await readFile(path.join(game, 'shader/pkg', row[0]));
  let start = 0;
  for (let i = 0; i <= Number(row[1]); i++) { start = data.indexOf('BTCDBTCD', start); if (start < 0) throw new Error('Missing actual shader record'); if (i < Number(row[1])) start += 8; }
  const next = data.indexOf('BTCDBTCD', start + 8);
  if (!records.has(row[0])) records.set(row[0], []);
  const group = records.get(row[0]);
  map.push([row[0], String(group.length), ...row.slice(2)].join('\t'));
  group.push(data.subarray(start, next < 0 ? undefined : next));
}
for (const [name, group] of records) files.push({ name: 'pkg/' + name, data: Array.from(Buffer.concat(group)) });
files.push({ name: 'profile/shader_map.tsv', text: 'package\tindex\tstage\tdm_ctl_sha16\tsource\n' + map.join('\n') + '\n' });
files.push({ name: 'profile/shader_facts.tsv', text: facts.join('\n') + '\n' });
files.push({ name: 'profile/shader_pairs.tsv', text: vertex + '\t' + pixel + '\n' });
files.push({ name: 'profile/shader_map.tsv.conflicts.tsv', text: '# no conflicts in this real shader sample\n' });
await mkdir(work, { recursive: true });
await writeFile(path.join(work, 'fixtures.json'), JSON.stringify({ files, keys: [...selected] }));
console.log(JSON.stringify({ fixture: path.join(work, 'fixtures.json'), keys: [...selected], source: 'actual user-local package records and actual vertex/pixel pair' }));

// Reads the user's local extracted packages; never add the resulting jobs or code to a public bundle.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const game = process.env.SHADER_GAME_DIR ?? path.join(repo, 'game-data/super-mario-odyssey');
const out = path.join(repo, 'tmp/odyssey/browser-shaders/fixtures');
const profile = path.join(game, 'profile/0100000000010000');
const map = (await readFile(path.join(profile, 'shader_map.tsv'), 'utf8')).split('\n')
  .filter(line => /^(vs_systemdata|ps_systemdata|cs_effectdata)\.bin\t0\t/.test(line)).map(line => line.split('\t'));
assert.equal(map.length, 3, 'Expected one real vertex, pixel, and compute shader.');
const facts = new Map((await readFile(path.join(profile, 'shader_facts.tsv'), 'utf8')).split('\n')
  .filter(line => line && !line.startsWith('#')).map(line => {
    const tab = line.indexOf('\t'); return [line.slice(0, tab), JSON.parse(line.slice(tab + 1))];
  }));
await mkdir(out, { recursive: true });
const jobs = [], provenance = [];
for (const [pkg, index, stage, key] of map) {
  const data = await readFile(path.join(game, 'shader/pkg', pkg));
  const start = data.indexOf('BTCDBTCD');
  assert(start >= 0);
  const end = data.indexOf('BTCDBTCD', start + 8);
  const record = data.subarray(start, end < 0 ? undefined : end);
  const control = record.indexOf(Buffer.from('34127698', 'hex'));
  assert(control >= 0 && control + 0x708 <= record.length);
  let code = record.subarray(0x38, control);
  const c1 = record.subarray(0x38 + record.readUInt32LE(control + 0x700), 0x38 + record.readUInt32LE(control + 0x704));
  // dmsh_build.py job_for: graphics retains SPH, compute instructions start at +0x100.
  if (pkg.startsWith('cs') && code.readUInt32LE(0) === 0x12345679) {
    assert(code.subarray(0x30, 0x100).every(byte => byte === 0));
    code = code.subarray(0x100);
  } else if (!pkg.startsWith('cs')) code = code.subarray(0x30);
  const codePath = path.join(out, key + '.bin');
  await writeFile(codePath, code);
  jobs.push({ key, stage: pkg.slice(0, 2), code: codePath, tex: {}, img: {}, attr: {}, fout: {}, c1: c1.toString('hex'), debug: true, reduced: true, ...facts.get(key) });
  provenance.push({ key, package: pkg, index: Number(index), bytes: code.length, c1bytes: c1.length, sha256: createHash('sha256').update(code).digest('hex') });
}
await writeFile(path.join(out, 'jobs.json'), JSON.stringify(jobs, null, 2) + '\n');
await writeFile(path.join(out, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
console.log(JSON.stringify(provenance, null, 2));

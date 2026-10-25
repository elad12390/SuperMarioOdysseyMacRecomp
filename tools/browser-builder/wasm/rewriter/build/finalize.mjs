import { createHash } from 'node:crypto';
import { readFile, writeFile, cp, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('../../../../../', import.meta.url)));
const scope = join(root, 'tools/browser-builder/wasm/rewriter');
const scratch = join(root, 'tmp/odyssey/browser-rewriter');
const bundle = join(scratch, 'bundle');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const wheels = ['capstone-5.0.6-py3-none-pyodide_2025_0_wasm32.whl', 'lz4-4.4.4-cp313-cp313-pyodide_2025_0_wasm32.whl'];
const dependencies = {};
for (const name of wheels) dependencies[name] = hash(await readFile(join(bundle, name)));
if (dependencies[wheels[1]] !== '98d2f8ec75fd46f2e99204a38aecdd7d9d00b20c27c2578033dfdf66c993198c') throw new Error('Pinned LZ4 wheel checksum mismatch');
await writeFile(join(bundle, 'dependencies.json'), JSON.stringify(dependencies, null, 2) + '\n');
for (const file of ['index.mjs', 'worker.mjs', 'README.md', 'THIRD-PARTY-NOTICES.md']) await cp(join(scope, file), join(bundle, file));
await cp(join(scope, 'licenses'), join(bundle, 'licenses'), { recursive: true });
async function inventory(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) files.push(...await inventory(join(directory, entry.name), name + '/'));
    else if (name !== 'SHA256SUMS') files.push([name, hash(await readFile(join(directory, entry.name)))]);
  }
  return files;
}
const files = (await inventory(bundle)).sort(([a], [b]) => a.localeCompare(b));
await writeFile(join(bundle, 'SHA256SUMS'), files.map(([name, sha]) => `${sha}  ${name}\n`).join(''));
console.log(JSON.stringify({ bundle, files: files.length, dependencies }, null, 2));

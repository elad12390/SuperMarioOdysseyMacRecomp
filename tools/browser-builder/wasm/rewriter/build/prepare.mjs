// All generated data stays in the caller's ignored scratch directory.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../../../../../', import.meta.url)));
const scratch = join(root, 'tmp/odyssey/browser-rewriter');
const source = join(scratch, 'source');
const bundle = join(scratch, 'bundle');
const revision = '0045c1dfb639f9775891382646ad38c2a11c56bf';
const patchSha256 = '98cfcc7d1456941d75c3c3ef7be1b0e9194a0d73d6fae7a1604f90cdc157aaff';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function git(args, cwd = join(root, 'external/nxnative')) {
  const p = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const bytes = new Uint8Array(await new Response(p.stdout).arrayBuffer());
  if (await p.exited) throw new Error(await new Response(p.stderr).text());
  return bytes;
}
const patch = await readFile(join(root, 'scripts/patches/nxnative-odyssey-sdk3.patch'));
if (hash(patch) !== patchSha256) throw new Error('Root Odyssey patch does not match the approved pin');
await rm(source, { recursive: true, force: true });
const names = new TextDecoder().decode(await git(['ls-tree', '-r', '--name-only', revision, 'dm/games']))
  .trim().split('\n').filter(name => name.endsWith('/patches.py'));
names.unshift(...['patch_nso.py', 'nso_asm.py', 'nso_code.py', 'sdk_patches.py'].map(n => `dm/tools/${n}`));
for (const name of [...names, 'LICENSE']) {
  const path = join(source, name);
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, await git(['show', `${revision}:${name}`]));
}
await mkdir(bundle, { recursive: true });
const pythonPatch = patch.toString('utf8').split(/(?=^diff --git )/m)
  .filter(part => /^diff --git a\/(dm\/tools\/[^/ ]+\.py|dm\/games\/[^/]+\/patches\.py) /m.test(part)).join('');
await writeFile(join(scratch, 'approved.patch'), pythonPatch);
// Run outside the parent checkout: git apply otherwise silently skips paths
// outside the ignored staging subdirectory's repository-relative prefix.
await git(['apply', '--unsafe-paths', `--directory=${source}`, join(scratch, 'approved.patch')], '/');
if (!names.includes('dm/games/0100000000010000/patches.py')) names.push('dm/games/0100000000010000/patches.py');
const files = [];
for (const name of names.sort()) {
  const bytes = await readFile(join(source, name));
  files.push({ path: name, sha256: hash(bytes), text: bytes.toString('utf8') });
}
const provenance = { nxnativeRevision: revision, odysseyPatchSha256: patchSha256, pyodide: '0.28.3', emscripten: '4.0.9', capstone: '5.0.6', lz4: '4.4.4' };
await writeFile(join(bundle, 'sources.json'), JSON.stringify({ provenance, files }));
await cp(join(scratch, 'setup/node_modules/pyodide'), join(bundle, 'pyodide'), { recursive: true });
await cp(join(source, 'LICENSE'), join(bundle, 'NXNATIVE-LICENSE'));
for (const file of ['index.mjs', 'worker.mjs']) await cp(join(root, 'tools/browser-builder/wasm/rewriter', file), join(bundle, file));
console.log(JSON.stringify({ provenance, sourceFiles: files.length, bundle }, null, 2));

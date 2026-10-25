// Fresh CPU-only C1 compatibility check. Cached booleans are never accepted.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const work = path.join(root, 'tmp/odyssey/browser-shader-chain/guard-diagnosis');
const script = fileURLToPath(new URL('./guard-compat.py', import.meta.url));
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value);
}
export async function verifyRetainedBfC1({ gameDirectory, manifest, nativeC1Path, runtimeDirectory, sourceManifestPath } = {}) {
  if (!gameDirectory || !manifest || !Array.isArray(manifest.files)) throw Error('C1 compatibility requires actual game files and the checked manifest');
  await mkdir(work, { recursive: true });
  const job = await mkdtemp(path.join(work, 'strict-'));
  const files = manifest.files.filter(file => file.path !== 'shader-chain.json')
    .map(({ path, size, sha256 }) => ({ path, size, sha256 })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const digest = createHash('sha256').update(canonical(files)).digest('hex');
  const args = ['uv', 'run', '--no-project', '--offline', 'python', script,
    '--game', path.resolve(gameDirectory), '--work', job,
    '--sources', path.resolve(sourceManifestPath || path.join(root, 'tmp/odyssey/browser-shader-chain/bundle/sources.json')),
    '--chain', manifest.chain, '--inputs', manifest.inputs, '--manifest-digest', digest,
    '--native-c1', path.resolve(nativeC1Path || path.join(root, 'game-data/super-mario-odyssey/profile/0100000000010000/c1_full.tsv'))];
  if (runtimeDirectory) args.push('--runtime', path.resolve(runtimeDirectory));
  const log = path.join(job, 'analysis.log'), errors = path.join(job, 'analysis.stderr');
  const child = Bun.spawn(args, { cwd: job, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', UV_CACHE_DIR: path.join(job, 'uv-cache') }, stdout: Bun.file(log), stderr: Bun.file(errors) });
  await writeFile(path.join(job, 'analysis.pid'), String(child.pid));
  const exit = await child.exited;
  await writeFile(path.join(job, 'analysis.status'), String(exit));
  let result;
  try { result = JSON.parse(await readFile(path.join(job, 'result.json'), 'utf8')); }
  catch { result = { passed: false, issues: ['Fresh native analysis produced no result', await readFile(errors, 'utf8')], exit }; }
  return { ...result, passed: exit === 0 && result.passed === true, proofDirectory: job, exit };
}

import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyRetainedBfC1 } from './guard-compat.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const work = path.join(root, 'tmp/odyssey/browser-shader-chain/guard-diagnosis');
const actualGame = process.env.GUARD_COMPAT_GAME || path.join(root, 'tmp/odyssey/browser-release/generated-1987-acceptance/relocated/Super Mario Odyssey.app/Contents/Resources/game');
const runtimeDirectory = process.env.GUARD_COMPAT_RUNTIME || path.join(root, 'tmp/odyssey/browser-release-tools/runtime-cache/b4d1805e2c14d937a7cfe0a185b97a9c214bcc9c67102d49fbe6a6a34167d23e');
const sourcesPath = process.env.GUARD_COMPAT_SOURCES || path.join(root, 'tmp/odyssey/browser-shader-chain/bundle/sources.json');
const key = '0044cbe6fa23c643', chain = '198729df4d5a';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function originalGuard(pinned, cache, output, logs) {
  const child = Bun.spawn(['uv', 'run', '--no-project', '--offline', 'python', path.join(pinned, 'c1_guard.py'), cache, output], {
    cwd: logs, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', UV_CACHE_DIR: path.join(logs, 'uv-cache') },
    stdout: Bun.file(path.join(logs, 'reference.log')), stderr: Bun.file(path.join(logs, 'reference.stderr')),
  });
  await writeFile(path.join(logs, 'reference.pid'), String(child.pid));
  const exit = await child.exited;
  await writeFile(path.join(logs, 'reference.status'), String(exit));
  expect(exit).toBe(0);
}
async function fixture() {
  await mkdir(work, { recursive: true });
  const directory = await mkdtemp(path.join(work, 'fixture-'));
  const game = path.join(directory, 'App.app/Contents/Resources/game');
  const cache = path.join(game, 'shader/cache/b-' + chain);
  const profile = path.join(game, 'profile/0100000000010000');
  const nativeCache = path.join(directory, 'native/b-' + chain);
  const pinned = path.join(directory, 'pinned');
  for (const dir of [cache, profile, nativeCache, pinned, path.resolve(game, '../../MacOS')]) await mkdir(dir, { recursive: true });
  await symlink(path.resolve(actualGame, '../../MacOS/dmhost'), path.resolve(game, '../../MacOS/dmhost'));
  const sources = JSON.parse(await readFile(sourcesPath, 'utf8'));
  for (const name of ['c1_guard.py', 'dmsh_chain.py']) await writeFile(path.join(pinned, name), sources.files.find(f => f.path.endsWith('/' + name)).text);
  for (const suffix of ['_b.metal', '_b.json', '_bf.metal']) await copyFile(path.join(actualGame, 'shader/cache/b-' + chain, key + suffix), path.join(cache, key + suffix));
  await writeFile(path.join(profile, 'game.tsv'), sources.profile);
  for (const [name, value] of Object.entries({
    'shader_map.tsv': 'package\tindex\tstage\tdm_ctl_sha16\tsource\nfixture\t0\tpixel\t' + key + '\tactual-record\n',
    'shader_facts.tsv': '', 'shader_map.tsv.conflicts.tsv': '', 'shader_pairs.tsv': '',
  })) await writeFile(path.join(profile, name), value);
  const hash = createHash('sha256');
  for (const name of ['shader_facts.tsv', 'shader_map.tsv', 'shader_map.tsv.conflicts.tsv', 'shader_pairs.tsv', 'bf_want.tsv']) {
    let bytes; try { bytes = await readFile(path.join(profile, name)); } catch { bytes = Buffer.from('missing'); }
    hash.update('game/' + name + '\0').update(bytes).update('\0');
  }
  hash.update(sources.profile.split('\n').filter(l => /^(nvn_|shader_)/.test(l)).map(l => l + '\n').join(''));
  const inputs = hash.digest('hex').slice(0, 12);
  const stamp = '# fixture\n' + 'game\t0100000000010000\ninputs\t' + inputs + '\n';
  await writeFile(path.join(cache, 'inputs.tsv'), stamp);
  await writeFile(path.join(nativeCache, 'inputs.tsv'), stamp);
  for (const suffix of ['_b.metal', '_b.json']) await copyFile(path.join(cache, key + suffix), path.join(nativeCache, key + suffix));
  const nativeC1Path = path.join(directory, 'native-c1.tsv');
  await originalGuard(pinned, nativeCache, nativeC1Path, directory);
  await originalGuard(pinned, cache, path.join(profile, 'c1_full.tsv'), directory);
  const manifest = { chain, inputs, shaders: 1, files: [] };
  async function refresh() {
    manifest.files = [];
    for (const name of [key + '_b.metal', key + '_bf.metal', key + '_b.json', 'inputs.tsv']) {
      const relative = 'shader/cache/b-' + chain + '/' + name, bytes = await readFile(path.join(game, relative));
      manifest.files.push({ path: relative, size: bytes.length, sha256: sha(bytes) });
    }
    for (const name of ['game.tsv', 'shader_map.tsv', 'shader_facts.tsv', 'shader_map.tsv.conflicts.tsv', 'shader_pairs.tsv', 'c1_full.tsv']) {
      const relative = 'profile/0100000000010000/' + name, bytes = await readFile(path.join(game, relative));
      manifest.files.push({ path: relative, size: bytes.length, sha256: sha(bytes) });
    }
    await writeFile(path.join(game, 'shader-chain.json'), JSON.stringify(manifest));
  }
  await refresh();
  return { directory, game, cache, profile, pinned, sources, manifest, nativeC1Path, refresh,
    verify: () => verifyRetainedBfC1({ gameDirectory: game, manifest, nativeC1Path, runtimeDirectory, sourceManifestPath: sourcesPath }) };
}
async function withFixture(fn) {
  const f = await fixture();
  try { await fn(f); } finally { await rm(f.directory, { recursive: true, force: true }); }
}

test('fresh unchanged analyzer accepts the real retained BF source and unchanged effective guards', async () => withFixture(async f => {
  const result = await f.verify();
  expect(result.passed).toBe(true);
  expect(result.reference.executed).toBe(true);
  expect(result.reference.exact_body).toBe(true);
  expect(result.effective_flags.exact).toBe(true);
  expect(result.fetch.analyzed).toBe(1);
  expect(result.fetch.same_expressions).toBe(1);
  expect(result.additional_base_full_required).toEqual([]);
  expect(result.provenance.passed).toBe(true);
}), 30000);

test('missing BF guard flag cannot pass even when its body equals the old native table', async () => withFixture(async f => {
  const file = path.join(f.profile, 'c1_full.tsv'), text = await readFile(file, 'utf8');
  await writeFile(file, text.split('\n')[0] + '\n');
  await f.refresh();
  const result = await f.verify();
  expect(result.passed).toBe(false);
  expect(result.reference.exact_body).toBe(false);
  expect(result.issues).toContain('Actual guard body differs from fresh unchanged native reference');
}), 30000);

test('arbitrary guard superset is rejected with current valid file hashes', async () => withFixture(async f => {
  const file = path.join(f.profile, 'c1_full.tsv');
  await writeFile(file, (await readFile(file, 'utf8')) + 'ffffffffffffffff_bf\n');
  await f.refresh();
  const result = await f.verify();
  expect(result.passed).toBe(false);
  expect(result.reference.exact_body).toBe(false);
  expect(result.issues).toContain('BF guard rows differ from the independently analyzed current C1-read source set');
}), 30000);

test('new unbounded BF access is rejected even when freshly generated guard body matches', async () => withFixture(async f => {
  const file = path.join(f.cache, key + '_bf.metal');
  const source = await readFile(file, 'utf8');
  const member = source.match(/float4 (m_\d+) \[\[user\(locn\d+\)\]\]/)?.[1];
  expect(member).toBeDefined();
  const changed = source.replace(/(\b[a-z]+_c1\)\._m0)\[([^\]]+)\]/, (_, prefix) => prefix + '[uint(in.' + member + '.x)]');
  expect(changed).not.toBe(source);
  await writeFile(file, changed);
  await originalGuard(f.pinned, f.cache, path.join(f.profile, 'c1_full.tsv'), f.directory);
  await f.refresh();
  const result = await f.verify();
  expect(result.passed).toBe(false);
  expect(result.reference.exact_body).toBe(true);
  expect(result.additional_base_full_required).toEqual([key]);
  expect(result.issues).toContain('BF C1 expression set differs from its base');
}), 30000);

test('modified reference analyzer is rejected despite a matching self-declared hash', async () => withFixture(async f => {
  const modified = structuredClone(f.sources), file = modified.files.find(f => f.path.endsWith('/c1_guard.py'));
  file.text += '\n# altered reference\n'; file.sha256 = sha(file.text);
  const alteredPath = path.join(f.directory, 'altered-sources.json');
  await writeFile(alteredPath, JSON.stringify(modified));
  const result = await verifyRetainedBfC1({ gameDirectory: f.game, manifest: f.manifest, nativeC1Path: f.nativeC1Path,
    runtimeDirectory, sourceManifestPath: alteredPath });
  expect(result.passed).toBe(false);
  expect(result.issues).toContain('Pinned reference analyzer changed: c1_guard.py');
}), 30000);

// Prepare public tools only. Never read game-data or publish generated tables.
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../../..');
const work = path.join(root, 'tmp/odyssey/browser-shader-chain');
const out = path.resolve(process.env.SHADER_CHAIN_BUNDLE || path.join(work, 'bundle'));
if (!out.startsWith(work + path.sep)) throw new Error('Shader preparation output must remain in tmp/odyssey/browser-shader-chain');
const upstream = path.join(root, 'external/nxnative');
const revision = '0045c1dfb639f9775891382646ad38c2a11c56bf';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function pinned(name) {
  const result = Bun.spawnSync(['git', '--no-pager', '-C', upstream, 'show', `${revision}:${name}`], { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  if (result.exitCode) throw new Error(`Missing pinned upstream source ${name}: ${result.stderr}`);
  return new TextDecoder().decode(result.stdout);
}
const names = ['shader_split', 'uepak', 'unityfs', 'smash_arc', 'dmsh_build', 'dmsh_chain', 'dmsh_fetch', 'dmsh_vin',
  'dmsh_geometry', 'dmsh_facts', 'dmsh_mtlcache', 'c1_guard', 'cb_extent'].map(n => `dm/gfx/tools/${n}.py`);
names.push('dm/games/game.py', 'dm/tools/nso_syms.py', 'dm/gfx/tools/dmsh_xlate/Program.cs', 'dm/gfx/tools/dmsh_xlate/dmsh_xlate.csproj', 'dm/ios/tools/ios_metal.py', 'dm/gfx/tools/dmsh_chain.lock');
const files = names.map(name => { const text = pinned(name); return { path: name, text, sha256: hash(text) }; });
let profile = pinned('dm/games/0100000000010000/game.tsv');
profile = profile.replace(/^package\t.*$/m, 'package\tv0').replace(/^shader_versions\t.*$/m, 'shader_versions\tv0');
profile = profile.replace(/^build\t.*\n/gm, '') + 'build\tv0\t1.0.0\tmain=3ca12dfaaf9c82da064d1698df79cda1\tsubsdk0=798c30e126697f2222cf843f78f5c140\tsdk=ae34e75d02925f4417b24499ad80c394\n';
const sources = { format: 1, revision, files, profile, profileSha256: hash(profile), provenance: { nxnative: revision, output: 'MSL source; native first-launch Metal compilation approved' } };
await mkdir(out, { recursive: true });
await writeFile(path.join(out, 'sources.json'), JSON.stringify(sources));
const adapterAssets = ['adapter.py', 'file-fs.mjs', 'worker.mjs', 'index.mjs', 'page-store.mjs', 'asset-loader.mjs', 'parallel.mjs', 'build-worker.mjs', 'yaz0.mjs', 'packed-output.mjs', 'scan.mjs', 'scan-worker.mjs'];
for (const name of adapterAssets) await cp(path.join(here, name), path.join(out, name));
const rewriter = process.env.REWRITER_BUNDLE || path.join(root, 'tmp/odyssey/browser-rewriter/bundle');
await cp(path.join(rewriter, 'pyodide'), path.join(out, 'pyodide'), { recursive: true });
const wheel = 'lz4-4.4.4-cp313-cp313-pyodide_2025_0_wasm32.whl';
await cp(path.join(rewriter, wheel), path.join(out, wheel));
const pyodideLock = JSON.parse(await readFile(path.join(rewriter, 'pyodide/pyodide-lock.json'), 'utf8'));
const lzmaWheel = pyodideLock.packages.lzma.file_name;
const lzma = await readFile(path.join(work, 'dependencies', lzmaWheel));
if (hash(lzma) !== pyodideLock.packages.lzma.sha256) throw new Error('Pyodide LZMA wheel checksum mismatch');
await writeFile(path.join(out, lzmaWheel), lzma);
await cp(path.join(root, 'tmp/odyssey/browser-shaders/publish/wwwroot'), path.join(out, 'maxwell'), { recursive: true });
await mkdir(path.join(out, 'cross'), { recursive: true });
for (const name of ['translator.mjs', 'spirv-cross.mjs', 'spirv-cross.wasm', 'SPIRV-Cross.LICENSE']) {
  await cp(path.join(root, 'tmp/odyssey/browser-shaders/cross', name), path.join(out, 'cross', name));
}
await cp(path.join(upstream, 'LICENSE'), path.join(out, 'NXNATIVE-LICENSE'));
const assets = [];
async function visit(directory, prefix = '') {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) await visit(path.join(directory, entry.name), relative + '/');
    else if (!['toolchain.json', 'CHAIN.json', 'BUILD-META.json'].includes(relative)) {
      const bytes = await readFile(path.join(directory, entry.name));
      assets.push({ path: relative, size: bytes.length, sha256: hash(bytes) });
    }
  }
}
await visit(out);
const assetDigest = prefix => hash(JSON.stringify(assets.filter(a => a.path.startsWith(prefix))));
const cs = files.filter(f => f.path.startsWith('dm/gfx/tools/dmsh_xlate/'));
const identity = { backend: 'browser-msl-source-v1', maxwell_assets: assetDigest('maxwell/'), cross_assets: assetDigest('cross/'),
  adapter_assets: hash(JSON.stringify(assets.filter(a => adapterAssets.includes(a.path)))),
  python_assets: assetDigest('pyodide/'), python_wheels: hash(JSON.stringify(assets.filter(a => a.path.endsWith('.whl')))),
  sources: assets.find(a => a.path === 'sources.json').sha256,
  xlate_source: hash(cs.map(f => f.text).join('')).slice(0, 16) };
const chain = hash('switchrecomp-browser-shader-chain\0' + JSON.stringify(identity)).slice(0, 12);
const manifest = { format: 1, chain, identity, assets, lz4Wheel: wheel, lzmaWheel };
await writeFile(path.join(out, 'toolchain.json'), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(path.join(out, 'CHAIN.json'), JSON.stringify({ chain, identity }, null, 2) + '\n');
await writeFile(path.join(out, 'BUILD-META.json'), JSON.stringify({ format: 1, shaderChain: chain,
  pipeline: 'index.mjs', shaderOptions: {}, nativeDefines: { DMSH_CHAIN: chain },
  backend: identity.backend, sourceRevision: revision, toolchain: 'toolchain.json',
  outputs: ['shader/cache/b-' + chain + '/', 'profile/0100000000010000/'] }, null, 2) + '\n');
console.log(JSON.stringify({ bundle: out, chain, assets: assets.length, privateInputsRead: 0 }));

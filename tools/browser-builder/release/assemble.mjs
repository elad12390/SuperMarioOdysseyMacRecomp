import { mkdir, readFile, readdir, rename, rm, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { listFiles, readAsset, put, sha256, jsonBytes, safePath } from './files.mjs';
import { auditBytes, dotnetPath, allowedRewriter, allowedShader } from './audit.mjs';
import { collectLicenses } from './licenses.mjs';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const revision = '0045c1dfb639f9775891382646ad38c2a11c56bf';
const rewriterWheelHash = '98d2f8ec75fd46f2e99204a38aecdd7d9d00b20c27c2578033dfdf66c993198c';
const extractorRoots = new Set(['extractor.js', 'browser-io.js', 'extractor-worker.js', 'extractor-client.js', 'THIRD-PARTY-NOTICES.md']);
const corePyodide = ['pyodide.mjs', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'];
const sorted = array => array.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);

async function exists(filename) { try { return await lstat(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function requireFiles(base, names, stage) {
  for (const name of names) try { await readAsset(base, name); } catch (error) { throw new Error(`${stage} component is missing ${name}: ${error.message}`); }
}
function verifyEmbeddedSources(sources, stage) {
  if (!Array.isArray(sources.files) || !sources.files.length) throw new Error(`${stage} has no pinned source inventory`);
  for (const entry of sources.files) {
    safePath(entry.path);
    if (typeof entry.text !== 'string' || sha256(Buffer.from(entry.text)) !== entry.sha256) throw new Error(`${stage} source hash mismatch: ${entry.path}`);
    if (!/^dm\/.+\.(?:py|cs|csproj|lock)$/.test(entry.path)) throw new Error(`${stage} source is not an allowlisted OSS tool: ${entry.path}`);
  }
}
async function copyStage(base, prefix, allowed, destination) {
  const names = await listFiles(base);
  for (const name of names) {
    if (!allowed(name)) throw new Error(`Unexpected ${prefix} file; refusing broad directory publication: ${name}`);
    const bytes = await readAsset(base, name);
    auditBytes(prefix + '/' + name, bytes);
    await put(destination, prefix + '/' + name, bytes);
  }
  return names;
}
async function verifyRewriter(base) {
  await requireFiles(base, ['index.mjs', 'worker.mjs', 'sources.json', 'dependencies.json', 'SHA256SUMS', 'NXNATIVE-LICENSE', ...corePyodide.map(n => 'pyodide/' + n)], 'rewriter');
  const sums = (await readAsset(base, 'SHA256SUMS')).toString().trim().split('\n');
  const declared = new Set(['SHA256SUMS']);
  for (const line of sums) {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/);
    if (!match || declared.has(match[2])) throw new Error('Malformed or duplicate rewriter SHA256SUMS row');
    safePath(match[2]); declared.add(match[2]);
    if (sha256(await readAsset(base, match[2])) !== match[1]) throw new Error(`Rewriter checksum mismatch: ${match[2]}`);
  }
  if (JSON.stringify(sorted(await listFiles(base))) !== JSON.stringify(sorted([...declared]))) throw new Error('Rewriter bundle contains unmanifested files');
  const sources = JSON.parse(await readAsset(base, 'sources.json'));
  verifyEmbeddedSources(sources, 'rewriter');
  if (sources.provenance?.nxnativeRevision !== revision || sources.provenance.pyodide !== '0.28.3') throw new Error('Rewriter source pin mismatch');
  const dependencies = JSON.parse(await readAsset(base, 'dependencies.json'));
  for (const [name, hash] of Object.entries(dependencies)) if (sha256(await readAsset(base, name)) !== hash) throw new Error(`Rewriter dependency hash mismatch: ${name}`);
  if (dependencies['lz4-4.4.4-cp313-cp313-pyodide_2025_0_wasm32.whl'] !== rewriterWheelHash) throw new Error('LZ4 wheel pin mismatch');
  return { provenance: sources.provenance, sourceFiles: sources.files.map(({ path, sha256 }) => ({ path, sha256 })), wheels: dependencies, checksumFile: sha256(await readAsset(base, 'SHA256SUMS')) };
}
async function verifyShader(base) {
  await requireFiles(base, ['index.mjs', 'worker.mjs', 'file-fs.mjs', 'adapter.py', 'sources.json', 'CHAIN.json', 'toolchain.json', 'cross/translator.mjs', 'cross/spirv-cross.mjs', 'cross/spirv-cross.wasm', 'cross/SPIRV-Cross.LICENSE', 'maxwell/shader-translator.mjs', 'maxwell/_framework/dotnet.js', ...corePyodide.map(n => 'pyodide/' + n)], 'shader pipeline');
  const manifest = JSON.parse(await readAsset(base, 'toolchain.json')), chain = JSON.parse(await readAsset(base, 'CHAIN.json'));
  if (manifest.format !== 1 || !/^[a-f0-9]{12}$/.test(manifest.chain) || manifest.chain !== chain.chain || JSON.stringify(manifest.identity) !== JSON.stringify(chain.identity)) throw new Error('Invalid shader chain identity');
  if (sha256(Buffer.from('switchrecomp-browser-shader-chain\0' + JSON.stringify(manifest.identity))).slice(0, 12) !== chain.chain) throw new Error('Shader CHAIN.json does not match its identity');
  const declared = new Set(['toolchain.json', 'CHAIN.json']);
  const metadataStat = await exists(path.join(base, 'BUILD-META.json'));
  if (metadataStat) {
    const metadata = JSON.parse(await readAsset(base, 'BUILD-META.json'));
    if (metadata.format !== 1 || metadata.shaderChain !== chain.chain || metadata.nativeDefines?.DMSH_CHAIN !== chain.chain || metadata.sourceRevision !== revision || metadata.pipeline !== 'index.mjs' || metadata.toolchain !== 'toolchain.json') throw new Error('Shader public build metadata does not match CHAIN.json');
    declared.add('BUILD-META.json');
  }
  for (const asset of manifest.assets) {
    safePath(asset.path);
    if (declared.has(asset.path)) throw new Error(`Duplicate shader asset: ${asset.path}`);
    declared.add(asset.path);
    const bytes = await readAsset(base, asset.path);
    if (bytes.length !== asset.size || sha256(bytes) !== asset.sha256) throw new Error(`Shader asset checksum mismatch: ${asset.path}`);
  }
  if (JSON.stringify(sorted(await listFiles(base))) !== JSON.stringify(sorted([...declared]))) throw new Error('Shader bundle contains unmanifested files');
  const digest = prefix => sha256(Buffer.from(JSON.stringify(manifest.assets.filter(a => a.path.startsWith(prefix)))));
  if (manifest.identity.maxwell_assets !== digest('maxwell/') || manifest.identity.cross_assets !== digest('cross/') || manifest.identity.python_assets !== digest('pyodide/')) throw new Error('Shader component fingerprints do not match the declared assets');
  if (manifest.identity.python_wheels && manifest.identity.python_wheels !== sha256(Buffer.from(JSON.stringify(manifest.assets.filter(a => a.path.endsWith('.whl')))))) throw new Error('Shader wheel fingerprint mismatch');
  const adapterDigest = sha256(Buffer.from(JSON.stringify(manifest.assets.filter(a => ['adapter.py', 'file-fs.mjs', 'worker.mjs', 'index.mjs'].includes(a.path)))));
  if (manifest.identity.adapter_assets !== adapterDigest || manifest.identity.sources !== sha256(await readAsset(base, 'sources.json'))) throw new Error('Shader adapter/source fingerprints do not match');
  const sources = JSON.parse(await readAsset(base, 'sources.json'));
  verifyEmbeddedSources(sources, 'shader pipeline');
  if (sources.revision !== revision || sha256(Buffer.from(sources.profile)) !== sources.profileSha256) throw new Error('Shader source/profile pin mismatch');
  const cs = sources.files.filter(f => f.path.startsWith('dm/gfx/tools/dmsh_xlate/'));
  if (manifest.identity.xlate_source !== sha256(Buffer.from(cs.map(f => f.text).join(''))).slice(0, 16)) throw new Error('Shader translator source fingerprint mismatch');
  if (sha256(await readAsset(base, manifest.lz4Wheel)) !== rewriterWheelHash) throw new Error('Shader LZ4 wheel pin mismatch');
  if (manifest.lzmaWheel) {
    const lock = JSON.parse(await readAsset(base, 'pyodide/pyodide-lock.json'));
    if (lock.packages.lzma.file_name !== manifest.lzmaWheel || lock.packages.lzma.sha256 !== '18523e1b59a6acc64857615fb48718ed6666ad1a562abf6707541427d3b01ace' || sha256(await readAsset(base, manifest.lzmaWheel)) !== lock.packages.lzma.sha256) throw new Error('Shader LZMA wheel pin mismatch');
  }
  return { chain: chain.chain, identity: chain.identity, sourceFiles: sources.files.map(({ path, sha256 }) => ({ path, sha256 })), sourcesSha256: sha256(await readAsset(base, 'sources.json')), manifestSha256: sha256(await readAsset(base, 'toolchain.json')) };
}
async function sourceInventory(root, destination, stageRoot = root) {
  const files = [];
  const scopes = ['wasm/extractor', 'wasm/rewriter', 'wasm/shaders', 'pipeline/shaders', 'signing', 'release'];
  async function visit(directory, prefix) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
      if (['node_modules', 'bin', 'obj', 'tests', 'test'].includes(entry.name) || entry.name.startsWith('.')) continue;
      const relative = prefix + '/' + entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Source mirror must not contain links: ${relative}`);
      if (entry.isDirectory()) { await visit(path.join(directory, entry.name), relative); continue; }
      if (!/\.(?:cs|csproj|cpp|hpp|props|targets|mjs|ts|py|sh|json|txt)$/.test(entry.name) && entry.name !== 'bun.lock') continue;
      const bytes = await readFile(path.join(directory, entry.name));
      // Build sources must not contain literal machine-specific local paths.
      if (bytes.includes(Buffer.from(os.homedir() + path.sep))) throw new Error(`Machine-specific path in public build source: ${relative}`);
      await put(destination, 'source/' + relative, bytes);
      files.push({ path: 'source/' + relative, sha256: sha256(bytes) });
    }
  }
  for (const scope of scopes) await visit(path.join(['release', 'signing'].includes(scope) ? root : stageRoot, 'tools/browser-builder', scope), scope);
  return files.sort((a, b) => a.path < b.path ? -1 : 1);
}

export async function assemble(options) {
  const { outDir, extractorWwwroot, rewriterBundle, shaderPipelineBundle, nugetAssets, dotnetRuntimePack } = options;
  for (const [name, value] of Object.entries({ outDir, extractorWwwroot, rewriterBundle, shaderPipelineBundle, dotnetRuntimePack })) if (typeof value !== 'string' || !value) throw new Error(`Required release component path is missing: ${name}`);
  if (!nugetAssets?.extractor || !nugetAssets?.shaders) throw new Error('Both actual NuGet project.assets.json files are required');
  const root = options.repoRoot ?? repoRoot, output = path.resolve(outDir);
  const original = await exists(output);
  if (original && (!original.isDirectory() ||
    (!(await exists(path.join(output, 'browser-tools.json'))) && !(await exists(path.join(output, '.browser-tools.json')))))) {
    if (!original.isDirectory() || (await readdir(output)).length) throw new Error('Refusing to replace an unowned nonempty output directory');
  }
  for (const source of [extractorWwwroot, rewriterBundle, shaderPipelineBundle]) if (path.resolve(source) === output || path.resolve(source).startsWith(output + path.sep) || output.startsWith(path.resolve(source) + path.sep)) throw new Error('Release output must be separate from stage inputs');
  const temporary = output + '.staging-' + randomUUID();
  await mkdir(temporary, { recursive: true });
  try {
    await requireFiles(extractorWwwroot, ['extractor.js', 'browser-io.js', 'extractor-worker.js', 'extractor-client.js', '_framework/dotnet.js'], 'extractor');
    const rewriter = await verifyRewriter(rewriterBundle), shaders = await verifyShader(shaderPipelineBundle);
    await copyStage(extractorWwwroot, 'extractor', name => dotnetPath(name, extractorRoots), temporary);
    await copyStage(rewriterBundle, 'rewriter', allowedRewriter, temporary);
    await copyStage(shaderPipelineBundle, 'shaders', allowedShader, temporary);
    const dependencies = await collectLicenses({ out: temporary, repoRoot: root, rewriterBundle, shaderPipelineBundle, nugetAssets, dotnetRuntimePack, scratch: options.scratch ?? path.join(root, 'tmp/odyssey/browser-release-tools') });
    const recipes = await sourceInventory(root, temporary, options.stageSourceRoot);
    const translatorPins = JSON.parse(await readFile(path.join(root, 'tools/browser-builder/wasm/shaders/sources.json'), 'utf8'));
    const program = await readFile(path.join(root, 'external/nxnative/dm/gfx/tools/dmsh_xlate/Program.cs'));
    if (sha256(program) !== translatorPins.originalProgramSha256) throw new Error('Original linked translator no longer matches its source pin');
    const extractorLock = await readFile(path.join(root, 'tools/browser-builder/wasm/extractor/packages.lock.json'));
    await put(temporary, 'sources.json', jsonBytes({ format: 1, nxnative: revision, rewriter, shaders, translatorPins, extractorNugetLockSha256: sha256(extractorLock), recipes, dependencyInventorySha256: sha256(await readFile(path.join(temporary, 'dependencies.json'))) }));
    await put(temporary, 'browser-tools.json', jsonBytes({ format: 1, kind: 'switchrecomp-public-browser-tools' }));
    const files = [];
    for (const name of await listFiles(temporary)) {
      const bytes = await readAsset(temporary, name);
      const kind = auditBytes(name, bytes);
      files.push({ path: name, size: bytes.length, sha256: sha256(bytes), kind });
    }
    const entrypoints = { extractor: 'extractor/extractor.js', rewriter: 'rewriter/index.mjs', shaderPipeline: 'shaders/index.mjs' };
    const shaderOptions = { bundleURL: './' };
    const manifest = { format: 1, kind: 'switchrecomp-public-browser-tools', entrypoints, shaderOptions, shaderChain: shaders.chain, files, bytes: files.reduce((sum, f) => sum + f.size, 0), components: dependencies.components.map(c => ({ name: c.name, version: c.version })), resolvedNugetPackages: dependencies.nuget.length };
    const bytes = jsonBytes(manifest);
    await put(temporary, 'manifest.json', bytes);
    await put(temporary, 'SHA256SUMS', Buffer.from([...files.map(f => `${f.sha256}  ${f.path}`), `${sha256(bytes)}  manifest.json`].sort((a, b) => a.slice(66) < b.slice(66) ? -1 : 1).join('\n') + '\n'));
    if (original) await rm(output, { recursive: true });
    await rename(temporary, output);
    return { format: 1, entrypoints, shaderOptions, shaderChain: shaders.chain, manifestSha256: sha256(bytes), files: files.length, bytes: manifest.bytes };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

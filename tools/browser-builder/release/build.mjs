import { mkdir, readdir, cp, symlink, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assemble, repoRoot } from './assemble.mjs';
import { defaultAssets } from './options.mjs';
import { runLogged } from './processes.mjs';
import { verifyBundle } from './verify.mjs';
import { sha256 } from './files.mjs';

async function mirrorDirectory(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (['node_modules', 'bin', 'obj', 'test', 'tests', '.git'].includes(entry.name) || entry.name.startsWith('.')) continue;
    if (entry.isSymbolicLink()) throw new Error(`Unexpected source symlink: ${entry.name}`);
    const target = path.join(destination, entry.name);
    if (entry.isDirectory()) await mirrorDirectory(path.join(source, entry.name), target);
    else await cp(path.join(source, entry.name), target);
  }
}

export async function buildTools({ outDir, reuseBuilt = false, reuseRewriterBundle, scratch = path.join(repoRoot, 'tmp/odyssey/browser-release-tools') }) {
  if (!outDir) throw new Error('An explicit outDir is required; the release builder never chooses or wipes dist');
  if (reuseBuilt) {
    const result = await assemble({ outDir, ...await defaultAssets(), scratch });
    return { result, audit: await verifyBundle(path.resolve(outDir)) };
  }
  const lock = path.join(scratch, 'build.lock');
  await mkdir(scratch, { recursive: true });
  try { await mkdir(lock); } catch { throw new Error('A release tools build is already active; inspect its captured job logs'); }
  const mirror = path.join(scratch, 'build-root'), logs = path.join(scratch, 'build-jobs');
  try {
    // These are exact public source copies, not edits to another agent's modules.
    for (const scope of ['wasm/extractor', 'wasm/rewriter', 'wasm/shaders', 'pipeline/shaders']) {
      await rm(path.join(mirror, 'tools/browser-builder', scope), { recursive: true, force: true });
      await mirrorDirectory(path.join(repoRoot, 'tools/browser-builder', scope), path.join(mirror, 'tools/browser-builder', scope));
    }
    await mkdir(path.join(mirror, 'external'), { recursive: true });
    await rm(path.join(mirror, 'external/nxnative'), { force: true });
    await symlink(path.join(repoRoot, 'external/nxnative'), path.join(mirror, 'external/nxnative'), 'dir');
    await mkdir(path.join(mirror, 'scripts/patches'), { recursive: true });
    await cp(path.join(repoRoot, 'scripts/patches/nxnative-odyssey-sdk3.patch'), path.join(mirror, 'scripts/patches/nxnative-odyssey-sdk3.patch'));
    const temp = path.join(scratch, 'host-tmp');
    await mkdir(temp, { recursive: true });
    // Do not consume SDK-repacked packages or a developer's global NuGet cache.
    // Locked restores use the same signed public packages as the clean CI host.
    const env = { ...process.env, TMPDIR: temp, EM_CACHE: path.join(scratch, 'cross-em-cache'),
      NUGET_PACKAGES: path.join(scratch, 'nuget-public-packages'), DisableImplicitLibraryPacksFolder: 'true' };
    const jobs = [];
    async function run(label, args, additions = {}) {
      jobs.push({ label, args: args.map(arg => arg.replaceAll(mirror, '$SOURCE_MIRROR').replaceAll(scratch, '$RELEASE_SCRATCH')) });
      await writeFile(path.join(scratch, 'build-plan.json'), JSON.stringify({ format: 1, jobs }, null, 2) + '\n');
      await runLogged(args, { directory: logs, label, cwd: mirror, env: { ...env, ...additions } });
    }
    await run('dotnet-version', ['dotnet', '--version']);
    if ((await readFile(path.join(logs, 'dotnet-version.log'), 'utf8')).trim() !== '10.0.402') throw new Error('Reproducible tool builds require .NET SDK 10.0.402');
    await run('cross-compiler-version', ['emcc', '--version']);
    if (!(await readFile(path.join(logs, 'cross-compiler-version.log'), 'utf8')).includes('6.0.13')) throw new Error('Reproducible Cross builds require Emscripten 6.0.13');
    await rm(path.join(mirror, 'tmp/odyssey/browser-extractor/publish'), { recursive: true, force: true });
    await run('extractor-publish', ['dotnet', 'publish', path.join(mirror, 'tools/browser-builder/wasm/extractor/BrowserExtractor.csproj'), '-c', 'Release', '-o', path.join(mirror, 'tmp/odyssey/browser-extractor/publish'), '-p:RestoreLockedMode=true']);
    const rewriter = path.join(mirror, 'tmp/odyssey/browser-rewriter');
    if (reuseRewriterBundle) {
      // Verify the finished public bundle before using its already-built wheels/runtime.
      const sums = (await readFile(path.join(reuseRewriterBundle, 'SHA256SUMS'), 'utf8')).trim().split('\n');
      for (const row of sums) {
        const match = row.match(/^([a-f0-9]{64})  (.+)$/);
        if (!match || match[2].includes('..') || path.isAbsolute(match[2]) || sha256(await readFile(path.join(reuseRewriterBundle, match[2]))) !== match[1]) throw new Error('Existing rewriter dependency checksum mismatch');
      }
      await rm(path.join(rewriter, 'bundle'), { recursive: true, force: true });
      await cp(reuseRewriterBundle, path.join(rewriter, 'bundle'), { recursive: true });
      await cp(path.join(reuseRewriterBundle, 'pyodide'), path.join(rewriter, 'setup/node_modules/pyodide'), { recursive: true });
      await run('rewriter-prepare', ['bun', path.join(mirror, 'tools/browser-builder/wasm/rewriter/build/prepare.mjs')]);
      await run('rewriter-finalize', ['bun', path.join(mirror, 'tools/browser-builder/wasm/rewriter/build/finalize.mjs')]);
    } else {
      await run('rewriter-dependencies', ['bash', path.join(mirror, 'tools/browser-builder/wasm/rewriter/build/dependencies.sh')]);
    }
    await rm(path.join(mirror, 'tmp/odyssey/browser-shaders/publish'), { recursive: true, force: true });
    await run('maxwell-publish', ['sh', path.join(mirror, 'tools/browser-builder/wasm/shaders/build.sh')]);
    await run('cross-build', ['sh', path.join(mirror, 'tools/browser-builder/wasm/shaders/build-spirv-cross.sh')]);
    await run('shader-chain-dependencies', ['bun', path.join(mirror, 'tools/browser-builder/pipeline/shaders/install-dependencies.mjs')]);
    await rm(path.join(mirror, 'tmp/odyssey/browser-shader-chain/bundle'), { recursive: true, force: true });
    await run('shader-chain-prepare', ['bun', path.join(mirror, 'tools/browser-builder/pipeline/shaders/build.mjs')]);
    const assets = await defaultAssets(mirror);
    const result = await assemble({ outDir, ...assets, repoRoot, stageSourceRoot: mirror, scratch });
    return { result, audit: await verifyBundle(path.resolve(outDir)), buildJobs: jobs.map(j => j.label) };
  } finally { await rm(lock, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { 'out-dir': { type: 'string' }, 'reuse-built': { type: 'boolean', default: false }, 'reuse-rewriter-bundle': { type: 'string' } }, strict: true });
  if (!values['out-dir']) throw new Error('Usage: bun release/build.mjs --out-dir PATH [--reuse-built | --reuse-rewriter-bundle PATH]');
  console.log(JSON.stringify(await buildTools({ outDir: path.resolve(values['out-dir']), reuseBuilt: values['reuse-built'], reuseRewriterBundle: values['reuse-rewriter-bundle'] ? path.resolve(values['reuse-rewriter-bundle']) : undefined }), null, 2));
}

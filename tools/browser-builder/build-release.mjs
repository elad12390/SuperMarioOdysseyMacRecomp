import { cp, readFile, mkdir, writeFile, lstat, readdir, rename, rm, rmdir, symlink, copyFile } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { assemble } from './release/assemble.mjs';
import { defaultAssets } from './release/options.mjs';
import { buildTools } from './release/build.mjs';
import { verifyBundle } from './release/verify.mjs';
import { createRuntimeRecipe, validateRuntimeTemplate, runRuntimeCommand } from './runtime/recipe.ts';

const builder = dirname(fileURLToPath(import.meta.url)), root = resolve(builder, '../..');
const scratch = resolve(root, 'tmp/odyssey/browser-release-tools');
const canonicalSite = resolve(builder, 'dist');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function exists(path) { try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
function allowedSite(path) {
  if (path !== canonicalSite && !path.startsWith(scratch + sep)) throw new Error('Release output must be this builder’s dist or its own browser-release-tools scratch directory.');
}
async function publicTools(directory) {
  const verification = await verifyBundle(directory);
  const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
  return { format: 1, entrypoints: manifest.entrypoints, shaderOptions: manifest.shaderOptions ?? {}, shaderChain: manifest.shaderChain, manifestSha256: verification.manifestSha256, files: verification.files, bytes: verification.bytes };
}

export async function buildRelease(options = {}) {
  const site = resolve(options.outDir ?? canonicalSite);
  allowedSite(site);
  if (options.runtimeDir && !options.reuseRuntime) throw new Error('--runtime-dir requires --reuse-runtime.');
  const runId = randomUUID(), work = resolve(scratch, 'build-release', runId), logs = resolve(work, 'jobs');
  await mkdir(work, { recursive: true });
  const lock = resolve(scratch, 'release-site-' + sha256(site).slice(0, 16) + '.lock');
  try { await mkdir(lock); } catch { throw new Error('A release assembly for this output is already running; inspect its captured logs.'); }
  let published = false;
  try {
    let toolsDirectory, tools, toolsBuildRan = false;
    if (options.reuseTools) {
      const candidates = options.toolsDir ? [resolve(options.toolsDir)] : [resolve(site, 'tools'), resolve(canonicalSite, 'tools'), resolve(scratch, 'site-tools')];
      for (const candidate of candidates) if (await exists(resolve(candidate, 'manifest.json'))) { toolsDirectory = candidate; break; }
      if (toolsDirectory) tools = await publicTools(toolsDirectory);
      else if (options.toolsDir) throw new Error('The requested reusable tool bundle is missing.');
      else {
        toolsDirectory = resolve(work, 'prepared-tools');
        tools = await assemble({ outDir: toolsDirectory, ...await defaultAssets() });
      }
    } else {
      toolsDirectory = resolve(work, 'built-tools');
      tools = (await buildTools({ outDir: toolsDirectory })).result;
      toolsBuildRan = true;
    }
    const recipe = await createRuntimeRecipe({ shaderChain: tools.shaderChain, logDirectory: resolve(logs, 'recipe') });
    const cacheWork = resolve(scratch, 'runtime-cache', recipe.identity);
    const runtimeWork = resolve(options.runtimeWork ?? process.env.SWITCHRECOMP_RUNTIME_WORK ?? cacheWork);
    let runtimeDirectory, runtimeBuildRan = false;
    if (options.reuseRuntime) {
      const candidates = options.runtimeDir ? [resolve(options.runtimeDir)] : [resolve(runtimeWork, 'public'), resolve(site, 'runtime'), resolve(canonicalSite, 'runtime'), resolve(root, 'tmp/odyssey/browser-release/runtime-final/public')];
      for (const candidate of candidates) if (await exists(resolve(candidate, 'manifest.json'))) { runtimeDirectory = candidate; break; }
      if (!runtimeDirectory) throw new Error('No completed runtime exists for --reuse-runtime. Build this recipe once in fresh scratch.');
    } else {
      runtimeDirectory = resolve(runtimeWork, 'public');
      if (!(await exists(resolve(runtimeDirectory, 'manifest.json')))) {
        if (await exists(resolve(runtimeWork, 'src'))) throw new Error('An incomplete runtime source export already exists. It was preserved; select a fresh --runtime-work instead of removing a broad directory.');
        await runRuntimeCommand(['bun', resolve(builder, 'runtime/build.ts')], {
          directory: logs, label: 'runtime-build', timeoutMs: 15 * 60 * 1000,
          env: { ...process.env, SWITCHRECOMP_SHADER_CHAIN: tools.shaderChain, SWITCHRECOMP_RUNTIME_WORK: runtimeWork },
        });
        runtimeBuildRan = true;
      }
    }
    // All reuse failures happen before rebuilding or replacing the existing UI.
    const runtime = await validateRuntimeTemplate({ directory: runtimeDirectory, expectedRecipe: recipe, logDirectory: resolve(logs, 'runtime-input') });
    const ui = resolve(work, 'ui');
    await mkdir(ui);
    await copyFile(resolve(builder, 'build.ts'), resolve(ui, 'build.ts'));
    for (const name of ['web', 'pipeline', 'signing', 'dmg', 'node_modules']) await symlink(resolve(builder, name), resolve(ui, name), 'dir');
    await runRuntimeCommand(['bun', resolve(ui, 'build.ts')], { directory: logs, label: 'ui-build' });
    const stagedSite = resolve(ui, 'dist');
    await cp(toolsDirectory, resolve(stagedSite, 'tools'), { recursive: true, preserveTimestamps: true });
    await cp(runtimeDirectory, resolve(stagedSite, 'runtime'), { recursive: true, preserveTimestamps: true });
    const copiedTools = await publicTools(resolve(stagedSite, 'tools'));
    if (copiedTools.manifestSha256 !== tools.manifestSha256) throw new Error('Tool bundle changed while copying; the existing site was preserved.');
    const copiedRuntime = await validateRuntimeTemplate({ directory: resolve(stagedSite, 'runtime'), expectedRecipe: recipe, logDirectory: resolve(logs, 'runtime-copy') });
    if (copiedRuntime.manifestSha256 !== runtime.manifestSha256) throw new Error('Runtime template changed while copying; the existing site was preserved.');
    const catalog = {
      format: 1, extractor: 'tools/' + tools.entrypoints.extractor, rewriter: 'tools/' + tools.entrypoints.rewriter,
      shaderPipeline: 'tools/' + tools.entrypoints.shaderPipeline, shaderOptions: tools.shaderOptions,
      runtime: 'runtime/manifest.json', shaderChain: tools.shaderChain, publicToolManifestSha256: tools.manifestSha256,
      runtimeManifestSha256: runtime.manifestSha256, runtimeRecipeIdentity: recipe.identity,
    };
    await writeFile(resolve(stagedSite, 'build-manifest.json'), JSON.stringify(catalog, null, 2) + '\n');
    await writeFile(resolve(stagedSite, '.browser-release.json'), JSON.stringify({ format: 1, kind: 'switchrecomp-public-browser-release', shaderChain: tools.shaderChain, toolManifestSha256: tools.manifestSha256, runtimeManifestSha256: runtime.manifestSha256, runtimeRecipeIdentity: recipe.identity }, null, 2) + '\n');
    const old = await exists(site), backup = site + '.previous-' + runId;
    if (old && (!old.isDirectory() || old.isSymbolicLink())) throw new Error('Release output must be an ordinary directory.');
    if (old && site !== canonicalSite && (await readdir(site)).length && !(await exists(resolve(site, '.browser-release.json')))) throw new Error('Refusing to replace an unowned nonempty scratch directory.');
    await mkdir(dirname(site), { recursive: true });
    if (old) await rename(site, backup);
    try { await rename(stagedSite, site); }
    catch (error) { if (old) await rename(backup, site); throw error; }
    published = true;
    // This exact renamed, owned previous output is the only directory removed.
    if (old) await rm(backup, { recursive: true });
    const result = { site, shaderChain: tools.shaderChain, toolManifestSha256: tools.manifestSha256, runtimeManifestSha256: runtime.manifestSha256, runtimeRecipeIdentity: recipe.identity, runtimeDirectory, toolsBuildRan, runtimeBuildRan, logDirectory: logs, containsPrivateGameInputs: false, verification: 'Static release, file hashes and ad-hoc signatures verified; integrated NSP-to-DMG/gameplay validation is separate.' };
    await writeFile(resolve(work, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    await writeFile(resolve(scratch, 'release-latest.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(`STATIC_BROWSER_RELEASE=${site}`);
    return result;
  } finally {
    await writeFile(resolve(work, 'assembly.status'), published ? 'published\n' : 'preserved-existing-output\n');
    await rmdir(lock);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { 'reuse-tools': { type: 'boolean', default: false }, 'reuse-runtime': { type: 'boolean', default: false }, 'tools-dir': { type: 'string' }, 'runtime-dir': { type: 'string' }, 'runtime-work': { type: 'string' }, 'out-dir': { type: 'string' } }, strict: true });
  await buildRelease({ reuseTools: values['reuse-tools'], reuseRuntime: values['reuse-runtime'], toolsDir: values['tools-dir'], runtimeDir: values['runtime-dir'], runtimeWork: values['runtime-work'], outDir: values['out-dir'] });
}

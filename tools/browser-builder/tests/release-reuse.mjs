// Run on the runtime build host, with the same build environment as build:release.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildRelease } from '../build-release.mjs';
import { verifyBundle } from '../release/verify.mjs';
import { createRuntimeRecipe, validateRuntimeTemplate } from '../runtime/recipe.ts';

const root = path.resolve(import.meta.dirname, '../../..');
const scratch = path.join(root, 'tmp/odyssey/browser-release-tools');
const canonical = path.join(root, 'tools/browser-builder/dist');
const latestPath = path.join(scratch, 'release-latest.json');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
async function optionalRead(file) {
  try { return await readFile(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Include the closed inventory and modes; never follow symlinks or load a bundle at once.
async function snapshot(directory) {
  const files = [];
  async function walk(file, name) {
    const info = await lstat(file);
    if (info.isSymbolicLink()) files.push({ path: name, link: await readlink(file) });
    else if (info.isDirectory()) {
      files.push({ path: name, directory: true, mode: info.mode & 0o777 });
      for (const child of (await readdir(file)).sort()) await walk(path.join(file, child), name ? name + '/' + child : child);
    } else {
      assert(info.isFile(), 'Unexpected input file type: ' + file);
      const digest = createHash('sha256');
      for await (const bytes of createReadStream(file)) digest.update(bytes);
      files.push({ path: name, size: info.size, mode: info.mode & 0o777, sha256: digest.digest('hex') });
    }
  }
  try { await walk(directory, ''); } catch (error) { if (error.code === 'ENOENT' && !files.length) return null; throw error; }
  return hash(JSON.stringify(files));
}

async function regression(values) {
  const previousLatest = await optionalRead(latestPath);
  const selectedRuntime = values.runtime ?? (previousLatest && JSON.parse(previousLatest.toString()).runtimeDirectory);
  assert(selectedRuntime, 'Supply --runtime DIR, or build a runtime recorded in release-latest.json first.');
  const runtime = path.resolve(selectedRuntime), tools = path.resolve(values.tools ?? path.join(canonical, 'tools'));
  await mkdir(scratch, { recursive: true });
  const work = await mkdtemp(path.join(scratch, 'release-reuse-'));
  const artifacts = path.join(work, 'artifacts'), site = path.join(artifacts, 'site');
  const proof = { format: 1, test: 'release-reuse', runtimeDirectory: runtime, toolsDirectory: tools, checks: [] };
  const runs = [];
  let failure, frozen, input, toolInput;
  async function release(runtimeDir = runtime) {
    const result = await buildRelease({ outDir: site, reuseTools: true, reuseRuntime: true, toolsDir: tools, runtimeDir });
    runs.push(result);
    assert.equal(result.toolsBuildRan, false, 'Reuse must not build tools.');
    assert.equal(result.runtimeBuildRan, false, 'Reuse must not build a runtime.');
    return result;
  }
  try {
    frozen = await snapshot(canonical);
    input = await snapshot(runtime);
    toolInput = tools === path.join(canonical, 'tools') ? null : await snapshot(tools);
    const toolBundle = await verifyBundle(tools);
    const expected = await createRuntimeRecipe({ shaderChain: toolBundle.shaderChain, logDirectory: path.join(work, 'jobs/recipe') });
    const valid = await validateRuntimeTemplate({ directory: runtime, expectedRecipe: expected, logDirectory: path.join(work, 'jobs/valid-runtime') });
    const recorded = valid.manifest;
    Object.assign(proof, { shaderChain: recorded.shaderChain, sourceIdentity: expected.identity, runtimeManifestSha256: valid.manifestSha256, toolManifestSha256: toolBundle.manifestSha256 });
    proof.checks.push('real-runtime-hashes-signature-arm64');
    await mkdir(artifacts);

    const first = await release();
    assert.equal(first.runtimeManifestSha256, valid.manifestSha256);
    assert.equal(first.toolManifestSha256, toolBundle.manifestSha256);
    const originalSite = await snapshot(site);
    const originalTools = await snapshot(path.join(site, 'tools'));
    const originalRuntime = await snapshot(path.join(site, 'runtime'));

    // Change a minimal source mirror, never the live runtime source or its recipe.
    const fixture = path.join(artifacts, 'source');
    for (const source of expected.inputs.sources) {
      const target = path.join(fixture, source.path);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(root, source.path), target);
    }
    for (const file of expected.inputs.font.files) {
      const relative = path.join('tools/browser-builder/node_modules/@fontsource/nunito', file.path);
      await mkdir(path.dirname(path.join(fixture, relative)), { recursive: true });
      await copyFile(path.join(root, relative), path.join(fixture, relative));
    }
    const source = path.join(fixture, 'tools/browser-builder/runtime/launcher.m');
    await writeFile(source, Buffer.concat([await readFile(source), Buffer.from('\n// release reuse source-drift probe\n')]));
    const changed = await createRuntimeRecipe({ root: fixture, shaderChain: recorded.shaderChain, toolchain: expected.inputs.toolchain });
    assert.notEqual(changed.identity, expected.identity);
    await assert.rejects(() => validateRuntimeTemplate({ directory: runtime, expectedRecipe: changed }), /source-recipe identity mismatch/);
    proof.checks.push('source-drift-rejected');
    await rm(fixture, { recursive: true });

    const wrongChain = await createRuntimeRecipe({ shaderChain: recorded.shaderChain === 'aaaaaaaaaaaa' ? 'bbbbbbbbbbbb' : 'aaaaaaaaaaaa', toolchain: expected.inputs.toolchain });
    await assert.rejects(() => validateRuntimeTemplate({ directory: runtime, expectedRecipe: wrongChain }), /source-recipe identity mismatch/);
    proof.checks.push('wrong-chain-rejected');
    await assert.rejects(() => release(path.join(artifacts, 'absent-runtime')), /No completed runtime exists/);
    proof.checks.push('missing-runtime-rejected');

    const sealedResource = recorded.files.find(file => file.path.includes('/Contents/Resources/') && /\.(?:txt|md)$/.test(file.path));
    assert(sealedResource, 'The generic template must contain a signed text resource for the tampering checks.');
    const cases = [
      ['missing-sourceRecipe', /source-recipe identity is missing/],
      ['invalid-sourceRecipe', /source-recipe identity mismatch/],
      ['bad-hash', /file hash mismatch/],
      ['bad-signature', /runtime-codesign failed/],
    ];
    for (const [name, message] of cases) {
      const directory = path.join(artifacts, name);
      await cp(runtime, directory, { recursive: true, preserveTimestamps: true });
      const manifestFile = path.join(directory, 'manifest.json'), manifest = await json(manifestFile);
      if (name === 'missing-sourceRecipe') delete manifest.sourceRecipe;
      else if (name === 'invalid-sourceRecipe') manifest.sourceRecipe.inputs.signing = 'invalid-test-signing';
      else {
        const resource = path.join(directory, 'files', sealedResource.path);
        const data = Buffer.concat([await readFile(resource), Buffer.from('\nrelease reuse resource-tampering probe\n')]);
        await writeFile(resource, data);
        if (name === 'bad-signature') {
          const entry = manifest.files.find(file => file.path === sealedResource.path);
          entry.size = data.length;
          entry.sha256 = hash(data);
        }
      }
      await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
      // Go through the actual release entry point, including real codesign rejection.
      await assert.rejects(() => release(directory), message);
      proof.checks.push(name + '-rejected');
      await rm(directory, { recursive: true });
    }
    assert.equal(await snapshot(site), originalSite, 'A rejected reuse changed the existing site.');
    proof.checks.push('rejected-reuse-preserves-site');

    const second = await release();
    for (const result of [first, second]) {
      assert.equal(result.runtimeRecipeIdentity, expected.identity);
      assert.equal(result.toolManifestSha256, toolBundle.manifestSha256);
      assert.equal(result.runtimeManifestSha256, valid.manifestSha256);
    }
    assert.equal(await snapshot(path.join(site, 'tools')), originalTools);
    assert.equal(await snapshot(path.join(site, 'runtime')), originalRuntime);
    proof.uiRebundles = 2;
    proof.checks.push('two-ui-rebundles-preserve-tools-runtime', 'no-tool-or-runtime-build');
  } catch (error) { failure = error; }

  // Always clean only this run's copies, even after an assertion fails. Keep small logs.
  try {
    if (frozen !== undefined) assert.equal(await snapshot(canonical), frozen, 'Canonical dist changed during the regression.');
    if (input !== undefined) assert.equal(await snapshot(runtime), input, 'The supplied runtime changed during the regression.');
    if (toolInput) assert.equal(await snapshot(tools), toolInput, 'The supplied tools changed during the regression.');
    proof.checks.push('canonical-dist-and-input-assets-unchanged');
  } catch (error) { failure ??= error; }
  try {
    const current = await optionalRead(latestPath);
    // Restore the pre-test report only if it is still this run's report.
    if (current && JSON.parse(current.toString()).site === site) {
      if (previousLatest) await writeFile(latestPath, previousLatest);
      else await rm(latestPath);
    }
    for (const [index, result] of runs.entries()) {
      const directory = path.dirname(result.logDirectory);
      assert.equal(path.dirname(directory), path.join(scratch, 'build-release'));
      assert.equal((await json(path.join(directory, 'result.json'))).site, site);
      const destination = path.join(work, 'builds', String(index + 1));
      await mkdir(destination, { recursive: true });
      for (const name of ['jobs', 'result.json', 'assembly.status']) await cp(path.join(directory, name), path.join(destination, name), { recursive: true });
      await rm(directory, { recursive: true });
    }
  } catch (error) { failure ??= error; }
  try {
    await rm(artifacts, { recursive: true, force: true });
    proof.fixtureCopiesRemoved = true;
  } catch (error) { failure ??= error; }
  proof.passed = !failure;
  if (failure) proof.error = failure.stack ?? String(failure);
  const report = path.join(work, 'proof.json');
  await writeFile(report, JSON.stringify(proof, null, 2) + '\n');
  console.log(`RELEASE_REUSE_${failure ? 'FAIL' : 'PASS'}=${report}`);
  if (failure) throw failure;
}

try {
  const { values } = parseArgs({ options: { runtime: { type: 'string' }, tools: { type: 'string' }, help: { type: 'boolean' } }, strict: true });
  if (values.help) console.log('Usage: bun tools/browser-builder/tests/release-reuse.mjs [--runtime DIR] [--tools DIR]\nRuntime defaults to release-latest.json runtimeDirectory; tools default to dist/tools. Uses real signatures, no runtime/tool builds or app launches.');
  else await regression(values);
} catch (error) {
  console.error('Release reuse regression failed: ' + error.message);
  process.exitCode = 1;
}

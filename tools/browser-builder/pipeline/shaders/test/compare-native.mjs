// Local CPU verification only; never execute a game or modify a mounted app.
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyRetainedBfC1 } from './guard-compat.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const work = path.join(root, 'tmp/odyssey/browser-shader-chain');
const nativeGame = path.join(root, 'game-data/super-mario-odyssey');
const record = 'browser-msl-source-v1; preserve-invariance; first-launch Metal';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const runtimeJson = /^[0-9a-f]{16}_b(?:g[0-4v])?\.json$/;
const sorted = values => [...values].sort();
const minus = (a, b) => sorted(a).filter(name => !b.has(name));
const canonical = value => Array.isArray(value) ? value.map(canonical) :
  value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
function functional(value) {
  const copy = structuredClone(value);
  delete copy.chain; delete copy.chain_metal;
  return JSON.stringify(canonical(copy));
}
async function batches(items, fn) {
  for (let i = 0; i < items.length; i += 16) await Promise.all(items.slice(i, i + 16).map(fn));
}
function relative(name) {
  if (typeof name !== 'string' || /[\\\0]/.test(name) || name.split('/').some(n => !n || n === '.' || n === '..')) throw Error('Unsafe artifact path: ' + name);
  return name;
}
export async function verifyActualFiles(files, gameDirectory) {
  const result = { requested: !!gameDirectory, checked: 0, failures: [] };
  if (gameDirectory) await batches(files, async file => {
    try {
      const bytes = await readFile(path.join(gameDirectory, relative(file.path)));
      if (bytes.length !== file.size || sha(bytes) !== file.sha256) result.failures.push({ file: file.path, reason: 'Actual size/SHA-256 differs from embedded manifest' });
      else result.checked++;
    } catch (error) { result.failures.push({ file: file.path, reason: error.code || error.message }); }
  });
  return result;
}
const depthHelpers = ['2d', '2d_array', 'cube', 'cube_array'].map(t =>
  'template <typename T>\nstatic inline depth' + t + '<T> spvDepthCast(texture' + t + '<T> t)\n{\n' +
  '    return reinterpret_cast<thread const depth' + t + '<T> &>(t);\n}\n\n').join('');
function inverseDepth(text) {
  if (!text.includes(depthHelpers)) return null;
  text = text.replace(depthHelpers, '');
  const members = new Set();
  text = text.replace(/spvDepthCast\(([^()\n]*)\)/g, (_, argument) => {
    const member = argument.match(/\.(\w+)/)?.[1];
    if (member) members.add(member);
    return argument;
  });
  for (const member of members) text = text.replace(new RegExp('\\btexture(\\w*)<([^>]+)>(\\s+' + member + '\\b)', 'g'), 'depth$1<$2>$3');
  return { texts: [text, text.replace('#pragma clang diagnostic ignored "-Wmissing-prototypes"\n\n', '')], members: [...members] };
}
function aliasBindings(value, members) {
  const copy = structuredClone(value);
  for (const binding of copy.bindings || []) if (members.includes(binding.msl_name)) binding.msl_type = binding.msl_type.replace(/^texture/, 'depth');
  return copy;
}
function browserJson(value, chain) {
  const copy = structuredClone(value);
  copy.chain = chain; delete copy.chain_metal; copy.chain_metal = record;
  return JSON.stringify(copy, null, 1);
}

/** Accept the embedded manifest itself or the older {manifest, stamp, guards} proof. */
export async function compareNative(proof, { gameDirectory, expectedChain, nativeDirectory = nativeGame, runtimeDirectory, sourceManifestPath } = {}) {
  const manifest = proof.manifest || proof;
  if (!manifest || !/^[0-9a-f]{12}$/.test(manifest.chain) || !Array.isArray(manifest.files)) throw Error('Expected an actual shader-chain manifest');
  const chain = manifest.chain;
  const cachePrefix = 'shader/cache/b-' + chain + '/';
  const profilePrefix = 'profile/0100000000010000/';
  const cache = path.join(nativeDirectory, 'shader/cache/b-dec5ee141a9f');
  const profile = path.join(nativeDirectory, profilePrefix);
  const issues = [], files = new Map();
  for (const file of manifest.files) {
    relative(file.path);
    if (files.has(file.path) || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[0-9a-f]{64}$/.test(file.sha256)) throw Error('Invalid or duplicate file metadata: ' + file.path);
    files.set(file.path, file);
    if (file.path.endsWith('.metallib')) issues.push({ file: file.path, reason: 'Browser output contains a native library' });
  }
  if (expectedChain && chain !== expectedChain) issues.push({ reason: 'Template shader chain differs', expected: expectedChain, actual: chain });
  const readActual = name => readFile(path.join(gameDirectory, relative(name)));
  // The embedded manifest intentionally omits its own shader-chain.json entry.
  const actualFileChecks = await verifyActualFiles([...files.values()], gameDirectory);
  if (gameDirectory) {
    try {
      for (const name of await readdir(path.join(gameDirectory, cachePrefix))) {
        if (!files.has(cachePrefix + name)) issues.push({ file: cachePrefix + name, reason: 'Actual cache file is absent from embedded manifest' });
      }
    } catch (error) { issues.push({ reason: 'Cannot read actual shader cache', error: error.code || error.message }); }
  }
  for (const name of ['game.tsv', 'shader_map.tsv', 'shader_facts.tsv', 'shader_pairs.tsv', 'c1_full.tsv', 'cb_extent.tsv']) {
    if (!files.has(profilePrefix + name)) issues.push({ file: profilePrefix + name, reason: 'Required profile artifact is undeclared' });
  }
  const rows = (await readFile(path.join(profile, 'shader_map.tsv'), 'utf8')).split('\n')
    .filter(l => l && !l.startsWith('#') && !l.startsWith('package\t')).map(l => l.split('\t'));
  const stageCounts = {}, expectedMetal = new Set(), expectedJson = new Set(), nativeRefs = new Map();
  const required = { base: 0, geometry: 0, fetch: 0, shadow: 0 };
  await batches(rows, async row => {
    const key = row[3], name = key + '_b.json';
    stageCounts[row[2]] = (stageCounts[row[2]] || 0) + 1;
    const raw = await readFile(path.join(cache, name), 'utf8'), value = JSON.parse(raw);
    nativeRefs.set(name, { raw, value });
    expectedMetal.add(key + '_b.metal'); expectedJson.add(name); required.base++;
    if (value.fetch) { expectedMetal.add(key + '_bf.metal'); required.fetch++; }
    if (value.vin) { expectedMetal.add(key + '_bv.metal'); required.shadow++; }
    if (value.stage === 'gs' && value.geometry) for (const suffix of ['g0', 'g1', 'g2', 'g3', 'g4', 'gv']) {
      expectedMetal.add(key + '_b' + suffix + '.metal'); expectedJson.add(key + '_b' + suffix + '.json'); required.geometry++;
    }
  });
  const output = [...files.values()].filter(f => f.path.startsWith(cachePrefix));
  const metal = output.filter(f => f.path.endsWith('.metal'));
  const actualMetal = new Set(metal.map(f => path.basename(f.path)));
  const actualJson = new Set(output.map(f => path.basename(f.path)).filter(n => runtimeJson.test(n)));
  const names = { expected: expectedMetal.size, actual: actualMetal.size, missing: minus(expectedMetal, actualMetal), extra: minus(actualMetal, expectedMetal),
    missingJson: minus(expectedJson, actualJson), extraJson: minus(actualJson, expectedJson) };
  if (expectedMetal.size !== 39185 || rows.length !== 27210 || manifest.shaders !== 27210) issues.push({ reason: 'Unexpected canonical v0 shader/profile counts' });
  const nativeNames = new Set(await readdir(cache));
  const nativeBinaryNames = new Set([...nativeNames].filter(n => n.endsWith('.metallib')).map(n => n.slice(0, -9) + '.metal'));
  const nativeCacheExtras = minus(nativeBinaryNames, expectedMetal);
  const msl = { total: metal.length, bytes: metal.reduce((n, f) => n + f.size, 0), exactNativeSource: 0, nativeBinaryOnly: 0, aliasDepth: [], mismatches: [] };
  const aliases = new Map();
  await batches(metal, async file => {
    const name = path.basename(file.path);
    if (!expectedMetal.has(name)) return;
    if (!expectedJson.has(name.slice(0, -6) + '.json')) {
      if (nativeBinaryNames.has(name)) msl.nativeBinaryOnly++;
      else msl.mismatches.push({ file: name, reason: 'Canonical variant has no native oracle' });
      return;
    }
    const bytes = await readFile(path.join(cache, name)), expected = sha(bytes);
    if (expected === file.sha256) { msl.exactNativeSource++; return; }
    const alias = inverseDepth(bytes.toString());
    if (alias?.texts.some(text => sha(text) === file.sha256)) {
      aliases.set(name.slice(0, 16), alias.members); msl.aliasDepth.push(name);
    } else msl.mismatches.push({ file: name, expected, actual: file.sha256 });
  });
  const reflection = { total: expectedJson.size, canonicalMatches: 0, aliasDepth: [], mismatches: [] };
  await batches(sorted(expectedJson), async name => {
    const artifact = files.get(cachePrefix + name);
    if (!artifact) return;
    let original = nativeRefs.get(name);
    if (!original) { const raw = await readFile(path.join(cache, name), 'utf8'); original = { raw, value: JSON.parse(raw) }; }
    const members = aliases.get(name.slice(0, 16)) || [];
    if (gameDirectory) {
      try {
        const actual = JSON.parse(await readActual(artifact.path));
        if (actual.chain !== chain || actual.chain_metal !== record) issues.push({ file: name, reason: 'Reflection backend identity differs' });
        if (functional(actual) === functional(original.value)) reflection.canonicalMatches++;
        else if (members.length && functional(actual) === functional(aliasBindings(original.value, members))) reflection.aliasDepth.push(name);
        else reflection.mismatches.push({ file: name, reason: 'Canonical reflection fields differ' });
      } catch (error) { reflection.mismatches.push({ file: name, reason: error.code || error.message }); }
    } else {
      // Hash-only proofs classify content; they do not establish actual disk writes.
      const direct = original.raw.replace(/("chain":\s*)"[^"]*"/, (_, p) => p + JSON.stringify(chain))
        .replace(/("chain_metal":\s*)"[^"]*"/, (_, p) => p + JSON.stringify(record));
      if ([direct, browserJson(original.value, chain)].some(text => sha(text) === artifact.sha256)) reflection.canonicalMatches++;
      else if (members.length && sha(browserJson(aliasBindings(original.value, members), chain)) === artifact.sha256) reflection.aliasDepth.push(name);
      else reflection.mismatches.push({ file: name, reason: 'Hash matches no canonical serialization' });
    }
  });
  const tableChecks = {}, guardChecks = {};
  for (const name of ['shader_map.tsv', 'shader_facts.tsv', 'shader_pairs.tsv']) {
    const expected = sha(await readFile(path.join(profile, name))), actual = files.get(profilePrefix + name)?.sha256;
    tableChecks[name] = { sha256: actual, exactNative: actual === expected };
  }
  for (const name of ['c1_full.tsv', 'cb_extent.tsv']) {
    const native = await readFile(path.join(profile, name));
    let header = proof.guards?.[name], bodyMatches = false;
    if (gameDirectory) {
      try {
        const actual = await readActual(profilePrefix + name), end = actual.indexOf(10);
        header = actual.subarray(0, end).toString();
        bodyMatches = actual.subarray(end).equals(native.subarray(native.indexOf(10)));
      } catch (error) { issues.push({ file: name, reason: error.code || error.message }); }
    } else if (header) bodyMatches = sha(Buffer.concat([Buffer.from(header), native.subarray(native.indexOf(10))])) === files.get(profilePrefix + name)?.sha256;
    guardChecks[name] = { sha256: files.get(profilePrefix + name)?.sha256, exactNativeBody: bodyMatches,
      stampMatches: !!header?.startsWith('# chain b-' + chain + ' inputs ' + manifest.inputs + ' ') };
  }
  let stamp = proof.stamp;
  if (gameDirectory) try { stamp = (await readActual(cachePrefix + 'inputs.tsv')).toString(); } catch (error) { issues.push({ file: 'inputs.tsv', reason: error.code || error.message }); }
  const stampRows = Object.fromEntries((stamp || '').split('\n').filter(l => l && !l.startsWith('#') && l.includes('\t')).map(l => l.split('\t', 2)));
  const stampMatches = stampRows.game === '0100000000010000' && stampRows.inputs === manifest.inputs;
  let inputsRecomputed;
  if (gameDirectory) {
    const inputHash = createHash('sha256');
    for (const name of ['shader_facts.tsv', 'shader_map.tsv', 'shader_map.tsv.conflicts.tsv', 'shader_pairs.tsv', 'bf_want.tsv']) {
      let bytes;
      try { bytes = await readActual(profilePrefix + name); } catch (error) { if (error.code !== 'ENOENT') throw error; bytes = Buffer.from('missing'); }
      inputHash.update('game/' + name + '\0').update(bytes).update('\0');
    }
    const game = (await readActual(profilePrefix + 'game.tsv')).toString();
    inputHash.update(game.split('\n').filter(l => /^(nvn_|shader_)/.test(l)).map(l => l + '\n').join(''));
    inputsRecomputed = inputHash.digest('hex').slice(0, 12);
    if (inputsRecomputed !== manifest.inputs) issues.push({ reason: 'Actual profile inputs digest differs', expected: manifest.inputs, actual: inputsRecomputed });
  }
  const nonC1Matches = !issues.length && !names.missing.length && !names.extra.length && !names.missingJson.length && !names.extraJson.length &&
    !msl.mismatches.length && !msl.aliasDepth.length && !reflection.mismatches.length && !reflection.aliasDepth.length &&
    reflection.canonicalMatches === expectedJson.size && stampMatches &&
    Object.values(tableChecks).every(v => v.exactNative) && guardChecks['cb_extent.tsv'].exactNativeBody &&
    Object.values(guardChecks).every(v => v.stampMatches);
  const actualFilesVerified = actualFileChecks.requested && !actualFileChecks.failures.length && actualFileChecks.checked === files.size;
  const retainedBf = metal.some(file => /_bf\.metal$/.test(file.path));
  let c1Compatibility;
  // Always check retained-BF libraries, even if a missing flag made the old table
  // comparison equal. A historical native table is not their source-derived oracle.
  if (retainedBf) {
    c1Compatibility = { passed: false, required: true, issues: ['Current actual-file and non-C1 prerequisites have not passed'] };
    if (actualFilesVerified && nonC1Matches) {
      try {
        c1Compatibility = await verifyRetainedBfC1({ gameDirectory, manifest, runtimeDirectory, sourceManifestPath,
          nativeC1Path: path.join(profile, 'c1_full.tsv') });
      } catch (error) { c1Compatibility = { passed: false, required: true, issues: [error.message] }; }
    }
  }
  const c1Accepted = retainedBf ? c1Compatibility?.passed === true : guardChecks['c1_full.tsv'].exactNativeBody;
  const manifestMatches = nonC1Matches && c1Accepted;
  return { passed: manifestMatches && actualFilesVerified,
    manifestMatches, actualFileChecks, chain, inputs: manifest.inputs, inputsRecomputed, shaders: manifest.shaders, stageCounts,
    files: files.size, bytes: [...files.values()].reduce((n, f) => n + f.size, 0), required, names, nativeCacheExtras,
    msl, reflection, tableChecks, guardChecks, c1Compatibility, stampMatches, issues };
}

if (import.meta.main) {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--proof', '--game', '--expected-chain', '--report', '--runtime-directory', '--source-manifest'].includes(args[i]) || !args[i + 1]) throw Error('Usage: --game /mounted/.../Contents/Resources/game [--proof manifest.json] [--expected-chain CHAIN] [--runtime-directory build-cache] [--source-manifest sources.json] [--report own-tmp/report.json]');
    options[args[i].slice(2)] = args[i + 1];
  }
  const proofPath = path.resolve(options.proof || (options.game ? path.join(options.game, 'shader-chain.json') : path.join(work, 'full-library-proof.json')));
  const proof = JSON.parse(await readFile(proofPath, 'utf8'));
  const result = await compareNative(proof, { gameDirectory: options.game && path.resolve(options.game), expectedChain: options['expected-chain'],
    runtimeDirectory: options['runtime-directory'], sourceManifestPath: options['source-manifest'] });
  const report = path.resolve(options.report || path.join(work, 'native-comparison-report.json'));
  if (!report.startsWith(work + path.sep) || report === proofPath) throw Error('Comparison report must stay in the owned tmp directory and preserve its input proof');
  await writeFile(report, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ passed: result.passed, chain: result.chain, actualFilesChecked: result.actualFileChecks.checked,
    actualFileFailures: result.actualFileChecks.failures.length, files: result.files, bytes: result.bytes, mslFiles: result.msl.total,
    mslBytes: result.msl.bytes, required: result.required, missingNames: result.names.missing.length, extraNames: result.names.extra.length,
    exactNativeMsl: result.msl.exactNativeSource, depthAliasMsl: result.msl.aliasDepth.length, canonicalJson: result.reflection.canonicalMatches,
    depthAliasJson: result.reflection.aliasDepth.length, historicalNativeC1BodyExact: result.guardChecks['c1_full.tsv'].exactNativeBody,
    c1CompatibilityPassed: result.c1Compatibility?.passed, c1CompatibilityIssues: result.c1Compatibility?.issues,
    unresolved: result.msl.mismatches.length + result.reflection.mismatches.length + result.issues.length, report }));
  if (!result.passed) process.exitCode = 1;
}

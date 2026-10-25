import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import puppeteer from '../../../wasm/shaders/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js';
import { apiChecks } from './api-checks.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../../../..');
const work = path.join(root, 'tmp/odyssey/browser-shader-chain');
const bundleDirectory = path.resolve(process.env.SHADER_BUNDLE ?? path.join(work, 'bundle'));
const parallel = process.env.SHADER_PARALLEL === '1';
const ownedProfile = path.join(work, process.env.SHADER_FULL === '1' ? 'stream-proof-profile' : parallel ? 'parallel-profile' : 'sample-profile');
const fixture = JSON.parse(await readFile(path.join(work, 'fixtures.json'), 'utf8'));
const requests = [], events = [], messages = [];
const server = createServer(async (request, response) => {
  requests.push({ method: request.method, path: request.url, body: !!request.headers['content-length'] });
  try {
    assert.equal(request.method, 'GET');
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Isolated browser shader chain proof</title>'); return; }
    const badBundle = url.pathname.startsWith('/bad-bundle/');
    const bundle = badBundle || url.pathname.startsWith('/bundle/');
    const base = bundle ? bundleDirectory : path.dirname(here);
    const relative = bundle ? url.pathname.slice(badBundle ? 12 : 8) : url.pathname.slice(1);
    const resolved = path.resolve(base, relative);
    assert(resolved.startsWith(base + path.sep));
    let bytes = await readFile(resolved);
    if (badBundle && relative === 'toolchain.json') { const manifest = JSON.parse(bytes); manifest.chain = '000000000000'; bytes = Buffer.from(JSON.stringify(manifest)); }
    response.setHeader('Content-Type', ({ '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' })[path.extname(resolved)] || 'application/octet-stream');
    response.end(bytes);
  } catch { response.statusCode = 404; response.end('Static tool asset unavailable'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await puppeteer.launch({ executablePath: path.join(process.env.HOME, '.cache/going-up-browsers/chrome-headless-shell/ext/chrome-headless-shell-mac-arm64/chrome-headless-shell'),
    headless: true, protocolTimeout: 0, userDataDir: ownedProfile, args: ['--no-sandbox', '--disable-gpu', '--disable-background-networking'] });
  await writeFile(path.join(work, process.env.SHADER_FULL === '1' ? 'active-full-browser.json' : 'active-sample-browser.json'), JSON.stringify({ pid: browser.process().pid, profile: ownedProfile, endpoint: browser.wsEndpoint() }));
  const page = await browser.newPage();
  page.on('console', message => messages.push(message.text())); page.on('pageerror', error => messages.push(String(error)));
  await page.goto('http://127.0.0.1:' + server.address().port, { waitUntil: 'load' });
  await page.exposeFunction('shaderProofProgress', event => {
    const now = Date.now();
    if (!events.length || now - events.at(-1).time > 5000 || event.stage === 'write') {
      events.push({ time: now, ...event }); console.log(JSON.stringify(events.at(-1)));
    }
  });
  if (process.env.SHADER_FULL === '1') {
    const localRoot = path.join(root, 'game-data/super-mario-odyssey/extract/v0');
    const relativeFiles = [];
    async function listLocal(directory, prefix = '') {
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isDirectory()) await listLocal(path.join(directory, entry.name), prefix + entry.name + '/');
        else relativeFiles.push(prefix + entry.name);
      }
    }
    await listLocal(localRoot);
    await page.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.multiple = true; input.id = 'local-input'; document.body.append(input); });
    const picker = await page.$('#local-input');
    await picker.uploadFile(...relativeFiles.map(name => path.join(localRoot, name)));
    const full = await page.evaluate(async relativeFiles => {
      const storage = await navigator.storage.getDirectory();
      const job = await storage.getDirectoryHandle('shader-full-proof', { create: true });
      await job.removeEntry('output', { recursive: true }).catch(() => {});
      const outputDirectory = await job.getDirectoryHandle('output', { create: true });
      const files = [...document.querySelector('#local-input').files];
      if (!files.length) throw new Error('Chrome did not grant local extraction files');
      const inputFiles = files.map((file, index) => {
        if (relativeFiles[index].split('/').at(-1) !== file.name) throw new Error('Local file-picker ordering changed');
        return { path: relativeFiles[index], file };
      });
      const { run } = await import('/bundle/index.mjs');
      const started = performance.now();
      const manifest = await run({ inputFiles, outputDirectory }, shaderProofProgress);
      const directory = await (await (await outputDirectory.getDirectoryHandle('shader')).getDirectoryHandle('cache')).getDirectoryHandle('b-' + manifest.chain);
      const stamp = await (await (await directory.getFileHandle('inputs.tsv')).getFile()).text();
      const profile = await (await outputDirectory.getDirectoryHandle('profile')).getDirectoryHandle('0100000000010000');
      const guards = {}, guardBodies = {};
      for (const name of ['c1_full.tsv', 'cb_extent.tsv']) {
        const text=await(await(await profile.getFileHandle(name)).getFile()).text();guards[name]=text.split('\n')[0];
        const body=text.split('\n').filter(s=>s&&!s.startsWith('#')).join('\n')+'\n';
        guardBodies[name]=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(body))),b=>b.toString(16).padStart(2,'0')).join('');
      }
      return { manifest, stamp, guards, guardBodies, elapsedMs: performance.now() - started, inputFiles: files.length,
        inputBytes: files.reduce((n, f) => n + f.size, 0), inputCopiedBytes: 0, crossOriginIsolated };
    }, relativeFiles);
    assert.equal(full.crossOriginIsolated, false);
    assert.equal(full.manifest.shaders, 27210);
    assert(full.manifest.files.every(f => f.path.startsWith('shader/cache/b-' + full.manifest.chain + '/') || f.path.startsWith('profile/0100000000010000/') || f.path === 'shader-chain.json'));
    assert(full.manifest.files.every(f => !f.path.endsWith('.metallib')));
    assert(full.stamp.includes('inputs\t' + full.manifest.inputs));
    for (const value of Object.values(full.guards)) assert(value.startsWith('# chain b-' + full.manifest.chain + ' inputs ' + full.manifest.inputs + ' '));
    for(const name of ['c1_full.tsv','cb_extent.tsv']){
      const baseline=await readFile(path.join(root,'tmp/odyssey/browser-release/generated-1987-acceptance/relocated/Super Mario Odyssey.app/Contents/Resources/game/profile/0100000000010000',name),'utf8');
      const body=baseline.split('\n').filter(s=>s&&!s.startsWith('#')).join('\n')+'\n';
      assert.equal(full.guardBodies[name],createHash('sha256').update(body).digest('hex'),'Complete guard table body changed: '+name);
    }
    const tableChecks = {};
    for (const name of ['shader_map.tsv', 'shader_facts.tsv', 'shader_pairs.tsv']) {
      const native = await readFile(path.join(root, 'game-data/super-mario-odyssey/profile/0100000000010000', name));
      const expected = createHash('sha256').update(native).digest('hex');
      const actual = full.manifest.files.find(f => f.path === 'profile/0100000000010000/' + name)?.sha256;
      assert.equal(actual, expected, 'Original full-library split differs: ' + name);
      tableChecks[name] = { sha256: actual, exactNative: true };
    }
    assert(requests.every(r => r.method === 'GET' && !r.body));
    await writeFile(path.join(work, 'full-library-proof.json'), JSON.stringify({ ...full, tableChecks, events, requests, messages }, null, 2));
    console.log(JSON.stringify({ fullLibrary: true, shaders: full.manifest.shaders, chain: full.manifest.chain, elapsedMs: full.elapsedMs, files: full.manifest.files.length, noUploads: true }));
  } else {
  const proof = await page.evaluate(async fixtures => {
    const storage = await navigator.storage.getDirectory();
    await storage.removeEntry('shader-chain-proof', { recursive: true }).catch(() => {});
    const outputDirectory = await storage.getDirectoryHandle('shader-chain-proof', { create: true });
    const worker = new Worker('/test/worker.mjs', { type: 'module' });
    const started = performance.now(), progress = [];
    try {
      return await new Promise((resolve, reject) => {
        worker.onerror = event => reject(new Error(event.message));
        worker.onmessage = ({ data }) => {
          if (data.type === 'progress') progress.push(data.event);
          if (data.type === 'error') reject(new Error(data.message));
          if (data.type === 'result') resolve({ ...data, progress, elapsedMs: performance.now() - started, crossOriginIsolated });
        };
        worker.postMessage({ fixtures, outputDirectory, parallel: fixtures.parallel, bundleURL: new URL('/bundle/', location.href).href });
      });
    } finally { worker.terminate(); }
  }, {...fixture,parallel});
  assert.equal(proof.crossOriginIsolated, false);
  assert.equal(proof.result.shaders, fixture.keys.length);
  if(parallel){
    assert(proof.result.batches.some(batch=>batch.packageCacheHits>0),'Immutable package cache was not reused');
    assert(proof.result.batches.every(batch=>batch.packageCacheBytes<=192*1024*1024),'Package cache exceeded its bound');
  }
  assert(proof.exported.some(file => file.size > 16 * 1024 * 1024), 'Real large-source streaming export was not exercised');
  assert(proof.files.every(file => !file.name.endsWith('.metallib')));
  for (const [name, expected] of Object.entries({
    '0020759d9400a726_bf.metal': '4d11402a2e5cf54b7c78dfec2335142c04ea6c497b594f638cac66b107ab2900',
    '0044cbe6fa23c643_bf.metal': 'd8652bcbc3403450dfc549167b230a87cb5703c6010b0a77b545232dfae93e2d',
  })) {
    const source = proof.files.find(file => file.name === name);
    assert(source, 'Original fetch rule produced no persisted source: ' + name);
    assert.equal(createHash('sha256').update(source.text).digest('hex'), expected, 'Original fetch body changed: ' + name);
  }
  const nativeRoot = path.join(root, 'game-data/super-mario-odyssey/shader/cache/b-dec5ee141a9f');
  for (const key of fixture.keys) {
    const reflection = JSON.parse(proof.files.find(file => file.name === key + '_b.json').text);
    assert.equal(reflection.chain, proof.result.chain);
    const msl = proof.files.find(file => file.name === key + '_b.metal').text;
    assert(!/fast::(?:min|max|clamp)\(/.test(msl));
    if (reflection.stage === 'vs') { assert.equal(reflection.entry_z, 'main0_z'); assert(msl.includes('main0_z')); }
    assert(reflection.bindings && reflection.raster);
    if (reflection.stage === 'gs') {
      assert.equal(reflection.msl_entry_kind, 'kernel');
      assert(reflection.geometry.vertices > 0);
      for (const suffix of ['_bg0', '_bg1', '_bg2', '_bg3', '_bg4', '_bgv']) {
        assert(proof.files.some(file => file.name === key + suffix + '.metal'), 'Missing actual GS topology/reader variant');
        assert(proof.files.some(file => file.name === key + suffix + '.json'), 'Missing actual GS variant reflection');
        const variant = proof.files.find(file => file.name === key + suffix + '.metal');
        assert.equal(variant.text, await readFile(path.join(nativeRoot, variant.name), 'utf8'), 'Actual GS topology MSL changed: ' + variant.name);
        const actual = JSON.parse(proof.files.find(file => file.name === key + suffix + '.json').text);
        const expected = JSON.parse(await readFile(path.join(nativeRoot, key + suffix + '.json'), 'utf8'));
        for (const field of ['chain', 'chain_metal', 'source']) { delete actual[field]; delete expected[field]; }
        assert.deepEqual(actual, expected, 'Actual GS topology reflection changed: ' + key + suffix);
      }
    }
    assert.equal(msl, await readFile(path.join(nativeRoot, key + '_b.metal'), 'utf8'), 'Higher Python MSL rules changed for ' + key);
    const nativeReflection = JSON.parse(await readFile(path.join(nativeRoot, key + '_b.json'), 'utf8'));
    // The reduced fixture intentionally stores a selected native record at
    // package index 0. Only its diagnostic source index and backend identity
    // differ; every functional reflection field must be byte-equivalent JSON.
    for (const field of ['chain', 'chain_metal', 'source']) { delete reflection[field]; delete nativeReflection[field]; }
    assert.deepEqual(reflection, nativeReflection, 'Higher Python reflection rules changed for ' + key);
  }
  for (const table of ['c1_full.tsv', 'cb_extent.tsv']) assert(proof.files.find(file => file.name === table).text.startsWith('# chain b-' + proof.result.chain + ' inputs ' + proof.result.inputs + ' '));
  assert(requests.every(r => r.method === 'GET' && !r.body));
  const output = { ...proof, requests, messages };
  output.apiChecks = await apiChecks(page, root);
  await writeFile(path.join(work, parallel ? 'parallel-shader-proof.json' : 'single-shader-proof.json'), JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ chain: proof.result.chain, shaders: proof.result.shaders, elapsedMs: proof.elapsedMs, sourceFiles: proof.files.length, scratchBytes: proof.scratchBytes, nonisolated: true, requests: requests.length, noUploads: true }));
  }
} catch (error) { console.error(messages.join('\n')); throw error; }
finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(ownedProfile, { recursive: true, force: true });
}

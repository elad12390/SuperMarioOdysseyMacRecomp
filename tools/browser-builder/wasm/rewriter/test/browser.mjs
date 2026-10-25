import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../../../../../', import.meta.url)));
const scope = join(root, 'tools/browser-builder/wasm/rewriter');
const scratch = join(root, 'tmp/odyssey/browser-rewriter');
const require = createRequire(join(scratch, 'setup/package.json'));
const puppeteer = require('puppeteer-core');
const original = process.env.REWRITER_EXEFS || join(root, 'game-data/super-mario-odyssey/extract/v0/ExeFS');
const oracle = process.env.REWRITER_ORACLE || join(root, 'game-data/super-mario-odyssey/patched_v0');
const requests = [];
const network = [];
const csp = "default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'self'";
const server = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  fetch(request) {
    const path = decodeURIComponent(new URL(request.url).pathname);
    requests.push({ method: request.method, path, body: request.headers.get('content-length') });
    if (request.method !== 'GET') return new Response('No uploads', { status: 405 });
    if (path === '/') return new Response('<!doctype html><title>NSO worker integration</title>', { headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': csp } });
    const location = path.startsWith('/bundle/') ? join(scratch, 'bundle', path.slice(8)) : join(scope, path);
    if (!location.startsWith(scope + '/') && !location.startsWith(join(scratch, 'bundle') + '/')) return new Response('', { status: 403 });
    return new Response(Bun.file(location), { headers: { 'Content-Security-Policy': csp } });
  },
});
const browser = await puppeteer.launch({
  executablePath: process.env.REWRITER_CHROME || join(process.env.HOME, '.cache/going-up-browsers/chrome-headless-shell/ext/chrome-headless-shell-mac-arm64/chrome-headless-shell'),
  headless: true,
  userDataDir: join(scratch, 'chrome-profile'),
  protocolTimeout: 1800000,
  args: ['--no-sandbox', '--js-flags=--max-old-space-size=4096'],
});
try {
  const page = await browser.newPage();
  page.on('request', request => {
    const record = { url: request.url(), method: request.method(), hasBody: !!request.postData() };
    network.push(record);
  });
  page.on('workercreated', worker => {
    worker.client.on('Network.requestWillBeSent', ({ request }) => network.push({ url: request.url, method: request.method, hasBody: !!request.postData }));
    worker.client.send('Network.enable').catch(error => console.error('worker network observer:', error.message));
  });
  page.on('console', message => console.log('browser:', message.text()));
  page.on('pageerror', error => console.error('browser error:', error));
  await page.goto(server.url.href);
  // The browser's real FileSystemDirectoryHandles live in OPFS. Populate via
  // DevTools evaluation, never by serving private inputs over HTTP.
  await page.evaluate(async () => {
    const fs = await navigator.storage.getDirectory();
    await fs.removeEntry('test', { recursive: true }).catch(() => {});
    window.testRoot = await fs.getDirectoryHandle('test', { create: true });
    window.inputDirectory = await testRoot.getDirectoryHandle('input', { create: true });
    window.outputDirectory = await testRoot.getDirectoryHandle('output', { create: true });
  });
  for (const name of ['main', 'subsdk0', 'sdk']) {
    const bytes = await readFile(join(original, name));
    for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) {
      const base64 = bytes.subarray(offset, offset + 1024 * 1024).toString('base64');
      await page.evaluate(async ({ name, base64, offset, size }) => {
        const h = await inputDirectory.getFileHandle(name, { create: true });
        const w = await h.createWritable({ keepExistingData: true });
        await w.write({ type: 'write', position: offset, data: Uint8Array.from(atob(base64), x => x.charCodeAt(0)) });
        await w.truncate(size); await w.close();
      }, { name, base64, offset, size: bytes.length });
    }
  }
  const negative = await page.evaluate(async () => {
    const { run } = await import('/bundle/index.mjs');
    const results = [];
    async function rejects(label, args, expected) {
      console.log(`case: ${label}`);
      let failure;
      try { await run({ inputDirectory, outputDirectory, modules: ['main', 'subsdk0', 'sdk'], ...args }); }
      catch (error) { failure = error.message; }
      if (!failure || !new RegExp(expected).test(failure)) throw new Error(`${label}: wrong rejection: ${failure}`);
      const files = []; for await (const name of outputDirectory.keys()) files.push(name);
      if (files.length) throw new Error(`${label}: leaked outputs: ${files}`);
      results.push({ label, error: failure });
    }
    await rejects('URL input', { inputDirectory: 'https://example.invalid/main' }, 'local FileSystemDirectoryHandles');
    await rejects('wrong module set', { modules: ['main'] }, 'Exactly main');
    await rejects('input equals output', { outputDirectory: inputDirectory }, 'must differ');
    await rejects('invalid dependency URL', { bundleURL: 'https://[invalid' }, 'Invalid URL');
    const bad = await testRoot.getDirectoryHandle('bad', { create: true });
    await rejects('missing module', { inputDirectory: bad }, 'Missing original ExeFS module');
    const original = await (await inputDirectory.getFileHandle('main')).getFile();
    const header = new Uint8Array(await original.slice(0, 256).arrayBuffer());
    const handle = await bad.getFileHandle('main', { create: true });
    async function set(bytes) { const w = await handle.createWritable(); await w.write(bytes); await w.close(); }
    header[0x40] ^= 1; await set(header);
    await rejects('unsupported build', { inputDirectory: bad }, 'unsupported build');
    header[0x40] ^= 1; await set(header);
    await rejects('truncated segment', { inputDirectory: bad }, 'corrupt or truncated NSO');
    header[0] = 0; await set(header);
    await rejects('wrong magic', { inputDirectory: bad }, 'expected original NSO0');
    for (const name of ['subsdk0', 'sdk']) {
      const file = await (await inputDirectory.getFileHandle(name)).getFile();
      const destination = await bad.getFileHandle(name, { create: true });
      const stream = await destination.createWritable(); await stream.write(file); await stream.close();
    }
    const damaged = new Uint8Array(await original.arrayBuffer());
    // Keep valid compressed data and the supported build ID; damage the stored
    // uncompressed segment hash to prove the real integrity check runs.
    damaged[0xa0] ^= 1; await set(damaged);
    await rejects('corrupt segment hash', { inputDirectory: bad }, 'SHA-256 mismatch');
    const controller = new AbortController(); controller.abort();
    await rejects('already aborted', { signal: controller.signal }, 'abort');
    // Force real work and real file creation before cancellation. The caller
    // must get AbortError and an empty output directory, with no success.
    const cancel = new AbortController();
    let cancelled = false;
    try {
      await run({ inputDirectory, outputDirectory, modules: ['sdk', 'main', 'subsdk0'], signal: cancel.signal }, event => {
        console.log(`cancel case: ${JSON.stringify(event)}`);
        if (event.stage === 'rewritten') cancel.abort();
      });
    } catch (error) { if (error.name !== 'AbortError') throw error; cancelled = true; }
    if (!cancelled) throw new Error('Cancellation returned success');
    const remaining = []; for await (const n of outputDirectory.keys()) remaining.push(n);
    if (remaining.length) throw new Error(`Cancellation leaked ${remaining}`);
    results.push({ label: 'cancel after real sdk output', cleaned: true });
    // Existing files must survive a rejected conversion unchanged.
    const existing = await outputDirectory.getFileHandle('main.patched.bin', { create: true });
    const w = await existing.createWritable(); await w.write('preserve'); await w.close();
    let refused = false;
    try { await run({ inputDirectory, outputDirectory, modules: ['main', 'subsdk0', 'sdk'] }); }
    catch (error) { refused = /Output already exists/.test(error.message); }
    if (!refused || await (await existing.getFile()).text() !== 'preserve') throw new Error('Existing output was overwritten');
    await outputDirectory.removeEntry('main.patched.bin');
    results.push({ label: 'existing output preserved', preserved: true });
    return results;
  });
  console.log(`PASS: ${negative.length} real browser rejection/cancellation cases`);
  const result = await page.evaluate(async () => {
    const { run } = await import('/bundle/index.mjs');
    const progress = [];
    const manifest = await run({ inputDirectory, outputDirectory, modules: ['main', 'subsdk0', 'sdk'] }, event => { progress.push(event); console.log(JSON.stringify(event)); });
    return { manifest, progress };
  });
  assert.equal(result.manifest.modules.length, 3);
  assert.equal(result.manifest.files.length, 19);
  const comparisons = [];
  for (const entry of result.manifest.files) {
    // The oracle provenance predates the approved root patch source. Verify
    // metadata against the pinned bundle, keeping all 18 NSO/TSV byte checks.
    const source = await Bun.file(join(scratch, 'bundle/sources.json')).json();
    const expected = entry.name === 'build_src.sha256'
      ? Buffer.from(['dm/tools/patch_nso.py', 'dm/tools/nso_code.py', 'dm/tools/nso_asm.py', 'dm/tools/sdk_patches.py', ...source.files.map(f => f.path).filter(p => p.startsWith('dm/games/')).sort()]
          .map(path => `${source.files.find(f => f.path === path).sha256}  ${path.startsWith('dm/tools/') ? path.slice(9) : '../' + path.slice(3)}\n`).join(''))
      : await readFile(join(oracle, entry.name));
    const expectedHash = createHash('sha256').update(expected).digest('hex');
    const actual = await page.evaluate(async name => {
      const file = await (await outputDirectory.getFileHandle(name)).getFile();
      const buffer = await file.arrayBuffer();
      return { size: file.size, sha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)), x => x.toString(16).padStart(2, '0')).join('') };
    }, entry.name);
    assert.equal(actual.size, expected.length, `${entry.name} size`);
    assert.equal(actual.sha256, expectedHash, `${entry.name} bytes`);
    assert.equal(entry.sha256, expectedHash, `${entry.name} manifest`);
    comparisons.push({ name: entry.name, ...actual });
  }
  assert(requests.every(r => r.method === 'GET' && !r.body), 'No private HTTP traffic');
  assert(network.every(r => new URL(r.url).origin === server.url.origin && r.method === 'GET' && !r.hasBody), 'Only local static dependencies are requested');
  const evidence = { ...result, negative, comparisons, requests, network, browser: await browser.version() };
  await writeFile(join(scratch, 'green.json'), JSON.stringify(evidence, null, 2));
  console.log('PASS: 18 NSO/TSV files byte-identical to patched_v0; source provenance matches pinned bundle');
} finally { await browser.close(); server.stop(true); }

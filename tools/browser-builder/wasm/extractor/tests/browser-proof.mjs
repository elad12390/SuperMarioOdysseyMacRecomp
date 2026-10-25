import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, stat, rm } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(source, '../../../..');
const scratch = resolve(repo, 'tmp/odyssey/browser-extractor');
const runId = process.env.EXTRACTOR_TEST_ID || `run-${process.pid}`;
if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error('Invalid proof run ID');
const runDirectory = resolve(scratch, 'tests', runId);
const profile = resolve(runDirectory, 'profile');
const iconOnly = process.env.EXTRACTOR_ICON_ONLY === '1';
const iconReference = process.env.EXTRACTOR_ICON_REFERENCE;
if (iconOnly && !iconReference) throw new Error('EXTRACTOR_ICON_REFERENCE is required for the icon-only proof');
const bundle = process.env.EXTRACTOR_BUNDLE || resolve(scratch, 'bin/Release/net10.0/wwwroot');
const nsp = process.env.EXTRACTOR_NSP;
const prod = process.env.EXTRACTOR_PROD_KEYS;
const workers = process.env.EXTRACTOR_WORKERS === undefined ? undefined : Number(process.env.EXTRACTOR_WORKERS);
if (workers !== undefined && (!/^[1-4]$/.test(process.env.EXTRACTOR_WORKERS) || !Number.isSafeInteger(workers)))
  throw new Error('EXTRACTOR_WORKERS must be 1, 2, 3 or 4');
const expectedFullWorkers = workers ?? 4;
const reference = process.env.EXTRACTOR_COMPARE_EVIDENCE
  ? JSON.parse(await readFile(process.env.EXTRACTOR_COMPARE_EVIDENCE, 'utf8')) : undefined;
const referenceRomfs = new Map((reference?.scenarios.find(s => s.name === 'complete ExeFS and RomFS')?.files || [])
  .filter(file => file.path.startsWith('RomFS/')).map((file, index) => [file.path, index]));
if (!nsp || !prod) throw new Error('Set EXTRACTOR_NSP and EXTRACTOR_PROD_KEYS to your private local proof inputs');
const chrome = process.env.EXTRACTOR_CHROME || resolve(process.env.HOME, '.cache/going-up-browsers/chrome-headless-shell/ext/chrome-headless-shell-mac-arm64/chrome-headless-shell');
const evidence = { runId, bundle, workersRequested: workers ?? 'default', expectedFullWorkers, scenarios: [], requests: [], inputBytes: (await stat(nsp)).size, fullRequested: !iconOnly && process.env.EXTRACTOR_FULL === '1', iconOnly };
function progressSummary(events, full = false, complete = full) {
  const counts = new Set(), partitions = new Map();
  for (const event of events) {
    if (event.workers !== undefined) {
      assert.ok(Number.isSafeInteger(event.workers) && event.workers >= 1 && event.workers <= expectedFullWorkers);
      if (!full) assert.equal(event.workers, 1, 'Control/ExeFS stays sequential');
      counts.add(event.workers);
    }
    if (event.io) assert.ok(event.io.maxReadBytes <= 1048576, 'Every reported worker read remains bounded to 1 MiB');
    if (event.workers > 1 && event.io && referenceRomfs.has(event.path)) {
      // The pool assigns the original RomFS enumeration round-robin. Preserve
      // each child's reported counters without changing product telemetry.
      const index = referenceRomfs.get(event.path) % event.workers;
      const prior = partitions.get(index);
      partitions.set(index, { index, samples: (prior?.samples || 0) + 1, ...event.io });
    }
  }
  if (full && expectedFullWorkers > 1) {
    assert.ok(counts.has(expectedFullWorkers), 'Actual RomFS progress reports the requested worker count');
    if (complete && referenceRomfs.size) assert.equal(partitions.size, expectedFullWorkers, 'Observe bounded I/O from every RomFS partition');
  }
  return { workerCounts: [...counts].sort(), partitionIo: [...partitions.values()].sort((a, b) => a.index - b.index), partitionIoSource: 'child progress grouped by reference RomFS enumeration index modulo workers' };
}
await mkdir(dirname(runDirectory), { recursive: true });
await mkdir(runDirectory); // Never reuse a profile or evidence owned by another run.
const server = createServer(async (req, res) => {
  evidence.requests.push({ method: req.method, path: req.url });
  if (req.method !== 'GET') { res.writeHead(405).end(); return; }
  if (req.url === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><input id="nsp" type="file"><input id="keys" type="file"><input id="icon-reference" type="file">');
    return;
  }
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://local').pathname);
    const base = bundle;
    const file = resolve(base, '.' + path);
    if (!file.startsWith(base + '/')) throw new Error('invalid path');
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.webcil': 'application/wasm' })[extname(file)] || 'application/octet-stream');
    res.end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
let browser;
try {
  browser = await puppeteer.launch({ executablePath: chrome, headless: true, userDataDir: profile, args: ['--no-sandbox', '--disable-dev-shm-usage'], timeout: 30000, protocolTimeout: 35 * 60 * 1000 });
  evidence.browser = await browser.version();
  await writeFile(resolve(runDirectory, 'browser-endpoint.txt'), browser.wsEndpoint() + '\n');
  const page = await browser.newPage();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const targets = await browser.target().createCDPSession();
  const liveWorkers = async () => (await targets.send('Target.getTargets')).targetInfos
    .filter(target => target.type === 'worker' && target.url.startsWith(origin + '/'))
    .map(target => ({ targetId: target.targetId, url: target.url }));
  await page.exposeFunction('proofWorkerTargets', liveWorkers);
  const networkViolations = [];
  const workerRequests = [];
  page.on('workercreated', worker => {
    worker.client.on('Network.requestWillBeSent', ({ request }) => {
      workerRequests.push({ method: request.method, path: new URL(request.url).pathname });
      if (!request.url.startsWith(origin + '/') || request.method !== 'GET')
        networkViolations.push({ method: request.method, url: request.url.split('?')[0] });
    });
  });
  page.on('request', request => {
    if (!request.url().startsWith(origin + '/') || request.method() !== 'GET') {
      networkViolations.push({ method: request.method(), url: request.url().split('?')[0] });
    }
  });
  page.on('pageerror', error => console.error('page:', error.message));
  page.on('console', msg => { if (msg.type() === 'error' || msg.text().startsWith('extraction phase')) console.log('browser:', msg.text()); });
  await page.goto(origin);
  await (await page.$('#nsp')).uploadFile(nsp);
  await (await page.$('#keys')).uploadFile(prod);
  if (iconReference) await (await page.$('#icon-reference')).uploadFile(iconReference);
  await page.evaluate(async workers => {
    const { createExtractorJob } = await import('./extractor-client.js');
    globalThis.createExtractorJob = createExtractorJob;
    globalThis.proofWorkerOptions = workers === null ? {} : { workers };
    globalThis.run = async options => {
      const progress = [];
      let lastPhase;
      const started = performance.now();
      const job = createExtractorJob({ ...proofWorkerOptions, nsp: document.querySelector('#nsp').files[0], prodKeys: document.querySelector('#keys').files[0], onProgress: p => { progress.push({ ...p, elapsedMs: performance.now() - started }); globalThis.latestProgress = p; const stage = p.phase + ':' + (p.detail || p.diagnostic || ''); if (lastPhase !== stage) { console.log('extraction phase', stage); lastPhase = stage; } }, ...options });
      return { result: await job.result, progress, elapsedMs: performance.now() - started };
    };
  }, workers ?? null);
  evidence.hardwareConcurrency = await page.evaluate(() => navigator.hardwareConcurrency);
  const outputHashes = (jobId, files) => page.evaluate(async ({ jobId, files }) => {
    const output = [];
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('switchrecomp-extractor');
    const job = await root.getDirectoryHandle(jobId);
    for (const { path, size } of files) {
      let directory = job;
      const parts = path.split('/');
      for (const name of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(name);
      const file = await (await directory.getFileHandle(parts.at(-1))).getFile();
      if (file.size !== size || file.size > 128 * 1024 * 1024) throw new Error('Proof hashing requires matching files no larger than 128 MiB.');
      const bytes = await file.arrayBuffer();
      const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
      output.push({ path, size, sha256 });
    }
    return output.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  }, { jobId, files });

  const exefs = await page.evaluate(() => run({ mode: 'exefs', jobId: 'test-exefs' }));
  assert.equal(exefs.result.titleId, '0100000000010000');
  assert.equal(exefs.result.supported, true);
  assert.equal(exefs.result.cryptoKnownAnswers, true, 'NIST AES-128/AES-256 ECB and AES-128 CBC encrypt/decrypt checks ran successfully in WASM');
  assert.ok(exefs.result.mainBuildId.length >= 32);
  assert.ok(exefs.result.filesWritten > 0);
  assert.ok(exefs.result.io.maxReadBytes <= 1048576);
  assert.ok(exefs.result.io.inputBytesRead < evidence.inputBytes);
  assert.ok(exefs.result.io.storageReadCalls > exefs.result.io.readCalls, 'Bounded read-ahead reduces synchronous file-read calls');
  assert.ok(exefs.progress.some(p => p.phase === 'extract'));
  const main = await page.evaluate(async () => {
    let dir = await navigator.storage.getDirectory();
    for (const name of ['switchrecomp-extractor', 'test-exefs', 'ExeFS']) dir = await dir.getDirectoryHandle(name);
    const file = await (await dir.getFileHandle('main')).getFile();
    const header = new Uint8Array(await file.slice(0, 128).arrayBuffer());
    return { size: file.size, magic: String.fromCharCode(...header.slice(0, 4)), buildId: [...header.slice(0x40, 0x60)].map(x => x.toString(16).padStart(2, '0')).join('') };
  });
  assert.equal(main.magic, 'NSO0');
  assert.equal(main.buildId, exefs.result.mainBuildId);
  evidence.scenarios.push({ name: 'real NSP decrypts to OPFS', ...exefs.result, main, elapsedMs: exefs.elapsedMs, progress: progressSummary(exefs.progress), hashes: await outputHashes('test-exefs', exefs.result.files) });
  await writeFile(resolve(runDirectory, 'checkpoint.json'), JSON.stringify({ ...evidence, checkpoint: 'EXEFS_VERIFIED' }, null, 2) + '\n');

  if (iconReference) {
    assert.ok(exefs.result.files.some(file => file.path === 'icon.jpg'), 'The control icon must appear in the extracted manifest');
    const icon = await page.evaluate(async () => {
      let dir = await navigator.storage.getDirectory();
      for (const name of ['switchrecomp-extractor', 'test-exefs']) dir = await dir.getDirectoryHandle(name);
      const actual = await (await dir.getFileHandle('icon.jpg')).getFile();
      const reference = document.querySelector('#icon-reference').files[0];
      const hash = async file => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))].map(x => x.toString(16).padStart(2, '0')).join('');
      return { size: actual.size, referenceSize: reference.size, sha256: await hash(actual), referenceSha256: await hash(reference) };
    });
    assert.equal(icon.size, icon.referenceSize);
    assert.equal(icon.sha256, icon.referenceSha256);
    evidence.scenarios.push({ name: 'optional control icon matches native extraction', ...icon });
  }

  if (!iconOnly) {
    const existing = await page.evaluate(async () => {
      try { await run({ mode: 'probe', jobId: 'test-exefs' }); return { rejected: false }; }
      catch (error) {
        let dir = await navigator.storage.getDirectory();
        for (const name of ['switchrecomp-extractor', 'test-exefs', 'ExeFS']) dir = await dir.getDirectoryHandle(name);
        return { rejected: true, code: error.code, mainBytes: (await (await dir.getFileHandle('main')).getFile()).size };
      }
    });
    assert.equal(existing.code, 'JOB_EXISTS');
    assert.equal(existing.mainBytes, main.size);
    evidence.scenarios.push({ name: 'existing job output is preserved', ...existing });

    for (const kind of ['truncated', 'wrong-keys']) {
      const rejected = await page.evaluate(async kind => {
        const nsp = document.querySelector('#nsp').files[0];
        const prodKeys = document.querySelector('#keys').files[0];
        try {
          await run({ jobId: 'test-' + kind, mode: 'probe', nsp: kind === 'truncated' ? new File([nsp.slice(0, 512)], 'truncated.nsp') : nsp, prodKeys: kind === 'wrong-keys' ? new File(['header_key = ' + '00'.repeat(32)], 'wrong.keys') : prodKeys });
          return { rejected: false };
        } catch (error) {
          const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('switchrecomp-extractor');
          let remains = true;
          try { await root.getDirectoryHandle('test-' + kind); } catch { remains = false; }
          return { rejected: true, code: error.code, message: error.message, remains };
        }
      }, kind);
      assert.equal(rejected.rejected, true, kind);
      assert.equal(rejected.remains, false, kind + ' cleanup');
      assert.ok(rejected.message.length > 15);
      assert.ok(!/[a-f0-9]{64}/i.test(rejected.message));
      evidence.scenarios.push({ name: kind, ...rejected });
    }

    const canceled = await page.evaluate(async () => {
      let job;
      let cancelPromise;
      const progress = [];
      let beforeCancel;
      job = createExtractorJob({ ...proofWorkerOptions, nsp: document.querySelector('#nsp').files[0], prodKeys: document.querySelector('#keys').files[0], jobId: 'test-cancel', mode: 'full', onProgress(p) {
        progress.push(p);
        if (p.phase === 'extract' && p.path?.startsWith('RomFS/') && p.fileBytesWritten > 0 && !cancelPromise) {
          cancelPromise = (async () => {
            const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('switchrecomp-extractor');
            const directory = await root.getDirectoryHandle('test-cancel');
            const entries = [];
            for await (const name of directory.keys()) entries.push(name);
            beforeCancel = { entries, workers: await proofWorkerTargets(), progressWorkers: p.workers ?? 1 };
            const started = performance.now();
            await job.cancel();
            beforeCancel.cleanupMs = performance.now() - started;
          })();
        }
      } });
      const result = await job.result.then(() => ({ completed: true }), e => ({ code: e.code }));
      await cancelPromise;
      let remains = true;
      try { await (await (await navigator.storage.getDirectory()).getDirectoryHandle('switchrecomp-extractor')).getDirectoryHandle('test-cancel'); } catch { remains = false; }
      return { ...result, remains, reachedRomFS: !!cancelPromise, beforeCancel, progress };
    });
    assert.equal(canceled.code, 'CANCELED');
    assert.equal(canceled.reachedRomFS, true);
    assert.equal(canceled.remains, false);
    assert.ok(canceled.beforeCancel.cleanupMs < 6000, 'Cancellation root cleanup remains bounded');
    if (expectedFullWorkers > 1) {
      assert.equal(canceled.beforeCancel.progressWorkers, expectedFullWorkers);
      assert.ok(canceled.beforeCancel.entries.includes('.extract-pool-owner'), 'Cancel while the nonce-owned pool marker exists');
      assert.ok(canceled.beforeCancel.workers.length >= expectedFullWorkers + 1, 'Observe the parent and nested workers before cancel');
    }
    let remainingWorkers;
    const deadline = Date.now() + 5000;
    do {
      remainingWorkers = await liveWorkers();
      if (!remainingWorkers.length) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    assert.deepEqual(remainingWorkers, [], 'Parent and nested workers all terminate after cancellation');
    const preservedHashes = await outputHashes('test-exefs', exefs.result.files);
    assert.deepEqual(preservedHashes, evidence.scenarios[0].hashes, 'Cancellation preserves every original output hash');
    const { progress: cancelProgress, ...cancelResult } = canceled;
    evidence.scenarios.push({ name: 'cancel during real RomFS extraction', ...cancelResult, progress: progressSummary(cancelProgress, true, false), remainingWorkers, originalHashesPreserved: true });
  }

  if (!iconOnly && process.env.EXTRACTOR_FULL === '1') {
    const full = await page.evaluate(() => run({ mode: 'full', jobId: 'test-full' }));
    assert.ok(full.result.bytesWritten > 4e9);
    assert.equal(full.result.cryptoKnownAnswers, true);
    assert.ok(full.result.io.maxReadBytes <= 1048576);
    const markerRemains = await page.evaluate(async () => {
      const directory = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('switchrecomp-extractor')).getDirectoryHandle('test-full');
      try { await directory.getFileHandle('.extract-pool-owner'); return true; }
      catch (error) { if (error.name === 'NotFoundError') return false; throw error; }
    });
    assert.equal(markerRemains, false, 'Successful full extraction removes the owned pool marker');
    evidence.scenarios.push({ name: 'complete ExeFS and RomFS', ...full.result, elapsedMs: full.elapsedMs, progress: progressSummary(full.progress, true), markerRemains, hashes: await outputHashes('test-full', full.result.files) });
  }
  if (reference) {
    assert.ok(reference.outcome === 'GREEN' || reference.checkpoint === 'EXEFS_VERIFIED', 'Reference has verified extraction output');
    evidence.comparisons = [];
    for (const scenario of evidence.scenarios.filter(s => s.hashes)) {
      const baseline = reference.scenarios.find(s => s.name === scenario.name);
      assert.deepEqual(scenario.hashes, baseline?.hashes, scenario.name + ': every output path, size and SHA-256 matches baseline');
      evidence.comparisons.push({ name: scenario.name, files: scenario.hashes.length, baselineMs: baseline.elapsedMs, candidateMs: scenario.elapsedMs, speedup: baseline.elapsedMs / scenario.elapsedMs });
    }
  }
  assert.deepEqual(networkViolations, []);
  assert.ok(evidence.requests.every(r => r.method === 'GET' && (r.path === '/' || r.path.startsWith('/_framework/') || /^\/(extractor-client|extractor-worker|extractor|browser-io|romfs-pool)\.js$/.test(r.path))));
  assert.ok(workerRequests.some(r => r.path.includes('dotnet.native') && r.path.endsWith('.wasm')), 'Observe actual worker WASM network requests');
  evidence.workerRequests = workerRequests;
  evidence.networkViolations = networkViolations;
  const nativeJs = evidence.requests.find(r => /\/_framework\/dotnet\.native\.[\w]+\.js$/.test(r.path));
  assert.ok(nativeJs, 'The actual native runtime configuration was requested');
  const nativeSource = await readFile(resolve(bundle, '.' + nativeJs.path), 'utf8');
  const aotSetting = nativeSource.match(/\brunAOTCompilation\s*:\s*(true|false)\b/);
  assert.ok(aotSetting, 'The requested native runtime declares its AOT configuration');
  evidence.runAOTCompilation = aotSetting[1] === 'true';
  if (process.env.EXTRACTOR_EXPECT_AOT !== undefined)
    assert.equal(evidence.runAOTCompilation, process.env.EXTRACTOR_EXPECT_AOT === '1', 'Actual served runtime AOT configuration');
  evidence.outcome = 'GREEN';
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  evidence.outcome = 'RED';
  evidence.error = error.message;
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.close();
  await writeFile(resolve(runDirectory, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  await rm(profile, { recursive: true, force: true });
}

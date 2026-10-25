import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const work = path.join(repo, 'tmp/odyssey/browser-shaders');
const jobsPath = process.env.SHADER_JOBS ?? path.join(work, 'fixtures/jobs.json');
const nativeDir = process.env.SHADER_NATIVE_OUTPUT ?? path.join(work, 'native-output');
const jobs = JSON.parse(await readFile(jobsPath, 'utf8'));
assert(jobs.length > 0, 'Supply real extracted shader jobs, never synthetic shader stubs.');
const entries = await Promise.all(jobs.map(async job => ({ job, code: Array.from(await readFile(job.code)) })));
const withCross = process.env.SHADER_TEST_CROSS === '1';
const requests = [];
const staticRequests = [];
const server = createServer(async (request, response) => {
  try {
    staticRequests.push({ method: request.method, path: new URL(request.url, 'http://localhost').pathname });
    assert.equal(request.method, 'GET', 'Only static GET requests are allowed.');
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><meta charset="utf-8"><title>Isolated shader WASM proof</title>');
      return;
    }
    let base, relative;
    if (url.pathname.startsWith('/maxwell/')) { base = path.join(work, 'publish/wwwroot'); relative = url.pathname.slice(9); }
    else if (withCross && url.pathname.startsWith('/cross/')) { base = path.join(work, 'cross'); relative = url.pathname.slice(7); }
    else throw new Error('Asset route is not allowed.');
    const resolved = path.resolve(base, relative);
    assert(resolved.startsWith(base + path.sep));
    const bytes = await readFile(resolved);
    const ext = path.extname(resolved);
    response.setHeader('Content-Type', ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' })[ext] ?? 'application/octet-stream');
    response.end(bytes);
  } catch (error) { response.statusCode = 404; response.end('Static asset unavailable'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
let browser;
const consoleMessages = [];
try {
  browser = await puppeteer.launch({
    executablePath: process.env.HEADLESS_SHELL ?? path.join(process.env.HOME, '.cache/going-up-browsers/chrome-headless-shell/ext/chrome-headless-shell-mac-arm64/chrome-headless-shell'),
    headless: true,
    userDataDir: path.join(work, 'isolated-browser-profile'),
    args: ['--no-sandbox', '--disable-gpu', '--disable-background-networking'],
  });
  const page = await browser.newPage();
  page.on('console', message => consoleMessages.push(message.type() + ': ' + message.text()));
  page.on('pageerror', error => consoleMessages.push('pageerror: ' + error.message));
  page.on('request', request => {
    requests.push({ method: request.method(), url: request.url(), hasBody: request.postData() != null });
  });
  await page.goto(origin, { waitUntil: 'load' });
  const started = performance.now();
  await page.evaluate(async withCross => {
    const { createShaderTranslator } = await import('/maxwell/shader-translator.mjs');
    globalThis.translator = await createShaderTranslator();
    if (withCross) {
      const { createMslTranslator } = await import('/cross/translator.mjs');
      globalThis.cross = await createMslTranslator();
    }
    globalThis.shaderWorker = new Worker('/maxwell/shader-worker.mjs', { type: 'module' });
    let sequence = 0;
    globalThis.callShaderWorker = request => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => reject(new Error('Shader worker timed out at ' + request.type)), 20000);
      const listener = ({ data }) => {
        if (data.id !== id) return;
        clearTimeout(timeout);
        globalThis.shaderWorker.removeEventListener('message', listener);
        if (data.type === 'error') reject(new Error(data.error)); else resolve(data);
      };
      globalThis.shaderWorker.addEventListener('message', listener);
      globalThis.shaderWorker.addEventListener('error', event => reject(new Error(event.message)), { once: true });
      globalThis.shaderWorker.postMessage({ ...request, id });
    });
    await globalThis.callShaderWorker({ type: 'init', mslTranslatorUrl: withCross ? new URL('/cross/translator.mjs', location.href).href : undefined });
  }, withCross);
  const startupMs = performance.now() - started;
  // Conversion must succeed after network access is disabled.
  await page.setOfflineMode(true);
  const assetRequestCount = staticRequests.length;
  const browserResult = await page.evaluate(async entries => {
    const input = entries.map(entry => ({ job: entry.job, code: Uint8Array.from(entry.code) }));
    const start = performance.now();
    const outputs = globalThis.translator.translateBatch(input);
    const translateMs = performance.now() - start;
    const result = outputs.map(output => ({ ...output, spirv: Array.from(output.spirv), readerSpirv: output.readerSpirv ? Array.from(output.readerSpirv) : null, msl: globalThis.cross?.translate(output.spirv) }));
    let badKey = false;
    try { globalThis.translator.translateBatch([{ job: { ...input[0].job, key: '../escape' }, code: input[0].code }]); }
    catch { badKey = true; }
    if (!badKey) throw new Error('Unsafe job key was accepted.');
    let missingOutput = false;
    try { globalThis.translator.api.ReadFile('/out/' + input[0].job.key + '.spv'); } catch { missingOutput = true; }
    if (!missingOutput) throw new Error('Batch left shader outputs in memory filesystem.');
    let missingInput = false;
    try { globalThis.translator.api.Translate(JSON.stringify([{ ...input[0].job, code: '/in/0.bin' }])); } catch { missingInput = true; }
    if (!missingInput) throw new Error('Batch left shader inputs in memory filesystem.');
    const repeated = globalThis.translator.translateBatch([input[0]]);
    if (repeated[0].spirv.length !== outputs[0].spirv.length) throw new Error('Repeated batch failed.');
    const workerResult = await globalThis.callShaderWorker({ type: 'translate-batch', entries: input });
    const workerOutputs = workerResult.outputs.map(output => ({ ...output, spirv: Array.from(output.spirv), readerSpirv: output.readerSpirv ? Array.from(output.readerSpirv) : null }));
    if (JSON.stringify(workerOutputs) !== JSON.stringify(result)) throw new Error('Worker and main-thread outputs differ.');
    let invalidSpirvRejected = null;
    if (globalThis.cross) {
      try { globalThis.cross.translate(new Uint8Array(4)); invalidSpirvRejected = false; }
      catch { invalidSpirvRejected = true; }
      if (!invalidSpirvRejected) throw new Error('Invalid SPIR-V was accepted.');
    }
    globalThis.shaderWorker.terminate();
    return { result, translateMs, checks: { unsafeKeyRejected: badKey, outputCleaned: missingOutput, inputCleaned: missingInput, repeatedBatch: true, exactWorkerOutput: true, invalidSpirvRejected } };
  }, entries);
  assert.equal(staticRequests.length, assetRequestCount, 'Conversion attempted a new network request.');
  const proof = { startupMs, translateMs: browserResult.translateMs, offlineTranslation: true, checks: browserResult.checks, samples: [], requests, staticRequests, conversionNetworkRequests: staticRequests.length - assetRequestCount };
  await mkdir(path.join(work, 'browser-output'), { recursive: true });
  for (const output of browserResult.result) {
    const binary = Buffer.from(output.spirv);
    const expected = await readFile(path.join(nativeDir, output.key + '.spv'));
    assert.deepEqual(binary, expected, output.key + ' SPIR-V differs from native translator');
    assert.deepEqual(output.resources, JSON.parse(await readFile(path.join(nativeDir, output.key + '.res.json'), 'utf8')), output.key + ' resource reflection differs');
    await writeFile(path.join(work, 'browser-output', output.key + '.spv'), binary);
    if (output.msl) {
      await writeFile(path.join(work, 'browser-output', output.key + '.metal'), output.msl);
      assert.equal(output.msl, await readFile(path.join(nativeDir, output.key + '.pinned.metal'), 'utf8'), output.key + ' MSL differs from pinned native SPIRV-Cross');
    }
    proof.samples.push({ key: output.key, bytes: binary.length, sha256: createHash('sha256').update(binary).digest('hex'), exactNativeSpirv: true, exactNativeResources: true, exactPinnedNativeMsl: !!output.msl, mslBytes: output.msl?.length ?? null });
  }
  assert(requests.every(request => request.method === 'GET' && !request.hasBody && request.url.startsWith(origin + '/')), 'Unexpected network request.');
  proof.consoleMessages = consoleMessages;
  await writeFile(path.join(work, withCross ? 'browser-proof-cross.json' : 'browser-proof.json'), JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify(proof, null, 2));
} catch (error) {
  console.error(consoleMessages.join('\n'));
  throw error;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}

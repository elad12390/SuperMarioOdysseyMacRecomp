import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const work = path.join(repo, 'tmp/odyssey/browser-shaders');
const [baselineArg, candidateArg, outputArg, roundsArg = '7'] = process.argv.slice(2);
assert(baselineArg && candidateArg && outputArg, 'Supply baseline wwwroot, candidate wwwroot, and private report path.');
const roots = { baseline: path.resolve(baselineArg), candidate: path.resolve(candidateArg) };
const outputPath = path.resolve(outputArg), rounds = Number(roundsArg);
assert(outputPath.startsWith(work + path.sep), 'Benchmark evidence must stay private under tmp/odyssey/browser-shaders.');
assert(Number.isSafeInteger(rounds) && rounds >= 3 && rounds <= 30, 'Use 3..30 timed rounds of the actual shader samples.');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const groups = [];
for (const [name, fixtures, native] of [
  ['vpc', 'fixtures', 'native-output'], ['geometry', 'geometry-fixtures', 'geometry-native'],
  ['depth', 'depth-alias-fixtures', 'depth-alias-native'],
]) {
  const jobs = JSON.parse(await readFile(path.join(work, fixtures, 'jobs.json'), 'utf8'));
  assert(jobs.length, 'Real extracted jobs are required.');
  const entries = [], expected = [];
  for (const job of jobs) {
    const code = await readFile(job.code);
    entries.push({ job, code: Array.from(code) });
    expected.push({
      key: job.key, inputSha256: hash(code),
      spirv: await readFile(path.join(work, native, job.key + '.spv')),
      resources: JSON.parse(await readFile(path.join(work, native, job.key + '.res.json'), 'utf8')),
      readerSpirv: job.geometry_topology == null ? null : await readFile(path.join(work, native, job.key + '.reader.spv')),
    });
  }
  groups.push({ name, entries, expected });
}

const requests = [];
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.method, 'GET');
    const pathname = new URL(request.url, 'http://localhost').pathname;
    requests.push(pathname);
    if (pathname === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><title>Isolated real Maxwell comparison</title>');
      return;
    }
    const mode = Object.keys(roots).find(name => pathname.startsWith(`/${name}/`));
    assert(mode, 'Static tool route required.');
    const filename = path.resolve(roots[mode], pathname.slice(mode.length + 2));
    assert(filename.startsWith(roots[mode] + path.sep));
    response.setHeader('Content-Type', ({ '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' })[path.extname(filename)] ?? 'application/octet-stream');
    response.end(await readFile(filename));
  } catch {
    response.statusCode = 404;
    response.end('Static tool unavailable');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(path.join(work, 'maxwell-benchmark-profile-'));
let browser;
const proof = { rounds, roots, cases: groups.map(group => ({ name: group.name, shaders: group.entries.length })), results: {} };
try {
  browser = await puppeteer.launch({
    executablePath: path.join(process.env.HOME, '.cache/going-up-browsers/chrome-headless-shell/ext/chrome-headless-shell-mac-arm64/chrome-headless-shell'),
    headless: true, userDataDir: profile, protocolTimeout: 600000,
    args: ['--no-sandbox', '--disable-gpu', '--disable-background-networking'],
  });
  for (const mode of Object.keys(roots)) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    const startupMs = await page.evaluate(async mode => {
      const source = `
        let translator;
        onmessage = async ({ data }) => {
          try {
            if (data.url) {
              const start = performance.now();
              const { createShaderTranslator } = await import(data.url);
              translator = await createShaderTranslator();
              postMessage({ id: data.id, startupMs: performance.now() - start });
            } else {
              const inputs = data.entries.map(entry => ({ job: entry.job, code: Uint8Array.from(entry.code) }));
              const start = performance.now();
              // Match the higher pipeline's per-job call and filesystem reset.
              const outputs = [];
              for (const input of inputs) outputs.push(...translator.translateBatch([input]));
              const translateMs = performance.now() - start;
              postMessage({ id: data.id, translateMs, outputs });
            }
          } catch (error) { postMessage({ id: data.id, error: String(error.stack || error) }); }
        };
      `;
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      globalThis.benchWorker = new Worker(url, { type: 'module' });
      URL.revokeObjectURL(url);
      let next = 0;
      globalThis.benchCall = message => new Promise((resolve, reject) => {
        const id = ++next;
        const listener = ({ data }) => {
          if (data.id !== id) return;
          cleanup();
          if (data.error) reject(new Error(data.error)); else resolve(data);
        };
        const crash = event => { cleanup(); reject(new Error(event.message || 'Benchmark worker failed')); };
        const cleanup = () => {
          clearTimeout(timeout);
          benchWorker.removeEventListener('message', listener);
          benchWorker.removeEventListener('error', crash);
        };
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error('Real shader benchmark timed out'));
        }, 120000);
        benchWorker.addEventListener('message', listener);
        benchWorker.addEventListener('error', crash);
        benchWorker.postMessage({ ...message, id });
      });
      return (await benchCall({ url: new URL(`/${mode}/shader-translator.mjs`, location.href).href })).startupMs;
    }, mode);
    const loaded = requests.length;
    await page.setOfflineMode(true);
    const result = { startupMs, groups: {} };
    for (const group of groups) {
      const timings = [];
      let samples;
      for (let round = 0; round <= rounds; round++) {
        const translated = await page.evaluate(async entries => {
          const result = await benchCall({ entries });
          return { translateMs: result.translateMs, outputs: result.outputs.map(output => ({
            ...output, spirv: Array.from(output.spirv), readerSpirv: output.readerSpirv ? Array.from(output.readerSpirv) : null,
          })) };
        }, group.entries);
        assert.equal(translated.outputs.length, group.expected.length);
        samples = translated.outputs.map((output, index) => {
          const expected = group.expected[index];
          assert.equal(output.key, expected.key);
          assert.deepEqual(Buffer.from(output.spirv), expected.spirv, `${mode} ${output.key}: native SPIR-V differs`);
          assert.deepEqual(output.resources, expected.resources, `${mode} ${output.key}: native resources differ`);
          assert.deepEqual(output.readerSpirv ? Buffer.from(output.readerSpirv) : null, expected.readerSpirv, `${mode} ${output.key}: native reader differs`);
          return { key: output.key, inputSha256: expected.inputSha256, spirvSha256: hash(Buffer.from(output.spirv)), resourcesSha256: hash(JSON.stringify(output.resources)), readerSha256: output.readerSpirv ? hash(Buffer.from(output.readerSpirv)) : null };
        });
        timings.push(translated.translateMs);
      }
      const warm = timings.slice(1).sort((a, b) => a - b);
      result.groups[group.name] = { firstMs: timings[0], warmMedianMs: warm[Math.floor(warm.length / 2)], timingsMs: timings, samples, exactNative: true };
    }
    assert.equal(requests.length, loaded, 'Translation attempted network access.');
    assert.deepEqual(errors, []);
    result.offline = true;
    proof.results[mode] = result;
    await page.close();
  }
  proof.comparison = {};
  for (const { name } of groups) {
    const baseline = proof.results.baseline.groups[name], candidate = proof.results.candidate.groups[name];
    assert.deepEqual(candidate.samples, baseline.samples, `${name}: interpreter/AOT bytes differ`);
    proof.comparison[name] = { exactBaseline: true, warmSpeedup: baseline.warmMedianMs / candidate.warmMedianMs };
  }
  proof.staticRequests = requests;
  await writeFile(outputPath, JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify({ cases: proof.cases, comparison: proof.comparison, outputPath }, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}

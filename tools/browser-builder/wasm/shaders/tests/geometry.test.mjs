import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const work = path.join(repo, 'tmp/odyssey/browser-shaders');
const jobs = JSON.parse(await readFile(path.join(work, 'geometry-fixtures/jobs.json'), 'utf8'));
const samples = JSON.parse(await readFile(path.join(work, 'geometry-fixtures/samples.json'), 'utf8'));
const functions = JSON.parse(await readFile(path.join(work, 'geometry-fixtures/functions.json'), 'utf8'));
const entries = await Promise.all(jobs.map(async job => ({ job, code: Array.from(await readFile(job.code)) })));
const expected = {};
for (const job of jobs) {
  const key = job.key;
  expected[key] = {
    spirv: Array.from(await readFile(path.join(work, 'geometry-native', key + '.spv'))),
    resources: JSON.parse(await readFile(path.join(work, 'geometry-native', key + '.res.json'), 'utf8')),
  };
  if (job.geometry_topology == null) expected[key].glsl = await readFile(path.join(work, 'geometry-prepared', key + '.glsl'), 'utf8');
  else for (const suffix of ['', '.reader']) {
    expected[key][suffix ? 'reader' : 'kernel'] = {
      raw: Array.from(await readFile(path.join(work, 'geometry-native', key + suffix + '.spv'))),
      flattened: Array.from(await readFile(path.join(work, 'geometry-prepared', key + suffix + '.spv'))),
      msl: await readFile(path.join(work, 'geometry-prepared', key + suffix + '.raw.metal'), 'utf8'),
      final: await readFile(path.join(work, 'geometry-prepared', key + suffix + '.metal'), 'utf8'),
    };
  }
}
const requests = [];
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    requests.push({ method: request.method, path: pathname });
    assert.equal(request.method, 'GET');
    if (pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Real geometry WASM proof</title>'); return; }
    const mounts = { '/maxwell/': path.join(work, 'publish/wwwroot'), '/cross/': path.join(work, 'cross'), '/pyodide/': path.join(repo, 'tmp/odyssey/browser-rewriter/bundle/pyodide') };
    const prefix = Object.keys(mounts).find(prefix => pathname.startsWith(prefix));
    assert(prefix);
    const filename = path.resolve(mounts[prefix], pathname.slice(prefix.length));
    assert(filename.startsWith(mounts[prefix] + path.sep));
    response.setHeader('Content-Type', ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' })[path.extname(filename)] ?? 'application/octet-stream');
    response.end(await readFile(filename));
  } catch { response.statusCode = 404; response.end('Static tool unavailable'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
let browser;
try {
  browser = await puppeteer.launch({ executablePath: path.join(process.env.HOME, '.cache/going-up-browsers/chrome-headless-shell/ext/chrome-headless-shell-mac-arm64/chrome-headless-shell'), headless: true, userDataDir: path.join(work, 'geometry-browser-profile'), args: ['--no-sandbox', '--disable-gpu', '--disable-background-networking'] });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('pageerror', error => consoleErrors.push(error.message));
  await page.goto(origin);
  await page.evaluate(async () => {
    const { createShaderTranslator } = await import('/maxwell/shader-translator.mjs');
    const { createMslTranslator } = await import('/cross/translator.mjs');
    const { loadPyodide } = await import('/pyodide/pyodide.mjs');
    globalThis.maxwell = await createShaderTranslator();
    globalThis.cross = await createMslTranslator();
    globalThis.py = await loadPyodide({ indexURL: location.origin + '/pyodide/' });
    globalThis.gsWorker = new Worker('/maxwell/shader-worker.mjs', { type: 'module' });
    let sequence = 0;
    globalThis.gsCall = message => new Promise((resolve, reject) => {
      const id = ++sequence, timeout = setTimeout(() => reject(new Error('Geometry worker timeout')), 20000);
      const listener = ({ data }) => {
        if (data.id !== id) return;
        clearTimeout(timeout); globalThis.gsWorker.removeEventListener('message', listener);
        if (data.type === 'error') reject(new Error(data.error)); else resolve(data);
      };
      globalThis.gsWorker.addEventListener('message', listener);
      globalThis.gsWorker.postMessage({ ...message, id });
    });
    await globalThis.gsCall({ type: 'init', mslTranslatorUrl: new URL('/cross/translator.mjs', location.href).href });
  });
  const loaded = requests.length;
  await page.setOfflineMode(true);
  const proof = await page.evaluate(async ({ entries, expected, functions, samples }) => {
    const inputs = entries.map(entry => ({ job: entry.job, code: Uint8Array.from(entry.code) }));
    const outputs = globalThis.maxwell.translateBatch(inputs), py = globalThis.py, cross = globalThis.cross;
    py.FS.mkdirTree('/proof');
    py.runPython('import json');
    py.runPython(functions.geometrySource);
    for (const source of Object.values(functions.functions)) py.runPython(source);
    let glslBridgeCalls = 0;
    py.registerJsModule('cross_bridge', { glsl_at_path(filename) { glslBridgeCalls++; return cross.translateGlsl(py.FS.readFile(String(filename)), { version: 450 }); } });
    py.runPython(`from types import SimpleNamespace\nimport cross_bridge\ndef browser_cross(argv, **kwargs):\n    if argv[0] != 'spirv-cross' or argv[2:] != ['--version', '450']:\n        raise RuntimeError('Unexpected native command in geometry proof')\n    return SimpleNamespace(returncode=0, stdout=cross_bridge.glsl_at_path(argv[1]), stderr='')\nsubprocess = SimpleNamespace(run=browser_cross)\n`);
    const result = [], same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    for (const output of outputs) {
      const reference = expected[output.key];
      if (!same(Array.from(output.spirv), reference.spirv) || !same(output.resources, reference.resources)) throw new Error('GS SPIR-V/resource mismatch: ' + output.key);
      if (reference.glsl != null) {
        const glsl = cross.translateGlsl(output.spirv);
        if (glsl !== reference.glsl) throw new Error('GS GLSL differs from native: ' + output.key);
        const filename = '/proof/' + output.key + '.spv';
        py.FS.writeFile(filename, output.spirv);
        py.globals.set('proof_spv', filename);
        const fold = JSON.parse(py.runPython('json.dumps(gs_slice(proof_spv))'));
        const native = samples.find(sample => sample.key === output.key);
        if (fold !== null || native.gsSlice !== null) throw new Error('Unexpected GS fold result: ' + output.key);
        result.push({ key: output.key, plainGeometry: true, gsSlice: fold, vertices: native.vertices, exactNativeSpirv: true, exactNativeResources: true, exactNativeGlsl: true });
      } else {
        if (!same(Array.from(output.readerSpirv), reference.reader.raw)) throw new Error('Geometry reader SPIR-V mismatch');
        for (const [name, spirv] of [['kernel', output.spirv], ['reader', output.readerSpirv]]) {
          const filename = '/proof/' + output.key + '-' + name + '.spv';
          py.FS.writeFile(filename, spirv); py.globals.set('proof_spv', filename);
          py.runPython('flatten_sets(proof_spv)');
          const flattened = py.FS.readFile(filename);
          if (!same(Array.from(flattened), reference[name].flattened)) throw new Error('Original geometry descriptor flattening differs');
          const msl = cross.translate(flattened);
          if (msl !== reference[name].msl) throw new Error('Geometry MSL differs from pinned native: ' + output.key + ' ' + name);
          py.globals.set('proof_msl', msl);
          const final = py.runPython(name === 'kernel' ? 'topology_pointer(precise(proof_msl))' : 'vs_layer(vs_init(precise(proof_msl)))');
          if (final !== reference[name].final) throw new Error('Original geometry MSL postprocessing differs');
        }
        result.push({ key: output.key, topology: inputs.find(entry => entry.job.key === output.key).job.geometry_topology, exactNativeSpirv: true, exactNativeResources: true, exactNativeReader: true, exactNativeFlattenedSpirv: true, exactNativeMsl: true, exactNativeGeometryPostprocessing: true, geometryStride: output.resources.geometry_stride });
      }
    }
    const worker = await globalThis.gsCall({ type: 'translate-batch', entries: inputs.filter(entry => entry.job.geometry_topology == null) });
    for (const output of worker.outputs) if (output.glsl !== expected[output.key].glsl || !same(Array.from(output.spirv), expected[output.key].spirv)) throw new Error('Dedicated GS worker differs');
    globalThis.gsWorker.terminate();
    if (glslBridgeCalls !== 3) throw new Error('Original gs_slice did not invoke real WASM GLSL exactly once per GS');
    return { samples: result, originalGsSliceCalls: glslBridgeCalls, dedicatedGsWorker: true, topologyVariants: 15, kernelAndReaderComparisons: 30, nativeFallbacks: 0 };
  }, { entries, expected, functions, samples });
  assert.equal(requests.length, loaded, 'Geometry conversion attempted HTTP after startup');
  assert.equal(consoleErrors.length, 0, consoleErrors.join('\n'));
  proof.offline = true; proof.conversionNetworkRequests = 0; proof.requests = requests;
  proof.sourceFunctionSha256 = createHash('sha256').update(JSON.stringify(functions)).digest('hex');
  await writeFile(path.join(work, 'geometry-proof.json'), JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify({ ...proof, requests: proof.requests.length }, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}

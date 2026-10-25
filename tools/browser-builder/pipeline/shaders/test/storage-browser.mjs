import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from '../../../wasm/shaders/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const work = path.join(root, 'tmp/odyssey/graphics-optimization/storage-' + Date.now());
const profile = path.join(work, 'browser-profile');
await mkdir(work, { recursive: true });
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.method, 'GET');
    const name = new URL(req.url, 'http://localhost').pathname;
    if (name === '/') { res.end('<!doctype html><title>Owned storage test</title>'); return; }
    const base = name.startsWith('/pyodide/')
      ? path.join(root, 'tmp/odyssey/browser-rewriter/bundle')
      : path.join(root, 'tools/browser-builder/pipeline/shaders');
    const target = path.resolve(base, '.' + name);
    assert(target.startsWith(base + path.sep));
    const bytes = await readFile(target);
    res.setHeader('Content-Type', target.endsWith('.wasm') ? 'application/wasm' : /\.m?js$/.test(target) ? 'text/javascript' : 'application/octet-stream');
    res.end(bytes);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await puppeteer.launch({
    executablePath: path.join(process.env.HOME, '.cache/going-up-browsers/chrome-headless-shell/ext/chrome-headless-shell-mac-arm64/chrome-headless-shell'),
    headless: true, userDataDir: profile, protocolTimeout: 120000,
    args: ['--no-sandbox', '--disable-gpu', '--disable-background-networking'],
  });
  await writeFile(path.join(work, 'owner.json'), JSON.stringify({ pid: browser.process().pid, profile }));
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:' + server.address().port);
  const result = await page.evaluate(async () => {
    const source = `
      import { loadPyodide } from '/pyodide/pyodide.mjs';
      import { mountScratch, mountFiles } from '/file-fs.mjs';
      onmessage = async () => {
        let scratch;
        try {
          const py = await loadPyodide({ indexURL: '/pyodide/' });
          const directory = await navigator.storage.getDirectory();
          const actual = await (await directory.getFileHandle('scratch.bin', {create:true})).createSyncAccessHandle();
          const calls = {read:0,write:0};
          const access = {
            read(...args) { calls.read++; return actual.read(...args); },
            write(...args) { calls.write++; return actual.write(...args); },
            getSize: () => actual.getSize(), truncate: n => actual.truncate(n),
            flush: () => actual.flush(), close: () => actual.close(),
          };
          scratch = mountScratch(py, '/job', access, { cacheBytes: 2*1024*1024, pageBytes: 256*1024 });
          const started = performance.now();
          py.runPython(\`import os, hashlib\nfrom pathlib import Path\np=Path('/job/data')\nchunk=bytes(range(256))*32\nwith p.open('wb') as f:\n    for i in range(512): f.write(chunk)\nassert p.read_bytes()==chunk*512\nwith p.open('r+b') as f:\n    f.truncate(4101)\n    f.seek(8200); f.write(b'END')\nexpected=chunk[:4101]+bytes(8200-4101)+b'END'\nassert p.read_bytes()==expected\np.unlink()\nq=Path('/job/reused')\nwith q.open('wb') as f:\n    f.seek(9000); f.write(b'NEW')\nassert q.read_bytes()==bytes(9000)+b'NEW'\nf=q.open('rb')\nq.rename('/job/renamed')\nos.unlink('/job/renamed')\nassert f.read()==bytes(9000)+b'NEW'\nf.close()\n\`);
          const elapsedMs = performance.now()-started;
          const bytes = scratch.bytes();
          scratch.close(); scratch=null;
          postMessage({calls,bytes,elapsedMs,correct:true});
        } catch (e) { postMessage({error:e.stack||String(e)}); }
        finally { scratch?.close(); }
      };
    `;
    const workerSource = source.replaceAll("from '/", "from '" + location.origin + '/').replace("indexURL: '/pyodide/'", "indexURL: '" + location.origin + "/pyodide/'");
    const url = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
    const worker = new Worker(url, { type: 'module' });
    try {
      return await new Promise((resolve, reject) => {
        worker.onerror = e => reject(new Error(e.message));
        worker.onmessage = ({data}) => data.error ? reject(new Error(data.error)) : resolve(data);
        worker.postMessage({});
      });
    } finally { worker.terminate(); URL.revokeObjectURL(url); }
  });
  await writeFile(path.join(work, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({work,...result}));
  assert.equal(result.correct, true);
  assert(result.calls.write <= 40, 'Small Python writes must be combined into bounded page writes');
  assert(result.calls.read <= 40, 'Repeated Python reads must use bounded cached pages');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(profile, {recursive:true,force:true});
}

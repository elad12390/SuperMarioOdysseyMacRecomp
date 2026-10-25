// Explicit browser proof CLI; synthetic files only, never discovered by bun test.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const run = resolve(repo, 'tmp/odyssey/browser-job-storage', `run-${process.pid}`);
await mkdir(run, { recursive: true });
const evidence = { run, scenarios: [], syntheticFileBytes: 1024 * 1024 };
let browser, server;
try {
  const result = await Bun.build({ entrypoints: [resolve(repo, 'tools/browser-builder/web/job-storage.ts')], target: 'browser', outdir: run, naming: 'job-storage.js' });
  assert.equal(result.success, true, result.logs.map(String).join('\n'));
  const module = await readFile(resolve(run, 'job-storage.js'));
  const html = `<!doctype html><script type="module">
    import {acquireBuildJob} from '/job-storage.js';
    globalThis.acquireBuildJob=acquireBuildJob;
    globalThis.jobs=async()=> (await navigator.storage.getDirectory()).getDirectoryHandle('switchrecomp',{create:true});
    globalThis.put=async(id,name='payload.bin',size=1048576)=>{const dir=await(await jobs()).getDirectoryHandle(id,{create:true});const file=await dir.getFileHandle(name,{create:true});const out=await file.createWritable();await out.write(new Uint8Array(size).fill(81));await out.close();};
    globalThis.names=async()=>{const out=[];for await(const [name,entry]of(await jobs()).entries())out.push({name,kind:entry.kind});return out;};
    globalThis.held=async id=>(await navigator.locks.query()).held.some(lock=>lock.name.endsWith(id));
  </script>`;
  const accessWorker = `let handle;onmessage=async({data})=>{try{if(data.type==='open'){const root=await navigator.storage.getDirectory();const jobs=await root.getDirectoryHandle('switchrecomp');const job=await jobs.getDirectoryHandle(data.id);handle=await(await job.getFileHandle('payload.bin')).createSyncAccessHandle();postMessage('opened');}else{handle?.close();postMessage('closed');close();}}catch(error){postMessage({error:error.name,message:error.message});}};`;
  server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end(html); }
    else if (req.url === '/job-storage.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(module); }
    else if (req.url === '/access-worker.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(accessWorker); }
    else res.writeHead(404).end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const executablePath = process.env.JOB_STORAGE_CHROME || resolve(homedir(), '.cache/going-up-browsers/chrome-headless-shell/ext/chrome-headless-shell-mac-arm64/chrome-headless-shell');
  browser = await puppeteer.launch({ executablePath, headless: true, userDataDir: resolve(run, 'profile'), args: ['--no-sandbox', '--disable-dev-shm-usage'], protocolTimeout: 15000 });
  evidence.browserPid = browser.process().pid;
  await writeFile(resolve(run, 'browser-endpoint.txt'), browser.wsEndpoint() + '\n');
  console.log(JSON.stringify({ run, browserPid: evidence.browserPid }));
  const page = async () => { const p = await browser.newPage(); await p.goto(origin); await p.waitForFunction(() => typeof acquireBuildJob === 'function'); return p; };
  const acquire = p => p.evaluate(async () => { globalThis.lease = await acquireBuildJob(); await put(lease.id); return lease.id; });
  const listed = async p => (await p.evaluate(() => names())).map(item => item.name);
  const a = await page(), b = await page(), completed = await page();
  const aId = await acquire(a), bId = await acquire(b), completedId = await acquire(completed);
  for (const id of [aId, bId, completedId]) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok((await listed(b)).includes(aId), 'B must preserve active A');
  await completed.evaluate(async () => { const dir = await(await jobs()).getDirectoryHandle(lease.id); globalThis.downloadUrl = URL.createObjectURL(await(await dir.getFileHandle('payload.bin')).getFile()); });
  await a.evaluate(() => lease.remove());
  const afterRemove = await listed(b);
  assert.ok(!afterRemove.includes(aId)); assert.ok(afterRemove.includes(bId)); assert.ok(afterRemove.includes(completedId));
  assert.equal(await b.evaluate(id => held(id), aId), false);
  evidence.scenarios.push({ name: 'active and completed leases survive other acquisitions; remove deletes only its own job', passed: true });

  const staleA = await acquire(a);
  await b.evaluate(async () => {
    await put('unrelated-not-a-uuid', 'notes.txt', 10);
    globalThis.uuidFile = crypto.randomUUID();
    const file = await(await jobs()).getFileHandle(uuidFile, {create:true}); const out = await file.createWritable(); await out.write('keep'); await out.close();
  });
  const uuidFile = await b.evaluate(() => uuidFile);
  await a.close(); // Native Web Locks releases the lease; OPFS remains on disk.
  const c = await page(), cId = await acquire(c);
  const afterClose = await listed(c);
  assert.ok(!afterClose.includes(staleA), 'A closed without cleanup must be reclaimed');
  for (const id of [bId, completedId, cId, 'unrelated-not-a-uuid', uuidFile]) assert.ok(afterClose.includes(id));
  assert.equal(await completed.evaluate(() => held(lease.id)), true);
  evidence.scenarios.push({ name: 'page-close stale UUID reclaimed; live B, completed download, non-UUID directory and UUID file preserved', passed: true });

  await b.evaluate(async () => {
    globalThis.access = new Worker('/access-worker.js');
    await new Promise((resolve,reject) => { access.onmessage = e => e.data === 'opened' ? resolve() : reject(new Error(JSON.stringify(e.data))); access.onerror = reject; access.postMessage({type:'open',id:lease.id}); });
  });
  const failure = await b.evaluate(async () => { try { await lease.remove(); return {failed:false}; } catch(error) { return {failed:true,errorName:error.name,cause:error.cause?.name,held:await held(lease.id)}; } });
  assert.equal(failure.failed, true, 'A real open sync access handle must block deletion');
  assert.equal(failure.held, true, 'Failed removal must retain the lease');
  const d = await page(), dId = await acquire(d);
  assert.ok((await listed(d)).includes(bId), 'A fresh acquisition must not reap the failed-removal job');
  await b.evaluate(async () => { await new Promise((resolve,reject) => { access.onmessage = e => e.data === 'closed' ? resolve() : reject(new Error(JSON.stringify(e.data))); access.postMessage({type:'close'}); }); await Promise.all([lease.remove(),lease.remove()]); });
  assert.ok(!(await listed(d)).includes(bId));
  assert.equal(await d.evaluate(id => held(id), bId), false);
  evidence.scenarios.push({ name: 'real OPFS removal failure retains lock; handle close and concurrent retry remove successfully', ...failure, passed: true });

  await c.evaluate(async id => { await(await jobs()).removeEntry(id,{recursive:true}); }, dId);
  await d.evaluate(() => lease.remove()); // Real NotFound is a successful cleanup.
  assert.equal(await c.evaluate(id => held(id), dId), false);
  await c.evaluate(async id => { await put(id,'replacement.txt',10); }, dId);
  await d.evaluate(() => lease.remove()); // A removed lease cannot delete a reused name.
  assert.ok((await listed(c)).includes(dId));
  evidence.scenarios.push({ name: 'NotFound releases lease; repeated remove cannot delete a replacement directory', passed: true });

  const e = await page(), f = await page();
  const [eId,fId] = await Promise.all([acquire(e),acquire(f)]);
  const afterRace = await listed(f);
  assert.ok(!afterRace.includes(dId));
  for(const id of [completedId,cId,eId,fId]) assert.ok(afterRace.includes(id));
  evidence.scenarios.push({ name: 'concurrent stale sweeps and new acquisitions preserve all live jobs', passed: true });

  const unsupported = await c.evaluate(async origin => {
    const token = crypto.randomUUID();
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => reject(new Error('Sandbox support check timed out')),5000);
      const iframe = document.createElement('iframe'); iframe.sandbox='allow-scripts';
      const listener = event => { if(event.data?.token!==token)return; clearTimeout(timer); window.removeEventListener('message',listener); iframe.remove(); resolve(event.data); };
      window.addEventListener('message',listener);
      iframe.srcdoc = '<script type="module">import {acquireBuildJob} from '+JSON.stringify(origin+'/job-storage.js')+';try{await acquireBuildJob();parent.postMessage({token:'+JSON.stringify(token)+',unexpected:true},"*");}catch(error){parent.postMessage({token:'+JSON.stringify(token)+',message:error.message},"*");}</script>';
      document.body.append(iframe);
    });
  },origin);
  assert.equal(unsupported.unexpected, undefined); assert.match(unsupported.message, /Chrome.*Edge|Edge.*Chrome/);
  evidence.scenarios.push({ name: 'real opaque sandbox rejects unavailable storage/locks with browser guidance', passed: true, message: unsupported.message });
  await Promise.all([c,e,f,completed].map(p=>p.evaluate(()=>lease.remove())));
  evidence.outcome='GREEN';
  console.log(JSON.stringify(evidence,null,2));
} catch(error) {
  evidence.outcome='RED'; evidence.error=error.message; console.error(error); process.exitCode=1;
} finally {
  await browser?.close();
  if(server)await new Promise(r=>server.close(r));
  await writeFile(resolve(run,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');
}

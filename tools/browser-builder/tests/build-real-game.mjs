import puppeteer from 'puppeteer-core';
import { observeBrowserNetwork } from './observe-network.mjs';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

const args = process.argv.slice(2);
const option = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
const root = resolve(import.meta.dirname, '../../..'), site = resolve(root, 'tools/browser-builder/dist');
const nsp = option('--nsp'), keys = option('--keys'), titleKeys = option('--title-keys');
const maxMinutes=Number(option('--max-minutes')??10);
if(!Number.isSafeInteger(maxMinutes)||maxMinutes<1||maxMinutes>90)throw new Error('Build deadline must be 1..90 minutes.');
if (!nsp || !keys) throw new Error('Usage: bun tests/build-real-game.mjs --nsp PATH --keys PATH [--title-keys PATH]');
// Fail before launching or selecting private inputs unless the complete static
// release has been assembled. This never treats a site shell as a working build.
const catalog = JSON.parse(await readFile(resolve(site, 'build-manifest.json'), 'utf8'));
if (catalog.format !== 1) throw new Error('Assemble a complete browser release first.');
const artifacts = resolve(root, 'tmp/odyssey/browser-release/end-to-end', new Date().toISOString().replaceAll(':', '-'));
await mkdir(artifacts, { recursive: true });
console.log('BROWSER_BUILD_ARTIFACTS='+artifacts);
const profile = resolve(artifacts, 'browser-profile');
const requests = [], progress = [], failures = [], consoleErrors = [];
const quotaGiB = option('--test-quota-gib');
if (quotaGiB !== undefined && (!/^\d+$/.test(quotaGiB) || +quotaGiB < 13 || +quotaGiB > 32)) throw new Error('Test quota must be 13–32 GiB; reserve enough real free disk space first.');
let storageBefore, storageAfter, cdpQuota;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const url = new URL(request.url);
  requests.push({ method: request.method, path: url.pathname, queryLength: url.search.length, contentLength: request.headers.get('content-length') });
  if (!['GET', 'HEAD'].includes(request.method) || url.search) return new Response('No upload endpoint', { status: 405 });
  let path;
  try { path = resolve(site, url.pathname === '/' ? 'index.html' : `.${decodeURIComponent(url.pathname)}`); }
  catch { return new Response('Bad path', { status: 400 }); }
  if (!path.startsWith(site + sep)) return new Response('Not found', { status: 404 });
  const file = Bun.file(path);
  if (!await file.exists()) return new Response('Not found', { status: 404 });
  return new Response(request.method === 'HEAD' ? null : file, { headers: { 'Content-Type': file.type, 'Cache-Control': 'no-store' } });
}});
const started = Date.now(); let browser, page, network, outcome, readyElapsedMs;
try {
  browser = await puppeteer.launch({
    executablePath: resolve(process.env.HOME, '.cache/going-up-browsers/chrome-headless-shell/ext/chrome-headless-shell-mac-arm64/chrome-headless-shell'),
    userDataDir: profile, headless: true, protocolTimeout: (maxMinutes+5) * 60 * 1000,
    args: ['--no-first-run', '--disable-background-networking'],
  });
  network = await observeBrowserNetwork(browser, new URL(server.url).origin);
  page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  const downloads = await browser.target().createCDPSession();
  await downloads.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: artifacts, eventsEnabled: true });
  const downloadComplete = new Promise((resolveDownload, reject) => {
    downloads.on('Browser.downloadProgress', event => {
      if (event.state === 'completed') resolveDownload(event);
      if (event.state === 'canceled') reject(new Error('The browser cancelled the DMG download.'));
    });
  });
  void downloadComplete.catch(() => {});
  page.on('pageerror', error => consoleErrors.push(error.message));
  page.on('requestfailed', request => failures.push({ url: request.url(), error: request.failure()?.errorText }));
  await page.exposeFunction('recordBuildProgress', event => {
    progress.push({ elapsedMs: Date.now() - started, ...event });
    console.log(`BUILD_PROGRESS=${JSON.stringify(progress.at(-1))}`);
  });
  await network.ready();
  await page.goto(String(server.url), { waitUntil: 'networkidle0' });
  storageBefore = await page.evaluate(() => navigator.storage.estimate());
  if (quotaGiB) {
    const storageSession = await page.createCDPSession();
    await storageSession.send('Storage.overrideQuotaForOrigin', { origin: new URL(server.url).origin, quotaSize: +quotaGiB * 1024 ** 3 });
    cdpQuota = await storageSession.send('Storage.getUsageAndQuota', { origin: new URL(server.url).origin });
    console.log('ACTUAL_CDP_QUOTA='+JSON.stringify(cdpQuota));
  }
  storageAfter = await page.evaluate(() => navigator.storage.estimate());
  await page.evaluate(() => {
    let previous = '';
    const capture = () => {
      const text = document.querySelector('#status').textContent;
      const stage = document.querySelector('#stages .active')?.getAttribute('data-stage') ?? null;
      const signature = stage + ':' + text;
      if (signature !== previous) { previous = signature; void window.recordBuildProgress({ stage, message: text }); }
    };
    new MutationObserver(capture).observe(document.querySelector('#status'), { childList: true, subtree: true, characterData: true });
  });
  await (await page.$('#files')).uploadFile(...[nsp, keys, titleKeys].filter(Boolean).map(path => resolve(path)));
  await page.waitForFunction(() => !document.querySelector('#build').disabled);
  await page.screenshot({ path: resolve(artifacts, 'selected-inputs.png'), fullPage: true });
  console.log('BROWSER_STORAGE='+JSON.stringify(await page.evaluate(() => navigator.storage.estimate())));
  await page.click('#build');
  await page.waitForFunction(() => !document.querySelector('#download').hidden || document.querySelector('#status').classList.contains('error'), { timeout: maxMinutes * 60 * 1000, polling: 250 });
  readyElapsedMs=Date.now()-started;
  const result = await page.evaluate(() => ({ status: document.querySelector('#status').textContent, failed: document.querySelector('#status').classList.contains('error'), ready: !document.querySelector('#download').hidden, stages: [...document.querySelectorAll('#stages li')].map(item => ({ stage: item.dataset.stage, state: item.className })) }));
  if (result.failed || !result.ready) throw new Error(result.status);
  await page.screenshot({ path: resolve(artifacts, 'completed.png'), fullPage: true });
  await page.click('#download');
  let downloadTimer;
  try { await Promise.race([downloadComplete, new Promise((_, reject) => { downloadTimer = setTimeout(() => reject(new Error('DMG download did not complete within five minutes.')), 5 * 60 * 1000); })]); }
  finally { clearTimeout(downloadTimer); }
  const dmg = resolve(artifacts, 'Super Mario Odyssey.dmg'), info = await stat(dmg);
  if (info.size < 1024 ** 3) throw new Error('The supposed game DMG is unexpectedly small.');
  const hash = createHash('sha256'); for await (const chunk of createReadStream(dmg)) hash.update(chunk);
  if (requests.some(request => !['GET', 'HEAD'].includes(request.method) || request.queryLength || request.contentLength && request.contentLength !== '0')) throw new Error('A private-upload or unexpected request was observed.');
  if (network.unexpected().length || network.errors.length) throw new Error('Unexpected browser/worker network traffic or incomplete observation; inspect metadata evidence.');
  outcome = { passed: true, elapsedMs: Date.now() - started, readyElapsedMs, deadlineMinutes:maxMinutes, dmg, bytes: info.size, sha256: hash.digest('hex'), result };
  console.log(`BROWSER_GAME_DMG=${dmg}`);
} catch (error) {
  outcome = { passed: false, elapsedMs: Date.now() - started, readyElapsedMs, deadlineMinutes:maxMinutes, error: String(error) };
  if (page) await page.screenshot({ path: resolve(artifacts, 'failed.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser?.close(); server.stop(true);
  await writeFile(resolve(artifacts, 'result.json'), JSON.stringify({ ...outcome, requests, browserNetwork: network?.requests, browserNetworkErrors: network?.errors, progress, failures, consoleErrors, storage: { before: storageBefore, after: storageAfter, testQuotaOverrideGiB: quotaGiB ? +quotaGiB : null, cdpQuota }, boundary: 'Real browser file selection through downloaded DMG. Mount, signature and native gameplay are separate required checks.' }, null, 2) + '\n');
  // Keep images and compact failure evidence, not another multi-gigabyte OPFS
  // copy. Browser.close() above releases this exact owned profile first.
  await rm(profile, { recursive: true, force: true });
  console.log(`BROWSER_BUILD_EVIDENCE=${artifacts}`);
}

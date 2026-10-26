/** Dedicated test browser; static fixture server has no upload/packaging endpoint. */
import puppeteer from 'puppeteer-core';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../../..'), work = resolve(root, 'tmp/odyssey/dmg-layout/browser', new Date().toISOString().replaceAll(':', '-')), profile = resolve(work, 'profile');
const fixture = resolve(root, 'tools/browser-builder/dist/runtime/files/Super Mario Odyssey.app');
const iconOption = process.argv.indexOf('--icon'), icon = iconOption < 0 ? undefined : process.argv[iconOption + 1];
const infoPlist = await readFile(resolve(fixture, 'Contents/Info.plist'), 'utf8');
const customizedInfo = icon ? infoPlist.includes('<key>CFBundleIconFile</key>') ? infoPlist : infoPlist.replace('</dict>', '<key>CFBundleIconFile</key><string>Game.icns</string></dict>') : undefined;
await mkdir(work, { recursive: true });
console.log('INSTALLER_ARTIFACTS=' + work);
const files: { path: string; size: number; mode: number; url: string }[] = [];
async function walk(relative = '') {
  for (const entry of await readdir(resolve(fixture, relative), { withFileTypes: true })) {
    const name = relative ? relative + '/' + entry.name : entry.name;
    if (entry.isDirectory()) await walk(name);
    else { const info = await stat(resolve(fixture, name)); files.push({ path: 'Super Mario Odyssey.app/' + name, size: name === 'Contents/Info.plist' && customizedInfo ? Buffer.byteLength(customizedInfo) : info.size, mode: info.mode & 0o777, url: '/fixture/' + name }); }
  }
}
await walk();
if (icon) files.push({ path: 'Super Mario Odyssey.app/Contents/Resources/Game.icns', size: (await stat(icon)).size, mode: 0o644, url: '/fixture-icon' });
const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, 'worker.ts')], target: 'browser', format: 'esm' });
if (!build.success) throw Error(build.logs.join('\n'));
const worker = await build.outputs[0].text();
const requests: string[] = [], errors: string[] = [];
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
  const url = new URL(req.url); requests.push(req.method + ' ' + url.pathname);
  if (req.method !== 'GET' || url.search) return new Response('Read only', { status: 405 });
  if (url.pathname === '/worker.js') return new Response(worker, { headers: { 'Content-Type': 'text/javascript' } });
  if (url.pathname === '/files.json') return Response.json(files);
  if (url.pathname === '/fixture-icon' && icon) return new Response(Bun.file(icon));
  if (url.pathname === '/fixture/Contents/Info.plist' && customizedInfo) return new Response(customizedInfo);
  if (url.pathname.startsWith('/fixture/')) { const file = resolve(fixture, decodeURIComponent(url.pathname.slice(9))); if (file.startsWith(fixture + '/')) return new Response(Bun.file(file)); }
  if (url.pathname === '/') return new Response(`<!doctype html><title>Installer acceptance</title><script>
    window.result=null; const w=new Worker('/worker.js',{type:'module'});
    w.onmessage=async({data})=>{if(data.error){window.result=data;return;}const a=document.createElement('a');a.href=URL.createObjectURL(data.file);a.download='installer.dmg';a.click();const r=new FileReader();r.onload=()=>{window.result={stats:data.stats,alias:[...data.alias],preview:r.result}};r.readAsDataURL(data.preview)};w.onerror=e=>window.result={error:e.message};w.postMessage({});
  </script>`, { headers: { 'Content-Type': 'text/html' } });
  return new Response('Not found', { status: 404 });
} });
let browser;
try {
  browser = await puppeteer.launch({ executablePath: resolve(process.env.HOME!, '.cache/going-up-browsers/chrome-headless-shell/ext/chrome-headless-shell-mac-arm64/chrome-headless-shell'), headless: true, userDataDir: profile, protocolTimeout: 120000, args: ['--no-first-run', '--disable-background-networking', '--disable-extensions'] });
  await writeFile(resolve(work, 'owner.json'), JSON.stringify({ pid: browser.process()?.pid, endpoint: browser.wsEndpoint(), profile, owned: true }));
  await (await browser.target().createCDPSession()).send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: work });
  const page = await browser.newPage(); page.on('pageerror', error => errors.push(String(error)));
  await page.goto(server.url.href); await page.waitForFunction('window.result !== null', { timeout: 60000 });
  const result = await page.evaluate('window.result') as { error?: string; stats: { imageBytes: number }; alias: number[]; preview: string };
  if (result.error) throw Error(result.error);
  const image = resolve(work, 'installer.dmg'), deadline = Date.now() + 60000;
  while ((await stat(image).catch(() => undefined))?.size !== result.stats.imageBytes) { if (Date.now() > deadline) throw Error('Installer download incomplete.'); await Bun.sleep(100); }
  await writeFile(resolve(work, 'background.alias'), new Uint8Array(result.alias));
  await writeFile(resolve(work, 'background-preview.png'), Buffer.from(result.preview.split(',')[1], 'base64'));
  if (errors.length) throw Error(errors.join('\n'));
  await writeFile(resolve(work, 'result.json'), JSON.stringify({ passed: true, image, ...result.stats, requests, errors, version: await browser.version() }, null, 2));
  console.log('INSTALLER_BROWSER_PASS=' + image);
} finally { await browser?.close(); server.stop(true); await rm(profile, { recursive: true, force: true }); }

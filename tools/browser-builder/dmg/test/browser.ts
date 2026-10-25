/** Test-only static server + isolated browser. Never used by the product writer. */
import puppeteer from "puppeteer-core";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const repo = resolve(import.meta.dir, "../../../.."), scratch = resolve(repo, "tmp/odyssey/browser-dmg");
const large = process.argv.includes("--large"), name = large ? "browser-large.dmg" : "browser-small.dmg";
const downloads = resolve(scratch, "downloads"); await mkdir(downloads, { recursive: true });
const profile = resolve(scratch, large ? "profile-large" : "profile-small");
await rm(profile, { recursive: true, force: true });
await rm(resolve(downloads, name), { force: true });
await rm(resolve(downloads, name + ".crdownload"), { force: true });
const built = await Bun.build({ entrypoints: [resolve(import.meta.dir, "worker.ts")], target: "browser", format: "esm" });
if (!built.success) throw Error(built.logs.join("\n"));
const worker = await built.outputs[0].text();
await writeFile(resolve(scratch, "worker.js"), worker);
const requests: string[] = [];
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
  const url = new URL(req.url); requests.push(`${req.method} ${url.pathname}`);
  if (req.method !== "GET") return new Response("Read only", { status: 405 });
  if (url.pathname === "/worker.js") return new Response(worker, { headers: { "Content-Type": "text/javascript" } });
  if (url.pathname.startsWith("/fixture/") && !url.pathname.includes("..")) {
    const path = resolve(scratch, "fixture/BrowserFixture.app/Contents", url.pathname.slice(9));
    return new Response(Bun.file(path));
  }
  if (url.pathname === "/") return new Response(`<!doctype html><title>Isolated browser DMG acceptance</title><p id="status">Writing disk image in a dedicated worker.</p><script>
    window.testResult = null;
    const worker = new Worker('/worker.js', {type:'module'});
    worker.onmessage = e => {
      if (e.data.done) {
        const link=document.createElement('a'); link.download=${JSON.stringify(name)};
        link.href=URL.createObjectURL(e.data.file); link.textContent='Download verified image'; document.body.append(link); link.click();
        window.testResult=e.data.stats; document.querySelector('#status').textContent='Complete';
      } else if (e.data.error) window.testResult=e.data;
      else { document.querySelector('#status').textContent=String(e.data.progress); console.log('worker-progress', e.data.progress); }
    };
    worker.onerror = e => window.testResult={error:e.message};
    worker.postMessage({large:${large}});
  </script>`, { headers: { "Content-Type": "text/html" } });
  return new Response("Not found", { status: 404 });
} });
const executablePath = process.env.BROWSER_DMG_HEADLESS_SHELL ?? resolve(process.env.HOME!, ".cache/going-up-browsers/chrome-headless-shell/ext/chrome-headless-shell-mac-arm64/chrome-headless-shell");
const browser = await puppeteer.launch({ executablePath, headless: true, userDataDir: profile,
  args: ["--no-first-run", "--disable-background-networking", "--disable-component-update", "--disable-extensions", "--disable-default-apps", "--disk-cache-size=1048576", "--enable-precise-memory-info"] });
let sampler: ReturnType<typeof setInterval> | undefined;
const heapSamples: { usedSize: number; totalSize: number; backingStorageSize?: number; embedderHeapUsedSize?: number }[] = [];
try {
  const browserCdp = await browser.target().createCDPSession();
  await browserCdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads, eventsEnabled: true });
  const page = await browser.newPage();
  page.on("workercreated", async w => {
    const target = browser.targets().find(t => t.url() === w.url());
    if (!target) return;
    const session = await target.createCDPSession();
    const sample = async () => { try { heapSamples.push(await session.send("Runtime.getHeapUsage")); } catch {} };
    await sample(); sampler = setInterval(() => { void sample(); }, 500);
  });
  page.on("console", msg => console.log(msg.text()));
  const consoleErrors: string[] = [], blockedRequests: string[] = [];
  page.on("pageerror", e => consoleErrors.push(String(e)));
  await page.setRequestInterception(true);
  page.on("request", req => {
    if (req.url().startsWith(server.url.origin) || req.url().startsWith("blob:")) void req.continue();
    else { blockedRequests.push(req.url()); void req.abort(); }
  });
  console.log(JSON.stringify({ phase: "browser-start", executablePath, version: await browser.version(), pid: browser.process()?.pid, large, origin: server.url.origin }));
  await page.goto(server.url.href);
  await page.waitForFunction("window.testResult !== null", { timeout: large ? 600000 : 60000, polling: 1000 });
  const result = await page.evaluate("window.testResult") as Record<string, unknown>;
  if (result.error) throw Error(JSON.stringify(result));
  const imagePath = resolve(downloads, name), deadline = Date.now() + 120000;
  while (true) {
    const info = await stat(imagePath).catch(() => null);
    if (info?.size === result.imageBytes) break;
    if (Date.now() > deadline) throw Error("Browser download incomplete");
    await Bun.sleep(250);
  }
  if (consoleErrors.length || blockedRequests.length) throw Error(JSON.stringify({ consoleErrors, blockedRequests }));
  const evidence = { ...result, browserVersion: await browser.version(), executablePath, imagePath, consoleErrors, blockedRequests, requests,
    workerHeap: { samples: heapSamples.length, peakUsedBytes: Math.max(0, ...heapSamples.map(s => s.usedSize)), peakBackingStorageBytes: Math.max(0, ...heapSamples.map(s => s.backingStorageSize ?? 0)) } };
  await writeFile(resolve(scratch, large ? "browser-large.json" : "browser-small.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence));
} finally { if (sampler) clearInterval(sampler); await browser.close(); server.stop(true); }

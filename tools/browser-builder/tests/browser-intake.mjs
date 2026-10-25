import puppeteer from 'puppeteer-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const artifacts = resolve(root, 'tmp/odyssey/browser-release/site-check', new Date().toISOString().replaceAll(':', '-'));
await mkdir(artifacts, { recursive: true });
const invalid = resolve(artifacts, 'incomplete.nsp');
const invalidKeys = resolve(artifacts, 'prod.keys');
await writeFile(invalid, 'An incomplete package');
await writeFile(invalidKeys, 'invalid key file');
const browser = await puppeteer.launch({
  executablePath: resolve(process.env.HOME, '.cache/going-up-browsers/chrome-headless-shell/ext/chrome-headless-shell-mac-arm64/chrome-headless-shell'),
  headless: true,
  args: ['--no-first-run', '--disable-background-networking'],
});
const page = await browser.newPage();
const errors = [], privateRequests = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => { if (request.method() !== 'GET') privateRequests.push({ method: request.method(), url: request.url() }); });
try {
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 });
  await page.goto('http://127.0.0.1:4381/', { waitUntil: 'networkidle0' });
  if (!await page.$eval('#build', el => el.disabled)) throw new Error('Build must require both inputs.');
  await (await page.$('#files')).uploadFile(invalid, invalidKeys);
  await page.waitForFunction(() => document.querySelector('#build').disabled === false);
  await page.click('#build');
  await page.waitForFunction(() => document.querySelector('#status').classList.contains('error'));
  const text = await page.$eval('#status', el => el.textContent);
  if (!/PFS0|key file/i.test(text)) throw new Error(`Expected an actionable input error, got ${text}`);
  if (!await page.$eval('#download', el => el.hidden)) throw new Error('Invalid input offered a ready download.');
  if (errors.length || privateRequests.length) throw new Error(JSON.stringify({ errors, privateRequests }));
  await page.reload({ waitUntil: 'networkidle0' });
  await page.screenshot({ path: resolve(artifacts, 'desktop.png'), fullPage: true });
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await page.screenshot({ path: resolve(artifacts, 'mobile.png'), fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  if (overflow) throw new Error('The mobile builder overflows horizontally.');
  await writeFile(resolve(artifacts, 'result.json'), JSON.stringify({ passed: true, validated: 'real isolated browser intake only; conversion and DMG gameplay not yet covered', errors, privateRequests }, null, 2));
  console.log('PASS: real browser selection, invalid-input rejection, no private upload, desktop/mobile layout.');
  console.log(`Artifacts: ${artifacts}`);
} finally { await browser.close(); }

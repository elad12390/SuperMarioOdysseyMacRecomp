import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyActualFiles } from './compare-native.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const work = path.join(root, 'tmp/odyssey/browser-shader-chain');

test('mounted-file verification reads real fetch bytes and rejects same-size tampering', async () => {
  const proof = JSON.parse(await readFile(path.join(work, 'single-shader-proof.json'), 'utf8'));
  const directory = await mkdtemp(path.join(work, 'actual-file-check-'));
  try {
    const files = [];
    for (const name of ['0020759d9400a726_bf.metal', '0044cbe6fa23c643_bf.metal']) {
      const source = proof.files.find(file => file.name === name);
      const metadata = proof.exported.find(file => file.path === name);
      expect(source).toBeDefined();
      expect(metadata).toBeDefined();
      const relative = 'shader/cache/b-' + proof.result.chain + '/' + name;
      await mkdir(path.dirname(path.join(directory, relative)), { recursive: true });
      await writeFile(path.join(directory, relative), source.text);
      files.push({ ...metadata, path: relative });
    }
    expect(await verifyActualFiles(files, directory)).toEqual({ requested: true, checked: 2, failures: [] });
    const original = await readFile(path.join(directory, files[0].path));
    const altered = Buffer.from(original); altered[0] ^= 1;
    await writeFile(path.join(directory, files[0].path), altered);
    const corrupt = await verifyActualFiles(files, directory);
    expect(corrupt.checked).toBe(1);
    expect(corrupt.failures).toHaveLength(1);
    expect(corrupt.failures[0].file).toBe(files[0].path);
    await rm(path.join(directory, files[1].path));
    const missing = await verifyActualFiles(files, directory);
    expect(missing.failures).toHaveLength(2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the actual legacy full proof fails for the complete currently required fetch set', async () => {
  // Produced by compare-native.mjs --proof full-library-proof.json; no conversion rerun.
  const report = JSON.parse(await readFile(path.join(work, 'legacy-classification-current-checker.json'), 'utf8'));
  const required = JSON.parse(await readFile(path.join(work, 'current-required-variants.json'), 'utf8'));
  expect(report.passed).toBe(false);
  expect(report.actualFileChecks.requested).toBe(false);
  expect(report.names.expected).toBe(39185);
  expect(report.required.fetch).toBe(10645);
  expect(report.required.shadow).toBe(1312);
  expect(report.names.missing).toEqual(required.requiredFetchFiles);
  expect(report.names.extra).toEqual([]);
  expect(report.msl.aliasDepth).toHaveLength(536);
  expect(report.reflection.aliasDepth).toHaveLength(536);
  expect(report.msl.mismatches).toEqual([]);
  expect(report.reflection.mismatches).toEqual([]);
});

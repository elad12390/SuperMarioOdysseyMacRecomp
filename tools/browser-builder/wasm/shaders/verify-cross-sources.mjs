import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const { spirvCross } = JSON.parse(await readFile(new URL('./sources.json', import.meta.url), 'utf8'));
const directory = path.resolve(process.argv[2] ?? new URL('../../../../tmp/odyssey/browser-shaders/SPIRV-Cross', import.meta.url).pathname);
const expected = { ...spirvCross.sourceFilesSha256, ...spirvCross.licenseFilesSha256 };
assert(Object.keys(expected).length > 1, 'Missing pinned Cross source hashes.');
for (const [name, digest] of Object.entries(expected)) {
  assert(!name.includes('\\') && name.split('/').every(part => part && part !== '.' && part !== '..'), 'Unsafe Cross source path.');
  const actual = createHash('sha256').update(await readFile(path.join(directory, name))).digest('hex');
  assert.equal(actual, digest, 'Pinned SPIRV-Cross source hash changed: ' + name);
}
if (process.argv[3]) {
  const sections = [`SPIRV-Cross ${spirvCross.revision}\n${spirvCross.repository}\n`];
  for (const name of Object.keys(spirvCross.licenseFilesSha256).sort()) sections.push(`\n--- Upstream ${name} ---\n` + await readFile(path.join(directory, name), 'utf8'));
  for (const name of Object.keys(spirvCross.sourceFilesSha256).sort()) {
    const text = await readFile(path.join(directory, name), 'utf8');
    const header = text.match(/^\s*(\/\*[\s\S]*?\*\/|(?:\/\/[^\n]*\n)+)/)?.[1];
    if (header) sections.push(`\n--- Upstream ${name} notice ---\n` + header + '\n');
  }
  const license = sections.join('');
  assert.equal(createHash('sha256').update(license).digest('hex'), spirvCross.licenseBundleSha256, 'Cross license bundle changed.');
  await writeFile(process.argv[3], license);
}
console.log(`Pinned SPIRV-Cross ${spirvCross.revision}: ${Object.keys(expected).length} source/license hashes verified.`);

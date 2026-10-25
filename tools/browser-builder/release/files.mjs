import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, mkdir, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
export function safePath(name) {
  if (!name || name.includes('\\') || name.includes('\0') || name.startsWith('/') || name.split('/').some(p => !p || p === '.' || p === '..')) throw new Error(`Unsafe asset path: ${name}`);
  return name;
}
export async function readAsset(base, name) {
  safePath(name);
  const filename = path.join(base, name);
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected a regular public asset: ${name}`);
  const actual = await realpath(filename), root = await realpath(base);
  if (!actual.startsWith(root + path.sep)) throw new Error(`Asset escapes its stage: ${name}`);
  return readFile(filename);
}
export async function listFiles(base, prefix = '') {
  const files = [];
  for (const entry of (await readdir(path.join(base, prefix), { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const name = prefix + entry.name;
    safePath(name);
    if (entry.isSymbolicLink()) throw new Error(`Symlink is not a public asset: ${name}`);
    if (entry.isDirectory()) files.push(...await listFiles(base, name + '/'));
    else if (entry.isFile()) files.push(name);
    else throw new Error(`Unsupported asset type: ${name}`);
  }
  return files;
}
export async function put(base, name, bytes) {
  safePath(name);
  const filename = path.join(base, name);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, bytes, { mode: 0o644 });
}

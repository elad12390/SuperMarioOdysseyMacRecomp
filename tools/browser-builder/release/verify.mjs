import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listFiles, readAsset, sha256 } from './files.mjs';
import { auditBytes } from './audit.mjs';

export async function verifyBundle(directory) {
  const manifestBytes = await readAsset(directory, 'manifest.json');
  const manifest = JSON.parse(manifestBytes);
  if (manifest.format !== 1 || manifest.kind !== 'switchrecomp-public-browser-tools') throw new Error('Unsupported public tool manifest');
  const expected = ['manifest.json', 'SHA256SUMS', ...manifest.files.map(file => file.path)].sort();
  if (new Set(expected).size !== expected.length || JSON.stringify((await listFiles(directory)).sort()) !== JSON.stringify(expected)) throw new Error('Unexpected, missing or duplicate public bundle file');
  let bytes = 0, wasm = 0, managedAssemblies = 0, archives = 0;
  for (const file of manifest.files) {
    const data = await readAsset(directory, file.path);
    if (data.length !== file.size || sha256(data) !== file.sha256) throw new Error(`Public asset checksum mismatch: ${file.path}`);
    const kind = auditBytes(file.path, data);
    if (kind !== file.kind) throw new Error(`Public binary format mismatch: ${file.path}`);
    bytes += data.length;
    if (kind === 'WASM') wasm++;
    if (kind === 'managed PE') managedAssemblies++;
    if (/\.(?:zip|whl)$/.test(file.path)) archives++;
  }
  const sums = (await readAsset(directory, 'SHA256SUMS')).toString().trim().split('\n');
  const checksumPaths = new Set();
  for (const line of sums) {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/);
    if (!match || checksumPaths.has(match[2]) || match[2] === 'SHA256SUMS') throw new Error('Invalid public checksum row');
    checksumPaths.add(match[2]);
    if (sha256(await readAsset(directory, match[2])) !== match[1]) throw new Error(`SHA256SUMS mismatch: ${match[2]}`);
  }
  if (checksumPaths.size !== manifest.files.length + 1 || bytes !== manifest.bytes) throw new Error('Incomplete public checksum manifest');
  const dependencies = JSON.parse(await readAsset(directory, 'dependencies.json'));
  for (const component of [...dependencies.components, ...dependencies.nuget]) {
    if (!component.files.length) throw new Error('Dependency has no license files');
    for (const file of component.files) if (sha256(await readAsset(directory, file.path)) !== file.sha256) throw new Error(`License checksum mismatch: ${file.path}`);
  }
  for (const filename of Object.values(manifest.entrypoints)) await readAsset(directory, filename);
  const chain = JSON.parse(await readAsset(directory, 'shaders/CHAIN.json'));
  if (chain.chain !== manifest.shaderChain) throw new Error('Shader runtime chain reference mismatch');
  return { format: 1, files: manifest.files.length, bytes, wasm, managedAssemblies, archives, components: dependencies.components.length, resolvedNugetPackages: dependencies.nuget.length, shaderChain: manifest.shaderChain, manifestSha256: sha256(manifestBytes), nativeBinaries: 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: bun release/verify.mjs OUTPUT_DIRECTORY');
  console.log(JSON.stringify(await verifyBundle(path.resolve(process.argv[2])), null, 2));
}

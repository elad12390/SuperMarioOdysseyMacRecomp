import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function verifyPublishedShaderAssemblies(wwwroot) {
  const framework = path.join(wwwroot, '_framework');
  const files = (await readdir(framework, { withFileTypes: true })).filter(entry => entry.isFile()).map(entry => entry.name);
  const required = ['ShaderTranslator', 'Ryujinx.Graphics.Shader', 'Ryujinx.Common', 'Spv.Generator', 'System.Runtime'];
  for (const assembly of required) {
    const matches = files.filter(name => name === assembly + '.wasm' ||
      (name.startsWith(assembly + '.') && name.endsWith('.wasm') && /^[a-z0-9_-]+$/.test(name.slice(assembly.length + 1, -5))));
    if (!matches.length) throw new Error('Published shader translator is missing managed dependency: ' + assembly);
    for (const name of matches) {
      const bytes = await readFile(path.join(framework, name));
      if (bytes.length < 8 || !bytes.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109]))) throw new Error('Invalid published WebAssembly dependency: ' + name);
    }
  }
  return { requiredAssemblies: required, verified: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Supply the published shader wwwroot directory');
  console.log(JSON.stringify(await verifyPublishedShaderAssemblies(path.resolve(process.argv[2]))));
}

// Install the exact public Pyodide standard-library wheel, not a private input.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const shared = path.join(root, 'tmp/odyssey/browser-rewriter/bundle/pyodide');
const cache = path.join(root, 'tmp/odyssey/browser-shader-chain/dependencies');
const { version } = JSON.parse(await readFile(path.join(shared, 'package.json'), 'utf8'));
if (version !== '0.28.3') throw new Error('Revalidate the shader LZMA dependency before changing Pyodide');
const { packages } = JSON.parse(await readFile(path.join(shared, 'pyodide-lock.json'), 'utf8'));
await mkdir(cache, { recursive: true });
const { loadPyodide } = await import(pathToFileURL(path.join(shared, 'pyodide.mjs')).href);
const py = await loadPyodide({ indexURL: shared + '/', packageCacheDir: cache });
// Pyodide installs a URL wheel into its virtual filesystem without retaining
// its archive on the host. Retain exactly that package-loader response for the
// public static bundle, checking the distribution's own lock before writing.
const packageFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const response = await packageFetch(...args);
  if (String(args[0]).endsWith('/' + packages.lzma.file_name)) {
    const archive = new Uint8Array(await response.clone().arrayBuffer());
    if (createHash('sha256').update(archive).digest('hex') !== packages.lzma.sha256) throw new Error('LZMA archive checksum mismatch');
    await writeFile(path.join(cache, packages.lzma.file_name), archive);
  }
  return response;
};
try { await py.loadPackage(`https://cdn.jsdelivr.net/pyodide/v${version}/full/${packages.lzma.file_name}`); }
finally { globalThis.fetch = packageFetch; }
const bytes = await readFile(path.join(cache, packages.lzma.file_name));
if (createHash('sha256').update(bytes).digest('hex') !== packages.lzma.sha256) throw new Error('LZMA dependency checksum mismatch');
if (!py.runPython("import lzma; lzma.decompress(lzma.compress(b'WASM LZMA check')) == b'WASM LZMA check'")) throw new Error('Real LZMA codec did not round trip');
console.log(JSON.stringify({ file: packages.lzma.file_name, sha256: packages.lzma.sha256, realCodec: true }));

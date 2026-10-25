import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { zipEntries } from './archives.mjs';
import { safePath } from './files.mjs';

const privateName = /(^|\/)(?:prod\.keys|title\.keys|jobs?\.json|fixtures?|browser-output|native-output|test-seeds?|saves?|game-data)(\/|$)|\.(?:nsp|nca|nso|metallib|metal|dmg|dylib|exe|a)$/i;
const macho = new Set(['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']);
export function binaryKind(bytes) {
  if (bytes.length >= 4 && macho.has(bytes.subarray(0, 4).toString('hex'))) return 'Mach-O';
  if (bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return 'ELF';
  if (bytes.subarray(0, 8).toString() === '!<arch>\n') return 'native archive';
  if (bytes.subarray(0, 4).equals(Buffer.from([0, 0x61, 0x73, 0x6d]))) return 'WASM';
  if (bytes.length >= 64 && bytes[0] === 77 && bytes[1] === 90) {
    const pe = bytes.readUInt32LE(60), optional = pe + 24;
    if (optional + 2 <= bytes.length && bytes.subarray(pe, pe + 4).toString('hex') === '50450000') {
      const magic = bytes.readUInt16LE(optional), directories = optional + (magic === 0x10b ? 96 : magic === 0x20b ? 112 : 0);
      if (directories > optional && directories + 15 * 8 <= bytes.length && bytes.readUInt32LE(directories + 14 * 8) !== 0) return 'managed PE';
    }
    return 'native PE';
  }
  return 'data';
}
export function auditBytes(name, input, depth = 0) {
  safePath(name);
  if (privateName.test(name)) throw new Error(`Private or native-only asset is forbidden: ${name}`);
  if (depth > 2) throw new Error(`Nested archive limit: ${name}`);
  let bytes = input;
  if (name.endsWith('.br')) return auditBytes(name.slice(0, -3), brotliDecompressSync(bytes, { maxOutputLength: 64 * 1024 ** 2 }), depth + 1);
  if (name.endsWith('.gz')) return auditBytes(name.slice(0, -3), gunzipSync(bytes, { maxOutputLength: 64 * 1024 ** 2 }), depth + 1);
  const kind = binaryKind(bytes);
  if (['Mach-O', 'ELF', 'native PE', 'native archive'].includes(kind)) throw new Error(`${kind} binary is forbidden in browser tools: ${name}`);
  if (/\.(?:wasm|so)$/.test(name) && kind !== 'WASM') throw new Error(`Expected a real WASM binary: ${name}`);
  if (/\.dll$/.test(name) && !['WASM', 'managed PE'].includes(kind)) throw new Error(`Expected a managed assembly: ${name}`);
  if (/\.(?:whl|zip)$/.test(name)) {
    for (const entry of zipEntries(bytes)) auditBytes(name + '/' + entry.name, entry.bytes, depth + 1);
  }
  return kind;
}

export const pyodideNames = new Set(['README.md', 'console.html', 'ffi.d.ts', 'package.json', 'pyodide-lock.json', 'pyodide.asm.js', 'pyodide.asm.wasm', 'pyodide.d.ts', 'pyodide.js', 'pyodide.js.map', 'pyodide.mjs', 'pyodide.mjs.map', 'python_stdlib.zip']);
export const wheelNames = new Set(['capstone-5.0.6-py3-none-pyodide_2025_0_wasm32.whl', 'lz4-4.4.4-cp313-cp313-pyodide_2025_0_wasm32.whl']);
export function dotnetPath(name, rootFiles) {
  const raw = name.replace(/\.(?:br|gz)$/, '');
  if (rootFiles.has(raw)) return true;
  return /^_framework\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:js|mjs|wasm|dll|dat|json|pdb)$/.test(raw);
}
export function allowedRewriter(name) {
  return new Set(['index.mjs', 'worker.mjs', 'sources.json', 'dependencies.json', 'NXNATIVE-LICENSE', 'README.md', 'THIRD-PARTY-NOTICES.md', 'SHA256SUMS']).has(name)
    || wheelNames.has(name) || name.startsWith('pyodide/') && pyodideNames.has(name.slice(8))
    || /^licenses\/[A-Za-z0-9_.-]+$/.test(name);
}
export function allowedShader(name) {
  return new Set(['index.mjs', 'worker.mjs', 'file-fs.mjs', 'adapter.py', 'sources.json', 'CHAIN.json', 'toolchain.json', 'BUILD-META.json', 'NXNATIVE-LICENSE']).has(name)
    || name === 'lz4-4.4.4-cp313-cp313-pyodide_2025_0_wasm32.whl' || name === 'lzma-1.0.0-cp313-cp313-pyodide_2025_0_wasm32.whl'
    || name.startsWith('pyodide/') && pyodideNames.has(name.slice(8))
    || name.startsWith('maxwell/') && dotnetPath(name.slice(8), new Set(['shader-translator.mjs', 'shader-worker.mjs', 'nxnative.LICENSE', 'Ryujinx.LICENSE.txt']))
    || /^cross\/(?:translator\.mjs|spirv-cross\.mjs|spirv-cross\.wasm|SPIRV-Cross\.LICENSE)$/.test(name);
}

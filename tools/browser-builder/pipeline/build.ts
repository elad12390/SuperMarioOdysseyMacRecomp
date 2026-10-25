import { writeDmgToOpfs, entryFromBlob, type DmgEntry } from '../dmg';
import { sealApp } from '../signing';
import { prepareBrowserProvenance, type BrowserProvenanceInput } from './provenance';

export type Stage = 'validate' | 'extract' | 'rewrite' | 'shaders' | 'package' | 'dmg';
export type Progress = { stage: Stage; message: string; fraction?: number };
type SourceFile = { path: string; size: number; sha256?: string; storagePath?: string; storageOffset?: number };
type Template = { format: number; shaderChain: string; source: BrowserProvenanceInput['runtimeSource']; files: { path: string; url: string; size: number; sha256: string; mode: number }[] };
type Catalog = { format: number; extractor: string; rewriter: string; shaderPipeline: string; shaderOptions: Record<string, unknown>; runtime: string };

const app = 'Super Mario Odyssey.app/Contents/Resources/game/';
const directories = new WeakMap<FileSystemDirectoryHandle, Map<string, Promise<FileSystemDirectoryHandle>>>();
const packedStores = new WeakMap<FileSystemDirectoryHandle, Map<string, Promise<FileSystemSyncAccessHandle>>>();
function parts(path: string) {
  const names = path.split('/');
  if (names.some(name => !name || name === '.' || name === '..' || /[\\\0]/.test(name))) throw new Error('A converter produced an invalid output path.');
  return names;
}
async function getFile(root: FileSystemDirectoryHandle, path: string) {
  const names = parts(path); let directory = root, prefix = '';
  let cache = directories.get(root);
  if (!cache) { cache = new Map(); directories.set(root, cache); }
  for (const name of names.slice(0, -1)) {
    prefix += name + '/';
    let pending = cache.get(prefix);
    if (!pending) { pending = directory.getDirectoryHandle(name); cache.set(prefix, pending); }
    directory = await pending;
  }
  return directory.getFileHandle(names.at(-1)!);
}
function sourceEntry(root: FileSystemDirectoryHandle, file: SourceFile, prefix: string): DmgEntry {
  parts(file.path);
  if (file.storagePath !== undefined) {
    parts(file.storagePath);
    const start=file.storageOffset;
    if (typeof start!=='number' || !Number.isSafeInteger(start) || start<0 || !Number.isSafeInteger(file.size) || file.size<0 || !Number.isSafeInteger(start+file.size)) throw new Error('Invalid packed shader extent.');
    return {path:prefix+file.path,size:file.size,mode:0o644,expectedSha256:file.sha256,async open(){
      let cache=packedStores.get(root);
      if(!cache){cache=new Map();packedStores.set(root,cache);}
      let pending=cache.get(file.storagePath!);
      if(!pending){pending=getFile(root,file.storagePath!).then(handle=>handle.createSyncAccessHandle());cache.set(file.storagePath!,pending);}
      const handle=await pending;let position=0;
      if(start+file.size>handle.getSize())throw new Error('Packed shader data is incomplete.');
      return {read(buffer){const count=Math.min(buffer.length,file.size-position);if(!count)return 0;const read=handle.read(buffer.subarray(0,count),{at:start+position});if(read!==count)throw new Error('Incomplete packed shader read.');position+=read;return read;},close(){}};
    }};
  }
  let fileHandle: Promise<FileSystemFileHandle> | undefined;
  return { path: prefix + file.path, size: file.size, mode: 0o644, expectedSha256:file.sha256, async open() {
    fileHandle ??= getFile(root, file.path);
    const handle = await (await fileHandle).createSyncAccessHandle(); let offset = 0;
    return { read(buffer) { const count = handle.read(buffer, { at: offset }); offset += count; return count; }, close() { handle.close(); } };
  }};
}
async function closePackedStores(root:FileSystemDirectoryHandle){
  const cache=packedStores.get(root);packedStores.delete(root);
  if(cache)await Promise.allSettled([...cache.values()].map(async pending=>(await pending).close()));
}
function staticUrl(path: string, base: URL): URL {
  const url = new URL(path, base);
  if (url.origin !== self.location.origin || !['http:', 'https:'].includes(url.protocol)) throw new Error('Build tools must be served as static assets from this website.');
  return url;
}
async function staticJson<T>(url: URL): Promise<T> {
  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok) throw new Error('This website’s conversion tools are incomplete. No private files were uploaded.');
  return response.json();
}
async function gameIcon(root: FileSystemDirectoryHandle): Promise<Blob | undefined> {
  let handle: FileSystemFileHandle;
  try { handle = await getFile(root, 'icon.jpg'); } catch { return; }
  const bitmap = await createImageBitmap(await handle.getFile());
  try {
    const canvas = new OffscreenCanvas(256, 256); const context = canvas.getContext('2d');
    if (!context) throw new Error('The browser could not prepare the app icon.');
    context.drawImage(bitmap, 0, 0, 256, 256);
    const png = await canvas.convertToBlob({ type: 'image/png' });
    const header = new Uint8Array(16), view = new DataView(header.buffer);
    header.set(new TextEncoder().encode('icns')); view.setUint32(4, png.size + 16);
    header.set(new TextEncoder().encode('ic08'), 8); view.setUint32(12, png.size + 8);
    return new Blob([header, png], { type: 'image/icns' });
  } finally { bitmap.close(); }
}

// This function runs only in a dedicated browser worker. Files/keys are local
// File objects; fetch is used exclusively for public, same-origin tool assets.
export async function runBrowserBuild(input: { nsp: File; prodKeys: File; titleKeys?: File; job: string; signal: AbortSignal }, report: (progress: Progress) => void) {
  const { signal } = input;
  const catalogUrl = new URL('./build-manifest.json', self.location.href);
  const catalog = await staticJson<Catalog>(catalogUrl);
  if (catalog.format !== 1) throw new Error('This website’s build manifest version is unsupported.');
  const root = await navigator.storage.getDirectory();
  const jobs = await root.getDirectoryHandle('switchrecomp', { create: true });
  const job = await jobs.getDirectoryHandle(input.job, { create: true });
  for await (const _ of job.keys()) throw new Error('This job already contains output; start a new build.');
  const extracted = await job.getDirectoryHandle('extracted', { create: true });
  const patched = await job.getDirectoryHandle('patched', { create: true });
  const shaderOutput = await job.getDirectoryHandle('graphics', { create: true });
  let active: Stage = 'extract';
  const provenance = prepareBrowserProvenance(input.nsp, signal);
  const rewriteController=new AbortController();
  const abortRewrite=()=>rewriteController.abort(signal.reason);
  signal.addEventListener('abort',abortRewrite,{once:true});
  let rewriteJob:Promise<any>|undefined;
  const beginRewrite=()=>{
    if(!rewriteJob){
      rewriteJob=(async()=>{
        const rewriter=await import(/* @vite-ignore */ staticUrl(catalog.rewriter,catalogUrl).href);
        const exefs=await extracted.getDirectoryHandle('ExeFS');
        return rewriter.run({inputDirectory:exefs,outputDirectory:patched,modules:['main','subsdk0','sdk'],signal:rewriteController.signal},
          (p:{module?:string;fraction?:number})=>{if(active==='rewrite')report({stage:active,message:`Converting ARM64 code${p.module?` · ${p.module}`:''}`,fraction:p.fraction});});
      })();
      void rewriteJob.catch(()=>{});
    }
    return rewriteJob;
  };
  try {
    signal.throwIfAborted(); report({ stage: active, message: 'Loading the local WASM extractor…' });
    const extractor = await import(/* @vite-ignore */ staticUrl(catalog.extractor, catalogUrl).href);
    const extraction = await extractor.run({ nsp: input.nsp, prodKeys: input.prodKeys, titleKeys: input.titleKeys, outputDirectory: extracted, signal }, (p: { phase: string; path?:string; bytesWritten?: number }) => {
      // RomFS follows ExeFS, whose sync handles are already flushed and closed.
      // Rewriting only reads those immutable modules while extraction continues.
      if(p.phase==='extract'&&p.path?.startsWith('RomFS/'))beginRewrite();
      report({ stage: active, message: p.phase === 'load' ? 'Loading the local WASM extractor…' : `Extracting game files · ${((p.bytesWritten ?? 0) / 1024 ** 3).toFixed(2)} GB written` });
    });
    // The extractor checks decrypted title/build identifiers before writing the
    // payload. Every later stage consumes only this validated local directory.
    signal.throwIfAborted(); active = 'rewrite'; report({ stage: active, message: 'Converting your game’s ARM64 instructions in WASM…' });
    const rewritten = await beginRewrite();
    signal.throwIfAborted(); active = 'shaders'; report({ stage: active, message: 'Reading and translating your game’s shaders…' });
    const shaderPipeline = await import(/* @vite-ignore */ staticUrl(catalog.shaderPipeline, catalogUrl).href);
    const graphics = await shaderPipeline.run({ ...catalog.shaderOptions, inputDirectory: extracted, outputDirectory: shaderOutput, signal }, (p: { message?: string; fraction?: number; completed?: number; total?: number }) => report({ stage: active, message: (p.message ?? 'Translating graphics in WASM…') + (typeof p.completed === 'number' ? ` · ${p.completed.toLocaleString('en-US')}${typeof p.total === 'number' ? ` / ${p.total.toLocaleString('en-US')}` : ''}` : ''), fraction: p.fraction }));
    signal.throwIfAborted(); active = 'package'; report({ stage: active, message: 'Preparing the standalone Mac app…' });
    const runtimeUrl = staticUrl(catalog.runtime, catalogUrl);
    const template = await staticJson<Template>(runtimeUrl);
    if (template.format !== 1 || !graphics.chain || template.shaderChain !== graphics.chain) throw new Error('The runtime and browser shader tools have different versions. This website needs a matching release.');
    const entries: DmgEntry[] = [];
    for (const item of template.files) {
      signal.throwIfAborted(); parts(item.path);
      if (!item.path.startsWith('Super Mario Odyssey.app/Contents/') || item.size > 64 * 1024 ** 2) throw new Error('The public app template is invalid.');
      const response = await fetch(staticUrl(item.url, runtimeUrl), { credentials: 'omit' });
      if (!response.ok) throw new Error('The public native runtime download failed. Try again.');
      const blob = await response.blob();
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(value => value.toString(16).padStart(2, '0')).join('');
      if (blob.size !== item.size || hash !== item.sha256) throw new Error('The public runtime file failed its integrity check.');
      entries.push(entryFromBlob(item.path, blob, item.mode));
    }
    for (const file of extraction.files as SourceFile[]) {
      if (file.path.startsWith('RomFS/')) entries.push(sourceEntry(extracted, file, app + 'extract/v0/'));
    }
    for (const file of rewritten.files as { name: string; size: number }[]) entries.push(sourceEntry(patched, { path: file.name, size: file.size }, app + 'patched_v0/'));
    for (const file of graphics.files as SourceFile[]) entries.push(sourceEntry(shaderOutput, file, app));
    const icon = await gameIcon(extracted);
    if (icon) entries.push(entryFromBlob('Super Mario Odyssey.app/Contents/Resources/Game.icns', icon));
    if (!entries.some(entry => entry.path.endsWith('/main.patched.bin')) || !entries.some(entry => entry.path.endsWith('/shader_map.tsv'))) throw new Error('The converters did not produce a complete playable app.');
    entries.push(await provenance({ nsp: input.nsp, extraction, rewriter: rewritten, shaderChain: graphics.chain, runtimeSource: template.source }, p => report({ stage: active, message: `Recording local input provenance · ${(p.hashedBytes / 1024 ** 3).toFixed(2)} GB checked`, fraction: p.fraction })));
    const sealedEntries = await sealApp(entries, { appName: 'Super Mario Odyssey.app', signal, progress: p => report({ stage: active, message: `Sealing app resources · ${(p.hashedBytes / 1024 ** 3).toFixed(2)} GB checked`, fraction: p.totalBytes ? p.hashedBytes / p.totalBytes : undefined }) });
    // Volume artwork lives outside the signed app; reuse the exact locally
    // extracted HOME-menu icon without adding a public bundled game asset.
    if (icon) sealedEntries.push(entryFromBlob('.VolumeIcon.icns', icon));
    signal.throwIfAborted(); active = 'dmg'; report({ stage: active, message: 'Creating your disk image locally…' });
    const result = await writeDmgToOpfs(sealedEntries, job, 'Super Mario Odyssey.dmg', { signal, volumeName: 'Super Mario Odyssey', onProgress: p => report({ stage: active, message: `Creating disk image · ${(p.writtenBytes / 1024 ** 3).toFixed(2)} GB`, fraction: Math.min(p.writtenBytes / p.volumeBytes, 1) }) });
    await closePackedStores(shaderOutput);
    // Keep only the finished image; reclaim the multi-gigabyte intermediates.
    for (const name of ['extracted', 'patched', 'graphics']) await job.removeEntry(name, { recursive: true });
    const { file: _handle, ...image } = result;
    return { ...image, file: 'Super Mario Odyssey.dmg' };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw Object.assign(new Error(error instanceof Error ? error.message : 'The browser build failed.'), { stage: active });
  } finally {
    rewriteController.abort();signal.removeEventListener('abort',abortRewrite);
    await rewriteJob?.catch(()=>{});
    await closePackedStores(shaderOutput);
  }
}

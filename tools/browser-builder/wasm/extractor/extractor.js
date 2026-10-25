import * as io from './browser-io.js';
import { checkPartition, copyRomfs } from './romfs-pool.js';

let runtime;
let busy = false;
let cryptoKnownAnswers = false;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const messages = {
  TRUNCATED_INPUT: 'The NSP is truncated or has invalid file offsets. Select a complete base-game dump.',
  UNSUPPORTED_TITLE: 'This package is not the supported Super Mario Odyssey base game (0100000000010000).',
  UNSUPPORTED_BUILD: 'This Odyssey build is unsupported. Select the base v0 / 1.0.0 NSP.',
  INVALID_MAIN: 'The decrypted main executable is invalid. Check your dump and keys.',
  MISSING_CONTROL: 'The NSP is missing its matching control metadata. Select a complete base-game dump.',
  OUTPUT_WRITE_FAILED: 'Writing extracted files failed. Check browser storage space and retry.',
  INSUFFICIENT_STORAGE: 'There is not enough browser storage for extraction. Free space and retry.',
  CANCELED: 'Extraction was canceled.',
  INVALID_INPUT: 'Select an NSP File, prod.keys File, and an empty OPFS output directory in a dedicated worker.',
  OUTPUT_NOT_EMPTY: 'Extraction requires an empty per-job OPFS directory.',
  BUSY: 'This worker is already extracting a package.',
  EXTRACT_FAILED: 'NSP decryption or integrity verification failed. Check prod.keys, optional title.keys, and the complete base-game dump.',
};

export class ExtractionError extends Error {
  constructor(code) { super(messages[code] || messages.EXTRACT_FAILED); this.name = 'ExtractionError'; this.code = code; }
}

function sanitized(error) {
  if (error instanceof ExtractionError) return error;
  if (error?.name === 'QuotaExceededError') return new ExtractionError('INSUFFICIENT_STORAGE');
  // Never expose LibHac exceptions, supplied text, key values, or worker stacks.
  const code = Object.keys(messages).find(code => String(error?.message).includes(code));
  return new ExtractionError(code || 'EXTRACT_FAILED');
}

async function getApi(progress) {
  runtime ??= (async () => {
    // .NET 10 otherwise classifies workers with an existing onmessage handler
    // as Emscripten pthread workers and waits forever for pthread startup.
    // This is a standalone runtime in the caller's dedicated pipeline worker.
    globalThis.dotnetSidecar = true;
    progress({ phase: 'load', detail: 'import-runtime', bytesWritten: 0 });
    const { dotnet } = await import('./_framework/dotnet.js');
    progress({ phase: 'load', detail: 'start-runtime', bytesWritten: 0 });
    const instance = await dotnet.withModuleConfig({ ENVIRONMENT_IS_PTHREAD: false }).withDiagnosticTracing(false).create();
    progress({ phase: 'load', detail: 'load-exports', bytesWritten: 0 });
    instance.setModuleImports('browser-io', { readInput: io.readInput, writeOutput: io.writeOutput });
    const exports = await instance.getAssemblyExports('BrowserExtractor');
    const api = exports.SwitchRecomp.Browser.Extractor;
    cryptoKnownAnswers = api.CryptoKnownAnswers();
    if (!cryptoKnownAnswers) throw new ExtractionError('EXTRACT_FAILED');
    return api;
  })();
  return runtime;
}

function safePath(path) {
  const parts = path.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || /[\\\0]/.test(p))) throw new ExtractionError('EXTRACT_FAILED');
  return parts;
}

async function createOutput(root, path) {
  const parts = safePath(path);
  let directory = root;
  for (const name of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(name, { create: true });
  const file = await directory.getFileHandle(parts.at(-1), { create: true });
  return file.createSyncAccessHandle();
}

// Call this from the shared pipeline's dedicated worker. The only downloads are
// static .NET runtime/tool assets. Selected Files are never fetched or uploaded.
export function run(options, progress = () => {}) { return extract(options, progress); }
export function runPartition(options, partition, progress = () => {}) { return extract({ ...options, workers: 1 }, progress, partition); }

async function extract({ nsp, prodKeys, titleKeys, outputDirectory, signal, mode = 'full', workers = 4 }, progress, partition) {
  if (busy) throw new ExtractionError('BUSY');
  if (typeof FileReaderSync === 'undefined' || !(nsp instanceof File) || !(prodKeys instanceof File) ||
      !outputDirectory || !['full', 'exefs', 'probe'].includes(mode) || prodKeys.size > io.CHUNK_SIZE ||
      (titleKeys && (!(titleKeys instanceof File) || titleKeys.size > io.CHUNK_SIZE)))
    throw new ExtractionError('INVALID_INPUT');
  // Never clobber existing job data. Caller owns this fresh directory.
  if (!Number.isSafeInteger(workers) || workers < 1 || workers > 4) throw new ExtractionError('INVALID_INPUT');
  if (partition) await checkPartition(outputDirectory, partition);
  else for await (const _ of outputDirectory.keys()) throw new ExtractionError('OUTPUT_NOT_EMPTY');
  busy = true;
  let api;
  let handle;
  const createdRoots = new Set();
  const files = [];
  let bytesWritten = 0;
  let parallelIo, partitionOrder = -1, romfsIndex = 0;
  const checkCanceled = () => { if (signal?.aborted) throw new ExtractionError('CANCELED'); };
  try {
    checkCanceled();
    const estimate = await navigator.storage.estimate();
    const required = mode === 'full' ? nsp.size + (1 << 28) : mode === 'exefs' ? Math.min(nsp.size, 1 << 28) : 0;
    if (estimate.quota !== undefined && estimate.usage !== undefined && estimate.quota - estimate.usage < required)
      throw new ExtractionError('INSUFFICIENT_STORAGE');
    progress({ phase: 'load', bytesWritten: 0 });
    api = await getApi(progress);
    checkCanceled();
    io.attachInput(nsp);
    progress({ phase: 'validate', bytesWritten: 0 });
    const metadata = JSON.parse(api.Open(nsp.size, await prodKeys.text(), titleKeys ? await titleKeys.text() : '', mode === 'full'));
    checkCanceled();
    progress({ phase: 'validated', ...metadata, bytesWritten: 0 });
    if (mode !== 'probe') {
      for (let next = api.NextFile(); next; next = api.NextFile()) {
        const file = JSON.parse(next);
        partitionOrder++;
        if (partition && (!file.path.startsWith('RomFS/') || romfsIndex++ % partition.count !== partition.index)) continue;
        const parts = safePath(file.path);
        if (!Number.isSafeInteger(file.size) || file.size < 0) throw new ExtractionError('EXTRACT_FAILED');
        createdRoots.add(parts[0]);
        checkCanceled();
        const concurrency = Math.min(workers, Math.max(1, (navigator.hardwareConcurrency || 4) - 2));
        if (!partition && mode === 'full' && file.path.startsWith('RomFS/') && concurrency > 1) {
          const prefixBytes=bytesWritten;
          const copied=await copyRomfs({nsp,prodKeys,titleKeys,outputDirectory,signal,workers:concurrency,expected:metadata,firstOrder:files.length}, p=>progress({...p,bytesWritten:prefixBytes+p.bytesWritten}));
          files.push(...copied.files);bytesWritten+=copied.bytesWritten;parallelIo=copied.io;
          break;
        }
        handle = await createOutput(outputDirectory, file.path);
        io.attachOutput(handle);
        handle.truncate(file.size);
        let fileBytesWritten = 0;
        for (;;) {
          checkCanceled();
          const copied = api.CopyChunk();
          if (!copied) break;
          fileBytesWritten += copied;
          bytesWritten += copied;
          progress({ phase: 'extract', path: file.path, fileSize: file.size, fileBytesWritten, bytesWritten, filesWritten: files.length, io: io.getStats() });
          await tick();
        }
        if (fileBytesWritten !== file.size) throw new ExtractionError('OUTPUT_WRITE_FAILED');
        handle.flush(); handle.close(); handle = undefined;
        io.attachOutput(undefined);
        files.push(partition ? { ...file, _order: partitionOrder } : file);
      }
    }
    checkCanceled();
    const stats=io.getStats();
    if(parallelIo)for(const field of Object.keys(stats))stats[field]=field==='maxReadBytes'?Math.max(stats[field],parallelIo[field]):stats[field]+parallelIo[field];
    const result = { ...metadata, files, filesWritten: files.length, bytesWritten, io: stats, cryptoKnownAnswers, ...(partition?{partitionTotal:romfsIndex}:{}) };
    progress({ phase: 'complete', bytesWritten, filesWritten: files.length });
    return result;
  } catch (error) {
    handle?.close(); handle = undefined;
    if(!partition)for(const name of createdRoots)for(let attempt=0;;attempt++){
      try{await outputDirectory.removeEntry(name,{recursive:true});break;}
      catch(cleanup){if(cleanup.name==='NotFoundError')break;if(attempt===99)throw cleanup;await new Promise(resolve=>setTimeout(resolve,50));}
    }
    progress({ phase: 'error', code: sanitized(error).code, diagnostic: api?.GetLastDiagnostic(), bytesWritten });
    throw sanitized(error);
  } finally {
    try { api?.Close(); } finally { io.detach(); busy = false; }
  }
}

const MARKER = '.extract-pool-owner';
const canceled = () => Object.assign(new Error('Extraction was canceled.'), { code: 'CANCELED' });

export async function checkPartition(directory, partition) {
  if (!partition || !Number.isSafeInteger(partition.index) || !Number.isSafeInteger(partition.count) ||
      partition.count < 2 || partition.count > 4 || partition.index < 0 || partition.index >= partition.count ||
      typeof partition.token !== 'string' || !/^[a-f0-9-]{36}$/.test(partition.token)) throw new Error('INVALID_INPUT');
  const marker = await (await directory.getFileHandle(MARKER)).getFile();
  if (marker.size !== 36 || await marker.text() !== partition.token) throw new Error('OUTPUT_NOT_EMPTY');
}

export async function copyRomfs({ nsp, prodKeys, titleKeys, outputDirectory, signal, workers, expected, firstOrder }, progress) {
  if (signal?.aborted) throw canceled();
  const token = crypto.randomUUID();
  try { await outputDirectory.getFileHandle(MARKER); throw new Error('OUTPUT_NOT_EMPTY'); }
  catch (error) { if (error.name !== 'NotFoundError') throw error; }
  const marker = await (await outputDirectory.getFileHandle(MARKER, { create: true })).createWritable();
  await marker.write(token); await marker.close();
  const pool = [], pending = new Set(), written = Array(workers).fill(0);
  let failure;
  const fail = error => {
    if (failure) return;
    failure = error;
    for (const reject of pending) reject(error);
    pending.clear();
    for (const worker of pool) worker.terminate();
  };
  const abort = () => fail(canceled());
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) throw canceled();
    const results = await Promise.all(Array.from({ length: workers }, (_, index) => new Promise((resolve, reject) => {
      if (failure) { reject(failure); return; }
      pending.add(reject);
      const worker = new Worker(new URL('./extractor-worker.js', import.meta.url), { type: 'module' });
      pool.push(worker);
      worker.onerror = () => fail(Object.assign(new Error('The extraction worker failed.'), { code: 'EXTRACT_FAILED' }));
      worker.onmessage = ({ data }) => {
        if (failure) return;
        if (data.type === 'progress') {
          if (data.phase === 'extract') {
            written[index] = data.bytesWritten;
            try { progress({ ...data, bytesWritten: written.reduce((a, b) => a + b, 0), workers }); }
            catch (error) { fail(error); }
          }
        } else if (data.type === 'result') {
          pending.delete(reject); worker.terminate(); resolve(data.result);
        } else if (data.type === 'error') fail(Object.assign(new Error('The extraction worker rejected its input.'), { code: data.code || 'EXTRACT_FAILED' }));
      };
      worker.postMessage({ type: 'extract', nsp, prodKeys, titleKeys, outputDirectory, mode: 'full', partition: { index, count: workers, token } });
    })));
    const files = results.flatMap(result => result.files).sort((a, b) => a._order - b._order);
    const names = new Set();
    for (const file of files) {
      if (!file.path.startsWith('RomFS/') || names.has(file.path) || !Number.isSafeInteger(file._order)) throw new Error('EXTRACT_FAILED');
      names.add(file.path);
    }
    const first = results[0];
    if(files.length!==first.partitionTotal||files.some((file,index)=>file._order!==firstOrder+index))throw new Error('EXTRACT_FAILED');
    for (const result of results) {
      if (!result.cryptoKnownAnswers || result.partitionTotal!==files.length || ['titleId', 'version', 'mainBuildId'].some(field => result[field] !== expected[field])) throw new Error('EXTRACT_FAILED');
    }
    const io = { inputBytesRead: 0, maxReadBytes: 0, readCalls: 0, storageReadCalls: 0, outputBytesWritten: 0 };
    for (const result of results) for (const field of Object.keys(io))
      io[field] = field === 'maxReadBytes' ? Math.max(io[field], result.io[field]) : io[field] + result.io[field];
    return { files: files.map(({ _order, ...file }) => file), bytesWritten: results.reduce((sum, result) => sum + result.bytesWritten, 0), io, workers };
  } finally {
    signal?.removeEventListener('abort', abort);
    for (const worker of pool) worker.terminate();
    await outputDirectory.removeEntry(MARKER);
  }
}

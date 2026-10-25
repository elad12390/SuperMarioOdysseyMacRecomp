/** Rewrite local ExeFS NSOs with pinned Python in a disposable WASM worker. */
export async function run(options, progress = () => {}) {
  const { inputDirectory, outputDirectory, modules, signal } = options;
  if (inputDirectory?.kind !== 'directory' || outputDirectory?.kind !== 'directory') {
    throw new TypeError('inputDirectory and outputDirectory must be local FileSystemDirectoryHandles');
  }
  if (await inputDirectory.isSameEntry(outputDirectory)) throw new Error('Input and output directories must differ');
  if (!Array.isArray(modules) || modules.length !== 3 || new Set(modules).size !== 3 || !['main', 'subsdk0', 'sdk'].every(n => modules.includes(n))) {
    throw new Error('Exactly main, subsdk0 and sdk are required');
  }
  signal?.throwIfAborted();
  const owned = [...modules.flatMap(n => ['patched.bin', 'fixups.tsv', 'gates.tsv', 'sites.tsv', 'cuts.tsv', 'obs.tsv'].map(s => `${n}.${s}`)), 'build_src.sha256'];
  // Reserve ownership in the parent before worker launch so cancellation also
  // covers filesystem operations whose worker messages have not arrived yet.
  for (const name of owned) {
    try { await outputDirectory.getFileHandle(name); }
    catch (error) { if (error.name === 'NotFoundError') continue; throw error; }
    throw new Error(`Output already exists: ${name}; select an empty output directory`);
  }
  signal?.throwIfAborted();
  const bundleURL = new URL(options.bundleURL || './', import.meta.url).href;
  const worker = new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' });
  try {
    return await new Promise((resolve, reject) => {
      const abort = () => reject(new DOMException('NSO rewrite cancelled', 'AbortError'));
      signal?.addEventListener('abort', abort, { once: true });
      const finish = (callback, value) => { signal?.removeEventListener('abort', abort); callback(value); };
      worker.onerror = event => finish(reject, new Error(event.message || 'NSO worker failed'));
      worker.onmessage = ({ data }) => {
        if (data.type === 'progress') {
          try { progress(data.event); } catch (error) { finish(reject, error); }
        }
        if (data.type === 'error') finish(reject, new Error(data.message));
        if (data.type === 'result') finish(resolve, data.manifest);
      };
      worker.postMessage({ inputDirectory, outputDirectory, modules, bundleURL });
      if (signal?.aborted) abort();
    });
  } catch (error) {
    worker.terminate();
    for (const name of owned) await outputDirectory.removeEntry(name).catch(() => {});
    throw error;
  } finally { worker.terminate(); }
}

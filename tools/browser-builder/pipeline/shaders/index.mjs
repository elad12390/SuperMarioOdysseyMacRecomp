/** Convert a user's extracted Odyssey files locally in a disposable WASM worker. */
export async function run(options, progress = () => {}) {
  const { inputDirectory, inputFiles, outputDirectory, profileDirectory, signal } = options;
  if (!!inputDirectory === !!inputFiles) throw new Error('Select an extracted directory or local File entries, not both');
  for (const [name, handle] of Object.entries({ ...(inputDirectory ? { inputDirectory } : {}), outputDirectory, ...(profileDirectory ? { profileDirectory } : {}) })) {
    if (handle?.kind !== 'directory') throw new TypeError(`${name} must be a FileSystemDirectoryHandle`);
  }
  if (inputFiles && (!Array.isArray(inputFiles) || !inputFiles.length || inputFiles.some(f => !(f.file instanceof File) || typeof f.path !== 'string'))) throw new TypeError('inputFiles must contain actual local {path, file: File} entries');
  if ((inputDirectory && await inputDirectory.isSameEntry(outputDirectory)) || (profileDirectory && await profileDirectory.isSameEntry(outputDirectory))) {
    throw new Error('Shader output must be separate from the input and profile');
  }
  signal?.throwIfAborted();
  for await (const name of outputDirectory.keys()) throw new Error(`Shader output must be empty (found ${name})`);
  const worker = new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' });
  const bundleURL = new URL(options.bundleURL || './', import.meta.url).href;
  let abort;
  try {
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        callback(value);
      };
      abort = () => finish(reject, new DOMException('Shader conversion cancelled', 'AbortError'));
      signal?.addEventListener('abort', abort, { once: true });
      worker.onerror = event => finish(reject, new Error(event.message || 'Shader worker failed'));
      worker.onmessage = ({ data }) => {
        if (data.type === 'progress') {
          try { progress(data.event); } catch (error) { finish(reject, error); }
        } else if (data.type === 'error') finish(reject, new Error(data.message));
        else if (data.type === 'result') finish(resolve, data.manifest);
      };
      worker.postMessage({ inputDirectory, inputFiles, outputDirectory, profileDirectory, bundleURL });
      if (signal?.aborted) abort();
    });
  } catch (error) {
    worker.terminate();
    // These names were absent before this dedicated job. Never remove inputs.
    const cleanupFailures = [];
    // Wait for the terminated worker's sync store to close before removing its
    // exported directories. Otherwise a pending writer can race early cleanup.
    for (const name of ['.shader-work', 'shader', 'profile', 'shader-chain.json']) {
      for (let attempt = 0; attempt < 250; attempt++) {
        try { await outputDirectory.removeEntry(name, { recursive: true }); break; }
        catch (cleanupError) {
          if (cleanupError.name === 'NotFoundError') break;
          if (attempt === 249) { cleanupFailures.push(`${name}: ${cleanupError.name}`); break; }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      }
    }
    if (cleanupFailures.length) error.cleanupFailures = cleanupFailures;
    throw error;
  } finally { worker.terminate(); }
}

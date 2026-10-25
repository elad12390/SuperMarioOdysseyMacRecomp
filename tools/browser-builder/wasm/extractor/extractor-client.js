const JOB_NAME = /^[a-zA-Z0-9_-]{1,80}$/;

export function createExtractorJob({ nsp, prodKeys, titleKeys, mode = 'full', jobId = crypto.randomUUID(), onProgress = () => {} }) {
  if (!JOB_NAME.test(jobId)) throw new Error('Invalid extraction job ID.');
  const worker = new Worker(new URL('./extractor-worker.js', import.meta.url), { type: 'module' });
  let rejectJob;
  let settled = false;
  let cleanupPromise;
  let ownsDirectory = false;
  let jobs;
  const prepared = (async () => {
    const root = await navigator.storage.getDirectory();
    jobs = await root.getDirectoryHandle('switchrecomp-extractor', { create: true });
    try {
      await jobs.getDirectoryHandle(jobId);
      throw Object.assign(new Error('This extraction job directory already exists. Choose a new job ID.'), { code: 'JOB_EXISTS' });
    } catch (error) { if (error.name !== 'NotFoundError') throw error; }
    const directory = await jobs.getDirectoryHandle(jobId, { create: true });
    ownsDirectory = true;
    return directory;
  })();
  const cleanup = () => cleanupPromise ??= (async () => {
    if (!ownsDirectory) return;
    // Terminating the worker releases its sync handles. Some browsers release
    // them on the next task; bounded retries cover that filesystem handoff.
    for (let attempt = 0;; attempt++) {
      try { await jobs.removeEntry(jobId, { recursive: true }); return; }
      catch (error) {
        if (error.name === 'NotFoundError') return;
        if (attempt === 19) throw error;
        await new Promise(r => setTimeout(r, 50));
      }
    }
  })();
  const result = new Promise((resolve, reject) => {
    rejectJob = reject;
    worker.onmessage = async ({ data }) => {
      if (settled) return;
      if (data.type === 'progress') { onProgress(data); return; }
      settled = true;
      worker.terminate();
      if (data.type === 'result') resolve(data.result);
      else {
        await cleanup();
        reject(Object.assign(new Error(data.message), { code: data.code }));
      }
    };
    worker.onerror = async () => {
      if (settled) return;
      settled = true; worker.terminate();
      await prepared.catch(() => {});
      await cleanup();
      reject(Object.assign(new Error('The browser extraction worker failed to load or run.'), { code: 'WORKER_FAILED' }));
    };
    prepared.then(outputDirectory => {
      if (!settled) worker.postMessage({ type: 'extract', jobId, nsp, prodKeys, titleKeys, outputDirectory, mode });
    }).catch(async error => {
      if (settled) return;
      settled = true; worker.terminate();
      await cleanup();
      reject(error);
    });
  });
  return { jobId, result, async cancel() {
    if (settled) return;
    settled = true; worker.terminate();
    try { await prepared.catch(() => {}); await cleanup(); }
    finally { rejectJob(Object.assign(new Error('Extraction was canceled.'), { code: 'CANCELED' })); }
  } };
}

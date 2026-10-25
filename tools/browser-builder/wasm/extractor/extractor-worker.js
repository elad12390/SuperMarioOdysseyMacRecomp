import { run } from './extractor.js';

// Thin isolated-test adapter. Production may import run in its existing worker.
self.onmessage = async ({ data }) => {
  if (data.type !== 'extract') return;
  const { jobId, nsp, prodKeys, titleKeys, outputDirectory, mode } = data;
  try {
    const result = await run({ nsp, prodKeys, titleKeys, outputDirectory, mode }, p => self.postMessage({ type: 'progress', jobId, ...p }));
    self.postMessage({ type: 'result', jobId, result });
  } catch (error) {
    self.postMessage({ type: 'error', jobId, code: error.code || 'EXTRACT_FAILED', message: error.code ? error.message : 'NSP extraction failed. Check the selected dump and keys.' });
  }
};

import { runBrowserBuild } from '../pipeline/build';

let running: AbortController | undefined;
// Embedded WASM runtimes may install their own onmessage property. Keep the
// pipeline's cancellation listener independent of their startup handlers.
(self as DedicatedWorkerGlobalScope).addEventListener('message', async ({ data }) => {
  if (data.type === 'cancel') { running?.abort(new DOMException('Build cancelled', 'AbortError')); return; }
  if (data.type !== 'build' || running) return;
  const controller = new AbortController(); running = controller;
  try {
    const result = await runBrowserBuild({ ...data, signal: controller.signal }, progress => self.postMessage({ type: 'progress', ...progress }));
    self.postMessage({ type: 'complete', ...result });
  } catch (error) {
    if (controller.signal.aborted) self.postMessage({ type: 'cancelled' });
    else self.postMessage({ type: 'error', stage: (error as { stage?: string }).stage ?? 'validate', message: error instanceof Error ? error.message : 'The browser conversion failed.' });
  } finally { running = undefined; }
});

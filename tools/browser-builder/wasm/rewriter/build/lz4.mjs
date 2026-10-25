import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('../../../../../', import.meta.url)));
const scratch = `${root}/tmp/odyssey/browser-rewriter`;
const { loadPyodide } = await import(`${scratch}/setup/node_modules/pyodide/pyodide.mjs`);
const py = await loadPyodide({ packageCacheDir: `${scratch}/bundle/` });
// Use the normal package installer and pinned Pyodide lockfile; no ad-hoc HTTP.
await py.loadPackage('lz4');

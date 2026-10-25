function staticBase(baseURL) {
  const base = new URL(baseURL);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      (globalThis.location && base.origin !== globalThis.location.origin)) {
    throw new Error('Shader tool assets must be same-origin static HTTP files');
  }
  return base;
}

function assetEntries(assets, base) {
  if (!Array.isArray(assets)) throw new TypeError('Expected a shader tool asset manifest array');
  const seen = new Set();
  return Array.from(assets, asset => {
    const path = asset?.path;
    // Manifest paths are literal, unescaped relative file names. Reject URL
    // syntax and encoded aliases before URL parsing can normalize traversal.
    if (typeof path !== 'string' || /[\\%?#:\x00-\x20\x7f]/.test(path) ||
        path.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error('Unsafe shader tool asset path');
    }
    if (seen.has(path)) throw new Error(`Duplicate shader tool asset path: ${path}`);
    seen.add(path);
    if (!Number.isSafeInteger(asset.size) || asset.size < 0 ||
        typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256)) {
      throw new Error(`Invalid shader tool size/SHA256: ${path}`);
    }
    const url = new URL(path, base);
    if (url.origin !== base.origin || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('Shader tool assets must be same-origin static HTTP files');
    }
    return { path, size: asset.size, sha256: asset.sha256, url };
  });
}

async function verifyAsset(asset, signal) {
  const response = await fetch(asset.url, { credentials: 'omit', mode: 'same-origin', redirect: 'error', signal });
  if (!response.ok) throw new Error(`Shader tool asset is unavailable: ${asset.path} (${response.status})`);
  // Only the active workers hold bodies. Return metadata so completed assets
  // do not keep their bytes alive while the rest of the manifest downloads.
  const bytes = await response.arrayBuffer();
  signal.throwIfAborted();
  if (bytes.byteLength !== asset.size) throw new Error(`Shader tool size mismatch: ${asset.path}`);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  signal.throwIfAborted();
  const sha256 = Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
  if (sha256 !== asset.sha256) throw new Error(`Shader tool checksum mismatch: ${asset.path}`);
  return { path: asset.path, size: bytes.byteLength, sha256 };
}

/**
 * Verify static asset bytes with Web Crypto and return metadata in manifest order.
 * Integer concurrency is clamped to 1..8. onProgress receives { completed, total }
 * after each verified asset; a throwing callback also cancels the operation.
 * Reject only after active requests settle, preserving the first failure/reason.
 */
export async function verifyAssets(assets, baseURL, { concurrency = 8, onProgress = () => {}, signal } = {}) {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(concurrency)) throw new TypeError('Shader asset concurrency must be a safe integer');
  if (typeof onProgress !== 'function') throw new TypeError('Shader asset onProgress must be a function');
  const entries = assetEntries(assets, staticBase(baseURL));
  const verified = new Array(entries.length);
  const controller = new AbortController();
  let next = 0, completed = 0, failed = false, failure;
  const stop = error => {
    if (failed) return;
    failed = true;
    failure = error;
    controller.abort(error);
  };
  const abort = () => stop(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) abort();
    async function worker() {
      while (!failed && next < entries.length) {
        const index = next++;
        try {
          const result = await verifyAsset(entries[index], controller.signal);
          if (failed) return;
          verified[index] = result;
          onProgress({ completed: ++completed, total: entries.length });
        } catch (error) {
          stop(error);
        }
      }
    }
    const count = Math.min(entries.length, Math.max(1, Math.min(8, concurrency)));
    await Promise.all(Array.from({ length: count }, () => worker()));
    if (failed) throw failure;
    return verified;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

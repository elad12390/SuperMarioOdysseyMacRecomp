import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { verifyAssets } from '../asset-loader.mjs';

const encode = text => new TextEncoder().encode(text);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const asset = (path, bytes) => ({ path, size: bytes.byteLength, sha256: sha256(bytes) });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

// Every verification uses real HTTP and independent node:crypto reference
// hashes. These fixtures never replace fetch, Web Crypto, or AbortSignal.
async function withServer(routes, run) {
  const requests = [], finished = [];
  let active = 0, peak = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push({ path, cookie: request.headers.get('cookie'), authorization: request.headers.get('authorization') });
      active++;
      peak = Math.max(peak, active);
      try {
        const route = routes.get(path);
        route?.started?.();
        if (route?.delay) await Bun.sleep(route.delay);
        if (route?.respond) return route.respond(request);
        return new Response(route?.bytes ?? 'missing', { status: route?.status ?? (route ? 200 : 404) });
      } finally {
        active--;
        finished.push(path);
      }
    },
  });
  try {
    return await run({
      baseURL: new URL('/tools/', server.url), requests, finished,
      get peak() { return peak; },
      stop: () => server.stop(true),
    });
  } finally {
    await server.stop(true);
  }
}

function library(count = 12) {
  // Deliberately unsorted and nested to expose completion-order fingerprints.
  const paths = ['z.wasm', 'pyodide/z.bin', 'cross/b.wasm', 'maxwell/a.dll', 'adapter.py', 'sources.json'];
  const assets = [], routes = new Map();
  for (let index = 0; index < count; index++) {
    const path = paths[index] ?? `pyodide/file-${index}.bin`;
    const bytes = index === 1 ? new Uint8Array() : encode(`real asset ${index}\n`);
    assets.push(asset(path, bytes));
    routes.set(`/tools/${path}`, { bytes, delay: index === 0 ? 100 : 5 });
  }
  return { assets, routes };
}

for (const [requested, bound] of [[1, 1], [3, 3], [undefined, 8], [0, 1], [-5, 1], [64, 8]]) {
  test(`HTTP verification concurrency ${requested ?? 'default'} stays within ${bound} and preserves fingerprints`, async () => {
    const { assets, routes } = library();
    await withServer(routes, async server => {
      const progress = [];
      const result = await verifyAssets(assets, server.baseURL, {
        concurrency: requested, onProgress: event => progress.push(event),
      });
      expect(result).toEqual(assets);
      expect(result).not.toBe(assets);
      expect(sha256(JSON.stringify(result))).toBe(sha256(JSON.stringify(assets)));
      for (const prefix of ['pyodide/', 'cross/', 'maxwell/']) {
        const fingerprint = list => sha256(JSON.stringify(list.filter(entry => entry.path.startsWith(prefix))));
        expect(fingerprint(result)).toBe(fingerprint(assets));
      }
      expect(progress).toEqual(assets.map((_, index) => ({ completed: index + 1, total: assets.length })));
      expect(server.peak).toBeLessThanOrEqual(bound);
      if (bound > 1) {
        expect(server.peak).toBeGreaterThan(1);
        expect(server.finished[0]).not.toBe('/tools/z.wasm');
      }
      expect(server.requests).toHaveLength(assets.length);
      expect(server.requests.every(request => request.cookie === null && request.authorization === null)).toBe(true);
      expect(result.every(entry => Object.keys(entry).join(',') === 'path,size,sha256')).toBe(true);
    });
  });
}

test('an empty manifest needs no HTTP or progress events', async () => {
  await withServer(new Map(), async server => {
    const progress = [];
    expect(await verifyAssets([], server.baseURL, { onProgress: event => progress.push(event) })).toEqual([]);
    expect(server.requests).toEqual([]);
    expect(progress).toEqual([]);
  });
});

test('manifest metadata is captured before concurrent downloads', async () => {
  const { assets, routes } = library(3);
  const expected = assets.map(entry => ({ ...entry }));
  await withServer(routes, async server => {
    const pending = verifyAssets(assets, server.baseURL);
    assets[0].sha256 = '0'.repeat(64);
    assets[1].path = 'changed';
    assets.push(asset('extra', encode('extra')));
    expect(await pending).toEqual(expected);
  });
});

const unsafePaths = [
  '', '.', '..', '../escape', 'dir/../escape', './file', 'dir/./file', '/root', '//example.invalid/file',
  'dir//file', 'dir/', '\\escape', 'dir\\file', '\0', 'dir/\0file', 'https://example.invalid/file',
  'http:file', 'file:///tmp/file', 'data:hello', 'javascript:alert(1)', 'file?query', 'file#fragment',
  '%2e%2e/file', 'dir/%2E%2e/file', 'dir/%2ffile', 'dir/%5cfile', 'dir/%00file', '%252e%252e/file',
  ' file', 'file\nname', 'file\tname', 'file\rname', 'file\x7fname', null, 42,
];

for (const path of unsafePaths) {
  test(`unsafe manifest path ${JSON.stringify(path)} rejects before any HTTP`, async () => {
    const { assets, routes } = library(1);
    await withServer(routes, async server => {
      await expect(verifyAssets([...assets, { ...assets[0], path }], server.baseURL)).rejects.toThrow('Unsafe shader tool asset path');
      expect(server.requests).toEqual([]);
    });
  });
}

test('duplicate paths reject the whole manifest before fetching', async () => {
  const { assets, routes } = library(1);
  await withServer(routes, async server => {
    await expect(verifyAssets([assets[0], { ...assets[0] }], server.baseURL)).rejects.toThrow('Duplicate');
    expect(server.requests).toEqual([]);
  });
});

test('invalid manifest arrays, sizes and hashes reject before fetching', async () => {
  const valid = asset('file.wasm', encode('bytes'));
  const invalid = [
    null, {}, 'assets', [null], [undefined], new Array(1),
    ...[-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '5', undefined].map(size => [{ ...valid, size }]),
    ...['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'x'.repeat(64), null, 123, undefined].map(hash => [{ ...valid, sha256: hash }]),
  ];
  await withServer(new Map(), async server => {
    for (const manifest of invalid) await expect(verifyAssets(manifest, server.baseURL)).rejects.toThrow();
    expect(server.requests).toEqual([]);
  });
});

test('invalid pool and callback options reject before fetching', async () => {
  const { assets, routes } = library(1);
  await withServer(routes, async server => {
    for (const concurrency of [NaN, Infinity, 1.5, '3', null, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(verifyAssets(assets, server.baseURL, { concurrency })).rejects.toThrow('concurrency');
    }
    await expect(verifyAssets(assets, server.baseURL, { onProgress: null })).rejects.toThrow('onProgress');
    expect(server.requests).toEqual([]);
  });
});

test('non-HTTP or credential-bearing base URLs reject even with an empty manifest', async () => {
  for (const base of [
    'file:///tmp/tools/', 'ftp://example.invalid/tools/', 'data:text/plain,tools', 'javascript:alert(1)',
    'blob:https://example.invalid/id', 'https://user:password@example.invalid/tools/',
    'http://user@example.invalid/tools/', '/relative/tools/', 'not a URL',
  ]) await expect(verifyAssets([], base)).rejects.toThrow();
});

test('HTTP redirects cannot fetch another origin or a same-origin replacement', async () => {
  await withServer(new Map(), async other => {
    const routes = new Map();
    await withServer(routes, async server => {
      const bytes = encode('redirect target');
      routes.set('/tools/file', { respond: () => Response.redirect(new URL('target', other.baseURL), 302) });
      await expect(verifyAssets([asset('file', bytes)], server.baseURL)).rejects.toThrow();
      expect(other.requests).toEqual([]);
      routes.set('/tools/file', { respond: () => Response.redirect(new URL('target', server.baseURL), 302) });
      await expect(verifyAssets([asset('file', bytes)], server.baseURL)).rejects.toThrow();
      expect(server.requests.map(request => request.path)).toEqual(['/tools/file', '/tools/file']);
    });
  });
});

for (const kind of ['missing', 'size', 'checksum']) {
  test(`${kind} failure stops dispatch and preserves the first error while cancelling active requests`, async () => {
    const { assets, routes } = library(10);
    const first = routes.get('/tools/z.wasm');
    first.delay = 25;
    if (kind === 'missing') first.status = 404;
    if (kind === 'size') first.bytes = encode('wrong byte count');
    if (kind === 'checksum') first.bytes = new Uint8Array(first.bytes.byteLength).fill(120);
    for (const entry of assets.slice(1)) routes.get(`/tools/${entry.path}`).delay = 150;
    await withServer(routes, async server => {
      const progress = [];
      const message = kind === 'missing' ? 'z.wasm (404)' : `${kind} mismatch: z.wasm`;
      await expect(verifyAssets(assets, server.baseURL, {
        concurrency: 3, onProgress: event => progress.push(event),
      })).rejects.toThrow(message);
      expect(server.requests.map(request => request.path)).toEqual(assets.slice(0, 3).map(entry => `/tools/${entry.path}`));
      expect(progress).toEqual([]);
    });
  });
}

test('a truncated HTTP response rejects without dispatching remaining assets', async () => {
  const { assets, routes } = library(4);
  const streaming = deferred();
  routes.set('/tools/z.wasm', {
    respond: () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encode('partial'));
        streaming.resolve();
      },
    })),
  });
  await withServer(routes, async server => {
    const outcome = verifyAssets(assets, server.baseURL, { concurrency: 1 }).then(
      value => ({ value }), error => ({ error }),
    );
    await streaming.promise;
    await Bun.sleep(20);
    await server.stop();
    expect((await outcome).error).toBeInstanceOf(Error);
    expect(server.requests.map(request => request.path)).toEqual(['/tools/z.wasm']);
  });
});

for (const reason of [new Error('already cancelled'), null, undefined]) {
  test(`pre-aborted signal preserves ${reason === null ? 'null' : reason?.message ?? 'AbortError'} without HTTP`, async () => {
    const { assets, routes } = library(2);
    const controller = new AbortController();
    controller.abort(reason);
    await withServer(routes, async server => {
      await expect(verifyAssets(assets, server.baseURL, { signal: controller.signal })).rejects.toBe(controller.signal.reason);
      expect(server.requests).toEqual([]);
    });
  });
}

test('abort with requests in flight preserves its reason and stops dispatch', async () => {
  const { assets, routes } = library(8);
  const started = deferred();
  let count = 0;
  for (const route of routes.values()) {
    route.delay = 150;
    route.started = () => { if (++count === 3) started.resolve(); };
  }
  const controller = new AbortController(), reason = new Error('cancel active downloads');
  await withServer(routes, async server => {
    const progress = [];
    const pending = verifyAssets(assets, server.baseURL, {
      concurrency: 3, signal: controller.signal, onProgress: event => progress.push(event),
    });
    const outcome = pending.then(value => ({ value }), error => ({ error }));
    await started.promise;
    controller.abort(reason);
    expect((await outcome).error).toBe(reason);
    expect(server.requests).toHaveLength(3);
    expect(progress).toEqual([]);
  });
});

test('abort during an HTTP response body cancels the read before progress', async () => {
  const { assets, routes } = library(3);
  const streaming = deferred();
  let timer;
  routes.set('/tools/z.wasm', {
    respond: () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encode('first bytes'));
        timer = setTimeout(() => {
          controller.close();
        }, 500);
        streaming.resolve();
      },
      cancel() { clearTimeout(timer); },
    })),
  });
  const controller = new AbortController();
  await withServer(routes, async server => {
    try {
      const progress = [];
      const pending = verifyAssets(assets, server.baseURL, {
        concurrency: 1, signal: controller.signal, onProgress: event => progress.push(event),
      });
      const outcome = pending.then(value => ({ value }), error => ({ error }));
      await streaming.promise;
      await Bun.sleep(20);
      controller.abort();
      expect((await outcome).error).toBe(controller.signal.reason);
      expect(server.requests).toHaveLength(1);
      expect(progress).toEqual([]);
    } finally {
      clearTimeout(timer);
    }
  });
});

for (const action of ['abort', 'throw']) {
  test(`progress callback ${action} cancels the pool after exactly one verified asset`, async () => {
    const { assets, routes } = library(8);
    routes.get('/tools/z.wasm').delay = 10;
    for (const entry of assets.slice(1)) routes.get(`/tools/${entry.path}`).delay = 150;
    const controller = new AbortController(), reason = new Error(`progress ${action}`);
    await withServer(routes, async server => {
      const progress = [];
      await expect(verifyAssets(assets, server.baseURL, {
        concurrency: 3, signal: controller.signal,
        onProgress(event) {
          progress.push(event);
          if (action === 'throw') throw reason;
          controller.abort(reason);
        },
      })).rejects.toBe(reason);
      expect(progress).toEqual([{ completed: 1, total: assets.length }]);
      expect(server.requests).toHaveLength(3);
    });
  });
}

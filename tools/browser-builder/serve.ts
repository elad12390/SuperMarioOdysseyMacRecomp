import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Local static-only development server. It has no upload or conversion endpoint.
const root = resolve(fileURLToPath(new URL('./dist', import.meta.url)));
const port = Number(process.env.PORT ?? 4381);
const server = Bun.serve({ hostname: '127.0.0.1', port, async fetch(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
  const url = new URL(request.url), name = decodeURIComponent(url.pathname);
  const path = resolve(root, name === '/' ? 'index.html' : `.${name}`);
  if (path !== root && !path.startsWith(root + sep)) return new Response('Not found', { status: 404 });
  const file = Bun.file(path);
  if (!await file.exists()) return new Response('Not found', { status: 404 });
  return new Response(request.method === 'HEAD' ? null : file, { headers: { 'Content-Type': file.type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } });
}});
console.log(`Browser builder: ${server.url}`);

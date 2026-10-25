import { inflateRawSync } from 'node:zlib';
import { safePath } from './files.mjs';

// Read the real wheel/stdlib ZIP directory without executing or extracting it.
export function zipEntries(bytes) {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw new Error('Unsupported ZIP directory');
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16), total = 0;
  const result = [], seen = new Set();
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('Corrupt ZIP directory');
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10);
    const packed = bytes.readUInt32LE(offset + 20), size = bytes.readUInt32LE(offset + 24);
    const length = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32);
    const mode = bytes.readUInt32LE(offset + 38) >>> 16, local = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + length).toString('utf8');
    offset += 46 + length + extra + comment;
    safePath(name.endsWith('/') ? name.slice(0, -1) : name);
    if (seen.has(name) || flags & 1 || (mode & 0xf000) === 0xa000) throw new Error(`Unsafe ZIP member: ${name}`);
    seen.add(name);
    if (name.endsWith('/')) continue;
    total += size;
    if (size > 64 * 1024 ** 2 || total > 256 * 1024 ** 2 || local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50) throw new Error(`Invalid ZIP member bounds: ${name}`);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    if (start + packed > bytes.length) throw new Error(`Truncated ZIP member: ${name}`);
    const payload = bytes.subarray(start, start + packed);
    const data = method === 0 ? Buffer.from(payload) : method === 8 ? inflateRawSync(payload, { maxOutputLength: Math.max(size, 1) }) : null;
    if (!data || data.length !== size) throw new Error(`Unsupported ZIP compression or size: ${name}`);
    result.push({ name, bytes: data });
  }
  return result;
}

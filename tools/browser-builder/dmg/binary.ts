export const BLOCK = 4096;
export const NODE = 8192;
export const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
export const round = (n: number, unit: number) => Math.ceil(n / unit) * unit;
export function u64(v: DataView, offset: number, value: number) { v.setBigUint64(offset, BigInt(value)); }
export function number64(v: DataView, offset: number) {
  const n = Number(v.getBigUint64(offset));
  if (!Number.isSafeInteger(n)) throw Error("UDIF integer exceeds safe range");
  return n;
}
const table = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let b = 0; b < 8; b++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  table[i] = c >>> 0;
}
/** IEEE CRC32, incremental, accepts a previously finalized CRC. */
export function crc32(bytes: Uint8Array, previous = 0): number {
  let c = (previous ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export function utf16(bytes: Uint8Array, offset: number, name: string) {
  const v = view(bytes); v.setUint16(offset, name.length);
  for (let i = 0; i < name.length; i++) v.setUint16(offset + 2 + i * 2, name.charCodeAt(i));
}
export function fork(bytes: Uint8Array, offset: number, size: number, start: number, blocks: number) {
  const v = view(bytes); u64(v, offset, size); v.setUint32(offset + 8, BLOCK);
  v.setUint32(offset + 12, blocks);
  if (blocks) { v.setUint32(offset + 16, start); v.setUint32(offset + 20, blocks); }
}

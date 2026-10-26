export const text = (value: string) => new TextEncoder().encode(value);
export function join(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let at = 0;
  for (const part of parts) { result.set(part, at); at += part.length; }
  return result;
}
export function uint(value: number | bigint, size: number): Uint8Array<ArrayBuffer> {
  let n = BigInt(value);
  if (n < 0n || n >= 1n << BigInt(size * 8)) throw Error('Installer integer outside its field.');
  const bytes = new Uint8Array(size);
  for (let at = size - 1; at >= 0; at--) { bytes[at] = Number(n & 255n); n >>= 8n; }
  return bytes;
}
export function utf16(value: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(value.length * 2), view = new DataView(bytes.buffer);
  for (let at = 0; at < value.length; at++) view.setUint16(at * 2, value.charCodeAt(at));
  return bytes;
}

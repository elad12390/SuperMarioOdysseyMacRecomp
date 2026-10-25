import { crc32, number64, u64, view } from "./binary";
import type { RandomReader } from "./types";

const encode = new TextEncoder(), decode = new TextDecoder();
function checksum(b: Uint8Array, at: number, crc: number) {
  const v = view(b); v.setUint32(at, 2); v.setUint32(at + 4, 32); v.setUint32(at + 8, crc);
}
function masterChecksum(crc: number) { const b = new Uint8Array(4); view(b).setUint32(0, crc); return crc32(b); }
function blockTable(volumeBytes: number, crc: number) {
  const b = new Uint8Array(204 + 2 * 40), v = view(b), sectors = volumeBytes / 512;
  v.setUint32(0, 0x6d697368); v.setUint32(4, 1); u64(v, 16, sectors);
  v.setUint32(32, 2048); v.setUint32(36, 0); checksum(b, 64, crc); v.setUint32(200, 2);
  v.setUint32(204, 1); u64(v, 220, sectors); u64(v, 236, volumeBytes);
  v.setUint32(244, 0xffffffff); u64(v, 252, sectors);
  return b;
}
export function udifTail(volumeBytes: number, crc: number) {
  const table = blockTable(volumeBytes, crc);
  const base64 = btoa(String.fromCharCode(...table));
  const xml = encode.encode(`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>resource-fork</key><dict><key>blkx</key><array><dict><key>Attributes</key><string>0x0050</string><key>CFName</key><string>whole disk (Apple_HFSX : 0)</string><key>Data</key><data>${base64}</data><key>ID</key><string>0</string><key>Name</key><string>whole disk (Apple_HFSX : 0)</string></dict></array></dict></dict></plist>\n`);
  const trailer = new Uint8Array(512), v = view(trailer);
  v.setUint32(0, 0x6b6f6c79); v.setUint32(4, 4); v.setUint32(8, 512); v.setUint32(12, 1);
  u64(v, 32, volumeBytes); v.setUint32(56, 1); v.setUint32(60, 1);
  checksum(trailer, 80, crc); u64(v, 216, volumeBytes); u64(v, 224, xml.length);
  checksum(trailer, 352, masterChecksum(crc)); v.setUint32(488, 2); u64(v, 492, volumeBytes / 512);
  return { xml, trailer };
}

/** Validate this writer's uncompressed single-run UDIF profile, bounded reads.
 * This is a container/checksum validator, not a general HFS filesystem fsck.
 */
export async function inspectDmg(source: RandomReader, chunkSize = 1024 * 1024) {
  if (!Number.isInteger(chunkSize) || chunkSize < 512 || chunkSize > 8 * 1024 * 1024) throw Error("Invalid validation chunk size");
  async function read(at: number, n: number) {
    if (at < 0 || n < 0 || at + n > source.size) throw Error("UDIF read outside file bounds");
    const b = await source.read(at, n); if (b.length !== n) throw Error("Short UDIF read"); return b;
  }
  if (!Number.isSafeInteger(source.size) || source.size < 2048) throw Error("Invalid UDIF file size");
  const trailer = await read(source.size - 512, 512), t = view(trailer);
  if (t.getUint32(0) !== 0x6b6f6c79 || t.getUint32(4) !== 4 || t.getUint32(8) !== 512) throw Error("Invalid UDIF trailer");
  const volumeBytes = number64(t, 32), xmlAt = number64(t, 216), xmlSize = number64(t, 224);
  if (number64(t, 24) !== 0 || volumeBytes < 8192 || volumeBytes % 4096 || xmlAt !== volumeBytes || xmlSize > 65536 || xmlAt + xmlSize !== source.size - 512 || number64(t, 492) * 512 !== volumeBytes || t.getUint32(56) !== 1 || t.getUint32(60) !== 1) throw Error("Invalid UDIF bounds or sectors");
  const xml = decode.decode(await read(xmlAt, xmlSize));
  const match = xml.match(/<key>Data<\/key>\s*<data>([A-Za-z0-9+/=\s]+)<\/data>/);
  if (!match || (xml.match(/<key>Data<\/key>/g)?.length !== 1)) throw Error("Invalid UDIF block metadata");
  let table: Uint8Array;
  try { table = Uint8Array.from(atob(match[1].replace(/\s/g, "")), c => c.charCodeAt(0)); } catch { throw Error("Invalid UDIF base64"); }
  const b = view(table);
  if (table.length !== 284 || b.getUint32(0) !== 0x6d697368 || b.getUint32(4) !== 1 || number64(b, 8) !== 0 || number64(b, 16) * 512 !== volumeBytes || number64(b, 24) !== 0 || b.getUint32(200) !== 2 || b.getUint32(204) !== 1 || number64(b, 212) !== 0 || number64(b, 220) * 512 !== volumeBytes || number64(b, 228) !== 0 || number64(b, 236) !== volumeBytes || b.getUint32(244) !== 0xffffffff || number64(b, 252) * 512 !== volumeBytes || number64(b, 260) !== 0 || number64(b, 268) !== 0 || number64(b, 276) !== 0) throw Error("Invalid UDIF block run");
  let crc = 0;
  for (let at = 0; at < volumeBytes; at += chunkSize) crc = crc32(await read(at, Math.min(chunkSize, volumeBytes - at)), crc);
  for (const [v, at, expected] of [[t, 80, crc], [b, 64, crc], [t, 352, masterChecksum(crc)]] as const) {
    if (v.getUint32(at) !== 2 || v.getUint32(at + 4) !== 32 || v.getUint32(at + 8) !== expected) throw Error("UDIF checksum mismatch");
  }
  const header = await read(1024, 512), alternate = await read(volumeBytes - 1024, 512), h = view(header);
  if (h.getUint16(0) !== 0x4858 || h.getUint16(2) !== 5 || h.getUint32(40) !== 4096 || h.getUint32(44) * 4096 !== volumeBytes || !header.every((x, i) => x === alternate[i])) throw Error("Invalid HFSX volume header");
  return { volumeBytes, imageBytes: source.size, dataChecksum: crc };
}

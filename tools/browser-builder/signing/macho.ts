/** Apple xnu cs_blobs.h and mach-o/loader.h field layouts; no native API. */
export interface AdhocLayout {
  signatureCommandOffset: number; signatureOffset: number; signatureSize: number;
  codeDirectoryOffset: number; codeDirectoryLength: number; resourceDigestOffset: number;
  hashOffset: number; codeLimit: number; codeSlots: number; pageSize: number;
  requirementsOffset: number; requirementsLength: number; cmsOffset: number;
}
function need(ok: unknown, message: string): asserts ok { if (!ok) throw Error(`Unsupported ad-hoc Launcher: ${message}`); }
export function inspectAdhocLauncher(bytes: Uint8Array): AdhocLayout {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), length = bytes.length;
  need(length >= 32 && length <= 16 * 1024 * 1024, "invalid executable size");
  need(v.getUint32(0, true) === 0xfeedfacf, "thin little-endian Mach-O64 required");
  need(v.getUint32(4, true) === 0x0100000c && v.getUint32(8, true) === 0, "ARM64 ALL required");
  need(v.getUint32(12, true) === 2, "MH_EXECUTE required");
  const count = v.getUint32(16, true), end = 32 + v.getUint32(20, true);
  need(count > 0 && count <= 1024 && end <= length, "invalid load-command bounds");
  let command = -1, cursor = 32;
  for (let i = 0; i < count; i++) {
    need(cursor + 8 <= end, "truncated load command");
    const cmd = v.getUint32(cursor, true), size = v.getUint32(cursor + 4, true);
    need(size >= 8 && size % 8 === 0 && cursor + size <= end, "invalid load command size");
    if (cmd === 0x1d) { need(command < 0 && size === 16, "duplicate/unexpected signature command"); command = cursor; }
    cursor += size;
  }
  need(cursor === end && command >= 0, "missing signature or excess load-command bytes");
  const signatureOffset = v.getUint32(command + 8, true), signatureSize = v.getUint32(command + 12, true);
  need(signatureOffset >= end && signatureOffset % 16 === 0 && signatureSize >= 36 && signatureOffset + signatureSize === length, "invalid signature extent");
  const base = signatureOffset, size = v.getUint32(base + 4), blobs = v.getUint32(base + 8);
  need(v.getUint32(base) === 0xfade0cc0 && size >= 36 && size <= signatureSize && blobs === 3, "expected three-slot embedded signature");
  const records = new Map<number, { offset: number; length: number; magic: number }>();
  const ranges: [number, number][] = [];
  for (let i = 0; i < blobs; i++) {
    const type = v.getUint32(base + 12 + i * 8), offset = v.getUint32(base + 16 + i * 8);
    need(!records.has(type) && [0, 2, 0x10000].includes(type), "alternate CodeDirectory or unknown signature slot");
    need(offset >= 36 && offset + 8 <= size, "blob index outside SuperBlob");
    const n = v.getUint32(base + offset + 4);
    need(n >= 8 && offset + n <= size, "blob outside SuperBlob");
    ranges.push([offset, offset + n]); records.set(type, { offset: base + offset, length: n, magic: v.getUint32(base + offset) });
  }
  ranges.sort((a,b) => a[0]-b[0]); let previous = 36;
  for (const [start,end] of ranges) { need(start === previous, "overlapping or gapped signature blobs"); previous = end; }
  need(previous === size, "unexpected SuperBlob tail");
  // LC_CODE_SIGNATURE reserves more storage than the active SuperBlob length.
  // Apple's re-signing can leave nonzero unused tail bytes. They are outside
  // the indexed signature, are never parsed as blobs, and remain unchanged.
  const cd = records.get(0)!, req = records.get(2)!, cms = records.get(0x10000)!;
  need(cd.magic === 0xfade0c02 && cd.length >= 88, "missing CodeDirectory");
  need(req.magic === 0xfade0c01 && req.length >= 12, "invalid requirements blob");
  need(cms.magic === 0xfade0b01 && cms.length === 8, "CMS/certificate signatures are not supported");
  const at = cd.offset, hashOffset = v.getUint32(at + 16), special = v.getUint32(at + 24), codeSlots = v.getUint32(at + 28), codeLimit = v.getUint32(at + 32);
  need(v.getUint32(at + 8) === 0x20400 && v.getUint32(at + 12) === 2, "CS_ADHOC-only version 0x20400 required");
  need(bytes[at + 36] === 32 && bytes[at + 37] === 2 && bytes[at + 38] === 0 && bytes[at + 39] === 14, "SHA256/32-byte/16KiB-page layout required");
  need(v.getUint32(at + 40) === 0 && v.getUint32(at + 44) === 0 && v.getUint32(at + 48) === 0 && v.getUint32(at + 52) === 0 && v.getBigUint64(at + 56) === 0n, "scatter/team/extended code-limit layout unsupported");
  need(special === 3 && codeLimit === signatureOffset && codeSlots === Math.ceil(codeLimit / 16384), "invalid code/special slots");
  need(hashOffset >= 88 + 96 && hashOffset + codeSlots * 32 === cd.length, "invalid hash table");
  const ident = v.getUint32(at + 20), specialStart = hashOffset - 96;
  need(ident === 88 && bytes.subarray(at + ident, at + specialStart).includes(0), "invalid identifier bounds");
  return { signatureCommandOffset: command, signatureOffset, signatureSize, codeDirectoryOffset: at, codeDirectoryLength: cd.length,
    resourceDigestOffset: at + specialStart, hashOffset, codeLimit, codeSlots, pageSize: 16384,
    requirementsOffset: req.offset, requirementsLength: req.length, cmsOffset: cms.offset };
}

import { describe, expect, test } from "bun:test";
import { crc32, inspectDmg, planDmg, writeDmg, type DmgEntry } from "../index";

const text = new TextEncoder();
function file(path: string, value = "hello", mode = 0o644): DmgEntry {
  const data = text.encode(value);
  return { path, size: data.length, mode, open: async () => {
    let pos = 0;
    return { read: async (buffer: Uint8Array) => {
      const n = Math.min(buffer.length, data.length - pos);
      buffer.set(data.subarray(pos, pos + n)); pos += n; return n;
    } };
  } };
}
async function image(entries: DmgEntry[] = [file("Fixture.app/Contents/MacOS/fixture", "ARM64 fixture", 0o755)], timestamp?: number) {
  const parts: Uint8Array[] = [];
  const result = await writeDmg(entries, { write: async b => { parts.push(b.slice()); } }, { volumeName: "Browser Fixture", timestamp });
  const bytes = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
  let at = 0; for (const b of parts) { bytes.set(b, at); at += b.length; }
  return { bytes, result };
}
function catalogFinderInfo(bytes: Uint8Array) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const catalog = v.getUint32(1024 + 288) * 4096;
  const records: { id: number; parent: number; name: string; info: Uint8Array }[] = [];
  for (let node = v.getUint32(catalog + 24); node !== 0;) {
    const start = catalog + node * 8192;
    for (let r = 0; r < v.getUint16(start + 10); r++) {
      const rec = start + v.getUint16(start + 8192 - 2 * (r + 1));
      const data = rec + 2 + v.getUint16(rec);
      if (v.getUint16(data) !== 1 && v.getUint16(data) !== 2) continue;
      records.push({ id: v.getUint32(data + 8), parent: v.getUint32(rec + 2),
        name: new TextDecoder("utf-16be").decode(bytes.subarray(rec + 8, data)),
        info: bytes.slice(data + 48, data + 80) });
    }
    node = v.getUint32(start);
  }
  return records;
}

describe("actual HFSX + UDIF bytes", () => {
  test("uses the standard incremental CRC32 vector", () => {
    expect(crc32(text.encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(text.encode("56789"), crc32(text.encode("1234")))).toBe(0xcbf43926);
  });
  test("marks the root custom icon and hides only its standard icon file", async () => {
    const { bytes } = await image([file(".VolumeIcon.icns", "icon fixture"), file("Nested/.VolumeIcon.icns")]);
    await inspectDmg({ size: bytes.length, read: async (o, n) => bytes.slice(o, o + n) });
    const records = catalogFinderInfo(bytes);
    const root = records.find(r => r.id === 2)!;
    const icon = records.find(r => r.parent === 2 && r.name === ".VolumeIcon.icns")!;
    const custom = new Uint8Array(32); custom[8] = 0x04;
    const invisible = new Uint8Array(32); invisible[8] = 0x40;
    expect(root.info).toEqual(custom);
    expect(icon.info).toEqual(invisible);
    for (const record of records) if (record !== root && record !== icon) expect(record.info).toEqual(new Uint8Array(32));
  });
  test("preserves the complete pre-icon writer output when no icon is supplied", async () => {
    const { bytes } = await image(undefined, 1700000000);
    expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe("0ef402b6797dbb14e0ce2150d6134928c48278d160b28f07e995c3b838b0ac76");
    for (const record of catalogFinderInfo(bytes)) expect(record.info).toEqual(new Uint8Array(32));
  });
  test.each([
    file("Nested/.VolumeIcon.icns"),
    file(".volumeicon.icns"),
    { path: ".VolumeIcon.icns", type: "directory" as const, size: 0, mode: 0o755 },
  ])("does not select a nested icon, differently cased name or directory: %j", async entry => {
    const { bytes } = await image([entry]);
    for (const record of catalogFinderInfo(bytes)) expect(record.info).toEqual(new Uint8Array(32));
  });
  test("has real volume headers, catalog fork, permissions and checksums", async () => {
    const { bytes, result } = await image();
    const parsed = await inspectDmg({ size: bytes.length, read: async (o, n) => bytes.slice(o, o + n) });
    expect(parsed.volumeBytes).toBe(result.volumeBytes);
    expect(new DataView(bytes.buffer).getUint16(1024)).toBe(0x4858);
    expect(new DataView(bytes.buffer).getUint16(1026)).toBe(5);
    expect(bytes.slice(1024, 1536)).toEqual(bytes.slice(result.volumeBytes - 1024, result.volumeBytes - 512));
    const v = new DataView(bytes.buffer);
    const catalogStart = v.getUint32(1024 + 272 + 16) * 4096;
    expect(v.getUint16(catalogStart + 14 + 18)).toBe(8192);
    expect(bytes[catalogStart + 14 + 37]).toBe(0xbc);
    // Inspect leaf records independently of the writer's model.
    let mode = 0;
    for (let node = v.getUint32(catalogStart + 14 + 10); node !== 0;) {
      const start = catalogStart + node * 8192;
      for (let r = 0; r < v.getUint16(start + 10); r++) {
        const rec = start + v.getUint16(start + 8192 - 2 * (r + 1));
        const data = rec + 2 + v.getUint16(rec);
        if (v.getUint16(data) === 2) mode = v.getUint16(data + 42);
        if (v.getUint16(data) === 1) expect(v.getUint16(data + 2) & 0x10).toBe(0x10);
      }
      node = v.getUint32(start);
    }
    expect(mode).toBe(0o100755);
    const totalBlocks = v.getUint32(1024 + 44);
    const allocationStart = v.getUint32(1024 + 112 + 16) * 4096;
    // Bits after the volume's final block are not allocated blocks.
    const finalByte = allocationStart + Math.floor((totalBlocks - 1) / 8);
    expect(bytes[finalByte] & ((1 << (7 - ((totalBlocks - 1) & 7))) - 1)).toBe(0);
    expect(new TextDecoder().decode(bytes.slice(-512, -508))).toBe("koly");
  });
  test("detects payload corruption and bad trailer bounds", async () => {
    const { bytes } = await image();
    bytes[4096] ^= 1;
    await expect(inspectDmg({ size: bytes.length, read: async (o,n) => bytes.slice(o,o+n) })).rejects.toThrow(/checksum/i);
    bytes[bytes.length - 512] = 0;
    await expect(inspectDmg({ size: bytes.length, read: async (o,n) => bytes.slice(o,o+n) })).rejects.toThrow(/UDIF|trailer/i);
  });
  test("builds index levels for many files and handles Unicode and case", async () => {
    const files = Array.from({ length: 1500 }, (_, i) => file(`data/f${i.toString().padStart(5,"0")}`, "x"));
    files.push(file("data/Caf\u00e9"), file("data/A"), file("data/a"), file("data/\u212b"), file("data/\u65e5\u672c\u8a9e"));
    const { bytes } = await image(files);
    await inspectDmg({ size: bytes.length, read: async (o,n) => bytes.slice(o,o+n) });
    const v = new DataView(bytes.buffer);
    const cat = v.getUint32(1024 + 288) * 4096;
    expect(v.getUint16(cat + 14)).toBeGreaterThan(1);
  });
});

describe("preflight and bounded streams", () => {
  test("plans files above 4 GiB without opening a payload", () => {
    const plan = planDmg([{ path: "huge", size: 2 ** 32 + 17, mode: 0o755, open: () => { throw Error("opened"); } }]);
    expect(plan.volumeBytes).toBeGreaterThan(2 ** 32);
    expect(plan.metadataBytes).toBeLessThan(2 ** 20);
  });
  test.each(["/absolute", "../escape", "x/../y", "x//y", "x/./y", "x/", "x\\y", "x:y", "\0bad"])("rejects unsafe path %j", path => {
    expect(() => planDmg([file(path)])).toThrow();
  });
  test("rejects conflicts, unsupported types, invalid sizes and permissions", () => {
    expect(() => planDmg([file("Caf\u00e9"), file("Cafe\u0301")])).toThrow(/duplicate/i);
    expect(() => planDmg([file("a"), file("a/b")])).toThrow(/directory|conflict/i);
    for (const size of [-1, NaN, 1.5, Number.MAX_SAFE_INTEGER]) expect(() => planDmg([{ ...file("x"), size }])).toThrow();
    expect(() => planDmg([{ ...file("x"), mode: 0o120777 }])).toThrow(/mode|type/i);
  });
  test("closes a short reader, propagates failures and honors cancellation", async () => {
    let closed = false;
    const entry: DmgEntry = { path:"short",size:100,mode:0o644,open:async()=>({read:async()=>0,close:async()=>{closed=true;}}) };
    await expect(writeDmg([entry],{write:async()=>{}})).rejects.toThrow(/short|EOF|size/i);
    expect(closed).toBe(true);
    await expect(writeDmg([file("x")],{write:async()=>{throw Error("disk full");}})).rejects.toThrow("disk full");
    const ctrl = new AbortController(); ctrl.abort();
    await expect(writeDmg([file("x")],{write:async()=>{}},{signal:ctrl.signal})).rejects.toThrow();
  });
  test("rejects an overlong source and awaits every bounded sink write", async () => {
    await expect(writeDmg([{ ...file("long", "toolong"),size:2 }],{write:async()=>{}})).rejects.toThrow(/long|size/i);
    let busy = false; let max = 0;
    await writeDmg([file("data", "z".repeat(200000))],{write:async b=>{
      expect(busy).toBe(false); busy=true; max=Math.max(max,b.length);
      await Promise.resolve(); busy=false;
    }},{chunkSize:16384});
    expect(max).toBeLessThanOrEqual(16384);
  });
  test("services a real timer cancellation while a synchronous reader streams", async () => {
    const ctrl = new AbortController(); let left = 32 * 1024 * 1024, closed = false;
    const entry: DmgEntry = { path: "sync-wasm-reader", size: left, mode: 0o644, open: () => {
      setTimeout(() => ctrl.abort(new Error("timer-cancel")), 0);
      return { read: b => { const n = Math.min(b.length, left); b.fill(90, 0, n); left -= n; return n; }, close: () => { closed = true; } };
    } };
    await expect(writeDmg([entry], { write: () => {} }, { signal: ctrl.signal })).rejects.toThrow("timer-cancel");
    expect(closed).toBe(true);
    expect(left).toBeGreaterThan(0);
  });
});

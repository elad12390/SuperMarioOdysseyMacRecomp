import { describe, expect, test } from "bun:test";
import { entryFromBlob, entryFromSymlink, inspectDmg, planDmg, writeDmg, type DmgEntry } from "../index";

const encoder = new TextEncoder();
const timestamp = 1700000000;

async function image(entries: DmgEntry[], onFileWritten?: (entry: DmgEntry) => Promise<void>) {
  const parts: Uint8Array[] = [];
  const result = await writeDmg(entries, { write: async b => { parts.push(b.slice()); } }, {
    timestamp, chunkSize: 4096, onFileWritten,
  });
  const bytes = new Uint8Array(result.imageBytes);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  await inspectDmg({ size: bytes.length, read: async (o, n) => bytes.slice(o, o + n) });
  return bytes;
}

// Parse the emitted catalog independently of the writer's internal model.
function catalog(bytes: Uint8Array) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const base = v.getUint32(1024 + 288) * 4096;
  const records = new Map<string, { mode: number; finder: Uint8Array; payload: Uint8Array }>();
  for (let node = v.getUint32(base + 24); node !== 0;) {
    const start = base + node * 8192;
    for (let r = 0; r < v.getUint16(start + 10); r++) {
      const key = start + v.getUint16(start + 8192 - 2 * (r + 1));
      const data = key + 2 + v.getUint16(key);
      const kind = v.getUint16(data);
      if (kind !== 1 && kind !== 2) continue;
      const name = new TextDecoder("utf-16be").decode(bytes.subarray(key + 8, data));
      const size = kind === 2 ? Number(v.getBigUint64(data + 88)) : 0;
      const extent = kind === 2 ? v.getUint32(data + 104) * 4096 : 0;
      records.set(name, { mode: v.getUint16(data + 42), finder: bytes.slice(data + 48, data + 80),
        payload: bytes.slice(extent, extent + size) });
    }
    node = v.getUint32(start);
  }
  return records;
}

describe("bounded HFSX symbolic links", () => {
  test("emits BSD symlink mode, slnk/rhap Finder metadata and exact non-normalized UTF-8 fork", async () => {
    const links = [entryFromSymlink("Applications", "/Applications"),
      entryFromSymlink("Fixture.app/Link", "../Caf\u00e9"),
      entryFromSymlink("utf8-bom", "\ufeffname"),
      entryFromSymlink("dangling", "./missing/../target")];
    const bytes = await image(links);
    const records = catalog(bytes);
    for (const entry of links) {
      expect(entry.type).toBe("symlink");
      expect(entry.open).toBeUndefined();
      const record = records.get(entry.path.split("/").at(-1)!)!;
      expect(record.mode).toBe(0o120777);
      expect(new TextDecoder().decode(record.finder.slice(0, 8))).toBe("slnkrhap");
      expect(record.finder.slice(8)).toEqual(new Uint8Array(24));
      expect(record.payload).toEqual(encoder.encode(entry.target));
      expect(entry.size).toBe(record.payload.length);
    }
  });

  test("counts links as files and supports a target exactly 1023 UTF-8 bytes", async () => {
    const entry = entryFromSymlink("long", "\u00e9".repeat(511) + "x");
    const plan = planDmg([entry], { timestamp });
    const bytes = await image([entry]);
    expect(new DataView(bytes.buffer).getUint32(1024 + 32)).toBe(1);
    expect(catalog(bytes).get("long")!.payload.length).toBe(1023);
    expect(plan.items.find(item => item.source === entry)!.blocks).toBe(1);
  });

  test.each(["", "\0", "a\nb", "a\tb", "a\u007fb", "a\u0085b", "a\\b", "\ud800", "\udc00", "x".repeat(1024), "\u00e9".repeat(512)])(
    "rejects invalid target %j at construction and preflight", target => {
      expect(() => entryFromSymlink("Applications", target)).toThrow(/target|symlink|UTF|Unicode/i);
      expect(() => planDmg([{ path: "Applications", type: "symlink", size: encoder.encode(target).length,
        mode: 0o777, target }])).toThrow(/target|symlink|UTF|Unicode/i);
    });

  test("validates direct entries, type bits and conflicts before any sink write", async () => {
    const valid = entryFromSymlink("Applications", "/Applications");
    for (const entry of [
      { ...valid, target: undefined }, { ...valid, size: valid.size + 1 },
      { ...valid, open: () => ({ read: () => 0 }) },
      ...[0o100777, 0o40777, 0o127777, 0o1777, -1, NaN, 1.5, 2 ** 32 + 0o777].map(mode => ({ ...valid, mode })),
    ]) {
      let writes = 0;
      await expect(writeDmg([entry], { write: () => { writes++; } })).rejects.toThrow();
      expect(writes).toBe(0);
    }
    for (const mode of [0o777, 0o120777, 0o120755]) expect(() => planDmg([{ ...valid, mode }])).not.toThrow();
    expect(() => planDmg([valid, entryFromBlob("Applications/child", new Blob(["x"]))])).toThrow(/directory|conflict/i);
    expect(() => planDmg([valid, { ...valid }])).toThrow(/duplicate/i);
    expect(() => entryFromSymlink("../bad", "/Applications")).toThrow();
    expect(() => planDmg([valid], { openFolder: "Applications" })).toThrow(/folder|directory/i);
    expect(() => planDmg([entryFromBlob("file", new Blob(["x"])), { ...valid, path: "file/child" }])).toThrow(/directory|conflict/i);
  });

  test("a symlink named .VolumeIcon.icns never selects custom icon flags", async () => {
    const bytes = await image([entryFromSymlink(".VolumeIcon.icns", "/Applications")]);
    expect(catalog(bytes).get(".VolumeIcon.icns")!.finder.slice(8)).toEqual(new Uint8Array(24));
    expect(catalog(bytes).get("Browser Build")!.finder).toEqual(new Uint8Array(32));
  });

  test("awaits link padding and original-entry callbacks without altering bytes", async () => {
    const link = entryFromSymlink("Applications", "/Applications");
    const entries = [link, entryFromBlob("Fixture.app/resource", new Blob(["fixture-resource"]))];
    const baseline = await image(entries);
    const callbacks: DmgEntry[] = [];
    const plan = planDmg(entries, { timestamp });
    let written = 0, busy = false;
    await writeDmg(entries, { write: async bytes => {
      expect(busy).toBe(false); busy = true;
      expect(bytes.length).toBeLessThanOrEqual(4096);
      await Bun.sleep(0); written += bytes.length; busy = false;
    } }, { timestamp, chunkSize: 4096, onFileWritten: async entry => {
      const item = plan.items.find(item => item.source === entry)!;
      expect(busy).toBe(false); expect(written).toBe((item.start + item.blocks) * 4096);
      await Bun.sleep(0); callbacks.push(entry);
    } });
    expect(callbacks).toEqual(entries);
    expect(await image(entries, async entry => { expect(entries.includes(entry)).toBe(true); })).toEqual(baseline);
  });

  test.each(["reject", "cancel"])("stops at a symlink callback on %s", async action => {
    const first = entryFromSymlink("Applications", "/Applications");
    let opened = false, callbacks = 0;
    const next: DmgEntry = { path: "next", mode: 0o644, size: 0, open: () => {
      opened = true; return { read: () => 0 };
    } };
    const ctrl = new AbortController(), reason = new Error(`link-${action}`);
    await expect(writeDmg([first, next], { write: () => {} }, { signal: ctrl.signal, onFileWritten: async entry => {
      expect(entry).toBe(first); callbacks++; await Bun.sleep(0);
      if (action === "reject") throw reason;
      ctrl.abort(reason);
    } })).rejects.toBe(reason);
    expect(callbacks).toBe(1); expect(opened).toBe(false);
  });

  test("cancels after link payload without callback or later source", async () => {
    const link = entryFromSymlink("Applications", "/Applications"), ctrl = new AbortController();
    const plan = planDmg([link], { timestamp });
    let written = 0, callbacks = 0;
    await expect(writeDmg([link], { write: bytes => {
      written += bytes.length;
      if (written > plan.metadataBytes) ctrl.abort(new Error("cancel-link-payload"));
    } }, { timestamp, chunkSize: 4096, signal: ctrl.signal, onFileWritten: () => { callbacks++; } })).rejects.toThrow("cancel-link-payload");
    expect(callbacks).toBe(0);
  });
});

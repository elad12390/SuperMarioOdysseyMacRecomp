import { expect, test } from "bun:test";
import { mkdir, mkdtemp, open, readFile, rm, stat, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { inspectDmg, planDmg, writeDmg, type DmgEntry } from "../index";

const scratch = resolve(import.meta.dir, "../../../../tmp/odyssey/opfs-firefox");
const timestamp = 1700000000;
const tick = () => new Promise<void>(done => setTimeout(done, 0));
async function workspace(run: (path: string) => Promise<void>) {
  await mkdir(scratch, { recursive: true });
  const path = await mkdtemp(resolve(scratch, "consumption-"));
  try { await run(path); } finally { await rm(path, { recursive: true, force: true }); }
}

test("awaits payload, padding and close before unlinking real sources; image bytes and CRC stay identical", async () => {
  await workspace(async path => {
    const values = [new Uint8Array(8192 + 37).fill(0x5a), new Uint8Array(0), new Uint8Array(4096).fill(0xa5)];
    const sources = values.map((_, i) => resolve(path, `source-${i}`));
    const closed = new Set<DmgEntry>(), completed: DmgEntry[] = [];
    let consuming = false;
    const files: DmgEntry[] = [];
    for (const [i, value] of values.entries()) {
      await Bun.write(sources[i], value);
      const entry: DmgEntry = { path: `Fixture.app/data/Caf\u00e9-${i}`, size: value.length, mode: 0o644, open: async () => {
        if (consuming) expect(completed).toEqual(files.slice(0, i));
        const input = await open(sources[i], "r");
        return { read: async buffer => (await input.read(buffer)).bytesRead, close: async () => {
          await input.close(); await tick(); closed.add(entry);
        } };
      } };
      files.push(entry);
    }
    const entries = [{ path: "empty-directory", type: "directory" as const, size: 0, mode: 0o755 }, ...files];
    const plan = planDmg(entries, { timestamp }), ends = new Map<DmgEntry, number>();
    let end = plan.metadataBytes;
    for (const entry of files) { end += Math.ceil(entry.size / 4096) * 4096; ends.set(entry, end); }
    const outputPath = resolve(path, "consumed.dmg"), baselinePath = resolve(path, "baseline.dmg");
    const baseline = await open(baselinePath, "wx");
    try { await writeDmg(entries, { write: bytes => baseline.writeFile(bytes) }, { timestamp, chunkSize: 16384 }); }
    finally { await baseline.close(); }
    closed.clear(); consuming = true;
    const output = await open(outputPath, "wx");
    let result;
    try {
      result = await writeDmg(entries, { write: async bytes => { await tick(); await output.writeFile(bytes); } }, {
        timestamp, chunkSize: 16384,
        onFileWritten: async entry => {
          expect(files.includes(entry)).toBe(true);
          expect(closed.has(entry)).toBe(true);
          expect((await output.stat()).size).toBe(ends.get(entry)!);
          await tick();
          await unlink(sources[files.indexOf(entry)]);
          completed.push(entry);
        },
      });
    } finally { await output.close(); }
    expect(completed).toEqual(files);
    for (const source of sources) expect(await stat(source).catch(() => null)).toBeNull();
    const bytes = await readFile(outputPath);
    expect(bytes.equals(await readFile(baselinePath))).toBe(true);
    const inspection = await inspectDmg({ size: bytes.length, read: async (o, n) => bytes.subarray(o, o + n) });
    expect(inspection.dataChecksum).toBe(result.dataChecksum);
    for (const [i, entry] of files.entries()) {
      const item = plan.items.find(item => item.source === entry)!;
      expect(bytes.subarray(item.start * 4096, item.start * 4096 + entry.size)).toEqual(Buffer.from(values[i]));
    }
  });
}, 10000);

test.each(["failure", "cancellation"])("stops before the next source after awaited callback %s", async kind => {
  await workspace(async path => {
    const source = resolve(path, "source"); await Bun.write(source, "payload");
    let closed = false, callbacks = 0, nextOpened = false;
    const first: DmgEntry = { path: "first", size: 7, mode: 0o644, open: async () => {
      const input = await open(source, "r");
      return { read: async b => (await input.read(b)).bytesRead, close: async () => { await input.close(); closed = true; } };
    } };
    const second = { ...first, path: "second", open: () => { nextOpened = true; return first.open!(); } };
    const controller = new AbortController(), reason = new Error(`callback-${kind}`);
    const output = await open(resolve(path, "incomplete.dmg"), "wx");
    try {
      await expect(writeDmg([first, second], { write: b => output.writeFile(b) }, {
        timestamp, signal: controller.signal,
        onFileWritten: async entry => {
          callbacks++; expect(entry).toBe(first); expect(closed).toBe(true);
          await tick();
          if (kind === "failure") throw reason;
          controller.abort(reason);
        },
      })).rejects.toBe(reason);
      expect(callbacks).toBe(1); expect(nextOpened).toBe(false);
      expect((await output.stat()).size).toBeLessThan(planDmg([first, second], { timestamp }).volumeBytes);
    } finally { await output.close(); }
  });
});

test.each(["source", "padding", "cancel-before-callback"])("does not release an input on %s failure", async kind => {
  await workspace(async path => {
    const source = resolve(path, "source"); await Bun.write(source, "payload");
    const output = await open(resolve(path, "incomplete.dmg"), "wx");
    const controller = new AbortController(); let callbacks = 0, closed = false;
    const entry: DmgEntry = { path: "data", size: kind === "source" ? 8 : 7, mode: 0o644, open: async () => {
      const input = await open(source, "r");
      return { read: async b => (await input.read(b)).bytesRead, close: async () => {
        await input.close(); closed = true;
        if (kind === "padding") await output.close();
        if (kind === "cancel-before-callback") controller.abort(new Error("cancel-after-close"));
      } };
    } };
    try {
      await expect(writeDmg([entry], { write: b => output.writeFile(b) }, {
        timestamp, signal: controller.signal, onFileWritten: () => { callbacks++; },
      })).rejects.toThrow();
      expect(callbacks).toBe(0); expect(closed).toBe(true);
      expect(await Bun.file(source).text()).toBe("payload");
    } finally { if (kind !== "padding") await output.close(); }
  });
});

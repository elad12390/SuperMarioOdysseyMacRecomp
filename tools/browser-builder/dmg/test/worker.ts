import { entryFromBlob, inspectDmg, writeDmgToOpfs, type DmgEntry } from "../index";

declare const self: DedicatedWorkerGlobalScope;
const text = new TextEncoder();
const cancelled = new AbortController();
let sourceReadMax = 0, sourceReads = 0, opened = 0, closed = 0;
const blobEntry = (path: string, data: string) => entryFromBlob(path, new Blob([data]));

self.onmessage = async event => {
  try {
    const root = await navigator.storage.getDirectory();
    const job = await root.getDirectoryHandle("browser-dmg-test", { create: true });
    self.postMessage({ progress: "worker-ready" });
    const { large } = event.data as { large: boolean };
    const names = ["Info.plist", "MacOS/BrowserFixture", "Resources/message.txt", "_CodeSignature/CodeResources"];
    const entries: DmgEntry[] = [];
    for (const name of names) {
      const response = await fetch(`/fixture/${name}`);
      if (!response.ok) throw Error(`Fixture fetch failed: ${name}`);
      entries.push(entryFromBlob(`BrowserFixture.app/Contents/${name}`, await response.blob(), name.startsWith("MacOS/") ? 0o755 : 0o644));
    }
    for (let i = 0; i < 1600; i++) entries.push(blobEntry(`catalog/f${String(i).padStart(5, "0")}`, `record-${i}\n`));
    for (const name of ["Caf\u00e9", "\u212b", "\u65e5\u672c\u8a9e", "\ud55c\uae00", "\ud83d\ude80"]) entries.push(blobEntry(`unicode/${name}`, "unicode-ok\n"));
    entries.push({ path: "empty-directory", size: 0, mode: 0o750, type: "directory" });
    entries.push(blobEntry("empty-file", ""));
    const hugeSize = 2 ** 32 + 37;
    if (large) entries.push({ path: "large-resource.bin", size: hugeSize, mode: 0o644, open: () => {
      let at = 0; opened++;
      return { read(buffer) {
        const n = Math.min(buffer.length, hugeSize - at); buffer.fill(0x5a, 0, n);
        if (at === 0 && n >= 16) buffer.set(text.encode("BROWSER-DMG-HEAD!"));
        const marker = text.encode("BROWSER-DMG-END!!"), start = hugeSize - marker.length;
        if (at + n > start) {
          const from = Math.max(at, start); buffer.set(marker.subarray(from - start), from - at);
        }
        at += n; sourceReads++; sourceReadMax = Math.max(sourceReadMax, n); return n;
      }, close() { closed++; } };
    } });
    const name = large ? "browser-large.dmg" : "browser-small.dmg";
    // Cancellation and EOF failures must remove incomplete job files.
    const errors: string[] = [];
    try {
      await writeDmgToOpfs([blobEntry("cancel-data", "hello")], job, "cancelled.dmg", {
        signal: cancelled.signal, onProgress: () => cancelled.abort(new Error("cancel-test")),
      });
      throw Error("Cancellation unexpectedly succeeded");
    } catch (e) { errors.push(String(e)); }
    try {
      await writeDmgToOpfs([{ path: "short", size: 12, mode: 0o644, open: () => ({ read: () => 0 }) }], job, "short.dmg");
      throw Error("Short source unexpectedly succeeded");
    } catch (e) { errors.push(String(e)); }
    for (const failed of ["cancelled.dmg", "short.dmg"]) {
      try { await job.getFileHandle(failed); throw Error("Partial OPFS output survived"); }
      catch (e) { if (!(e instanceof DOMException && e.name === "NotFoundError")) throw e; }
    }
    const timerAbort = new AbortController();
    let left = 32 * 1024 * 1024, timerClosed = false;
    try {
      await writeDmgToOpfs([{ path: "sync-wasm", size: left, mode: 0o644, open: () => {
        setTimeout(() => timerAbort.abort(new Error("timer-cancel")), 0);
        return { read: b => { const n = Math.min(b.length, left); b.fill(90, 0, n); left -= n; return n; }, close: () => { timerClosed = true; } };
      } }], job, "timer-cancelled.dmg", { signal: timerAbort.signal });
      throw Error("Timer cancellation unexpectedly succeeded");
    } catch (e) { if (!String(e).includes("timer-cancel")) throw e; errors.push(String(e)); }
    if (!timerClosed || left <= 0) throw Error("Synchronous reader did not cancel early and close");
    try { await job.getFileHandle("timer-cancelled.dmg"); throw Error("Timer cancellation output survived"); }
    catch (e) { if (!(e instanceof DOMException && e.name === "NotFoundError")) throw e; }
    const started = performance.now();
    let lastReport = 0;
    const result = await writeDmgToOpfs(entries, job, name, {
      volumeName: "Browser DMG Fixture", timestamp: 1792886400,
      chunkSize: 1024 * 1024,
      onProgress: p => { if (p.writtenBytes - lastReport >= 256 * 1024 * 1024) { lastReport = p.writtenBytes; self.postMessage({ progress: p.writtenBytes }); } },
    });
    const elapsedMs = performance.now() - started;
    // Reuse a verification buffer too: File.slice().arrayBuffer() per block
    // would leave hundreds of MB of temporary buffers awaiting browser GC.
    const verifyHandle = await result.file.createSyncAccessHandle();
    const verifyBuffer = new Uint8Array(1024 * 1024);
    let inspection;
    try {
      inspection = await inspectDmg({ size: verifyHandle.getSize(), read: async (o, n) => {
        const b = n > 65536 ? verifyBuffer.subarray(0, n) : new Uint8Array(n);
        let at = 0;
        while (at < n) { const count = verifyHandle.read(b.subarray(at), { at: o + at }); if (!count) throw Error("Short verification read"); at += count; }
        return b;
      } });
    } finally { verifyHandle.close(); }
    const file = await result.file.getFile();
    const { file: _handle, ...stats } = result;
    self.postMessage({ done: true, file, stats: { ...stats, elapsedMs, sourceReadMax, sourceReads, opened, closed, inspection, errors, opfsFailuresCleaned: true } });
  } catch (error) { self.postMessage({ error: String(error), stack: error instanceof Error ? error.stack : "" }); }
};

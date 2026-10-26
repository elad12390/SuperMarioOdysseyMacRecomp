import { BLOCK, NODE, crc32, round } from "./binary";
import { bitmap, planDmg, treeHeader, treeNode, volumeHeader } from "./hfsx";
import { udifTail } from "./udif";
import { symlinkReader } from "./symlink";
import type { DmgEntry, DmgOptions, DmgResult, DmgSink } from "./types";
export { crc32 } from "./binary";
export { planDmg } from "./hfsx";
export { inspectDmg } from "./udif";
export { writeDmgToOpfs, entryFromBlob } from "./opfs";
export { entryFromSymlink } from "./symlink";
export type * from "./types";

/** Sequential output, O(metadata + chunkSize) memory. Sink lifetime is caller-owned. */
export async function writeDmg(entries: readonly DmgEntry[], sink: DmgSink, options: DmgOptions = {}): Promise<DmgResult> {
  const chunkSize = options.chunkSize ?? 1024 * 1024;
  if (!Number.isInteger(chunkSize) || chunkSize < 4096 || chunkSize > 8 * 1024 * 1024) throw Error("chunkSize must be 4 KiB to 8 MiB");
  const aborted = () => options.signal?.throwIfAborted();
  aborted();
  const plan = planDmg(entries, options), buffer = new Uint8Array(chunkSize), zero = new Uint8Array(chunkSize);
  let written = 0, crc = 0, lastProgress = 0, lastYield = 0;
  async function emit(bytes: Uint8Array, path?: string, isData = true) {
    for (let at = 0; at < bytes.length; at += chunkSize) {
      aborted(); const part = bytes.subarray(at, Math.min(at + chunkSize, bytes.length));
      await sink.write(part); if (isData) crc = crc32(part, crc); written += part.length;
      // Synchronous WASM readers + OPFS writes otherwise form a microtask chain
      // that prevents a worker from receiving a cancel message for the whole job.
      if (written - lastYield >= 16 * 1024 * 1024) {
        await new Promise<void>(resolve => setTimeout(resolve, 0)); lastYield = written; aborted();
      }
      if (written - lastProgress >= chunkSize || path) {
        options.onProgress?.({ writtenBytes: written, volumeBytes: plan.volumeBytes, path }); lastProgress = written;
      }
    }
  }
  async function padding(n: number) {
    while (n > 0) { const size = Math.min(n, zero.length); await emit(zero.subarray(0, size)); n -= size; }
  }
  const first = new Uint8Array(BLOCK), header = volumeHeader(plan); first.set(header, 1024);
  await emit(first); await emit(bitmap(plan)); await emit(treeHeader(BLOCK));
  await emit(treeHeader(NODE, plan.tree));
  for (const n of plan.tree.nodes) await emit(treeNode(n));
  for (const item of plan.items) {
    if (item.directory) continue;
    aborted();
    const reader = item.symlinkTarget !== undefined ? symlinkReader(item.symlinkTarget) : await item.source!.open!();
    try {
      let remaining = item.size;
      while (remaining > 0) {
        aborted(); const part = buffer.subarray(0, Math.min(remaining, buffer.length));
        const n = await reader.read(part);
        if (!Number.isInteger(n) || n <= 0 || n > part.length) throw Error(`Short source or invalid read size: ${item.path}`);
        await emit(part.subarray(0, n), item.path); remaining -= n;
      }
      aborted();
      if (await reader.read(buffer.subarray(0, 1)) !== 0) throw Error(`Source longer than declared size: ${item.path}`);
    } finally { await reader.close?.(); }
    await padding(round(item.size, BLOCK) - item.size);
    aborted();
    await options.onFileWritten?.(item.source!);
    aborted();
  }
  await padding(plan.volumeBytes - BLOCK - written);
  const last = new Uint8Array(BLOCK); last.set(header, BLOCK - 1024); await emit(last);
  const { xml, trailer } = udifTail(plan.volumeBytes, crc);
  await emit(xml, undefined, false); await emit(trailer, undefined, false); aborted();
  options.onProgress?.({ writtenBytes: written, volumeBytes: plan.volumeBytes });
  return { volumeBytes: plan.volumeBytes, imageBytes: written, dataChecksum: crc, fileCount: plan.fileCount, metadataBytes: plan.metadataBytes };
}

import { writeDmg } from "./index";
import { planDmg } from "./hfsx";
import type { DmgEntry, DmgOptions } from "./types";

export function entryFromBlob(path: string, blob: Blob, mode = 0o644): DmgEntry {
  return { path, size: blob.size, mode, open: () => {
    let offset = 0;
    return { read: async buffer => {
      const bytes = new Uint8Array(await blob.slice(offset, offset + buffer.length).arrayBuffer());
      buffer.set(bytes); offset += bytes.length; return bytes.length;
    } };
  } };
}

/** Run in a dedicated worker: OPFS sync access avoids a second temp-file copy.
 * name MUST be new. Success closes/flushed output; any failure removes it.
 */
export async function writeDmgToOpfs(entries: readonly DmgEntry[], directory: FileSystemDirectoryHandle, name: string, options: DmgOptions = {}) {
  planDmg(entries, options); // Validate all metadata before creating output.
  if (!name || name === "." || name === ".." || /[/\\\0]/.test(name)) throw Error("Invalid OPFS output name");
  options.signal?.throwIfAborted();
  try { await directory.getFileHandle(name); throw Error("OPFS output already exists; choose a new job name"); }
  catch (error) { if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error; }
  const file = await directory.getFileHandle(name, { create: true });
  let handle: FileSystemSyncAccessHandle | undefined;
  try {
    handle = await file.createSyncAccessHandle(); handle.truncate(0);
    const active = handle;
    const result = await writeDmg(entries, { write: bytes => {
      let at = 0;
      while (at < bytes.length) {
        const n = active.write(bytes.subarray(at));
        if (!Number.isInteger(n) || n <= 0) throw Error("OPFS short write"); at += n;
      }
    } }, options);
    active.flush(); active.close(); handle = undefined;
    return { ...result, file };
  } catch (error) {
    try { handle?.close(); } finally { await directory.removeEntry(name); }
    throw error;
  }
}

import { hfsPath } from "./names";
import type { DmgEntry, DmgReader } from "./types";

/** MAXPATHLEN is 1024 on macOS, including the terminating NUL. Never normalize targets. */
export function symlinkBytes(target: unknown): Uint8Array {
  if (typeof target !== "string" || !target.length || target.length > 1023 || /[\x00-\x1f\x7f-\x9f\\]/.test(target)) {
    throw Error("Invalid symlink target (nonempty path, no controls or backslash, at most 1023 UTF-8 bytes)");
  }
  const bytes = new TextEncoder().encode(target);
  if (bytes.length > 1023 || new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes) !== target) {
    throw Error("Symlink target must be well-formed Unicode and at most 1023 UTF-8 bytes");
  }
  return bytes;
}

export function entryFromSymlink(path: string, target: string): DmgEntry {
  hfsPath(path);
  return { path, type: "symlink", target, size: symlinkBytes(target).length, mode: 0o777 };
}

/** A bounded private reader keeps links on the ordinary payload/cancellation lifecycle. */
export function symlinkReader(target: string): DmgReader {
  const bytes = symlinkBytes(target);
  let offset = 0;
  return { read(buffer) {
    const n = Math.min(buffer.length, bytes.length - offset);
    buffer.set(bytes.subarray(offset, offset + n)); offset += n; return n;
  } };
}

export const CHUNK_SIZE = 1 << 20;
let input;
let reader;
let output;
let stats;
let cachedBytes;
let cachedOffset = 0;

export function attachInput(file) {
  input = file;
  reader = new FileReaderSync();
  cachedBytes = undefined;
  stats = { inputBytesRead: 0, maxReadBytes: 0, readCalls: 0, storageReadCalls: 0, outputBytesWritten: 0 };
}

export function attachOutput(handle) { output = handle; }

export function readInput(offset, destination) {
  const length = destination.length;
  if (!Number.isSafeInteger(offset) || offset < 0 || length > CHUNK_SIZE || offset + length > input.size)
    throw new Error('TRUNCATED_INPUT');
  // LibHac often asks for 16 KiB sectors. One bounded read-ahead window avoids
  // a synchronous browser file-read round trip for every encrypted sector.
  if (!cachedBytes || offset < cachedOffset || offset + length > cachedOffset + cachedBytes.length) {
    cachedOffset = offset;
    cachedBytes = new Uint8Array(reader.readAsArrayBuffer(input.slice(offset, Math.min(input.size, offset + CHUNK_SIZE))));
    stats.inputBytesRead += cachedBytes.length;
    stats.maxReadBytes = Math.max(stats.maxReadBytes, cachedBytes.length);
    stats.readCalls++;
  }
  const bytes = cachedBytes.subarray(offset - cachedOffset, offset - cachedOffset + length);
  destination.set(bytes);
  stats.storageReadCalls++;
  return bytes.length;
}

export function writeOutput(offset, source) {
  if (!output || !Number.isSafeInteger(offset) || offset < 0 || source.length > CHUNK_SIZE)
    throw new Error('OUTPUT_WRITE_FAILED');
  // MemoryView.slice() copies only this bounded chunk; views never outlive interop.
  const bytes = source.slice();
  let written = 0;
  while (written < bytes.length) {
    const count = output.write(bytes.subarray(written), { at: offset + written });
    if (count <= 0) throw new Error('OUTPUT_WRITE_FAILED');
    written += count;
  }
  stats.outputBytesWritten += written;
  return written;
}

export function getStats() { return { ...stats }; }
export function detach() { input = reader = output = cachedBytes = undefined; }

/** Bounded write-back pages over the job's real synchronous OPFS scratch file. */
export function cachedStore(access, { pageBytes = 256 * 1024, cacheBytes = 64 * 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(pageBytes) || pageBytes < 4096 || pageBytes % 4096 ||
      !Number.isSafeInteger(cacheBytes) || cacheBytes < pageBytes) throw new Error('Invalid shader scratch cache bounds');
  const limit = Math.floor(cacheBytes / pageBytes), pages = new Map();
  const stats = { reads: 0, writes: 0, hits: 0, peakBytes: 0 };
  let diskBytes = access.getSize();
  function flushPage(at, page) {
    if (!page.dirty) return;
    if (access.write(page.bytes, { at }) !== page.bytes.length) throw new Error('Incomplete OPFS shader scratch page write');
    stats.writes++; diskBytes = Math.max(diskBytes, at + page.bytes.length); page.dirty = false;
  }
  function get(at) {
    let page = pages.get(at);
    if (page) { pages.delete(at); pages.set(at, page); stats.hits++; return page; }
    if (pages.size === limit) {
      const [oldAt, oldPage] = pages.entries().next().value;
      flushPage(oldAt, oldPage); pages.delete(oldAt);
    }
    page = { bytes: new Uint8Array(pageBytes), dirty: false };
    const count = Math.min(pageBytes, Math.max(0, diskBytes - at));
    if (count) {
      if (access.read(page.bytes.subarray(0, count), { at }) !== count) throw new Error('Incomplete OPFS shader scratch page read');
      stats.reads++;
    }
    pages.set(at, page); stats.peakBytes = Math.max(stats.peakBytes, pages.size * pageBytes);
    return page;
  }
  function copy(bytes, at, write) {
    for (let done = 0; done < bytes.length;) {
      const position = at + done, start = Math.floor(position / pageBytes) * pageBytes;
      const inner = position - start, count = Math.min(bytes.length - done, pageBytes - inner);
      const page = get(start);
      if (write) { page.bytes.set(bytes.subarray(done, done + count), inner); page.dirty = true; }
      else bytes.set(page.bytes.subarray(inner, inner + count), done);
      done += count;
    }
    return bytes.length;
  }
  return {
    read(bytes, { at }) { return copy(bytes, at, false); },
    write(bytes, { at }) { return copy(bytes, at, true); },
    flush() { for (const [at, page] of pages) flushPage(at, page); access.flush(); },
    close() { try { this.flush(); } finally { pages.clear(); access.close(); } },
    stats,
  };
}

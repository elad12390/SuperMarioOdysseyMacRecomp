import { cachedStore } from './page-store.mjs';

/** Read-only Emscripten FS backed by local File blobs, read in bounded slices. */
export function mountFiles(py, mountpoint, files, { chunkBytes = 4 * 1024 * 1024 } = {}) {
  const { FS } = py;
  const reader = new FileReaderSync();
  const directories = new Map([['', null]]);
  const nodes = new Map();
  const errno = value => { throw new FS.ErrnoError(value); };
  const nodeOps = {
    getattr(node) {
      const size = node.blob?.size || 0;
      return { dev: 1, ino: node.id, mode: node.mode, nlink: 1, uid: 0, gid: 0, rdev: 0, size,
        atime: new Date(0), mtime: new Date(0), ctime: new Date(0), blksize: 4096, blocks: Math.ceil(size / 512) };
    },
    lookup(parent, name) { return parent.children.get(name) || errno(44); },
    readdir(node) { return ['.', '..', ...node.children.keys()]; },
    setattr() { errno(69); },
  };
  const streamOps = {
    open(stream) { if ((stream.flags & 3) !== 0) errno(69); },
    llseek(stream, offset, whence) {
      const position = whence === 1 ? stream.position + offset : whence === 2 ? stream.node.blob.size + offset : offset;
      if (position < 0) errno(28);
      return position;
    },
    read(stream, buffer, offset, length, position) {
      const blob = stream.node.blob;
      const count = Math.max(0, Math.min(length, blob.size - position));
      for (let done = 0; done < count;) {
        const part = new Uint8Array(reader.readAsArrayBuffer(blob.slice(position + done, position + Math.min(count, done + chunkBytes))));
        if (!part.length) throw new Error(`Local file changed during shader conversion: ${stream.node.name}`);
        buffer.set(part, offset + done); done += part.length;
      }
      return count;
    },
    write() { errno(69); },
  };
  const create = (parent, name, blob) => {
    const node = FS.createNode(parent, name, blob ? 0o100444 : 0o40555, 0);
    node.node_ops = nodeOps; node.stream_ops = streamOps;
    node.blob = blob; node.children = new Map();
    if (parent) parent.children.set(name, node);
    return node;
  };
  const type = { mount() {
    const root = create(null, '/', null); directories.set('', root);
    for (const { name, file } of files) {
      if (!name || name.split('/').some(n => !n || n === '.' || n === '..')) throw new Error(`Invalid local file path: ${name}`);
      const parts = name.split('/'); let relative = '', parent = root;
      for (const part of parts.slice(0, -1)) {
        relative = relative ? `${relative}/${part}` : part;
        if (!directories.has(relative)) directories.set(relative, create(parent, part, null));
        parent = directories.get(relative);
      }
      if (parent.children.has(parts.at(-1))) throw new Error(`Duplicate local file: ${name}`);
      nodes.set(name, create(parent, parts.at(-1), file));
    }
    return root;
  } };
  FS.mkdirTree(mountpoint); FS.mount(type, {}, mountpoint);
  return () => FS.unmount(mountpoint);
}

/** Writable Python scratch files share one block store, never a MEMFS game copy. */
export function mountScratch(py, mountpoint, rawAccess, options) {
  const access = cachedStore(rawAccess, options);
  const { FS } = py;
  const blockSize = 4 * 1024;
  let nextBlock = 0;
  const free = [];
  const release = node => { for (const block of node.blocks.values()) free.push(block); node.blocks.clear(); };
  const discard = node => { node.deleted = true; if (!node.opens) release(node); };
  const errno = value => { throw new FS.ErrnoError(value); };
  const create = (parent, name, mode) => {
    const node = FS.createNode(parent, name, mode, 0);
    node.node_ops = operations; node.stream_ops = streams;
    node.children = new Map(); node.blocks = new Map(); node.size = 0;
    if (parent) parent.children.set(name, node);
    return node;
  };
  const operations = {
    getattr(node) {
      return { dev: 2, ino: node.id, mode: node.mode, nlink: 1, uid: 0, gid: 0, rdev: 0, size: node.size,
        atime: new Date(0), mtime: new Date(0), ctime: new Date(0), blksize: blockSize, blocks: node.blocks.size * 128 };
    },
    setattr(node, attr) {
      if (attr.mode !== undefined) node.mode = attr.mode;
      if (attr.size !== undefined) {
        if (attr.size === 0) release(node);
        else if (attr.size < node.size) {
          for (const [index, block] of node.blocks) if (index * blockSize >= attr.size) { free.push(block); node.blocks.delete(index); }
          const tail = attr.size % blockSize, block = node.blocks.get(Math.floor(attr.size / blockSize));
          if (tail && block !== undefined) access.write(new Uint8Array(blockSize - tail), { at: block + tail });
        }
        node.size = attr.size;
      }
    },
    lookup(parent, name) { return parent.children.get(name) || errno(44); },
    mknod(parent, name, mode) { return create(parent, name, mode); },
    rename(node, parent, name) {
      const existing = parent.children.get(name);
      if (existing && FS.isDir(existing.mode) && existing.children.size) errno(55);
      if (existing && existing !== node) discard(existing);
      node.parent.children.delete(node.name); node.parent = parent; node.name = name;
      parent.children.set(name, node);
    },
    unlink(parent, name) { const node = parent.children.get(name); parent.children.delete(name); if (node) discard(node); },
    rmdir(parent, name) {
      if (parent.children.get(name)?.children.size) errno(55);
      parent.children.delete(name);
    },
    readdir(node) { return ['.', '..', ...node.children.keys()]; },
  };
  const streams = {
    open(stream) { stream.node.opens = (stream.node.opens || 0) + 1; },
    close(stream) { if (--stream.node.opens === 0 && stream.node.deleted) release(stream.node); },
    llseek(stream, offset, whence) {
      const position = whence === 1 ? stream.position + offset : whence === 2 ? stream.node.size + offset : offset;
      if (!Number.isSafeInteger(position) || position < 0) errno(28);
      return position;
    },
    read(stream, buffer, offset, length, position) {
      const count = Math.max(0, Math.min(length, stream.node.size - position));
      buffer.fill(0, offset, offset + count);
      for (let done = 0; done < count;) {
        const at = position + done, index = Math.floor(at / blockSize), inner = at % blockSize;
        const size = Math.min(count - done, blockSize - inner), block = stream.node.blocks.get(index);
        if (block !== undefined) access.read(buffer.subarray(offset + done, offset + done + size), { at: block + inner });
        done += size;
      }
      return count;
    },
    write(stream, buffer, offset, length, position) {
      for (let done = 0; done < length;) {
        const at = position + done, index = Math.floor(at / blockSize), inner = at % blockSize;
        const size = Math.min(length - done, blockSize - inner);
        if (!stream.node.blocks.has(index)) {
          const block = free.length ? free.pop() : nextBlock;
          if (block === nextBlock) nextBlock += blockSize;
          access.write(new Uint8Array(blockSize), { at: block });
          stream.node.blocks.set(index, block);
        }
        const written = access.write(buffer.subarray(offset + done, offset + done + size), { at: stream.node.blocks.get(index) + inner });
        if (written !== size) throw new Error('Incomplete OPFS shader scratch write');
        done += size;
      }
      stream.node.size = Math.max(stream.node.size, position + length);
      return length;
    },
  };
  FS.mkdirTree(mountpoint);
  FS.mount({ mount: () => create(null, '/', 0o40700) }, {}, mountpoint);
  return { close() { try { FS.unmount(mountpoint); } finally { access.close(); } }, bytes: () => nextBlock, stats: access.stats };
}

export async function directoryFiles(directory, progress = () => {}, prefix = '') {
  const files = [];
  const entries = [];
  for await (const entry of directory.values()) entries.push(entry);
  entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  for (const handle of entries) {
    const name = prefix + handle.name;
    if (handle.kind === 'directory') files.push(...await directoryFiles(handle, progress, name + '/'));
    else {
      files.push({ name, file: await handle.getFile() });
      progress({ stage: 'index', file: name });
    }
  }
  return files;
}

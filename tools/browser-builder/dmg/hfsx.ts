import { BLOCK, NODE, fork, u64, utf16, view } from "./binary";
import { hfsName, hfsPath } from "./names";
import type { DmgEntry, DmgOptions } from "./types";

interface Item {
  path: string; name: string; id: number; parent: number; directory: boolean;
  mode: number; size: number; start: number; blocks: number; children: number; subfolders: number;
  source?: DmgEntry; explicit: boolean; finderFlags?: number;
}
interface Record { parent: number; name: string; key: Uint8Array; data: () => Uint8Array; length: number }
interface TreeNode { id: number; height: number; records: Record[]; previous: number; next: number }
interface Tree { nodes: TreeNode[]; root: number; first: number; last: number; records: number; height: number }
export interface DmgPlan {
  volumeName: string; volumeBytes: number; metadataBytes: number; fileCount: number;
  /** Internal layout is exported for inspection, but must not be mutated. */
  readonly items: readonly Item[];
  readonly tree: Tree;
  readonly bitmapBlocks: number; readonly catalogStart: number; readonly dataStart: number;
  readonly usedEnd: number; readonly totalBlocks: number; readonly time: number;
}
function key(parent: number, name: string) {
  const b = new Uint8Array(8 + name.length * 2), v = view(b);
  v.setUint16(0, b.length - 2); v.setUint32(2, parent); utf16(b, 6, name); return b;
}
function itemData(item: Item, time: number) {
  const b = new Uint8Array(item.directory ? 88 : 248), v = view(b);
  v.setUint16(0, item.directory ? 1 : 2); v.setUint16(2, item.directory ? 0x10 : 2);
  if (item.directory) { v.setUint32(4, item.children); v.setUint32(84, item.subfolders); }
  v.setUint32(8, item.id);
  for (const at of [12, 16, 20, 24]) v.setUint32(at, time);
  v.setUint32(32, 99); v.setUint32(36, 99);
  v.setUint16(42, (item.directory ? 0o040000 : 0o100000) | item.mode);
  // HFSPlusCatalog{Folder,File}.userInfo (48) + Finder flags (8), big-endian.
  if (item.finderFlags) v.setUint16(56, item.finderFlags);
  // Finder treats .app directories as bundles by extension.
  if (!item.directory) fork(b, 88, item.size, item.start, item.blocks);
  return b;
}
function recordsFor(items: Item[], time: number): Record[] {
  const records: Record[] = [];
  for (const item of items) {
    const k = key(item.parent, item.name);
    records.push({ parent: item.parent, name: item.name, key: k, data: () => itemData(item, time), length: k.length + (item.directory ? 88 : 248) });
    const tk = key(item.id, "");
    records.push({ parent: item.id, name: "", key: tk, length: tk.length + 10 + item.name.length * 2, data: () => {
      const b = new Uint8Array(10 + item.name.length * 2), v = view(b);
      v.setUint16(0, item.directory ? 3 : 4); v.setUint32(4, item.parent); utf16(b, 8, item.name); return b;
    } });
  }
  return records.sort((a, b) => a.parent - b.parent || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
function buildTree(records: Record[]): Tree {
  const nodes: TreeNode[] = [];
  let current = records, height = 1, first = 0, last = 0;
  while (true) {
    const level: TreeNode[] = [];
    let group: Record[] = [], occupied = 16;
    const flush = () => {
      if (!group.length) return;
      const node = { id: nodes.length + 1, height, records: group, previous: 0, next: 0 };
      const prev = level.at(-1);
      if (prev) { prev.next = node.id; node.previous = prev.id; }
      nodes.push(node); level.push(node); group = []; occupied = 16;
    };
    for (const r of current) {
      if (occupied + r.length + 2 > NODE) flush();
      group.push(r); occupied += r.length + 2;
    }
    flush();
    if (height === 1) { first = level[0].id; last = level.at(-1)!.id; }
    if (level.length === 1) return { nodes, root: level[0].id, first, last, records: records.length, height };
    current = level.map(n => {
      const r = n.records[0];
      return { ...r, length: r.key.length + 4, data: () => { const b = new Uint8Array(4); view(b).setUint32(0, n.id); return b; } };
    });
    height++;
  }
}

export function planDmg(entries: readonly DmgEntry[], options: DmgOptions = {}): DmgPlan {
  if (entries.length > 100000) throw Error("At most 100000 input entries are supported");
  const volumeName = hfsName(options.volumeName ?? "Browser Build");
  const time = (options.timestamp ?? Math.floor(Date.now() / 1000)) + 2082844800;
  if (!Number.isInteger(time) || time < 0 || time > 0xffffffff) throw Error("Timestamp outside HFS range (1904-2040)");
  const root: Item = { path: "", name: volumeName, id: 2, parent: 1, directory: true, mode: 0o755, size: 0, start: 0, blocks: 0, children: 0, subfolders: 0, explicit: true };
  const items = [root], map = new Map([["", root]]);
  function insert(path: string, entry?: DmgEntry): Item {
    const prior = map.get(path);
    if (prior) {
      if (entry) {
        if (!prior.directory || entry.type !== "directory") throw Error(`Duplicate or directory conflict: ${path}`);
        if (prior.explicit) throw Error(`Duplicate entry: ${path}`);
        prior.mode = entry.mode & 0o777; prior.explicit = true;
      }
      return prior;
    }
    const split = path.lastIndexOf("/"), parentPath = split < 0 ? "" : path.slice(0, split);
    const parent = insert(parentPath);
    if (!parent.directory) throw Error(`Parent is not a directory: ${parentPath}`);
    const directory = !entry || entry.type === "directory";
    const item: Item = { path, name: path.slice(split + 1), id: 16 + items.length - 1, parent: parent.id, directory,
      mode: entry ? entry.mode & 0o777 : 0o755, size: entry?.size ?? 0, start: 0,
      blocks: directory ? 0 : Math.ceil(entry!.size / BLOCK), children: 0, subfolders: 0, source: entry, explicit: !!entry };
    parent.children++; if (directory) parent.subfolders++; items.push(item); map.set(path, item);
    if (items.length > 100000) throw Error("At most 100000 catalog objects are supported");
    return item;
  }
  for (const entry of entries) {
    if (entry.type !== undefined && entry.type !== "file" && entry.type !== "directory") throw Error("Unsupported entry type");
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > (0xffffffff - 4096) * BLOCK) throw Error("Invalid or excessive file size");
    const typeBits = entry.mode & 0o170000;
    if (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o170777 || (entry.mode & ~0o170777) || (typeBits && typeBits !== (entry.type === "directory" ? 0o040000 : 0o100000))) throw Error("Unsupported mode or file type");
    if (entry.type === "directory" ? entry.size !== 0 || !!entry.open : typeof entry.open !== "function") throw Error("Files need open(); directories must have zero size and no payload");
    // Item snapshots layout metadata; retain the caller's entry for completion callbacks.
    insert(hfsPath(entry.path), entry);
  }
  const volumeIcon = map.get(".VolumeIcon.icns");
  if (volumeIcon && !volumeIcon.directory) {
    root.finderFlags = 0x0400; // kHasCustomIcon (Finder.h)
    volumeIcon.finderFlags = 0x4000; // kIsInvisible
  }
  const tree = buildTree(recordsFor(items, time));
  // Header map covers all nodes. Reject instead of silently emitting a bad tree.
  if (tree.nodes.length + 1 > (NODE - 256) * 8) throw Error("Catalog too large for the supported B-tree allocation map");
  const payloadBlocks = items.reduce((n, f) => n + f.blocks, 0);
  const catalogBlocks = (tree.nodes.length + 1) * NODE / BLOCK;
  let totalBlocks = Math.max(2048, 1 + 1 + catalogBlocks + payloadBlocks + 256 + 1);
  let bitmapBlocks = 0;
  while (true) {
    const needed = Math.ceil(totalBlocks / 8 / BLOCK);
    if (needed === bitmapBlocks) break;
    totalBlocks += needed - bitmapBlocks; bitmapBlocks = needed;
  }
  if (totalBlocks > 0xffffffff) throw Error("Volume exceeds HFS 32-bit allocation block limit");
  const catalogStart = 1 + bitmapBlocks + 1, dataStart = catalogStart + catalogBlocks;
  let next = dataStart;
  for (const item of items) if (item.blocks) { item.start = next; next += item.blocks; }
  return { volumeName, volumeBytes: totalBlocks * BLOCK, metadataBytes: dataStart * BLOCK,
    fileCount: items.filter(x => !x.directory).length, items, tree, bitmapBlocks, catalogStart, dataStart,
    usedEnd: next, totalBlocks, time };
}

export function volumeHeader(p: DmgPlan): Uint8Array {
  const b = new Uint8Array(512), v = view(b);
  v.setUint16(0, 0x4858); v.setUint16(2, 5); v.setUint32(4, 1 << 8); v.setUint32(8, 0x42545331); // BTS1 writer
  v.setUint32(16, p.time); v.setUint32(20, p.time); v.setUint32(28, p.time);
  v.setUint32(32, p.fileCount); v.setUint32(36, p.items.length - p.fileCount - 1);
  v.setUint32(40, BLOCK); v.setUint32(44, p.totalBlocks); v.setUint32(48, p.totalBlocks - p.usedEnd - 1);
  v.setUint32(52, p.usedEnd); v.setUint32(56, BLOCK); v.setUint32(60, BLOCK);
  v.setUint32(64, p.items.length + 15); v.setUint32(68, 1); u64(v, 72, 1);
  // Deterministic nonzero volume ID, not a filesystem path or machine ID.
  v.setUint32(104, 0x42545331); v.setUint32(108, p.time);
  fork(b, 112, Math.ceil(p.totalBlocks / 8), 1, p.bitmapBlocks);
  fork(b, 192, BLOCK, 1 + p.bitmapBlocks, 1);
  fork(b, 272, (p.tree.nodes.length + 1) * NODE, p.catalogStart, (p.tree.nodes.length + 1) * NODE / BLOCK);
  return b;
}
export function bitmap(p: DmgPlan): Uint8Array {
  const b = new Uint8Array(p.bitmapBlocks * BLOCK);
  b.fill(255, 0, Math.floor(p.usedEnd / 8));
  for (let i = Math.floor(p.usedEnd / 8) * 8; i < p.usedEnd; i++) b[i >>> 3] |= 0x80 >>> (i & 7);
  const final = p.totalBlocks - 1; b[final >>> 3] |= 0x80 >>> (final & 7);
  return b;
}
export function treeHeader(nodeSize: number, tree?: Tree): Uint8Array {
  const b = new Uint8Array(nodeSize), v = view(b), total = tree ? tree.nodes.length + 1 : 1;
  b[8] = 1; v.setUint16(10, 3);
  v.setUint16(14, tree?.height ?? 0); v.setUint32(16, tree?.root ?? 0);
  v.setUint32(20, tree?.records ?? 0); v.setUint32(24, tree?.first ?? 0); v.setUint32(28, tree?.last ?? 0);
  v.setUint16(32, nodeSize); v.setUint16(34, tree ? 516 : 10); v.setUint32(36, total);
  v.setUint32(46, nodeSize); b[51] = tree ? 0xbc : 0; v.setUint32(52, tree ? 6 : 2);
  for (let i = 0; i < total; i++) b[248 + (i >>> 3)] |= 0x80 >>> (i & 7);
  for (const [i, offset] of [14, 120, 248, nodeSize - 8].entries()) v.setUint16(nodeSize - 2 * (i + 1), offset);
  return b;
}
export function treeNode(n: TreeNode): Uint8Array {
  const b = new Uint8Array(NODE), v = view(b);
  v.setUint32(0, n.next); v.setUint32(4, n.previous); b[8] = n.height === 1 ? 255 : 0; b[9] = n.height;
  v.setUint16(10, n.records.length);
  let at = 14;
  n.records.forEach((r, i) => {
    v.setUint16(NODE - (i + 1) * 2, at); b.set(r.key, at); at += r.key.length;
    const data = r.data(); b.set(data, at); at += data.length;
  });
  v.setUint16(NODE - (n.records.length + 1) * 2, at); return b;
}

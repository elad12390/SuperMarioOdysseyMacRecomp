import { join, text, uint, utf16 } from './binary';

type Value = string | number | boolean | Uint8Array | { [key: string]: Value };
const width = (n: number) => n <= 255 ? 1 : n <= 65535 ? 2 : 4;
const integer = (n: number) => { const size = width(n); return join([Uint8Array.of(0x10 + Math.log2(size)), uint(n, size)]); };
const length = (kind: number, n: number) => n < 15 ? Uint8Array.of(kind | n) : join([Uint8Array.of(kind | 15), integer(n)]);

/** The small property-list subset used by Finder's bwsp/icvp dictionaries. */
export function binaryPlist(value: Value): Uint8Array<ArrayBuffer> {
  const objects: (() => Uint8Array)[] = [];
  let refSize = 1;
  const refs = (ids: number[]) => join(ids.map(id => uint(id, refSize)));
  function add(item: Value): number {
    const id = objects.length; objects.push(() => new Uint8Array());
    let encode: () => Uint8Array;
    if (typeof item === 'boolean') encode = () => Uint8Array.of(item ? 9 : 8);
    else if (typeof item === 'string') {
      const ascii = /^[\x00-\x7f]*$/.test(item), bytes = ascii ? text(item) : utf16(item);
      encode = () => join([length(ascii ? 0x50 : 0x60, item.length), bytes]);
    } else if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw Error('Invalid Finder property-list number.');
      if (Number.isSafeInteger(item) && item >= 0) encode = () => integer(item);
      else { const bytes = new Uint8Array(9); bytes[0] = 0x23; new DataView(bytes.buffer).setFloat64(1, item); encode = () => bytes; }
    } else if (item instanceof Uint8Array) encode = () => join([length(0x40, item.length), item]);
    else {
      const entries = Object.entries(item), keys = entries.map(([key]) => add(key)), values = entries.map(([, value]) => add(value));
      encode = () => join([length(0xd0, entries.length), refs(keys), refs(values)]);
    }
    objects[id] = encode; return id;
  }
  const top = add(value); refSize = width(objects.length - 1);
  const chunks: Uint8Array[] = [text('bplist00')], offsets: number[] = []; let at = 8;
  for (const encode of objects) { const bytes = encode(); offsets.push(at); chunks.push(bytes); at += bytes.length; }
  const offsetSize = width(at), offsetTable = at;
  chunks.push(join(offsets.map(offset => uint(offset, offsetSize))));
  const trailer = new Uint8Array(32); trailer[6] = offsetSize; trailer[7] = refSize;
  trailer.set(uint(objects.length, 8), 8); trailer.set(uint(top, 8), 16); trailer.set(uint(offsetTable, 8), 24);
  chunks.push(trailer); return join(chunks);
}

import { join, text, uint, utf16 } from './binary';

export interface BackgroundTarget { path: string; cnid: number; parentCnid: number; parentIds?: readonly number[] }

/** Version-2 AliasRecord for a file whose identity is known before the HFSX image is written. */
export function backgroundAlias(input: BackgroundTarget & { volumeName: string; hfsTime: number }): Uint8Array<ArrayBuffer> {
  const { volumeName, path, cnid, parentCnid, hfsTime } = input, names = path.split('/');
  if (!volumeName || /[\0/:]/.test(volumeName) || !names.length || /[\0\\:]/.test(path) || names.some(name => !name || name === '.' || name === '..')) throw Error('Invalid installer background path or volume name.');
  const parentIds = input.parentIds ?? [parentCnid];
  for (const n of [cnid, parentCnid, hfsTime, ...parentIds]) if (!Number.isInteger(n) || n < 2 || n > 0xffffffff) throw Error('Invalid installer file identity.');
  const filename = names.at(-1)!, folder = names.at(-2) ?? volumeName, header = new Uint8Array(150), view = new DataView(header.buffer);
  function pascal(at: number, size: number, value: string) { const bytes = text(value).subarray(0, size - 1); header[at] = bytes.length; header.set(bytes, at + 1); }
  view.setUint16(6, 2); pascal(10, 28, volumeName); view.setUint32(38, hfsTime);
  header.set(text('H+'), 42); view.setUint32(46, parentCnid); pascal(50, 64, filename);
  view.setUint32(114, cnid); view.setUint32(118, hfsTime); view.setInt16(130, -1); view.setInt16(132, -1);
  const chunks: Uint8Array[] = [header];
  function tag(id: number, bytes: Uint8Array) { chunks.push(uint(id, 2), uint(bytes.length, 2), bytes); if (bytes.length & 1) chunks.push(Uint8Array.of(0)); }
  tag(0, text(folder));
  tag(16, uint(BigInt(hfsTime) * 65536n, 8)); tag(17, uint(BigInt(hfsTime) * 65536n, 8));
  tag(1, join(parentIds.map(id => uint(id, 4)))); tag(2, text(volumeName + ':' + names.join(':\0')));
  tag(14, join([uint(filename.length, 2), utf16(filename)]));
  tag(15, join([uint(volumeName.length, 2), utf16(volumeName)]));
  tag(18, text('/' + path)); tag(19, text('/Volumes/' + volumeName));
  chunks.push(Uint8Array.of(255, 255, 0, 0));
  const bytes = join(chunks);
  if (bytes.length > 32767) throw Error('Installer alias is too large.');
  view.setUint16(4, bytes.length); bytes.set(header); return bytes;
}

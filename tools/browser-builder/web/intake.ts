export type Inputs = { nsp?: File; prodKeys?: File; titleKeys?: File };
export type NspEntry = { name: string; offset: number; size: number };

export function classifyInputs(files: Iterable<File>): Inputs {
  const result: Inputs = {};
  for (const file of files) {
    const name = file.name.toLowerCase();
    const kind = name.endsWith('.nsp') ? 'nsp' : name === 'prod.keys' ? 'prodKeys' : name === 'title.keys' ? 'titleKeys' : null;
    if (!kind) throw new Error('Choose a base-game .nsp, prod.keys, and optionally title.keys.');
    if (result[kind]) throw new Error(`Choose only one ${kind === 'nsp' ? 'base-game NSP' : file.name}.`);
    result[kind] = file;
  }
  return result;
}

// Read only the PFS0 metadata. The game payload stays in the original File and
// is accessed in bounded slices by the extraction worker.
export async function inspectNsp(file: File): Promise<NspEntry[]> {
  const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  if (header.length !== 16 || new TextDecoder().decode(header.subarray(0, 4)) !== 'PFS0') {
    throw new Error('The selected .nsp is incomplete or invalid (PFS0). Choose a complete base-game 1.0.0 dump and try again.');
  }
  const view = new DataView(header.buffer);
  const count = view.getUint32(4, true), stringsSize = view.getUint32(8, true);
  const metadataSize = count * 24 + stringsSize;
  if (!count || count > 100_000 || metadataSize > 64 * 1024 * 1024 || 16 + metadataSize > file.size) {
    throw new Error('The NSP metadata is invalid or truncated. Copy the complete dump and try again.');
  }
  const metadata = new Uint8Array(await file.slice(16, 16 + metadataSize).arrayBuffer());
  const entriesView = new DataView(metadata.buffer);
  const names = metadata.subarray(count * 24);
  const payload = 16 + metadataSize;
  const entries: NspEntry[] = [], seen = new Set<string>();
  for (let i = 0; i < count; i++) {
    const relative = entriesView.getBigUint64(i * 24, true), size = entriesView.getBigUint64(i * 24 + 8, true);
    const nameOffset = entriesView.getUint32(i * 24 + 16, true), end = names.indexOf(0, nameOffset);
    if (nameOffset >= names.length || end < 0 || relative + size > BigInt(file.size - payload)) {
      throw new Error('The NSP is truncated or contains an invalid file entry. Copy the complete dump and try again.');
    }
    const name = new TextDecoder('utf-8', { fatal: true }).decode(names.subarray(nameOffset, end));
    if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..' || seen.has(name)) {
      throw new Error('The NSP contains an invalid or duplicate file name.');
    }
    seen.add(name);
    entries.push({ name, offset: payload + Number(relative), size: Number(size) });
  }
  const ordered = [...entries].sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i - 1]!.offset + ordered[i - 1]!.size > ordered[i]!.offset) throw new Error('The NSP contains overlapping file entries.');
  }
  if (!entries.some(entry => entry.name.toLowerCase().endsWith('.nca'))) throw new Error('The NSP contains no NCA game content.');
  return entries;
}

export async function validateKeyFile(file: File): Promise<void> {
  if (file.size > 1024 * 1024) throw new Error('The key file is too large; choose the plain-text prod.keys file.');
  const text = await file.text();
  const fields = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const clean = line.replace(/#.*/, '').trim();
    if (!clean) continue;
    const match = /^([a-z0-9_]+)\s*=\s*([a-f0-9]+)$/i.exec(clean);
    if (!match || match[2]!.length % 2) throw new Error('The key file is not a valid plain-text Switch key file.');
    fields.set(match[1]!.toLowerCase(), match[2]!);
  }
  if (file.name.toLowerCase() === 'prod.keys' && fields.get('header_key')?.length !== 64) {
    throw new Error('prod.keys must contain a valid 32-byte header_key.');
  }
  if (!fields.size) throw new Error('The key file is empty.');
}

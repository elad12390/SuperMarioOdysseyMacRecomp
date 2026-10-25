import { createSHA256 } from 'hash-wasm';
import { entryFromBlob, type DmgEntry } from '../dmg';

export type BrowserProvenanceInput = {
  nsp: File;
  extraction: { titleId: string; version: string; mainBuildId: string };
  rewriter: {
    provenance: {
      nxnativeRevision: string; odysseyPatchSha256: string;
      pyodide: string; emscripten: string; capstone: string; lz4: string;
    };
    modules: readonly { name: string; buildId: string; inputSize: number }[];
  };
  shaderChain: string;
  runtimeSource: { repository: string; commit: string; patches?: Readonly<Record<string, string>> };
};

export type ProvenanceProgress = {
  phase: 'hash' | 'complete'; hashedBytes: number; totalBytes: number; fraction: number;
};

function quoted(value: string, field: string): string {
  if (typeof value !== 'string' || !value.length || value.length > 8192)
    throw new Error(`Invalid browser provenance field: ${field}`);
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) throw new Error(`Invalid Unicode in provenance field: ${field}`);
  }
  // JSON basic-string escapes also work in TOML; DEL additionally needs escaping.
  return JSON.stringify(value).replace(/\u007f/g, '\\u007f');
}

function hex(value: string, lengths: readonly number[], field: string): string {
  if (typeof value !== 'string' || !lengths.includes(value.length) || !/^[a-f0-9]+$/i.test(value))
    throw new Error(`Invalid browser provenance identifier: ${field}`);
  return value.toLowerCase();
}

function size(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid browser provenance size: ${field}`);
  return value;
}

/** Local generated-game resource. Append before sealApp; never add to public tool assets.
 * Only explicit metadata fields are serialized. Key files are not inputs to this API.
 */
export async function generateBrowserProvenance(
  input: BrowserProvenanceInput,
  signal?: AbortSignal,
  progress: (event: ProvenanceProgress) => void = () => {},
): Promise<DmgEntry> {
  signal?.throwIfAborted();
  const { nsp, extraction, rewriter, runtimeSource } = input;
  if (!(nsp instanceof File)) throw new Error('Browser provenance requires the selected local NSP File.');
  const totalBytes = size(nsp.size, 'input.size_bytes');
  const filename = quoted(nsp.name, 'input.filename');
  const game = [
    '[game]',
    `title_id = "${hex(extraction.titleId, [16], 'game.title_id')}"`,
    `version = ${quoted(extraction.version, 'game.version')}`,
    `main_build_id = "${hex(extraction.mainBuildId, [32, 64], 'game.main_build_id')}"`,
  ];
  const fields = rewriter.provenance;
  const rewrite = [
    '[rewriter]',
    `nxnative_revision = "${hex(fields.nxnativeRevision, [40], 'rewriter.nxnative_revision')}"`,
    `odyssey_patch_sha256 = "${hex(fields.odysseyPatchSha256, [64], 'rewriter.odyssey_patch_sha256')}"`,
    ...(['pyodide', 'emscripten', 'capstone', 'lz4'] as const).map(name => `${name} = ${quoted(fields[name], `rewriter.${name}`)}`),
  ];
  if (!Array.isArray(rewriter.modules) || !rewriter.modules.length || rewriter.modules.length > 64)
    throw new Error('Invalid browser provenance module list.');
  const names = new Set<string>();
  const modules = rewriter.modules.flatMap(module => {
    if (typeof module.name !== 'string' || !/^[a-z0-9_][a-z0-9_.-]{0,79}$/i.test(module.name) || names.has(module.name))
      throw new Error('Invalid or duplicate browser provenance module.');
    names.add(module.name);
    return ['', '[[modules]]', `name = ${quoted(module.name, 'module.name')}`,
      `build_id = "${hex(module.buildId, [32, 64], 'module.build_id')}"`,
      `input_size_bytes = ${size(module.inputSize, 'module.input_size_bytes')}`];
  });
  const chain = quoted(input.shaderChain, 'shaders.chain');
  const repository = new URL(runtimeSource.repository);
  if (repository.protocol !== 'https:' || repository.username || repository.password || repository.search || repository.hash)
    throw new Error('Runtime provenance requires a public HTTPS source URL without credentials or query parameters.');
  const runtime = ['[runtime]', `repository = ${quoted(repository.href, 'runtime.repository')}`,
    `commit = "${hex(runtimeSource.commit, [40], 'runtime.commit')}"`];
  const patches = Object.entries(runtimeSource.patches ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (patches.length > 128) throw new Error('Too many runtime provenance patches.');
  if (patches.length) runtime.push('', '[runtime.patches]');
  for (const [path, digest] of patches) {
    if (/[\\\x00-\x1f\x7f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..'))
      throw new Error('Invalid runtime provenance patch path.');
    runtime.push(`${quoted(path, 'runtime.patch.path')} = "${hex(digest, [64], 'runtime.patch.sha256')}"`);
  }

  const report = (phase: ProvenanceProgress['phase'], hashedBytes: number) => {
    progress({ phase, hashedBytes, totalBytes, fraction: totalBytes ? hashedBytes / totalBytes : 1 });
    signal?.throwIfAborted();
  };
  report('hash', 0);
  const hash = await createSHA256();
  signal?.throwIfAborted();
  hash.init();
  const chunkSize = 1024 * 1024;
  for (let offset = 0; offset < totalBytes;) {
    signal?.throwIfAborted();
    const end = Math.min(offset + chunkSize, totalBytes);
    const bytes = new Uint8Array(await nsp.slice(offset, end).arrayBuffer());
    signal?.throwIfAborted();
    if (bytes.length !== end - offset) throw new Error('The selected NSP could not be read completely for provenance.');
    hash.update(bytes); offset = end;
    report('hash', offset);
    if (offset % (16 * chunkSize) === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  signal?.throwIfAborted();
  const sha256 = hex(hash.digest('hex'), [64], 'input.sha256');
  const text = [
    'schema_version = 1', 'asset_scope = "local-generated-game-output"', 'conversion = "browser-wasm"', '',
    '[input]', 'source = "user-selected-local-file"', `filename = ${filename}`,
    `size_bytes = ${totalBytes}`, `sha256 = "${sha256}"`, '',
    ...game, '', ...rewrite, ...modules, '', '[shaders]', `chain = ${chain}`, '', ...runtime, '',
  ].join('\n');
  const entry = entryFromBlob('Super Mario Odyssey.app/Contents/Resources/game/provenance.toml', new Blob([text], { type: 'text/plain;charset=utf-8' }));
  report('complete', totalBytes);
  return entry;
}

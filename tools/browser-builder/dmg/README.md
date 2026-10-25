# Browser HFSX + UDIF writer

Independent disk-image stage for the browser-only builder. Integration API:
`writeDmg(entries, sink, options)` and `writeDmgToOpfs(entries, directory, name,
options)`. Files are opened only when their extent is being written. The output
is an unpartitioned, case-sensitive HFS+ (HFSX v5) volume in an uncompressed UDIF
container. It has real BSD mode bits and no FAT32 4 GiB per-file restriction.

Native fixtures and the static browser test server are test infrastructure only.
The image-writing module itself imports no Node or Bun API. It works in a static
website worker, with OPFS and user-selected File/Blob inputs.

## API

```ts
import { entryFromBlob, writeDmgToOpfs } from "./dmg/index";

// Inside a dedicated worker; compiledExecutable and infoPlist are File/Blob
// objects from earlier LOCAL browser pipeline stages.
const root = await navigator.storage.getDirectory();
const job = await root.getDirectoryHandle(crypto.randomUUID(), { create: true });
const result = await writeDmgToOpfs([
  entryFromBlob("Game.app/Contents/MacOS/Game", compiledExecutable, 0o755),
  entryFromBlob("Game.app/Contents/Info.plist", infoPlist),
  // Add every runtime library, asset and signature file here.
], job, "Game.dmg", {
  volumeName: "Game",
  signal: abortController.signal,
  onProgress: ({ writtenBytes, volumeBytes, path }) => {
    postMessage({ writtenBytes, volumeBytes, path });
  },
});
postMessage({ ready: true, file: await result.file.getFile() });
// Main thread: URL.createObjectURL(file), then <a download="Game.dmg">.
```

For a WASM filesystem, provide entries directly:

```ts
type DmgEntry = {
  path: string;       // relative slash-separated path
  size: number;       // safe integer; does NOT have a 32-bit file-size limit
  mode: number;       // e.g. 0o755 or 0o100755
  type?: "file" | "directory";
  open?: () => Promise<{
    read(target: Uint8Array): Promise<number> | number;
    close?(): Promise<void> | void;
  }> | {
    read(target: Uint8Array): Promise<number> | number;
    close?(): Promise<void> | void;
  };
};
```

`read` fills the supplied bounded buffer and returns the byte count; 0 means EOF.
Partial reads are valid. The writer verifies the declared length and checks for
extra bytes, and closes each opened reader in a finally block. No source is
opened during `planDmg(entries, options)` preflight. Directories are implicit by
default; explicit directories have type `directory`, size 0 and no `open`.

`writeDmg(entries, { write(bytes) }, options)` accepts any sequential sink. Every
write is awaited; the sink must consume/copy its bytes before resolving because
the chunk is reused. This core function does not close or abort a caller-owned
sink. The OPFS wrapper owns its sync handle, flushes/closes on success and removes
incomplete output on error/cancel. It refuses an existing filename. Supply an
exclusive job directory and a unique output name; concurrent writers must never
share that destination. An abruptly terminated worker requires the caller to
remove its abandoned job directory after its handles are released.

`chunkSize` defaults to 1 MiB (allowed: 4 KiB through 8 MiB). Payload memory is
bounded by chunks; metadata scales with file count plus one bitmap bit per 4 KiB
volume block. The current cap is 100,000 catalog objects and 2^32-1 allocation
blocks (just under 16 TiB). `metadataBytes` describes the filesystem metadata's
on-disk span, not JavaScript heap consumption. Catalog index levels are generated
as needed. The writer yields to the worker event loop every 16 MiB so cancellation
messages can run even when WASM readers and OPFS writes are synchronous.

`inspectDmg({ size, read(offset, size) })` validates this writer's UDIF profile,
CRC32 checksums and matching volume headers using bounded reads. It is not a
general filesystem repair tool; macOS fsck supplies independent catalog/extent
validation. CRC32 detects corruption and is not an authenticity signature.

## Format and integration limits

- HFSX is genuine case-sensitive HFS+. This avoids importing a case-folding
  implementation and preserves executable permissions and files over 4 GiB.
  Case-only name pairs can exist on the image; callers targeting a normal
  case-insensitive APFS destination should avoid such collisions in app bundles.
- Files and directories only. Symlinks, hard links, resource forks and xattrs are
  rejected/unsupported; flatten framework symlinks before packaging, and include
  normal signature files. Modes allow only normal rwx permissions (no setuid,
  devices or sockets). Names use frozen Unicode 3.2 decomposition with Apple's
  exclusions; decomposed names must fit 255 UTF-16 units. Traversal, empty path
  segments, colon, backslash and control characters are rejected.
- Output is an uncompressed single-volume, unpartitioned UDIF image. Space use is
  roughly payload rounded to 4 KiB per file, catalog metadata and about 1 MiB of
  free blocks. Browser storage/quota must also accommodate the source pipeline.
  The download method may require an additional image-sized copy on the user's
  disk; no multi-GB Blob/ArrayBuffer is constructed by the writer.
- The caller must provide a complete, already signed, relocatable app. This stage
  does not rewrite/compile game code or make an incomplete launcher standalone.
  The acceptance fixture is ad-hoc signed; Developer ID signing, notarization and
  Gatekeeper distribution acceptance belong to the release pipeline.

## Reproduce verification

From this directory:

```sh
bun install --frozen-lockfile
bun test ./test
bun run typecheck
/bin/zsh test/prepare-fixture.sh
bun run ./test/browser.ts
/bin/zsh test/verify-macos.sh small
bun run ./test/browser.ts --large
/bin/zsh test/verify-macos.sh large
bun run ./test/corrupt.ts
# Expected FAILURE, exit 1:
hdiutil verify ../../../tmp/odyssey/browser-dmg/downloads/corrupt-small.dmg
```

Run shell jobs in the background with PID/log/exit-status capture, as required
by the repository's machine instructions. Browser tests use puppeteer-core in a
separate headless-shell process and profiles under `tmp/odyssey/browser-dmg/`.
Set `BROWSER_DMG_HEADLESS_SHELL` to override its installed executable path. The
test server accepts only GET requests and serves original fixture/static bytes;
the output is made by the browser worker and downloaded from an OPFS-backed File.
No user browser, game assets, saves, credentials or Player installation is used.

Detailed outcomes and retained evidence are in [EVIDENCE.md](./EVIDENCE.md).

## Sources and dependencies

Format research uses [Apple TN1150](https://developer.apple.com/library/archive/technotes/tn/tn1150.html)
for volume headers, forks, B-trees, permissions and HFSX binary name comparison.
Modern HFSX subfolder-count flags and the catalog field at offset 84 follow
[Apple's current hfs_format.h](https://github.com/apple-oss-distributions/hfs/blob/main/core/hfs_format.h),
which extends the older TN1150 layout. A real fsck check covers these fields.
The HFS+ normalization version is frozen at Unicode 3.2, with Apple's exclusions;
JavaScript's evolving `String.normalize` is unsuitable for this format.

UDIF field layouts were cross-checked against the original parser/writer
definitions in [libdmg-hfsplus dmg.h](https://github.com/planetbeing/libdmg-hfsplus/blob/master/includes/dmg/dmg.h)
and [dmg2img dmg2img.h](https://github.com/Lekensteyn/dmg2img/blob/master/dmg2img.h).
No code from either project is incorporated. The latter is GPL-licensed and is
only a format reference. All online retrieval used Web Research Assistant MCP.

Runtime: no packages, WASM module, Node APIs or native binaries. Frozen Unicode
data is accompanied by its Unicode license. Original implementation: MIT, see
LICENSE. Unicode data: Unicode License v3, see UNICODE-LICENSE.txt. Regenerate it
with `uv run --no-project python test/generate-unicode.py` (CPython ucd_3_2_0).
Test-only packages are pinned in package.json and bun.lock: Bun types (MIT),
TypeScript (Apache-2.0) and puppeteer-core (Apache-2.0).
Chromium headless-shell is supplied by the machine, not bundled in the product.

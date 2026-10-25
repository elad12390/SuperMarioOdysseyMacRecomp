# Verified browser disk-image stage

Verified locally on Apple Silicon macOS on 2026-10-25. This is an independently
usable packaging stage, not evidence that the whole Odyssey browser conversion
pipeline is complete. No game inputs, Player installation or saves were used.
No commit, push, native image creation, native game test or distribution occurred.

## RED before GREEN

- `bun test ./test`: initial RED (module absent), recorded in
  `tmp/odyssey/browser-dmg/red.log`.
- Real macOS fsck found missing modern HFSX folder-count metadata and bits set
  beyond the volume's allocation bitmap. Added structural assertions first;
  `red-fsck.log` records RED before the corrections. Current fsck exits 0.
- `red-cancel.log` records a real timer cancellation test failing because a
  synchronous source/OPFS microtask chain starved worker events. Yielding every
  16 MiB fixed it; the same condition now passes in Bun and the browser worker.
- Final `bun test ./test`: **18 passed, 0 failed, 565 assertions**.
- Final `bun run typecheck` (`tsc --noEmit`): exit 0.

## Real browser output

Exact test commands, run from `tools/browser-builder/dmg/` with background
PID/log/status capture:

```sh
/bin/zsh test/prepare-fixture.sh
bun run ./test/browser.ts
bun run ./test/browser.ts --large
```

The harness launches the separate dedicated executable
`~/.cache/going-up-browsers/chrome-headless-shell/ext/chrome-headless-shell-mac-arm64/chrome-headless-shell`.
Observed version: **HeadlessChrome/154.0.8037.92**. A bundled copy of the same
portable writer runs in a dedicated module worker, writes sequentially into an
OPFS sync access handle, validates the output, and downloads an OPFS-backed File
using a browser Blob URL. No whole-image ArrayBuffer is constructed. The native
C executable is an original test fixture only, compiled with clang `-arch arm64`
and ad-hoc signed before browser packaging. The writer has no native dependency.

| Measurement | Small image | Large image |
| --- | ---: | ---: |
| DMG bytes | 8,394,084 | 4,303,324,516 |
| HFSX volume bytes | 8,392,704 | 4,303,323,136 |
| File count | 1,610 | 1,611 |
| On-disk metadata span | 528,384 | 659,456 |
| Image-writing time, excluding post-write validation/download | 308.5 ms | 10,122.9 ms |
| Sampled worker JS heap peak | 4,664,628 bytes | 7,252,556 bytes |
| Sampled worker backing-storage peak | 5,477,058 bytes | 5,542,783 bytes |
| CDP heap samples | 3 | 45 |

These are sampled `Runtime.getHeapUsage` measurements, not whole-process RSS or a
guaranteed memory ceiling. The large synthetic file is **4,294,967,333 bytes**
(4 GiB + 37). Its reader opens and closes once, makes 4,098 reads including EOF,
and never receives a buffer larger than **1,048,576 bytes**. Payload buffers are
reused by both writing and validation.

Both browser runs also exercise immediate cancellation, timer-driven mid-stream
cancellation of a synchronous source, and a truncated source. Each fails and
removes its partial OPFS output. No console errors occurred. The test server
received only six GET requests (HTML, worker bundle and four original fixture
files); output is downloaded directly from browser storage. No output upload or
native image-generation service is involved.

Raw measurements: `tmp/odyssey/browser-dmg/browser-small.json` and
`tmp/odyssey/browser-dmg/browser-large.json`. Logs, captured PIDs and exit status
files have the corresponding basename. The exact browser bundle remains at
`tmp/odyssey/browser-dmg/worker.js`.

## Independent macOS acceptance

```sh
/bin/zsh test/verify-macos.sh small
/bin/zsh test/verify-macos.sh large
```

Both scripts exit **0** and report `MACOS_ACCEPTANCE_OK`. They perform:

1. `hdiutil verify -verbose IMAGE`: valid data, block and master CRC32 checksums.
2. `hdiutil attach -readonly -nobrowse -noautoopen -mountpoint MOUNT -plist IMAGE`.
   `diskutil info` reports **Mac OS Extended (Case-sensitive)** and readonly media
   and volume flags. There is no partition-table requirement for this image.
3. `diskutil verifyVolume MOUNT`: macOS runs `fsck_hfs -fn -x`; catalog, extents,
   hierarchy, bitmap and volume checks all succeed, filesystem check exit **0**.
4. `stat`: main Mach-O mode **0755**, explicit empty directory mode **0750**.
5. `ditto`: copy app from the readonly image into another scratch directory.
   `codesign --verify --deep --strict --verbose=2` accepts the relocated app.
6. `otool -L`: fixture uses only `/usr/lib/libSystem.B.dylib`; no checkout or
   Homebrew library is needed. Running the relocated ARM64 program returns **0**
   and prints `browser-dmg-arm64-ok: browser-dmg-resource-ok`, having read its
   relative bundled resource. `cmp` confirms original executable/resource bytes.
7. All 1,600 catalog stress files are present, a late entry's content matches,
   and Latin decomposed, Angstrom-exclusion, Japanese, Hangul and emoji names
   resolve. Empty files and explicit directories are included.
8. Large variant: `stat` confirms **4,294,967,333 bytes** and `head`/`tail` confirm
   the exact 17-byte start/end markers. Both images are detached afterwards.

Evidence: `tmp/odyssey/browser-dmg/macos-small.log`, `macos-large.log`, and
`attach-small.plist` / `attach-large.plist`. No repair operation was used.

## Corruption negative check

`bun run test/corrupt.ts` flips one byte in the downloaded small image. The
TypeScript inspector rejects it with `UDIF checksum mismatch`. Then:

```sh
hdiutil verify ../../../tmp/odyssey/browser-dmg/downloads/corrupt-small.dmg
```

returns **1**, with **INVALID** / **invalid checksum**. The acceptance wrapper
records this expected failure as success in `tmp/odyssey/browser-dmg/corrupt.log`
and `corrupt.status`. The image is never mounted or repaired.

## Repository suite

From repository root:

```sh
CARGO_TARGET_DIR="$PWD/tmp/odyssey/browser-dmg/cargo-target" CARGO_INCREMENTAL=0 cargo test --offline
```

Exit **0**, **78 tests passed, 0 failed** across 24 unit/integration/doc-test
result groups. This is the existing synthetic workspace suite; no native game
test or Player launch was run. Log: `tmp/odyssey/browser-dmg/cargo-test.log`.

## Artifact hashes

SHA-256, also recorded in `tmp/odyssey/browser-dmg/SHA256SUMS`:

| Artifact | SHA-256 |
| --- | --- |
| browser-small.dmg | `f174844a08e7ad2f3c2dae63185c15e84f683c3a2414a67f4ab12cd01ffbd576` |
| browser-large.dmg | `50a5ec5995c942221387d8b7538e45b036e7372ac36878a48976c27afab2834e` |
| browser worker bundle | `ef4ca69d05df833f8b86d5cdf5d6abf232abd43801d090a3e319e7dfa062fd4b` |
| frozen Unicode data | `71e2417103701250832d7ea3c4003c585e7a1cf063142dd5d721f751547d49db` |

The implementation is MIT; the frozen Unicode data carries Unicode License v3.
Runtime has zero packages. Dev dependencies and their exact versions are pinned
in package.json/bun.lock. See README for primary format sources and API limits.

Owned duplicate OPFS browser profiles and Bun/uv download caches were removed
after verification. The temporary Cargo target (305 MiB, checked for its
CACHEDIR.TAG and debug directory) was removed; the existing root target remains
1.1 GiB. Retained downloads/evidence use about 4.0 GiB, primarily the deliberately
kept large DMG. `test/cleanup.ts` checks successful acceptance status and exact
owned cache paths before removal. Cleanup log: `tmp/odyssey/browser-dmg/cleanup.log`.

The initial instruction-read logs were mistakenly placed in two `/tmp/` scratch
directories; those exact directories were removed immediately. Project code,
dependencies, test images, profiles and subsequent logs stayed in the two allowed
scopes. The only modified/added source owned by this task is under `dmg/`; other
working-tree changes belong to concurrent/pre-existing work.

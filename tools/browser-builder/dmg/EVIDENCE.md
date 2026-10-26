# Verified browser disk-image stage

Verified locally on Apple Silicon macOS on 2026-10-25, with focused additions on
2026-10-26. The fixture-based module
checks below are independent packaging evidence. Their initial runs used no game
inputs, Player installation or saves. The subsequent full Firefox integration
uses private local game inputs; its scope and measurements are recorded in
[the browser release documentation](../../../docs/browser-release.md#firefox-disk-image-storage).
No native game or desktop window was launched for the storage regression.

## Bounded symlinks and Finder opening folder (2026-10-26)

Intent and Gherkin were updated before implementation. New tests ran RED:
`03-red.log` / exit 1 records the missing `entryFromSymlink` export;
`05-red-open-folder.log` / exit 1 records 14 failing real-writer tests:
field 2 was zero instead of the selected CNID, and invalid folders were accepted.
All paths in this section are relative to
`tmp/odyssey/dmg-layout/symlink-agent/`, with captured PID/log/exit files.

Final checks:

| Command from repository root | Result | Evidence |
| --- | --- | --- |
| `bun test ./tools/browser-builder/dmg/test` | 62 pass, 0 fail, 4888 assertions | `24-final-tests.log` |
| `bun run --cwd tools/browser-builder/dmg typecheck` | Exit 0 | `24-final-tests.log` |
| `bun run --cwd tools/browser-builder typecheck` | Exit 0 | `22-consumer-typecheck.log` |
| `bun run --cwd tools/browser-builder test` | 13 pass, 0 fail, 51 assertions | `16-builder-tests.log` |
| `bun tools/browser-builder/dmg/test/browser.ts --symlinks` | Exit 0, real worker and OPFS output | `11-browser-symlinks.log` |
| `bun tools/browser-builder/dmg/test/verify-symlinks-macos.ts` | Exit 0, MACOS_SYMLINK_ACCEPTANCE_OK | `19-final-native.log` |
| `git diff --check -- tools/browser-builder/dmg` | Exit 0 | `24-final-tests.log` |

The builder-wide typecheck passed earlier in `10-typecheck.log`. An intermediate
recheck in `18-final-tests.log` returned exit 2 after the DMG typecheck passed,
with five typed-array compatibility errors in concurrently added, out-of-scope
`installer/alias.ts:16`, `installer/layout.ts:20,24`, and
`installer/plist.ts:33,35`. This task did not edit those files. The final shared
consumer recheck in `22-consumer-typecheck.log` passed, exit 0.

The existing complete-image no-icon/no-link fixed-timestamp SHA-256 regression
still passes:
`0ef402b6797dbb14e0ce2150d6134928c48278d160b28f07e995c3b838b0ac76`.
A final exact-byte regression (`23-red-bom.log`, exit 1) caught default UTF-8
TextDecoder BOM stripping during target validation. Preserving the leading BOM
with `ignoreBOM: true` passes the same test and the full suite in
`24-final-tests.log`, exit 0. This changes validation only; the mounted fixture
contains no leading-BOM target.

New tests independently parse catalog bytes to check S_IFLNK, Finder
`slnk`/`rhap`, exact UTF-8 data forks without normalization or NUL, file counts,
and a 1023-byte target. Invalid target encodings/lengths/controls, inconsistent
size/readers, conflicting parents, special/mismatched modes and invalid opening
folders reject before output. Callback identity/order, awaited payload/padding,
rejection/cancellation, bounded writes and byte identity are covered. The
`.VolumeIcon.icns` symlink does not select icon flags on either record.
Root, implicit, explicit and nested opening folders set field 2 in both headers;
other blessing fields remain zero. Existing `planDmg.items` metadata and shared
`plan.time` remain available to the caller.

HeadlessChrome/154.0.8037.92 wrote an 8,394,084-byte image with 1,614 files,
including four links, in 370.1 ms (write time only; excludes verification and
download). Browser data CRC32 is `0x88a98ce3`. Real OPFS callbacks completed
once per original file/link entry, and rejected/cancelled symlink callbacks left
no partial output. The browser retained explicit-offset writes; payload bytes
and UDIF CRCs validated. Only six local GET requests were observed; no upload,
external requests or console errors occurred. Raw stats are in
`browser/browser-small.json`; the historical small-stats basename is retained
inside this isolated symlink job, while the image is `browser-symlink.dmg`.

Independent native acceptance used:

- `hdiutil verify -verbose`: data/block/master CRCs valid, exit 0.
- `hdiutil attach -readonly -nobrowse -noautoopen`: case-sensitive HFS+;
  diskutil reports both media and volume non-writable.
- Real `lstat` and byte-buffer `readlink`: `Applications` is mode
  `120777`, size 13, target exactly `/Applications`. Relative resource,
  non-normalized UTF-8 dangling and 1023-byte targets also match. Following the
  relative resource link returns the original fixture bytes; `cmp` confirms
  the original test executable bytes without running it.
- `diskutil verifyVolume` ran `fsck_hfs -fn -x`, verified catalog,
  extents, hierarchy and bitmap, and reported filesystem exit 0.
- Readonly `bless --info` returned exit 0 and explicitly printed
  `finderinfo[2]: 2 => 1st dir in open-folder list is .../mounted/`.
  Fields 0, 1, 3, 4 and 5 remained unset. `bless --openfolder` is unsupported
  on this Apple Silicon system; the writer does not call it.
- After unmounting (macOS locks a mounted block device), the still-attached
  readonly device was read directly. Primary header at 1024 and alternate at
  8,391,680 both contain field 2 = root CNID 2 and creation time 3,875,731,200
  (the shared explicit Unix timestamp 1,792,886,400 + HFS epoch offset).
  Direct on-device catalog parsing also confirmed Applications mode `120777`,
  type `slnk`, creator `rhap` and exact data-fork target. The xattr view
  returned ENOATTR for this symlink, so validation reads its actual catalog
  metadata instead. The device was detached in a finally block.

Local source checks used the installed macOS SDK: `hfs/hfs_format.h`
`kSymLinkFileType`/`kSymLinkCreator` and volume-header layout,
`sys/_types/_s_ifmt.h` S_IFLNK, `sys/syslimits.h` PATH_MAX 1024 and
`sys/param.h` MAXPATHLEN. Logs: `04-sdk.log`, `08-finder-evidence.log`.
No internet retrieval was needed. Native verification commands each have a
45-second deadline and captured child PID/log/exit; cleanup targets only the
attached scratch device.

Image SHA-256:
`93375c2910ed80f7152e81beebcc7c9d6ec6718b3b62e60666aacd357e40b7ae`
(also in `SHA256SUMS`). Independent header captures, attach/disk-info plists
and `macos-symlinks.json` remain under the same job directory.

Scope: only `tools/browser-builder/dmg/**` source files were written. The
protected six game-harness files remained 52 insertions / 4 deletions; the
native-savestates artifacts and game-harness intent were not touched. Concurrent
pipeline, CI and installer changes belong to the main task. Nothing was staged,
committed or pushed. No Finder UI, native game/app execution, arbitrary xattr or
hard-link support, new native converter, full Firefox pipeline, >4 GiB rerun,
DS_Store generation, background artwork or visual auto-open acceptance is claimed
by this focused change.

## Input release and explicit OPFS offsets

The 2026-10-25 focused rerun passed all 23 existing tests and 6 new real-file
regressions: **29 passed, 0 failed, 627 assertions**. Asynchronous writes/close
finish before the callback unlinks each source, including empty files. Complete
image bytes match the retained-input run; payloads and UDIF CRCs validate.
Callback rejection/cancellation stops before opening the next source; failed
reads, padding writes and pre-callback cancellation do not release input.

Commands from the repository root, all exit 0:

- `bun test ./tools/browser-builder/dmg/test`
- `bun run --cwd tools/browser-builder/dmg typecheck`
- `bun run --cwd tools/browser-builder typecheck`
- `bun tools/browser-builder/dmg/test/browser.ts`

The small real OPFS worker run in HeadlessChrome/154.0.8037.92 unlinked its closed
source, verified image data/CRC and removed incomplete output after callback
rejection and cancellation. No mocks or quota/persistence requests were used.
This rerun did not force zero/invalid write responses or repeat the >4 GiB,
Firefox, full-game or mounted-app acceptance. Per-command PID, log and exit
status: `tmp/odyssey/opfs-firefox/1792962129310-{dmg-tests,dmg-typecheck,builder-typecheck,opfs-browser}/`.

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
after verification. Retained downloads/evidence use about 4.0 GiB, primarily the deliberately
kept large DMG. `test/cleanup.ts` checks successful acceptance status and exact
owned cache paths before removal. Cleanup log: `tmp/odyssey/browser-dmg/cleanup.log`.

The initial instruction-read logs were mistakenly placed in two `/tmp/` scratch
directories; those exact directories were removed immediately. Project code,
dependencies, test images, profiles and subsequent logs stayed in the two allowed
scopes. The only modified/added source owned by this task is under `dmg/`; other
working-tree changes belong to concurrent/pre-existing work.

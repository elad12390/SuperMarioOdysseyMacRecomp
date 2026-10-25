# Browser ad-hoc app resource sealing

Browser-only repair of the public template's resource seal after private game
assets are added. Verified with macOS deep/strict bundle verification of a real
browser-generated DMG. No native signing tool, certificate, app launch, helper
or build server is part of the product implementation.

```ts
import { sealApp } from "./signing/index";
import { writeDmgToOpfs } from "./dmg/index";

const sealed = await sealApp(entries, {
  appName: "Super Mario Odyssey.app",
  signal,
  progress: ({ phase, path, hashedBytes, totalBytes, filesDone, totalFiles }) => {
    // Forward real progress to the main thread.
  },
});
const image = await writeDmgToOpfs(sealed, jobDirectory, "Game.dmg", { signal });
```

The API accepts and returns the shared `DmgEntry[]` type. It replaces only the
Launcher and CodeResources entries. Other entries, including dmhost, retain
their original object identity and payload source. Entry `open()` functions
must be repeatable: sealing reads resources to hash them; DMG creation then
reads them again. Keep source files immutable between those passes.

## Exact operation

1. Read bounded signing metadata: Launcher (maximum 16 MiB), input CodeResources
   (8 MiB), and Info.plist (1 MiB). Game payload buffering is bounded separately
   to the 64 MiB per-lane native-digest limit described below. The generated
   output envelope has a separate **64 MiB** ceiling: the 70,000-file regression
   produces 17,296,042 bytes, so 8 MiB cannot represent real game file counts.
   The input parser and all Mach-O/signature bounds remain unchanged.
2. Require a thin little-endian ARM64 ALL executable, CodeDirectory v0x20400,
   flags exactly CS_ADHOC, SHA-256 type 2 / hash size 32 / page exponent 14,
   exactly three special slots and one primary CodeDirectory. Reject alternate
   CodeDirectories, scatter/team/extended-limit layouts and unknown blob slots.
3. Validate the original code-page, Info.plist, requirements and resource-envelope
   hashes before changing any bytes. The existing empty 8-byte CMS wrapper is
   an ad-hoc placeholder; any nonempty CMS payload is rejected. No certificate
   signature is created or reused.
4. Parse the trusted XML envelope with a bounded balanced plist parser. Preserve
   all original text, `files`, `files2`, nested dmhost cdhash/requirement and rules.
   Hash every ordinary resource with SHA-1 and SHA-256. Files from 256 KiB
   through 64 MiB use native WebCrypto after one bounded read; smaller and
   larger files stream through pinned hash-wasm 4.12.0. Existing sealed
   resources must match both hashes.
   Optional `DmgEntry.expectedSha256` values must be exactly 64 hexadecimal
   characters (either case), validated before hashing. Resource digests must
   match the conversion digest before updating CodeResources. This comparison
   reuses the existing SHA-256 result; it adds no payload pass or source open.
5. Add SHA-1 records to `files` and SHA-256 `hash2` records to `files2` for new
   `Contents/Resources/game/...` files or `Contents/Resources/Game.icns`.
   Normalize paths with the same frozen HFS normalization used by the DMG
   writer, escape XML keys, reject normalized duplicates and unsafe paths.
   No rule is omitted or relaxed. New files outside the existing template and
   those permitted resource locations fail.
6. Hash the new envelope and replace only CSSLOT_RESOURCEDIR (special slot 3)
   in the existing Launcher's CodeDirectory. The Mach-O size, code pages,
   load commands, requirements, Info slot and other signature bytes do not change.

The active SuperBlob length governs signature parsing. Apple's signer reserves
extra LC_CODE_SIGNATURE storage and can leave nonzero unused tail bytes there;
these bytes are preserved, not interpreted as signature blobs or cleared.

Resource reading uses at most **four independent lanes**, each with private
SHA-1/SHA-256 state and a reusable buffer starting at **1 MiB**. For native
digests, the buffer grows only as needed, up to **64 MiB per lane / 256 MiB
retained across four lanes**, in addition to the browser's native digest copies.
Every read request remains bounded to 1 MiB; bytes go directly into the digest
buffer without an extra payload read or accumulation copy. Smaller and oversized
files stream through WASM. No whole-game/image buffer is created.
Every resource still receives both hashes, declared-size and EOF checks. All
in-flight readers close before an error or cancellation returns. File completion
order can vary; aggregate progress stays monotonic and new envelope records are
sorted before insertion, preserving deterministic output. It yields to worker
tasks every 16 MiB, including synchronous WASM readers. Memory is bounded by
the lane buffers, native digest copies, hash states and
metadata/envelope/file records, independent of total game payload size. The
result remains an ordinary ad-hoc signature; Developer ID, notarization and
Gatekeeper approval are outside this API.

If WebCrypto is unavailable, the existing streaming WASM path is used. If a
native algorithm reports `NotSupportedError`, both native jobs are drained and
WASM hashes the already-read bounded bytes without reopening the resource.
Other native failures reject the seal. Abort is checked before and after native
jobs; both jobs settle before the lane buffer can be reused or failure returns.

Four lanes can share readonly, position-based OPFS pack handles while keeping
each entry's cursor separate. The caller owns shared pack-handle lifetime through
sealing and DMG writing. The standalone real-File measurements in EVIDENCE.md
do not establish a production package-stage time for that provider.

## Verification

From this directory, run each command as a captured background job:

```sh
bun install --frozen-lockfile
bun test ./test/seal.test.ts
bun run typecheck
bun run ./test/browser.ts
bun run ./test/verify.ts
```

From the repository root, the focused current checks are:

```sh
bun run --cwd tools/browser-builder/signing typecheck
bun run --cwd tools/browser-builder/signing test
bun run --cwd tools/browser-builder typecheck
```

The test server serves static public-template fixtures only. A dedicated
headless-shell browser creates the added private resources, seals the app with
this module, writes the image into OPFS using the real DMG writer, and downloads
it. Native verification uses hdiutil only to verify/attach/detach and codesign
only with --verify. It never signs output or executes Launcher/dmhost.

Observed native results:

| Actual artifact | `codesign --verify --deep --strict` |
| --- | --- |
| Browser-sealed app on readonly mounted DMG | exit 0 |
| Relocated copy of that app | exit 0 |
| Same private files with original unsealed metadata restored | exit 1, added resources |
| Sealed copy with a private resource byte changed | exit 1, modified resource |

The browser test includes a 32 MiB + 37 byte generated resource, an empty file,
an icon, and a Unicode/XML-sensitive filename. It also rejects non-ad-hoc,
corrupt signed-page and malformed CMS inputs in the actual browser. Unit tests
cover the exact 32-byte patch boundary, layout rejection, original metadata and
resource tampering, stream lengths, cancellation and malformed XML.

Evidence is under `tmp/odyssey/browser-signing/`: browser.json, worker.js,
native-verify.log, macos-results.json and individual verifier command records.
The actual browser-created image is downloads/browser-sealed.dmg. Details and
SHA-256 hashes are in EVIDENCE.md.

The real 70k-file scale regression is `bun run ./test/scale.ts`. It uses the
current cached public template, real browser hash-wasm, the existing browser DMG
writer and native readonly deep/strict verification. Added files are one byte
each; the ~333 MB image is filesystem overhead. Evidence is retained under
`tmp/odyssey/browser-signing/scale/`; the owned image and profile are removed.

## Sources and notices

On-disk field definitions follow Apple's primary
[xnu cs_blobs.h](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/cs_blobs.h)
and Mach-O loader structures, cross-checked against the actual signed public
Launcher before implementation. Online retrieval used Web Research Assistant.
No Apple source implementation is incorporated.

Original implementation: MIT (LICENSE). Only runtime package: **hash-wasm
4.12.0**, pinned with bun.lock, no transitive runtime dependencies. Its MIT notice
is in HASH-WASM-LICENSE.txt; embedded SHA notices are retained separately in
HASH-WASM-EMBEDDED-NOTICES.txt (SHA-1 public domain, SHA-256 permissive notice).
Ship these notices with the browser tool bundle. The shared DMG path normalizer
and its Unicode data retain their existing MIT/Unicode notices. Test-only Bun
types, TypeScript and puppeteer-core are pinned dev dependencies.

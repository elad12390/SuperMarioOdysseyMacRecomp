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

1. Read bounded signing metadata: Launcher (maximum 16 MiB), CodeResources
   (8 MiB), and Info.plist (1 MiB). Game payloads are not buffered.
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
   Stream every ordinary resource through incremental SHA-1 and SHA-256 in
   pinned hash-wasm 4.12.0. Existing sealed resources must match both hashes.
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

Resource reading uses a reusable **1 MiB** buffer, checks declared sizes and EOF,
and closes readers on success/error/cancel. It yields to worker tasks every
16 MiB, including synchronous WASM readers. Memory is bounded by chunks plus
metadata/envelope/file records, independent of total game payload size. The
result remains an ordinary ad-hoc signature; Developer ID, notarization and
Gatekeeper approval are outside this API.

## Verification

From this directory, run each command as a captured background job:

```sh
bun install --frozen-lockfile
bun test ./test/seal.test.ts
bun run typecheck
bun run ./test/browser.ts
bun run ./test/verify.ts
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

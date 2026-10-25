# Browser resource seal: independently verified

## 70,000-file real-scale regression (2026-10-25)

The production failure `Updated CodeResources exceeds metadata bound` was
reproduced in the actual browser before the fix (scale/red.log). The only
production change raises the generated OUTPUT CodeResources ceiling from 8 MiB
to 64 MiB. Input envelope/parser limits remain 8 MiB; Mach-O, CodeDirectory,
Info.plist and all signature-layout checks are unchanged. This is a fixed
ceiling with approximately four times the observed 70k envelope size, rather
than a bound coupled to multi-GB game payload size.

`bun run ./test/scale.ts` uses the immutable public template at:
`tmp/odyssey/browser-release-tools/runtime-cache/b4d1805e2c14d937a7cfe0a185b97a9c214bcc9c67102d49fbe6a6a34167d23e/public`.
Every published file is checked against its manifest before sealing. Real
headless-shell browser SHA-1/SHA-256 WASM hashes 70,000 deterministic one-byte
ordinary files through sealApp, followed by the existing browser DMG writer.

| Measurement | Observed |
| --- | ---: |
| Private synthetic files | 70,000 |
| Public template files | 18 |
| Total output files | 70,018 |
| CodeResources XML bytes | 17,296,042 |
| Sealing time | 696.1 ms |
| Browser DMG write time | 7,379.2 ms |
| DMG bytes | 332,875,108 |
| Maximum private source read buffer | 1 byte |
| Native mounted private-file count | 70,000 |
| hdiutil verify / readonly attach / deep-strict codesign / detach | 0 / 0 / 0 / 0 |

The mounted XML byte count and SHA-256 equal the exact browser-produced XML.
Only the launcher's existing resource digest slot changes (offsets 53851..53882
for this template); original code, nested host and all signature layouts remain
unchanged. No app, Launcher, host, GPU or Player invocation occurred.

Retained hashes:

- XML: `a20eefd2d67096252c198b597650ae1615f9dbc5e7fd7d0f6e87f19a39d8556d`
- DMG: `36bc7dd66bad4230a90d7f4a6bd0cee6a288c378529b6975d0636def2fe33480`
- Original Launcher: `c6f20a588373194e8b19bb44c6e46c5399e8c59f7f857b8629261edffdf862ee`
- Sealed Launcher: `536d91fd59d8324f0b4a275942d68fc050dcd8efe4c4da142f53c92404cf9cbf`
- Manifest: `67f38507921a74d6bdd39823c42ce79732c6beff0b41243115566767a23cba5b`

All raw browser/native outputs, captured PIDs and statuses are in
`tmp/odyssey/browser-signing/scale/`. The owned OPFS browser profile and downloaded
image were removed after proof, and the disk was detached. No private game run
was repeated. Existing malformed-signature/XML, tamper, stream/cancel negatives
remain enforced; an added test proves the input envelope still rejects above
8 MiB before opening its reader. No commit was made for this fix.

## Earlier small-resource proof

Verified 2026-10-25 using the actual public native template and an isolated
HeadlessChrome/154.0.8037.92 browser. No Launcher, dmhost, game or desktop window
was executed/opened. Native commands only verified and mounted output.

## Exact current-template layout inspected first

- Thin little-endian ARM64 ALL MH_EXECUTE, Launcher size **72,096** bytes.
- LC_CODE_SIGNATURE command at **2,216**, data offset **53,696**, allocated
  signature storage **18,400** bytes, active SuperBlob length **400** bytes.
- One primary CodeDirectory at **53,732**, length **344**, version **0x20400**,
  flags **2 (CS_ADHOC)**, SHA-256 type **2**, hash size **32**, page exponent **14**.
- Three special slots, four code-page slots. Resource slot 3 starts at absolute
  offset **53,852**. Requirements blob is at **54,076**, length **12**.
- The CMS slot is an empty **8-byte** wrapper at **54,088**. It has no certificate
  signature payload. A nonempty CMS blob is rejected.
- The baseline actual app passed `codesign --verify --deep --strict` before any
  implementation. Raw inspection: tmp/odyssey/browser-signing/layout.json and
  canonical-before.log. Some unused allocated signature tail bytes are nonzero
  after Apple's re-signing; these lie outside the active SuperBlob and are
  preserved exactly.

Public inputs (from the actual manifest):

| File | SHA-256 |
| --- | --- |
| Launcher | `aa3a788ed36a35e73173baa8b0c78bed7afef158aff397cecbfdcbd69a572789` |
| CodeResources | `52450c834591fd813e997c18bff3024c26a5977a311f01b531b75990981db52e` |
| dmhost | `70a0acbb1956bf0eaba5cec5c5eadcaee344c9f4af6643c5272cfcaa5d7d9343` |

## RED/GREEN and browser proof

Commands run from tools/browser-builder/signing, as captured background jobs:

```sh
bun test ./test/seal.test.ts
bun run typecheck
bun run ./test/browser.ts
bun run ./test/verify.ts
```

Initial RED is in red.log (module absent). Additional real RED cases for invalid
XML entities and unexpected new non-resource files are in red-input-guards.log.
Current results: **6 unit tests pass, 0 fail, 72,094 assertions**; typecheck exit 0.

The browser worker fetched and hash-checked all 10 published template files,
created four new ordinary private resources (32 MiB + 37 bytes streamed file,
Unicode/XML-sensitive filename, empty file and Game.icns), ran sealApp, then
used the existing real browser DMG writer to stream output into OPFS. The
browser downloaded the OPFS-backed File directly; no native signing or image
creation command was used.

- Seal time: **119.3 ms** in this local test (not a general throughput guarantee).
- Generated streamed file: **33,554,469** bytes; maximum reader buffer **1 MiB**.
- Generated source opened/closed **twice**, once for hashing and once for DMG
  writing. It was not represented as a whole-file buffer.
- Progress callbacks: **42**. Output: **14 files**, DMG **36,898,148 bytes**.
- Launcher remained **72,096 bytes**. The only changed bytes are offsets
  **53,852 through 53,883**, exactly resource slot 3's 32 bytes. Code pages,
  requirements, Info slot, signature headers and host remain unchanged.
- Real browser negative cases reject non-ad-hoc flags, a damaged signed page,
  and malformed CMS. Unit cases additionally reject fat/x86/wrong-hash and
  malformed signature bounds, modified original resources/Info/envelope,
  duplicate/unsafe paths, short streams, cancellation and malformed XML.
- No console errors. Only GET requests for the static page, worker, manifest and
  public-template files. No upload or native product server is involved.

Raw browser evidence: tmp/odyssey/browser-signing/browser.json, browser.log,
worker.js. A fresh build of current source matches the verified worker hash;
source-match.log records that check.

## Independent native result

The verifier first runs hdiutil verify and attaches the exact downloaded DMG
**readonly**, with `-nobrowse -noautoopen`. It then runs:

```sh
/usr/bin/codesign --verify --deep --strict --verbose=4 APP
```

| Real artifact | PID | Exit | Native output |
| --- | ---: | ---: | --- |
| Browser-sealed app on mounted DMG | 7329 | 0 | valid on disk; satisfies its Designated Requirement |
| Relocated sealed app | 7330 | 0 | valid on disk; satisfies its Designated Requirement |
| Same private files, original Launcher/CodeResources restored | 7331 | 1 | file added for all four new resources; sealed resource missing/invalid |
| Sealed app, one private-resource byte flipped | 7332 | 1 | file modified; sealed resource missing/invalid |

The nested dmhost reports prepared/validated in the positive results, and its
original cdhash/requirement remains in the envelope. The negative fixtures are
test-only copied app directories. No fixture is re-signed. The DMG was detached
(PID 7336, exit 0). hdiutil verification/attachment also exit 0. The wrapper
reports **BROWSER_ADHOC_SEAL_NATIVE_ACCEPTANCE_OK**.

Raw records: tmp/odyssey/browser-signing/macos-results.json, native-verify.log,
sealed-mounted.json, sealed-relocated.json, unsealed-resource-negative.json,
corrupt-resource-negative.json. Each command's PID/output/status is retained.

## Retained artifact hashes

| Artifact | SHA-256 |
| --- | --- |
| browser-sealed.dmg | `d26a3024658b443feb87188a70c4562a0907324d6184cde90a2a83c564e42bc1` |
| Verified worker bundle | `41a7577212422e7df2682bb3beccf187161a60316f7d640c8516c247df0c5b9e` |
| Sealed Launcher | `0ef9da33c5256f16dd45ddd3496acc8cd12cdf3cb8be65d22c85126ae61ed247` |
| Updated CodeResources | `e429353e63954ac85d3aa9a5c262815ac5eeacca6b365260e81741a33675bfc3` |

SHA256SUMS is also saved in the scratch evidence folder. Implementation and
notices are under tools/browser-builder/signing only; other writes are under
tmp/odyssey/browser-signing. No public-template/runtime/web source was edited,
no proprietary asset was used, no native signing command or certificate was
needed, no Rust build was run, and no commit/push was made. This proves resource
sealing only; gameplay and notarization are outside this slice.

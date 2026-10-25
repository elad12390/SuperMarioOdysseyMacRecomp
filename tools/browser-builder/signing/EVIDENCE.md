# Browser resource seal: independently verified

## Bounded native resource digests (2026-10-25)

Resources from 256 KiB through 64 MiB (inclusive) now use real WebCrypto SHA-1
and SHA-256. The entry is read once, in at most 1 MiB requests, directly into a
reusable lane buffer. Four lanes retain at most 64 MiB each / 256 MiB total,
plus native digest copies. Smaller and oversized resources continue streaming
through hash-wasm. The native jobs both settle before buffer reuse or error
return. Missing WebCrypto uses streaming WASM; NotSupportedError falls back
over already-read bytes without another source open/read. All existing
expected-SHA, original-resource, size/EOF and signature-layout checks remain.

A fresh paired comparison used the original real app's 71,098 files and
6,825,873,335 resource bytes in the same owned headless Chrome, without copying
the app or corpus. Both versions checked 66,458 conversion digests against
reference records from the original app. File selection and bundling are
outside the timed sealApp calls.

| Measurement | Streaming WASM | Bounded WebCrypto |
| --- | ---: | ---: |
| Wall time | 39,391.2 ms | 30,496.5 ms |
| Source opens / closes | 71,097 / 71,097 | 71,097 / 71,097 |
| Read calls including EOF/metadata | 146,494 | 146,494 |
| Bytes read including metadata | 6,825,952,246 | 6,825,952,246 |
| Maximum read | 1 MiB | 1 MiB |
| Maximum active readers | 4 | 4 |
| Native digest calls | 0 | 3,648 |

Measured saving: 8,894.7 ms / 22.58%, a 1.29x speedup. Native calls hashed
5,198,713,039 resource bytes with each algorithm (1,824 eligible resources).
The complete Launcher (72,096 bytes) and CodeResources (20,532,642 bytes) match
the streaming baseline and original native-verified real app exactly, retaining
the hashes recorded below. No production packed-OPFS package-stage duration or
10-second target is established by this asynchronous File-reader measurement.

The 2 MiB generated File test uses actual native digests and independent Bun
CryptoHasher references for both resource hashes. Partial reads are exercised,
the source opens/closes once, and the complete Launcher equals the original
with only the independently computed resource slot patched. Tests also cover
both inclusive native-size bounds, real WASM fallback without WebCrypto, a
real provider NotSupportedError, short/overlong/mismatched native-size inputs,
and abort during the actual native digest jobs. All 19 focused tests and both
signing/builder typechecks pass. Existing malformed metadata, expected digests,
tamper and cancellation tests remain active.

Evidence and public worker bundles are retained under
`tmp/odyssey/graphics-optimization/sealing-webcrypto-*`. The browser/profile
ownership is recorded and the owned profile is removed after the comparison.
All implementation changes remain confined to signing; no stage or commit.

## Conversion digest integrity hook (2026-10-25)

The sealer validates optional `DmgEntry.expectedSha256` values before opening
inputs or hashing. Values must be exactly 64 hexadecimal characters, with
uppercase accepted and trailing newlines rejected. Each resource's already
computed SHA-256 is compared before adding envelope records or patching the
Launcher. No extra payload read or hash pass is introduced.

The regression tests use the existing real public-template font through the
actual File/Blob DmgEntry reader. A correct expected digest produces identical
Launcher and CodeResources bytes and opens the converted resource exactly once.
A same-size one-byte corruption and a wrong well-formed digest both reject
before sealed progress, leaving the input metadata unchanged. Malformed
digests reject before opening the resource or reporting hash progress. Both
negative cases were demonstrated failing against the previous implementation
before adding the hook. Logs are under
`tmp/odyssey/graphics-optimization/sealing-integrity-*`.
The current focused suite passes all 13 tests (72,423 assertions); signing and
builder typechecks also pass. The hook has no separate full-payload performance
measurement: it compares the existing 32-byte digest without another read or
hash pass. The measured four-lane gain below predates this hook.

## Real-app source latency optimization (2026-10-25)

Status: uncommitted candidate, not a demonstrated production OPFS improvement.
The main task is replacing loose intermediates with packed OPFS sources and
shared readonly sync handles. Measure that provider before adopting this
concurrency change; its main benefit in this proof is asynchronous File-read
latency. No packed-provider or complete-pipeline timing is claimed here.

The unchanged serial sealer and bounded four-lane sealer processed the original
71,098 files from
`tmp/odyssey/browser-release/generated-1987-acceptance/relocated/Super Mario Odyssey.app`.
The matching public template supplies only the original signing metadata;
private resources are mounted as original File objects, never copied into OPFS
or another app. Both timed runs use the same asynchronous File slice reader,
resource order, 1 MiB maximum read and real hash-wasm implementations in an
owned HeadlessChrome/154.0.8037.92 browser.

| Measurement | Serial | Four bounded lanes |
| --- | ---: | ---: |
| Resource bytes | 6,825,873,335 | 6,825,873,335 |
| Total input files | 71,098 | 71,098 |
| Sealing wall time | 87,555.0 ms | 41,368.5 ms |
| Source opens / closes (including metadata) | 71,097 / 71,097 | 71,097 / 71,097 |
| Read calls (including metadata and EOF) | 146,494 | 146,494 |
| Total bytes read (including metadata) | 6,825,952,246 | 6,825,952,246 |
| Maximum source read | 1 MiB | 1 MiB |

This saves 46,186.5 ms (52.75%), a 2.12x speedup for the full real-file seal.
The serial run spent 60,694.3 ms awaiting reads. The optimized sum of individual
read waits is 136,228.8 ms because independent waits overlap; it is not CPU time
and must not be compared directly with wall time. A discovery run using
FileReaderSync took 123,654.8 ms, with 85,725.7 ms in reads; it is not used as
the before/after comparison because its reader differs.

Both runs reproduce the existing real app's signing metadata exactly:

- Launcher: 72,096 bytes,
  `05670be585814893f67b45ad545ae63d859b34389c266d486013e2669364e9da`.
- CodeResources: 20,532,642 bytes,
  `9ce462f6ea701c0df00b4970498791079eb0e39ac84eb2b318a8bb78a414be6a`.

Every resource is still read and hashed with SHA-1 and SHA-256, with unchanged
size/EOF, original-resource and signing-layout validation. The four lanes have
private hash states and 1 MiB buffers, and drain all opened readers before an
error or cancellation returns. No caller-supplied digest cache or whole-file
native crypto buffer was introduced. New tests verify interleaved digest
correctness, the four-reader ceiling, monotonic progress and failure/cancel
cleanup against real Blob readers. Original tamper and signature negatives
remain in the focused suite.

All 10 focused tests and both signing/builder typechecks pass. Readonly native
`codesign --verify --deep --strict --verbose=4` also passes on the original app
whose Launcher and CodeResources are exactly reproduced by both browser runs.
The app is never launched or modified for this verification.

Current focused commands from the repository root:

```sh
bun run --cwd tools/browser-builder/signing typecheck
bun run --cwd tools/browser-builder/signing test
bun run --cwd tools/browser-builder typecheck
```

Evidence, original/optimized browser worker bundles, owned-browser PIDs and
captured job logs/statuses remain under
`tmp/odyssey/graphics-optimization/sealing-*`. Only metadata and public tool
source are retained; owned headless profiles are removed. This measures the
actual sealApp function on real File-backed resources, not the complete
production OPFS build. The saved 101.619-second packaging interval includes
different source adapters and handoff costs; its new duration requires the
main task's complete pipeline measurement. No stage or commit was made for
this slice.

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

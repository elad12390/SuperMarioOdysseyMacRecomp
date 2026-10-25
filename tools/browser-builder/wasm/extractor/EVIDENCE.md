# Browser extraction evidence

## Four-worker RomFS proof, 2026-10-25

The published JS pool passed the actual local base NSP proof with
`EXTRACTOR_WORKERS=4`, `EXTRACTOR_FULL=1`, `EXTRACTOR_EXPECT_AOT=1`, and
`EXTRACTOR_COMPARE_EVIDENCE` pointing at the retained sequential
`tests/aot-optimized-measured/evidence.json`. The AOT WASM was not rebuilt.

Full extraction measured **27.1627s**, versus the retained sequential AOT
**72.8795s**: **2.6831x faster**. Both produce **4,643 files / 5,527,949,302
bytes**. Every actual path, size and SHA-256 matches; the returned enumeration
order also matches. Timing includes worker/runtime startup and OPFS output,
and excludes subsequent output hashing. Control/ExeFS stays sequential and
measured 0.6604s in this run; that timing difference is not attributed to the
RomFS pool. Browser hardware concurrency was 14; actual RomFS progress reported
`workers: 4`.

Every reported child I/O sample and the final aggregate maximum is at most
1,048,576 bytes. Last observed child-progress counters:

| RomFS partition | Progress samples | Physical reads | Max read bytes | Output bytes |
| --- | ---: | ---: | ---: | ---: |
| 0 | 2,345 | 2,466 | 1,048,576 | 1,518,742,748 |
| 1 | 2,199 | 2,317 | 1,048,576 | 1,380,972,842 |
| 2 | 2,055 | 2,152 | 1,048,576 | 1,202,929,221 |
| 3 | 2,239 | 2,344 | 1,048,576 | 1,402,443,045 |

The runner assigns these samples to the explicit round-robin partitions using
the retained reference RomFS enumeration index modulo four. Product telemetry
was not changed. Final aggregate I/O, including the parent: 9,762,068,992 input
bytes read, 9,315 physical reads, 343,842 logical storage reads, 1 MiB maximum
read, and 5,527,949,302 output bytes written. The selected NSP was read directly;
no second full input corpus was staged.

Cancellation occurred after an actual RomFS `CopyChunk` wrote bytes. Before
cancel, the test observed the parent plus four nested worker targets and the
`.extract-pool-owner` marker beside control/ExeFS/RomFS output. `cancel()`
cleaned the owned root in **54.8ms**. The root was absent afterward, no parent or
nested worker targets remained, and every earlier ExeFS output hash was
unchanged. Successful full extraction also removed the ownership marker.
Wrong-key and truncated-input rejection, existing-output preservation, actual
WASM crypto known answers, AOT runtime configuration and network checks passed.

Proof: `tests/aot-parallel-workers4-measured/evidence.json`, outcome GREEN.
Captured job: `jobs/aot-parallel-workers4-proof.pid/.log/.exit`, PID 85602,
exit 0. The owned browser profile was removed after browser closure. Inputs,
keys, saves, Player and unrelated WIP were untouched; no full NSP-to-DMG build
or native game run was part of this proof. Only the proof runner and these
README/EVIDENCE docs were edited in this slice; no staging or commit occurred.

## Sequential source-built AOT speedup, 2026-10-25

The retained sequential publication is a linked AOT WASM build, verified with the
real local base NSP. No SDK, workload, package or other download was needed.
Installed tooling: .NET SDK 10.0.402, wasm-tools manifest 10.0.113, Mono/WASM
runtime 10.0.13, on Apple Silicon macOS.

| Real extraction | Interpreter baseline | AOT publication | Speedup |
| --- | ---: | ---: | ---: |
| Control and ExeFS, 7 files / 22,861,446 bytes | 2.241s | 0.805s | 2.78x |
| Complete output, 4,643 files / 5,527,949,302 bytes | 487.921s | 72.880s | 6.69x |

These are single local runs through the same proof harness and private inputs.
Extraction timing includes worker/runtime loading and OPFS output, and excludes
the subsequent SHA-256 verification. This is extractor acceptance, not timing
or acceptance for the complete NSP-to-DMG/gameplay pipeline.

Every actual output path, size and SHA-256 matches between the baseline and AOT
full runs. Both run the existing NIST AES-128/AES-256 ECB and AES-128 CBC
encrypt/decrypt known answers inside the active WASM instance. Both pass
existing-output preservation, truncated-input and wrong-key rejection, and
cancellation after real decrypted RomFS copying. Observed network violations:
zero; private files remain browser File inputs and never become HTTP payloads.

Full AOT I/O: 338,111 logical reads, 5,951 physical reads, maximum physical read
1,048,576 bytes, physical input bytes 6,238,956,032, output 5,527,949,302 bytes.
LibHac retains `IntegrityCheckLevel.ErrorOnInvalid`. Its post-link DLL is
byte-identical to the existing three-factory adapted DLL; no parsing, AES mode,
integrity or output-copy algorithm changed.

The Release project now enables AOT and the SDK-required linker. The SDK's
implicit build-only `Microsoft.NET.ILLink.Tasks` 10.0.13 is locked. The extractor,
LibHac and the required `System.Runtime` facade are rooted. Because the adapted
LibHac DLL has a scratch path outside the original NuGet runtime item, its
`ResolvedFileToPublish` item explicitly opts into SDK linker processing with
`PostprocessAssembly=true` and `TrimMode=copy`.

Actual build proof:

- `jobs/aot-sdk-info.*` / `aot-workloads.*`: installed workload inventory, exit 0.
- `jobs/aot-clean-release-restore.*`: Release restore from existing local NuGet
  caches only, exit 0.
- `jobs/aot-publish-link-input-fix.*`: clean build, exit 0, 79.3s. Logs show 24
  assemblies compiled to bitcode and native objects, then emcc/WASM linking.
- Generated `obj/Release/net10.0/wasm/for-publish/driver-gen.c` registers AOT
  modules for BrowserExtractor, LibHac and BouncyCastle.Cryptography.
- `jobs/aot-publish-locked-reuse.*`: ordinary restore plus locked Release
  publication using the local package source, exit 0; native AOT outputs reused.
- `jobs/aot-debug-locked-restore.*`: default-configuration locked restore also
  passes against the same local package cache.
- All build jobs capture PID, log and exit status. `EMCC_FROZEN_CACHE=1` prevents
  Emscripten from acquiring missing cache assets.

Sequential proof publication directory:
`tmp/odyssey/browser-extractor/publish/wwwroot/`. Its public bundle contained
105 files / 29,186,492 bytes before the later JS-only pool integration. Native runtime:

`_framework/dotnet.native.lfr0j86wa6.wasm`, 12,222,380 bytes, SHA-256:

`1f02cf53cf5c15d2b4675289de99f8874b41490eedb7b868b4d93c9cde19f2d3`

Retained real proof:

- `tests/aot-baseline-measured/evidence.json`: baseline timings, crypto checks,
  every original output hash, negative cases and network observation.
- `tests/aot-optimized-measured/evidence.json`: AOT timings, every matching output
  hash, actual served runtime `runAOTCompilation=true`, comparisons and GREEN.
- `tests/aot-optimized-measured/tool-bundle-hashes.json`: every public tool file's
  path, size and SHA-256.
- `jobs/aot-baseline-proof.*` / `aot-optimized-proof.*`: both exit 0.

Both owned headless browser profiles were removed after browser closure.
The proof selects the existing NSP directly; it does not stage another full
input corpus. Input NSPs, keys, prepared games, saves and Player were untouched.
No full browser game build, native game or user-browser session was run. Changes
remain uncommitted for main review. Earlier evidence below describes the
interpreter implementation and its historical publication.

All conversion tests use a separate puppeteer-core process and the cached
chrome-headless-shell, never Player or the user's Chrome. Private files are
selected as browser Files; the HTTP fixture serves only static public tools.

## RED before implementation

`tmp/odyssey/browser-extractor/jobs/red.log` and `red-evidence.json` record the
real browser failure to import the then-missing callable extractor module.
The acceptance scenarios were written in `tests/extraction.feature` first.

## Real WASM crypto and extraction

- The real base NSP is 5,611,009,601 bytes. The browser validates decrypted title
  `0100000000010000`, control display version `1.0.0`, and main build ID
  `3ca12dfaaf9c82da064d1698df79cda100000000000000000000000000000000`.
- A complete control/ExeFS run wrote six files, 22,768,898 bytes, to OPFS. The
  test reads back `ExeFS/main` and verifies its NSO0 magic and full build ID.
- Truncated input and wrong keys fail with sanitized errors. The suite verifies
  that partial job directories are removed, prior job output is preserved, and
  cancellation after actual decrypted RomFS copying releases handles and removes
  that job's storage.
- The initial platform AES failure was reproduced in the browser. The final
  provider adapts exactly three LibHac AES factories to Bouncy Castle, retaining
  LibHac's NCA parsing, key derivation, AES modes, and integrity checking.
- Actual NIST AES-128/AES-256 ECB and AES-128 CBC encrypt/decrypt checks, using
  explicit-key and parameterless .NET APIs, passed in the active extraction WASM
  instance. Explicit evidence is
  `tmp/odyssey/browser-extractor/tests/published-cached-proof/known-answers.json`.
- The final I/O bridge keeps one 1 MiB read-ahead window. Physical reads never
  exceed 1 MiB; the complete NSP is never loaded in an ArrayBuffer or WASM memory.

The exact final publication bundle passed the complete `EXTRACTOR_FULL=1`
suite with exit 0. It wrote 4,642 files totaling 5,527,856,754 bytes, including
the complete RomFS. All files were read with LibHac's integrity checking enabled.
The returned manifest contains all 4,642 output paths and sizes.

The full run served 338,106 storage reads using 5,950 physical FileReaderSync
reads, each at most 1,048,576 bytes. Total physical input bytes, including
bounded read-ahead and seeks, were 6,237,953,024. The suite observed 210 static
HTTP requests and 910 worker network events, with no network violations.

Compact proof is retained under
`tmp/odyssey/browser-extractor/tests/published-cached-proof/`:

- `evidence.json`: full passing suite, metadata, file manifest and I/O counters.
- `manifest.json` / `proof-hashes.json`: manifest plus SHA-256 of evidence and
  manifest files.
- `known-answers.json`: actual NIST checks from the running WASM instance.
- `output-hashes.json`: SHA-256 of all six actual control/ExeFS output files,
  computed in the browser from completed OPFS files.
- `cleanup.json`: ownership check and deletion record for the completed profile.

The browser closed normally. After verifying no active profile owner, the
5.2 GiB profile and its extracted game binaries were deleted. The inactive
221 MiB legacy profile from old failed runs was also removed after an ownership
check. No input dumps, keys, Player data, or user caches were cleaned.

## Publication and public restore

`jobs/publish-clean.log` and `jobs/publish-cached.log` record successful real
publication builds. `PublishTrimmed=false` preserves LibHac's framework facades;
a clean rebuild was required after switching from trimming. Copy the entire
`tmp/odyssey/browser-extractor/publish/wwwroot` directory into the static site.

`jobs/fresh-public-restore.log` records a locked restore with `--no-http-cache`,
an initially empty `fresh-nuget` directory and empty fallback folders. The public
NuGet flat-container package endpoint for LibHac 0.19.0 returned HTTP OK and its
content hash matched `packages.lock.json`. Publication was subsequently built
using that fresh package directory, rather than this Mac's global LibHac cache.

LibHac 0.19.0 and BouncyCastle.Cryptography 2.6.2 are browser dependencies.
Mono.Cecil 0.11.6 is build-time only and is excluded from the browser bundle.
Dependency notices are copied into the publication output. The separate
repository audit and higher-level pipeline own final publication approval and
complete generated-app acceptance.

## Optional control icon

The focused icon regression first failed against the accepted bundle because
`icon.jpg` was absent from the output manifest (`jobs/icon-red.log`, exit 1).
`Extractor.cs` now selects American English or the first icon in the original
native extractor's supported language order. It adds the optional file to the
existing bounded copy enumerator before ExeFS/RomFS. The byte-copy methods and
RomFS path were not changed.

`jobs/publish-icon.log` records a successful updated publication build.
`tests/icon-green/evidence.json` records the focused published-bundle browser
proof, exit 0: seven control/ExeFS files, 22,861,446 bytes, 1 MiB maximum input
read, crypto known answers true, and no network violations. The 92,548-byte
OPFS `icon.jpg` matches `game-data/super-mario-odyssey/extract/v0/icon.jpg`:

`SHA-256 9e22d954279ea488d11a85937148c71d904e62fb7f8ad6ef56e366d8849c01cc`

The accepted full proof remains unchanged. Adding this verified icon gives an
expected full manifest of 4,643 files and 5,527,949,302 bytes. This is a derived
total, not a repeated full-RomFS test. No private icon bytes are tracked or
included in the public tool bundle.

## Canonical package restore and fresh source release

The GitHub source release initially failed with NU1403 because the lock used
Homebrew SDK library-packs bytes for Microsoft.NET.ILLink.Tasks 10.0.13. The
signed NuGet.org package has content hash
`40yrBMsLEcjixBR4G+FiUaBPvxXIPSKJ2OgSrbOZcmSDBda4Sb0k7BWrfDpIvn3IvvDzwOL/tEPa6gDQfh6aRw==`.
`dotnet nuget verify --all` verifies its Microsoft author and NuGet repository
signatures. The release builder now disables the SDK package feed and uses an
isolated public-package cache. The lock is retained; an actual restore using
the former hash still fails with NU1403.

The complete source release and reuse path passes, including fresh extractor,
Maxwell and SPIRV-Cross builds, native template/signatures, portability and the
Pages archive audit. The rebuilt extractor passes the real WASM crypto and
negative-input checks, cancellation and complete four-worker extraction of all
4,643 files. Every output matches the previous verified file size/SHA-256 proof;
full extraction measured 25,751 ms. The fresh shader regression passes 11 actual
records and 65 outputs with the native functional comparison.

Private evidence is under `tmp/odyssey/push-optimization/`; extractor evidence is
`tmp/odyssey/browser-extractor/tests/canonical-source-release/evidence.json`.
The local source release uses chain `8b86866155b2`; all 545 public tool files
(93,078,340 bytes) pass the source/license/binary boundary audit. These are
source-release and component proofs, separate from the earlier complete
browser-to-DMG and native-gameplay recordings.

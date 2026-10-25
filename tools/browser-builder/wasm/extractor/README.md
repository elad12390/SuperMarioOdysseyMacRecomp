# Browser NSP extractor

This module runs the existing nx_extract dependency, LibHac 0.19.0, in .NET 10
browser WASM. There is no native extraction helper or conversion server.

Import the module in the shared pipeline's dedicated worker:

```js
import { run } from './extractor/extractor.js';

const result = await run({
  nsp,                    // user-selected File; never loaded in full
  prodKeys,               // user-selected File
  titleKeys,              // optional File
  outputDirectory,        // fresh, empty per-job OPFS directory handle
  signal,                 // optional AbortSignal, checked between copy chunks
  workers: 4,             // optional full-mode maximum; 1 forces the reference path
}, progress => postMessage({ type: 'progress', stage: 'extract', ...progress }));

// result.titleId, result.version, result.mainBuildId
// result.files = [{ path: 'ExeFS/main', size: ... }, ...]
```

Deploy the complete published `wwwroot` directory together. The module resolves
`./_framework/dotnet.js` relative to itself, so a GitHub Pages subpath works.
Only one extraction may run in a given worker at a time. Full mode copies
control/ExeFS sequentially, then partitions RomFS across up to four nested
workers, limited by available hardware concurrency. `workers: 1` forces the
sequential reference path; probe and ExeFS modes remain sequential. Each child
uses the unchanged LibHac enumerator and copy routine in its own WASM runtime.
The host owns the job directory: stop all workers before deleting partial
output. The isolated client adapter's `cancel()` handles nested termination and
bounded cleanup of its owned root, including the pool ownership marker.

Source releases use signed public NuGet packages with the SDK library-packs
feed disabled and a dedicated ignored package cache. Keep the committed lock
hashes; a Homebrew SDK can bundle different package bytes at the same version.
For a manual publish, set `NUGET_PACKAGES` to
`$PWD/tmp/odyssey/browser-release-tools/nuget-public-packages` from the repository
root so an older global package cache cannot shadow the locked package.

Release publication AOT-compiles the extractor and its managed dependencies to
WASM using the installed .NET workload. The required linker preserves the
extractor, LibHac and its net7.0 `System.Runtime` forwarding facade. The adapted
LibHac publish item uses `TrimMode=copy`: its bytes remain identical after the
three existing AES factory adaptations. Use clean generated `obj`, `bin`, and
publication directories when changing linker settings; keep private inputs and
test evidence outside those generated directories.

`progress` reports `phase` (`load`, `validate`, `validated`, `extract`, `complete`),
`bytesWritten`, and file path/size/offset during copying. The returned `io`
counters report actual input reads and maximum read size. `mode: 'probe'`
validates decrypted metadata without output; `mode: 'exefs'` writes control
metadata and ExeFS. The default `full` mode writes control metadata, ExeFS, RomFS.
Probe and ExeFS modes are diagnostics and do not mean complete game conversion.
When present, a supported control `icon_<language>.dat` is copied as `icon.jpg`
through the same bounded output loop, before ExeFS/RomFS. American English is
preferred, followed by the native extractor's supported language order. Missing
icons are valid and do not add an output entry.

RomFS pool progress includes `workers` with the actual partition count. Its
`io` is the reporting child's bounded counters; the completed result aggregates
all workers, taking the maximum of their `maxReadBytes` rather than summing it.

The optional `extractor-client.js` / `extractor-worker.js` pair supplies an
isolated worker adapter used by the browser regression test. The production
shared pipeline can import `run` directly without this adapter.

The four-worker AOT publication passed complete base-NSP extraction in 27.163s,
versus the retained sequential AOT run's 72.880s (2.68x). All 4,643 paths, sizes
and SHA-256 values match, with actual progress reporting four workers and a
maximum 1 MiB physical read in each partition. Cancellation removed its owned
root and all five parent/child worker targets in the test; earlier ExeFS output
hashes remained unchanged. See `EVIDENCE.md` for the saved proof.

The retained sequential AOT publication passed complete base-NSP extraction: 4,643
files / 5,527,949,302 bytes, including the icon, with a maximum 1 MiB physical
input read and passing WASM NIST crypto checks. Every output path, size and
SHA-256 matches a fresh interpreter baseline. Full extraction measured 72.880s
versus 487.921s (6.69x); control/ExeFS measured 0.805s versus 2.241s (2.78x).
These are extraction-only local measurements. See `EVIDENCE.md` for the exact
published artifact and saved proofs.

## Validation and I/O

- Only Odyssey base v0 / 1.0.0 is accepted: decrypted title ID
  `0100000000010000`, 32-byte main build ID
  `3ca12dfaaf9c82da064d1698df79cda100000000000000000000000000000000`.
  The prefix is pinned by the existing native game's `game.tsv` base profile.
- PFS0 bounds are checked before LibHac allocates package metadata. Common
  tickets are imported before opening NCAs; optional title.keys are supported.
- LibHac uses `IntegrityCheckLevel.ErrorOnInvalid` for Code and RomFS. There is
  no lenient damaged-content mode.
- Browser .NET rejects the platform `Aes.Create` used by LibHac's managed
  fallback. `build/BrowserLibHac.targets` adapts exactly three factory calls in
  a scratch copy of the pinned assembly to `ManagedAes`, backed by
  BouncyCastle.Cryptography 2.6.2. This preserves LibHac's AES-XTS/AES-CTR code.
  The original package is read-only. Mono.Cecil 0.11.6 runs only during the tool
  build and is excluded from browser assets. NIST AES-128/AES-256 ECB and
  AES-128 CBC encrypt/decrypt known answers execute in WASM at runtime startup.
- `BrowserStorage` exposes seekable Int64 input offsets to LibHac. The JS bridge
  uses `FileReaderSync` on at most 1 MiB slices in the dedicated worker, and
  interop copies directly into a bounded WASM MemoryView.
- Each output file gets one OPFS sync access handle. C# reads and decrypts a
  bounded chunk, JS writes it immediately, then the worker yields to service
  cancellation. Handles are flushed and closed at each file boundary.
- No NSP or output files are materialized in WASM MEMFS. Bounded key text files
  exist transiently in MEMFS because the original LibHac public key parser
  expects paths; they are unlinked immediately and never written to OPFS.
- Errors are sanitized and never include supplied key text or library stacks.
  `run` requires a dedicated worker, secure context, OPFS sync access handles,
  and adequate browser storage. Each WASM runtime stays within one worker;
  RomFS parallelism does not require SharedArrayBuffer or isolation headers.

## Build and test

Prerequisites: SDK 10.0.402 with the already installed `wasm-tools` workload;
Bun; the existing dedicated chrome-headless-shell. Do not install workloads
concurrently with another agent.

From the repository root:

```sh
dotnet build tools/browser-builder/wasm/extractor/BrowserExtractor.csproj -c Release
dotnet publish tools/browser-builder/wasm/extractor/BrowserExtractor.csproj -c Release \
  -o tmp/odyssey/browser-extractor/publish -p:RestoreLockedMode=true
cd tools/browser-builder/wasm/extractor
bun install --frozen-lockfile
EXTRACTOR_NSP=/absolute/path/to/base.nsp \
EXTRACTOR_PROD_KEYS=/absolute/path/to/prod.keys \
bun tests/browser-proof.mjs
```

Run terminal commands as detached background jobs with PID, log and exit-status
capture. `Directory.Build.props` puts build intermediates and outputs under
`tmp/odyssey/browser-extractor`, within this task's write scope. Deployable
output is `tmp/odyssey/browser-extractor/publish/wwwroot/`.

`RunAOTCompilation=true` is the Release default, not an optional integration
flag. The lockfile includes the SDK's build-only IL linker. With the verified
packages already cached, an offline publication can add
`-p:RestoreSources="$PWD/tmp/odyssey/browser-extractor/fresh-nuget"`
and `-p:NuGetAudit=false`; use `EMCC_FROZEN_CACHE=1` to reject missing Emscripten
cache entries rather than acquire anything. No workload or dependency download
was needed for the measured publication.

The browser regression uses a separate puppeteer-core/headless-shell process,
local file selection via the browser, and an isolated profile in the scratch
directory. Its local HTTP fixture serves static tool assets only. It never
runs native extraction, launches Player, or controls the user's Chrome.
The proof's CLI filename is deliberately outside Bun's test discovery. Every
invocation uses its own profile and writes compact evidence under
`tmp/odyssey/browser-extractor/tests/<run-id>/`. The default run ID includes the
process ID; `EXTRACTOR_TEST_ID` may supply a unique descriptive ID.

Set both private input locations explicitly with `EXTRACTOR_NSP` and
`EXTRACTOR_PROD_KEYS`; there are no default game or key paths. `EXTRACTOR_CHROME` selects a dedicated headless-shell.
`EXTRACTOR_BUNDLE` selects the built/published `wwwroot` directory. Set it to the
absolute `tmp/odyssey/browser-extractor/publish/wwwroot` path to test the exact
publication output; the test serves all modules from that directory.
`EXTRACTOR_FULL=1` adds complete RomFS extraction to the real-input suite.
Private inputs are not test fixtures or tracked assets.

`EXTRACTOR_WORKERS=4` forwards the requested pool size through every test job,
including cancellation; `EXTRACTOR_WORKERS=1` forces the reference path. Omit it
to exercise the API default of up to four workers. The proof records actual
`progress.workers`, checks every reported I/O maximum against 1 MiB, and groups
child counters by the retained reference enumeration's round-robin partition.
Cancellation observes the parent and nested worker targets while the ownership
marker exists, then requires the root and workers to disappear and the earlier
ExeFS output hashes to remain unchanged.

For the four-worker full comparison, keep the existing local private-input
variables and set `EXTRACTOR_FULL=1`, `EXTRACTOR_WORKERS=4`,
`EXTRACTOR_EXPECT_AOT=1`, and `EXTRACTOR_COMPARE_EVIDENCE` to
`tmp/odyssey/browser-extractor/tests/aot-optimized-measured/evidence.json`
(absolute path). That retained 4,643-file sequential AOT proof is the hash oracle;
no additional full input corpus copy is needed.

The proof records extraction time separately from output verification, hashes
every actual output in the browser, and removes its owned profile after closing
the browser. It refuses an existing run directory. Set `EXTRACTOR_EXPECT_AOT=1`
to require the actual served native runtime's AOT setting, and
`EXTRACTOR_COMPARE_EVIDENCE=/absolute/baseline/evidence.json` to require identical
paths, sizes and SHA-256 values. Hash verification is serial and bounded to the
supported corpus's files of at most 128 MiB; the complete NSP is never buffered.

For the focused optional-icon regression, set `EXTRACTOR_ICON_ONLY=1` and
`EXTRACTOR_ICON_REFERENCE` to an existing native `icon.jpg`. This mode only
extracts control/ExeFS and compares both icon hashes inside the browser; it
skips negative/cancellation cases and full RomFS even if `EXTRACTOR_FULL` is set.

## Dependency provenance

LibHac is pinned to NuGet 0.19.0, MIT, source revision
`cd4004af194a51712812c680f0a028ba9152c0f8` from its package metadata.
`packages.lock.json` records the package content hash. The public artifact
contains open-source tool/runtime code only. The separate repository licensing
audit owns publication approval and consolidated dependency notices.

LibHac's hidden NuGet package page does not prevent package retrieval. A fresh
locked restore into an empty directory passed on this machine with HTTP
caching disabled and fallback folders cleared:

```sh
dotnet restore tools/browser-builder/wasm/extractor/BrowserExtractor.csproj \
  --packages "$PWD/tmp/odyssey/browser-extractor/fresh-nuget" \
  --no-http-cache --force --locked-mode --source https://api.nuget.org/v3/index.json \
  --verbosity normal \
  -p:BaseIntermediateOutputPath="$PWD/tmp/odyssey/browser-extractor/fresh-restore-obj/" \
  -p:RestoreFallbackFolders= -p:RestoreAdditionalProjectFallbackFolders=
```

The log records GET/OK for the public flat-container `libhac.0.19.0.nupkg` and
the same SHA-512 content hash as the lockfile. See
`tmp/odyssey/browser-extractor/jobs/fresh-public-restore.log` for exact evidence.

Official worker hosting reference:
https://learn.microsoft.com/en-us/aspnet/core/client-side/dotnet-on-webworkers?view=aspnetcore-10.0

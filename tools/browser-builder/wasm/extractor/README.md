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
}, progress => postMessage({ type: 'progress', stage: 'extract', ...progress }));

// result.titleId, result.version, result.mainBuildId
// result.files = [{ path: 'ExeFS/main', size: ... }, ...]
```

Deploy the complete published `wwwroot` directory together. The module resolves
`./_framework/dotnet.js` relative to itself, so a GitHub Pages subpath works.
Only one extraction may run in a given worker at a time. The host owns the job
directory and should terminate the worker and remove the directory when the
user cancels. Normal failures and cooperative `signal` cancellation close sync
handles and remove this module's partial files before rejecting.

Publication deliberately sets `PublishTrimmed=false`. LibHac's net7.0 assembly
requires framework forwarding facades that must remain in the WASM dependency
graph. Use a clean scratch `obj`, `bin`, and publication directory when changing
trimming settings; mixed old/new framework artifacts fail at runtime.

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

The optional `extractor-client.js` / `extractor-worker.js` pair supplies an
isolated worker adapter used by the browser regression test. The production
shared pipeline can import `run` directly without this adapter.

The RomFS copy path passed a real complete base-NSP extraction: 4,642 files,
5,527,856,754 bytes, with a maximum 1 MiB physical input read and passing WASM
NIST crypto checks. Optional icon preservation adds one verified 92,548-byte
file for this input. The current control/ExeFS proof writes seven files and
matches the native icon's SHA-256. Full output is therefore expected to contain
4,643 files totaling 5,527,949,302 bytes; the unchanged RomFS copy was not rerun
for this optional-icon addition. See `EVIDENCE.md` for exact evidence.

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
  and adequate browser storage. No SharedArrayBuffer or isolation headers are
  required by this single-threaded WASM implementation.

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

# Shader-chain API

Publish the complete prepared directory from `tmp/odyssey/browser-shader-chain/bundle/`.
Its `index.mjs` exports:

```js
await run({inputDirectory, outputDirectory, profileDirectory?, signal?, bundleURL?}, progress);
// => {chain, inputs, shaders, files: [{path, size, sha256}], provenance, ...}
```

`inputDirectory` is the extracted root with `ExeFS/main` and `RomFS/`.
For zero-copy proofs against an existing local extraction, supply
`inputFiles: [{path: 'ExeFS/main', file: actualFile}, ...]` instead of
`inputDirectory`. This mounts those actual File blobs read-only; it does not
copy the source corpus into OPFS. Production can keep using the extractor's
original OPFS directory. Never provide both forms.
`outputDirectory` is an empty OPFS graphics root for this job. `profileDirectory`,
when supplied, is a local profile folder containing game.tsv and optional authored
shader_facts_manual.tsv / bf_want.tsv; generated maps/facts/pairs are always made
from this user's input. Initial support is exactly Odyssey main build
`3ca12dfaaf9c82da064d1698df79cda1` (v0). Cancellation terminates the worker.

Output paths are relative to graphics root:

- `shader/cache/b-<chain>/*.metal`, reflection `*.json`, and `inputs.tsv`.
- `profile/0100000000010000/*.tsv` including generated shader_map/facts/pairs,
  c1_full and cb_extent, plus game.tsv.
- `shader-chain.json`: complete per-job output manifest and public provenance.

Read the runtime's required DMSH_CHAIN from the prepared bundle's `CHAIN.json`.
`BUILD-META.json` exposes the integration schema directly: `shaderChain`,
`pipeline: "index.mjs"`, `shaderOptions: {}`, `nativeDefines.DMSH_CHAIN`, source
revision and output prefixes. Read that metadata only after bundle preparation
finishes, and use the same prepared bundle for the runtime and site publication.
It fingerprints actual verified WASM tools, pinned unchanged Python rule sources,
the serial/storage adapter and Pyodide. Never use nxnative's native-chain string
for this backend. Match `graphics.chain` to the native template shaderChain.

Install the pinned Pyodide LZMA wheel once with
`bun tools/browser-builder/pipeline/shaders/install-dependencies.mjs` (tool download
only; no private input), then prepare with
`bun tools/browser-builder/pipeline/shaders/build.mjs` as a captured
background job. This only copies public tools/source; it does not read game data.
Reuse the ready rewriter Pyodide distribution and Volta's verified public outputs.
No Apple compiler, font, private shader table or game file enters that bundle.

Progress events include `{stage, message, completed?, total?, fraction?}`.
The single worker runs real Pyodide plus synchronous Maxwell/Cross WASM calls;
no SharedArrayBuffer, cross-origin isolation, helper or upload is required.
The adapter accepts VS/PS/CS/GS and maps the original `spirv-cross INPUT --version
450` call to synchronous `cross.translateGlsl`. All three Odyssey GS programs
continue through unchanged `gs_slice` and `geometry_finish`; topology variants
and reader SPIR-V are retained. These are compute geometry, not invented layer
folds. The frozen prepared `198729df4d5a` bundle includes API-v2 GS/GLSL, the
fetch-source cleanup fix, and Cross SDK 1.4.363.0 at
`f11ba9f0b21ba8fc15153d50a2a1ae31ab1cf8f7`. Cross WASM SHA-256 is
`3c2cb111fe59bff9a1aea14fc63fe14e83c8d625db6470c35f9605248064048c`.
Earlier browser fingerprints are superseded.

Verification uses `bun tools/browser-builder/pipeline/shaders/test/prepare.mjs`
then `bun tools/browser-builder/pipeline/shaders/test/browser.mjs`. The eleven real
V/P/C/GS samples emit 65 source/reflection/table files in the final regression,
including two required fetch records, two depth-alias records and an actual
31,542,483-byte MSL program. Export and SHA-256 hashing stream in chunks of at
most 4 MiB; valid source size is not capped at 16 MiB. All 15 GS topology jobs
and all three readers have byte-exact MSL and equal functional reflection
against the prepared native `b-dec5ee141a9f` oracle. Only the backend chain and
the reduced fixture's diagnostic source-record index differ. The API checks
exercise real split cancellation, cleanup, input/output isolation, existing
output preservation and invalid-chain rejection.

The final release proof belongs to Main's one integrated fresh NSP-to-DMG run.
Do not duplicate its extraction or run a second standalone full library.

Before any game/GPU launch, compare the mounted app using local CPU file reads:

```sh
bun tools/browser-builder/pipeline/shaders/test/compare-native.mjs \
  --game "/Volumes/Your mounted app/Your.app/Contents/Resources/game" \
  --expected-chain 198729df4d5a \
  --report tmp/odyssey/browser-shader-chain/mounted-dmg-comparison.json
```

The comparator reads the embedded shader-chain.json, hashes every declared
actual file and checks its size before trusting its digest. Its own omitted
manifest entry is intentional. It requires the exact 39,185 current source names
(27,210 base + 18 GS helpers + 1,312 shadow + 10,645 fetch), all 27,228 reflection
files, canonical JSON equality, guard bodies/stamps and a recomputed profile
input digest. JSON object order and backend identity are normalized; array order
and source-record indices are preserved. Known legacy depth-alias differences
are classified explicitly and do not pass the final compatibility gate. Native
cache files that are outside current reflection requirements are reported as
extras, rather than blindly becoming required outputs.

`--proof /absolute/path/proof.json` accepts the old {manifest, stamp, guards}
wrapper or the direct embedded manifest. Pair it with `--game` to verify actual
files. A hash-only proof can classify differences but can never return passed.
No output report overwrites the original failed proof or writes into the app.

The module also exports `compareNative(manifest, {gameDirectory, expectedChain})`
for a caller that already parsed the mounted manifest. It returns a report with
`passed`, `actualFileChecks`, exact source-name groups, source byte totals,
canonical reflection counts, table checks and unresolved issues.

The current retained 57e full proof remains a failure: all 10,645 required fetch
files were removed by the old storage suffix collision, and 536 pixel sources
used the earlier Cross depth representation. Its map/facts/pairs and both guard
bodies matched the native oracle. It is not evidence for the final candidate.

Comparator regression commands (the first deliberately returns status 1):

```sh
bun tools/browser-builder/pipeline/shaders/test/compare-native.mjs \
  --proof tmp/odyssey/browser-shader-chain/full-library-proof.json \
  --report tmp/odyssey/browser-shader-chain/legacy-classification-current-checker.json
bun test tools/browser-builder/pipeline/shaders/test/compare-native.test.mjs
```

All commands run as background jobs with captured PID, log and exit status.
Private proof manifests and current fixtures stay under
`tmp/odyssey/browser-shader-chain/`; do not publish them. The isolated regression
closes its owned headless browser and removes its own OPFS profile.

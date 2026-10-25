# Ready for higher Python shader-chain adapter

Initialize once in the same dedicated worker that runs Pyodide:

```js
const { createShaderTranslator } = await import('/tools/shaders/maxwell/shader-translator.mjs');
const { createMslTranslator } = await import('/tools/shaders/cross/translator.mjs');
const maxwell = await createShaderTranslator();
const cross = await createMslTranslator();

// Both calls below are synchronous, suitable for synchronous subprocess adapters.
const translated = maxwell.translateBatch(entries);
// entries: Array<{ job: the native job object, code: Uint8Array }>
// translated: Array<{ key, spirv: Uint8Array, resources: Object, readerSpirv: Uint8Array | null }>
const source = cross.translate(translated[0].spirv); // string, flags match native XC
```

Replace the example asset prefix with the caller's actual static mount paths.

Built Maxwell assets: tmp/odyssey/browser-shaders/publish/wwwroot/ (copy entire directory).
Maxwell now uses source-built .NET LLVM AOT with -O3. The synchronous public API
and shader options are unchanged. The installed 10.0.402 SDK/10.0.13 wasm-tools
compile the original source-linked translator; no downloaded runtime replacement
or patched Ryujinx implementation is used. AOT requires trimming, with explicit
roots for the translator, Ryujinx.Graphics.Shader, Ryujinx.Common and
Spv.Generator. IL remains available for reflection/generic fallback.

The accepted AOT publication has passed the existing V/P/C, depth-alias, and
complete geometry browser proofs offline. The real-sample comparison covers 25
jobs, one job per translateBatch call, with seven timed warm rounds. All SPIR-V,
resource JSON and reader bytes match both native and interpreter references.
Measured warm medians for V/P/C, geometry and depth were 75.1 -> 22.4 ms,
201.0 -> 62.3 ms and 24.2 -> 6.8 ms respectively (3.2..3.6x). These are sample
timings, not a whole-library AOT result. Worker startup was 90.0 -> 182.7 ms;
total publication bytes were 14,487,399 -> 34,428,919.

Private evidence: tmp/odyssey/browser-shaders/maxwell-aot-proof-1792954669/,
including benchmark.json, vpc-proof.json, depth-proof.json and geometry-proof.json.
The verified candidate was promoted to the standard publish directory only
after checking no higher-pipeline copy was active. Keep that directory stable
while consumers copy it. All higher toolchain/CHAIN identities and matching
native runtime headers must be rebuilt by their owner because tool bytes changed.
Built Cross assets: tmp/odyssey/browser-shaders/cross/translator.mjs, spirv-cross.mjs,
spirv-cross.wasm and SPIRV-Cross.LICENSE (copy these four; exclude native-spirv-cross).
The API itself handles .NET's worker sidecar flag before runtime import.

jobs use the untouched native Program.cs metadata contract. Key must contain
ASCII letters/digits/underscore/hyphen only; stage must be vs, ps, cs or gs. A missing
or failed shader throws; all temporary inputs and outputs are cleared after each
batch. The caller owns output arrays and must release them after writing its
working filesystem. Retain geometry readerSpirv when present.

No MSL rules are applied in this slice; feed the exact source and resource
metadata to the original higher Python rules. Native first-launch Metal
compilation (with preserveInvariance) is approved and belongs to the runtime.

Verified: three actual Odyssey shaders (VS/PS/CS), correct instruction-only
compute fixture, exact native SPIR-V/resource metadata and pinned native Cross
MSL, equal dedicated-worker outputs, offline conversion, zero HTTP requests
during conversion. Private evidence: tmp/odyssey/browser-shaders/browser-proof-cross.json.
Source pin: SPIRV-Cross f11ba9f0b21ba8fc15153d50a2a1ae31ab1cf8f7,
official vulkan-sdk-1.4.363.0 tag matching Homebrew 1.4.363.0.

## Geometry support (API version 2; rebuild required)

The same createMslTranslator() result now also exports synchronous
translateGlsl(spirv, { version: 450 }) -> string, exactly the desktop GLSL path
used by original gs_slice(): spirv-cross INPUT --version 450.
The .NET translateBatch guard accepts stage gs. Supply geometry_topology 0..4
for the original geometry-to-compute path; readerSpirv is returned unchanged.

Odyssey v0's three actual GS keys are 38dec326b62f6f73, 054f1e996331de9f,
653761faae9ece8c. Native reflection classifies them as real compute geometry
(2,64,64 output vertices, line-strip output), not layer-only folds. Original
gs_slice must return None for these; higher Python must continue into original
geometry_finish, not drop them or invent fold metadata.

All prior tool/CHAIN fingerprints are superseded when these new assets are
built. Rebuild the higher public shader bundle/CHAIN and matching runtime header.
Verified: all 3 actual GS have exact native SPIR-V, resources and GLSL; original
gs_slice executed in real browser Pyodide through translateGlsl returns None
for each, exactly as native. All 15 topology variants and 15 reader shaders
match native SPIR-V, flattened descriptors, raw MSL and original Python geometry
postprocessing. Dedicated-worker GS conversion and offline operation pass.
Private evidence: tmp/odyssey/browser-shaders/geometry-proof.json.
VS/PS/CS regression still passes with the new API and WASM assets.

Subprocess dispatch for original gs_slice is precise: argv has no --msl and
contains --version 450; read its SPIR-V from the Python work FS, call
cross.translateGlsl(bytes,{version:450}), return that actual string as stdout.
When original gs_slice returns None, call original geometry_finish; retain all
five geometry_topology jobs and the reader SPIR-V, then apply original
flatten_sets/topology_pointer/precise/vs_init/vs_layer functions unchanged.
No GS should be dropped, converted to an empty fold, or sent straight to MSL.

## Cross depth-alias correction (1.4.363.0)

The ready tmp/odyssey/browser-shaders/cross assets now use the official revision
above and Emscripten 6.0.13. API v2 is unchanged. No C# source or Maxwell semantic
change was required. All four canonical-oracle jobs match the installed native
Homebrew output exactly, including spvDepthCast; fresh native compilation of the
same official source also matches those four outputs exactly. V/P/C and all 15
GS topologies plus all 15 readers pass again, offline in isolated headless Chrome.

Private proof: tmp/odyssey/browser-shaders/cross-363-proof.json and the referenced
V/P/C, depth-alias and geometry proof files. The license asset now combines exact
upstream license texts and required source notices; sources.json pins all compiled
source/header and license hashes. Copy only translator.mjs, spirv-cross.mjs,
spirv-cross.wasm and SPIRV-Cross.LICENSE from cross; exclude native-spirv-cross.

Main/Hypatia must rebuild the public shader bundle/CHAIN and matching native
runtime header before promotion. release/licenses.mjs still hardcodes the former
7affe revision and Apache-only declaration; its owner must update that inventory
to the new revision and sources.json license expression. This slice does not edit
release/pipeline scopes or canonical dist/runtime-final assets.

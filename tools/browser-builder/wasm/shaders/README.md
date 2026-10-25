# Browser WASM shader translation

The browser runs the original Maxwell-to-SPIR-V translator and pinned SPIRV-Cross.
No native translator, upload, helper service, Metal compiler, or game shader is
part of the deployed tool bundle. The local proof server serves static tool
assets only. The generated MSL is intended for the runtime's approved first-launch
native Metal compilation with preserveInvariance.

## Build

Prerequisites: .NET SDK 10.0.402 and installed wasm-tools (runtime pack 10.0.13),
Emscripten 6.0.13, Bun, and the existing nxnative checkout. These scripts never
install the .NET workload. All build products go to tmp/odyssey/browser-shaders.
Maxwell Release builds compile the .NET assemblies to native WASM with LLVM AOT
and -O3, using the installed workload's Emscripten toolchain. AOT requires IL
trimming, so ShaderTranslator, Ryujinx.Graphics.Shader, Ryujinx.Common and
Spv.Generator are explicit trimmer roots. Their original source stays unchanged.
IL is retained for reflection and any generic interpreter fallback.

SHADER_OFFLINE=1 restores from the existing local NuGet cache only, with an
empty local package source and auditing disabled; a missing dependency fails
without contacting a package feed. Normal CI builds retain their existing NuGet
restore behavior. The script never installs tools or workloads.
Only one Maxwell build may own its captured build lock at a time.
Run from the repository root:

```sh
bun install --cwd tools/browser-builder/wasm/shaders
sh tools/browser-builder/wasm/shaders/build.sh
sh tools/browser-builder/wasm/shaders/build-spirv-cross.sh
```

Set SHADER_PUBLISH_DIR to a separate directory under
tmp/odyssey/browser-shaders to build a candidate without changing the standard
publish/ directory. Test that candidate with SHADER_MAXWELL_ROOT pointing at its
wwwroot. SHADER_PROOF and SHADER_BROWSER_PROFILE select private evidence/profile
paths for both browser.test.mjs and geometry.test.mjs. Do not replace the standard
publication while the higher pipeline is copying it; frozen public releases are
never build output targets.

For a local build without network/package downloads, prefix the build command
with SHADER_OFFLINE=1. The accepted AOT comparison was built with only local
package sources and installed workloads.

Deploy only these tool directories:

- tmp/odyssey/browser-shaders/publish/wwwroot/ as the Maxwell tool directory.
- tmp/odyssey/browser-shaders/cross/spirv-cross.mjs, spirv-cross.wasm,
  translator.mjs and SPIRV-Cross.LICENSE as the MSL tool directory.

Never deploy fixtures/, native-output/, browser-output/, test profiles, logs,
proof jobs, or the native test executable. Those contain private test material
or native-only verification tools. No shader code is stored under this source
folder. Keep the .NET framework directory and content-hashed filenames together.

## Callable API

```js
import { createShaderTranslator } from './maxwell/shader-translator.mjs';
import { createMslTranslator } from './cross/translator.mjs';
const maxwell = await createShaderTranslator();
const cross = await createMslTranslator();
const outputs = maxwell.translateBatch([
  { job: { key: 'shader_key', stage: 'vs', tex: {}, img: {}, attr: {}, fout: {}, c1: '', debug: true, reduced: true }, code: userShaderBytes },
]);
for (const output of outputs) {
  // output: { key, spirv: Uint8Array, resources: object, readerSpirv: Uint8Array | null }
  const msl = cross.translate(output.spirv);
  // Forward MSL + resource metadata to the existing higher-level MSL rules.
}
```

Both translation calls are synchronous after initialization. Use bounded batches
in a module worker so they do not block the page or retain the whole library.
Initialization selects the .NET standalone worker sidecar before importing
dotnet.js. Without this, .NET 10 mistakes an existing onmessage handler for one
of its own pthread workers and stalls. This is internal to createShaderTranslator.
Each batch clears its in-memory filesystem in a finally block. The caller owns
returned arrays. Job metadata follows the untouched native Program.cs contract;
code paths are replaced with per-batch memory paths. Duplicate/unsafe keys,
unsupported stages and absent byte inputs fail clearly. A batch with any failed
translation throws instead of presenting partial outputs as complete.

The low-level JSExport methods are at maxwell.api:
WriteFile('/in/0.bin', Uint8Array), Translate(jobsJson) -> native exit code,
ReadFile('/out/key.spv') -> Uint8Array, GetDiagnostics() -> string, and Reset().
Translate uses /jobs.json and /out in the WASM memory filesystem. It preserves
private SwshXlate.Main through DynamicDependency and invokes it via reflection.
StartupObject points at an empty wrapper Main; OriginalProgram.cs is linked
unchanged. verify-sources.mjs checks both original source hashes before builds.

SPIRV-Cross emits MSL 2.3 with argument buffers, native texture buffers and padded
fragment outputs, exactly matching dmsh_build.py XC. It does not apply Python
MSL rewrites, resource-binding postprocessing, pair padding, or Metal compilation.

## Worker messages

Create new Worker('./maxwell/shader-worker.mjs', { type: 'module' }). Send a unique
id with every request and wait for its response:

- { id, type: 'init', mslTranslatorUrl: absoluteUrlToCrossTranslator } -> { id, type: 'ready' }.
  Omit mslTranslatorUrl for Maxwell-only translation.
- { id, type: 'translate-batch', entries: [{ job, code: Uint8Array }] } ->
  { id, type: 'result', outputs }. Outputs have the fields above plus msl when
  Cross was initialized. SPIR-V buffers are transferred to the parent.
- Errors return { id, type: 'error', error: message }.

Terminate the worker to cancel an active synchronous WASM translation. Start a
fresh worker for the next job; no input or output is persisted by these modules.

## Real browser proof

The full proof reads three actual user-local Odyssey package records (vertex,
pixel, compute), applies the extracted profile's facts, runs untouched native
Program.cs as a reference, and compiles the same pinned SPIRV-Cross C++ wrapper
natively. It uses only the dedicated chrome-headless-shell and an isolated
profile under tmp/odyssey/browser-shaders. No Player or user browser is opened.

```sh
sh tools/browser-builder/wasm/shaders/tests/prove.sh
```

The test verifies exact SPIR-V bytes, exact resource JSON, exact MSL text, failure
propagation, repeated batches and input/output cleanup. Tool assets are loaded
first; translation then runs offline and must make zero additional HTTP
requests. Private proof JSON, shader bytes and generated text stay in tmp.
SHADER_GAME_DIR, SHADER_JOBS, SHADER_NATIVE_OUTPUT and HEADLESS_SHELL can select
local fixtures and the isolated browser binary. Source pins and measured tool
versions are in sources.json. The normal .NET publish currently emits IL2026
warnings from original JsonArray.Add calls; real reflection output equality is
checked, including nonempty resource tables. The original source is not patched.

The shader module proof does not establish whole-library coverage or a playable
DMG. The main pipeline owns extraction, all higher MSL rules, packaging and runtime
first-launch compilation.

For a comparison of an existing interpreter publication and an AOT candidate,
run the real-sample benchmark after both builds are idle:

```sh
bun tools/browser-builder/wasm/shaders/tests/benchmark.mjs \
  /absolute/private/interpreter/wwwroot /absolute/private/aot/wwwroot \
  /absolute/repository/tmp/odyssey/browser-shaders/comparison.json
```

It times only the real Maxwell translateBatch calls in an isolated module worker,
after startup and with network disabled. It uses the existing V/P/C, all geometry
topologies/readers, and depth-alias fixtures, with one job per call as in the
higher pipeline. Every repeated result must match
the native SPIR-V bytes and resource JSON; interpreter and AOT fingerprints must
also match. The first batch and seven subsequent timings are reported separately,
along with startup times. These sample timings do not establish whole-library
speed or a playable release.

## Sources and licenses

- Original translator and source-linked Ryujinx: nxnative revision 0045c1dfb639f9775891382646ad38c2a11c56bf (MIT).
- SPIRV-Cross: https://github.com/KhronosGroup/SPIRV-Cross/tree/f11ba9f0b21ba8fc15153d50a2a1ae31ab1cf8f7 (official vulkan-sdk-1.4.363.0 tag, matching Homebrew 1.4.363.0).
- .NET browser API: https://learn.microsoft.com/en-us/aspnet/core/client-side/dotnet-interop/wasm-browser-app?view=aspnetcore-10.0

Redistribute upstream license/notice files with tool assets. build.sh copies the
native project's and Ryujinx license files; the Cross build copies its license.

Cross builds verify SHA-256 for the complete compiled source/header closure and
upstream license files. SPIRV-Cross.LICENSE contains the upstream Apache, MIT,
Khronos and CC license texts plus the compiled files' copyright notices.
sources.json records the source commit/tree, Homebrew formula archive digest,
individual source/license hashes and the combined license digest. The build
requires Emscripten 6.0.13. A cached checkout at an older revision must be moved
to the pinned tag explicitly; the build never overwrites an unrelated checkout.

The former 7affe pin omitted spvDepthCast in some fragment outputs. The 1.4.363.0
WASM build matches four canonical native fragment oracles exactly, including
both affected depth-alias cases and both controls. V/P/C and all 15 geometry
topology variants plus all 15 readers also match native. This changes Cross tool
fingerprints: rebuild the higher shader bundle/CHAIN and matching runtime header.

## Geometry and GLSL (API v2)

The Cross instance also exports synchronous translateGlsl(spirv, {version:450}),
matching native spirv-cross INPUT --version 450 for original gs_slice().
The Maxwell batch API accepts gs. Supply geometry_topology 0..4 for the
original compute-emulation path; each result includes its readerSpirv. The
module worker returns glsl for a plain GS and msl for a topology-lowered job.

All three Odyssey v0 GS are real line-strip emitters (2,64,64 output vertices),
so original gs_slice returns None and original geometry_finish must execute.
Browser proof covers those three GLSL outputs, all 15 topology variants and all
15 reader shaders, including exact original Python postprocessing; no native
fallback is used in the browser. Re-run with tests/prove-geometry.sh.
The prior VS/PS/CS proof also passes after these changes. Rebuild the public
higher shader bundle, CHAIN identity and matching runtime header afterward.

## Fresh publication dependency check

The browser project directly references Spv.Generator and publishes the complete managed dependency graph. A fresh publish previously omitted this transitive assembly even though the existing local cache could translate shaders. The build now verifies the actual WebAssembly assets for ShaderTranslator, Ryujinx.Graphics.Shader, Ryujinx.Common, Spv.Generator and System.Runtime before the public tool bundle is assembled. The original translator sources and options remain unchanged.

`bun tools/browser-builder/wasm/shaders/verify-publish.mjs /absolute/published/wwwroot` checks an existing publication. Real shader acceptance still compares translated output against the native reference.

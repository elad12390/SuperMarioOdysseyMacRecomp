# Public browser tool release

This assembler publishes only static browser tools and public source/notices. It
never reads game-data, private input files, native test fixtures, Player state,
or the separate generic native runtime template. No Apple Metal compiler or
Apple signing executable is copied. Main owns site build.ts and root CI.

## API after Main's last UI build

```js
import { assemble } from './release/assemble.mjs';
import { defaultAssets } from './release/options.mjs';
const tools = await assemble({ outDir: siteToolsDirectory, ...await defaultAssets() });
// tools.entrypoints = {
//   extractor: 'extractor/extractor.js',
//   rewriter: 'rewriter/index.mjs',
//   shaderPipeline: 'shaders/index.mjs',
// }
// tools.shaderOptions = { bundleURL: './' }
// tools.shaderChain is the exact higher pipeline CHAIN.json value.
```

Callers may supply extractorWwwroot, rewriterBundle, shaderPipelineBundle,
nugetAssets: {extractor, shaders}, and dotnetRuntimePack explicitly. The NuGet
paths must be the actual project.assets.json files for those builds. Override
repoRoot/stageSourceRoot only when source recipes were built in another exact
public source mirror. outDir is mandatory. No code chooses or wipes dist.
An empty output directory or an earlier bundle owned by this assembler may be
replaced. Missing dependencies, failed hashes, unknown files, missing licenses,
unsafe paths, and native binaries fail before the previous output is removed.

The returned shaderChain must match the native runtime header/template before
Main publishes build-manifest.json. GS API v2 changes require rebuilding the
higher shader bundle and CHAIN after Hypatia's GLSL adapter is integrated.
Resource sealing runs after all private game files/assets have been added and
before DMG generation; that ordering is Main-owned. The hash-wasm license and
actual SHA-1/SHA-256 implementation notices are included here. No Developer ID
or notarization is asserted by this tool release.

## Build commands

Assemble completed modules without rebuilding or running game fixtures:

```sh
bun tools/browser-builder/release/build.mjs --out-dir OUTPUT --reuse-built
```

Build the real stages while reusing the finished rewriter runtime/wheels:

```sh
bun tools/browser-builder/release/build.mjs --out-dir OUTPUT \
  --reuse-rewriter-bundle tmp/odyssey/browser-rewriter/bundle
```

For a clean CI host, omit both reuse options. Prerequisites are .NET SDK
10.0.402 with already-installed wasm-tools/runtime pack 10.0.13, Emscripten
6.0.13 for Cross, Bun, uv, git, make and a host C compiler. Workload installation
belongs to host setup, not this build. Main installs signing dependencies with
the signing module's frozen Bun lockfile before assembling.

The full command invokes actual module entry points in order: extractor dotnet
publish, canonical rewriter dependency build (or prepare/finalize for verified
existing wheels), Maxwell dotnet publish, pinned Cross em++, canonical shader
LZMA installer, and higher shader bundle preparation. Every child process has
PID, log and exit-status files under tmp/odyssey/browser-release-tools/build-jobs.
The executable build plan is recorded beside those logs. These are tool builds;
no native game conversion or multi-gigabyte private test fixture is run.

An exact public-source mirror keeps builders' fixed scratch paths within this
slice. It links read-only source dependencies to the canonical nxnative checkout
and does not duplicate SDKs or the game tree. Publish directories are cleared
before rebuilding to avoid stale .NET content-hashed files. Shared build caches
are reused. Keep the failed-job logs for diagnosis; clean only this task's own
inactive scratch outputs. The full fresh rewriter toolchain bootstrap is exposed
for CI; the local tested path reuses the already proven rewriter bundle.

## Publication contents and integrity

The output contains extractor/, rewriter/, shaders/, source/, licenses/,
dependencies.json, sources.json, THIRD-PARTY-NOTICES.md, manifest.json and
SHA256SUMS. The manifest lists each payload file's byte size, SHA-256 and binary
format. SHA256SUMS covers all payload files plus manifest.json; it excludes its
own recursive checksum. No timestamp or local filesystem path enters public
metadata. Original higher shader CHAIN/toolchain files remain byte-identical.

Stage copies use explicit path/type allowlists and verify the stage manifests,
embedded OSS source hashes, official Pyodide wheel hashes and shader component
fingerprints. Wheels and the Python standard-library ZIP are inspected inside.
Mach-O, ELF, native PE, native static archives, symlinks, path escapes, private
input names, metallibs and generated MSL are rejected. Managed PE DLLs and WASM
assemblies are accepted by content, including legitimate .wasm.dll names.

Actual license texts/notices cover CPython, Pyodide, Capstone, python-lz4/LZ4,
LZMA/liblzma, nxnative, LibHac, Bouncy Castle, Mono.Cecil (build-only), .NET runtime,
Ryujinx, Spv.Generator/Khronos grammar, Cross's complete license catalog,
Emscripten/LLVM/libc++/musl runtime pieces and signing's hash-wasm. All resolved
NuGet packages, including dependencies later trimmed or used only at build time,
have exact versions, metadata, content hashes, archive hashes, source origins and
license files. The SDK's real NuGet implementation verifies signature-independent
content hashes and signed package integrity; raw archive hashes are recorded
separately. The SDK verifier is build-only and never enters the static bundle.

## Verify and test

```sh
bun tools/browser-builder/release/verify.mjs OUTPUT
bun tools/browser-builder/release/tests/release.test.mjs
```

Tests assemble actual delivered stages twice and require byte-identical manifests
and checksums. They verify complete license inventories, signed NuGet integrity,
real native-binary rejection, real managed-DLL acceptance, missing-component
failure preserving earlier output, unknown-file rejection and checksum failures.
Evidence stays in tmp/odyssey/browser-release-tools. No Rust tests or new Rust
targets are involved. Full 27,210-shader/gameplay/signing/DMG validation belongs
to Main's integrated pipeline, not the static-asset audit.

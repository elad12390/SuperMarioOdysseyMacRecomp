# Public browser tool release API

Import { assemble } from './release/assemble.mjs' in Main's site build.
The async call accepts:

```js
const result = await assemble({
  outDir,                    // Main supplies dist/tools; tests use release scratch
  extractorWwwroot,          // complete published extractor wwwroot
  rewriterBundle,            // completed canonical rewriter bundle
  shaderPipelineBundle,      // completed higher shader-chain bundle
  nugetAssets: { extractor, shaders }, // actual project.assets.json paths
  dotnetRuntimePack,         // Microsoft.NETCore.App.Runtime.Mono.browser-wasm/10.0.13
});
// result: { format, entrypoints, shaderOptions, shaderChain, manifestSha256, files, bytes }
// entrypoints: extractor/extractor.js, rewriter/index.mjs, shaders/index.mjs
```

The assembler reads existing stages, verifies declared hashes/source pins and
browser binary formats, and copies only allowlisted public files. It writes
manifest.json, SHA256SUMS, sources.json, dependencies.json and actual license
texts/notices. It does not run game inputs, native verification executables,
Apple Metal tools or the separate generic-runtime bundler.

bun tools/browser-builder/release/build.mjs --out-dir PATH --reuse-built
assembles existing default local stages. Without --reuse-built it invokes the
existing stage builds from an isolated source mirror under
 tmp/odyssey/browser-release-tools, so the builders' fixed scratch paths stay
inside this release slice. Missing components or licenses fail explicitly.

The higher shader-chain bundle and its CHAIN.json are kept byte-identical;
Main should use result.shaderChain for its runtime template match. Site build
and root CI remain Main-owned. See README.md for final commands and audit proof.

Current higher GS requirement: API v2 exposes translateGlsl(bytes,{version:450});
all 3 actual GS require original geometry_finish after gs_slice returns None.
Rebuild higher CHAIN and native runtime header after integration. Signing is
Main-owned; hash-wasm notices are included, no native signing helper ships.

Entrypoint strings are relative to outDir. With outDir=dist/tools and a catalog
at dist/build-manifest.json, catalog URLs must be tools/extractor/extractor.js,
tools/rewriter/index.mjs and tools/shaders/index.mjs (prefix tools/).
The shaderOptions bundleURL=./ is relative to the shader module itself.

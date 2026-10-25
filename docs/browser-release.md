# Browser-only macOS release

The source is published at [elad12390/SuperMarioOdysseyMacRecomp](https://github.com/elad12390/SuperMarioOdysseyMacRecomp).

The release goal is a GitHub Pages website where the user selects their own
Super Mario Odyssey base 1.0.0 NSP and console keys and downloads a standalone
Apple Silicon macOS DMG. Private inputs and generated game files stay on the
user's device. There is no upload endpoint, build server or native conversion
helper.

The user explicitly approved macOS compiling the browser-translated Metal
shader source on the generated app's first launch. Extraction, instruction
rewriting, Maxwell-to-SPIR-V translation, Metal source generation and disk-image
assembly run locally in browser workers.

## Current verified state

This repository now contains only the Odyssey browser builder, native runtime
and harness. The unused generic Rust, specification, sample-title and AWS
automation scaffolding has been removed.

The complete local browser-to-gameplay path is verified. A real browser build produced a 7.01 GB DMG; its relocated app passed all seven native gameplay/audio checks. Public GitHub Pages deployment is the remaining release step.

| Surface | Evidence |
| --- | --- |
| File intake | Real isolated browser selection and malformed-input rejection pass; no private upload request; desktop/mobile captures inspected. |
| Extraction WASM | Real 5.61 GB NSP extraction and NCA integrity checks pass; all RomFS files and the app icon match the local native oracle. |
| ARM64 rewriting WASM | All three modules and their 18 binary/TSV outputs match the original native pipeline. |
| Shader WASM | Real vertex, pixel and compute outputs match native SPIR-V, metadata and MSL. All three geometry shaders pass all five topology/reader variants. The corrected compiler matches the native depth cases. The actual app contains all 39,185 required Metal variants; all 66,422 declared shader/profile files pass size and hash verification, 27,228 available native sources match exactly, and all 27,228 reflection records match canonically. Retained framebuffer guards also pass fresh native analysis. |
| Browser app sealing | A real browser-updated resource seal passes `codesign --verify --deep --strict` on a mounted DMG and a relocated app. The 70,000-file scale proof seals a 17.3 MB resource catalog, produces a real 333 MB DMG and passes the same macOS checks. Unsealed/tampered resources fail verification. |
| Disk-image writer | A real streamed 4.30 GB HFSX/UDIF image passes `hdiutil` and filesystem verification, including a single file above 4 GiB. |
| Public static release | Complete ~100 MB public WASM bundle and a source-built ARM64 native template assemble with a matching shader-chain identity; no private game input is included. |
| Native source loading | A real Odyssey MSL shader compiles through Metal with `preserveInvariance`, matching the existing offline precision requirement. |
| Standalone launcher | Builds for ARM64 and resolves data from its own app bundle, with saves/settings in Application Support rather than this checkout. The actual relocated browser-generated app reaches Cap Kingdom with a fresh private save and responds to walking, jumping and camera controls. |
| Source checks | The website and native harness pass TypeScript checks. All 11 intake, provenance and real tone/silence cases pass, along with 18 disk-image cases. Native signature, portability and archive checks run against built release assets. |
| Full conversion and DMG | The real input browser run passed all six stages in 74.7 minutes on this M4 Pro while on battery with other workloads. The 7,012,570,468-byte image passes checksum/mount checks and strict signatures before and after native gameplay. Seven native checks pass with sound and zero viewer-relayed inputs. |

Acceptance criteria are in
[`tools/browser-builder/INTENT.md`](../tools/browser-builder/INTENT.md) and
[the browser build scenarios](../.bdd/features/browser-builder/browser-build.feature).

## Source and output layout

- `tools/browser-builder/web/`: static intake, progress and download interface.
- `tools/browser-builder/wasm/extractor/`: .NET WASM LibHac extraction with
  bounded FileReaderSync input and OPFS output.
- `tools/browser-builder/wasm/rewriter/`: original Python NSO rewriter and its
  Capstone/LZ4 dependencies in browser WASM.
- `tools/browser-builder/wasm/shaders/`: unchanged original C# translator in
  .NET WASM plus pinned SPIRV-Cross WASM.
- `tools/browser-builder/pipeline/`: orchestration and original shader rules.
- `tools/browser-builder/dmg/`: streaming HFSX/UDIF disk-image generation.
- `tools/browser-builder/runtime/`: source-only native template build, bundle
  launcher and opt-in Metal source-library loading.
- `tmp/odyssey/browser-*`: ignored build products, private fixtures and evidence.

The app contains its generated game assets in `Contents/Resources/game` and
uses `~/Library/Application Support/SwitchRecomp/Super Mario Odyssey` for
saves, graphics preferences, temporary game files and logs. It needs macOS 26
and Apple Silicon. No Homebrew, .NET or Python installation is required to play
the finished app. The generated app uses an ad-hoc signature, not Developer ID notarization; macOS may require an explicit Open Anyway approval in Privacy & Security.

## Development checks

Run commands as captured background jobs in this workspace. Building the public tools requires Apple Silicon macOS 26, Xcode 26 with its macOS SDK, Bun 1.4.3, uv, .NET SDK 10.0.402 with the wasm-tools workload, and Emscripten 6.0.13. The Pages workflow installs/prepares these without private inputs. Before a local source build, prepare the pinned upstream checkout as shown in that workflow; the runtime builder exports the pristine commit and applies the tracked compatibility patches itself.

```sh
cd tools/browser-builder
bun install --frozen-lockfile
bun run test
bun run typecheck
bun run build:release
bun run dev
```

The Pages workflow can be dispatched manually. A push to `main` also runs it when the workflow file itself changes; the path filter avoids starting a full release for unrelated commits and makes initial workflow registration explicit.

The SPIRV-Cross build requires Emscripten 6.0.13. Its version gate accepts both Homebrew's `6.0.13-git` and the official SDK's `6.0.13 (commit-hash)` banner; adjacent versions remain rejected. The SDK checkout and all 23 pinned Cross source/license hashes are checked separately.

The development `bun run build` command builds only the interface. Use `build:release` for the complete site and runtime.

The static development server binds only to `127.0.0.1:4381`, allows GET/HEAD,
and provides no conversion or upload endpoint. The site shell alone is not a
release build; matching WASM tools and the source-only runtime manifest must be
assembled before a successful game conversion is possible.

```sh
bun tools/browser-builder/tests/browser-intake.mjs
sh tools/browser-builder/wasm/shaders/tests/prove.sh
```

The shader proof reads private local fixtures only for validation. Those fixtures
and generated shader outputs are excluded from hosted static assets.

## Publication boundary

The reusable runtime is built from nxnative commit
`0045c1dfb639f9775891382646ad38c2a11c56bf`, the tracked Odyssey compatibility
patch and `scripts/patches/nxnative-browser-source-shaders.patch`. It links only
Apple system libraries and the licensed OSS decoders. Never build the public
template from the dirty development checkout or the existing Player executable.

The prior controller-icon font copied macOS Arial outlines. The public template
build instead uses the pinned SIL OFL Nunito font and includes its license.
Apple's extracted Metal compiler is not shipped. Required native/WASM dependency
notices and reproducible source pins must accompany the hosted tools.

Source is published in the independent `elad12390/SuperMarioOdysseyMacRecomp`
repository, with no upstream fork relationship. GitHub Actions builds and
deploys the public tools; live verification of the renamed release is pending.
The repository and website include the [project disclaimer](../DISCLAIMER.md):
no original game or keys are provided, piracy is not condoned, and users must
supply files they are legally entitled to use.

## Real release acceptance

```sh
bun tools/browser-builder/tests/build-real-game.mjs --nsp /path/to/base.nsp --keys /path/to/prod.keys
# After mounting, verifying, and relocating the actual resulting app:
bun tools/browser-builder/tests/play-generated.ts --app /absolute/private/test/path/Super\ Mario\ Odyssey.app
```

Both commands are test tooling only. Run them as background jobs and keep their evidence under `tmp/odyssey/`. The first drives the actual static website in the dedicated isolated headless browser, downloads the completed DMG, and retains hashes/progress/network metadata. It accepts an optional explicit `--test-quota-gib` diagnostic override, which is recorded in the result and is not used by the current full run. Chromium may report a privacy-limited 10 GiB storage estimate even with a larger actual quota; the product does not reject valid builds based on that estimate. Keep at least 20 GB free and let actual OPFS writes enforce quota.

The native test uses `createGameTest`, private save/settings paths, direct native controller IPC and the runtime/data from the generated app. It produces the standard compressed video with native audio and action timeline, including failure/Not run states. Before the ending card, its explicit audio step stops native capture and measures the final two seconds of the real gameplay WAV through ffmpeg, after movement and camera control. It rejects peak levels at or below -60 dB or mean levels at or below -75 dB; real generated tone/silence regressions exercise this gate. The finalized MP4 also needs audio-stream and level verification. The test runs headless, so this evidence does not establish final native-window presentation correctness.

## Converter corrections and storage lifecycle

Full-corpus validation caught two issues before any generated-game GPU test: temporary cleanup deleted 10,645 framebuffer-fetch source variants, and the original browser Cross pin lacked the depth aliases used by the working native compiler. The corrected source backend preserves fetch output and uses official SPIRV-Cross tag `vulkan-sdk-1.4.363.0` (`f11ba9f0b21ba8fc15153d50a2a1ae31ab1cf8f7`). The bounded 11-record regression passes, including fetch/depth cases, all geometry topologies/readers and a 31.5 MB Metal source. Its matching runtime/tool chain is `198729df4d5a`; the earlier `57e1752d814c` candidate is failed evidence, not a release.

A per-job Web Lock protects each active build and completed download. When a page closes, its lease disappears and the next build removes only abandoned UUID job directories. Other active tabs and their downloads are preserved. Real multi-tab OPFS tests cover page closure, concurrent acquisition, locked-file deletion failures and retry.

```sh
bun tools/browser-builder/tests/job-storage.mjs
bun tools/browser-builder/tests/release-reuse.mjs --runtime /path/to/public-runtime-template
```

The final real-input run observes HTTP metadata on both page and worker targets without retaining request bodies or query values. The static server has no upload endpoint. The real browser run observed 359 static GET requests and zero unexpected requests, observer errors, uploads or browser errors. No quota override was used. The actual downloaded image and native gameplay checks both passed.

## Native gameplay and retained-source guard validation

The native acceptance run used only the runtime and converted data copied from the actual browser-produced DMG. It verified 1,102.7 units of walking, a 127.6-unit jump followed by a grounded standing state, camera rotation, uncapped rendering and native gameplay audio. Its two-second warm sample measured 161.7 rendered FPS and 60.07 Hz simulation, with zero interpolation restore mismatches. Median frame interval was 5.59 ms, p95 9.59 ms and maximum 95.20 ms; this short sample is not a sustained-performance guarantee. The final compressed recording contains 61.1 seconds of H.264 720p60 video and native AAC stereo sound. Independent decoded-audio and sampled-frame reviews pass. This is headless native rendering, not a verification of final native-window presentation.

The historical native shader cache omitted framebuffer Metal sources after compiling them. Retaining those sources causes the unchanged guard generator to emit 6,399 extra `_bf` rows, because it cannot find separate variant reflection files. The runtime specializes these functions on the existing base shader, so those rows do not alter allocation. The verifier preserves the historical byte-comparison difference and independently reruns the hash-pinned native analyzer on every actual file. It reproduces the full 6,411-row table, requires the original 12 effective base/geometry rows unchanged, and proves all 10,645 framebuffer variants have the same constant-buffer expressions and bounds as their bases. Arbitrary extra flags, missing flags, new unbounded accesses and altered analyzers are rejected.

The local real-input guard regressions require an existing browser-generated game and the source-built runtime cache. Set `GUARD_COMPAT_GAME`, `GUARD_COMPAT_RUNTIME` and `GUARD_COMPAT_SOURCES` explicitly when using paths other than the canonical local proof layout. They remain outside the public-input-free CI suite.

```sh
bun test ./tools/browser-builder/pipeline/shaders/test/guard-compat.test.mjs
bun tools/browser-builder/pipeline/shaders/test/compare-native.mjs \
  --game /absolute/private/app/Contents/Resources/game \
  --expected-chain 198729df4d5a \
  --runtime-directory /absolute/runtime-build-cache \
  --source-manifest /absolute/public-shader-tools/sources.json
```

First-launch compilation and scene loading can pause native input polling. The test waits on fresh native samples and gives startup key acknowledgements the remaining startup budget; active gameplay retains the normal short input path. `NativeKeyboard.press` accepts an optional `timeout` without adding a fixed key hold. Landing is verified by original floor height plus the standing state, since the native game retains a small downward gravity velocity on the floor.

# Research Directions and Required Research

This document lists research topics needed to complete the specs and deliver a working static recompilation pipeline.

## Core Research Directions

### 1) Binary Formats and Loading
- Identify Switch executable formats used by retail titles.
- Map sections, relocations, and symbol handling.
- Determine how overlays or dynamic code segments are represented.

Needed research:
- Public documentation or reverse engineering notes on Switch executable formats.
- Tools and libraries that can parse these formats reliably.

### 2) CPU ISA and Semantics
- Confirm the exact ARMv8-A subset used by Switch titles.
- Enumerate required SIMD and floating point instructions.
- Define precise flag and exception semantics for those instructions.

Needed research:
- ARMv8-A reference manuals.
- Instruction usage analysis on sample titles.

### 3) OS, Services, and IPC
- Identify essential system services required for boot and main loop.
- Define a minimal service surface for early milestones.
- Determine which services can be stubbed without breaking games.

Needed research:
- Public technical references on Switch OS services.
- Trace-based profiling of service calls for selected titles.

### 4) GPU and Graphics
- Confirm GPU architecture and the command stream interface used by games.
- Assess feasibility of command stream interpretation vs shader translation.
- Identify core texture formats and shader features.

Needed research:
- GPU architecture references.
- Shader translation tooling that can be adapted.

### 5) Timing and Determinism
- Determine which timing-sensitive behaviors must be modeled.
- Identify stable methods for trace collection and replay.

Needed research:
- Prior work on deterministic replay in emulation or recompilation.
- Instrumentation approaches for low overhead tracing.

### 6) Audio, Input, and I/O
- Identify the minimal audio path needed for gameplay.
- Map controller input handling to the runtime.
- Define file system access boundaries and safety rules.

Needed research:
- Audio subsystem assumptions in Switch titles.
- Input service behavior and common usage patterns.

### 7) Legal and Preservation Policy
- Define acceptable inputs, distributions, and legal compliance expectations.
- Ensure documentation is consistent with preservation goals.
- Follow and update `docs/LEGAL-POLICY.md` as policy decisions are finalized.

Needed research:
- Jurisdiction-specific rules affecting preservation.
- Best practices for open source preservation tooling.

### 8) Automation, Input Replay, and Media Normalization
- Define a stable automation loop for intake, build, capture, and validation.
- Normalize reference media and capture outputs into comparable artifacts.
- Model deterministic input replay aligned to reference timelines.

Needed research:
- Capture tooling behavior and determinism guarantees.
- Input timing and latency characteristics for Switch titles.
- Video/audio similarity metrics and drift analysis.
- Operational checklist for title-a24b9e807b456252 validation artifacts (see `docs/title-a24b9e807b456252-validation-prereqs.md`).

### 9) LLM-Assisted Decompilation Long-Tail Strategy
- Define when similarity-guided scheduling beats difficulty-only scheduling for unresolved functions.
- Identify specialist lanes where domain tools materially improve output quality (graphics macros, math transforms, mechanical cleanup).
- Determine guardrails needed to keep unattended agent loops policy-compliant and reproducible.

Needed research:
- Compare opcode-sequence distance tools (for example Coddog-style bounded Levenshtein) against embedding-based retrieval for candidate ranking.
- Measure whether cleanup/documentation passes improve downstream success on similar unresolved functions.
- Track attempt distributions and outlier classes (for example large functions, graphics-heavy functions, matrix/vector math).
- Define retry budgets and escalation rules that reduce token burn without masking hard blockers.

## Seed Resources (Reviewed)
- Jamulator write-up on static recompilation pitfalls and concurrency: https://andrewkelley.me/post/jamulator.html
- N64Recomp repository for pipeline patterns: https://github.com/N64Recomp/N64Recomp
- Dinosaur Planet recomp for asset separation precedent: https://github.com/DinosaurPlanetRecomp/dino-recomp
- Nintendo Switch platform baseline: https://en.wikipedia.org/wiki/Nintendo_Switch
- Tegra X1 whitepaper: https://www.nvidia.com/content/tegra/embedded-systems/pdf/tegra-x1-whitepaper.pdf
- Switch hardware overview: https://switchbrew.org/wiki/Hardware
- Switch homebrew NRO format: https://switchbrew.org/wiki/NRO
- Switch NSO format and compression: https://switchbrew.org/wiki/NSO
- Homebrew ABI entrypoint and loader config: https://switchbrew.org/wiki/Homebrew_ABI
- NACP title metadata format: https://switchbrew.org/wiki/NACP
- Switch NCA container format: https://switchbrew.org/wiki/NCA
- hactool (XCI/NCA extraction and keyset handling): https://github.com/SciresM/hactool
- hactoolnet (XCI/NCA extraction with user keys): https://github.com/Thealexbarney/hactoolnet
- nstool (XCI/NCA/NSO extraction): https://github.com/jakcron/nstool
- Switch HID input services: https://switchbrew.org/wiki/HID
- FFmpeg documentation (capture, formats, filters): https://ffmpeg.org/ffmpeg.html
- FFmpeg filters (SSIM/PSNR references): https://ffmpeg.org/ffmpeg-filters.html
- Ghidra SLEIGH language reference (p-code semantics): https://github.com/NationalSecurityAgency/ghidra/blob/master/GhidraDocs/languages/html/sleigh.html
- sleigh library (p-code lifting implementation): https://github.com/lifting-bits/sleigh
- Resurrecting Crimsonland (banteg, 2026-02-01): headless Ghidra pipeline with evidence-backed rename map and regen loop, plus runtime instrumentation (WinDbg/cdb, Frida) for behavior capture; useful automation and validation ideas. https://banteg.xyz/posts/crimsonland/
- The Long Tail of LLM-Assisted Decompilation (Chris Lewis, 2026-02-16): reports that similarity-guided candidate scheduling, specialist skills, cleanup loops, and strict hooks materially improved decomp throughput before hard tail limits (large functions, graphics macros, math transforms) dominated. https://blog.chrislewis.au/the-long-tail-of-llm-assisted-decompilation/
- FFmpeg filter reference for SSIM/PSNR/EBU R128 audio analysis: https://manpages.debian.org/bookworm/ffmpeg/ffmpeg-filters.1.en.html
- FFmpeg libvmaf filter usage notes: https://manpages.opensuse.org/Tumbleweed/ffmpeg/ffmpeg-filters.1.en.html
- EBU R 128 loudness recommendation (audio loudness measurement): https://tech.ebu.ch/publications/r128

## Existing Game Runtimes Investigated for the Local ARM64 Setup

- [nxnative](https://github.com/seedds/nxnative): native execution of rewritten
  ARM64 game modules on Apple platforms, with Horizon services and a Metal
  graphics backend. Selected for the local Odyssey setup; the build script
  supports a Mac-only build and a profile derived from an unregistered version.
- [smo-recomp](https://github.com/Coz-0/smo-recomp): a game-specific Odyssey
  static recompiler and Windows runtime. Its history also covers base 1.0.0,
  useful when checking older SDK behavior.
- [Link's Awakening recompilation](https://github.com/archcorsair/lasrecomp):
  another game-specific implementation with macOS platform and Metal code.
- [MacNativeGames](https://github.com/ly05010419/MacNativeGames): native Mac
  runtime implementations for Odyssey and Zelda, useful for platform and
  graphics comparisons; game versions must match each implementation's inputs.
- [mini-metal-toolchain](https://github.com/awesomo4000/mini-metal-toolchain):
  extracts Apple's signed standalone Metal compiler from its official asset,
  allowing this CLT-only Mac to compile and GPU-test shaders without full Xcode.
- [OdysseyDecomp](https://github.com/MonsterDruide1/OdysseyDecomp): original
  engine/controller/menu structure for the base game. Cross-checked against this
  dump's own symbols and instructions for fixed updates, render-only camera/model
  interpolation, native settings, menu strings, repeat-input guards, and axis
  arbitration. Private layouts are gated on the exact base-game build ID.

- Apple Metal 4 SDK headers, inspected locally in the installed macOS SDK:
  `Metal.framework/Headers/MTL4CommandAllocator.h` requires all command buffers
  using an allocator to finish before reset; `MTL4CommandQueue.h` defines drawable
  wait/signal ordering. Used to verify the native presentation ownership fix.
  A later local-only investigation also checked `MTL4CommitFeedback.h`,
  `MTLCommandBuffer.h`, `CAMetalLayer.h` and `nvn_rec.h`: completion feedback is
  delivered after GPU work, classic `presentDrawable` schedules presentation
  with the command buffer, and recorded producer submissions drain before
  enqueueing a present. The macOS compatibility candidate changes only the final
  window copy to classic Metal; its on-screen outcome remains unverified.

## Research Deliverables

- [Original SMO TAS archive](https://github.com/MonsterDruide1/smo-tas-archive):
  its `public/tas.json` records authors, source versions and setups. Published
  scripts 33, 26, 18 and 35 cover wake-up to tower, tower ascent, summit approach
  and Topper respectively. All original rows are available, unlike the full Cap
  entry 37 whose script field is unknown. Script 33 has 2,114 consecutive frames
  and is labelled 1.3; scripts 26 and 35 are labelled Any. Preserve input values,
  frame counts, required controller mappings, and setup/version provenance.
- [Tyron18's Talkatoo run with input display](https://www.youtube.com/watch?v=vjy3dINxbRg):
  the first 210 seconds include the Cap route, and the controller overlay is
  visibly present. Local extraction retains all 12,602 video frames at 60 FPS
  as 2,648 input holds. Button states/durations are observed; stick calibration
  is inferred from pixels. The display does not expose controller motion, so it
  is not a complete hardware input log or proof of a deterministic full replay.
- [OdysseyDecomp PlayerInput](https://github.com/MonsterDruide1/OdysseyDecomp/blob/master/src/Player/PlayerInput.cpp):
  `isTriggerRolling` requires a sub-action hold plus an action trigger or a
  controller swing. This explains why copying an overlay's ZL alone can omit
  the motion needed to reproduce rolling. Reconstructed motion must be marked
  separately from directly observed buttons.
- [hamhub7/tas-script](https://github.com/hamhub7/tas-script):
  the original Cap TAS example explicitly maps motion to button presses with
  an in-game mod. A visible button display by itself does not establish the
  motion mapping or make a script portable between runtime configurations.
  Its [native controller implementation](https://github.com/hamhub7/tas-script/blob/master/source/lua_hiddbg.cpp)
  creates a Bluetooth FullKey controller, matching the native replay's observed
  FullKey style. Its [nx-TAS player](https://github.com/hamhub7/tas-script/blob/master/lua/lib/nxtas.lua)
  publishes the original integer axes/buttons and advances on display vsync.
  The [format documentation](https://github.com/hamhub7/tas-script/blob/master/lua/lib/nxtas.md)
  confirms absolute frame numbers and per-frame button states.
- [Historical practice-mod motion mapping](https://github.com/fruityloops1/smo-practice/blob/dfd0007c72352f23bbafce5891a49739f5721857/source/main.cpp)
  and its [base-game call sites](https://github.com/fruityloops1/smo-practice/blob/dfd0007c72352f23bbafce5891a49739f5721857/patches/100.slpatch):
  the published `oldMotion` branch maps an L trigger to a single right-hand
  upward swing, directional triggers to two-hand swings, and suppresses L's
  normal camera centering during playback. RSTICK remains a digital click.
  This provides a concrete optional controller environment for compatibility
  tests, without editing recordings. This snapshot postdates the archived 2021
  segments; their exact original mod build has not been established.
- [SmallAnt's Cap/Cascade beginner guide](https://www.youtube.com/watch?v=tIr3hPpGjm4):
  the Cap route chapter runs from 25 to 159 seconds. Direct inspection of sampled
  frames shows the route, frog ascent and Topper, but no live controller overlay
  or measured button-hold durations. Use it as route guidance, not an input log.
- [Gamer Guides' Cap Kingdom prologue walkthrough](https://www.gamerguides.com/super-mario-odyssey/guide/story-walkthrough/cap-kingdom/prologue):
  the intended frog ascent, Topper fight and wire departure to Cascade.
- [Topper mechanics](https://smo.wiki/Topper) and [Cap Kingdom](https://smo.wiki/Cap_Kingdom):
  the opening fight has two vulnerable phases, three hats each; victory enables
  the Spark Pylon. Reaching the first frog alone does not complete this route.

- A research summary for each category with sources.
- A list of confirmed requirements to update the specs.
- A compatibility matrix based on real title traces.

## Alternate controller sources (2026-10-25)

- [hamhub7/TAS-nx](https://github.com/hamhub7/TAS-nx) includes literal
  `roll_cancel`, `roll_cancel_directed`, and `nut_clip` input examples. Its
  [script documentation](https://github.com/hamhub7/TAS-nx/blob/master/scripts/README.md)
  says omitted frames are neutral; sparse files must not be interpreted as
  holding the preceding input. These are movement examples, not a full Cap run.
- [Qflame's original Cap left-side video](https://www.youtube.com/watch?v=V8QFsbCLjYI)
  links an [original controller script](https://pastebin.com/sPqJ7bmL): 418
  records with sparse indexes 1-583. It differs materially from archive18.
  The video begins airborne inside the tower's upper doorway, before the exit
  load, so a settled exterior checkpoint is not an established starting state.
  Frame 515 contains LX=32776; retain that value and establish the source
  engine's axis semantics before adapting it. The game version and exact motion
  profile are not documented by the source.
- [The yuzu TAS documentation](https://yuzu-mirror.github.io/help/feature/tas/)
  credits matthewpugs24 for a 773-frame example. Its embedded source video is
  [Slots TAS v3](https://www.youtube.com/watch?v=Gh2aCXdnZRk), not a Cap route.
  A downloadable input file still requires its matching scene and initial state.
- [The original tower recording](https://www.youtube.com/watch?v=Ue6Fhp1EFWQ)
  accompanying archive26 begins at the exterior bottom doorway, includes the
  first-frog capture and cutscene-skip confirmation, and ends after entering the
  upper exit. Its video ends during the exit load, without showing the exterior
  destination. Preserve that initial capture/menu state when testing its inputs.
- Eight leaderboard creators' source descriptions and early video samples were
  checked: heytherecool, BP31, cmanrulo, Dangers, Fir, Tippi, Tomshi and
  Chaospringle. Inspected samples did not show live controller telemetry and
  their descriptions did not link input data. This does not establish that an
  overlay is absent throughout every full recording. Evidence and source URLs
  are retained in `tmp/odyssey/research/input-run-search/leaderboard.md`.

## Supplied two-player TAS recordings (2026-10-25)

- The user supplied `cap.tsv` and `Cascade-FM-World-Select.tsv`, alongside
  [Odyssey Best Theoretical Time with TAS](https://docs.google.com/spreadsheets/d/1r2qE3BY8rO7S3Zlqe7D4y_bgjoumQW8Mgsl40qTjYyQ/edit?gid=1649420127#gid=1649420127)
  and the [Cap source file](https://drive.google.com/file/d/1ZRNnLGpf0-y-IeF0saVhgywSVlGRVO6y/view).
  Both files declare two-player mode. Cascade credits sknoll18,
  MrKatzenGaming and PlacidMink, and declares starting position
  `(5700, 1175, 700)`. This is initial-state metadata, not permission for
  corrective steering during the tape.
- The unmodified [TSV-TAS-2 compiler](https://github.com/xiivler/TSV-TAS-2/blob/main/tsv-tas.py),
  Git blob `6f52cc38a614e4dfa96a6799af98618a37ecce91`, emits 7,055 Cap
  scene frames and 5,327 Cascade scene frames. Preserve its original binary
  output: conversion to button-only nx-TAS text would discard the two hands'
  accelerations, gyro matrices and angular velocities.
- [PlacidMink's original TAS player](https://github.com/PlacidMink/smo-lunakit-tas/blob/stable/src/program/smo-tas/TAS.cpp)
  applies SEAD controller masks, float sticks and both sensor addons to two
  independently resolved controller ports. Its
  [scene hook](https://github.com/PlacidMink/smo-lunakit-tas/blob/stable/src/program/main.cpp)
  advances on `al::Scene::movement`, after controller sampling and before
  scene logic. Extra native renders must not advance the source recording.
  The published release mask is `held & previous`; exact-source playback
  retains that expression rather than silently changing it.

- The Sheet's ANY% 2P BTT vs TAS tab (gid 1613019953), rows 19, 20 and 23,
  supplies the three prerequisite Cascade moons: chest, Chomp Through the Rocks
  and 2D. The local original catalog identifies IDs 216, 206 and 212. The
  [first-moon to world-selection reference](https://www.youtube.com/watch?v=ER0dtZifqv8)
  credits the same three authors as the supplied TSV; exact file/video identity
  remains unproven. The [Cap reference](https://www.youtube.com/watch?v=ItSVSy0W2xY)
  and its Sheet endpoint end at the Odyssey logo fadeout. A later playable
  Cascade check is recorded separately from the original Cap tape.

## Open Research Questions

- What is the minimal instruction coverage needed for a first title?
- Which OS services are required to reach a game loop without patches?
- What is the simplest graphics path that still produces correct output?
- How can we generate reference traces without distributing proprietary content?
- What is the minimal input script fidelity needed for stable validation?

### Continuous Cap/Cascade input junction (2026-10-25)

- [SMO TAS archive script 17](https://github.com/MonsterDruide1/smo-tas-archive/blob/main/public/scripts/17.txt): original 1.0 Cascade arrival-to-First-Moon candidate, 1,624 records; excludes the supplied 2025 route's three earlier moons. It is not a recovered whole-route bridge.
- [Any% BTT creators' explanation](https://www.youtube.com/watch?v=WOKns8hEbNk): Cascade ICRC uses Cappy's prior position and a manual-return cancellation window. The supplied tape's Cappy actions at 1554 and 1734 are separated by 180 frames; this identifies a live-state junction requirement, not proof of successful activation from a fixture.
- [Original 2P source sheet](https://docs.google.com/spreadsheets/d/1r2qE3BY8rO7S3Zlqe7D4y_bgjoumQW8Mgsl40qTjYyQ/edit?gid=1613019953): rows 19-26 cover the missing chest, Chomp, 2D and First Moon approach. Video/split references were recovered; exact companion controller files remain unfound.

### Creator repository follow-up (2026-10-25)

- [Placid-Mink public repositories](https://api.github.com/users/Placid-Mink/repos?per_page=100): newer hyphenated creator account, distinct from PlacidMink; exposes a LunaKit fork and TSV compiler, not a recovered input bridge.
- [MrKatzenGaming compiler tree](https://api.github.com/repos/MrKatzenGaming/TSV-TAS-2/git/trees/main?recursive=1): tsv-tas.py has Git blob 6f52cc38a614e4dfa96a6799af98618a37ecce91, matching the compiler retained for the supplied inputs. The inspected tree contains compiler code, not the missing route.
- [BTT Studio](https://github.com/MrKatzenGaming/BTT-Studio): the recording creator's practice tool documents warps, player teleport, input display and settings. It is not itself a continuous controller recording; no bundled route is established from its README. Do not use its progress/setup features as a substitute for playing the missing section.

### Browser-only release pipeline (2026-10-25)

- [Microsoft .NET browser-WASM interop](https://learn.microsoft.com/en-us/aspnet/core/client-side/dotnet-interop/wasm-browser-app?view=aspnetcore-10.0): the supported WebAssembly SDK, JSExport entry points and runtime asset loading used by the local extractor and shader translator.
- [GitHub Pages custom workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages): static artifact deployment, Pages permissions, deployment dependencies and environment configuration.
- [GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners): `macos-26` is an ARM64 public runner; the platform matches the native runtime's Metal 4/macOS 26 requirement.
- [Apple code-signature structures](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/cs_blobs.h): primary CodeDirectory/SuperBlob field definitions used to validate and update the ad-hoc resource hash after local game resources are added. Browser-generated artifacts are independently checked with macOS deep/strict signature verification.

- [Chromium storage quota reporting](https://chromium.googlesource.com/chromium/src/+/main/storage/browser/quota/quota_manager_impl.cc) and [StaticStorageQuota feature](https://chromium.googlesource.com/chromium/src/+/main/storage/browser/quota/quota_features.cc): Storage API estimates intentionally report usage plus 10 GiB by default; the browser builder must not reject larger local builds using that privacy-limited estimate. Real OPFS writes enforce available quota.

## GitHub workflow registration

- [GitHub Community: workflows omitted after initial repository push](https://github.com/orgs/community/discussions/179439) - Firsthand report of manual workflow indexing during new-repository/default-branch initialization. This is context for deployment diagnosis; the release workflow also has a narrowly scoped push trigger on its own file.

- [GitHub Pages artifact action source](https://github.com/actions/upload-pages-artifact/blob/v4/action.yml) - The archive step excludes dotfiles. Public files named in a checksum manifest must use ordinary names; the archive regression applies the same GNU tar filter.

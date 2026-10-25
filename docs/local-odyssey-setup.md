# Local Super Mario Odyssey on Apple Silicon

Open **`release/Super Mario Odyssey.app`** in Finder to play your Player slot.
The Terminal launcher is `scripts/play-odyssey.command`. It uses the user's extracted base 1.0.0 game in
`game-data/super-mario-odyssey/` and the native ARM64 host built there.
Launching the prepared game does not need a key file, Rust, Python, or .NET.
The original NSP and first extraction live in `source-dumps/super-mario-odyssey/`.
Keep the app inside this workspace; its prepared data is separate from the app.

From the workspace root:

```sh
./scripts/play-odyssey.command
```

The launcher writes its log to `tmp/odyssey/play.log`. Generated recordings,
research downloads, replay saves, screenshots, native socket and harness runtime
files also live under `tmp/odyssey/`. Other setup scratch work is under `tmp/`.
Persistent player saves and renderer preferences stay in the game's run folder.

The default slot is **Player**, which keeps the existing progress in
`game-data/super-mario-odyssey/run/save`. Additional personal slots are available with
`./scripts/play-odyssey.command --slot Elad2`; each gets a new save in
`run/saves/Elad2`, separate renderer preferences, and a labeled native window.
Switch back to the existing progress by launching without `--slot`.

For an additional playthrough without Terminal arguments, double-click
`release/Play Fresh Save.command`. It selects the personal **FreshStart** slot
in `run/saves/FreshStart`, with separate renderer preferences. It starts from
the beginning when empty and resumes that playthrough on subsequent launches.
The regular app continues to use the original Player progress. Persistent dated
backups of Player's `save`, `save.work`, and renderer preferences are in
`game-data/super-mario-odyssey/save-backups/`, with per-file SHA-256 manifests.

Automated **Tests** use their own native process, port 4318, socket, working
directory, save and settings. Every run starts a fresh private save; an explicit
checkpoint is copied into it. Test windows ignore physical controllers, keyboard
and touch, so playing in the Player window cannot change scripted inputs.
The test result records its actual save and settings paths. Test finalization
stops only its own native process. Test files remain under `tmp/odyssey/`.

This uses [nxnative](https://github.com/seedds/nxnative) as the execution backend.
The original SwitchRecomp Rust workspace remains an exploratory pipeline.
nxnative rewrites instructions that need host handling, runs the remaining
ARM64 code natively, supplies Horizon services, and renders through Metal.

## Controls and saves

| Key | Action |
| --- | --- |
| WASD | Left stick: movement and menu navigation |
| Arrow keys | Right stick: camera, including the opening Look Around tutorial |
| J / K | A / B: confirm and jump |
| U / I | X / Y: cap actions |
| Q / E | L / R |
| Z / C | ZL / ZR: crouch and ground pound |
| Return / Tab | Plus / Minus |
| Space | Shake the controller |
| Command-Q | Quit |
| Control-Command-F | Toggle fullscreen |

The host also supports controllers recognized by macOS GameController.
`DM_ARROW_CAMERA=0` restores upstream's arrow-key D-pad mapping.

The main automation harness is [the Playwright bridge](../tools/game-harness/README.md).
Start it with `cd tools/game-harness && bun run start`, then open
<http://127.0.0.1:4318/>. Its native controller mapping matches the launcher.
Its Playwright-style NativeGamePage talks directly to native HID and native menu
text over a Unix socket. A separate real Playwright page only displays and
records the game. Every test has an intro, action thumbnails, a highlighted
current step, and a passed/failed ending with unrun steps marked.

Run the complete recorded test with one command:

```sh
./scripts/record-odyssey-demo.command --window --120-video
```

For a menu test that starts its own isolated game:

```sh
bun run --cwd tools/game-harness gui
```

Recordings are compressed H.264 MP4s at 1280x720, preserving 60 or 120 FPS.
The full script starts the Tests viewer/process manager if needed and boots a
private game. `--profile` also retains native timings beside the video.
Every recorded test stops its own game after finalization.

## Native renderer settings

Open the game's pause menu, then **Options -> Graphics**. This native page
contains **Renderer limit** (Uncapped, 60, 90, 120, 144, or 240 FPS) and
**FPS counter** (Off/On). Left/right changes the selected value. Controls retains
its original eleven rows. Both preferences persist in
`game-data/super-mario-odyssey/run/native-options.ini`.

The FPS counter defaults to On for Player and Off for automated Tests. Its small
native overlay at the top center shows renderer FPS and completed Metal drawable
presentations per second. These are measured counters, independent of the chosen
limit; presentation callbacks do not establish physical screen scan-out. The
overlay samples existing counters four times per second and performs no GPU
readback or additional game rendering. It uses a small, click-through native
child window, keeping AppKit text updates outside the game's Metal view.
Turning it Off removes that child window and stops its timer.

The user confirmed the Graphics page and counter work. Subsequent native-window
profiling opened Graphics and toggled the counter repeatedly from a private copy
of the Player save, then returned to actual Cascade Kingdom gameplay.

Game logic, physics, scene counters, and input consumption advance at 60 Hz.
Additional renders interpolate camera and model root positions between completed
updates, then restore those values before simulation continues. Skeletal animation
retains its current completed pose. Loading, menus, and cinematics keep the
guarded 60 FPS path; active gameplay can be uncapped. The screen's refresh rate
still limits complete physical frames, independently of renderer throughput.

### Purple patches and WindowServer investigation, 2026-10-25

The installed ownership fix did not resolve the user's live-game fault. A third
WindowServer crash occurred at 02:47:57 +02 on 2026-10-25 after Player launched
with its own save. It has the same Metal `stop_encoders` / `add_shared_event` /
backdrop-composition stack. No diagnostic game or screen-capture helper was
active at that crash. The exact triggering client operation remains unproven.

Local source and installed SDK review produced a separate compatibility
candidate: on macOS, the final fullscreen copy uses a classic Metal command
buffer and `presentDrawable`, while scene rendering remains on Metal 4. A GPU
event orders its source read after the producer, and actual command-buffer
completion retires the swapchain ticket. This removes the Metal 4
`waitForDrawable` / `signalDrawable` handoff from the macOS display surface.
It adds no CPU wait, lower frame cap, scene-rendering fallback or extra full-frame
copy. Its frame-time and memory impact require native-window measurement.

The candidate compiles for ARM64; all 64 CPU presentation-coordinator checks,
the native host CPU suite and all 78 Rust workspace tests pass. At the user's
request, the final ARM64 build was installed atomically behind the existing
`release/Super Mario Odyssey.app` for manual testing. Its architecture, code
signature and installed SHA were verified; Player save and preferences hashes
were unchanged. The previous host and build metadata remain under
`tmp/odyssey/purple-glitch/classic-display-host/`. Native-window validation is
pending the user's manual test; automated graphics reproduction remains stopped.
A clean earlier
recording captured the source before the display copy and cannot establish
that the displayed image was correct.

The user subsequently reported stable gameplay with no purple corruption, but
a 60 FPS lock. Player preferences remained `render_fps=0`; the runtime log
confirmed effective uncapped gameplay while frame times stayed near 16.7 ms.
The next candidate keeps the classic Metal copy and changes only uncapped
presentation: it calls the drawable's immediate `present` from the copy's
actual GPU-completion callback. Capped modes keep command-buffer scheduled
presentation. The source texture still retires after GPU completion, and no
Metal 4 drawable wait/signal calls are restored. This targets the scheduling
gate; its frame rate and continued visual stability require a manual retest.
The stable 60 FPS executable is retained as a separate rollback copy.

The immediate-handoff build was also reported stable, at roughly 50-57 FPS.
An approved five-second read-only `sample` of Player in Cascade gameplay
showed the presenter waiting in `CAMetalLayer nextDrawable` in 3,306 of 3,418
samples (96.7%), and the render thread waiting for source reuse in 1,579
samples (46.2%). The native state confirmed an uncapped render target. This
identifies drawable backpressure; those percentages are sampled thread states,
not percentages of GPU work.

The next optimization keeps the same classic Metal window copy and uses a
latest-frame queue when the render target exceeds the screen refresh or is
uncapped. The presenter obtains a drawable before claiming a game texture.
New renders supersede older unclaimed frames during that wait. Each source is
reusable only after its own ticket and GPU readers finish; global retirement
remains contiguous for drains and bounded queue storage. Capped presentation
at or below screen refresh retains FIFO behavior. No resolution or memory
budget reduction is applied, and no Metal 4 drawable events are restored.

The CPU regression now passes 76 checks, including independent reuse of a
newer discarded source, protection of an older copy and optional readers, full
drain ordering, all 80,640 completion orders and ring reuse. The ARM64 build and
all 78 Rust workspace tests pass. Existing 300-frame log summaries now also
separate actual acquire pacing, source-reuse waits and native-drawable waits.
Runtime performance and visual stability of this queue change require the
user's manual retest. Profile evidence is under
`tmp/odyssey/stable-performance/`.

The previous Tests runs also used an older save, no learned pipeline cache and
an FPS overlay that defaulted Off. Player loads 5,905 structurally valid cache
records and defaults its overlay On. No concrete prewarm race or stale shader
key was found in the bounded local audit. Future isolated validation must copy
the current checkpoint and pipeline manifest and explicitly match the overlay.
The current save seed and crash evidence are recorded under
`tmp/odyssey/purple-glitch/current-save-copy.json` and
`tmp/odyssey/purple-glitch/crash-2026-10-25T00-47-57Z/`.

The following records describe the earlier ownership fix and its limited checks.

The Player log and both local WindowServer crash intervals were inspected. The
native game was active in both intervals. WindowServer aborted in QuartzCore's
Metal layer/backdrop composition; no kernel GPU fault or reset was found in
those intervals. The second failure overlapped an experimental ScreenCaptureKit
helper and a Metal regression. The helper aborted while constructing its filter,
before starting a stream. This does not identify which client triggered the
compositor assertion, or establish that the purple patches have the same cause.
The experimental capture helper remains disabled. A bounded native offscreen
run explicitly unset DM_WINDOW. After source review and that run passed, two
short private native-window scenarios exercised real presentation without
ScreenCaptureKit or the earlier GPU stress test. Evidence is under `tmp/odyssey/purple-glitch/`.

A concrete presentation lifetime bug was found in the native renderer. The
old completion watermark advanced to a newer dropped ticket even while an older
present still owned GPU command memory and a window texture. That could both
reset a Metal 4 command allocator and return its source texture to AcquireTexture
too early. Apple's installed Metal SDK explicitly requires all command buffers
using an allocator to complete before reset.

The source patch separates each allocator's actual GPU completion from frame
retirement and advances retirement only past individually completed or dropped
tickets. Asynchronous preview/readback copies wait for their producer and hold
the source until their own GPU completion; JPEG encoding remains independent.
The presenter selects another free slot before waiting, retains the
existing three allocators and eight-entry queue, and adds no GPU copies, per-frame
allocations in normal play, frame cap, or shader changes. On-screen performance
and disappearance
of the intermittent purple symptom remain incompletely characterized. After the
bounded native checks below, the verified host replaced the Player executable
atomically; the previous executable is retained under tmp/odyssey/purple-glitch.

CPU validation calls the same coordinator used by the renderer, without opening
a Metal device or window. It covers all 80,640 completion orders across two ring
positions, duplicate completions, 10,000 sequential tickets, allocator backpressure,
spurious wakeups, free non-preferred slots and preview-reader ownership: 64
checks passed. A
negative control restoring the old high-watermark rule fails the regression.
The candidate ARM64 host compiles successfully; the Rust workspace command
`cargo test --workspace --target aarch64-apple-darwin -- --test-threads=1` passed.
An initial offscreen attempt failed during shader startup while the Tests bridge
retained its pre-crash macOS service context (XPC assertions). Restarting only that
verified idle bridge let the identical candidate boot and pass all seven Cascade
gameplay steps: camera sweeps, Cappy, jumping, pause/resume and save isolation.
Renderer throughput was 149-211 FPS with recording active; simulation was near
60 Hz. WindowServer retained its PID and launch time. No GPU/display errors were
logged. A scan of 2,134 raw frames found no bright magenta blocks, but captures
precede the final display copy, so this does not establish an on-screen cure.
The 720p60 compressed recording contains native game audio. Median offscreen
GPU work was 1.6-2.1 ms and median frame time 4.2-6.0 ms across the measured
phases. A 155.7 ms outlier remains, so this is not a stutter-resolution claim.
Peak logged process residency was 3,237 MB and GPU allocation 2,494 MB; the last
sample was 2,981/2,233 MB. The earlier six-step sample omits menu transitions
and is not a matched memory or performance benchmark.


A real-window run on the Dell passed seven scenario steps, with no GPU errors
or WindowServer restart. Its raw-frame scan covered 1,196 frames with no bright
magenta blocks. A second five-step native run confirmed the renderer is not
fixed at 60 FPS: preview active 94.6 FPS, preview disabled 119.8 FPS, preview
restored 118.3 FPS; the configured limit stayed 0 and simulation stayed near
60 Hz. The camera pose changes across these samples, so they do not establish
a speedup or isolate preview cost. Both recordings contain native game audio.
The exact intermittent purple fault and WindowServer trigger remain unproven.
Installed host SHA256:
`b6f5eb8abbde95a6759b1c0bd5cb6e19298014d0043f446a810a6823a71577e8`.

### Frame-time investigation, 2026-10-25

The Player save was copied byte-for-byte into a checkpoint under
`tmp/odyssey/checkpoints/`; every profile mounted a further private copy. The
original `Common.bin` and `File1.bin` hashes remained unchanged. Investigation
artifacts and recordings are under `tmp/odyssey/frame-pacing/` and
`tmp/odyssey/harness/`.

The reported choppiness is real: on the user's Dell P2720DC at 60 Hz, typical GPU
work takes about 1.7 ms, but presentation gaps often reach 33.36 ms. These miss a
refresh despite a high average renderer rate. The largest measured stalls
correlate with `nextDrawable` and the presentation queue's texture-reuse wait.
The Player log also contains separate first-use pipeline/library compilation
hitches, including hundreds of milliseconds when a new view introduces shaders.

Two bounded runtime changes address scheduling:

- Main guest threads receive the same interactive QoS mapping as other guest
  threads. Previously the main thread could inherit unspecified QoS.
- Runtime frame pacing is declared before the first acquire and retains QoS
  across menus and uncapped gameplay. The real macOS policy probe confirmed that
  switching a pthread to Mach real-time scheduling permanently opts it out of
  QoS; clearing real-time does not restore QoS, and pthread reapplication fails
  with EPERM. Fixed-profile games retain their existing real-time policy.

The native FPS HUD also uses its own child window as described above. A steady
FPS loss from the counter was not established by the On/Off comparisons.
An optional `DM_WINDOW_DISPLAY` selects a CoreGraphics display ID for reproducible
native tests; unset retains normal window placement. IDs are machine-specific.

These changes do **not** fully resolve presentation pacing. In comparable
eight-second counter-On samples on the Dell, gaps above 25 ms numbered 66 before
and 47 with the scheduling/HUD candidate; the 99th-percentile presentation gap
remained 33.36 ms. Background VM load and memory pressure were present, so this
is a short local observation, not a general speedup claim. The renderer setting
remains Uncapped and simulation remains approximately 60 Hz.

An opt-in experiment retiring native presentation tickets at GPU submission was
tested privately and excluded from the Player build: it did not remove drawable
stalls. Future display-path work must separate submitted-frame ownership, GPU
allocator completion, and physical presentation without weakening drains or
external-producer synchronization.

Validation: the native host suite passed, including a new real-pthread main-QoS
regression that fails against the old initializer. The Rust workspace command
`cargo test --workspace --target aarch64-apple-darwin -- --test-threads=1` passed
all 78 tests. Recorded native-window profiles reached Cascade gameplay and
checked Player-save isolation. One early run was invalidated by a WindowServer
SIGABRT and was excluded from performance comparisons.

The native renderer advances its temporal image history on every rendered
frame, including frames between simulation updates. Stateful GPU preparation
runs once after the interpolated camera is ready. The original opening also
reaches preparation through tail calls; those sites are included in the
build-verified offline rewrite. Repeating preparation can consume the fog's
pending work and flip uniform-buffer banks more than once before drawing.

Run the opening foot-fog regression with:

```sh
bun run --cwd tools/game-harness fog
```

It uses a separate headless game host, socket and private fresh save, records
720p120 video with native sound, and retains consecutive native frames under
`tmp/odyssey/harness/`. It checks 60 Hz simulation, image-history rotation on
extra renders, and a single GPU preparation per render. Visual inspection of
the low fog is still needed alongside those counters.

`bun run --cwd tools/game-harness fog --moon` also looks at the large yellow
moon, pans away and returns, and checks exposure history. Extra renders commit
the previous exposure histogram and rotate HDR uniform banks without advancing
the game's 60 Hz parameter timers. The six-step native test
`2026-10-24T19-13-15-012Z-moon-lighting` passed: logic 60.17 Hz, 256 extra renders
and 256 exposure/image-history updates over 3.51 seconds. Player save and
settings hashes were unchanged. Visual review of 72 sampled frames found no
conspicuous moon-lighting flashes; that camera view did not include Mario's feet.

The original 100 MiB dynamic texture pool also ran out of room for a shadow-mask
allocation, causing the original caller to dereference null. Exact-build-checked
rewrites reserve a 192 MiB texture pool within a 272 MiB graphics heap. This is a
bounded memory-budget increase. A later automated-window startup exposed a
different archive/heap-disposer crash; the headless moon test and the Player
app launch passed that startup, but that intermittent window failure remains
under investigation.

For the base game's opening, tilt the right stick **up**, then press A to stand
up. Walking is disabled until that camera tutorial finishes. This sequence and
the SDK 3.5.1 controller-history behavior were checked against
[smo-recomp's Cap Kingdom test](https://github.com/Coz-0/smo-recomp/blob/main/tests/cap_kingdom.seq).

Saves are in `game-data/super-mario-odyssey/run/save`. Keep that folder
when rebuilding. `DM_SAVE` can select another save directory for a test.
`--headless` runs the same host without a window or audible output.

## Source and local compatibility changes

- nxnative checkout: `external/nxnative`, commit
  `0045c1dfb639f9775891382646ad38c2a11c56bf`.
- Comparison sources: [Coz-0/smo-recomp](https://github.com/Coz-0/smo-recomp),
  [Link's Awakening](https://github.com/archcorsair/lasrecomp), and
  [MacNativeGames](https://github.com/ly05010419/MacNativeGames).
- The supplied game is base 1.0.0, main build ID
  `3ca12dfaaf9c82da064d1698df79cda1`. nxnative generated a derived profile from
  this version's own modules and 27,210 shader programs.
- `hle_oe.c`: recognize SDK 3's older gameplay-recording entry point with the
  same semantics as the existing host recording controls.
- `hle_audren.c`: discover the update mutex before resolving its functions;
  derive the renderer wrapper's member offset from the actual SDK code.
  This SDK uses an ordinary mutex at +0x1f8 and the renderer member at +0x50.
- `hle_movie.c`: connect SDK 3's two-argument decoder constructor to the real
  VideoToolbox decoder. The old API's format 3 is raw NV12 (format 4 in the
  newer API); this is verified from its own output-conversion code.
- `front_mac.m`: opt-in arrow-key camera mapping, enabled by this launcher.
- `hle_hid.c`: retain a real 17-sample history per controller/style, following
  the same SDK 3.5.1 implementation in smo-recomp. Add continuous control-file
  compatibility plus direct native socket input/state, consumed-input receipts,
  short stick-tap latching, and event-driven waits for the harness.
  Render-only reads preserve that history's sampling number instead of adding
  duplicate samples between the original 60 Hz controller updates.
- `hle_audio_record.c`: copy actual played output to a bounded queue and write
  stereo WAVs on a separate thread. The recording fixture aligns those samples
  with the browser preview and muxes AAC into every compressed video.
- `hle_smo_replay.c`: load original controller frames once and advance them
  before native HID sampling on simulation ticks. Socket/browser timing does
  not schedule individual frames; catch-up preserves each source input sample.
- `hle_smo_route.c`: observe stage, original actor nerves/steps, positions and
  camera direction for assertions. It does not steer or change game progress.
  Processed player jump/dive triggers, jump-chain counters, velocity and nested
  jump/damage states distinguish a HID receipt from an action the game accepted.
  Replay frame numbers are captured in that same game-thread snapshot.
- `hle_smo_tas_motion.c`: optional `legacy-2021` controller environment from
  the published practice-mod `oldMotion` mapping. Offline, build-verified calls
  apply L/directional motion and suppress L camera centering during playback;
  ordinary play delegates to the original functions. Exact original recording
  mod provenance is still unknown and recorded in each test's source metadata.
- `nvn_mtl.m`: optional asynchronous 1280x720 JPEG preview using two reusable
  Metal readbacks. A persistent WebSocket carries the newest frames to the
  browser; capture stops when there is no viewer. Full native PNG screenshots
  wait for newly produced frames, excluding older queued presents. The shader
  translation chain is unchanged.
- `hle_smo_frame.c`: exact-build-gated fixed 60 Hz updates, separate renderer
  deadlines, real scene/player observations, and native preference persistence.
  Its tested clock limits catch-up work to four updates per render, retaining
  outstanding time after CPU stalls. Long loads/debugger stops stay guarded.
- `hle_smo_interpolate.c`: bounded camera and model translation snapshots with
  render-only overrides, writer barriers, and exact restoration.
- `hle_smo_options.c`: expose Graphics settings using the game's native scrolling
  settings list, preserving its original settings and save layout.
- `hle_smo_ui.c`: read native menu strings, current values, selection, and input
  guards on the game thread; publish a thread-safe semantic snapshot. Tests use
  text/role locators. Value waits read the visible native TextBox and respect
  roll animations, rather than accepting the requested index before text changes.
- NVN presentation: release the old 60 Hz display-link path for higher caps,
  reset stale real-time scheduling budgets, and avoid timed drawable holds when
  the requested cap exceeds this screen's refresh rate.

These local source changes are saved in
`scripts/patches/nxnative-odyssey-sdk3.patch`. On a fresh checkout of the pinned
commit, apply it with:

```sh
git -C external/nxnative apply ../../scripts/patches/nxnative-odyssey-sdk3.patch
```

The Mac build uses nxnative's `scripts/build_ipa_from_nsp.py --platform mac`.
Its Python environment is `tmp/odyssey-native/venv`; the standalone Apple Metal
compiler is `external/mini-metal-toolchain/toolchain/bin`. The build uses normal
Homebrew, Cargo, NuGet, and uv dependency installation. Game inputs, extraction,
keys, saves, and shader outputs are ignored by Git. Nothing is published.

## Verification record

Verified on the local M4 Pro on 2026-10-24:

- All 27,210 shaders compiled successfully; the prepared build runs natively
  with Metal and the original base game's modules and assets.
- Direct native input passed through the original HID/game code. The full test
  proves Cap Kingdom locomotion, jumping, landing, native menu changes, and
  actual scene-step counters rather than only reaching the main menu.
- Latest native window: 119.51 FPS at the 120 setting, 219.33 FPS uncapped.
  Actual game/scene updates remained near 60 Hz in both five-second camera pans.
  Earlier opening-area runs measured up to 261.07 FPS uncapped.
- Native GUI dispatch median / 95th percentile: 0.41 / 1.16 ms. Input
  consumption median / 95th percentile: 16.63 / 32.81 ms. A full press/release
  took 33.04 ms median. Visible text waits additionally respect the original
  roll animation; fixed key holds and guessed menu delays are removed.
- The seven-step native menu regression passed with browser input blocked and
  zero viewer input requests. Its complete video is 9.03 seconds, 511 KB.
- Initial browser preview: 6.52 FPS while the native game ran at 59.11 FPS.
  Replacing synchronous PNG polling with the asynchronous stream produced
  60.09 native FPS and 59.90 browser FPS during a ten-second camera pan.
- All 613 delivered browser frames were distinct. Median / 95th percentile
  capture-to-canvas delay: 7.38 / 10.19 ms. Frame-gap median / 95th percentile:
  17.8 / 18.3 ms; longest observed gap: 40.2 ms.
- The latest full recording is 1280x720, 120 FPS, H.264, CRF 28: 5.31 MB for
  53.08 seconds. Conservative FFmpeg duplicate removal retained 102-103
  changing frames per second in its camera pans. Its rate label alone was
  not the acceptance criterion. This window's screen reports 60 Hz; drawable
  presentation callbacks do not imply a higher physical scan-out rate.
- Full native host suite passed, including all 81 HID/native-IPC checks and
  eight fixed-clock regression checks (including catch-up after a 191 ms stall):
  `DM_GAMES_DIR="$PWD/game-data/super-mario-odyssey/profile" make -C external/nxnative/dm/host/tests GAME=0100000000010000 run`.
- Full Rust workspace suite passed, 78 tests:
  `cargo test --workspace --target aarch64-apple-darwin -- --test-threads=1`.
- Native WAV and legacy-motion mapping regressions pass, as do all five
  offline patch registry checks and both lossless TAS importer checks.
- `cd tools/game-harness && bun run check` passed.
- After the audio and optional TAS-controller changes, the complete native
  regression passed all 12 actions on a private copy of the user's save.
  Headless rendering measured 117.61 FPS at 120 and 218.29 FPS uncapped, with
  logic at 60.10 and 59.77 Hz respectively. Its 50.31-second recording is 720p120
  H.264 plus 48 kHz stereo AAC, 5.81 MB, with zero dropped audio samples.
  This measures native rendering throughput, not physical screen refresh.

Evidence is under `tmp/odyssey/harness/`:

- `2026-10-24T12-19-18-620Z-native-input`: first verified playable opening.
- `2026-10-24T12-29-14-583Z-frame-rate`: old preview baseline.
- `2026-10-24T12-33-22-048Z-native-input`: controls with the new stream.
- `2026-10-24T12-34-34-020Z-frame-rate`: FPS result and compressed recording.
- `2026-10-24T15-13-17-821Z-odyssey-demo`: latest full native-window gameplay,
  visible native text waits, settings, 120/uncapped measurements, and video.
- `2026-10-24T15-14-25-908Z-native-menu`: latest native text selectors with the
  viewer's HTTP input path blocked; all seven actions passed.
- `2026-10-24T15-05-44-262Z-odyssey-demo`: retained failing clock regression,
  before the catch-up debt fix; failure and unrun Finish are visible in its video.
- `2026-10-24T17-22-10-079Z-odyssey-demo`: 12/12 checks after audio and TAS
  compatibility changes, private save, 120/uncapped measurements, sound and
  verified Telegram Saved Messages delivery of the compressed document.

These checks cover the opening area, not the full campaign. Delivered Playwright
MP4s now include the native game's stereo sound, captured without microphone or
system audio and aligned with the browser preview. The original silent WebM and
native WAV segments are retained. The `2026-10-24T16-38-19-165Z-odyssey-controls`
run passed all seven gameplay checks, produced 720p60 H.264 with stereo AAC,
and recorded no dropped audio frames. Its decoded AAC matches the aligned WAV
with 0.99969 correlation and zero sample offset error. This checks the mux;
subjective speaker/display latency is separate. Native recorder and full host
tests pass, as does the ARM64 Rust workspace suite. Current setup
details are in `tmp/odyssey-native/STATE.md`; build and regression logs are in
`tmp/odyssey/`.

If the native game crashes before `audio-stop`, the recorder can recover the
PCM already written after its verified 44-byte WAV header. It retains the
capture-start timestamp and preview alignment, records the recovered byte/frame
count, and still reports the audio capture as incomplete and the test as failed.
It never fabricates a successful stop. The real failed opening run
`2026-10-24T18-56-37-514Z-moon-lighting` recovered 31.17 seconds of native stereo
audio into a 1.91 MB, 720p120 failure recording; decoded AAC/PCM correlation was
0.99618. Recovery evidence is under `tmp/odyssey/audio-recovery/`.

## Frog capture and shadow texture lifetime

The first frog capture crash was caused by extra draws in guarded 60 FPS modes.
A render could arrive before the next simulation tick and draw without the
engine update's graphics preparation. That preparation releases the preceding
shadow textures; drawing again overwrote their owners and retained another
4 MiB allocation. The failure also reproduced before reaching the frog, so a
60 FPS cap did not solve it.

Guarded frames now sleep only until the next real simulation update is due.
Uncapped gameplay keeps its existing render-only path. Present-driven and
frozen test clocks retain render-only support with the required graphics
preparation. Clock credit and catch-up debt are preserved. The provisional
192 MiB texture pool and 272 MiB graphics heap were removed; the rewritten
guest uses its original 100 MiB pool and 170 MiB heap.

The allocation census verified one live shadow map after drawing instead of
accumulating old maps. It reached a legitimate 16 MiB map in the cinematic.
That diagnostic run passed all 13 gameplay checks. The production runtime has
no allocation census instrumentation.

The native-window run `2026-10-24T21-19-21-126Z-frog-freeze` then passed all
14 checks on the original budgets: full first capture cinematic, restored
control, frog jump, landing and movement. Its 3.50-second camera sample measured
154.44 rendered FPS and 59.95 simulation updates per second, with the renderer
uncapped and no interpolation restore mismatches. Player save hashes stayed
unchanged; the compressed recording includes native audio without capture
errors and was delivered to Telegram Saved Messages.

The source review found no new pacing wait in high-rate Play. Short, matched
offscreen measurements were 187.25 FPS before and 178.72 FPS after; a longer
reverse-order pair measured 147.00 and 136.79 FPS. Concurrent VM CPU/GPU load
limits attribution, so these results do not establish performance parity or
a speedup. The first window comparison also changed display refresh between
runs and is explicitly marked inconclusive in its analysis file. Keep those
raw measurements when doing a later quiet comparison.

The original director intentionally waits at least 2,250 of its own updates
before the first frog tutorial message. Its roughly 37.5-second cinematic is
separate from a resource allocation crash. This regression follows the game
through that entire transition instead of treating its duration as a freeze.

## Recorded-input compatibility status

`bun run --cwd tools/game-harness replay --headless --legacy-motion` runs
Mars2030's original 2,114-frame archived wake-up-to-tower segment unchanged.
It uses a separate private save, waits for the opening B prompt's actual input
guard (`step > 45`), and records source URL/hash, versions, controller profile,
all observed game states and the final tower-entry assertion. `--60hz` repeats
the same inputs with a 60 FPS renderer; the default is uncapped.

The legacy motion environment reproduces the Cappy chase, but both 60 FPS and
uncapped runs currently fail in Bonneton before entering Top Hat Tower. The
recording is labelled 1.3 and the local dump is 1.0.0. The exact original mod
build and complete initial state are not established. This is an honest failed
compatibility check; no route corrections or added recorded inputs are used,
and Cap Kingdom completion has not been demonstrated by this replay.

The replay now has sixteen native checkpoints instead of a single replay step
and a final stage assertion. The `2026-10-24T18-00-56-422Z-original-tas` run
passed twelve steps, failed **Land the village dive** at original source frame
1227, and marked switch activation, door opening and tower entry Not run.
The native game recognized all three jump presses and started the dive on the
recorded action. The failure occurred afterward when the player entered Damage
at the village ledge, at (-3832.25, 526.52, 5351.08). The observer missed no
updates, and the original input hash and all button/stick/duration values were
preserved. Playback stopped after the failure. Full evidence is in
`checkpoint-results.json`, `first-failure-state.json`, the JSONL trace, and the
compressed stereo recording. The first geometric divergence from the author's
reference still requires comparison; these checkpoints establish the first
detected native failure, not its root cause.

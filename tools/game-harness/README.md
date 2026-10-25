# Native Odyssey Playwright harness

Run the complete recorded demonstration from the repository root:

~~~sh
./scripts/record-odyssey-demo.command --120-video
~~~

That one command starts the local bridge if needed, enters Cap Kingdom, proves
walking/jumping/landing, changes 60 FPS / 120 FPS / Uncapped through Odyssey's
own Options menu, measures actual rendering and simulation, and creates a
compressed video. Each test starts a private game with its own save, working
directory, renderer settings and socket. Booting and loading still take the
game's own time. The Player instance and its progress are separate.

Every video opens with its title, purpose, and planned actions. The left sidebar
shows actual game thumbnails and highlights the current action. The ending shows
passed/failed counts. On failure, the action turns red, the error appears, and
every remaining planned action is marked **Not run**. Intro and success previews
are brief; the failure ending stays visible longer for inspection.
Failure details collapse empty diagnostic lines and have a larger, scrollable
box so actual/expected values remain readable. The saved tower-entry assertion
fits completely, including alongside twelve unrun actions; the full original
error remains in `test-result.json`.

To show gameplay driven by an actual archived controller recording, run
`bun run --cwd tools/game-harness recorded-demo` from the repository root.
It replays Mars2030's original Cap opening input frames 0-1203, with unchanged
buttons, stick values and durations, in a private native Tests window with
speaker playback enabled. The video includes the original input row, measured
native render FPS, the action timeline and native game audio. The input clock
and video remain 60 Hz; render FPS is measured separately in
`render-measurements.json`. No fixed 300 FPS label is substituted for a reading.
The archived source targets game version 1.3 and the local dump is 1.0.0.
This opening excerpt covers the chase and three jumps; it does not establish
completion of the full archived route or Cap Kingdom.

GUI input has no fixed key holds or pauses between selections. It advances when
the real game consumes input and its native menu is ready. Input and text queries
use a direct Unix socket to the ARM64 host. The browser is a passive viewer;
there is no browser event, HTTP relay, or control-file polling on that path.
Walking, jumping, and camera measurements deliberately remain visible. Short stick taps reach one
actual native HID sample even if they begin and end between 60 Hz updates.

~~~sh
./scripts/record-odyssey-demo.command                 # 60 FPS recording
./scripts/record-odyssey-demo.command --120-video     # 120 FPS recording
./scripts/record-odyssey-demo.command --window --120-video
./scripts/record-odyssey-demo.command --profile --120-video
cd tools/game-harness
bun run smoke                                      # shorter controls scenario
bun run gui                                        # private game and fast menus
bun run performance --120-video                     # private game and camera measurement
bun run check
~~~

`--profile` starts a fresh game, retains its log, frame timings, and interpolation
trace beside the video. Finalization stops only the test's own game.
`--window` also opens a native window labeled Tests; physical input and focus
changes do not interrupt it. Playwright uses
its own isolated browser for viewing and recording.

For native runtime debugging, `game.start({ nativeHost: absolutePath })` selects
an executable test build under `tmp/odyssey/`. The bridge validates its path
and rejects symlinks. The launcher records the actual host path in the game
log. Player continues to use the prepared host in `game-data/`.

Other generated files share `tmp/odyssey/`: `runtime-tests/` holds the test process
log, preview and captures; `checkpoints/` holds private test saves; `research/`
holds downloaded references. The bridge socket, process ID and log are also
under this directory. The player's persistent save stays in the game's run
folder.

Results go into timestamped folders under `tmp/odyssey/harness/`:

- `playwright-recording-compressed.mp4`: H.264, 1280x720, CRF 28, fast-start,
  with stereo 48 kHz AAC game audio; preserves the original 60 or 120 FPS rate.
- Original Playwright WebM, retained for inspection.
- `native-audio-*.wav`: original PCM16 stereo game output, including headless
  playback. `native-audio.json` records timestamps, preview delay, sample counts,
  dropped frames, and the offsets used for muxing.
- `recording-intro.png` and `recording-cover.png` (the final result card).
- Full native PNGs, `demo-report.json`, and `test-result.json` with action
  timings, the actual failure, and steps that did not run.
- On failure, `failure-state.json` and `failure-native.png`.

`bun run fog` checks the opening's low fog on a private fresh save. It uses a
separate native process at port 4318, a separate socket and runtime directory,
and leaves the player's running game alone. It records 720p120 with sound,
retains 36 native render frames, and checks the 60 Hz simulation plus per-render
history/preparation counts. Inspect the consecutive frames for fog flicker;
passing counters alone do not establish visual correctness.

The page is 1600x900 before compression; its game panel stays 16:9. Native PNGs
are separate 1600x900 game captures. The browser's original WebM is silent;
the delivered MP4 combines it with the game's native sound.

Audio is tapped after the native output applies volume, using the same output
path as the real device and the headless real-time sink. The audio callback
copies into a bounded queue; a separate thread writes the WAV. Capture never
uses a microphone or the system mix. Each native restart creates another segment.
The fixture aligns segment UTC timestamps to the browser recording and adds the
measured preview delay. Silence preserves the intro, restart gaps, and ending.
Missing or dropped audio makes finalization fail instead of reporting a complete
recording. The WAV and original video remain available for diagnosis.

The 2026-10-24 `16-38-19-165Z-odyssey-controls` recording passed all seven
gameplay checks. Its 720p60 MP4 contains AAC stereo, with zero dropped audio
frames. Audio/video durations differ by less than 1 ms. Comparing the decoded
AAC to the timestamp-aligned native WAV gave 0.99969 correlation and zero
sample offset error; this verifies mux alignment, rather than subjective
speaker/display latency. Evidence is in that run's `audio-verification.json`.

## Native Page and Playwright recording

Native frame replay is also available as `await game.replay(path)` or
`await page.replay(path)`. Each non-comment row contains
`frames buttonsHex leftX leftY rightX rightY`; axes are signed integers from
-32767 to 32767. The native host loads the file once and advances it on the
original 60 Hz simulation clock, independently of rendering and socket timing.
`await game.release()` stops replay and releases all controls.

`bun run replay --headless` imports Mars2030's original archived
wake-up-to-tower script from `tmp/odyssey/research/cap-archive/33.txt`.
It clones a private save under `tmp/odyssey/checkpoints/` and waits for the
documented B-prompt starting state. Every source button, stick value and frame
is preserved; there is no adaptive steering or added motion. The artifact records
the source URL, hash, setup, and source/local game versions. The archive labels
this segment 1.3, while the local dump is 1.0.0; that difference must be kept in
mind when diagnosing divergence. Tower entry and full Cap completion are separate
assertions. The prior video-overlay experiments are retained as failed research;
their inferred sticks/motion do not establish gameplay compatibility.

The opening prompt is visible before it accepts input. The harness waits for
the original `OpeningStageStartDemo::exeWaitStandUp` guard (`step > 45`) before
source frame zero, then verifies that the source's first B press starts standing
up. This fixes setup without changing any recorded frames.

`--60hz` selects a 60 FPS renderer for comparison; the default remains uncapped.
`--legacy-motion` selects the published practice-mod `oldMotion` controller
environment: L triggers an upward right-hand motion, D-pad triggers directional
two-hand motion, and L camera centering is suppressed during replay. RSTICK
retains its original digital meaning. The native host applies these semantics
at offline-verified base-build call sites, delegates to the original game
outside active playback, and leaves the input file intact. The source URL and
the provenance limit are recorded: the exact motion-mod build used to author
the archived segment is unknown, so this is a compatibility profile to test,
not a claim that the original environment has been fully reconstructed.

The original replay has sixteen named steps: private setup, the actionable B
prompt, standing up, wake-up completion, the chase roll, Cappy's meeting,
cutscene skipping, the village approach, three separate jumps, the dive, its
landing, the switch, the door, and tower entry. A passive native subscription
checks actual actor states and processed player triggers while the entire input
file runs on its own native queue. Updating the sidebar never schedules inputs.
The first missed checkpoint stops playback, captures its source frame, position,
velocity and full native state, and leaves future actions Not run. Detailed
results are in `checkpoint-results.json` and `first-failure-state.json`.

`--trace-every-frame` retains every observed native update in the JSONL trace;
checkpoint monitoring always observes every available update. Observation gaps
are recorded explicitly. `route.replayFrame` is captured with the actor snapshot
on the game thread, avoiding confusion with a newer input row that has been
queued before the next game update. Error messages use the original file's
zero-based source frame numbers.

The script's `page` is a NativeGamePage with Playwright-style keyboard and
locator methods. They call the native controller and read actual native pane
strings, list labels, selected values, and enabled states. Text waits subscribe
to native state changes, with no guessed menu delays or OCR. Selected values
come from the actual `TxtRoll` pane, including Odyssey's roll animation; a
requested selection index alone does not satisfy the text wait. Native input
guards, scrolling cooldowns, and roll completion supply actionability. Controller input uses the original
HID path; selectors do not overwrite menu selection or game state.

`viewer` is the real Playwright browser Page used for the action panel and video.
It is independent of the user's Chrome, using the dedicated headless shell under
`~/.cache/going-up-browsers`. Set `GAME_HARNESS_CHROMIUM` for another location.
The fixture blocks `/api/input` requests from this viewer and records their count
in `test-result.json`. Launch/stop management and viewer status are separate from
the direct native control path.

Menu automation uses the same familiar shape:

~~~ts
await page.keyboard.press("Enter");
await page.getByRole("option", { name: "Options", exact: true }).click();
await page.getByRole("option", { name: "Graphics", exact: true }).click();
await page.getByText("Renderer limit", { exact: true }).selectOption("120 FPS");
await page.getByText("120 FPS", { exact: true }).waitFor();
~~~

This is the supported native API subset, rather than a DOM Page or browser
Locator. Menu text currently covers Pause, Options, Controls, and Graphics. Common lists
expose all logical rows, and focusing drives the game's controller to scroll.
Title menus, other subpages, and arbitrary rich-text tags are not exposed yet.

~~~ts
import { createGameTest } from "./fixture.ts";
import { enterOpeningGameplay } from "./opening.ts";
import { join } from "node:path";

const test = await createGameTest("movement", {
  title: "Odyssey / movement check",
  description: "Start a private native game, walk forward, and capture the result.",
  actions: ["Start isolated gameplay", "Walk forward"],
});
const { page, game, artifacts } = test;
let failure: unknown;

try {
  await test.step("Start isolated gameplay", async () => {
    await game.start({ headless: true });
    await enterOpeningGameplay(page);
  });
  await test.step("Walk forward", async () => {
    await page.keyboard.down("w");
    try {
      await game.waitForInput();
      await page.waitForTimeout(1000); // Visible movement, not a GUI delay.
    } finally {
      await page.keyboard.up("w");
      await game.waitForInput();
    }
    await game.screenshot(join(artifacts, "walking.png"));
  });
} catch (error) {
  failure = error;
  throw error;
} finally {
  await test.finish(failure); // Ending, WebM, MP4; prints PLAYWRIGHT_VIDEO=...
}
~~~

Import relative to your script and run with Bun. Declare planned actions upfront
so the recorder can identify unrun steps. Put scenario actions inside `test.step`
and always call `finish` in `finally`. Share the compressed MP4 after every run,
including failures. Keep scratch scripts in gitignored `tmp/`.

## Controller and API

| Script key | Native input |
| --- | --- |
| W / A / S / D | Left stick up / left / down / right |
| Arrow keys | Right stick / camera |
| J / K / U / I | A / B / X / Y |
| Q / E | L / R |
| Z / C | ZL / ZR |
| F / G | Press left / right stick |
| Enter / Tab | Plus / Minus |
| Space | Shake |

`page.keyboard` and `game.keyboard` are the same native driver. Down/up dispatch
directly; a press waits for actual consumed/released samples. `waitForInput()`
waits for dispatch, and `game.status().native.consumed` reports input committed
after the original game update. Menu locator actions wait for their actual text
or selection change and the native input guard to permit the next action.

~~~ts
await game.stick("left", 0.35, 0.8);             // Hold; +Y is up.
await page.keyboard.press("k", { delay: 150 }); // B: jump.
await game.stick("right", -0.6, 0, 1500);
await game.press(["L", "R"], 100);
await game.release();
const state = (await game.status()).native;
await viewer.screenshot({ path: join(artifacts, "viewer.png") });
await game.screenshot(join(artifacts, "native.png"));
~~~

`setInput` replaces the complete controller state; axes range from -1 to 1.
`connectGame(viewer)` returns the native connection, native `page`, and original
`viewer` without starting or stopping the game. The optional dashboard at
<http://127.0.0.1:4318/> supports manual controls for the Tests instance; recorded
tests use <http://127.0.0.1:4318/?view=game&native=1>, which disables browser input.
Run `bun run start` for the viewer/process manager alone.

Player uses `scripts/play-odyssey.command`; `--slot NAME` selects an additional
personal save. The default Player save and preferences retain their existing
paths. Each automated start creates `runs/<uuid>/save`, `game-temp`, and
`native-options.ini` under the test runtime. `saveDirectory` is a checkpoint
seed under `tmp/odyssey/checkpoints/`, copied into the run instead of mounted.
`test-result.json` records these paths and instance ownership. A second test
cannot attach to a test already running. Explicit Player observations permit
only native state reads and waits; start, stop, input and release are rejected.

The preview uses two asynchronous Metal readbacks, 1280x720 JPEGs, and a persistent
WebSocket to the `#game-frame` canvas. Slow consumers get the latest frame rather
than a backlog. Capture stops when no viewer is connected. Full native PNG
capture is separate and does not block controller input. It waits for a newly
produced native frame, so queued older presents cannot satisfy a screenshot.

Rendering, game updates, drawable presentation callbacks, preview delivery, and
recording cadence are measured separately. The native adapter fixes game updates
at 60 Hz while allowing additional renders. It interpolates camera and model root
positions between completed updates; skeletal animation retains its current pose.
Loading, menus, and cinematics keep the guarded 60 FPS path. The active display's
refresh rate limits the complete frames it can show.

## Verified local results

On the M4 Pro, the latest full native-window test rendered 119.51 FPS at the
120 setting and 219.33 FPS uncapped, with actual game/scene updates near 60 Hz.
Earlier opening-area runs measured up to 261.07 FPS uncapped. The separate
seven-step GUI test completed in a 9.03-second, 511 KB video, with zero viewer
input requests. Median native dispatch was 0.41 ms; input consumption was
16.63 ms, and a full press/release took 33.04 ms. Native text selectors also wait
for the original value animation to complete. These numbers cover the opening
Cap Kingdom and tested menus, not the entire campaign.

The latest compressed gameplay video is 1280x720 at 120 FPS, 5.31 MB for 53.08
seconds. Conservative FFmpeg duplicate removal retained 102-103 changing frames
per second in its camera pans; the file-rate label is not the sole evidence.
The current window's screen reports 60 Hz. Drawable presentation callbacks are
counted separately and do not imply a higher physical scan-out rate.

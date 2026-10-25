# Native game harness

- Player and Tests are separate instances. Normal tests default to port 4318,
  `runtime-tests` and `tests.sock`; Player owns port 4317 and `native.sock`.
  Resolve endpoints when constructing an instance, never at module import.
  Explicit test overrides such as `runtime-fog` and `fog.sock` remain supported.
- Every test start gets a fresh private save, temp directory and renderer
  preferences. `saveDirectory` is only a checkpoint seed under
  `tmp/odyssey/checkpoints/`, copied into that run; never mount Player saves.
  Keep the instance and actual save/preferences paths in `test-result.json`.
- Test windows use `DM_AUTOMATED_INPUT=1`: skip physical keyboard, controller,
  touch and haptics callbacks, and ignore focus/minimize suspension. Native
  socket input remains available. Player observation must be explicit and
  read-only; test start/stop/release must never target Player.
- A crashed process is valid status data with `running: false` and its error.
  Preserve that failure in results while allowing a new start. Do not stop an
  audio recording that never started during fixture initialization.
- This is the main game automation harness. Its NativeGamePage supplies the
  Playwright-style keyboard and locator API directly to the native host over a
  Unix socket. The real Playwright browser page is only the viewer/recorder.
- Keep browser events, HTTP relays, and control-file polling out of the script's
  input/text-query path. Rendering stays in the native ARM64/Metal runtime.
- Wait on native UI text and enabled state with locators. Avoid menu indices,
  guessed frame counts, OCR, or delays as substitutes for native actionability.
- Reuse existing game/controller implementations before inventing mappings.
- Prove gameplay beyond the menu: camera, locomotion, jumping, video, and audio.
  Input delivery alone does not prove the game responded.
- Every game test must use `createGameTest`, finalize its recording even on
  failure, and provide its Playwright video in the conversation after the test.
- Share compressed MP4s: 1280x720, H.264, CRF 28, fast-start metadata; preserve
  the recording's frame rate. Use 60 fps normally or 120 for motion validation.
  Keep the original Playwright WebM locally for detailed inspection.
- Include native game sound in every delivered MP4, including headless tests.
  Capture the game's actual output, align it to the video timestamps, retain the
  WAV/metadata, and verify audible samples and the final audio stream. A silent
  browser WebM alone does not satisfy recording delivery.
- Windowed demonstrations must also enable native speaker playback; recording
  a non-silent WAV does not establish that the live game window is audible.
- Measure native presents, delivered browser frames, and recording cadence
  separately. Verify motion in the finished recording before claiming smoothness.
- For live-window corruption, identify the capture point. A clean source image
  captured before the final display copy does not prove the window is correct.
  Match Player's persistent pipeline cache and FPS-overlay state in isolated
  reproductions; fresh Test defaults can omit both code paths.
- Check high-rate rendering at the opening's low fog around Mario's feet.
  Use consecutive native frames and verify one stateful GPU preparation per
  render, with rendered-image history separate from the 60 Hz simulation.
- The user reports chat video downloads failing. Send compressed recordings to
  the already-authorized Telegram Saved Messages as documents and verify delivery.
- Use app-scoped desktop controls for Telegram delivery. Never substitute global
  macOS keystrokes or focus-dependent AppleScript typing: the user may be using
  another app, and input can trigger shortcuts there. If targeted desktop control
  is unavailable, keep the compressed files ready and report delivery unverified.
- Every recorded scenario uses `test.step` for a left-side action timeline with
  real game thumbnails and a highlighted current action. Keep the game at 16:9.
  Recorded replays need native checkpoints for movement phases, individual
  jumps, landings, and stage transitions. Fail the first missed checkpoint and
  mark future phases Not run while preserving the native input clock.
- Every test opens with its title, purpose, and planned steps, and ends with a
  passed/failed result. On failure, show the failed action and error, mark all
  remaining planned actions "Not run", and retain those states in the video.
- Run GUI input as soon as native state permits it: no fixed key holds or
  pauses between menu actions. Wait for real consumption/selection changes.
  Keep movement/jumps visible and the successful ending preview brief.
- Keep the end-to-end demonstration in one runnable script; `bun run demo` must
  start the bridge if needed, drive the scenario, and produce its compressed video.
- Use the dedicated `chrome-headless-shell` under `~/.cache/going-up-browsers`.
  Keep tests separate from the user's browser and desktop.
- Keep game files, keys, recordings, and captures out of Git. Use Bun.
- When asked to copy a speedrunner's keypresses, obtain an actual input recording
  or a run with a verified input overlay and retain its buttons and frame counts.
  Do not substitute an inferred route or repeated autonomous navigation attempts.
- This replay is a runtime compatibility check. Keep the original recorded
  buttons, sticks, motion, and durations unchanged; do not correct the route
  from native game state. Fix runtime divergences instead. A video overlay with
  inferred sticks or reconstructed motion is an incomplete source, not a
  successful gameplay compatibility proof.
- A failed recorded-input replay is ongoing debugging, not task completion.
  Continue independent native input/state analysis while a reference-retrieval
  question is pending; do not treat that pending question as blocking all work.
- The user approved all yt-dlp use for this project on 2026-10-24. Retrieve
  reference footage with yt-dlp without asking for that permission again.

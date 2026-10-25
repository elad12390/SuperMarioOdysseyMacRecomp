# Native LunaKit replay

Run the original two-player binary from TSV-TAS-2 through the native Scene movement clock. The browser only records the native stream. P1/Mario and P2/Cappy retain the original buttons, float32 sticks, both accelerometers, direction matrices, angular velocities and frame durations.

## Verified Cap profile

The complete 7,055-frame Cap recording passed all 14 source checkpoints on 2026-10-25. A separate fifteenth step dismissed Cascade's welcome and verified playable Waterfall. The isolated run is recorded under tmp/odyssey/harness/2026-10-25T03-51-47-833Z-lunakit-cap/. It includes native stereo audio, zero dropped audio frames, an intro, action timeline, source/controller HUD and passing result.

Use English, paired Joy-Con and the original fastest camera sensitivity level 2. The runner generates a preferences-only Common.bin; the game creates File1.bin itself. No Player save is copied. The default level -1 misses the bridge. With level 2 the bridge cinematic ends at scene frame 3112, allowing the unchanged R at 3114; with -1 it ends at 3122. This is an observed compatible starting setting; the source TSV does not encode it.

The route is frogless inside Top-Hat Tower. Its first B wakes Mario; its later B1620 is a movement jump. The source endpoint is the Odyssey logo fadeout. Arrival/playability checks occur after the source tape, and separate GUI acknowledgements are logged as such. They never steer the authored route.

From the repository root:

~~~sh
bun tools/game-harness/lunakit-replay.ts \
  --tape tmp/odyssey/tsv-replay/cap.bin \
  --scenario cap --host tmp/odyssey/tsv-replay/dmhost-cascade3 --language en-US
~~~

## Cascade checkpoint and run

The supplied Cascade file is the first-story-moon to world-selection segment, not a fresh full-kingdom recording. It assumes three ordinary moons: chest 216, Chomp Through the Rocks 206, and 2D 212. The reference map also shows acquired Island in the Sky (obj2832) and Waterfall Basin (obj597) flags. The original world-to-map matrix and catalog positions identify these markers with approximately 5px and 1px residuals; other flags do not match. Story 205, painting-island 207, and boss multi-moon 218 must remain uncollected. Its original position initializer (5700,1175,700) is applied once by the native source adapter.

Prepare a private checkpoint from a genuinely persisted zero-moon Cascade arrival. The tool refuses a Cap save rather than manufacturing stage, unlock or story flags:

~~~sh
uv run --no-project tools/game-harness/prepare-cascade.py \
  --seed tmp/odyssey/runtime-tests/runs/GENUINE-RUN/save \
  --out tmp/odyssey/checkpoints/cascade-initial \
  --checkpoint obj2832 --checkpoint obj597

bun tools/game-harness/lunakit-replay.ts \
  --tape tmp/odyssey/tsv-replay/cascade.bin --scenario cascade \
  --host tmp/odyssey/tsv-replay/dmhost-cascade3 \
  --save tmp/odyssey/checkpoints/cascade-initial --language zh-TW
~~~

The writer copies only Common.bin/File1.bin and changes the three moons' IsGet, Status and ordered native-second GetTime fields, Common's locale and CRCs. Explicit repeated --checkpoint IDs fill empty acquired-checkpoint entries; their sorted value-string table is appended into unused BYAML padding, and every value-string index is remapped to preserve its logical string. Native validation requires lexical table ordering. The manifest includes these fields and the table storage change. It validates both decoded field differences and byte whitelists, rejects shared payloads, existing outputs, Player paths, links and special files, and preserves the input. The sibling JSON manifest records hashes/differences. This is a prepared prerequisite fixture, not an exact live frame or a claim that those earlier three routes were played. The reference proves flag activation by its map moment, not before source frame zero; pre-seeding them is an explicit fixture precondition and does not establish their acquisition history. Chest animations, broken geometry and temporary actor switches are not reconstructed.

Before source frame zero the runner requires original native GameDataFile readback showing exactly those three moons in playable Waterfall. Passive source gates cover story moon 3 -> 4, cutscene/dialogue exit, movement jump, rolling, roll cancel, native island warp, later jump, painting moon 4 -> 5, the restored Odyssey and the original world-selection substate. Unknown/missing telemetry fails; consuming all 5,327 source frames alone cannot pass. All 14 steps passed on 2026-10-25 in tmp/odyssey/harness/2026-10-25T04-26-21-513Z-lunakit-cascade/. The tested seed is tmp/odyssey/checkpoints/cascade-source-map-flags-sorted-20261025/. Native world selection was observed and the original B tail closed it; the runner did not select a destination or add post-tape steering.

## Options and isolation

- Required: --tape, --scenario cap|cascade, and an executable --host. No implicit Player host or download fallback.
- --save is required for Cascade and forbidden for Cap. Seeds must be below this checkout's tmp/odyssey/checkpoints/ and are copied into a fresh private run.
- --language defaults to en-US for Cap and zh-TW for Cascade. The verified generated Cap preferences require en-US.
- --camera-speed accepts original levels -2..2 for Cap comparisons; default 2. Cascade retains its checkpoint preferences.
- Optional --through FRAME is a zero-based partial diagnostic cutoff. The entire original tape is queued; observation latency may overshoot. A partial run never claims kingdom completion.
- --help prints usage without opening a game.

Only Tests instances are permitted. The launcher requires automated input and private runtime/save/socket/settings paths, enables DM_SMO_LUNAKIT=1 and DM_TEST_NPAD_STYLE=joy-dual, and records supplied host/tape/seed hashes. It clears conflicting legacy motion and inherited automation settings. It copies the existing pipeline cache into the private run and sets render_fps=0/show_fps=1 there. The installed Player executable, saves, preferences and renderer are independent.

## Evidence and recording

Each fixture saves original.bin/source.json, launch status, bootstrap receipts/state, native-state.jsonl, original P1/P2 float32 receipt comparisons, observation coverage and checkpoint verdicts. Source receipt mismatches and native Miss/Dead states fail immediately. Unseen IPC snapshots are reported as observation gaps, not claimed as individually verified inputs or dropped simulation frames.

All steps use the shared action timeline. The first failed step stays failed and remaining actions become Not run. test.finish runs in finally, retaining the native WAV/metadata and original WebM, plus a 1280x720 H.264 CRF28 fast-start MP4 with native game audio. Failure-only recordings remain diagnostics. replay-result.json distinguishes partial diagnostics, source completion and complete native checkpoint results.

Cap additionally saves initial-common.bin, generated preference provenance, source-end-state.json, post-replay-gui-inputs.json and playable-cascade.json. GUI acknowledgements start only after every authored frame and are excluded from the original trace.

Run the commands as background jobs with captured PID/log/status, as required by the project instructions.

## Reusing a running game

runLunaSegment(test, tape, plans, { directory, label }) plays on the fixture's existing native process and records per-segment receipts/checkpoints. It does not seed/reload a save, restart a process or finish the recording. Call installLunaHUD once on the shared viewer and finish the owning fixture exactly once. Prefix checkpoint labels when composing segments so the action timeline is unambiguous.

launchLunaWrapper(..., "verify") selects the Tests-only DM_SMO_LUNAKIT_POSITION=verify policy: validate proximity to nonzero source position metadata, with no position or puppet writes. The 150-unit check alone does not reconstruct Cappy's live state or make unrelated tapes continuous. The default CLI still uses the source initializer for isolated segment compatibility.

Cap --language en-US or zh-TW generates matching fresh Common preferences; File1 remains game-created. The supplied Cascade segment misses its first-moon dialogue deadline with true English preferences. A launch-language override alone is insufficient when Common retains TWzh.

The matching TWzh fresh-Cap run also passed all 15 checks with unchanged 7,055-frame inputs: tmp/odyssey/harness/2026-10-25T04-51-25-443Z-lunakit-cap/. This verifies a shared language profile for the two segments; it does not fill the missing three-moon/Cappy-state route.

## Continuous ownership diagnostic

Use --session continuous with the full fresh Cap scenario to test a real same-process handoff. It adds three labelled checks after normal Cap completion: retain 2P, play one generated neutral scene frame as a separate ownership probe, and explicitly restore the initial controller mode. It does not play the missing three-moon route.

~~~sh
bun tools/game-harness/lunakit-replay.ts \
  --tape tmp/odyssey/tsv-replay/cap.bin --scenario cap \
  --host tmp/odyssey/continuous/dmhost-handoff2 --language zh-TW \
  --session continuous
~~~

The opt-in launcher sets DM_SMO_LUNAKIT_CONTINUOUS=1 and the no-write source-position policy. The segment queue bypasses the isolated replay-stop wrapper, preserving Cappy's live mode between tapes. The generated neutral probe is saved separately, is not presented as original runner input, and must not be used as a route bridge.

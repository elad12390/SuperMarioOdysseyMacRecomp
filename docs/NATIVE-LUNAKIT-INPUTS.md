# Original two-player LunaKit inputs

The native Tests host can play unmodified BOOB binaries from the original [TSV-TAS-2 compiler](https://github.com/xiivler/TSV-TAS-2). The adapter follows [PlacidMink's original TAS runtime](https://github.com/PlacidMink/smo-lunakit-tas/blob/stable/src/program/smo-tas/TAS.cpp). It is an input compatibility tool; consuming a recording is not proof of completing its route.

## Isolation and activation

The prepared Player executable is not replaced by input experiments. Build a separate candidate below tmp/odyssey/ and use the Tests launcher. DM_SMO_LUNAKIT=1 requires DM_AUTOMATED_INPUT=1 and the verified Odyssey 1.0.0 main build 3ca12dfaaf9c82da064d1698df79cda1. Unknown builds fail before installing hooks. DM_TEST_NPAD_STYLE=joy-dual selects paired Joy-Con classification for automated instances; the default remains full-key. Source controller mode is configured before frame zero.

Player saves, preferences, renderer lifecycle and frame limits are independent of the adapter. Test saves and recordings remain below tmp/odyssey/. No game assets or original input files are tracked.

## Source semantics

- Apply both players at the original Scene::movement boundary, after normal pad sampling and before scene logic. Render-only updates, status requests and video recording do not consume source frames.
- Preserve SEAD button bits, float32 sticks, both accelerometers, both direction matrices and both angular velocity vectors. Do not convert to integer HID or legacy motion aliases.
- Resolve each original player port through the game's own controller manager. Missing addon sets fail atomically before either player's input is written.
- Decode off the game thread; reject malformed input before replacing a running tape. The bounded decoder validates length, ordering, players, float values and metadata.
- Apply nonzero source position metadata once through the original puppet lifecycle. A zero position means no teleport. Stage/entrance changes are explicitly unsupported and rejected.
- Release controls and restore the test adapter's controller ownership on stop, completion and failure. The final authored frame reaches the original movement before cleanup.
- DM_SMO_LUNAKIT_DIAGNOSTICS=1 adds passive results from the original motion analyzers. It does not change detection or controller input.

The native replay JSON includes source frame, record count, phase, generation and separate P1/P2 controller receipts. Completed receipts retain their final source frame after input cleanup so a later doorway or stage transition can still be observed; stop or another tape ends that retained selection. The browser is a passive viewer. Snapshot gaps are reported as observation gaps; they do not establish dropped native inputs.

## Validation and current limits

The supplied Cap file compiles to 7,055 scene frames / 14,110 player records. Cascade compiles to 5,327 / 10,654. Full original binary replay through the real decoder/pad-writing implementations passes the CPU golden checks for every record. These CPU checks use synthetic guest callback boundaries; they are not gameplay completion.

The complete fresh Cap run now passes its 14 source checkpoints: wake-up, first jump, Cappy chase, bridge, frogless tower ascent, upper exit, and all 7,055 original frames through the logo transition and Cascade load. A separate fifteenth GUI step acknowledges Cascade's welcome and verifies playable Waterfall. The passing isolated recording is tmp/odyssey/harness/2026-10-25T03-51-47-833Z-lunakit-cap/; it has native stereo audio and no dropped audio frames.

The compatible initial camera level is 2 (fastest). The generated Common.bin contains preferences only; File1.bin is created by the game. With default level -1 the bridge cinematic ends at 3122, swallowing original R3114-3118. At level 2 it ends at 3112 and the unchanged tape crosses correctly. The source file does not encode camera sensitivity, so this establishes a working initial profile rather than the author's exact settings. No buttons or durations were changed.

Independent comparisons found 2,976 identical shared position snapshots at capped versus uncapped rendering, and 2,975 identical shared position/velocity/camera snapshots with Pro versus paired Joy-Con. Original motion analyzers recognize the recorded shakes. Those hypotheses were ruled out for the bridge miss; no renderer workaround was introduced.

Cascade uses Traditional Chinese and assumes three prior ordinary moons. The source Sheet identifies the chest, Chomp Through the Rocks, and 2D moon; the local original catalog resolves them to 216, 206 and 212. The private checkpoint writer requires a genuinely saved Cascade arrival and changes only those acquisition records, locale and CRCs. It preserves story, boss and checkpoint flags, and records all byte/field differences. The reference map additionally requires Island in the Sky (obj2832) and Waterfall Basin (obj597). Original world-to-map projection identifies those visible markers with approximately 5px and 1px residuals. These are supplied as explicit fixture preconditions: their activation by the reference map is established, but their acquisition timing before frame zero is not. No other checkpoint flags are invented. The native loader requires sorted BYAML string tables; the writer rebuilds that table and remaps value-string indices while preserving every logical field outside the whitelist.

The complete 5,327-frame Cascade segment now passes 14 native checkpoints from that prepared fixture: original story moon 3 -> 4, movement/jumps/roll cancel, native island warp, painting moon 4 -> 5, initial Odyssey activation and world selection, then every original frame. The passing recording is tmp/odyssey/harness/2026-10-25T04-26-21-513Z-lunakit-cascade/. This is a segment compatibility result, not proof that its three earlier moon routes were played or that its exact initial live frame was reconstructed.

Tests-only passive lunaGameData telemetry queries the original GameDataFile for Cascade's count and IDs 216/206/212/205/207/218. The original isActivateHome predicate (initial Cascade restoration; later-story repair is different) and the verified StageScene world-map substate provide restoration/world-selection evidence. These getters do not write save data, move actors, cap rendering, or install in the normal Player executable. Exact source inputs continue to run independently of observation.

## Checks

Run the native host and harness checks, then the optional private golden inputs:

```sh
DM_GAMES_DIR="$PWD/game-data/super-mario-odyssey/profile" make -C external/nxnative/dm/host/tests GAME=0100000000010000 run
external/nxnative/dm/host/tests/build/t_smo_lunakit_tape tmp/odyssey/tsv-replay/cap.bin tmp/odyssey/tsv-replay/cascade.bin
TMPDIR="$PWD/tmp/odyssey/tsv-replay" external/nxnative/dm/host/tests/build/t_smo_lunakit_runtime --goldens tmp/odyssey/tsv-replay/cap.bin tmp/odyssey/tsv-replay/cascade.bin
bun run --cwd tools/game-harness check
bun test tools/game-harness/nx-tas.test.ts
```

The default native suite uses only synthetic inputs and does not require private recordings. The source-of-truth native changes are in scripts/patches/nxnative-odyssey-sdk3.patch.

## Continuous playback boundary

runLunaSegment in tools/game-harness/lunakit-segment.ts queues one unchanged tape on an existing fixture. It does not start/stop the game, load a save, or finalize audio/video. Each segment retains its own trace, strict float32 receipts and checkpoint results; an outer fixture owns the recording lifecycle. The existing CLI uses the same implementation. A failed segment finalizes its diagnostic through the owning fixture.

DM_SMO_LUNAKIT_POSITION=verify is an opt-in Tests preflight for continuous playback. For a nonzero source position, it reads the original al::getTrans result and rejects frame zero unless Mario is finite and within 150 game units of the source start. It never calls the puppet or position setters in this mode. The receipt includes positionPolicy, positionChecked and positionDelta. This check runs once; it is not ongoing steering. The default isolated-segment mode retains the original position initializer. The wrapper selects the policy explicitly and clears an inherited value. CPU cases cover nearby/no-write, later ordinary movement, a distant start and non-finite coordinates.

Proximity is not proof of a compatible live junction. Cappy's transform and prior location, transient actors, three genuine moon acquisitions and naturally activated flags also matter. The supplied Cascade tape attempts ICRC before opening its map; pre-seeding Island in the Sky can mask whether that trick activated it. A whole run must establish and observe these states through gameplay. The earlier two fixture recordings are not a continuous-run result.

Fresh Cap preferences can now be generated with USen or TWzh locale. Common's internal locale takes precedence over the launch fallback in the observed profile: changing DM_LANG alone did not switch the Chinese fixture. A true English fixture misses the Cascade first-moon dialogue deadline at source frame 1365. Inputs were not retimed. The matching Chinese fresh-Cap compatibility check is separate from whole-run completion.

The matching TWzh fresh-Cap run also passed all 15 checks with unchanged 7,055-frame inputs: tmp/odyssey/harness/2026-10-25T04-51-25-443Z-lunakit-cap/. This verifies a shared language profile for the two segments; it does not fill the missing three-moon/Cappy-state route.

## Continuous controller ownership

DM_SMO_LUNAKIT_CONTINUOUS=1 keeps the initial controller owner snapshot across tape boundaries. Completion releases both controllers but retains the live separate-play mode; a pending replacement tape does not restore/recreate Cappy. A new tape compares its mode with the current mode, while retaining the original owner for later restoration. Explicit stop, source error and legacy replay transitions restore the original mode. This opt-in remains Tests-only and is disabled by the normal launcher.

The passive lunaSession object reports continuous, modeOwned, initialSeparatePlay and the stage's actual separatePlay getter result. The continuous runLunaSegment path sends the native replay command directly after neutral input release; the isolated NativeGamePage.replay wrapper deliberately stops a previous replay and must not be used for this handoff. ReplayObserver uses the native source generation to recognize a newly completed one-frame tape without accepting a prior completed tape.

The --session continuous Cap diagnostic runs the complete original tape, acknowledges Cascade's welcome, verifies retained live 2P mode and zero moons, queues a separately labelled generated one-frame neutral ownership probe, and explicitly stops/restores the original mode. It compares PID, run ID, save and settings identities. It does not supply the missing Cascade bridge or claim whole-run completion.

The first live retained-2P attempt passed all original Cap source checks but failed during welcome acknowledgement. HID had reported its last controller read (Cappy) as the consumed receipt, hiding Mario input from the GUI helper. The host now retains player 1 consumption separately while preserving raw last-controller observation fields; additional HID cases cover P2 polling after P1 press/release. This changes acknowledgement data, not input or game timing. The full diagnostic remains unverified until its real-game rerun passes. replay-result separates sourceCheckpointsPassed from complete scenario success.

The corrected real diagnostic passed all 18 actions in tmp/odyssey/harness/2026-10-25T05-12-18-098Z-lunakit-cap/. Original Cap7055 frames were unchanged; a separate neutral probe advanced native source generation7055 ->7056 while retaining owned 2P mode. Explicit stop restored the original1P mode. PID23277 and save/settings/run identity stayed unchanged, Cascade moons stayed0, viewer input requests were0, and native audio recorded8957634frames with0drops. This proves controller handoff/GUI integration, not the missing3moon route or full continuous-goal completion.

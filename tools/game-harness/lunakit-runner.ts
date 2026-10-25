import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, lstat, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createGameTest } from "./fixture.ts";
import { cascadeCheckpoints, lunaGameData, verifyCascadePrerequisites } from "./cascade-checkpoints.ts";
import { capCameraPreferences } from "./camera-config.ts";
import { readLunaTape, type LunaReplay } from "./lunakit-tape.ts";
import { gameInstance, validateTestPath } from "./manager.ts";
import { enterOpeningGameplay } from "./opening.ts";
import type { NativeState } from "./protocol.ts";
import type { ReplayCheckpoint } from "./replay-observer.ts";
import { installLunaHUD, runLunaSegment } from "./lunakit-segment.ts";
import { handoffActions, verifyContinuousHandoff } from "./lunakit-handoff.ts";

export type LunaReplayOptions = {
  tape: string;
  scenario: "cap" | "cascade";
  host: string;
  save?: string;
  language: string;
  through?: number;
  cameraSpeed?: number;
  continuous?: boolean;
};
type Tape = Awaited<ReturnType<typeof readLunaTape>>;
// The native opt-in publishes this already. Do not extend the shared protocol WIP.
type LunaState = NativeState & { lunaScene?: { type: string; nerve: string; step: number } };
const root = resolve(import.meta.dir, "../..");
const player = (s: NativeState) => s.route?.actors.find(actor => actor.type === "PlayerActorHakoniwa" && actor.alive);
const opening = (s: NativeState) => s.route?.actors.find(actor => actor.type === "OpeningStageStartDemo");
const replay = (s: NativeState) => s.replay as LunaReplay | undefined;
export const nativeGameplayReady = (s: NativeState) => /StageSceneNrvPlayE/.test(s.timing?.scene ?? "") && Boolean(player(s)) &&
  s.route?.player?.inputDisabled === false && !/NrvDemoE|NrvBindE|NrvDead/.test(s.timing?.playerNerve ?? "");
const y = (s: NativeState) => s.timing?.position?.[1] ?? -Infinity;
const nativeDeath = (s: NativeState) => /Nrv(?:Miss|Dead)/.test(`${s.timing?.scene ?? ""} ${s.timing?.playerNerve ?? ""} ${player(s)?.nerve ?? ""}`)
  ? "Native Mario entered Miss/Dead" : undefined;
const cascadeSetup = "Prepared source prerequisites: chest 216, Chomp rocks 206, 2D 212, and the reference map's Island in the Sky/Waterfall Basin flags. Native GameDataFile must verify 3 -> 4 -> 5 moons, the restored Odyssey and world selection.";

export function capCheckpoints(frames: number): ReplayCheckpoint[] {
  return [
    { label: "Start waking Mario on the recorded B", from: 1380, through: 1385,
      accept: s => /NrvStandUpE/.test(opening(s)?.nerve ?? "") },
    { label: "Finish wake-up before the first jump", from: 1381, through: 1621,
      accept: s => opening(s)?.alive === false && nativeGameplayReady(s) },
    { label: "Perform the first recorded jump", from: 1621, through: 1648,
      accept: s => (s.route?.player?.velocity[1] ?? 0) > 5 && /NrvJumpE/.test(player(s)?.nerve ?? "") },
    { label: "Finish the recorded Cappy chase", from: 1400, through: 3000,
      accept: s => s.route?.actors.some(actor => actor.type === "OpeningStageStartCapManHero" && !actor.alive) === true },
    { label: "Cross the bridge to the far platform", from: 3150, through: 3420, reject: nativeDeath,
      accept: s => s.route?.stage === "CapWorldTowerStage" || (s.route?.stage === "CapWorldHomeStage" &&
        (s.timing?.position?.[0] ?? -Infinity) > 2000 && y(s) > 500 && (s.timing?.position?.[2] ?? Infinity) < -1200) },
    { label: "Enter Top-Hat Tower", from: 3150, through: 3500, reject: nativeDeath,
      accept: s => s.route?.stage === "CapWorldTowerStage" && nativeGameplayReady(s) },
    { label: "Perform the first frogless interior jump", from: 3468, through: 3495, reject: nativeDeath,
      accept: s => s.route?.stage === "CapWorldTowerStage" && (s.route?.player?.velocity[1] ?? 0) > 5 &&
        /NrvJumpE/.test(player(s)?.nerve ?? "") && !/NrvHackE/.test(player(s)?.nerve ?? "") },
    { label: "Climb inside the tower as Mario and Cappy", from: 3500, through: 5000,
      accept: s => s.route?.stage === "CapWorldTowerStage" && nativeGameplayReady(s) && y(s) > 1200 && !/NrvHackE/.test(player(s)?.nerve ?? "") },
    { label: "Reach the upper tower exit", from: 2500, through: 5500,
      accept: s => s.route?.stage === "CapWorldHomeStage" && y(s) > 4800 && nativeGameplayReady(s) },
    { label: "Complete Cap and load Cascade", from: 4000, through: frames + 1, allowAfterReplay: true,
      accept: s => s.route?.stage === "WaterfallWorldHomeStage" },
  ];
}

export function lunaCheckpoints(options: LunaReplayOptions, tape: Tape) {
  const plans: ReplayCheckpoint[] = [{ label: "Apply both original source controllers together", from: 1, through: 20,
    accept: s => Boolean(replay(s)?.separatePlay && replay(s)?.controllers.length === 2 &&
      replay(s)?.controllers.every(controller => controller.port >= 0) && replay(s)!.frame > 0) }];
  if (options.scenario === "cap") plans.push(...capCheckpoints(tape.frames));
  else plans.push(...cascadeCheckpoints(tape.frames));
  if (options.through !== undefined) {
    // Keep all fully elapsed gates. A partial attempt never moves a deadline or
    // turns an unfinished gate into a pass. The full original binary is queued.
    const elapsed = plans.filter(plan => plan.through <= options.through! + 1);
    return [...elapsed, { label: `Diagnostic only / observe source frame ${options.through}`, from: options.through + 1,
      through: tape.frames + 1, allowAfterReplay: true,
      accept: (s: NativeState) => (replay(s)?.frame ?? 0) >= options.through! + 1 }];
  }
  return [...plans, { label: "Complete all original source frames", from: tape.frames, through: tape.frames + 1, allowAfterReplay: true,
    accept: (s: NativeState) => replay(s)?.phase === "completed" && replay(s)?.frame === tape.frames }];
}

async function sha256(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function inspectSeed(path: string) {
  const seed = resolve(path), base = join(root, "tmp/odyssey/checkpoints");
  if (!seed.startsWith(base + "/")) throw new Error("Cascade --save must name a seed below tmp/odyssey/checkpoints/");
  await validateTestPath(seed);
  if (!(await lstat(seed)).isDirectory()) throw new Error("Cascade --save must be a directory");
  const files: { path: string; bytes: number; sha256: string }[] = [];
  const walk = async (path: string) => {
    const info = await lstat(path);
    if (info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1)))
      throw new Error(`Checkpoint seeds cannot contain links or special files: ${path}`);
    if (info.isDirectory()) for (const name of (await readdir(path)).sort()) await walk(join(path, name));
    else files.push({ path: relative(seed, path), bytes: info.size, sha256: await sha256(path) });
  };
  await walk(seed);
  if (!files.length) throw new Error("Cascade requires a nonempty private checkpoint seed");
  return { directory: seed, files, priorMoons: { required: 3, status: "unknown", ids: null, flags: null } };
}

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
/** Resolve task-relative paths at launch, regardless of the wrapper's depth. */
export function launchLunaWrapper(path: string, host: string, language: string, positionPolicy: "source" | "verify" = "source", continuous = false) {
  const hostRelative = relative(root, host);
  const hostExpression = !isAbsolute(hostRelative) && hostRelative !== ".." && !hostRelative.startsWith("../")
    ? '"$root"/' + quote(hostRelative) : quote(host);
  return ["#!/bin/bash", "set -euo pipefail",
    '[[ "${GAME_INSTANCE_ROLE:-}" == tests && "${DM_INSTANCE_LABEL:-}" == Tests && "${DM_AUTOMATED_INPUT:-}" == 1 ]] || { echo "LunaKit replay requires isolated Tests" >&2; exit 2; }',
    'root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")"/' + quote(relative(dirname(path), root)) + ' && pwd -P)"',
    'for name in DM_RUN_DIRECTORY DM_SAVE DM_TEMP DM_NATIVE_OPTIONS DM_NATIVE_SOCKET; do',
    '  value="${!name:?Missing private test path}"',
    '  case "$value" in',
    '    "$root/tmp/odyssey/runtime/"*|"$root/tmp/odyssey/game-temp"|"$root/tmp/odyssey/game-temp/"*|"$root/tmp/odyssey/native.sock"|"$root/tmp/odyssey/player-"*) exit 2 ;;',
    '    "$root/tmp/odyssey/"*) ;;',
    '    *) echo "LunaKit replay refuses non-test paths" >&2; exit 2 ;;',
    '  esac',
    'done',
    "export DM_SMO_LUNAKIT=1 DM_TEST_NPAD_STYLE=joy-dual DM_WINDOW=1 DM_WINDOW_DISPLAY=3 DM_AUDIO=1",
    "export DM_LANG=" + quote(language),
    continuous ? "export DM_SMO_LUNAKIT_CONTINUOUS=1" : "unset DM_SMO_LUNAKIT_CONTINUOUS",
    positionPolicy === "verify" ? "export DM_SMO_LUNAKIT_POSITION=verify" : "unset DM_SMO_LUNAKIT_POSITION",
    "unset DM_SMO_TAS_MOTION DM_SMO_LUNAKIT_DIAGNOSTICS DM_NATIVE_SAVESTATES DM_KEYS DM_CTL DM_CTL_POLL_MS DM_FULLSCREEN DM_METAL_HUD DM_NVN_STREAM_PRESENTED",
    'cache="$root/game-data/super-mario-odyssey/run/pso_user.tsv"',
    'if [[ -f "$cache" ]]; then cp -- "$cache" "$DM_RUN_DIRECTORY/pso_user.tsv"; fi',
    "printf 'render_fps=0\\nshow_fps=1\\n' > \"$DM_NATIVE_OPTIONS\"",
    "exec " + hostExpression + ' "$@"', ""].join("\n");
}

/** One fixture owns lifecycle, native audio and compressed video, including failures. */
export async function runLunaReplay(options: LunaReplayOptions) {
  const instance = gameInstance();
  if (instance.role !== "tests") throw new Error("LunaKit replay is Tests-only; Player control is forbidden");
  await validateTestPath(instance.runtimeDirectory); await validateTestPath(instance.socketPath);
  if (options.scenario === "cascade" && !options.save) throw new Error("Cascade requires an explicit --save checkpoint seed");
  if (options.scenario === "cap" && options.save) throw new Error("Cap requires a fresh save; --save is forbidden");
  if (options.scenario === "cap" && !["en-US", "zh-TW"].includes(options.language))
    throw new Error("Fresh Cap preferences support --language en-US or zh-TW");
  const cameraSpeed = options.cameraSpeed ?? 2;
  const source = resolve(options.tape), host = await realpath(resolve(options.host));
  if (!(await lstat(host)).isFile()) throw new Error("--host must be an executable native host file");
  await access(host, constants.X_OK);
  if (/[\r\n\0]/.test(host)) throw new Error("The native host path cannot contain line breaks");
  const tape = await readLunaTape(source);
  if (options.scenario === "cap" && tape.frames !== 7055)
    throw new Error(`Cap checkpoint windows require the complete 7055-frame source tape; received ${tape.frames} frames`);
  if (options.scenario === "cascade" && tape.frames !== 5327) throw new Error("Cascade checkpoints require the complete 5327-frame original tape");
  if (options.through !== undefined && (!Number.isSafeInteger(options.through) || options.through < 0 || options.through >= tape.frames - 1))
    throw new Error(`--through must be between 0 and ${tape.frames - 2}`);
  const seed = options.save ? await inspectSeed(options.save) : null;
  const hostHash = await sha256(host), plans = lunaCheckpoints(options, tape);
  const diagnostic = options.through !== undefined;
  if (options.continuous && (options.scenario !== "cap" || diagnostic))
    throw new Error("The continuous ownership diagnostic requires the complete fresh Cap scenario");
  const startLabel = options.scenario === "cap" ? "Start a fresh isolated game" : "Start from the supplied private Cascade seed";
  const bootstrapLabel = options.scenario === "cap" ? "Match the fresh source Start menu before frame zero" : "Verify playable Waterfall before frame zero";
  const welcomeLabel = "After the tape / dismiss Cascade welcome and verify play";
  const test = await createGameTest(`lunakit-${options.scenario}${diagnostic ? "-diagnostic" : ""}`, {
    title: `${options.continuous ? "Continuous controller handoff" : diagnostic ? "Partial diagnostic" : "Compatibility attempt"} / original ${options.scenario === "cap" ? "Cap" : "Cascade"} 2P inputs`,
    description: (options.continuous ? "Session diagnostic: keep live 2P through Cap completion, queue a separate generated one-frame neutral probe, then explicitly restore the original controller mode. This does not play the missing Cascade route. " : "") + "Unchanged original buttons, float32 sticks, both motion sensors and native scene-frame clock. " +
      `Language ${options.language}; paired Joy-Con; ${options.scenario === "cap" ? `camera speed ${cameraSpeed}; ` : ""}uncapped native rendering and game audio. ` +
      (diagnostic ? `Stops at the first observed receipt at/after source frame ${options.through}; no kingdom completion claim. ` : "") +
      (options.scenario === "cascade" ? cascadeSetup : "Native checkpoints must pass. After all original frames, a separate GUI step acknowledges the next kingdom's welcome dialogue; no route correction or frog capture is substituted."),
    actions: [startLabel, bootstrapLabel, ...plans.map(plan => plan.label), ...(!diagnostic && options.scenario === "cap" ? [welcomeLabel] : []), ...(options.continuous ? handoffActions : [])],
  });
  const { game, page, viewer, artifacts } = test;
  console.log(`ARTIFACTS=${artifacts}`);
  const json = (name: string, data: unknown) => writeFile(join(artifacts, name), JSON.stringify(data, null, 2) + "\n");
  let failure: unknown, nativeChecksPassed = false;
  let segment: Awaited<ReturnType<typeof runLunaSegment>> | undefined;
  let launched: Awaited<ReturnType<typeof game.status>> | undefined;
  try {
    const original = join(artifacts, "original.bin"), wrapper = join(artifacts, "launch.command");
    let launchSeed = seed?.directory;
    if (options.scenario === "cap") {
      // A preferences-only seed: the game creates a completely new File1.bin.
      // No Player checkpoint or earlier experiment's Common.bin is copied.
      launchSeed = join(root, "tmp/odyssey/checkpoints", `cap-camera-${randomUUID()}`);
      await mkdir(launchSeed, { recursive: true });
      const locale = options.language === "zh-TW" ? "TWzh" : "USen";
      const preferences = capCameraPreferences(cameraSpeed, locale);
      await writeFile(join(launchSeed, "Common.bin"), preferences);
      await writeFile(join(artifacts, "initial-common.bin"), preferences);
      await json("initial-preferences.json", { cameraStickSensitivityLevel: cameraSpeed, generated: true, gameplaySave: false,
        language: locale, directory: launchSeed, sha256: createHash("sha256").update(preferences).digest("hex") });
    }
    await writeFile(original, tape.bytes);
    if (await sha256(original) !== tape.sha256) throw new Error("Artifact copy does not match the original tape hash");
    await writeFile(wrapper, launchLunaWrapper(wrapper, host, options.language, options.continuous ? "verify" : "source", options.continuous), { mode: 0o755 });
    const cache = join(root, "game-data/super-mario-odyssey/run/pso_user.tsv");
    await json("source.json", { original: source, artifact: original, sha256: tape.sha256, frames: tape.frames, records: tape.records,
      scenario: options.scenario, language: options.language, cameraSpeed: options.scenario === "cap" ? cameraSpeed : null, through: options.through ?? null, diagnostic,
      nativeHost: { path: host, sha256: hostHash }, instance, seed,
      canonicalPSO: { path: cache, sha256: await sha256(cache).catch(error => { if (error.code === "ENOENT") return null; throw error; }), copyPolicy: "Copy into the private run at launch if present" },
      clock: "original native Scene::movement", bootstrap: "Before source frame zero only",
      changedButtons: false, changedSticks: false, changedMotion: false, changedDurations: false, steeringCorrections: false,
      positionMetadata: tape.position, positionPolicy: options.continuous ? "Native proximity check; no position setter" : "Applied only by the native source adapter, never by this runner", continuous: options.continuous ?? false,
      compatibility: "unverified until native checkpoints pass", cascadeSetup: options.scenario === "cascade" ? cascadeSetup : null });
    await test.step(startLabel, async () => {
      if (await sha256(host) !== hostHash) throw new Error("The supplied native host changed after provenance was captured");
      const status = await game.start({ headless: false, renderFPS: 0, saveDirectory: launchSeed, nativeHost: wrapper });
      launched = status;
      await json("launch-status.json", status);
      await page.until(async () => Boolean(((await page.state()) as LunaState).lunaScene?.type), 30000);
    });
    await test.step(bootstrapLabel, async () => {
      if (options.scenario === "cap") {
        // The source's own first A confirms Start. Do not confirm it here.
        await page.until(async () => {
          const scene = ((await page.state()) as LunaState).lunaScene;
          return /FirstSequenceScene/.test(scene?.type ?? "") && /SelectMode/.test(scene?.nerve ?? "");
        }, 30000);
      } else {
        await enterOpeningGameplay(page);
        const state = await page.state();
        if (state.route?.stage !== "WaterfallWorldHomeStage" || !nativeGameplayReady(state))
          throw new Error(`Cascade seed did not reach playable WaterfallWorldHomeStage: ${state.route?.stage}`);
        const data = verifyCascadePrerequisites(state);
        await json("cascade-prerequisites.json", { stage: state.route.stage, ready: true, seed, nativeGameData: data, verified: true });
      }
      await json("bootstrap-inputs.json", page.keyboard.receipts);
      await json("original-start.json", await page.state());
      await game.screenshot(join(artifacts, "original-start.png"));
      await installLunaHUD(viewer);
    });
    segment = await runLunaSegment(test, tape, plans, { directory: artifacts, through: options.through, continuous: options.continuous });
    nativeChecksPassed = !diagnostic;
    if (nativeChecksPassed && options.scenario === "cap") {
      await json("source-end-state.json", segment?.state ?? await page.state());
      await test.step(welcomeLabel, async () => {
        const firstReceipt = page.keyboard.receipts.length;
        await viewer.evaluate(() => {
          const clock = document.querySelector(".luna-clock");
          if (clock) clock.textContent = "All original frames completed / separate welcome-dialogue GUI step";
          document.querySelectorAll(".luna-pad").forEach(node => { node.textContent = "Original source finished / GUI acknowledgement only"; });
        });
        const waiting = (s: NativeState) => /StageSceneNrvDemoStageStartCapManHeroTalkE/.test(s.timing?.scene ?? "");
        const dialogueDeadline = performance.now() + 60000;
        for (;;) {
          await page.until(async () => { const s = await page.state(); return nativeGameplayReady(s) || waiting(s); }, 60000);
          const state = await page.state();
          if (nativeGameplayReady(state)) break;
          if (state.route?.stage !== "WaterfallWorldHomeStage" || performance.now() >= dialogueDeadline)
            throw new Error("Cascade welcome did not become playable after native dialogue acknowledgements");
          await page.keyboard.press("j"); // Native A; after every authored frame, with no movement input.
        }
        const state = await page.state();
        if (state.route?.stage !== "WaterfallWorldHomeStage" || !nativeGameplayReady(state)) throw new Error("Cascade is not playable after its welcome");
        await json("post-replay-gui-inputs.json", { separateFromSource: true, purpose: "Acknowledge next-kingdom welcome after Cap completion", receipts: page.keyboard.receipts.slice(firstReceipt) });
        await json("playable-cascade.json", state);
      });
    }
    if (options.continuous) await verifyContinuousHandoff(test, launched!);
    await json("native-result.json", segment?.state ?? await page.state());
    await game.release();
    await game.screenshot(join(artifacts, "final-native.png"));
  } catch (error) {
    failure = error;
    await game.release().catch(() => {});
    await json("failure-state.json", await page.state().catch(() => null)).catch(() => {});
    await game.screenshot(join(artifacts, "failure-native.png")).catch(() => {});
  } finally {
    // Each cleanup failure is retained; none can bypass fixture finalization.
    const preserve = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (error) { failure ??= error; console.error(error); } };
    await preserve(async () => { await test.finish(failure); });
    await preserve(() => json("replay-result.json", { scenario: options.scenario, diagnostic, through: options.through ?? null,
      status: failure !== undefined ? "failed" : diagnostic ? "diagnostic-only" : "native-checkpoints-passed",
      sourceCheckpointsPassed: nativeChecksPassed,
      capComplete: failure === undefined && nativeChecksPassed && options.scenario === "cap", cascadeComplete: failure === undefined && nativeChecksPassed && options.scenario === "cascade",
      compatibility: failure === undefined && nativeChecksPassed ? "native-checkpoints-passed" : "unverified",
      error: failure === undefined ? null : String(failure), cascadeSetup: options.scenario === "cascade" ? cascadeSetup : null,
      artifacts, video: join(artifacts, "playwright-recording-compressed.mp4") }));
  }
  if (failure !== undefined) throw failure;
  console.log(diagnostic ? "PARTIAL_DIAGNOSTIC_ONLY=true" : `${options.scenario.toUpperCase()}_NATIVE_CHECKPOINTS_PASSED=true`);
  return { artifacts, diagnostic };
}

import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createGameTest } from "./fixture.ts";
import { ensureBridge } from "./manager.ts";
import { importNxTas } from "./nx-tas.ts";
import type { NativeState } from "./protocol.ts";
import { ReplayObserver, type ReplayCheckpoint } from "./replay-observer.ts";

const root = resolve(import.meta.dir, "../..");
const originalPath = join(root, "tmp/odyssey/research/cap-archive/33.txt");
const original = await readFile(originalPath, "utf8");
const originalImport = importNxTas(original);
const demoExcerpt = process.argv.includes("--demo-excerpt");
const excerptText = original.trim().split(/\r?\n/).slice(0, 1204).join("\n") + "\n";
const imported = demoExcerpt ? importNxTas(excerptText) : originalImport;
const renderFPS = process.argv.includes("--60hz") ? 60 : 0;
const tasMotion = process.argv.includes("--legacy-motion") ? "legacy-2021" : undefined;
const traceEvery = process.argv.includes("--trace-every-frame") ? 1 : 30;
const player = (state: NativeState) => state.route?.actors.find(actor => actor.type === "PlayerActorHakoniwa");
const openingActor = (state: NativeState) => state.route?.actors.find(actor => actor.type === "OpeningStageStartDemo");
const cappy = (state: NativeState) => state.route?.actors.find(actor => actor.type === "OpeningStageStartCapManHero");
const isPlayer = (state: NativeState, nerve: RegExp) => nerve.test(player(state)?.nerve ?? "");
const damage = (state: NativeState) => isPlayer(state, /Nrv(?:Damage|DamageSwim|DamageFire|Dead)E/) ? "The native player entered damage/death before this recorded action completed" : undefined;
let checkpoints: ReplayCheckpoint[] = [
  { label: "Stand up on the recorded B press", from: 1, through: 30,
    accept: state => /NrvStandUpE/.test(openingActor(state)?.nerve ?? "") },
  { label: "Finish the wake-up animation", from: 235, through: 250,
    accept: state => openingActor(state)?.alive === false && !isPlayer(state, /NrvDemoE/) },
  { label: "Start the Cappy chase roll", from: 246, through: 280,
    accept: state => isPlayer(state, /NrvRollingE/), reject: damage },
  { label: "Reach Cappy's meeting cutscene", from: 790, through: 820,
    accept: state => /NrvEventTalkDemoE/.test(cappy(state)?.nerve ?? "") },
  { label: "Skip the Cappy cutscene", from: 834, through: 894,
    accept: state => cappy(state)?.alive === false && !isPlayer(state, /NrvDemoE/) },
  { label: "Approach the Bonneton jumps", from: 1095, through: 1101,
    accept: state => isPlayer(state, /Nrv(?:Rolling|Run)E/), reject: damage },
  { label: "Perform village jump one", from: 1101, through: 1111,
    accept: state => isPlayer(state, /NrvJumpE/) && (state.route?.player?.jump.step ?? 99) <= 8, reject: damage },
  { label: "Perform village jump two", from: 1135, through: 1146,
    accept: state => isPlayer(state, /NrvJumpE/) && state.route?.player?.continuousJump === 1 && state.route.player.jump.step <= 8, reject: damage },
  { label: "Perform the third jump", from: 1165, through: 1176,
    accept: state => isPlayer(state, /NrvJumpE/) && state.route?.player?.continuousJump === 2 && state.route.player.jump.step <= 8, reject: damage },
  { label: "Dive from the third jump", from: 1204, through: 1211,
    accept: state => isPlayer(state, /NrvHeadSlidingE/), reject: damage },
  { label: "Land the village dive", from: 1204, through: 1247,
    accept: state => (state.route?.replayFrame ?? 0) >= 1228 && isPlayer(state, /Nrv(?:Rolling|Run|Wait)E/),
    reject: state => damage(state) ? "Expected the village dive to reach a clean landing; the native player entered Damage at the ledge" : undefined },
  { label: "Activate the Cap switch", from: 1247, through: imported.frames,
    accept: state => state.route?.actors.some(actor => actor.type === "CapSwitch" && /NrvOnWaitE/.test(actor.nerve)) ?? false },
  { label: "Open the Top Hat Tower door", from: 1247, through: imported.frames,
    accept: state => state.route?.stage === "CapWorldTowerStage" || (state.route?.actors.some(actor => actor.type === "DoorAreaChange" && Math.hypot(actor.position[0]! - 4313.35205, actor.position[2]! + 3323.40161) < 10 && /NrvOpenWaitE/.test(actor.nerve)) ?? false) },
  { label: "Finish the unchanged recording in the tower", from: 1247, through: imported.frames + 1, allowAfterReplay: true,
    accept: state => state.replay?.active === false && state.replay.frame === imported.frames && state.route?.stage === "CapWorldTowerStage" && Boolean(player(state)) },
];
if (demoExcerpt) checkpoints = [...checkpoints.slice(0, 9), {
  label: "Complete the unchanged opening excerpt", from: imported.frames, through: imported.frames + 1, allowAfterReplay: true,
  accept: state => state.replay?.active === false && state.replay.frame === imported.frames && state.route?.stage === "CapWorldHomeStage" && !damage(state),
}];
await ensureBridge();
const test = await createGameTest(demoExcerpt ? "recorded-input-demo" : "original-tas", {
  title: demoExcerpt ? "Super Mario Odyssey / real recorded inputs" : `Original Cap TAS / unchanged inputs / ${renderFPS || "uncapped"} FPS`,
  description: demoExcerpt ? "Mars2030\u2019s Cap opening: original input frames 0-1203, unchanged buttons and sticks, native ARM64 gameplay and measured render FPS. 60 Hz input clock; source version 1.3, local dump 1.0.0. This is an opening excerpt."
    : "Run Mars2030's archived wake-up-to-tower script. Preserve every button, stick value and frame; check whether the native runtime reproduces tower entry. No route corrections or added motion.",
  actions: ["Load private fresh save", "Wait for the B prompt", ...checkpoints.map(checkpoint => checkpoint.label)],
});
const { game, page, artifacts } = test;
const trace = createWriteStream(join(artifacts, "native-state.jsonl"));
const sourceRows = excerptText.trim().split("\n");
const nativeRows = imported.native.trim().split("\n");
const buttonNames = ["A", "B", "X", "Y", "LSTICK", "RSTICK", "L", "R", "ZL", "ZR", "+", "-", "LEFT", "UP", "RIGHT", "DOWN"];
let decorating = false, lastDecoration = 0;
let fpsSample: { at: number; frame: number; ticks: number } | undefined;
const fpsSamples: { frame: number; seconds: number; renderFPS: number; logicHz: number }[] = [];
let lastLogged = -60;
let observer: ReplayObserver | undefined;
const recordState = (state: NativeState) => {
  const frame = state.route?.replayFrame ?? 0;
  if (demoExcerpt) {
    const now = performance.now(), ticks = state.timing?.logicTicks ?? 0;
    if (!fpsSample) fpsSample = { at: now, frame: state.frame, ticks };
    else if (now - fpsSample.at >= 1000) {
      const seconds = (now - fpsSample.at) / 1000;
      fpsSamples.push({ frame, seconds, renderFPS: (state.frame - fpsSample.frame) / seconds, logicHz: (ticks - fpsSample.ticks) / seconds });
      fpsSample = { at: now, frame: state.frame, ticks };
    }
    if (!decorating && now - lastDecoration >= 75) {
      lastDecoration = now; decorating = true;
      const index = Math.min(nativeRows.length - 1, Math.max(0, frame - 1));
      const row = nativeRows[index]!.split(" "), mask = BigInt("0x" + row[1]);
      const keys = buttonNames.filter((_, i) => Boolean(mask & (1n << BigInt(i))));
      void test.viewer.evaluate(data => {
        window.dispatchEvent(new CustomEvent("native-keys", { detail: data.keys }));
        const label = document.querySelector(".ar-key-label"); if (label) label.textContent = "PAD";
        const line = document.querySelector("#archived-input-row"); if (line) line.textContent = data.line;
      }, { keys, line: sourceRows[index]! }).catch(() => {}).finally(() => { decorating = false; });
    }
  }
  if (frame - lastLogged < traceEvery) return;
  lastLogged = frame;
  trace.write(JSON.stringify(state) + "\n");
};
const opening = async () => (await page.state()).route?.actors.find(actor => actor.type === "OpeningStageStartDemo");
let failure: unknown;
try {
  await test.step("Load private fresh save", async () => {
    await game.stop();
    const save = join(root, "tmp/odyssey/checkpoints", basename(artifacts));
    await mkdir(save, { recursive: false });
    let nativeHost: string | undefined;
    if (demoExcerpt) {
      const dir = join(root, "tmp/odyssey/recorded-demo"); await mkdir(dir, { recursive: true });
      nativeHost = join(dir, "launch.command");
      await writeFile(nativeHost, '#!/bin/bash\nset -euo pipefail\n[[ "${DM_INSTANCE_LABEL:-}" == Tests ]] || exit 2\nroot="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd -P)"\nexport DM_WINDOW=1 DM_WINDOW_DISPLAY=3 DM_AUDIO=1\nunset DM_FULLSCREEN DM_METAL_HUD DM_NVN_STREAM_PRESENTED\nif [[ -f "$root/game-data/super-mario-odyssey/run/pso_user.tsv" ]]; then cp "$root/game-data/super-mario-odyssey/run/pso_user.tsv" "$DM_RUN_DIRECTORY/pso_user.tsv"; fi\nprintf \'render_fps=0\\nshow_fps=1\\n\' > "$DM_NATIVE_OPTIONS"\nexec "$root/game-data/super-mario-odyssey/tools/dmhost" "$@"\n', { mode: 0o755 });
      await test.viewer.evaluate(() => {
        const line = document.createElement("div"); line.id = "archived-input-row";
        line.style.cssText = "font: 15px ui-monospace,monospace;color:#b7edff;white-space:nowrap";
        line.textContent = "Original input row: frame / buttons / left stick / right stick";
        document.querySelector(".ar-hud")?.append(line);
      });
    }
    await game.start({ headless: process.argv.includes("--headless"), renderFPS, saveDirectory: save, tasMotion, nativeHost });
    const deadline = performance.now() + 60000;
    while (performance.now() < deadline) {
      const state = await page.state();
      if (state.timing?.position) break;
      if (!state.timing?.scene || /DemoSceneNrvPlay|SkipDemo/.test(state.timing.scene)) await page.keyboard.press("Enter");
      await page.keyboard.press("j");
      await game.transport.wait(state.generation);
    }
    await page.until(async () => {
      const state = await page.state();
      return Boolean(state.timing?.position && state.route?.stage === "CapWorldHomeStage");
    }, 30000);
    assert.equal((await page.state()).route?.stage, "CapWorldHomeStage");
  });
  await test.step("Wait for the B prompt", async () => {
    if (!/NrvWaitStandUpE/.test((await opening())?.nerve ?? "")) {
      await page.until(async () => /NrvCameraTutorial/.test((await opening())?.nerve ?? ""), 30000);
      await page.keyboard.down("ArrowUp");
      try { await page.until(async () => /NrvWaitStandUpE/.test((await opening())?.nerve ?? ""), 30000); }
      finally { await page.keyboard.up("ArrowUp"); }
    }
    await game.waitForInput();
    // Base-build exeWaitStandUp rejects B/A while isLessEqualStep(45).
    // Wait for native actionability before frame zero, without editing the TAS.
    await page.until(async () => {
      const actor = await opening();
      return Boolean(actor && /NrvWaitStandUpE/.test(actor.nerve) && actor.step > 45);
    }, 10000);
    await writeFile(join(artifacts, "initial-state.json"), JSON.stringify(await page.state(), null, 2) + "\n");
    await game.screenshot(join(artifacts, "original-start.png"));
  });
  {
    const path = join(artifacts, "original-native.inputs");
    await writeFile(path, imported.native);
    await writeFile(join(artifacts, "original-script.txt"), original);
    await writeFile(join(artifacts, "source.json"), JSON.stringify({
      url: "https://github.com/MonsterDruide1/smo-tas-archive/blob/main/public/scripts/33.txt",
      author: "Mars2030", setup: "Start at B press prompt", sourceVersion: "1.3", localVersion: "1.0.0",
      frames: imported.frames, sha256: originalImport.sha256, source: originalPath,
      originalFrames: originalImport.frames, excerpt: demoExcerpt ? { from: 0, through: 1203, sha256: imported.sha256 } : null,
      renderFPS,
      controllerEnvironment: tasMotion ?? "stock",
      motionMappingSource: tasMotion ? "https://github.com/fruityloops1/smo-practice/blob/dfd0007c72352f23bbafce5891a49739f5721857/source/main.cpp" : null,
      motionMappingProvenance: tasMotion ? "Published oldMotion compatibility branch; exact original recording mod build is unknown" : null,
      changedButtons: false, changedSticks: false, changedDurations: false, addedMotion: false, steeringCorrections: false,
    }, null, 2) + "\n");
    observer = new ReplayObserver(checkpoints, imported.frames, recordState);
    await observer.start();
    await game.replay(path);
    for (const checkpoint of checkpoints) await test.step(checkpoint.label, () => observer!.expect(checkpoint.label));
  }
  await writeFile(join(artifacts, "native-result.json"), JSON.stringify(await page.state(), null, 2) + "\n");
  await game.screenshot(join(artifacts, "final-native.png"));
} catch (error) {
  failure = error;
  await game.release().catch(() => {});
  if (observer?.firstFailure) await writeFile(join(artifacts, "first-failure-state.json"), JSON.stringify(observer.firstFailure, null, 2) + "\n");
  await writeFile(join(artifacts, "failure-state.json"), JSON.stringify(await page.state().catch(() => null), null, 2) + "\n");
  await game.screenshot(join(artifacts, "failure-native.png")).catch(() => {});
  throw error;
} finally {
  await observer?.stop();
  await writeFile(join(artifacts, "checkpoint-results.json"), JSON.stringify(observer?.report() ?? { started: false }, null, 2) + "\n");
  if (demoExcerpt) await writeFile(join(artifacts, "render-measurements.json"), JSON.stringify({ samples: fpsSamples, peakOneSecondRenderFPS: Math.max(0, ...fpsSamples.map(s => s.renderFPS)), sourceFrames: imported.frames, inputClockHz: 60, videoFPS: 60 }, null, 2) + "\n");
  await new Promise<void>(resolve => trace.end(resolve));
  await test.finish(failure);
}

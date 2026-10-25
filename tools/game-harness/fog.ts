import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { NativeState } from "./protocol.ts";
import { enterOpeningGameplay } from "./opening.ts";

const root = resolve(import.meta.dir, "../..");
const moon = process.argv.includes("--moon");
const { ensureBridge } = await import("./manager.ts");
const { createGameTest } = await import("./fixture.ts");
const instance = await ensureBridge();
const observation = moon ? "Observe moon lighting" : "Observe opening foot fog";
const test = await createGameTest(moon ? "moon-lighting" : "fog-history", {
  title: moon ? "Moon lighting / uncapped renderer" : "Opening foot fog / uncapped renderer",
  description: moon
    ? "View the bright yellow moon, pan away and back, and retain native frames. Verify exposure and fog history on every extra render while simulation stays at 60 Hz."
    : "Observe the opening fog at Mario's feet. Verify one GPU preparation per render, rendered-image history, and a steady 60 Hz simulation.",
  actions: ["Start isolated native host", "Start opening gameplay", ...(moon ? ["Look at the bright moon"] : []), observation,
    ...(moon ? ["Pan away and return to the moon"] : []), "Check render history and simulation"],
  fps: 120,
});
const saveJSON = (name: string, value: unknown) => writeFile(join(test.artifacts, name), JSON.stringify(value, null, 2));
const camera = (state: NativeState) => {
  const eye = state.route?.cameraEye, target = state.route?.cameraTarget;
  assert(eye?.length === 3 && target?.length === 3, "Need the native camera eye and target");
  return { pitch: (target[1]! - eye[1]!) / Math.hypot(target[0]! - eye[0]!, target[2]! - eye[2]!),
    forward: state.route!.cameraForward! };
};
async function captureFrames(prefix: string) {
  await test.game.screenshot(join(test.artifacts, `${prefix}-native.png`));
  let last = 0n;
  const records = [];
  const deadline = performance.now() + 10000;
  while (records.length < 36 && performance.now() < deadline) {
    const packet = await readFile(join(instance.runtimeDirectory, "preview.frame"));
    const frame = packet.readBigUInt64LE(0);
    if (frame !== last) {
      last = frame;
      await writeFile(join(test.artifacts, `${prefix}-${String(records.length).padStart(3, "0")}.jpg`), packet.subarray(16));
      records.push({ frame: String(frame), state: await test.page.state() });
    }
    await Bun.sleep(4);
  }
  await saveJSON(`${prefix}-frame-states.json`, records);
  assert.equal(records.length, 36, "Need 36 fresh native render frames");
}
let failure: unknown;
let before: NativeState, after: NativeState, seconds = 0;
try {
  await test.step("Start isolated native host", async () => {
    const save = join(root, "tmp/odyssey/checkpoints", basename(test.artifacts));
    await mkdir(save, { recursive: true });
    await test.game.start({ headless: true, renderFPS: 0, saveDirectory: save });
  });
  await test.step("Start opening gameplay", () => enterOpeningGameplay(test.page));
  if (moon) await test.step("Look at the bright moon", async () => {
    await saveJSON("camera-before.json", await test.page.state());
    await test.page.keyboard.down("ArrowUp");
    try { await test.page.until(async () => camera(await test.page.state()).pitch > 0.35, 8000); }
    finally { await test.page.keyboard.up("ArrowUp"); }
    await saveJSON("camera-moon.json", await test.page.state());
  });
  await test.step(observation, async () => {
    before = await test.page.state();
    const start = performance.now();
    if (moon) await Bun.sleep(3500);
    else {
      await test.page.keyboard.down("w");
      try { await Bun.sleep(750); } finally { await test.page.keyboard.up("w"); }
      await Bun.sleep(2750);
    }
    seconds = (performance.now() - start) / 1000;
    after = await test.page.state();
    await captureFrames(moon ? "moon" : "fog");
  });
  if (moon) await test.step("Pan away and return to the moon", async () => {
    const forward = camera(await test.page.state()).forward;
    const alignment = async () => {
      const current = camera(await test.page.state()).forward;
      return forward[0]! * current[0]! + forward[2]! * current[2]!;
    };
    await test.page.keyboard.down("ArrowRight");
    try { await test.page.until(async () => await alignment() < 0.5, 10000); }
    finally { await test.page.keyboard.up("ArrowRight"); }
    await test.page.keyboard.down("ArrowLeft");
    try { await test.page.until(async () => await alignment() > 0.998, 10000); }
    finally { await test.page.keyboard.up("ArrowLeft"); }
    await captureFrames("moon-return");
  });
  await test.step("Check render history and simulation", async () => {
    assert(before.timing && after.timing, "Need native timing");
    const ticks = after.timing.logicTicks - before.timing.logicTicks;
    const extra = after.timing.drawsWithoutTick - before.timing.drawsWithoutTick;
    const history = (after.timing.historyExtraUpdates ?? 0) - (before.timing.historyExtraUpdates ?? 0);
    assert(before.timing.graphicsPreparation && after.timing.graphicsPreparation, "Need native preparation counters");
    const preparations = after.timing.graphicsPreparation.renders - before.timing.graphicsPreparation.renders;
    const deferred = after.timing.graphicsPreparation.deferred - before.timing.graphicsPreparation.deferred;
    const exposure = (after.timing.exposureExtraUpdates ?? 0) - (before.timing.exposureExtraUpdates ?? 0);
    const result = { seconds, logicHz: ticks / seconds, ticks, extra, history, preparations, deferred, exposure, stage: after.route?.stage };
    await saveJSON("render-report.json", result);
    assert(result.logicHz > 55 && result.logicHz < 65, JSON.stringify(result));
    assert(extra > ticks, "Need actual extra render frames");
    assert(Math.abs(history - extra) <= 1, "Every extra render must rotate its image history once");
    if (moon) assert(Math.abs(exposure - extra) <= 1, "Every extra render must rotate its exposure history once");
    assert(Math.abs(preparations - extra - deferred) <= 3, "Stateful GPU preparation must run once per render");
    assert(Math.abs(deferred - ticks) <= 3, "Original tick preparation must be deferred exactly once");
  });
} catch (error) {
  failure = error;
  await saveJSON("failure-state.json", await test.page.state()).catch(() => {});
  await test.game.screenshot(join(test.artifacts, "failure-native.png")).catch(() => {});
  throw error;
} finally {
  await test.finish(failure);
}

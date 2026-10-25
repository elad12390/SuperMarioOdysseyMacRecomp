import assert from "node:assert/strict";
import { copyFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createGameTest } from "./fixture.ts";
import { ensureBridge } from "./manager.ts";
import type { NativeState } from "./protocol.ts";
import { enterOpeningGameplay } from "./opening.ts";

const root = resolve(import.meta.dir, "../..");
const baseURL = process.env.GAME_HARNESS_URL || "http://127.0.0.1:4318";
const controlsOnly = process.argv.includes("--controls-only");
const saveDirectory = process.argv.find(arg => arg.startsWith("--save-directory="))?.slice("--save-directory=".length);
const actions = ["Start native game", "Load Cap Kingdom", "Set camera", "Walk forward", "Jump", "Land",
  "60 FPS baseline", "120 FPS in Options", "Check 120 FPS motion", "Uncap in Options", "Check uncapped motion", "Finish"]
  .filter((_, i) => !controlsOnly || i < 6 || i === 11);


await ensureBridge();
const test = await createGameTest(controlsOnly ? "odyssey-controls" : "odyssey-demo", { title: "Super Mario Odyssey / native ARM64", actions,
  description: controlsOnly ? "Load Cap Kingdom, verify the real camera and player, then prove walking, jumping, and landing through Playwright keyboard input."
    : "Load Cap Kingdom and prove walking, jumping, and landing. Change 60 FPS, 120 FPS, and Uncapped through Odyssey's own Options menu, then verify rendering speed and a steady 60 Hz game clock.",
  fps: process.argv.includes("--120-video") ? 120 : 60 });
const { page, viewer, game, artifacts } = test;
const measurements: object[] = [];
async function state() {
  const status = await game.status();
  assert(status.running && status.native?.timing, status.error || "The native game/frame-clock adapter is unavailable");
  return status.native;
}
async function until(label: string, predicate: (s: NativeState) => boolean, timeout = 45000) {
  let result: NativeState | undefined;
  try {
    await page.until(async () => { result = await state(); return predicate(result); }, timeout);
  } catch (cause) { throw new Error(`Timed out: ${label}`, { cause }); }
  return result!;
}
async function key(value: string) {
  await page.keyboard.press(value);
}
async function rendererLimit(fps: number) {
  await key("Enter");
  await page.getByRole("option", { name: "Options", exact: true }).click();
  await page.getByRole("option", { name: "Graphics", exact: true }).click();
  const limit = page.getByText("Renderer limit", { exact: true });
  await limit.waitFor();
  const value = fps ? String(fps) + " FPS" : "Uncapped";
  await limit.selectOption(value);
  await page.getByText(value, { exact: true }).waitFor();
  assert.equal((await state()).timing!.renderFPS, fps, "The native Renderer limit did not apply");
  await game.screenshot(join(artifacts, "options-" + (fps || "uncapped") + ".png"));
  await limit.press("Escape");
  await page.getByRole("option", { name: "Graphics", exact: true }).waitFor();
  await page.getByRole("option", { name: "Graphics", exact: true }).press("Escape");
  await page.getByRole("option", { name: "Options", exact: true }).waitFor();
  await page.getByRole("option", { name: "Options", exact: true }).press("Escape");
  await until("return to gameplay", s => /StageSceneNrvPlay/.test(s.timing!.scene) && s.timing!.effectiveRenderFPS === fps);
}
async function measure(label: string, target: number) {
  await until("rendering is in normal gameplay", s => /StageSceneNrvPlay/.test(s.timing!.scene) && s.timing!.sceneStep >= 6);
  const first = await state(), start = performance.now();
  await page.keyboard.down("ArrowRight"); await game.waitForInput(); await page.waitForTimeout(5000);
  await page.keyboard.up("ArrowRight"); await game.waitForInput();
  const last = await state(), seconds = (performance.now() - start) / 1000;
  const result = { label, seconds, renderFPS: (last.frame - first.frame) / seconds,
    logicHz: (last.timing!.logicTicks - first.timing!.logicTicks) / seconds,
    sceneHz: (last.timing!.sceneStep - first.timing!.sceneStep) / seconds,
    drawablePresentFPS: (last.timing!.display.presents - first.timing!.display.presents) / seconds,
    displayMaxHz: last.timing!.display.maxHz,
    interpolatedRenders: last.timing!.interpolation.applies - first.timing!.interpolation.applies,
    modelInterpolations: last.timing!.interpolation.modelWrites - first.timing!.interpolation.modelWrites };
  measurements.push(result); console.log(JSON.stringify(result));
  assert(Math.abs(result.logicHz - 60) < 1 && Math.abs(result.sceneHz - 60) < 1, "Actual game counters changed speed with the renderer");
  assert(target ? result.renderFPS >= target * .85 && result.renderFPS <= target * 1.15 : result.renderFPS > 120,
    "Rendering did not meet the selected target");
  assert(result.interpolatedRenders > 0, "The renderer did not interpolate camera motion between simulation ticks");
  assert.equal(last.timing!.interpolation.restoreMismatches, 0, "A temporary render pose was not restored");
}

let failure: unknown;
try {
  await test.step(actions[0]!, async () => {
    await game.start({ headless: !process.argv.includes("--window"), renderFPS: 0, profile: process.argv.includes("--profile"), saveDirectory });
    await viewer.waitForFunction(() => Boolean(document.querySelector<HTMLElement>("#game-frame")?.dataset.frame), undefined, { timeout: 15000 });
  });
  await test.step(actions[1]!, async () => {
    await enterOpeningGameplay(page);
  });
  await test.step(actions[2]!, async () => {
    await key("q");
    await until("normal gameplay", s => /StageSceneNrvPlay/.test(s.timing!.scene));
    await until("player is grounded", s => !/Jump|Fall|Damage/.test(s.timing!.playerNerve));
  });
  await test.step(actions[3]!, async () => {
    const before = (await state()).timing!.position!;
    await page.keyboard.down("w"); await game.waitForInput(); await page.waitForTimeout(1500);
    await game.screenshot(join(artifacts, "walking.png"));
    await page.keyboard.up("w"); await game.waitForInput();
    const after = (await state()).timing!.position!;
    assert(Math.hypot(...after.map((v, i) => v - before[i]!)) > 50, "The real player did not move");
  });
  const ground = (await state()).timing!.position![1]!;
  await test.step(actions[4]!, async () => {
    await page.keyboard.down("k"); await game.waitForInput(); await page.waitForTimeout(220);
    assert((await state()).timing!.position![1]! > ground + 10, "The real player did not jump");
    await game.screenshot(join(artifacts, "jumping.png")); await page.keyboard.up("k"); await game.waitForInput();
  });
  await test.step(actions[5]!, async () => {
    await page.waitForTimeout(1400);
    assert(!/Jump|Fall|Damage/.test((await state()).timing!.playerNerve), "The real player did not land");
    await game.screenshot(join(artifacts, "landed.png"));
  });
  if (!controlsOnly) {
    await test.step(actions[6]!, async () => {
    await rendererLimit(60); await key("q");
    await game.screenshot(join(artifacts, "baseline-60.png"));
  });
  await test.step(actions[7]!, async () => {
    await rendererLimit(120); await key("q");
    await game.screenshot(join(artifacts, "baseline-120.png"));
  });
  await test.step(actions[8]!, () => measure("120 FPS", 120));
  await test.step(actions[9]!, () => rendererLimit(0));
    await test.step(actions[10]!, () => measure("Uncapped", 0));
  }
  await test.step(actions.at(-1)!, async () => {
    await game.release(); await key("q");
    await game.screenshot(join(artifacts, "final-native.png"));
    await writeFile(join(artifacts, "demo-report.json"), JSON.stringify({ checkedAt: new Date().toISOString(), measurements, inputReceipts: page.keyboard.receipts, native: await state() }, null, 2) + "\n");
  });
} catch (error) {
  failure = error;
  await writeFile(join(artifacts, "failure-native-action.json"), JSON.stringify(page.lastState, null, 2) + "\n");
  await writeFile(join(artifacts, "failure-state.json"), JSON.stringify(await game.status().catch(() => null), null, 2) + "\n");
  await game.screenshot(join(artifacts, "failure-native.png")).catch(() => {});
  throw error;
}
finally {
  try { await test.finish(failure); }
  finally {
    if (process.argv.includes("--profile")) {
      await fetch(new URL("/api/stop", baseURL), { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const work = join(root, "tmp/odyssey/runtime");
      for (const name of ["game.log", "frame-times.tsv", "frame-times.tsv.interpolation.tsv"])
        await copyFile(join(work, name), join(artifacts, name));
    }
  }
}

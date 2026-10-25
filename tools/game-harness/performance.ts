import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createGameTest } from "./fixture.ts";
import { enterOpeningGameplay } from "./opening.ts";

type DeliveredFrame = { time: number; frame: number; latency: number };
declare global { interface Window { deliveredFrames: DeliveredFrame[]; } }

const actions = ["Start isolated gameplay", "Pan camera and measure"];
const test = await createGameTest("frame-rate", { title: "Odyssey / frame delivery test", actions,
  description: "Pan the native game's camera for ten seconds. Compare rendered frames, frames delivered to the browser, frame gaps, and capture delay.",
  fps: process.argv.includes("--120-video") ? 120 : 60 });
const { page, viewer, game, artifacts } = test;
let failure: unknown;
try {
  await test.step(actions[0]!, async () => {
  await game.start({ headless: true, renderFPS: 0 });
  await enterOpeningGameplay(page);
  await viewer.waitForFunction(() => Boolean((document.querySelector("#game-frame") as HTMLElement)?.dataset.frame));
  });
  await test.step(actions[1]!, async () => {
  await viewer.evaluate(() => {
    window.deliveredFrames = [];
    document.querySelector("#game-frame")!.addEventListener("frame", event => {
      const { frame, timestamp, received } = (event as CustomEvent).detail;
      window.deliveredFrames.push({ time: received, frame, latency: Date.now() - timestamp });
    });
  });
  const start = await game.status();
  const t0 = performance.now();
  await page.keyboard.down("ArrowRight");
  await game.waitForInput();
  await page.waitForTimeout(10000);
  await page.keyboard.up("ArrowRight");
  await game.waitForInput();
  const end = await game.status();
  const seconds = (performance.now() - t0) / 1000;
  const preview = await viewer.evaluate(() => {
    const frames = window.deliveredFrames;
    const gaps = frames.slice(1).map((value, i) => value.time - frames[i]!.time).sort((a, b) => a - b);
    const latency = frames.map(value => value.latency).sort((a, b) => a - b);
    const percentile = (values: number[], p: number) => values[Math.min(values.length - 1, Math.floor(values.length * p))];
    return { frames: frames.length, uniqueFrames: new Set(frames.map(value => value.frame)).size,
      spanSeconds: frames.length > 1 ? (frames.at(-1)!.time - frames[0]!.time) / 1000 : 0,
      gapMedianMs: percentile(gaps, .5), gapP95Ms: percentile(gaps, .95), gapMaxMs: gaps.at(-1),
      captureToCanvasMedianMs: percentile(latency, .5), captureToCanvasP95Ms: percentile(latency, .95) };
  });
  const result = {
    seconds, nativeFrames: end.native!.frame - start.native!.frame,
    nativeFPS: (end.native!.frame - start.native!.frame) / seconds,
    previewFrames: preview.frames, previewFPS: preview.spanSeconds ? (preview.frames - 1) / preview.spanSeconds : 0,
    preview,
  };
  await game.screenshot(join(artifacts, "native.png"));
  await writeFile(join(artifacts, "frame-rate.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
  if (result.nativeFPS < 55 || result.previewFPS < 50) throw new Error("Frame rate is below the gameplay target (55 native / 50 preview FPS)");
  });
} catch (error) { failure = error; throw error; }
finally { await test.finish(failure); }

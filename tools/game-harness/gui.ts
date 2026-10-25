import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createGameTest } from "./fixture.ts";
import { enterOpeningGameplay } from "./opening.ts";

const test = await createGameTest("native-menu", {
  title: "Odyssey / fast native menu controls",
  description: "Use native text selectors to open Options and Graphics, verify 60 FPS, 120 FPS, and Uncapped, then return to gameplay. Browser input is blocked.",
  actions: ["Start isolated gameplay", "Open Options", "Open Graphics", "60 FPS", "120 FPS", "Uncapped", "Return to gameplay"],
  fps: 120,
});
const { page, game, artifacts } = test;
let failure: unknown;
try {
  await test.step("Start isolated gameplay", async () => {
    await game.start({ headless: !process.argv.includes("--window"), renderFPS: 0 });
    await enterOpeningGameplay(page);
  });
  await test.step("Open Options", async () => {
    await page.keyboard.press("Enter");
    await page.getByRole("option", { name: "Options", exact: true }).click();
  });
  await test.step("Open Graphics", () => page.getByRole("option", { name: "Graphics", exact: true }).click());
  const limit = page.getByText("Renderer limit", { exact: true });
  for (const [label, fps] of [["60 FPS", 60], ["120 FPS", 120], ["Uncapped", 0]] as const) {
    await test.step(label, async () => {
      await limit.selectOption(label);
      await page.getByText(label, { exact: true }).waitFor();
      assert.equal((await game.status()).native!.timing!.renderFPS, fps);
      await game.screenshot(join(artifacts, `options-${fps}.png`));
      // A short success preview, after the native action has already completed.
      await page.waitForTimeout(150);
    });
  }
  await test.step("Return to gameplay", async () => {
    await limit.press("Escape");
    await page.getByRole("option", { name: "Graphics", exact: true }).press("Escape");
    await page.getByRole("option", { name: "Options", exact: true }).press("Escape");
    await page.until(async () => /StageSceneNrvPlay/.test((await game.status()).native!.timing!.scene));
    await writeFile(join(artifacts, "native-controls.json"), JSON.stringify({ receipts: page.keyboard.receipts, status: await game.status() }, null, 2) + "\n");
  });
} catch (error) {
  failure = error;
  await writeFile(join(artifacts, "failure-native-action.json"), JSON.stringify(page.lastState, null, 2) + "\n");
  throw error;
} finally { await test.finish(failure); }

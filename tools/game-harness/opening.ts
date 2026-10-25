import type { NativeGamePage } from "./native-page.ts";

/** Enter gameplay through native input/state, including a fresh save's camera tutorial. */
export async function enterOpeningGameplay(page: NativeGamePage) {
  const deadline = performance.now() + 60000;
  while (performance.now() < deadline) {
    const state = await page.state();
    if (state.timing?.position) break;
    if (!state.timing?.scene || /DemoSceneNrvPlay|SkipDemo/.test(state.timing.scene)) await page.keyboard.press("Enter");
    await page.keyboard.press("j");
    await page.transport.wait(state.generation);
  }
  await page.until(async () => Boolean((await page.state()).timing?.position), 10000);
  const opening = async () => (await page.state()).route?.actors.find(actor => actor.type === "OpeningStageStartDemo" && actor.alive);
  // The player can appear before the opening actor has been published.
  // Wait for that scene boundary before choosing the tutorial or loaded-save path.
  await page.until(async () => Boolean(await opening()) || /StageSceneNrvPlayE/.test((await page.state()).timing?.scene ?? ""), 15000);
  if (await opening()) {
    await page.until(async () => /NrvCameraTutorial|NrvWaitStandUpE/.test((await opening())?.nerve ?? ""), 30000);
    if (!/NrvWaitStandUpE/.test((await opening())?.nerve ?? "")) {
      await page.keyboard.down("ArrowUp");
      try { await page.until(async () => /NrvWaitStandUpE/.test((await opening())?.nerve ?? ""), 30000); }
      finally { await page.keyboard.up("ArrowUp"); }
    }
    await page.until(async () => ((await opening())?.step ?? 0) > 45, 10000);
    await page.keyboard.press("k");
  }
  await page.until(async () => /StageSceneNrvPlayE/.test((await page.state()).timing?.scene ?? ""), 15000);
}

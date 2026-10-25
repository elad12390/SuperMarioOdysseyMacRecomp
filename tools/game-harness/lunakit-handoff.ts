import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { createGameTest } from "./fixture.ts";
import { lunaGameData } from "./cascade-checkpoints.ts";
import { readLunaTape, type LunaReplay } from "./lunakit-tape.ts";
import { runLunaSegment } from "./lunakit-segment.ts";
import type { NativeState } from "./protocol.ts";

type Test = Awaited<ReturnType<typeof createGameTest>>;
type Session = { continuous: boolean; modeOwned: boolean; initialSeparatePlay: boolean; separatePlay: boolean };
const session = (state: NativeState) => (state as NativeState & { lunaSession?: Session }).lunaSession;
export const handoffActions = [
  "Keep live two-player mode after original Cap completion",
  "Queue a separate one-frame neutral ownership probe",
  "Explicitly stop and restore the original controller mode",
];

/** Synthetic neutral input for ownership verification only; never a route bridge. */
function neutralProbe() {
  const bytes = Buffer.alloc(284 + 2 * 148);
  bytes.write("BOOB"); bytes.writeUInt32LE(2, 4); bytes[8] = 1; bytes.writeInt32LE(-1, 12);
  for (let player = 0; player < 2; player++) {
    const offset = 284 + player * 148; bytes[offset + 4] = player;
    for (const at of [52, 100]) for (const diagonal of [0, 4, 8]) bytes.writeFloatLE(1, offset + at + diagonal * 4);
  }
  return bytes;
}

/** Exercise a real same-process handoff without adding gameplay or progress. */
export async function verifyContinuousHandoff(test: Test, launched: Awaited<ReturnType<Test["game"]["status"]>>) {
  const { game, page, artifacts } = test;
  const directory = join(artifacts, "ownership-probe"); await mkdir(directory);
  const json = (name: string, value: unknown) => writeFile(join(directory, name), JSON.stringify(value, null, 2) + "\n");
  let before!: NativeState;
  await test.step(handoffActions[0]!, async () => {
    before = await page.state(); const owner = session(before), data = lunaGameData(before);
    if (!owner?.continuous || !owner.modeOwned || !owner.separatePlay || owner.initialSeparatePlay ||
        before.route?.stage !== "WaterfallWorldHomeStage" || data?.moons !== 0 || !data.available)
      throw new Error("Cap completion did not retain a fresh live 2P Cascade session: " + JSON.stringify({ owner, data }));
    await json("before.json", before);
  });
  const path = join(directory, "synthetic-neutral.bin"); await writeFile(path, neutralProbe());
  const tape = await readLunaTape(path);
  await json("source.json", { generated: true, purpose: "One neutral scene frame to verify controller ownership, not gameplay or a source route", frames: tape.frames, sha256: tape.sha256 });
  await runLunaSegment(test, tape, [{ label: handoffActions[1]!, from: 1, through: 2, allowAfterReplay: true,
    accept: state => {
      const receipt = state.replay as LunaReplay | undefined, owner = session(state);
      return receipt?.phase === "completed" && receipt.frame === 1 && owner?.modeOwned === true && owner.separatePlay;
    },
  }], { directory, label: "Synthetic neutral ownership probe", continuous: true });
  await test.step(handoffActions[2]!, async () => {
    await json("after-handoff.json", await page.state());
    await page.stopReplay();
    await page.until(async () => {
      const owner = session(await page.state());
      return owner?.continuous === true && owner.modeOwned === false && owner.separatePlay === owner.initialSeparatePlay;
    }, 5000);
    const after = await page.state(), identity = await game.status();
    for (const key of ["pid", "runId", "saveDirectory", "settingsPath"] as const)
      if (identity[key] !== launched[key]) throw new Error("The native process/save identity changed during handoff: " + key);
    if (lunaGameData(after)?.moons !== 0) throw new Error("The neutral ownership probe unexpectedly changed Cascade progress");
    await json("after-stop.json", after);
    await json("identity.json", { before: launched, after: identity, sameProcess: true, gameplaySeeded: false, originalCapFrames: 7055, syntheticNeutralFrames: 1 });
    await test.viewer.evaluate(() => {
      const clock = document.querySelector(".luna-clock");
      if (clock) clock.textContent = "Original Cap 7055/7055 passed | neutral handoff passed | original controller mode restored";
    });
  });
}

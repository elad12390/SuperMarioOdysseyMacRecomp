import { createWriteStream, type WriteStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Page } from "playwright-core";
import type { createGameTest } from "./fixture.ts";
import { lunaGameData } from "./cascade-checkpoints.ts";
import { lunaButtons, readLunaTape, type LunaReplay } from "./lunakit-tape.ts";
import type { NativeState } from "./protocol.ts";
import { ReplayObserver, type ReplayCheckpoint } from "./replay-observer.ts";

type Tape = Awaited<ReturnType<typeof readLunaTape>>;
type GameTest = Awaited<ReturnType<typeof createGameTest>>;
type LunaState = NativeState & { lunaScene?: { type: string; nerve: string; step: number } };
const replay = (s: NativeState) => s.replay as LunaReplay | undefined;
const nativeDeath = (s: NativeState) => /Nrv(?:Miss|Dead)/.test(`${s.timing?.scene ?? ""} ${s.timing?.playerNerve ?? ""} ${s.route?.actors.find(a => a.type === "PlayerActorHakoniwa" && a.alive)?.nerve ?? ""}`)
  ? "Native Mario entered Miss/Dead" : undefined;

function sameFloats(actual: unknown, expected: number[] | number[][]): boolean {
  return Array.isArray(actual) && actual.length === expected.length && expected.every((value, i) =>
    Array.isArray(value) ? sameFloats(actual[i], value) :
      typeof actual[i] === "number" && Number.isFinite(actual[i]) && Object.is(Math.fround(actual[i]), value));
}

function receiptMismatch(state: NativeState, tape: Tape): string | undefined {
  const r = replay(state);
  if (!r || r.format !== "lunakit") return "The native host did not publish a LunaKit receipt";
  if (!Number.isInteger(r.frame) || r.frame < 0 || r.frame > tape.frames || r.frames !== tape.frames)
    return "Native receipt has an invalid source frame/count";
  if (!r.frame) return;
  if (!Array.isArray(r.controllers) || r.controllers.length !== 2) return "Native receipt must contain exactly P1 and P2";
  for (let p = 0; p < 2; p++) {
    const expected = tape.controller(r.frame - 1, p), actual = r.controllers[p]!;
    if (!actual || actual.player !== p || !Number.isInteger(actual.port) || actual.port < 0 || actual.buttons !== expected.buttons ||
      !sameFloats(actual.sticks, expected.sticks) || !sameFloats(actual.accel, expected.accel) ||
      !sameFloats(actual.direction, expected.direction) || !sameFloats(actual.angular, expected.angular))
      return `Native receipt differs from original source frame ${r.frame - 1}, P${p + 1}`;
  }
  if (r.controllers[0]!.port === r.controllers[1]!.port) return "P1 and P2 resolved to the same native controller port";
}

export async function installLunaHUD(viewer: Page) {
  await viewer.evaluate(() => {
    const style = document.createElement("style");
    // The existing 900px viewport leaves 90px below the 720px game. Replace
    // the duplicate key row so pads, source clock and native metrics all fit.
    style.textContent = ".ar-hud{gap:4px!important}.ar-key-row{display:none!important}.luna-pads{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;font:16px/20px ui-monospace,monospace;color:#b7edff}.luna-pad{white-space:pre;overflow:hidden;margin:0;min-width:0;height:22px}.luna-clock{font:16px/20px ui-monospace,monospace;color:#b7edff}";
    const pads = document.createElement("div"); pads.className = "luna-pads";
    for (const name of ["P1 / Mario", "P2 / Cappy"]) {
      const pad = document.createElement("pre"); pad.className = "luna-pad"; pad.textContent = name + " / waiting for native receipt"; pads.append(pad);
    }
    const clock = document.createElement("div"); clock.className = "luna-clock";
    document.head.append(style); document.querySelector(".ar-hud")?.append(pads, clock);
  });
}


/** Queue one unchanged tape on the existing process. Never start/stop a game,
 * seed/reload a save, or finish the recording at a segment boundary. */
export async function runLunaSegment(test: GameTest, tape: Tape, plans: ReplayCheckpoint[], options: {
  directory: string; through?: number; label?: string; continuous?: boolean;
}) {
  const { game, viewer } = test;
  const { directory } = options;
  const diagnostic = options.through !== undefined;
  const json = (name: string, value: unknown) => writeFile(join(directory, name), JSON.stringify(value, null, 2) + "\n");
  let trace: WriteStream | undefined, failure: unknown, mismatch: string | undefined, nativeFailure: string | undefined;
  let observedReceipts = 0, throughSourceFrame: number | null = null, decorating: Promise<unknown> | undefined, lastHUD = 0;
  let traceError: Error | undefined, replayStarted = false;
  let rejectReceipt!: (error: Error) => void;
  const invalidReceipt = new Promise<never>((_, reject) => { rejectReceipt = reject; });
  void invalidReceipt.catch(() => {});
  const attempted = new Set<string>(), passed = new Set<string>();
  const observe = (state: NativeState) => {
    const r = replay(state);
    const problem = receiptMismatch(state, tape);
    if (problem && !mismatch) { mismatch = problem; rejectReceipt(new Error(problem)); }
    if (!r) return;
    const frame = Math.max(0, r.frame - 1);
    const death = nativeDeath(state);
    if (death && !nativeFailure) { nativeFailure = `${death} at source frame ${frame}`; rejectReceipt(new Error(nativeFailure)); }
    observedReceipts++; throughSourceFrame = frame;
    trace?.write(JSON.stringify({ unixMs: Date.now(), sourceFrame: frame, renderFrame: state.frame,
      logicTicks: state.timing?.logicTicks, stage: state.route?.stage, position: state.timing?.position,
      velocity: state.route?.player?.velocity, cameraForward: state.route?.cameraForward,
      cameraEye: state.route?.cameraEye, cameraTarget: state.route?.cameraTarget,
      actors: state.route?.actors.filter(actor => ["PlayerActorHakoniwa", "OpeningStageStartDemo", "OpeningStageStartCapManHero"].includes(actor.type)),
      nerve: state.timing?.playerNerve, scene: state.timing?.scene, lunaScene: (state as LunaState).lunaScene, lunaSession: (state as NativeState & { lunaSession?: unknown }).lunaSession, lunaGameData: lunaGameData(state), replay: r }) + "\n");
    if (problem || death) return;
    if (!decorating && performance.now() - lastHUD >= 100) {
      lastHUD = performance.now();
      const pads = r.controllers.map((controller, i) => `${i === 0 ? "P1 Mario" : "P2 Cappy"} ` +
        `buttons:${lunaButtons(controller.buttons).join("+") || "none"} ` +
        `L(${controller.sticks.slice(0, 2).map(n => n.toFixed(2)).join(",")}) R(${controller.sticks.slice(2).map(n => n.toFixed(2)).join(",")})`);
      decorating = viewer.evaluate(({ pads, clock, keys }) => {
        document.querySelectorAll(".luna-pad").forEach((node, i) => { node.textContent = pads[i] ?? "missing controller"; });
        const node = document.querySelector(".luna-clock"); if (node) node.textContent = clock;
        window.dispatchEvent(new CustomEvent("native-keys", { detail: keys }));
      }, { pads, clock: `${options.label ? options.label + " / " : ""}Source frame ${frame} / ${tape.frames - 1} | ${r.phase}${diagnostic ? " | PARTIAL DIAGNOSTIC" : ""}`,
        keys: r.controllers.flatMap((controller, i) => lunaButtons(controller.buttons).map(button => `P${i + 1}:${button}`)) })
        .catch(() => {}).finally(() => { decorating = undefined; });
    }
  };
  const observer = new ReplayObserver(plans, tape.frames, observe, {
    requirePlayer: false, timeoutMs: tape.frames / 60 * 1000 + 120000,
  });
  try {
    trace = createWriteStream(join(directory, "native-state.jsonl"));
    trace.on("error", error => { traceError = error; rejectReceipt(error); });
    const original = join(directory, "original.bin");
    await writeFile(original, tape.bytes);
    await observer.start();
    if (options.continuous) {
      const state = await game.page.state();
      const session = (state as NativeState & { lunaSession?: { continuous: boolean } }).lunaSession;
      if (!session?.continuous || state.replay?.active || state.savestates?.paused)
        throw new Error("Continuous tape handoff requires an idle, live continuous Tests session");
      // NativeGamePage.replay intentionally stops isolated replays first. A
      // continuous handoff must not restore 1P or discard the live Cappy.
      await game.setInput({});
      await game.transport.request(`replay ${resolve(original)}`);
    } else await game.replay(original);
    replayStarted = true;
    for (const plan of plans) await test.step(plan.label, async () => {
      attempted.add(plan.label);
      await Promise.race([observer.expect(plan.label), invalidReceipt]);
      if (mismatch || nativeFailure || traceError) throw traceError ?? new Error(mismatch ?? nativeFailure);
      passed.add(plan.label);
    });
  } catch (error) { failure = error; }
  finally {
    const preserve = async (fn: () => Promise<unknown>) => {
      try { await fn(); } catch (error) { failure ??= error; }
    };
    await preserve(async () => { await observer.stop(); await decorating; });
    if (mismatch || nativeFailure || traceError) failure ??= traceError ?? new Error(mismatch ?? nativeFailure);
    await preserve(async () => {
      if (trace && !trace.destroyed) await new Promise<void>((resolve, reject) => {
        trace!.once("error", reject); trace!.end(resolve);
      });
      if (traceError) throw traceError;
    });
    await preserve(() => json("observation-coverage.json", { observedReceipts, throughSourceFrame,
      gaps: observer.gaps, mismatch: mismatch ?? null, nativeFailure: nativeFailure ?? null,
      note: "Passive IPC gaps are unobserved snapshots, not skipped native inputs. Every observed receipt is checked against original float32 data." }));
    await preserve(() => json("checkpoint-results.json", { ...observer.report(), replayStarted, diagnostic,
      firstFailure: observer.firstFailure ?? (failure === undefined ? null : String(failure)),
      checkpoints: plans.map(plan => ({ label: plan.label, fromSourceFrame: Math.max(0, plan.from - 1),
        throughSourceFrame: plan.through - 1,
        status: passed.has(plan.label) ? "passed" : attempted.has(plan.label) ? "failed" : "not-run",
        observation: attempted.has(plan.label) ? observer.report().checkpoints.find(c => c.label === plan.label) : undefined })) }));
    await preserve(() => json("native-result.json", observer.lastState ?? null));
    await preserve(() => viewer.evaluate(text => {
      const clock = document.querySelector(".luna-clock");
      if (clock) clock.textContent = text;
    }, failure !== undefined
      ? `${options.label ?? "Original inputs"} / FAILED at observed source frame ${observer.firstFailure?.sourceFrame ?? throughSourceFrame ?? "unknown"} (${tape.frames} original frames)`
      : diagnostic
        ? `PARTIAL DIAGNOSTIC / observed source frame ${throughSourceFrame ?? "unknown"} (${tape.frames} original frames)`
        : `${options.label ?? "Original inputs"} / source frame ${tape.frames - 1} / ${tape.frames - 1} | completed (native receipt)`));
  }
  if (failure !== undefined) throw failure;
  return { state: observer.lastState, report: observer.report(), diagnostic };
}

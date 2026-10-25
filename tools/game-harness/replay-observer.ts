import { NativeTransport } from "./native-transport.ts";
import type { NativeState } from "./protocol.ts";

export type ReplayCheckpoint = {
  label: string;
  from: number;
  through: number;
  accept(state: NativeState): boolean;
  reject?(state: NativeState): string | undefined;
  allowAfterReplay?: boolean;
};
type Outcome = { ok: boolean; reason?: string; frame: number; state?: NativeState };
type Checkpoint = ReplayCheckpoint & { result?: Outcome; outcome: Promise<Outcome>; settle(result: Outcome): void };

/** Passive native state subscription. Checkpoints never schedule or change inputs. */
export class ReplayObserver {
  private readonly transport = new NativeTransport();
  private readonly checkpoints: Checkpoint[];
  private stopping = false;
  private started = false;
  private pump?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private lastFrame = -1;
  private baselineReplayGeneration?: number;
  lastState?: NativeState;
  firstFailure?: { label: string; reason: string; sourceFrame: number; state: NativeState };
  readonly gaps: { after: number; before: number }[] = [];

  constructor(plans: ReplayCheckpoint[], private readonly frames: number, private readonly onState: (state: NativeState) => void,
    private readonly options: { timeoutMs?: number; requirePlayer?: boolean } = {}) {
    this.checkpoints = plans.map(plan => {
      let settle!: (result: Outcome) => void;
      const outcome = new Promise<Outcome>(resolve => { settle = resolve; });
      return { ...plan, outcome, settle };
    });
  }

  private finish(checkpoint: Checkpoint, result: Outcome) {
    if (checkpoint.result) return;
    checkpoint.result = result; checkpoint.settle(result);
    if (!result.ok && result.state && !this.firstFailure)
      this.firstFailure = { label: checkpoint.label, reason: result.reason!, sourceFrame: Math.max(0, result.frame - 1), state: result.state };
  }

  private receive(state: NativeState) {
    const nativeError = (state.replay as { error?: string } | undefined)?.error;
    const receipt = state.replay as (NativeState["replay"] & { phase?: string; generation?: number });
    const completedNewTape = receipt?.phase === "completed" && this.baselineReplayGeneration !== undefined &&
      typeof receipt.generation === "number" && receipt.generation > this.baselineReplayGeneration;
    if (!this.started && (receipt?.active || nativeError || completedNewTape) && receipt?.frames === this.frames) this.started = true;
    if (!this.started || state.route?.replayFrame === undefined) return;
    const frame = state.route.replayFrame;
    this.lastState = state;
    if (nativeError) for (const checkpoint of this.checkpoints)
      this.finish(checkpoint, { ok: false, reason: `Native replay failed: ${nativeError}`, frame, state });
    if (frame > this.lastFrame) {
      if (this.lastFrame >= 0 && frame > this.lastFrame + 1) this.gaps.push({ after: this.lastFrame, before: frame });
      this.onState(state); this.lastFrame = frame;
    }
    for (const checkpoint of this.checkpoints) {
      if (checkpoint.result || frame < checkpoint.from) continue;
      if (frame > checkpoint.through) {
        this.finish(checkpoint, { ok: false, reason: `Expected native state was not observed by source frame ${checkpoint.through - 1}`, frame, state });
        continue;
      }
      const rejected = checkpoint.reject?.(state);
      if (rejected) this.finish(checkpoint, { ok: false, reason: rejected, frame, state });
      else if (checkpoint.accept(state)) this.finish(checkpoint, { ok: true, frame, state });
      else if (!state.replay?.active && frame >= this.frames && !checkpoint.allowAfterReplay)
        this.finish(checkpoint, { ok: false, reason: "Original input recording ended before this checkpoint was reached", frame, state });
    }
  }

  async start() {
    let state = await this.transport.state();
    const receipt = state.replay as (NativeState["replay"] & { generation?: number });
    if (typeof receipt?.generation === "number") this.baselineReplayGeneration = receipt.generation;
    if (state.route?.replayFrame === undefined || (this.options.requirePlayer !== false && !state.route.player)) throw new Error("The native host lacks processed-player replay diagnostics; rebuild it first");
    this.timer = setTimeout(() => {
      for (const checkpoint of this.checkpoints) this.finish(checkpoint, { ok: false, reason: "Native replay exceeded its observation deadline", frame: this.lastFrame, state: this.lastState });
    }, this.options.timeoutMs ?? 60000);
    this.pump = (async () => {
      try {
        while (!this.stopping) {
          this.receive(state);
          state = await this.transport.wait(state.generation);
        }
      } catch (error) {
        if (!this.stopping) for (const checkpoint of this.checkpoints)
          this.finish(checkpoint, { ok: false, reason: `Native observation failed: ${error}`, frame: this.lastFrame, state: this.lastState });
      }
    })();
  }

  async expect(label: string) {
    const checkpoint = this.checkpoints.find(item => item.label === label);
    if (!checkpoint) throw new Error(`Unknown replay checkpoint: ${label}`);
    const result = await checkpoint.outcome;
    if (!result.ok) {
      const state = result.state;
      const actor = state?.route?.actors.find(actor => actor.type === "PlayerActorHakoniwa");
      const nerve = actor?.nerve.match(/Nrv(.+)E/)?.[1] ?? actor?.nerve ?? "unavailable";
      throw new Error(`${result.reason}\nSource frame ${Math.max(0, result.frame - 1)} / ${this.frames}\nNative player: ${nerve}\nPosition: ${actor?.position.map(value => value.toFixed(2)).join(", ") ?? "unavailable"}\nVelocity: ${state?.route?.player?.velocity.map(value => value.toFixed(2)).join(", ") ?? "unavailable"}`);
    }
    return result;
  }

  report() {
    return { sourceFrames: this.frames, observedThroughSourceFrame: Math.max(0, this.lastFrame - 1), gaps: this.gaps, firstFailure: this.firstFailure,
      checkpoints: this.checkpoints.map(({ label, from, through, result }) => ({ label, fromSourceFrame: Math.max(0, from - 1), throughSourceFrame: through - 1,
        status: result ? result.ok ? "passed" : "failed" : "not-run", sourceFrame: result ? Math.max(0, result.frame - 1) : undefined, reason: result?.reason })) };
  }

  async stop() {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.transport.close(); await this.pump;
  }
}

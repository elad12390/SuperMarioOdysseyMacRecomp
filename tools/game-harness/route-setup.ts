import { createWriteStream } from "node:fs";
import type { NativeGameConnection } from "./native-page.ts";
import type { GameInput, NativeState } from "./protocol.ts";

/** Controller-only checkpoint preparation, before original-input playback. */
export class RouteSetup {
  private log;
  private lastInput = "";
  private last?: NativeState;
  private lastConsumed = "";
  constructor(readonly game: NativeGameConnection, logPath: string) {
    this.log = createWriteStream(logPath);
    game.transport.onState = state => {
      if (!state.consumed) return;
      const encoded=JSON.stringify(state.consumed);
      if(encoded===this.lastConsumed) return;
      this.lastConsumed=encoded;
      this.log.write(JSON.stringify({event:"consumed",tick:state.timing?.logicTicks,generation:state.generation,
        input:state.consumed,stage:state.route?.stage,position:state.timing?.position})+"\n");
    };
  }
  async state() { const s = await this.game.page.state(); this.last = s; return s; }
  async next(s = this.last) {
    if (!s) s = await this.state();
    const next = await this.game.transport.wait(s.generation);
    this.last = next; return next;
  }
  async input(input: GameInput) {
    const encoded = JSON.stringify(input);
    if (encoded === this.lastInput) return;
    this.lastInput = encoded;
    await this.game.setInput(input);
    const s = await this.state();
    this.log.write(JSON.stringify({ event:"dispatch",tick: s.timing?.logicTicks, input, stage: s.route?.stage,
      position: s.timing?.position, scene: s.timing?.scene, player: s.timing?.playerNerve }) + "\n");
  }
  async release() { await this.input({}); }
  async hold(frames: number, input: GameInput = {}) {
    const s = await this.state(), end = s.timing!.logicTicks + frames;
    await this.input(input);
    let current = s;
    while (current.timing!.logicTicks < end) current = await this.next(current);
    await this.release(); return current;
  }
  hasNerve(s: NativeState, name: RegExp) {
    return [s.timing?.scene ?? "", s.timing?.playerNerve ?? "", ...(s.route?.actors.map(a => a.nerve) ?? [])].some(n => name.test(n));
  }
  async wait(label: string, predicate: (s: NativeState) => boolean, maxFrames = 1800) {
    let s = await this.state(); const end = s.timing!.logicTicks + maxFrames;
    const wallEnd = performance.now() + Math.max(30000, maxFrames * 50);
    while (!predicate(s)) {
      if (s.timing!.logicTicks >= end || performance.now() > wallEnd)
        throw new Error(`Route timed out: ${label}; stage=${s.route?.stage}; player=${s.timing?.playerNerve}; position=${s.timing?.position}`);
      s = await this.next(s);
    }
    return s;
  }
  async advanceDialog(predicate: (s: NativeState) => boolean, maxFrames = 3600) {
    const first = await this.state(); const end = first.timing!.logicTicks + maxFrames;
    let s = first;
    while (!predicate(s)) {
      if (s.timing!.logicTicks >= end) throw new Error(`Dialogue did not finish: ${s.timing!.scene}`);
      await this.game.page.keyboard.press("j");
      s = await this.state();
      if (predicate(s)) break;
      await this.hold(22); s = await this.state();
    }
    await this.release(); return s;
  }
  stickToward(s: NativeState, x: number, z: number) {
    const p = s.timing!.position, forward = s.route?.cameraForward;
    if (!p || !forward) throw new Error("Native player/camera observation is unavailable");
    const dx = x-p[0]!, dz = z-p[2]!, d = Math.hypot(dx, dz);
    const fl = Math.hypot(forward[0]!, forward[2]!);
    if (fl < .001) throw new Error("The native camera is vertical; reset it before steering");
    const fx = forward[0]!/fl, fz = forward[2]!/fl;
    const clamp = (v: number) => Math.max(-1,Math.min(1,v));
    return { distance: d, leftStick: { x: clamp((dx*-fz+dz*fx)/Math.max(d,.001)), y: clamp((dx*fx+dz*fz)/Math.max(d,.001)) } };
  }
  async goTo(x: number, z: number, options: { radius?: number; maxFrames?: number; jump?: boolean; interrupt?: boolean } = {}) {
    let s = await this.state(); const stage = s.route?.stage, start = s.timing!.logicTicks;
    let last = s.timing!.position!, sampled = start, jumpUntil = 0, coolUntil = 0, demoSince = 0;
    const wallEnd = performance.now()+90000;
    try {
      while (s.timing!.logicTicks-start < (options.maxFrames ?? 900) && performance.now() < wallEnd) {
        const tick = s.timing!.logicTicks, p = s.timing!.position;
        if (s.route?.stage !== stage) return "stage-change";
        if (!p) { s = await this.next(s); continue; }
        const { distance, leftStick } = this.stickToward(s,x,z);
        if (distance <= (options.radius ?? 150)) return "arrived";
        if (options.interrupt !== false && /NrvDemoE|NrvBindE/.test(s.timing!.playerNerve)) {
          demoSince ||= tick;
          if (tick-demoSince >= 10) return "cutscene";
        } else demoSince = 0;
        if (options.jump && tick-sampled >= 12) {
          if (Math.hypot(p[0]!-last[0]!,p[2]!-last[2]!) < 30 && tick >= coolUntil) {
            jumpUntil = tick+14; coolUntil = jumpUntil+10;
          }
          last=p; sampled=tick;
        }
        await this.input({ leftStick, ...(tick < jumpUntil ? { buttons: ["B"] } : {}) });
        s = await this.next(s);
      }
      throw new Error(`Could not reach (${x}, ${z}); actual=${s.timing?.position}; stage=${s.route?.stage}`);
    } finally { await this.release(); }
  }
  async points(points: number[][], options: Parameters<RouteSetup["goTo"]>[2] = {}) {
    for (const [x,z] of points) {
      const result = await this.goTo(x!,z!,options);
      console.log(`ROUTE_POINT=${x},${z} ${result}`);
      if (result !== "arrived") return result;
    }
    return "arrived";
  }
  async close() { await this.release().catch(() => {}); this.game.transport.onState=undefined; await new Promise<void>(resolve => this.log.end(resolve)); }
}

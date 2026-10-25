import type { Button, Capture, GameInput, GameStatus } from "./protocol.ts";

// saveDirectory is a seed under tmp/odyssey/checkpoints, copied into a new test save.
export type StartOptions = { headless?: boolean; keys?: string; renderFPS?: number; profile?: boolean; saveDirectory?: string; tasMotion?: "legacy-2021"; nativeHost?: string };
export type { GameInstance, InstanceStatus } from "./manager.ts";
export type StickName = "left" | "right";

export interface BrowserGame {
  status(): Promise<GameStatus>;
  start(options?: StartOptions): Promise<GameStatus>;
  stop(): Promise<GameStatus>;
  setInput(input: GameInput): Promise<GameStatus>;
  release(): Promise<GameStatus>;
  press(button: Button | Button[], durationMs?: number): Promise<GameStatus>;
  stick(side: StickName, x: number, y: number, durationMs?: number): Promise<GameStatus>;
  screenshot(name?: string): Promise<Capture>;
  flush(): Promise<void>;
}

declare global {
  interface Window {
    game: BrowserGame;
  }
}

/** Native game control; the supplied real Playwright Page is only its viewer. */
export { connectNativeGame as connectGame } from "./native-page.ts";
export type { NativeGameConnection as GameConnection } from "./native-page.ts";

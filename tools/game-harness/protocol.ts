export const buttonNames = [
  "A", "B", "X", "Y", "LS", "RS", "L", "R", "ZL", "ZR",
  "Plus", "Minus", "Left", "Up", "Right", "Down", "Shake",
] as const;
export type Button = (typeof buttonNames)[number];
export type Stick = { x: number; y: number };
export type GameInput = { buttons?: Button[]; leftStick?: Stick; rightStick?: Stick };
export type NativeState = {
  generation: number;
  replay?: { active: boolean; frame: number; frames: number; hold: number; holds: number };
  consumed?: { buttons: string; lx: number; ly: number; rx: number; ry: number };
  ui?: { screen: string; visible: boolean; ready: boolean; selectedText?: string;
    actions?: { vertical: boolean; horizontal: boolean };
    items: { role: "heading" | "option" | "status"; text: string; value?: string; selected: boolean; enabled: boolean }[] };
  frame: number;
  sampling: number;
  reads: number;
  id: number;
  style: number;
  buttons: string;
  lx: number;
  ly: number;
  rx: number;
  ry: number;
  route?: { stage: string | null; cameraForward: number[] | null; cameraEye?: number[] | null; cameraTarget?: number[] | null; replayFrame?: number;
    player?: { velocity: number[]; continuousJump: number; jumpWindow: number; inputDisabled: boolean; triggerJump: boolean; holdJump: boolean; triggerDive: boolean; triggerHipDrop: boolean;
      jump: { type: string; nerve: string; step: number }; damage: { type: string; nerve: string; step: number } } | null;
    actors: { type: string; nerve: string; step: number; position: number[]; alive: boolean }[] };
  timing?: { logicTicks: number; logicCpuNs: number; drawsWithoutTick: number; historyExtraUpdates?: number; exposureExtraUpdates?: number; renderFPS: number; effectiveRenderFPS: number;
    graphicsPreparation?: { renders: number; deferred: number };
    sequence: string; scene: string; sceneStep: number; playerNerve: string; playerStep: number; position: number[] | null;
    menu: { pauseNerve: string; optionsNerve: string; pauseStep: number; optionsStep: number; pauseSelected: number; optionsSelected: number; configSelected: number; configRows: number;
      pauseListNerve: string; optionsListNerve: string; configListNerve: string };
    interpolation: { enabled: boolean; mode: string; captures: number; applies: number; restores: number; modelWrites: number; restoreMismatches: number };
    display: { presents: number; maxHz: number } };
};
export type GameStatus = {
  running: boolean;
  pid: number | null;
  native: NativeState | null;
  error?: string;
};
export type Capture = { url: string; path: string; frame: number };

// Loopback JSON API, used by the browser page and the Playwright helper:
// GET /api/status -> GameStatus
// POST /api/start { headless?: boolean, keys?: string } -> GameStatus
// POST /api/stop {} -> GameStatus
// POST /api/input GameInput -> GameStatus (complete input state, omitted axes/buttons = released)
// POST /api/screenshot { name?: string } -> Capture; GET capture.url -> native PNG
// GET / or /?view=game -> real browser page, full-screen game viewport in view=game.
// WS /stream -> uint64LE present number, uint64LE Unix nanoseconds, JPEG bytes.

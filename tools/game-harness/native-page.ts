import { mkdir, readFile, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Page } from "playwright-core";
import type { StartOptions } from "./client.ts";
import { NativeTransport } from "./native-transport.ts";
import { assertInstanceStatus, gameInstance, type GameInstance, type InstanceStatus } from "./manager.ts";
import { buttonNames, type Button, type GameInput, type GameStatus, type NativeState } from "./protocol.ts";

const buttons: Record<string, Button> = { j: "A", k: "B", u: "X", i: "Y", q: "L", e: "R", z: "ZL", c: "ZR", f: "LS", g: "RS", Enter: "Plus", Tab: "Minus", Space: "Shake" };
const directions = new Set(["w", "a", "s", "d", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);
const normalize = (key: string) => key === " " ? "Space" : key.length === 1 ? key.toLowerCase() : key;
type UIItem = NonNullable<NativeState["ui"]>["items"][number];

/** The keyboard speaks directly to native HID. The browser is not on this path. */
class NativeController {
  readonly held = new Set<string>();
  manual: GameInput = {};
  constructor(readonly transport: NativeTransport, readonly onKeys: (keys: string[]) => void) {}
  input(): GameInput {
    const active = new Set(this.manual.buttons);
    for (const key of this.held) if (buttons[key]) active.add(buttons[key]!);
    const axis = (negative: string, positive: string) => Number(this.held.has(positive)) - Number(this.held.has(negative));
    return { buttons: [...active],
      leftStick: ["w", "a", "s", "d"].some(k => this.held.has(k)) ? { x: axis("a", "d"), y: axis("s", "w") } : this.manual.leftStick,
      rightStick: [...directions].slice(4).some(k => this.held.has(k)) ? { x: axis("ArrowLeft", "ArrowRight"), y: axis("ArrowDown", "ArrowUp") } : this.manual.rightStick };
  }
  async send() { this.onKeys([...this.held, ...(this.manual.buttons ?? [])]); await this.transport.input(this.input()); }
  async pulse(button: Button | Button[], durationMs = 0) {
    const before = this.manual, start = performance.now();
    this.manual = { ...before, buttons: [...new Set([...(before.buttons ?? []), ...(Array.isArray(button) ? button : [button])])] };
    let dispatchMs = 0, consumedMs = 0;
    try {
      await this.send(); dispatchMs = performance.now() - start;
      await this.waitConsumed(this.input()); consumedMs = performance.now() - start;
      if (durationMs) await Bun.sleep(durationMs);
    } finally { this.manual = before; await this.send(); }
    await this.waitConsumed(this.input());
    return { dispatchMs, consumedMs, releasedMs: performance.now() - start };
  }
  async waitConsumed(input: GameInput, timeout = 15000) {
    let mask = 0n;
    for (const b of input.buttons ?? []) if (b !== "Shake") mask |= 1n << BigInt(buttonNames.indexOf(b));
    const expected = [input.leftStick?.x ?? 0, input.leftStick?.y ?? 0, input.rightStick?.x ?? 0, input.rightStick?.y ?? 0].map(v => Math.round(v * 32767));
    const end = performance.now() + timeout;
    let raw = await this.transport.state();
    while (performance.now() < end) {
      const s = raw.consumed ?? raw;
      if ((BigInt(s.buttons) & 0xffffn) === mask && [s.lx, s.ly, s.rx, s.ry].every((v, i) => v === expected[i])) return;
      raw = await this.transport.wait(raw.generation);
    }
    throw new Error("The native game did not consume the controller state");
  }
  async release() { this.held.clear(); this.manual = {}; await this.send(); }
}

export class NativeKeyboard {
  lastReceipt = { dispatchMs: 0, consumedMs: 0, releasedMs: 0 };
  readonly receipts: { key: string; dispatchMs: number; consumedMs: number; releasedMs: number }[] = [];
  constructor(private readonly controller: NativeController) {}
  async down(key: string) {
    key = normalize(key);
    if (!buttons[key] && !directions.has(key)) throw new Error(`Unsupported native game key: ${key}`);
    this.controller.held.add(key); await this.controller.send();
  }
  async up(key: string) { this.controller.held.delete(normalize(key)); await this.controller.send(); }
  async press(key: string, options: { delay?: number } = {}) {
    const start = performance.now();
    await this.down(key);
    const dispatchMs = performance.now() - start;
    let consumedMs = 0;
    try {
      await this.controller.waitConsumed(this.controller.input());
      consumedMs = performance.now() - start;
      if (options.delay) await Bun.sleep(options.delay);
    } finally { await this.up(key); }
    // Sequential taps need a real released sample, not a guessed sleep.
    await this.controller.waitConsumed(this.controller.input());
    this.lastReceipt = { dispatchMs, consumedMs, releasedMs: performance.now() - start };
    if (this.receipts.length < 1024) this.receipts.push({ key, ...this.lastReceipt });
  }
  async type(text: string, options: { delay?: number } = {}) { for (const key of text) await this.press(key, options); }
}

class NativeLocator {
  constructor(private readonly page: NativeGamePage, private readonly match: (item: UIItem) => boolean) {}
  private async snapshot() { const s = await this.page.state(); return { s, item: s.ui?.items.find(this.match) }; }
  async waitFor(options: { state?: "visible" | "hidden" | "attached" | "detached"; timeout?: number } = {}) {
    await this.page.until(async () => {
      const { s, item } = await this.snapshot();
      const found = Boolean(s.ui?.visible && item);
      return options.state === "hidden" || options.state === "detached" ? !found : found;
    }, options.timeout);
  }
  async isVisible() { const { s, item } = await this.snapshot(); return Boolean(s.ui?.visible && item); }
  async isEnabled() { const { s, item } = await this.snapshot(); return Boolean(s.ui?.visible && s.ui.ready && item?.enabled); }
  async textContent() { return (await this.snapshot()).item?.text ?? null; }
  async getAttribute(name: string) {
    const { item } = await this.snapshot();
    if (!item) return null;
    return name === "aria-selected" ? String(item.selected) : name === "aria-disabled" ? String(!item.enabled) : name === "data-value" ? item.value ?? null : null;
  }
  private async focus(options: { timeout?: number } = {}) {
    await this.waitFor(options);
    for (let n = 0; n < 32; n++) {
      await this.page.until(() => this.isEnabled(), options.timeout);
      const { s, item } = await this.snapshot();
      if (!item || item.role !== "option" || item.selected) return;
      const rows = s.ui!.items.filter(row => row.role === "option" && row.enabled);
      const target = rows.indexOf(item), selected = rows.findIndex(row => row.selected);
      if (target < 0 || selected < 0) throw new Error("Native UI has no selectable current item");
      const previous = rows[selected]!.text;
      await this.page.until(async () => (await this.page.state()).ui?.actions?.vertical ?? this.isEnabled(), options.timeout);
      await this.page.holdButtonUntil(target > selected ? "Down" : "Up",
        async () => (await this.page.state()).ui?.items.some(row => row.selected && row.text !== previous) ?? false, options.timeout);
    }
    throw new Error("Native selection did not reach the requested text");
  }
  async click(options: { timeout?: number } = {}) {
    await this.focus(options);
    const { s, item } = await this.snapshot();
    if (item?.role === "option" && !/control|config|setting|graphics/i.test(s.ui!.screen))
      await this.page.holdButtonUntil("A", async () => {
        const ui = (await this.page.state()).ui; return !ui?.ready || ui.screen !== s.ui!.screen;
      }, options.timeout);
  }
  async press(key: string, options: { delay?: number; timeout?: number } = {}) {
    if (key === "Escape") { await this.waitFor(options); await this.page.dismissMenu(options); return; }
    await this.focus(options);
    const menuKeys: Record<string, Button> = { ArrowRight: "Right", ArrowLeft: "Left", ArrowUp: "Up", ArrowDown: "Down", Enter: "A", Escape: "B" };
    if (menuKeys[key]) await this.page.pressButton(menuKeys[key]!, options.delay);
    else await this.page.keyboard.press(key, options);
  }
  async selectOption(value: string, options: { timeout?: number } = {}) {
    await this.focus(options);
    for (let n = 0; n < 12; n++) {
      await this.page.until(() => this.isEnabled(), options.timeout);
      const previous = (await this.snapshot()).item?.value;
      if (previous === value) return [value];
      if (previous === undefined) throw new Error("The selected native item has no value choices");
      await this.page.until(async () => (await this.page.state()).ui?.actions?.horizontal ?? this.isEnabled(), options.timeout);
      await this.page.pressButton("Right");
      await this.page.until(async () => {
        const value = (await this.snapshot()).item?.value;
        return value !== undefined && value !== previous;
      }, options.timeout);
    }
    throw new Error(`The native menu did not offer ${value}`);
  }
}

/** Playwright-style game surface backed by native state, not DOM/OCR/timers. */
export class NativeGamePage {
  readonly keyboard: NativeKeyboard;
  lastState?: NativeState;
  constructor(readonly transport: NativeTransport, readonly controller: NativeController) { this.keyboard = new NativeKeyboard(controller); }
  async pressButton(button: Button, durationMs = 0) {
    const receipt = await this.controller.pulse(button, durationMs);
    if (this.keyboard.receipts.length < 1024) this.keyboard.receipts.push({ key: button, ...receipt });
  }
  async holdButtonUntil(button: Button, changed: () => Promise<boolean>, timeout?: number) {
    const before = this.controller.manual, start = performance.now();
    this.controller.manual = { ...before, buttons: [...new Set([...(before.buttons ?? []), button])] };
    let dispatchMs = 0, consumedMs = 0;
    try {
      await this.controller.send(); dispatchMs = performance.now() - start;
      await this.until(changed, timeout); consumedMs = performance.now() - start;
    } finally { this.controller.manual = before; await this.controller.send(); }
    await this.controller.waitConsumed(this.controller.input());
    if (this.keyboard.receipts.length < 1024) this.keyboard.receipts.push({ key: button, dispatchMs, consumedMs, releasedMs: performance.now() - start });
  }
  async dismissMenu(options: { timeout?: number } = {}) {
    await this.until(async () => Boolean((await this.state()).ui?.ready), options.timeout);
    const previous = (await this.state()).ui!.screen;
    await this.holdButtonUntil("B", async () => {
      const ui = (await this.state()).ui; return !ui?.ready || ui.screen !== previous;
    }, options.timeout);
  }
  private generation = 0;
  async state() { const s = await this.transport.state(); this.generation = s.generation; this.lastState = s; return s; }
  async until(predicate: () => Promise<boolean>, timeout = 10000) {
    const end = performance.now() + timeout;
    while (performance.now() < end) {
      if (await predicate()) return;
      const s = await this.transport.wait(this.generation); this.generation = s.generation;
    }
    throw new Error("Timed out waiting for native UI text/state");
  }
  getByText(text: string | RegExp, options: { exact?: boolean } = {}) {
    return new NativeLocator(this, item => [item.text, ...(item.value === undefined ? [] : [item.value])].some(value =>
      typeof text === "string" ? options.exact ? value === text : value.includes(text) : (text.lastIndex = 0, text.test(value))));
  }
  getByRole(role: UIItem["role"], options: { name?: string | RegExp; exact?: boolean } = {}) {
    const name = options.name;
    return new NativeLocator(this, item => item.role === role && (name === undefined || (typeof name === "string" ? options.exact ? item.text === name : item.text.includes(name) : (name.lastIndex = 0, name.test(item.text)))));
  }
  waitForTimeout(ms: number) { return Bun.sleep(ms); }
  async stopReplay() { await this.transport.request("replay-stop"); }
  async replay(path: string) {
    await this.stopReplay();await this.controller.release();
    await this.controller.waitConsumed(this.controller.input());
    await this.transport.request(`replay ${resolve(path)}`);
  }
  async screenshot(options: { path?: string } = {}) {
    const path = options.path ? resolve(options.path) : join(resolve(import.meta.dir, "../../tmp/odyssey"), `native-${crypto.randomUUID()}.png`);
    await mkdir(dirname(path), { recursive: true }); await unlink(path).catch(() => {});
    await this.transport.request(`shot ${path}`, 30000);
    const end = performance.now() + 10000;
    while (performance.now() < end) {
      try {
        const png = await readFile(path);
        if (png.length > 20 && png.subarray(-8, -4).toString() === "IEND") {
          if (!options.path) await unlink(path); return png;
        }
      } catch {}
      await Bun.sleep(2);
    }
    throw new Error("Native screenshot did not complete");
  }
}

export async function connectNativeGame(viewer: Page, onKeys: (keys: string[]) => void = () => {},
  options: { instance?: GameInstance; observePlayer?: boolean } = {}) {
  const instance = gameInstance(options.instance ?? (options.observePlayer ? { role: "player" } : {}));
  const baseURL = instance.baseURL;
  const transport = new NativeTransport({ instance, observePlayer: options.observePlayer });
  const viewURL = new URL(baseURL); viewURL.searchParams.set("view", "game"); viewURL.searchParams.set("native", "1");
  await viewer.goto(viewURL.href); await viewer.waitForFunction(() => Boolean(window.game));
  // Process lifecycle is separate from the direct input/text/screenshot socket.
  const manage = async (path: string, body?: object): Promise<InstanceStatus> => {
    const response = await fetch(new URL(path, baseURL), body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const s = await response.json() as InstanceStatus;
    // A crashed process is status data, and must not prevent a subsequent start.
    if (!response.ok || (path !== "/api/status" && s.error)) throw new Error(s.error || `Game manager HTTP ${response.status}`);
    assertInstanceStatus(s, instance);
    return s;
  };
  const controller = new NativeController(transport, onKeys);
  const page = new NativeGamePage(transport, controller);
  let owned = false;
  const mutable = () => { if (transport.readOnly) throw new Error("Player observation is read-only"); };
  const status = async (): Promise<InstanceStatus> => {
    if (!transport.readOnly) return manage("/api/status");
    const metadata = { instance, runId: null, saveDirectory: null, settingsPath: null, tempDirectory: null, automatedInput: false };
    try { return { running: true, pid: null, native: await transport.state(), ...metadata }; }
    catch (error) { return { running: false, pid: null, native: null, error: String(error), ...metadata }; }
  };
  // Verify the instance before any control can be issued, including by fixtures.
  if (!transport.readOnly) await status();
  return { page, viewer, keyboard: page.keyboard, transport,
    status,
    async start(options: StartOptions = {}) {
      mutable(); transport.close(); controller.held.clear(); controller.manual = {};
      const s = await manage("/api/start", options);
      if (!s.running) throw new Error(s.error || "The native test process did not start");
      owned = true; return s;
    },
    async stop() { mutable(); transport.close(); const s = await manage("/api/stop", {}); owned = false; return s; },
    async release() {
      mutable(); const s = await status();
      if (owned && s.running) { await page.stopReplay(); await controller.release(); }
      return s;
    },
    replay: (path: string) => page.replay(path),
    async setInput(input: GameInput) { mutable(); controller.held.clear(); controller.manual = input; await controller.send(); return status(); },
    async press(button: Button | Button[], durationMs = 0) {
      mutable(); await controller.pulse(button, durationMs); return status();
    },
    async stick(side: "left" | "right", x: number, y: number, durationMs?: number) {
      mutable(); const field = side === "left" ? "leftStick" : "rightStick", before = controller.manual[field];
      controller.manual[field] = { x, y }; await controller.send();
      if (durationMs !== undefined) {
        try { await Bun.sleep(durationMs); }
        finally { controller.manual[field] = before; await controller.send(); }
      }
      return status();
    },
    waitForInput: () => transport.flush(),
    screenshot: (path?: string) => page.screenshot({ path }),
  };
}

export type NativeGameConnection = Awaited<ReturnType<typeof connectNativeGame>>;

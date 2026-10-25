import { createConnection, type Socket } from "node:net";
import { gameInstance, validateTestPath, type GameInstance } from "./manager.ts";
import { buttonNames, type GameInput, type NativeState } from "./protocol.ts";

/** One direct Unix-socket hop to the native host; NDJSON replies, no HTTP/files. */
export class NativeTransport {
  readonly instance: GameInstance;
  readonly socketPath: string;
  readonly readOnly: boolean;
  onState?: (state: NativeState) => void;
  private socket?: Socket;
  private connecting?: Promise<Socket>;
  private queue: Promise<unknown> = Promise.resolve();
  private pending?: { resolve(value: unknown): void; reject(error: Error): void };
  private received = "";
  private observer?: NativeTransport;

  constructor(options: { instance?: GameInstance; observePlayer?: boolean } = {}) {
    this.instance = gameInstance(options.instance ?? (options.observePlayer ? { role: "player" } : {}));
    this.socketPath = this.instance.socketPath;
    this.readOnly = options.observePlayer === true;
    if (this.instance.role === "player" && !this.readOnly)
      throw new Error("Player native connections require explicit observePlayer: true (no input or lifecycle control)");
  }

  private async connect(): Promise<Socket> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;
    if (this.instance.role === "tests") await validateTestPath(this.socketPath);
    this.connecting = new Promise<Socket>((resolve, reject) => {
      const socket = createConnection({ path: this.socketPath });
      socket.setEncoding("utf8");
      const fail = (error: Error) => {
        this.pending?.reject(error); this.pending = undefined;
        this.connecting = undefined; this.socket = undefined; reject(error);
      };
      socket.on("error", fail);
      socket.on("close", () => {
        this.pending?.reject(new Error("The native game socket closed")); this.pending = undefined;
        if (this.socket === socket) this.socket = undefined;
        this.connecting = undefined;
      });
      socket.on("data", chunk => {
        this.received += chunk;
        if (this.received.length > 1024 * 1024) { socket.destroy(new Error("Native reply exceeded 1 MiB")); return; }
        const newline = this.received.indexOf("\n");
        if (newline < 0) return;
        const line = this.received.slice(0, newline); this.received = this.received.slice(newline + 1);
        const pending = this.pending; this.pending = undefined;
        try {
          const value = JSON.parse(line);
          if (typeof value.generation === "number") this.onState?.(value);
          if (value.error) pending?.reject(new Error(value.error)); else pending?.resolve(value);
        } catch (error) { pending?.reject(new Error(`Invalid native reply: ${error}`)); }
      });
      socket.once("connect", () => { this.socket = socket; this.connecting = undefined; this.received = ""; resolve(socket); });
    });
    return this.connecting;
  }

  request<T>(command: string, timeout = 3000): Promise<T> {
    if (/[\r\n]/.test(command) || command.length > 1900) return Promise.reject(new Error("Invalid native command"));
    if (this.readOnly && command !== "state" && !/^wait \d+$/.test(command))
      return Promise.reject(new Error("Player observation is read-only"));
    const run = async () => {
      const socket = await this.connect();
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => socket.destroy(new Error(`Native request timed out: ${command.split(" ")[0]}`)), timeout);
        this.pending = { resolve: value => { clearTimeout(timer); resolve(value as T); }, reject: error => { clearTimeout(timer); reject(error); } };
        socket.write(command + "\n", error => { if (error) socket.destroy(error); });
      });
    };
    const result = this.queue.then(run, run); this.queue = result.catch(() => {}); return result;
  }

  state() { return this.request<NativeState>("state"); }
  wait(after: number) {
    this.observer ??= new NativeTransport({ instance: this.instance, observePlayer: this.readOnly });
    this.observer.onState = state => this.onState?.(state);
    return this.observer.request<NativeState>(`wait ${after}`);
  }
  input(input: GameInput) { return this.request<{ ok: true }>(encodeInput(input)); }
  async flush() { await this.queue; }
  close() { this.socket?.destroy(); this.socket = undefined; this.connecting = undefined; this.observer?.close(); this.observer = undefined; }
}

export function encodeInput(input: GameInput): string {
  let mask = 0n;
  for (const button of input.buttons ?? []) {
    const bit = buttonNames.indexOf(button); if (bit < 0) throw new Error(`Unknown button ${button}`);
    mask |= 1n << BigInt(button === "Shake" ? 63 : bit);
  }
  const axis = (value = 0) => {
    if (!Number.isFinite(value) || Math.abs(value) > 1) throw new Error("Native stick axes must be between -1 and 1");
    return Math.round(value * 32767);
  };
  return `input ${mask.toString(16)} ${[input.leftStick?.x, input.leftStick?.y, input.rightStick?.x, input.rightStick?.y].map(axis).join(" ")}`;
}

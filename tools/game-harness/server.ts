import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { closeSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { buttonNames, type GameInput, type GameStatus, type NativeState } from "./protocol.ts";
import { NativeTransport } from "./native-transport.ts";
import { gameInstance, prepareTestRun, validateTestPath, type InstanceStatus } from "./manager.ts";
import type { StartOptions } from "./client.ts";

const root = resolve(import.meta.dir, "../..");
const build = join(root, "game-data/super-mario-odyssey");
const instance = gameInstance();
const work = instance.runtimeDirectory;
const nativeSocketPath = instance.socketPath;
const captures = join(work, "captures");
const gameLog = join(work, "game.log");
const streamPath = join(work, "preview.frame");
const streamActive = `${streamPath}.active`;
const port = Number(new URL(instance.baseURL).port || 80);
const origin = `http://127.0.0.1:${port}`;
type OwnedProcess = Pick<ReturnType<typeof Bun.spawn>, "pid" | "exitCode" | "exited" | "kill">;
let game: OwnedProcess | null = null;
const native = new NativeTransport({ instance, observePlayer: instance.role === "player" });
let run: Awaited<ReturnType<typeof prepareTestRun>> | undefined;
function metadata() {
  return { instance, runId: run?.runId ?? null, saveDirectory: run?.saveDirectory ?? null,
    settingsPath: run?.settingsPath ?? null, tempDirectory: run?.tempDirectory ?? null,
    automatedInput: instance.role === "tests" };
}
let queue: Promise<unknown> = Promise.resolve();
const viewers = new Set<Bun.ServerWebSocket<{ frames: true }>>();
let lastStreamFrame = 0n, lastStreamMtime = 0, readingStream = false;
if (instance.role === "tests") {
  await validateTestPath(work); await validateTestPath(nativeSocketPath);
}
await mkdir(captures, { recursive: true });
await unlink(streamActive).catch(() => {});

// Capture and input have independent paths. Only the newest complete packet is
// broadcast, and a slow browser cannot build an unbounded video queue.
const streamTimer = setInterval(async () => {
  if (!viewers.size || !running() || readingStream) return;
  readingStream = true;
  try {
    const info = await stat(streamPath);
    if (info.mtimeMs === lastStreamMtime) return;
    const packet = await readFile(streamPath);
    if (packet.length < 18 || packet[16] !== 0xff || packet[17] !== 0xd8) return;
    const frame = packet.readBigUInt64LE(0);
    if (frame <= lastStreamFrame) return;
    lastStreamFrame = frame;
    lastStreamMtime = info.mtimeMs;
    for (const viewer of viewers) if (viewer.getBufferedAmount() < 256 * 1024) viewer.send(packet);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error("Native stream:", error);
  } finally { readingStream = false; }
}, 4);

function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn);
  queue = next.catch(() => {});
  return next;
}
function running() { return game !== null && game.exitCode === null; }
function requireGame() { if (!running()) throw new Error("The native game is not running. Start it first."); }
async function command(line: string) { requireGame(); await native.request(line); }
async function waitFile<T>(path: string, parse: (data: Buffer) => T, timeout = 5000): Promise<T> {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    requireGame();
    try { return parse(await readFile(path)); } catch { /* the native write may still be in progress */ }
    await Bun.sleep(2);
  }
  throw new Error(`Native game did not produce ${basename(path)} within ${timeout} ms. See ${gameLog}`);
}
async function nativeState(): Promise<NativeState> {
  requireGame();
  const until = Date.now() + 5000;
  for (;;) {
    try { return await native.state(); }
    catch (error) { if (!running() || Date.now() >= until) throw error; await Bun.sleep(5); }
  }
}
async function status(): Promise<InstanceStatus> {
  if (running()) {
    try { return { running: true, pid: game!.pid, native: await nativeState(), ...metadata() }; }
    catch (error) { if (running()) throw error; }
  }
  let error: string | undefined;
  if (game && game.exitCode) {
    const log = await readFile(gameLog, "utf8").catch(() => "");
    error = log.split("\n").filter(s => /FATAL|CRASH/.test(s)).slice(-2).join("\n") || `Game exited ${game.exitCode}`;
  }
  return { running: false, pid: game?.pid ?? null, native: null, ...metadata(), ...(error ? { error } : {}) };
}
async function stop(): Promise<GameStatus> {
  if (running()) {
    await command("input 0 0 0 0 0").catch(() => {});
    game!.kill("SIGTERM");
    await Promise.race([game!.exited, Bun.sleep(5000)]);
    if (running()) { game!.kill("SIGKILL"); await game!.exited; }
  }
  native.close();
  if (instance.role === "tests") await unlink(nativeSocketPath).catch(() => {});
  game = null;
  return status();
}
async function start(options: StartOptions): Promise<GameStatus> {
  if (instance.role !== "tests") throw new Error("Player bridges are read-only; use play-odyssey.command to play");
  if (running()) throw new Error("The harness already owns a running game. Stop it before starting another.");
  if (options.keys !== undefined && (typeof options.keys !== "string" || options.keys.length > 8192)) throw new Error("Invalid input script");
  if (options.renderFPS !== undefined && (!Number.isInteger(options.renderFPS) || (options.renderFPS !== 0 && (options.renderFPS < 30 || options.renderFPS > 480)))) throw new Error("Render FPS must be 0 (uncapped) or 30 to 480");
  if (options.tasMotion !== undefined && options.tasMotion !== "legacy-2021") throw new Error("Unsupported TAS motion profile");
  let nativeHost: string | undefined;
  if (options.nativeHost !== undefined) {
    if (typeof options.nativeHost !== "string" || !options.nativeHost) throw new Error("nativeHost must name a private test build");
    nativeHost = resolve(options.nativeHost);
    await validateTestPath(nativeHost);
    if (!(await stat(nativeHost)).isFile()) throw new Error("nativeHost must be a file under tmp/odyssey");
  }
  run = await prepareTestRun(instance, options.saveDirectory);
  native.close();
  await unlink(nativeSocketPath).catch(() => {});
  await unlink(streamPath).catch(() => {});
  lastStreamFrame = 0n; lastStreamMtime = 0;
  const env: Record<string, string | undefined> = { ...process.env, GAME_INSTANCE_ROLE: "tests",
    DM_INSTANCE_LABEL: "Tests", DM_AUTOMATED_INPUT: "1", DM_SAVE: run.saveDirectory, DM_TEMP: run.tempDirectory,
    DM_NATIVE_OPTIONS: run.settingsPath, DM_RUN_DIRECTORY: run.runDirectory,
    DM_NATIVE_SOCKET: nativeSocketPath, DM_NVN_STREAM: streamPath, DM_LAUNCH_LOG: gameLog };
  delete env.DM_SMO_TAS_MOTION;
  delete env.DM_NATIVE_SAVESTATES;
  delete env.DM_NATIVE_HOST;
  if (nativeHost) env.DM_NATIVE_HOST = nativeHost;
  if(options.tasMotion) env.DM_SMO_TAS_MOTION=options.tasMotion;
  delete env.DM_CTL; delete env.DM_CTL_POLL_MS;
  // A run starts with no inherited replay, watchdog, or capture configuration.
  for (const key of ["DM_KEYS", "DM_NVN_SHOT", "DM_AUDIO_DUMP", "DM_WATCH", "DM_WATCH_STALL", "DM_NVN_TSV", "DM_NVN_PROF", "DM_SMO_RENDER_FPS", "DM_FULLSCREEN", "DM_AUDIO", "DM_PLAYER_SLOT"]) delete env[key];
  if (options.keys) env.DM_KEYS = options.keys;
  if (options.renderFPS !== undefined) env.DM_SMO_RENDER_FPS = String(options.renderFPS);
  if (options.profile) { env.DM_NVN_TSV = join(work, "frame-times.tsv"); env.DM_NVN_TSV_CALLS = "0"; env.DM_NVN_PROF = "1"; }
  const fd = openSync(gameLog, "w");
  try {
    game = Bun.spawn([join(root, "scripts/play-odyssey.command"), ...(options.headless === false ? [] : ["--headless"])], {
      cwd: root, env, stdin: "ignore", stdout: fd, stderr: fd,
    });
  } finally { closeSync(fd); }
  await writeFile(join(work, "game.pid"), `${game!.pid}\n`);
  await Bun.sleep(350);
  return status();
}
function axis(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1) throw new Error("Stick axes must be between -1 and 1");
  return Math.round(value * 32767);
}
async function input(value: GameInput): Promise<GameStatus> {
  let mask = 0n;
  if (value.buttons !== undefined && !Array.isArray(value.buttons)) throw new Error("buttons must be an array");
  for (const name of value.buttons || []) {
    const bit = buttonNames.indexOf(name);
    if (bit < 0) throw new Error(`Unknown button ${name}`);
    mask |= 1n << BigInt(name === "Shake" ? 63 : bit);
  }
  const axes = [axis(value.leftStick?.x), axis(value.leftStick?.y), axis(value.rightStick?.x), axis(value.rightStick?.y)];
  if (!running() && mask === 0n && axes.every(v => v === 0)) return status();
  await command(`input ${mask.toString(16)} ${axes.join(" ")}`);
  // Acknowledge dispatch immediately. status() separately observes what the
  // actual game consumed; input must not wait for a status/screenshot round trip.
  return { running: true, pid: game!.pid, native: null };
}
async function screenshot(name = `capture-${Date.now()}`) {
  if (!/^[a-zA-Z0-9_-]{1,100}(?:\.png)?$/.test(name)) throw new Error("Capture name must contain only letters, numbers, hyphens, and underscores");
  const file = name.endsWith(".png") ? name : `${name}.png`;
  const path = join(captures, file);
  await unlink(path).catch(() => {});
  await command(`shot ${path}`);
  await waitFile(path, data => {
    if (data.length < 20 || data.subarray(-8, -4).toString() !== "IEND") throw new Error("PNG not complete");
    return true;
  }, 10000);
  return { url: `/captures/${file}`, path, frame: (await nativeState()).frame };
}
function json(value: unknown, code = 200) { return Response.json(value, { status: code, headers: { "Cache-Control": "no-store" } }); }

const server = Bun.serve<{ frames: true }>({
  hostname: "127.0.0.1", port,
  async fetch(req): Promise<Response | undefined> {
    const url = new URL(req.url);
    if (req.headers.get("origin") && req.headers.get("origin") !== origin) return json({ error: "Use the local harness origin" }, 403);
    if (url.pathname === "/stream" && req.method === "GET") {
      return server.upgrade(req, { data: { frames: true } }) ? undefined : json({ error: "WebSocket upgrade required" }, 426);
    }
    if (url.pathname === "/" && req.method === "GET") return new Response(Bun.file(join(import.meta.dir, "web.html")), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    if (url.pathname.startsWith("/captures/") && req.method === "GET") {
      const name = url.pathname.slice("/captures/".length);
      if (!/^[a-zA-Z0-9_-]+\.png$/.test(name)) return json({ error: "Invalid capture" }, 400);
      const file = Bun.file(join(captures, name));
      return await file.exists() ? new Response(file, { headers: { "Content-Type": "image/png", "Cache-Control": "no-store" } }) : json({ error: "Capture missing" }, 404);
    }
    if (url.pathname === "/api/status" && req.method === "GET") {
      try { return json(await serial(status)); } catch (error) { return json({ error: String(error) }, 503); }
    }
    if (!url.pathname.startsWith("/api/") || req.method !== "POST") return json({ error: "Not found" }, 404);
    if (instance.role !== "tests") return json({ error: "Player observation is read-only" }, 403);
    if (!req.headers.get("content-type")?.startsWith("application/json")) return json({ error: "JSON required" }, 415);
    try {
      const body = await req.json();
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected a JSON object");
      if (url.pathname === "/api/input") return json(await input(body));
      return json(await serial(async () => {
        switch (url.pathname) {
          case "/api/start": return start(body);
          case "/api/stop": return stop();
          case "/api/screenshot": return screenshot(body.name);
          default: throw new Error("Unknown API operation");
        }
      }));
    } catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, 400); }
  },
  websocket: {
    open(socket) { viewers.add(socket); writeFileSync(streamActive, ""); },
    message() { /* stream is server-to-browser only */ },
    close(socket) {
      viewers.delete(socket);
      if (!viewers.size) { try { unlinkSync(streamActive); } catch { /* already stopped */ } }
    },
  },
});
console.log(`Odyssey Playwright harness: ${origin} (native control, port ${server.port})`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, async () => {
  clearInterval(streamTimer);
  await serial(stop);
  await unlink(streamActive).catch(() => {});
  server.stop(true); process.exit(0);
});

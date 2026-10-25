import { closeSync, openSync } from "node:fs";
import { cp, lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { GameStatus } from "./protocol.ts";

const root = resolve(import.meta.dir, "../..");
const scratch = join(root, "tmp/odyssey");
export type GameInstance = {
  role: "tests" | "player";
  label: string;
  baseURL: string;
  runtimeDirectory: string;
  socketPath: string;
};
export type InstanceStatus = GameStatus & {
  instance: GameInstance;
  runId: string | null;
  saveDirectory: string | null;
  settingsPath: string | null;
  tempDirectory: string | null;
  automatedInput: boolean;
};

/** Test paths cannot overlap the legacy Player runtime, socket or named slots. */
export function assertTestPath(path: string) {
  const value = relative(scratch, resolve(path));
  if (!value || value.startsWith("../") || value === ".." ||
      /^(?:runtime|game-temp|player-slots)(?:\/|$)/.test(value) ||
      /^(?:native\.sock|play\.log|player-[^/]*)(?:\/|$)/.test(value))
    throw new Error(`Tests must use private paths under tmp/odyssey: ${path}`);
}

/** Reject symlink ancestors before creating or deleting any test-owned files. */
export async function validateTestPath(path: string) {
  assertTestPath(path);
  let current = resolve(path);
  while (current !== root) {
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`Test paths cannot contain symlinks: ${current}`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    current = dirname(current);
  }
}

/** Resolve at the call site, after scripts such as fog.ts set their environment. */
export function gameInstance(overrides: Partial<GameInstance> = {}): GameInstance {
  const role = overrides.role ?? (process.env.GAME_INSTANCE_ROLE || "tests").toLowerCase();
  if (role !== "tests" && role !== "player") throw new Error("GAME_INSTANCE_ROLE must be Tests or Player");
  const baseURL = new URL(overrides.baseURL ?? process.env.GAME_HARNESS_URL ??
    `http://127.0.0.1:${process.env.GAME_HARNESS_PORT || (role === "tests" ? 4318 : 4317)}`);
  if (baseURL.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(baseURL.hostname) || baseURL.username || baseURL.password)
    throw new Error("The native bridge requires a loopback HTTP URL");
  const instance: GameInstance = {
    role, label: role === "tests" ? "Tests" : "Player",
    baseURL: baseURL.origin,
    runtimeDirectory: resolve(overrides.runtimeDirectory ?? process.env.GAME_HARNESS_RUNTIME ?? join(scratch, role === "tests" ? "runtime-tests" : "runtime")),
    socketPath: resolve(overrides.socketPath ?? process.env.GAME_NATIVE_SOCKET ?? join(scratch, role === "tests" ? "tests.sock" : "native.sock")),
  };
  if (role === "tests") {
    if (baseURL.port === "4317") throw new Error("Port 4317 belongs to Player; tests use 4318");
    assertTestPath(instance.runtimeDirectory); assertTestPath(instance.socketPath);
    if (instance.socketPath === instance.runtimeDirectory || instance.runtimeDirectory.startsWith(instance.socketPath + "/"))
      throw new Error("Use a separate test runtime directory and socket file");
  }
  if (Buffer.byteLength(instance.socketPath) >= 104) throw new Error("Native Unix socket path must be shorter than 104 bytes");
  return instance;
}

export function assertInstanceStatus(value: InstanceStatus, instance: GameInstance) {
  const actual = value.instance;
  if (!actual || actual.role !== instance.role || actual.socketPath !== instance.socketPath ||
      actual.runtimeDirectory !== instance.runtimeDirectory)
    throw new Error("Bridge instance mismatch; refusing to attach to an old or different Player/Tests bridge");
  if (instance.role === "tests" && value.automatedInput !== true)
    throw new Error("The Tests bridge must disable physical input");
}

/** A checkpoint is a seed, never the live save; refuse symlinks/hardlinks into Player. */
export async function prepareTestRun(instance: GameInstance, seed?: string) {
  if (instance.role !== "tests") throw new Error("Only Tests may prepare an automated run");
  await validateTestPath(instance.runtimeDirectory);
  let source: string | undefined;
  if (seed !== undefined) {
    if (typeof seed !== "string" || !seed) throw new Error("Invalid checkpoint save directory");
    source = resolve(seed);
    if (!source.startsWith(join(scratch, "checkpoints") + "/")) throw new Error("Save seeds must be in tmp/odyssey/checkpoints/");
    await validateTestPath(source);
    if (!(await lstat(source)).isDirectory()) throw new Error("The save seed must be a directory");
    const inspect = async (path: string) => {
      const info = await lstat(path);
      if (info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1)))
        throw new Error(`Save seeds cannot contain links or special files: ${path}`);
      if (info.isDirectory()) for (const entry of await readdir(path)) await inspect(join(path, entry));
    };
    await inspect(source);
  }
  const runId = crypto.randomUUID();
  const runDirectory = join(instance.runtimeDirectory, "runs", runId);
  const saveDirectory = join(runDirectory, "save"), tempDirectory = join(runDirectory, "game-temp");
  const settingsPath = join(runDirectory, "native-options.ini");
  await validateTestPath(runDirectory);
  await mkdir(saveDirectory, { recursive: true }); await mkdir(tempDirectory, { recursive: true });
  if (source) await cp(source, saveDirectory, { recursive: true, dereference: false });
  return { runId, runDirectory, saveDirectory, tempDirectory, settingsPath, seedDirectory: source ?? null };
}

export async function ensureBridge(options: Partial<GameInstance> = {}) {
  const instance = gameInstance(options);
  const probe = async () => {
    const response = await fetch(new URL("/api/status", instance.baseURL), { signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error(`Bridge status HTTP ${response.status}`);
    assertInstanceStatus(await response.json() as InstanceStatus, instance);
  };
  try { await probe(); return instance; }
  catch (error) {
    // Only connection failure permits startup; a mismatched live bridge is unsafe.
    if (!(error instanceof TypeError) && (error as NodeJS.ErrnoException).code !== "ECONNREFUSED") throw error;
  }
  if (instance.role === "tests") {
    await validateTestPath(instance.runtimeDirectory); await validateTestPath(instance.socketPath);
  }
  await mkdir(instance.runtimeDirectory, { recursive: true });
  const log = join(instance.runtimeDirectory, "harness-server.log");
  const fd = openSync(log, "a");
  let bridge;
  try {
    bridge = Bun.spawn([process.execPath, join(import.meta.dir, "server.ts")], { cwd: import.meta.dir,
      env: { ...process.env, GAME_INSTANCE_ROLE: instance.role, GAME_HARNESS_URL: instance.baseURL,
        GAME_HARNESS_PORT: new URL(instance.baseURL).port || "80", GAME_HARNESS_RUNTIME: instance.runtimeDirectory,
        GAME_NATIVE_SOCKET: instance.socketPath }, stdin: "ignore", stdout: fd, stderr: fd });
    bridge.unref();
  } finally { closeSync(fd); }
  await writeFile(join(instance.runtimeDirectory, "harness-server.pid"), `${bridge.pid}\n`);
  for (let i = 0; i < 50; i++) {
    if (bridge.exitCode !== null) throw new Error(`The local bridge exited; see ${log}`);
    try { await probe(); return instance; }
    catch (error) {
      if (!(error instanceof TypeError) && (error as NodeJS.ErrnoException).code !== "ECONNREFUSED") throw error;
    }
    await Bun.sleep(100);
  }
  throw new Error(`The local bridge did not become ready; see ${log}`);
}

/** Real published-runtime acceptance. Never runs dmhost or opens a GUI.
 * Run: bun test tools/browser-builder/runtime/tests/portable.test.ts
 * All fixture writes/evidence stay in tmp/odyssey/browser-runtime-portability.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

interface Entry { path: string; url: string; size: number; sha256: string; mode: number }
interface Manifest {
  format: number; kind: string; architecture: string; minimumMacOS: string;
  source: { repository: string; commit: string; patches: Record<string, string> };
  gameAssetsIncluded: boolean; notarized: boolean; files: Entry[];
}
interface SignalEvent { pid: number; signal: "SIGTERM" | "SIGKILL" }
interface Command { name: string; args: string[]; pid: number; status: number; stdout: string; stderr: string; elapsedMs: number; timedOut: boolean; signalsSent: SignalEvent[] }
const repo = resolve(import.meta.dir, "../../../..");
const scratch = resolve(repo, "tmp/odyssey/browser-runtime-portability");
const publicRoot = resolve(repo, process.env.SWITCHRECOMP_RUNTIME_PUBLIC ?? "tmp/odyssey/browser-release/runtime-public/public");
const manifestPath = resolve(publicRoot, "manifest.json");
const run = resolve(scratch, `run-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
const fixtureHome = resolve(run, "isolated Foundation home");
const temporary = resolve(run, "private macOS temporary");
const profile = resolve(fixtureHome, "Library/Application Support/SwitchRecomp/Super Mario Odyssey");
const commands: Command[] = [];
const findings: Record<string, unknown> = {};
const descriptions: Record<string, Record<string, string>> = {};
const copies = [
  resolve(run, "First.app"),
  resolve(run, "a path with spaces/deeper/another level/Renamed Runtime.app"),
];
const sealCopy = resolve(run, "separate seal probe/Generated Game.app");
let manifest: Manifest, manifestBytes: Buffer, appName: string, original: string;
let sequence = 0;
const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function command(name: string, args: string[], env: Record<string, string> = {}, timeoutMs = 15000): Promise<Command> {
  const started = performance.now(); let timedOut = false;
  const child = Bun.spawn(args, {
    cwd: run,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: process.env.HOME ?? "", CFFIXED_USER_HOME: fixtureHome, TMPDIR: temporary + "/", ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const log = resolve(run, `${String(++sequence).padStart(2, "0")}-${name}`);
  const signalsSent: SignalEvent[] = [];
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const signalChild = (signal: SignalEvent["signal"]) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill(signal); signalsSent.push({ pid: child.pid, signal });
  };
  const timer = setTimeout(() => {
    timedOut = true; signalChild("SIGTERM");
    killTimer = setTimeout(() => signalChild("SIGKILL"), 250);
  }, timeoutMs);
  try {
    await writeFile(log + ".pid", `${child.pid}\n`);
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const result = { name, args, pid: child.pid, status, stdout, stderr, elapsedMs: performance.now() - started, timedOut, signalsSent }; commands.push(result);
    await Promise.all([writeFile(log + ".stdout", stdout), writeFile(log + ".stderr", stderr), writeFile(log + ".status", `${status}\n`)]);
    return result;
  } finally { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); }
}
function successful(result: Command) {
  expect(result.status, `${result.name}: ${result.stderr || result.stdout}`).toBe(0);
}
async function walk(directory: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name), name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await walk(path, name));
    else { expect(entry.isFile(), `Unexpected nonordinary file ${name}`).toBe(true); result.push(name); }
  }
  return result.sort();
}
async function validateFiles(root: string) {
  for (const entry of manifest.files) {
    const full = resolve(root, entry.path), info = await lstat(full);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== entry.size || hash(await readFile(full)) !== entry.sha256 || (info.mode & 0o777) !== entry.mode) throw Error(`Manifest mismatch: ${entry.path}`);
  }
}
async function describeApp(app: string, name: string, env: Record<string, string> = {}) {
  // This is the only execution of product code. Never call Launcher without
  // --describe, never substitute a host, and never execute the real dmhost.
  const result = await command(name, [join(app, "Contents/MacOS/Launcher"), "--describe"], env);
  successful(result); expect(result.stderr).toBe("");
  const value = JSON.parse(result.stdout) as Record<string, string>;
  descriptions[name] = value; return value;
}
function expectedPaths(app: string, writable = profile) {
  const game = join(app, "Contents/Resources/game");
  return {
    DM_ROOT: game, DM_ROMFS: join(game, "extract/v0/RomFS"), DM_MSL_DIR: join(game, "shader/cache"),
    DM_FONT_DIR: join(game, "font"), DM_NVN_SHMAP: join(game, "profile/0100000000010000/shader_map.tsv"),
    host: join(app, "Contents/MacOS/dmhost"), workingDirectory: writable,
    DM_SAVE: join(writable, "saves/Player"), DM_TEMP: join(writable, "temporary"), DM_NATIVE_OPTIONS: join(writable, "graphics.ini"),
  };
}

beforeAll(async () => {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw Error("This acceptance test requires real Apple Silicon macOS; no emulation or mock fallback.");
  await mkdir(run, { recursive: true }); await mkdir(fixtureHome); await mkdir(temporary);
  manifestBytes = await readFile(manifestPath); manifest = JSON.parse(manifestBytes.toString());
  if (!manifest.files?.length || manifest.gameAssetsIncluded !== false) throw Error("Completed public runtime manifest is required; game inputs are not permitted.");
  const apps = new Set(manifest.files.map(e => e.path.split("/")[0]));
  if (apps.size !== 1) throw Error("Expected one public app template");
  appName = [...apps][0]; original = join(publicRoot, "files", appName);
  if (!appName.endsWith(".app") || appName === "..") throw Error("Unsafe app root");
  for (const e of manifest.files) {
    if (e.path.split("/").some(p => !p || p === "." || p === "..") || e.path.startsWith("/") || e.path.includes("\\") || e.url !== "files/" + e.path.split("/").map(encodeURIComponent).join("/")) throw Error("Unsafe manifest entry");
  }
  await validateFiles(join(publicRoot, "files"));
  const launcher = manifest.files.find(e => e.path.endsWith("/Contents/MacOS/Launcher"));
  if (!launcher || launcher.sha256 === "651b9876e21d3a2a8197fd8e2043fa2b85d66737f9927df8f6680de72978f38e") throw Error("Refuse to invoke the old Launcher whose --describe errors open NSAlert. Wait for the refreshed fixed manifest.");
  await writeFile(join(run, "manifest.snapshot.json"), manifestBytes);
  for (const dest of [...copies, sealCopy]) { await mkdir(dirname(dest), { recursive: true }); await cp(original, dest, { recursive: true, preserveTimestamps: true }); }
  findings.manifest = { path: manifestPath, sha256: hash(manifestBytes), files: manifest.files.length, totalBytes: manifest.files.reduce((n, f) => n + f.size, 0), source: manifest.source };
}, 30000);

afterAll(async () => {
  const unchanged = manifestBytes && hash(await readFile(manifestPath)) === hash(manifestBytes);
  findings.manifestUnchangedDuringAcceptance = !!unchanged;
  const report = { run, manifestPath, copies, sealCopy, commands, descriptions, findings,
    terminationSignalsSent: commands.flatMap(c => c.signalsSent.map(s => ({ ...s, command: c.name, reason: "command timeout" }))),
    boundaries: { productInvocations: "actual Launcher --describe only", dmhostExecuted: false, desktopUIUsed: false, publicTemplateModified: false,
      bundleDataRead: "Bun reads real font bytes at paths returned by the native Launcher; dmhost resource loading is not exercised",
      environmentSanitization: "Path overrides tested dynamically. Other inherited variables are not exposed by --describe, which returns before unsetenv; host-environment sanitization is not dynamically verified." } };
  await writeFile(join(run, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(join(scratch, "latest-report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`PORTABILITY_EVIDENCE=${join(run, "report.json")}`);
  if (!unchanged) throw Error("Public runtime changed during acceptance; rerun against completed manifest");
});

describe("actual public runtime portability", () => {
  test("completed manifest covers exact ordinary files, provenance, modes and hashes", async () => {
    expect(manifest.format).toBe(1); expect(manifest.kind).toBe("open-source-runtime-template");
    expect(manifest.architecture).toBe("arm64"); expect(manifest.minimumMacOS).toBe("26.0");
    expect(manifest.gameAssetsIncluded).toBe(false); expect(manifest.source.commit).toMatch(/^[a-f0-9]{40}$/);
    expect((await walk(original)).map(p => `${appName}/${p}`)).toEqual(manifest.files.map(e => e.path).sort());
    for (const [path, expected] of Object.entries(manifest.source.patches)) expect(hash(await readFile(resolve(repo, path)))).toBe(expected);
    for (const dest of copies) for (const entry of manifest.files) {
      const file = join(dest, entry.path.slice(appName.length + 1)), info = await stat(file);
      expect(info.size).toBe(entry.size); expect(info.mode & 0o777).toBe(entry.mode); expect(hash(await readFile(file))).toBe(entry.sha256);
    }
    findings.manifestValidated = true;
  });

  test("real Launcher resolves renamed apps at different depths and whitespace", async () => {
    const data = [];
    for (const [i, app] of copies.entries()) {
      const desc = await describeApp(app, `describe-copy-${i}`); expect(desc).toMatchObject(expectedPaths(app)); data.push(desc);
      for (const key of ["DM_ROOT", "DM_ROMFS", "DM_MSL_DIR", "DM_FONT_DIR", "DM_NVN_SHMAP", "host"]) expect(relative(app, desc[key]).startsWith("Contents/")).toBe(true);
      expect(JSON.stringify(desc)).not.toContain(original); expect(JSON.stringify(desc)).not.toContain("scripts/play-odyssey.command");
    }
    expect(data[0].DM_ROOT).not.toBe(data[1].DM_ROOT); expect(data[0].workingDirectory).toBe(data[1].workingDirectory);
    findings.relocatedPathsVerified = true;
  }, 30000);

  test("described data paths read the real copied font resources", async () => {
    const fonts = manifest.files.filter(e => e.path.includes("/Contents/Resources/game/font/"));
    expect(fonts.length).toBeGreaterThan(0);
    for (const [i, app] of copies.entries()) {
      const desc = descriptions[`describe-copy-${i}`] ?? await describeApp(app, `resource-description-${i}`);
      for (const entry of fonts) {
        const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
        const bytes = await readFile(join(desc.DM_FONT_DIR, name)); expect(bytes.length).toBe(entry.size); expect(hash(bytes)).toBe(entry.sha256);
      }
    }
    findings.resourcePathBytesVerified = fonts.map(e => ({ path: e.path, sha256: e.sha256 }));
  });

  test("Application Support paths never collide with existing checkout Player", async () => {
    const desc = await describeApp(copies[0], "describe-app-support"); expect(desc).toMatchObject(expectedPaths(copies[0]));
    const player = resolve(repo, "game-data/super-mario-odyssey/run");
    for (const key of ["DM_SAVE", "DM_TEMP", "DM_NATIVE_OPTIONS", "workingDirectory"]) {
      expect(desc[key].startsWith(profile)).toBe(true); expect(desc[key].startsWith(player)).toBe(false);
    }
    expect(await lstat(profile).catch(() => null)).toBeNull(); // --describe must not start/create a game profile.
    findings.playerIsolation = { publicProfile: profile, existingPlayerSave: join(player, "save"), existingPlayerOptions: join(player, "native-options.ini"), profileCreated: false };
  });

  test("absolute repo-local test profile and inherited path overrides remain isolated", async () => {
    const isolated = join(run, "explicit test profile outside macOS temporary with spaces");
    const desc = await describeApp(copies[1], "describe-test-root", { SWITCHRECOMP_TEST_ROOT: isolated });
    expect(desc).toMatchObject(expectedPaths(copies[1], isolated));
    const hostile: Record<string, string> = { GAME_INSTANCE_ROLE: "tests", DM_AUTOMATED_INPUT: "1", DM_WINDOW: "0", DM_AUDIO: "0" };
    for (const key of ["DM_ROOT", "DM_ROMFS", "DM_MSL_DIR", "DM_FONT_DIR", "DM_NVN_SHMAP", "DM_SAVE", "DM_TEMP", "DM_NATIVE_OPTIONS", "DM_NATIVE_HOST", "DM_NATIVE_SOCKET", "DM_KEYS", "DM_CTL", "DM_RUN_DIRECTORY", "DM_AUDIO_RECORD", "DM_CAPTURE", "DM_PREVIEW"]) hostile[key] = join(run, "inherited poison", key);
    const polluted = await describeApp(copies[1], "describe-inherited-overrides", hostile);
    expect(polluted).toMatchObject(expectedPaths(copies[1])); expect(JSON.stringify(polluted)).not.toContain("inherited poison");
    expect(await lstat(isolated).catch(() => null)).toBeNull();
    findings.inheritedEnvironment = { injectedKeys: Object.keys(hostile), pathsIgnoreOverrides: true, nonPathSanitizationObserved: false };
  }, 30000);

  test("invalid relative or Player-profile roots fail quietly on stderr with bounded exit", async () => {
    const results = [];
    for (const [label, root, expected] of [
      ["relative", "relative/private-profile", /absolute directory path/i],
      ["player-exact", profile, /separate from the Player profile/i],
      ["player-child", join(profile, "saves/unsafe-test"), /separate from the Player profile/i],
    ] as const) {
      const result = await command(`describe-reject-${label}`, [join(copies[1], "Contents/MacOS/Launcher"), "--describe"], { SWITCHRECOMP_TEST_ROOT: root }, 2000);
      results.push(result);
      expect(result.timedOut, "Quiet --describe validation must exit by itself, without killing an alert").toBe(false);
      expect(result.elapsedMs).toBeLessThan(2000); expect(result.status).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).toMatch(expected);
      let exists = true; try { process.kill(result.pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; exists = false; }
      expect(exists, "No Launcher process may remain after a rejected description").toBe(false);
    }
    findings.quietValidationFailures = results;
    expect(await lstat(profile).catch(() => null)).toBeNull();
  }, 10000);

  test("real Mach-O executables are arm64, signed and use only system dependencies", async () => {
    const binaries = [];
    for (const name of ["Launcher", "dmhost"]) {
      const bin = join(copies[1], "Contents/MacOS", name);
      const arch = await command(`arch-${name}`, ["/usr/bin/lipo", "-archs", bin]);
      const signature = await command(`signature-${name}`, ["/usr/bin/codesign", "--verify", "--strict", "--verbose=2", bin]);
      const libraries = await command(`libraries-${name}`, ["/usr/bin/otool", "-L", bin]);
      const deps = libraries.stdout.trim().split("\n").slice(1).map(line => line.trim().split(" (compatibility version")[0]);
      const loads = await command(`load-commands-${name}`, ["/usr/bin/otool", "-l", bin]);
      const bytes = await readFile(bin);
      const rpaths = [...loads.stdout.matchAll(/cmd LC_RPATH[\s\S]*?\n\s*path (.*?) \(offset/g)].map(m => m[1]);
      binaries.push({ name, architecture: arch.stdout.trim(), dependencies: deps, rpaths, sha256: hash(bytes), arch, signature, libraries, loads,
        containsCheckoutPath: bytes.includes(Buffer.from(repo)), containsHomebrewPath: bytes.includes(Buffer.from("/opt/homebrew/")) });
    }
    findings.executables = binaries;
    // Collect both real binaries' evidence even if one signature check fails.
    for (const b of binaries) {
      successful(b.arch); successful(b.libraries); successful(b.loads);
      expect(b.architecture).toBe("arm64"); expect(b.dependencies.length).toBeGreaterThan(0);
      for (const dep of b.dependencies) expect(dep.startsWith("/usr/lib/") || dep.startsWith("/System/Library/"), `Nonsystem dependency: ${dep}`).toBe(true);
      for (const path of b.rpaths) expect(/^(?:@executable_path|@loader_path|\/usr\/lib\/|\/System\/Library\/)/.test(path)).toBe(true);
      expect(b.containsCheckoutPath).toBe(false); expect(b.containsHomebrewPath).toBe(false);
    }
    for (const b of binaries) successful(b.signature);
  }, 30000);

  test("timeout escalation terminates only the captured non-GUI child that ignores SIGTERM", async () => {
    // The safety self-exit makes the RED run bounded even with a SIGTERM-only
    // helper. This is a real OS process-control fixture, never a game host.
    const script = "process.on('SIGTERM',()=>{});console.log('signal-control-ready');setInterval(()=>{},1000);setTimeout(()=>process.exit(0),3000);";
    const result = await command("timeout-escalation-control", [process.execPath, "-e", script], {}, 1000);
    findings.timeoutEscalationControl = result;
    expect(result.stdout).toContain("signal-control-ready");
    expect(result.timedOut).toBe(true); expect(result.status).not.toBe(0);
    expect(result.signalsSent.map(s => s.signal)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(result.signalsSent.every(s => s.pid === result.pid)).toBe(true);
    expect(result.elapsedMs).toBeLessThan(3000);
    let alive = true; try { process.kill(result.pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; alive = false; }
    expect(alive).toBe(false);
  }, 10000);

  test("original template bundle rejects ordinary private resources added without resealing", async () => {
    const before = await command("bundle-before-data", ["/usr/bin/codesign", "--verify", "--deep", "--strict", "--verbose=2", sealCopy]);
    const dummy = join(sealCopy, "Contents/Resources/game/private-portability-fixture.bin");
    const content = Buffer.from("Original synthetic resource for browser runtime seal acceptance. No game data.\n");
    await writeFile(dummy, content); await chmod(dummy, 0o644);
    const after = await command("bundle-after-data", ["/usr/bin/codesign", "--verify", "--deep", "--strict", "--verbose=2", sealCopy]);
    findings.bundleSeal = { copiedApp: sealCopy, addedResource: dummy, addedResourceSha256: hash(content), before, after, reSigned: false,
      expectedBehavior: "Original template validates before addition and rejects unsealed added data. Browser sealApp success is separate real coverage in signing/EVIDENCE.md." };
    // Observe both actual results before assertions: a failing baseline must
    // never hide the post-addition bundle result or become executable-only proof.
    successful(before);
    expect(after.timedOut).toBe(false);
    expect(after.status).not.toBe(0);
    expect(after.stdout + after.stderr).toMatch(/a sealed resource is missing or invalid/i);
    expect(after.stdout + after.stderr).toContain("private-portability-fixture.bin");
  }, 30000);
});

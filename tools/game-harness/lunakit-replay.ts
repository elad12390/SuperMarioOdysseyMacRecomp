import { runLunaReplay, type LunaReplayOptions } from "./lunakit-runner.ts";

export const lunaReplayUsage = `Usage:
  bun tools/game-harness/lunakit-replay.ts --tape original.bin --scenario cap|cascade --host /path/to/dmhost [options]

  --tape PATH        Original, complete two-player LunaKit binary (Cap: exactly 7055 frames)
  --scenario NAME    cap: fresh Start menu; cascade: seeded first-moon to world selection
  --host PATH        Required executable native LunaKit host; no Player fallback
  --save DIRECTORY   Cascade only: seed below tmp/odyssey/checkpoints/
  --language CODE    Native DM_LANG (default: en-US for Cap, zh-TW for Cascade)
  --through FRAME    Stop after observing this zero-based source frame (optional partial diagnostic)
  --camera-speed N   Cap only: original camera level -2..2 (default: 2, fastest)
  --session MODE     isolated (default), or continuous: full Cap plus a neutral ownership handoff check
  --help             Print this help without starting the harness

Playback never rewrites inputs or retimes the tape. Cascade requires --save and
verifies its three prerequisite moons through the original native GameDataFile.
`;

/** Parse before creating a fixture, bridge, window or recording. */
export function parseLunaReplayOptions(args: string[]): LunaReplayOptions | undefined {
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) return undefined;
  const allowed = new Set(["--tape", "--scenario", "--host", "--save", "--language", "--through", "--camera-speed", "--session"]);
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (!allowed.has(key)) throw new Error(`Unknown option: ${key}`);
    if (values.has(key)) throw new Error(`Repeated option: ${key}`);
    if (!value || value.startsWith("--") || /[\r\n\0]/.test(value)) throw new Error(`${key} requires one value`);
    values.set(key, value);
  }
  for (const key of ["--tape", "--scenario", "--host"]) {
    if (!values.has(key)) throw new Error(`Required option: ${key}`);
  }
  const scenario = values.get("--scenario");
  if (scenario !== "cap" && scenario !== "cascade") throw new Error("--scenario must be cap or cascade");
  const throughText = values.get("--through");
  const cameraText = values.get("--camera-speed");
  if (cameraText !== undefined && (!/^-?\d+$/.test(cameraText) || Number(cameraText) < -2 || Number(cameraText) > 2))
    throw new Error("--camera-speed must be an original level from -2 through 2");
  if (cameraText !== undefined && scenario !== "cap") throw new Error("Cascade keeps its checkpoint's original preferences; --camera-speed is Cap-only");
  if (throughText !== undefined && (!/^\d+$/.test(throughText) || !Number.isSafeInteger(Number(throughText))))
    throw new Error("--through must be a nonnegative, zero-based source frame");
  const session = values.get("--session") ?? "isolated";
  if (!["isolated", "continuous"].includes(session)) throw new Error("--session must be isolated or continuous");
  if (session === "continuous" && (scenario !== "cap" || throughText !== undefined))
    throw new Error("--session continuous is a full fresh-Cap ownership diagnostic, not a full Cascade run");
  const save = values.get("--save");
  if (scenario === "cascade" && !save) throw new Error("Cascade requires an explicit --save checkpoint seed; Player saves are forbidden");
  if (scenario === "cap" && save) throw new Error("Cap requires a fresh save and Start menu; omit --save");
  const language = values.get("--language") ?? (scenario === "cap" ? "en-US" : "zh-TW");
  // nn::settings::LanguageCode has eight bytes, including its terminator.
  if (!/^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(language) || Buffer.byteLength(language) > 7)
    throw new Error("--language must be a native language code of at most seven bytes, such as en-US or zh-TW");
  return { tape: values.get("--tape")!, scenario, host: values.get("--host")!, save, language,
    through: throughText === undefined ? undefined : Number(throughText), cameraSpeed: cameraText === undefined ? undefined : Number(cameraText), continuous: session === "continuous" };
}

if (import.meta.main) {
  try {
    const options = parseLunaReplayOptions(process.argv.slice(2));
    if (options) await runLunaReplay(options);
    else console.log(lunaReplayUsage);
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  }
}

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

export type LunaController = {
  player: number; port: number; buttons: number; sticks: number[];
  accel: number[][]; direction: number[][]; angular: number[][];
};
export type LunaReplay = {
  format: "lunakit"; active: boolean; phase: string; error: string;
  frame: number; frames: number; hold: number; holds: number;
  generation: number; separatePlay: boolean; controllers: LunaController[];
  positionPolicy?: "verify-nearby-no-write" | "source-initializer";
  positionChecked?: boolean; positionDelta?: number[];
};
const labels = ["A", "B", "ZL", "X", "Y", "ZR", "RS", "LS", "Home", "Minus", "Plus", "Start", "Select", "L", "R", "Touch", "Up", "Down", "Left", "Right"];
export function lunaButtons(mask: number) { return labels.filter((_, bit) => Boolean(mask & (1 << bit))); }

/** Read the original compiler output for passive display and receipt checks.
 * Native code independently validates and plays the full, unchanged binary. */
export async function readLunaTape(path: string) {
  const bytes = await readFile(path);
  if (bytes.length < 284 || bytes.toString("ascii", 0, 4) !== "BOOB") throw new Error("Expected an original TSV-TAS-2 LunaKit binary");
  const records = bytes.readUInt32LE(4);
  if (!records || records > 120000 || bytes.length !== 284 + records * 148) throw new Error("Invalid LunaKit binary length");
  const frames = bytes.readUInt32LE(284 + (records - 1) * 148) + 1;
  const twoPlayer = bytes[8] === 1;
  if (!twoPlayer || records !== frames * 2) throw new Error("This scenario requires a complete two-player source recording");
  const controller = (frame: number, player: number): Omit<LunaController, "port"> => {
    const offset = 284 + (frame * 2 + player) * 148;
    if (bytes.readUInt32LE(offset) !== frame || bytes[offset + 4] !== player) throw new Error("Source controller records must remain interleaved in frame order");
    const floats = (at: number, count: number) => Array.from({ length: count }, (_, i) => bytes.readFloatLE(offset + at + i * 4));
    return { player, buttons: bytes.readUInt32LE(offset + 8), sticks: floats(12, 4),
      accel: [floats(28, 3), floats(40, 3)], direction: [floats(52, 9), floats(100, 9)], angular: [floats(88, 3), floats(136, 3)] };
  };
  // Validate ordering now, away from the native playback clock.
  for (let f = 0; f < frames; f++) for (let p = 0; p < 2; p++) controller(f, p);
  return { bytes, frames, records, twoPlayer, controller,
    position: [272, 276, 280].map(offset => bytes.readFloatLE(offset)),
    sha256: createHash("sha256").update(bytes).digest("hex") };
}

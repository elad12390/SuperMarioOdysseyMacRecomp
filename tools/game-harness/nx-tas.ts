import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const keys = ["A", "B", "X", "Y", "LSTICK", "RSTICK", "L", "R", "ZL", "ZR", "PLUS", "MINUS", "DLEFT", "DUP", "DRIGHT", "DDOWN"];

/** Lossless format conversion: every source row remains one native game frame. */
export function importNxTas(source: string) {
  const lines = source.trim().split(/\r?\n/);
  const inputs: string[] = [];
  for (const [frame, line] of lines.entries()) {
    const match = /^(\d+)\s+(NONE|KEY_[A-Z0-9_]+(?:;KEY_[A-Z0-9_]+)*)\s+(-?\d+);(-?\d+)\s+(-?\d+);(-?\d+)$/.exec(line);
    assert(match && Number(match[1]) === frame, `Missing or invalid original TAS frame ${frame}`);
    let mask = 0n;
    if (match[2] !== "NONE") for (const key of match[2]!.split(";")) {
      const index = keys.indexOf(key.slice(4));
      assert(index >= 0, `Unsupported recorded key ${key}`);
      mask |= 1n << BigInt(index);
    }
    const axes = match.slice(3).map(Number);
    assert(axes.length === 4 && axes.every(axis => Number.isInteger(axis) && Math.abs(axis) <= 32767), `Invalid original stick values at ${frame}`);
    inputs.push(`1 ${mask.toString(16)} ${axes.join(" ")}`);
  }
  return { frames: inputs.length, native: inputs.join("\n") + "\n", sha256: createHash("sha256").update(source).digest("hex") };
}

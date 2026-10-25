import { expect, test } from "bun:test";
import { importNxTas } from "./nx-tas.ts";

test("recorded button edges and signed stick values survive conversion", () => {
  const source = "0 NONE 0;0 0;0\n1 KEY_B;KEY_DLEFT;KEY_RSTICK -32767;32269 123;-456\n2 NONE 0;0 0;0\n";
  const result = importNxTas(source);
  expect(result.frames).toBe(3);
  expect(result.native).toBe("1 0 0 0 0 0\n1 1022 -32767 32269 123 -456\n1 0 0 0 0 0\n");
  expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
});

test("incomplete or unsupported recordings fail instead of inventing inputs", () => {
  expect(() => importNxTas("0 NONE 0;0 0;0\n2 KEY_B 0;0 0;0")).toThrow("frame 1");
  expect(() => importNxTas("0 KEY_SHAKE 0;0 0;0")).toThrow("Unsupported recorded key");
  expect(() => importNxTas("0 NONE 32768;0 0;0")).toThrow("stick values");
});

import { beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sealApp, inspectAdhocLauncher } from "../index";
import { parseEnvelope } from "../plist";
import type { DmgEntry } from "../../dmg/types";

const repo = resolve(import.meta.dir, "../../../.."), pub = resolve(process.env.SWITCHRECOMP_RUNTIME_PUBLIC ?? resolve(repo, "tmp/odyssey/browser-release/runtime-public/public"));
let entries: DmgEntry[], launcher: Uint8Array, resources: Uint8Array;
const appName = "Super Mario Odyssey.app", prefix = appName + "/Contents/";
const hex = (b: Uint8Array, name = "sha256") => createHash(name).update(b).digest("hex");
function entry(path: string, bytes: Uint8Array, mode = 0o644): DmgEntry {
  return { path, size: bytes.length, mode, open: () => { let at = 0; return { read: buffer => { const n = Math.min(buffer.length, bytes.length - at); buffer.set(bytes.subarray(at, at+n)); at += n; return n; } }; } };
}
async function bytes(e: DmgEntry) {
  const out = new Uint8Array(e.size), r = await e.open!(); let at = 0;
  try { while (at < out.length) { const n = await r.read(out.subarray(at)); if (!n) throw Error("short"); at += n; } } finally { await r.close?.(); } return out;
}
beforeAll(async () => {
  const manifest = JSON.parse(await readFile(resolve(pub, "manifest.json"), "utf8")); entries = [];
  for (const e of manifest.files) { const b = await readFile(resolve(pub, "files", e.path)); expect(hex(b)).toBe(e.sha256); entries.push(entry(e.path, b, e.mode)); }
  launcher = await bytes(entries.find(e => e.path.endsWith("/MacOS/Launcher"))!);
  resources = await bytes(entries.find(e => e.path.endsWith("/_CodeSignature/CodeResources"))!);
});

test("seals the actual template by changing only slot 3 and adding both resource digests", async () => {
  const privateBytes = new TextEncoder().encode("original private-resource fixture\n");
  const path = prefix + "Resources/game/private & escaped<name>.bin";
  const output = await sealApp([...entries, entry(path, privateBytes)], { appName });
  const sealedLauncher = await bytes(output.find(e => e.path.endsWith("/MacOS/Launcher"))!);
  const sealedResources = await bytes(output.find(e => e.path.endsWith("/_CodeSignature/CodeResources"))!);
  const layout = inspectAdhocLauncher(launcher);
  expect(sealedLauncher.length).toBe(launcher.length);
  for (let i = 0; i < launcher.length; i++) if (i < layout.resourceDigestOffset || i >= layout.resourceDigestOffset + 32) expect(sealedLauncher[i]).toBe(launcher[i]);
  expect(hex(sealedResources)).toBe(Buffer.from(sealedLauncher.subarray(layout.resourceDigestOffset, layout.resourceDigestOffset + 32)).toString("hex"));
  const xml = new TextDecoder().decode(sealedResources);
  expect(xml).toContain("private &amp; escaped&lt;name&gt;.bin");
  expect(xml).toContain(createHash("sha1").update(privateBytes).digest("base64"));
  expect(xml).toContain(createHash("sha256").update(privateBytes).digest("base64"));
  const oldHostSeal = parseEnvelope(new TextDecoder().decode(resources)).second.get('MacOS/dmhost');
  expect(oldHostSeal).toBeDefined();
  expect(parseEnvelope(xml).second.get('MacOS/dmhost')?.text).toBe(oldHostSeal!.text);
  const host = entries.find(e => e.path.endsWith("/MacOS/dmhost"))!;
  expect(output.find(e => e.path === host.path)).toBe(host);
});

test("rejects malformed/non-thin/non-ARM64/non-ad-hoc/wrong-hash/CMS layouts", () => {
  const layout = inspectAdhocLauncher(launcher);
  const mutations: [string, (b: Uint8Array, v: DataView) => void][] = [
    ["fat", (_, v) => v.setUint32(0, 0xcafebabe)],
    ["x86", (_, v) => v.setUint32(4, 0x01000007, true)],
    ["certificate", (_, v) => v.setUint32(layout.codeDirectoryOffset + 12, 0)],
    ["wrong hash", b => { b[layout.codeDirectoryOffset + 37] = 1; }],
    ["bad extent", (_, v) => v.setUint32(layout.signatureCommandOffset + 8, 0xffffffff, true)],
    ["CMS", (_, v) => v.setUint32(layout.cmsOffset + 4, 9)],
    ["truncated CD", (_, v) => v.setUint32(layout.codeDirectoryOffset + 4, 44)],
  ];
  for (const [name, mutate] of mutations) { const b = launcher.slice(); mutate(b, new DataView(b.buffer)); expect(() => inspectAdhocLauncher(b), name).toThrow(); }
});

test("rejects original code-page, Info, envelope and existing-resource tampering", async () => {
  for (const suffix of ["MacOS/Launcher", "Info.plist", "_CodeSignature/CodeResources", "Resources/game/font/standard.ttf"]) {
    const changed = entries.map(e => ({ ...e })); const i = changed.findIndex(e => e.path === prefix + suffix);
    const b = await bytes(changed[i]); b[suffix === "MacOS/Launcher" ? 16384 : b.length - 2] ^= 1; changed[i] = entry(changed[i].path, b, changed[i].mode);
    await expect(sealApp(changed, { appName })).rejects.toThrow();
  }
});

test("streams a generated resource through bounded read buffers and closes on cancellation", async () => {
  let max = 0, closed = false, left = 20 * 1024 * 1024;
  const ctrl = new AbortController();
  const big: DmgEntry = { path: prefix + "Resources/game/stream.bin", size: left, mode: 0o644, open: () => ({ read: b => { max = Math.max(max, b.length); const n = Math.min(b.length, left); b.fill(90, 0, n); left -= n; return n; }, close: () => { closed = true; } }) };
  await expect(sealApp([...entries, big], { appName, signal: ctrl.signal, progress: p => { if (p.path === big.path && p.hashedBytes > 2 * 1024 * 1024) ctrl.abort(Error("cancel")); } })).rejects.toThrow("cancel");
  expect(max).toBeLessThanOrEqual(1024 * 1024); expect(closed).toBe(true); expect(left).toBeGreaterThan(0);
});

test("rejects duplicate paths, new resources outside the permitted area and short streams", async () => {
  await expect(sealApp([...entries, entries[0]], { appName })).rejects.toThrow(/duplicate/i);
  await expect(sealApp([...entries, entry(prefix + "Resources/outside.bin", new Uint8Array(1))], { appName })).rejects.toThrow();
  await expect(sealApp([...entries, entry(prefix + "MacOS/unexpected", new Uint8Array(1))], { appName })).rejects.toThrow(/outside|unexpected/i);
  await expect(sealApp([...entries, entry(prefix + "Resources/game/../escape.bin", new Uint8Array(1))], { appName })).rejects.toThrow();
  await expect(sealApp([...entries, { ...entry(prefix + "Resources/game/short.bin", new Uint8Array(1)), size: 100 }], { appName })).rejects.toThrow(/short|EOF/i);
});

test("XML insertion rejects malformed entities, duplicate keys and unbalanced containers", () => {
  const xml = new TextDecoder().decode(resources);
  expect(() => parseEnvelope(xml.replace("<key>rules</key>", "<key>rules</key><dict/><key>rules</key>"))).toThrow();
  expect(() => parseEnvelope(xml.slice(0, -15))).toThrow();
  expect(() => parseEnvelope(xml.replace('<string>cdhash H"', '<string>&unknown;cdhash H"'))).toThrow();
});

test("trusted input-envelope cap remains 8 MiB and rejects before opening", async () => {
  let opened=false;
  const changed=entries.map(e=>e.path.endsWith("/_CodeSignature/CodeResources")?{...e,size:8*1024*1024+1,open:()=>{opened=true;throw Error("must not open oversized input");}}:e);
  await expect(sealApp(changed,{appName})).rejects.toThrow(/metadata exceeds bounded limit/);
  expect(opened).toBe(false);
});

/** A negative acceptance fixture, deliberately damaged after browser creation. */
import { resolve } from "node:path";
import { inspectDmg } from "../index";
const repo = resolve(import.meta.dir, "../../../.."), scratch = resolve(repo, "tmp/odyssey/browser-dmg");
const input = Bun.file(resolve(scratch, "downloads/browser-small.dmg"));
const bytes = new Uint8Array(await input.arrayBuffer());
bytes[4096] ^= 1;
const path = resolve(scratch, "downloads/corrupt-small.dmg");
await Bun.write(path, bytes);
let rejected = false;
try { await inspectDmg({ size: bytes.length, read: async (o,n) => bytes.slice(o,o+n) }); }
catch (e) { if (!String(e).includes("checksum")) throw e; rejected = true; console.log(String(e)); }
if (!rejected) throw Error("Corruption was not detected");
console.log(path);

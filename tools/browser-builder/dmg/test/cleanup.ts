/** Remove only this harness's known generated caches, after successful tests. */
import { lstat, readFile, realpath, rm } from "node:fs/promises";
import { resolve } from "node:path";
const repo = resolve(import.meta.dir, "../../../.."), scratch = resolve(repo, "tmp/odyssey/browser-dmg");
for (const check of ["browser-small", "browser-large", "macos-small", "macos-large"]) {
  if ((await readFile(resolve(scratch, check + ".status"), "utf8")).trim() !== "0") throw Error(`Refuse cleanup before successful ${check}`);
}
for (const name of ["profile-large", "profile-small", "bun-cache", "uv-cache"]) {
  const path = resolve(scratch, name), info = await lstat(path).catch(() => null);
  if (!info) continue;
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw Error(`Refuse unexpected cleanup path: ${path}`);
  if (name.startsWith("profile-")) {
    const port = await readFile(resolve(path, "DevToolsActivePort"), "utf8");
    const cookies = await readFile(resolve(path, "Default/Cookies"));
    if (!/^\d+\n\/devtools\/browser\/[a-z0-9-]+/i.test(port) || cookies.subarray(0, 16).toString() !== "SQLite format 3\0") throw Error("Not a generated headless-shell profile");
  }
  await rm(path, { recursive: true });
  console.log(`Removed owned cache: ${path}`);
}

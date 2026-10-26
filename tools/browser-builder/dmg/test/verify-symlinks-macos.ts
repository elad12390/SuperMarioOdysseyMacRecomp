/** Independent readonly macOS checks. Does not open Finder or run any executable/app. */
import assert from "node:assert/strict";
import { mkdir, open, readFile, readlink, lstat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { inspectDmg } from "../index";

const repo = resolve(import.meta.dir, "../../../..");
const scratch = resolve(repo, "tmp/odyssey/dmg-layout/symlink-agent");
const browser = resolve(scratch, "browser"), mount = resolve(scratch, "mounted");
const path = resolve(browser, "downloads/browser-symlink.dmg");
await mkdir(mount, { recursive: true });
let sequence = 0;
async function command(args: string[], required = true) {
  const id = String(++sequence).padStart(2, "0");
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  await writeFile(resolve(scratch, `macos-${id}.pid`), `${proc.pid}\n`);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, 45000);
  let stdout: string, stderr: string, exit: number;
  try { [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]); }
  finally { clearTimeout(timer); }
  await writeFile(resolve(scratch, `macos-${id}.log`), JSON.stringify({ args, pid: proc.pid, exit, timedOut }) + "\n" + stdout + stderr);
  await writeFile(resolve(scratch, `macos-${id}.exit`), `${exit}\n`);
  console.log(JSON.stringify({ args, pid: proc.pid, exit, timedOut }), stdout, stderr);
  assert(!timedOut, `Timed out: ${args.join(" ")}`);
  if (required) assert.equal(exit, 0, args.join(" "));
  return { stdout, stderr, exit };
}

const bytes = await readFile(path);
const inspection = await inspectDmg({ size: bytes.length, read: async (o, n) => bytes.subarray(o, o + n) });
const evidence = JSON.parse(await readFile(resolve(browser, "browser-small.json"), "utf8"));
assert.equal(inspection.dataChecksum, evidence.dataChecksum);
assert.equal(evidence.symlinksVerified, true);
await command(["/usr/bin/hdiutil", "verify", "-verbose", path]);
let attached = false, detachTarget = mount;
try {
  const attach = await command(["/usr/bin/hdiutil", "attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mount, "-plist", path]);
  attached = true;
  const plist = resolve(scratch, "attach-symlinks.plist"); await writeFile(plist, attach.stdout);
  const entities = JSON.parse((await command(["/usr/bin/plutil", "-convert", "json", "-o", "-", plist])).stdout)["system-entities"];
  const device = entities.find((entity: Record<string, string>) => entity["mount-point"] === mount)?.["dev-entry"];
  assert.match(device, /^\/dev\/disk\d+(s\d+)?$/);
  detachTarget = device;
  const infoFile = resolve(scratch, "disk-info.plist");
  await writeFile(infoFile, (await command(["/usr/sbin/diskutil", "info", "-plist", mount])).stdout);
  const info = JSON.parse((await command(["/usr/bin/plutil", "-convert", "json", "-o", "-", infoFile])).stdout);
  assert.equal(info.FilesystemUserVisibleName, "Mac OS Extended (Case-sensitive)");
  assert.equal(info.WritableMedia, false); assert.equal(info.WritableVolume, false);
  const links = [
    ["Applications", "/Applications"],
    ["message-link", "BrowserFixture.app/Contents/Resources/message.txt"],
    ["dangling-utf8", "../Caf\u00e9"],
    ["long-link", "a".repeat(1023)],
  ];
  for (const [name, target] of links) {
    const stat = await lstat(resolve(mount, name));
    assert(stat.isSymbolicLink()); assert.equal(stat.mode & 0o177777, 0o120777);
    const actual = await readlink(resolve(mount, name), { encoding: "buffer" });
    assert.deepEqual(actual, Buffer.from(target)); assert.equal(stat.size, Buffer.byteLength(target));
    console.log(JSON.stringify({ name, mode: (stat.mode & 0o177777).toString(8), size: stat.size, targetMatches: true }));
  }
  const original = resolve(repo, "tmp/odyssey/browser-dmg/fixture/BrowserFixture.app/Contents/Resources/message.txt");
  assert.deepEqual(await readFile(resolve(mount, "message-link")), await readFile(original));
  await command(["/usr/bin/cmp", resolve(mount, "BrowserFixture.app/Contents/MacOS/BrowserFixture"),
    resolve(repo, "tmp/odyssey/browser-dmg/fixture/BrowserFixture.app/Contents/MacOS/BrowserFixture")]);
  await command(["/usr/sbin/diskutil", "verifyVolume", mount]);
  // Info mode is readonly. Apple Silicon bless may reject disk-image devices; retain its exact result.
  const bless = await command(["/usr/sbin/bless", "--info", mount], false);
  if (bless.exit === 0) {
    assert.match(bless.stdout, /finderinfo\[2\]:\s+2 => 1st dir in open-folder list is /);
    assert(bless.stdout.includes(`${mount}/`));
  }
  // macOS exclusively locks the mounted block device. Unmount, retaining the
  // attached readonly media, before opening its independent raw-header view.
  await command(["/usr/sbin/diskutil", "unmount", device]);

  // This reads the attached readonly block device, independently of our plan or serializer.
  const input = await open(device, "r");
  try {
    for (const offset of [1024, inspection.volumeBytes - 1024]) {
      const header = Buffer.alloc(512);
      assert.equal((await input.read(header, 0, header.length, offset)).bytesRead, 512);
      assert.equal(header.readUInt16BE(0), 0x4858);
      assert.equal(header.readUInt32BE(88), 2); // HFS root CNID, not inferred from planDmg.
      assert.equal(header.readUInt32BE(16), 1792886400 + 2082844800);
      assert.deepEqual(header, bytes.subarray(offset, offset + 512));
      await writeFile(resolve(scratch, `readonly-header-${offset}.bin`), header);
      console.log(JSON.stringify({ device, offset, finderInfo2: header.readUInt32BE(88), createDate: header.readUInt32BE(16) }));
    }
    // This mount's symlink FinderInfo xattr view returned ENOATTR. Verify the
    // stored on-device catalog directly instead of following /Applications.
    const header = Buffer.alloc(512); await input.read(header, 0, 512, 1024);
    const blockSize = header.readUInt32BE(40), catalogStart = header.readUInt32BE(288) * blockSize;
    const treeHeader = Buffer.alloc(64); await input.read(treeHeader, 0, 64, catalogStart);
    const nodeSize = treeHeader.readUInt16BE(32);
    let found = false;
    for (let node = treeHeader.readUInt32BE(24); node !== 0;) {
      const leaf = Buffer.alloc(nodeSize);
      assert.equal((await input.read(leaf, 0, nodeSize, catalogStart + node * nodeSize)).bytesRead, nodeSize);
      for (let r = 0; r < leaf.readUInt16BE(10); r++) {
        const key = leaf.readUInt16BE(nodeSize - 2 * (r + 1)), data = key + 2 + leaf.readUInt16BE(key);
        if (leaf.readUInt16BE(data) !== 2 || leaf.readUInt32BE(key + 2) !== 2) continue;
        const name = new TextDecoder("utf-16be").decode(leaf.subarray(key + 8, data));
        if (name !== "Applications") continue;
        assert.equal(leaf.readUInt16BE(data + 42), 0o120777);
        assert.equal(leaf.subarray(data + 48, data + 80).toString("hex"), "736c6e6b72686170" + "00".repeat(24));
        const targetSize = Number(leaf.readBigUInt64BE(data + 88)), targetOffset = leaf.readUInt32BE(data + 104) * blockSize;
        const target = Buffer.alloc(targetSize); await input.read(target, 0, targetSize, targetOffset);
        assert.deepEqual(target, Buffer.from("/Applications")); found = true;
        console.log(JSON.stringify({ onDeviceCatalog: name, mode: "120777", finderType: "slnk", creator: "rhap", targetMatches: true }));
      }
      node = leaf.readUInt32BE(0);
    }
    assert(found, "Applications catalog record missing from readonly device");
  } finally { await input.close(); }
  await writeFile(resolve(scratch, "macos-symlinks.json"), JSON.stringify({ inspection, device, links: links.length,
    readonly: true, finderInfo2: 2, blessExit: bless.exit, appLaunched: false, finderOpened: false }, null, 2) + "\n");
} finally {
  if (attached) await command(["/usr/bin/hdiutil", "detach", detachTarget]);
}
console.log("MACOS_SYMLINK_ACCEPTANCE_OK");

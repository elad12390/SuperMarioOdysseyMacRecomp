import { expect, test } from "bun:test";
import { entryFromBlob, planDmg, writeDmg, type DmgEntry, type DmgOptions } from "../index";

const timestamp = 1700000000;
const entries: DmgEntry[] = [entryFromBlob("Fixture.app/Contents/data", new Blob(["payload"])),
  { path: "empty", size: 0, mode: 0o755, type: "directory" }];

test.each(["", "Fixture.app", "Fixture.app/Contents", "empty"])("sets both volume Finder info field 2 for %j", async openFolder => {
  const options = { timestamp, openFolder };
  const plan = planDmg(entries, options), folder = plan.items.find(item => item.path === openFolder)!;
  const chunks: Uint8Array[] = [];
  await writeDmg(entries, { write: b => { chunks.push(b.slice()); } }, options);
  const bytes = new Uint8Array(chunks.reduce((n, b) => n + b.length, 0));
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const v = new DataView(bytes.buffer);
  expect(v.getUint32(1024 + 88)).toBe(folder.id);
  expect(v.getUint32(plan.volumeBytes - 1024 + 88)).toBe(folder.id);
  // Other blessing fields must stay zero, preserving app-folder CNIDs for the caller.
  for (const at of [80, 84, 92, 96, 100]) expect(v.getUint32(1024 + at)).toBe(0);
  expect(plan.time).toBe(timestamp + 2082844800);
});

test.each(["missing", "Fixture.app/Contents/data", "/absolute", "../bad", "Fixture.app/../empty", "empty/", "x\\y", "x:y", "x\0y", 42])(
  "rejects invalid or non-directory openFolder %j before any write", async openFolder => {
    let writes = 0;
    await expect(writeDmg(entries, { write: () => { writes++; } }, {
      timestamp, openFolder,
    } as DmgOptions)).rejects.toThrow(/path|folder|directory/i);
    expect(writes).toBe(0);
  });

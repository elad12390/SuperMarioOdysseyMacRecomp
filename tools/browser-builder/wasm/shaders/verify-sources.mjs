import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const sources = JSON.parse(await readFile(new URL('./sources.json', import.meta.url), 'utf8'));
const native = new URL('../../../../external/nxnative/dm/gfx/tools/dmsh_xlate/', import.meta.url);
for (const [file, expected] of [['Program.cs', sources.originalProgramSha256], ['dmsh_xlate.csproj', sources.originalProjectSha256]]) {
  const actual = createHash('sha256').update(await readFile(new URL(file, native))).digest('hex');
  if (actual !== expected) throw new Error(file + ' source hash changed; review the original translator before repinning.');
}
console.log('Original shader translator source hashes verified.');

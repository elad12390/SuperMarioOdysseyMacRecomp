import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFinderStore } from './ds-store';
import { backgroundAlias } from './alias';

const scratch = resolve(import.meta.dir, '../../../tmp/odyssey/dmg-layout');
const layout = { width: 760, height: 480, window: { width: 777, height: 604 }, iconSize: 104, textSize: 13, app: { x: 190, y: 250 }, applications: { x: 570, y: 250 } };
const background = { path: 'Super Mario Odyssey.app/Contents/Resources/game/installer/background.tiff', cnid: 105, parentCnid: 104, parentIds: [104, 103, 102, 101, 100] };
const input = { appName: 'Super Mario Odyssey.app', volumeName: 'Super Mario Odyssey', hfsTime: 1700000000 + 2082844800, background, layout };

test('independent DS_Store, plist and alias readers recover the actual installer settings', async () => {
  await mkdir(scratch, { recursive: true });
  const work = await mkdtemp(resolve(scratch, 'metadata-'));
  try {
    await writeFile(resolve(work, '.DS_Store'), createFinderStore(input));
    await writeFile(resolve(work, 'background.alias'), backgroundAlias({ volumeName: input.volumeName, hfsTime: input.hfsTime, ...background }));
    const log = Bun.spawn(['uv', 'run', '--no-project', '--with', 'ds-store==1.3.3', '--with', 'mac-alias==2.2.3', 'python', resolve(import.meta.dir, 'test/read-metadata.py'), work], { stdout: 'pipe', stderr: 'pipe' });
    const [output, error, code] = await Promise.all([new Response(log.stdout).text(), new Response(log.stderr).text(), log.exited]);
    if (code !== 0) throw Error('Independent Finder parser failed: ' + error);
    expect(code).toBe(0);
    const result = JSON.parse(output);
    expect(result.records).toHaveLength(6);
    expect(result.appPosition).toEqual([190, 250]);
    expect(result.applicationsPosition).toEqual([570, 250]);
    expect(result.window.WindowBounds).toBe('{{160, 120}, {777, 604}}');
    for (const key of ['ShowToolbar', 'ShowSidebar', 'ShowStatusBar', 'ShowPathbar', 'ShowTabView']) expect(result.window[key]).toBe(false);
    expect(result.view).toBe('icnv');
    expect(result.icons.iconSize).toBe(104);
    expect(result.icons.textSize).toBe(13);
    expect(result.icons.arrangeBy).toBe('none');
    expect(result.icons.backgroundType).toBe(2);
    expect(result.icons.labelOnBottom).toBe(true);
    expect(result.alias).toEqual({ version: 2, volume: input.volumeName, fsType: 'H+', createdUnix: 1700000000, path: '/' + background.path, filename: 'background.tiff', cnid: 105, parentCnid: 104 });
    expect(result.aliasMatches).toBe(true);
  } finally { await rm(work, { recursive: true, force: true }); }
}, 30000);

test('layout serialization is deterministic, bounded and rejects unsafe alias metadata', () => {
  expect(createFinderStore(input)).toEqual(createFinderStore(input));
  expect(createFinderStore(input).byteLength).toBeLessThanOrEqual(16384);
  expect(() => backgroundAlias({ volumeName: input.volumeName, hfsTime: input.hfsTime, ...background, path: '../elsewhere' })).toThrow();
  expect(() => backgroundAlias({ volumeName: input.volumeName, hfsTime: NaN, ...background })).toThrow();
  expect(() => backgroundAlias({ volumeName: input.volumeName, hfsTime: input.hfsTime, ...background, cnid: -1 })).toThrow();
});

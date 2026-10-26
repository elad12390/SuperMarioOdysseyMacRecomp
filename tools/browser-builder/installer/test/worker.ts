/// <reference lib="webworker" />
import { entryFromBlob, planDmg, writeDmgToOpfs } from '../../dmg';
import { addFinderInstaller, createInstallerResource, backgroundPath } from '../layout';
import { backgroundAlias } from '../alias';
import { createInstallerBackground, INSTALLER_FRAME } from '../background';
import { sealApp } from '../../signing';

self.onmessage = async () => {
  try {
    const files: { path: string; size: number; mode: number; url: string }[] = await (await fetch('/files.json')).json();
    const entries = []; let icon: Blob | undefined;
    for (const item of files) { const blob = await (await fetch(item.url)).blob(); if (blob.size !== item.size) throw Error('Fixture short read.'); entries.push(entryFromBlob(item.path, blob, item.mode)); if (item.path.endsWith('/Resources/Game.icns')) icon = blob; }
    entries.push(await createInstallerResource());
    const sealed = await sealApp(entries, { appName: 'Super Mario Odyssey.app' });
    if (icon) sealed.push(entryFromBlob('.VolumeIcon.icns', icon));
    const volumeName = 'Odyssey Installer Test';
    const prepared = await addFinderInstaller(sealed, { volumeName, timestamp: 1700000001 });
    const plan = planDmg(prepared.entries, { volumeName, timestamp: prepared.timestamp, openFolder: '' });
    const target = plan.items.find(item => item.path === backgroundPath)!;
    const parentIds = plan.items.filter(item => item.directory && item.path && backgroundPath.startsWith(item.path + '/')).map(item => item.id).reverse();
    const alias = backgroundAlias({ volumeName, hfsTime: plan.time, path: target.path, cnid: target.id, parentCnid: target.parent, parentIds });
    const root = await navigator.storage.getDirectory(), job = await root.getDirectoryHandle('installer', { create: true });
    const started = performance.now();
    const result = await writeDmgToOpfs(prepared.entries, job, 'installer.dmg', { volumeName, timestamp: prepared.timestamp, openFolder: '' });
    self.postMessage({ done: true, file: await result.file.getFile(), preview: await createInstallerBackground(INSTALLER_FRAME), alias, stats: { ...result, file: undefined, durationMs: performance.now() - started, backgroundId: target.id, backgroundParent: target.parent } });
  } catch (error) { self.postMessage({ error: String(error) }); }
};

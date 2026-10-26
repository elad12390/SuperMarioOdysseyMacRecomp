import { entryFromBlob, entryFromSymlink, planDmg, type DmgEntry } from '../dmg';
import { createInstallerBackground, INSTALLER_LAYOUT, INSTALLER_FRAME } from './background';
import { createFinderStore } from './ds-store';
import { retinaTiff } from './tiff';

const appName = 'Super Mario Odyssey.app';
export const backgroundPath = appName + '/Contents/Resources/game/installer/background.tiff';

/** Create the small local installer artwork before app resource sealing. */
export async function createInstallerResource(): Promise<DmgEntry> {
  const bitmap = await createImageBitmap(await createInstallerBackground(INSTALLER_FRAME));
  let background: Uint8Array<ArrayBuffer>;
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d');
    if (!context || bitmap.width !== INSTALLER_FRAME.width * 2 || bitmap.height !== INSTALLER_FRAME.height * 2) throw Error('Installer background has invalid dimensions.');
    context.drawImage(bitmap, 0, 0);
    background = retinaTiff(context.getImageData(0, 0, bitmap.width, bitmap.height).data, bitmap.width, bitmap.height);
  } finally { bitmap.close(); }
  return entryFromBlob(backgroundPath, new Blob([background]));
}

/** Add volume presentation after app sealing, using the existing signed background. */
export async function addFinderInstaller(signedEntries: readonly DmgEntry[], options: { volumeName: string; timestamp?: number }) {
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const entries = [...signedEntries, entryFromSymlink('Applications', '/Applications')];
  const plan = planDmg(entries, { volumeName: options.volumeName, timestamp });
  const target = plan.items.find(item => item.path === backgroundPath);
  if (!target || target.directory) throw Error('Signed installer background is missing.');
  const parentIds = plan.items.filter(item => item.directory && item.path && backgroundPath.startsWith(item.path + '/')).map(item => item.id).reverse();
  const store = createFinderStore({ appName, volumeName: options.volumeName, hfsTime: plan.time, background: { path: backgroundPath, cnid: target.id, parentCnid: target.parent, parentIds }, layout: { ...INSTALLER_LAYOUT, window: INSTALLER_FRAME } });
  entries.push(entryFromBlob('.DS_Store', new Blob([store])));
  return { entries, timestamp };
}

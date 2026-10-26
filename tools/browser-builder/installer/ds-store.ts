import { backgroundAlias, type BackgroundTarget } from './alias';
import { join, text, uint, utf16 } from './binary';
import { binaryPlist } from './plist';

export interface FinderLayout {
  width: number; height: number; iconSize: number; textSize: number;
  app: { x: number; y: number }; applications: { x: number; y: number };
  window?: { width: number; height: number };
}
export function createFinderStore(input: { appName: string; volumeName: string; hfsTime: number; background: BackgroundTarget; layout: FinderLayout }): Uint8Array<ArrayBuffer> {
  const { appName, layout } = input;
  if (!appName.endsWith('.app') || /[\0/\\:]/.test(appName)) throw Error('Invalid installer app name.');
  for (const n of [layout.width, layout.height, layout.iconSize, layout.textSize, layout.app.x, layout.app.y, layout.applications.x, layout.applications.y, layout.window?.width ?? layout.width, layout.window?.height ?? layout.height]) if (!Number.isInteger(n) || n <= 0 || n > 4096) throw Error('Invalid installer geometry.');
  const rows: { name: string; code: string; kind: string; value: Uint8Array }[] = [];
  function blob(name: string, code: string, bytes: Uint8Array) { rows.push({ name, code, kind: 'blob', value: join([uint(bytes.length, 4), bytes]) }); }
  const frame = layout.window ?? layout;
  blob('.', 'bwsp', binaryPlist({ WindowBounds: `{{160, 120}, {${frame.width}, ${frame.height}}}`, ShowStatusBar: false, ShowToolbar: false, ShowSidebar: false, ShowPathbar: false, ShowTabView: false, ContainerShowSidebar: false, PreviewPaneVisibility: false, SidebarWidth: 0 }));
  blob('.', 'icvp', binaryPlist({ viewOptionsVersion: 1, backgroundType: 2, backgroundColorRed: 1, backgroundColorGreen: 1, backgroundColorBlue: 1, backgroundImageAlias: backgroundAlias({ ...input.background, volumeName: input.volumeName, hfsTime: input.hfsTime }), gridOffsetX: 0, gridOffsetY: 0, gridSpacing: 100, arrangeBy: 'none', showIconPreview: false, showItemInfo: false, labelOnBottom: true, textSize: layout.textSize, iconSize: layout.iconSize, scrollPositionX: 0, scrollPositionY: 0 }));
  rows.push({ name: '.', code: 'icvl', kind: 'type', value: text('icnv') }, { name: '.', code: 'vSrn', kind: 'long', value: uint(1, 4) });
  for (const [name, position] of [[appName, layout.app], ['Applications', layout.applications]] as const) blob(name, 'Iloc', join([uint(position.x, 4), uint(position.y, 4), uint(0xffffffff, 4), uint(0xffff0000, 4)]));
  rows.sort((a, b) => a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : a.code < b.code ? -1 : 1);
  const records = rows.map(row => join([uint(row.name.length, 4), utf16(row.name), text(row.code), text(row.kind), row.value]));
  const leaf = join([uint(0, 4), uint(records.length, 4), ...records]);
  if (leaf.length > 4096) throw Error('Installer Finder metadata exceeds its single-page limit.');
  // A bounded Buddy file: allocator at 2048, DSDB superblock at 32, one leaf at 4096.
  // Buddy offsets are relative to file byte 4, not the start of the header.
  const bytes = new Uint8Array(8196), view = new DataView(bytes.buffer);
  view.setUint32(0, 1); bytes.set(text('Bud1'), 4); view.setUint32(8, 2048); view.setUint32(12, 2048); view.setUint32(16, 2048);
  bytes.set(Uint8Array.of(0, 0, 16, 12, 0, 0, 0, 135, 0, 0, 32, 11, 0, 0, 0, 0), 20);
  const allocator = [uint(3, 4), uint(0, 4), uint(2048 | 11, 4), uint(32 | 5, 4), uint(4096 | 12, 4), new Uint8Array(253 * 4), uint(1, 4), Uint8Array.of(4), text('DSDB'), uint(1, 4)];
  for (let width = 0; width < 32; width++) {
    const free = width >= 6 && width <= 10 || width >= 13 && width <= 30;
    allocator.push(uint(free ? 1 : 0, 4)); if (free) allocator.push(uint(2 ** width, 4));
  }
  bytes.set(join(allocator), 2052); bytes.set(join([uint(2, 4), uint(0, 4), uint(rows.length, 4), uint(1, 4), uint(4096, 4)]), 36);
  bytes.set(leaf, 4100); return bytes;
}

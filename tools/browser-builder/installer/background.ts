/** Finder positions are in logical pixels; the PNG has two pixels per point. */
export const INSTALLER_LAYOUT = {
  width: 760,
  height: 480,
  app: { x: 190, y: 250 },
  applications: { x: 570, y: 250 },
  iconSize: 104,
  textSize: 13,
} as const;
// Extra room for Finder's user-enabled tab/path/status bars and permanent scrollbar.
export const INSTALLER_FRAME = { width: 777, height: 604 } as const;

const SCALE = 2;
const FONT = 'system-ui, -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif';

/** Render in the conversion worker, without loading fonts, art or game assets. */
export async function createInstallerBackground(frame: { width: number; height: number } = INSTALLER_LAYOUT): Promise<Blob> {
  const { width, height, app, applications } = INSTALLER_LAYOUT;
  if (frame.width < width || frame.height < height || frame.width > 2048 || frame.height > 2048) throw new Error('Invalid installer frame.');
  const canvas = new OffscreenCanvas(frame.width * SCALE, frame.height * SCALE);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Installer background requires a 2D canvas context.');
  context.scale(SCALE, SCALE);

  const backdrop = context.createLinearGradient(0, 0, frame.width * 0.3, frame.height);
  backdrop.addColorStop(0, '#fcfbf8');
  backdrop.addColorStop(0.55, '#f8f7f4');
  backdrop.addColorStop(1, '#f1f2f2');
  context.fillStyle = backdrop;
  context.fillRect(0, 0, frame.width, frame.height);

  // Cropped orbital details stay outside Finder's icon and label regions.
  context.lineWidth = 1;
  context.strokeStyle = '#e8e5e0';
  for (const radius of [144, 166]) {
    context.beginPath();
    context.arc(frame.width + 5, -24, radius, 0, Math.PI * 2);
    context.stroke();
  }
  context.strokeStyle = '#e9e6e2';
  context.beginPath();
  context.arc(-18, frame.height + 28, 124, 0, Math.PI * 2);
  context.stroke();

  context.lineCap = 'round';
  context.lineWidth = 2;
  context.strokeStyle = '#d9716c';
  context.beginPath();
  context.arc(frame.width + 5, -24, 166, Math.PI * 0.73, Math.PI * 0.91);
  context.stroke();

  context.fillStyle = '#c94c48';
  context.beginPath();
  context.roundRect(width / 2 - 15, 47, 30, 4, 2);
  context.fill();

  context.textAlign = 'center';
  context.textBaseline = 'alphabetic';
  context.fillStyle = '#292b2e';
  context.font = `650 32px ${FONT}`;
  context.fillText('Super Mario Odyssey', width / 2, 101);
  context.fillStyle = '#716e6a';
  context.font = `400 16px ${FONT}`;
  context.fillText('Ready for your Mac', width / 2, 132);

  // Finder draws the real app and Applications icons and their labels.
  const arrowX = (app.x + applications.x) / 2;
  const arrowY = (app.y + applications.y) / 2;
  context.strokeStyle = '#8b8d90';
  context.lineWidth = 2.75;
  context.lineJoin = 'round';
  context.beginPath();
  context.moveTo(arrowX - 42, arrowY);
  context.lineTo(arrowX + 42, arrowY);
  context.moveTo(arrowX + 28, arrowY - 14);
  context.lineTo(arrowX + 42, arrowY);
  context.lineTo(arrowX + 28, arrowY + 14);
  context.stroke();

  context.fillStyle = '#383a3d';
  context.font = `500 17px ${FONT}`;
  context.fillText('Drag Super Mario Odyssey to Applications', width / 2, 384);
  context.fillStyle = '#716e6a';
  context.font = `400 13px ${FONT}`;
  context.fillText('Then open it from Applications', width / 2, 424);

  return canvas.convertToBlob({ type: 'image/png' });
}

import { describe, expect, test } from 'bun:test';
import { INSTALLER_LAYOUT } from './background';

describe('Finder installer background contract', () => {
  test('keeps Finder geometry in logical pixels, independent of PNG resolution', () => {
    expect(INSTALLER_LAYOUT).toEqual({
      width: 760,
      height: 480,
      app: { x: 190, y: 250 },
      applications: { x: 570, y: 250 },
      iconSize: 104,
      textSize: 13,
    });
    const { width, height, app, applications, iconSize, textSize } = INSTALLER_LAYOUT;
    expect(app.y).toBe(applications.y);
    expect(app.x + applications.x).toBe(width);
    expect(applications.x - app.x).toBeGreaterThan(iconSize * 2);
    for (const icon of [app, applications]) {
      expect(icon.x - iconSize / 2).toBeGreaterThan(0);
      expect(icon.x + iconSize / 2).toBeLessThan(width);
      expect(icon.y - iconSize / 2).toBeGreaterThan(132);
      expect(icon.y + iconSize / 2 + textSize * 2).toBeLessThan(380);
      expect(icon.y + iconSize / 2 + textSize * 2).toBeLessThan(height);
    }
  });

  test('bundles for a browser worker without Node or external dependencies', async () => {
    const result = await Bun.build({
      entrypoints: [new URL('./background.ts', import.meta.url).pathname],
      target: 'browser',
      write: false,
    });
    expect(result.success).toBe(true);
    expect(result.logs).toHaveLength(0);
    expect(result.outputs).toHaveLength(1);
    const source = await result.outputs[0]!.text();
    expect(source).not.toMatch(/\b(?:require|import)\s*\(/);
    expect(source).not.toMatch(/\b(?:Bun|process|Buffer|document|window)\s*\./);
  });
});

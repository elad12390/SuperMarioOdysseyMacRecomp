/** A single RGB TIFF representation with explicit Retina density (no native encoder). */
export function retinaTiff(rgba: Uint8ClampedArray, width: number, height: number, scale = 2): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 4096 || height > 4096 || rgba.length !== width * height * 4 || !Number.isInteger(scale) || scale < 1 || scale > 4) throw Error('Invalid installer raster.');
  const count = 13, directoryEnd = 8 + 2 + count * 12 + 4, bits = directoryEnd, xResolution = bits + 6, yResolution = xResolution + 8, pixels = yResolution + 8;
  const bytes = new Uint8Array(pixels + width * height * 3), view = new DataView(bytes.buffer);
  bytes[0] = bytes[1] = 0x49; view.setUint16(2, 42, true); view.setUint32(4, 8, true); view.setUint16(8, count, true);
  let at = 10;
  function tag(id: number, type: number, n: number, value: number) { view.setUint16(at, id, true); view.setUint16(at + 2, type, true); view.setUint32(at + 4, n, true); view.setUint32(at + 8, value, true); at += 12; }
  tag(256, 4, 1, width); tag(257, 4, 1, height); tag(258, 3, 3, bits); tag(259, 3, 1, 1); tag(262, 3, 1, 2); tag(273, 4, 1, pixels);
  tag(277, 3, 1, 3); tag(278, 4, 1, height); tag(279, 4, 1, width * height * 3); tag(282, 5, 1, xResolution); tag(283, 5, 1, yResolution); tag(284, 3, 1, 1); tag(296, 3, 1, 2);
  for (let i = 0; i < 3; i++) view.setUint16(bits + i * 2, 8, true);
  for (const offset of [xResolution, yResolution]) { view.setUint32(offset, 72 * scale, true); view.setUint32(offset + 4, 1, true); }
  for (let source = 0, target = pixels; source < rgba.length; source += 4) {
    const alpha = rgba[source + 3] / 255;
    for (let channel = 0; channel < 3; channel++) bytes[target++] = Math.round(rgba[source + channel] * alpha + 255 * (1 - alpha));
  }
  return bytes;
}

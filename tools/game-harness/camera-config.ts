// A fresh Odyssey Common.bin containing preferences only, with no gameplay file.
// The public GameConfigData writer defines these BYAML fields. The native save
// wrapper is version 1, CRC32 of bytes 4..end, and a 1024-byte Common payload.
// This serializes ordinary configuration; it embeds no game assets or save dump.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let bit = 0; bit < 8; bit++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Generate a fresh native preferences file; no gameplay progress is included. */
export function capCameraPreferences(cameraSpeed = 2, locale: "USen" | "TWzh" = "USen") {
  if (!Number.isInteger(cameraSpeed) || cameraSpeed < -2 || cameraSpeed > 2) throw new Error("Camera speed must be an original level from -2 through 2");
  if (locale !== "USen" && locale !== "TWzh") throw new Error("Unsupported native preferences locale");
  const fields = {
    CameraGyroSensitivityLevel: { type: 0xd1, value: -1 },
    CameraStickSensitivityLevel: { type: 0xd1, value: cameraSpeed },
    IsCameraReverseInputH: { type: 0xd0, value: 0 },
    IsCameraReverseInputV: { type: 0xd0, value: 0 },
    IsPadRumble: { type: 0xd0, value: 1 },
    IsUseOpenListAdditionalButton: { type: 0xd0, value: 0 },
    IsValidCameraGyro: { type: 0xd0, value: 1 },
    PadRumbleLevel: { type: 0xd1, value: 0 },
  };
  const keys = [...Object.keys(fields), "GameConfigData"].sort();
  const strings = keys.map(key => Buffer.from(key + "\0"));
  const stringHeader = 4 + 4 * (keys.length + 1);
  const table = Buffer.alloc(stringHeader + strings.reduce((n, s) => n + s.length, 0));
  table[0] = 0xc2; table.writeUIntLE(keys.length, 1, 3);
  let at = stringHeader;
  strings.forEach((s, i) => { table.writeUInt32LE(at, 4 + i * 4); s.copy(table, at); at += s.length; });
  table.writeUInt32LE(at, 4 + keys.length * 4);
  const root = (16 + table.length + 3) & ~3;
  const child = root + 12;
  const byaml = Buffer.alloc(child + 4 + Object.keys(fields).length * 8);
  byaml.write("YB"); byaml.writeUInt16LE(3, 2); byaml.writeUInt32LE(16, 4);
  byaml.writeUInt32LE(root, 12); table.copy(byaml, 16);
  byaml[root] = 0xc1; byaml.writeUIntLE(1, root + 1, 3);
  byaml.writeUIntLE(keys.indexOf("GameConfigData"), root + 4, 3);
  byaml[root + 7] = 0xc1; byaml.writeUInt32LE(child, root + 8);
  byaml[child] = 0xc1; byaml.writeUIntLE(Object.keys(fields).length, child + 1, 3);
  Object.entries(fields).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).forEach(([key, value], i) => {
    const entry = child + 4 + i * 8;
    byaml.writeUIntLE(keys.indexOf(key), entry, 3); byaml[entry + 3] = value.type;
    byaml.writeInt32LE(value.value, entry + 4);
  });
  if (byaml.length > 964) throw new Error("Common preferences exceed the original payload");
  const save = Buffer.alloc(1036);
  save.writeUInt32LE(1, 4); save.writeUInt32LE(save.length, 8);
  save.write(locale, 24); // Native internal locale; independent of the launch-language fallback.
  save.writeUInt32LE(byaml.length, 68); byaml.copy(save, 72);
  save.writeUInt32LE(crc32(save.subarray(4)), 0);
  return save;
}

import unicode from "./unicode-3.2.json";
const decomposition = unicode.decomposition as Record<string, number[]>;
const combining = unicode.combining as Record<string, number>;

/** Frozen BMP Unicode 3.2 canonical decomposition, with TN1150 exclusions. */
export function hfsName(input: string): string {
  if (!input || input === "." || input === ".." || /[\u0000-\u001f\u007f/:\\]/.test(input)) throw Error("Invalid HFS name");
  const units: number[] = [];
  function add(c: number) {
    if (c >= 0xac00 && c <= 0xd7a3) {
      const s = c - 0xac00;
      add(0x1100 + Math.floor(s / 588)); add(0x1161 + Math.floor((s % 588) / 28));
      if (s % 28) add(0x11a7 + s % 28);
    } else if (decomposition[c]) {
      for (const d of decomposition[c]) add(d);
    } else {
      const cc = combining[c] ?? 0;
      let at = units.length;
      if (cc) while (at && (combining[units[at - 1]] ?? 0) > cc) at--;
      units.splice(at, 0, c);
    }
  }
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const low = input.charCodeAt(++i);
      if (!(low >= 0xdc00 && low <= 0xdfff)) throw Error("Unpaired surrogate in HFS name");
      units.push(c, low);
    } else if (c >= 0xdc00 && c <= 0xdfff) throw Error("Unpaired surrogate in HFS name");
    else add(c);
  }
  if (units.length > 255) throw Error("HFS name exceeds 255 UTF-16 units after decomposition");
  return String.fromCharCode(...units);
}
export function hfsPath(path: string): string {
  if (typeof path !== "string" || path.length > 32768) throw Error("Invalid path");
  return path.split("/").map(hfsName).join("/");
}

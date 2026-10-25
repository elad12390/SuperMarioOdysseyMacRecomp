/**
 * Decode a Yaz0 container without changing the pinned shader splitter's rules.
 * Compatible with shader_split.py at nxnative 0045c1dfb639f9775891382646ad38c2a11c56bf:
 * reserved header bytes and trailing input are ignored, and the final match is
 * clipped to the declared size. Malformed references and truncated tokens fail.
 * The default bound matches the shader worker's 512 MiB candidate limit.
 */
export function decodeYaz0(input, { maxBytes = 512 * 1024 * 1024 } = {}) {
  if (!(input instanceof Uint8Array)) throw new TypeError('Yaz0: input must be a Uint8Array');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('Yaz0: maxBytes must be a nonnegative safe integer');
  }
  if (input.length < 16) throw new Error('Yaz0: truncated 16-byte header');
  if (input[0] !== 0x59 || input[1] !== 0x61 || input[2] !== 0x7a || input[3] !== 0x30) {
    throw new Error('Yaz0: invalid magic');
  }
  // Multiplication keeps the big-endian u32 unsigned, including sizes >= 2 GiB.
  const size = input[4] * 0x1000000 + (input[5] << 16) + (input[6] << 8) + input[7];
  if (size > maxBytes) throw new RangeError(`Yaz0: declared output ${size} exceeds maxBytes ${maxBytes}`);

  const output = new Uint8Array(size);
  let source = 16;
  let target = 0;
  while (target < size) {
    if (source >= input.length) throw new Error('Yaz0: truncated control byte');
    const control = input[source++];
    for (let mask = 0x80; mask !== 0 && target < size; mask >>= 1) {
      if (control & mask) {
        if (source >= input.length) throw new Error('Yaz0: truncated literal');
        output[target++] = input[source++];
        continue;
      }
      if (source + 2 > input.length) throw new Error('Yaz0: truncated back-reference');
      const first = input[source++];
      const distance = (((first & 0x0f) << 8) | input[source++]) + 1;
      let length = first >> 4;
      if (length === 0) {
        if (source >= input.length) throw new Error('Yaz0: truncated extended length');
        length = input[source++] + 0x12;
      } else {
        length += 2;
      }
      if (distance > target) throw new Error('Yaz0: back-reference precedes decoded output');
      // Upstream returns out[:n], even when the last complete token overruns n.
      length = Math.min(length, size - target);
      if (distance === 1) {
        output.fill(output[target - 1], target, target + length);
      } else if (length < 16) {
        // Forward copying is essential: later bytes may read this match's output.
        for (let i = 0; i < length; i++) output[target + i] = output[target + i - distance];
      } else {
        // Seed one period, then double only bytes already decoded. A single
        // memmove of an overlapping match would copy uninitialized output.
        let copied = Math.min(distance, length);
        output.copyWithin(target, target - distance, target - distance + copied);
        while (copied < length) {
          const count = Math.min(copied, length - copied);
          output.copyWithin(target + copied, target, target + count);
          copied += count;
        }
      }
      target += length;
    }
  }
  return output;
}

import { expect, test } from 'bun:test';
import { decodeYaz0 } from '../yaz0.mjs';

// All streams here are synthetic. No game bytes or private fixtures are needed.
function container(tokens, declaredSize) {
  const payload = [];
  const expected = [];
  for (let start = 0; start < tokens.length; start += 8) {
    const controlIndex = payload.length;
    payload.push(0);
    for (let bit = 0; bit < 8 && start + bit < tokens.length; bit++) {
      const token = tokens[start + bit];
      if (typeof token === 'number') {
        payload[controlIndex] |= 0x80 >> bit;
        payload.push(token);
        expected.push(token);
      } else {
        const { distance, length } = token;
        const offset = distance - 1;
        payload.push(((length < 18 ? length - 2 : 0) << 4) | (offset >> 8), offset & 0xff);
        if (length >= 18) payload.push(length - 18);
        for (let i = 0; i < length; i++) expected.push(expected[expected.length - distance]);
      }
    }
  }
  const input = new Uint8Array(16 + payload.length);
  input.set([0x59, 0x61, 0x7a, 0x30]);
  new DataView(input.buffer).setUint32(4, declaredSize ?? expected.length);
  input.set(payload, 16);
  return { input, expected: Uint8Array.from(expected).subarray(0, declaredSize ?? expected.length) };
}

test('empty output requires a complete header but no tokens', () => {
  expect(decodeYaz0(container([]).input, { maxBytes: 0 })).toEqual(new Uint8Array());
});

test('literal control bits run MSB first across groups and finish mid-group', () => {
  const { input, expected } = container(Array.from({ length: 259 }, (_, i) => i & 0xff));
  expect(decodeYaz0(input)).toEqual(expected);
});

test('reads a Uint8Array view at its actual byte offset without modifying input', () => {
  const { input, expected } = container([65, 66, { distance: 2, length: 273 }]);
  const backing = new Uint8Array(input.length + 11).fill(0xcc);
  backing.set(input, 7);
  const original = backing.slice();
  expect(decodeYaz0(backing.subarray(7, 7 + input.length))).toEqual(expected);
  expect(backing).toEqual(original);
});

test('preserves ignored reserved bytes, trailing padding and unused control bits', () => {
  const { input, expected } = container([65]);
  input.fill(0xa5, 8, 16);
  input[16] = 0xff;
  const padded = new Uint8Array(input.length + 9).fill(0x7f);
  padded.set(input);
  expect(decodeYaz0(padded)).toEqual(expected);
});

for (const length of [3, 15, 16, 17, 18, 19, 272, 273]) {
  for (const distance of [1, 2, 3, 16, 32]) {
    test(`expands length ${length} at distance ${distance}, including overlap`, () => {
      const literals = Array.from({ length: distance }, (_, i) => 65 + (i % 26));
      const { input, expected } = container([...literals, { distance, length }]);
      expect(decodeYaz0(input)).toEqual(expected);
    });
  }
}

test('decodes the full 12-bit distance and chained back-references', () => {
  const literals = Array.from({ length: 4096 }, (_, i) => (i * 17 + (i >> 8)) & 0xff);
  const { input, expected } = container([
    ...literals,
    { distance: 4096, length: 273 },
    { distance: 273, length: 273 },
    { distance: 2, length: 273 },
  ]);
  expect(decodeYaz0(input)).toEqual(expected);
});

test('clips the final complete match to the declared output like pinned Python', () => {
  for (const distance of [1, 2, 32]) {
    for (const remaining of [1, 2, 15, 16, 18, 272]) {
      const { input, expected } = container([
        ...Array.from({ length: distance }, (_, i) => i),
        { distance, length: 273 },
      ], distance + remaining);
      expect(decodeYaz0(input)).toEqual(expected);
    }
  }
});

test('deterministic mixed streams match a simple forward-copy oracle', () => {
  let state = 0x12345678;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  for (let sample = 0; sample < 64; sample++) {
    const tokens = [];
    let size = 0;
    for (let i = 0; i < 256; i++) {
      if (size === 0 || random() % 3 === 0) {
        tokens.push(random() & 0xff);
        size++;
      } else {
        const length = 3 + random() % 271;
        tokens.push({ distance: 1 + random() % Math.min(size, 4096), length });
        size += length;
      }
    }
    const { input, expected } = container(tokens);
    expect(decodeYaz0(input)).toEqual(expected);
  }
});

test('rejects every truncated prefix of a complete stream', () => {
  const { input } = container([65, 66, { distance: 2, length: 273 }, 67, 68, 69, 70, 71, 72]);
  for (let length = 0; length < input.length; length++) {
    expect(() => decodeYaz0(input.subarray(0, length))).toThrow(/Yaz0: truncated/);
  }
});

test('rejects truncated control, literal, short match and extended match separately', () => {
  const { input } = container([65, { distance: 1, length: 273 }]);
  for (const [length, message] of [[16, 'control'], [17, 'literal'], [18, 'back-reference'], [19, 'back-reference'], [20, 'extended length']]) {
    expect(() => decodeYaz0(input.subarray(0, length))).toThrow(`Yaz0: truncated ${message}`);
  }
});

test('rejects matches before any output and distances beyond initialized output', () => {
  for (const tokens of [[{ distance: 1, length: 3 }], [65, { distance: 2, length: 3 }], [65, { distance: 4096, length: 273 }]]) {
    expect(() => decodeYaz0(container(tokens).input)).toThrow(/back-reference precedes decoded output/);
  }
});

test('does not conceal missing match bytes just because the final output is clipped', () => {
  const { input } = container([65, { distance: 1, length: 273 }], 2);
  expect(() => decodeYaz0(input.subarray(0, input.length - 1))).toThrow(/truncated extended length/);
});

test('rejects output that ends before its declared size', () => {
  expect(() => decodeYaz0(container([65], 2).input)).toThrow(/truncated back-reference/);
});

test('validates magic and all 16 header bytes', () => {
  const { input } = container([]);
  for (let i = 0; i < 4; i++) {
    const invalid = input.slice();
    invalid[i] ^= 1;
    expect(() => decodeYaz0(invalid)).toThrow(/invalid magic/);
  }
  expect(() => decodeYaz0(input.subarray(0, 15))).toThrow(/truncated 16-byte header/);
});

test('enforces the output cap before allocating, with unsigned big-endian sizes', () => {
  const { input } = container([65]);
  expect(decodeYaz0(input, { maxBytes: 1 })).toEqual(Uint8Array.of(65));
  expect(() => decodeYaz0(input, { maxBytes: 0 })).toThrow(RangeError);
  for (const size of [512 * 1024 * 1024 + 1, 0x80000000, 0xffffffff]) {
    new DataView(input.buffer).setUint32(4, size);
    expect(() => decodeYaz0(input)).toThrow(`declared output ${size} exceeds maxBytes 536870912`);
  }
});

test('validates input and the configurable output bound', () => {
  for (const input of [null, undefined, [], 'Yaz0', new ArrayBuffer(16), new DataView(new ArrayBuffer(16)), new Uint16Array(16)]) {
    expect(() => decodeYaz0(input)).toThrow(TypeError);
  }
  for (const maxBytes of [-1, 1.5, NaN, Infinity, '1024', null, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => decodeYaz0(container([]).input, { maxBytes })).toThrow(RangeError);
  }
});

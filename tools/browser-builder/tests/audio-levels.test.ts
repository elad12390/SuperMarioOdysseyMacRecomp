import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { assertAudibleAudio } from './audio-levels';

const run = promisify(execFile);
let fixtures: string | undefined;

beforeAll(async () => {
  const parent = resolve(import.meta.dir, '../../../tmp/odyssey/browser-release');
  await mkdir(parent, { recursive: true });
  fixtures = await mkdtemp(join(parent, 'audio-levels-'));
  for (const [name, source] of [
    ['sine', 'sine=frequency=1000:sample_rate=48000:duration=0.25'],
    ['silence', 'anullsrc=channel_layout=stereo:sample_rate=48000'],
  ]) {
    await run('/opt/homebrew/bin/ffmpeg', [
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', source!,
      '-t', '0.25', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', join(fixtures, `${name}.wav`),
    ], { timeout: 5000, killSignal: 'SIGKILL' });
    const wav = await readFile(join(fixtures, `${name}.wav`));
    const fmt = wav.indexOf('fmt ');
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(fmt).toBeGreaterThanOrEqual(12);
    expect(wav.readUInt16LE(fmt + 8)).toBe(1);
    expect(wav.readUInt16LE(fmt + 10)).toBe(2);
    expect(wav.readUInt32LE(fmt + 12)).toBe(48000);
    expect(wav.readUInt16LE(fmt + 22)).toBe(16);
  }
}, 15000);

afterAll(async () => {
  if (fixtures) await rm(fixtures, { recursive: true });
});

test('accepts audible PCM16 stereo 48 kHz sine measured by real ffmpeg', async () => {
  const levels = await assertAudibleAudio(join(fixtures!, 'sine.wav'));
  expect(levels.exitCode).toBe(0);
  expect(levels.meanDb).toBeGreaterThan(-35);
  expect(levels.meanDb).toBeLessThan(-10);
  expect(levels.maxDb).toBeGreaterThan(-30);
  expect(levels.maxDb).toBeLessThan(-5);
  expect(levels.stderr).toContain('volumedetect');
  const tail = await assertAudibleAudio(join(fixtures!, 'sine.wav'), { lastSeconds: 0.1 });
  expect(tail.meanDb).toBeCloseTo(levels.meanDb, 0);
  expect(tail.lastSeconds).toBe(0.1);
  console.log(JSON.stringify({ fixture: 'sine', ...levels }));
}, 10000);

test('rejects valid but silent PCM16 stereo 48 kHz measured by real ffmpeg', async () => {
  const failure = await assertAudibleAudio(join(fixtures!, 'silence.wav'), { lastSeconds: 0.1 }).catch(error => error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain('Audio is not audible');
  expect((failure as Error).message).toContain('meanDb=');
  expect((failure as Error).message).toContain('maxDb=');
  console.log((failure as Error).message);
}, 10000);

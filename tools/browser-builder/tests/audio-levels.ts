import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const MIN_AUDIO_PEAK_DB = -60;
export const MIN_AUDIO_MEAN_DB = -75;
const run = promisify(execFile);

/** Measure the first audio stream, rejecting silence and failed/incomplete analysis. */
export async function assertAudibleAudio(path: string, options: { lastSeconds?: number } = {}) {
  const tail = options.lastSeconds;
  if (tail !== undefined && (!Number.isFinite(tail) || tail <= 0)) throw new Error('Audio interval must be a positive number of seconds');
  let stderr: string;
  try {
    ({ stderr } = await run('/opt/homebrew/bin/ffmpeg', [
      '-hide_banner', '-nostdin', '-nostats',
      ...(tail === undefined ? [] : ['-sseof', String(-tail)]),
      '-i', path, '-map', '0:a:0',
      '-vn', '-sn', '-dn', '-af', 'volumedetect', '-f', 'null', '-',
    ], { encoding: 'utf8', shell: false, timeout: 120000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 }));
  } catch (error) {
    const failure = error as Error & { code?: string | number; signal?: string; stderr?: string };
    throw new Error(`ffmpeg volumedetect failed for ${path} (exit=${failure.code ?? 'unknown'}, signal=${failure.signal ?? 'none'}):\n${failure.stderr ?? failure.message}`, { cause: error });
  }
  const meanDb = Number(/\bmean_volume:\s*(\S+)\s+dB\b/.exec(stderr)?.[1] ?? NaN);
  const maxDb = Number(/\bmax_volume:\s*(\S+)\s+dB\b/.exec(stderr)?.[1] ?? NaN);
  if (!Number.isFinite(meanDb) || !Number.isFinite(maxDb)) {
    throw new Error(`Missing or nonfinite ffmpeg audio levels for ${path} (exit=0):\n${stderr}`);
  }
  if (maxDb <= MIN_AUDIO_PEAK_DB || meanDb <= MIN_AUDIO_MEAN_DB) {
    throw new Error(`Audio is not audible for ${path}: meanDb=${meanDb}, maxDb=${maxDb} (exit=0; require meanDb>${MIN_AUDIO_MEAN_DB}, maxDb>${MIN_AUDIO_PEAK_DB})`);
  }
  return { meanDb, maxDb, lastSeconds: tail ?? null, exitCode: 0, stderr };
}

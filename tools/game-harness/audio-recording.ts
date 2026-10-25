import { open, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright-core";
import type { NativeTransport } from "./native-transport.ts";

type AudioStart = { ok: true; unixNs: string; rate: number; channels: number };
type AudioStop = { ok: true; unixNs: string; frames: number; droppedFrames: number; error: boolean };
type PreviewSample = { nativeUnixMs: number; paintUnixMs: number; latencyMs: number };
type PreviewWindow = Window & { __nativeAudioPreview?: PreviewSample[] };
type AudioSegment = {
  path: string; start?: AudioStart; stop?: AudioStop; usable?: boolean; error?: string;
  recovery?: { reason: string; headerBytes: number; pcmBytes: number; frames: number };
  previewDelayMs?: number; previewSampleCount?: number; offsetSamples?: number;
};

/** Observe the existing canvas draw event; no input or audio goes through the viewer. */
export async function observeAudioPreview(viewer: Page) {
  await viewer.addInitScript(() => {
    const samples: PreviewSample[] = [];
    (window as PreviewWindow).__nativeAudioPreview = samples;
    let lastSample = -Infinity;
    document.addEventListener("frame", event => {
      if (!(event.target instanceof HTMLCanvasElement) || event.target.id !== "game-frame") return;
      const timestamp = (event as CustomEvent<{ timestamp: number }>).detail?.timestamp;
      if (!Number.isFinite(timestamp) || performance.now() - lastSample < 250) return;
      lastSample = performance.now();
      requestAnimationFrame(() => {
        // The next rAF is the paint boundary after drawImage. Commit only once
        // the following rAF confirms that the browser had a chance to paint.
        const paintUnixMs = Date.now();
        requestAnimationFrame(() => {
          const latencyMs = paintUnixMs - timestamp;
          if (latencyMs < 0 || latencyMs > 5000) return;
          samples.push({ nativeUnixMs: timestamp, paintUnixMs, latencyMs });
          if (samples.length > 2048) samples.shift();
        });
      });
    }, true);
  });
}

export class NativeAudioRecording {
  readonly segments: AudioSegment[] = [];
  readonly errors: string[] = [];
  readonly metadataPath: string;
  private active?: AudioSegment;
  private previewSamples: PreviewSample[] = [];
  private previewReadError?: string;
  private videoDurationSeconds?: number;
  private webm?: string;
  private mp4?: string;

  constructor(private readonly artifacts: string, private readonly videoEpochMs: number) {
    this.metadataPath = join(artifacts, "native-audio.json");
  }

  async start(transport: NativeTransport) {
    if (this.active) throw new Error("Native audio is already recording");
    const segment: AudioSegment = { path: join(this.artifacts, `native-audio-${String(this.segments.length + 1).padStart(3, "0")}.wav`) };
    this.segments.push(segment); this.active = segment;
    try {
      const start = segment.start = await transport.request<AudioStart>(`audio-record ${segment.path}`);
      if (start.ok !== true || !/^\d+$/.test(start.unixNs) || BigInt(start.unixNs) <= 0n || start.rate !== 48000 || start.channels !== 2)
        throw new Error("Expected capture-start UTC nanoseconds and PCM16 stereo at 48000 Hz");
    } catch (error) { throw this.captureError(segment, "start", error); }
  }

  async stop(transport: NativeTransport) {
    const segment = this.active;
    if (!segment) return;
    try {
      const stop = segment.stop = await transport.request<AudioStop>("audio-stop");
      if (stop.ok !== true || !segment.start || stop.unixNs !== segment.start.unixNs ||
          !Number.isSafeInteger(stop.frames) || stop.frames <= 0 ||
          !Number.isSafeInteger(stop.droppedFrames) || stop.droppedFrames < 0 || typeof stop.error !== "boolean")
        throw new Error("Invalid or empty native audio capture, or capture-start timestamp changed");
      const wav = await stat(segment.path);
      if (!wav.isFile() || wav.size < 44 + stop.frames * 4) throw new Error("Native WAV is missing or shorter than its reported PCM frames");
      segment.usable = true;
      if (stop.error || stop.droppedFrames) throw new Error(`Native audio capture error=${stop.error}, droppedFrames=${stop.droppedFrames}`);
    } catch (error) { throw this.captureError(segment, "stop", error); }
    finally { this.active = undefined; }
  }

  private captureError(segment: AudioSegment, operation: string, error: unknown) {
    const message = `Native audio ${operation} (${segment.path}): ${error}`;
    segment.error = message; this.errors.push(message);
    return new Error(message);
  }

  /** Salvage only the native recorder's fixed PCM layout; never validate a failed stop. */
  private async recover(segment: AudioSegment) {
    const start = segment.start;
    if (start?.ok !== true || typeof start.unixNs !== "string" || !/^\d+$/.test(start.unixNs) ||
        BigInt(start.unixNs) <= 0n || start.rate !== 48000 || start.channels !== 2 ||
        !Number.isSafeInteger(this.videoEpochMs) || this.videoEpochMs <= 0) return;
    try {
      const file = await open(segment.path, "r");
      let pcmBytes: number;
      try {
        const wav = await file.stat();
        pcmBytes = wav.size - 44;
        if (!wav.isFile() || !Number.isSafeInteger(pcmBytes) || pcmBytes <= 0 || pcmBytes % 4) return;
        const header = Buffer.alloc(44);
        const { bytesRead } = await file.read(header, 0, 44, 0);
        if (bytesRead !== 44 || header.toString("ascii", 0, 4) !== "RIFF" ||
            header.toString("ascii", 8, 16) !== "WAVEfmt " || header.readUInt32LE(16) !== 16 ||
            header.readUInt16LE(20) !== 1 || header.readUInt16LE(22) !== 2 ||
            header.readUInt32LE(24) !== 48000 || header.readUInt32LE(28) !== 192000 ||
            header.readUInt16LE(32) !== 4 || header.readUInt16LE(34) !== 16 ||
            header.toString("ascii", 36, 40) !== "data") return;
      } finally { await file.close(); }
      const reason = segment.error ?? "Native audio stop did not complete; recovered existing PCM only";
      segment.recovery = { reason, headerBytes: 44, pcmBytes, frames: pcmBytes / 4 };
      // A muxable recovery is still incomplete capture, with no fabricated stop metadata.
      if (!segment.error) this.captureError(segment, "recovery", reason);
    } catch (error) { this.captureError(segment, "recovery", error); }
  }

  async collectPreview(viewer: Page) {
    try { this.previewSamples = await viewer.evaluate(() => (window as PreviewWindow).__nativeAudioPreview ?? []); }
    catch (error) { this.previewReadError = String(error); }
  }

  async saveMetadata() {
    await writeFile(this.metadataPath, JSON.stringify({
      source: "native-played-game-audio", format: "pcm_s16le", rate: 48000, channels: 2,
      videoEpochMs: this.videoEpochMs, videoDurationSeconds: this.videoDurationSeconds,
      sync: "offsetSamples = round(((captureUnixNs - videoEpochMs * 1000000) / 1000000 + previewDelayMs) * 48)",
      previewMeasurement: "Median native UTC to next rAF after canvas frame draw, committed after the following rAF; per-segment samples",
      fallbackPreviewDelayMs: 20, previewReadError: this.previewReadError, previewSamples: this.previewSamples,
      segments: this.segments, errors: this.errors, webm: this.webm, mp4: this.mp4,
    }, null, 2) + "\n");
  }

  /** Keep the entire browser video; silence fills intro, restart gaps and the ending card. */
  async mux(webm: string, mp4: string) {
    this.webm = webm;
    try {
      const probe = Bun.spawn(["/opt/homebrew/bin/ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", webm],
        { stdout: "pipe", stderr: "pipe" });
      const [probeOutput, probeError, probeExit] = await Promise.all([new Response(probe.stdout).text(), new Response(probe.stderr).text(), probe.exited]);
      if (probeExit) throw new Error(`Cannot read original video duration: ${probeError}`);
      const duration = this.videoDurationSeconds = Number(JSON.parse(probeOutput).format?.duration);
      if (!Number.isFinite(duration) || duration <= 0) throw new Error("Original video has no valid duration");
      for (const segment of this.segments) if (!segment.usable) await this.recover(segment);
      const segments = this.segments.filter(segment => segment.usable || segment.recovery);
      if (!segments.length) this.errors.push("No usable native game audio was captured");
      const inputs: string[] = [];
      const filters = [`anullsrc=r=48000:cl=stereo,atrim=duration=${duration}[silence]`];
      for (const [index, segment] of segments.entries()) {
        const start = segment.start!;
        const frames = segment.recovery?.frames ?? segment.stop!.frames;
        const nativeStartMs = Number(BigInt(start.unixNs) / 1000000n);
        const delays = this.previewSamples.filter(sample => sample.nativeUnixMs >= nativeStartMs &&
          sample.nativeUnixMs <= nativeStartMs + frames / 48).map(sample => sample.latencyMs).sort((a, b) => a - b);
        segment.previewSampleCount = delays.length;
        const middle = Math.floor(delays.length / 2);
        segment.previewDelayMs = delays.length ? (delays[middle]! + delays[Math.floor((delays.length - 1) / 2)]!) / 2 : 20;
        // Subtract in integer nanoseconds before converting so UTC precision is retained.
        const offsetMs = Number(BigInt(start.unixNs) - BigInt(this.videoEpochMs) * 1000000n) / 1000000 + segment.previewDelayMs;
        const offset = segment.offsetSamples = Math.round(offsetMs * 48);
        if (segment.recovery) inputs.push("-f", "s16le", "-ar", "48000", "-ac", "2", "-skip_initial_bytes", String(segment.recovery.headerBytes));
        inputs.push("-i", segment.path);
        filters.push(`[${index + 1}:a:0]atrim=start_sample=${Math.max(0, -offset)}:end_sample=${frames},asetpts=PTS-STARTPTS,adelay=${Math.max(0, offset)}S:all=1[a${index}]`);
      }
      filters.push(`[silence]${segments.map((_, index) => `[a${index}]`).join("")}amix=inputs=${segments.length + 1}:duration=first:normalize=0:dropout_transition=0[audio]`);
      const ffmpeg = Bun.spawn(["/opt/homebrew/bin/ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", webm, ...inputs,
        "-filter_complex", filters.join(";"), "-map", "0:v:0", "-map", "[audio]",
        "-vf", "scale=1280:720", "-c:v", "libx264", "-preset", "medium", "-crf", "28", "-fps_mode:v", "passthrough",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", mp4],
        { stdout: "ignore", stderr: "pipe" });
      const conversionError = await new Response(ffmpeg.stderr).text();
      if (await ffmpeg.exited) throw new Error(`Video/audio conversion failed; original recording is ${webm}: ${conversionError}`);
      this.mp4 = mp4;
    } catch (error) { this.errors.push(String(error)); }
    finally { await this.saveMetadata(); }
    if (this.errors.length) throw new Error(`Native audio recording incomplete; see ${this.metadataPath}: ${this.errors.join("; ")}`);
  }
}

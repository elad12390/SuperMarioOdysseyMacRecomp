import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { NativeAudioRecording, observeAudioPreview } from "./audio-recording.ts";
import { connectNativeGame, type NativeGameConnection } from "./native-page.ts";
import { createActionRecording, type RecordingResult } from "./recording.ts";
import { ensureBridge, gameInstance, type InstanceStatus } from "./manager.ts";

/** Every game test records the real Playwright viewport, including failures. */
export async function createGameTest(name: string, options: { title: string; description: string; actions: string[]; fps?: 60 | 120 }) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error("Use a simple test name");
  if (!options.actions.length) throw new Error("Plan the test actions before recording so failures can identify steps not run");
  const instance = gameInstance();
  if (instance.role !== "tests") throw new Error("createGameTest requires the Tests instance; Player observation uses connectNativeGame explicitly");
  await ensureBridge(instance);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const artifacts = resolve(import.meta.dir, `../../tmp/odyssey/harness/${stamp}-${name}`);
  await mkdir(artifacts, { recursive: true });
  const executablePath = process.env.GAME_HARNESS_CHROMIUM || join(homedir(), ".cache/going-up-browsers/chrome-headless-shell/ext/chrome-headless-shell-mac-arm64/chrome-headless-shell");
  const fps = options.fps ?? 60;
  const browser = await chromium.launch({ executablePath, headless: true,
    ...(fps > 60 ? { args: ["--disable-frame-rate-limit", "--disable-gpu-vsync"] } : {}) });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1,
    recordVideo: { dir: artifacts, size: { width: 1280, height: 720 }, fps },
  });
  const recordingStartedAt = performance.now();
  const videoEpochMs = Date.now();
  const viewer = await context.newPage();
  const audio = new NativeAudioRecording(artifacts, videoEpochMs);
  let viewerInputRequests = 0;
  viewer.on("request", request => { if (new URL(request.url()).pathname === "/api/input") viewerInputRequests++; });
  await viewer.route("**/api/input", route => route.abort("blockedbyclient"));
  let game: NativeGameConnection | undefined;
  let viewerUpdates: Promise<unknown> = Promise.resolve();
  let recording: Awaited<ReturnType<typeof createActionRecording>> | undefined;
  let finished = false;
  let stepFailure: unknown;
  let audioStarted = false;
  let processStarted = false;
  const runs: InstanceStatus[] = [];
  const timeline: { label: string; startSeconds: number; endSeconds: number; failed: boolean }[] = [];
  const finish = async (error?: unknown) => {
      if (finished) throw new Error("Test was already finalized");
      finished = true;
      await game?.release().catch(() => {});
      await viewerUpdates.catch(() => {});
      let cause: unknown = error ?? stepFailure ?? (viewerInputRequests ? new Error("The viewer attempted to relay controller input") : undefined);
      let result: RecordingResult | undefined;
      let recorderError: unknown;
      try { result = await recording?.end(cause); }
      catch (error) { recorderError = error; console.error("Recording result card:", error); }
      if (game && audioStarted) {
        await audio.stop(game.transport).catch(error => { cause ??= error; console.error("Native audio capture:", error); });
        audioStarted = false;
      }
      if (game && processStarted) await game.stop().catch(error => { cause ??= error; });
      await audio.collectPreview(viewer);
      await audio.saveMetadata();
      const saveResult = async () => writeFile(join(artifacts, "test-result.json"), JSON.stringify({ title: options.title ?? name,
        description: options.description, controlBackend: "native-unix-socket", viewerInputRequests,
        instance, runs, saveDirectory: runs.at(-1)?.saveDirectory ?? null,
        settingsPath: runs.at(-1)?.settingsPath ?? null, automatedInput: true,
        failed: cause !== undefined || Boolean(result?.failed) || Boolean(recorderError), error: cause === undefined ? null : String(cause),
        audio: { metadata: audio.metadataPath, errors: audio.errors },
        result, timeline, ...(recorderError ? { recorderError: String(recorderError) } : {}) }, null, 2) + "\n");
      await saveResult();
      await recording?.close().catch(() => {});
      await viewer.screenshot({ path: join(artifacts, "recording-cover.png") }).catch(() => {});
      const video = viewer.video();
      game?.transport.close();
      await context.close();
      const webm = await video!.path();
      await browser.close();
      const mp4 = join(artifacts, "playwright-recording-compressed.mp4");
      try { await audio.mux(webm, mp4); }
      catch (error) { cause ??= error; }
      await saveResult();
      console.log(`PLAYWRIGHT_VIDEO=${mp4}`);
      if (cause !== undefined) throw cause;
      if (recorderError && cause === undefined) throw recorderError;
      if (result?.failed && cause === undefined) throw new Error("The recording ended with incomplete or failed actions; see test-result.json");
      return { webm, mp4, result };
  };
  try {
    await observeAudioPreview(viewer);
    game = await connectNativeGame(viewer, keys => {
      // Recording decoration is asynchronous and never delays native input.
      viewerUpdates = viewerUpdates.catch(() => {}).then(() => viewer.evaluate(keys => {
        window.dispatchEvent(new CustomEvent("native-keys", { detail: keys }));
      }, keys));
    }, { instance });
    const connection = game;
    const start = connection.start.bind(connection), stop = connection.stop.bind(connection);
    connection.start = async options => {
      if (audioStarted) { await audio.stop(connection.transport); audioStarted = false; }
      const status = await start(options);
      processStarted = true; runs.push(status);
      if (!status.running) throw new Error("The native game did not start for audio capture");
      audioStarted = true; await audio.start(connection.transport);
      return status;
    };
    connection.stop = async () => {
      let captureError: unknown;
      if (audioStarted) {
        await audio.stop(connection.transport).catch(error => { captureError = error; });
        audioStarted = false;
      }
      const status = await stop();
      processStarted = false;
      if (captureError) throw captureError;
      return status;
    };
    recording = await createActionRecording(viewer, { title: options.title, description: options.description, actions: options.actions });
    if ((await connection.status()).running) throw new Error("Tests already owns a running game; finish that run before creating another fixture");
    await viewer.screenshot({ path: join(artifacts, "recording-intro.png") });
  }
  catch (error) { await finish(error); throw error; }
  return { page: game.page, viewer, game, artifacts, finish,
    async step<T>(label: string, fn: () => Promise<T>) {
      const startSeconds = (performance.now() - recordingStartedAt) / 1000;
      console.log(`STEP_START=${label}`);
      let failed = false;
      try { return await recording!.step(label, async () => {
        const value = await fn();
        if (viewerInputRequests) throw new Error("The viewer attempted to relay controller input");
        return value;
      }); }
      catch (error) { failed = true; stepFailure ??= error; throw error; }
      finally { timeline.push({ label, startSeconds, endSeconds: (performance.now() - recordingStartedAt) / 1000, failed }); console.log(`STEP_${failed ? "FAILED" : "PASSED"}=${label}`); }
    } };
}

import type { Page } from "playwright-core";
import type { BrowserGame } from "./client.ts";

type ActionRecording = {
  step<T>(label: string, fn: () => Promise<T>): Promise<T>;
  end(error?: unknown): Promise<RecordingResult>;
  close(): Promise<void>;
};

export type RecordingResult = { failed: boolean; succeeded: number; failedActions: string[]; notRun: string[]; error: string | null };

type RecordingController = {
  begin(label: string): Promise<void>;
  finish(failed: boolean): Promise<void>;
  end(error: string | null): Promise<RecordingResult>;
  close(): void;
};

type RecordingWindow = Window & {
  game: BrowserGame;
  __gameActionRecording?: RecordingController;
};

const maxActions = 64;
const maxLabelLength = 240;

function actionLabel(value: string): string {
  const label = value.trim();
  if (!label || label.length > maxLabelLength) {
    throw new Error(`Recording labels must contain 1-${maxLabelLength} characters`);
  }
  return label;
}

/**
 * Add a passive recording layout after connectGame(), at a 1600x900 viewport.
 * Planned actions appear immediately; unplanned labels are appended as needed.
 * Steps must run sequentially. close() freezes the final layout for the video
 * and stops this helper's observers; the caller still owns the page and game.
 */
export async function createActionRecording(
  page: Page,
  options: { title?: string; description?: string; actions?: string[] } = {},
): Promise<ActionRecording> {
  const actions = (options.actions ?? []).map(actionLabel);
  if (actions.length > maxActions) throw new Error(`A recording supports at most ${maxActions} actions`);
  const title = actionLabel(options.title ?? "Native game recording");
  const description = (options.description ?? "Drive the real native game through Playwright, verify the listed actions, and record the result.").trim();
  if (!description || description.length > 1200) throw new Error("A test description must contain 1-1200 characters");

  await page.evaluate(({ title, description, actions, maxActions }) => {
    const host = window as RecordingWindow;
    const root = document.documentElement;
    const candidate = document.querySelector<HTMLCanvasElement>("#game-frame");
    const main = candidate?.closest("main");
    if (!root.classList.contains("game-view") || !main || !(candidate instanceof HTMLCanvasElement) || !host.game?.status) {
      throw new Error("Connect to the harness /?view=game page before creating a recording");
    }
    const frame: HTMLCanvasElement = candidate;
    if (window.innerWidth !== 1600 || window.innerHeight !== 900) {
      throw new Error("The action recording layout requires a 1600x900 page viewport");
    }
    if (host.__gameActionRecording) throw new Error("This page already has an active action recording");

    // A closed recording may leave its final layout on this same page.
    document.querySelectorAll("[data-action-recording-ui]").forEach(node => node.remove());
    root.setAttribute("data-action-recording", "");

    function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
      const node = document.createElement(tag);
      node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }
    function owned<T extends HTMLElement>(node: T): T {
      node.setAttribute("data-action-recording-ui", "");
      return node;
    }

    const style = owned(element("style", ""));
    style.textContent = `
      html.game-view[data-action-recording], html.game-view[data-action-recording] body {
        width: 100%; height: 100%; overflow: hidden; background: #0b111b;
      }
      html.game-view[data-action-recording] main {
        position: fixed; inset: 0 0 0 280px; width: calc(100vw - 280px); height: 100vh;
        max-width: none; margin: 0; padding: 0; display: grid;
        grid-template-columns: 1280px; grid-template-rows: minmax(0, 1fr) 720px minmax(0, 1fr);
        justify-content: center; justify-items: stretch; align-items: stretch; align-content: stretch;
      }
      html.game-view[data-action-recording] main > .viewport {
        grid-column: 1; grid-row: 2; width: 1280px; height: 720px;
        min-width: 1280px; min-height: 720px; aspect-ratio: 16 / 9; margin: 0; padding: 0;
      }
      html.game-view[data-action-recording] #game-frame {
        width: 1280px; height: 720px; max-width: none; max-height: none; object-fit: contain;
      }
      html.game-view[data-action-recording] #error { left: 300px; right: 20px; bottom: 100px; }
      [data-action-recording-ui] { box-sizing: border-box; pointer-events: none; }
      .ar-sidebar {
        position: fixed; z-index: 3; inset: 0 auto 0 0; width: 280px; padding: 22px 15px 16px;
        display: flex; flex-direction: column; gap: 16px; border-right: 1px solid #324255;
        background: #111a27; color: #f1f5fb; font: 15px/1.4 system-ui, sans-serif;
      }
      .ar-eyebrow { margin: 0; color: #a9bbd1; font-size: 12px; font-weight: 650; letter-spacing: .1em; }
      .ar-recording-title {
        margin: 6px 0 8px; font-size: 22px; line-height: 1.2; font-weight: 700;
        display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
        overflow-wrap: anywhere;
      }
      .ar-progress { color: #b8c7d9; font-size: 14px; font-variant-numeric: tabular-nums; }
      .ar-actions {
        flex: 1; min-height: 0; margin: 0; padding: 0; list-style: none;
        display: flex; flex-direction: column; gap: 8px; overflow-y: auto; overflow-x: hidden;
        scrollbar-width: none; overscroll-behavior: contain; scroll-behavior: auto;
      }
      .ar-action {
        flex: none; display: grid; grid-template-columns: 104px minmax(0, 1fr); align-items: center;
        gap: 10px; min-height: 86px; padding: 10px 8px; border: 2px solid #344257;
        border-radius: 9px; background: #182333; color: #dce5f0;
      }
      .ar-action[data-state="active"] {
        border-color: #72d9ff; background: #143a51; color: #fff; box-shadow: inset 4px 0 #72d9ff;
      }
      .ar-action[data-state="done"] { border-color: #42685b; }
      .ar-action[data-state="failed"] { border-color: #ff9393; background: #48242e; }
      .ar-action[data-state="not-run"] { border-style: dashed; opacity: .65; }
      .ar-thumb {
        width: 104px; height: 58px; overflow: hidden; border-radius: 4px;
        background: #0c1420; display: grid; place-items: center;
      }
      .ar-thumb canvas { display: block; width: 104px; height: 58px; }
      .ar-thumb [hidden] { display: none; }
      .ar-placeholder { padding: 5px; color: #94a7bd; font-size: 12px; text-align: center; }
      .ar-action-label { font-size: 16px; line-height: 1.25; font-weight: 650; overflow-wrap: anywhere; }
      .ar-action-meta { margin-top: 5px; color: #b8c7d9; font-size: 14px; font-variant-numeric: tabular-nums; }
      .ar-action[data-state="active"] .ar-action-meta { color: #b7edff; font-weight: 700; }
      .ar-action[data-state="done"] .ar-action-meta { color: #a1dbbd; }
      .ar-action[data-state="failed"] .ar-action-meta { color: #ffc5c5; }
      .ar-note { color: #a9bbd1; font-size: 12px; line-height: 1.45; }
      /* Fit seven actions at the recording height without reducing label sizes. */
      @media (max-height: 960px) {
        .ar-sidebar { padding: 18px 12px 14px; gap: 12px; }
        .ar-actions { gap: 6px; }
        .ar-action {
          grid-template-columns: 80px minmax(0, 1fr); gap: 8px;
          min-height: 72px; padding: 6px 8px;
        }
        .ar-thumb, .ar-thumb canvas { width: 80px; height: 45px; }
        .ar-action-meta { margin-top: 4px; }
      }
      .ar-current {
        grid-column: 1; grid-row: 1; display: flex; align-items: center; justify-content: space-between;
        gap: 24px; min-width: 0; color: #f1f5fb; pointer-events: none;
      }
      .ar-current-copy { min-width: 0; }
      .ar-current-title {
        margin: 4px 0 0; font: 700 25px/1.15 system-ui, sans-serif; overflow-wrap: anywhere;
        display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
      }
      .ar-current-state { flex: none; color: #b7edff; font-size: 15px; font-weight: 650; }
      .ar-hud {
        grid-column: 1; grid-row: 3; display: flex; flex-direction: column; justify-content: center;
        gap: 8px; min-width: 0; color: #dce5f0; pointer-events: none;
      }
      .ar-key-row, .ar-keys, .ar-metrics { display: flex; align-items: center; gap: 8px; min-width: 0; }
      .ar-key-row { min-height: 30px; }
      .ar-key-label { margin-right: 4px; color: #a9bbd1; font-size: 13px; font-weight: 650; }
      .ar-keys { flex: 1; overflow: hidden; white-space: nowrap; }
      .ar-key {
        flex: none; display: inline-flex; align-items: center; min-width: 32px; height: 30px;
        justify-content: center; padding: 0 9px; border: 1px solid #74ccee; border-radius: 5px;
        background: #193a50; color: #edfbff; font: 650 15px ui-monospace, monospace;
      }
      .ar-idle-keys { color: #a9bbd1; font-size: 14px; }
      .ar-native-state { flex: none; color: #b8c7d9; font-size: 14px; }
      .ar-metrics { gap: 28px; font-size: 14px; }
      .ar-metric { display: flex; gap: 8px; align-items: baseline; color: #a9bbd1; }
      .ar-metric-value { color: #f1f5fb; font-size: 17px; font-weight: 650; font-variant-numeric: tabular-nums; }
      .ar-slate {
        position: fixed; z-index: 4; left: 300px; top: 90px; width: 1280px; height: 720px;
        padding: 36px 48px; display: flex; flex-direction: column; justify-content: center;
        gap: 22px; color: #f1f5fb; background: #101b2b; font: 20px/1.45 system-ui, sans-serif;
        border: 1px solid #40536d; border-top: 6px solid #72d9ff;
      }
      .ar-slate[hidden] { display: none; }
      .ar-slate[data-result="passed"] { border-top-color: #a1dbbd; }
      .ar-slate[data-result="failed"] { border-top-color: #ff9393; }
      .ar-slate[data-result] { padding: 36px 48px; gap: 16px; }
      .ar-slate h2 { margin: 0; font-size: 42px; line-height: 1.15; overflow-wrap: anywhere; }
      .ar-slate p { margin: 0; }
      .ar-slate .ar-purpose { font-size: 24px; line-height: 1.45; color: #c5d4e6; max-width: 1080px; }
      .ar-slate .ar-result-detail { padding: 16px 20px; background: #1a293d; border-radius: 8px; overflow-wrap: anywhere; white-space: pre-wrap; font-size: 18px; min-height: 104px; max-height: 240px; overflow: auto; }
      .ar-slate .ar-unrun { display: grid; grid-template-columns: 1fr 1fr; column-gap: 32px; row-gap: 7px; padding-left: 24px; margin: 0; font-size: 18px; }
    `;
    document.head.append(style);

    const sidebar = owned(element("aside", "ar-sidebar"));
    sidebar.setAttribute("aria-label", "Recording actions");
    const heading = element("div", "");
    const progress = element("div", "ar-progress");
    heading.append(element("p", "ar-eyebrow", "ACTION RECORDING"), element("h1", "ar-recording-title", title), progress);
    const list = element("ol", "ar-actions");
    sidebar.append(heading, list, element("div", "ar-note", "Each thumbnail shows the latest captured game view for that action."));
    document.body.append(sidebar);

    const current = owned(element("div", "ar-current"));
    const currentCopy = element("div", "ar-current-copy");
    const currentCaption = element("div", "ar-eyebrow", "CURRENT ACTION");
    const currentTitle = element("h2", "ar-current-title", "Waiting for the first action");
    const currentState = element("div", "ar-current-state", "Ready");
    currentCopy.append(currentCaption, currentTitle);
    current.append(currentCopy, currentState);
    main.prepend(current);

    const hud = owned(element("div", "ar-hud"));
    const keyRow = element("div", "ar-key-row");
    const keyChips = element("div", "ar-keys");
    const nativeState = element("div", "ar-native-state", "Reading native status");
    keyRow.append(element("span", "ar-key-label", "KEYS"), keyChips, nativeState);
    const metrics = element("div", "ar-metrics");
    function metric(label: string) {
      const item = element("div", "ar-metric");
      const value = element("span", "ar-metric-value", "Measuring");
      item.append(element("span", "", label), value);
      metrics.append(item);
      return value;
    }
    const renderFPS = metric("Render");
    const simulationFPS = metric("Simulation");
    const previewFPS = metric("Preview");
    hud.append(keyRow, metrics);
    main.append(hud);

    const slate = owned(element("section", "ar-slate"));
    slate.setAttribute("aria-label", "Test introduction and result");
    slate.append(element("p", "ar-eyebrow", "PLAYWRIGHT GAME TEST"), element("h2", "", title),
      element("p", "ar-purpose", description), element("p", "ar-eyebrow", `${actions.length} PLANNED ACTIONS`));
    const plan = element("ol", "ar-unrun");
    actions.slice(0, 12).forEach(label => plan.append(element("li", "", label)));
    if (actions.length > 12) plan.append(element("li", "", `Plus ${actions.length - 12} more in the action list`));
    slate.append(plan);
    document.body.append(slate);

    type State = "pending" | "active" | "done" | "failed" | "not-run";
    type Row = {
      label: string; state: State; item: HTMLLIElement; meta: HTMLDivElement;
      thumbnail: HTMLCanvasElement; placeholder: HTMLDivElement;
    };
    const rows: Row[] = [];
    let active: Row | undefined;
    let disposed = false;
    let paintFrame = 0;
    let resolvePaint: (() => void) | undefined;
    const listeners = new AbortController();

    function updateProgress() {
      const succeeded = rows.filter(row => row.state === "done").length;
      const failed = rows.filter(row => row.state === "failed").length;
      progress.textContent = failed ? `${succeeded} succeeded / ${failed} failed` : `${succeeded} / ${rows.length} actions succeeded`;
    }
    function addRow(label: string): Row {
      if (rows.length >= maxActions) throw new Error(`A recording supports at most ${maxActions} actions`);
      const item = element("li", "ar-action");
      item.dataset.state = "pending";
      const thumb = element("div", "ar-thumb");
      const thumbnail = element("canvas", "");
      thumbnail.width = 104; thumbnail.height = 58; thumbnail.hidden = true;
      thumbnail.setAttribute("aria-label", `Real game snapshot: ${label}`);
      const placeholder = element("div", "ar-placeholder", "Not captured");
      thumb.append(thumbnail, placeholder);
      const copy = element("div", "");
      const meta = element("div", "ar-action-meta", `${String(rows.length + 1).padStart(2, "0")} / Pending`);
      copy.append(element("div", "ar-action-label", label), meta);
      item.append(thumb, copy);
      const row: Row = { label, state: "pending", item, meta, thumbnail, placeholder };
      rows.push(row); list.append(item); updateProgress();
      return row;
    }
    function setState(row: Row, state: State) {
      row.state = state;
      row.item.dataset.state = state;
      row.meta.textContent = `${String(rows.indexOf(row) + 1).padStart(2, "0")} / ${state === "not-run" ? "Not run" : state[0]!.toUpperCase() + state.slice(1)}`;
      if (state === "active") row.item.setAttribute("aria-current", "step");
      else row.item.removeAttribute("aria-current");
      updateProgress();
    }
    function capture(row: Row) {
      if (!frame.dataset.frame) {
        if (row.thumbnail.hidden) row.placeholder.textContent = row.state === "active" ? "Awaiting frame" : "No game frame";
        return;
      }
      const context = row.thumbnail.getContext("2d", { alpha: false });
      if (!context) return;
      // Copy only 104x58 pixels. No full-size images or data URLs are retained.
      context.imageSmoothingQuality = "high";
      context.drawImage(frame, 0, 0, 104, 58);
      row.thumbnail.hidden = false; row.placeholder.hidden = true;
      row.thumbnail.dataset.frame = frame.dataset.frame;
    }
    function alignList() {
      // Keep the top of the visible list on a whole card after auto-scrolling.
      const top = rows.find(row => row.item.offsetTop - list.offsetTop >= list.scrollTop);
      if (top) list.scrollTop = top.item.offsetTop - list.offsetTop;
    }
    function afterPaint(): Promise<void> {
      // The second callback allows a paint of the new state before fn() starts.
      return new Promise(resolve => {
        resolvePaint = resolve;
        paintFrame = requestAnimationFrame(() => {
          paintFrame = requestAnimationFrame(() => {
            paintFrame = 0; resolvePaint = undefined; resolve();
          });
        });
      });
    }
    actions.forEach(addRow);
    updateProgress();

    const held = new Map<string, string>();
    const keyNames: Record<string, string> = {
      Space: "Space", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
      Enter: "Enter", Tab: "Tab", Escape: "Esc",
    };
    function renderKeys() {
      keyChips.replaceChildren();
      if (!held.size) keyChips.append(element("span", "ar-idle-keys", "No keys pressed"));
      for (const name of held.values()) keyChips.append(element("kbd", "ar-key", name));
    }
    function onKey(event: KeyboardEvent) {
      if (event.type === "keyup") held.delete(event.code);
      else if (!held.has(event.code) && held.size < 16) {
        held.set(event.code, (keyNames[event.code] ?? event.code.replace(/^(Key|Digit)/, "")).slice(0, 24));
      } else return;
      renderKeys();
    }
    function clearKeys() { held.clear(); renderKeys(); }
    const passive = { capture: true, passive: true, signal: listeners.signal };
    window.addEventListener("keydown", onKey, passive);
    window.addEventListener("keyup", onKey, passive);
    window.addEventListener("native-keys", event => {
      held.clear();
      for (const key of (event as CustomEvent<string[]>).detail)
        held.set(key, keyNames[key] ?? key.toUpperCase());
      renderKeys();
    }, { signal: listeners.signal });
    window.addEventListener("blur", clearKeys, passive);
    document.addEventListener("visibilitychange", () => { if (document.hidden) clearKeys(); }, passive);
    renderKeys();

    // Count actual draws emitted by the existing canvas stream, never rAF ticks.
    let previewFrames = 0;
    let previewSample = { at: performance.now(), frames: 0 };
    frame.addEventListener("frame", () => { previewFrames++; }, { signal: listeners.signal });
    let nativeSample: { at: number; pid: number | null; frame: number; ticks: number | undefined } | undefined;
    let polling = false;
    let lastPoll = -Infinity;
    const fps = (count: number, seconds: number) => `${(count / seconds).toFixed(1)} FPS`;

    async function pollNative() {
      polling = true;
      lastPoll = performance.now();
      try {
        const status = await host.game.status();
        if (disposed) return;
        const native = status.native;
        if (status.error || !status.running || !native) {
          nativeSample = undefined;
          nativeState.textContent = status.error ? "Native status error" : status.running ? "Waiting for native counters" : "Native game stopped";
          renderFPS.textContent = simulationFPS.textContent = "Unavailable";
          return;
        }
        const at = performance.now();
        const ticks = native.timing?.logicTicks;
        nativeState.textContent = `Native game running / frame ${native.frame}`;
        const previous = nativeSample;
        const seconds = previous ? (at - previous.at) / 1000 : 0;
        const valid = previous && previous.pid === status.pid && seconds > 0 && native.frame >= previous.frame;
        renderFPS.textContent = valid && Number.isFinite(native.frame) ? fps(native.frame - previous.frame, seconds) : "Measuring";
        simulationFPS.textContent = valid && ticks !== undefined && previous.ticks !== undefined && ticks >= previous.ticks && Number.isFinite(ticks)
          ? fps(ticks - previous.ticks, seconds) : ticks === undefined ? "Unavailable" : "Measuring";
        nativeSample = { at, pid: status.pid, frame: native.frame, ticks };
      } catch {
        if (!disposed) {
          nativeSample = undefined;
          nativeState.textContent = "Native status unavailable";
          renderFPS.textContent = simulationFPS.textContent = "Unavailable";
        }
      } finally { polling = false; }
    }
    function tick() {
      const now = performance.now();
      const seconds = (now - previewSample.at) / 1000;
      if (seconds >= 1) {
        previewFPS.textContent = fps(previewFrames - previewSample.frames, seconds);
        previewSample = { at: now, frames: previewFrames };
      }
      // At most one status call per second, with no overlapping requests.
      if (!polling && now - lastPoll >= 1000) void pollNative();
    }
    tick();
    const timer = window.setInterval(tick, 1000);

    const controller: RecordingController = {
      async begin(label) {
        if (disposed) throw new Error("The action recording is closed");
        if (active) throw new Error("Recording steps must run sequentially");
        slate.hidden = true;
        const row = rows.find(row => row.state === "pending" && row.label === label) ?? addRow(label);
        active = row;
        setState(row, "active"); capture(row);
        currentCaption.textContent = "CURRENT ACTION";
        currentTitle.textContent = label;
        currentState.textContent = `Step ${rows.indexOf(row) + 1} of ${rows.length} / Active`;
        row.item.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
        alignList();
        await afterPaint();
      },
      async finish(failed) {
        if (disposed || !active) return;
        const row = active;
        setState(row, failed ? "failed" : "done"); capture(row); active = undefined;
        currentCaption.textContent = failed ? "ACTION FAILED" : "ACTION COMPLETE";
        currentState.textContent = `Step ${rows.indexOf(row) + 1} of ${rows.length} / ${failed ? "Failed" : "Done"}`;
        await afterPaint();
      },
      async end(error) {
        if (active) { setState(active, "failed"); capture(active); active = undefined; }
        const notRun = rows.filter(row => row.state === "pending");
        notRun.forEach(row => setState(row, "not-run"));
        const failedRows = rows.filter(row => row.state === "failed");
        const succeeded = rows.filter(row => row.state === "done").length;
        const failed = Boolean(error || failedRows.length || notRun.length);
        const message = error || (notRun.length ? "The test ended before all planned actions completed." : null);
        const result = { failed, succeeded, failedActions: failedRows.map(row => row.label), notRun: notRun.map(row => row.label), error: message };
        slate.replaceChildren(); slate.hidden = false; slate.dataset.result = failed ? "failed" : "passed";
        slate.append(element("p", "ar-eyebrow", "TEST RECORDING COMPLETE"), element("h2", "", failed ? "TEST FAILED" : "TEST PASSED"),
          element("p", "ar-purpose", title), element("p", "", `${succeeded} succeeded / ${failedRows.length} failed / ${notRun.length} not run`));
        if (failedRows.length || message) slate.append(element("p", "ar-result-detail",
          `${failedRows.length ? `Failed at: ${failedRows.map(row => row.label).join(", ")}\n` : ""}${(message ?? "").replace(/\n[ \t]*\n/g, "\n").slice(0, 650)}`));
        if (notRun.length) {
          slate.append(element("p", "ar-eyebrow", "PLANNED ACTIONS NOT RUN"));
          const remaining = element("ul", "ar-unrun");
          notRun.slice(0, 12).forEach(row => remaining.append(element("li", "", row.label)));
          if (notRun.length > 12) remaining.append(element("li", "", `Plus ${notRun.length - 12} more in the action list`));
          slate.append(remaining);
        }
        currentCaption.textContent = failed ? "TEST FAILED" : "TEST PASSED";
        currentTitle.textContent = failedRows[0]?.label ?? title;
        currentState.textContent = failed ? `${failedRows.length} failed / ${notRun.length} not run` : `${succeeded} actions passed`;
        const focus = failedRows[0] ?? rows.at(-1);
        if (focus) list.scrollTop = Math.max(0, focus.item.offsetTop - list.clientHeight / 3);
        alignList();
        await afterPaint(); return result;
      },
      close() {
        if (disposed) return;
        disposed = true;
        clearInterval(timer); listeners.abort();
        if (paintFrame) cancelAnimationFrame(paintFrame);
        resolvePaint?.(); resolvePaint = undefined; paintFrame = 0;
        held.clear(); rows.length = 0; active = undefined;
        if (host.__gameActionRecording === controller) delete host.__gameActionRecording;
        // Leave the bounded DOM snapshots in place for the recording's last frame.
      },
    };
    host.__gameActionRecording = controller;
    window.addEventListener("pagehide", () => controller.close(), { once: true, signal: listeners.signal });
  }, { title, description, actions, maxActions });
  await page.waitForTimeout(1500);

  let closed = false;
  let stepping = false;
  let ended = false;
  return {
    async step<T>(label: string, fn: () => Promise<T>): Promise<T> {
      if (closed) throw new Error("The action recording is closed");
      if (ended) throw new Error("The test result was already recorded");
      if (stepping) throw new Error("Recording steps must run sequentially");
      const text = actionLabel(label);
      stepping = true;
      let begun = false;
      try {
        await page.evaluate(label => {
          const controller = (window as RecordingWindow).__gameActionRecording;
          if (!controller) throw new Error("The action recording is no longer attached to this page");
          return controller.begin(label);
        }, text);
        begun = true;
        if (closed) throw new Error("The action recording was closed before the action started");
        const result = await fn();
        if (!closed) await page.evaluate(() => {
          const controller = (window as RecordingWindow).__gameActionRecording;
          if (!controller) throw new Error("The action recording is no longer attached to this page");
          return controller.finish(false);
        });
        return result;
      } catch (error) {
        if (begun && !closed && !page.isClosed()) {
          // A teardown/navigation error must never mask the original action error.
          await page.evaluate(() => (window as RecordingWindow).__gameActionRecording?.finish(true)).catch(() => {});
        }
        throw error;
      } finally { stepping = false; }
    },
    async end(error?: unknown) {
      if (closed || ended) throw new Error("The test result was already recorded or closed");
      ended = true;
      const message = error === undefined ? null : error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      // Leave the actual failed game frame and its red action visible first.
      await page.waitForTimeout(message ? 700 : 250);
      const result = await page.evaluate(message => {
        const controller = (window as RecordingWindow).__gameActionRecording;
        if (!controller) throw new Error("The action recording is no longer attached");
        return controller.end(message);
      }, message);
      await page.waitForTimeout(result.failed ? 4000 : 1200);
      return result;
    },
    async close() {
      if (closed) return;
      closed = true;
      if (page.isClosed()) return;
      try { await page.evaluate(() => (window as RecordingWindow).__gameActionRecording?.close()); }
      catch (error) { if (!page.isClosed()) throw error; }
    },
  };
}

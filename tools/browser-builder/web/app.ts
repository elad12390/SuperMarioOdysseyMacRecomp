import { classifyInputs, inspectNsp, validateKeyFile, type Inputs } from './intake';
import { acquireBuildJob, type BuildJob } from './job-storage';

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const pick = $<HTMLInputElement>('#files'), build = $<HTMLButtonElement>('#build');
const cancel = $<HTMLButtonElement>('#cancel'), status = $('#status'), stages = $('#stages');
const progress = $<HTMLProgressElement>('#progress'), download = $<HTMLAnchorElement>('#download');
let selected: Inputs = {}, worker: Worker | undefined, outputUrl: string | undefined, job: string | undefined;
let busy = false, selectionVersion = 0, cancelling = false;
let jobLease: BuildJob | undefined;

function message(text: string, error = false) { status.textContent = text; status.classList.toggle('error', error); }
function renderFiles() {
  const list = $('#selected-files'); list.replaceChildren();
  for (const [kind, file] of Object.entries(selected)) {
    if (!file) continue;
    const row = document.createElement('li'), name = document.createElement('span'), remove = document.createElement('button');
    name.className = 'filename'; name.textContent = file.name;
    remove.textContent = '×'; remove.setAttribute('aria-label', `Remove ${file.name}`); remove.disabled = busy;
    remove.onclick = () => { delete selected[kind as keyof Inputs]; selectionVersion++; renderFiles(); };
    row.append(name, remove); list.append(row);
  }
  build.disabled = busy || !selected.nsp || !selected.prodKeys;
  build.textContent = busy ? 'Building on your device…' : selected.nsp && selected.prodKeys ? 'Build my Mac version' : 'Choose your game and prod.keys';
  pick.disabled = busy;
}
async function choose(files: File[]) {
  if (busy) return;
  try {
    const incoming = classifyInputs(files);
    selected = { ...selected, ...incoming }; selectionVersion++;
    renderFiles(); message('');
  } catch (error) { message(error instanceof Error ? error.message : 'Could not read the selected files.', true); }
}
pick.addEventListener('change', () => { void choose(Array.from(pick.files ?? [])); pick.value = ''; });
const zone = $('#dropzone');
for (const event of ['dragenter', 'dragover']) zone.addEventListener(event, e => { e.preventDefault(); if (!busy) zone.classList.add('dragging'); });
for (const event of ['dragleave', 'drop']) zone.addEventListener(event, e => { e.preventDefault(); zone.classList.remove('dragging'); });
zone.addEventListener('drop', e => { void choose(Array.from((e as DragEvent).dataTransfer?.files ?? [])); });

function selectStage(stage: string, failed = false) {
  let found = false;
  for (const item of stages.querySelectorAll<HTMLLIElement>('li')) {
    const active = item.dataset.stage === stage;
    item.className = active ? failed ? 'failed' : 'active' : found ? '' : 'done';
    found ||= active;
  }
}
function finish() { worker?.terminate(); worker = undefined; busy = false; cancelling = false; cancel.disabled = false; cancel.hidden = true; renderFiles(); }
async function cleanup() {
  if (!jobLease) return;
  const owned = jobLease;
  try { await owned.remove(); }
  catch (cause) { throw new Error('Temporary files could not be removed; try again after this build releases its files.', { cause }); }
  if (jobLease === owned) { jobLease = undefined; job = undefined; }
}

build.addEventListener('click', async () => {
  if (busy || !selected.nsp || !selected.prodKeys) return;
  busy = true; renderFiles(); download.hidden = true;
  if (outputUrl) URL.revokeObjectURL(outputUrl);
  outputUrl = undefined;
  stages.hidden = false; selectStage('validate'); progress.hidden = true; cancel.hidden = false;
  const version = selectionVersion;
  try {
    message('Checking your local game file and keys…');
    await cleanup();
    await Promise.all([inspectNsp(selected.nsp), validateKeyFile(selected.prodKeys), ...(selected.titleKeys ? [validateKeyFile(selected.titleKeys)] : [])]);
    if (!navigator.storage?.getDirectory || typeof Worker === 'undefined') throw new Error('This browser does not support local file workers. Use a current Chrome or Edge browser.');
    // Chromium's StaticStorageQuota deliberately reports usage + 10 GiB.
    // estimate() is advisory, so rejecting a >10 GiB job would block valid
    // disks. Actual OPFS writes enforce quota and failures clean up this job.
    if (!busy || version !== selectionVersion) return;
    const lease = await acquireBuildJob();
    if (!busy || version !== selectionVersion) { await lease.remove(); return; }
    jobLease = lease; job = lease.id;
    worker = new Worker(new URL('./build-worker.js', import.meta.url), { type: 'module' });
    const activeWorker = worker, activeJob = job;
    worker.onmessage = async ({ data }) => {
      if (worker !== activeWorker) return;
      try {
      if (data.type === 'cancelled') {
        await cleanup(); if (worker !== activeWorker) return;
        finish(); progress.hidden = true; message('Build cancelled. Your original game and keys are unchanged.'); return;
      }
      if (cancelling) return;
      if (data.type === 'progress') {
        selectStage(data.stage); message(data.message);
        progress.hidden = false;
        if (typeof data.fraction === 'number' && Number.isFinite(data.fraction)) progress.value = Math.min(1, Math.max(0, data.fraction)); else progress.removeAttribute('value');
      } else if (data.type === 'complete') {
        const root = await navigator.storage.getDirectory(); const jobs = await root.getDirectoryHandle('switchrecomp');
        const directory = await jobs.getDirectoryHandle(activeJob); const file = await directory.getFileHandle(data.file);
        if (worker !== activeWorker || cancelling) return;
        const completedFile = await file.getFile();
        if (worker !== activeWorker || cancelling) return;
        outputUrl = URL.createObjectURL(completedFile); download.href = outputUrl;
        download.download = 'Super Mario Odyssey.dmg'; download.hidden = false;
        for (const item of stages.querySelectorAll('li')) item.className = 'done';
        progress.hidden = true; message('Your Mac version is ready. Download the disk image to install it.'); finish();
      } else if (data.type === 'error') {
        selectStage(data.stage, true); progress.hidden = true;
        message(data.message, true); await cleanup(); if (worker === activeWorker) finish();
      }
      } catch (error) { if (worker !== activeWorker) return; message(error instanceof Error ? error.message : 'The generated file could not be opened.', true); finish(); }
    };
    worker.onerror = async () => {
      if (worker !== activeWorker) return;
      activeWorker.terminate();
      progress.hidden = true;
      try { await cleanup(); if (worker !== activeWorker) return; message('The browser worker stopped unexpectedly. Your original files are unchanged.', true); }
      catch (error) { if (worker === activeWorker) message((error as Error).message, true); }
      if (worker === activeWorker) finish();
    };
    worker.postMessage({ type: 'build', job, ...selected });
  } catch (error) {
    if (version !== selectionVersion) return;
    let cause = error;
    try { await cleanup(); } catch (cleanupError) { cause = cleanupError; }
    if (version !== selectionVersion) return;
    message(cause instanceof Error ? cause.message : 'The build could not start.', true); selectStage('validate', true); finish();
  }
});
cancel.addEventListener('click', async () => {
  if (!busy || cancelling) return;
  selectionVersion++; cancelling = true; cancel.disabled = true; message('Cancelling and removing this build’s temporary files…');
  if (!worker) { try { await cleanup(); message('Build cancelled. Your original game and keys are unchanged.'); } catch (error) { message((error as Error).message, true); } finish(); return; }
  const active = worker;
  active.postMessage({ type: 'cancel' });
  // Most stages yield between bounded chunks. If a tool is stuck in a long
  // synchronous call, terminate its isolated worker and release OPFS handles.
  setTimeout(async () => {
    if (worker !== active || !cancelling) return;
    active.terminate(); progress.hidden = true;
    try { await cleanup(); if (worker !== active) return; message('Build cancelled. Your original game and keys are unchanged.'); }
    catch (error) { if (worker !== active) return; message((error as Error).message, true); }
    if (worker === active) finish();
  }, 5000);
});
window.addEventListener('beforeunload', e => { if (busy) { e.preventDefault(); e.returnValue = ''; } });

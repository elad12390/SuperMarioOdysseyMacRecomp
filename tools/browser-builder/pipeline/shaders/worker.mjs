import { directoryFiles, mountFiles, mountScratch } from './file-fs.mjs';
import { verifyAssets } from './asset-loader.mjs';
import { buildParallel } from './parallel.mjs';
import { decodeYaz0 } from './yaz0.mjs';
import { scanParallel } from './scan.mjs';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const adapterAssets = ['adapter.py', 'file-fs.mjs', 'worker.mjs', 'index.mjs', 'page-store.mjs', 'asset-loader.mjs', 'parallel.mjs', 'build-worker.mjs', 'yaz0.mjs', 'packed-output.mjs', 'scan.mjs', 'scan-worker.mjs'];
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const digest = async bytes => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
const messages = { bootstrap: 'Loading verified shader conversion tools', index: 'Reading the local game file list',
  split: 'Finding shaders in your game', maxwell: 'Translating shader programs in WASM', translate: 'Preparing Metal shader source', python: 'Processing game graphics' };
const progress = event => postMessage({ type: 'progress', event: { message: messages[event.stage] || event.stage, ...event } });
function staticURL(name, base) {
  const url = new URL(name, base);
  if (url.origin !== self.location.origin || !['http:', 'https:'].includes(url.protocol)) throw new Error('Shader tool assets must be same-origin static files');
  return url;
}
async function responseBytes(url) {
  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok) throw new Error(`Shader tool asset is unavailable: ${url.pathname} (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}
async function bootstrap(bundleURL, { translators = true } = {}) {
  const manifest = JSON.parse(decoder.decode(await responseBytes(staticURL('toolchain.json', bundleURL))));
  if (manifest.format !== 1 || !/^[a-f0-9]{12}$/.test(manifest.chain)) throw new Error('Unsupported browser shader toolchain manifest');
  const verified = await verifyAssets(manifest.assets, bundleURL, { onProgress: event => {
    if (event.completed % 20 === 0 || event.completed === event.total) progress({ stage: 'bootstrap', ...event });
  } });
  const listHash = list => digest(encoder.encode(JSON.stringify(list)));
  const identity = { ...manifest.identity };
  for (const [field, prefix] of [['maxwell_assets', 'maxwell/'], ['cross_assets', 'cross/'], ['python_assets', 'pyodide/']]) {
    if (identity[field] !== await listHash(verified.filter(a => a.path.startsWith(prefix)))) throw new Error(`Shader ${field} fingerprint mismatch`);
  }
  if (identity.adapter_assets !== await listHash(verified.filter(a => adapterAssets.includes(a.path)))) throw new Error('Shader adapter fingerprint mismatch');
  if (identity.python_wheels !== await listHash(verified.filter(a => a.path.endsWith('.whl')))) throw new Error('Shader Python wheel fingerprint mismatch');
  if (identity.sources !== verified.find(a => a.path === 'sources.json')?.sha256) throw new Error('Shader rule source fingerprint mismatch');
  const expectedChain = (await digest(encoder.encode('switchrecomp-browser-shader-chain\0' + JSON.stringify(identity)))).slice(0, 12);
  if (expectedChain !== manifest.chain) throw new Error('Browser shader chain fingerprint mismatch');
  const sources = JSON.parse(decoder.decode(await responseBytes(staticURL('sources.json', bundleURL))));
  const { loadPyodide } = await import(staticURL('pyodide/pyodide.mjs', bundleURL).href);
  const py = await loadPyodide({ indexURL: staticURL('pyodide/', bundleURL).href,
    stdout: text => progress({ stage: 'python', text }), stderr: text => progress({ stage: 'python', text }) });
  globalThis.shader_decode_yaz0 = bytes => decodeYaz0(bytes.toJs());
  await py.loadPackage([staticURL(manifest.lz4Wheel, bundleURL).href, staticURL(manifest.lzmaWheel, bundleURL).href]);
  for (const file of sources.files) {
    const bytes = encoder.encode(file.text);
    if (await digest(bytes) !== file.sha256 || !/^dm\/[\w/.-]+$/.test(file.path) || file.path.split('/').includes('..')) throw new Error('Pinned Python shader source checksum/path mismatch');
    const target = '/source/' + file.path;
    py.FS.mkdirTree(target.slice(0, target.lastIndexOf('/'))); py.FS.writeFile(target, bytes);
  }
  if (await digest(encoder.encode(sources.profile)) !== sources.profileSha256) throw new Error('Pinned public shader profile checksum mismatch');
  let maxwell,cross;
  if(translators){
    const { createShaderTranslator } = await import(staticURL('maxwell/shader-translator.mjs', bundleURL).href);
    const { createMslTranslator } = await import(staticURL('cross/translator.mjs', bundleURL).href);
    maxwell = await createShaderTranslator();cross = await createMslTranslator();
  }
  const adapter = decoder.decode(await responseBytes(staticURL('adapter.py', bundleURL)));
  return { py, sources, manifest, adapter, maxwell, cross };
}

function processBridge(py, maxwell, cross, identity) {
  return command => {
    const argv = JSON.parse(command);
    try {
      if (argv[0] === '/browser/dmsh_xlate') {
        const jobs = JSON.parse(decoder.decode(py.FS.readFile(argv[1])));
        if (!Array.isArray(jobs)) throw new Error('Expected a shader job list');
        for (const job of jobs) {
          if (!['vs', 'ps', 'cs', 'gs'].includes(job.stage)) throw new Error(`Unsupported browser shader stage ${job.stage}`);
          const code = py.FS.readFile(job.code);
          if (code.length > 16 * 1024 * 1024) throw new Error(`Shader ${job.key} exceeds the bounded 16 MiB translator input`);
          const [output] = maxwell.translateBatch([{ job, code }]);
          py.FS.writeFile(`${argv[2]}/${output.key}.spv`, output.spirv);
          py.FS.writeFile(`${argv[2]}/${output.key}.res.json`, encoder.encode(JSON.stringify(output.resources)));
          if (output.readerSpirv) py.FS.writeFile(`${argv[2]}/${output.key}.reader.spv`, output.readerSpirv);
          progress({ stage: 'maxwell', shader: job.key });
        }
        return JSON.stringify({ code: 0, stdout: '', stderr: '' });
      }
      if (argv[0] === 'spirv-cross') {
        if (argv.length === 2 && argv[1] === '--version') return JSON.stringify({ code: 0, stdout: identity.cross_assets, stderr: '' });
        const input = argv.slice(1).find(a => a.endsWith('.spv'));
        if (!input) throw new Error('Missing local SPIR-V input');
        if (!argv.includes('--msl')) {
          if (argv.length !== 4 || argv[1] !== input || argv[2] !== '--version' || argv[3] !== '450') throw new Error('Unsupported GLSL options in shader conversion');
          const glsl = cross.translateGlsl(py.FS.readFile(input), { version: 450 });
          return JSON.stringify({ code: 0, stdout: glsl, stderr: '' });
        }
        const flags = argv.filter(a => a !== input);
        const outAt = flags.indexOf('--output');
        const output = outAt >= 0 ? flags[outAt + 1] : null;
        if (outAt >= 0) flags.splice(outAt, 2);
        if (JSON.stringify(flags) !== JSON.stringify(['spirv-cross', '--msl', '--msl-version', '20300', '--msl-argument-buffers', '--msl-texture-buffer-native', '--msl-pad-fragment-output'])) throw new Error('Unsupported Cross options; refusing to silently change shader semantics');
        const msl = cross.translate(py.FS.readFile(input));
        if (output) py.FS.writeFile(output, encoder.encode(msl));
        return JSON.stringify({ code: 0, stdout: output ? '' : msl, stderr: '' });
      }
      throw new Error(`Native subprocess is unavailable in the browser shader chain: ${argv[0]}`);
    } catch (error) {
      return JSON.stringify({ code: 1, stdout: '', stderr: error?.message || String(error) });
    }
  };
}

async function put(root, path, bytes) {
  let directory = root;
  const names = path.split('/');
  for (const part of names.slice(0, -1)) directory = await directory.getDirectoryHandle(part, { create: true });
  const handle = await directory.getFileHandle(names.at(-1), { create: true });
  const writable = await handle.createWritable();
  try { await writable.write(bytes); await writable.close(); }
  catch (error) { await writable.abort().catch(() => {}); throw error; }
  return { path, size: bytes.byteLength, sha256: await digest(bytes) };
}
async function removeScratch(root) {
  for(let attempt=0;attempt<250;attempt++) {
    try {await root.removeEntry('.shader-work',{recursive:true});return;}
    catch(error) {
      if(error.name==='NotFoundError')return;
      if(error.name!=='NoModificationAllowedError'||attempt===249)throw error;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
  }
}
async function exportTree(py, source, root, prefix, files, include = () => true) {
  for (const name of py.FS.readdir(source).filter(n => n !== '.' && n !== '..').sort()) {
    const path = source + '/' + name;
    if (py.FS.isDir(py.FS.stat(path).mode)) await exportTree(py, path, root, prefix + name + '/', files, include);
    else {
      if (!include(name)) continue;
      const size = py.FS.stat(path).size;
      if (name.endsWith('.metallib')) throw new Error('Browser source build unexpectedly emitted a metallib');
      let directory = root;
      const outputPath = prefix + name;
      const parts = outputPath.split('/');
      for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part, { create: true });
      const writable = await (await directory.getFileHandle(parts.at(-1), { create: true })).createSyncAccessHandle();
      const stream = py.FS.open(path, 'r');
      const hasher = py.runPython('hashlib.sha256()');
      const buffer = new Uint8Array(Math.min(Math.max(size, 1), 4 * 1024 * 1024));
      try {
        let position = 0;
        while (position < size) {
          const count = py.FS.read(stream, buffer, 0, Math.min(buffer.length, size - position), position);
          if (!count) throw new Error(`Unexpected end of shader output ${name}`);
          const chunk = buffer.subarray(0, count);
          const bytes = py.toPy(chunk);
          try { hasher.update(bytes); } finally { bytes.destroy(); }
          if (writable.write(chunk, { at: position }) !== count) throw new Error('Incomplete OPFS shader source export');
          position += count;
        }
        writable.truncate(size); writable.close();
        files.push({ path: outputPath, size, sha256: hasher.hexdigest() });
      } catch (error) { try { writable.close(); } catch {} throw error; }
      finally { py.FS.close(stream); hasher.destroy(); }
    }
  }
}

async function execute({ inputDirectory, inputFiles: selectedFiles, outputDirectory, profileDirectory, bundleURL, workers }) {
  progress({ stage: 'bootstrap', message: 'Verifying and loading shader WASM tools' });
  const { py, sources, manifest, adapter, maxwell, cross } = await bootstrap(bundleURL);
  let inputFiles;
  if (selectedFiles) {
    const seen = new Set();
    inputFiles = selectedFiles.map(({ path: name, file }) => {
      if (!(file instanceof File) || !name || /[\\\0]/.test(name) || name.split('/').some(n => !n || n === '.' || n === '..') || seen.has(name)) throw new Error('Invalid or duplicate local shader input path');
      seen.add(name); return { name, file };
    }).filter(f => f.name === 'ExeFS/main' || f.name.startsWith('RomFS/'));
  } else {
    const exefs = await inputDirectory.getDirectoryHandle('ExeFS');
    const main = await (await exefs.getFileHandle('main')).getFile();
    const romfs = await inputDirectory.getDirectoryHandle('RomFS');
    inputFiles = [{ name: 'ExeFS/main', file: main }, ...(await directoryFiles(romfs, progress)).map(f => ({ ...f, name: 'RomFS/' + f.name }))];
  }
  const main = inputFiles.find(f => f.name === 'ExeFS/main')?.file;
  if (!main) throw new Error('Missing original ExeFS/main for shader conversion');
  const header = new Uint8Array(await main.slice(0, 0x100).arrayBuffer());
  if (main.size > 128 * 1024 * 1024 || header.length !== 0x100 || decoder.decode(header.subarray(0, 4)) !== 'NSO0' || hex(header.subarray(0x40, 0x50)) !== '3ca12dfaaf9c82da064d1698df79cda1') throw new Error('Shader conversion supports only the original Odyssey base 1.0.0 main NSO');
  const view = new DataView(header.buffer);
  for (let i = 0; i < 3; i++) if (view.getUint32(0x14 + 16 * i, true) + view.getUint32(0x18 + 16 * i, true) > 512 * 1024 * 1024) throw new Error('NSO shader scan exceeds the bounded 512 MiB image');
  const scratchDirectory = await outputDirectory.getDirectoryHandle('.shader-work', { create: true });
  const access = await (await scratchDirectory.getFileHandle('workspace.bin', { create: true })).createSyncAccessHandle();
  const scratch = mountScratch(py, '/job', access);
  const unmount = mountFiles(py, '/input', inputFiles);
  try {
    const profile = '/job/profile/0100000000010000';
    py.FS.mkdirTree(profile);
    py.FS.writeFile(profile + '/game.tsv', encoder.encode(sources.profile));
    if (profileDirectory) for (const name of ['game.tsv', 'shader_facts_manual.tsv', 'bf_want.tsv']) {
      let handle;
      try { handle = await profileDirectory.getFileHandle(name); } catch (error) { if (error.name === 'NotFoundError') continue; throw error; }
      const file = await handle.getFile();
      if (file.size > 8 * 1024 * 1024) throw new Error(`Local profile file is too large: ${name}`);
      py.FS.writeFile(profile + '/' + name, new Uint8Array(await file.arrayBuffer()));
    }
    globalThis.shader_tool_identity = () => JSON.stringify(manifest.identity);
    globalThis.shader_process = processBridge(py, maxwell, cross, manifest.identity);
    globalThis.shader_event = json => progress(JSON.parse(json));
    py.globals.set('_browser_config', JSON.stringify({ chain: manifest.chain, identity: manifest.identity }));
    py.runPython(adapter);
    // Tools are fully initialized. Conversion must not fetch anything, even if
    // a future native subprocess adapter accidentally tries to reach a server.
    globalThis.fetch = () => Promise.reject(new Error('Network is disabled during private shader conversion'));
    await scanParallel({py,manifest,bundleURL,inputFiles,progress});
    py.runPython('split()');
    const result = await buildParallel({ py, manifest, bundleURL, outputDirectory, scratchDirectory, progress, workers });
    const files = [...result.files];
    progress({ stage: 'write', message: 'Writing MSL, reflection and stamped shader tables' });
    await exportTree(py, '/job/cache/b-' + manifest.chain, outputDirectory, 'shader/cache/b-' + manifest.chain + '/', files);
    await exportTree(py, profile, outputDirectory, 'profile/0100000000010000/', files);
    const output = { ...result, shaderDirectory: 'shader/cache/b-' + manifest.chain, profileDirectory: 'profile/0100000000010000', files,
      provenance: { ...sources.provenance, identity: manifest.identity }, scratchBytes: scratch.bytes() };
    files.push(await put(outputDirectory, 'shader-chain.json', encoder.encode(JSON.stringify(output, null, 2) + '\n')));
    return output;
  } finally {
    unmount(); scratch.close();
    await removeScratch(outputDirectory);
  }
}

onmessage = async ({ data }) => {
  onmessage = null;
  try { postMessage({ type: 'result', manifest: await execute(data) }); }
  catch (error) { postMessage({ type: 'error', message: error?.message || String(error) }); }
};

export { bootstrap, processBridge, exportTree };

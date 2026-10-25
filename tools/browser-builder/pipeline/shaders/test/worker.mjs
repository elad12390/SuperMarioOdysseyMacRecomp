import { bootstrap, processBridge, exportTree } from '../worker.mjs';
import { mountScratch } from '../file-fs.mjs';
onmessage = async ({ data }) => {
  let scratch;
  try {
    const { py, manifest, sources, adapter, maxwell, cross } = await bootstrap(data.bundleURL);
    const store = await data.outputDirectory.getFileHandle('proof-store.bin', { create: true });
    scratch = mountScratch(py, '/job', await store.createSyncAccessHandle());
    const profile = '/job/profile/0100000000010000';
    py.FS.mkdirTree(profile); py.FS.mkdirTree('/job/pkg');
    py.FS.writeFile(profile + '/game.tsv', sources.profile);
    for (const file of data.fixtures.files) {
      const target = file.name.startsWith('profile/') ? profile + file.name.slice(7) : '/job/' + file.name;
      py.FS.writeFile(target, file.text ?? Uint8Array.from(file.data));
    }
    globalThis.shader_tool_identity = () => JSON.stringify(manifest.identity);
    globalThis.shader_process = processBridge(py, maxwell, cross, manifest.identity);
    globalThis.shader_event = json => postMessage({ type: 'progress', event: JSON.parse(json) });
    py.globals.set('_browser_config', JSON.stringify({ chain: manifest.chain, identity: manifest.identity }));
    py.runPython(adapter);
    globalThis.fetch = () => Promise.reject(new Error('Network disabled during real shader proof'));
    const proxy = py.runPython('build()'); const result = proxy.toJs({ dict_converter: Object.fromEntries }); proxy.destroy();
    const out = '/job/cache/b-' + manifest.chain;
    const exported = [];
    const exportRoot = await data.outputDirectory.getDirectoryHandle('exported', { create: true });
    await exportTree(py, out, exportRoot, '', exported);
    for (const file of exported) {
      const actual = await (await exportRoot.getFileHandle(file.path)).getFile();
      const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await actual.arrayBuffer())), b => b.toString(16).padStart(2, '0')).join('');
      if (actual.size !== file.size || sha256 !== file.sha256) throw new Error('Streamed shader export differs: ' + file.path);
    }
    const files = [];
    for (const name of py.FS.readdir(out).filter(n => n !== '.' && n !== '..')) {
      files.push({ name, text: new TextDecoder().decode(py.FS.readFile(out + '/' + name)) });
    }
    for (const name of ['c1_full.tsv', 'cb_extent.tsv']) files.push({ name, text: new TextDecoder().decode(py.FS.readFile(profile + '/' + name)) });
    postMessage({ type: 'result', result, files, exported, scratchBytes: scratch.bytes() });
  } catch (error) { postMessage({ type: 'error', message: error.stack || String(error) }); }
  finally { scratch?.close(); }
};

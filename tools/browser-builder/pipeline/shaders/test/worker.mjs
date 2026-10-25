import { bootstrap, processBridge, exportTree } from '../worker.mjs';
import { mountScratch } from '../file-fs.mjs';
import { buildParallel } from '../parallel.mjs';
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
    let result;
    if (data.parallel) {
      result = await buildParallel({py,manifest,bundleURL:data.bundleURL,outputDirectory:data.outputDirectory,
        scratchDirectory:await data.outputDirectory.getDirectoryHandle('pool-work',{create:true}),
        progress:event=>postMessage({type:'progress',event}),workers:3,batchSize:2});
      // Read the actual pool outputs back through the same reference checks.
      for (const file of result.files) {
        let parent=data.outputDirectory;
        const parts=(file.storagePath??file.path).split('/');
        for (const name of parts.slice(0,-1))parent=await parent.getDirectoryHandle(name);
        const actual=await(await parent.getFileHandle(parts.at(-1))).getFile();
        const bytes=new Uint8Array(await (file.storagePath?actual.slice(file.storageOffset,file.storageOffset+file.size):actual).arrayBuffer());
        const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
        if(bytes.length!==file.size||sha256!==file.sha256)throw new Error('Actual packed shader extent differs: '+file.path);
        const target='/job/cache/b-'+manifest.chain+'/'+file.path.split('/').at(-1);
        py.FS.writeFile(target,bytes);
      }
    } else {
      const proxy = py.runPython('build()'); result = proxy.toJs({ dict_converter: Object.fromEntries }); proxy.destroy();
    }
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

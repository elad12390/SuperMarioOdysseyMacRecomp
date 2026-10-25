// A pool member owns its Python/Maxwell/Cross instances and scratch file.
// All members read the same local packages; only independent shader keys run together.
import { bootstrap, processBridge } from './worker.mjs';
import { mountFiles, mountScratch } from './file-fs.mjs';
import { exportPacked, finishPacked } from './packed-output.mjs';

let tools, scratch, unmount, output, ownKeys = new Set(), dependencies = [];
let id, store;
const value = expression => {
  const proxy = tools.py.runPython(expression);
  if (!proxy?.toJs) return proxy;
  try { return proxy.toJs({ dict_converter: Object.fromEntries }); } finally { proxy.destroy(); }
};
async function initialize(data) {
  output = data.outputDirectory;
  id=data.id;
  tools = await bootstrap(data.bundleURL);
  const { py, manifest, adapter, maxwell, cross } = tools;
  const access = await (await data.scratchDirectory.getFileHandle('worker-' + data.id + '.bin', {create:true})).createSyncAccessHandle();
  scratch = mountScratch(py, '/job', access, {cacheBytes:32*1024*1024});
  py.FS.mkdirTree('/job/pkg');
  unmount = mountFiles(py, '/job/pkg', data.packages);
  const profile = '/job/profile/0100000000010000';
  py.FS.mkdirTree(profile);
  for (const file of data.profile) py.FS.writeFile(profile+'/'+file.name, new Uint8Array(await file.file.arrayBuffer()));
  globalThis.shader_tool_identity = () => JSON.stringify(manifest.identity);
  globalThis.shader_process = processBridge(py, maxwell, cross, manifest.identity);
  globalThis.shader_event = () => {};
  py.globals.set('_browser_config', JSON.stringify({chain:manifest.chain, identity:manifest.identity}));
  py.runPython(adapter);
  globalThis.fetch = () => Promise.reject(new Error('Network disabled during private shader conversion'));
  return {chain:manifest.chain};
}
async function convert(data) {
  const started=performance.now();
  const {py,manifest} = tools;
  const cache = '/job/cache/b-'+manifest.chain;
  py.FS.mkdirTree(cache);
  for (const item of data.dependencies) {
    if (ownKeys.has(item.key)) continue;
    const name = cache+'/'+item.key+'_b.metal';
    py.FS.writeFile(name, new Uint8Array(await item.file.arrayBuffer()));
    dependencies.push(name);
  }
  const keyProxy=py.toPy(data.keys);
  try { py.globals.set('_batch_keys', keyProxy); } finally { keyProxy.destroy(); }
  let result;
  try { result = value('build(_batch_keys)'); }
  finally { py.runPython('del _batch_keys\ngc.collect()'); }
  for (const key of data.keys) ownKeys.add(key);
  for (const name of dependencies) py.FS.unlink(name);
  dependencies=[];
  const converted=performance.now();
  const files=[];
  store??={name:`worker-${id}-phase-${data.phase}.bin`,chain:manifest.chain};
  await exportPacked(py,cache,output,files,data.keys,store);
  return {...result,files,timing:{buildMs:converted-started,exportMs:performance.now()-converted,
    packageCacheHits:result.packageCache.hits,packageCacheMisses:result.packageCache.misses,packageCacheBytes:result.packageCache.bytes}};
}
function guards() {
  const {py,manifest}=tools;
  py.runPython(`
_directory = '/job/cache/b-' + CHAIN
dmsh_chain.write_stamp(_directory, '0100000000010000', dmsh_chain.inputs(dmsh_chain.load_game()))
for _tool, _table in (('c1_guard.py','c1_full.tsv'),('cb_extent.py','cb_extent.tsv')):
    execute(SOURCE + '/' + _tool, [_tool, _directory, PROFILE + '/' + _table])
`);
  return {chain:manifest.chain, tables:Object.fromEntries(['c1_full.tsv','cb_extent.tsv'].map(name=>[name,
    new TextDecoder().decode(py.FS.readFile('/job/profile/0100000000010000/'+name))]))};
}
onmessage = async ({data}) => {
  try {
    let result;
    if (data.type==='init') result=await initialize(data);
    else if (data.type==='convert') result=await convert(data);
    else if (data.type==='guards') result=guards();
    else if (data.type==='finish-phase'){if(store)finishPacked(store);store=undefined;result={};}
    else if (data.type==='close') {
      try { if(store)finishPacked(store); } finally {try{unmount?.();}finally{scratch?.close();}}
      store=scratch=unmount=undefined;result={};
    }
    else throw new Error('Unsupported shader pool command');
    postMessage({type:'result',request:data.request,result});
  } catch(error) { postMessage({type:'error',request:data.request,message:error.stack||String(error)}); }
};

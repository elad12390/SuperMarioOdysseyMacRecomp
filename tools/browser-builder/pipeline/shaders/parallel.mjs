const decoder=new TextDecoder(), encoder=new TextEncoder();
const profilePath='/job/profile/0100000000010000';
const text=(py,path)=>decoder.decode(py.FS.readFile(path));
function workerClient(url) {
  const worker=new Worker(url,{type:'module'});
  let sequence=0, pending;
  worker.onmessage=({data})=>{
    if (!pending || data.request!==pending.request) return;
    const {resolve,reject}=pending; pending=undefined;
    if(data.type==='error') reject(new Error(data.message)); else resolve(data.result);
  };
  worker.onerror=event=>{pending?.reject(new Error(event.message||'Shader pool worker failed'));pending=undefined;};
  const client={call(data){
    if(pending) throw new Error('Shader pool member is already busy');
    return new Promise((resolve,reject)=>{const request=++sequence;pending={request,resolve,reject};worker.postMessage({...data,request});});
  },async close(){
    let timer;
    try {
      if(!pending)await Promise.race([client.call({type:'close'}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Shader worker close timeout')),2000);})]);
    } catch {} finally {
      clearTimeout(timer);worker.terminate();pending?.reject(new DOMException('Shader pool terminated','AbortError'));pending=undefined;
    }
  }};
  return client;
}
async function snapshot(py, source, directory) {
  const files=[];
  for(const name of py.FS.readdir(source).filter(n=>n!=='.'&&n!=='..').sort()) {
    const path=source+'/'+name;
    if(!py.FS.isFile(py.FS.stat(path).mode)) throw new Error('Unexpected directory in shader job inputs');
    const handle=await directory.getFileHandle(name,{create:true});
    const access=await handle.createSyncAccessHandle();
    const stream=py.FS.open(path,'r'),size=py.FS.stat(path).size;
    const buffer=new Uint8Array(Math.min(Math.max(size,1),4*1024*1024));
    try {
      for(let at=0;at<size;) {
        const count=py.FS.read(stream,buffer,0,Math.min(buffer.length,size-at),at);
        if(!count||access.write(buffer.subarray(0,count),{at})!==count) throw new Error('Incomplete shader package snapshot');
        at+=count;
      }
      access.truncate(size);access.flush();
    } finally {py.FS.close(stream);access.close();}
    files.push({name,file:await handle.getFile()});
  }
  return files;
}
export function planBatches(mapText,pairsText,batchSize=256) {
  if(!Number.isSafeInteger(batchSize)||batchSize<1||batchSize>1024)throw new Error('Invalid shader batch bound');
  const keys=new Set(mapText.split('\n').filter(s=>s&&!s.startsWith('#')).map(s=>s.split('\t')[3]).filter(s=>/^[0-9a-f]{16}$/.test(s)));
  const pairs=new Map();
  for(const line of pairsText.split('\n')) {
    if(!line||line.startsWith('#')) continue;
    const [v,p]=line.trim().split(/\s+/);
    if(!keys.has(v)||!keys.has(p)) throw new Error('Shader pair refers to a missing local shader');
    if(!pairs.has(v)) pairs.set(v,new Set());
    pairs.get(v).add(p);
  }
  const sorted=[...keys].sort(), phases=[sorted.filter(k=>!pairs.has(k)),sorted.filter(k=>pairs.has(k))];
  const chunks=phases.map(phase=>Array.from({length:Math.ceil(phase.length/batchSize)},(_,i)=>phase.slice(i*batchSize,(i+1)*batchSize)));
  return {keys:sorted,pairs,phases,chunks};
}
export async function buildParallel({py,manifest,bundleURL,outputDirectory,scratchDirectory,progress,workers,batchSize}) {
  const plan=planBatches(text(py,profilePath+'/shader_map.tsv'),text(py,profilePath+'/shader_pairs.tsv'),batchSize);
  if(!plan.keys.length) throw new Error('No shaders were extracted from the local game');
  if(workers!==undefined&&(!Number.isSafeInteger(workers)||workers<1||workers>12))throw new Error('Invalid shader worker bound');
  const cores=navigator.hardwareConcurrency||4;
  const memoryLimit=navigator.deviceMemory&&navigator.deviceMemory<=4?2:cores<=8?4:12;
  const count=Math.max(1,Math.min(workers??8,Math.max(1,cores-2),memoryLimit));
  const packages=await snapshot(py,'/job/pkg',await scratchDirectory.getDirectoryHandle('packages',{create:true}));
  const profile=await snapshot(py,profilePath,await scratchDirectory.getDirectoryHandle('profile',{create:true}));
  const pool=Array.from({length:count},()=>workerClient(new URL('./build-worker.mjs',import.meta.url)));
  const files=[], results=new Map(), batches=[];let completed=0,inputs;
  const started=performance.now();
  try {
    progress({stage:'bootstrap',message:`Preparing ${count} local graphics workers`,completed:0,total:count});
    let initialized=0;
    await Promise.all(pool.map(async(client,id)=>{
      const result=await client.call({type:'init',id,bundleURL,packages,profile,outputDirectory,scratchDirectory});
      if(result.chain!==manifest.chain)throw new Error('Shader worker toolchain mismatch');
      progress({stage:'bootstrap',message:`Preparing ${count} local graphics workers`,completed:++initialized,total:count});
    }));
    const outputs=new Map(),stores=new Map();
    const outputFile=async file=>{
      if(!file)throw new Error('Missing completed pixel shader source');
      let store=stores.get(file.storagePath);
      if(!store){let parent=outputDirectory;const parts=file.storagePath.split('/');for(const name of parts.slice(0,-1))parent=await parent.getDirectoryHandle(name);store=await(await parent.getFileHandle(parts.at(-1))).getFile();stores.set(file.storagePath,store);}
      if(file.storageOffset+file.size>store.size)throw new Error('Incomplete packed pixel shader source');
      return new File([store.slice(file.storageOffset,file.storageOffset+file.size)],file.path.split('/').at(-1));
    };
    for(let phase=0;phase<plan.chunks.length;phase++) {
      let next=0;
      await Promise.all(pool.map(async client=>{
        while(next<plan.chunks[phase].length) {
          const keys=plan.chunks[phase][next++],dependencies=[];
          const wanted=new Set(keys.flatMap(k=>[...(plan.pairs.get(k)||[])]));
          for(const key of wanted)dependencies.push({key,file:await outputFile(outputs.get('shader/cache/b-'+manifest.chain+'/'+key+'_b.metal'))});
          const result=await client.call({type:'convert',keys,dependencies,phase});
          if(result.chain!==manifest.chain||result.shaders!==keys.length||inputs&&result.inputs!==inputs) throw new Error('Parallel shader identity or count mismatch');
          inputs=result.inputs;
          for(const row of result.results){if(results.has(row.key)||row.st!=='ok')throw new Error('Duplicate or failed parallel shader');results.set(row.key,row);}
          files.push(...result.files);for(const file of result.files)outputs.set(file.path,file);completed+=keys.length;
          batches.push({phase,count:keys.length,...result.timing});
          progress({stage:'translate',message:`Translating graphics with ${count} workers`,completed,total:plan.keys.length,fraction:completed/plan.keys.length});
        }
      }));
      await Promise.all(pool.map(client=>client.call({type:'finish-phase'})));
    }
    progress({stage:'guards',message:'Checking shader memory bounds in parallel',completed:0,total:count});
    let guarded=0;
    const guards=await Promise.all(pool.map(async client=>{const result=await client.call({type:'guards'});progress({stage:'guards',message:'Checking shader memory bounds in parallel',completed:++guarded,total:count});return result;}));
    if(completed!==plan.keys.length||results.size!==plan.keys.length)throw new Error('Parallel shader build omitted keys');
    const names=new Set();for(const file of files){if(names.has(file.path))throw new Error('Parallel shader output collision');names.add(file.path);}
    for(const name of ['c1_full.tsv','cb_extent.tsv']) {
      let header;const rows=new Map();
      for(const result of guards) {
        const lines=result.tables[name].trimEnd().split('\n');
        if(!lines[0].startsWith('# chain b-'+manifest.chain+' inputs '+inputs+' '))throw new Error('Parallel guard table stamp mismatch');
        if(!header)header=lines.filter(s=>s.startsWith('#'));
        for(const line of lines.filter(s=>s&&!s.startsWith('#'))){const key=line.split('\t')[0];if(rows.has(key))throw new Error('Duplicate parallel guard row');rows.set(key,line);}
      }
      py.FS.writeFile(profilePath+'/'+name,encoder.encode([...header,...[...rows].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,line])=>line)].join('\n')+'\n'));
    }
    const ordered=plan.phases.flat().map(k=>results.get(k));
    py.globals.set('_pool_results_json',JSON.stringify(ordered));
    py.globals.set('_pool_inputs',inputs);
    py.runPython(`
_directory='/job/cache/b-'+CHAIN
os.makedirs(_directory,exist_ok=True)
dmsh_chain.write_stamp(_directory,'0100000000010000',str(_pool_inputs))
with open(_directory+'/_b_build.json','w') as _stream: json.dump(json.loads(_pool_results_json),_stream,ensure_ascii=False)
`);
    return {chain:manifest.chain,inputs,shaders:plan.keys.length,directory:'cache/b-'+manifest.chain,files,workers:count,elapsedMs:performance.now()-started,batches};
  } finally {await Promise.all(pool.map(client=>client.close()));}
}

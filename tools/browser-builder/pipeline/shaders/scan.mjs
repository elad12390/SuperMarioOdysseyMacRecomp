// Precompute independent file scans. The original splitter consumes results in
// its original order and still owns deduplication, package indices and tables.
export async function scanParallel({py,manifest,bundleURL,inputFiles,progress}){
  const files=inputFiles.filter(f=>f.name.startsWith('RomFS/')).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
  const count=Math.min(4,Math.max(1,(navigator.hardwareConcurrency||4)-2),files.length);
  if(count<=1)return;
  let next=0,completed=0;
  const workers=Array.from({length:count},()=>new Worker(new URL('./scan-worker.mjs',import.meta.url),{type:'module'}));
  function task(worker,message){return new Promise((resolve,reject)=>{
    worker.onerror=e=>reject(new Error(e.message||'Local shader scanner failed'));
    worker.onmessage=({data})=>data.type==='error'?reject(new Error(data.message)):data.type==='ready'||data.type==='result'?resolve(data):undefined;
    worker.postMessage(message);
  });}
  progress({stage:'split',message:`Finding shaders with ${count} local workers`,completed,total:files.length});
  try{
    await Promise.all(workers.map(async worker=>{
      await task(worker,{type:'init',bundleURL,inputFiles});
      while(next<files.length){
        const file=files[next++],result=await task(worker,{type:'scan',name:file.name});
        if(result.name!==file.name||!(result.bytes instanceof Uint8Array))throw new Error('Local scan result mismatch');
        const proxy=py.toPy(result.bytes);
        try{py.globals.set('_scan_pickle',proxy);}finally{proxy.destroy();}
        // pickle stays local to these owned workers and comes from our exact
        // pinned scan function, never from the game or a fetched file.
        py.runPython("_scanned=pickle.loads(_scan_pickle)\nSCAN_RESULTS[_scanned[0]]=_scanned\ndel _scanned,_scan_pickle");
        completed++;
        progress({stage:'split',message:`Finding shaders with ${count} local workers`,completed,total:files.length,fraction:completed/files.length});
      }
    }));
  }finally{for(const worker of workers)worker.terminate();}
}

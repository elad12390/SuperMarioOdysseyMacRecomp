import { bootstrap } from './worker.mjs';
import { mountFiles } from './file-fs.mjs';
let tools;
onmessage=async({data})=>{
  try{
    if(data.type==='init'){
      tools=await bootstrap(data.bundleURL,{translators:false});
      const {py,manifest,sources,adapter}=tools;
      mountFiles(py,'/input',data.inputFiles);
      py.FS.mkdirTree('/job/profile/0100000000010000');
      py.FS.writeFile('/job/profile/0100000000010000/game.tsv',sources.profile);
      globalThis.shader_tool_identity=()=>JSON.stringify(manifest.identity);
      globalThis.shader_process=()=>{throw new Error('Unexpected subprocess during local shader scan');};
      globalThis.shader_event=()=>{};
      py.globals.set('_browser_config',JSON.stringify({chain:manifest.chain,identity:manifest.identity}));
      py.runPython(adapter);
      py.runPython(`
_scan_scope=execute(SOURCE+'/shader_split.py',[],namespace={'__name__':'_browser_shader_scan'})
import unityfs
try: _common=unityfs.common_strings(_scan_scope['nso_image']('/input/ExeFS/main'))
except ValueError: _common=None
_scan_scope['_pool_init'](_common,{},_scan_scope['zs_dicts']('/input/RomFS'))
`);
      globalThis.fetch=()=>Promise.reject(new Error('Network disabled during local shader scan'));
      postMessage({type:'ready'});
    }else if(data.type==='scan'){
      const {py}=tools;
      py.globals.set('_scan_name',data.name);
      const proxy=py.runPython("pickle.dumps(bounded_scan(_scan_scope['scan_file'],('/input/'+_scan_name,_scan_name[len('RomFS/'):])),protocol=5)");
      let bytes;
      try{bytes=new Uint8Array(proxy.toJs()).slice();}finally{proxy.destroy();}
      postMessage({type:'result',name:data.name,bytes},[bytes.buffer]);
    }else throw new Error('Unsupported local scan command');
  }catch(error){postMessage({type:'error',message:error.stack||String(error)});}
};

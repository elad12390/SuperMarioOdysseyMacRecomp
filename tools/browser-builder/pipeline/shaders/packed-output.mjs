// Private build intermediates share a few append-only stores. The DMG still
// contains every original logical file; size and SHA256 are recorded per file.
export async function exportPacked(py, source, root, files, keys, state) {
  const include=new Set(keys);
  if(!state.access) {
    const shader=await root.getDirectoryHandle('shader',{create:true});
    const packed=await shader.getDirectoryHandle('packed',{create:true});
    state.handle=await packed.getFileHandle(state.name,{create:true});
    state.access=await state.handle.createSyncAccessHandle();state.offset=0;
  }
  for(const name of py.FS.readdir(source).filter(n=>include.has(n.slice(0,16))&&/^[0-9a-f]{16}_b/.test(n)).sort()) {
    const path=source+'/'+name,size=py.FS.stat(path).size,start=state.offset;
    if(!py.FS.isFile(py.FS.stat(path).mode)||name.endsWith('.metallib'))throw new Error('Unexpected packed shader output');
    const stream=py.FS.open(path,'r'),hasher=py.runPython('hashlib.sha256()');
    const buffer=new Uint8Array(Math.min(Math.max(size,1),4*1024*1024));
    try {
      for(let position=0;position<size;) {
        const count=py.FS.read(stream,buffer,0,Math.min(buffer.length,size-position),position);
        if(!count)throw new Error('Unexpected end of packed shader source');
        const bytes=buffer.subarray(0,count),proxy=py.toPy(bytes);
        try{hasher.update(proxy);}finally{proxy.destroy();}
        if(state.access.write(bytes,{at:state.offset})!==count)throw new Error('Incomplete packed shader write');
        position+=count;state.offset+=count;
      }
      files.push({path:'shader/cache/b-'+state.chain+'/'+name,size,sha256:hasher.hexdigest(),
        storagePath:'shader/packed/'+state.name,storageOffset:start});
    } finally {py.FS.close(stream);hasher.destroy();}
  }
}
export function finishPacked(state) {
  if(!state.access)return;
  try{state.access.truncate(state.offset);state.access.flush();}finally{state.access.close();state.access=undefined;}
}

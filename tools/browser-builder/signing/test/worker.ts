import { sealApp, inspectAdhocLauncher } from "../index";
import { entryFromBlob, writeDmgToOpfs } from "../../dmg/index";
import type { DmgEntry } from "../../dmg/types";
declare const self: DedicatedWorkerGlobalScope;
self.onmessage=async()=>{
  try {
    const manifest=await(await fetch("/manifest.json")).json(), entries:DmgEntry[]=[];
    for(const e of manifest.files) {
      const response=await fetch("/"+e.url);if(!response.ok)throw Error("Public fixture fetch failed");const blob=await response.blob();
      if(blob.size!==e.size)throw Error("Public fixture size mismatch");
      const digest=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",await blob.arrayBuffer())),b=>b.toString(16).padStart(2,"0")).join("");
      if(digest!==e.sha256)throw Error("Public fixture hash mismatch");entries.push(entryFromBlob(e.path,blob,e.mode));
    }
    const appName="Super Mario Odyssey.app",prefix=appName+"/Contents/";
    const publicLauncher=entries.find(e=>e.path.endsWith("/MacOS/Launcher"))!;
    async function metadata(e:DmgEntry){const b=new Uint8Array(e.size),r=await e.open!();let at=0;while(at<b.length){const n=await r.read(b.subarray(at));if(!n)throw Error("short");at+=n;}await r.close?.();return b;}
    const originalBytes=await metadata(publicLauncher),originalLayout=inspectAdhocLauncher(originalBytes),rejected:string[]=[];
    for(const kind of ["non-ad-hoc","code-page","CMS"]){
      const corrupt=originalBytes.slice(),v=new DataView(corrupt.buffer);
      if(kind==="non-ad-hoc")v.setUint32(originalLayout.codeDirectoryOffset+12,0);
      else if(kind==="code-page")corrupt[16384]^=1;
      else v.setUint32(originalLayout.cmsOffset+4,9);
      try {await sealApp(entries.map(e=>e===publicLauncher?entryFromBlob(e.path,new Blob([corrupt]),e.mode):e),{appName});throw Error("Unexpected acceptance");}
      catch(e){if(String(e).includes("Unexpected acceptance"))throw e;rejected.push(`${kind}: ${String(e)}`);}
    }
    entries.push(entryFromBlob(prefix+"Resources/game/private & caf\u00e9 <proof>.bin",new Blob(["browser private resource\n"])));
    entries.push(entryFromBlob(prefix+"Resources/game/empty.dat",new Blob([])));
    entries.push(entryFromBlob(prefix+"Resources/Game.icns",new Blob([new Uint8Array([105,99,110,115,0,0,0,8])])));
    let maxRead=0,opens=0,closes=0;const largeSize=32*1024*1024+37;
    entries.push({path:prefix+"Resources/game/streamed-resource.bin",size:largeSize,mode:0o644,open:()=>{
      let at=0;opens++;return {read:b=>{const n=Math.min(b.length,largeSize-at);maxRead=Math.max(maxRead,b.length);b.fill(90,0,n);at+=n;return n;},close:()=>{closes++;}};
    }});
    const root=await navigator.storage.getDirectory(),job=await root.getDirectoryHandle(crypto.randomUUID(),{create:true});
    const start=performance.now();let progressEvents=0;
    const output=await sealApp(entries,{appName,progress:()=>{progressEvents++;}});
    const sealingMs=performance.now()-start;
    const image=await writeDmgToOpfs(output,job,"browser-sealed.dmg",{volumeName:"Browser Sealed Fixture"});
    const file=await image.file.getFile();
    const old=entries.find(e=>e.path.endsWith("/MacOS/Launcher"))!,patched=output.find(e=>e.path.endsWith("/MacOS/Launcher"))!;
    async function read(e:DmgEntry){const b=new Uint8Array(e.size),r=await e.open!();let at=0;while(at<b.length){const n=await r.read(b.subarray(at));if(!n)throw Error("short");at+=n;}await r.close?.();return b;}
    const before=await read(old),after=await read(patched),layout=inspectAdhocLauncher(before);
    const differences=[];for(let i=0;i<before.length;i++)if(before[i]!==after[i])differences.push(i);
    if(differences.some(i=>i<layout.resourceDigestOffset||i>=layout.resourceDigestOffset+32))throw Error("Unexpected executable changes");
    self.postMessage({file,done:true,stats:{sealingMs,progressEvents,largeSize,maxRead,opens,closes,files:output.length,imageBytes:file.size,layout,differences,manifest,rejected,launcherSizeBefore:before.length,launcherSizeAfter:after.length}});
  } catch(e){self.postMessage({error:String(e),stack:e instanceof Error?e.stack:""});}
};

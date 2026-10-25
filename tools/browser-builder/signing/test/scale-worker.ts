import { sealApp,inspectAdhocLauncher } from "../index";
import { entryFromBlob } from "../../dmg/opfs";
import { writeDmgToOpfs } from "../../dmg/index";
import type { DmgEntry } from "../../dmg/types";
declare const self:DedicatedWorkerGlobalScope;
self.onmessage=async()=>{try{
  const manifest=await(await fetch("/manifest.json")).json(),entries:DmgEntry[]=new Array(manifest.files.length);let next=0;
  await Promise.all(Array.from({length:16},async()=>{for(;;){const i=next++;if(i>=manifest.files.length)return;const e=manifest.files[i];const b=await(await fetch("/"+e.url)).blob();const hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",await b.arrayBuffer())),x=>x.toString(16).padStart(2,"0")).join("");if(b.size!==e.size||hash!==e.sha256)throw Error("Template identity mismatch: "+e.path);entries[i]=entryFromBlob(e.path,b,e.mode);}}));
  const appName=manifest.files[0].path.split("/")[0],prefix=appName+"/Contents/Resources/game/scale-proof/";
  let reads=0,maxRead=0;for(let i=0;i<70000;i++)entries.push({path:prefix+`resource-${String(i).padStart(6,"0")}.bin`,size:1,mode:0o644,open:()=>{let done=false;return{read:b=>{maxRead=Math.max(maxRead,b.length);reads++;if(done)return 0;done=true;b[0]=i&255;return 1;}};}});
  self.postMessage({progress:"sealing",privateFiles:70000,templateFiles:manifest.files.length});
  const start=performance.now(),output=await sealApp(entries,{appName});const sealingMs=performance.now()-start;
  const envelope=output.find(e=>e.path.endsWith("/_CodeSignature/CodeResources"))!,launcher=output.find(e=>e.path.endsWith("/MacOS/Launcher"))!;
  async function bytes(e:DmgEntry){const b=new Uint8Array(e.size),r=await e.open!();let at=0;try{while(at<b.length){const n=await r.read(b.subarray(at));if(!n)throw Error("Short metadata");at+=n;}}finally{await r.close?.();}return b;}
  const xml=await bytes(envelope),binary=await bytes(launcher),original=await bytes(entries.find(e=>e.path===launcher.path)!),layout=inspectAdhocLauncher(original);
  const differences=[];for(let i=0;i<binary.length;i++)if(original[i]!==binary[i])differences.push(i);
  if(differences.some(i=>i<layout.resourceDigestOffset||i>=layout.resourceDigestOffset+32))throw Error("Unexpected code change");
  if(xml.length<=8*1024*1024)throw Error("Scale regression did not exceed old limit");
  const sha=async(b:Uint8Array<ArrayBuffer>)=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",b)),x=>x.toString(16).padStart(2,"0")).join("");
  self.postMessage({progress:"writing-dmg",xmlBytes:xml.length,sealingMs});
  const root=await navigator.storage.getDirectory(),job=await root.getDirectoryHandle(crypto.randomUUID(),{create:true}),dmgStart=performance.now();
  const image=await writeDmgToOpfs(output,job,"scale-sealed.dmg",{volumeName:"70k Browser Seal Proof"});
  self.postMessage({done:true,file:await image.file.getFile(),stats:{appName,privateFiles:70000,totalFiles:output.length,templateFiles:manifest.files.length,xmlBytes:xml.length,xmlSha256:await sha(xml),launcherSha256:await sha(binary),originalLauncherSha256:await sha(original),sealingMs,dmgMs:performance.now()-dmgStart,imageBytes:image.imageBytes,reads,maxRead,differences,layout}});
}catch(e){self.postMessage({error:String(e),stack:e instanceof Error?e.stack:""});}};

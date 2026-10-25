import { createSHA1, createSHA256 } from "hash-wasm";
import type { DmgEntry } from "../dmg/types";
import { hfsPath } from "../dmg/names";
import { inspectAdhocLauncher } from "./macho";
import { data, dictionary, insertEnvelope, parseEnvelope } from "./plist";
export { inspectAdhocLauncher } from "./macho";
export interface SealOptions {
  appName: string; signal?: AbortSignal;
  progress?: (p: { phase: "hash" | "sealed"; path: string; hashedBytes: number; totalBytes: number; filesDone: number; totalFiles: number }) => void;
}
const encode = new TextEncoder();
const equal = (a: Uint8Array,b: Uint8Array) => a.length===b.length && a.every((v,i)=>v===b[i]);
function entry(path:string, b:Uint8Array, mode:number):DmgEntry {
  return {path,size:b.length,mode,open:()=>{let at=0;return {read:buffer=>{const n=Math.min(buffer.length,b.length-at);buffer.set(b.subarray(at,at+n));at+=n;return n;}};}};
}
async function small(e:DmgEntry, cap:number, signal?:AbortSignal) {
  if(e.size>cap)throw Error(`Signing metadata exceeds bounded limit: ${e.path}`);
  const bytes=new Uint8Array(e.size); let at=0; const r=await e.open!();
  try { while(at<bytes.length) { signal?.throwIfAborted(); const n=await r.read(bytes.subarray(at)); if(!Number.isInteger(n)||n<=0||n>bytes.length-at)throw Error(`Short or invalid metadata source: ${e.path}`);at+=n; }
    if(await r.read(new Uint8Array(1))!==0)throw Error(`Overlong metadata source: ${e.path}`);
  } finally { await r.close?.(); } return bytes;
}

/** Ad-hoc metadata update only. No certificate signing or native product helper.
 * open() must be repeatable: this pass hashes, then the DMG writer reads payloads.
 */
export async function sealApp(entries:DmgEntry[], options:SealOptions):Promise<DmgEntry[]> {
  const {signal}=options; signal?.throwIfAborted();
  if(!options.appName.endsWith(".app") || hfsPath(options.appName)!==options.appName || options.appName.includes("/"))throw Error("Invalid appName");
  const prefix=options.appName+"/Contents/", map=new Map<string,DmgEntry>();
  for(const e of entries) {
    const path=hfsPath(e.path);
    if(map.has(path))throw Error(`Duplicate normalized entry: ${path}`);
    if(!path.startsWith(options.appName+"/") || !Number.isSafeInteger(e.size)||e.size<0 || !Number.isInteger(e.mode)||e.mode<0||e.mode>0o170777||(e.mode&0o7000))throw Error("Invalid signing entry");
    if(e.type==="directory") { if(e.size!==0||e.open)throw Error("Invalid directory entry"); }
    else if(e.type!==undefined&&e.type!=="file" || typeof e.open!=="function" || (e.mode&0o170000)!==0&&(e.mode&0o170000)!==0o100000)throw Error("Only ordinary files can be resource sealed");
    map.set(path,e);
  }
  const requireEntry=(suffix:string)=>{const e=map.get(prefix+suffix);if(!e||e.type==="directory")throw Error(`Missing signing input: ${suffix}`);return e;};
  const executable=requireEntry("MacOS/Launcher"), envelope=requireEntry("_CodeSignature/CodeResources"), info=requireEntry("Info.plist");
  requireEntry("MacOS/dmhost");
  const launcher=await small(executable,16*1024*1024,signal), oldResources=await small(envelope,8*1024*1024,signal), infoBytes=await small(info,1024*1024,signal);
  const layout=inspectAdhocLauncher(launcher), sha256=await createSHA256(), sha1=await createSHA1();
  const digest=(bytes:Uint8Array)=>{sha256.init();sha256.update(bytes);return sha256.digest("binary");};
  const special=(slot:number)=>launcher.subarray(layout.codeDirectoryOffset+layout.hashOffset-slot*32,layout.codeDirectoryOffset+layout.hashOffset-(slot-1)*32);
  if(!equal(special(3),digest(oldResources)))throw Error("Original CodeResources digest mismatch");
  if(!equal(special(1),digest(infoBytes)))throw Error("Original Info.plist digest mismatch");
  if(!equal(special(2),digest(launcher.subarray(layout.requirementsOffset,layout.requirementsOffset+layout.requirementsLength))))throw Error("Original requirements digest mismatch");
  for(let i=0;i<layout.codeSlots;i++) {
    signal?.throwIfAborted(); const wanted=launcher.subarray(layout.codeDirectoryOffset+layout.hashOffset+i*32,layout.codeDirectoryOffset+layout.hashOffset+(i+1)*32);
    if(!equal(wanted,digest(launcher.subarray(i*layout.pageSize,Math.min((i+1)*layout.pageSize,layout.codeLimit)))))throw Error("Original signed code-page digest mismatch");
  }
  const xml=new TextDecoder("utf-8",{fatal:true}).decode(oldResources), parsed=parseEnvelope(xml);
  for(const [full,e] of map) {
    if(e.type==="directory")continue;
    const relative=full.startsWith(prefix)?full.slice(prefix.length):"";
    if(!relative || !relative.startsWith("Resources/") && !["MacOS/Launcher","Info.plist","_CodeSignature/CodeResources"].includes(relative) && !parsed.second.has(relative))throw Error(`Unexpected file outside existing template/game resources: ${full}`);
  }
  const resources=[...map].filter(([path,e])=>path.startsWith(prefix+"Resources/") && e.type!=="directory");
  const seen=new Set<string>(), additions:{path:string;sha1:Uint8Array;sha256:Uint8Array}[]=[];
  let totalBytes=0; for(const [,e] of resources) {totalBytes+=e.size;if(!Number.isSafeInteger(totalBytes))throw Error("Resource total exceeds safe integer range");}
  let hashedBytes=0,filesDone=0,lastYield=0; const buffer=new Uint8Array(1024*1024);
  for(const [full,e] of resources) {
    const path=full.slice(prefix.length), legacy=parsed.first.get(path), modern=parsed.second.get(path);
    if(!!legacy!==!!modern)throw Error(`Inconsistent existing resource seal: ${path}`);
    if(!legacy && !path.startsWith("Resources/game/") && path!=="Resources/Game.icns")throw Error(`New resource outside permitted game/icon paths: ${path}`);
    sha1.init();sha256.init(); signal?.throwIfAborted(); const r=await e.open!(); let remaining=e.size;
    try {
      while(remaining>0) {
        signal?.throwIfAborted();const part=buffer.subarray(0,Math.min(buffer.length,remaining)), n=await r.read(part);
        if(!Number.isInteger(n)||n<=0||n>part.length)throw Error(`Short/invalid resource source: ${path}`);
        sha1.update(part.subarray(0,n));sha256.update(part.subarray(0,n));remaining-=n;hashedBytes+=n;
        options.progress?.({phase:"hash",path:e.path,hashedBytes,totalBytes,filesDone,totalFiles:resources.length});
        if(hashedBytes-lastYield>=16*1024*1024) {await new Promise<void>(r=>setTimeout(r,0));lastYield=hashedBytes;}
      }
      signal?.throwIfAborted(); if(await r.read(buffer.subarray(0,1))!==0)throw Error(`Overlong resource source: ${path}`);
    } finally {await r.close?.();}
    const a=sha1.digest("binary"), b=sha256.digest("binary");
    if(legacy&&modern) {const fields=dictionary(modern), hash=fields.get("hash2");if(!hash||!equal(data(legacy,20),a)||!equal(data(hash,32),b))throw Error(`Existing resource changed: ${path}`);}
    else additions.push({path,sha1:a,sha256:b});
    seen.add(path);filesDone++;
  }
  for(const path of parsed.first.keys())if(!seen.has(path))throw Error(`Missing originally sealed resource: ${path}`);
  for(const path of parsed.second.keys())if(path.startsWith("Resources/")&&!seen.has(path))throw Error(`Missing originally sealed resource: ${path}`);
  additions.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  const updated=encode.encode(insertEnvelope(xml,parsed,additions));if(updated.length>8*1024*1024)throw Error("Updated CodeResources exceeds metadata bound");
  const patched=launcher.slice();patched.set(digest(updated),layout.resourceDigestOffset);signal?.throwIfAborted();
  options.progress?.({phase:"sealed",path:envelope.path,hashedBytes,totalBytes,filesDone,totalFiles:resources.length});
  return entries.map(e=>e===executable?entry(e.path,patched,e.mode):e===envelope?entry(e.path,updated,e.mode):e);
}

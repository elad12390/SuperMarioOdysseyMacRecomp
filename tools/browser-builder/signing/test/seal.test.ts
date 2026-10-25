import { beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sealApp, inspectAdhocLauncher } from "../index";
import { data, dictionary, parseEnvelope } from "../plist";
import { entryFromBlob } from "../../dmg/opfs";
import type { DmgEntry } from "../../dmg/types";

const repo = resolve(import.meta.dir, "../../../.."), pub = resolve(process.env.SWITCHRECOMP_RUNTIME_PUBLIC ?? resolve(repo, "tmp/odyssey/browser-release/runtime-public/public"));
let entries: DmgEntry[], launcher: Uint8Array, resources: Uint8Array;
const appName = "Super Mario Odyssey.app", prefix = appName + "/Contents/";
const hex = (b: Uint8Array, name = "sha256") => createHash(name).update(b).digest("hex");
function entry(path: string, bytes: Uint8Array, mode = 0o644): DmgEntry {
  return { path, size: bytes.length, mode, open: () => { let at = 0; return { read: buffer => { const n = Math.min(buffer.length, bytes.length - at); buffer.set(bytes.subarray(at, at+n)); at += n; return n; } }; } };
}
async function bytes(e: DmgEntry) {
  const out = new Uint8Array(e.size), r = await e.open!(); let at = 0;
  try { while (at < out.length) { const n = await r.read(out.subarray(at)); if (!n) throw Error("short"); at += n; } } finally { await r.close?.(); } return out;
}
beforeAll(async () => {
  const manifest = JSON.parse(await readFile(resolve(pub, "manifest.json"), "utf8")); entries = [];
  for (const e of manifest.files) { const b = await readFile(resolve(pub, "files", e.path)); expect(hex(b)).toBe(e.sha256); entries.push(entry(e.path, b, e.mode)); }
  launcher = await bytes(entries.find(e => e.path.endsWith("/MacOS/Launcher"))!);
  resources = await bytes(entries.find(e => e.path.endsWith("/_CodeSignature/CodeResources"))!);
});

test("seals the actual template by changing only slot 3 and adding both resource digests", async () => {
  const privateBytes = new TextEncoder().encode("original private-resource fixture\n");
  const path = prefix + "Resources/game/private & escaped<name>.bin";
  const output = await sealApp([...entries, entry(path, privateBytes)], { appName });
  const sealedLauncher = await bytes(output.find(e => e.path.endsWith("/MacOS/Launcher"))!);
  const sealedResources = await bytes(output.find(e => e.path.endsWith("/_CodeSignature/CodeResources"))!);
  const layout = inspectAdhocLauncher(launcher);
  expect(sealedLauncher.length).toBe(launcher.length);
  for (let i = 0; i < launcher.length; i++) if (i < layout.resourceDigestOffset || i >= layout.resourceDigestOffset + 32) expect(sealedLauncher[i]).toBe(launcher[i]);
  expect(hex(sealedResources)).toBe(Buffer.from(sealedLauncher.subarray(layout.resourceDigestOffset, layout.resourceDigestOffset + 32)).toString("hex"));
  const xml = new TextDecoder().decode(sealedResources);
  expect(xml).toContain("private &amp; escaped&lt;name&gt;.bin");
  expect(xml).toContain(createHash("sha1").update(privateBytes).digest("base64"));
  expect(xml).toContain(createHash("sha256").update(privateBytes).digest("base64"));
  const oldHostSeal = parseEnvelope(new TextDecoder().decode(resources)).second.get('MacOS/dmhost');
  expect(oldHostSeal).toBeDefined();
  expect(parseEnvelope(xml).second.get('MacOS/dmhost')?.text).toBe(oldHostSeal!.text);
  const host = entries.find(e => e.path.endsWith("/MacOS/dmhost"))!;
  expect(output.find(e => e.path === host.path)).toBe(host);
});

test("rejects malformed/non-thin/non-ARM64/non-ad-hoc/wrong-hash/CMS layouts", () => {
  const layout = inspectAdhocLauncher(launcher);
  const mutations: [string, (b: Uint8Array, v: DataView) => void][] = [
    ["fat", (_, v) => v.setUint32(0, 0xcafebabe)],
    ["x86", (_, v) => v.setUint32(4, 0x01000007, true)],
    ["certificate", (_, v) => v.setUint32(layout.codeDirectoryOffset + 12, 0)],
    ["wrong hash", b => { b[layout.codeDirectoryOffset + 37] = 1; }],
    ["bad extent", (_, v) => v.setUint32(layout.signatureCommandOffset + 8, 0xffffffff, true)],
    ["CMS", (_, v) => v.setUint32(layout.cmsOffset + 4, 9)],
    ["truncated CD", (_, v) => v.setUint32(layout.codeDirectoryOffset + 4, 44)],
  ];
  for (const [name, mutate] of mutations) { const b = launcher.slice(); mutate(b, new DataView(b.buffer)); expect(() => inspectAdhocLauncher(b), name).toThrow(); }
});

test("rejects original code-page, Info, envelope and existing-resource tampering", async () => {
  for (const suffix of ["MacOS/Launcher", "Info.plist", "_CodeSignature/CodeResources", "Resources/game/font/standard.ttf"]) {
    const changed = entries.map(e => ({ ...e })); const i = changed.findIndex(e => e.path === prefix + suffix);
    const b = await bytes(changed[i]); b[suffix === "MacOS/Launcher" ? 16384 : b.length - 2] ^= 1; changed[i] = entry(changed[i].path, b, changed[i].mode);
    await expect(sealApp(changed, { appName })).rejects.toThrow();
  }
});

test("streams a generated resource through bounded read buffers and closes on cancellation", async () => {
  let max = 0, closed = false, left = 20 * 1024 * 1024;
  const ctrl = new AbortController();
  const big: DmgEntry = { path: prefix + "Resources/game/stream.bin", size: left, mode: 0o644, open: () => ({ read: b => { max = Math.max(max, b.length); const n = Math.min(b.length, left); b.fill(90, 0, n); left -= n; return n; }, close: () => { closed = true; } }) };
  await expect(sealApp([...entries, big], { appName, signal: ctrl.signal, progress: p => { if (p.path === big.path && p.hashedBytes > 2 * 1024 * 1024) ctrl.abort(Error("cancel")); } })).rejects.toThrow("cancel");
  expect(max).toBeLessThanOrEqual(1024 * 1024); expect(closed).toBe(true); expect(left).toBeGreaterThan(0);
});

test("rejects duplicate paths, new resources outside the permitted area and short streams", async () => {
  await expect(sealApp([...entries, entries[0]], { appName })).rejects.toThrow(/duplicate/i);
  await expect(sealApp([...entries, entry(prefix + "Resources/outside.bin", new Uint8Array(1))], { appName })).rejects.toThrow();
  await expect(sealApp([...entries, entry(prefix + "MacOS/unexpected", new Uint8Array(1))], { appName })).rejects.toThrow(/outside|unexpected/i);
  await expect(sealApp([...entries, entry(prefix + "Resources/game/../escape.bin", new Uint8Array(1))], { appName })).rejects.toThrow();
  await expect(sealApp([...entries, { ...entry(prefix + "Resources/game/short.bin", new Uint8Array(1)), size: 100 }], { appName })).rejects.toThrow(/short|EOF/i);
});

test("XML insertion rejects malformed entities, duplicate keys and unbalanced containers", () => {
  const xml = new TextDecoder().decode(resources);
  expect(() => parseEnvelope(xml.replace("<key>rules</key>", "<key>rules</key><dict/><key>rules</key>"))).toThrow();
  expect(() => parseEnvelope(xml.slice(0, -15))).toThrow();
  expect(() => parseEnvelope(xml.replace('<string>cdhash H"', '<string>&unknown;cdhash H"'))).toThrow();
});

test("trusted input-envelope cap remains 8 MiB and rejects before opening", async () => {
  let opened=false;
  const changed=entries.map(e=>e.path.endsWith("/_CodeSignature/CodeResources")?{...e,size:8*1024*1024+1,open:()=>{opened=true;throw Error("must not open oversized input");}}:e);
  await expect(sealApp(changed,{appName})).rejects.toThrow(/metadata exceeds bounded limit/);
  expect(opened).toBe(false);
});

test("bounded resource lanes preserve exact per-resource digests and close every reader", async () => {
  let active=0,maximum=0,opens=0,closes=0;
  const expected=new Map<string,Uint8Array>();
  const privateEntries:DmgEntry[]=Array.from({length:13},(_,i)=>{
    const path=prefix+`Resources/game/lane-${i}.bin`,payload=Uint8Array.from({length:65537+i*257},(_,n)=>(n*31+i)&255);
    expected.set(path,payload);
    const blob=new Blob([payload]);
    return {path,size:blob.size,mode:0o644,async open(){
      active++;opens++;maximum=Math.max(maximum,active);let at=0;
      return {async read(buffer){const part=new Uint8Array(await blob.slice(at,at+Math.min(buffer.length,8191)).arrayBuffer());buffer.set(part);at+=part.length;return part.length;},close(){active--;closes++;}};
    }};
  });
  const progress:{hashedBytes:number;filesDone:number}[]=[];
  const output=await sealApp([...entries,...privateEntries],{appName,progress:p=>progress.push(p)});
  const envelope=parseEnvelope(new TextDecoder().decode(await bytes(output.find(e=>e.path.endsWith("/_CodeSignature/CodeResources"))!)));
  for(const [path,payload]of expected){
    const relative=path.slice(prefix.length);
    expect(Buffer.from(data(envelope.first.get(relative)!,20)).toString("hex")).toBe(hex(payload,"sha1"));
    expect(Buffer.from(data(dictionary(envelope.second.get(relative)!).get("hash2")!,32)).toString("hex")).toBe(hex(payload));
  }
  expect(maximum).toBeGreaterThan(1);expect(maximum).toBeLessThanOrEqual(4);
  expect(opens).toBe(13);expect(closes).toBe(opens);expect(active).toBe(0);
  for(let i=1;i<progress.length;i++){
    expect(progress[i]!.hashedBytes).toBeGreaterThanOrEqual(progress[i-1]!.hashedBytes);
    expect(progress[i]!.filesDone).toBeGreaterThanOrEqual(progress[i-1]!.filesDone);
  }
});

test("resource failure drains and closes the bounded in-flight readers before rejecting", async () => {
  let opens=0,closes=0,active=0,maximum=0;
  const privateEntries:DmgEntry[]=Array.from({length:12},(_,i)=>{
    const payload=new Blob([Uint8Array.of(i,17,29)]);
    return {path:prefix+`Resources/game/failure-${i}.bin`,size:3,mode:0o644,open(){
      opens++;active++;maximum=Math.max(maximum,active);let at=0;
      return {async read(buffer){const part=new Uint8Array(await payload.slice(at,at+buffer.length).arrayBuffer());if(i===0)throw Error("source failed");buffer.set(part);at+=part.length;return part.length;},close(){closes++;active--;}};
    }};
  });
  await expect(sealApp([...entries,...privateEntries],{appName})).rejects.toThrow("source failed");
  expect(opens).toBeGreaterThan(0);expect(maximum).toBeLessThanOrEqual(4);
  expect(closes).toBe(opens);expect(active).toBe(0);
});

test("bounded lanes still reject overlong streams and close all active readers on cancellation", async () => {
  await expect(sealApp([...entries,{...entry(prefix+"Resources/game/overlong.bin",Uint8Array.of(1,2)),size:1}],{appName})).rejects.toThrow(/overlong/i);
  const control=new AbortController();let opens=0,closes=0;
  const sources:DmgEntry[]=Array.from({length:8},(_,i)=>({path:prefix+`Resources/game/cancel-${i}.bin`,size:3*1024*1024,mode:0o644,open(){
    opens++;let remaining=3*1024*1024;
    return {async read(buffer){const n=Math.min(buffer.length,remaining);buffer.fill(i,0,n);remaining-=n;await Promise.resolve();return n;},close(){closes++;}};
  }}));
  await expect(sealApp([...entries,...sources],{appName,signal:control.signal,progress:p=>{if(p.path.includes("/cancel-"))control.abort(Error("stop lanes"));}})).rejects.toThrow("stop lanes");
  expect(opens).toBeGreaterThan(0);expect(opens).toBeLessThanOrEqual(4);expect(closes).toBe(opens);
});

test("checks the conversion SHA-256 on real resource bytes in the existing single read pass", async () => {
  const file=Bun.file(resolve(pub,"files",prefix+"Resources/game/font/standard.ttf"));
  const source=entryFromBlob(prefix+"Resources/game/converted-font.ttf",file);
  const expectedSha256=hex(new Uint8Array(await file.arrayBuffer())).toUpperCase();
  let opens=0;
  const checked:DmgEntry={...source,expectedSha256,open:()=>{opens++;return source.open!();}};
  const original=await sealApp([...entries,source],{appName});
  const verified=await sealApp([...entries,checked],{appName});
  expect(opens).toBe(1);
  expect(verified.find(e=>e.path===checked.path)).toBe(checked);
  for(const suffix of ["MacOS/Launcher","_CodeSignature/CodeResources"]){
    expect(await bytes(verified.find(e=>e.path===prefix+suffix)!)).toEqual(await bytes(original.find(e=>e.path===prefix+suffix)!));
  }
});

test("rejects same-size corrupted converted resource bytes or digest before updating the seal", async () => {
  const payload=new Uint8Array(await Bun.file(resolve(pub,"files",prefix+"Resources/game/font/standard.ttf")).arrayBuffer());
  const corrupt=payload.slice();corrupt[Math.floor(corrupt.length/2)]!^=1;
  const expectedSha256=hex(payload);
  const beforeLauncher=await bytes(entries.find(e=>e.path===prefix+"MacOS/Launcher")!);
  const beforeResources=await bytes(entries.find(e=>e.path===prefix+"_CodeSignature/CodeResources")!);
  for(const [input,expected]of [[corrupt,expectedSha256],[payload,"0".repeat(64)]] as const){
    const file=new File([input],"converted-font.ttf");
    const source={...entryFromBlob(prefix+"Resources/game/converted-font.ttf",file),expectedSha256:expected};
    expect(source.size).toBe(payload.length);
    let sealed=false;
    await expect(sealApp([...entries,source],{appName,progress:p=>{if(p.phase==="sealed")sealed=true;}})).rejects.toThrow(/Resource SHA-256 mismatch.*converted-font\.ttf/);
    expect(sealed).toBe(false);
  }
  expect(await bytes(entries.find(e=>e.path===prefix+"MacOS/Launcher")!)).toEqual(beforeLauncher);
  expect(await bytes(entries.find(e=>e.path===prefix+"_CodeSignature/CodeResources")!)).toEqual(beforeResources);
});

test("rejects malformed expected SHA-256 before opening or hashing real resources", async () => {
  const file=Bun.file(resolve(pub,"files",prefix+"Resources/game/font/standard.ttf"));
  const resource=entryFromBlob(prefix+"Resources/game/converted-font.ttf",file);
  const invalid:unknown[]=["","a".repeat(63),"a".repeat(65),"g".repeat(64),"a".repeat(64)+"\n"," "+"a".repeat(63),"0x"+"a".repeat(62),null,123];
  for(const expectedSha256 of invalid){
    let opened=false,progress=0;
    const source:DmgEntry={...resource,expectedSha256:expectedSha256 as string,open:()=>{opened=true;return resource.open!();}};
    await expect(sealApp([...entries,source],{appName,progress:()=>{progress++;}})).rejects.toThrow(/Invalid expected SHA-256/);
    expect(opened).toBe(false);expect(progress).toBe(0);
  }
});

// Observe actual WebCrypto calls; the real native digest implementation runs.
async function observeNativeDigests<T>(observe:(algorithm:AlgorithmIdentifier,input:BufferSource)=>void,run:()=>Promise<T>) {
  const subtle=crypto.subtle,descriptor=Object.getOwnPropertyDescriptor(subtle,"digest"),digest=subtle.digest.bind(subtle);
  Object.defineProperty(subtle,"digest",{configurable:true,value:(algorithm:AlgorithmIdentifier,input:BufferSource)=>{observe(algorithm,input);return digest(algorithm,input);}});
  try{return await run();}finally{if(descriptor)Object.defineProperty(subtle,"digest",descriptor);else Reflect.deleteProperty(subtle,"digest");}
}
const nativePayload=()=>Uint8Array.from({length:2*1024*1024},(_,i)=>(i*17+(i>>>8))&255);

test("native SHA-1/SHA-256 seals a real 2 MiB File once with independent digests and exact signature bytes", async () => {
  const payload=nativePayload(),path=prefix+"Resources/game/native-2m.bin";
  const source=entryFromBlob(path,new File([payload],"native-2m.bin"));
  const expectedSha1=new Bun.CryptoHasher("sha1").update(payload).digest("hex"),expectedSha256=new Bun.CryptoHasher("sha256").update(payload).digest("hex");
  let opens=0,closes=0,maxRead=0;
  const checked:DmgEntry={...source,expectedSha256,async open(){opens++;const r=await source.open!();return {read(buffer){maxRead=Math.max(maxRead,buffer.length);return r.read(buffer.subarray(0,Math.min(buffer.length,65537)));},async close(){closes++;await r.close?.();}};}};
  const calls:string[]=[];
  const output=await observeNativeDigests((algorithm,input)=>{if(input.byteLength===payload.length)calls.push(String(algorithm));},()=>sealApp([...entries,checked],{appName}));
  expect(calls.sort()).toEqual(["SHA-1","SHA-256"]);expect(opens).toBe(1);expect(closes).toBe(1);expect(maxRead).toBeLessThanOrEqual(1024*1024);
  const resourceBytes=await bytes(output.find(e=>e.path===prefix+"_CodeSignature/CodeResources")!),parsed=parseEnvelope(new TextDecoder().decode(resourceBytes)),relative=path.slice(prefix.length);
  expect(Buffer.from(data(parsed.first.get(relative)!,20)).toString("hex")).toBe(expectedSha1);
  expect(Buffer.from(data(dictionary(parsed.second.get(relative)!).get("hash2")!,32)).toString("hex")).toBe(expectedSha256);
  const wanted=launcher.slice(),layout=inspectAdhocLauncher(launcher);
  wanted.set(new Bun.CryptoHasher("sha256").update(resourceBytes).digest(),layout.resourceDigestOffset);
  expect(await bytes(output.find(e=>e.path===prefix+"MacOS/Launcher")!)).toEqual(wanted);
});

test("unavailable WebCrypto falls back to real streaming WASM with identical signing metadata", async () => {
  const payload=nativePayload(),source={...entryFromBlob(prefix+"Resources/game/fallback-2m.bin",new File([payload],"fallback.bin")),expectedSha256:hex(payload)};
  const native=await sealApp([...entries,source],{appName}),descriptor=Object.getOwnPropertyDescriptor(globalThis,"crypto");
  let streamed:DmgEntry[];
  Object.defineProperty(globalThis,"crypto",{configurable:true,value:undefined});
  try{streamed=await sealApp([...entries,source],{appName});}finally{if(descriptor)Object.defineProperty(globalThis,"crypto",descriptor);else Reflect.deleteProperty(globalThis,"crypto");}
  for(const suffix of ["MacOS/Launcher","_CodeSignature/CodeResources"]){
    expect(await bytes(streamed.find(e=>e.path===prefix+suffix)!)).toEqual(await bytes(native.find(e=>e.path===prefix+suffix)!));
  }
});

test("an unsupported native algorithm falls back over retained bytes without reopening the real File", async () => {
  const payload=nativePayload(),path=prefix+"Resources/game/unsupported-native.bin",source=entryFromBlob(path,new File([payload],"unsupported.bin"));
  const subtle=crypto.subtle,descriptor=Object.getOwnPropertyDescriptor(subtle,"digest"),digest=subtle.digest.bind(subtle);let opens=0,closes=0;
  // Ask the actual provider for an unsupported algorithm to exercise its real
  // NotSupportedError, while SHA-256 still runs through the real native path.
  Object.defineProperty(subtle,"digest",{configurable:true,value:(algorithm:AlgorithmIdentifier,input:BufferSource)=>digest(input.byteLength===payload.length&&algorithm==="SHA-1"?"SHA-NOT-SUPPORTED":algorithm,input)});
  let output:DmgEntry[];
  try{output=await sealApp([...entries,{...source,expectedSha256:hex(payload),async open(){opens++;const r=await source.open!();return {read:buffer=>r.read(buffer),async close(){closes++;await r.close?.();}};}}],{appName});}
  finally{if(descriptor)Object.defineProperty(subtle,"digest",descriptor);else Reflect.deleteProperty(subtle,"digest");}
  expect(opens).toBe(1);expect(closes).toBe(1);
  const parsed=parseEnvelope(new TextDecoder().decode(await bytes(output.find(e=>e.path===prefix+"_CodeSignature/CodeResources")!))),relative=path.slice(prefix.length);
  expect(Buffer.from(data(parsed.first.get(relative)!,20)).toString("hex")).toBe(new Bun.CryptoHasher("sha1").update(payload).digest("hex"));
  expect(Buffer.from(data(dictionary(parsed.second.get(relative)!).get("hash2")!,32)).toString("hex")).toBe(hex(payload));
});

test("native-sized short, overlong and digest-mismatched real Files reject and close their readers", async () => {
  const payload=nativePayload(),blob=new File([payload],"native-invalid.bin");
  for(const [size,expectedSha256,error]of [[payload.length+1,hex(payload),/Short\/invalid/],[payload.length-1,undefined,/Overlong/],[payload.length,"0".repeat(64),/SHA-256 mismatch/]] as const){
    const source=entryFromBlob(prefix+"Resources/game/native-invalid.bin",blob);let opens=0,closes=0,sealed=false;
    const checked:DmgEntry={...source,size,expectedSha256,async open(){opens++;const r=await source.open!();return {read:buffer=>r.read(buffer),async close(){closes++;await r.close?.();}};}};
    await expect(sealApp([...entries,checked],{appName,progress:p=>{if(p.phase==="sealed")sealed=true;}})).rejects.toThrow(error);
    expect(opens).toBe(1);expect(closes).toBe(1);expect(sealed).toBe(false);
  }
});

test("abort during real native digest jobs drains them and returns no sealed metadata", async () => {
  const payload=nativePayload(),source=entryFromBlob(prefix+"Resources/game/native-cancel.bin",new File([payload],"cancel.bin")),control=new AbortController();
  let closes=0,sealed=false;
  const checked:DmgEntry={...source,async open(){const r=await source.open!();return {read:buffer=>r.read(buffer),async close(){closes++;await r.close?.();}};}};
  await expect(observeNativeDigests((algorithm,input)=>{if(input.byteLength===payload.length&&algorithm==="SHA-256")control.abort(Error("cancel native digest"));},()=>sealApp([...entries,checked],{appName,signal:control.signal,progress:p=>{if(p.phase==="sealed")sealed=true;}}))).rejects.toThrow("cancel native digest");
  expect(closes).toBe(1);expect(sealed).toBe(false);
});

test("native hashing respects both inclusive size bounds and streams resources outside them", async () => {
  const seed=nativePayload();
  for(const size of [256*1024-1,256*1024,64*1024*1024,64*1024*1024+1]){
    const chunks:Uint8Array<ArrayBuffer>[]=[];for(let at=0;at<size;at+=seed.length)chunks.push(seed.subarray(0,Math.min(seed.length,size-at)));
    const blob=new Blob(chunks),source=entryFromBlob(prefix+`Resources/game/boundary-${size}.bin`,blob),expected=new Bun.CryptoHasher("sha256");
    for(const chunk of chunks)expected.update(chunk);
    const calls:string[]=[];
    await observeNativeDigests((algorithm,input)=>{if(input.byteLength===size)calls.push(String(algorithm));},()=>sealApp([...entries,{...source,expectedSha256:expected.digest("hex")}],{appName}));
    expect(calls.sort()).toEqual(size>=256*1024&&size<=64*1024*1024?["SHA-1","SHA-256"]:[]);
  }
});

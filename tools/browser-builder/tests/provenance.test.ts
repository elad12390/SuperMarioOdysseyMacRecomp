import { test, expect } from 'bun:test';
import { generateBrowserProvenance, prepareBrowserProvenance } from '../pipeline/provenance';
function input(file = new File(['abc'], 'dump.nsp')) { return {
 nsp:file,
 extraction:{titleId:'0100000000010000',version:'1.0.0',mainBuildId:'3ca12dfaaf9c82da064d1698df79cda100000000000000000000000000000000'},
 rewriter:{provenance:{nxnativeRevision:'0045c1dfb639f9775891382646ad38c2a11c56bf',odysseyPatchSha256:'98cfcc7d1456941d75c3c3ef7be1b0e9194a0d73d6fae7a1604f90cdc157aaff',pyodide:'0.28.3',emscripten:'4.0.9',capstone:'5.0.6',lz4:'4.4.4'},modules:[{name:'main',buildId:'3ca12dfaaf9c82da064d1698df79cda1',inputSize:15388240}]},
 shaderChain:'browser-chain-20261025',
 runtimeSource:{repository:'https://github.com/seedds/nxnative',commit:'0045c1dfb639f9775891382646ad38c2a11c56bf',patches:{'scripts/patches/runtime.patch':'a'.repeat(64)}}
}; }
async function text(entry:any) { const reader=await entry.open(); const parts:Uint8Array[]=[]; const buffer=new Uint8Array(17); try {for(;;){const n=await reader.read(buffer);if(!n)break;parts.push(buffer.slice(0,n));}}finally{await reader.close?.();}return new Blob(parts).text(); }
test('real File abc SHA-256, parseable escaped TOML, repeatable DmgEntry and facts only', async()=>{
 const filename='quote" backslash\\ newline\n[owner]\nverified=true\t\u007f 😀.nsp';
 const value={...input(new File(['abc'],filename)), prodKeys:new File(['NEVER_RECORD_KEY_CONTENTS'], 'prod.keys'), ownershipVerified:true};
 const entry=await generateBrowserProvenance(value);
 expect(entry.path).toBe('Super Mario Odyssey.app/Contents/Resources/game/provenance.toml');expect(entry.mode).toBe(0o644);
 const body=await text(entry), doc=Bun.TOML.parse(body) as any;
 expect(new TextEncoder().encode(body).length).toBe(entry.size);expect(await text(entry)).toBe(body);
 expect(doc.input.source).toBe('user-selected-local-file');expect(doc.input.filename).toBe(filename);expect(doc.input.size_bytes).toBe(3);
 expect(doc.input.sha256).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
 expect(doc.game.title_id).toBe(value.extraction.titleId);expect(doc.modules[0].build_id).toBe(value.rewriter.modules[0].buildId);
 expect(doc.rewriter.nxnative_revision).toBe(value.rewriter.provenance.nxnativeRevision);expect(doc.runtime.patches['scripts/patches/runtime.patch']).toBe('a'.repeat(64));
 expect(doc.shaders.chain).toBe(value.shaderChain);expect(doc.asset_scope).toBe('local-generated-game-output');
 expect(body.includes('NEVER_RECORD_KEY_CONTENTS')).toBe(false);expect('owner' in doc).toBe(false);expect('ownershipVerified' in doc).toBe(false);
});
test('real multi-chunk File matches independent SHA-256 and reports 1 MiB increments', async()=>{
 const bytes=new Uint8Array(2*1048576+17).fill(97);const file=new File([bytes],'large.nsp');const progress:any[]=[];
 const entry=await generateBrowserProvenance(input(file),undefined,p=>progress.push(p));const doc=Bun.TOML.parse(await text(entry)) as any;
 expect(doc.input.sha256).toBe(new Bun.CryptoHasher('sha256').update(bytes).digest('hex'));
 const hashed=[...new Set(progress.map(p=>p.hashedBytes))];expect(hashed).toEqual([0,1048576,2097152,2097169]);expect(progress.at(-1).fraction).toBe(1);
});
test('empty real File has the standard empty SHA-256', async()=>{
 const doc=Bun.TOML.parse(await text(await generateBrowserProvenance(input(new File([],'empty.nsp'))))) as any;
 expect(doc.input.sha256).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});
test('cancellation is checked before work and between actual chunks', async()=>{
 const pre=new AbortController();pre.abort();await expect(generateBrowserProvenance(input(),pre.signal)).rejects.toMatchObject({name:'AbortError'});
 const controller=new AbortController(), seen:number[]=[];
 await expect(generateBrowserProvenance(input(new File([new Uint8Array(2*1048576)],'cancel.nsp')),controller.signal,p=>{seen.push(p.hashedBytes);if(p.hashedBytes===1048576)controller.abort();})).rejects.toMatchObject({name:'AbortError'});
 expect(seen.at(-1)).toBe(1048576);
});
test('invalid static identifiers and authenticated source URLs fail before hashing', async()=>{
 for(const value of [{...input(),extraction:{...input().extraction,titleId:'bad'}},{...input(),runtimeSource:{...input().runtimeSource,repository:'https://user:password@example.com/repo'}},{...input(),rewriter:{...input().rewriter,modules:[input().rewriter.modules[0],input().rewriter.modules[0]]}}]){
  let calls=0;await expect(generateBrowserProvenance(value,undefined,()=>calls++)).rejects.toThrow();expect(calls).toBe(0);
 }
});
test('overlapped input hashing produces identical provenance for the same selected File', async()=>{
 const value=input(new File([new Uint8Array(3*1048576+19).fill(37)],'overlapped.nsp'));
 const prepared=prepareBrowserProvenance(value.nsp);
 const expected=await generateBrowserProvenance(value);
 expect(await text(await prepared(value))).toBe(await text(expected));
 expect(()=>prepared(input(new File(['different'],'overlapped.nsp')))).toThrow('different selected file');
});
test('an aborted prepared hash cannot be accepted later during packaging', async()=>{
 const controller=new AbortController(),value=input(new File([new Uint8Array(2*1048576)],'aborted.nsp'));
 const prepared=prepareBrowserProvenance(value.nsp,controller.signal);controller.abort();
 await expect(prepared(value)).rejects.toMatchObject({name:'AbortError'});
});

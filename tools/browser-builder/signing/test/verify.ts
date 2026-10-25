/** Native independent verification ONLY. Never signs, creates an image or runs an app. */
import { copyFile,cp,mkdir,readFile,writeFile } from "node:fs/promises";
import { resolve,join } from "node:path";
import { hfsPath } from "../../dmg/names";
const repo=resolve(import.meta.dir,"../../../.."),scratch=resolve(repo,"tmp/odyssey/browser-signing"),pub=resolve(repo,"tmp/odyssey/browser-release/runtime-public/public/files");
const mount=resolve(scratch,"mount"),dest=resolve(scratch,"relocated"),appName="Super Mario Odyssey.app";
await mkdir(mount,{recursive:true});await mkdir(dest,{recursive:true});
const results:{name:string;args:string[];pid:number;status:number;stdout:string;stderr:string}[]=[];
async function cmd(name:string,args:string[],expected=0){
  const child=Bun.spawn(args,{stdout:"pipe",stderr:"pipe"});await writeFile(resolve(scratch,name+".pid"),String(child.pid)+"\n");
  const [stdout,stderr,status]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  const r={name,args,pid:child.pid,status,stdout,stderr};results.push(r);await writeFile(resolve(scratch,name+".json"),JSON.stringify(r,null,2)+"\n");console.log(JSON.stringify(r));
  if(expected===0?status!==0:status===0)throw Error(`Unexpected ${name} exit ${status}`);return r;
}
await cmd("hdiutil-verify",["/usr/bin/hdiutil","verify",resolve(scratch,"downloads/browser-sealed.dmg")]);
await cmd("attach",["/usr/bin/hdiutil","attach","-readonly","-nobrowse","-noautoopen","-mountpoint",mount,resolve(scratch,"downloads/browser-sealed.dmg")]);
try {
  await cmd("sealed-mounted",["/usr/bin/codesign","--verify","--deep","--strict","--verbose=4",join(mount,appName)]);
  const app=join(dest,appName);await cp(join(mount,appName),app,{recursive:true});
  await cmd("sealed-relocated",["/usr/bin/codesign","--verify","--deep","--strict","--verbose=4",app]);
  const unsealed=resolve(scratch,"negative-unsealed",appName);await cp(app,unsealed,{recursive:true});
  for(const name of ["MacOS/Launcher","_CodeSignature/CodeResources"])await copyFile(join(pub,appName,"Contents",name),join(unsealed,"Contents",name));
  await cmd("unsealed-resource-negative",["/usr/bin/codesign","--verify","--deep","--strict","--verbose=4",unsealed],1);
  const corrupt=resolve(scratch,"negative-corrupt",appName);await cp(app,corrupt,{recursive:true});
  const path=join(corrupt,hfsPath("Contents/Resources/game/private & caf\u00e9 <proof>.bin")),b=await readFile(path);b[0]^=1;await writeFile(path,b);
  await cmd("corrupt-resource-negative",["/usr/bin/codesign","--verify","--deep","--strict","--verbose=4",corrupt],1);
} finally {await cmd("detach",["/usr/bin/hdiutil","detach",mount]);await writeFile(resolve(scratch,"macos-results.json"),JSON.stringify(results,null,2)+"\n");}
console.log("BROWSER_ADHOC_SEAL_NATIVE_ACCEPTANCE_OK");

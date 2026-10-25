import puppeteer from "puppeteer-core";
import { mkdir,readFile,stat,unlink,writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const repo=resolve(import.meta.dir,"../../../.."),scratch=resolve(repo,"tmp/odyssey/browser-signing"),pub=resolve(repo,"tmp/odyssey/browser-release/runtime-public/public");
const manifestBytes=await readFile(resolve(pub,"manifest.json")),manifest=JSON.parse(manifestBytes.toString());
const downloads=resolve(scratch,"downloads");await mkdir(downloads,{recursive:true});
const imagePath=resolve(downloads,"browser-sealed.dmg");try{await unlink(imagePath);}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
const built=await Bun.build({entrypoints:[resolve(import.meta.dir,"worker.ts")],target:"browser",format:"esm"});
if(!built.success)throw Error(built.logs.join("\n"));const worker=await built.outputs[0].text();await writeFile(resolve(scratch,"worker.js"),worker);
const paths=new Map<string,string>(manifest.files.map((e:{url:string;path:string})=>["/"+e.url,resolve(pub,"files",e.path)]));
const requests:string[]=[];
const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch(req){const path=new URL(req.url).pathname;requests.push(`${req.method} ${path}`);
  if(req.method!=="GET")return new Response("GET only",{status:405});
  if(path==="/manifest.json")return new Response(manifestBytes,{headers:{"Content-Type":"application/json"}});
  if(path==="/worker.js")return new Response(worker,{headers:{"Content-Type":"text/javascript"}});
  if(paths.has(path))return new Response(Bun.file(paths.get(path)!));
  if(path==="/")return new Response(`<!doctype html><title>Browser ad-hoc sealing acceptance</title><script>
window.result=null;const w=new Worker('/worker.js',{type:'module'});w.onmessage=e=>{if(e.data.error){window.result=e.data;return;}if(e.data.done){const a=document.createElement('a');a.href=URL.createObjectURL(e.data.file);a.download='browser-sealed.dmg';document.body.append(a);a.click();window.result=e.data.stats;}};w.onerror=e=>window.result={error:e.message};w.postMessage({});</script>`,{headers:{"Content-Type":"text/html"}});
  return new Response("not found",{status:404});}});
const executablePath=resolve(process.env.HOME!,".cache/going-up-browsers/chrome-headless-shell/ext/chrome-headless-shell-mac-arm64/chrome-headless-shell");
const browser=await puppeteer.launch({executablePath,headless:true,userDataDir:resolve(scratch,"profile-"+crypto.randomUUID()),args:["--no-first-run","--disable-background-networking","--disable-component-update","--disable-extensions","--disable-default-apps"]});
try {
  const cdp=await browser.target().createCDPSession();await cdp.send("Browser.setDownloadBehavior",{behavior:"allow",downloadPath:downloads});
  const page=await browser.newPage(),errors:string[]=[];page.on("pageerror",e=>errors.push(String(e)));
  console.log(JSON.stringify({browserPid:browser.process()?.pid,version:await browser.version(),executablePath}));
  await page.goto(server.url.href);await page.waitForFunction("window.result!==null",{timeout:60000,polling:100});
  const result=await page.evaluate("window.result") as Record<string,unknown>;if(result.error)throw Error(JSON.stringify(result));
  const deadline=Date.now()+30000;while((await stat(imagePath).catch(()=>null))?.size!==result.imageBytes){if(Date.now()>deadline)throw Error("Download incomplete");await Bun.sleep(100);}
  if(errors.length)throw Error(errors.join("\n"));
  const evidence={...result,imagePath,browserVersion:await browser.version(),requests,errors,workerSha256:new Bun.CryptoHasher("sha256").update(worker).digest("hex")};
  await writeFile(resolve(scratch,"browser.json"),JSON.stringify(evidence,null,2)+"\n");console.log(JSON.stringify(evidence));
} finally {await browser.close();server.stop(true);}

/** Strict, bounded plist XML parser. Original byte spelling is retained on insertion. */
export interface Node { tag: string; start: number; close: number; end: number; text: string; children: Node[] }
const scalar = new Set(["key", "string", "data", "integer", "real", "true", "false"]);
function fail(): never { throw Error("Malformed or unsupported CodeResources XML"); }
export function decode(text: string): string {
  if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/.test(text)) fail();
  return text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, entity: string) => {
    const named: Record<string,string> = { amp:"&",lt:"<",gt:">",quot:'"',apos:"'" };
    if (named[entity]) return named[entity];
    const n = entity.startsWith("#x") ? parseInt(entity.slice(2),16) : Number(entity.slice(1));
    if (!n || n > 0x10ffff || n >= 0xd800 && n <= 0xdfff) fail(); return String.fromCodePoint(n);
  });
}
export const escape = (s: string) => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");
export function dictionary(node: Node): Map<string, Node> {
  if (node.tag !== "dict" || node.children.length % 2) fail();
  const map = new Map<string, Node>();
  for (let i=0;i<node.children.length;i+=2) {
    const key = node.children[i]; if (key.tag !== "key") fail(); const name = decode(key.text);
    if (map.has(name)) throw Error(`Duplicate CodeResources key: ${name}`); map.set(name,node.children[i+1]);
  }
  return map;
}
export function parseEnvelope(xml: string) {
  if (xml.length > 8 * 1024 * 1024 || /<!ENTITY|<!\[CDATA|<!--/i.test(xml)) fail();
  let at = 0, nodes = 0;
  const space = () => { while (/\s/.test(xml[at] ?? "") && at < xml.length) at++; };
  space();
  if (xml.startsWith("<?xml", at)) { const end=xml.indexOf("?>",at); if(end<0)fail(); at=end+2; }
  space();
  if (xml.startsWith("<!DOCTYPE",at)) {
    const end=xml.indexOf(">",at); if(end<0 || !/^<!DOCTYPE plist PUBLIC "-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN" "http:\/\/www\.apple\.com\/DTDs\/PropertyList-1\.0\.dtd">$/.test(xml.slice(at,end+1))) fail(); at=end+1;
  }
  function element(depth: number): Node {
    space(); if (depth>64 || ++nodes>200000) fail();
    const start=at, match=/^<(plist(?: version="1\.0")?|dict|array|key|string|data|integer|real|true|false)\s*(\/?)>/.exec(xml.slice(at));
    if(!match)fail(); const tag=match[1].split(" ")[0]; at+=match[0].length;
    if(match[2]) { if(!["true","false","dict","array","string","data"].includes(tag))fail(); return {tag,start,close:at-match[0].length,end:at,text:"",children:[]}; }
    const content=at, children: Node[]=[];
    if(scalar.has(tag)) { const end=xml.indexOf("<",at); if(end<0)fail(); at=end; }
    else { space(); while(!xml.startsWith("</",at)) { children.push(element(depth+1)); space(); } }
    const close=at; if(!xml.startsWith(`</${tag}>`,at))fail(); at+=tag.length+3;
    const node={tag,start,close,end:at,text:scalar.has(tag)?xml.slice(content,close):"",children};
    if(tag==="dict") dictionary(node);
    if(tag==="key"||tag==="string") decode(node.text);
    if(tag==="integer" && !/^[+-]?\d+$/.test(node.text.trim()))fail();
    if(tag==="real" && (!node.text.trim() || !Number.isFinite(Number(node.text.trim()))))fail();
    if(tag==="data" && !/^[A-Za-z0-9+/=\s]*$/.test(node.text))fail();
    if((tag==="true"||tag==="false") && node.text.trim())fail();
    return node;
  }
  const root=element(0); space(); if(at!==xml.length || root.tag!=="plist" || root.children.length!==1)fail();
  const top=dictionary(root.children[0]), files=top.get("files"), files2=top.get("files2");
  if(!files || !files2 || !top.get("rules") || !top.get("rules2") || files.end===files.close || files2.end===files2.close)fail();
  // Self-closing maps are deliberately not supported by this prebuilt-template profile.
  if(!xml.slice(files.close).startsWith("</dict>") || !xml.slice(files2.close).startsWith("</dict>"))fail();
  dictionary(top.get("rules")!); dictionary(top.get("rules2")!);
  return { files, files2, first:dictionary(files), second:dictionary(files2) };
}
export function data(node: Node, length: number): Uint8Array {
  if(node.tag!=="data")fail(); let bytes: Uint8Array;
  try { bytes=Uint8Array.from(atob(node.text.replace(/\s/g,"")),c=>c.charCodeAt(0)); } catch { return fail(); }
  if(bytes.length!==length)fail(); return bytes;
}
export function insertEnvelope(xml: string, parsed: ReturnType<typeof parseEnvelope>, additions: {path:string;sha1:Uint8Array;sha256:Uint8Array}[]): string {
  const b64=(b:Uint8Array)=>btoa(String.fromCharCode(...b));
  const old=additions.map(a=>`\n\t\t<key>${escape(a.path)}</key><data>${b64(a.sha1)}</data>`).join("");
  const modern=additions.map(a=>`\n\t\t<key>${escape(a.path)}</key><dict><key>hash2</key><data>${b64(a.sha256)}</data></dict>`).join("");
  const edits=[{at:parsed.files.close,text:old},{at:parsed.files2.close,text:modern}].sort((a,b)=>b.at-a.at);
  let result=xml; for(const e of edits)result=result.slice(0,e.at)+e.text+result.slice(e.at); return result;
}

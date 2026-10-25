import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createGameTest } from './fixture.ts';
import { enterOpeningGameplay } from './opening.ts';
import { importNxTas } from './nx-tas.ts';
import { ReplayObserver, type ReplayCheckpoint } from './replay-observer.ts';
import type { NativeState } from './protocol.ts';
import { RouteSetup } from './route-setup.ts';
const root=resolve(import.meta.dir,'../..');
const nativeHost=join(root,'tmp/odyssey/recorded-tower/launch.command');
async function prepareHost(){
 await mkdir(join(root,'tmp/odyssey/recorded-tower'),{recursive:true});
 await writeFile(nativeHost,[
  '#!/bin/bash',
  'set -euo pipefail',
  '[[ "${DM_INSTANCE_LABEL:-}" == Tests ]] || exit 2',
  'root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd -P)"',
  'export DM_WINDOW=1 DM_WINDOW_DISPLAY=3 DM_AUDIO=1',
  'unset DM_FULLSCREEN DM_METAL_HUD DM_NVN_STREAM_PRESENTED',
  'if [[ -f "$root/game-data/super-mario-odyssey/run/pso_user.tsv" ]]; then cp "$root/game-data/super-mario-odyssey/run/pso_user.tsv" "$DM_RUN_DIRECTORY/pso_user.tsv"; fi',
  "printf 'render_fps=0\\nshow_fps=1\\n' > \"$DM_NATIVE_OPTIONS\"",
  'exec "$root/game-data/super-mario-odyssey/tools/dmhost" "$@"',
  '',
 ].join('\n'),{mode:0o755});
}
const original=await readFile(join(root,'tmp/odyssey/research/cap-archive/26.txt'),'utf8');
const imported=importNxTas(original);
assert.equal(imported.frames,1188,'Tower checkpoints require the complete original archive26 recording');
const sourceRows=original.trim().split(/\r?\n/), rows=imported.native.trim().split('\n');
const seed=JSON.parse(await readFile(join(root,'tmp/odyssey/frog-freeze-repro.json'),'utf8')).seed;
const player=(s:NativeState)=>s.route?.actors.find(a=>a.type==='PlayerActorHakoniwa');
const hack=(s:NativeState)=>/NrvHackE/.test(player(s)?.nerve??'');
const y=(s:NativeState)=>s.timing?.position?.[1]??-9999;
const play=(s:NativeState)=>/StageSceneNrvPlayE/.test(s.timing?.scene??'')&&!/NrvDemoE|NrvBindE/.test(s.timing?.playerNerve??'');
const damage=(s:NativeState)=>/Nrv(?:Damage|Dead)/.test(player(s)?.nerve??'')?'Unplanned native damage/death':undefined;
const vertical=(s:NativeState)=>s.route?.player?.velocity[1]??0;
let previousVertical=0,lastLandingFrame=-1;
const jumps=[419,488,554,662,796,929,993,1061];
const landingWindows=[[480,489,800],[552,570,2250],[645,663,3300],[780,807,3100],[915,940,3150],[986,1003,4200],[1056,1070,6200],[1120,1135,7100]];
const plans:ReplayCheckpoint[]=[
 {label:'Enter the tower on the original inputs',from:1,through:220,accept:s=>s.route?.stage==='CapWorldTowerStage'&&play(s)},
 {label:'Capture the frog on the recorded throw',from:270,through:326,accept:hack,reject:damage},
 {label:'Skip the capture cinematic with recorded buttons',from:359,through:420,accept:s=>hack(s)&&play(s)},
 ...jumps.flatMap((frame,i):ReplayCheckpoint[]=>[
  {label:'Frog jump '+(i+1)+' / original '+(frame===554||frame===662||frame===796||frame===993?'L motion':'B'),from:frame+1,through:frame+26,accept:s=>hack(s)&&vertical(s)>20,reject:damage},
  {label:'Land frog jump '+(i+1),from:landingWindows[i]![0]!+1,through:landingWindows[i]![1]!+1,accept:s=>hack(s)&&(Math.abs(vertical(s))<10||lastLandingFrame>=landingWindows[i]![0]!)&&y(s)>landingWindows[i]![2]!,reject:damage},
 ]),
 {label:'Leave the frog on the recorded ZL',from:1135,through:imported.frames+1,allowAfterReplay:true,accept:s=>!hack(s)&&y(s)>7100,reject:damage},
 {label:'Resume play outside the upper exit',from:imported.frames,through:imported.frames+1,allowAfterReplay:true,accept:s=>s.replay?.active===false&&s.replay.frame===imported.frames&&s.route?.stage==='CapWorldHomeStage'&&play(s)&&(s.timing?.sceneStep??0)>=30&&y(s)>4800,reject:damage},
];
const setup=['Load a private Cap checkpoint','Prepare Cappy and the tower path','Reach the tower bottom entrance','Match the documented exit-and-reenter setup'];
const test=await createGameTest('original-tower-inputs',{title:'Odyssey / original tower controller recording',description:'Replay all 1188 original controller frames from Mars2030\'s published Top-Hat Tower recording. Buttons, sticks and 60 Hz timing unchanged. Private checkpoint setup uses controller navigation before the author input file starts. Native sound and measured render FPS.',actions:[...setup,...plans.map(p=>p.label)]});
const {game,page,viewer,artifacts}=test;
const route=new RouteSetup(game,join(artifacts,'setup-inputs.jsonl'));
const trace=createWriteStream(join(artifacts,'native-state.jsonl'));
let observer:ReplayObserver|undefined, failure:unknown, decorating=false,lastDecoration=0,lastMask="",setupClosed=false;
const buttons=['A','B','X','Y','LSTICK','RSTICK','L','R','ZL','ZR','+','-','LEFT','UP','RIGHT','DOWN'];
const observe=(s:NativeState)=>{
 const frame=s.route?.replayFrame??0, sourceFrame=Math.max(0,frame-1);
 // A buffered jump can leave the platform in the same update that lands.
 // Keep that falling-to-rising transition as well as visible floor velocity.
 if(hack(s)&&previousVertical < -10&&(Math.abs(vertical(s))<10||vertical(s)>20))lastLandingFrame=sourceFrame;
 previousVertical=vertical(s);
 trace.write(JSON.stringify({sourceFrame,unixMs:Date.now(),renderFrame:s.frame,logicTicks:s.timing?.logicTicks,stage:s.route?.stage,position:s.timing?.position,velocity:s.route?.player?.velocity,nerve:s.timing?.playerNerve,scene:s.timing?.scene,replay:s.replay})+'\n');
 const i=Math.min(rows.length-1,sourceFrame),maskText=rows[i]!.split(' ')[1]!,changed=maskText!==lastMask;
 if(!decorating&&(changed||performance.now()-lastDecoration>=75)){
  lastDecoration=performance.now();lastMask=maskText;decorating=true;const mask=BigInt('0x'+maskText);
  void viewer.evaluate(d=>{window.dispatchEvent(new CustomEvent('native-keys',{detail:d.keys}));const label=document.querySelector('.ar-key-label');if(label)label.textContent='PAD';const line=document.querySelector('#author-row');if(line)line.textContent=d.row;},{keys:buttons.filter((_,i)=>Boolean(mask&(1n<<BigInt(i)))),row:sourceRows[i]!}).catch(()=>{}).finally(()=>{decorating=false;});
 }
};
console.log('ARTIFACTS='+artifacts);
try{
 await test.step(setup[0]!,async()=>{await prepareHost();await game.start({renderFPS:0,saveDirectory:seed,tasMotion:'legacy-2021',nativeHost});await enterOpeningGameplay(page);assert.equal((await page.state()).route?.stage,'CapWorldHomeStage');});
 await test.step(setup[1]!,async()=>{await route.points([[-2155,24372],[-1726,23707],[-777,23590],[79,23185],[658,22309],[1271,21460],[2135,20835],[2812,20018],[3124,19004],[3102,17960],[2634,17270],[2536,17173],[1694,16875],[1175,15970],[708,15076],[-159,14546],[-876,13828],[-1622,13121]],{radius:150,jump:true});assert(!(await page.state()).route?.actors.some(a=>a.type==='OpeningStageStartCapManHero'&&a.alive),'Private checkpoint still requires Cappy dialogue');await route.points([[-1273,13435],[-2100,12600],[-2970,11738],[-2934,11420],[-3076,10713],[-3748,10536],[-4066,10642],[-4702,10147],[-5515,9899],[-5551,8803],[-6116,7955],[-6046,7106],[-5657,6718],[-5233,6293],[-4879,5940],[-4738,5303],[-4313,5728],[-3995,5409],[-3889,4879]],{jump:true,maxFrames:600});await route.goTo(-3041,4031,{radius:260,jump:true,maxFrames:600});await route.hold(8,{buttons:['Y']});await route.wait('tower path',s=>route.hasNerve(s,/CapSwitch.*OnWait/)&&play(s),900);});
 await test.step(setup[2]!,async()=>{await route.points([[-2828,3818],[-2546,3536],[-2298,3288],[-2051,3041],[-1803,2793],[-1584,2574],[-1344,2333],[-1127,2117],[-880,1870],[-672,1662],[-389,1379],[-141,1131],[141,849],[460,530],[831,159],[1237,-247],[3783,-2793],[3924,-2934],[4172,-3182],[4313,-3323]],{jump:true,maxFrames:600});await route.hold(8,{buttons:['Y']});await route.wait('tower door',s=>route.hasNerve(s,/DoorAreaChange.*OpenWait/),300);await route.goTo(4631,-3641,{radius:80,jump:true,maxFrames:900});await route.wait('inside tower',s=>s.route?.stage==='CapWorldTowerStage'&&play(s),1800);});
 await test.step(setup[3]!,async()=>{await page.keyboard.press('i');await route.goTo(-500,15500,{radius:40,maxFrames:400,interrupt:false});await route.wait('bottom exit',s=>s.route?.stage==='CapWorldHomeStage'&&play(s)&&/NrvWaitE/.test(s.timing?.playerNerve??''),1800);await route.close();setupClosed=true;await writeFile(join(artifacts,'original-start.json'),JSON.stringify(await page.state(),null,2)+'\n');await game.screenshot(join(artifacts,'original-start.png'));await viewer.evaluate(()=>{const line=document.createElement('div');line.id='author-row';line.style.cssText='font:15px ui-monospace,monospace;color:#b7edff;white-space:nowrap';document.querySelector('.ar-hud')?.append(line);});});
 await writeFile(join(artifacts,'original-script.txt'),original);
 await writeFile(join(artifacts,'original-native.inputs'),imported.native);
 await writeFile(join(artifacts,'source.json'),JSON.stringify({author:'Mars2030',url:'https://github.com/MonsterDruide1/smo-tas-archive/blob/main/public/scripts/26.txt',video:'https://www.youtube.com/watch?v=Ue6Fhp1EFWQ',setup:'Exit Tower (bottom entrance)',sourceVersion:'Any',localVersion:'1.0.0',frames:imported.frames,sha256:imported.sha256,controllerEnvironment:'legacy-2021',changedButtons:false,changedSticks:false,changedDurations:false,steeringCorrections:false,bootstrapNavigation:'Before source frame zero only; not part of the author recording'},null,2)+'\n');
 observer=new ReplayObserver(plans,imported.frames,observe);await observer.start();await game.replay(join(artifacts,'original-native.inputs'));
 for(const checkpoint of plans)await test.step(checkpoint.label,()=>observer!.expect(checkpoint.label));
 await game.screenshot(join(artifacts,'final-native.png'));
 await writeFile(join(artifacts,'native-result.json'),JSON.stringify(await page.state(),null,2)+'\n');
}catch(error){failure=error;await game.release().catch(()=>{});await writeFile(join(artifacts,'failure-state.json'),JSON.stringify(await page.state().catch(()=>null),null,2)+'\n');await game.screenshot(join(artifacts,'failure-native.png')).catch(()=>{});throw error;}
finally{await observer?.stop();if(!setupClosed)await route.close().catch(()=>{});await writeFile(join(artifacts,'checkpoint-results.json'),JSON.stringify(observer?.report()??{started:false},null,2)+'\n');await new Promise<void>(r=>trace.end(r));await test.finish(failure);}

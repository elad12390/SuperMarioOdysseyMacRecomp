import { test, expect } from 'bun:test';
import { planBatches } from '../parallel.mjs';

const keys=['1111111111111111','2222222222222222','3333333333333333','4444444444444444'];
const map='package\tindex\tstage\tdm_ctl_sha16\tsource\n'+keys.map((key,i)=>`ps_local.bin\t${i}\tpixel\t${key}\t/local`).join('\n');
test('all independent outputs precede vertices that read another worker pixel source',()=>{
  const plan=planBatches(map,keys[0]+'\t'+keys[3]+'\n'+keys[0]+'\t'+keys[2],2);
  expect(plan.phases[0]).toEqual(keys.slice(1));
  expect(plan.phases[1]).toEqual([keys[0]]);
  expect(plan.chunks.flat(2).sort()).toEqual(keys);
  expect([...plan.pairs.get(keys[0])].sort()).toEqual(keys.slice(2));
});
test('duplicate map references produce one conversion and an incomplete dependency is rejected',()=>{
  expect(planBatches(map+'\nps_local.bin\t9\tpixel\t'+keys[0]+'\t/duplicate','',2).keys).toEqual(keys);
  expect(()=>planBatches(map,keys[0]+'\t'+'aaaaaaaaaaaaaaaa')).toThrow('missing');
});
test('invalid batch bounds cannot silently omit any conversion',()=>{
  for(const value of [0,-1,NaN,Infinity,1.5,1025])expect(()=>planBatches(map,'',value)).toThrow('bound');
});

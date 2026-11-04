import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

const html=await readFile(new URL('../research-daily.html',import.meta.url),'utf8');
const client=await readFile(new URL('../research-daily-client.mjs',import.meta.url),'utf8');
const index=await readFile(new URL('../index.html',import.meta.url),'utf8');
const css=await readFile(new URL('../style.css',import.meta.url),'utf8');
test('research layout and main navigation expose accessible, responsive evidence panels',()=>{
  for(const id of ['status','meta','forecast-rows','results-rows','league-rows','metrics','refresh','state-pill','report-sha']){
    assert.match(html,new RegExp('id="'+id+'"'));
  }
  assert.match(html,/aria-label="30天分联赛前瞻评分/);
  assert.match(html,/@media\(max-width:600px\)/);
  assert.match(index,/class="decision-flow"/);
  assert.match(css,/\.decision-step/);
  assert.doesNotMatch(html+client+index,/666888/);
  assert.doesNotMatch(client,/\.innerHTML\s*=/);
});
class El{
  constructor(){this.children=[];this.textContent='';this.value='all';this.events={};this.dataset={};this.style={setProperty(){}};}
  append(...x){this.children.push(...x);}replaceChildren(...x){this.children=[...x];}
  addEventListener(k,f){this.events[k]=f;}setAttribute(){}
}
const base=()=>({kind:'research-daily-1x2',mode:'research-reference',commercialReleaseGate:'BLOCKED',
 externalTelegramSent:false,strictMarkets:{releasedCandidates:0},disclaimer:'研究参考，非投注建议。',
 beijingDay:'2026-11-04',generatedAt:'2026-11-04T04:00:00Z',state:'frozen-research-forecasts',
 reportId:'a'.repeat(64),codeSha:'b'.repeat(40),
 forecasts:{total:1,candidates:[{league:'PL',home:'甲队',away:'乙队',selection:'home',kickoff:'2026-11-05T12:00:00Z',
 probabilities:{home:.46,draw:.28,away:.26}}]},
 prospective:{oneDay:{eligibleFrozen:1,scored:0,pending:1,voided:0},
 sevenDays:{eligibleFrozen:1,scored:0,pending:1,voided:0},
 thirtyDays:{eligibleFrozen:1,scored:0,pending:1,voided:0},
 byLeague30Days:[]}
});
async function mount(payload){
 const ids=[...html.matchAll(/id="([^"]+)"/g)].map(x=>x[1]);
 const els=new Map(ids.map(x=>[x,new El()]));
 const context={document:{getElementById:id=>els.get(id),createElement:()=>new El()},location:{assign(){}},
   fetch:async()=>payload,Date,Intl,Number,String,Object,Array,Math,Error};
 runInNewContext(client,context,{timeout:3000});
 for(let i=0;i<12;i++)await Promise.resolve();return els;
}
test('valid report renders only real frozen data, missing report hides all KPIs',async()=>{
 let els=await mount({status:200,ok:true,json:async()=>base()});
 assert.equal(els.get('metrics').children.length,4);
 assert.equal(els.get('forecast-rows').children.length,1);
 assert.equal(els.get('results-rows').children.length,3);
 assert.match(els.get('forecast-count').textContent,/1 \/ 1 场/);
 els=await mount({status:404,ok:false});
 assert.equal(els.get('metrics').children.length,0);
 assert.match(els.get('state-pill').textContent,/尚无报告/);
 const malformed=base();malformed.forecasts.total=2;
 els=await mount({status:200,ok:true,json:async()=>malformed});
 assert.equal(els.get('metrics').children.length,0);
 assert.match(els.get('state-pill').textContent,/核验失败/);
});

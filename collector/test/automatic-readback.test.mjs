import test from 'node:test';
import assert from 'node:assert/strict';
import {FORECAST_MODEL} from '../forecast.mjs';
import {createPredictionRecord} from '../prediction-ledger.mjs';
import {buildAutomaticReadback,webView,telegramDraft} from '../automatic-readback.mjs';

const time='2026-11-02T08:06:00.000Z',reportId='b'.repeat(64),codeSha='c'.repeat(40);
function inputs(){
  const fixture={id:'oldb-9999',source:'openligadb',league:'BL1',home:'<Alpha>',away:'Beta',
    homeTeamId:'101',awayTeamId:'102',kickoff:'2026-11-06T19:30:00.000Z',status:'SCHEDULED'};
  const forecast={fixtureId:fixture.id,status:'forecast',generatedAt:'2026-11-02T08:02:00.000Z',
    trainingCutoff:'2026-11-02T08:02:00.000Z',trainingHash:'a'.repeat(64),
    probabilities:{home:0.52,draw:0.26,away:0.22},
    freshness:{validUntil:'2026-11-02T08:59:00.000Z'}};
  const record=createPredictionRecord({fixture,forecast,model:FORECAST_MODEL,reportId,
    nowISO:'2026-11-02T08:05:00.000Z'});
  return {nowISO:time,codeSha,
    document:{kind:'prematch-forecast-report',simulated:false,generatedAt:'2026-11-02T08:05:00.000Z',
      publication:{reportId},model:FORECAST_MODEL,fixtures:[{fixture,forecast}]},
    ledger:{exists:true,events:[{predictions:[record]}]}};
}
test('immutable venue-poisson-v2 ledger yields bound machine readback and identical Web/TG reportId',()=>{
  const output=buildAutomaticReadback(inputs());
  assert.equal(output.eligible,1);
  assert.equal(output.within36h,0);
  assert.equal(output.fixtures[0].modelId,'venue-poisson-v2');
  assert.equal(output.fixtures[0].selection,'home');
  assert.ok(output.fixtures[0].leadHours>72);
  assert.match(webView(output),/&lt;Alpha&gt;/);
  assert.doesNotMatch(webView(output),/<Alpha>/);
  assert.match(telegramDraft(output).text,new RegExp(output.readbackId));
  assert.equal(telegramDraft(output).status,'NOT_SENT');
});
test('no simulated report, fake probability, ledger absence or changed model is admitted',()=>{
  const base=inputs();
  const bad=[
    {...base,document:{...base.document,simulated:true}},
    {...base,ledger:{...base.ledger,exists:false}},
    {...base,document:{...base.document,model:{...FORECAST_MODEL,version:3}}},
    {...base,document:{...base.document,fixtures:[{fixture:base.document.fixtures[0].fixture,
      forecast:{...base.document.fixtures[0].forecast,probabilities:{home:.2,draw:.3,away:.5}}}]}},
    {...base,ledger:{...base.ledger,events:[{predictions:[base.ledger.events[0].predictions[0],
      base.ledger.events[0].predictions[0]]}]}}
  ];
  for(const x of bad) assert.throws(()=>buildAutomaticReadback(x),/AUTO_/);
});
test('source fixture outside upcoming time window is excluded, never replaced with a simulated pick',()=>{
  const base=inputs();
  const past=buildAutomaticReadback({...base,nowISO:'2026-11-09T08:06:00.000Z'});
  assert.equal(past.eligible,0);
  assert.equal(past.excluded,1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { settleAsianHandicap as ah, settleFrozenAhResearch as score } from '../research-ah-settlement.mjs';

const W = 'FULL_WIN', HW = 'HALF_WIN', P = 'PUSH', HL = 'HALF_LOSS', L = 'FULL_LOSS';
const quote = { source:'independent-quote-a', matchId:'FX-123', marketId:'asian-ah-123', pool:'ah',
  homeHandicap:-0.75, homeOdds:1.86, awayOdds:1.94,
  observedAt:'2026-11-03T14:00:00.000Z',rawSha256:'a'.repeat(64) };
const fixture = {matchId:'FX-123',source:'fixtures-a',home:'甲',away:'乙',kickoff:'2026-11-03T16:00:00.000Z'};
const forecast = {matchId:'FX-123',modelVersion:'v3-research',pool:'ah',marketId:'asian-ah-123',
  homeHandicap:-0.75,selection:'home',generatedAt:'2026-11-03T14:05:00.000Z',
  frozenAt:'2026-11-03T14:10:00.000Z',rawSha256:'b'.repeat(64)};
const result = {matchId:'FX-123',home:'甲',away:'乙',status:'FT',homeGoals:2,awayGoals:1,
  observedAt:'2026-11-03T18:05:00.000Z',rawSha256:'c'.repeat(64)};
const run = (over={})=>score({fixture:{...fixture,...over.fixture},quote:{...quote,...over.quote},
  forecast:{...forecast,...over.forecast},result:{...result,...over.result}});

test('AH -0.25 home draw → half loss (no 1X2/hhad semantics)',()=>{
  const x=ah({homeGoals:1,awayGoals:1,homeHandicap:-.25,selection:'home',decimalOdds:1.9});
  assert.equal(x.outcome,HL); assert.equal(x.profitUnits,-.5);
  assert.deepEqual(x.legs.map(v=>v.line),[-.5,0]);
});
test('AH +0.25 home draw → half win',()=>{
  const x=ah({homeGoals:1,awayGoals:1,homeHandicap:.25,selection:'home',decimalOdds:1.9});
  assert.equal(x.outcome,HW); assert.equal(x.profitUnits,.45);
});
test('AH -0.75 home win by one → half win',()=>{
  const x=ah({homeGoals:2,awayGoals:1,homeHandicap:-.75,selection:'home',decimalOdds:1.86});
  assert.equal(x.outcome,HW); assert.equal(x.profitUnits,.43);
  assert.deepEqual(x.legs.map(v=>v.line),[-1,-.5]);
});
test('AH -1.25 home win by one → half loss',()=>{
  const x=ah({homeGoals:2,awayGoals:1,homeHandicap:-1.25,selection:'home',decimalOdds:1.86});
  assert.equal(x.outcome,HL); assert.equal(x.profitUnits,-.5);
});
test('AH -1 home win by one → refund, not hhad draw victory',()=>{
  const x=ah({homeGoals:2,awayGoals:1,homeHandicap:-1,selection:'home',decimalOdds:1.9});
  assert.equal(x.outcome,P); assert.equal(x.profitUnits,0);
});
test('AH home -0.75 away selection uses +0.75',()=>{
  const x=ah({homeGoals:2,awayGoals:1,homeHandicap:-.75,selection:'away',decimalOdds:1.94});
  assert.equal(x.outcome,HL); assert.equal(x.pickedLine,.75); assert.equal(x.profitUnits,-.5);
});
test('AH handles full win/full loss and excludes non-quarter lines and invalid prices',()=>{
  assert.equal(ah({homeGoals:4,awayGoals:0,homeHandicap:-.75,selection:'home',decimalOdds:1.9}).outcome,W);
  assert.equal(ah({homeGoals:0,awayGoals:4,homeHandicap:-.75,selection:'home',decimalOdds:1.9}).outcome,L);
  assert.equal(ah({homeGoals:1,awayGoals:0,homeHandicap:-.3,selection:'home',decimalOdds:1.9}),null);
  assert.equal(ah({homeGoals:1,awayGoals:0,homeHandicap:-.75,selection:'draw',decimalOdds:1.9}),null);
  assert.equal(ah({homeGoals:1,awayGoals:0,homeHandicap:-.75,selection:'home',decimalOdds:1}),null);
});
test('real-source contract shaped pregame frozen ledger scores research-only',()=>{
  const x=run();assert.equal(x.status,'SCORED');assert.equal(x.outcome,HW);
  assert.equal(x.profitUnits,.43);assert.equal(x.commercialReleaseGate,'BLOCKED');
  assert.equal(x.evidence.provenance,'RAW_HASH_FORMAT_ONLY_NOT_EXTERNALLY_VERIFIED');
});
test('market type cannot be hhad, selection line must match frozen market',()=>{
  assert.equal(run({quote:{pool:'hhad'}}).reason,'MARKET_NOT_AH');
  assert.equal(run({forecast:{homeHandicap:-.25}}).reason,'SELECTION_MISMATCH');
});
test('future quote/future forecast/backdated lock are rejected',()=>{
  assert.equal(run({quote:{observedAt:'2026-11-03T14:30:00.000Z'}}).reason,'TIME_CAUSALITY_INVALID');
  assert.equal(run({forecast:{generatedAt:'2026-11-03T15:00:00.000Z'}}).reason,'TIME_CAUSALITY_INVALID');
  assert.equal(run({forecast:{frozenAt:'2026-11-03T16:00:00.000Z'}}).reason,'TIME_CAUSALITY_INVALID');
});
test('reject wrong fixture, live result, bogus hashes and early results',()=>{
  assert.equal(run({result:{home:'丙'}}).reason,'FIXTURE_MISMATCH');
  assert.equal(run({result:{status:'LIVE'}}).reason,'RESULT_NOT_FT');
  assert.equal(run({result:{rawSha256:'not-a-sha'}}).reason,'RAW_HASH_REQUIRED');
  assert.equal(run({result:{observedAt:'2026-11-03T16:30:00.000Z'}}).reason,'TIME_CAUSALITY_INVALID');
});
test('nonexistent score cannot sneak into accuracy denominator',()=>{
  assert.equal(run({result:{homeGoals:undefined}}).reason,'SCORE_INVALID');
});

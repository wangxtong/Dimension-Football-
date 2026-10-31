import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteAdmission, crossCheckQuotes } from '../commercial-feed-admission.mjs';
const now='2026-10-31T10:00:00.000Z';
const quote={fixtureId:'2026-1',sourceId:'opticodds',independenceGroup:'upstream-a',bookmaker:'Bookmaker A',market:'ah',selection:'home',handicap:-0.5,decimalOdds:1.86,commercialRightsVerified:true,bookmakerVerified:true,inPlay:false,closed:false,observedAt:'2026-10-31T09:59:30.000Z',sourceUpdatedAt:'2026-10-31T09:59:20.000Z'};
test('signed-off eligible quotes require timestamps rights and actual bookmaker',()=>{
 assert.equal(quoteAdmission(quote,now),'ELIGIBLE');
 assert.equal(quoteAdmission({...quote,commercialRightsVerified:false},now),'RIGHTS_UNVERIFIED');
 assert.equal(quoteAdmission({...quote,bookmakerVerified:false},now),'BOOKMAKER_UNVERIFIED');
 assert.equal(quoteAdmission({...quote,sourceUpdatedAt:null},now),'UPSTREAM_TIME_UNKNOWN');
});
test('stale, future, closed and live markets fail closed',()=>{
 assert.equal(quoteAdmission({...quote,sourceUpdatedAt:'2026-10-31T09:40:00.000Z'},now),'STALE_QUOTE');
 assert.equal(quoteAdmission({...quote,observedAt:'2026-10-31T10:01:00.000Z'},now),'FUTURE_TIMESTAMP');
 assert.equal(quoteAdmission({...quote,inPlay:true},now),'NOT_OPEN_PREMATCH');
 assert.equal(quoteAdmission({...quote,closed:true},now),'NOT_OPEN_PREMATCH');
});
test('same reseller upstream is not independent, different handicap not same market',()=>{
 assert.equal(crossCheckQuotes([quote,{...quote,sourceId:'other',bookmaker:'Bookmaker B'}],now).dualSourceEvidencePresent,false);
 assert.equal(crossCheckQuotes([quote,{...quote,sourceId:'other',independenceGroup:'upstream-b',handicap:-1}],now).dualSourceEvidencePresent,false);
 assert.equal(crossCheckQuotes([quote,{...quote,sourceId:'other',independenceGroup:'upstream-b'}],now).dualSourceEvidencePresent,true);
});
test('invalid and fabricated records cannot count as independent evidence',()=>{
 assert.equal(crossCheckQuotes([quote,{...quote,sourceId:'other',independenceGroup:'upstream-b',decimalOdds:NaN}],now).dualSourceEvidencePresent,false);
 assert.throws(()=>quoteAdmission(quote,'not-a-date'),/INVALID_ADMISSION_POLICY/);
});

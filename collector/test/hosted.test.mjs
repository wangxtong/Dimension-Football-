import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createHostedPublisher as blockedPublisher } from '../hosted.mjs';
import { withMockReleaseGate } from './helpers/delivery-mock.mjs';
const { HOSTED_ORIGIN, STATE_LIMITS, allowedStatePath, validateStateSnapshot, captureState, restoreState,
  createHostedClient, createStateSession, createHostedPublisher, runHosted, runShadow, observationBundle } = await withMockReleaseGate(new URL('../hosted.mjs',import.meta.url));
import { atomicJson, readJson } from '../storage.mjs';
import { persistReport, loadReportBundle, reportHash } from '../report-store.mjs';
import { createAcquisitionSnapshot } from '../data/acquisition-snapshot.mjs';
import { DEFAULT_POLICY } from '../policy.mjs';
import { sampleReport, sampleReceipt, NOW } from '../../website/test/fixtures.mjs';

const at = offset => new Date(NOW+offset).toISOString(), hash = text => createHash('sha256').update(text).digest('hex');
const file = (path,value) => ({path,content:Buffer.from(JSON.stringify(value)).toString('base64')});
async function workspace(t){const dir=await mkdtemp(join(tmpdir(),'hosted-client-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
async function report(root,letter='a',offset=0){
  const out=join(root,'reports'),document=sampleReport(letter,offset),receipt=sampleReceipt(document);
  const text=JSON.stringify(document);receipt.files=[{name:'predictions.json',sha256:hash(text)}];receipt.events=[];
  receipt.channels.externalWebsite={status:'not_configured'};
  await mkdir(out,{recursive:true});await writeFile(join(out,'predictions.json'),text);await atomicJson(join(out,'publication.json'),receipt);
  return {out,document,receipt};
}
function backend(){
  let state=null,bundle=null,notifications=0,observations=null;const sent=new Map(),calls=[];
  const api={calls,get state(){return state;},set state(value){state=value;},get bundle(){return bundle;},get notifications(){return notifications;},
    async request(path,options={}){
      const {method='GET',body}=options;calls.push({path,method,body});
      if(path==='/internal/state'&&method==='GET')return state?structuredClone(state):null;
      if(path==='/internal/state'&&method==='PUT'){
        if(body.expectedRevision!==(state?.revision||0))throw Error('HOSTED_STATE_CONFLICT');
        state={revision:body.expectedRevision+1,files:structuredClone(body.files)};return {revision:state.revision};
      }
      if(path==='/internal/publications'){
        if(bundle&&bundle.reportId===body.reportId)assert.equal(reportHash(bundle.report),reportHash(body.report));
        bundle=structuredClone(body);return {reportId:body.reportId,reportHash:reportHash(body.report)};
      }
      if(path==='/internal/observations'){
        observations={version:1,reportId:hash(body.reportId+'projection'),originReportId:body.reportId,reportHash:hash(JSON.stringify(body.report)),
          generatedAt:body.report.generatedAt,mode:'hosted',health:'available',publicationKind:'observations',forecastPublished:false};
        return structuredClone(observations);
      }
      if(path==='/internal/report-status'&&observations)return structuredClone(observations);
      if(path==='/internal/report-status')return {version:1,reportId:bundle.reportId,reportHash:reportHash(bundle.report),generatedAt:bundle.report.generatedAt,mode:'hosted',health:'available'};
      if(path==='/internal/notifications'){
        assert.equal(body.reportId,bundle.reportId);assert.equal(bundle.receipt.channels.externalWebsite.servedVerified,true);
        if(!sent.has(body.reportId)){notifications++;sent.set(body.reportId,{status:'accepted',checkedAt:at(1000),messageId:notifications,reportId:body.reportId});}
        bundle.receipt.channels.notifications=sent.get(body.reportId);return structuredClone(bundle.receipt);
      }
      assert.fail(path);
    }};return api;
}

test('state allowlist includes nested ledgers and current replay but excludes credentials, locks and legacy report copies',()=>{
  for(const path of ['state/state.json.history.json','state/state.json.public-cooldown.json','state/hosted-scheduler.json',
    `reports/forecast-ledger/${'a'.repeat(64)}/predictions/${'b'.repeat(64)}.json`,`reports/forecast-ledger/${'a'.repeat(64)}/opportunities/${'b'.repeat(64)}.json`,`reports/replays/${'a'.repeat(64)}/run-inputs.json`,
    'reports/.delivery/current.json','reports/public-source-fixtures.json','reports/prospective-evaluation.json'])assert.equal(allowedStatePath(path),true,path);
  for(const path of ['../state/a.json','/state/a.json','state/../a.json','state/a\\b.json','state/.secret.json','state/collector.env.json',
    'state/token.json','state/a.json.lock','reports/latest.json','reports/collection-2026.json','reports/.delivery/outbox/a.json','reports/predictions.html'])assert.equal(allowedStatePath(path),false,path);
});
test('multi-megabyte canonical base64 state validates without recursive regexp exhaustion',()=>{
  const snapshot={revision:1,files:[file('state/state.json.history.json',{rows:'x'.repeat(3*1024*1024)})]};
  assert.equal(validateStateSnapshot(snapshot).size,1);
});
test('restore validates every path and payload before writing and rejects duplicate/noncanonical/oversize state',async t=>{
  const root=await workspace(t),good=file('state/state.json',{version:1});
  for(const snapshot of [
    {revision:1,files:[good,file('../escape.json',{})]},
    {revision:1,files:[good,good]},
    {revision:1,files:[{path:'state/x.json',content:'e30'}]},
    {revision:1,files:[{path:'state/x.json',content:Buffer.from('not-json').toString('base64')}]},
    {revision:'bad',files:[]},
  ]){await assert.rejects(restoreState(root,snapshot),/HOSTED_STATE_/);assert.deepEqual(await readdir(root),[]);}
  assert.throws(()=>validateStateSnapshot({revision:0,files:[good]}, {...STATE_LIMITS,decodedBytes:1}),/LIMIT_EXCEEDED/);
  assert.throws(()=>validateStateSnapshot({revision:0,files:[good]}, {...STATE_LIMITS,jsonBytes:8}),/LIMIT_EXCEEDED/);
  assert.throws(()=>validateStateSnapshot({revision:0,files:[good]}, {...STATE_LIMITS,files:0}),/LIMIT_EXCEEDED/);
});
test('capture preserves required state and only the current bundle; symlinks and malformed required JSON fail closed',async t=>{
  const root=await workspace(t),a=await report(root);await persistReport(a.out,{nowISO:at(0)});
  await atomicJson(join(root,'state/state.json'),{version:1});
  await writeFile(join(a.out,'collection-old.json'),'intentionally not parsed');
  await atomicJson(join(a.out,'.delivery/reports','b'.repeat(64),'content.json'),{old:true});
  await atomicJson(join(root,'state/secret.json'),{hidden:true});
  const captured=await captureState(root,2);assert.ok(captured.files.some(row=>row.path==='state/state.json'));
  assert.ok(!captured.files.some(row=>/collection-old|secret|\/b{64}\//.test(row.path)));
  const restored=await workspace(t);await restoreState(restored,captured);
  assert.equal((await loadReportBundle(join(restored,'reports'))).reportId,a.receipt.reportId);
  await symlink(join(root,'state/state.json'),join(root,'state/linked.json'));
  await assert.rejects(captureState(root,2),/HOSTED_STATE_UNSAFE_FILE/);
  await rm(join(root,'state/linked.json'));await writeFile(join(root,'state/state.json'),'{');
  await assert.rejects(captureState(root,2),/HOSTED_STATE_INVALID_JSON/);
});
test('tampered current snapshot is rejected and count limits never truncate ledgers',async t=>{
  const root=await workspace(t),r=await report(root);await persistReport(r.out,{nowISO:at(0)});
  const snapshot=await captureState(root,1),content=snapshot.files.find(row=>row.path.endsWith('/content.json'));
  const decoded=JSON.parse(Buffer.from(content.content,'base64'));decoded.report.generatedAt=at(1000);content.content=Buffer.from(JSON.stringify(decoded)).toString('base64');
  assert.throws(()=>validateStateSnapshot(snapshot),/HOSTED_STATE_BUNDLE_INVALID/);
  await assert.rejects(captureState(root,1,{...STATE_LIMITS,files:1}),/HOSTED_STATE_LIMIT_EXCEEDED/);
});

const oidcEnv={ACTIONS_ID_TOKEN_REQUEST_URL:'https://pipelines.actions.githubusercontent.com/idtoken?api-version=2.0',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'test-request-bearer'};
const jwt=(now,number=1)=>`${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({aud:HOSTED_ORIGIN,exp:Math.floor(now/1000)+300,number})).toString('base64url')}.signature`;
test('OIDC audience is fixed, tokens are reused then renewed and all application requests stay on the original Site',async()=>{
  let now=NOW,tokens=0,reads=0;
  const client=createHostedClient({env:oidcEnv,clock:()=>now,fetchImpl:async(url,options)=>{
    assert.equal(options.redirect,'error');const u=new URL(url);
    if(u.hostname.endsWith('.actions.githubusercontent.com')){
      assert.equal(u.searchParams.get('audience'),HOSTED_ORIGIN);assert.equal(options.headers.Authorization,'Bearer '+oidcEnv.ACTIONS_ID_TOKEN_REQUEST_TOKEN);
      return Response.json({value:jwt(now,++tokens)});
    }
    assert.equal(u.origin,HOSTED_ORIGIN);assert.ok(options.headers.Authorization.startsWith('Bearer '));reads++;return Response.json({ok:true});
  }});
  await client.request('/internal/report-status');await client.request('/internal/report-status');assert.equal(tokens,1);
  now+=260000;await client.request('/internal/report-status');assert.equal(tokens,2);assert.equal(reads,3);
  await assert.rejects(client.request('https://evil.example/internal/state'),/INVALID_ENDPOINT/);
  const invalid=createHostedClient({env:{...oidcEnv,ACTIONS_ID_TOKEN_REQUEST_URL:'https://evil.example/idtoken'},fetchImpl:()=>assert.fail('credential leak')});
  await assert.rejects(invalid.request('/internal/state'),/OIDC_NOT_CONFIGURED/);
});
test('confirmed 401 refreshes identity once, while conflict and uncertain writes are not retried',async()=>{
  let tokenCalls=0,siteCalls=0;
  const client=createHostedClient({env:oidcEnv,clock:()=>NOW,fetchImpl:async(url)=>{
    if(url.includes('actions.githubusercontent.com'))return Response.json({value:jwt(NOW,++tokenCalls)});
    siteCalls++;return siteCalls===1?new Response('',{status:401}):Response.json({revision:1});
  }});
  await client.request('/internal/state',{method:'PUT',body:{expectedRevision:0,files:[]}});assert.equal(tokenCalls,2);assert.equal(siteCalls,2);
  const conflict=createHostedClient({env:oidcEnv,clock:()=>NOW,fetchImpl:async url=>url.includes('actions.githubusercontent.com')?Response.json({value:jwt(NOW)}):new Response('',{status:409})});
  await assert.rejects(conflict.request('/internal/state',{method:'PUT',body:{}}),/HOSTED_STATE_CONFLICT/);
});
test('CAS conflict blocks further writes and no publication happens before a successful checkpoint',async t=>{
  const root=await workspace(t),api=backend(),session=await createStateSession(root,api);await report(root);
  api.state={revision:3,files:[]};const publish=createHostedPublisher({client:api,session,clock:()=>at(0)});
  await assert.rejects(publish(join(root,'reports')),/HOSTED_STATE_CONFLICT/);
  assert.equal(session.blocked,'HOSTED_STATE_CONFLICT');assert.equal(api.calls.filter(c=>c.method==='PUT').length,1);
  await assert.rejects(session.checkpoint(),/HOSTED_STATE_CONFLICT/);
  assert.equal(api.calls.filter(c=>c.path==='/internal/publications').length,0);
});
test('direct production publication remains BLOCKED regardless of environment or injected extra options',async t=>{
  const root=await workspace(t),api=backend(),session=await createStateSession(root,api),r=await report(root);
  const publisher=blockedPublisher({client:api,session,clock:()=>at(0),releaseGate:()=>({status:'APPROVED'})});
  await assert.rejects(publisher(r.out,{env:{RELEASE_GATE:'GREEN'},releaseGate:()=>true}),/^Error: RELEASE_GATE_BLOCKED$/);
  assert.equal(api.calls.filter(c=>c.method==='POST').length,0);assert.equal(api.notifications,0);
  const receipt=await readJson(join(r.out,'publication.json'));
  assert.equal(receipt.channels.releaseGate.decision,'BLOCKED');
  assert.equal(receipt.channels.releaseGate.diagnostic.productionAuthorization,false);
  await session.checkpoint(); // A blocked release still retains collection and audit state.
});
test('malformed successful state responses never become an empty initial state',async t=>{
  for(const remote of [false,{},0,{revision:0,files:[]}]){
    const root=await workspace(t);await assert.rejects(createStateSession(root,{request:async()=>remote}),/HOSTED_STATE_INVALID/);
    assert.deepEqual(await readdir(root),[]);
  }
});
test('publication checkpoints first, verifies exact served bytes and delegates repeat notifications to the durable Worker',async t=>{
  const root=await workspace(t),api=backend(),session=await createStateSession(root,api),r=await report(root);
  const publish=createHostedPublisher({client:api,session,clock:()=>at(0)});
  const first=await publish(r.out,{expectedReportId:r.receipt.reportId});
  assert.equal(first.channels.externalWebsite.mode,'hosted');assert.equal(first.channels.externalWebsite.servedVerified,true);
  assert.equal(first.channels.notifications.status,'accepted');
  assert.deepEqual(api.calls.slice(1,6).map(c=>[c.path,c.method]),[
    ['/internal/state','PUT'],['/internal/publications','POST'],['/internal/report-status','GET'],['/internal/publications','POST'],['/internal/notifications','POST']]);
  await session.checkpoint();
  const nextRoot=await workspace(t),nextSession=await createStateSession(nextRoot,api);
  const replay=await createHostedPublisher({client:api,session:nextSession,clock:()=>at(1000)})(join(nextRoot,'reports'));
  assert.equal(replay.channels.notifications.status,'accepted');assert.equal(api.notifications,1);
});
test('restored immutable bundles publish without excluded legacy files and corrupted restored data cannot publish',async t=>{
  const root=await workspace(t),api=backend(),session=await createStateSession(root,api),r=await report(root);
  await writeFile(join(r.out,'predictions.md'),'legacy');r.receipt.files.push({name:'predictions.md',sha256:hash('legacy')});await atomicJson(join(r.out,'publication.json'),r.receipt);
  await persistReport(r.out,{nowISO:at(0)});await session.checkpoint();
  const restored=await workspace(t),resumed=await createStateSession(restored,api);
  await assert.rejects(readFile(join(restored,'reports/predictions.md')),/ENOENT/);
  const publisher=createHostedPublisher({client:api,session:resumed,clock:()=>at(0)});
  assert.equal((await publisher(join(restored,'reports'))).channels.externalWebsite.servedVerified,true);
  const document=await readJson(join(restored,'reports/predictions.json'));document.summary.forecasts=0;await atomicJson(join(restored,'reports/predictions.json'),document);
  await assert.rejects(publisher(join(restored,'reports')),/HOSTED_REPORT_CONTENT_CHANGED/);
});
test('bootstrap, wrong report and wrong hash cannot claim hosted publication or trigger notification',async t=>{
  for(const change of [{mode:'bootstrap'},{reportId:'b'.repeat(64)},{reportHash:'b'.repeat(64)},{health:'upstream_unavailable'}]){
    const root=await workspace(t),api=backend(),base=api.request;
    api.request=async(path,options)=>{const value=await base(path,options);return path==='/internal/report-status'?{...value,...change}:value;};
    const session=await createStateSession(root,api),r=await report(root);
    const result=await createHostedPublisher({client:api,session,clock:()=>at(0)})(r.out);
    assert.equal(result.channels.externalWebsite.status,'failed');assert.equal(result.channels.externalWebsite.servedVerified,false);assert.equal(api.notifications,0);
  }
});
test('a notification receipt for another report is unknown and never adopted',async t=>{
  const root=await workspace(t),api=backend(),base=api.request;
  api.request=async(path,options)=>{const value=await base(path,options);if(path==='/internal/notifications')value.reportId='f'.repeat(64);return value;};
  const session=await createStateSession(root,api),r=await report(root);
  const result=await createHostedPublisher({client:api,session,clock:()=>at(0)})(r.out);
  assert.equal(result.reportId,r.receipt.reportId);assert.equal(result.channels.notifications.status,'unknown');
  assert.equal(result.channels.notifications.code,'HOSTED_NOTIFICATION_RECEIPT_MISMATCH');
});

function acquisition(){return createAcquisitionSnapshot({fixtures:[{id:'oldb-1',sourceFixtureId:'1',source:'openligadb',league:'BL1',season:'2026',
  home:'A',away:'B',homeTeamId:'1',awayTeamId:'2',kickoff:at(7200000),status:'SCHEDULED',updatedAt:at(0),fetchedAt:at(0)}],history:[],checkedAt:at(0),policy:DEFAULT_POLICY});}
test('research mode settles already-frozen predictions before collecting new fixtures',async t=>{
  const api=backend(),calls=[];
  const fake=async(args,options)=>{
    const lane=args[1];calls.push(lane);
    assert.ok(args.includes('--mode'));assert.ok(args.includes('private-research'));
    assert.equal(options.env.COLLECTOR_COMMIT,'a'.repeat(40));
    if(lane==='results')await atomicJson(join(options.cwd,'reports/prospective-evaluation.json'),{generatedAt:at(0)});
    return {status:'complete',exitCode:0};
  };
  const result=await runHosted({root:await workspace(t),env:{GITHUB_SHA:'a'.repeat(40)},client:api,clock:()=>at(0),stdout:()=>{},
    runOrchestrationImpl:fake,privateResearch:true});
  assert.deepEqual(calls,['results','fixtures']);
  assert.equal(result.mode,'private-research');assert.equal(result.RELEASE_GATE,'BLOCKED');
});
test('fresh runners resume durable cadence: fixtures 15m, markets next run and results independently when budget permits',async t=>{
  const api=backend(),calls=[];let now=0,number=0;
  const fake=async(args,options)=>{
    const lane=args[1];calls.push(lane);assert.equal(options.env.COLLECTOR_COMMIT,'a'.repeat(40));
    assert.equal(options.env.TELEGRAM_BOT_TOKEN,undefined);assert.ok(args.includes(join(options.cwd,'state/state.json')));
    if(lane==='results'){await atomicJson(join(options.cwd,'reports/prospective-evaluation.json'),{generatedAt:at(now)});return {status:'complete',exitCode:0};}
    const r=await report(options.cwd,number++?'b':'a',now);await atomicJson(join(r.out,'public-fixtures.json'),acquisition());
    const receipt=await options.dependencies.publishAll(r.out,{expectedReportId:r.receipt.reportId});
    return {status:'complete',exitCode:0,reportId:receipt.reportId};
  };
  const options={env:{GITHUB_SHA:'a'.repeat(40)},client:api,clock:()=>at(now),stdout:()=>{},runOrchestrationImpl:fake};
  const first=await runHosted({root:await workspace(t),...options});assert.equal(first.status,'complete');assert.deepEqual(calls,['fixtures']);
  now=300000;await runHosted({root:await workspace(t),...options});assert.deepEqual(calls,['fixtures','markets','results']);
  now=360000;const idle=await runHosted({root:await workspace(t),...options});assert.equal(idle.status,'idle');assert.equal(calls.length,3);
  assert.ok(api.state.files.some(row=>row.path==='state/hosted-scheduler.json'));
});
test('uncertain pre-publication checkpoint stops the run and finally cannot overwrite the saved revision',async t=>{
  const api=backend(),base=api.request;let puts=0;
  api.request=async(path,options)=>{const value=await base(path,options);if(path==='/internal/state'&&options?.method==='PUT'){puts++;throw Error('HOSTED_REQUEST_UNCONFIRMED');}return value;};
  const root=await workspace(t),result=await runHosted({root,env:{GITHUB_SHA:'a'.repeat(40)},client:api,clock:()=>at(0),stdout:()=>{},
    runOrchestrationImpl:async(args,options)=>{const r=await report(root);try{await options.dependencies.publishAll(r.out);}catch{}return {status:'failed',exitCode:1};}});
  assert.equal(result.status,'blocked');assert.equal(result.code,'HOSTED_REQUEST_UNCONFIRMED');assert.equal(puts,1);
  assert.equal(api.calls.filter(c=>c.path==='/internal/publications').length,0);assert.equal(api.state.revision,1);
});

function publicManifest(offset=0){
  const snapshot=acquisition(),checkedAt=at(offset);
  return {version:1,kind:'public-fixture-sample',dataSchemaVersion:2,simulated:false,poolComplete:false,checkedAt,
    fixtures:snapshot.fixtures.map(fixture=>({...fixture,kickoff:at(offset+7200000),fetchedAt:checkedAt,updatedAt:checkedAt})),
    history:[],diagnostics:[],coverage:[],sources:[{name:'OpenLigaDB',license:'ODbL-1.0',url:'https://www.openligadb.de/'}],limitations:[]};
}
async function fakePublic(args,options){
  assert.ok(!args.includes('--collect'));assert.equal(options.collectMode,'public');assert.equal(options.env.COLLECTOR_COMMIT,'a'.repeat(40));
  const manifest=publicManifest(Date.parse(options.clock())-NOW),out=args[args.indexOf('--out')+1];
  await atomicJson(join(out,'public-fixtures.json'),manifest);await atomicJson(join(out,'public-source-fixtures.json'),manifest);
  return {manifest,collection:null,exitCode:0};
}
test('observation bundles preserve source observation times and contain zero predictions or market candidates',()=>{
  const manifest=publicManifest(),bundle=observationBundle(manifest,{commit:'a'.repeat(40),nowISO:at(1000)});
  assert.equal(bundle.report.generatedAt,manifest.checkedAt);assert.equal(bundle.report.fixtures[0].fixture.fetchedAt,manifest.fixtures[0].fetchedAt);
  assert.equal(bundle.report.summary.forecasts,0);assert.equal(bundle.report.summary.strictCandidates,0);
  assert.equal(bundle.report.fixtures[0].forecast.status,'unavailable');assert.equal(bundle.report.fixtures[0].marketCandidate.candidate,null);
  assert.equal(bundle.receipt.channels.externalWebsite.code,'RELEASE_GATE_BLOCKED');assert.equal(bundle.receipt.channels.externalWebsite.servedVerified,false);
  assert.equal(bundle.sourceData.openligadb.reportId,bundle.reportId);
  assert.doesNotMatch(JSON.stringify(bundle),/probabilities|decimalOdds|forecast-ledger|replays/);
  assert.throws(()=>observationBundle(manifest,{commit:'a'.repeat(40),nowISO:at(1200001)}),/STALE_OR_INVALID/);
});
test('observation mode checkpoints before Site projection and never calls forecast publication or notification endpoints',async t=>{
  const root=await workspace(t),api=backend();
  const result=await runShadow({root,env:{GITHUB_SHA:'a'.repeat(40)},client:api,clock:()=>at(0),stdout:()=>{},runPublicImpl:fakePublic});
  assert.equal(result.status,'complete');assert.equal(result.RELEASE_GATE,'BLOCKED');assert.equal(result.forecastPublished,false);assert.equal(result.observationServedVerified,true);
  assert.deepEqual(api.calls.map(c=>[c.path,c.method]),[['/internal/state','GET'],['/internal/state','PUT'],['/internal/observations','POST'],['/internal/report-status','GET'],['/internal/state','PUT']]);
  const row=api.state.files.find(row=>row.path==='state/hosted-observation.json'),record=JSON.parse(Buffer.from(row.content,'base64'));
  assert.equal(record.bundle.receipt.channels.externalWebsite.code,'RELEASE_GATE_BLOCKED');assert.equal(record.delivery.forecastPublished,false);
  assert.equal(api.notifications,0);
});
test('five-minute wakeups reuse original times and only collect new observations every fifteen minutes',async t=>{
  const api=backend(),options={env:{GITHUB_SHA:'a'.repeat(40)},client:api,stdout:()=>{}};let calls=0;
  const runPublicImpl=async(...args)=>{calls++;return fakePublic(...args);};
  const first=await runShadow({root:await workspace(t),...options,clock:()=>at(0),runPublicImpl});
  const idle=await runShadow({root:await workspace(t),...options,clock:()=>at(300000),runPublicImpl});
  assert.equal(idle.status,'idle');assert.equal(calls,1);assert.equal(idle.observationGeneratedAt,first.observationGeneratedAt);
  const next=await runShadow({root:await workspace(t),...options,clock:()=>at(900000),runPublicImpl});
  assert.equal(next.status,'complete');assert.equal(calls,2);assert.equal(next.observationGeneratedAt,at(900000));
});
test('repeated observation runs preserve existing unscored ledger/replay bytes and keep state file count bounded',async t=>{
  const api=backend(),retained=[file(`reports/forecast-ledger/${'a'.repeat(64)}/predictions/${'b'.repeat(64)}.json`,{unscored:true}),
    file(`reports/replays/${'a'.repeat(64)}/run-inputs.json`,{original:'must survive'}),file('state/state.json.history.json',{oldHistory:[1,2,3]})];
  api.state={revision:1,files:structuredClone(retained)};let firstCount,firstBytes;
  for(let run=0;run<40;run++){
    const result=await runShadow({root:await workspace(t),env:{GITHUB_SHA:'a'.repeat(40)},client:api,clock:()=>at(run*900000),stdout:()=>{},runPublicImpl:fakePublic});
    assert.equal(result.status,'complete');const size=JSON.stringify(api.state).length;
    if(!run){firstCount=api.state.files.length;firstBytes=size;}
    assert.equal(api.state.files.length,firstCount);assert.ok(size<firstBytes+200);
    for(const original of retained)assert.deepEqual(api.state.files.find(row=>row.path===original.path),original);
  }
  assert.equal(api.state.files.filter(row=>row.path.includes('/forecast-ledger/')||row.path.includes('/replays/')).length,2);
});
test('failed, stale or empty collection cannot replace a previously served observation',async t=>{
  for(const change of [value=>({...value,exitCode:1}),value=>({...value,manifest:{...value.manifest,fixtures:[]}}),
    value=>({...value,manifest:{...value.manifest,checkedAt:at(-1200001)}})]){
    const api=backend(),result=await runShadow({root:await workspace(t),env:{GITHUB_SHA:'a'.repeat(40)},client:api,clock:()=>at(0),stdout:()=>{},
      runPublicImpl:async(...args)=>change(await fakePublic(...args))});
    assert.equal(result.status,'blocked');assert.ok(!result.observationServedVerified);assert.equal(api.calls.filter(row=>row.method==='POST').length,0);
  }
});
test('projection readback must agree on origin, projected hash, mode and forecastPublished false',async t=>{
  for(const change of [{originReportId:'f'.repeat(64)},{reportHash:'f'.repeat(64)},{mode:'bootstrap'},{forecastPublished:true}]){
    const api=backend(),base=api.request;
    api.request=async(path,options)=>{const value=await base(path,options);return path==='/internal/report-status'?{...value,...change}:value;};
    const result=await runShadow({root:await workspace(t),env:{GITHUB_SHA:'a'.repeat(40)},client:api,clock:()=>at(0),stdout:()=>{},runPublicImpl:fakePublic});
    assert.equal(result.code,'HOSTED_OBSERVATION_READBACK_MISMATCH');assert.equal(result.observationServedVerified,false);
    assert.equal(api.calls.filter(row=>row.path==='/internal/notifications').length,0);
  }
});
test('observation checkpoint conflicts stop before publication and never overwrite a newer revision in finally',async t=>{
  const api=backend(),base=api.request;let puts=0;
  api.request=async(path,options)=>{if(path==='/internal/state'&&options?.method==='PUT'){puts++;throw Error('HOSTED_STATE_CONFLICT');}return base(path,options);};
  const result=await runShadow({root:await workspace(t),env:{GITHUB_SHA:'a'.repeat(40)},client:api,clock:()=>at(0),stdout:()=>{},runPublicImpl:fakePublic});
  assert.equal(result.code,'HOSTED_STATE_CONFLICT');assert.equal(puts,1);assert.equal(api.calls.filter(row=>row.method==='POST').length,0);
});

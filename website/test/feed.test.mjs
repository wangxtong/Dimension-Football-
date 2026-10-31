import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { readDashboardBundle, dashboardReportHash, dashboardBundleFile } from '../report-feed.mjs';
import { sampleBundle, NOW } from './fixtures.mjs';

test('authenticated ECS bundle preserves report identity and never forwards visitor credentials',async()=>{
  const bundle=sampleBundle(), env={REPORTS_ORIGIN:'https://reports.example',REPORTS_READ_TOKEN:'a'.repeat(40)};
  const result=await readDashboardBundle(env,{now:NOW,fetchImpl:async(url,init)=>{
    assert.equal(url,'https://reports.example/api/report');assert.equal(init.redirect,'manual');
    assert.deepEqual(Object.keys(init.headers).sort(),['Accept','Authorization']);return Response.json(bundle);
  }});
  assert.equal(result.reportId,bundle.reportId);assert.equal(result.freshness.mode,'ecs');assert.equal(result.health.status,'available');
  assert.equal(result.reportHash,await dashboardReportHash(bundle.report));
});
test('compressed real bootstrap is explicit and old timestamps are never renewed',async()=>{
  const bundle=sampleBundle(), compressed='gzip:'+gzipSync(JSON.stringify(bundle)).toString('base64');
  const result=await readDashboardBundle({DASHBOARD_BOOTSTRAP_REPORT:compressed},{now:NOW+7200000,fetchImpl:()=>assert.fail('network')});
  assert.equal(result.report.generatedAt,bundle.report.generatedAt);assert.equal(result.freshness.stale,true);assert.equal(result.freshness.mode,'bootstrap');
  assert.deepEqual(dashboardBundleFile(result,'/api/predictions.json'),bundle.report);
  assert.equal(dashboardBundleFile(result,'/api/openligadb-fixtures.json'),null);
});
test('a failed upstream can serve a labelled bootstrap; corrupt bundles fail closed',async()=>{
  const env={REPORTS_ORIGIN:'https://reports.example',REPORTS_READ_TOKEN:'x'.repeat(40),DASHBOARD_BOOTSTRAP_REPORT:JSON.stringify(sampleBundle())};
  const result=await readDashboardBundle(env,{fetchImpl:async()=>new Response('private upstream',{status:404})});
  assert.equal(result.health.status,'upstream_unavailable');assert.equal(result.freshness.mode,'bootstrap');
  await assert.rejects(readDashboardBundle({...env,DASHBOARD_BOOTSTRAP_REPORT:'{}'},{fetchImpl:async()=>Response.json({version:1})}));
  await assert.rejects(readDashboardBundle({...env,REPORTS_ORIGIN:'http://reports.example'},{fetchImpl:()=>assert.fail('insecure request')}),/CONFIGURATION/);
  await assert.rejects(readDashboardBundle({},{fetchImpl:()=>assert.fail('anonymous GitHub request')}),/REPORT_NOT_CONFIGURED/);
});
test('chunked deployment bindings reconstruct the same snapshot and missing chunks fail closed',async()=>{
  const value='gzip:'+gzipSync(JSON.stringify(sampleBundle())).toString('base64');
  const middle=Math.floor(value.length/2),env={DASHBOARD_BOOTSTRAP_REPORT:'chunks:2',DASHBOARD_BOOTSTRAP_REPORT_1:value.slice(0,middle),DASHBOARD_BOOTSTRAP_REPORT_2:value.slice(middle)};
  assert.equal((await readDashboardBundle(env,{now:NOW})).reportId,sampleBundle().reportId);
  delete env.DASHBOARD_BOOTSTRAP_REPORT_2;
  await assert.rejects(readDashboardBundle(env),/BOOTSTRAP_CHUNK_MISSING/);
  const split={DASHBOARD_BOOTSTRAP_REPORT:'chunks:24'};
  for(let i=0;i<24;i++)split['DASHBOARD_BOOTSTRAP_REPORT_'+(i+1)]=value.slice(Math.floor(value.length*i/24),Math.floor(value.length*(i+1)/24));
  assert.equal((await readDashboardBundle(split,{now:NOW})).reportId,sampleBundle().reportId);
  await assert.rejects(readDashboardBundle({...split,DASHBOARD_BOOTSTRAP_REPORT:'chunks:33'}));
});
test('ECS reverse-proxy prefix is preserved without allowing query or credential URLs',async()=>{
  const env={REPORTS_ORIGIN:'https://football.fotpredict.xyz/dimension-football',REPORTS_READ_TOKEN:'a'.repeat(40)};
  await readDashboardBundle(env,{fetchImpl:async url=>{assert.equal(url,'https://football.fotpredict.xyz/dimension-football/api/report');return Response.json(sampleBundle());}});
  await assert.rejects(readDashboardBundle({...env,REPORTS_ORIGIN:env.REPORTS_ORIGIN+'?other=1'}),/CONFIGURATION/);
});

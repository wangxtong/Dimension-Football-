import test from 'node:test';
import assert from 'node:assert/strict';
import { RESEARCH_JOBS, researchRuntime, nextResearchJob, finishResearchJob } from '../research-cloud-worker.mjs';

const sha = 'a'.repeat(40);
const valid = { RAILWAY_VOLUME_MOUNT_PATH: '/data', RAILWAY_GIT_COMMIT_SHA: sha, RAILWAY_ENVIRONMENT_NAME: 'research' };

test('research service requires an attached /data volume and real commit SHA', () => {
  assert.deepEqual(researchRuntime(valid), {root:'/data',commitSha:sha});
  assert.throws(() => researchRuntime({...valid,RAILWAY_VOLUME_MOUNT_PATH:undefined}), /RESEARCH_PERSISTENT_VOLUME_REQUIRED/);
  assert.throws(() => researchRuntime({...valid,RAILWAY_VOLUME_MOUNT_PATH:'/tmp'}), /RESEARCH_PERSISTENT_VOLUME_REQUIRED/);
  assert.throws(() => researchRuntime({...valid,RAILWAY_GIT_COMMIT_SHA:'demo'}), /RESEARCH_CODE_SHA_REQUIRED/);
});

test('production env and enabled publication flags are rejected', () => {
  assert.throws(() => researchRuntime({...valid,RAILWAY_ENVIRONMENT_NAME:'production'}), /RESEARCH_PRODUCTION_ENV_FORBIDDEN/);
  assert.throws(() => researchRuntime({...valid,HOSTED_PUBLICATION_ENABLED:'true'}), /RESEARCH_PUBLICATION_ENV_FORBIDDEN/);
  assert.throws(() => researchRuntime({...valid,VANTIS_ECS_PRIMARY:'true'}), /RESEARCH_PUBLICATION_ENV_FORBIDDEN/);
});

test('only fixtures, markets, results; no delivery or commercial publication lane', () => {
  assert.deepEqual(RESEARCH_JOBS.map(x=>x.lane), ['fixtures','markets','results']);
});

test('fresh worker launches fixtures first, then other initial due jobs', () => {
  let state = {version:1,due:{}};
  assert.equal(nextResearchJob(state,0).lane,'fixtures');
  state = finishResearchJob(state,'fixtures',1000,{status:'partial',exitCode:0});
  assert.equal(nextResearchJob(state,1000).lane,'markets');
  state = finishResearchJob(state,'markets',1200,{status:'blocked',exitCode:1});
  assert.equal(nextResearchJob(state,1200).lane,'results');
});

test('next scheduled job respects intervals and bounded sleep', () => {
  let state={version:1,due:{fixtures:2000000,markets:2000000,results:2000000}};
  const x=nextResearchJob(state,1000);
  assert.equal(x.waitMs,30000);
  state = finishResearchJob(state,'markets',2000000,{status:'complete',exitCode:0,reportId:'b'.repeat(64)});
  assert.equal(state.due.markets,2000000+120000);
  assert.equal(state.last.reportId,'b'.repeat(64));
});

test('bad scheduler and wrong lane fail closed', () => {
  assert.throws(() => nextResearchJob({version:2,due:{}},0),/RESEARCH_SCHEDULER_INVALID/);
  assert.throws(() => finishResearchJob({version:1,due:{}},'delivery',0,{}),/RESEARCH_SCHEDULER_INVALID/);
});

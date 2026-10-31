import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activationPlan, runActivation } from '../activate.mjs';
import { DEFAULT_PROVIDER_POLICY } from '../sources/providers.mjs';
import { DEFAULT_SOURCE_POLICY } from '../sources/manager.mjs';

const NOW = '2026-10-31T10:00:00.000Z';
const plan = (env, sourcePolicy = DEFAULT_SOURCE_POLICY) => activationPlan({ env,
  providerPolicy: DEFAULT_PROVIDER_POLICY, sourcePolicy, nowISO: NOW });
async function workspace(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'football-activation-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

test('activation requires an enabled fixture source or input, not an odds key alone', () => {
  assert.equal(plan({ THE_ODDS_API_KEY: 'private-key' }).canCollect, false);
  assert.equal(plan({ FOOTBALL_DATA_API_KEY: '   ' }).canCollect, false);
  assert.equal(plan({ FOOTBALL_DATA_API_TOKEN: 'private-key' }).canCollect, true);
  assert.equal(plan({ SPORTMONKS_API_TOKEN: 'private-key' }).canCollect, true);
  assert.equal(plan({ SPORTMONKS_API_TOKEN: 'private-key' }, { ...DEFAULT_SOURCE_POLICY,
    fixturePriority: ['football-data.org'] }).canCollect, false);
  assert.equal(plan({ FIXTURES_FILE: 'fixtures.json' }).canCollect, true);
});

test('missing credentials produce an explicit configuration report without any collection', async t => {
  const cwd = await workspace(t);
  const { report, exitCode } = await runActivation([], { cwd, env: {}, clock: () => NOW,
    stdout: () => {}, collect: () => assert.fail('must not collect') });
  assert.equal(exitCode, 0);
  assert.equal(report.status, 'configuration_required');
  assert.equal(report.collection, null);
  assert.equal(report.providers.find(row => row.id === 'nami').status, 'contract_required');
  assert.equal(JSON.parse(await readFile(join(cwd, 'reports/activation.json'))).canCollect, false);
});

test('activation uses bounded basic collection and separates data, empty responses and auth failures', async t => {
  const cwd = await workspace(t), secret = 'never-publish-this-private-key', output = [];
  const env = { SPORTMONKS_API_TOKEN: secret, THE_ODDS_API_KEY: secret, ISPORTS_API_KEY: secret,
    GITHUB_STEP_SUMMARY: join(cwd, 'summary.md') };
  const { report } = await runActivation([], { cwd, env, clock: () => NOW, stdout: text => output.push(text),
    collect: async (args) => {
      assert.ok(args.includes('--basic'));
      assert.equal(args[args.indexOf('--budget-minutes') + 1], '5');
      return { exitCode: 0, report: { status: 'completed', summary: { total: 2, candidates: 0 },
        providers: { attempts: [
          { id: 'sportmonks', status: 'checked', requests: 1, observationCount: 2 },
          { id: 'the-odds-api', status: 'checked', requests: 1, observationCount: 0 },
          { id: 'isports', status: 'authorization_required', requests: 1 },
        ] } } };
    } });
  assert.equal(report.status, 'collection_completed');
  assert.deepEqual(report.providers.slice(0, 3).map(row => row.status),
    ['data_received', 'no_matching_data', 'authorization_required']);
  for (const path of ['reports/activation.json', 'reports/activation.md', 'summary.md']) {
    assert.ok(!(await readFile(join(cwd, path), 'utf8')).includes(secret));
  }
  assert.ok(!output.join('').includes(secret));
});

test('collector errors fail activation, redact arbitrary exceptions and never claim API verification', async t => {
  const cwd = await workspace(t), secret = 'private-key-inside-error';
  const { report, exitCode } = await runActivation([], { cwd, env: { SPORTMONKS_API_TOKEN: secret },
    clock: () => NOW, stdout: () => {}, collect: async () => { throw new Error(secret); } });
  assert.equal(exitCode, 1);
  assert.equal(report.status, 'collection_failed');
  assert.equal(report.error, 'COLLECTION_FAILED');
  assert.equal(report.providers[0].status, 'not_attempted');
  assert.ok(!(await readFile(join(cwd, 'reports/activation.json'), 'utf8')).includes(secret));
});

test('empty fixtures and zero requests do not mark configured providers as connected', async t => {
  const cwd = await workspace(t);
  const { report } = await runActivation([], { cwd, env: { SPORTMONKS_API_TOKEN: 'configured' },
    clock: () => NOW, stdout: () => {}, collect: async () => ({ exitCode: 0,
      report: { status: 'completed', summary: { total: 0, candidates: 0 },
        providers: { attempts: [{ id: 'sportmonks', status: 'not_checked', requests: 0, observationCount: 0 }] } } }) });
  assert.equal(report.providers[0].status, 'not_attempted');
  assert.equal(report.collection.fixtures, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, parseArgs } from '../run.mjs';

const NOW = '2026-10-29T08:00:00.000Z';

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dimension-football-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('demo CLI is fully offline, visibly simulated, and produces zero production candidates', async t => {
  const cwd = await workspace(t), output = [];
  let networkCalls = 0;
  const result = await runCli(['--demo'], { cwd, env: { API_FOOTBALL_KEY: 'unused', FOOTBALL_DATA_API_TOKEN: 'unused' }, clock: () => NOW, stdout: text => output.push(text),
    fetchImpl: async () => { networkCalls++; throw new Error('Network is forbidden in this test'); } });
  assert.equal(networkCalls, 0);
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.simulated, true);
  assert.equal(result.report.summary.candidates, 0);
  assert.equal(result.report.summary.simulatedCandidates, 1);
  assert.deepEqual(result.report.candidates, []);
  assert.ok(output.join('').includes('模拟验证'));
  const entries = await readdir(cwd);
  assert.ok(entries.includes('.collection-state-demo'));
  assert.ok(!entries.includes('.collection-state'));
  const state = JSON.parse(await readFile(join(cwd, '.collection-state-demo', 'state.json'), 'utf8'));
  assert.equal(state.simulated, true);
});

test('a missing or blank fixture API key fails clearly before any network or checkpoint write', async t => {
  const cwd = await workspace(t);
  for (const env of [{}, { FOOTBALL_DATA_API_KEY: '   ', FOOTBALL_DATA_API_TOKEN: ' ', API_FOOTBALL_KEY: ' ' }]) {
    let networkCalls = 0;
    await assert.rejects(runCli([], { cwd, env, clock: () => NOW, stdout: () => {},
      fetchImpl: async () => { networkCalls++; throw new Error('Network forbidden'); } }),
    { message: 'FIXTURE_API_KEY_OR_INPUT_REQUIRED' });
    assert.equal(networkCalls, 0);
    assert.deepEqual(await readdir(cwd), []);
  }
});

test('complete fixture source failure returns failure and redacts network error credentials', async t => {
  const cwd = await workspace(t), secret = 'fixture-api-secret-do-not-persist', output = [];
  let calls = 0;
  const result = await runCli([], { cwd, env: { FOOTBALL_DATA_API_KEY: secret }, clock: () => NOW,
    stdout: text => output.push(text), fetchImpl: async () => { calls++; throw new Error(`Authorization: ${secret}`); } });
  assert.ok(calls > 0);
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.poolComplete, false);
  assert.equal(result.report.summary.candidates, 0);
  assert.equal(result.report.summary.total, 0);
  assert.ok(!JSON.stringify(result.report).includes(secret));
  assert.ok(!output.join('').includes(secret));
  assert.ok(!(await readFile(result.files.jsonPath, 'utf8')).includes(secret));
});

test('argument validation rejects contradictory input, accidental evidence acceptance and excessive budgets', () => {
  for (const argv of [['--demo', '--input', 'fixtures.json'], ['--demo', '--evidence', 'quotes.json'],
    ['--accept-reviewed-evidence'], ['--budget-minutes', '21'], ['--budget-minutes', '0'],
    ['--input'], ['--demo', '--demo'], ['--unknown']]) assert.throws(() => parseArgs(argv));
  assert.equal(parseArgs(['--budget-minutes', '20']).budgetMs, 1_200_000);
  assert.equal(parseArgs(['--deep-analysis'])['deep-analysis'], true);
  assert.throws(() => parseArgs(['--basic', '--deep-analysis']), { message: 'CONFLICTING_ARGUMENTS' });
  assert.throws(() => parseArgs(['--demo', '--deep-analysis']), { message: 'CONFLICTING_ARGUMENTS' });
});

test('basic collection suppresses automatic deep analysis with only an API-Football key', async t => {
  const cwd = await workspace(t);
  const result = await runCli(['--basic'], { cwd, env: { API_FOOTBALL_KEY: 'basic-mode-key' },
    clock: () => NOW, stdout: () => {}, fetchImpl: async () => new Response(JSON.stringify({
      get: 'fixtures', errors: [], results: 0, paging: { current: 1, total: 1 }, response: [],
    }), { headers: { Date: new Date(NOW).toUTCString() } }) });
  assert.equal(result.exitCode, 0);
  assert.equal(result.fullAnalysis, undefined);
  assert.ok(!(await readdir(join(cwd, 'reports'))).includes('full-analysis'));
});

test('deep analysis requires the specifically authorized provider key before any network request', async t => {
  const cwd = await workspace(t);
  let calls = 0;
  await assert.rejects(runCli(['--deep-analysis'], { cwd, env: { FOOTBALL_DATA_API_TOKEN: 'other-provider-key' },
    fetchImpl: async () => { calls++; throw new Error('Must not fetch'); }, stdout: () => {} }),
  { message: 'DEEP_ANALYSIS_API_KEY_REQUIRED' });
  assert.equal(calls, 0);
});

test('accepts both providers and the token alias with deterministic preference and no credential persistence', async t => {
  const scenarios = [
    { env: { API_FOOTBALL_KEY: 'api-football-only' }, host: 'v3.football.api-sports.io', key: 'api-football-only' },
    { env: { FOOTBALL_DATA_API_TOKEN: 'football-data-alias', API_FOOTBALL_KEY: 'unused-api-football' }, host: 'api.football-data.org', key: 'football-data-alias' },
    { env: { FOOTBALL_DATA_API_KEY: 'primary-key', FOOTBALL_DATA_API_TOKEN: 'unused-alias', API_FOOTBALL_KEY: 'unused-api-football' }, host: 'api.football-data.org', key: 'primary-key' },
    { env: { FOOTBALL_DATA_API_KEY: ' ', FOOTBALL_DATA_API_TOKEN: 'football-data-alias' }, host: 'api.football-data.org', key: 'football-data-alias' },
  ];
  for (const scenario of scenarios) {
    const cwd = await workspace(t), calls = [];
    const result = await runCli([], { cwd, env: scenario.env, clock: () => NOW, stdout: () => {},
      fetchImpl: async (url, init) => {
        const request = new URL(url); calls.push(request);
        assert.equal(request.hostname, scenario.host);
        assert.equal(init.headers[scenario.host === 'api.football-data.org' ? 'X-Auth-Token' : 'x-apisports-key'], scenario.key);
        return new Response(JSON.stringify(scenario.host === 'api.football-data.org' ? { matches: [] }
          : { get: 'fixtures', errors: [], results: 0, paging: { current: 1, total: 1 }, response: [] }),
        { headers: { Date: new Date(NOW).toUTCString() } });
      } });
    assert.equal(calls.length, 5);
    assert.equal(result.exitCode, 0);
    assert.equal(result.report.poolComplete, true);
    const savedReport = await readFile(result.files.jsonPath, 'utf8');
    for (const secret of Object.values(scenario.env).filter(value => value.trim())) assert.ok(!savedReport.includes(secret));
  }
});

test('an explicit fixture file overrides both API credentials without network requests', async t => {
  const cwd = await workspace(t);
  await writeFile(join(cwd, 'fixtures.json'), '[]');
  const result = await runCli(['--input', 'fixtures.json'], { cwd,
    env: { FOOTBALL_DATA_API_TOKEN: 'unused-football-data', API_FOOTBALL_KEY: 'unused-api-football', FIXTURES_FILE: 'missing.json' },
    clock: () => NOW, stdout: () => {}, fetchImpl: async () => { throw new Error('Network forbidden'); } });
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.poolComplete, false);
});

test('CLI automatically switches schedules, persists cooldown and exposes a fully offline health command', async t => {
  const cwd = await workspace(t), env = { FOOTBALL_DATA_API_KEY: 'fd-private-key', API_FOOTBALL_KEY: 'af-private-key' };
  const calls = [];
  const fetchImpl = async (url, init) => {
    const host = new URL(url).host; calls.push(host);
    assert.equal(init.redirect, 'manual');
    if (host === 'api.football-data.org') return new Response('{}', { status: 401 });
    assert.equal(host, 'v3.football.api-sports.io');
    return new Response(JSON.stringify({ get: 'fixtures', errors: [], results: 0,
      paging: { current: 1, total: 1 }, response: [] }), { headers: { Date: new Date(NOW).toUTCString() } });
  };
  for (let run = 0; run < 2; run++) {
    calls.length = 0;
    const result = await runCli([], { cwd, env, clock: () => NOW, stdout: () => {}, fetchImpl });
    assert.equal(result.exitCode, 0); assert.equal(result.report.poolComplete, true);
    assert.equal(result.report.sourceManagement.selectedSource, 'api-football');
    assert.equal(result.report.sourceManagement.fallbackUsed, true);
    assert.equal(calls.length, run === 0 ? 10 : 5);
    assert.equal(result.fullAnalysis, undefined, 'fallback does not silently enable extra paid analysis requests');
    const report = JSON.parse(await readFile(result.files.jsonPath, 'utf8'));
    assert.equal(report.sourceManagement.attempts[0].code, run === 0 ? 'authorization_required' : 'cooldown');
    const message = await readFile(result.files.messagePath, 'utf8');
    assert.ok(message.includes('信息源自动维护') && message.includes('api-football'));
    for (const secret of Object.values(env)) assert.ok(!JSON.stringify(report).includes(secret) && !message.includes(secret));
  }
  const output = [];
  const status = await runCli(['--source-status'], { cwd, env: {}, clock: () => NOW,
    stdout: text => output.push(text), fetchImpl: () => assert.fail('status must be offline') });
  assert.equal(status.exitCode, 0);
  const saved = JSON.parse(output.join(''));
  assert.equal(saved.lastSelectedSource, 'api-football');
  assert.equal(saved.sources[0].circuit, 'open');
  assert.equal(saved.sources[1].status, 'healthy');
});

test('source-status on a new installation makes no network or state writes', async t => {
  const cwd = await workspace(t);
  const result = await runCli(['--source-status'], { cwd, env: {}, stdout: () => {},
    fetchImpl: () => assert.fail('network forbidden') });
  assert.ok(result.sourceManagement.sources.every(source => source.status === 'unknown'));
  assert.deepEqual(await readdir(cwd), []);
  assert.throws(() => parseArgs(['--source-status', '--demo']), { message: 'CONFLICTING_ARGUMENTS' });
});

test('CLI cancellation stops source failover with nonzero exit and no provider failure history', async t => {
  const cwd = await workspace(t), controller = new AbortController();
  let calls = 0;
  const result = await runCli([], { cwd, env: { FOOTBALL_DATA_API_KEY: 'fd-key', API_FOOTBALL_KEY: 'af-key' },
    clock: () => NOW, stdout: () => {}, signal: controller.signal, fetchImpl: async () => {
      calls++; controller.abort(); throw new Error('cancelled by operator');
    } });
  assert.equal(calls, 5); assert.equal(result.exitCode, 1);
  assert.equal(result.report.sourceManagement.interrupted, 'cancelled');
  const state = JSON.parse(await readFile(join(cwd, '.collection-state/state.json.sources.json'), 'utf8'));
  assert.deepEqual(state.sources, {});
});

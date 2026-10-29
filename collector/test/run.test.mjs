import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
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
  const result = await runCli(['--demo'], { cwd, env: {}, clock: () => NOW, stdout: text => output.push(text),
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
  for (const env of [{}, { FOOTBALL_DATA_API_KEY: '   ' }]) {
    let networkCalls = 0;
    await assert.rejects(runCli([], { cwd, env, clock: () => NOW, stdout: () => {},
      fetchImpl: async () => { networkCalls++; throw new Error('Network forbidden'); } }),
    { message: 'FOOTBALL_DATA_API_KEY_OR_INPUT_REQUIRED' });
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
});

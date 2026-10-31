import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOrchestration } from '../orchestrate.mjs';
import { atomicJson, readJson } from '../storage.mjs';
import { createAcquisitionSnapshot, verifyAcquisitionSnapshot } from '../data/acquisition-snapshot.mjs';
import { verifyReplayBundle } from '../data/run-manifest.mjs';
import { verifyPublication } from '../publication.mjs';
import { withEventIdentity } from '../data/identity.mjs';
import { DEFAULT_POLICY } from '../policy.mjs';
import { appendReportPredictions } from '../prediction-ledger.mjs';
import { FORECAST_MODEL } from '../forecast.mjs';

const NOW = '2026-10-31T04:00:00.000Z', at = days => new Date(Date.parse(NOW) + days * 86400000).toISOString();
const fixture = () => withEventIdentity({ id: 'oldb-7', sourceFixtureId: '7', source: 'openligadb', league: 'BL1', season: '2026',
  home: 'Club 1', away: 'Club 2', homeTeamId: '1', awayTeamId: '2', kickoff: at(1), status: 'SCHEDULED', updatedAt: NOW, fetchedAt: NOW });
async function workspace(t) { const path = await mkdtemp(join(tmpdir(), 'orchestration-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }
const args = (cwd, lane) => ['--lane', lane, '--state', join(cwd, 'state.json'), '--out', join(cwd, 'reports'), '--budget-minutes', '1'];
const common = cwd => ({ cwd, env: {}, clock: () => NOW, stdout: () => {}, fetchImpl: () => assert.fail('unexpected network') });
const snapshot = rows => createAcquisitionSnapshot({ fixtures: rows, history: [], checkedAt: NOW, policy: DEFAULT_POLICY });

test('orchestration help is read-only and never invokes a dependency', async t => {
  const cwd = await workspace(t), result = await runOrchestration(['--help'], common(cwd));
  assert.equal(result.exitCode, 0); assert.deepEqual(await readdir(cwd), []);
});

test('market lane refuses stale or modified fixture snapshots without refreshing their timestamps', async t => {
  const cwd = await workspace(t), file = join(cwd, 'reports/public-fixtures.json'), input = snapshot([fixture()]);
  await atomicJson(file, input);
  const original = await readFile(file, 'utf8');
  const stale = await runOrchestration(args(cwd, 'markets'), { ...common(cwd), clock: () => '2026-10-31T04:20:00.001Z' });
  assert.equal(stale.status, 'blocked'); assert.equal(stale.code, 'FIXTURE_CACHE_EXPIRED');
  assert.equal(await readFile(file, 'utf8'), original);
  input.fixtures[0].kickoff = at(2); await atomicJson(file, input);
  const changed = await runOrchestration(args(cwd, 'markets'), common(cwd));
  assert.equal(changed.code, 'ACQUISITION_SNAPSHOT_CHANGED');
});

test('market lane skips an empty next-day window, and forwards fresh cached inputs without reacquisition', async t => {
  const cwd = await workspace(t), file = join(cwd, 'reports/public-fixtures.json');
  await atomicJson(file, snapshot([{ ...fixture(), kickoff: at(2) }]));
  const skipped = await runOrchestration(args(cwd, 'markets'), common(cwd));
  assert.equal(skipped.code, 'NO_FIXTURES_WITHIN_24_HOURS');
  await atomicJson(file, snapshot([fixture()])); const original = await readFile(file, 'utf8'); let collected = 0, delivered = 0;
  const result = await runOrchestration(args(cwd, 'markets'), { ...common(cwd), dependencies: {
    runPublic: () => assert.fail('markets cannot reacquire fixtures'),
    runCli: async (argv, options) => { collected++; assert.ok(argv.includes(file)); assert.equal(options.marketHorizonHours, 24);
      assert.equal(options.persistAcquisition, false); return { exitCode: 0, report: { publication: { reportId: 'a'.repeat(64) } } }; },
    publishAll: async (out, options) => { delivered++; assert.equal(options.expectedReportId, 'a'.repeat(64)); return { reportId: options.expectedReportId }; },
  } });
  assert.equal(result.exitCode, 0); assert.equal(collected, 1); assert.equal(delivered, 1);
  assert.equal(await readFile(file, 'utf8'), original);
});

test('configured fixture sources remain on their authorized channel and preserve history inputs', async t => {
  const cwd = await workspace(t); let mode;
  const result = await runOrchestration(args(cwd, 'fixtures'), { ...common(cwd), env: { API_FOOTBALL_KEY: 'offline-test-key', HISTORY_FILE: 'owned-history.json' },
    dependencies: { runPublic: async (argv, options) => { mode = options.collectMode; assert.equal(options.env.HISTORY_FILE, 'owned-history.json');
      assert.equal(options.evidenceMode, 'none'); assert.equal(options.persistAcquisition, true);
      return { exitCode: 0, collection: { report: { publication: { reportId: 'a'.repeat(64) } } } }; },
    publishAll: async () => ({ reportId: 'a'.repeat(64) }) } });
  assert.equal(result.exitCode, 0); assert.equal(mode, 'managed');
});

test('delivery lane only resumes publication and never starts acquisition or model work', async t => {
  const cwd = await workspace(t); let calls = 0;
  const result = await runOrchestration(args(cwd, 'delivery'), { ...common(cwd), dependencies: {
    runPublic: () => assert.fail('no acquisition'), runCli: () => assert.fail('no analysis'), fetchPublicResults: () => assert.fail('no results'),
    publishAll: async directory => { calls++; assert.equal(directory, join(cwd, 'reports')); return { reportId: 'a'.repeat(64) }; },
  } });
  assert.equal(calls, 1); assert.equal(result.status, 'complete');
});

test('fixture orchestration binds replay files and writes predictions before publication', async t => {
  const cwd = await workspace(t), history = []; let published = 0;
  for (let round = 0; round < 12; round++) for (let home = 1; home <= 4; home++) for (let away = 1; away <= 4; away++) {
    if (home === away) continue;
    history.push({ matchID: 100 + history.length, leagueShortcut: 'bl1', leagueSeason: 2026,
      team1: { teamId: home, teamName: `Club ${home}` }, team2: { teamId: away, teamName: `Club ${away}` },
      matchDateTimeUTC: at(-150 + history.length), matchIsFinished: true,
      matchResults: [{ resultTypeKind: 'After90Minutes', pointsTeam1: (round + home) % 4, pointsTeam2: (round + away) % 3 }] });
  }
  const upcoming = { matchID: 7, leagueShortcut: 'bl1', leagueSeason: 2026, team1: { teamId: 1, teamName: 'Club 1' },
    team2: { teamId: 2, teamName: 'Club 2' }, matchDateTimeUTC: at(1), matchIsFinished: false, matchResults: [] };
  const result = await runOrchestration(args(cwd, 'fixtures'), { ...common(cwd), env: { COLLECTOR_COMMIT: 'b'.repeat(40) },
    fetchImpl: async url => new Response(JSON.stringify(url.endsWith('/2026') ? [upcoming, ...history] : url.endsWith('/2025') ? [] : { events: null }),
      { headers: { Date: new Date(NOW).toUTCString() } }), dependencies: {
      publishAll: async (directory, options) => {
        published++;
        const receipt = await readJson(join(directory, 'publication.json')); await verifyPublication(directory, receipt);
        assert.equal(receipt.reportId, options.expectedReportId);
        assert.ok(receipt.files.some(row => row.name === 'run-manifest.json')); assert.ok(receipt.files.some(row => row.name === 'run-inputs.json'));
        const replay = verifyReplayBundle({ manifest: await readJson(join(directory, 'run-manifest.json')), inputs: await readJson(join(directory, 'run-inputs.json')) }, { reportId: receipt.reportId });
        assert.equal(replay.inputs.history.length, history.length);
        assert.equal((await readJson(join(directory, 'openligadb-fixtures.json'))).reportId, receipt.reportId);
        const document = await readJson(join(directory, 'predictions.json'));
        assert.equal(document.summary.forecasts, 1); assert.equal(document.predictionLedger.recorded, 1);
        assert.equal(document.coverage.find(row => row.league === 'PL').historyStatus, 'not-supported');
        assert.ok((await readdir(join(directory, 'forecast-ledger'))).length > 0);
        const archived = await readJson(join(directory, 'replays', receipt.reportId, 'run-inputs.json'));
        assert.equal(archived.reportId, receipt.reportId);
        return { ...receipt, channels: { ...receipt.channels, externalWebsite: { status: 'published' } } };
      },
    } });
  assert.equal(result.exitCode, 0); assert.equal(published, 1);
  const acquired = await readJson(join(cwd, 'reports/public-fixtures.json'));
  assert.equal(verifyAcquisitionSnapshot(acquired, { nowISO: NOW }).fixtures[0].fetchedAt, NOW);
});

test('a delivery failure remains partial and arbitrary upstream error text never enters lane state', async t => {
  const cwd = await workspace(t);
  const partial = await runOrchestration(args(cwd, 'delivery'), { ...common(cwd), dependencies: {
    publishAll: async () => ({ reportId: 'a'.repeat(64), channels: { externalWebsite: { status: 'failed' } } }),
  } });
  assert.equal(partial.status, 'partial'); assert.equal(partial.code, 'DELIVERY_INCOMPLETE'); assert.equal(partial.exitCode, 1);
  const failed = await runOrchestration(args(cwd, 'delivery'), { ...common(cwd), dependencies: {
    publishAll: async () => { throw Error('PRIVATE_UPSTREAM_SECRET'); },
  } });
  assert.equal(failed.code, 'LANE_FAILED');
  assert.ok(!(await readFile(join(cwd, 'state.json.lanes.json'), 'utf8')).includes('PRIVATE_UPSTREAM_SECRET'));
});

test('results lane stores actual final scores and produces prospective horizon evaluations', async t => {
  const cwd = await workspace(t), directory = join(cwd, 'reports/forecast-ledger'), f = fixture(), predictionAt = NOW;
  await appendReportPredictions({ directory, nowISO: predictionAt, report: { simulated: false, publication: { reportId: 'a'.repeat(64) },
    forecasts: { model: FORECAST_MODEL, generatedAt: predictionAt }, results: [{ fixture: f, forecast: { fixtureId: f.id, status: 'forecast',
      generatedAt: predictionAt, trainingCutoff: predictionAt, trainingHash: 'b'.repeat(64), probabilities: { home: .5, draw: .3, away: .2 } } }] } });
  const now = at(2), result = { ...f, status: 'FINISHED', period: 'full-time', homeGoals: 2, awayGoals: 0, resultObservedAt: now, observedAt: now, fetchedAt: now };
  for (const key of ['revisionId', 'recordHash', 'identityRevision', 'canonicalMatchId']) delete result[key];
  const outcome = await runOrchestration(args(cwd, 'results'), { ...common(cwd), clock: () => now, dependencies: {
    fetchPublicResults: async () => ({ history: [result], diagnostics: [] }), publishAll: () => assert.fail('results lane must not send'),
  } });
  assert.equal(outcome.exitCode, 0); assert.equal(outcome.summary.recordedScores, 1);
  const evaluation = await readJson(join(cwd, 'reports/prospective-evaluation.json'));
  const day = evaluation.groups.find(row => row.horizonHours === 24);
  assert.equal(day.coverage.evaluated, 1); assert.ok(day.metrics.brier >= 0);
});

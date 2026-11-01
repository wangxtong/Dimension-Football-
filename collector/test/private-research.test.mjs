import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOrchestration, parseOrchestrationArgs } from '../orchestrate.mjs';
import { runHosted, allowedStatePath, createStateSession } from '../hosted.mjs';
import { readPredictionLedger } from '../prediction-ledger.mjs';
import { requireGreenForecastDelivery } from '../publication-release-gate.mjs';
import { createArchiveShard } from '../state-archive.mjs';

const NOW = Date.parse('2026-10-31T04:00:00.000Z'), at = offset => new Date(NOW + offset).toISOString();
async function workspace(t) { const dir = await mkdtemp(join(tmpdir(), 'private-research-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
function backend() {
  let state = null; const paths = [], objects = new Map();
  return { paths, get state() { return state; }, async request(path, { method = 'GET', body } = {}) {
    paths.push(path);
    if (/^\/internal\/state\/objects\/[a-f0-9]{64}\/[a-f0-9]{64}$/.test(path)) {
      if (method === 'GET') return structuredClone(objects.get(path));
      const shard = createArchiveShard(body.epoch, body.files); assert.equal(path.split('/').at(-1), shard.descriptor.sha256);
      objects.set(path, structuredClone(body)); return { version: 1, epoch: body.epoch, ...shard.descriptor };
    }
    assert.equal(path, '/internal/state', 'Private research can only call durable state, never publications or notifications');
    if (method === 'GET') return structuredClone(state);
    assert.equal(method, 'PUT'); assert.equal(body.expectedRevision, state?.revision || 0);
    state = { revision: body.expectedRevision + 1, files: structuredClone(body.files),
      ...(body.version === 2 ? { version: 2, archive: structuredClone(body.archive) } : {}) }; return { revision: state.revision };
  } };
}
function source(clock, settled = false) {
  const history = [];
  for (let round = 0; round < 12; round++) for (let home = 1; home <= 4; home++) for (let away = 1; away <= 4; away++) {
    if (home === away) continue;
    history.push({ matchID: 100 + history.length, leagueShortcut: 'bl1', leagueSeason: 2026,
      team1: { teamId: home, teamName: `Club ${home}` }, team2: { teamId: away, teamName: `Club ${away}` },
      matchDateTimeUTC: at((-150 + history.length) * 86400000), matchIsFinished: true,
      matchResults: [{ resultTypeKind: 'After90Minutes', pointsTeam1: (round + home) % 4, pointsTeam2: (round + away) % 3 }] });
  }
  const match = { matchID: 7, leagueShortcut: 'bl1', leagueSeason: 2026, team1: { teamId: 1, teamName: 'Club 1' },
    team2: { teamId: 2, teamName: 'Club 2' }, matchDateTimeUTC: at(86400000), matchIsFinished: settled,
    matchResults: settled ? [{ resultTypeKind: 'After90Minutes', pointsTeam1: 2, pointsTeam2: 0 }] : [] };
  return async url => new Response(JSON.stringify(url.endsWith('/2026') ? [match, ...history] : url.endsWith('/2025') ? [] : { events: null }),
    { headers: { Date: new Date(clock()).toUTCString() } });
}

test('private research refuses delivery before writes and does not change the default publishing contract', async t => {
  assert.equal(parseOrchestrationArgs(['--lane', 'fixtures']).mode, 'publish');
  assert.throws(() => parseOrchestrationArgs(['--lane', 'fixtures', '--mode', 'anything']), /INVALID_ORCHESTRATION_MODE/);
  const cwd = await workspace(t);
  await assert.rejects(runOrchestration(['--lane', 'delivery', '--mode', 'private-research', '--state', join(cwd, 'state.json')]), /PRIVATE_RESEARCH_DELIVERY_FORBIDDEN/);
  assert.deepEqual(await readdir(cwd), []);
});

test('real private freezes survive a new runner, settle privately, and never call a publication endpoint', async t => {
  const api = backend(), firstRoot = await workspace(t), clock = () => at(0);
  const common = { env: { GITHUB_SHA: 'a'.repeat(40) }, client: api, privateResearch: true, stdout: () => {} };
  const first = await runHosted({ root: firstRoot, ...common, clock, fetchImpl: source(clock) });
  assert.equal(first.exitCode, 0); assert.equal(first.mode, 'private-research'); assert.equal(first.forecastPublished, false);
  assert.equal(first.publicationStatus, 'not_attempted'); assert.deepEqual(first.outcomes.map(row => row.lane), ['results', 'fixtures']);
  const frozen = await readPredictionLedger({ directory: join(firstRoot, 'reports/forecast-ledger') });
  const predictions = frozen.events.flatMap(event => event.predictions);
  assert.equal(predictions.length, 1); assert.equal(predictions[0].recordedAt, at(0));
  assert.ok(api.state.files.some(row => row.path === 'state/hosted-research-scheduler.json'));
  assert.equal(allowedStatePath('state/hosted-research-scheduler.json'), true);
  assert.ok(!api.state.files.some(row => row.path === 'state/hosted-scheduler.json'));
  const recoveredRoot = await workspace(t); await createStateSession(recoveredRoot, api);
  const recovered = await readPredictionLedger({ directory: join(recoveredRoot, 'reports/forecast-ledger') });
  assert.deepEqual(recovered, frozen);
  const finalRoot = await workspace(t), finalClock = () => at(2 * 86400000);
  const second = await runHosted({ root: finalRoot, ...common, clock: finalClock, fetchImpl: source(finalClock, true) });
  assert.equal(second.status, 'partial'); assert.equal(second.forecastPublished, false);
  assert.deepEqual(second.outcomes.map(row => [row.lane, row.status]), [['results', 'complete'], ['fixtures', 'blocked']]);
  assert.equal(second.outcomes[1].code, 'NO_GENERATED_REPORT', 'No remaining future fixtures must not conceal successful settlement');
  const result = JSON.parse(await readFile(join(finalRoot, 'reports/prospective-evaluation.json'), 'utf8'));
  assert.equal(result.scope, 'private-research-freezes'); assert.equal(result.forecastPublished, false);
  assert.equal(result.releaseGate, 'BLOCKED'); assert.equal(result.summary.recordedScores, 1);
  const group = result.groups.find(row => row.source === 'openligadb' && row.league === 'BL1' && row.horizonHours === 24);
  assert.equal(group.evaluations.length, 1);
  const finalLedger = await readPredictionLedger({ directory: join(finalRoot, 'reports/forecast-ledger') });
  assert.deepEqual(finalLedger.events.flatMap(event => event.predictions), predictions, 'Existing frozen predictions remain byte-for-byte equivalent');
  await assert.rejects(requireGreenForecastDelivery(join(finalRoot, 'reports')), /RELEASE_GATE_BLOCKED/);
});

test('due results run before repeatedly failing private fixtures across restored runners', async t => {
  const api = backend(), calls = []; let now = 0;
  const fake = async (args, options) => {
    const lane = args[1]; calls.push(lane); assert.ok(args.includes('private-research'));
    await assert.rejects(options.dependencies.publishAll(), /HOSTED_PRIVATE_RESEARCH_DELIVERY_FORBIDDEN/);
    return lane === 'fixtures' ? { status: 'failed', code: 'NO_GENERATED_REPORT', exitCode: 1 } : { status: 'complete', exitCode: 0 };
  };
  const common = { env: { GITHUB_SHA: 'a'.repeat(40) }, client: api, privateResearch: true,
    stdout: () => {}, clock: () => at(now), runOrchestrationImpl: fake };
  assert.equal((await runHosted({ root: await workspace(t), ...common })).status, 'partial');
  now = 300000; await runHosted({ root: await workspace(t), ...common });
  now = 3600000; await runHosted({ root: await workspace(t), ...common });
  assert.deepEqual(calls, ['results', 'fixtures', 'fixtures', 'results', 'fixtures']);
});

test('private mode is explicit and cannot be enabled through a truthy string', async t => {
  await assert.rejects(runHosted({ root: await workspace(t), env: { GITHUB_SHA: 'a'.repeat(40) }, privateResearch: 'true', client: backend() }), /HOSTED_INVALID_ARGUMENT/);
});

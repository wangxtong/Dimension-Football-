import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { demoInput } from '../demo.mjs';
import { DEFAULT_POLICY, fixtureKey } from '../policy.mjs';
import { runCollection, safeDiagnostics, safeMarketDiagnostics } from '../pipeline.mjs';
import { atomicJson, readState, acquireLock } from '../storage.mjs';

const NOW = '2026-10-29T08:00:00.000Z';

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dimension-football-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, statePath: join(directory, 'state.json'), outDir: join(directory, 'reports') };
}

function syntheticInput(count = 1) {
  const demo = demoInput(NOW);
  const fixtures = demo.fixtures.slice(0, count).map((fixture, index) => ({ ...fixture, id: `fd-${index + 1}`, source: 'football-data' }));
  const quotes = [], signals = [];
  for (const fixture of fixtures) {
    const fixtureSnapshot = Object.fromEntries(['id', 'league', 'home', 'away', 'kickoff', 'source'].map(key => [key, fixture[key]]));
    quotes.push(...structuredClone(demo.evidence.quotes).map(row => ({ ...row, fixtureId: fixture.id, fixtureSnapshot,
      ...(row.opening ? { opening: { ...row.opening, fixtureId: fixture.id, fixtureSnapshot } } : {}) })));
    signals.push(...structuredClone(demo.evidence.signals).map(row => ({ ...row, fixtureId: fixture.id, fixtureSnapshot })));
  }
  return { fixtures, evidence: { quotes, signals, diagnostics: [] } };
}

function invocation(paths, input, extra = {}) {
  return { ...paths, fixtures: input.fixtures, collectEvidence: async () => structuredClone(input.evidence),
    clock: () => NOW, monotonic: () => 0, ...extra };
}

test('exhausted budget persists every fixture as pending and the next run resumes it', async t => {
  const paths = await workspace(t), input = syntheticInput(3);
  let tick = 0;
  const first = await runCollection(invocation(paths, input, {
    policy: { ...DEFAULT_POLICY, budgetMs: 100 }, monotonic: () => tick,
    collectEvidence: async () => { tick = 100; return structuredClone(input.evidence); },
  }));
  assert.equal(first.report.status, 'partial');
  assert.equal(first.report.summary.pending, 3);
  assert.equal(first.report.summary.processed, 0);
  const saved = await readState(paths.statePath, false);
  assert.equal(saved.currentPool.length, 3);
  assert.ok(Object.values(saved.entries).every(entry => entry.result.reasons.includes('BUDGET_EXHAUSTED')));
  const second = await runCollection(invocation(paths, input, { policy: { ...DEFAULT_POLICY, budgetMs: 100 } }));
  assert.equal(second.report.summary.pending, 0);
  assert.equal(second.report.summary.processed, 3);
  assert.equal(second.report.summary.candidates, 3);
});

test('an unchanged evidence checkpoint is reused on the next run', async t => {
  const paths = await workspace(t), input = syntheticInput();
  await runCollection(invocation(paths, input));
  const resumed = await runCollection(invocation(paths, input));
  assert.equal(resumed.report.summary.reused, 1);
  assert.equal(resumed.report.summary.processed, 0);
  assert.equal(resumed.report.summary.candidates, 1);
  assert.equal((await readState(paths.statePath, false)).runs.length, 2);
});

test('true openings are checkpointed and reused only alongside fresh quotes of the same fixture', async t => {
  const paths = await workspace(t), input = syntheticInput();
  await runCollection(invocation(paths, input));
  const next = { ...input, evidence: { ...input.evidence, quotes: input.evidence.quotes.map(q => ({ ...q, opening: undefined })) } };
  const result = await runCollection(invocation(paths, next));
  assert.equal(result.report.summary.candidates, 1);
  assert.equal(result.report.results[0].openingRecords.length, 2);
  assert.equal(result.report.results[0].marketReadiness.verifiedOpeningCount, 2);
  assert.ok(result.report.results[0].lastEvidence.quotes.some(q => q.opening?.basis === 'provider-opening'));
  const missing = await runCollection(invocation(paths, { ...input, evidence: { quotes: [], signals: [], diagnostics: [] } }));
  assert.equal(missing.report.summary.candidates, 0);
  assert.equal(missing.report.results[0].marketReadiness.pairedQuoteCount, 0);
});

test('refreshing fixture updatedAt does not starve previously pending fixtures on a small budget', async t => {
  const paths = await workspace(t), input = syntheticInput(3);
  const policy = { ...DEFAULT_POLICY, budgetMs: 100 };
  async function oneFixtureRun(nowISO) {
    let tick = 0;
    const refreshed = { ...input, fixtures: input.fixtures.map(fixture => ({ ...fixture, updatedAt: nowISO })) };
    return runCollection(invocation(paths, refreshed, { policy, monotonic: () => tick, clock: () => nowISO,
      checkpoint: async (path, state) => {
        await atomicJson(path, state);
        if (Object.values(state.entries).some(entry => entry.checkedAt === nowISO)) tick = 100;
      },
    }));
  }
  const first = await oneFixtureRun(NOW);
  assert.equal(first.report.summary.processed, 1);
  assert.equal(first.report.summary.pending, 2);
  const next = new Date(Date.parse(NOW) + 1000).toISOString();
  const second = await oneFixtureRun(next);
  assert.equal(second.report.summary.processed, 1);
  const rows = new Map(second.report.results.map(row => [row.fixture.id, row]));
  assert.equal(rows.get('fd-1').checkedAt, NOW);
  assert.equal(rows.get('fd-2').checkedAt, next);
});

test('a candidate that expires before report completion is removed from the published report', async t => {
  const paths = await workspace(t), input = syntheticInput();
  let now = NOW, hadCandidateCheckpoint = false;
  const expired = new Date(Date.parse(NOW) + 300_001).toISOString();
  const result = await runCollection(invocation(paths, input, {
    clock: () => now,
    checkpoint: async (path, state) => {
      hadCandidateCheckpoint ||= Object.values(state.entries).some(entry => entry.result.status === 'candidate');
      await atomicJson(path, state);
      if (hadCandidateCheckpoint) now = expired;
    },
  }));
  assert.equal(hadCandidateCheckpoint, true);
  assert.equal(result.report.summary.candidates, 0);
  assert.deepEqual(result.report.candidates, []);
  assert.equal(result.report.results[0].result.status, 'source_insufficient');
  assert.equal(JSON.parse(await readFile(join(paths.outDir, 'latest.json'), 'utf8')).summary.candidates, 0);
});

test('an interrupted checkpoint does not discard earlier persisted progress and releases its lock', async t => {
  const paths = await workspace(t), input = syntheticInput(3);
  let checkpoints = 0;
  await assert.rejects(runCollection(invocation(paths, input, {
    checkpoint: async (path, state) => {
      if (++checkpoints === 3) throw new Error('simulated disk interruption');
      await atomicJson(path, state);
    },
  })), /simulated disk interruption/);
  const persisted = await readState(paths.statePath, false);
  assert.equal(persisted.entries[fixtureKey(input.fixtures[0])].result.status, 'candidate');
  assert.equal(persisted.entries[fixtureKey(input.fixtures[1])].result.status, 'pending');
  assert.ok(!(await readdir(paths.directory)).some(name => name.endsWith('.lock')));
  const resumed = await runCollection(invocation(paths, input));
  assert.equal(resumed.report.summary.reused, 1);
  assert.equal(resumed.report.summary.processed, 2);
  assert.equal(resumed.report.summary.candidates, 3);
});

test('source exceptions are explicit failures and never expose thrown credentials', async t => {
  const paths = await workspace(t), input = syntheticInput();
  const secret = 'api-secret-do-not-persist';
  const result = await runCollection(invocation(paths, input, {
    collectEvidence: async () => { throw new Error(`Bearer ${secret} https://private.example/?token=${secret}`); },
  }));
  assert.equal(result.report.status, 'failed');
  assert.equal(result.report.summary.candidates, 0);
  assert.equal(result.report.diagnostics[0].code, 'SOURCE_COLLECTION_FAILED');
  for (const file of [paths.statePath, result.files.jsonPath, result.files.briefPath, result.files.messagePath]) {
    assert.ok(!(await readFile(file, 'utf8')).includes(secret));
  }
});

test('valid observations are retained for source-insufficient fixtures without persisting raw source bodies', async t => {
  const paths = await workspace(t), input = syntheticInput();
  const secret = 'raw-source-secret-never-store';
  input.evidence.quotes = input.evidence.quotes.filter(row => row.sourceId === 'titan007')
    .map(row => ({ ...row, opening: undefined, rawBody: secret, authorization: secret }));
  input.evidence.signals = input.evidence.signals.map(row => ({ ...row, headers: { authorization: secret }, rawBody: secret }));
  input.evidence.quotes.push({ ...input.evidence.quotes[0], bookmaker: secret, validUntil: NOW });
  input.evidence.signals.push({ ...input.evidence.signals[0], evidenceUrl: `https://www.statarea.com/?token=${secret}` });
  const result = await runCollection(invocation(paths, input));
  assert.equal(result.report.results[0].result.status, 'source_insufficient');
  const saved = await readState(paths.statePath, false);
  const observations = saved.entries[fixtureKey(input.fixtures[0])].lastEvidence;
  assert.equal(observations.quotes.length, 2);
  assert.equal(observations.signals.length, 1);
  assert.equal(observations.observedAt, NOW);
  assert.equal(observations.signals[0].probability, .6);
  assert.equal(JSON.stringify(saved).includes(secret), false);
  assert.equal(JSON.stringify(result.report).includes(secret), false);
});

test('budget-pending fixtures keep their last observations while a completed failed refresh records no new evidence', async t => {
  const paths = await workspace(t), input = syntheticInput();
  await runCollection(invocation(paths, input));
  const key = fixtureKey(input.fixtures[0]);
  const previous = (await readState(paths.statePath, false)).entries[key].lastEvidence;
  const controller = new AbortController();
  controller.abort();
  await runCollection(invocation(paths, input, { signal: controller.signal }));
  const pending = (await readState(paths.statePath, false)).entries[key];
  assert.equal(pending.result.status, 'pending');
  assert.deepEqual(pending.lastEvidence, previous);
  const failed = await runCollection(invocation(paths, input, {
    collectEvidence: async () => { throw new Error('network unavailable'); },
  }));
  assert.equal(failed.report.status, 'failed');
  const refreshed = (await readState(paths.statePath, false)).entries[key];
  assert.equal(refreshed.result.status, 'source_insufficient');
  assert.deepEqual(refreshed.lastEvidence.quotes, []);
  assert.deepEqual(refreshed.lastEvidence.signals, []);
});

test('a cancelled run writes a resumable pending checkpoint without starting collection', async t => {
  const paths = await workspace(t), input = syntheticInput();
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const result = await runCollection(invocation(paths, input, { signal: controller.signal,
    collectEvidence: async () => { calls++; return structuredClone(input.evidence); },
  }));
  assert.equal(calls, 0);
  assert.equal(result.report.status, 'partial');
  assert.equal(result.report.summary.pending, 1);
  assert.equal(result.report.summary.processed, 0);
  assert.equal(Object.values((await readState(paths.statePath, false)).entries)[0].result.status, 'pending');
});

test('diagnostics discard bodies, headers, URL tokens and unstructured provider error messages', () => {
  const secret = 'top-secret-do-not-persist';
  const result = safeDiagnostics([{ id: 'provider', status: 'failed',
    code: `request failed: https://private.example/?token=${secret}`, checkedAt: NOW,
    headers: { authorization: secret }, body: secret, error: secret, matchedCount: 0 }]);
  assert.equal(result[0].code, 'SOURCE_STATUS_UNKNOWN');
  assert.equal(JSON.stringify(result).includes(secret), false);
  for (const key of ['headers', 'body', 'error']) assert.equal(Object.hasOwn(result[0], key), false);
});

test('per-fixture market diagnostics survive checkpoints and reports without changing evidence gates', async t => {
  const paths = await workspace(t), input = syntheticInput();
  input.evidence.quotes = [];
  input.evidence.fixtureDiagnostics = [{ fixtureId: 'fd-1', id: 'm88', status: 'pending', code: 'fixture_identity_unmatched',
    checkedAt: NOW, httpStatus: 200, scheduleCandidateCount: 0, marketRowCount: 0, matchedCount: 0,
    sourceUpdatedAt: NOW, scheduleUpdatedAt: NOW, body: 'private-body-do-not-store', headers: { authorization: 'private-token' } }];
  input.evidence.diagnostics = [{ id: 'm88', status: 'available', code: 'matched_1', checkedAt: NOW,
    parsedCount: 37, matchedCount: 1, scheduleParsedCount: 120, requestedFixtureCount: 1,
    sourceUpdatedAt: NOW, scheduleCoverageFrom: NOW, scheduleCoverageTo: '2026-10-30T20:00:00.000Z' }];
  const result = await runCollection(invocation(paths, input));
  assert.equal(result.report.summary.candidates, 0);
  assert.deepEqual(result.report.results[0].result.reasons, ['NO_FRESH_COMPLETE_ASIAN_MARKET']);
  assert.equal(result.report.results[0].marketDiagnostics[0].code, 'fixture_identity_unmatched');
  assert.equal(result.report.marketDiagnostics[0].bookmaker, 'M88');
  assert.equal(result.report.diagnostics[0].parsedCount, 37);
  assert.equal(result.report.diagnostics[0].scheduleCoverageTo, '2026-10-30T20:00:00.000Z');
  const state = await readState(paths.statePath, false);
  assert.deepEqual(state.entries[fixtureKey(input.fixtures[0])].marketDiagnostics, result.report.marketDiagnostics);
  assert.match(await readFile(result.files.messagePath, 'utf8'), /赛程身份未匹配/);
  assert.equal(JSON.stringify(result.report).includes('private-'), false);
});

test('market diagnostics whitelist known codes and companies and reject unrelated fixture ids', () => {
  const { fixtures } = syntheticInput();
  const rows = safeMarketDiagnostics([
    { fixtureId: 'fd-1', id: 'm88', status: 'pending', code: 'secret_value', bookmaker: 'secret_value', companyId: 999,
      scheduleCandidateCount: -1, marketRowCount: 'secret_value', rawBody: 'secret_value' },
    { fixtureId: 'not-in-pool', id: 'm88', code: 'matched' },
    { fixtureId: 'fd-1', id: 'unknown', code: 'matched' },
  ], fixtures);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].code, 'SOURCE_STATUS_UNKNOWN');
  assert.equal(rows[0].bookmaker, 'M88');
  assert.equal(rows[0].companyId, 17);
  assert.equal(Object.hasOwn(rows[0], 'scheduleCandidateCount'), false);
  assert.equal(Object.hasOwn(rows[0], 'marketRowCount'), false);
  assert.equal(JSON.stringify(rows).includes('secret_value'), false);
});

test('Macau per-fixture diagnostics retain their own source without trusting provider-supplied identity or secrets', async t => {
  const paths = await workspace(t), input = syntheticInput();
  input.evidence.quotes = [];
  input.evidence.fixtureDiagnostics = [{ fixtureId: 'fd-1', id: 'macauslot', sourceId: 'hkjc', bookmaker: 'HKJC',
    companyId: 17, status: 'pending', code: 'incomplete_market', checkedAt: NOW, httpStatus: 200, matchedCount: 0,
    sourceUpdatedAt: NOW, body: 'private-response', headers: { authorization: 'private-response' } }];
  const result = await runCollection(invocation(paths, input));
  const diagnostic = result.report.marketDiagnostics[0];
  assert.equal(diagnostic.sourceId, 'macauslot'); assert.equal(diagnostic.bookmaker, 'Macau SLOT');
  assert.equal(diagnostic.companyId, null); assert.equal(diagnostic.code, 'incomplete_market');
  assert.equal(diagnostic.sourceUpdatedAt, NOW); assert.equal(result.report.summary.candidates, 0);
  const saved = await readState(paths.statePath, false);
  assert.deepEqual(saved.entries[fixtureKey(input.fixtures[0])].marketDiagnostics, result.report.marketDiagnostics);
  assert.ok(!JSON.stringify(result.report).includes('private-response'));
});

test('demo state cannot be reused for production, including with an explicit shared state path', async t => {
  const paths = await workspace(t), input = syntheticInput();
  const demo = await runCollection(invocation(paths, input, { simulated: true }));
  assert.equal(demo.report.summary.candidates, 0);
  assert.equal(demo.report.summary.simulatedCandidates, 1);
  await assert.rejects(runCollection(invocation(paths, input)), { message: 'STATE_INVALID_OR_MODE_MISMATCH' });
  assert.equal((await readState(paths.statePath, true)).simulated, true);
});

test('production refuses example fixtures before collecting evidence', async t => {
  const paths = await workspace(t), demo = demoInput(NOW);
  let calls = 0;
  await assert.rejects(runCollection({ ...paths, fixtures: demo.fixtures, clock: () => NOW,
    collectEvidence: async () => { calls++; return demo.evidence; } }), { message: 'EXAMPLE_FIXTURES_REQUIRE_DEMO' });
  assert.equal(calls, 0);
});

test('adapter negative market states override older imported prices in the pipeline', async t => {
  const paths = await workspace(t), input = syntheticInput();
  const previous = input.evidence.quotes.map(row => ({ ...row, observedAt: new Date(Date.parse(NOW) - 60000).toISOString(),
    sourceUpdatedAt: new Date(Date.parse(NOW) - 60000).toISOString() }));
  const marketStates = input.evidence.quotes.filter(row => row.selection === 'home').map(row => ({ ...row,
    selection: undefined, handicap: undefined, decimalOdds: undefined, opening: undefined,
    marketState: 'unavailable', stateReason: 'incomplete_market' }));
  const result = await runCollection(invocation(paths, input, { importedEvidence: { quotes: previous, signals: [] },
    collectEvidence: async () => ({ quotes: [], signals: input.evidence.signals, diagnostics: [], marketStates }) }));
  assert.equal(result.report.summary.candidates, 0);
  assert.ok(result.report.results[0].marketReadiness.blockers.includes('LATEST_MARKET_UNAVAILABLE'));
});

test('logical fixture conflicts are quarantined with diagnostics instead of counting duplicate matches', async t => {
  const paths = await workspace(t), input = syntheticInput();
  const row = { ...input.fixtures[0], sourceFixtureId: '1', homeTeamId: '10', awayTeamId: '20' };
  const result = await runCollection({ ...paths, fixtures: [row, { ...row, id: 'fd-2', sourceFixtureId: '2' }], clock: () => NOW,
    collectEvidence: () => assert.fail('ambiguous pool must not collect evidence') });
  assert.equal(result.report.summary.total, 0); assert.equal(result.report.poolComplete, false);
  assert.equal(result.report.diagnostics.find(row => row.code === 'logical_fixture_conflict').rejectedCount, 2);
  assert.equal(result.report.identityConflicts[0].ids.length, 2);
});

test('state lock prevents overlapping collectors and release allows another run', async t => {
  const paths = await workspace(t);
  const release = await acquireLock(paths.statePath);
  try { await assert.rejects(acquireLock(paths.statePath), { message: 'COLLECTION_ALREADY_LOCKED' }); }
  finally { await release(); }
  const releaseAgain = await acquireLock(paths.statePath);
  await releaseAgain();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createReplayBundle, verifyReplayBundle, replayForecasts } from '../data/run-manifest.mjs';
import { buildForecasts, FORECAST_MODEL } from '../forecast.mjs';
import { DEFAULT_POLICY } from '../policy.mjs';

const NOW = '2026-10-31T04:00:00.000Z';
const options = () => ({ reportId: 'a'.repeat(64), generatedAt: NOW, cutoff: NOW, codeVersion: 'b'.repeat(40),
  fixtures: [{ id: 'oldb-7', sourceFixtureId: '7', source: 'openligadb', league: 'BL1', home: 'Home', away: 'Away',
    homeTeamId: '1', awayTeamId: '2', kickoff: '2026-11-01T14:30:00Z', status: 'SCHEDULED', updatedAt: NOW }],
  history: [], policy: DEFAULT_POLICY, model: FORECAST_MODEL });

test('replay manifest binds report, exact inputs, code, model, policy and cutoff without network', () => {
  const bundle = createReplayBundle(options());
  assert.equal(bundle.manifest.replayStatus, 'version-bound');
  assert.equal(bundle.inputs.reportId, bundle.manifest.reportId);
  assert.deepEqual(verifyReplayBundle(bundle, { reportId: options().reportId, codeVersion: options().codeVersion }), bundle);
  const replayed = replayForecasts(bundle, { buildForecasts, codeVersion: options().codeVersion });
  const direct = buildForecasts({ ...bundle.inputs, nowISO: NOW });
  assert.deepEqual(replayed, direct);
  assert.equal(replayed.summary.forecasts, 0);
  assert.throws(() => verifyReplayBundle(bundle, { reportId: 'c'.repeat(64) }), /RUN_REPORT_ID_MISMATCH/);
  assert.throws(() => verifyReplayBundle(bundle, { codeVersion: 'c'.repeat(40) }), /RUN_CODE_VERSION_MISMATCH/);
  assert.throws(() => replayForecasts(bundle, { buildForecasts }), /REPLAY_CODE_VERSION_REQUIRED/);
});

test('a versioned snapshot replays an actual forecast and training hash after original inputs change', () => {
  const input = options(), history = [];
  for (let round = 0; round < 12; round++) for (let home = 1; home <= 4; home++) for (let away = 1; away <= 4; away++) {
    if (home === away) continue;
    history.push({ id: `history-${history.length}`, source: 'openligadb', league: 'BL1', home: `Club ${home}`, away: `Club ${away}`,
      homeTeamId: String(home), awayTeamId: String(away), kickoff: new Date(Date.parse(NOW) + (-150 + history.length) * 86400000).toISOString(),
      homeGoals: (round + home) % 4, awayGoals: (round + away) % 3, status: 'FINISHED', period: 'full-time' });
  }
  const bundle = createReplayBundle({ ...input, history });
  const direct = buildForecasts({ ...bundle.inputs, nowISO: NOW });
  history[0].homeGoals = 20;
  const replayed = replayForecasts(bundle, { buildForecasts, codeVersion: input.codeVersion });
  assert.equal(replayed.rows[0].status, 'forecast');
  assert.equal(replayed.rows[0].trainingHash, direct.rows[0].trainingHash);
  assert.deepEqual(replayed.rows[0].probabilities, direct.rows[0].probabilities);
  assert.equal(bundle.manifest.visibility, 'snapshot-only');
});

test('input and metadata tampering are rejected; unknown code cannot silently claim exact replay', () => {
  const bundle = createReplayBundle(options()), tampered = structuredClone(bundle);
  tampered.inputs.fixtures[0].kickoff = '2026-11-02T14:30:00.000Z';
  assert.throws(() => verifyReplayBundle(tampered), /RUN_INPUT_HASH_MISMATCH/);
  const wrongCutoff = structuredClone(bundle); wrongCutoff.manifest.cutoff = '2026-10-30T04:00:00.000Z';
  assert.throws(() => verifyReplayBundle(wrongCutoff), /RUN_INPUT_HASH_MISMATCH/);
  const unknown = createReplayBundle({ ...options(), codeVersion: null });
  assert.throws(() => replayForecasts(unknown, { buildForecasts }), /REPLAY_CODE_VERSION_REQUIRED/);
  assert.equal(unknown.manifest.replayStatus, 'inputs-only-code-version-unknown');
});

test('replay inputs strip arbitrary raw fields and cannot store credential configuration', () => {
  const input = options(); input.fixtures[0].authorization = 'discard-me';
  assert.ok(!JSON.stringify(createReplayBundle(input)).includes('discard-me'));
  assert.throws(() => createReplayBundle({ ...options(), policy: { ...DEFAULT_POLICY, apiKey: 'discard-me' } }), /INVALID_REPLAY_POLICY/);
});

test('A3 fail-closed replay rejects fixtures first acquired or changed after the cutoff', () => {
  const later = '2026-10-31T05:00:00.000Z';
  for (const field of ['updatedAt', 'fetchedAt', 'observedAt', 'sourceUpdatedAt']) {
    const input = options(); input.fixtures[0][field] = later;
    const bundle = createReplayBundle(input);
    // A stored archive may be intact while its as-of-cutoff claim is false.
    assert.doesNotThrow(() => verifyReplayBundle(bundle));
    assert.throws(() => replayForecasts(bundle, { buildForecasts, codeVersion: input.codeVersion }),
      { message: 'REPLAY_INPUT_AFTER_CUTOFF' }, field);
  }
});

test('A3 fail-closed replay rejects result evidence acquired after the cutoff without rejecting known-at-cutoff data', () => {
  const baseHistory = { id: 'oldb-history-9', sourceFixtureId: '9', source: 'openligadb', league: 'BL1',
    home: 'Club 1', away: 'Club 2', homeTeamId: '1', awayTeamId: '2', kickoff: '2026-05-01T14:30:00Z',
    status: 'FINISHED', period: 'full-time', homeGoals: 2, awayGoals: 1 };
  const later = '2026-10-31T05:00:00.000Z';
  for (const field of ['observedAt', 'resultObservedAt', 'fetchedAt', 'sourceUpdatedAt']) {
    const input = { ...options(), history: [{ ...baseHistory, [field]: later }] };
    const bundle = createReplayBundle(input);
    assert.throws(() => replayForecasts(bundle, { buildForecasts, codeVersion: input.codeVersion }),
      { message: 'REPLAY_INPUT_AFTER_CUTOFF' }, field);
  }
  const input = { ...options(), history: [{ ...baseHistory, observedAt: NOW,
    resultObservedAt: NOW, fetchedAt: NOW, sourceUpdatedAt: NOW }] };
  assert.doesNotThrow(() => replayForecasts(createReplayBundle(input), {
    buildForecasts, codeVersion: input.codeVersion }));
});

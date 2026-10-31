import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withHistoryCache, normalizeHistoryRecord } from '../data/history-cache.mjs';

const NOW = '2026-10-31T04:00:00.000Z', LATER = '2026-10-31T05:00:00.000Z';
const identity = { source: 'openligadb', league: 'BL1', season: '2025' };
const row = () => ({ ...identity, id: 'oldb-7', sourceFixtureId: '7', home: 'Home', away: 'Away', homeTeamId: '1', awayTeamId: '2',
  kickoff: '2026-05-01T14:30:00Z', status: 'FINISHED', period: 'full-time', homeGoals: 2, awayGoals: 1 });
async function workspace(t) { const path = await mkdtemp(join(tmpdir(), 'history-cache-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }

test('history normalization keeps unknown observation time unknown and rejects false identity metadata', () => {
  const normalized = normalizeHistoryRecord({ ...row(), season: 2025, secretHeader: 'must-not-retain' });
  assert.equal(normalized.season, '2025');
  assert.equal(normalized.observedAt, undefined);
  assert.ok(!JSON.stringify(normalized).includes('must-not-retain'));
  assert.throws(() => normalizeHistoryRecord({ ...normalized, homeGoals: 3 }), /HISTORY_IDENTITY_MISMATCH/);
  assert.throws(() => normalizeHistoryRecord({ ...row(), observedAt: LATER, fetchedAt: NOW }), /INVALID_HISTORY_PROVENANCE/);
});

test('history cache survives restart without renewing first observation and makes corrections new versions', async t => {
  const statePath = join(await workspace(t), 'history.json');
  const first = await withHistoryCache({ statePath }, cache => cache.put(identity, [row()], { fetchedAt: NOW, receivedCount: 1 }));
  const again = await withHistoryCache({ statePath }, async cache => {
    const cached = cache.get(identity, { nowISO: LATER, maxAgeMs: 86400000 });
    assert.equal(cached.fetchedAt, NOW); assert.equal(cached.records[0].observedAt, NOW);
    assert.equal(cache.get(identity, { nowISO: LATER, maxAgeMs: 1000 }), null);
    return cache.put(identity, [row()], { fetchedAt: LATER, receivedCount: 1 });
  });
  assert.equal(again.records[0].observedAt, NOW); assert.equal(again.records[0].resultObservedAt, NOW);
  assert.equal(again.records[0].fetchedAt, LATER); assert.equal(again.records[0].revisionId, first.records[0].revisionId);
  const corrected = await withHistoryCache({ statePath }, cache => cache.put(identity, [{ ...row(), homeGoals: 3 }], { fetchedAt: LATER, receivedCount: 1 }));
  assert.equal(corrected.records[0].resultObservedAt, LATER);
  assert.notEqual(corrected.records[0].revisionId, first.records[0].revisionId);
  assert.equal(first.records[0].homeGoals, 2);
});

test('damaged cache is refused and cannot reset retained provenance silently', async t => {
  const statePath = join(await workspace(t), 'history.json');
  await withHistoryCache({ statePath }, cache => cache.put(identity, [row()], { fetchedAt: NOW, receivedCount: 1 }));
  const stored = JSON.parse(await readFile(statePath, 'utf8'));
  Object.values(stored.entries)[0].records[0].homeGoals = 9;
  await writeFile(statePath, JSON.stringify(stored));
  await assert.rejects(withHistoryCache({ statePath }, () => assert.fail('must not use corrupt cache')));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateBundle } from '../report-schema.mjs';
import { handleHostedRequest, loadHostedBundle, updateHostedReceipt } from '../hosted-publications.mjs';
import { NOW, ORIGIN, sampleBundle } from './fixtures.mjs';
import { MemoryBucket, fakeKeys, machineRequest } from './hosted-fixtures.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const otherHash = value => value.slice(0, -1) + (value.endsWith('a') ? 'b' : 'a');

test('website JSON contract refuses contradictory per-channel report identities and digests', () => {
  const valid = sampleBundle();
  valid.reportHash = digest(valid.report);
  valid.receipt.channels.externalWebsite = {
    status: 'published', servedVerified: true, reportId: valid.reportId, reportHash: valid.reportHash,
  };
  assert.equal(validateBundle(valid), valid);

  const wrongId = structuredClone(valid);
  wrongId.receipt.channels.externalWebsite.reportId = 'b'.repeat(64);
  assert.throws(() => validateBundle(wrongId), /RECEIPT_SCHEMA_INVALID/);

  const wrongHash = structuredClone(valid);
  wrongHash.receipt.channels.externalWebsite.reportHash = otherHash(valid.reportHash);
  assert.throws(() => validateBundle(wrongHash), /RECEIPT_SCHEMA_INVALID/);

  const malformedHash = structuredClone(valid);
  malformedHash.receipt.channels.externalWebsite.reportHash = 'not-a-sha256';
  assert.throws(() => validateBundle(malformedHash), /RECEIPT_SCHEMA_INVALID/);

  const malformedBundle = structuredClone(valid);
  malformedBundle.reportHash = 'not-a-sha256';
  assert.throws(() => validateBundle(malformedBundle), /SNAPSHOT_SCHEMA_INVALID/);
});

test('hosted receipt write rejects a false website readback without poisoning last verified report', async () => {
  const env = { DASHBOARD_ORIGIN: ORIGIN, BUCKET: new MemoryBucket() };
  const { fetchImpl } = fakeKeys();
  const incoming = sampleBundle();
  const result = await handleHostedRequest(machineRequest('/internal/observations', {
    method: 'POST', body: incoming,
  }), env, { fetchImpl, now: NOW });
  assert.equal(result.status, 200, await result.clone().text());
  const current = await loadHostedBundle(env, { now: NOW });
  assert.equal(current.publicationKind, 'observations');

  for (const changes of [
    { reportId: incoming.reportId },
    { reportHash: otherHash(current.reportHash) },
  ]) {
    const falseReceipt = structuredClone(current.receipt);
    falseReceipt.channels.externalWebsite = {
      status: 'published', servedVerified: true, checkedAt: new Date(NOW).toISOString(),
      reportId: current.reportId, reportHash: current.reportHash, ...changes,
    };
    await assert.rejects(updateHostedReceipt(env, falseReceipt), /RECEIPT_SCHEMA_INVALID/);
    const unchanged = await loadHostedBundle(env, { now: NOW });
    assert.equal(unchanged.receipt.channels.externalWebsite.status, 'not_attempted');
    assert.equal(unchanged.reportId, current.reportId);
    assert.equal(unchanged.reportHash, current.reportHash);
  }
});

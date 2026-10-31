import test from 'node:test';
import assert from 'node:assert/strict';
import { demoInput } from '../demo.mjs';
import { digest, fixtureKey, safeOpening, evaluateFixture, validQuote } from '../policy.mjs';
import { reconcileMarketEvidence, marketReadiness } from '../market-evidence.mjs';

const NOW = '2026-10-31T08:00:00.000Z';
const at = offset => new Date(Date.parse(NOW) + offset).toISOString();
const setup = () => { const d = demoInput(NOW); return { fixture: d.fixtures[0], ...d.evidence }; };

test('a provider update after quote capture cannot seed an opening archive for a later clean snapshot', () => {
  const { fixture, quotes, signals } = setup();
  const impossible = quotes.map(q => ({ ...q, observedAt: at(-60_000) }));
  assert.ok(impossible.every(q => !validQuote(q, fixture, Date.parse(NOW))));
  const first = reconcileMarketEvidence(fixture, impossible, [], NOW);
  assert.equal(first.records.length, 0);
  assert.notEqual(evaluateFixture(fixture, { quotes: first.quotes, signals }, NOW).status, 'candidate');

  const clean = quotes.map(q => ({ ...q, opening: undefined }));
  const second = reconcileMarketEvidence(fixture, clean, JSON.parse(JSON.stringify(first.records)), NOW);
  assert.equal(second.records.length, 0);
  assert.ok(second.quotes.every(q => !q.opening));
  assert.equal(evaluateFixture(fixture, { quotes: second.quotes, signals }, NOW).status, 'source_insufficient');
  assert.ok(marketReadiness(fixture, second.quotes, NOW).blockers.includes('TRUE_OPENING_RECORD_MISSING'));
});

test('capture causality has no invented clock-skew allowance even when the update precedes evaluation', async t => {
  for (const offset of [-1, 0, 1, 1000, 30000]) await t.test(`update minus capture: ${offset} ms`, () => {
    const { fixture, quotes } = setup(), quote = { ...quotes[0], sourceUpdatedAt: at(offset) };
    assert.equal(validQuote(quote, fixture, Date.parse(at(60_000))), offset <= 0);
  });
  const { fixture, quotes } = setup();
  assert.equal(validQuote({ ...quotes[0], sourceUpdatedAt: '2026-10-31T09:00:00+01:00' }, fixture, Date.parse(NOW)), true);
});

test('an opening obtained later is usable only after its recorded time, without rewriting an earlier cutoff', () => {
  const { fixture, quotes, signals } = setup(), obtainedAt = at(60_000);
  const laterOpening = quotes.map(q => ({ ...q, opening: q.opening ? { ...q.opening, recordedAt: obtainedAt } : undefined }));
  const before = reconcileMarketEvidence(fixture, laterOpening, [], NOW);
  assert.equal(before.records.length, 0);
  assert.notEqual(evaluateFixture(fixture, { quotes: before.quotes, signals }, NOW).status, 'candidate');

  // A genuinely declared provider opening may be obtained after a still-fresh
  // quote. Its observation time remains the provider opening time, not capture.
  const obtained = reconcileMarketEvidence(fixture, laterOpening, [], obtainedAt);
  assert.equal(obtained.records.length, 2);
  assert.ok(obtained.records.every(record => record.firstRecordedAt === obtainedAt && record.opening.recordedAt === obtainedAt));
  assert.equal(evaluateFixture(fixture, { quotes: obtained.quotes, signals }, obtainedAt).status, 'candidate');

  const replay = reconcileMarketEvidence(fixture, quotes.map(q => ({ ...q, opening: undefined })), obtained.records, NOW);
  assert.ok(replay.quotes.every(q => !q.opening));
  assert.ok(replay.records.every(record => record.archiveStatus === 'pending_verification'));
  assert.notEqual(evaluateFixture(fixture, { quotes: replay.quotes, signals }, NOW).status, 'candidate');
});

test('newer mismatched direction, company, event or line cannot borrow an old opposite side', async t => {
  const mutations = {
    direction: q => q.selection === 'away' ? { ...q, selection: 'home', handicap: -.25 } : q,
    company: q => q.selection === 'away' ? { ...q, bookmaker: 'Other company' } : q,
    event: q => q.selection === 'away' ? { ...q, providerMatchId: 'other-event' } : q,
    line: q => q.selection === 'away' ? { ...q, handicap: .5 } : q,
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, () => {
    const { fixture, quotes, signals } = setup();
    const older = quotes.map(q => ({ ...q, observedAt: at(-60_000), sourceUpdatedAt: at(-60_000) }));
    const rows = [...older, ...quotes.map(mutate)];
    for (const order of [rows, [...rows].reverse()]) {
      const reconciled = reconcileMarketEvidence(fixture, order, [], NOW);
      assert.notEqual(evaluateFixture(fixture, { quotes: reconciled.quotes, signals }, NOW).status, 'candidate');
      assert.equal(marketReadiness(fixture, reconciled.quotes, NOW).pairedQuoteCount, 0);
    }
  });
});

test('all legacy archives retain their original evidence pending a new capture proof, including previously valid openings', () => {
  const { fixture, quotes, signals } = setup();
  // Version 2 never retained the quote capture timestamps. The same stored
  // shape could come from a valid capture or the formerly accepted bad order.
  const legacy = quotes.filter(q => q.opening).map(q => {
    const opening = safeOpening(q.opening);
    return { version: 2, fixtureKey: fixtureKey(fixture), opening, hash: digest(opening), firstRecordedAt: NOW,
      conflict: false, archiveStatus: 'verified' };
  });
  delete legacy[1].firstRecordedAt;
  const serialized = JSON.stringify(legacy), clean = quotes.map(q => ({ ...q, opening: undefined }));
  let previous = legacy;
  for (let iteration = 0; iteration < 3; iteration++) {
    const replay = reconcileMarketEvidence(fixture, clean, previous, NOW);
    assert.equal(replay.records.length, 2);
    assert.ok(replay.records.every(r => r.version === 2 && r.archiveStatus === 'pending_verification' && !r.conflict
      && !Object.hasOwn(r, 'captureProof') && !Object.hasOwn(r, 'captureProofHash')));
    assert.deepEqual(replay.records.map(r => r.opening), legacy.map(r => r.opening));
    assert.deepEqual(replay.records.map(r => r.hash), legacy.map(r => r.hash));
    assert.deepEqual(replay.records.map(r => r.firstRecordedAt), [NOW, null]);
    assert.ok(replay.quotes.every(q => !q.opening));
    assert.equal(evaluateFixture(fixture, { quotes: replay.quotes, signals }, NOW).status, 'source_insufficient');
    previous = JSON.parse(JSON.stringify(replay.records));
  }
  assert.equal(JSON.stringify(legacy), serialized);
  const reverified = reconcileMarketEvidence(fixture, quotes, previous, NOW);
  assert.equal(reverified.records.filter(r => r.version === 3 && r.archiveStatus === 'verified').length, 2);
  assert.equal(reverified.records.filter(r => r.archiveStatus === 'pending_verification').length, 2);
});

test('capture proof survives safe JSON restoration and cannot expose an opening before first archive availability', () => {
  const { fixture, quotes, signals } = setup(), archivedAt = at(60_000);
  const first = reconcileMarketEvidence(fixture, quotes.map(q => ({ ...q, privateMetadata: 'do-not-retain' })), [], archivedAt);
  assert.ok(first.records.every(r => r.version === 3 && r.captureProofHash === digest(r.captureProof)
    && r.captureProof.openingHash === r.hash && r.captureProof.archivedAt === archivedAt));
  assert.ok(!JSON.stringify(first.records).includes('do-not-retain'));
  const clean = quotes.map(q => ({ ...q, opening: undefined })), saved = JSON.stringify(first.records);
  const early = reconcileMarketEvidence(fixture, clean, JSON.parse(saved), NOW);
  assert.ok(early.records.every(r => r.archiveStatus === 'pending_verification' && !r.conflict));
  assert.ok(early.quotes.every(q => !q.opening));
  const restored = reconcileMarketEvidence(fixture, clean, JSON.parse(JSON.stringify(early.records)), archivedAt);
  assert.deepEqual(restored.records, first.records);
  assert.equal(evaluateFixture(fixture, { quotes: restored.quotes, signals }, archivedAt).status, 'candidate');
  assert.equal(JSON.stringify(first.records), saved);
});

test('capture proof binds opening, provenance and chronological order; integrity failure is sticky', async t => {
  const mutations = {
    wrongArchiveVersion: r => { r.version = 2; },
    wrongProofVersion: r => { r.captureProof.version = 2; r.captureProofHash = digest(r.captureProof); },
    missingProof: r => { delete r.captureProof; delete r.captureProofHash; },
    noProofHash: r => { delete r.captureProofHash; },
    badProofHash: r => { r.captureProofHash = '0'.repeat(64); },
    substitutedOpening: r => { r.opening.decimalOdds = 1.86; r.hash = digest(r.opening); },
    earlierArchive: r => { r.firstRecordedAt = at(-1); },
    futureUpdate: r => { r.captureProof.sourceUpdatedAt = at(1); r.captureProofHash = digest(r.captureProof); },
    laterCapture: r => { r.captureProof.observedAt = at(1); r.captureProofHash = digest(r.captureProof); },
    wrongFixture: r => { r.captureProof.fixtureKey = '0'.repeat(64); r.captureProofHash = digest(r.captureProof); },
    wrongEvent: r => { r.captureProof.providerMatchId = 'other-event'; r.captureProofHash = digest(r.captureProof); },
    wrongDirection: r => { r.captureProof.selection = 'away'; r.captureProofHash = digest(r.captureProof); },
    wrongMarket: r => { r.captureProof.market = 'totals'; r.captureProofHash = digest(r.captureProof); },
    wrongCompany: r => { r.captureProof.bookmaker = 'Other'; r.captureProofHash = digest(r.captureProof); },
    wrongProducer: r => { r.captureProof.provider = 'commercial-reference'; r.captureProofHash = digest(r.captureProof); },
    extraProofField: r => { r.captureProof.unrecognized = 'discard'; r.captureProofHash = digest(r.captureProof); },
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, () => {
    const { fixture, quotes, signals } = setup();
    let previous = JSON.parse(JSON.stringify(reconcileMarketEvidence(fixture, quotes, [], NOW).records));
    previous.forEach(mutate);
    for (let iteration = 0; iteration < 2; iteration++) {
      const replay = reconcileMarketEvidence(fixture, quotes, previous, NOW);
      assert.ok(replay.records.every(r => r.archiveStatus === 'integrity_failure' && r.conflict));
      assert.ok(replay.quotes.every(q => !q.opening));
      assert.equal(evaluateFixture(fixture, { quotes: replay.quotes, signals }, NOW).status, 'source_insufficient');
      previous = JSON.parse(JSON.stringify(replay.records));
    }
  });
});

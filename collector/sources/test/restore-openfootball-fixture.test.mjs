import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { decodeOpenFootballFixture, readOpenFootballFixture, restoreOpenFootballFixture, runRestoreOpenFootballCli } from '../../../scripts/restore-openfootball-fixture.mjs';

const fixturePath = new URL('./fixtures/openfootball-e674442.json.gz', import.meta.url);
const temporary = async t => { const root = await mkdtemp(join(tmpdir(), 'dimension-openfootball-')); t.after(() => rm(root, { recursive: true, force: true })); return root; };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function replaceJSON(row, value) {
  const bytes = Buffer.from(JSON.stringify(value)); Object.assign(row, { content: bytes.toString('base64'), bytes: bytes.length, sha256: sha(bytes) });
}

test('fixed public snapshots restore offline with exact bytes and honest acquisition times', async t => {
  const root = await temporary(t), destination = join(root, 'restored');
  const { fixture, files } = await readOpenFootballFixture(), fetchBefore = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Network forbidden during fixed fixture restoration'); };
  try {
    const result = await restoreOpenFootballFixture(destination);
    assert.equal(result.files, 21); assert.equal(result.releaseGate, 'BLOCKED');
    assert.deepEqual(result.coverage, { received: 3504, retainedResults: 1871, quarantined: 130, modelReady: 0 });
    assert.equal(result.acquiredFrom, '2026-11-01T07:56:05.550Z');
    assert.equal(result.acquiredThrough, '2026-11-01T07:56:06.312Z');
    for (const [name, bytes] of files) assert.deepEqual(await readFile(join(destination, name)), bytes, name);
    const metadata = JSON.parse(await readFile(join(destination, '2025-26/en.1.json.meta.json')));
    assert.equal(metadata.fetchedAt, '2026-11-01T07:56:05.598Z');
    assert.match(await readFile(join(destination, 'LICENSE.md'), 'utf8'), /CC0 1.0 Universal/);
    assert.deepEqual(gzipSync(JSON.stringify(fixture), { level: 9, mtime: 0 }), await readFile(fixturePath));
  } finally { globalThis.fetch = fetchBefore; }
});

test('snapshot decoder rejects traversal, duplicate paths, scripts, corrupt bytes and changed provenance', async () => {
  const compressed = await readFile(fixturePath), original = JSON.parse(gunzipSync(compressed));
  const changes = [
    value => { value.files[0].path = '../outside.json'; },
    value => { value.files[0].path = '/tmp/outside.json'; },
    value => { value.files[0].path = 'run.sh'; },
    value => { value.files[0].path = value.files[1].path; },
    value => { value.files.pop(); },
    value => { value.files[0].sha256 = '0'.repeat(64); },
    value => { value.files[0].content += '!'; },
    value => { value.files[0].bytes += 1; },
    value => { value.sourceCommit = 'master'; },
    value => { value.acquiredFrom = '2026-10-31T00:00:00Z'; },
    value => { const row = value.files.find(row => row.path.endsWith('.meta.json')); replaceJSON(row, { ...JSON.parse(Buffer.from(row.content, 'base64')), fetchedAt: '2026-10-31T00:00:00Z' }); },
    value => { replaceJSON(value.files.find(row => row.path.endsWith('.meta.json')), { token: 'must-not-be-in-fixture' }); },
  ];
  for (const change of changes) {
    const candidate = structuredClone(original); change(candidate);
    assert.throws(() => decodeOpenFootballFixture(gzipSync(JSON.stringify(candidate))), /^Error: OPENFOOTBALL_FIXTURE_INVALID$/);
  }
  assert.throws(() => decodeOpenFootballFixture(compressed.subarray(0, -10)), /OPENFOOTBALL_FIXTURE_INVALID/);
  assert.throws(() => decodeOpenFootballFixture(Buffer.alloc(100_001)), /OPENFOOTBALL_FIXTURE_INVALID/);
  assert.throws(() => decodeOpenFootballFixture(gzipSync(Buffer.alloc(1_200_001, 32))), /OPENFOOTBALL_FIXTURE_INVALID/);
});

test('restoration refuses existing or symlinked destinations and relative paths without overwriting', async t => {
  const root = await temporary(t), existing = join(root, 'existing'), alias = join(root, 'alias');
  await mkdir(existing); await writeFile(join(existing, 'keep.json'), '{"keep":true}'); await symlink(existing, alias);
  for (const target of [existing, alias, join(alias, 'new'), 'relative-snapshot-directory']) await assert.rejects(restoreOpenFootballFixture(target), /OPENFOOTBALL_FIXTURE_/);
  assert.equal(await readFile(join(existing, 'keep.json'), 'utf8'), '{"keep":true}');
  assert.deepEqual(await readdir(existing), ['keep.json']);
  let output = '', error = '';
  assert.equal(await runRestoreOpenFootballCli(['--out', existing], { stdout: text => { output += text; }, stderr: text => { error += text; } }), 1);
  assert.equal(output, ''); assert.equal(error, 'OPENFOOTBALL_FIXTURE_RESTORE_FAILED\n');
});

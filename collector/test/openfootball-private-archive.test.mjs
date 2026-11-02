import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARCHIVE_DIRECTORY, PINNED_OPENFOOTBALL_COMMIT,
  verifyOpenFootballResearchArchive } from '../../scripts/verify-openfootball-research-archive.mjs';

async function isolatedArchive(run) {
  const root = await mkdtemp(join(tmpdir(), 'dimension-raw-archive-'));
  const directory = join(root, 'copy');
  try { await cp(ARCHIVE_DIRECTORY, directory, { recursive: true }); return await run(directory); }
  finally { await rm(root, { force: true, recursive: true }); }
}

test('private 15-file archive verifies exact saved Git blobs, SHA256 and results without model promotion', async () => {
  const actual = await verifyOpenFootballResearchArchive();
  assert.equal(actual.sourceCommit, PINNED_OPENFOOTBALL_COMMIT);
  assert.equal(actual.status, 'VERIFIED_HISTORICAL_RAW_ONLY');
  assert.equal(actual.fileCount, 15);
  assert.equal(actual.matches, 5478);
  assert.equal(actual.fullTime, 5377);
  assert.equal(actual.missingFullTime, 101);
  assert.equal(actual.modelReady, false);
  assert.equal(actual.releaseGate, 'BLOCKED');
  assert.equal(new Set(actual.files.map(row => row.path)).size, 15);
  assert.equal(actual.files.find(row => row.path === '2019-20/fr.1.json').missingFullTime, 101);
});

test('a changed RAW byte fails closed instead of silently rewriting an archived result', async () => {
  await isolatedArchive(async directory => {
    const path = join(directory, '2021-22', 'en.1.json');
    const raw = await readFile(path, 'utf8');
    assert.ok(raw.includes('English Premier League'));
    await writeFile(path, raw.replace('English Premier League', 'English Premier Leagoo'));
    await assert.rejects(verifyOpenFootballResearchArchive({ directory }), /ARCHIVE_RAW_HASH_MISMATCH/);
  });
});

test('modified manifest counts cannot promote incomplete French 2019-20 into scored history', async () => {
  await isolatedArchive(async directory => {
    const path = join(directory, 'manifest.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    manifest.totalFullTime = 5478;
    await writeFile(path, JSON.stringify(manifest));
    await assert.rejects(verifyOpenFootballResearchArchive({ directory }), /ARCHIVE_TOTAL_MISMATCH/);
  });
});

test('a missing source file is rejected; no stale fallback or fake historical coverage', async () => {
  await isolatedArchive(async directory => {
    await unlink(join(directory, '2020-21', 'de.1.json'));
    await assert.rejects(verifyOpenFootballResearchArchive({ directory }));
  });
});

test('out-of-scope season or incorrect source identity is rejected', async () => {
  await isolatedArchive(async directory => {
    const path = join(directory, 'manifest.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    manifest.files[0].path = '2022-23/en.1.json';
    await writeFile(path, JSON.stringify(manifest));
    await assert.rejects(verifyOpenFootballResearchArchive({ directory }), /ARCHIVE_FILES_NOT_EXACTLY_PINNED/);
  });
});

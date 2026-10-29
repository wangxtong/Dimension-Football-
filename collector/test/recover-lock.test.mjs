import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { recoverLock } from '../recover-lock.mjs';
import { acquireLock, atomicJson } from '../storage.mjs';

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dimension-football-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'state.json');
}

test('lock recovery refuses a live owner and leaves the lock unchanged', async t => {
  const path = await workspace(t), release = await acquireLock(path);
  t.after(release);
  const previous = await readFile(`${path}.lock`, 'utf8');
  await assert.rejects(recoverLock(path), { message: 'LOCK_OWNER_STILL_RUNNING' });
  assert.equal(await readFile(`${path}.lock`, 'utf8'), previous);
});

test('explicit recovery removes only a dead owner on this host and permits a fresh lock', async t => {
  const path = await workspace(t);
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true });
  const pid = child.pid;
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 && signal === null ? resolve() : reject(new Error('Child did not exit cleanly')));
  });
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
  await atomicJson(`${path}.lock`, { token: randomUUID(), pid, hostname: hostname(), createdAt: new Date().toISOString() });
  assert.deepEqual(await recoverLock(path), { recovered: true, code: 'DEAD_OWNER_LOCK_REMOVED' });
  await assert.rejects(stat(`${path}.lock`), error => error.code === 'ENOENT');
  const release = await acquireLock(path);
  await release();
  assert.deepEqual(await recoverLock(path), { recovered: false, code: 'NO_LOCK' });
});

test('a lock from another host is never removed even if its PID is locally present', async t => {
  const path = await workspace(t);
  const lock = { token: randomUUID(), pid: process.pid, hostname: `${hostname()}-other-host` };
  await atomicJson(`${path}.lock`, lock);
  await assert.rejects(recoverLock(path), { message: 'LOCK_FROM_ANOTHER_HOST' });
  assert.deepEqual(JSON.parse(await readFile(`${path}.lock`, 'utf8')), lock);
});

test('malformed lock metadata is rejected without deletion', async t => {
  const path = await workspace(t);
  for (const lock of [{}, { token: 'bad-token', pid: process.pid, hostname: hostname() },
    { token: randomUUID(), pid: 0, hostname: hostname() }]) {
    await atomicJson(`${path}.lock`, lock);
    await assert.rejects(recoverLock(path), { message: 'LOCK_INVALID' });
    assert.deepEqual(JSON.parse(await readFile(`${path}.lock`, 'utf8')), lock);
  }
});

import { lstat, readFile, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Explicit operator recovery, never called automatically by the scheduler.
// Stop the scheduler before this command; a running owner always blocks repair.
export async function recoverLock(statePath) {
  const path = `${resolve(statePath)}.lock`;
  let stat;
  try { stat = await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return { recovered: false, code: 'NO_LOCK' }; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('LOCK_INVALID');
  let lock;
  try { lock = JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error('LOCK_INVALID'); }
  if (!Number.isSafeInteger(lock?.pid) || lock.pid <= 0 || typeof lock.token !== 'string' || !/^[a-f0-9-]{36}$/.test(lock.token)) throw new Error('LOCK_INVALID');
  if (lock.hostname !== hostname()) throw new Error('LOCK_FROM_ANOTHER_HOST');
  try { process.kill(lock.pid, 0); throw new Error('LOCK_OWNER_STILL_RUNNING'); }
  catch (error) { if (error.code !== 'ESRCH') throw new Error('LOCK_OWNER_STILL_RUNNING'); }
  const current = JSON.parse(await readFile(path, 'utf8'));
  if (current.token !== lock.token) throw new Error('LOCK_CHANGED');
  await unlink(path);
  return { recovered: true, code: 'DEAD_OWNER_LOCK_REMOVED' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--state') throw new Error('USAGE');
    const result = await recoverLock(process.argv[3]); console.log(result.code);
  } catch (error) {
    const codes = ['LOCK_INVALID', 'LOCK_FROM_ANOTHER_HOST', 'LOCK_OWNER_STILL_RUNNING', 'LOCK_CHANGED', 'USAGE'];
    console.error(codes.includes(error.message) ? error.message : 'LOCK_RECOVERY_FAILED'); process.exitCode = 1;
  }
}

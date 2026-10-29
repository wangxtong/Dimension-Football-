import { mkdir, readFile, open, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

export async function readJson(path, maxBytes = 20_000_000) {
  const handle = await open(path, 'r');
  try {
    if ((await handle.stat()).size > maxBytes) throw new Error('JSON_FILE_TOO_LARGE');
    return JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
}

export async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await file.sync();
  } finally { await file.close(); }
  try { await rename(temporary, path); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

export async function acquireLock(statePath) {
  const path = `${resolve(statePath)}.lock`;
  await mkdir(dirname(path), { recursive: true });
  let file;
  try { file = await open(path, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('COLLECTION_ALREADY_LOCKED'); throw error; }
  const token = randomUUID();
  await file.writeFile(JSON.stringify({ token, pid: process.pid, hostname: hostname(), createdAt: new Date().toISOString() }));
  await file.close();
  return async () => {
    try { if (JSON.parse(await readFile(path, 'utf8')).token === token) await unlink(path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
}

export async function readState(path, simulated) {
  let state;
  try { state = await readJson(path, 64_000_000); }
  catch (error) { if (error.code === 'ENOENT') return { version: 1, simulated, entries: {}, runs: [] }; throw new Error('STATE_UNREADABLE'); }
  if (state?.version !== 1 || state.simulated !== simulated || !state.entries || Array.isArray(state.entries)
    || typeof state.entries !== 'object' || !Array.isArray(state.runs) || Object.keys(state.entries).some(key => !/^[a-f0-9]{64}$/.test(key))) throw new Error('STATE_INVALID_OR_MODE_MISMATCH');
  for (const entry of Object.values(state.entries)) if (!entry?.fixture || typeof entry.fixture.id !== 'string'
    || !['pending', 'candidate', 'simulated_candidate', 'avoid', 'source_insufficient'].includes(entry.result?.status)
    || !Array.isArray(entry.result.reasons)) throw new Error('STATE_INVALID_OR_MODE_MISMATCH');
  return state;
}

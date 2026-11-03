/**
 * Container-hosted research only. No ECS systemd, website, Telegram, or commercial releases.
 * Requires Railway's actual persistent /data mount and an immutable source revision.
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';

export const RESEARCH_JOBS = Object.freeze([
  Object.freeze({ lane: 'fixtures', intervalMs: 15 * 60_000, budgetMinutes: 2 }),
  Object.freeze({ lane: 'markets', intervalMs: 2 * 60_000, budgetMinutes: 1 }),
  Object.freeze({ lane: 'results', intervalMs: 60 * 60_000, budgetMinutes: 2 }),
]);
const SHA40 = /^[a-f0-9]{40}$/;
const MAX_SLEEP_MS = 30_000;

export function researchRuntime(env = {}) {
  if (env.RAILWAY_VOLUME_MOUNT_PATH !== '/data') throw Error('RESEARCH_PERSISTENT_VOLUME_REQUIRED');
  if (env.RAILWAY_ENVIRONMENT_NAME === 'production') throw Error('RESEARCH_PRODUCTION_ENV_FORBIDDEN');
  if (env.VANTIS_ECS_PRIMARY === 'true' || env.HOSTED_PUBLICATION_ENABLED === 'true')
    throw Error('RESEARCH_PUBLICATION_ENV_FORBIDDEN');
  const sha = env.RAILWAY_GIT_COMMIT_SHA || env.COLLECTOR_COMMIT;
  if (typeof sha !== 'string' || !SHA40.test(sha)) throw Error('RESEARCH_CODE_SHA_REQUIRED');
  return { root: '/data', commitSha: sha };
}

export function nextResearchJob(state, nowMs) {
  if (!state || state.version !== 1 || typeof state.due !== 'object' || !state.due
      || !Number.isFinite(nowMs)) throw Error('RESEARCH_SCHEDULER_INVALID');
  const remaining = RESEARCH_JOBS.map(job => ({ ...job, dueAt: Number.isFinite(state.due[job.lane]) ? state.due[job.lane] : 0 }))
    .sort((a, b) => a.dueAt - b.dueAt || RESEARCH_JOBS.findIndex(j => j.lane === a.lane) - RESEARCH_JOBS.findIndex(j => j.lane === b.lane));
  const next = remaining[0];
  return next.dueAt <= nowMs ? { ...next, waitMs: 0 } : { ...next, waitMs: Math.min(MAX_SLEEP_MS, next.dueAt - nowMs) };
}

export function finishResearchJob(state, lane, finishedMs, outcome) {
  const job = RESEARCH_JOBS.find(x => x.lane === lane);
  if (!job || !Number.isFinite(finishedMs) || !state || state.version !== 1 || !state.due)
    throw Error('RESEARCH_SCHEDULER_INVALID');
  return { version: 1,
    due: { ...state.due, [lane]: finishedMs + job.intervalMs },
    last: { lane, finishedAt: new Date(finishedMs).toISOString(),
      status: String(outcome?.status || 'failed').slice(0, 30),
      exitCode: Number.isInteger(outcome?.exitCode) ? outcome.exitCode : 1,
      reportId: /^[a-f0-9]{64}$/.test(outcome?.reportId || '') ? outcome.reportId : null } };
}

async function readScheduler(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    if (parsed.version !== 1 || !parsed.due || typeof parsed.due !== 'object'
        || !RESEARCH_JOBS.every(job => parsed.due[job.lane] === undefined
          || Number.isFinite(parsed.due[job.lane]))) throw Error('RESEARCH_SCHEDULER_INVALID');
    return parsed;
  } catch (e) {
    if (e.code === 'ENOENT') return { version: 1, due: {} };
    throw e;
  }
}

async function saveScheduler(path, state) {
  const tmp = path + '.' + process.pid + '.new';
  await writeFile(tmp, JSON.stringify(state) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(tmp, path);
}

export async function runResearchWorker({ env = process.env, signal, now = () => Date.now(),
  onOutcome = x => console.log(JSON.stringify(x)), runLane } = {}) {
  const cfg = researchRuntime(env);
  const schedulerPath = join(cfg.root, 'operations/research-cloud-scheduler.json');
  await mkdir(join(cfg.root, 'operations'), { recursive: true, mode: 0o700 });
  await mkdir(join(cfg.root, 'state'), { recursive: true, mode: 0o700 });
  await mkdir(join(cfg.root, 'reports'), { recursive: true, mode: 0o700 });
  let state = await readScheduler(schedulerPath);
  const invoke = runLane || (async job => {
    const { runOrchestration } = await import('./orchestrate.mjs');
    return runOrchestration(['--lane', job.lane, '--mode', 'private-research',
      '--state', join(cfg.root, 'state/state.json'), '--out', join(cfg.root, 'reports'),
      '--budget-minutes', String(job.budgetMinutes)],
    { env: { ...env, COLLECTOR_COMMIT: cfg.commitSha }, signal, stdout: () => {} });
  });
  onOutcome({ event: 'RESEARCH_WORKER_STARTED', mode: 'private-research',
    publicationEnabled: false, volume: cfg.root, codeSha: cfg.commitSha });
  while (!signal?.aborted) {
    const due = nextResearchJob(state, now());
    if (due.waitMs) {
      try { await pause(due.waitMs, undefined, { signal }); }
      catch (e) { if (signal?.aborted && e.name === 'AbortError') break; throw e; }
      continue;
    }
    let outcome;
    try { outcome = await invoke(due); }
    catch (e) { outcome = { status: 'failed', exitCode: 1, code: 'RESEARCH_LANE_THROWN' }; }
    state = finishResearchJob(state, due.lane, now(), outcome);
    await saveScheduler(schedulerPath, state);
    onOutcome({ event: 'RESEARCH_LANE_FINISHED', lane: due.lane,
      status: state.last.status, exitCode: state.last.exitCode,
      reportId: state.last.reportId, commercialReleaseGate: 'BLOCKED' });
  }
  return { stopped: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort());
  process.once('SIGINT', () => controller.abort());
  runResearchWorker({ signal: controller.signal }).catch(e => {
    const allowed = /^RESEARCH_[A-Z_]+$/.test(e.message || '') ? e.message : 'RESEARCH_WORKER_FAILED';
    console.error(JSON.stringify({ event: 'RESEARCH_WORKER_ABORTED', code: allowed }));
    process.exitCode = 1;
  });
}

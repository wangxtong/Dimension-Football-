import { mkdir, readFile, readdir, open, link, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, isoMillis } from './policy.mjs';
import { scoreProbabilities, summarizeEvaluations, validProbabilities } from './forecast-evaluation.mjs';

const token = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const time = value => Number.isFinite(isoMillis(value));
const identity = fixture => ({ source: fixture.source, fixtureId: fixture.id, league: fixture.league,
  homeTeamId: fixture.homeTeamId, awayTeamId: fixture.awayTeamId, kickoff: new Date(isoMillis(fixture.kickoff)).toISOString(),
  season: fixture.season == null ? null : String(fixture.season) });
function validateFixture(fixture) {
  if (!fixture || !['id', 'source', 'league', 'homeTeamId', 'awayTeamId'].every(key => token(fixture[key]))
    || fixture.homeTeamId === fixture.awayTeamId || !time(fixture.kickoff)) throw new Error('INVALID_LEDGER_FIXTURE');
}
const eventId = row => digest([row.source, row.fixtureId]);

export function createPredictionRecord({ fixture, forecast, model, reportId, nowISO }) {
  validateFixture(fixture);
  if (forecast?.status !== 'forecast' || forecast.fixtureId !== fixture.id || !validProbabilities(forecast.probabilities)
    || !time(forecast.generatedAt) || isoMillis(forecast.generatedAt) >= isoMillis(fixture.kickoff)
    || !time(forecast.trainingCutoff) || isoMillis(forecast.trainingCutoff) > isoMillis(forecast.generatedAt)
    || !hash(forecast.trainingHash) || !hash(reportId) || !token(model?.id) || !Number.isSafeInteger(model.version)
    || !time(nowISO) || isoMillis(nowISO) < isoMillis(forecast.generatedAt) || isoMillis(nowISO) >= isoMillis(fixture.kickoff)) throw new Error('INVALID_PREDICTION_RECORD');
  const record = { version: 1, kind: 'prediction', ...identity(fixture), reportId,
    model: { id: model.id, version: model.version, calibrated: model.calibrated === true },
    generatedAt: new Date(isoMillis(forecast.generatedAt)).toISOString(), recordedAt: new Date(isoMillis(nowISO)).toISOString(), trainingCutoff: forecast.trainingCutoff,
    trainingHash: forecast.trainingHash, probabilities: Object.fromEntries(['home', 'draw', 'away'].map(key => [key, forecast.probabilities[key]])),
    horizonHours: (isoMillis(fixture.kickoff) - isoMillis(forecast.generatedAt)) / 3600000 };
  return { ...record, predictionId: digest([record.source, record.fixtureId, record.model, record.generatedAt]) };
}

export function createResultVersion(result) {
  validateFixture(result);
  const observedAt = result.resultObservedAt || result.observedAt;
  if (!time(observedAt) || !['FINISHED', 'CANCELLED', 'POSTPONED', 'ABANDONED'].includes(result.status)
    || result.status === 'FINISHED' && (result.period !== 'full-time' || isoMillis(observedAt) <= isoMillis(result.kickoff)
      || ![result.homeGoals, result.awayGoals].every(n => Number.isInteger(n) && n >= 0 && n <= 20))) throw new Error('INVALID_RESULT_VERSION');
  const content = { version: 1, kind: 'result', ...identity(result), status: result.status,
    period: result.status === 'FINISHED' ? 'full-time' : null,
    homeGoals: result.status === 'FINISHED' ? result.homeGoals : null, awayGoals: result.status === 'FINISHED' ? result.awayGoals : null };
  return { ...content, contentHash: digest(content), resultVersionId: digest([content, new Date(isoMillis(observedAt)).toISOString()]), resultObservedAt: new Date(isoMillis(observedAt)).toISOString(),
    sourceRevisionId: token(result.revisionId) ? result.revisionId : null };
}

export function scorePredictionRecord(prediction, result) {
  if (prediction.source !== result.source || prediction.fixtureId !== result.fixtureId) throw new Error('RESULT_IDENTITY_MISMATCH');
  const sameIdentity = ['league', 'homeTeamId', 'awayTeamId', 'kickoff'].every(key => prediction[key] === result[key]);
  const status = !sameIdentity ? 'void-identity-or-schedule-changed' : result.status === 'CANCELLED' || result.status === 'ABANDONED'
    ? 'void-result' : result.status === 'POSTPONED' ? 'pending-postponed' : 'scored';
  const actual = status === 'scored' ? result.homeGoals > result.awayGoals ? 'home' : result.homeGoals === result.awayGoals ? 'draw' : 'away' : null;
  return { version: 1, kind: 'score', scoreId: digest([prediction.predictionId, result.resultVersionId]),
    predictionId: prediction.predictionId, resultVersionId: result.resultVersionId, reportId: prediction.reportId,
    status, actual, metrics: actual ? scoreProbabilities(prediction.probabilities, actual) : null,
    resultObservedAt: result.resultObservedAt };
}

async function records(directory) {
  let names; try { names = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return Promise.all(names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort().map(name => readFile(join(directory, name), 'utf8').then(decode)));
}
function decode(text) {
  const envelope = JSON.parse(text);
  if (!hash(envelope.sha256) || digest(envelope.record) !== envelope.sha256) throw new Error('LEDGER_INTEGRITY_FAILURE');
  return envelope.record;
}

/** Fsync a complete temporary record, then publish with atomic no-replace link. */
async function append(directory, id, record, equivalent = (a, b) => digest(a) === digest(b)) {
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${id}.json`), temporary = join(directory, `.${id}.${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(`${JSON.stringify({ record, sha256: digest(record) })}\n`); await file.sync(); } finally { await file.close(); }
  try {
    try { await link(temporary, path); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = decode(await readFile(path, 'utf8'));
      if (!equivalent(existing, record)) throw new Error('IMMUTABLE_LEDGER_CONFLICT');
      return { created: false, record: existing };
    }
    const dir = await open(directory, 'r'); try { await dir.sync(); } finally { await dir.close(); }
    return { created: true, record };
  } finally { await unlink(temporary).catch(() => {}); }
}

export async function appendPrediction({ directory, fixture, forecast, model, reportId, nowISO }) {
  const record = createPredictionRecord({ fixture, forecast, model, reportId, nowISO });
  return append(join(directory, eventId(record), 'predictions'), record.predictionId, record,
    (a, b) => digest({ ...a, recordedAt: null }) === digest({ ...b, recordedAt: null }));
}

export async function appendResultAndScore({ directory, result, nowISO }) {
  let version = createResultVersion(result);
  if (!time(nowISO) || isoMillis(version.resultObservedAt) > isoMillis(nowISO)) throw new Error('FUTURE_RESULT_OBSERVATION');
  const root = join(directory, eventId(version));
  const previous = (await records(join(root, 'results'))).sort((a, b) => isoMillis(b.resultObservedAt) - isoMillis(a.resultObservedAt))[0];
  if (previous?.contentHash === version.contentHash && isoMillis(previous.resultObservedAt) <= isoMillis(version.resultObservedAt)) version = previous;
  // Re-polling an unchanged result keeps its first stored observation time.
  const stored = await append(join(root, 'results'), version.resultVersionId, version,
    (a, b) => a.resultVersionId === b.resultVersionId && digest({ ...a, resultObservedAt: null, sourceRevisionId: null }) === digest({ ...b, resultObservedAt: null, sourceRevisionId: null }));
  const scores = [];
  for (const prediction of await records(join(root, 'predictions'))) {
    const score = scorePredictionRecord(prediction, stored.record);
    scores.push(await append(join(root, 'scores'), score.scoreId, score));
  }
  return { result: stored, scores };
}

/** Call after reportId exists, before publishing; caller decides durable root. */
export async function appendReportPredictions({ directory, report, nowISO }) {
  if (report?.simulated) return { recorded: 0, reused: 0 };
  const document = report?.kind === 'prematch-forecast-report';
  const rows = document ? report.fixtures : report?.results;
  const model = document ? report.model : report?.forecasts?.model;
  const generated = document ? report.generatedAt : report?.forecasts?.generatedAt;
  const reportId = report?.publication?.reportId;
  if (!hash(reportId) || !time(nowISO) || !Array.isArray(rows)) throw new Error('INVALID_LEDGER_REPORT');
  const result = { recorded: 0, reused: 0, opportunities: 0 };
  for (const row of rows) {
    let predictionId = null;
    if (row.forecast?.status === 'forecast') {
      const saved = await appendPrediction({ directory, fixture: row.fixture, forecast: row.forecast,
        model, reportId, nowISO });
      predictionId = saved.record.predictionId;
      result[saved.created ? 'recorded' : 'reused']++;
    }
    const f = row.fixture, generatedAt = row.forecast?.generatedAt || generated;
    if (![f?.id, f?.source, f?.league].every(token) || !time(f?.kickoff) || !time(generatedAt)
      || isoMillis(generatedAt) > isoMillis(nowISO) || isoMillis(nowISO) >= isoMillis(f.kickoff)) continue;
    const opportunity = { version: 1, kind: 'opportunity', source: f.source, fixtureId: f.id, league: f.league,
      kickoff: f.kickoff, generatedAt, recordedAt: nowISO, reportId, horizonHours: (isoMillis(f.kickoff) - isoMillis(generatedAt)) / 3600000,
      model: token(model?.id) ? { id: model.id, version: model.version } : null,
      status: predictionId ? 'forecast' : 'unavailable', predictionId, reasons: row.forecast?.reasons || ['FORECAST_MISSING'] };
    await append(join(directory, eventId(opportunity), 'opportunities'), digest([reportId, f.source, f.id]), opportunity,
      (a, b) => digest({ ...a, recordedAt: null }) === digest({ ...b, recordedAt: null }));
    result.opportunities++;
  }
  return result;
}

/** One prediction per fixture per lead-time window, preventing hourly pseudo-replication. */
export async function evaluatePredictionLedger({ directory, nowISO, horizonHours = 1, toleranceHours = 1, modelId, modelVersion, source, league }) {
  if (!time(nowISO) || !Number.isFinite(horizonHours) || horizonHours < 0 || !Number.isFinite(toleranceHours)
    || toleranceHours < 0 || toleranceHours > 24 || [modelId, source, league].some(value => value !== undefined && !token(value))
    || modelVersion !== undefined && !Number.isSafeInteger(modelVersion)) throw new Error('INVALID_LEDGER_EVALUATION');
  let events; try { events = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') events = []; else throw error; }
  const evaluations = [], exclusions = []; let eligible = 0, pending = 0;
  for (const event of events.filter(hash)) {
    const root = join(directory, event);
    const withinWindow = row => isoMillis(row.generatedAt) <= isoMillis(nowISO) && isoMillis(row.recordedAt) <= isoMillis(nowISO)
      && row.horizonHours >= horizonHours && row.horizonHours <= horizonHours + toleranceHours
      && (modelId === undefined || row.model?.id === modelId) && (modelVersion === undefined || row.model?.version === modelVersion)
      && (source === undefined || row.source === source) && (league === undefined || row.league === league);
    const order = (a, b) => a.horizonHours - b.horizonHours || (a.predictionId || a.reportId).localeCompare(b.predictionId || b.reportId);
    const predictions = (await records(join(root, 'predictions'))).filter(withinWindow).sort(order);
    const opportunity = (await records(join(root, 'opportunities'))).filter(withinWindow).sort(order)[0];
    const prediction = opportunity ? predictions.find(row => row.predictionId === opportunity.predictionId) : predictions[0];
    if (!prediction && !opportunity) continue; eligible++;
    if (!prediction) { exclusions.push({ fixtureId: opportunity.fixtureId, reason: opportunity.status === 'unavailable' ? 'FORECAST_UNAVAILABLE' : 'PREDICTION_RECORD_MISSING', reasons: opportunity.reasons }); continue; }
    const versions = (await records(join(root, 'results'))).filter(row => isoMillis(row.resultObservedAt) <= isoMillis(nowISO))
      .sort((a, b) => isoMillis(b.resultObservedAt) - isoMillis(a.resultObservedAt) || a.resultVersionId.localeCompare(b.resultVersionId));
    if (!versions.length) { pending++; continue; }
    // Equal observation times with different outcomes have no trustworthy ordering.
    if (versions[1]?.resultObservedAt === versions[0].resultObservedAt) { exclusions.push({ predictionId: prediction.predictionId, reason: 'AMBIGUOUS_RESULT_REVISION' }); continue; }
    const result = versions[0], score = scorePredictionRecord(prediction, result);
    if (score.status === 'pending-postponed') { pending++; continue; }
    if (score.status !== 'scored') { exclusions.push({ predictionId: prediction.predictionId, reason: score.status }); continue; }
    evaluations.push({ ...prediction, actual: score.actual, resultVersionId: result.resultVersionId,
      resultObservedAt: result.resultObservedAt, provenance: 'prospective-ledger' });
  }
  return { horizonHours, toleranceHours, filters: { modelId: modelId ?? null, modelVersion: modelVersion ?? null, source: source ?? null, league: league ?? null }, evaluations, exclusions,
    ...summarizeEvaluations(evaluations, { eligible, skipped: exclusions.length, pending }) };
}

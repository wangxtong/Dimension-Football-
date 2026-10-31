import { canonicalJSON, canonicalTimestamp, dataHash, validDataHash, validDataToken, withEventIdentity } from './identity.mjs';
import { normalizeHistoryRecord } from './history-cache.mjs';

const fixtureFields = ['id', 'source', 'sourceFixtureId', 'league', 'season', 'home', 'away', 'homeTeamId', 'awayTeamId',
  'kickoff', 'status', 'updatedAt', 'fetchedAt', 'observedAt', 'sourceUpdatedAt', 'canonicalMatchId', 'identityScope', 'identityRevision', 'revisionId', 'recordHash'];
const validName = value => typeof value === 'string' && value.trim() && value.length <= 200 && !/[\x00-\x1f\x7f]/u.test(value);
const status = new Set(['SCHEDULED', 'TIMED', 'FINISHED', 'IN_PLAY', 'PAUSED', 'CANCELLED', 'POSTPONED', 'SUSPENDED']);

function fixtureInput(row) {
  if (!validDataToken(row?.id) || !validDataToken(row?.source) || !['PL', 'PD', 'SA', 'BL1', 'FL1'].includes(row?.league)
    || !validName(row.home) || !validName(row.away) || row.home === row.away || !canonicalTimestamp(row.kickoff) || !status.has(row.status)) throw new Error('INVALID_REPLAY_FIXTURE');
  const clean = Object.fromEntries(fixtureFields.filter(key => row[key] !== undefined).map(key => [key, row[key]]));
  for (const key of ['kickoff', 'updatedAt', 'fetchedAt', 'observedAt', 'sourceUpdatedAt']) {
    if (clean[key] === null && key !== 'kickoff') continue;
    if (clean[key] !== undefined) {
      if (!canonicalTimestamp(clean[key])) throw new Error('INVALID_REPLAY_FIXTURE');
      clean[key] = canonicalTimestamp(clean[key]);
    }
  }
  if (clean.homeTeamId !== undefined || clean.awayTeamId !== undefined) {
    const normalized = withEventIdentity(clean);
    for (const key of ['canonicalMatchId', 'identityRevision', 'revisionId', 'recordHash']) if (row[key] !== undefined && row[key] !== normalized[key]) throw new Error('REPLAY_IDENTITY_MISMATCH');
    return normalized;
  }
  // Legacy records without team IDs are reproducible unavailable forecasts;
  // recording them must not invent verified identity.
  if (['canonicalMatchId', 'identityRevision', 'revisionId', 'recordHash'].some(key => row[key] !== undefined)) throw new Error('REPLAY_IDENTITY_MISMATCH');
  return clean;
}

function plainConfig(value, error) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || JSON.stringify(value).length > 20000) throw new Error(error);
  // Config inputs are numeric/boolean model parameters and safe symbolic text,
  // not arbitrary request options, URLs, headers or credential-bearing objects.
  for (const [key, field] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,79}$/.test(key) || /secret|token|password|authorization|apiKey/i.test(key)
      || !['string', 'number', 'boolean'].includes(typeof field) || typeof field === 'number' && !Number.isFinite(field)
      || typeof field === 'string' && (field.length > 300 || /[\x00-\x1f\x7f]/u.test(field))) throw new Error(error);
  }
  return structuredClone(value);
}

export function prepareReplayInputs({ fixtures, history = [], policy, model, reportId }) {
  if (!Array.isArray(fixtures) || fixtures.length > 3000 || !Array.isArray(history) || history.length > 10000) throw new Error('INVALID_REPLAY_INPUTS');
  if (reportId !== undefined && !validDataHash(reportId)) throw new Error('INVALID_RUN_MANIFEST');
  return { version: 1, dataSchemaVersion: 2, ...(reportId === undefined ? {} : { reportId }), fixtures: fixtures.map(fixtureInput), history: history.map(normalizeHistoryRecord),
    policy: plainConfig(policy, 'INVALID_REPLAY_POLICY'), model: plainConfig(model, 'INVALID_REPLAY_MODEL') };
}

export function createReplayBundle({ reportId, fixtures, history, policy, model, generatedAt, cutoff,
  codeVersion = null, simulated = false }) {
  if (!validDataHash(reportId) || !canonicalTimestamp(generatedAt) || !canonicalTimestamp(cutoff)
    || Date.parse(cutoff) > Date.parse(generatedAt) || typeof simulated !== 'boolean'
    || codeVersion !== null && !/^[a-f0-9]{40,64}$/.test(codeVersion)) throw new Error('INVALID_RUN_MANIFEST');
  const inputs = prepareReplayInputs({ fixtures, history, policy, model, reportId });
  const manifest = { version: 1, kind: 'forecast-run-manifest', reportId, generatedAt: canonicalTimestamp(generatedAt),
    cutoff: canonicalTimestamp(cutoff), codeVersion, simulated, dataSchemaVersion: 2, inputFile: 'run-inputs.json',
    inputsHash: dataHash(inputs), policyHash: dataHash(inputs.policy), modelHash: dataHash(inputs.model),
    fixtureCount: inputs.fixtures.length, historyCount: inputs.history.length,
    replayStatus: codeVersion ? 'version-bound' : 'inputs-only-code-version-unknown',
    visibility: !inputs.history.length ? 'no-history' : inputs.history.every(row => row.observedAt && row.resultObservedAt) ? 'observed-result-versions' : 'snapshot-only',
    limitations: ['Observation timestamps are acquisition evidence, not original result publication times.',
      'Replaying an older cutoff cannot establish availability before the first retained observation.'] };
  return { manifest: { ...manifest, manifestHash: dataHash(manifest) }, inputs };
}

export function verifyReplayBundle(bundle, { reportId, codeVersion } = {}) {
  const manifest = bundle?.manifest, inputs = bundle?.inputs;
  if (!manifest || manifest.version !== 1 || manifest.kind !== 'forecast-run-manifest' || manifest.dataSchemaVersion !== 2
    || !validDataHash(manifest.reportId) || !canonicalTimestamp(manifest.generatedAt) || !canonicalTimestamp(manifest.cutoff)
    || Date.parse(manifest.cutoff) > Date.parse(manifest.generatedAt) || !validDataHash(manifest.manifestHash)
    || manifest.inputFile !== 'run-inputs.json' || typeof manifest.simulated !== 'boolean') throw new Error('INVALID_RUN_MANIFEST');
  if (!inputs || inputs.version !== 1 || inputs.dataSchemaVersion !== 2 || inputs.reportId !== manifest.reportId
    || !Array.isArray(inputs.fixtures) || !Array.isArray(inputs.history) || !inputs.policy || !inputs.model) throw new Error('INVALID_REPLAY_INPUTS');
  const { manifestHash, ...body } = manifest;
  if (dataHash(body) !== manifestHash || dataHash(inputs) !== manifest.inputsHash
    || dataHash(inputs.policy) !== manifest.policyHash || dataHash(inputs.model) !== manifest.modelHash
    || inputs.fixtures.length !== manifest.fixtureCount || inputs.history.length !== manifest.historyCount
    || canonicalJSON(prepareReplayInputs(inputs)) !== canonicalJSON(inputs)) throw new Error('RUN_INPUT_HASH_MISMATCH');
  if (reportId !== undefined && reportId !== manifest.reportId) throw new Error('RUN_REPORT_ID_MISMATCH');
  if (codeVersion !== undefined && codeVersion !== manifest.codeVersion) throw new Error('RUN_CODE_VERSION_MISMATCH');
  return structuredClone({ manifest, inputs });
}

// A verifiable checksum binds a replay snapshot, but cannot prove that data
// acquired or revised after its cutoff was available at that cutoff. Preserve
// archives for inspection, while refusing to execute such a replay as-of time.
function requirePointInTimeInputs(inputs, cutoff) {
  const boundary = Date.parse(cutoff);
  const later = (row, fields) => fields.some(field => row[field] && Date.parse(row[field]) > boundary);
  if (inputs.fixtures.some(row => later(row, ['updatedAt', 'fetchedAt', 'observedAt', 'sourceUpdatedAt']))
    || inputs.history.some(row => later(row, ['observedAt', 'resultObservedAt', 'fetchedAt', 'sourceUpdatedAt']))) {
    throw new Error('REPLAY_INPUT_AFTER_CUTOFF');
  }
}

// No CLI or fetch path is invoked. The caller supplies the version-matched pure
// model function; a missing code binding must be explicitly acknowledged.
export function replayForecasts(bundle, { buildForecasts, codeVersion, allowUnknownCodeVersion = false } = {}) {
  const { manifest, inputs } = verifyReplayBundle(bundle, { codeVersion });
  if (typeof buildForecasts !== 'function') throw new Error('REPLAY_MODEL_REQUIRED');
  if (manifest.codeVersion && !codeVersion) throw new Error('REPLAY_CODE_VERSION_REQUIRED');
  if (!manifest.codeVersion && !allowUnknownCodeVersion) throw new Error('REPLAY_CODE_VERSION_REQUIRED');
  requirePointInTimeInputs(inputs, manifest.cutoff);
  return buildForecasts({ fixtures: inputs.fixtures, history: inputs.history, policy: inputs.policy,
    nowISO: manifest.cutoff, simulated: manifest.simulated, remaining: () => Infinity });
}

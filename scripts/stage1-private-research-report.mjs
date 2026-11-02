import { createHash } from 'node:crypto';
import { readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import { resolve, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { requireGreenForecastDelivery } from '../collector/publication-release-gate.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const fail = s => { throw new Error('STAGE1_' + s); };
const readJSON = async p => JSON.parse(await readFile(p, 'utf8'));
const optionalJSON = async p => {
  try { return await readJSON(p); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
};
const html = x => String(x).replace(/[&<>"']/g, c => ({
  '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;',
}[c]));

export function summarizeStage1(inputs) {
  const { original, receipt, normalized, lanes, evaluation, report, publication, gateBlocked, sourceCommit, capturedAt } = inputs;
  if (!/^[a-f0-9]{40}$/.test(sourceCommit || '') || !Number.isFinite(Date.parse(capturedAt || ''))) fail('META_INVALID');
  if (original?.receipt?.observationMode !== 'LIVE_SOURCE_HTTP' || original.receipt.httpStatus !== 200
    || original.receipt.sourceId !== 'openligadb-bl1-history'
    || !hash(original.receipt.rawSha256) || original.receipt.rawSha256 !== receipt?.rawSha256
    || original.receipt.rawSha256 !== normalized?.rawSha256
    || !hash(receipt?.batchSha256) || normalized?.kind !== 'research-history-batch'
    || receipt.status !== 'RESEARCH_HISTORICAL_RAW_IMPORTED'
    || receipt.records !== normalized.records?.length || normalized.records.length !== 306
    || normalized.releaseGate !== 'BLOCKED'
    || normalized.modelReadyForProspective !== false
    || normalized.historicalPregameObserved !== false || gateBlocked !== true) fail('SOURCE_OR_RELEASE_INVALID');
  const summaries = {};
  for (const name of ['results', 'fixtures']) {
    const lane = lanes?.lanes?.[name];
    if (!lane || lane.mode !== 'private-research' || lane.forecastPublished !== false
      || lane.publicationStatus !== 'not_attempted'
      || lane.releaseGate?.productionAuthorization !== false
      || lane.releaseGate?.decision !== 'BLOCKED') fail('LANE_NOT_PRIVATE');
    summaries[name] = { status:lane.status, code:lane.code ?? null,
      exitCode:lane.exitCode, reportId:lane.reportId ?? null };
  }
  if (evaluation && (evaluation.scope !== 'private-research-freezes'
    || evaluation.forecastPublished !== false || evaluation.releaseGate !== 'BLOCKED'
    || !Number.isSafeInteger(evaluation.summary?.recordedScores))) fail('EVALUATION_NOT_PRIVATE');
  if (report && (!Array.isArray(report.fixtures) || report.simulated)) fail('REPORT_INVALID');
  if (publication) for (const channel of ['externalWebsite', 'notifications', 'receiptSync']) {
    if (['published', 'accepted', 'sent'].includes(publication.channels?.[channel]?.status))
      fail('EXTERNAL_PUBLICATION_FOUND');
  }
  return {
    version:1, kind:'dimension-football-stage1-private-research',
    capturedAt, codeSha:sourceCommit, runtime:'GITHUB_EPHEMERAL_RESEARCH_NOT_ECS',
    source:{ id:'openligadb', league:'BL1', season:2025,
      rawSha256:receipt.rawSha256, normalizedSha256:receipt.batchSha256,
      verifiedFT:normalized.records.length, observedAt:normalized.observedAt },
    lanes:summaries,
    dailyResearch:{ status:summaries.fixtures.status, reportId:summaries.fixtures.reportId,
      reportFixtures:report?.fixtures?.length ?? null,
      resultsRegistered:evaluation?.summary.recordedResults ?? null,
      prospectiveScores:evaluation?.summary.recordedScores ?? null },
    modelReadyForProspective:false, historicalPregameVisibility:false,
    releaseGate:'BLOCKED', forecastPublished:false, externalDeliveryAttempted:false,
    outstanding:['FIVE_LEAGUE_REAL_MARKET_ODDS','FOUR_CONTINUOUS_600S_SLOTS',
      'PERSISTENT_RESTART_READBACK','QUALIFIED_PROSPECTIVE_MODEL_SAMPLES',
      'A10_SAME_SHA_INDEPENDENT_APPROVAL']
  };
}

export function renderStage1HTML(value) {
  const rows = [
    ['真实赛果原始SHA',value.source.rawSha256],
    ['转换后历史SHA',value.source.normalizedSha256],
    ['已核验90分钟赛果',value.source.verifiedFT],
    ['内部历史核账',value.lanes.results.status],
    ['内部研究预测',value.lanes.fixtures.status],
    ['已记录赛后评分',value.dailyResearch.prospectiveScores ?? '未取得'],
    ['正式预测发布',value.releaseGate],
  ].map(row => '<tr><th>'+html(row[0])+'</th><td>'+html(row[1])+'</td></tr>').join('');
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
    +'<meta name="viewport" content="width=device-width,initial-scale=1">'
    +'<title>维度足球·第一阶段私有研究看板</title>'
    +'<style>body{font:15px/1.7 system-ui;background:#071511;color:#e9f3e9;margin:0}'
    +'main{max-width:950px;margin:auto;padding:32px 18px}h1,th{color:#e0c47c}'
    +'table{border-collapse:collapse;width:100%;background:#122b22}'
    +'td,th{padding:13px;border:1px solid #355448;text-align:left;word-break:break-all}'
    +'p{color:#b4c1b8}</style></head><body><main>'
    +'<h1>维度足球 · 第一阶段内部研究试验</h1><p>生成于 '+html(value.capturedAt)+'</p>'
    +'<p>本页只随私有测试附件保存；不是生产Web、正式预测或赔率推荐。历史赛果回填不证明当年赛前可见性。</p>'
    +'<table>'+rows+'</table><p>正式发布 BLOCKED，阶段一仅验证真实采集、研究冻结和赛后核账。</p>'
    +'</main></body></html>';
}

export async function runStage1Report(root, codeSha) {
  if (typeof root !== 'string' || !isAbsolute(root)) fail('ROOT_INVALID');
  const target = resolve(root), st = await lstat(target);
  if (!st.isDirectory() || st.isSymbolicLink() || await realpath(target) !== target) fail('ROOT_INVALID');
  const [original, receipt, lanes, evaluation, report, publication] = await Promise.all([
    readJSON(join(target,'scrapling-receipt.json')),
    readJSON(join(target,'normalized-receipt.json')),
    readJSON(join(target,'state/state.json.lanes.json')),
    optionalJSON(join(target,'reports/prospective-evaluation.json')),
    optionalJSON(join(target,'reports/predictions.json')),
    optionalJSON(join(target,'reports/publication.json')),
  ]);
  if (typeof receipt.outputFile !== 'string' || !isAbsolute(receipt.outputFile)
    || !resolve(receipt.outputFile).startsWith(join(target,'normalized')+'/')) fail('NORMALIZED_PATH_INVALID');
  const bytes = await readFile(receipt.outputFile);
  if (sha(bytes) !== receipt.batchSha256) fail('NORMALIZED_HASH_MISMATCH');
  let gateBlocked = false;
  try { await requireGreenForecastDelivery(join(target,'reports')); }
  catch (e) { gateBlocked = e.code === 'RELEASE_GATE_BLOCKED'; }
  const status = summarizeStage1({
    original, receipt, normalized:JSON.parse(bytes.toString('utf8')),
    lanes, evaluation, report, publication, gateBlocked,
    sourceCommit:codeSha, capturedAt:new Date().toISOString()
  });
  await writeFile(join(target,'stage1-status.json'),JSON.stringify(status,null,2)+'\n',{flag:'wx',mode:0o600});
  await writeFile(join(target,'stage1-internal-dashboard.html'),renderStage1HTML(status),{flag:'wx',mode:0o600});
  return status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  if (argv.length !== 4 || argv[0] !== '--root' || argv[2] !== '--commit') {
    process.stderr.write('STAGE1_INVALID_ARGS\n');process.exitCode=1;
  } else try {
    const status = await runStage1Report(argv[1],argv[3]);
    process.stdout.write(JSON.stringify({stage1:'PRIVATE_ARTIFACT_READY',source:status.source.id,
      sourceResults:status.source.verifiedFT,fixtures:status.lanes.fixtures.status,
      results:status.lanes.results.status,formalRelease:status.releaseGate})+'\n');
  } catch {
    process.stderr.write('STAGE1_EVIDENCE_VALIDATION_FAILED\n');process.exitCode=1;
  }
}

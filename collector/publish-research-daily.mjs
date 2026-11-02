import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson } from './storage.mjs';
import { createHostedClient } from './hosted.mjs';

export async function publishDailyResearch({ root, env = process.env, fetchImpl = fetch, client } = {}) {
  if (!root) throw Error('RESEARCH_ROOT_REQUIRED');
  const report = await readJson(resolve(root, 'reports/research-daily/latest.json'), 750_000);
  if (report?.kind !== 'research-daily-1x2' || report?.mode !== 'research-reference'
    || report.commercialReleaseGate !== 'BLOCKED' || report.externalTelegramSent !== false
    || report?.strictMarkets?.releasedCandidates !== 0 || !/^[a-f0-9]{64}$/.test(report.reportId || ''))
    throw Error('RESEARCH_REPORT_INVALID');
  const transport = client || createHostedClient({ env, fetchImpl });
  const status = await transport.request('/internal/research-daily', { method: 'POST', body: report });
  if (status?.reportId !== report.reportId || status.status !== 'research-available'
    || status.commercialReleaseGate !== 'BLOCKED') throw Error('RESEARCH_WRITE_UNCONFIRMED');
  const reloaded = await transport.request('/internal/research-daily', { method: 'GET' });
  if (reloaded?.reportId !== report.reportId || reloaded?.codeSha !== report.codeSha
    || reloaded?.beijingDay !== report.beijingDay || reloaded?.sourceReportId !== report.sourceReportId)
    throw Error('RESEARCH_READBACK_MISMATCH');
  return { reportId: report.reportId, beijingDay: report.beijingDay,
    status: 'research-authenticated-web-verified', telegramSent: false, commercialReleaseGate: 'BLOCKED' };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--root') {
    console.error('用法：node collector/publish-research-daily.mjs --root <研究工作区>');
    process.exitCode = 2;
  } else {
    try { console.log(JSON.stringify(await publishDailyResearch({ root: args[1] }))); }
    catch(error) {
      const code = /^RESEARCH_[A-Z0-9_]+$/.test(error?.message || '') ? error.message : 'RESEARCH_DELIVERY_FAILED';
      console.error(code); process.exitCode = 1;
    }
  }
}

import { resolve } from 'node:path';
import { publishSummary, recordArtifact } from './publication.mjs';
import { readJson } from './storage.mjs';
import { configureEnvironmentProxy } from './network.mjs';
import { publishWebsite, publishWebsiteReceipt, publishTelegram, publishGitHubArchive, publishAll } from './delivery.mjs';
import { fileURLToPath } from 'node:url';
import { requireGreenForecastDelivery } from './publication-release-gate.mjs';

export { publishAll } from './delivery.mjs';

const [mode, directory] = process.argv.slice(2);
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
try {
  if (!directory || !['summary', 'artifact', 'website', 'website-receipt', 'telegram', 'archive', 'all'].includes(mode) || process.argv.length !== 4) throw new Error('INVALID_ARGUMENT');
  const out = resolve(directory);
  if (['website','website-receipt','telegram','all'].includes(mode))
    await requireGreenForecastDelivery(out);
  if (['website', 'website-receipt', 'telegram', 'archive', 'all'].includes(mode)) {
    configureEnvironmentProxy(process.env);
    const config = await readJson(new URL('../config/delivery.json', import.meta.url));
    const result = await ({ website:publishWebsite, 'website-receipt':publishWebsiteReceipt, telegram:publishTelegram, archive:publishGitHubArchive, all:publishAll }[mode])(out,{config,env:process.env});
    const channels = { website:'externalWebsite', 'website-receipt':'receiptSync', telegram:'notifications', archive:'repositoryArchive' };
    const delivery = mode === 'all' ? { status:Object.values(result.channels).some(row => ['failed','unknown'].includes(row.status)) ? 'failed' : 'completed' } : result.channels[channels[mode]];
    console.log(JSON.stringify({ reportId:result.reportId, channel:mode, status:delivery.status, ...(delivery.code ? {code:delivery.code} : {}) }));
    if (['failed','unknown'].includes(delivery.status)) process.exitCode = 1;
  } else {
  const receipt = mode === 'summary' ? await publishSummary(out, process.env.GITHUB_STEP_SUMMARY)
    : await recordArtifact(out, { outcome: process.env.UPLOAD_OUTCOME, id: process.env.ARTIFACT_ID, url: process.env.ARTIFACT_URL,
      digest: process.env.ARTIFACT_DIGEST, repository: process.env.GITHUB_REPOSITORY, runId: process.env.GITHUB_RUN_ID });
  console.log(JSON.stringify({ reportId: receipt.reportId, channel: mode, status: receipt.channels[mode === 'summary' ? 'githubSummary' : 'githubArtifact'].status }));
  if (['failed', 'unknown'].includes(receipt.channels[mode === 'summary' ? 'githubSummary' : 'githubArtifact'].status)) process.exitCode = 1;
  }
} catch { console.error('PUBLICATION_FAILED: see publication.json for the recorded outcome'); process.exitCode = 1; }
}

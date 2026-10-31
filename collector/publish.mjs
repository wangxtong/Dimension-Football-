import { resolve } from 'node:path';
import { publishSummary, recordArtifact } from './publication.mjs';
import { readJson } from './storage.mjs';
import { configureEnvironmentProxy } from './network.mjs';
import { publishWebsite, publishWebsiteReceipt, publishTelegram } from './delivery.mjs';

const [mode, directory] = process.argv.slice(2);
try {
  if (!directory || !['summary', 'artifact', 'website', 'website-receipt', 'telegram'].includes(mode) || process.argv.length !== 4) throw new Error('INVALID_ARGUMENT');
  const out = resolve(directory);
  if (['website', 'website-receipt', 'telegram'].includes(mode)) {
    configureEnvironmentProxy(process.env);
    const config = await readJson(new URL('../config/delivery.json', import.meta.url));
    const result = await ({ website:publishWebsite, 'website-receipt':publishWebsiteReceipt, telegram:publishTelegram }[mode])(out,{config,env:process.env});
    console.log(JSON.stringify({ reportId:result.reportId, channel:mode, status:result.status || result.channels[mode === 'telegram' ? 'notifications' : 'externalWebsite'].status }));
  } else {
  const receipt = mode === 'summary' ? await publishSummary(out, process.env.GITHUB_STEP_SUMMARY)
    : await recordArtifact(out, { outcome: process.env.UPLOAD_OUTCOME, id: process.env.ARTIFACT_ID, url: process.env.ARTIFACT_URL,
      digest: process.env.ARTIFACT_DIGEST, repository: process.env.GITHUB_REPOSITORY, runId: process.env.GITHUB_RUN_ID });
  console.log(JSON.stringify({ reportId: receipt.reportId, channel: mode, status: receipt.channels[mode === 'summary' ? 'githubSummary' : 'githubArtifact'].status }));
  }
} catch { console.error('PUBLICATION_FAILED: see publication.json for the recorded outcome'); process.exitCode = 1; }

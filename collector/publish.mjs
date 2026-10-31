import { resolve } from 'node:path';
import { publishSummary, recordArtifact } from './publication.mjs';
import { readJson } from './storage.mjs';
import { configureEnvironmentProxy } from './network.mjs';
import { publishWebsite, publishWebsiteReceipt, publishTelegram } from './delivery.mjs';
import { blockUnverifiedPublication } from './block-unverified-delivery.mjs';

const [mode, directory] = process.argv.slice(2);
try {
  if (!directory || !['summary', 'artifact', 'website', 'website-receipt', 'telegram'].includes(mode) || process.argv.length !== 4) throw new Error('INVALID_ARGUMENT');
  const out = resolve(directory);
  if (['website', 'website-receipt', 'telegram'].includes(mode)) {
    // External delivery requires an independently audited, all-GREEN release.
    // No such approval exists in the trial collector. Secret env flags alone
    // must never override this fail-closed production interlock.
    await blockUnverifiedPublication(out);
    const receipt = await readJson(resolve(out,'publication.json'));
    console.log(JSON.stringify({reportId:receipt.reportId,channel:mode,status:'skipped',code:'BACKTEST_ALL_GREEN_ONLY_NOT_VERIFIED'}));
    process.exitCode = 1;
  } else {
  const receipt = mode === 'summary' ? await publishSummary(out, process.env.GITHUB_STEP_SUMMARY)
    : await recordArtifact(out, { outcome: process.env.UPLOAD_OUTCOME, id: process.env.ARTIFACT_ID, url: process.env.ARTIFACT_URL,
      digest: process.env.ARTIFACT_DIGEST, repository: process.env.GITHUB_REPOSITORY, runId: process.env.GITHUB_RUN_ID });
  console.log(JSON.stringify({ reportId: receipt.reportId, channel: mode, status: receipt.channels[mode === 'summary' ? 'githubSummary' : 'githubArtifact'].status }));
  }
} catch { console.error('PUBLICATION_FAILED: see publication.json for the recorded outcome'); process.exitCode = 1; }

import { resolve } from 'node:path';
import { publishSummary, recordArtifact } from './publication.mjs';

const [mode, directory] = process.argv.slice(2);
try {
  if (!directory || !['summary', 'artifact'].includes(mode) || process.argv.length !== 4) throw new Error('INVALID_ARGUMENT');
  const out = resolve(directory);
  const receipt = mode === 'summary' ? await publishSummary(out, process.env.GITHUB_STEP_SUMMARY)
    : await recordArtifact(out, { outcome: process.env.UPLOAD_OUTCOME, id: process.env.ARTIFACT_ID, url: process.env.ARTIFACT_URL,
      digest: process.env.ARTIFACT_DIGEST, repository: process.env.GITHUB_REPOSITORY, runId: process.env.GITHUB_RUN_ID });
  console.log(JSON.stringify({ reportId: receipt.reportId, channel: mode, status: receipt.channels[mode === 'summary' ? 'githubSummary' : 'githubArtifact'].status }));
} catch { console.error('PUBLICATION_FAILED: see publication.json for the recorded outcome'); process.exitCode = 1; }

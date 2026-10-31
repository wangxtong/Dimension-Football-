import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { updatePublicationChannel } from './publication.mjs';

// Until a separately audited full historical backtest and production-release gate
// are available, the hourly trial job is allowed to generate internal artifacts,
// but may not send forecasts to the website data branch or Telegram.
export async function blockUnverifiedPublication(directory, now = () => new Date().toISOString()) {
  const result = {};
  for (const channel of ['externalWebsite', 'notifications']) {
    const receipt = await updatePublicationChannel(directory, channel, async () => ({
      status: 'skipped',
      checkedAt: now(),
      code: 'BACKTEST_ALL_GREEN_ONLY_NOT_VERIFIED',
    }));
    result[channel] = receipt.channels[channel];
  }
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw Error('INVALID_ARGUMENT');
    const result = await blockUnverifiedPublication(resolve(process.argv[2]));
    if (Object.values(result).some(x => x.status !== 'skipped'))
      throw Error('DELIVERY_NOT_BLOCKED');
    process.stdout.write('External forecast delivery blocked; internal report archived\n');
  } catch {
    process.stderr.write('EXTERNAL_DELIVERY_BLOCK_FAILED\n');
    process.exitCode = 1;
  }
}

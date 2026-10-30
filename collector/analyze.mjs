import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildFullAnalysis, renderFullAnalysisHtml } from './full-report.mjs';

const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--evidence', '--markets', '--history', '--independent', '--out'].includes(args[i]) || !args[i + 1]) throw new Error('INVALID_ANALYSIS_ARGUMENT');
  options[args[i].slice(2)] = args[i + 1];
}
if (!options.evidence || !options.markets || !options.out) throw new Error('REQUIRE_EVIDENCE_MARKETS_AND_OUT');
const read = async path => JSON.parse(await readFile(resolve(path), 'utf8'));
const report = buildFullAnalysis({ evidence: await read(options.evidence), marketSnapshot: await read(options.markets),
  priorHistory: options.history ? await read(options.history) : [], independentReport: options.independent ? await read(options.independent) : undefined });
await mkdir(resolve(options.out), { recursive: true });
await writeFile(resolve(options.out, '逐场深度分析.json'), JSON.stringify(report, null, 2));
await writeFile(resolve(options.out, '逐场深度分析.html'), renderFullAnalysisHtml(report));
console.log(JSON.stringify({ summary: report.summary, output: resolve(options.out) }));
